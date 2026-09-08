'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const { parseCommand } = require('../src/services/validation');

test('parsa comando completo TRASLADO DOCUMENTO SUCURSAL', () => {
  const r = parseCommand('TRASLADO 1234567890 SUCURSAL SUR');
  assert.equal(r.ok, true);
  assert.equal(r.document, '1234567890');
  assert.equal(r.branch, 'SUCURSAL SUR');
});

test('parsa sucursal de una sola palabra', () => {
  const r = parseCommand('TRASLADO 1234567890 SUR');
  assert.equal(r.ok, true);
  assert.equal(r.document, '1234567890');
  assert.equal(r.branch, 'SUR');
});

test('es insensible a mayúsculas', () => {
  const r = parseCommand('traslado 1234567890 sucursal norte');
  assert.equal(r.ok, true);
  assert.equal(r.document, '1234567890');
  assert.equal(r.branch, 'SUCURSAL NORTE');
});

test('documento puede venir en medio', () => {
  const r = parseCommand('TRASLADO SURE 1234567890 SUR');
  assert.equal(r.ok, true);
  assert.equal(r.document, '1234567890');
  assert.equal(r.branch, 'SUR');
});

test('múltiples espacios se normalizan', () => {
  const r = parseCommand('TRASLADO   1234567890   SUCURSAL   SUR');
  assert.equal(r.ok, true);
  assert.equal(r.branch, 'SUCURSAL SUR');
});

test('comando desconocido', () => {
  const r = parseCommand('HOLA 1234567890 SUR');
  assert.equal(r.ok, false);
  assert.equal(r.error, 'Comando desconocido');
});

test('mensaje vacío', () => {
  assert.equal(parseCommand('').ok, false);
  assert.equal(parseCommand('   ').ok, false);
  assert.equal(parseCommand(null).ok, false);
});

test('formato incorrecto (solo comando sin datos)', () => {
  const r = parseCommand('TRASLADO');
  assert.equal(r.ok, false);
  assert.equal(r.error, 'Formato incorrecto');
});

test('documento inválido (no numérico)', () => {
  const r = parseCommand('TRASLADO ABCDEF SUCURSAL SUR');
  assert.equal(r.ok, false);
  assert.equal(r.error, 'Documento inválido');
});

test('documento con formato de 6 dígitos es válido', () => {
  const r = parseCommand('TRASLADO 123456 SUR');
  assert.equal(r.ok, true);
});

test('sucursal vacía', () => {
  // sin tokens después del documento
  const r = parseCommand('TRASLADO 1234567890 ');
  assert.equal(r.ok, false);
  assert.equal(r.error, 'Sucursal vacía');
});
