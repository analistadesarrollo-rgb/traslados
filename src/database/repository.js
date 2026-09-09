'use strict';

const { getDb } = require('./index');

/**
 * Capa de acceso a datos. Centraliza todas las consultas SQL.
 * Aislada para permitir migrar a MySQL/PostgreSQL sin tocar el resto.
 */

// ---------------------------------------------------------------------
// TRANSFER REQUESTS
// ---------------------------------------------------------------------

function createTransferRequest(req) {
  const db = getDb();
  const res = db
    .prepare(
      `INSERT INTO transfer_requests
         (message_id, phone_number, document, source_branch,
          destination_branch, status, error_message, raw_message, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`
    )
    .run(
      req.message_id,
      req.phone_number,
      req.document,
      req.source_branch || null,
      req.destination_branch,
      req.status || 'PENDING',
      req.error_message || null,
      req.raw_message || null
    );
  return res.lastInsertRowid;
}

function findTransferRequestByMessageId(messageId) {
  const db = getDb();
  return db
    .prepare('SELECT * FROM transfer_requests WHERE message_id = ?')
    .get(messageId) || null;
}

function getTransferRequestById(id) {
  const db = getDb();
  return db.prepare('SELECT * FROM transfer_requests WHERE id = ?').get(id) || null;
}

function updateTransferRequest(id, fields) {
  const db = getDb();
  const allowed = [
    'source_branch',
    'destination_branch',
    'status',
    'started_at',
    'completed_at',
    'error_message',
    'updated_at',
  ];
  const sets = [];
  const params = [];
  for (const key of allowed) {
    if (key in fields) {
      const col = key === 'updated_at' ? key : key;
      sets.push(`${col} = ?`);
      params.push(fields[key]);
    }
  }
  if (fields.status) {
    // siempre actualizar updated_at cuando cambia el status
    sets.push('updated_at = datetime(\'now\')');
  }
  if (sets.length === 0) return false;
  params.push(id);
  const res = db.prepare(`UPDATE transfer_requests SET ${sets.join(', ')} WHERE id = ?`).run(...params);
  return res.changes > 0;
}

function listTransferRequests(opts = {}) {
  const db = getDb();
  const { limit = 100, offset = 0, status, document } = opts;
  const where = [];
  const params = [];
  if (status) {
    where.push('status = ?');
    params.push(status);
  }
  if (document) {
    where.push('document = ?');
    params.push(document);
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  params.push(limit, offset);
  return db
    .prepare(
      `SELECT * FROM transfer_requests ${whereSql}
       ORDER BY created_at DESC LIMIT ? OFFSET ?`
    )
    .all(...params);
}

function countTransferRequests(opts = {}) {
  const db = getDb();
  const { status, document, date } = opts;
  const where = [];
  const params = [];
  if (status) {
    where.push('status = ?');
    params.push(status);
  }
  if (document) {
    where.push('document = ?');
    params.push(document);
  }
  if (date) {
    where.push(`date(created_at) = date(?)`);
    params.push(date);
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const row = db
    .prepare(`SELECT COUNT(*) AS c FROM transfer_requests ${whereSql}`)
    .get(...params);
  return row ? row.c : 0;
}

function getStatusCounts() {
  const db = getDb();
  const rows = db
    .prepare('SELECT status, COUNT(*) AS c FROM transfer_requests GROUP BY status')
    .all();
  const out = { PENDING: 0, PROCESSING: 0, SUCCESS: 0, FAILED: 0 };
  for (const r of rows) {
    if (r.status in out) out[r.status] = r.c;
  }
  return out;
}

// ---------------------------------------------------------------------
// JOB QUEUE
// ---------------------------------------------------------------------

function enqueueJob(entry) {
  const db = getDb();
  // Idempotencia por (request_id): no encolar dos veces la misma solicitud.
  const existing = db
    .prepare('SELECT id FROM job_queue WHERE request_id = ?')
    .get(entry.request_id);
  if (existing) return { id: existing.id, duplicated: true };
  const res = db
    .prepare(
      `INSERT INTO job_queue (request_id, document, payload, status, priority, created_at)
       VALUES (?, ?, ?, 'PENDING', ?, datetime('now'))`
    )
    .run(entry.request_id, entry.document, entry.payload, entry.priority || 0);
  return { id: res.lastInsertRowid, duplicated: false };
}

/**
 * Toma el siguiente job PENDING con lock atómico (por documento).
 * El lock de documento impide procesar dos trabajos del mismo documento
 * de forma simultánea. Devuelve null si no hay trabajo disponible.
 */
function claimNextJob(owner, leaseMs) {
  const db = getDb();
  const nowIso = new Date().toISOString();
  const leaseUntil = new Date(Date.now() + leaseMs).toISOString();

  const tx = (fn) => {
    db.exec('BEGIN IMMEDIATE');
    try {
      const out = fn();
      db.exec('COMMIT');
      return out;
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  };

  return tx(() => {
    // Reasignar jobs cuyo lease expiró (worker murió a mitad de proceso)
    db.prepare(
      `UPDATE job_queue
         SET status='PENDING', lock_owner=NULL, lease_until=NULL
       WHERE status='PROCESSING' AND lease_until IS NOT NULL AND lease_until < ?`
    ).run(nowIso);

    // Buscar un job PENDING que no tenga otro job ACTIVO más antiguo
    // del mismo documento. Esto garantiza un lock por documento: solo se
    // entrega el job activo más antiguo de cada documento a la vez.
    const candidate = db
      .prepare(
        `SELECT j.id
           FROM job_queue j
          WHERE j.status = 'PENDING'
            AND NOT EXISTS (
              SELECT 1 FROM job_queue o
               WHERE o.document = j.document
                 AND o.status IN ('PENDING','PROCESSING')
                 AND o.id < j.id
            )
          ORDER BY j.priority DESC, j.id ASC
          LIMIT 1`
      )
      .get();

    if (!candidate) return null;

    const res = db
      .prepare(
        `UPDATE job_queue
            SET status='PROCESSING', lock_owner=?, lease_until=?,
                started_at=datetime('now'), attempts=attempts+1
          WHERE id=? AND status='PENDING'`
      )
      .run(owner, leaseUntil, candidate.id);

    if (res.changes === 0) return null;

    return db.prepare('SELECT * FROM job_queue WHERE id = ?').get(candidate.id);
  });
}

function markJobDone(id, payload = null) {
  const db = getDb();
  db.prepare(
    `UPDATE job_queue
        SET status='DONE', lock_owner=NULL, lease_until=NULL,
            completed_at=datetime('now'), error=NULL, payload=?
      WHERE id=?`
  ).run(JSON.stringify(payload || {}), id);
}

function markJobFailed(id, error) {
  const db = getDb();
  db.prepare(
    `UPDATE job_queue
        SET status='FAILED', lock_owner=NULL, lease_until=NULL,
            completed_at=datetime('now'), error=?
      WHERE id=?`
  ).run(String(error || '').slice(0, 2000), id);
}

// ---------------------------------------------------------------------
// ACTIVITY LOGS
// ---------------------------------------------------------------------

function insertLog(level, component, message, meta, requestId) {
  const db = getDb();
  db.prepare(
    `INSERT INTO activity_logs (level, component, message, meta, request_id, created_at)
     VALUES (?, ?, ?, ?, ?, datetime('now'))`
  ).run(
    level,
    component || null,
    String(message),
    meta ? JSON.stringify(meta) : null,
    requestId || null
  );
}

function listActivityLogs(opts = {}) {
  const db = getDb();
  const { limit = 100, requestId } = opts;
  if (requestId) {
    return db
      .prepare(
        'SELECT * FROM activity_logs WHERE request_id = ? ORDER BY created_at DESC, id DESC LIMIT ?'
      )
      .all(requestId, limit);
  }
  return db
    .prepare('SELECT * FROM activity_logs ORDER BY created_at DESC, id DESC LIMIT ?')
    .all(limit);
}

function listRecentErrors(limit = 20) {
  const db = getDb();
  return db
    .prepare(
      `SELECT * FROM activity_logs
        WHERE level IN ('error','warn')
        ORDER BY created_at DESC, id DESC LIMIT ?`
    )
    .all(limit);
}

// ---------------------------------------------------------------------
// ALLOWED NUMBERS
// ---------------------------------------------------------------------

function listAllowedNumbers() {
  const db = getDb();
  return db.prepare('SELECT * FROM allowed_numbers ORDER BY created_at DESC').all();
}

function isAllowedNumber(phoneNumber) {
  const db = getDb();
  return !!db.prepare('SELECT 1 FROM allowed_numbers WHERE phone_number = ?').get(phoneNumber);
}

function countAllowedNumbers() {
  const db = getDb();
  return db.prepare('SELECT COUNT(*) AS c FROM allowed_numbers').get().c;
}

function addAllowedNumber(phoneNumber, label) {
  const db = getDb();
  db.prepare(
    `INSERT INTO allowed_numbers (phone_number, label, created_at)
     VALUES (?, ?, datetime('now'))
     ON CONFLICT(phone_number) DO UPDATE SET label = excluded.label`
  ).run(phoneNumber, label || null);
}

function removeAllowedNumber(phoneNumber) {
  const db = getDb();
  const res = db.prepare('DELETE FROM allowed_numbers WHERE phone_number = ?').run(phoneNumber);
  return res.changes > 0;
}

module.exports = {
  // transfer_requests
  createTransferRequest,
  findTransferRequestByMessageId,
  getTransferRequestById,
  updateTransferRequest,
  listTransferRequests,
  countTransferRequests,
  getStatusCounts,
  // job_queue
  enqueueJob,
  claimNextJob,
  markJobDone,
  markJobFailed,
  // activity_logs
  insertLog,
  listActivityLogs,
  listRecentErrors,
  // allowed_numbers
  listAllowedNumbers,
  isAllowedNumber,
  countAllowedNumbers,
  addAllowedNumber,
  removeAllowedNumber,
};
