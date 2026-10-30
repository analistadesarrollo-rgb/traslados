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

      // Migra los números heredados de ALLOWED_PHONE_NUMBERS (.env) para no
      // perder acceso al activar la restricción por primera vez.
      const legacyNumbers = String(process.env.ALLOWED_PHONE_NUMBERS || '')
        .split(',')
        .map((s) => s.replace(/[^0-9]/g, ''))
        .map((digits) => (digits.length > 10 ? digits.slice(-10) : digits))
        .filter(Boolean);
      const insert = db.prepare(
        `INSERT OR IGNORE INTO allowed_numbers (phone_number) VALUES (?)`
      );
      for (const phone of legacyNumbers) insert.run(phone);
    },
  },
  {
    version: 3,
    name: 'create users, schedules, schedule_audit; extend transfer_requests',
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS users (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          username TEXT NOT NULL,
          password_hash TEXT NOT NULL,
          password_salt TEXT NOT NULL,
          role TEXT NOT NULL DEFAULT 'scheduler',
          display_name TEXT,
          enabled INTEGER NOT NULL DEFAULT 1,
          created_by TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT
        );
        CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username
          ON users (username);
      `);

      db.exec(`
        CREATE TABLE IF NOT EXISTS schedules (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          document TEXT NOT NULL,
          destination_branch TEXT NOT NULL,
          scheduled_date TEXT NOT NULL,          -- YYYY-MM-DD (America/Bogota)
          scheduled_time TEXT NOT NULL,          -- HH:MM (America/Bogota)
          scheduled_at_utc TEXT NOT NULL,        -- instante absoluto en UTC
          timezone TEXT NOT NULL DEFAULT 'America/Bogota',
          status TEXT NOT NULL DEFAULT 'SCHEDULED',
          created_by_user_id INTEGER,
          created_by_username TEXT NOT NULL,
          request_id INTEGER,
          job_id INTEGER,
          late INTEGER NOT NULL DEFAULT 0,
          dispatched_at TEXT,
          executed_at TEXT,
          result_message TEXT,
          error_message TEXT,
          cancelled_at TEXT,
          cancelled_by TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT,
          FOREIGN KEY (created_by_user_id) REFERENCES users(id) ON DELETE SET NULL,
          FOREIGN KEY (request_id) REFERENCES transfer_requests(id)
        );
        CREATE INDEX IF NOT EXISTS idx_schedules_status ON schedules (status);
        CREATE INDEX IF NOT EXISTS idx_schedules_due ON schedules (scheduled_at_utc);
        CREATE INDEX IF NOT EXISTS idx_schedules_user ON schedules (created_by_user_id);
        CREATE INDEX IF NOT EXISTS idx_schedules_document ON schedules (document);
        -- Evita duplicados: no puede haber dos programaciones vivas (no
        -- canceladas ni fallidas) para el mismo documento+sucursal+instante.
        CREATE UNIQUE INDEX IF NOT EXISTS idx_schedules_unique_active
          ON schedules (document, destination_branch, scheduled_at_utc)
          WHERE status IN ('SCHEDULED','QUEUED','PROCESSING','SUCCESS');
      `);

      db.exec(`
        CREATE TABLE IF NOT EXISTS schedule_audit (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          schedule_id INTEGER NOT NULL,
          action TEXT NOT NULL,
          actor_username TEXT,
          actor_user_id INTEGER,
          details TEXT,
          created_at TEXT NOT NULL,
          FOREIGN KEY (schedule_id) REFERENCES schedules(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_schedule_audit_schedule
          ON schedule_audit (schedule_id);
      `);

      // Origen/usuario responsable de cada traslado (WhatsApp vs panel).
      // ALTER TABLE ADD COLUMN con DEFAULT es seguro sobre datos existentes.
      db.exec(`
        ALTER TABLE transfer_requests ADD COLUMN origin TEXT NOT NULL DEFAULT 'whatsapp';
      `);
      db.exec(`
        ALTER TABLE transfer_requests ADD COLUMN created_by_username TEXT;
      `);
      db.exec(`
        ALTER TABLE transfer_requests ADD COLUMN schedule_id INTEGER;
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
