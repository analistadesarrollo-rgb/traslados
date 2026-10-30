'use strict';

const config = require('../config');
const repo = require('../database/repository');
const { DOCUMENT_RE } = require('./validation');

/**
 * Reglas de negocio de la programación de traslados.
 *
 * Las fechas/horas se capturan SIEMPRE en America/Bogota (UTC-5, sin DST) y
 * se persisten además como instante absoluto UTC (`scheduled_at_utc`) para
 * comparar de forma segura sin depender de la zona horaria del servidor.
 */

const BOGOTA_OFFSET_MINUTES = 300; // UTC-5

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^\d{2}:\d{2}$/;

class ScheduleError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ScheduleError';
    this.code = code;
  }
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

/** Fecha/hora actual en la zona configurada (por defecto America/Bogota). */
function nowLocalParts(now = new Date()) {
  const s = now.toLocaleString('sv-SE', { timeZone: config.timezone });
  const [date, time] = s.split(' ');
  return { date, time: (time || '').slice(0, 5) };
}

/**
 * Convierte una fecha/hora local de Bogotá a ISO UTC.
 * @param {string} date YYYY-MM-DD
 * @param {string} time HH:MM
 */
function localToUtcIso(date, time) {
  const [y, m, d] = date.split('-').map(Number);
  const [hh, mm] = time.split(':').map(Number);
  const utcMs = Date.UTC(y, m - 1, d, hh, mm, 0) + BOGOTA_OFFSET_MINUTES * 60 * 1000;
  return new Date(utcMs).toISOString();
}

function isValidCalendarDate(date) {
  if (!DATE_RE.test(date)) return false;
  const [y, m, d] = date.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return (
    dt.getUTCFullYear() === y &&
    dt.getUTCMonth() === m - 1 &&
    dt.getUTCDate() === d
  );
}

function normalizeDocument(document) {
  return String(document === undefined || document === null ? '' : document).trim();
}

function normalizeBranch(branch) {
  return String(branch === undefined || branch === null ? '' : branch).trim();
}

/**
 * Valida y normaliza los datos de una programación.
 * @returns {{document:string,destination_branch:string,scheduled_date:string,scheduled_time:string,scheduled_at_utc:string}}
 */
function validateScheduleInput(input, opts = {}) {
  const document = normalizeDocument(input.document);
  const branch = normalizeBranch(input.destination_branch);
  const date = String(input.scheduled_date || '').trim();
  const time = String(input.scheduled_time || '').trim();

  if (!DOCUMENT_RE.test(document)) {
    throw new ScheduleError(
      'INVALID_DOCUMENT',
      'El documento debe contener entre 6 y 12 dígitos.'
    );
  }
  if (!branch || branch.length > 20 || /[\r\n]/.test(branch)) {
    throw new ScheduleError(
      'INVALID_BRANCH',
      'La sucursal destino es obligatoria (máximo 20 caracteres).'
    );
  }
  if (!isValidCalendarDate(date)) {
    throw new ScheduleError('INVALID_DATE', 'La fecha no es válida (formato AAAA-MM-DD).');
  }
  if (!TIME_RE.test(time)) {
    throw new ScheduleError('INVALID_TIME', 'La hora no es válida (formato HH:MM).');
  }
  const [hh, mm] = time.split(':').map(Number);
  if (hh > 23 || mm > 59) {
    throw new ScheduleError('INVALID_TIME', 'La hora no es válida (00:00 a 23:59).');
  }

  const scheduledAtUtc = localToUtcIso(date, time);
  if (opts.enforceFuture !== false) {
    if (Date.parse(scheduledAtUtc) <= Date.now()) {
      throw new ScheduleError(
        'PAST_DATE',
        'No se puede programar un traslado para una fecha/hora anterior al momento actual.'
      );
    }
  }

  return {
    document,
    destination_branch: branch,
    scheduled_date: date,
    scheduled_time: time,
    scheduled_at_utc: scheduledAtUtc,
  };
}

function canManage(actor, schedule) {
  if (!actor) return false;
  if (actor.role === 'admin') return true;
  if (actor.userId == null) return false;
  return Number(schedule.created_by_user_id) === Number(actor.userId);
}

function createSchedule(input, actor) {
  if (!actor) throw new ScheduleError('UNAUTHORIZED', 'Sesión requerida.');
  const data = validateScheduleInput(input);
  try {
    const id = repo.createSchedule({
      ...data,
      timezone: config.timezone,
      created_by_user_id: actor.userId,
      created_by_username: actor.username,
    });
    repo.insertScheduleAudit({
      schedule_id: id,
      action: 'CREATED',
      actor_username: actor.username,
      actor_user_id: actor.userId,
      details: {
        document: data.document,
        destination_branch: data.destination_branch,
        scheduled_at_utc: data.scheduled_at_utc,
      },
    });
    return repo.getScheduleById(id);
  } catch (e) {
    if (/UNIQUE constraint failed/i.test(String(e.message))) {
      throw new ScheduleError(
        'DUPLICATE',
        'Ya existe una programación activa para ese documento, sucursal y horario.'
      );
    }
    throw e;
  }
}

function getScheduleForActor(id, actor) {
  const schedule = repo.getScheduleById(id);
  if (!schedule) throw new ScheduleError('NOT_FOUND', 'Programación no encontrada.');
  if (!canManage(actor, schedule)) {
    throw new ScheduleError('FORBIDDEN', 'No tiene permiso sobre esta programación.');
  }
  return schedule;
}

function updateSchedule(id, input, actor) {
  const schedule = getScheduleForActor(id, actor);
  if (schedule.status !== 'SCHEDULED') {
    throw new ScheduleError(
      'NOT_EDITABLE',
      'Solo se pueden editar programaciones en estado SCHEDULED (aún no despachadas).'
    );
  }

  const merged = {
    document: input.document !== undefined ? input.document : schedule.document,
    destination_branch:
      input.destination_branch !== undefined
        ? input.destination_branch
        : schedule.destination_branch,
    scheduled_date:
      input.scheduled_date !== undefined ? input.scheduled_date : schedule.scheduled_date,
    scheduled_time:
      input.scheduled_time !== undefined ? input.scheduled_time : schedule.scheduled_time,
  };
  const data = validateScheduleInput(merged);

  let ok = false;
  try {
    ok = repo.updateSchedule(id, { ...data, timezone: config.timezone });
  } catch (e) {
    if (/UNIQUE constraint failed/i.test(String(e.message))) {
      throw new ScheduleError(
        'DUPLICATE',
        'Ya existe otra programación activa para ese documento, sucursal y horario.'
      );
    }
    throw e;
  }
  if (!ok) {
    throw new ScheduleError(
      'NOT_EDITABLE',
      'La programación ya no está en estado SCHEDULED; no se puede editar.'
    );
  }

  repo.insertScheduleAudit({
    schedule_id: id,
    action: 'UPDATED',
    actor_username: actor.username,
    actor_user_id: actor.userId,
    details: {
      before: {
        document: schedule.document,
        destination_branch: schedule.destination_branch,
        scheduled_at_utc: schedule.scheduled_at_utc,
      },
      after: {
        document: data.document,
        destination_branch: data.destination_branch,
        scheduled_at_utc: data.scheduled_at_utc,
      },
    },
  });

  return repo.getScheduleById(id);
}

function cancelSchedule(id, actor) {
  const schedule = getScheduleForActor(id, actor);
  if (schedule.status !== 'SCHEDULED') {
    throw new ScheduleError(
      'NOT_CANCELLABLE',
      'Solo se pueden cancelar programaciones en estado SCHEDULED (aún no despachadas).'
    );
  }
  const ok = repo.cancelSchedule(id, actor.username);
  if (!ok) {
    throw new ScheduleError('NOT_CANCELLABLE', 'La programación ya no se puede cancelar.');
  }
  repo.insertScheduleAudit({
    schedule_id: id,
    action: 'CANCELLED',
    actor_username: actor.username,
    actor_user_id: actor.userId,
    details: { previous_status: schedule.status },
  });
  return repo.getScheduleById(id);
}

function listSchedules(query, actor) {
  const limit = Math.min(Math.max(Number.parseInt(query.limit, 10) || 100, 1), 500);
  const offset = Math.max(Number.parseInt(query.offset, 10) || 0, 0);
  const opts = {
    limit,
    offset,
    status: query.status || undefined,
    document: query.document ? normalizeDocument(query.document) : undefined,
    date: query.date || undefined,
    userId: actor ? actor.userId : null,
    isAdmin: !!(actor && actor.role === 'admin'),
  };
  return {
    items: repo.listSchedules(opts),
    total: repo.countSchedules(opts),
    limit,
    offset,
  };
}

module.exports = {
  ScheduleError,
  BOGOTA_OFFSET_MINUTES,
  nowLocalParts,
  localToUtcIso,
  validateScheduleInput,
  createSchedule,
  updateSchedule,
  cancelSchedule,
  getScheduleForActor,
  listSchedules,
  canManage,
};
