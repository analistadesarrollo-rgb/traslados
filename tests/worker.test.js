'use strict';

process.env.DB_FILE = ':memory:';
process.env.QUEUE_POLL_INTERVAL_MS = '100';

const { test, before, after } = require('node:test');
const assert = require('node:assert');

const { migrate } = require('../src/database/migrations');
const repo = require('../src/database/repository');
const { closeDb } = require('../src/database');
const { startWorker } = require('../src/queue/worker');

let executed = [];

before(() => migrate());
after(() => closeDb());

function waitForStatus(requestId, statuses, timeoutMs = 3000) {
  const start = Date.now();
  return new Promise((resolve) => {
    const iv = setInterval(() => {
      const r = repo.getTransferRequestById(requestId);
      if (r && statuses.includes(r.status)) {
        clearInterval(iv);
        resolve(r);
      } else if (Date.now() - start > timeoutMs) {
        clearInterval(iv);
        resolve(repo.getTransferRequestById(requestId));
      }
    }, 20);
  });
}

test('worker procesa un job con éxito, actualiza estado y envía respuesta', async () => {
  executed = [];
  const sent = [];

  const worker = startWorker({
    sender: {
      connected: true,
      sendText: async (phone, text) => sent.push({ phone, text }),
    },
    transferExecutor: async (payload) => {
      executed.push(payload);
      return { ok: true, sourceBranch: 'Sucursal Norte', destinationBranch: payload.branch };
    },
  });
  worker.start();

  const requestId = repo.createTransferRequest({
    message_id: 'W-SUCCESS',
    phone_number: '5491',
    document: '1234567890',
    destination_branch: 'SUR',
    status: 'PENDING',
    raw_message: 'TRASLADO 1234567890 SUCURSAL SUR',
  });
  repo.enqueueJob({ request_id: requestId, document: '1234567890', payload: JSON.stringify({ phoneNumber: '5491', document: '1234567890', branch: 'SUR' }) });

  const done = await waitForStatus(requestId, ['SUCCESS', 'FAILED']);
  worker.stop();

  assert.equal(done.status, 'SUCCESS');
  assert.equal(done.source_branch, 'Sucursal Norte');
  assert.equal(executed.length, 1);
  assert.equal(executed[0].branch, 'SUR');
  assert.equal(sent.length, 1, 'Debe enviarse la respuesta de éxito');
  assert.ok(sent[0].text.includes('Traslado realizado correctamente'));
});

test('worker procesa un fallo y envía respuesta de error', async () => {
  executed = [];
  const sent = [];

  const worker = startWorker({
    sender: {
      connected: true,
      sendText: async (phone, text) => sent.push({ phone, text }),
    },
    transferExecutor: async (payload) => {
      return { ok: false, errorCode: 'NO_ACTIVE_SHIFT', error: 'El colocador no tiene un turno activo.' };
    },
  });
  worker.start();

  const requestId = repo.createTransferRequest({
    message_id: 'W-FAIL',
    phone_number: '5492',
    document: '55555555',
    destination_branch: 'CENTRO',
    status: 'PENDING',
    raw_message: 'TRASLADO 55555555 SUCURSAL CENTRO',
  });
  repo.enqueueJob({ request_id: requestId, document: '55555555', payload: JSON.stringify({ phoneNumber: '5492', document: '55555555', branch: 'CENTRO' }) });

  const done = await waitForStatus(requestId, ['SUCCESS', 'FAILED']);
  worker.stop();

  assert.equal(done.status, 'FAILED');
  assert.ok(done.error_message.includes('turno activo'));
  assert.equal(sent.length, 1);
  assert.ok(sent[0].text.includes('no tiene un turno activo'));
});
