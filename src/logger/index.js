'use strict';

const fs = require('node:fs');
const path = require('node:path');
const config = require('../config');

let repo = null;

/**
 * Logger estructurado (JSON). Escribe a consola y a un archivo de rotación
 * por día, y opcionalmente persiste a la tabla activity_logs.
 *
 * No depende de librerías externas (pino no estaba disponible en el entorno
 * de instalación offline), por lo que se implementa de forma ligera pero
 * con el mismo contrato: level, componente, mensaje y metadatos.
 */

const LEVELS = { trace: 10, debug: 20, info: 30, warn: 40, error: 50, fatal: 60 };
const minLevel = LEVELS[config.logging.level] || LEVELS.info;

// registrar acceso (para que _bindRepo se pueda llamar desde index)
let logFileStream = null;

function fileStream() {
  if (logFileStream) return logFileStream;
  fs.mkdirSync(config.logging.dir, { recursive: true });
  const day = new Date().toISOString().slice(0, 10);
  const file = path.join(config.logging.dir, `app-${day}.log`);
  logFileStream = fs.createWriteStream(file, { flags: 'a' });
  return logFileStream;
}

function bindRepo(r) {
  repo = r;
}

function emit(level, component, message, meta) {
  const numeric = LEVELS[level] !== undefined ? LEVELS[level] : LEVELS.info;
  if (numeric < minLevel) return;

  const entry = {
    level,
    component: component || 'app',
    message,
    meta: meta || undefined,
    timestamp: new Date().toISOString(),
  };
  const line = JSON.stringify(entry);

  try {
    console[level === 'error' || level === 'fatal' ? 'error' : 'log'](line);
    const f = fileStream();
    f.write(line + '\n');
  } catch (_) {
    /* console/write errors should not crash */
  }

  // Persistir a BD (solo si está disponible)
  if (repo && typeof repo.insertLog === 'function') {
    try {
      repo.insertLog(
        level,
        component,
        message,
        meta || {},
        meta && meta.requestId ? meta.requestId : null
      );
    } catch (_) {
      /* DB logging is best-effort */
    }
  }
}

const logger = {
  bindRepo,
  trace: (c, m, meta) => emit('trace', c, m, meta),
  debug: (c, m, meta) => emit('debug', c, m, meta),
  info: (c, m, meta) => emit('info', c, m, meta),
  warn: (c, m, meta) => emit('warn', c, m, meta),
  error: (c, m, meta) => emit('error', c, m, meta),
  fatal: (c, m, meta) => emit('fatal', c, m, meta),
  child: (component) => {
    const child = {};
    for (const lv of Object.keys(LEVELS)) {
      child[lv] = (m, meta) => emit(lv, component, m, meta);
    }
    return child;
  },
};

module.exports = logger;
