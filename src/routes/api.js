'use strict';

const express = require('express');
const config = require('../config');
const controller = require('../controllers/dashboardController');

/**
 * Rutas de la API del panel administrativo.
 * Protegidas por Basic Auth cuando ADMIN_PASSWORD está configurado.
 */

function requireAuth(req, res, next) {
  if (!config.admin.password) return next();

  const auth = req.headers.authorization || '';
  const b64 = auth.startsWith('Basic ') ? auth.slice(6) : '';
  const decoded = Buffer.from(b64, 'base64').toString('utf8');
  const [user, pass] = decoded.split(':');
  if (user === config.admin.user && pass === config.admin.password) {
    return next();
  }
  res.set('WWW-Authenticate', 'Basic realm="admin"');
  return res.status(401).json({ error: 'Autenticación requerida' });
}

const router = express.Router();

router.get('/dashboard', requireAuth, controller.dashboard);
router.get('/history', requireAuth, controller.history);
router.get('/history/:id', requireAuth, controller.historyDetail);
router.get('/qr', requireAuth, controller.qr);
router.get('/health', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime() });
});

module.exports = { apiRouter: router, requireAuth };
