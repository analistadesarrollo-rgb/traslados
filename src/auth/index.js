'use strict';

const crypto = require('node:crypto');
const config = require('../config');
const repo = require('../database/repository');

/**
 * Autenticación y sesiones.
 *
 * - El administrador definido en .env (ADMIN_USER / ADMIN_PASSWORD) sigue
 *   siendo la cuenta administrativa principal.
 * - Además se soportan usuarios persistidos en la tabla `users` con dos
 *   roles: `admin` y `scheduler` (usuario programador).
 * - Las contraseñas de esos usuarios se guardan con scrypt + salt (node:crypto),
 *   sin dependencias externas.
 * - La cookie de sesión es un token firmado con HMAC-SHA256 (HttpOnly).
 */

const SESSION_COOKIE = 'tb_session';
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;
const SCRYPT_KEYLEN = 64;

function sessionSecret() {
  return config.admin.password || 'transfer-bot-session';
}

function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(password), salt, SCRYPT_KEYLEN).toString('hex');
  return { hash, salt };
}

function verifyPassword(password, hash, salt) {
  if (!hash || !salt) return false;
  try {
    const derived = crypto.scryptSync(String(password), salt, SCRYPT_KEYLEN);
    const expected = Buffer.from(hash, 'hex');
    if (derived.length !== expected.length) return false;
    return crypto.timingSafeEqual(derived, expected);
  } catch (_) {
    return false;
  }
}

/**
 * Valida credenciales contra el admin de .env o contra la tabla users.
 * @returns {{username:string, role:string, userId:number|null, isPrimaryAdmin:boolean}|null}
 */
function authenticate(username, password) {
  const name = String(username || '').trim();
  const pass = String(password || '');
  if (!name) return null;

  if (
    config.admin.password &&
    name === config.admin.user &&
    safeEqual(pass, config.admin.password)
  ) {
    return {
      username: config.admin.user,
      role: 'admin',
      userId: null,
      isPrimaryAdmin: true,
    };
  }

  const user = repo.findUserByUsername(name);
  if (!user || !user.enabled) return null;
  if (!verifyPassword(pass, user.password_hash, user.password_salt)) return null;

  return {
    username: user.username,
    role: user.role,
    userId: user.id,
    isPrimaryAdmin: false,
  };
}

function sign(body) {
  return crypto.createHmac('sha256', sessionSecret()).update(body).digest('base64url');
}

function createSessionToken(user) {
  const payload = {
    u: user.username,
    r: user.role,
    id: user.userId || null,
    p: user.isPrimaryAdmin ? 1 : 0,
    iat: Date.now(),
  };
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  return `${body}.${sign(body)}`;
}

function verifySessionToken(token) {
  if (typeof token !== 'string') return null;
  const idx = token.lastIndexOf('.');
  if (idx <= 0) return null;
  const body = token.slice(0, idx);
  const sig = token.slice(idx + 1);
  if (!safeEqual(sig, sign(body))) return null;

  let payload;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch (_) {
    return null;
  }
  if (!payload || !payload.u) return null;
  if (!payload.iat || Date.now() - payload.iat > SESSION_TTL_MS) return null;
  return payload;
}

/**
 * Revalida contra la base en cada request (permite deshabilitar usuarios al
 * instante sin esperar a que expire la cookie).
 */
function resolveSessionUser(payload) {
  if (!payload) return null;
  if (payload.p === 1 || payload.u === config.admin.user) {
    if (!config.admin.password) return null;
    return {
      username: config.admin.user,
      role: 'admin',
      userId: null,
      isPrimaryAdmin: true,
    };
  }
  const user = repo.findUserById(payload.id);
  if (!user || !user.enabled) return null;
  return {
    username: user.username,
    role: user.role,
    userId: user.id,
    isPrimaryAdmin: false,
  };
}

module.exports = {
  SESSION_COOKIE,
  SESSION_TTL_MS,
  hashPassword,
  verifyPassword,
  authenticate,
  createSessionToken,
  verifySessionToken,
  resolveSessionUser,
};
