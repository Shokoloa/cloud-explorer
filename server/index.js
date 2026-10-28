require('dotenv').config();
const express = require('express');
const cookieParser = require('cookie-parser');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs/promises');
const rateLimit = require('express-rate-limit');
const multer = require('multer');

const { initData, save, getState } = require('./db');
const { initStorage, safeStorageName, getStoragePath, deleteStoredFile } = require('./storage');
const { createSession, destroySession, requireAuth, login } = require('./auth');

const app = express();
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const quota = Number(process.env.STORAGE_QUOTA || 107374182400);
const maxUpload = Number(process.env.MAX_UPLOAD_SIZE || 5368709120);
const shareTtl = Number(process.env.SHARE_TTL || 604800000);

app.disable('x-powered-by');
if (process.env.TRUST_PROXY === "true") app.set('trust proxy', 1);

app.use(express.json({ limit: '5mb' }));
app.use(cookieParser());
app.use(express.static(path.resolve('public'), { index: 'index.html' }));

const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 20, standardHeaders: true, legacyHeaders: false });
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: maxUpload, files: 1 } });

const now = () => Date.now();
const id = () => crypto.randomBytes(16).toString('hex');
const state = () => getState();
const find = id => state().items.find(x => x.id === id);

function cleanName(name) {
    return String(name ?? '').trim().replace(/[\/\\\0]/g, '').replace(/^\.+$/, '');
}

function children(parent) {
    return state().items.filter(x => (x.parent || null) === (parent || null));
}

function used() {
    return state().items.filter(x => x.type === 'file' && x.trashed !== true).reduce((sum, x) => sum + Number(x.size || 0), 0);
}

function publicItem(x) {
    return {
        id: x.id,
        type: x.type,
        name: x.name,
        parent: x.parent || null,
        size: x.size || 0,
        mime: x.mime || null,
        createdAt: x.createdAt,
        updatedAt: x.updatedAt,
        trashed: x.trashed === true,
        trashedAt: x.trashedAt || null
    };
}

function descendants(itemId) {
    const output = [];
    for (const item of state().items.filter(x => x.parent === itemId)) output.push(item.id, ...descendants(item.id));
    return output;
}

function treeIds(itemId) {
    return [itemId, ...descendants(itemId)];
}

function isDescendant(itemId, parentId) {
    let item = find(parentId);
    while (item) {
        if (item.id === itemId) return true;
        item = item.parent ? find(item.parent) : null;
    }
    return false;
}

function ensureState() {
    const s = state();
    if (!Array.isArray(s.items)) s.items = [];
    if (!Array.isArray(s.shares)) s.shares = [];
    for (const item of s.items) if (item.trashed === undefined) item.trashed = false;
    return s;
}

function sameName(name, parent, exclude) {
    return children(parent).some(x => x.id !== exclude && x.trashed !== true && x.name === name);
}

function sortItems(items, sort, direction) {
    const multiplier = direction === 'desc' ? -1 : 1;

    return items.sort((a, b) => {
        let av, bv;

        if (sort === 'size') {
            av = a.size || 0;
            bv = b.size || 0;
        } else if (sort === 'date') {
            av = a.updatedAt || 0;
            bv = b.updatedAt || 0;
        } else {
            av = a.name.toLocaleLowerCase();
            bv = b.name.toLocaleLowerCase();
        }

        if (av < bv) return -multiplier;
        if (av > bv) return multiplier;

        return (a.type === 'folder' ? -1 : 1) - (b.type === 'folder' ? -1 : 1);
    });
}

function purgeExpiredShares() {
    const timestamp = now();
    state().shares = state().shares.filter(share => share.expiresAt > timestamp && find(share.fileId) && !find(share.fileId).trashed);
}

async function uniqueName(base, parent) {
    const ext = path.extname(base);
    const stem = base.slice(0, base.length - ext.length);

    let number = 1;
    let name = base;

    while (sameName(name, parent)) name = `${stem} (${number++})${ext}`;
    return name;
}

app.get('/api/auth/me', requireAuth, (_req, res) => res.json({ authenticated: true }));

app.post('/api/auth/login', authLimiter, async (req, res) => {
    if (!await login(req.body?.password || '')) return res.status(401).json({ error: 'Invalid password' });
    const token = createSession();

    res.cookie('cloud_session', token, {
        httpOnly: true,
        sameSite: 'strict',
        secure: req.secure,
        maxAge: Number(process.env.SESSION_TTL || 604800000),
        path: '/'
    });

    res.json({ authenticated: true });
});

app.post('/api/auth/logout', requireAuth, (req, res) => {
    destroySession(req.cookies.cloud_session);
    res.clearCookie('cloud_session', { path: '/' });
    res.json({ ok: true });
});

app.get('/api/storage', requireAuth, (req, res) => {
    const current = used();
    res.json({ used: current, quota, free: Math.max(0, quota - current), percent: quota ? Math.min(100, current / quota * 100) : 0 });
});

app.get('/api/files', requireAuth, (req, res) => {
    ensureState();

    const parent = req.query.parent || null;
    const search = String(req.query.search || '').trim().toLocaleLowerCase();
    const sort = String(req.query.sort || 'name');
    const direction = String(req.query.dir || 'asc');

    let items = state().items.filter(item => item.trashed !== true && (item.parent || null) === parent);
    if (search) items = state().items.filter(item => item.trashed !== true && item.name.toLocaleLowerCase().includes(search));

    sortItems(items, sort, direction);
    res.json({ items: items.map(publicItem), parent, search, sort, dir: direction });
});

app.get('/api/trash', requireAuth, (req, res) => {
    ensureState();
    const items = state().items.filter(item => item.trashed === true && (!item.parent || !find(item.parent)?.trashed));
    sortItems(items, 'date', 'desc');
    res.json({ items: items.map(publicItem) });
});

app.post('/api/folders', requireAuth, async (req, res) => {
    const name = cleanName(req.body?.name);
    const parent = req.body?.parent || null;

    if (!name || name.length > 255) return res.status(400).json({ error: 'Invalid folder name' });
    if (parent && (!find(parent) || find(parent).type !== 'folder' || find(parent).trashed)) return res.status(404).json({ error: 'Parent folder not found' });

    if (sameName(name, parent)) return res.status(409).json({ error: 'An item with this name already exists' });

    const item = {
        id: id(),
        type: 'folder',
        name,
        parent,
        createdAt: now(),
        updatedAt: now(),
        trashed: false
    };

    state().items.push(item);
    await save();

    res.status(201).json({ item: publicItem(item) });
});

app.post('/api/upload', requireAuth, upload.single('file'), async (req, res) => {
    const parent = req.body?.parent || null;
    if (!req.file) return res.status(400).json({ error: 'No file supplied' });
    if (parent && (!find(parent) || find(parent).type !== 'folder' || find(parent).trashed)) return res.status(404).json({ error: 'Parent folder not found' });
    if (used() + req.file.size > quota) return res.status(413).json({ error: 'Storage quota exceeded' });

    const name = cleanName(req.file.originalname);
    if (!name || name.length > 255) return res.status(400).json({ error: 'Invalid filename' });
    if (sameName(name, parent)) return res.status(409).json({ error: 'An item with this name already exists' });

    const storageName = safeStorageName();
    await fs.writeFile(getStoragePath(storageName), req.file.buffer);

    const item = {
        id: id(),
        type: "file",
        name,
        parent,
        size: req.file.size,
        mime: req.file.mimetype || 'application/octet-stream',
        storageName,
        createdAt: now(),
        updatedAt: now(),
        trashed: false
    };

    state().items.push(item);
    await save();

    res.status(201).json({ item: publicItem(item) });
});

app.get('/api/download/:id', requireAuth, (req, res) => {
    const item = find(req.params.id);
    if (!item || item.type !== 'file' || item.trashed) return res.status(404).json({ error: 'File not found' });

    res.download(getStoragePath(item.storageName), item.name);
});

app.get('/api/preview/:id', requireAuth, (req, res) => {
    const item = find(req.params.id);
    if (!item || item.type !== 'file' || item.trashed) return res.status(404).json({ error: 'File not found' });

    res.setHeader('Content-Type', item.mime || 'application/octet-stream');
    res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(item.name)}`);
    res.sendFile(getStoragePath(item.storageName));
});

app.patch('/api/files/:id', requireAuth, async (req, res) => {
    const item = find(req.params.id);
    if (!item || item.trashed) return res.status(404).json({ error: 'Item not found' });

    const name = req.body?.name !== undefined ? cleanName(req.body.name) : item.name;
    const parent = req.body?.parent !== undefined ? req.body.parent || null : item.parent;

    if (!name || name.length > 255) return res.status(400).json({ error: 'Invalid name' });
    if (parent && (!find(parent) || find(parent).type !== 'folder' || find(parent).trashed)) return res.status(404).json({ error: 'Destination folder not found' });
    if (item.type === 'folder' && (parent === item.id || isDescendant(item.id, parent))) return res.status(400).json({ error: 'Cannot move a folder into itself' });
    if (sameName(name, parent, item.id)) return res.status(409).json({ error: 'An item with this name already exists' });

    item.name = name;
    item.parent = parent;
    item.updatedAt = now();

    await save();

    res.json({ item: publicItem(item) });
});

app.post('/api/files/move', requireAuth, async (req, res) => {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids : [];
    const parent = req.body?.parent || null;

    if (!ids.length) return res.status(400).json({ error: 'No items selected' });
    if (parent && (!find(parent) || find(parent).type !== 'folder' || find(parent).trashed)) return res.status(404).json({ error: 'Destination folder not found' });

    const items = ids.map(find);
    if (items.some(item => !item || item.trashed)) return res.status(404).json({ error: 'Item not found' });

    for (const item of items) {
        if (item.type === 'folder' && (parent === item.id || isDescendant(item.id, parent))) return res.status(400).json({ error: 'Invalid destination' });
        if (sameName(item.name, parent, item.id)) return res.status(409).json({ error: `Name already exists: ${item.name}` });
    }

    for (const item of items) {
        item.parent = parent;
        item.updatedAt = now();
    }

    await save();
    res.json({ items: items.map(publicItem) });
});

app.post('/api/files/copy', requireAuth, async (req, res) => {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids : [];
    const parent = req.body?.parent || null;

    if (!ids.length) return res.status(400).json({ error: 'No items selected' });
    if (parent && (!find(parent) || find(parent).type !== 'folder' || find(parent).trashed)) return res.status(404).json({ error: 'Destination folder not found' });

    const originals = ids.map(find);
    if (originals.some(item => !item || item.trashed)) return res.status(404).json({ error: 'Item not found' });
    const created = [];

    async function clone(original, destination) {
        const name = await uniqueName(original.name, destination);

        const copy = {
            ...original,
            id: id(),
            name,
            parent: destination,
            createdAt: now(),
            updatedAt: now(),
            trashed: false
        };

        if (copy.type === 'file') {
            const storageName = safeStorageName();
            await fs.copyFile(getStoragePath(original.storageName), getStoragePath(storageName));
            copy.storageName = storageName;
        }

        state().items.push(copy);
        created.push(copy);

        if (original.type === 'folder') {
            for (const child of state().items.filter(item => item.parent === original.id && !item.trashed)) {
                await clone(child, copy.id);
            }
        }
    }

    for (const original of originals) await clone(original, parent);

    await save();
    res.status(201).json({ items: created.map(publicItem) });
});

app.post('/api/trash', requireAuth, async (req, res) => {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids : [];
    if (!ids.length) return res.status(400).json({ error: 'No items selected' });

    const all = [...new Set(ids.flatMap(treeIds))];
    for (const itemId of all) {
        const item = find(itemId);

        if (item) {
            item.trashed = true;
            item.trashedAt = now();
            item.updatedAt = now();
        }
    }

    state().shares = state().shares.filter(share => !all.includes(share.fileId));
    await save();
    res.json({ ok: true });
});

app.post('/api/trash/restore', requireAuth, async (req, res) => {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids : [];
    const all = [...new Set(ids.flatMap(treeIds))];

    for (const itemId of all) {
        const item = find(itemId);
        if (!item || !item.trashed) continue;

        let parent = item.parent;
        if (parent && (!find(parent) || find(parent).trashed)) parent = null;
        if (sameName(item.name, parent, item.id)) item.name = await uniqueName(item.name, parent);

        item.parent = parent;
        item.trashed = false;
        item.trashedAt = null;
        item.updatedAt = now();
    }

    await save();
    res.json({ ok: true });
});

app.delete('/api/trash', requireAuth, async (req, res) => {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids : [];
    const all = [...new Set(ids.flatMap(treeIds))];

    for (const itemId of all) {
        const item = find(itemId);
        if (item?.type === 'file' && item.storageName) await deleteStoredFile(item.storageName);
    }

    state().items = state().items.filter(item => !all.includes(item.id));
    state().shares = state().shares.filter(share => !all.includes(share.fileId));

    await save();
    res.json({ ok: true });
});

app.get('/api/shares', requireAuth, (req, res) => {
    purgeExpiredShares();
    res.json({ shares: state().shares.map(share => ({ ...share, file: find(share.fileId) ? publicItem(find(share.fileId)) : null, url: `/share/${share.token}` })) });
});

app.post('/api/share/:id', requireAuth, async (req, res) => {
    const item = find(req.params.id);
    if (!item || item.type !== 'file' || item.trashed) return res.status(404).json({ error: 'File not found' });

    const days = Math.max(1, Math.min(365, Number(req.body?.days || 7)));
    const token = crypto.randomBytes(32).toString('base64url');

    const share = {
        id: id(),
        fileId: item.id,
        token,
        createdAt: now(),
        expiresAt: now() + days * 86400000
    };

    state().shares.push(share);
    await save();
    res.status(201).json({ ...share, url: `/share/${token}` });
});

app.patch('/api/shares/:id', requireAuth, async (req, res) => {
    const share = state().shares.find(x => x.id === req.params.id);
    if (!share) return res.status(404).json({ error: 'Share not found' });

    if (req.body?.days !== undefined) {
        const days = Math.max(1, Math.min(365, Number(req.body.days)));
        share.expiresAt = now() + days * 86400000;
    }

    await save();
    res.json({ ...share, url: `/share/${share.token}` });
});

app.delete('/api/shares/:id', requireAuth, async (req, res) => {
    state().shares = state().shares.filter(x => x.id !== req.params.id);
    await save();
    res.json({ ok: true });
});

app.get('/share/:token', (req, res) => {
    purgeExpiredShares();

    const share = state().shares.find(x => x.token === req.params.token);
    const item = share && find(share.fileId);
    if (!share || !item || item.trashed) return res.status(404).send('Share link not found or expired.');

    res.download(getStoragePath(item.storageName), item.name);
});

app.use((err, req, res, next) => {
    if (err instanceof multer.MulterError) return res.status(413).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'File is too large' : err.message });
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
});

async function main() {
    await initStorage();
    await initData();
    ensureState();
    await save();

    app.listen(PORT, HOST, () => {
        console.log(`Cloud Explorer: http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
    });
}

main().catch(error => {
    console.error(error);
    process.exit(1);
});