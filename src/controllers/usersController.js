'use strict';

const config = require('../config');
const repo = require('../database/repository');
const auth = require('../auth');
const logger = require('../logger').child('users');

/**
 * Administración de usuarios (solo rol admin).
 * El admin de .env no vive en la tabla `users`: se muestra aparte y no puede
 * deshabilitarse desde aquí.
 */

const USERNAME_RE = /^[a-zA-Z0-9._-]{3,40}$/;
const ROLES = ['admin', 'scheduler'];

function safeUser(user) {
  return {
    id: user.id,
    username: user.username,
    role: user.role,
    display_name: user.display_name,
    enabled: !!user.enabled,
    created_by: user.created_by,
    created_at: user.created_at,
    updated_at: user.updated_at,
  };
}

function listUsers(req, res) {
  res.json({
    items: repo.listUsers().map(safeUser),
    primaryAdmin: {
      username: config.admin.user,
      role: 'admin',
      isPrimaryAdmin: true,
    },
  });
}

function validatePassword(password) {
  return typeof password === 'string' && password.length >= 8;
}

function createUser(req, res) {
  const username = String(req.body.username || '').trim();
  const password = String(req.body.password || '');
  const role = String(req.body.role || 'scheduler');
  const displayName = req.body.display_name
    ? String(req.body.display_name).trim().slice(0, 120)
    : null;

  if (!USERNAME_RE.test(username)) {
    return res.status(400).json({
      error:
        'Usuario inválido: 3-40 caracteres, solo letras, números, punto, guion o guion bajo.',
    });
  }
  if (username === config.admin.user) {
    return res.status(409).json({ error: 'Ese usuario ya existe (administrador principal).' });
  }
  if (!ROLES.includes(role)) {
    return res.status(400).json({ error: 'Rol inválido.' });
  }
  if (!validatePassword(password)) {
    return res.status(400).json({ error: 'La contraseña debe tener al menos 8 caracteres.' });
  }
  if (repo.findUserByUsername(username)) {
    return res.status(409).json({ error: 'El usuario ya existe.' });
  }

  const { hash, salt } = auth.hashPassword(password);
  const id = repo.createUser({
    username,
    password_hash: hash,
    password_salt: salt,
    role,
    display_name: displayName,
    enabled: 1,
    created_by: req.auth ? req.auth.username : null,
  });

  logger.info('Usuario creado', {
    userId: id,
    username,
    role,
    createdBy: req.auth ? req.auth.username : null,
  });

  res.status(201).json({ item: safeUser(repo.findUserById(id)) });
}

function updateUser(req, res) {
  const id = Number(req.params.id);
  const user = repo.findUserById(id);
  if (!user) return res.status(404).json({ error: 'Usuario no encontrado.' });

  const fields = {};
  const self = req.auth && req.auth.userId != null && Number(req.auth.userId) === id;

  if (req.body.display_name !== undefined) {
    fields.display_name = req.body.display_name
      ? String(req.body.display_name).trim().slice(0, 120)
      : null;
  }

  if (req.body.role !== undefined) {
    const role = String(req.body.role);
    if (!ROLES.includes(role)) {
      return res.status(400).json({ error: 'Rol inválido.' });
    }
    if (self && role !== 'admin') {
      return res.status(400).json({ error: 'No puede quitarse a sí mismo el rol admin.' });
    }
    fields.role = role;
  }

  if (req.body.enabled !== undefined) {
    const enabled = ['1', 'true', 'yes', 'on'].includes(
      String(req.body.enabled).toLowerCase()
    ) || req.body.enabled === true;
    if (self && !enabled) {
      return res.status(400).json({ error: 'No puede deshabilitar su propio usuario.' });
    }
    fields.enabled = enabled ? 1 : 0;
  }

  if (req.body.password !== undefined && req.body.password !== '') {
    const password = String(req.body.password);
    if (!validatePassword(password)) {
      return res.status(400).json({
        error: 'La contraseña debe tener al menos 8 caracteres.',
      });
    }
    const { hash, salt } = auth.hashPassword(password);
    fields.password_hash = hash;
    fields.password_salt = salt;
  }

  if (Object.keys(fields).length === 0) {
    return res.status(400).json({ error: 'No se enviaron cambios.' });
  }

  repo.updateUser(id, fields);
  logger.info('Usuario actualizado', {
    userId: id,
    username: user.username,
    changed: Object.keys(fields),
    actor: req.auth ? req.auth.username : null,
  });

  res.json({ item: safeUser(repo.findUserById(id)) });
}

module.exports = { listUsers, createUser, updateUser, safeUser };
