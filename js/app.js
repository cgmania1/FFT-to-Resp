/* FRF RPM별 응답 계산기 — 화면 (계산은 js/logic.js) */
(function () {
  'use strict';
  var L = window.FRFLogic, S = window.FRFSample, Store = window.FRFStore;
  var main = document.getElementById('main');

  // ── 상태 ─────────────────────────────────────────────────────
  function defaultSettings() {
    return {
      rpmStart: '', rpmEnd: '', rpmStep: '', orders: [{ order: '', force: '', scale: '' }], forceMode: 'const', forceUnit: 'N', interp: 'linear', antiRatio: 0.05,
      // 2026-09-29 추가 — scale factor · RPM 연동 벡터 · 추정 방식
      scaleOn: false, refOrder: '', vectorRows: [], vectorStep: '', vectorPaste: '', estMode: 'each', polyDegree: 1,
      // 2026-09-29 오후 추가 — 비교 대상(차수별/overall)·오차 기준(평균/최대)·오차 단위(절대/상대)
      estObjective: 'order', estCrit: 'mean', estErrScale: 'abs'
    };
  }
  function emptyState() {
    return { sample: false, frfFile: null, frfMap: null, frf: null, frfWarnings: [], settings: defaultSettings(), forceFile: null, forceTable: null, measFile: null, measMap: null };
  }
  var state = Store.load() || emptyState();
  if (!state.settings) state.settings = defaultSettings();
  (function fillDefaults() {   // 예전 버전에서 저장한 상태에 새 항목 채우기
    var d = defaultSettings();
    Object.keys(d).forEach(function (k) { if (state.settings[k] == null) state.settings[k] = d[k]; });
  })();
  var result = null, estimate = null, fit = null;   // 계산 결과는 저장하지 않고 필요할 때 다시 계산
  var ui = { point: 0, logY: false, detail: false, fitPoint: 0 };
  var MODE_SHORT = { const: '차수별 상수', vector: 'RPM 연동 벡터', table: 'RPM별 가진력 표 파일' };

  function save() {
    var ok = Store.save(state);
    var b = document.getElementById('storeBanner');
    if (!ok) { b.textContent = '파일이 커서 브라우저 저장소에 담지 못했습니다. 이 창을 닫으면 불러온 파일이 사라지니, 결과는 엑셀로 내려받아 두십시오.'; b.hidden = false; }
    else b.hidden = true;
  }

  // ── DOM 도우미 ────────────────────────────────────────────────
  function el(tag, attrs) {
    var n = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) {
      var v = attrs[k];
      if (v == null || v === false) return;
      if (k === 'class') n.className = v;
      else if (k === 'text') n.textContent = v;
      else if (k.slice(0, 2) === 'on') n.addEventListener(k.slice(2), v);
      else if (k === 'value') n.value = v;
      else if (k === 'checked' || k === 'selected' || k === 'disabled') n[k] = !!v;
      else n.setAttribute(k, v === true ? '' : v);
    });
    for (var i = 2; i < arguments.length; i++) add(n, arguments[i]);
    return n;
  }
  function add(n, c) {
    if (c == null || c === false) return;
    if (Array.isArray(c)) { c.forEach(function (x) { add(n, x); }); return; }
    n.appendChild(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c);
  }
  var toastTimer;
  function toast(msg, isErr) {
    var t = document.getElementById('toast');
    t.textContent = msg; t.className = 'toast' + (isErr ? ' error' : ''); t.hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(function () { t.hidden = true; }, 3500);
  }
  function alertBox(kind, title, items) {
    if (!items || !items.length) return null;
    return el('div', { class: 'alert ' + kind, role: kind === 'error' ? 'alert' : null }, title ? el('strong', null, title) : null, el('ul', null, items.map(function (x) { return el('li', null, x); })));
  }
  function field(label, input, help) { return el('label', { class: 'field' }, el('span', null, label), input, help ? el('small', null, help) : null); }
  function colLetter(i) { var s = ''; i++; while (i > 0) { var m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = Math.floor((i - 1) / 26); } return s; }
  function colSelect(name, headers, value, allowNone) {
    var s = el('select', { name: name });
    if (allowNone) s.appendChild(el('option', { value: '-1' }, '(쓰지 않음)'));
    headers.forEach(function (h, i) { s.appendChild(el('option', { value: String(i), selected: i === value }, colLetter(i) + ' · ' + (String(h).trim() || '(빈 머리)'))); });
    if (value == null || value < 0) s.value = allowNone ? '-1' : '0';
    return s;
  }
  function today() { var d = new Date(), p = function (n) { return (n < 10 ? '0' : '') + n; }; return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()); }
  function nowText() { var d = new Date(), p = function (n) { return (n < 10 ? '0' : '') + n; }; return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes()); }
  function baseOf(name) { return String(name || '').replace(/\.[^.]+$/, '').replace(/[\\\/:*?"<>|\s]+/g, '_'); }
  function outName(kind, ext) { return (state.sample ? '예시데이터_' : '') + kind + (state.frfFile && !state.sample ? '_' + baseOf(state.frfFile.name) : '') + '_' + today() + '.' + ext; }

  function download(name, blob) {
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 2000);
  }
  function downloadSheets(name, sheets) {
    var wb = XLSX.utils.book_new();
    sheets.forEach(function (s) { XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(s.rows), s.name); });
    var out = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
    download(name, new Blob([out], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
  }

  // ── 파일 읽기 (xlsx·xls·csv) — 브라우저 안에서만 ────────────────────
  function readFile(file, cb) {
    var reader = new FileReader();
    reader.onload = function () {
      try {
        var buf = new Uint8Array(reader.result), wb;
        if (/\.(csv|txt)$/i.test(file.name)) {
          var text;
          try { text = new TextDecoder('utf-8', { fatal: true }).decode(buf); }
          catch (e) { text = new TextDecoder('euc-kr').decode(buf); } // 한글 엑셀이 저장한 CSV(CP949)
          wb = XLSX.read(text.replace(/^﻿/, ''), { type: 'string', raw: true });
        } else wb = XLSX.read(buf, { type: 'array' });
        var sheets = {};
        wb.SheetNames.forEach(function (n) { sheets[n] = XLSX.utils.sheet_to_json(wb.Sheets[n], { header: 1, raw: true, defval: '' }); });
        cb(null, { name: file.name, sheetNames: wb.SheetNames, sheets: sheets });
      } catch (e) { cb(e); }
    };
    reader.onerror = function () { cb(reader.error); };
    reader.readAsArrayBuffer(file);
  }
  function fileRowsInfo(f) {
    var rows = f.sheets[f.sheet] || [];
    var hr = Math.max(0, Math.min(f.headerRow || 0, rows.length - 1));
    return { headers: (rows[hr] || []).map(function (h) { return h == null ? '' : h; }), data: rows.slice(hr + 1), rows: rows, hr: hr };
  }
  function prepareFile(raw) {
    var sheet = raw.sheetNames.filter(function (n) { return (raw.sheets[n] || []).length > 1; })[0] || raw.sheetNames[0];
    return { name: raw.name, sheetNames: raw.sheetNames, sheets: raw.sheets, sheet: sheet, headerRow: L.guessHeaderRow(raw.sheets[sheet] || []) };
  }
  function fileControls(f, onChange) {
    if (!f) return null;
    var info = fileRowsInfo(f);
    var sheetSel = el('select', { name: 'sheet', onchange: function () { f.sheet = this.value; f.headerRow = L.guessHeaderRow(f.sheets[f.sheet] || []); onChange(true); } },
      f.sheetNames.map(function (n) { return el('option', { value: n, selected: n === f.sheet }, n); }));
    var hrIn = el('input', { type: 'number', name: 'headerRow', min: 1, value: String(info.hr + 1), onchange: function () { f.headerRow = Math.max(0, (parseInt(this.value, 10) || 1) - 1); onChange(true); } });
    var prev = info.rows.slice(info.hr, info.hr + 6);
    var width = Math.min(Math.max.apply(null, prev.map(function (r) { return r.length; }).concat([1])), 30);
    return el('div', null,
      el('div', { class: 'form-grid' },
        field('시트', sheetSel, f.sheetNames.length + '개 시트'),
        field('머리행 번호', hrIn, '열 이름이 있는 행(자동으로 찾은 값, 고칠 수 있음)'),
        el('div', { class: 'field' }, el('span', null, '데이터'), el('div', null, info.data.length + '행 × ' + info.headers.length + '열'))),
      el('h3', { style: 'margin-top:14px' }, '미리 보기 (머리행 + 5행)'),
      el('div', { class: 'table-wrap' }, el('table', { class: 'grid' },
        el('thead', null, el('tr', null, Array.apply(null, Array(width)).map(function (_, i) { return el('th', null, colLetter(i)); }))),
        el('tbody', null, prev.map(function (r) { return el('tr', null, Array.apply(null, Array(width)).map(function (_, i) { var v = r[i]; return el('td', null, v == null ? '' : String(v)); })); })))));
  }
  function fileInput(label, onFile) {
    return el('label', { class: 'field' }, el('span', null, label),
      el('input', { type: 'file', accept: '.xlsx,.xls,.xlsm,.csv', onchange: function () {
        var file = this.files && this.files[0];
        if (!file) return;
        readFile(file, function (err, raw) {
          if (err) { toast('파일을 읽지 못했습니다: ' + (err.message || err), true); return; }
          onFile(prepareFile(raw));
        });
      } }),
      el('small', null, '엑셀(xlsx·xls) 또는 CSV. 파일은 이 브라우저 안에서만 읽고 외부로 보내지 않습니다.'));
  }

  // ── 1. FRF 불러오기 ───────────────────────────────────────────
  function viewFrf() {
    var f = state.frfFile;
    var wrap = el('div');
    wrap.appendChild(el('div', { class: 'page-head' }, el('h1', null, '1. FRF 해석 결과 불러오기')));
    wrap.appendChild(steps());
    wrap.appendChild(el('section', { class: 'card' },
      el('h2', null, 'FRF 엑셀 선택'),
      el('p', { class: 'note' }, '단위 가진 FRF 결과 파일을 고르고, 아래에서 주파수 열과 응답점 열을 지정합니다. 실제 파일의 열 배치를 아직 모르기 때문에 열은 화면에서 직접 짝지어 주는 방식입니다.'),
      fileInput('FRF 파일', function (nf) {
        state.frfFile = nf; state.sample = false; state.frf = null; result = null; estimate = null; fit = null;
        var info = fileRowsInfo(nf);
        state.frfMap = L.guessMapping(info.headers);
        save(); render();
      }),
      f ? el('p', { style: 'margin-top:10px' }, '불러온 파일: ', el('strong', null, f.name)) : el('p', { class: 'note', style: 'margin-top:10px' }, '파일이 없으면 위쪽의 「예시 데이터 불러오기」로 가상 FRF 를 넣어 흐름을 먼저 볼 수 있습니다.')));
    if (!f) return wrap;

    wrap.appendChild(el('section', { class: 'card' }, el('h2', null, '시트·머리행'), fileControls(f, function (reguess) {
      if (reguess) { state.frfMap = L.guessMapping(fileRowsInfo(f).headers); state.frf = null; }
      save(); render();
    })));

    var info = fileRowsInfo(f), m = state.frfMap || L.guessMapping(info.headers);
    state.frfMap = m;
    var two = L.FORMATS[m.format].cols === 2;
    var fmtSel = el('select', { name: 'format', onchange: function () { m.format = this.value; state.frf = null; save(); render(); } },
      Object.keys(L.FORMATS).map(function (k) { return el('option', { value: k, selected: k === m.format }, L.FORMATS[k].ko); }));
    var freqSel = colSelect('freqCol', info.headers, m.freqCol);
    freqSel.addEventListener('change', function () { m.freqCol = +this.value; state.frf = null; save(); });
    var rows = m.points.map(function (p, i) {
      var nameIn = el('input', { class: 'cell-input', name: 'pname', value: p.name, 'aria-label': '응답점 이름', oninput: function () { p.name = this.value; state.frf = null; save(); } });
      var aSel = colSelect('pa', info.headers, p.a); aSel.className = 'cell-input'; aSel.setAttribute('aria-label', '크기 열');
      aSel.addEventListener('change', function () { p.a = +this.value; state.frf = null; save(); });
      var bSel = colSelect('pb', info.headers, p.b, true); bSel.className = 'cell-input'; bSel.setAttribute('aria-label', '두 번째 열');
      bSel.addEventListener('change', function () { p.b = +this.value; state.frf = null; save(); });
      var unitIn = el('input', { class: 'cell-input', name: 'punit', value: p.unit || '', placeholder: '예: Pa/N', 'aria-label': '단위', oninput: function () { p.unit = this.value; state.frf = null; save(); } });
      return el('tr', null, el('td', null, nameIn), el('td', null, aSel), two ? el('td', null, bSel) : null, el('td', null, unitIn),
        el('td', null, el('button', { type: 'button', class: 'btn btn-small btn-danger', onclick: function () { m.points.splice(i, 1); state.frf = null; save(); render(); } }, '빼기')));
    });
    wrap.appendChild(el('section', { class: 'card' },
      el('h2', null, '열 짝짓기'),
      el('div', { class: 'form-grid cols-2' },
        field('주파수 열 (Hz)', freqSel, '주파수 단위는 Hz 로 봅니다(가정).'),
        field('FRF 값 형식', fmtSel, '크기+위상·실수+허수여도 응답 계산에는 크기 |FRF| 만 씁니다(가정).')),
      el('h3', { style: 'margin-top:16px' }, '응답점 (' + m.points.length + '개)'),
      el('div', { class: 'table-wrap' }, el('table', { class: 'grid map' },
        el('thead', null, el('tr', null, el('th', null, '응답점 이름'), el('th', null, two ? (m.format === 'reim' ? '실수 열' : '크기 열') : '크기 열'), two ? el('th', null, m.format === 'reim' ? '허수 열' : '위상 열') : null, el('th', null, '단위(선택)'), el('th', null, ''))),
        el('tbody', null, rows))),
      el('div', { class: 'btn-row', style: 'margin-top:10px' },
        el('button', { type: 'button', class: 'btn btn-small', onclick: function () { m.points.push({ name: '응답점' + (m.points.length + 1), a: -1, b: -1, unit: '' }); save(); render(); } }, '응답점 추가'),
        el('button', { type: 'button', class: 'btn btn-small', onclick: function () { state.frfMap = L.guessMapping(info.headers); state.frf = null; save(); render(); } }, '머리행으로 다시 추정')),
      el('div', { class: 'actions' }, el('button', { type: 'button', class: 'btn btn-primary', id: 'buildFrf', onclick: buildFrf }, 'FRF 표 만들기'))));

    if (state.frf) wrap.appendChild(frfSummaryCard());
    return wrap;
  }
  function buildFrf() {
    var info = fileRowsInfo(state.frfFile);
    var r = L.buildFrf(info.data, state.frfMap);
    if (!r.ok) { state.frf = null; save(); render(); var eb = alertBox('error', 'FRF 표를 만들지 못했습니다', r.errors); eb.id = 'frfErrors'; main.appendChild(eb); eb.scrollIntoView({ block: 'nearest' }); return; }
    state.frf = r.frf; state.frfWarnings = r.warnings; result = null; estimate = null; fit = null;
    save(); toast('FRF 표를 만들었습니다 — 응답점 ' + r.frf.points.length + '개');
    render();
  }
  function frfSummaryCard() {
    var s = L.frfSummary(state.frf);
    return el('section', { class: 'card', id: 'frfSummary' },
      el('h2', null, 'FRF 표 확인'),
      el('dl', { class: 'summary' },
        el('div', null, el('dt', null, '주파수 범위'), el('dd', null, L.fmt(s.fmin) + ' ~ ' + L.fmt(s.fmax) + ' Hz')),
        el('div', null, el('dt', null, '주파수 간격'), el('dd', null, L.fmt(s.step) + ' Hz' + (s.uneven ? ' (고르지 않음)' : ''))),
        el('div', null, el('dt', null, '행 수'), el('dd', null, String(s.rows))),
        el('div', null, el('dt', null, '응답점'), el('dd', null, state.frf.points.map(function (p) { return p.name + (p.unit ? ' [' + p.unit + ']' : ''); }).join(', ')))),
      alertBox('warn', '확인할 점', state.frfWarnings),
      el('div', { class: 'actions' }, el('a', { class: 'btn btn-primary', href: '#/calc' }, '다음: 계산 조건')));
  }

  // ── 2. 계산 조건 ──────────────────────────────────────────────
  function viewCalc() {
    var st = state.settings;
    var wrap = el('div');
    wrap.appendChild(el('div', { class: 'page-head' }, el('h1', null, '2. 계산 조건')));
    wrap.appendChild(steps());
    if (!state.frf) wrap.appendChild(el('div', { class: 'alert info' }, '먼저 ', el('a', { href: '#/frf' }, '1. FRF 불러오기'), '에서 FRF 표를 만들어 주십시오. 조건은 미리 입력해 둘 수 있습니다.'));
    function num(name, label, help) {
      return field(label, el('input', { type: 'number', name: name, step: 'any', value: st[name] === '' || st[name] == null ? '' : String(st[name]), oninput: function () { st[name] = this.value; save(); } }), help);
    }
    var s = L.frfSummary && state.frf ? L.frfSummary(state.frf) : null;
    wrap.appendChild(el('section', { class: 'card' },
      el('h2', null, 'RPM 범위'),
      el('div', { class: 'form-grid' }, num('rpmStart', 'RPM 시작'), num('rpmEnd', 'RPM 끝'), num('rpmStep', 'RPM 간격', '끝값이 간격에 맞지 않으면 끝값도 계산합니다.')),
      s ? el('p', { class: 'note', style: 'margin-top:10px' }, 'FRF 해석 범위는 ' + L.fmt(s.fmin) + '~' + L.fmt(s.fmax) + ' Hz 입니다. 가진 주파수(차수 × RPM / 60)가 이 범위를 넘는 칸은 계산하지 않고 표시합니다.') : null));

    var interpSel = el('select', { name: 'interp', onchange: function () { st.interp = this.value; save(); } },
      Object.keys(L.INTERP).map(function (k) { return el('option', { value: k, selected: k === st.interp }, L.INTERP[k]); }));
    var modeRow = el('div', { class: 'radio-row', role: 'radiogroup', 'aria-label': '가진력 입력 방식' },
      [['const', '차수별 상수'], ['vector', 'RPM 연동 벡터(화면에 입력·붙여넣기)'], ['table', 'RPM별 가진력 표 파일(엑셀·CSV)']].map(function (o) {
        return el('label', null, el('input', { type: 'radio', name: 'forceMode', value: o[0], checked: st.forceMode === o[0], onchange: function () { st.forceMode = o[0]; save(); render(); } }), o[1]);
      }));
    var isConst = st.forceMode === 'const', scaleOn = !!st.scaleOn;
    var sc = scaleOn ? currentScale() : null;
    var refNum = L.toNumber(st.refOrder);
    var refRow = scaleOn ? st.orders.filter(function (o) { return L.toNumber(o.order) === refNum; })[0] : null;
    var orderRows = st.orders.map(function (o, i) {
      var k = L.toNumber(o.order), isRef = scaleOn && k === refNum && !isNaN(k);
      var forceCell = null;
      if (isConst) {
        if (!scaleOn || isRef) {
          forceCell = el('td', null, el('input', { class: 'cell-input', type: 'number', step: 'any', name: 'force', value: o.force === '' || o.force == null ? '' : String(o.force), 'aria-label': (i + 1) + '번째 가진력', oninput: function () { o.force = this.value; save(); }, onchange: scaleOn ? function () { render(); } : null }));
        } else {
          var Fr = refRow ? L.toNumber(refRow.force) : NaN;
          var v = sc && sc.ok && !isNaN(Fr) && sc.ratio[k] != null ? L.fmt(sc.ratio[k] * Fr) : '-';
          forceCell = el('td', { class: 'computed', title: '기준 차수 가진력 × (이 차수 scale ÷ 기준 차수 scale)' }, v + ' (계산)');
        }
      }
      return el('tr', null,
        el('td', null, el('input', { class: 'cell-input', type: 'number', step: 'any', name: 'order', value: o.order === '' ? '' : String(o.order), 'aria-label': (i + 1) + '번째 차수', oninput: function () { o.order = this.value; save(); }, onchange: scaleOn ? function () { render(); } : null })),
        scaleOn ? el('td', null, el('input', { class: 'cell-input', type: 'number', step: 'any', min: 0, name: 'scale', value: o.scale == null ? '' : String(o.scale), 'aria-label': (i + 1) + '번째 scale factor', oninput: function () { o.scale = this.value; save(); }, onchange: function () { render(); } })) : null,
        scaleOn ? el('td', { class: 'center' }, el('input', { type: 'radio', name: 'refOrder', 'aria-label': (i + 1) + '번째 차수를 기준으로', checked: isRef, onchange: function () { st.refOrder = o.order; save(); render(); } })) : null,
        forceCell,
        el('td', null, el('button', { type: 'button', class: 'btn btn-small btn-danger', onclick: function () { st.orders.splice(i, 1); if (!st.orders.length) st.orders.push({ order: '', force: '', scale: '' }); save(); render(); } }, '빼기')));
    });
    var scaleErr = scaleOn && sc && !sc.ok && validOrderNumbers().length ? alertBox('warn', 'scale factor 확인', sc.errors) : null;
    wrap.appendChild(el('section', { class: 'card' },
      el('h2', null, '차수와 가진력'),
      el('p', { class: 'note' }, '차수는 회전 차수로 보고 가진 주파수 = 차수 × RPM / 60 (Hz) 로 계산합니다(가정 — 기획서 10장 확인 사항). 0.5차 같은 소수 차수도 넣을 수 있습니다.'),
      modeRow,
      el('label', { class: 'radio-row', style: 'margin-top:10px' }, el('input', { type: 'checkbox', name: 'scaleOn', checked: scaleOn, onchange: function () {
        st.scaleOn = this.checked;
        if (st.scaleOn && isNaN(L.toNumber(st.refOrder))) { var first = validOrderNumbers()[0]; if (first != null) st.refOrder = first; }
        save(); render();
      } }), '차수별 scale factor 사용 — 기준 차수 하나만 입력하면 나머지 차수는 F_k = (s_k ÷ s_기준) × F_기준 으로 계산'),
      el('div', { class: 'form-grid', style: 'margin-top:12px' },
        field('가진력 단위', el('input', { name: 'forceUnit', value: st.forceUnit || '', oninput: function () { st.forceUnit = this.value; save(); } }), '표시·엑셀 기록용'),
        field('FRF 보간 방식', interpSel, '가진 주파수가 해석 주파수 사이에 있을 때')),
      el('div', { class: 'table-wrap', style: 'margin-top:14px' }, el('table', { class: 'grid map', id: 'orderTable' },
        el('thead', null, el('tr', null, el('th', null, '차수'), scaleOn ? el('th', null, 'scale factor') : null, scaleOn ? el('th', null, '기준') : null,
          isConst ? el('th', null, '가진력' + (st.forceUnit ? ' (' + st.forceUnit + ')' : '') + (scaleOn ? ' — 기준 차수만 입력' : '')) : null, el('th', null, ''))),
        el('tbody', null, orderRows))),
      scaleErr,
      el('div', { class: 'btn-row', style: 'margin-top:10px' }, el('button', { type: 'button', class: 'btn btn-small', onclick: function () { st.orders.push({ order: '', force: '', scale: '' }); save(); render(); } }, '차수 추가')),
      st.forceMode === 'vector' ? vectorBlock() : st.forceMode === 'table' ? forceTableBlock() : null));

    wrap.appendChild(el('div', { class: 'actions' }, el('button', { type: 'button', class: 'btn btn-primary', id: 'calcBtn', onclick: runCalc }, 'RPM별 응답 계산')));
    return wrap;
  }
  function forceTableBlock() {
    var ff = state.forceFile, st = state.settings;
    var box = el('div', { style: 'margin-top:18px' }, el('h3', null, 'RPM별 가진력 표'),
      el('p', { class: 'note' }, '한 행 = RPM 하나, 차수마다 가진력 열 하나인 표를 불러옵니다(가정 형식). 표의 RPM 사이는 선형 보간하고, 표 범위 밖 RPM 은 계산하지 않습니다.' + (st.scaleOn ? ' scale factor 를 쓰므로 기준 차수 열 하나만 지정하면 됩니다.' : '')));
    if (ff && ff.source === 'estimate') {
      box.appendChild(el('div', { class: 'alert info' }, '지금 가진력 표는 「4. 가진력 추정」의 종합 추정값에서 왔습니다 (RPM ' + L.fmt(state.forceTable.rpm[0]) + '~' + L.fmt(state.forceTable.rpm[state.forceTable.rpm.length - 1]) + ', 차수 ' + Object.keys(state.forceTable.byOrder).join(', ') + '). 다른 파일을 고르면 바뀝니다.'));
    }
    box.appendChild(fileInput('가진력 표 파일', function (nf) {
      nf.map = guessForceMap(fileRowsInfo(nf).headers);
      state.forceFile = nf; state.forceTable = null; save(); render();
    }));
    if (!ff || ff.source === 'estimate') return box;
    box.appendChild(fileControls(ff, function (reguess) { if (reguess) ff.map = guessForceMap(fileRowsInfo(ff).headers); state.forceTable = null; save(); render(); }));
    var info = fileRowsInfo(ff);
    var rpmSel = colSelect('forceRpmCol', info.headers, ff.map.rpmCol);
    rpmSel.addEventListener('change', function () { ff.map.rpmCol = +this.value; save(); });
    var ords = forceKeys();
    var rows = ords.map(function (k) {
      var cur = (ff.map.orderCols.filter(function (c) { return +c.order === k; })[0] || {}).col;
      var sel = colSelect('forceCol', info.headers, cur == null ? -1 : cur, true);
      sel.className = 'cell-input';
      sel.addEventListener('change', function () {
        ff.map.orderCols = ff.map.orderCols.filter(function (c) { return +c.order !== k; }).concat([{ order: k, col: +this.value }]); save();
      });
      return el('tr', null, el('td', null, k + '차'), el('td', null, sel));
    });
    box.appendChild(el('div', { class: 'form-grid cols-2', style: 'margin-top:14px' }, field('RPM 열', rpmSel)));
    box.appendChild(ords.length
      ? el('div', { class: 'table-wrap', style: 'margin-top:10px' }, el('table', { class: 'grid map' }, el('thead', null, el('tr', null, el('th', null, '차수'), el('th', null, '가진력 열'))), el('tbody', null, rows)))
      : el('p', { class: 'note' }, '위 차수 칸에 차수를 먼저 입력하면 차수별 열을 고를 수 있습니다.'));
    return box;
  }
  // scale factor 를 쓰면 기준 차수 하나, 아니면 모든 차수의 가진력을 입력받습니다
  function forceKeys() {
    var nums = validOrderNumbers();
    if (!state.settings.scaleOn) return nums;
    var r = L.toNumber(state.settings.refOrder);
    return nums.indexOf(r) >= 0 ? [r] : [];
  }
  function currentScale() { return L.scaleRatios(state.settings.orders, validOrderNumbers(), state.settings.refOrder); }

  // RPM 연동 가진력 벡터 — 화면 표에 직접 넣거나 엑셀에서 복사해 붙여넣기 (2026-09-29 요청 1)
  function vectorBlock() {
    var st = state.settings, keys = forceKeys();
    var box = el('div', { style: 'margin-top:18px', id: 'vectorBlock' }, el('h3', null, 'RPM 연동 가진력 벡터'),
      el('p', { class: 'note' }, st.scaleOn
        ? '기준 차수(' + (keys[0] == null ? '미지정' : keys[0] + '차') + ')의 RPM별 가진력만 넣어 주십시오. 나머지 차수는 scale factor 비율로 계산합니다. RPM 사이는 선형 보간하고, 표 범위 밖 RPM 은 계산하지 않습니다.'
        : '모든 차수의 RPM별 가진력을 넣어 주십시오. RPM 사이는 선형 보간하고, 표 범위 밖 RPM 은 계산하지 않습니다.'));
    if (!keys.length) { box.appendChild(el('p', { class: 'note' }, st.scaleOn ? '위 표에서 기준 차수를 골라 주십시오.' : '위 차수 칸에 차수를 먼저 입력해 주십시오.')); return box; }
    var rows = st.vectorRows.map(function (r, i) {
      if (!r.v) r.v = {};
      return el('tr', null,
        el('td', null, el('input', { class: 'cell-input', type: 'number', step: 'any', name: 'vrpm', value: r.rpm == null ? '' : String(r.rpm), 'aria-label': (i + 1) + '번째 RPM', oninput: function () { r.rpm = this.value; save(); } })),
        keys.map(function (k) {
          return el('td', null, el('input', { class: 'cell-input', type: 'number', step: 'any', name: 'vval', value: r.v[k] == null ? '' : String(r.v[k]), 'aria-label': (i + 1) + '번째 줄 ' + k + '차 가진력', oninput: function () { r.v[k] = this.value; save(); } }));
        }),
        el('td', null, el('button', { type: 'button', class: 'btn btn-small btn-danger', onclick: function () { st.vectorRows.splice(i, 1); save(); render(); } }, '빼기')));
    });
    var stepIn = el('input', { type: 'number', step: 'any', name: 'vectorStep', value: st.vectorStep === '' || st.vectorStep == null ? '' : String(st.vectorStep), placeholder: 'RPM 간격', oninput: function () { st.vectorStep = this.value; save(); } });
    var paste = el('textarea', { name: 'vectorPaste', rows: 5, placeholder: 'RPM\t' + keys.map(function (k) { return k + '차'; }).join('\t') + '\n800\t…', oninput: function () { st.vectorPaste = this.value; save(); } });
    paste.value = st.vectorPaste || '';
    box.appendChild(el('div', { class: 'table-wrap tall', style: 'margin-top:10px' }, el('table', { class: 'grid map', id: 'vectorTable' },
      el('thead', null, el('tr', null, el('th', null, 'RPM'), keys.map(function (k) { return el('th', null, k + '차 가진력' + (st.forceUnit ? ' (' + st.forceUnit + ')' : '') + (st.scaleOn ? ' — 기준' : '')); }), el('th', null, ''))),
      el('tbody', null, rows.length ? rows : el('tr', null, el('td', { colspan: String(keys.length + 2), class: 'text' }, '아직 입력한 줄이 없습니다. 아래 「RPM 범위로 줄 만들기」나 붙여넣기로 시작해 주십시오.'))))));
    box.appendChild(el('div', { class: 'btn-row', style: 'margin-top:10px' },
      el('button', { type: 'button', class: 'btn btn-small', onclick: function () { st.vectorRows.push({ rpm: '', v: {} }); save(); render(); } }, '줄 추가'),
      el('button', { type: 'button', class: 'btn btn-small btn-danger', onclick: function () { st.vectorRows = []; save(); render(); } }, '모두 비우기')));
    box.appendChild(el('div', { class: 'form-grid', style: 'margin-top:12px' },
      field('RPM 간격(벡터)', stepIn, '위 RPM 시작·끝 사이를 이 간격으로 줄을 만듭니다. 이미 넣은 값은 남깁니다.'),
      el('div', { class: 'field' }, el('span', null, '\u00a0'), el('button', { type: 'button', class: 'btn', id: 'vectorFillBtn', onclick: function () {
        var stp = L.toNumber(st.vectorStep) > 0 ? st.vectorStep : st.rpmStep;
        var rl = L.rpmList(st.rpmStart, st.rpmEnd, stp);
        if (!rl.ok) { toast(rl.errors[0], true); return; }
        var old = {};
        st.vectorRows.forEach(function (r) { var k = L.toNumber(r.rpm); if (!isNaN(k)) old[k] = r; });
        st.vectorRows = rl.list.map(function (rpm) { return old[rpm] || { rpm: rpm, v: {} }; });
        save(); render();
      } }, 'RPM 범위로 줄 만들기'))));
    box.appendChild(el('div', { style: 'margin-top:12px' },
      field('엑셀에서 복사해 붙여넣기', paste, '열 순서: RPM, ' + keys.map(function (k) { return k + '차'; }).join(', ') + '. 탭·쉼표·공백 구분, 머리행은 건너뜁니다. 붙여넣으면 위 표를 바꿉니다.'),
      el('div', { class: 'btn-row', style: 'margin-top:8px' }, el('button', { type: 'button', class: 'btn btn-small', id: 'vectorPasteBtn', onclick: function () {
        var lines = L.splitPasted(st.vectorPaste);
        if (!lines.length) { toast('붙여넣은 숫자 줄이 없습니다.', true); return; }
        st.vectorRows = lines.map(function (c) { var v = {}; keys.forEach(function (k, j) { v[k] = c[j + 1] == null ? '' : c[j + 1]; }); return { rpm: c[0], v: v }; });
        save(); render(); toast(lines.length + '줄을 넣었습니다.');
      } }, '붙여넣은 값으로 표 채우기'))));
    return box;
  }

  function guessForceMap(headers) {
    var rpmCol = 0;
    headers.forEach(function (h, i) { if (/rpm|회전/i.test(String(h)) && rpmCol === 0) rpmCol = i; });
    var orderCols = [];
    headers.forEach(function (h, i) {
      if (i === rpmCol) return;
      var m = String(h).match(/(\d+(?:\.\d+)?)\s*(차|order|ord|x\b)/i) || String(h).match(/^\s*(\d+(?:\.\d+)?)\s*$/);
      if (m) { orderCols.push({ order: +m[1], col: i }); return; }
      var s2 = L.splitMeasHeader(h, []); // 1st · 2X · H1 · order 1 등 (2026-09-29 저녁 머리행 규칙)
      if (s2.ok && typeof s2.order === 'number') orderCols.push({ order: s2.order, col: i });
    });
    return { rpmCol: rpmCol, orderCols: orderCols };
  }
  function validOrderNumbers() {
    var out = [];
    state.settings.orders.forEach(function (o) { var k = L.toNumber(o.order); if (k > 0 && out.indexOf(k) < 0) out.push(k); });
    return out.sort(function (a, b) { return a - b; });
  }

  function configFromSettings() {
    var st = state.settings, errs = [];
    if (!state.frf) errs.push('FRF 표가 없습니다. 1단계에서 FRF 표를 만들어 주십시오.');
    var rl = L.rpmList(st.rpmStart, st.rpmEnd, st.rpmStep);
    if (!rl.ok) errs = errs.concat(rl.errors);
    var mode = MODE_SHORT[st.forceMode] ? st.forceMode : 'const';
    var isConst = mode === 'const', scaleOn = !!st.scaleOn;
    var vo = L.validateOrders(st.orders, isConst && !scaleOn);
    if (!vo.ok) errs = errs.concat(vo.errors);
    var nums = vo.ok ? vo.orders.map(function (o) { return o.order; }) : [];
    var sc = null;
    if (vo.ok && scaleOn) { sc = L.scaleRatios(st.orders, nums, st.refOrder); if (!sc.ok) { errs = errs.concat(sc.errors); sc = null; } }
    var force = null, orders = vo.ok ? vo.orders : [];
    if (isConst) {
      if (scaleOn && sc) {
        var refRow = st.orders.filter(function (o) { return L.toNumber(o.order) === sc.ref; })[0];
        var cf = L.constForcesByScale(nums, sc.ratio, refRow && refRow.force);
        if (!cf.ok) errs = errs.concat(cf.errors); else { orders = cf.orders; force = { mode: 'const', orders: orders }; }
      } else if (vo.ok && !scaleOn) force = { mode: 'const', orders: orders };
    } else if (mode === 'vector') {
      if (vo.ok && (!scaleOn || sc)) {
        var keys = scaleOn ? [sc.ref] : nums;
        var pv = L.parseForceVector(st.vectorRows, keys);
        if (!pv.ok) errs = errs.concat(pv.errors);
        else force = { mode: 'table', table: scaleOn ? L.expandTableByScale(pv.table, nums, sc.ratio, sc.ref).table : pv.table };
      }
    } else {
      var fromEst = state.forceFile && state.forceFile.source === 'estimate';
      if (state.forceFile && !fromEst) {
        var info = fileRowsInfo(state.forceFile);
        var pt = L.parseForceTable(info.data, state.forceFile.map);
        if (!pt.ok) errs = errs.concat(pt.errors); else state.forceTable = pt.table;
      }
      if (!state.forceTable) { if (!errs.length) errs.push('RPM별 가진력 표를 불러와 주십시오.'); }
      else if (vo.ok && (!scaleOn || sc || fromEst)) {
        var need = scaleOn && !fromEst ? [sc.ref] : nums;
        need.forEach(function (k) { if (!state.forceTable.byOrder[k]) errs.push(k + '차의 가진력 열을 지정해 주십시오.'); });
        if (!errs.length) force = { mode: 'table', table: scaleOn && !fromEst ? L.expandTableByScale(state.forceTable, nums, sc.ratio, sc.ref).table : state.forceTable };
      }
    }
    var ri = L.INTERP[st.interp] ? st.interp : 'linear';
    if (errs.length) return { ok: false, errors: errs };
    return { ok: true, cfg: { rpms: rl.list, orders: orders, force: force, interp: ri, forceMode: mode, scale: sc ? { ref: sc.ref, factors: sc.factors } : null } };
  }
  function runCalc() {
    var c = configFromSettings();
    if (!c.ok) {
      render();
      var box = alertBox('error', '계산하지 못했습니다', c.errors); box.id = 'calcErrors';
      main.appendChild(box); box.scrollIntoView({ block: 'nearest' });
      return;
    }
    result = L.computeResponse(state.frf, c.cfg); result.cfg = c.cfg;
    save(); ui.point = 0;
    location.hash = '#/result';
  }

  // ── 3. 결과 ─────────────────────────────────────────────────
  var COLORS = ['#1f77b4', '#d62728', '#2ca02c', '#9467bd', '#ff7f0e', '#17becf', '#8c564b', '#e377c2'];
  function ensureResult() {
    if (result) return true;
    var c = configFromSettings();
    if (!c.ok) return false;
    result = L.computeResponse(state.frf, c.cfg); result.cfg = c.cfg;
    return true;
  }
  function viewResult() {
    var wrap = el('div');
    wrap.appendChild(el('div', { class: 'page-head' }, el('h1', null, '3. RPM별 응답 결과')));
    wrap.appendChild(steps());
    if (!ensureResult()) {
      wrap.appendChild(el('div', { class: 'alert info' }, '아직 계산 결과가 없습니다. ', el('a', { href: '#/calc' }, '2. 계산 조건'), '에서 「RPM별 응답 계산」을 눌러 주십시오.'));
      return wrap;
    }
    var st = state.settings, cfg = result.cfg;
    if (ui.point >= result.points.length) ui.point = 0;
    var p = result.points[ui.point];
    add(wrap, alertBox('warn', '확인할 점', result.warnings));
    wrap.appendChild(el('section', { class: 'card' },
      el('div', { class: 'btn-row', style: 'justify-content:space-between;margin-bottom:10px' },
        el('p', { class: 'note', style: 'margin:0' }, 'RPM ' + L.fmt(cfg.rpms[0]) + '~' + L.fmt(cfg.rpms[cfg.rpms.length - 1]) + ' (' + cfg.rpms.length + '점) · 차수 ' + cfg.orders.map(function (o) { return o.order; }).join(', ') + ' · ' + L.INTERP[cfg.interp] + ' · 가진력 ' + MODE_SHORT[cfg.forceMode] + (cfg.scale ? ' · scale factor(기준 ' + cfg.scale.ref + '차)' : '')),
        el('div', { class: 'btn-row' },
          el('button', { type: 'button', class: 'btn btn-primary', id: 'xlsxBtn', onclick: function () {
            downloadSheets(outName('RPM별응답', 'xlsx'), L.resultToSheets(result, cfg.orders, { fileName: state.frfFile && state.frfFile.name, interp: cfg.interp, forceMode: cfg.forceMode, scale: cfg.scale, forceUnit: st.forceUnit, sample: state.sample, created: nowText() }));
          } }, '결과 엑셀 내려받기'),
          el('button', { type: 'button', class: 'btn', id: 'csvBtn', onclick: function () {
            var sh = L.resultToSheets({ points: [p] }, cfg.orders, { forceMode: cfg.forceMode })[1];
            download(outName('RPM별응답_' + baseOf(p.name), 'csv'), new Blob([L.toCsv(sh.rows)], { type: 'text/csv;charset=utf-8' }));
          } }, '이 응답점 CSV'))),
      result.points.length > 1 ? el('div', { class: 'point-tabs', role: 'group', 'aria-label': '응답점' }, result.points.map(function (q, i) {
        return el('button', { type: 'button', class: 'btn btn-small', 'aria-pressed': i === ui.point ? 'true' : 'false', onclick: function () { ui.point = i; render(); } }, q.name);
      })) : null,
      el('div', { class: 'btn-row', style: 'margin-bottom:6px' },
        el('h2', { style: 'margin:0;margin-right:auto' }, p.name + (p.unit ? ' — FRF 단위 ' + p.unit : '')),
        el('button', { type: 'button', class: 'btn btn-small', 'aria-pressed': ui.logY ? 'true' : 'false', onclick: function () { ui.logY = !ui.logY; render(); } }, '세로축 로그'),
        el('button', { type: 'button', class: 'btn btn-small', onclick: function () {
          var svg = document.querySelector('.chart-box svg');
          download(outName('RPM응답그래프_' + baseOf(p.name), 'svg'), new Blob(['<?xml version="1.0" encoding="UTF-8"?>\n' + svg.outerHTML], { type: 'image/svg+xml' }));
        } }, '그래프 SVG 저장')),
      chart(p, cfg.orders)));

    var detail = ui.detail;
    var head = [el('th', null, 'RPM')];
    cfg.orders.forEach(function (o) {
      if (detail) head.push(el('th', null, o.order + '차 f(Hz)'), el('th', null, o.order + '차 |FRF|'), el('th', null, o.order + '차 가진력'));
      head.push(el('th', null, o.order + '차 응답'));
    });
    head.push(el('th', null, 'overall (RSS)'), el('th', { class: 'text' }, '비고'));
    var body = p.rows.map(function (r) {
      var cells = [el('td', null, L.fmt(r.rpm, 6))];
      var notes = [];
      r.comps.forEach(function (c) {
        if (detail) cells.push(el('td', null, L.fmt(c.f, 5)), el('td', null, L.fmt(c.frf)), el('td', null, L.fmt(c.force)));
        cells.push(el('td', null, c.resp == null ? '-' : L.fmt(c.resp)));
        if (c.status !== 'ok') notes.push(c.order + '차 ' + L.STATUS_TEXT[c.status]);
      });
      cells.push(el('td', null, el('strong', null, r.overall == null ? '-' : L.fmt(r.overall))), el('td', { class: 'text' }, (r.partial ? '일부 차수 제외. ' : '') + notes.join('; ')));
      return el('tr', { class: r.partial ? 'partial' : null }, cells);
    });
    wrap.appendChild(el('section', { class: 'card' },
      el('div', { class: 'btn-row', style: 'margin-bottom:10px' },
        el('h2', { style: 'margin:0;margin-right:auto' }, '계산 표'),
        el('label', { class: 'radio-row' }, el('input', { type: 'checkbox', name: 'detail', checked: detail, onchange: function () { ui.detail = this.checked; render(); } }), '가진 주파수·|FRF|·가진력 열도 보기')),
      el('p', { class: 'note' }, '차수 응답 = |FRF(차수 × RPM / 60)| × 가진력, overall = √(Σ 차수 응답²). 응답 단위는 FRF 단위 × 가진력 단위(' + (st.forceUnit || '미입력') + ')입니다. 주황 줄은 일부 차수가 빠진 overall 입니다.'),
      el('div', { class: 'table-wrap tall' }, el('table', { class: 'grid', id: 'resultTable' }, el('thead', null, el('tr', null, head)), el('tbody', null, body)))));
    return wrap;
  }

  // SVG 선 그래프 (외부 라이브러리 없이)
  function chart(p, orders) {
    var W = 900, H = 420, m = { l: 74, r: 18, t: 18, b: 52 };
    var series = orders.map(function (o, k) { return { name: o.order + '차', color: COLORS[k % COLORS.length], width: 2, pts: p.rows.map(function (r) { return [r.rpm, r.comps[k].resp]; }) }; });
    series.push({ name: 'overall', color: '#111', width: 3.5, pts: p.rows.map(function (r) { return [r.rpm, r.overall]; }) });
    var xs = p.rows.map(function (r) { return r.rpm; });
    var ys = [];
    series.forEach(function (s) { s.pts.forEach(function (q) { if (q[1] != null && isFinite(q[1]) && (!ui.logY || q[1] > 0)) ys.push(q[1]); }); });
    var xmin = Math.min.apply(null, xs), xmax = Math.max.apply(null, xs);
    if (xmax === xmin) { xmin -= 1; xmax += 1; }
    var ymin, ymax, ty;
    var NS = 'http://www.w3.org/2000/svg';
    function s(tag, attrs, txt) { var n = document.createElementNS(NS, tag); Object.keys(attrs).forEach(function (k) { n.setAttribute(k, attrs[k]); }); if (txt != null) n.textContent = txt; return n; }
    var svg = s('svg', { viewBox: '0 0 ' + W + ' ' + H, xmlns: NS, role: 'img', 'aria-label': p.name + ' RPM별 응답 그래프', 'font-family': 'sans-serif', 'font-size': '14' });
    svg.appendChild(s('rect', { x: 0, y: 0, width: W, height: H, fill: '#fff' }));
    if (!ys.length) { svg.appendChild(s('text', { x: W / 2, y: H / 2, 'text-anchor': 'middle', fill: '#555' }, '그릴 값이 없습니다')); return el('div', { class: 'chart-box' }, svg); }
    if (ui.logY) {
      var lo = Math.floor(Math.log10(Math.min.apply(null, ys))), hi = Math.ceil(Math.log10(Math.max.apply(null, ys)));
      if (hi === lo) hi = lo + 1;
      ymin = lo; ymax = hi; ty = []; for (var e = lo; e <= hi; e++) ty.push(e);
    } else {
      ty = L.niceTicks(0, Math.max.apply(null, ys), 5); ymin = ty[0]; ymax = ty[ty.length - 1];
    }
    var tx = L.niceTicks(xmin, xmax, 6).filter(function (v) { return v >= xmin && v <= xmax; });
    function X(v) { return m.l + (v - xmin) / (xmax - xmin) * (W - m.l - m.r); }
    function Y(v) { var t = ui.logY ? Math.log10(v) : v; return H - m.b - (t - ymin) / (ymax - ymin) * (H - m.t - m.b); }
    ty.forEach(function (v) {
      var y = H - m.b - (v - ymin) / (ymax - ymin) * (H - m.t - m.b);
      svg.appendChild(s('line', { x1: m.l, x2: W - m.r, y1: y, y2: y, stroke: '#e3e7ec' }));
      svg.appendChild(s('text', { x: m.l - 8, y: y + 5, 'text-anchor': 'end', fill: '#444' }, ui.logY ? L.fmt(Math.pow(10, v), 3) : L.fmt(v, 4)));
    });
    tx.forEach(function (v) {
      svg.appendChild(s('line', { x1: X(v), x2: X(v), y1: m.t, y2: H - m.b, stroke: '#eef1f4' }));
      svg.appendChild(s('text', { x: X(v), y: H - m.b + 20, 'text-anchor': 'middle', fill: '#444' }, L.fmt(v, 6)));
    });
    svg.appendChild(s('line', { x1: m.l, x2: W - m.r, y1: H - m.b, y2: H - m.b, stroke: '#333' }));
    svg.appendChild(s('line', { x1: m.l, x2: m.l, y1: m.t, y2: H - m.b, stroke: '#333' }));
    svg.appendChild(s('text', { x: (m.l + W - m.r) / 2, y: H - 10, 'text-anchor': 'middle', fill: '#222' }, 'RPM'));
    svg.appendChild(s('text', { x: 16, y: (m.t + H - m.b) / 2, 'text-anchor': 'middle', fill: '#222', transform: 'rotate(-90 16 ' + (m.t + H - m.b) / 2 + ')' }, '응답' + (ui.logY ? ' (로그)' : '')));
    series.forEach(function (sr) {
      var d = '', pen = false;
      sr.pts.forEach(function (q) {
        var ok = q[1] != null && isFinite(q[1]) && (!ui.logY || q[1] > 0);
        if (!ok) { pen = false; return; }
        d += (pen ? 'L' : 'M') + X(q[0]).toFixed(1) + ' ' + Y(q[1]).toFixed(1) + ' ';
        pen = true;
      });
      if (d) svg.appendChild(s('path', { d: d, fill: 'none', stroke: sr.color, 'stroke-width': sr.width, 'stroke-linejoin': 'round' }));
    });
    // 범례를 그림 안에도 넣어 SVG 로 저장해도 읽히게
    var lx = m.l + 10;
    series.forEach(function (sr) {
      svg.appendChild(s('line', { x1: lx, x2: lx + 22, y1: m.t + 12, y2: m.t + 12, stroke: sr.color, 'stroke-width': sr.width }));
      svg.appendChild(s('text', { x: lx + 28, y: m.t + 17, fill: '#222' }, sr.name));
      lx += 40 + sr.name.length * 9;
    });
    return el('div', null, el('div', { class: 'chart-box' }, svg),
      el('ul', { class: 'legend' }, series.map(function (sr) { return el('li', null, el('i', { style: 'border-color:' + sr.color + ';border-top-width:' + sr.width + 'px' }), sr.name); })));
  }

  // 범용 XY 그래프 — series: [{name, color, width(0 이면 선 없음), pts:[[x,y]], marker: true|'hollow'}]
  function xyChart(o) {
    var W = 900, H = 400, m = { l: 74, r: 18, t: 18, b: 52 }, logY = !!o.logY;
    var NS = 'http://www.w3.org/2000/svg';
    function s(tag, attrs, txt) { var n = document.createElementNS(NS, tag); Object.keys(attrs).forEach(function (k) { n.setAttribute(k, attrs[k]); }); if (txt != null) n.textContent = txt; return n; }
    function good(y) { return y != null && isFinite(y) && (!logY || y > 0); }
    var svg = s('svg', { viewBox: '0 0 ' + W + ' ' + H, xmlns: NS, role: 'img', 'aria-label': o.aria || '', 'font-family': 'sans-serif', 'font-size': '14' });
    svg.appendChild(s('rect', { x: 0, y: 0, width: W, height: H, fill: '#fff' }));
    var xs = [], ys = [];
    o.series.forEach(function (sr) { sr.pts.forEach(function (q) { if (good(q[1])) { xs.push(q[0]); ys.push(q[1]); } }); });
    var box = el('div', { class: 'chart-box', id: o.id });
    if (!ys.length) { svg.appendChild(s('text', { x: W / 2, y: H / 2, 'text-anchor': 'middle', fill: '#555' }, '그릴 값이 없습니다')); box.appendChild(svg); return box; }
    var xmin = Math.min.apply(null, xs), xmax = Math.max.apply(null, xs);
    if (xmax === xmin) { xmin -= 1; xmax += 1; }
    var ymin, ymax, ty;
    if (logY) {
      var lo = Math.floor(Math.log10(Math.min.apply(null, ys))), hi = Math.ceil(Math.log10(Math.max.apply(null, ys)));
      if (hi === lo) hi = lo + 1;
      ymin = lo; ymax = hi; ty = []; for (var e = lo; e <= hi; e++) ty.push(e);
    } else { ty = L.niceTicks(Math.min(0, Math.min.apply(null, ys)), Math.max.apply(null, ys), 5); ymin = ty[0]; ymax = ty[ty.length - 1]; }
    var tx = L.niceTicks(xmin, xmax, 6).filter(function (v) { return v >= xmin && v <= xmax; });
    function X(v) { return m.l + (v - xmin) / (xmax - xmin) * (W - m.l - m.r); }
    function Yt(t) { return H - m.b - (t - ymin) / (ymax - ymin) * (H - m.t - m.b); }
    function Y(v) { return Yt(logY ? Math.log10(v) : v); }
    ty.forEach(function (v) {
      svg.appendChild(s('line', { x1: m.l, x2: W - m.r, y1: Yt(v), y2: Yt(v), stroke: '#e3e7ec' }));
      svg.appendChild(s('text', { x: m.l - 8, y: Yt(v) + 5, 'text-anchor': 'end', fill: '#444' }, logY ? L.fmt(Math.pow(10, v), 3) : L.fmt(v, 4)));
    });
    tx.forEach(function (v) {
      svg.appendChild(s('line', { x1: X(v), x2: X(v), y1: m.t, y2: H - m.b, stroke: '#eef1f4' }));
      svg.appendChild(s('text', { x: X(v), y: H - m.b + 20, 'text-anchor': 'middle', fill: '#444' }, L.fmt(v, 6)));
    });
    svg.appendChild(s('line', { x1: m.l, x2: W - m.r, y1: H - m.b, y2: H - m.b, stroke: '#333' }));
    svg.appendChild(s('line', { x1: m.l, x2: m.l, y1: m.t, y2: H - m.b, stroke: '#333' }));
    svg.appendChild(s('text', { x: (m.l + W - m.r) / 2, y: H - 10, 'text-anchor': 'middle', fill: '#222' }, 'RPM'));
    svg.appendChild(s('text', { x: 16, y: (m.t + H - m.b) / 2, 'text-anchor': 'middle', fill: '#222', transform: 'rotate(-90 16 ' + (m.t + H - m.b) / 2 + ')' }, o.yLabel || ''));
    o.series.forEach(function (sr) {
      if (sr.width > 0) {
        var d = '', pen = false;
        sr.pts.forEach(function (q) {
          if (!good(q[1])) { pen = false; return; }
          d += (pen ? 'L' : 'M') + X(q[0]).toFixed(1) + ' ' + Y(q[1]).toFixed(1) + ' '; pen = true;
        });
        if (d) svg.appendChild(s('path', { d: d, fill: 'none', stroke: sr.color, 'stroke-width': sr.width, 'stroke-linejoin': 'round' }));
      }
      if (sr.marker) sr.pts.forEach(function (q) {
        if (good(q[1])) svg.appendChild(s('circle', { cx: X(q[0]).toFixed(1), cy: Y(q[1]).toFixed(1), r: 4.5, fill: sr.marker === 'hollow' ? '#fff' : sr.color, stroke: sr.color, 'stroke-width': 2 }));
      });
    });
    box.appendChild(svg);
    return el('div', null, box, el('ul', { class: 'legend' }, o.series.map(function (sr) {
      return el('li', null, sr.width > 0 ? el('i', { style: 'border-color:' + sr.color + ';border-top-width:' + sr.width + 'px' }) : el('b', { class: 'dot', style: 'border-color:' + sr.color }), sr.name);
    })));
  }

  // ── 4. 가진력 추정 ────────────────────────────────────────────
  function viewForce() {
    var wrap = el('div');
    wrap.appendChild(el('div', { class: 'page-head' }, el('h1', null, '4. 계측 데이터로 가진력 추정')));
    wrap.appendChild(steps());
    wrap.appendChild(el('div', { class: 'alert info' },
      el('p', { style: 'margin:0 0 4px' }, '계산 응답(|FRF| × 가진력)과 계측 응답의 차이가 가장 작아지도록 가진력을 구합니다. 차수별 응답으로도, overall 로도 맞출 수 있고, 오차는 평균값·최대값 중에서 고릅니다(기획서 11장).'),
      el('p', { style: 'margin:0' }, '계측 표 형식: 차수별 열(RPM, 1차, 2차 …) · overall 만(RPM, overall) · 여러 지점(차수 우선 / 지점 우선) · 지점별 시트 · 긴 형식(RPM, 차수, 응답점 열). 예시 파일은 samples/ 폴더의 「예시데이터_계측_」 파일들입니다.')));
    if (!state.frf) { wrap.appendChild(el('div', { class: 'alert info' }, '먼저 ', el('a', { href: '#/frf' }, '1. FRF 불러오기'), '에서 FRF 표를 만들어 주십시오.')); return wrap; }
    var mf = state.measFile;
    wrap.appendChild(el('section', { class: 'card' },
      el('h2', null, '계측 파일'),
      fileInput('계측 응답 파일', function (nf) {
        state.measFile = nf; state.measMap = guessMeasMap(nf); estimate = null; fit = null; save(); render();
      }),
      mf ? el('p', { style: 'margin-top:10px' }, '불러온 파일: ', el('strong', null, mf.name)) : null,
      mf ? fileControls(mf, function (reguess) { if (reguess) state.measMap = guessMeasMap(mf); estimate = null; fit = null; save(); render(); }) : null));
    if (!mf) return wrap;
    var info = fileRowsInfo(mf), mm = state.measMap || guessMeasMap(mf);
    if (!mm.format) { var g0 = guessMeasMap(mf); Object.keys(g0).forEach(function (k) { if (mm[k] == null) mm[k] = g0[k]; }); mm.format = 'long'; } // 예전 저장 상태
    state.measMap = mm;
    function reset() { estimate = null; fit = null; save(); }
    var st = state.settings;
    var ratioIn = el('input', { type: 'number', name: 'antiRatio', step: 'any', min: 0, value: String(st.antiRatio == null ? '' : st.antiRatio), oninput: function () { st.antiRatio = this.value; estimate = null; fit = null; save(); } });
    var methodRow = el('div', { class: 'radio-row', role: 'radiogroup', 'aria-label': '추정 방식' },
      [['each', 'RPM·차수마다 따로'], ['scale', 'scale factor 고정 — 기준 차수의 RPM별 크기'], ['poly', 'scale factor 미고정 — 차수별 다항식']].map(function (o) {
        return el('label', null, el('input', { type: 'radio', name: 'estMode', value: o[0], checked: st.estMode === o[0], onchange: function () { st.estMode = o[0]; estimate = null; fit = null; save(); render(); } }), o[1]);
      }));
    var methodNote;
    if (st.estMode === 'scale') {
      var sc = st.scaleOn ? currentScale() : null;
      methodNote = sc && sc.ok
        ? el('p', { class: 'note' }, '2. 계산 조건의 scale factor 를 씁니다 — 기준 ' + sc.ref + '차, ' + validOrderNumbers().map(function (k) { return k + '차 ' + sc.factors[k]; }).join(', ') + '. RPM 점마다 모든 차수·응답점 관측으로 F_기준(RPM) = Σ a·m ÷ Σ a² (a = |FRF| × s_k/s_기준) 를 구합니다. ',
          el('a', { href: '#/calc' }, 'scale factor 고치기'))
        : el('div', { class: 'alert warn' }, '2. 계산 조건에서 「차수별 scale factor 사용」을 켜고 계측 표의 모든 차수에 scale factor 와 기준 차수를 넣어 주십시오. ', el('a', { href: '#/calc' }, '2. 계산 조건으로'));
    } else if (st.estMode === 'poly') {
      methodNote = el('div', null,
        el('div', { class: 'form-grid', style: 'margin-top:8px' }, field('가진력 형태 (다항식 차수 n)', el('select', { name: 'polyDegree', onchange: function () { st.polyDegree = +this.value; fit = null; save(); } },
          [0, 1, 2, 3, 4, 5].map(function (n) { return el('option', { value: String(n), selected: +st.polyDegree === n }, n + '차 ' + ['(상수)', '(직선)', '(2차 함수)', '(3차 함수)', '(4차 함수)', '(5차 함수)'][n]); })), '차수마다 F_k(RPM) = c0 + c1·RPM + … + cn·RPMⁿ')),
        el('p', { class: 'note', style: 'margin-top:8px' }, '계측 ≈ |FRF| × F_k(RPM) 의 제곱오차 합이 가장 작은 계수를 선형 최소제곱(QR 분해)으로 구합니다. 차수마다 계측 RPM 점이 n+1개 이상 있어야 합니다.'));
    } else {
      methodNote = el('p', { class: 'note' }, 'RPM·차수마다 가진력 = |계측| ÷ |FRF| 를 응답점별로 구하고, 응답점이 여럿이면 최소제곱으로 하나로 합칩니다(1단계 방식).');
    }
    var objRow = radioGroup('estObjective', '비교 대상', [['order', '차수별 응답 오차'], ['overall', 'overall 오차 (차수 합성 √Σ)']], st.estObjective, function (v) { st.estObjective = v; reset(); render(); });
    var critRow = radioGroup('estCrit', '오차 기준', [['mean', '평균값 — 평균 제곱오차 최소(RMS)'], ['max', '최대값 — 최대 절대오차 최소(minimax)']], st.estCrit, function (v) { st.estCrit = v; reset(); });
    var scaleRow = radioGroup('estErrScale', '오차 단위', [['abs', '절대오차(응답 단위)'], ['rel', '상대오차(계측 대비 비율)']], st.estErrScale, function (v) { st.estErrScale = v; reset(); });
    wrap.appendChild(el('section', { class: 'card' },
      el('h2', null, '계측 표 형식과 열 배정'),
      measFormatBlock(mf, mm, reset),
      el('div', { class: 'form-grid', style: 'margin-top:14px' },
        field('반공진 경고 기준', ratioIn, '차수별 오차로 맞출 때, 그 응답점 최대 |FRF| 에 이 비율을 곱한 값보다 |FRF| 가 작은 관측은 맞춤에서 뺍니다. 값은 해석자가 정합니다.')),
      el('h3', { style: 'margin-top:18px' }, '추정 방식'),
      methodRow, methodNote,
      st.estMode === 'each' ? null : el('div', { id: 'estOptions' },
        el('h3', { style: 'margin-top:14px' }, '비교 대상'), objRow,
        el('p', { class: 'note' }, 'overall 오차: 계산 overall = √(Σ_k (|FRF_k| × F_k)²) 이 계측 overall 과 가장 가깝도록 차수별 가진력을 구합니다. 계측이 overall 값뿐이면 이것만 쓸 수 있고, 합성할 차수는 2. 계산 조건의 차수 목록(' + (validOrderNumbers().join(', ') || '미입력') + ')입니다. 차수별 계측이면 overall 을 √Σ 로 만들어 씁니다.'),
        el('h3', { style: 'margin-top:14px' }, '오차 기준'), critRow,
        el('p', { class: 'note' }, '평균값 = 모든 관측(계측 지점·RPM)의 오차 제곱 평균을, 최대값 = 모든 관측 중 가장 큰 오차를 가장 작게 합니다. 계측 지점이 하나여도 여럿이어도 같은 방식입니다.'),
        el('h3', { style: 'margin-top:14px' }, '오차 단위'), scaleRow),
      el('div', { class: 'actions' }, el('button', { type: 'button', class: 'btn btn-primary', id: 'estBtn', onclick: runEstimate }, '가진력 추정'))));
    if (estimate && st.estMode === 'each') wrap.appendChild(estimateCard());
    if (fit && fit.mode === st.estMode) wrap.appendChild(fitCard());
    return wrap;
  }
  function radioGroup(name, label, opts, cur, onPick) {
    return el('div', { class: 'radio-row', role: 'radiogroup', 'aria-label': label }, opts.map(function (o) {
      return el('label', null, el('input', { type: 'radio', name: name, value: o[0], checked: cur === o[0], onchange: function () { onPick(o[0]); } }), o[1]);
    }));
  }
  function frfNames() { return state.frf ? state.frf.points.map(function (p) { return p.name; }) : []; }
  function ordersOf(text) { var out = []; String(text || '').split(/[,\s]+/).forEach(function (t) { var k = L.toNumber(t); if (k > 0 && out.indexOf(k) < 0) out.push(k); }); return out; }

  // 계측 표 형식 추정: 차수 열이 있으면 긴 형식, 시트 이름이 응답점과 맞으면 지점별 시트, 아니면 가로 형식
  function guessMeasMap(f) {
    var headers = fileRowsInfo(f).headers, names = frfNames();
    var rpmCol = -1, orderCol = -1, pointCols = {};
    headers.forEach(function (h, i) {
      var t = String(h);
      if (rpmCol < 0 && /rpm|회전/i.test(t)) rpmCol = i;
      else if (orderCol < 0 && /^\s*(차수|order)\s*$/i.test(t)) orderCol = i;
    });
    if (rpmCol < 0) rpmCol = 0;
    names.forEach(function (n) { pointCols[n] = headers.map(function (h) { return String(h).trim(); }).indexOf(n); });
    var sheetHits = names.filter(function (n) { return f.sheetNames.some(function (sn) { return sn === L.sheetName(n, {}) || sn === n; }); });
    var format = orderCol >= 0 ? 'long' : sheetHits.length ? 'sheets' : 'wide';
    // 가로 형식 기본값: 머리행 이름으로 응답점·차수를 찾고, 없으면 첫 응답점 · 계산 조건의 차수
    // 머리행 규칙(2026-09-29 저녁): 지점 이름은 파일 그대로(FRF 응답점 이름과 같아야 짝), 차수는 1차·1·1st·1X·H1·order 1 등
    var auto = L.measMapByHeader(headers, names, rpmCol, { defaultPoint: null }), pts = [];
    auto.forEach(function (c) { if (pts.indexOf(c.point) < 0) pts.push(c.point); });
    var single = pts.length ? auto : L.measMapByHeader(headers, names.slice(0, 1), rpmCol);
    var ords = [];
    single.forEach(function (c) { if (c.order !== 'overall' && ords.indexOf(c.order) < 0) ords.push(c.order); });
    var overall = single.length && single.every(function (c) { return c.order === 'overall'; });
    var wide = {
      kind: overall ? 'overall' : 'order', points: pts.length ? pts : names.slice(0, 1), layout: single.length ? 'auto' : 'order',
      ordersText: (ords.length ? ords.sort(function (a, b) { return a - b; }) : validOrderNumbers()).join(', '), startCol: rpmCol + 1,
      alias: {}, overrides: {}
    };
    var bind = {};
    names.forEach(function (n) { bind[n] = f.sheetNames.filter(function (sn) { return sn === L.sheetName(n, {}) || sn === n; })[0] || ''; });
    return {
      format: format, rpmCol: rpmCol, orderCol: orderCol < 0 ? (rpmCol === 0 ? 1 : 0) : orderCol, pointCols: pointCols, wide: wide,
      sheets: { bind: bind, rpmCol: 0, startCol: 1, kind: wide.kind, ordersText: wide.ordersText, layout: 'auto', overrides: {} }
    };
  }
  /**
   * 가로 형식 열 배정. 자동(머리행 이름)이면 L.analyzeMeasHeaders 로 열마다 인식 결과(analysis)도 돌려줍니다 — 「열 배정 확인」 표의 재료.
   * fixedPoint: 지점별 시트(시트 ↔ 응답점 짝이 정해짐). w.alias: 파일의 지점 이름 → FRF 응답점, w.overrides: 열별 직접 지정
   */
  function wideColMap(headers, rpmCol, w, points, fixedPoint, overrides) {
    var orders = w.kind === 'overall' ? ['overall'] : ordersOf(w.ordersText);
    if (w.layout === 'auto') {
      var an = L.analyzeMeasHeaders(headers, { rpmCol: rpmCol, points: frfNames(), defaultPoint: fixedPoint ? null : points[0] || null, fixedPoint: fixedPoint || null,
        alias: w.alias || {}, kind: w.kind, orders: w.kind === 'overall' ? null : orders, overrides: overrides || w.overrides || {} });
      return { map: an.filter(function (e) { return e.status === 'ok'; }).map(function (e) { return { col: e.col, point: e.point, order: e.order }; }), need: 0, analysis: an };
    }
    var m = L.measLayoutMap(+w.startCol, points, orders, w.layout === 'pos' ? 'order' : w.layout);
    return { map: m.filter(function (c) { return c.col < headers.length; }), need: m.length ? m[m.length - 1].col + 1 : 0 };
  }
  function sheetPart(f, sheet, point, sh) {
    var rows = f.sheets[sheet] || [], hr = L.guessHeaderRow(rows), headers = rows[hr] || [];
    if (!sh.overrides) sh.overrides = {};
    if (!sh.overrides[sheet]) sh.overrides[sheet] = {};
    var cm = wideColMap(headers, +sh.rpmCol, { kind: sh.kind, ordersText: sh.ordersText, layout: sh.layout === 'auto' ? 'auto' : 'order', startCol: sh.startCol }, [point], point, sh.overrides[sheet]);
    return { rows: rows.slice(hr + 1), rpmCol: +sh.rpmCol, colMap: cm.map, need: cm.need, width: headers.length, sheet: sheet, headers: headers, analysis: cm.analysis, overrides: sh.overrides[sheet] };
  }
  /** 화면의 형식·배정대로 계측 표를 읽습니다 → L.parseMeasured / L.parseMeasTable 결과 */
  function buildMeasured() {
    var f = state.measFile, mm = state.measMap, info = fileRowsInfo(f);
    if (mm.format === 'long') return L.parseMeasured(info.data, mm);
    if (mm.format === 'wide') {
      var cm = wideColMap(info.headers, mm.rpmCol, mm.wide, mm.wide.points);
      if (cm.need > info.headers.length) return { ok: false, errors: ['열 배치대로면 ' + cm.need + '열까지 있어야 하는데 표는 ' + info.headers.length + '열입니다. 응답점·차수 수나 시작 열을 확인해 주십시오.'] };
      return L.parseMeasTable([{ rows: info.data, rpmCol: mm.rpmCol, colMap: cm.map }]);
    }
    var parts = [], errs = [];
    frfNames().forEach(function (n) {
      var sn = mm.sheets.bind[n];
      if (!sn) return;
      var p = sheetPart(f, sn, n, mm.sheets);
      if (p.need > p.width) errs.push('시트 「' + sn + '」: ' + p.need + '열까지 있어야 하는데 ' + p.width + '열입니다.');
      parts.push(p);
    });
    if (!parts.length) errs.push('응답점마다 계측 시트를 하나 이상 골라 주십시오.');
    return errs.length ? { ok: false, errors: errs } : L.parseMeasTable(parts);
  }
  /** 열 배정 확인 표. rows: [{where, header, recog, point(글자|DOM), order(글자|DOM), state, cls}] */
  function mapPreview(rows) {
    return el('div', { class: 'table-wrap tall', style: 'margin-top:10px' }, el('table', { class: 'grid map', id: 'measMapTable' },
      el('thead', null, el('tr', null, el('th', null, '시트·열'), el('th', null, '머리행 (파일 그대로)'), el('th', null, '읽은 표기'), el('th', null, '응답점'), el('th', null, '차수'), el('th', null, '상태'))),
      el('tbody', null, rows.length ? rows.map(function (r) { return el('tr', { class: r.cls || null }, el('td', null, r.where), el('td', { class: 'text' }, r.header), el('td', { class: 'text' }, r.recog), el('td', { class: 'text' }, r.point), el('td', null, r.order), el('td', { class: 'text' }, r.state)); })
        : el('tr', null, el('td', { colspan: '6', class: 'text' }, '배정된 열이 없습니다. 응답점·차수·열 배치를 확인해 주십시오.')))));
  }
  var STATE_TEXT = { ok: '씀', order: '인식 못함 — 쓰지 않음', point: '응답점 짝 없음 — 쓰지 않음', filtered: '쓰지 않음', skip: '직접 뺌' };
  /** 자동 배정 한 열 → 표 한 줄. 차수·응답점은 고를 수 있음(직접 지정). */
  function analysisRow(where, e, ov, orderOpts, pointSel, reset) {
    var cur = ov[e.col] || {};
    var ordSel = el('select', { class: 'cell-input', name: 'measColOrder', 'aria-label': where + ' 차수', style: 'width:auto', onchange: function () {
      var o = ov[e.col] || (ov[e.col] = {}); o.order = this.value; if (!o.order && !o.point) delete ov[e.col]; reset(); render(); } },
      [['', '자동' + (e.auto != null ? ' (' + L.orderText(e.auto) + ')' : ' (인식 못함)')], ['skip', '쓰지 않음']].concat(orderOpts).map(function (o) { return el('option', { value: o[0], selected: String(cur.order || '') === o[0] }, o[1]); }));
    var pt = pointSel ? el('select', { class: 'cell-input', name: 'measColPoint', 'aria-label': where + ' 응답점', style: 'width:auto', onchange: function () {
      var o = ov[e.col] || (ov[e.col] = {}); o.point = this.value; if (!o.order && !o.point) delete ov[e.col]; reset(); render(); } },
      [el('option', { value: '' }, '자동' + (e.point && !cur.point ? ' (' + e.point + ')' : ''))].concat(frfNames().map(function (n) { return el('option', { value: n, selected: cur.point === n }, n); }))) : (e.point || '—');
    var recog = e.auto == null ? '—' : (e.label || e.header) + ' → ' + L.orderText(e.auto) + (e.form ? ' (' + L.ORDER_FORMS[e.form] + ')' : '');
    if (e.pointText) recog = '지점 「' + e.pointText + '」 · ' + recog;
    var state = (STATE_TEXT[e.status] || e.status) + (e.reason && e.status !== 'ok' ? ': ' + e.reason : '') + (e.overridden && e.status === 'ok' ? ' (직접 지정)' : '');
    return { where: where, header: e.header, recog: recog, point: pt, order: ordSel, state: state, use: e.status === 'ok', cls: e.status === 'order' || e.status === 'point' ? 'partial' : e.status === 'ok' ? null : 'muted' };
  }
  function analysisSummary(an) {
    var ok = an.filter(function (e) { return e.status === 'ok'; }).length, bad = an.filter(function (e) { return e.status === 'order' || e.status === 'point'; });
    if (!bad.length) return el('p', { class: 'note', id: 'measHeaderSummary' }, '머리행 ' + an.length + '개 가운데 ' + ok + '개를 계산에 씁니다. 계산 전에 아래 표에서 읽은 차수·응답점을 확인해 주십시오.');
    return el('div', { class: 'alert warn', id: 'measHeaderSummary' }, '머리행 ' + an.length + '개 가운데 ' + bad.length + '개를 알아보지 못해 계산에 쓰지 않습니다(추측하지 않음): ',
      bad.map(function (e) { return '「' + e.header + '」'; }).join(', '),
      '. 써야 하는 열이면 표의 차수·응답점을 직접 골라 주십시오. 인식하는 차수 표기: 1차 · 1 · 1st · 1X · H1 · order 1 · 1ord · ord1 (전각·대소문자 무관). 1/rev 는 쓰지 않는 것으로 확인해 읽지 않습니다.');
  }
  /** 직접 지정 차수 목록: 차수 목록 + 머리행에서 읽은 차수 (+ overall) */
  function orderOptions(w, an) {
    var ks = w.kind === 'overall' ? [] : ordersOf(w.ordersText);
    an.forEach(function (e) { if (typeof e.order === 'number' && ks.indexOf(e.order) < 0) ks.push(e.order); });
    ks.sort(function (a, b) { return a - b; });
    return ks.map(function (k) { return [String(k), k + '차']; }).concat([['overall', 'overall']]);
  }
  /** 위치 배정 한 열 → 표 한 줄. 머리행이 말하는 차수와 위치 배정이 다르면 알림 */
  function posRow(where, header, c) {
    var h = String(header == null ? '' : header), s = L.splitMeasHeader(h, frfNames());
    var clash = s.ok && (s.order !== c.order || (s.pointText && s.pointText !== c.point));
    return { where: where, header: h, recog: s.ok ? (s.pointText ? '지점 「' + s.pointText + '」 · ' : '') + L.orderText(s.order) : '—', point: c.point, order: L.orderText(c.order),
      state: clash ? '씀 — 그런데 머리행이 말하는 차수·지점과 위치 배정이 다릅니다. 열 배치를 확인해 주십시오' : '씀 (위치 배정)', use: true, cls: clash ? 'partial' : null };
  }
  function measFormatBlock(f, mm, reset) {
    var info = fileRowsInfo(f), names = frfNames(), box = el('div');
    box.appendChild(radioGroup('measFormat', '계측 표 형식', [['wide', '가로 형식 (RPM + 차수별 또는 overall 열, 한 지점·여러 지점)'], ['sheets', '지점별 시트'], ['long', '긴 형식 (RPM, 차수, 응답점 열)']], mm.format, function (v) { mm.format = v; reset(); render(); }));
    if (mm.format === 'long') {
      var rpmSel = colSelect('measRpmCol', info.headers, mm.rpmCol); rpmSel.addEventListener('change', function () { mm.rpmCol = +this.value; reset(); });
      var ordSel = colSelect('measOrderCol', info.headers, mm.orderCol); ordSel.addEventListener('change', function () { mm.orderCol = +this.value; reset(); });
      box.appendChild(el('div', { class: 'form-grid', style: 'margin-top:12px' }, field('RPM 열', rpmSel), field('차수 열', ordSel)));
      box.appendChild(el('div', { class: 'table-wrap', style: 'margin-top:14px' }, el('table', { class: 'grid map' },
        el('thead', null, el('tr', null, el('th', null, 'FRF 응답점'), el('th', null, '계측값 열'))),
        el('tbody', null, names.map(function (n) {
          var sel = colSelect('measPointCol', info.headers, mm.pointCols[n] == null ? -1 : mm.pointCols[n], true);
          sel.className = 'cell-input';
          sel.addEventListener('change', function () { mm.pointCols[n] = +this.value; reset(); });
          return el('tr', null, el('td', null, n), el('td', null, sel));
        })))));
      return box;
    }
    var w = mm.format === 'wide' ? mm.wide : mm.sheets;
    var kindRow = radioGroup('measKind', '값 종류', [['order', '차수별 응답'], ['overall', 'overall 만 (차수 정의 없음)']], w.kind, function (v) { w.kind = v; reset(); render(); });
    var ordIn = el('input', { name: 'measOrders', value: w.ordersText || '', placeholder: '예: 1, 2, 4', oninput: function () { w.ordersText = this.value; reset(); }, onchange: function () { render(); } });
    var layoutOpts = mm.format === 'wide'
      ? [['auto', '머리행 이름으로 자동 (지점이름_1차 · _1st · _1X · _H1 · _order 1 · _1ord · _ord1)'], ['order', '차수 우선 (지점1_차수1, 지점2_차수1, …)'], ['point', '지점 우선 (지점1_차수1, 지점1_차수2, …)']]
      : [['auto', '머리행 이름으로 자동 (1차 · 1 · 1st · 1X · H1 · overall)'], ['pos', '위치로 (시작 열부터 차수 순서)']];
    var layoutRow = radioGroup('measLayout', '열 배치', layoutOpts, w.layout, function (v) { w.layout = v; reset(); render(); });
    var grid = el('div', { class: 'form-grid', style: 'margin-top:12px' });
    var headersForSel = mm.format === 'wide' ? info.headers : (function () { var sn = names.map(function (n) { return mm.sheets.bind[n]; }).filter(Boolean)[0]; var rows = sn ? f.sheets[sn] || [] : []; return rows[L.guessHeaderRow(rows)] || []; })();
    var rpmSel2 = colSelect('measRpmCol', headersForSel, mm.format === 'wide' ? mm.rpmCol : +w.rpmCol);
    rpmSel2.addEventListener('change', function () { if (mm.format === 'wide') mm.rpmCol = +this.value; else w.rpmCol = +this.value; reset(); render(); });
    var startSel = colSelect('measStartCol', headersForSel, +w.startCol);
    startSel.addEventListener('change', function () { w.startCol = +this.value; reset(); render(); });
    grid.appendChild(field('RPM 열', rpmSel2, mm.format === 'sheets' ? '모든 시트가 같은 배치라고 봅니다' : null));
    if (w.kind === 'order') grid.appendChild(field('차수 목록 (열 순서대로)', ordIn, '쉼표로 구분. 자동 배정이면 이 목록에 있는 차수 열만 씁니다.'));
    if (w.layout !== 'auto') grid.appendChild(field('첫 계측값 열', startSel));
    box.appendChild(el('h3', { style: 'margin-top:14px' }, '값 종류')); box.appendChild(kindRow);
    box.appendChild(el('h3', { style: 'margin-top:14px' }, '열 배치')); box.appendChild(layoutRow);
    box.appendChild(grid);
    var preview = [], summary = null, allAn = [];
    if (mm.format === 'wide') {
      var pts = w.points;
      if (w.layout === 'auto') {
        if (!pts.length) pts.push(names[0]);
        box.appendChild(el('h3', { style: 'margin-top:14px' }, '지점 이름이 없는 열(RPM, 1차, 2차 …)의 응답점'));
        box.appendChild(el('select', { class: 'cell-input', name: 'measPoint', 'aria-label': '지점 이름이 없는 열의 응답점', style: 'width:auto', onchange: function () { pts[0] = this.value; reset(); render(); } },
          names.map(function (m) { return el('option', { value: m, selected: m === pts[0] }, m); })));
        box.appendChild(el('p', { class: 'note' }, '머리행에 지점 이름이 있으면(지점이름_1차) 그 이름을 파일 그대로 FRF 응답점 이름과 맞춥니다. 이름이 다르면 아래 「지점 이름 짝」에서 골라 주십시오.'));
      } else {
        box.appendChild(el('h3', { style: 'margin-top:14px' }, '계측 지점 (FRF 응답점과 짝, 열 순서대로)'));
        box.appendChild(el('div', { class: 'btn-row' }, pts.map(function (n, i) {
          var sel = el('select', { class: 'cell-input', name: 'measPoint', 'aria-label': (i + 1) + '번째 계측 지점', style: 'width:auto', onchange: function () { pts[i] = this.value; reset(); render(); } },
            names.map(function (m) { return el('option', { value: m, selected: m === n }, (i + 1) + '. ' + m); }));
          return el('span', { class: 'btn-row' }, sel, el('button', { type: 'button', class: 'btn btn-small btn-danger', onclick: function () { pts.splice(i, 1); reset(); render(); } }, '빼기'));
        }), el('button', { type: 'button', class: 'btn btn-small', onclick: function () { var next = names.filter(function (m) { return pts.indexOf(m) < 0; })[0]; if (next) { pts.push(next); reset(); render(); } } }, '지점 추가')));
      }
      var wcm = wideColMap(info.headers, mm.rpmCol, w, pts);
      if (wcm.analysis) {
        if (!w.overrides) w.overrides = {};
        if (!w.alias) w.alias = {};
        // 파일의 지점 이름 ↔ FRF 응답점 짝 — 이름이 다를 때만(이름은 파일 그대로 두고 짝만 지음)
        var texts = [];
        wcm.analysis.forEach(function (e) { if (e.pointText && (names.indexOf(e.pointText) < 0 || w.alias[e.pointText]) && texts.indexOf(e.pointText) < 0) texts.push(e.pointText); });
        if (texts.length) {
          box.appendChild(el('h3', { style: 'margin-top:14px' }, '지점 이름 짝 (파일 이름 그대로 → FRF 응답점)'));
          box.appendChild(el('div', { class: 'table-wrap' }, el('table', { class: 'grid map', id: 'measAliasTable' },
            el('thead', null, el('tr', null, el('th', null, '파일의 지점 이름'), el('th', null, 'FRF 응답점'))),
            el('tbody', null, texts.map(function (t) {
              var sel = el('select', { class: 'cell-input', name: 'measAlias', 'aria-label': t + ' 짝', onchange: function () { if (this.value) w.alias[t] = this.value; else delete w.alias[t]; reset(); render(); } },
                [el('option', { value: '' }, '(짝 없음 — 쓰지 않음)')].concat(names.map(function (n) { return el('option', { value: n, selected: w.alias[t] === n }, n); })));
              return el('tr', null, el('td', { class: 'text' }, t), el('td', null, sel));
            })))));
        }
        summary = analysisSummary(wcm.analysis);
        var oo = orderOptions(w, wcm.analysis);
        wcm.analysis.forEach(function (e) { preview.push(analysisRow(colLetter(e.col), e, w.overrides, oo, true, reset)); });
      } else wcm.map.forEach(function (c) { preview.push(posRow(colLetter(c.col), info.headers[c.col], c)); });
    } else {
      box.appendChild(el('h3', { style: 'margin-top:14px' }, '응답점별 시트'));
      box.appendChild(el('div', { class: 'table-wrap' }, el('table', { class: 'grid map' },
        el('thead', null, el('tr', null, el('th', null, 'FRF 응답점'), el('th', null, '계측 시트'))),
        el('tbody', null, names.map(function (n) {
          var sel = el('select', { class: 'cell-input', name: 'measSheet', onchange: function () { mm.sheets.bind[n] = this.value; reset(); render(); } },
            [el('option', { value: '' }, '(쓰지 않음)')].concat(f.sheetNames.map(function (sn) { return el('option', { value: sn, selected: sn === mm.sheets.bind[n] }, sn); })));
          return el('tr', null, el('td', null, n), el('td', null, sel));
        })))));
      names.forEach(function (n) {
        var sn = mm.sheets.bind[n];
        if (!sn) return;
        var p = sheetPart(f, sn, n, mm.sheets);
        if (p.analysis) {
          allAn = allAn.concat(p.analysis);
          var oo2 = orderOptions(w, p.analysis);
          p.analysis.forEach(function (e) { preview.push(analysisRow(sn + ' · ' + colLetter(e.col), e, p.overrides, oo2, false, reset)); });
        } else p.colMap.forEach(function (c) { preview.push(posRow(sn + ' · ' + colLetter(c.col), p.headers[c.col], c)); });
      });
      if (mm.sheets.layout === 'auto') summary = analysisSummary(allAn);
    }
    var used = preview.filter(function (r) { return r.use; }).length;
    box.appendChild(el('h3', { style: 'margin-top:14px' }, '열 배정 확인 (계산에 쓰는 열 ' + used + ' / ' + preview.length + ')'));
    if (summary) box.appendChild(summary);
    box.appendChild(mapPreview(preview));
    return box;
  }
  function runEstimate() {
    var pm = buildMeasured();
    if (pm.ok && pm.kind === 'overall' && state.settings.estMode === 'each') pm = { ok: false, errors: ['계측이 overall 값뿐이면 「RPM·차수마다 따로」로는 차수별 가진력을 나눌 수 없습니다. scale factor 고정 또는 다항식을 골라 주십시오(비교 대상은 overall).'] };
    if (!pm.ok) { render(); var b = alertBox('error', '추정하지 못했습니다', pm.errors); b.id = 'estErrors'; main.appendChild(b); b.scrollIntoView({ block: 'nearest' }); return; }
    var ratio = L.toNumber(state.settings.antiRatio);
    if (isNaN(ratio) || ratio < 0) { render(); main.appendChild(alertBox('error', '추정하지 못했습니다', ['반공진 경고 기준을 0 이상의 숫자로 입력해 주십시오.'])); return; }
    var st = state.settings, opts = { interp: st.interp, antiRatio: ratio };
    var extra = { objective: pm.kind === 'overall' ? 'overall' : st.estObjective, crit: st.estCrit, errScale: st.estErrScale, orders: validOrderNumbers() };
    if (st.estMode === 'scale' || st.estMode === 'poly') {
      var r;
      if (st.estMode === 'scale') {
        var sc = st.scaleOn ? currentScale() : { ok: false, errors: ['2. 계산 조건에서 「차수별 scale factor 사용」을 켜고 값을 넣어 주십시오.'] };
        r = sc.ok ? L.estimateScaleFixed(state.frf, pm, Object.assign({ interp: st.interp, antiRatio: ratio, ratio: sc.ratio, ref: sc.ref }, extra)) : sc;
        if (r.ok) r.factors = sc.factors;
      } else r = L.estimatePoly(state.frf, pm, Object.assign({ interp: st.interp, antiRatio: ratio, degree: st.polyDegree }, extra));
      if (!r.ok) { fit = null; render(); var eb = alertBox('error', '추정하지 못했습니다', r.errors); eb.id = 'estErrors'; main.appendChild(eb); eb.scrollIntoView({ block: 'nearest' }); return; }
      fit = r;
      fit.each = pm.kind === 'order' ? L.estimateForce(state.frf, pm, opts) : { rows: [] };   // 그래프에 점으로 겹쳐 보일 「따로 구한 값」
      fit.meta = { skipped: pm.skipped, points: pm.points, ratio: ratio };
      render();
      var fc = document.getElementById('fitCard'); if (fc) fc.scrollIntoView({ block: 'start' });
      return;
    }
    estimate = L.estimateForce(state.frf, pm, opts);
    estimate.meta = { skipped: pm.skipped, points: pm.points, ratio: ratio };
    render();
    var c = document.getElementById('estCard'); if (c) c.scrollIntoView({ block: 'start' });
  }

  // 새 추정 방식(scale 고정·다항식)의 결과 — 계수, RPM별 가진력 그래프, 계산 vs 계측 그래프, 잔차
  function fitCard() {
    var st = state.settings, f = fit, unit = st.forceUnit ? ' (' + st.forceUnit + ')' : '';
    var excluded = f.obs.filter(function (o) { return !o.use; });
    var anti = excluded.filter(function (o) { return o.anti; }).length;
    var notes = [];
    if (anti) notes.push('반공진 부근(|FRF| 가 작아 오차가 커지기 쉬운 곳)으로 본 관측 ' + anti + '개를 맞춤에서 뺐습니다.');
    if (excluded.length - anti) notes.push('FRF 범위 밖이거나 계측값이 비어 쓰지 못한 관측이 ' + (excluded.length - anti) + '개 있습니다.');
    if (f.meta.skipped) notes.push('RPM·차수가 숫자가 아닌 행 ' + f.meta.skipped + '개를 건너뛰었습니다.');
    var coef;
    if (f.mode === 'scale') {
      coef = el('div', null,
        el('p', { class: 'note' }, '기준 ' + f.ref + '차의 RPM별 크기를 RPM 점마다 최소제곱으로 구했습니다. 다른 차수는 scale factor 비(' + f.orders.map(function (k) { return k + '차 ' + L.fmt(f.ratio[k], 4); }).join(', ') + ') × 기준입니다.'),
        el('div', { class: 'table-wrap tall' }, el('table', { class: 'grid', id: 'fitCoefTable' },
          el('thead', null, el('tr', null, el('th', null, 'RPM'), el('th', null, '기준 ' + f.ref + '차 추정' + unit), el('th', null, '쓴 관측'), f.orders.map(function (k) { return el('th', null, k + '차' + unit); }))),
          el('tbody', null, f.rpms.map(function (r, i) {
            return el('tr', null, el('td', null, L.fmt(r, 6)), el('td', null, el('strong', null, L.fmt(f.refForce[i]))), el('td', null, String(f.used[i])), f.orders.map(function (k) { return el('td', null, L.fmt(f.table.byOrder[k][i])); }));
          })))));
    } else {
      coef = el('div', null,
        el('p', { class: 'note' }, '차수마다 F_k(RPM) = Σ c_j·RPMʲ 의 계수입니다(RPM 은 그대로의 값, 가진력 단위' + (st.forceUnit ? ' ' + st.forceUnit : '') + '). 계측 RPM 범위 밖으로 늘여 쓰면(외삽) 값이 크게 틀릴 수 있습니다.'),
        el('div', { class: 'table-wrap' }, el('table', { class: 'grid', id: 'fitCoefTable' },
          el('thead', null, el('tr', null, el('th', null, '차수'), Array.apply(null, Array(f.degree + 1)).map(function (_, j) { return el('th', null, 'c' + j); }), el('th', null, '쓴 관측'), el('th', { class: 'text' }, '식'))),
          el('tbody', null, f.fits.map(function (ft) {
            return el('tr', null, el('td', null, ft.order + '차'), ft.coef.map(function (c) { return el('td', null, L.fmt(c, 6)); }), el('td', null, String(ft.n)), el('td', { class: 'text' }, L.polyText(ft.coef)));
          })))));
    }
    // RPM별 가진력 그래프: 선 = 추정, 점 = RPM·차수마다 따로 구한 값
    var fSeries = [], rmin = f.rpms[0], rmax = f.rpms[f.rpms.length - 1];
    f.orders.forEach(function (k, i) {
      var color = COLORS[i % COLORS.length], pts = [];
      if (f.mode === 'poly') {
        var ft = f.fits.filter(function (x) { return x.order === k; })[0];
        for (var t = 0; t <= 100; t++) { var r = rmin + (rmax - rmin) * t / 100; pts.push([r, L.polyEval(ft.coef, r)]); }
      } else pts = f.rpms.map(function (r, j) { return [r, f.table.byOrder[k][j]]; });
      fSeries.push({ name: k + '차 추정', color: color, width: 2.5, pts: pts, marker: f.mode === 'scale' });
      fSeries.push({ name: k + '차 따로 구한 값', color: color, width: 0, pts: f.each.rows.filter(function (r) { return r.order === k; }).map(function (r) { return [r.rpm, r.ls]; }), marker: 'hollow' });
    });
    // 계산 vs 계측 그래프 (응답점 하나)
    var pts = f.meta.points;
    if (ui.fitPoint >= pts.length) ui.fitPoint = 0;
    var pname = pts[ui.fitPoint], cSeries = [];
    (f.objective === 'overall' ? ['overall'] : f.orders).forEach(function (k, i) {
      var color = k === 'overall' ? '#111' : COLORS[i % COLORS.length], lab = k === 'overall' ? 'overall' : k + '차';
      var mine = f.obs.filter(function (o) { return o.point === pname && o.order === k; }).sort(function (a, b) { return a.rpm - b.rpm; });
      cSeries.push({ name: lab + ' 계산', color: color, width: 2.5, pts: mine.map(function (o) { return [o.rpm, o.calc]; }) });
      cSeries.push({ name: lab + ' 계측', color: color, width: 0, pts: mine.map(function (o) { return [o.rpm, o.meas]; }), marker: 'hollow' });
    });
    var statRows = f.stats.concat(f.statsByPoint.slice(1)).map(function (g) {
      return el('tr', null, el('td', { class: 'text' }, g.key), el('td', null, String(g.n)), el('td', null, L.fmt(g.rms)), el('td', null, L.fmt(g.maxAbs)), el('td', null, g.rmsDb == null ? '-' : L.fmt(g.rmsDb, 3) + ' dB'), el('td', null, g.maxDb == null ? '-' : L.fmt(g.maxDb, 3) + ' dB'));
    });
    return el('section', { class: 'card', id: 'fitCard' },
      el('div', { class: 'btn-row', style: 'margin-bottom:10px' },
        el('h2', { style: 'margin:0;margin-right:auto' }, (f.mode === 'scale' ? '추정 결과 — scale factor 고정' : '추정 결과 — ' + f.degree + '차 다항식') + ' · ' + (f.objective === 'overall' ? 'overall' : '차수별') + ' 오차 · ' + (f.crit === 'max' ? '최대값' : '평균값') + (f.errScale === 'rel' ? ' · 상대오차' : '')),
        el('button', { type: 'button', class: 'btn btn-primary', id: 'fitXlsxBtn', onclick: function () {
          downloadSheets(outName('가진력추정_' + (f.mode === 'scale' ? 'scale고정' : f.degree + '차다항식'), 'xlsx'), L.fitToSheets(f, { fileName: state.frfFile && state.frfFile.name, measFile: state.measFile.name, interp: st.interp, antiRatio: f.meta.ratio, sample: state.sample, created: nowText() }));
        } }, '추정 엑셀 내려받기'),
        el('button', { type: 'button', class: 'btn', id: 'useFitBtn', onclick: useFit }, '추정 가진력을 계산에 쓰기')),
      alertBox('warn', null, notes),
      el('h3', null, f.mode === 'scale' ? '기준 차수 RPM별 크기' : '추정 계수'),
      coef,
      el('div', { class: 'btn-row', style: 'margin:18px 0 6px' }, el('h3', { style: 'margin:0;margin-right:auto' }, 'RPM별 추정 가진력'), svgSaveBtn('fitForceChart', '추정가진력그래프')),
      el('p', { class: 'note' }, f.objective === 'overall' && !f.each.rows.length ? '선 = 이번 추정. overall 만 있는 계측은 RPM·차수마다 따로 구할 수 없어 비교 점이 없습니다.' : '선 = 이번 추정, 빈 원 = RPM·차수마다 따로 구한 값(1단계 방식). 둘이 크게 어긋나면 가정한 형태(scale 비·다항식 차수)가 계측과 맞지 않는다는 뜻입니다.'),
      xyChart({ id: 'fitForceChart', series: fSeries, yLabel: '가진력' + unit, aria: 'RPM별 추정 가진력 그래프' }),
      el('div', { class: 'btn-row', style: 'margin:18px 0 6px' }, el('h3', { style: 'margin:0;margin-right:auto' }, '계산 vs 계측 — ' + pname),
        el('button', { type: 'button', class: 'btn btn-small', 'aria-pressed': ui.logY ? 'true' : 'false', onclick: function () { ui.logY = !ui.logY; render(); } }, '세로축 로그'),
        svgSaveBtn('fitCmpChart', '계산대비계측_' + baseOf(pname))),
      pts.length > 1 ? el('div', { class: 'point-tabs', role: 'group', 'aria-label': '비교 응답점' }, pts.map(function (n, i) {
        return el('button', { type: 'button', class: 'btn btn-small', 'aria-pressed': i === ui.fitPoint ? 'true' : 'false', onclick: function () { ui.fitPoint = i; render(); } }, n);
      })) : null,
      el('p', { class: 'note' }, f.objective === 'overall' ? '선 = 계산 overall √(Σ_k (|FRF_k| × F_k)²), 빈 원 = 계측 overall.' : '선 = 계산(|FRF| × 추정 가진력), 빈 원 = 계측.'),
      xyChart({ id: 'fitCmpChart', series: cSeries, yLabel: '응답' + (ui.logY ? ' (로그)' : ''), aria: pname + ' 계산 대비 계측 그래프', logY: ui.logY }),
      el('h3', { style: 'margin-top:18px' }, '잔차'),
      el('p', { class: 'note' }, 'RMS = √(Σ(계산 − 계측)² ÷ n) — 평균값 기준이 줄이는 값, 최대 절대오차 = max|계산 − 계측| — 최대값 기준이 줄이는 값 (응답 단위). dB 오차 = 20·log10(계산 ÷ 계측). 맞춤에 쓴 관측만 셉니다.'),
      el('div', { class: 'table-wrap' }, el('table', { class: 'grid', id: 'fitStatTable' },
        el('thead', null, el('tr', null, el('th', { class: 'text' }, '구분'), el('th', null, '관측 수'), el('th', null, 'RMS 오차 (평균)'), el('th', null, '최대 절대오차'), el('th', null, 'RMS dB 오차'), el('th', null, '최대 |dB| 오차'))),
        el('tbody', null, statRows))));
  }
  function svgSaveBtn(id, kind) {
    return el('button', { type: 'button', class: 'btn btn-small', onclick: function () {
      var svg = document.querySelector('#' + id + ' svg');
      if (svg) download(outName(kind, 'svg'), new Blob(['<?xml version="1.0" encoding="UTF-8"?>\n' + svg.outerHTML], { type: 'image/svg+xml' }));
    } }, '그래프 SVG 저장');
  }
  // 추정 가진력을 「RPM 연동 벡터」로 넣어 2. 계산 조건에서 바로 쓰게 합니다
  function useFit() {
    var st = state.settings, f = fit;
    var scales = {};
    st.orders.forEach(function (o) { scales[L.toNumber(o.order)] = o.scale; });
    st.orders = f.orders.map(function (k) { return { order: k, force: '', scale: scales[k] == null ? '' : scales[k] }; });
    st.forceMode = 'vector';
    if (f.mode === 'scale') {
      st.scaleOn = true; st.refOrder = f.ref;
      st.vectorRows = f.rpms.map(function (r, i) { var v = {}; v[f.ref] = f.refForce[i] == null ? '' : L.round(f.refForce[i], 9); return { rpm: r, v: v }; });
    } else {
      st.scaleOn = false;
      st.vectorRows = f.rpms.map(function (r, i) { var v = {}; f.orders.forEach(function (k) { v[k] = L.round(f.table.byOrder[k][i], 9); }); return { rpm: r, v: v }; });
    }
    st.rpmStart = f.rpms[0]; st.rpmEnd = f.rpms[f.rpms.length - 1];
    if (!(L.toNumber(st.rpmStep) > 0)) st.rpmStep = f.rpms.length > 1 ? f.rpms[1] - f.rpms[0] : 1;
    result = null; save();
    toast('추정 가진력을 RPM 연동 벡터로 넣었습니다. 계산 조건을 확인하고 계산해 주십시오.');
    location.hash = '#/calc';
  }
  function estimateCard() {
    var pts = estimate.meta.points;
    var anti = 0, missing = 0;
    var body = estimate.rows.map(function (r) {
      return el('tr', null, el('td', null, L.fmt(r.rpm, 6)), el('td', null, String(r.order)), el('td', null, L.fmt(r.f, 5)),
        r.points.map(function (q) {
          if (q.anti) anti++;
          if (q.status !== 'ok') missing++;
          return el('td', { class: q.anti ? 'anti' : null, title: q.anti ? '반공진 부근 — 종합값에서 뺌' : null }, q.force == null ? '-' : L.fmt(q.force) + (q.anti ? ' (경고)' : ''));
        }),
        el('td', null, el('strong', null, r.ls == null ? '-' : L.fmt(r.ls))), el('td', null, String(r.used)));
    });
    var notes = [];
    if (anti) notes.push('반공진 부근(|FRF| 가 작아 추정값이 튀기 쉬운 곳)으로 표시된 칸이 ' + anti + '개 있습니다. 종합값에서 뺐습니다.');
    if (missing) notes.push('FRF 범위 밖이거나 계측값이 비어 계산하지 못한 칸이 ' + missing + '개 있습니다.');
    if (estimate.meta.skipped) notes.push('RPM·차수가 숫자가 아닌 행 ' + estimate.meta.skipped + '개를 건너뛰었습니다.');
    return el('section', { class: 'card', id: 'estCard' },
      el('div', { class: 'btn-row', style: 'margin-bottom:10px' },
        el('h2', { style: 'margin:0;margin-right:auto' }, '추정 결과 (' + estimate.rows.length + '행)'),
        el('button', { type: 'button', class: 'btn btn-primary', id: 'estXlsxBtn', onclick: function () {
          downloadSheets(outName('가진력추정', 'xlsx'), L.estimateToSheets(estimate, { fileName: state.frfFile && state.frfFile.name, measFile: state.measFile.name, interp: state.settings.interp, antiRatio: estimate.meta.ratio, sample: state.sample, created: nowText() }));
        } }, '추정 엑셀 내려받기'),
        el('button', { type: 'button', class: 'btn', id: 'useEstBtn', onclick: useEstimate }, '종합값을 가진력 표로 계산에 쓰기')),
      alertBox('warn', null, notes),
      el('p', { class: 'note' }, '종합값 = 경고 없는 응답점들로 구한 최소제곱 값 Σ|FRF|·|계측| ÷ Σ|FRF|² (응답점마다 같은 가중, 가정). 응답점별 값이 서로 크게 다르면 가진점이 여럿이거나 계측점·해석점이 어긋났을 수 있습니다.'),
      el('div', { class: 'table-wrap tall' }, el('table', { class: 'grid', id: 'estTable' },
        el('thead', null, el('tr', null, el('th', null, 'RPM'), el('th', null, '차수'), el('th', null, 'f(Hz)'), pts.map(function (n) { return el('th', null, n); }), el('th', null, '종합'), el('th', null, '쓴 응답점'))),
        el('tbody', null, body))));
  }
  function useEstimate() {
    var t = L.estimateToForceTable(estimate);
    var st = state.settings;
    state.forceTable = t.table;
    state.forceFile = { source: 'estimate', name: '가진력 추정 결과' };
    st.forceMode = 'table';
    st.orders = t.orders.map(function (k) { return { order: k, force: '' }; });
    st.rpmStart = t.table.rpm[0]; st.rpmEnd = t.table.rpm[t.table.rpm.length - 1];
    if (!(L.toNumber(st.rpmStep) > 0)) st.rpmStep = t.table.rpm.length > 1 ? t.table.rpm[1] - t.table.rpm[0] : 1;
    result = null; save();
    toast('종합 추정값을 RPM별 가진력 표로 넣었습니다. 계산 조건을 확인하고 계산해 주십시오.');
    location.hash = '#/calc';
  }

  // ── 계산 방법 ─────────────────────────────────────────────────
  function viewHelp() {
    return el('div', { class: 'prose' },
      el('div', { class: 'page-head' }, el('h1', null, '계산 방법과 가정')),
      el('section', { class: 'card' },
        el('h2', null, '계산식 (수강생 원문 참고 1·2)'),
        el('div', { class: 'formula' }, '가진 주파수   f = 차수 × RPM / 60            [Hz]\n차수 응답     R_k(RPM) = |FRF(f)| × F_k(RPM)\noverall       R(RPM) = √( Σ_k R_k(RPM)² )     (RSS)\n가진력 추정   F_k = |계측 응답| ÷ |FRF(f)|'),
        el('h2', null, '가진력 입력 — scale factor 와 RPM 연동 벡터 (2026-09-29 추가)'),
        el('div', { class: 'formula' }, 'RPM 연동 벡터   F_k(RPM) = 입력한 RPM 점 사이를 선형 보간 (범위 밖은 계산하지 않음)\nscale factor    F_k(RPM) = (s_k / s_기준) × F_기준(RPM)\n                예) s_1 = 0.5, s_2 = 1.0, s_3 = 0.2, 기준 2차 60 N → F_1 = 30 N, F_3 = 12 N'),
        el('p', null, '차수별 상수·RPM 연동 벡터·가진력 표 파일 어느 방식에서도 scale factor 를 켜면 기준 차수 하나만 입력합니다.'),
        el('h2', null, '가진력 추정 — 계산/계측 오차 최소화 (2026-09-29 추가)'),
        el('div', { class: 'formula' }, '관측 i = (RPM_i, 차수 k_i, 응답점 p_i),  h_i = |H_p(k_i·RPM_i/60)|,  m_i = |계측_i|\n계산 응답        c_i = h_i × F_k(RPM_i)\n목표             Σ_i (c_i − m_i)² 최소\n\n(a) scale 고정   F_k(RPM) = r_k × F_기준(RPM),  r_k = s_k / s_기준\n                 RPM 점마다  F_기준(RPM) = Σ a_i·m_i / Σ a_i²,  a_i = h_i × r_k\n\n(b) 형태 지정    F_k(RPM) = c_0 + c_1·RPM + … + c_n·RPMⁿ   (차수마다 따로)\n                 A_ij = h_i × (RPM_i / RPM_max)ʲ,  min ‖A·β − m‖  (QR 분해)\n                 c_j = β_j / RPM_maxʲ\n\n잔차             RMS = √(Σ(c_i − m_i)² / n),  dB 오차 = 20·log10(c_i / m_i)'),
        el('ul', null,
          el('li', null, '크기(|FRF|·|계측|)로 맞춥니다. FRF 가 크기+위상·실수+허수로 와도 이 도구는 |FRF| 로 바꿔 두고, 계측 표도 RPM·차수별 크기라 위상이 없습니다. 가진점이 하나이면 |H·F| = |H|·|F| 라 크기만으로 모형이 정확합니다.'),
          el('li', null, '반공진 부근(|FRF| 가 작은 곳)과 FRF 범위 밖 관측은 맞춤에서 뺍니다.'),
          el('li', null, '(b) 는 RPM 을 최댓값으로 나눠 풀고 계수를 되돌립니다. 정규방정식(AᵀA)을 직접 풀면 3차 이상에서 오차가 커지기 쉬워 QR 분해를 씁니다.'),
          el('li', null, '검증: 알려진 가진력으로 만든 합성 계측(노이즈 없음)에서 추정값이 원래 값과 1e-9 이내로 같고, ±2% 노이즈에서 3% 이내임을 테스트로 확인합니다.')),
        el('h2', null, '계측 표 형식·overall 오차·오차 기준 (2026-09-29 오후 추가)'),
        el('div', { class: 'formula' }, '계측 표 형식\n  차수별       RPM, 1차, 2차, …                     (한 지점)\n  overall      RPM, overall                          (차수 정의 없음)\n  여러 지점    차수 우선 RPM, 지점1_1차, 지점2_1차, …, 지점1_2차, …\n               지점 우선 RPM, 지점1_1차, 지점1_2차, …, 지점2_1차, …\n  지점별 시트  시트마다 RPM, 1차, 2차, … (또는 RPM, overall)\n  긴 형식      RPM, 차수, 응답점1, 응답점2, …\n\n머리행 규칙 (2026-09-29 저녁 확정)\n  지점 이름    파일에 있는 그대로 (FRF 응답점 이름과 같으면 짝, 다르면 「지점 이름 짝」에서 고름)\n  차수 표기    1차 · 차수1 (기본)  1 · 0.5 (숫자만, 200 이하)  1st · 2nd · 3rd · 4th · 1st order\n               1X · 1x  H1  order 1 · Ord1 · 2 order · 1ord · ord1 (09-30 확인)\n               전각 숫자(１차)·대소문자·공백 무관\n  쓰지 않음    1/rev (09-30 확인 — 차수로 읽지 않고 「인식 못함」)\n  overall      overall · OA · 전체 · 합성\n  모르는 표기  추측하지 않고 「인식 못함」으로 표시, 계산에서 뺌 (2st·11st 처럼 서수가 틀려도)\n\noverall 오차  계산 overall_p(RPM) = √( Σ_k ( |H_p(k·RPM/60)| × F_k(RPM) )² )\n  scale 고정  = F_기준 × √Σ_k(|H_pk| × s_k/s_기준)²  → F_기준 에 선형\n  다항식      F_k 계수에 비선형 → Levenberg–Marquardt\n  (F_k 의 부호는 overall 로 구분되지 않아 양수로 맞춤)\n\n오차 기준     평균값: min Σ e_i² / n   (최소제곱)\n              최대값: min max_i |e_i|  (minimax — Lawson 반복 재가중)\n              e_i = 계산_i − 계측_i  (상대오차면 ÷ 계측_i), i = 모든 계측 지점·RPM(·차수)'),
        el('ul', null,
          el('li', null, '계측 지점이 하나여도 여럿이어도 같은 식입니다. 여럿이면 모든 지점의 오차를 한데 모아 평균 또는 최대를 줄입니다.'),
          el('li', null, 'overall 만으로도 차수별 가진력을 나눌 수 있는 것은 차수마다 가진 주파수가 달라 |FRF| 가 RPM 에 따라 다르게 변하기 때문입니다. 관측(지점 × RPM)이 계수 수(차수 × (n+1))보다 많아야 하고, 테스트에서 노이즈 없는 합성 overall 로 계수를 1e-7 이내로 복원함을 확인했습니다.'),
          el('li', null, '최대값 기준은 튀는 점 하나에 맞춰 전체가 끌려갈 수 있습니다. 결과의 잔차 표에서 RMS 와 최대 오차를 함께 보십시오.')),
        el('h2', null, '1단계에서 둔 가정 (실제 자료를 받으면 확정)'),
        el('ul', null,
          el('li', null, '차수는 회전 차수이며 가진 주파수 = 차수 × RPM / 60 입니다.'),
          el('li', null, '주파수 열의 단위는 Hz 입니다.'),
          el('li', null, 'FRF 가 크기+위상 또는 실수+허수로 와도 응답 계산에는 크기 |FRF| 만 씁니다. 가진점 개수·위상은 고려하지 않습니다(2026-09-29 수강생 확인).'),
          el('li', null, '해석 주파수 사이 값은 선택한 방식(선형 / 가장 가까운 점 / 로그)으로 보간합니다. 기본은 선형(2026-09-29 확인). 해석 범위 밖은 계산하지 않고 비고에 적습니다.'),
          el('li', null, '계측 파일 형식은 위 여섯 가지 중에서 고릅니다(2026-09-29 수강생 정의). 반공진 경고 기준은 사용자가 정합니다.'),
          el('li', null, 'dB 변환은 기준값을 확인한 뒤 2단계에서 넣습니다.')),
        el('h2', null, '교차 확인'),
        el('p', null, '같은 계산을 하는 파이썬 스크립트 ', el('code', null, 'python/rpm_response.py'), ' 와 코랩 노트북 ', el('code', null, 'python/rpm_response_colab.ipynb'), ' 이 저장소에 있습니다. 웹 결과와 값을 대조할 수 있습니다.'),
        el('h2', null, '데이터 보관'),
        el('p', null, '불러온 파일과 조건은 이 브라우저 저장소에만 남습니다. 다른 PC 로 옮기거나 보관하려면 결과 엑셀을 내려받아 두십시오. 「모두 지우기」로 지울 수 있습니다.')));
  }

  function steps() {
    var done = [!!state.frf, !!(result || (state.settings.rpmStart !== '' && state.settings.rpmEnd !== '')), !!result, !!(estimate || fit)];
    var items = [['1. FRF 불러오기', '열 짝짓기 → FRF 표'], ['2. 계산 조건', 'RPM·차수·가진력'], ['3. 결과', '그래프·표·엑셀'], ['4. 가진력 추정', '계측이 있을 때']];
    return el('ol', { class: 'steps' }, items.map(function (it, i) { return el('li', { class: done[i] ? 'done' : null }, el('b', null, it[0]), el('span', null, it[1])); }));
  }

  // ── 예시 데이터·지우기 ────────────────────────────────────────
  function loadSample() {
    var s = S.build();
    function asFile(name, rows) { var sh = {}; sh['예시데이터'] = rows; return { name: name, sheetNames: ['예시데이터'], sheets: sh, sheet: '예시데이터', headerRow: 0 }; }
    state = emptyState();
    state.sample = true;
    state.frfFile = asFile(S.FILE_FRF + '.xlsx', s.frfRows);
    state.frfMap = L.guessMapping(s.frfRows[0]);
    state.frfMap.points.forEach(function (p) { p.unit = s.units[p.name] || ''; });
    var b = L.buildFrf(s.frfRows.slice(1), state.frfMap);
    state.frf = b.frf; state.frfWarnings = b.warnings;
    var st = s.settings;
    state.settings = defaultSettings();
    ['rpmStart', 'rpmEnd', 'rpmStep', 'forceMode', 'forceUnit', 'interp', 'antiRatio', 'refOrder', 'vectorStep'].forEach(function (k) { state.settings[k] = st[k]; });
    state.settings.orders = st.orders.map(function (o) { return { order: o.order, force: o.force, scale: o.scale }; });
    state.settings.vectorRows = st.vectorRows.map(function (r) { return { rpm: r.rpm, v: Object.assign({}, r.v) }; });
    state.forceFile = asFile(S.FILE_FORCE + '.csv', s.forceRows);
    state.forceFile.map = guessForceMap(s.forceRows[0]);
    state.measFile = asFile(S.FILE_MEAS + '.csv', s.measRows);
    state.measMap = guessMeasMap(state.measFile);
    result = null; estimate = null; fit = null;
    save();
    toast('예시 데이터를 불러왔습니다(가상 값).');
    if (location.hash === '#/frf') render(); else location.hash = '#/frf';
  }
  function clearAll() {
    if (!window.confirm('불러온 파일·조건·결과를 이 브라우저에서 모두 지웁니다. 계속하시겠습니까?')) return;
    Store.clear(); state = emptyState(); result = null; estimate = null; fit = null; save();
    toast('모두 지웠습니다.');
    if (location.hash === '#/frf') render(); else location.hash = '#/frf';
  }

  // ── 라우팅 ─────────────────────────────────────────────────
  var ROUTES = { '#/frf': viewFrf, '#/calc': viewCalc, '#/result': viewResult, '#/force': viewForce, '#/help': viewHelp };
  function render() {
    var h = ROUTES[location.hash] ? location.hash : '#/frf';
    main.textContent = '';
    main.appendChild(ROUTES[h]());
    document.getElementById('sampleBanner').hidden = !state.sample;
    Array.prototype.forEach.call(document.querySelectorAll('#nav a'), function (a) {
      if (a.getAttribute('href') === h) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
    });
    main.setAttribute('data-route', h);
  }
  var lastRoute = null;
  window.addEventListener('hashchange', function () {
    if (!ROUTES[location.hash]) { location.hash = '#/frf'; return; }
    render();
    if (lastRoute !== location.hash) { window.scrollTo(0, 0); main.focus({ preventScroll: true }); }
    lastRoute = location.hash;
  });
  document.getElementById('sampleBtn').addEventListener('click', loadSample);
  document.getElementById('clearBtn').addEventListener('click', clearAll);
  if (!Store.available()) {
    var sb = document.getElementById('storeBanner');
    sb.textContent = '이 브라우저는 저장소를 막고 있어, 창을 닫으면 입력이 사라집니다. 결과는 엑셀로 내려받아 두십시오.'; sb.hidden = false;
  }
  if (!ROUTES[location.hash]) history.replaceState(null, '', '#/frf');
  lastRoute = location.hash;
  render();
})();
