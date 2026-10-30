'use strict';

const { getDb } = require('./index');

/**
 * Capa de acceso a datos. Centraliza todas las consultas SQL.
 * Aislada para permitir migrar a MySQL/PostgreSQL sin tocar el resto.
 */

/** Retorna la fecha/hora actual en America/Bogota como 'YYYY-MM-DD HH:MM:SS'. */
function nowLocal() {
  return new Date().toLocaleString('sv-SE', { timeZone: 'America/Bogota' }).replace('T', ' ');
}

/**
 * Usa los últimos 10 dígitos como clave para que un número coincida con o
 * sin indicativo de país (ej. WhatsApp envía 573001234567, el panel puede
 * tener guardado 3001234567).
 */
function normalizePhoneKey(phone) {
  const digits = String(phone || '').replace(/[^0-9]/g, '');
  return digits.length > 10 ? digits.slice(-10) : digits;
}

// ---------------------------------------------------------------------
// TRANSFER REQUESTS
// ---------------------------------------------------------------------

function createTransferRequest(req) {
  const db = getDb();
  const res = db
    .prepare(
      `INSERT INTO transfer_requests
         (message_id, phone_number, document, source_branch,
          destination_branch, status, error_message, raw_message,
          origin, created_by_username, schedule_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      req.message_id,
      req.phone_number,
      req.document,
      req.source_branch || null,
      req.destination_branch,
      req.status || 'PENDING',
      req.error_message || null,
      req.raw_message || null,
      req.origin || 'whatsapp',
      req.created_by_username || null,
      req.schedule_id || null,
      nowLocal()
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
    sets.push('updated_at = ?');
    params.push(nowLocal());
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
       VALUES (?, ?, ?, 'PENDING', ?, ?)`
    )
    .run(entry.request_id, entry.document, entry.payload, entry.priority || 0, nowLocal());
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
                started_at=?, attempts=attempts+1
          WHERE id=? AND status='PENDING'`
      )
      .run(owner, leaseUntil, nowLocal(), candidate.id);

    if (res.changes === 0) return null;

    return db.prepare('SELECT * FROM job_queue WHERE id = ?').get(candidate.id);
  });
}

function markJobDone(id, payload = null) {
  const db = getDb();
  db.prepare(
    `UPDATE job_queue
        SET status='DONE', lock_owner=NULL, lease_until=NULL,
            completed_at=?, error=NULL, payload=?
      WHERE id=?`
  ).run(JSON.stringify(payload || {}), nowLocal(), id);
}

function markJobFailed(id, error) {
  const db = getDb();
  db.prepare(
    `UPDATE job_queue
        SET status='FAILED', lock_owner=NULL, lease_until=NULL,
            completed_at=?, error=?
      WHERE id=?`
  ).run(nowLocal(), String(error || '').slice(0, 2000), id);
}

// ---------------------------------------------------------------------
// ACTIVITY LOGS
// ---------------------------------------------------------------------

function insertLog(level, component, message, meta, requestId) {
  const db = getDb();
  db.prepare(
    `INSERT INTO activity_logs (level, component, message, meta, request_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(
    level,
    component || null,
    String(message),
    meta ? JSON.stringify(meta) : null,
    requestId || null,
    nowLocal()
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
  return !!db.prepare('SELECT 1 FROM allowed_numbers WHERE phone_number = ?').get(normalizePhoneKey(phoneNumber));
}

function countAllowedNumbers() {
  const db = getDb();
  return db.prepare('SELECT COUNT(*) AS c FROM allowed_numbers').get().c;
}

function addAllowedNumber(phoneNumber, label) {
  const db = getDb();
  db.prepare(
    `INSERT INTO allowed_numbers (phone_number, label, created_at)
     VALUES (?, ?, ?)
     ON CONFLICT(phone_number) DO UPDATE SET label = excluded.label`
  ).run(normalizePhoneKey(phoneNumber), label || null, nowLocal());
}

function removeAllowedNumber(phoneNumber) {
  const db = getDb();
  const res = db.prepare('DELETE FROM allowed_numbers WHERE phone_number = ?').run(normalizePhoneKey(phoneNumber));
  return res.changes > 0;
}

/**
 * Obtiene la etiqueta de un número autorizado.
 * @param {string} phone
 * @returns {string|null}
 */
function getNumberLabel(phone) {
  const db = getDb();
  const key = normalizePhoneKey(phone);
  const row = db.prepare('SELECT label FROM allowed_numbers WHERE phone_number = ?').get(key);
  return row && row.label ? row.label : null;
}

// ---------------------------------------------------------------------
// USERS
// ---------------------------------------------------------------------

function createUser(user) {
  const db = getDb();
  const res = db
    .prepare(
      `INSERT INTO users
         (username, password_hash, password_salt, role, display_name,
          enabled, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      user.username,
      user.password_hash,
      user.password_salt,
      user.role || 'scheduler',
      user.display_name || null,
      user.enabled === undefined ? 1 : (user.enabled ? 1 : 0),
      user.created_by || null,
      nowLocal()
    );
  return res.lastInsertRowid;
}

/** Devuelve la fila completa (incluye hash/salt). Solo para autenticación. */
function findUserByUsername(username) {
  const db = getDb();
  return db.prepare('SELECT * FROM users WHERE username = ?').get(username) || null;
}

function findUserById(id) {
  const db = getDb();
  return db.prepare('SELECT * FROM users WHERE id = ?').get(id) || null;
}

/** Listado seguro: nunca expone hash/salt. */
function listUsers() {
  const db = getDb();
  return db
    .prepare(
      `SELECT id, username, role, display_name, enabled, created_by,
              created_at, updated_at
         FROM users ORDER BY id ASC`
    )
    .all();
}

function updateUser(id, fields) {
  const db = getDb();
  const allowed = [
    'username',
    'password_hash',
    'password_salt',
    'role',
    'display_name',
    'enabled',
  ];
  const sets = [];
  const params = [];
  for (const key of allowed) {
    if (key in fields) {
      sets.push(`${key} = ?`);
      params.push(fields[key]);
    }
  }
  if (sets.length === 0) return false;
  sets.push('updated_at = ?');
  params.push(nowLocal());
  params.push(id);
  const res = db.prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`).run(...params);
  return res.changes > 0;
}

function countUsers() {
  const db = getDb();
  return db.prepare('SELECT COUNT(*) AS c FROM users').get().c;
}

// ---------------------------------------------------------------------
// SCHEDULES (programación automática de traslados)
// ---------------------------------------------------------------------

function createSchedule(s) {
  const db = getDb();
  const res = db
    .prepare(
      `INSERT INTO schedules
         (document, destination_branch, scheduled_date, scheduled_time,
          scheduled_at_utc, timezone, status, created_by_user_id,
          created_by_username, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'SCHEDULED', ?, ?, ?)`
    )
    .run(
      s.document,
      s.destination_branch,
      s.scheduled_date,
      s.scheduled_time,
      s.scheduled_at_utc,
      s.timezone || 'America/Bogota',
      s.created_by_user_id || null,
      s.created_by_username,
      nowLocal()
    );
  return res.lastInsertRowid;
}

function getScheduleById(id) {
  const db = getDb();
  return db.prepare('SELECT * FROM schedules WHERE id = ?').get(id) || null;
}

function listSchedules(opts = {}) {
  const db = getDb();
  const {
    limit = 100,
    offset = 0,
    status,
    document,
    date,
    userId,
    isAdmin = false,
  } = opts;
  const where = [];
  const params = [];
  if (!isAdmin) {
    where.push('created_by_user_id = ?');
    params.push(userId);
  }
  if (status) {
    where.push('status = ?');
    params.push(status);
  }
  if (document) {
    where.push('document = ?');
    params.push(document);
  }
  if (date) {
    where.push('scheduled_date = ?');
    params.push(date);
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  params.push(limit, offset);
  return db
    .prepare(
      `SELECT * FROM schedules ${whereSql}
        ORDER BY scheduled_at_utc DESC, id DESC LIMIT ? OFFSET ?`
    )
    .all(...params);
}

function countSchedules(opts = {}) {
  const db = getDb();
  const { status, document, date, userId, isAdmin = false } = opts;
  const where = [];
  const params = [];
  if (!isAdmin) {
    where.push('created_by_user_id = ?');
    params.push(userId);
  }
  if (status) {
    where.push('status = ?');
    params.push(status);
  }
  if (document) {
    where.push('document = ?');
    params.push(document);
  }
  if (date) {
    where.push('scheduled_date = ?');
    params.push(date);
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const row = db
    .prepare(`SELECT COUNT(*) AS c FROM schedules ${whereSql}`)
    .get(...params);
  return row ? row.c : 0;
}

/** Solo permite modificar programaciones aún no despachadas. */
function updateSchedule(id, fields) {
  const db = getDb();
  const allowed = [
    'document',
    'destination_branch',
    'scheduled_date',
    'scheduled_time',
    'scheduled_at_utc',
    'timezone',
  ];
  const sets = [];
  const params = [];
  for (const key of allowed) {
    if (key in fields) {
      sets.push(`${key} = ?`);
      params.push(fields[key]);
    }
  }
  if (sets.length === 0) return false;
  sets.push('updated_at = ?');
  params.push(nowLocal());
  params.push(id);
  const res = db
    .prepare(`UPDATE schedules SET ${sets.join(', ')} WHERE id = ? AND status = 'SCHEDULED'`)
    .run(...params);
  return res.changes > 0;
}

function cancelSchedule(id, actorUsername) {
  const db = getDb();
  const res = db
    .prepare(
      `UPDATE schedules
          SET status='CANCELLED', cancelled_at=?, cancelled_by=?, updated_at=?
        WHERE id=? AND status='SCHEDULED'`
    )
    .run(nowLocal(), actorUsername || null, nowLocal(), id);
  return res.changes > 0;
}

function listDueSchedules(nowUtc, limit = 50) {
  const db = getDb();
  return db
    .prepare(
      `SELECT * FROM schedules
        WHERE status = 'SCHEDULED' AND scheduled_at_utc <= ?
        ORDER BY scheduled_at_utc ASC, id ASC LIMIT ?`
    )
    .all(nowUtc, limit);
}

/**
 * Despacha atómicamente una programación vencida hacia la cola existente.
 * - Crea (o reutiliza) el transfer_request con message_id idempotente.
 * - Encola el job de forma idempotente.
 * - Transiciona SCHEDULED -> QUEUED solo si sigue en SCHEDULED.
 * Todo dentro de una única transacción: un crash no deja estados a medias.
 */
function dispatchSchedule(id, opts = {}) {
  const db = getDb();
  const nowUtc = opts.nowUtc || new Date().toISOString();
  const lateThresholdMs = opts.lateThresholdMs || 0;

  db.exec('BEGIN IMMEDIATE');
  try {
    const sch = db.prepare('SELECT * FROM schedules WHERE id = ?').get(id);
    if (!sch || sch.status !== 'SCHEDULED') {
      db.exec('COMMIT');
      return { dispatched: false, reason: 'not_scheduled' };
    }
    if (sch.scheduled_at_utc > nowUtc) {
      db.exec('COMMIT');
      return { dispatched: false, reason: 'not_due' };
    }

    const messageId = `sched:${id}`;
    let request = db
      .prepare('SELECT * FROM transfer_requests WHERE message_id = ?')
      .get(messageId);
    let requestId;
    if (request) {
      requestId = request.id;
    } else {
      const ins = db
        .prepare(
          `INSERT INTO transfer_requests
             (message_id, phone_number, document, source_branch,
              destination_branch, status, error_message, raw_message,
              origin, created_by_username, schedule_id, created_at)
           VALUES (?, '', ?, NULL, ?, 'PENDING', NULL, NULL, 'panel', ?, ?, ?)`
        )
        .run(messageId, sch.document, sch.destination_branch, sch.created_by_username, id, nowLocal());
      requestId = ins.lastInsertRowid;
    }

    let job = db.prepare('SELECT id FROM job_queue WHERE request_id = ?').get(requestId);
    let jobId;
    if (job) {
      jobId = job.id;
    } else {
      const payload = JSON.stringify({
        origin: 'panel',
        notify: false,
        scheduleId: id,
        document: sch.document,
        branch: sch.destination_branch,
        phoneNumber: '',
        chatId: null,
      });
      const ins = db
        .prepare(
          `INSERT INTO job_queue (request_id, document, payload, status, priority, created_at)
           VALUES (?, ?, ?, 'PENDING', 0, ?)`
        )
        .run(requestId, sch.document, payload, nowLocal());
      jobId = ins.lastInsertRowid;
    }

    const late =
      Date.parse(nowUtc) - Date.parse(sch.scheduled_at_utc) > lateThresholdMs ? 1 : 0;

    db.prepare(
      `UPDATE schedules
          SET status='QUEUED', request_id=?, job_id=?, dispatched_at=?,
              late=?, updated_at=?
        WHERE id=? AND status='SCHEDULED'`
    ).run(requestId, jobId, nowLocal(), late, nowLocal(), id);

    insertScheduleAudit({
      schedule_id: id,
      action: 'DISPATCHED',
      actor_username: sch.created_by_username,
      actor_user_id: sch.created_by_user_id,
      details: { requestId, jobId, late: !!late, nowUtc },
    });

    db.exec('COMMIT');
    return { dispatched: true, requestId, jobId, late: !!late };
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

/**
 * Proyecta el estado de transfer_requests sobre las programaciones activas.
 * No ejecuta nada: solo sincroniza QUEUED/PROCESSING con la cola/worker.
 */
function syncScheduleStatuses() {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT s.id, s.status, s.request_id, s.created_by_username,
              s.created_by_user_id, t.status AS req_status,
              t.error_message, t.completed_at
         FROM schedules s
         JOIN transfer_requests t ON t.id = s.request_id
        WHERE s.status IN ('QUEUED','PROCESSING') AND s.request_id IS NOT NULL`
    )
    .all();

  const map = {
    PENDING: 'QUEUED',
    PROCESSING: 'PROCESSING',
    SUCCESS: 'SUCCESS',
    FAILED: 'FAILED',
  };
  const updated = [];

  for (const r of rows) {
    const next = map[r.req_status];
    if (!next || next === r.status) continue;
    const terminal = next === 'SUCCESS' || next === 'FAILED';
    db.prepare(
      `UPDATE schedules
          SET status=?, updated_at=?, executed_at=?, error_message=?, result_message=?
        WHERE id=?`
    ).run(
      next,
      nowLocal(),
      terminal ? (r.completed_at || nowLocal()) : null,
      next === 'FAILED' ? (r.error_message || null) : null,
      next === 'SUCCESS' ? 'Traslado ejecutado correctamente' : null,
      r.id
    );
    insertScheduleAudit({
      schedule_id: r.id,
      action: next === 'SUCCESS' ? 'EXECUTED' : next === 'FAILED' ? 'FAILED' : 'STATUS_CHANGED',
      actor_username: 'sistema',
      actor_user_id: null,
      details: { status: next },
    });
    updated.push(r.id);
  }
  return updated;
}

function insertScheduleAudit(entry) {
  const db = getDb();
  db.prepare(
    `INSERT INTO schedule_audit
       (schedule_id, action, actor_username, actor_user_id, details, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(
    entry.schedule_id,
    entry.action,
    entry.actor_username || null,
    entry.actor_user_id || null,
    entry.details ? JSON.stringify(entry.details) : null,
    nowLocal()
  );
}

function listScheduleAudit(scheduleId) {
  const db = getDb();
  return db
    .prepare(
      'SELECT * FROM schedule_audit WHERE schedule_id = ? ORDER BY id ASC'
    )
    .all(scheduleId);
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
  getNumberLabel,
  normalizePhoneKey,
  // users
  createUser,
  findUserByUsername,
  findUserById,
  listUsers,
  updateUser,
  countUsers,
  // schedules
  createSchedule,
  getScheduleById,
  listSchedules,
  countSchedules,
  updateSchedule,
  cancelSchedule,
  listDueSchedules,
  dispatchSchedule,
  syncScheduleStatuses,
  insertScheduleAudit,
  listScheduleAudit,
};
