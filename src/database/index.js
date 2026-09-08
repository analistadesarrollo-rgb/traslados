'use strict';

/**
 * Conexión a la base de datos SQLite usando el módulo nativo node:sqlite.
 *
 * Se usa SQLite embebido (sin servidor) para permitir la ejecución inmediata
 * sin dependencias externas. La capa de acceso a datos (repository.js) está
 * aislada para poder migrar a MySQL/MariaDB o PostgreSQL en el futuro sin
 * modificar el resto de la aplicación (ver README).
 */

const path = require('node:path');
const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');
const config = require('../config');

let db = null;

/**
 * Abre (o reutiliza) la conexión a la base de datos.
 * @returns {import('node:sqlite').DatabaseSync}
 */
function getDb() {
  if (db) return db;
  if (config.database.file === ':memory:') {
    db = new DatabaseSync(':memory:');
  } else {
    fs.mkdirSync(path.dirname(config.database.file), { recursive: true });
    db = new DatabaseSync(config.database.file);
    db.exec('PRAGMA journal_mode = WAL;');
  }
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec('PRAGMA busy_timeout = 10000;');
  return db;
}

/** Cierra la conexión. */
function closeDb() {
  if (db) {
    try {
      db.close();
    } catch (_) {
      /* ignore */
    }
    db = null;
  }
}

/** @returns {boolean} */
function isOpen() {
  return db !== null;
}

module.exports = { getDb, closeDb, isOpen };
