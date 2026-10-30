'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { renderScheduleNew, renderSchedules } = require('../src/views');

const admin = { username: 'admin', role: 'admin' };

test('renderScheduleNew incluye selector de calendario y de hora', () => {
  const html = renderScheduleNew(admin);
  assert.match(html, /id="p-date" type="text" placeholder="AAAA-MM-DD"/);
  assert.match(html, /id="p-time" type="text" placeholder="HH:MM"/);
  assert.match(html, /TransferPicker\.date\(document\.getElementById\('p-date'\)\)/);
  assert.match(html, /TransferPicker\.time\(document\.getElementById\('p-time'\)\)/);
  assert.match(html, /href="\/picker\.css"/);
  assert.match(html, /src="\/picker\.js"/);
});

test('renderSchedules incluye selector de calendario y de hora al editar', () => {
  const html = renderSchedules(admin);
  assert.match(html, /id="e-date" type="text" placeholder="AAAA-MM-DD"/);
  assert.match(html, /id="e-time" type="text" placeholder="HH:MM"/);
  assert.match(html, /TransferPicker\.date\(document\.getElementById\('e-date'\)\)/);
  assert.match(html, /TransferPicker\.time\(document\.getElementById\('e-time'\)\)/);
  assert.match(html, /syncEditMin\(\)/);
});
