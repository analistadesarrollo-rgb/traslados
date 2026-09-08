'use strict';

const path = require('node:path');

// Cargar variables de entorno desde .env (si existe)
require('dotenv').config();

function intEnv(name, def) {
  const v = process.env[name];
  if (v === undefined || v === '') return def;
  const n = Number.parseInt(v, 10);
  return Number.isNaN(n) ? def : n;
}

function boolEnv(name, def) {
  const v = process.env[name];
  if (v === undefined || v === '') return def;
  return ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase());
}

function strList(name, def) {
  const v = process.env[name];
  if (v === undefined || v === '') return def;
  return String(v)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

const root = path.resolve(__dirname, '..', '..');

/**
 * Configuración central de la aplicación.
 * Toda la configuración se lee desde variables de entorno / .env.
 * Nunca se almacenan credenciales en el código fuente.
 */
const config = {
  root,
  env: process.env.NODE_ENV || 'development',
  port: intEnv('PORT', 3000),

  webSystem: {
    url: process.env.WEB_SYSTEM_URL || '',
    user: process.env.WEB_SYSTEM_USER || '',
    password: process.env.WEB_SYSTEM_PASSWORD || '',
  },

  database: {
    file: process.env.DB_FILE === ':memory:' ? ':memory:' : path.resolve(root, process.env.DB_FILE || './data/transfer-bot.sqlite'),
  },

  whatsapp: {
    sessionDir: path.resolve(root, process.env.WA_SESSION_DIR || './data/wa-session'),
    mediaDir: path.resolve(root, process.env.WA_MEDIA_DIR || './data/media'),
    qrTimeoutMs: intEnv('WA_QR_TIMEOUT_MS', 120000),
    allowedPhoneNumbers: strList('ALLOWED_PHONE_NUMBERS', []),
    browserPath: process.env.WA_BROWSER_PATH || '',
  },

  automation: {
    headless: boolEnv('AUTOMATION_HEADLESS', true),
    chromePath:
      process.env.CHROME_PATH ||
      'C:/Program Files/Google/Chrome/Application/chrome.exe',
    timeoutMs: intEnv('AUTOMATION_TIMEOUT_MS', 30000),
  },

  queue: {
    concurrency: intEnv('WORKER_CONCURRENCY', 1),
    pollIntervalMs: intEnv('QUEUE_POLL_INTERVAL_MS', 2000),
    jobLeaseMs: intEnv('JOB_LEASE_MS', 300000),
  },

  admin: {
    user: process.env.ADMIN_USER || 'admin',
    password: process.env.ADMIN_PASSWORD || '',
  },

  logging: {
    level: process.env.LOG_LEVEL || 'info',
    dir: path.resolve(root, process.env.LOG_DIR || './logs'),
  },
};

module.exports = config;
