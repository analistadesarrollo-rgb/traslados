'use strict';

process.env.DB_FILE = ':memory:';

const { test, before, after } = require('node:test');
const assert = require('node:assert');

const { migrate } = require('../src/database/migrations');
const repo = require('../src/database/repository');
const { closeDb } = require('../src/database');
const queue = require('../src/queue');

const OWNER = 'test-worker-1';
const LEASE = 60000;

before(() => migrate());
after(() => closeDb());

test('enqueue es idempotente por request_id', () => {
  const reqId = repo.createTransferRequest({
    message_id: 'MID-1',
    phone_number: '5491',
    document: 'DOC-A',
    destination_branch: 'SUR',
    status: 'PENDING',
  });
  const j1 = repo.enqueueJob({ request_id: reqId, document: 'DOC-A', payload: '{}' });
  const j2 = repo.enqueueJob({ request_id: reqId, document: 'DOC-A', payload: '{}' });
  assert.equal(j2.duplicated, true);
  assert.ok(j1.id);
  // Completar el job para no dejar un PENDING que interfiera en otros tests
  repo.markJobDone(j1.id, {});
});

test('claimNextJob devuelve un solo job por documento (lock de documento)', () => {
  // Dos jobs distintos para el mismo documento
  const r1 = repo.createTransferRequest({ message_id: 'A1', phone_number: '1', document: 'DOC-X', destination_branch: 'SUR', status: 'PENDING' });
  const r2 = repo.createTransferRequest({ message_id: 'A2', phone_number: '1', document: 'DOC-X', destination_branch: 'CENTRO', status: 'PENDING' });
  repo.enqueueJob({ request_id: r1, document: 'DOC-X', payload: '{}' });
  repo.enqueueJob({ request_id: r2, document: 'DOC-X', payload: '{}' });

  // El primer claim toma el job más antiguo
  const j1 = repo.claimNextJob(OWNER, LEASE);
  assert.ok(j1);
  assert.equal(j1.status, 'PROCESSING');
  assert.equal(j1.document, 'DOC-X');

  // El mismo worker no puede reclamar otro job del mismo documento
  const j2 = repo.claimNextJob(OWNER + '-2', LEASE);
  assert.equal(j2, null, 'No debe entregarse otro job del mismo documento mientras hay uno activo');

  // Al terminar el job (DONE), el siguiente del mismo documento ya es reclamable
  repo.markJobDone(j1.id, {});
  const j3 = repo.claimNextJob(OWNER, LEASE);
  assert.ok(j3, 'Debe entregarse el siguiente job una vez terminado el anterior');
  assert.equal(j3.document, 'DOC-X');
  repo.markJobDone(j3.id, {});
});

test('jobs huérfanos con lease vencido se reasignan', () => {
  const r = repo.createTransferRequest({ message_id: 'ORPHAN1', phone_number: '2', document: 'DOC-Y', destination_branch: 'SUR', status: 'PENDING' });
  repo.enqueueJob({ request_id: r, document: 'DOC-Y', payload: '{}' });
  const j = repo.claimNextJob('dead-worker', -1000); // lease ya vencido
  assert.ok(j);

  // marcar como si el worker murió: simular lease vencido
  const db = require('../src/database').getDb();
  db.prepare(`UPDATE job_queue SET status='PROCESSING', lock_owner='dead', lease_until=? WHERE id=?`).run(new Date(Date.now() - 5000).toISOString(), j.id);

  // un nuevo worker reclama el job huérfano
  const j2 = repo.claimNextJob('new-worker', LEASE);
  assert.ok(j2);
  assert.equal(j2.id, j.id);
});

test('hasActiveJobForDocument detecta jobs activos', () => {
  const r = repo.createTransferRequest({ message_id: 'ACTIVE1', phone_number: '3', document: 'DOC-Z', destination_branch: 'SUR', status: 'PENDING' });
  const j = repo.enqueueJob({ request_id: r, document: 'DOC-Z', payload: '{}' });
  // al estar PENDING es activo
  assert.equal(queue.hasActiveJobForDocument('DOC-Z'), true);
  repo.claimNextJob(OWNER, LEASE); // lo toma -> PROCESSING, sigue activo
  assert.equal(queue.hasActiveJobForDocument('DOC-Z'), true);
  repo.markJobDone(j.id, {});
  assert.equal(queue.hasActiveJobForDocument('DOC-Z'), false);
});
