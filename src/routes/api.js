'use strict';

const express = require('express');
const auth = require('../auth');
const controller = require('../controllers/dashboardController');
const usersController = require('../controllers/usersController');
const schedulesController = require('../controllers/schedulesController');
const repo = require('../database/repository');

/**
 * Rutas de la API del panel.
 * - Sesión por cookie (login del panel) resuelta en app.checkSession.
 * - Basic Auth como alternativa para clientes API (admin de .env o usuarios).
 */

function requireAuth(req, res, next) {
  // 1. Cookie de sesión (login via formulario)
  if (req.auth) return next();

  // 2. Basic Auth (API clients)
  const header = req.headers.authorization || '';
  const b64 = header.startsWith('Basic ') ? header.slice(6) : '';
  if (b64) {
    const decoded = Buffer.from(b64, 'base64').toString('utf8');
    const idx = decoded.indexOf(':');
    if (idx >= 0) {
      const user = auth.authenticate(decoded.slice(0, idx), decoded.slice(idx + 1));
      if (user) {
        req.auth = user;
        req.authenticatedUser = user.username;
        return next();
      }
    }
  }

  res.set('WWW-Authenticate', 'Basic realm="admin"');
  return res.status(401).json({ error: 'Autenticación requerida' });
}

function requireRole(role) {
  return (req, res, next) => {
    if (!req.auth) {
      return res.status(401).json({ error: 'Autenticación requerida' });
    }
    if (req.auth.role !== role && req.auth.role !== 'admin') {
      return res.status(403).json({ error: 'No tiene permisos para esta operación.' });
    }
    return next();
  };
}

const router = express.Router();

// Sesión / identidad
router.get('/me', requireAuth, (req, res) => res.json({ user: req.auth }));

// Panel administrativo (solo admin)
router.get('/dashboard', requireAuth, requireRole('admin'), controller.dashboard);
router.get('/history', requireAuth, requireRole('admin'), controller.history);
router.get('/history/:id', requireAuth, requireRole('admin'), controller.historyDetail);
router.get('/qr', requireAuth, requireRole('admin'), controller.qr);
router.get('/allowed-numbers', requireAuth, requireRole('admin'), controller.listAllowedNumbers);
router.post('/allowed-numbers', requireAuth, requireRole('admin'), controller.addAllowedNumber);
router.delete('/allowed-numbers/:phone', requireAuth, requireRole('admin'), controller.removeAllowedNumber);
router.get('/allowed-numbers/debug', requireAuth, requireRole('admin'), (req, res) => {
  const items = repo.listAllowedNumbers().map(n => ({
    ...n,
    normalizedKey: repo.normalizePhoneKey(n.phone_number),
  }));
  res.json({ items });
});

// Usuarios (solo admin)
router.get('/users', requireAuth, requireRole('admin'), usersController.listUsers);
router.post('/users', requireAuth, requireRole('admin'), usersController.createUser);
router.patch('/users/:id', requireAuth, requireRole('admin'), usersController.updateUser);

// Programación de traslados (admin y scheduler)
router.get('/schedules', requireAuth, schedulesController.listSchedules);
router.post('/schedules', requireAuth, schedulesController.createSchedule);
router.get('/schedules/:id', requireAuth, schedulesController.getSchedule);
router.patch('/schedules/:id', requireAuth, schedulesController.updateSchedule);
router.post('/schedules/:id/cancel', requireAuth, schedulesController.cancelSchedule);

// Health (público)
router.get('/health', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime() });
});

module.exports = { apiRouter: router, requireAuth, requireRole };
