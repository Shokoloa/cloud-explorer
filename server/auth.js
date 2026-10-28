const crypto = require('crypto');
const bcrypt = require('bcryptjs');

const sessions = new Map();
const ttl = Number(process.env.SESSION_TTL || 604800000);
const passwordHash = bcrypt.hashSync(process.env.ADMIN_PASSWORD || 'change-me', 12);

function createSession() {
    const token = crypto.randomBytes(48).toString('hex');
    sessions.set(token, Date.now() + ttl);
    return token;
}

function destroySession(token) {
    sessions.delete(token);
}

function requireAuth(req, res, next) {
    const token = req.cookies?.cloud_session;
    const expires = token && sessions.get(token);
    if (!expires || expires < Date.now()) {
        if (token) sessions.delete(token);
        return res.status(401).json({ error: 'Authentication required' });
    }
    next();
}

async function login(password) {
    return bcrypt.compare(password, passwordHash);
}

module.exports = { createSession, destroySession, requireAuth, login };
