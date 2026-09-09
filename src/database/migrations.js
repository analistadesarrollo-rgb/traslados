'use strict';

const { getDb } = require('./index');

/**
 * Esquema de la base de datos.
 *
 * Tablas:
 *  - schema_migrations : registro de migraciones aplicadas.
 *  - transfer_requests: solicitudes/traslados (auditoría e idempotencia).
 *  - job_queue        : cola de trabajos (para procesamiento asíncrono).
 *  - activity_logs    : logs estructurados de la aplicación.
 */

const MIGRATIONS = [
  {
    version: 1,
    name: 'create transfer_requests, job_queue, activity_logs',
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS transfer_requests (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          message_id TEXT NOT NULL,
          phone_number TEXT NOT NULL,
          document TEXT NOT NULL,
          source_branch TEXT,
          destination_branch TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'PENDING',
          started_at TEXT,
          completed_at TEXT,
          error_message TEXT,
          raw_message TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT
        );

        CREATE UNIQUE INDEX IF NOT EXISTS idx_transfer_message_id
          ON transfer_requests (message_id);
        CREATE INDEX IF NOT EXISTS idx_transfer_document
          ON transfer_requests (document);
        CREATE INDEX IF NOT EXISTS idx_transfer_status
          ON transfer_requests (status);
      `);

      db.exec(`
        CREATE TABLE IF NOT EXISTS job_queue (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          request_id INTEGER NOT NULL,
          document TEXT NOT NULL,
          payload TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'PENDING', -- PENDING | PROCESSING | DONE | FAILED
          attempts INTEGER NOT NULL DEFAULT 0,
          lock_owner TEXT,
          lease_until TEXT,
          error TEXT,
          priority INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          started_at TEXT,
          completed_at TEXT,
          FOREIGN KEY (request_id) REFERENCES transfer_requests(id)
        );
        CREATE INDEX IF NOT EXISTS idx_job_status ON job_queue (status);
        CREATE INDEX IF NOT EXISTS idx_job_document ON job_queue (document);
      `);

      db.exec(`
        CREATE TABLE IF NOT EXISTS activity_logs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          level TEXT NOT NULL,
          component TEXT,
          message TEXT NOT NULL,
          meta TEXT,
          request_id INTEGER,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS idx_activity_request ON activity_logs (request_id);
        CREATE INDEX IF NOT EXISTS idx_activity_created ON activity_logs (created_at);
      `);
    },
  },
  {
    version: 2,
    name: 'create allowed_numbers',
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS allowed_numbers (
          phone_number TEXT PRIMARY KEY,
          label TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
      `);
    },
  },
];

/**
 * Aplica las migraciones pendientes. Es idempotente.
 */
function migrate() {
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  const applied = new Set(
    db.prepare('SELECT version FROM schema_migrations').all().map((r) => r.version)
  );

  let count = 0;
  for (const m of MIGRATIONS) {
    if (applied.has(m.version)) continue;
    db.exec('BEGIN');
    try {
      m.up(db);
      db.prepare(
        'INSERT INTO schema_migrations (version, name) VALUES (?, ?)'
      ).run(m.version, m.name);
      db.exec('COMMIT');
      count += 1;
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }
  return { applied: count, total: MIGRATIONS.length };
}

module.exports = { migrate, MIGRATIONS };
