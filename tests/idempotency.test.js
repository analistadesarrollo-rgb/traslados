'use strict';

// Configurar BD en memoria ANTES de cargar los módulos
process.env.DB_FILE = ':memory:';

const { test, before, after } = require('node:test');
const assert = require('node:assert');

const { migrate } = require('../src/database/migrations');
const repo = require('../src/database/repository');
const transferService = require('../src/services/transferService');
const { closeDb } = require('../src/database');

before(() => {
  migrate();
  for (const phone of ['5491122334455', '549111111', '549122222', '549133333']) {
    repo.addAllowedNumber(phone, 'test');
  }
});

after(() => {
  closeDb();
});

test('el mismo mensaje no se procesa dos veces (idempotencia por message_id)', async () => {
  const msg = {
    messageId: 'MESSAGE-UNICO-001',
    phoneNumber: '5491122334455',
    rawMessage: 'TRASLADO 1234567890 SUCURSAL SUR',
  };

  const first = await transferService.handleMessage(msg);
  assert.equal(first.type, 'processing');

  // El segundo envío del MISMO messageId NO debe encolar de nuevo
  const second = await transferService.handleMessage(msg);
  assert.notEqual(second.type, 'processing', 'No debe procesarse dos veces');

  // Debe existir una única solicitud registrada para ese message_id
  const reqs = repo.listTransferRequests({ document: '1234567890' });
  assert.equal(reqs.length, 1);
});

test('dos mensajes distintos del mismo documento generan dos solicitudes', async () => {
  const a = await transferService.handleMessage({
    messageId: 'M2A',
    phoneNumber: '549111111',
    rawMessage: 'TRASLADO 99999999 SUCURSAL SUR',
  });
  const b = await transferService.handleMessage({
    messageId: 'M2B',
    phoneNumber: '549122222',
    rawMessage: 'TRASLADO 99999999 SUCURSAL CENTRO',
  });
  assert.equal(a.type, 'processing');
  assert.equal(b.type, 'processing');
  const reqs = repo.listTransferRequests({ document: '99999999' });
  assert.equal(reqs.length, 2);
});

test('mensaje con formato incorrecto se registra como FAILED sin encolar', async () => {
  const r = await transferService.handleMessage({
    messageId: 'BAD1',
    phoneNumber: '549133333',
    rawMessage: 'TRASLADO abc xyz',
  });
  assert.equal(r.type, 'format-error');
  const req = repo.findTransferRequestByMessageId('BAD1');
  assert.ok(req);
  assert.equal(req.status, 'FAILED');
  assert.equal(req.error_message, 'Documento inválido');
});
