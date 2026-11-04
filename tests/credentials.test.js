'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { passwordCandidates } = require('../src/automation/credentials');

test('prioriza la contraseña principal y agrega respaldos sin duplicados', () => {
  assert.deepEqual(passwordCandidates('654321', ['123456', '654321']), ['654321', '123456']);
  assert.deepEqual(passwordCandidates('123456', ['123456', '654321']), ['123456', '654321']);
  assert.deepEqual(passwordCandidates('otra', ['123456', '654321']), ['otra', '123456', '654321']);
});

test('ignora contraseñas vacías o inválidas', () => {
  assert.deepEqual(passwordCandidates('', ['', null, '123456']), ['123456']);
  assert.deepEqual(passwordCandidates(undefined, undefined), []);
});
