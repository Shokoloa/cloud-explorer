const fs = require('fs/promises');
const path = require('path');

const dataPath = path.resolve(process.env.DATA_PATH || './data/files.json');
let state = { items: [], shares: [] };
let writeQueue = Promise.resolve();

async function initData() {
    await fs.mkdir(path.dirname(dataPath), { recursive: true });
    try {
        state = JSON.parse(await fs.readFile(dataPath, 'utf8'));
        if (!Array.isArray(state.items)) state.items = [];
        if (!Array.isArray(state.shares)) state.shares = [];
    } catch (e) {
        if (e.code !== 'ENOENT') throw e;
        await save();
    }
}

async function save() {
    const payload = JSON.stringify(state, null, 2);
    const tmp = `${dataPath}.tmp`;
    await fs.writeFile(tmp, payload, 'utf8');
    await fs.rename(tmp, dataPath);
}

function persist() {
    writeQueue = writeQueue.then(save);
    return writeQueue;
}

function getState() {
    return state;
}

module.exports = { initData, save: persist, getState };
