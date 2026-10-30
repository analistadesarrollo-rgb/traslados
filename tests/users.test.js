'use strict';

process.env.DB_FILE = ':memory:';
process.env.ADMIN_USER = 'admin';
process.env.ADMIN_PASSWORD = 'adminpass-test';

const { test, before, after } = require('node:test');
const assert = require('node:assert');

const { migrate } = require('../src/database/migrations');
const repo = require('../src/database/repository');
const auth = require('../src/auth');
const { closeDb } = require('../src/database');

before(() => migrate());
after(() => closeDb());

test('hashPassword/verifyPassword acepta la correcta y rechaza la incorrecta', () => {
  const { hash, salt } = auth.hashPassword('claveSegura123');
  assert.equal(auth.verifyPassword('claveSegura123', hash, salt), true);
  assert.equal(auth.verifyPassword('otraClave', hash, salt), false);
  assert.equal(auth.verifyPassword('claveSegura123', hash, 'salt-invalido'), false);
});

test('el administrador de .env autentica como admin principal', () => {
  const user = auth.authenticate('admin', 'adminpass-test');
  assert.ok(user);
  assert.equal(user.role, 'admin');
  assert.equal(user.isPrimaryAdmin, true);
  assert.equal(auth.authenticate('admin', 'incorrecta'), null);
});

test('crear usuario programador y autenticarlo', () => {
  const { hash, salt } = auth.hashPassword('clave12345');
  const id = repo.createUser({
    username: 'juan.perez',
    password_hash: hash,
    password_salt: salt,
    role: 'scheduler',
    display_name: 'Juan Pérez',
    enabled: 1,
    created_by: 'admin',
  });
  const user = auth.authenticate('juan.perez', 'clave12345');
  assert.ok(user);
  assert.equal(user.role, 'scheduler');
  assert.equal(user.userId, id);
  assert.equal(user.isPrimaryAdmin, false);
  assert.equal(auth.authenticate('juan.perez', 'mala'), null);
});

test('un usuario deshabilitado no puede autenticarse', () => {
  const row = repo.findUserByUsername('juan.perez');
  repo.updateUser(row.id, { enabled: 0 });
  assert.equal(auth.authenticate('juan.perez', 'clave12345'), null);
  repo.updateUser(row.id, { enabled: 1 });
  assert.ok(auth.authenticate('juan.perez', 'clave12345'));
});

test('listUsers nunca expone hash ni salt', () => {
  const items = repo.listUsers();
  assert.ok(items.length >= 1);
  for (const u of items) {
    assert.equal('password_hash' in u, false);
    assert.equal('password_salt' in u, false);
  }
});

test('token de sesión: válido, manipulable y expirado', () => {
  const user = auth.authenticate('juan.perez', 'clave12345');
  const token = auth.createSessionToken(user);
  const payload = auth.verifySessionToken(token);
  assert.ok(payload);
  assert.equal(payload.u, 'juan.perez');

  const resolved = auth.resolveSessionUser(payload);
  assert.ok(resolved);
  assert.equal(resolved.userId, user.userId);

  assert.equal(auth.verifySessionToken(token + 'x'), null);
  assert.equal(auth.verifySessionToken('basura'), null);

  const expired = auth.verifySessionToken(token);
  assert.ok(expired);
  // simular expiración manipulando el payload no es posible sin firma;
  // se valida que un token con iat viejo (firmado) se rechace.
  const crypto = require('node:crypto');
  const body = Buffer.from(
    JSON.stringify({ u: 'juan.perez', r: 'scheduler', id: user.userId, iat: Date.now() - 48 * 3600 * 1000 })
  ).toString('base64url');
  const sig = crypto
    .createHmac('sha256', 'adminpass-test')
    .update(body)
    .digest('base64url');
  assert.equal(auth.verifySessionToken(`${body}.${sig}`), null);
});
