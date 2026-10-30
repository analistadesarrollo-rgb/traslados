(function () {
  'use strict';

  var MONTHS = [
    'Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio',
    'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre',
  ];
  var WEEKDAYS = ['L', 'M', 'X', 'J', 'V', 'S', 'D'];

  function pad(n) {
    return String(n).padStart(2, '0');
  }

  function bogotaNow() {
    var s = new Date().toLocaleString('sv-SE', { timeZone: 'America/Bogota' });
    var parts = s.split(' ');
    return { date: parts[0], time: (parts[1] || '').slice(0, 5) };
  }

  function parseDate(value) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ''))) return null;
    var p = String(value).split('-').map(Number);
    var d = new Date(p[0], p[1] - 1, p[2]);
    if (d.getFullYear() !== p[0] || d.getMonth() !== p[1] - 1 || d.getDate() !== p[2]) return null;
    return d;
  }

  function fmtDate(d) {
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }

  function closeAll(except) {
    document.querySelectorAll('.tp-pop.open').forEach(function (pop) {
      if (pop === except) return;
      pop.classList.remove('open');
      var wrap = pop.parentNode;
      if (wrap) wrap.classList.remove('tp-active');
    });
  }

  function ensureWrap(input) {
    if (input.__tpWrap) return input.__tpWrap;
    var wrap = document.createElement('div');
    wrap.className = 'tp-wrap';
    input.parentNode.insertBefore(wrap, input);
    wrap.appendChild(input);
    var pop = document.createElement('div');
    pop.className = 'tp-pop';
    wrap.appendChild(pop);
    input.__tpWrap = { wrap: wrap, pop: pop };
    return input.__tpWrap;
  }

  function show(input, pop, html) {
    closeAll(pop);
    pop.innerHTML = html;
    pop.classList.add('open');
    input.__tpWrap.wrap.classList.add('tp-active');
  }

  // ------------------------------------------------------------------
  // Calendario
  // ------------------------------------------------------------------
  var view = null;

  function openDate(input, pop) {
    var min = input.dataset.minDate || bogotaNow().date;
    var selected = parseDate(input.value) || parseDate(min) || new Date();
    view = { y: selected.getFullYear(), m: selected.getMonth() };
    renderDate(input, pop, min);
  }

  function renderDate(input, pop, min) {
    var y = view.y;
    var m = view.m;
    var first = new Date(y, m, 1);
    var startIdx = (first.getDay() + 6) % 7; // lunes = 0
    var daysInMonth = new Date(y, m + 1, 0).getDate();
    var today = bogotaNow().date;
    var selected = input.value;

    var minMonth = min ? min.slice(0, 7) : '';
    var thisMonth = y + '-' + pad(m + 1);
    var prevDisabled = minMonth && thisMonth <= minMonth;

    var cells = [];
    for (var i = 0; i < startIdx; i++) cells.push('<span class="tp-day empty"></span>');
    for (var d = 1; d <= daysInMonth; d++) {
      var ds = y + '-' + pad(m + 1) + '-' + pad(d);
      var disabled = min && ds < min;
      var cls = 'tp-day';
      if (ds === selected) cls += ' selected';
      if (ds === today) cls += ' today';
      if (disabled) cls += ' disabled';
      cells.push(
        '<button type="button" class="' + cls + '" data-date="' + ds + '"' +
          (disabled ? ' disabled' : '') + '>' + d + '</button>'
      );
    }

    var weekHtml = WEEKDAYS.map(function (w) {
      return '<span>' + w + '</span>';
    }).join('');

    show(input, pop,
      '<div class="tp-head">' +
        '<button type="button" class="tp-nav" data-nav="-1"' + (prevDisabled ? ' disabled' : '') + '>‹</button>' +
        '<div class="tp-title">' + MONTHS[m] + ' ' + y + '</div>' +
        '<button type="button" class="tp-nav" data-nav="1">›</button>' +
      '</div>' +
      '<div class="tp-grid tp-week">' + weekHtml + '</div>' +
      '<div class="tp-grid">' + cells.join('') + '</div>' +
      '<div class="tp-foot"><button type="button" class="tp-today">Hoy</button></div>'
    );

    pop.querySelectorAll('[data-nav]').forEach(function (btn) {
      btn.addEventListener('click', function (e) {
        e.stopPropagation();
        if (btn.disabled) return;
        view.m += Number(btn.dataset.nav);
        if (view.m < 0) { view.m = 11; view.y -= 1; }
        if (view.m > 11) { view.m = 0; view.y += 1; }
        renderDate(input, pop, min);
      });
    });

    pop.querySelectorAll('[data-date]').forEach(function (btn) {
      btn.addEventListener('click', function (e) {
        e.stopPropagation();
        if (btn.disabled) return;
        input.value = btn.dataset.date;
        input.dispatchEvent(new Event('change', { bubbles: true }));
        closeAll();
      });
    });

    var hoy = pop.querySelector('.tp-today');
    if (hoy) {
      hoy.addEventListener('click', function (e) {
        e.stopPropagation();
        var t = bogotaNow().date;
        if (min && t < min) return;
        input.value = t;
        input.dispatchEvent(new Event('change', { bubbles: true }));
        closeAll();
      });
    }
  }

  // ------------------------------------------------------------------
  // Selector de hora
  // ------------------------------------------------------------------
  function openTime(input, pop) {
    var min = input.dataset.minTime || '';
    var current = /^\d{2}:\d{2}$/.test(input.value)
      ? input.value
      : (min || bogotaNow().time);
    var parts = current.split(':').map(Number);
    renderTime(input, pop, min, parts[0], parts[1]);
  }

  function renderTime(input, pop, min, selH, selM) {
    var minParts = min ? min.split(':').map(Number) : [-1, -1];
    var minH = minParts[0];
    var minM = minParts[1];

    var hours = [];
    for (var h = 0; h < 24; h++) {
      var hDisabled = min && h < minH;
      hours.push(
        '<button type="button" class="tp-tick' + (h === selH ? ' selected' : '') +
          '" data-h="' + h + '"' + (hDisabled ? ' disabled' : '') + '>' + pad(h) + '</button>'
      );
    }

    var mins = [];
    for (var m = 0; m < 60; m++) {
      var mDisabled = min && selH === minH && m < minM;
      mins.push(
        '<button type="button" class="tp-tick' + (m === selM ? ' selected' : '') +
          '" data-m="' + m + '"' + (mDisabled ? ' disabled' : '') + '>' + pad(m) + '</button>'
      );
    }

    show(input, pop,
      '<div class="tp-head"><div class="tp-title">Seleccionar hora</div></div>' +
      '<div class="tp-time">' +
        '<div><div class="tp-col-title">Hora</div><div class="tp-scroll" data-col="h">' + hours.join('') + '</div></div>' +
        '<div><div class="tp-col-title">Minuto</div><div class="tp-scroll" data-col="m">' + mins.join('') + '</div></div>' +
      '</div>' +
      '<div class="tp-foot"><button type="button" class="tp-now">Ahora</button></div>'
    );

    pop.querySelectorAll('[data-h]').forEach(function (btn) {
      btn.addEventListener('click', function (e) {
        e.stopPropagation();
        if (btn.disabled) return;
        renderTime(input, pop, min, Number(btn.dataset.h), selM);
      });
    });

    pop.querySelectorAll('[data-m]').forEach(function (btn) {
      btn.addEventListener('click', function (e) {
        e.stopPropagation();
        if (btn.disabled) return;
        input.value = pad(selH) + ':' + pad(Number(btn.dataset.m));
        input.dispatchEvent(new Event('change', { bubbles: true }));
        closeAll();
      });
    });

    var now = pop.querySelector('.tp-now');
    if (now) {
      now.addEventListener('click', function (e) {
        e.stopPropagation();
        input.value = bogotaNow().time;
        input.dispatchEvent(new Event('change', { bubbles: true }));
        closeAll();
      });
    }

    pop.querySelectorAll('.tp-scroll').forEach(function (col) {
      var selected = col.querySelector('.tp-tick.selected');
      if (selected) {
        col.scrollTop = Math.max(0, selected.offsetTop - col.clientHeight / 2 + selected.offsetHeight / 2);
      }
    });
  }

  // ------------------------------------------------------------------
  // API pública
  // ------------------------------------------------------------------
  function attachDate(input) {
    if (!input || input.__tpDate) return;
    input.__tpDate = true;
    input.readOnly = true;
    input.placeholder = 'Seleccionar fecha';
    input.setAttribute('autocomplete', 'off');
    var w = ensureWrap(input);
    input.addEventListener('click', function () { openDate(input, w.pop); });
    input.addEventListener('focus', function () { openDate(input, w.pop); });
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') closeAll();
    });
  }

  function attachTime(input) {
    if (!input || input.__tpTime) return;
    input.__tpTime = true;
    input.readOnly = true;
    input.placeholder = 'Seleccionar hora';
    input.setAttribute('autocomplete', 'off');
    var w = ensureWrap(input);
    input.addEventListener('click', function () { openTime(input, w.pop); });
    input.addEventListener('focus', function () { openTime(input, w.pop); });
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') closeAll();
    });
  }

  document.addEventListener('click', function (e) {
    if (!(e.target instanceof Element) || !e.target.closest('.tp-wrap')) closeAll();
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') closeAll();
  });

  window.TransferPicker = { date: attachDate, time: attachTime };
})();
