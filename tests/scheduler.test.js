'use strict';

process.env.DB_FILE = ':memory:';
process.env.ADMIN_USER = 'admin';
process.env.ADMIN_PASSWORD = 'adminpass-test';
process.env.LOG_LEVEL = 'error';
process.env.QUEUE_POLL_INTERVAL_MS = '20';

const { test, before, after } = require('node:test');
const assert = require('node:assert');

const { migrate } = require('../src/database/migrations');
const { getDb, closeDb } = require('../src/database');
const repo = require('../src/database/repository');
const auth = require('../src/auth');
const service = require('../src/services/scheduleService');
const scheduler = require('../src/scheduler');

const admin = { username: 'admin', role: 'admin', userId: null, isPrimaryAdmin: true };

let userA;
let userB;
let actorA;
let actorB;

function bogotaParts(date) {
  const s = date.toLocaleString('sv-SE', { timeZone: 'America/Bogota' });
  const [d, t] = s.split(' ');
  return { date: d, time: t.slice(0, 5) };
}

function futureInput(doc, branch, offsetMs = 2 * 60 * 60 * 1000) {
  const p = bogotaParts(new Date(Date.now() + offsetMs));
  return {
    document: doc,
    destination_branch: branch,
    scheduled_date: p.date,
    scheduled_time: p.time,
  };
}

function createUser(username, role) {
  const { hash, salt } = auth.hashPassword('clave12345');
  const id = repo.createUser({
    username,
    password_hash: hash,
    password_salt: salt,
    role,
    enabled: 1,
    created_by: 'admin',
  });
  return { username, role, userId: id, isPrimaryAdmin: false };
}

function insertDueSchedule(doc, branch, minutesAgo = 5) {
  const when = new Date(Date.now() - minutesAgo * 60 * 1000);
  const p = bogotaParts(when);
  return repo.createSchedule({
    document: doc,
    destination_branch: branch,
    scheduled_date: p.date,
    scheduled_time: p.time,
    scheduled_at_utc: when.toISOString(),
    timezone: 'America/Bogota',
    created_by_user_id: userA.userId,
    created_by_username: userA.username,
  });
}

function count(table, where = '', ...params) {
  const sql = `SELECT COUNT(*) AS c FROM ${table}${where ? ' WHERE ' + where : ''}`;
  return getDb().prepare(sql).get(...params).c;
}

before(() => {
  migrate();
  userA = createUser('programador.a', 'scheduler');
  userB = createUser('programador.b', 'scheduler');
  actorA = userA;
  actorB = userB;
});

after(() => closeDb());

test('localToUtcIso convierte hora de Bogotá (UTC-5) a UTC', () => {
  assert.equal(service.localToUtcIso('2026-10-30', '10:00'), '2026-10-30T15:00:00.000Z');
  assert.equal(service.localToUtcIso('2026-01-01', '00:00'), '2026-01-01T05:00:00.000Z');
});

test('rechaza fechas/horas anteriores al momento actual', () => {
  assert.throws(
    () => service.validateScheduleInput({
      document: '1234567890',
      destination_branch: 'SUR',
      scheduled_date: '2020-01-01',
      scheduled_time: '10:00',
    }),
    (err) => err.code === 'PAST_DATE'
  );
});

test('valida documento, sucursal, fecha y hora', () => {
  assert.throws(
    () => service.validateScheduleInput({ document: '12', destination_branch: 'SUR', scheduled_date: '2030-01-01', scheduled_time: '10:00' }),
    (err) => err.code === 'INVALID_DOCUMENT'
  );
  assert.throws(
    () => service.validateScheduleInput({ document: '123456', destination_branch: '', scheduled_date: '2030-01-01', scheduled_time: '10:00' }),
    (err) => err.code === 'INVALID_BRANCH'
  );
  assert.throws(
    () => service.validateScheduleInput({ document: '123456', destination_branch: 'SUR', scheduled_date: '2030-02-30', scheduled_time: '10:00' }),
    (err) => err.code === 'INVALID_DATE'
  );
  assert.throws(
    () => service.validateScheduleInput({ document: '123456', destination_branch: 'SUR', scheduled_date: '2030-01-01', scheduled_time: '25:00' }),
    (err) => err.code === 'INVALID_TIME'
  );
});

test('crea una programación futura que aún no se despacha', () => {
  const schedule = service.createSchedule(futureInput('1000000001', 'SUR'), actorA);
  assert.equal(schedule.status, 'SCHEDULED');
  assert.equal(schedule.created_by_user_id, actorA.userId);
  const res = scheduler.tick();
  assert.equal(res.dispatched.some((d) => d.id === schedule.id), false);
  assert.equal(count('schedules', 'id = ? AND status = ?', schedule.id, 'SCHEDULED'), 1);
});

test('despacha una programación vencida a la cola de forma idempotente', () => {
  const id = insertDueSchedule('2000000002', 'CENTRO');
  const first = scheduler.tick();
  assert.ok(first.dispatched.some((d) => d.id === id));

  const row = repo.getScheduleById(id);
  assert.equal(row.status, 'QUEUED');
  assert.ok(row.request_id);
  assert.ok(row.job_id);

  const request = repo.getTransferRequestById(row.request_id);
  assert.equal(request.origin, 'panel');
  assert.equal(request.created_by_username, userA.username);
  assert.equal(request.schedule_id, id);
  assert.equal(request.message_id, `sched:${id}`);

  const job = getDb().prepare('SELECT * FROM job_queue WHERE id = ?').get(row.job_id);
  const payload = JSON.parse(job.payload);
  assert.equal(payload.notify, false);
  assert.equal(payload.origin, 'panel');
  assert.equal(payload.scheduleId, id);

  // Segundo tick: no debe duplicar ni el request ni el job.
  scheduler.tick();
  scheduler.tick();
  assert.equal(count('transfer_requests', 'message_id = ?', `sched:${id}`), 1);
  assert.equal(count('job_queue', 'request_id = ?', row.request_id), 1);
});

test('marca como retrasada una ejecución despachada tarde', () => {
  const id = insertDueSchedule('2000000003', 'NORTE', 30);
  const res = scheduler.tick();
  assert.ok(res.dispatched.some((d) => d.id === id));
  assert.equal(repo.getScheduleById(id).late, 1);
});

test('sincroniza el estado de la programación con la ejecución real', () => {
  const id = insertDueSchedule('2000000004', 'OCCIDENTE');
  scheduler.tick();
  const row = repo.getScheduleById(id);
  repo.updateTransferRequest(row.request_id, { status: 'PROCESSING', started_at: new Date().toISOString() });
  scheduler.tick();
  assert.equal(repo.getScheduleById(id).status, 'PROCESSING');

  repo.updateTransferRequest(row.request_id, {
    status: 'SUCCESS',
    completed_at: new Date().toISOString(),
  });
  scheduler.tick();
  const done = repo.getScheduleById(id);
  assert.equal(done.status, 'SUCCESS');
  assert.ok(done.executed_at);
});

test('sincroniza FAILED con el mensaje de error', () => {
  const id = insertDueSchedule('2000000005', 'ORIENTE');
  scheduler.tick();
  const row = repo.getScheduleById(id);
  repo.updateTransferRequest(row.request_id, {
    status: 'FAILED',
    error_message: 'CONSISTENCY',
    completed_at: new Date().toISOString(),
  });
  scheduler.tick();
  const failed = repo.getScheduleById(id);
  assert.equal(failed.status, 'FAILED');
  assert.equal(failed.error_message, 'CONSISTENCY');
});

test('una programación cancelada no se despacha', () => {
  const schedule = service.createSchedule(futureInput('3000000006', 'SUR'), actorA);
  const cancelled = service.cancelSchedule(schedule.id, actorA);
  assert.equal(cancelled.status, 'CANCELLED');
  assert.equal(cancelled.cancelled_by, actorA.username);
  scheduler.tick();
  assert.equal(count('transfer_requests', 'message_id = ?', `sched:${schedule.id}`), 0);
});

test('editar solo es posible en estado SCHEDULED', () => {
  const schedule = service.createSchedule(futureInput('3000000007', 'SUR'), actorA);
  const input = futureInput('3000000007', 'CENTRO', 3 * 60 * 60 * 1000);
  const updated = service.updateSchedule(schedule.id, input, actorA);
  assert.equal(updated.destination_branch, 'CENTRO');

  const id = insertDueSchedule('3000000008', 'SUR');
  scheduler.tick();
  assert.throws(
    () => service.updateSchedule(id, futureInput('3000000008', 'NORTE'), admin),
    (err) => err.code === 'NOT_EDITABLE'
  );
  assert.throws(
    () => service.cancelSchedule(id, admin),
    (err) => err.code === 'NOT_CANCELLABLE'
  );
});

test('no permite programaciones activas duplicadas', () => {
  const input = futureInput('4000000009', 'SUR');
  service.createSchedule(input, actorA);
  assert.throws(
    () => service.createSchedule(input, actorB),
    (err) => err.code === 'DUPLICATE'
  );
});

test('un programador solo ve sus programaciones; el admin ve todas', () => {
  service.createSchedule(futureInput('5000000010', 'SUR'), actorA);
  service.createSchedule(futureInput('5000000011', 'SUR'), actorB);

  const listA = service.listSchedules({}, actorA);
  assert.ok(listA.items.length > 0);
  assert.ok(listA.items.every((s) => s.created_by_user_id === actorA.userId));

  const listAdmin = service.listSchedules({}, admin);
  const docs = listAdmin.items.map((s) => s.document);
  assert.ok(docs.includes('5000000010'));
  assert.ok(docs.includes('5000000011'));
});

test('un programador no puede editar ni cancelar programaciones de otro', () => {
  const schedule = service.createSchedule(futureInput('6000000012', 'SUR'), actorB);
  assert.throws(
    () => service.updateSchedule(schedule.id, futureInput('6000000012', 'NORTE'), actorA),
    (err) => err.code === 'FORBIDDEN'
  );
  assert.throws(
    () => service.cancelSchedule(schedule.id, actorA),
    (err) => err.code === 'FORBIDDEN'
  );
});

test('el worker ejecuta la programación y no envía WhatsApp (notify:false)', async () => {
  const id = insertDueSchedule('8000000015', 'SUR');
  const sent = [];
  const sender = {
    connected: () => true,
    sendText: async (phone, text) => {
      sent.push({ phone, text });
    },
  };
  const { startWorker } = require('../src/queue/worker');
  const worker = startWorker({
    sender,
    transferExecutor: async () => ({ ok: true, sourceBranch: 'NORTE' }),
  });
  worker.start();
  try {
    scheduler.tick();
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline && repo.getScheduleById(id).status !== 'SUCCESS') {
      await new Promise((r) => setTimeout(r, 50));
      scheduler.tick();
    }
  } finally {
    worker.stop();
  }
  const schedule = repo.getScheduleById(id);
  assert.equal(schedule.status, 'SUCCESS');
  assert.ok(schedule.executed_at);
  assert.equal(sent.length, 0, 'no debe intentar enviar respuesta por WhatsApp');
});

test('registra auditoría de creación, despacho y cancelación', () => {
  const schedule = service.createSchedule(futureInput('7000000013', 'SUR'), actorA);
  const auditCreate = repo.listScheduleAudit(schedule.id);
  assert.ok(auditCreate.some((a) => a.action === 'CREATED'));

  const dueId = insertDueSchedule('7000000014', 'SUR');
  scheduler.tick();
  const auditDispatch = repo.listScheduleAudit(dueId);
  assert.ok(auditDispatch.some((a) => a.action === 'DISPATCHED'));

  const cancelled = service.cancelSchedule(schedule.id, actorA);
  assert.equal(cancelled.status, 'CANCELLED');
  const auditCancel = repo.listScheduleAudit(schedule.id);
  assert.ok(auditCancel.some((a) => a.action === 'CANCELLED'));
});
