require('dotenv').config();
const express = require('express');
const cookieParser = require('cookie-parser');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs/promises');
const rateLimit = require('express-rate-limit');
const multer = require('multer');
const { ZipArchive } = require('archiver');

const { initData, save, getState } = require('./db');
const { initStorage, safeStorageName, getStoragePath, deleteStoredFile, root: storageRoot } = require('./storage');
const { createSession, destroySession, requireAuth, login } = require('./auth');

const app = express();
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const quota = Number(process.env.STORAGE_QUOTA || 107374182400);
const maxUpload = Number(process.env.MAX_UPLOAD_SIZE || 5368709120);
const shareTtl = Number(process.env.SHARE_TTL || 604800000);
const trashTtl = Number(process.env.TRASH_TTL ?? 2592000000);

app.disable('x-powered-by');
if (process.env.TRUST_PROXY === "true") app.set('trust proxy', 1);

app.use(express.json({ limit: '5mb' }));
app.use(cookieParser());
app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    next();
});
app.use(express.static(path.join(__dirname, '..', 'public'), { index: 'index.html' }));

const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 20, standardHeaders: true, legacyHeaders: false });
const upload = multer({
    storage: multer.diskStorage({
        destination: (_req, _file, cb) => cb(null, storageRoot),
        filename: (_req, _file, cb) => cb(null, safeStorageName())
    }),
    limits: { fileSize: maxUpload, files: 1 }
});

const now = () => Date.now();
const id = () => crypto.randomBytes(16).toString('hex');
const state = () => getState();
const find = id => state().items.find(x => x.id === id);

const TEXT_EXT = new Set(['txt', 'md', 'markdown', 'json', 'jsonc', 'js', 'mjs', 'cjs', 'ts', 'jsx', 'tsx', 'css', 'scss', 'less', 'html', 'htm', 'xml', 'yml', 'yaml', 'toml', 'ini', 'env', 'log', 'csv', 'tsv', 'sql', 'sh', 'bash', 'zsh', 'bat', 'ps1', 'py', 'rb', 'php', 'java', 'c', 'h', 'cpp', 'hpp', 'cs', 'go', 'rs', 'kt', 'swift', 'lua', 'vue', 'svelte', 'ejs', 'conf', 'cfg', 'gitignore', 'dockerfile', 'properties']);
const DOC_EXT = new Set(['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'odt', 'ods', 'odp', 'rtf', 'epub']);
const ARCHIVE_EXT = new Set(['zip', 'rar', '7z', 'tar', 'gz', 'tgz', 'bz2', 'xz']);
const extOf = name => path.extname(String(name)).slice(1).toLowerCase();
const MAX_TEXT = 2 * 1048576;

function isEditable(item) {
    if (item.type !== 'file' || Number(item.size || 0) > MAX_TEXT) return false;
    const mime = item.mime || '';
    return mime.startsWith('text/') || /(json|xml|javascript|yaml|x-sh)/.test(mime) || TEXT_EXT.has(extOf(item.name));
}

function category(item) {
    const mime = item.mime || '', ext = extOf(item.name);
    if (mime.startsWith('image/')) return 'images';
    if (mime.startsWith('video/')) return 'videos';
    if (mime.startsWith('audio/')) return 'audio';
    if (/zip|rar|7z|tar|gzip|compressed/.test(mime) || ARCHIVE_EXT.has(ext)) return 'archives';
    if (mime === 'application/pdf' || mime.startsWith('text/') || DOC_EXT.has(ext) || TEXT_EXT.has(ext) || /word|sheet|presentation|opendocument|json|xml/.test(mime)) return 'documents';
    return 'other';
}

// multer decodes multipart filenames as latin1: repair UTF-8 names (accents, emojis)
function fixFilename(name) {
    name = String(name ?? '');
    if (/[^\x00-\xff]/.test(name)) return name;
    const decoded = Buffer.from(name, 'latin1').toString('utf8');
    return decoded.includes('\ufffd') ? name : decoded;
}

function cleanName(name) {
    return String(name ?? '').trim().replace(/[\/\\\0]/g, '').replace(/^\.+$/, '');
}

function children(parent) {
    return state().items.filter(x => (x.parent || null) === (parent || null));
}

function used() {
    // trashed files still occupy the disk until they are purged
    return state().items.filter(x => x.type === 'file').reduce((sum, x) => sum + Number(x.size || 0), 0);
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
        trashedAt: x.trashedAt || null,
        starred: x.starred === true,
        editable: isEditable(x)
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
    for (const item of s.items) {
        if (item.trashed === undefined) item.trashed = false;
        if (item.starred === undefined) item.starred = false;
    }
    return s;
}

function sameName(name, parent, exclude) {
    return children(parent).some(x => x.id !== exclude && x.trashed !== true && x.name === name);
}

function sortItems(items, sort, direction) {
    const m = direction === 'desc' ? -1 : 1;
    const byName = (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });

    return items.sort((a, b) => {
        if (a.type !== b.type) return a.type === 'folder' ? -1 : 1;

        let r;
        if (sort === 'size') r = (a.size || 0) - (b.size || 0);
        else if (sort === 'date') r = (a.updatedAt || 0) - (b.updatedAt || 0);
        else r = byName(a, b) * m;

        return r ? (sort === 'name' ? r : r * m) : byName(a, b);
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

async function purgeOldTrash() {
    if (!trashTtl) return;
    const limit = now() - trashTtl;
    const old = state().items.filter(x => x.trashed && x.trashedAt && x.trashedAt < limit);
    if (!old.length) return;

    const ids = new Set(old.map(x => x.id));
    for (const item of old) if (item.type === 'file') await deleteStoredFile(item.storageName);

    state().items = state().items.filter(x => !ids.has(x.id));
    state().shares = state().shares.filter(x => !ids.has(x.fileId));
    await save();
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
    const files = state().items.filter(x => x.type === 'file');
    const breakdown = { images: 0, videos: 0, audio: 0, documents: 0, archives: 0, other: 0 };
    let current = 0, trash = 0, count = 0;

    for (const x of files) {
        const size = Number(x.size || 0);
        current += size;
        if (x.trashed) { trash += size; continue; }
        count++;
        breakdown[category(x)] += size;
    }

    res.json({
        used: current,
        quota,
        free: Math.max(0, quota - current),
        percent: quota ? Math.min(100, current / quota * 100) : 0,
        trash,
        trashTtl,
        files: count,
        folders: state().items.filter(x => x.type === 'folder' && !x.trashed).length,
        breakdown
    });
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

app.get('/api/tree', requireAuth, (req, res) => {
    ensureState();
    res.json({ folders: state().items.filter(x => x.type === 'folder' && !x.trashed).map(x => ({ id: x.id, name: x.name, parent: x.parent || null })) });
});

app.get('/api/recent', requireAuth, (req, res) => {
    ensureState();
    const items = state().items.filter(x => x.type === 'file' && !x.trashed).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)).slice(0, 100);
    res.json({ items: items.map(publicItem) });
});

app.get('/api/starred', requireAuth, (req, res) => {
    ensureState();
    const items = state().items.filter(x => x.starred === true && !x.trashed);
    sortItems(items, 'name', 'asc');
    res.json({ items: items.map(publicItem) });
});

app.post('/api/files/star', requireAuth, async (req, res) => {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids : [];
    const items = ids.map(find);
    if (!items.length || items.some(item => !item || item.trashed)) return res.status(404).json({ error: 'Item not found' });

    for (const item of items) item.starred = req.body?.starred === true;

    await save();
    res.json({ items: items.map(publicItem) });
});

app.get('/api/zip', requireAuth, (req, res) => {
    ensureState();
    const roots = String(req.query.ids || '').split(',').filter(Boolean).map(find);
    if (!roots.length || roots.some(item => !item || item.trashed)) return res.status(404).json({ error: 'Item not found' });

    const archive = new ZipArchive({ zlib: { level: 3 } });
    archive.on('error', err => { console.error(err); res.destroy(err); });
    res.on('close', () => archive.abort());
    res.attachment(roots.length === 1 ? `${roots[0].name}.zip` : 'cloud-explorer.zip');
    archive.pipe(res);

    const taken = new Set();
    const topName = name => {
        const ext = path.extname(name), stem = name.slice(0, name.length - ext.length);
        let n = name, i = 1;
        while (taken.has(n)) n = `${stem} (${i++})${ext}`;
        taken.add(n);
        return n;
    };

    const add = (item, prefix, nameOverride) => {
        if (item.trashed) return;
        const entry = prefix + (nameOverride ?? item.name);

        if (item.type === 'folder') {
            archive.append(Buffer.alloc(0), { name: entry + '/' });
            for (const child of children(item.id)) add(child, entry + '/');
        } else {
            archive.file(getStoragePath(item.storageName), { name: entry });
        }
    };

    for (const item of roots) add(item, '', topName(item.name));
    archive.finalize();
});

function editableItem(req) {
    const item = find(req.params.id);
    return item && !item.trashed && isEditable(item) ? item : null;
}

app.get('/api/text/:id', requireAuth, async (req, res) => {
    const item = editableItem(req);
    if (!item) return res.status(404).json({ error: 'File not found or not editable' });
    res.json({ content: await fs.readFile(getStoragePath(item.storageName), 'utf8') });
});

app.put('/api/text/:id', requireAuth, async (req, res) => {
    const item = editableItem(req);
    if (!item) return res.status(404).json({ error: 'File not found or not editable' });

    const content = req.body?.content;
    if (typeof content !== 'string') return res.status(400).json({ error: 'Invalid content' });

    const bytes = Buffer.byteLength(content, 'utf8');
    if (bytes > MAX_TEXT) return res.status(413).json({ error: 'File is too large' });
    if (used() - Number(item.size || 0) + bytes > quota) return res.status(413).json({ error: 'Storage quota exceeded' });

    await fs.writeFile(getStoragePath(item.storageName), content, 'utf8');
    item.size = bytes;
    item.updatedAt = now();

    await save();
    res.json({ item: publicItem(item) });
});

app.post('/api/text', requireAuth, async (req, res) => {
    let name = cleanName(req.body?.name);
    const parent = req.body?.parent || null;
    const content = typeof req.body?.content === 'string' ? req.body.content : '';

    if (!name || name.length > 255) return res.status(400).json({ error: 'Invalid filename' });
    if (parent && (!find(parent) || find(parent).type !== 'folder' || find(parent).trashed)) return res.status(404).json({ error: 'Parent folder not found' });
    if (!path.extname(name)) name += '.txt';

    const bytes = Buffer.byteLength(content, 'utf8');
    if (bytes > MAX_TEXT) return res.status(413).json({ error: 'File is too large' });
    if (used() + bytes > quota) return res.status(413).json({ error: 'Storage quota exceeded' });

    name = await uniqueName(name, parent);
    const storageName = safeStorageName();
    await fs.writeFile(getStoragePath(storageName), content, 'utf8');

    const mimes = { '.md': 'text/markdown', '.json': 'application/json', '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.csv': 'text/csv' };
    const item = {
        id: id(),
        type: 'file',
        name,
        parent,
        size: bytes,
        mime: mimes[path.extname(name).toLowerCase()] || 'text/plain',
        storageName,
        createdAt: now(),
        updatedAt: now(),
        trashed: false,
        starred: false
    };

    state().items.push(item);
    await save();
    res.status(201).json({ item: publicItem(item) });
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
    if (!req.file) return res.status(400).json({ error: 'No file supplied' });

    const storageName = req.file.filename;
    const reject = async (status, error) => {
        await deleteStoredFile(storageName);
        return res.status(status).json({ error });
    };

    const parent = req.body?.parent || null;
    if (parent && (!find(parent) || find(parent).type !== 'folder' || find(parent).trashed)) return reject(404, 'Parent folder not found');
    if (used() + req.file.size > quota) return reject(413, 'Storage quota exceeded');

    const base = cleanName(fixFilename(req.file.originalname));
    if (!base || base.length > 255) return reject(400, 'Invalid filename');
    const name = await uniqueName(base, parent);

    const item = {
        id: id(),
        type: 'file',
        name,
        parent,
        size: req.file.size,
        mime: req.file.mimetype || 'application/octet-stream',
        storageName,
        createdAt: now(),
        updatedAt: now(),
        trashed: false,
        starred: false
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

    const mime = item.mime || 'application/octet-stream';
    res.setHeader('Content-Type', mime);
    res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(item.name)}`);
    if (/html|svg|xml|javascript/.test(mime)) res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'; img-src data:; style-src 'unsafe-inline'");
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

    if (name !== item.name || parent !== item.parent) item.updatedAt = now();
    item.name = name;
    item.parent = parent;
    if (req.body?.starred !== undefined) item.starred = req.body.starred === true;

    await save();

    res.json({ item: publicItem(item) });
});

app.post('/api/files/move', requireAuth, async (req, res) => {
    const ids = req.body?.all === true ? state().items.filter(x => x.trashed).map(x => x.id) : Array.isArray(req.body?.ids) ? req.body.ids : [];
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
        expiresAt: now() + days * 86400000,
        downloads: 0
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

const escapeHtml = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function shell(title, body) {
    return `<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${escapeHtml(title)}</title><style>
*{box-sizing:border-box;margin:0}body{min-height:100vh;display:grid;place-items:center;padding:24px;font:15px/1.5 Inter,ui-sans-serif,system-ui,'Segoe UI',sans-serif;color:#eef0fa;background:radial-gradient(900px 500px at 10% -10%,#4f46e5aa,transparent),radial-gradient(800px 500px at 100% 30%,#0ea5e955,transparent),#06070c}
.card{width:min(460px,100%);padding:34px;border-radius:28px;text-align:center;background:rgba(18,21,32,.78);border:1px solid rgba(255,255,255,.09);backdrop-filter:blur(26px);box-shadow:0 30px 80px rgba(0,0,0,.55)}
.logo{width:64px;height:64px;margin:0 auto 18px;border-radius:20px;display:grid;place-items:center;font-size:30px;background:linear-gradient(135deg,#7c6cff,#35c4f5);box-shadow:0 12px 34px -8px #7c6cff}
h1{font-size:19px;word-break:break-word}p{color:#8a91aa;margin-top:6px;font-size:13px}.preview{margin:22px 0 4px}.preview img,.preview video{max-width:100%;max-height:300px;border-radius:16px}.preview audio{width:100%}
a.btn{display:inline-flex;gap:8px;align-items:center;justify-content:center;margin-top:24px;padding:13px 26px;border-radius:14px;color:#fff;text-decoration:none;font-weight:600;background:linear-gradient(135deg,#7c6cff,#35c4f5);box-shadow:0 14px 34px -12px #7c6cff}a.btn:hover{filter:brightness(1.1)}small{display:block;margin-top:22px;color:#5d6480;font-size:12px}
</style></head><body><div class="card">${body}</div></body></html>`;
}

app.get('/share/:token', (req, res) => {
    purgeExpiredShares();

    const share = state().shares.find(x => x.token === req.params.token);
    const item = share && find(share.fileId);
    if (!share || !item || item.trashed) return res.status(404).send(shell('Lien introuvable', '<div class="logo">☁</div><h1>Lien introuvable ou expiré</h1><p>Ce lien de partage n\u2019existe plus.</p>'));

    if (req.query.dl !== undefined) {
        share.downloads = (share.downloads || 0) + 1;
        save().catch(console.error);
        return res.download(getStoragePath(item.storageName), item.name);
    }

    const mime = item.mime || '';
    const previewable = /^(image|video|audio)\//.test(mime) && !/svg/.test(mime);
    if (req.query.raw !== undefined && previewable) {
        res.setHeader('Content-Type', mime);
        return res.sendFile(getStoragePath(item.storageName));
    }

    const raw = `/share/${share.token}?raw=1`;
    const media = !previewable ? '' : mime.startsWith('image/') ? `<img src="${raw}" alt="">` : mime.startsWith('video/') ? `<video src="${raw}" controls></video>` : `<audio src="${raw}" controls></audio>`;
    const days = Math.max(0, Math.ceil((share.expiresAt - now()) / 86400000));
    const size = Number(item.size || 0) < 1048576 ? `${(Number(item.size || 0) / 1024).toFixed(1)} Ko` : `${(Number(item.size) / 1048576).toFixed(1)} Mo`;

    res.send(shell(item.name, `<div class="logo">☁</div><h1>${escapeHtml(item.name)}</h1><p>${size} · expire dans ${days} jour${days > 1 ? 's' : ''}</p>${media ? `<div class="preview">${media}</div>` : ''}<a class="btn" href="/share/${share.token}?dl=1">Télécharger</a><small>Partagé avec Cloud Explorer</small>`));
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
    if ((process.env.ADMIN_PASSWORD || 'change-me') === 'change-me') console.warn('⚠  ADMIN_PASSWORD still has its default value — set a real password in .env');
    await purgeOldTrash();
    setInterval(() => purgeOldTrash().catch(console.error), 3600000).unref();
    await save();

    app.listen(PORT, HOST, () => {
        console.log(`Cloud Explorer: http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
    });
}

main().catch(error => {
    console.error(error);
    process.exit(1);
});