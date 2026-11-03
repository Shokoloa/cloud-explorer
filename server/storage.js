const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');

const root = path.resolve(process.env.STORAGE_PATH || './storage');

async function initStorage() {
    await fs.mkdir(root, { recursive: true });
}

function safeStorageName() {
    return crypto.randomBytes(24).toString('hex');
}

function getStoragePath(storageName) {
    const resolved = path.resolve(root, storageName);
    if (path.dirname(resolved) !== root) throw new Error('Invalid storage path');
    return resolved;
}

async function writeUpload(stream, storageName) {
    const filePath = getStoragePath(storageName);
    const handle = await fs.open(filePath, 'w');
    try {
        let size = 0;
        for await (const chunk of stream) {
            size += chunk.length;
            await handle.write(chunk);
        }
        return size;
    } finally {
        await handle.close();
    }
}

async function deleteStoredFile(storageName) {
    if (!storageName) return;
    try { await fs.unlink(getStoragePath(storageName)); } catch (e) { if (e.code !== 'ENOENT') throw e; }
}

async function statStoredFile(storageName) {
    return fs.stat(getStoragePath(storageName));
}

module.exports = { root, initStorage, safeStorageName, getStoragePath, writeUpload, deleteStoredFile, statStoredFile };