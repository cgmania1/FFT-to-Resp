/*
 * FRF RPM별 응답 계산기 — 순수 계산 모듈 (화면·저장소와 무관)
 * 기획서 4장 「과제 B 계산 흐름」과 원문 참고 1·2 를 그대로 옮겼습니다.
 *   가진 주파수 f = 차수 × RPM / 60 (Hz)                     (가정 — 회전 차수 기준)
 *   차수 성분 = |FRF(f)| × 가진력(차수, RPM)                   (원문 참고 1)
 *   overall = √(Σ 차수 성분²)                                (원문 참고 2, RSS)
 *   가진력 추정 = 계측 응답 ÷ |FRF(f)|                         (기획서 4장, 단일 가진점 가정)
 * 브라우저에서는 window.FRFLogic, Node(테스트)에서는 module.exports 로 씁니다.
 * ES module 이 아닌 이유: index.html 을 파일(file://)로 열면 브라우저가 module 스크립트를 막기 때문입니다.
 */
(function (root) {
  'use strict';

  var FORMATS = {
    mag: { ko: '크기만', cols: 1 },
    magphase: { ko: '크기 + 위상', cols: 2 },
    reim: { ko: '실수 + 허수', cols: 2 }
  };
  var INTERP = {
    linear: '선형 보간',
    nearest: '가장 가까운 점',
    loglog: '로그 보간(주파수·크기 모두 로그)'
  };
  var MAX_RPM_POINTS = 20000;
  var FORCE_MODES = {
    const: '차수별 상수',
    vector: 'RPM 연동 벡터(화면 입력·붙여넣기, RPM 사이 선형 보간)',
    table: 'RPM별 가진력 표 파일(RPM 사이 선형 보간)'
  };

  // ── 숫자 ──────────────────────────────────────────────────────
  function toNumber(v) {
    if (typeof v === 'number') return isFinite(v) ? v : NaN;
    if (v == null) return NaN;
    var s = String(v).trim().replace(/,/g, '').replace(/\s+/g, '');
    if (s === '') return NaN;
    // 「1.2e-3」「-5」「3.」 형태만 숫자로 봅니다(단위가 붙은 값은 숫자가 아님)
    if (!/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(s)) return NaN;
    return Number(s);
  }
  function round(x, n) {
    if (x == null || !isFinite(x)) return x;
    var p = Math.pow(10, n == null ? 6 : n);
    return Math.round(x * p) / p;
  }

  // ── 열 자동 추정 (사용자가 화면에서 고칠 수 있는 첫 제안일 뿐) ────────
  var RE_FREQ = /(freq|주파수|^hz$|\[hz\]|\(hz\))/i;
  var RE_MAG = /(mag|amp|크기|진폭|abs)/i;
  var RE_PHASE = /(phase|위상|deg|ang)/i;
  var RE_RE = /(real|실수|(^|[^a-z])re([^a-z]|$))/i;
  var RE_IM = /(imag|허수|(^|[^a-z])im([^a-z]|$))/i;

  function baseName(h) {
    return String(h).replace(RE_MAG, '').replace(RE_PHASE, '').replace(/real|imag|실수|허수/ig, '')
      .replace(/[\s_\-\[\]\(\)\/:]+$/g, '').replace(/^[\s_\-\[\]\(\)\/:]+/g, '').trim() || String(h);
  }

  function guessMapping(headers) {
    var hs = headers.map(function (h) { return String(h == null ? '' : h).trim(); });
    var freqCol = -1;
    for (var i = 0; i < hs.length; i++) if (RE_FREQ.test(hs[i])) { freqCol = i; break; }
    if (freqCol < 0) freqCol = 0;
    var rest = [];
    for (var j = 0; j < hs.length; j++) if (j !== freqCol && hs[j] !== '') rest.push(j);
    var nPhase = rest.filter(function (c) { return RE_PHASE.test(hs[c]); }).length;
    var nIm = rest.filter(function (c) { return RE_IM.test(hs[c]); }).length;
    var format = 'mag';
    if (nPhase > 0 && nPhase * 2 === rest.length) format = 'magphase';
    else if (nIm > 0 && nIm * 2 === rest.length) format = 'reim';
    var points = [];
    if (format === 'mag') {
      rest.forEach(function (c) { points.push({ name: hs[c], a: c, b: -1, unit: '' }); });
    } else {
      var second = format === 'magphase' ? RE_PHASE : RE_IM;
      var firsts = rest.filter(function (c) { return !second.test(hs[c]); });
      var seconds = rest.filter(function (c) { return second.test(hs[c]); });
      firsts.forEach(function (c, k) { points.push({ name: baseName(hs[c]), a: c, b: seconds[k] == null ? -1 : seconds[k], unit: '' }); });
    }
    return { freqCol: freqCol, format: format, points: points };
  }

  // 표 머리행 찾기: 숫자가 아닌 칸이 가장 많은 첫 행(위 5행 안) — 제목 줄이 있어도 넘어가도록
  function guessHeaderRow(rows) {
    var best = 0, bestScore = -1;
    for (var r = 0; r < Math.min(rows.length, 5); r++) {
      var row = rows[r] || [];
      var text = 0, filled = 0;
      row.forEach(function (v) { if (v !== '' && v != null) { filled++; if (isNaN(toNumber(v))) text++; } });
      var next = rows[r + 1] || [];
      var nextNum = next.filter(function (v) { return !isNaN(toNumber(v)); }).length;
      var score = filled >= 2 && nextNum >= 2 ? text * 10 + filled : -1;
      if (score > bestScore) { bestScore = score; best = r; }
    }
    return best;
  }

  // ── FRF 표 만들기 ───────────────────────────────────────────────
  function magnitudeOf(format, a, b) {
    if (format === 'reim') return Math.sqrt(a * a + b * b);
    return Math.abs(a); // mag, magphase — 크기는 위상과 무관
  }

  /**
   * rows: 머리행 아래 데이터 행(배열의 배열), mapping: {freqCol, format, points:[{name,a,b,unit}]}
   * 반환: {freq:[], points:[{name,unit,mag:[]}], warnings:[], skipped}
   */
  function buildFrf(rows, mapping) {
    var errors = [];
    if (!mapping || mapping.freqCol == null || mapping.freqCol < 0) errors.push('주파수 열을 지정해 주십시오.');
    if (!FORMATS[mapping && mapping.format]) errors.push('FRF 값 형식을 지정해 주십시오.');
    var pts = (mapping && mapping.points || []).filter(function (p) { return p && p.a != null && p.a >= 0; });
    if (!pts.length) errors.push('응답점 열을 하나 이상 지정해 주십시오.');
    if (mapping && FORMATS[mapping.format] && FORMATS[mapping.format].cols === 2) {
      pts.forEach(function (p) { if (p.b == null || p.b < 0) errors.push('「' + p.name + '」의 두 번째 열(' + (mapping.format === 'reim' ? '허수' : '위상') + ')을 지정해 주십시오.'); });
    }
    var names = {};
    pts.forEach(function (p) {
      var n = String(p.name || '').trim();
      if (!n) errors.push('응답점 이름이 비어 있습니다.');
      else if (names[n]) errors.push('응답점 이름 「' + n + '」이 겹칩니다.');
      names[n] = true;
    });
    if (errors.length) return { ok: false, errors: errors };

    var two = FORMATS[mapping.format].cols === 2;
    var recs = [], skipped = 0;
    rows.forEach(function (row) {
      var f = toNumber(row[mapping.freqCol]);
      if (isNaN(f)) { skipped++; return; }
      var vals = pts.map(function (p) {
        var a = toNumber(row[p.a]);
        var b = two ? toNumber(row[p.b]) : 0;
        return isNaN(a) || isNaN(b) ? NaN : magnitudeOf(mapping.format, a, b);
      });
      recs.push({ f: f, v: vals });
    });
    var warnings = [];
    if (skipped) warnings.push('주파수가 숫자가 아닌 행 ' + skipped + '개를 건너뛰었습니다.');
    var sorted = recs.every(function (r, i) { return i === 0 || recs[i - 1].f <= r.f; });
    if (!sorted) {
      recs.sort(function (x, y) { return x.f - y.f; });
      warnings.push('주파수가 오름차순이 아니어서 정렬했습니다.');
    }
    var uniq = [], dup = 0;
    recs.forEach(function (r) {
      if (uniq.length && uniq[uniq.length - 1].f === r.f) { dup++; return; }
      uniq.push(r);
    });
    if (dup) warnings.push('같은 주파수가 두 번 이상 나온 행 ' + dup + '개는 처음 값만 썼습니다.');
    if (uniq.length < 2) return { ok: false, errors: ['주파수 행이 2개 이상 있어야 보간할 수 있습니다.'] };
    var neg = uniq.filter(function (r) { return r.f < 0; }).length;
    if (neg) warnings.push('음수 주파수 행이 ' + neg + '개 있습니다. 열 지정을 확인해 주십시오.');
    var frf = {
      freq: uniq.map(function (r) { return r.f; }),
      points: pts.map(function (p, k) {
        var mag = uniq.map(function (r) { return r.v[k]; });
        var blank = mag.filter(function (x) { return isNaN(x); }).length;
        if (blank) warnings.push('「' + String(p.name).trim() + '」에 숫자가 아닌 값이 ' + blank + '개 있습니다(그 주파수 근처는 계산하지 않습니다).');
        return { name: String(p.name).trim(), unit: String(p.unit || '').trim(), mag: mag };
      })
    };
    return { ok: true, frf: frf, warnings: warnings, skipped: skipped };
  }

  function frfSummary(frf) {
    var f = frf.freq, diffs = [];
    for (var i = 1; i < f.length; i++) diffs.push(f[i] - f[i - 1]);
    diffs.sort(function (a, b) { return a - b; });
    var med = diffs[Math.floor(diffs.length / 2)];
    return {
      rows: f.length, fmin: f[0], fmax: f[f.length - 1], step: med,
      uneven: diffs.length ? round(diffs[diffs.length - 1] - diffs[0], 9) > Math.abs(med) * 1e-6 : false,
      points: frf.points.length
    };
  }

  function maxMag(mag) {
    var m = 0;
    mag.forEach(function (x) { if (isFinite(x) && x > m) m = x; });
    return m;
  }

  // ── 보간 ──────────────────────────────────────────────────────
  /**
   * freq(오름차순)·vals 에서 f 의 값을 구합니다.
   * status: ok | out_of_range(해석 주파수 범위 밖) | no_data(이웃 값이 숫자가 아님)
   * 로그 보간은 f·값 중 0 이하가 끼면 로그를 쓸 수 없어 그 구간만 선형으로 대신하고 note 를 남깁니다.
   */
  function interpolate(freq, vals, f, method) {
    var n = freq.length;
    if (!(f >= freq[0] && f <= freq[n - 1])) return { value: null, status: 'out_of_range' };
    var lo = 0, hi = n - 1;
    while (hi - lo > 1) {
      var mid = (lo + hi) >> 1;
      if (freq[mid] <= f) lo = mid; else hi = mid;
    }
    if (freq[lo] === f) return pick(vals[lo]);
    if (freq[hi] === f) return pick(vals[hi]);
    var f0 = freq[lo], f1 = freq[hi], v0 = vals[lo], v1 = vals[hi];
    if (method === 'nearest') {
      // 한가운데면 낮은 주파수 쪽을 씁니다
      return pick(f - f0 <= f1 - f ? v0 : v1);
    }
    if (!isFinite(v0) || !isFinite(v1)) return { value: null, status: 'no_data' };
    var t = (f - f0) / (f1 - f0);
    if (method === 'loglog') {
      if (f0 > 0 && v0 > 0 && v1 > 0) {
        var tl = Math.log(f / f0) / Math.log(f1 / f0);
        return { value: Math.exp(Math.log(v0) + tl * (Math.log(v1) - Math.log(v0))), status: 'ok' };
      }
      return { value: v0 + t * (v1 - v0), status: 'ok', note: 'loglog_fallback_linear' };
    }
    return { value: v0 + t * (v1 - v0), status: 'ok' };
  }
  function pick(v) { return isFinite(v) ? { value: v, status: 'ok' } : { value: null, status: 'no_data' }; }

  // ── RPM·차수 ──────────────────────────────────────────────────
  function excitationFreq(order, rpm) { return order * rpm / 60; }

  function rpmList(start, end, step) {
    var s = toNumber(start), e = toNumber(end), d = toNumber(step);
    var errs = [];
    if (isNaN(s) || isNaN(e) || isNaN(d)) errs.push('RPM 시작·끝·간격을 숫자로 입력해 주십시오.');
    else {
      if (s < 0) errs.push('RPM 시작값은 0 이상이어야 합니다.');
      if (e < s) errs.push('RPM 끝값이 시작값보다 작습니다.');
      if (d <= 0) errs.push('RPM 간격은 0보다 커야 합니다.');
    }
    if (errs.length) return { ok: false, errors: errs };
    var count = Math.floor((e - s) / d + 1e-9) + 1;
    if (count > MAX_RPM_POINTS) return { ok: false, errors: ['RPM 점이 ' + count + '개로 너무 많습니다(최대 ' + MAX_RPM_POINTS + '개). 간격을 늘려 주십시오.'] };
    var list = [];
    for (var i = 0; i < count; i++) list.push(round(s + i * d, 9));
    if (round(list[list.length - 1], 6) < round(e, 6)) list.push(e); // 끝값이 간격에 딱 맞지 않아도 끝값까지 계산
    return { ok: true, list: list };
  }

  /** orders: [{order, force}] (force 는 차수별 상수 모드에서만 필요) */
  function validateOrders(orders, needForce) {
    var errs = [], seen = {}, out = [];
    (orders || []).forEach(function (o, i) {
      if ((o.order === '' || o.order == null) && (o.force === '' || o.force == null)) return; // 빈 줄
      var k = toNumber(o.order), F = toNumber(o.force);
      if (isNaN(k) || k <= 0) { errs.push((i + 1) + '번째 줄: 차수는 0보다 큰 숫자여야 합니다.'); return; }
      if (seen[k]) { errs.push('차수 ' + k + '가 두 번 들어 있습니다.'); return; }
      seen[k] = true;
      if (needForce && (isNaN(F) || F < 0)) { errs.push('차수 ' + k + '의 가진력을 0 이상의 숫자로 입력해 주십시오.'); return; }
      out.push({ order: k, force: needForce ? F : null });
    });
    if (!out.length && !errs.length) errs.push('차수를 하나 이상 입력해 주십시오.');
    out.sort(function (a, b) { return a.order - b.order; });
    return errs.length ? { ok: false, errors: errs } : { ok: true, orders: out };
  }

  /**
   * RPM별 가진력 표 읽기. mapping: {rpmCol, orderCols:[{order, col}]}
   * 반환 table: {rpm:[오름차순], byOrder:{차수: [값…]}}
   */
  function parseForceTable(rows, mapping) {
    var errs = [];
    if (mapping.rpmCol == null || mapping.rpmCol < 0) errs.push('가진력 표의 RPM 열을 지정해 주십시오.');
    var cols = (mapping.orderCols || []).filter(function (c) { return c.col >= 0 && !isNaN(toNumber(c.order)); });
    if (!cols.length) errs.push('가진력 표에서 차수별 열을 하나 이상 지정해 주십시오.');
    if (errs.length) return { ok: false, errors: errs };
    var recs = [];
    rows.forEach(function (r) {
      var rpm = toNumber(r[mapping.rpmCol]);
      if (isNaN(rpm)) return;
      recs.push({ rpm: rpm, v: cols.map(function (c) { return toNumber(r[c.col]); }) });
    });
    recs.sort(function (a, b) { return a.rpm - b.rpm; });
    if (!recs.length) return { ok: false, errors: ['가진력 표에 RPM 이 숫자인 행이 없습니다.'] };
    var table = { rpm: recs.map(function (r) { return r.rpm; }), byOrder: {} };
    cols.forEach(function (c, k) { table.byOrder[toNumber(c.order)] = recs.map(function (r) { return isNaN(r.v[k]) ? null : r.v[k]; }); });
    return { ok: true, table: table };
  }

  /** forceSpec: {mode:'const', orders:[{order,force}]} | {mode:'table', table} */
  function forceAt(spec, order, rpm) {
    if (spec.mode === 'table') {
      var col = spec.table && spec.table.byOrder[order];
      if (!col) return { value: null, status: 'no_force' };
      var r = interpolate(spec.table.rpm, col.map(function (x) { return x == null ? NaN : x; }), rpm, 'linear');
      if (r.status === 'out_of_range') return { value: null, status: 'force_out_of_range' };
      if (r.status !== 'ok') return { value: null, status: 'no_force' };
      return { value: r.value, status: 'ok' };
    }
    for (var i = 0; i < spec.orders.length; i++) if (spec.orders[i].order === order) return { value: spec.orders[i].force, status: 'ok' };
    return { value: null, status: 'no_force' };
  }

  function rss(values) {
    var s = 0, n = 0;
    values.forEach(function (v) { if (v != null && isFinite(v)) { s += v * v; n++; } });
    return { value: n ? Math.sqrt(s) : null, count: n };
  }

  var STATUS_TEXT = {
    ok: '',
    out_of_range: '가진 주파수가 FRF 해석 범위 밖',
    no_data: 'FRF 값 없음(숫자가 아닌 칸)',
    no_force: '가진력 없음',
    force_out_of_range: 'RPM 이 가진력 표 범위 밖'
  };

  /**
   * frf: buildFrf 결과, cfg: {rpms:[..], orders:[{order,force}], force: forceSpec, interp}
   * 반환: {points:[{name, unit, rows:[{rpm, comps:[{order,f,frf,force,resp,status}], overall, used, partial}]}], warnings}
   */
  function computeResponse(frf, cfg) {
    var warnings = [], outCount = 0, fbCount = 0;
    var points = frf.points.map(function (p) {
      var rows = cfg.rpms.map(function (rpm) {
        var comps = cfg.orders.map(function (o) {
          var f = excitationFreq(o.order, rpm);
          var h = interpolate(frf.freq, p.mag, f, cfg.interp);
          if (h.note) fbCount++;
          var F = forceAt(cfg.force, o.order, rpm);
          var status = h.status !== 'ok' ? h.status : F.status;
          if (h.status === 'out_of_range') outCount++;
          var resp = status === 'ok' ? h.value * F.value : null;
          return { order: o.order, f: f, frf: h.value, force: F.value, resp: resp, status: status };
        });
        var o = rss(comps.map(function (c) { return c.resp; }));
        return { rpm: rpm, comps: comps, overall: o.value, used: o.count, partial: o.count < comps.length };
      });
      return { name: p.name, unit: p.unit, rows: rows };
    });
    if (outCount) warnings.push('가진 주파수가 FRF 해석 범위(' + frf.freq[0] + '~' + frf.freq[frf.freq.length - 1] + ' Hz)를 벗어난 칸이 ' + outCount + '개 있습니다. 그 차수는 overall 에서 빠지고 「일부 차수 제외」로 표시됩니다.');
    if (fbCount) warnings.push('로그 보간에서 0 이하 값이 끼어 선형 보간으로 대신한 칸이 ' + fbCount + '개 있습니다.');
    return { points: points, warnings: warnings };
  }

  // ── 가진력 추정 (계측 응답 ÷ |FRF|) ─────────────────────────────
  /**
   * 계측 표 읽기(가정 형식: 한 행 = RPM·차수 하나, 응답점마다 열 하나).
   * mapping: {rpmCol, orderCol, pointCols:{응답점이름: 열번호}}
   */
  /** 긴 형식의 차수 칸: 숫자면 그대로, 글자면 차수 표기 정규화(1차·1st·H1·1X …). overall·모르는 표기는 NaN */
  function cellOrder(v) {
    if (typeof v === 'number') return v;
    var r = parseOrderLabel(v);
    return r.ok && r.order !== 'overall' ? r.order : NaN;
  }
  function parseMeasured(rows, mapping) {
    var errs = [];
    if (mapping.rpmCol == null || mapping.rpmCol < 0) errs.push('계측 표의 RPM 열을 지정해 주십시오.');
    if (mapping.orderCol == null || mapping.orderCol < 0) errs.push('계측 표의 차수 열을 지정해 주십시오.');
    var names = Object.keys(mapping.pointCols || {}).filter(function (k) { return mapping.pointCols[k] >= 0; });
    if (!names.length) errs.push('FRF 응답점과 짝지을 계측 열을 하나 이상 지정해 주십시오.');
    if (errs.length) return { ok: false, errors: errs };
    var out = [], skipped = 0;
    rows.forEach(function (r) {
      var rpm = toNumber(r[mapping.rpmCol]), k = cellOrder(r[mapping.orderCol]);
      if (isNaN(rpm) || isNaN(k)) { skipped++; return; }
      var values = {};
      names.forEach(function (n) { var v = toNumber(r[mapping.pointCols[n]]); values[n] = isNaN(v) ? null : v; });
      out.push({ rpm: rpm, order: k, values: values });
    });
    if (!out.length) return { ok: false, errors: ['RPM·차수가 숫자인 계측 행이 없습니다.'] };
    return { ok: true, kind: 'order', points: names, orders: uniqSorted(out.map(function (r) { return r.order; })), rows: out, skipped: skipped };
  }

  /**
   * opts: {interp, antiRatio} — antiRatio: 그 응답점 최대 |FRF| 대비 이 비율보다 작으면 반공진 부근 경고
   * 종합값: 경고 없는 응답점들로 최소제곱 F = Σ|H|·m / Σ|H|² (가정 — 단일 가진점, 응답점마다 같은 가중)
   */
  function estimateForce(frf, measured, opts) {
    var byName = {};
    frf.points.forEach(function (p) { byName[p.name] = { p: p, max: maxMag(p.mag) }; });
    var ratio = toNumber(opts.antiRatio);
    if (isNaN(ratio) || ratio < 0) ratio = 0;
    var rows = measured.rows.map(function (m) {
      var f = excitationFreq(m.order, m.rpm);
      var pts = measured.points.map(function (name) {
        var ent = byName[name], meas = m.values[name];
        if (!ent) return { name: name, meas: meas, frf: null, force: null, anti: false, status: 'no_point' };
        if (meas == null) return { name: name, meas: null, frf: null, force: null, anti: false, status: 'no_meas' };
        var h = interpolate(frf.freq, ent.p.mag, f, opts.interp);
        if (h.status !== 'ok') return { name: name, meas: meas, frf: null, force: null, anti: false, status: h.status };
        if (!(h.value > 0)) return { name: name, meas: meas, frf: h.value, force: null, anti: true, status: 'zero_frf' };
        var anti = h.value < ratio * ent.max;
        return { name: name, meas: meas, frf: h.value, force: Math.abs(meas) / h.value, anti: anti, status: 'ok' };
      });
      var num = 0, den = 0, used = 0;
      pts.forEach(function (q) { if (q.status === 'ok' && !q.anti) { num += q.frf * Math.abs(q.meas); den += q.frf * q.frf; used++; } });
      return { rpm: m.rpm, order: m.order, f: f, points: pts, ls: used ? num / den : null, used: used };
    });
    return { rows: rows };
  }

  // 추정 결과를 「RPM별 가진력 표」로 바꿔 계산에 다시 쓸 수 있게 합니다
  function estimateToForceTable(est) {
    var rpms = [], orders = [], map = {};
    est.rows.forEach(function (r) {
      if (rpms.indexOf(r.rpm) < 0) rpms.push(r.rpm);
      if (orders.indexOf(r.order) < 0) orders.push(r.order);
      map[r.rpm + '|' + r.order] = r.ls;
    });
    rpms.sort(function (a, b) { return a - b; });
    orders.sort(function (a, b) { return a - b; });
    var table = { rpm: rpms, byOrder: {} };
    orders.forEach(function (k) { table.byOrder[k] = rpms.map(function (r) { var v = map[r + '|' + k]; return v == null ? null : v; }); });
    return { table: table, orders: orders };
  }

  // ── 가진력 scale factor · RPM 연동 벡터 (2026-09-29 수강생 요청 1) ────────
  /*
   * 차수별 scale factor s_k 와 기준 차수 r 이 있으면
   *   F_k(RPM) = (s_k / s_r) × F_r(RPM)
   * 로 기준 차수 하나만 입력해 나머지 차수를 계산합니다. s_r = 1 이면 F_k = s_k × F_r 입니다.
   */
  /**
   * scales: [{order, scale}] (화면 입력 그대로), orderNums: 검증된 차수 목록, ref: 기준 차수
   * 반환: {ok, ratio:{차수: s_k/s_r}, factors:{차수: s_k}, ref}
   */
  function scaleRatios(scales, orderNums, ref) {
    var errs = [], factors = {}, r = toNumber(ref);
    (scales || []).forEach(function (o) {
      var k = toNumber(o.order);
      if (isNaN(k) || orderNums.indexOf(k) < 0) return;
      var s = toNumber(o.scale);
      if (isNaN(s) || s <= 0) errs.push('차수 ' + k + '의 scale factor 를 0보다 큰 숫자로 입력해 주십시오.');
      else factors[k] = s;
    });
    if (isNaN(r)) errs.push('기준 차수를 골라 주십시오.');
    else if (orderNums.indexOf(r) < 0) errs.push('기준 차수 ' + r + '가 차수 목록에 없습니다.');
    orderNums.forEach(function (k) { if (factors[k] == null && !errs.some(function (e) { return e.indexOf('차수 ' + k + '의') === 0; })) errs.push('차수 ' + k + '의 scale factor 를 입력해 주십시오.'); });
    if (errs.length) return { ok: false, errors: errs };
    var ratio = {};
    orderNums.forEach(function (k) { ratio[k] = factors[k] / factors[r]; });
    return { ok: true, ratio: ratio, factors: factors, ref: r };
  }

  /** 차수별 상수 모드 + scale: 기준 차수 가진력 하나로 나머지를 채운 orders 반환 */
  function constForcesByScale(orderNums, ratio, refForce) {
    var F = toNumber(refForce);
    if (isNaN(F) || F < 0) return { ok: false, errors: ['기준 차수의 가진력을 0 이상의 숫자로 입력해 주십시오.'] };
    return { ok: true, orders: orderNums.map(function (k) { return { order: k, force: ratio[k] * F }; }) };
  }

  /**
   * 붙여넣은 글(엑셀에서 복사한 탭 구분, 또는 쉼표·공백 구분)을 행 배열로 나눕니다.
   * 숫자가 아닌 첫 줄(머리행)은 건너뜁니다.
   */
  function splitPasted(text) {
    var out = [];
    String(text || '').split(/\r?\n/).forEach(function (line) {
      if (!line.trim()) return;
      var cells = line.indexOf('\t') >= 0 ? line.split('\t') : line.trim().split(/\s*[,;]\s*|\s+/);
      out.push(cells.map(function (c) { return c.trim(); }));
    });
    while (out.length && isNaN(toNumber(out[0][0]))) out.shift();
    return out;
  }

  /**
   * RPM 연동 가진력 벡터 읽기. rows: [[RPM, 값1, 값2, …]] (문자열이어도 됨), keys: 값 열에 대응하는 차수 목록
   * 반환 table: {rpm:[오름차순], byOrder:{차수:[값…]}} — parseForceTable 과 같은 모양이라 forceAt 에 그대로 씁니다.
   */
  function parseForceVector(rows, keys) {
    var errs = [], recs = [], seen = {};
    (rows || []).forEach(function (r, i) {
      var cells = Array.isArray(r) ? r : [r.rpm].concat(keys.map(function (k) { return r.v ? r.v[k] : ''; }));
      var filled = cells.some(function (c) { return c !== '' && c != null; });
      if (!filled) return; // 빈 줄
      var rpm = toNumber(cells[0]);
      if (isNaN(rpm) || rpm < 0) { errs.push((i + 1) + '번째 줄: RPM 을 0 이상의 숫자로 입력해 주십시오.'); return; }
      if (seen[rpm]) { errs.push('RPM ' + rpm + '이 두 번 들어 있습니다.'); return; }
      seen[rpm] = true;
      var vals = keys.map(function (k, j) {
        var v = toNumber(cells[j + 1]);
        if (isNaN(v) || v < 0) { errs.push('RPM ' + rpm + ' · ' + k + '차: 가진력을 0 이상의 숫자로 입력해 주십시오.'); return null; }
        return v;
      });
      recs.push({ rpm: rpm, v: vals });
    });
    if (!recs.length && !errs.length) errs.push('RPM별 가진력을 한 줄 이상 입력해 주십시오.');
    if (errs.length) return { ok: false, errors: errs };
    recs.sort(function (a, b) { return a.rpm - b.rpm; });
    var table = { rpm: recs.map(function (r) { return r.rpm; }), byOrder: {} };
    keys.forEach(function (k, j) { table.byOrder[k] = recs.map(function (r) { return r.v[j]; }); });
    return { ok: true, table: table };
  }

  /** 기준 차수 열만 있는 표 → 모든 차수 열이 있는 표 (F_k = ratio_k × F_ref) */
  function expandTableByScale(table, orderNums, ratio, ref) {
    var base = table.byOrder[ref];
    if (!base) return { ok: false, errors: ['기준 차수 ' + ref + '의 가진력 열이 없습니다.'] };
    var out = { rpm: table.rpm.slice(), byOrder: {} };
    orderNums.forEach(function (k) { out.byOrder[k] = base.map(function (v) { return v == null ? null : ratio[k] * v; }); });
    return { ok: true, table: out };
  }

  // ── 최소제곱 (Householder QR) ────────────────────────────────────
  /**
   * min ‖A x − b‖₂ 를 QR 분해로 풉니다. 정규방정식(AᵀA)x = Aᵀb 보다 조건수가 제곱으로 커지지 않아 안정적입니다.
   * 반환: {ok, x, rank_ok} — R 대각 원소가 가장 큰 값의 1e-10 배 이하이면 계수가 정해지지 않는 것으로 봅니다.
   */
  function lstsq(A, b) {
    var m = A.length, n = m ? A[0].length : 0;
    if (!n) return { ok: false, reason: 'empty' };
    if (m < n) return { ok: false, reason: 'underdetermined' };
    var R = A.map(function (r) { return r.slice(); }), y = b.slice(), i, j, c;
    for (j = 0; j < n; j++) {
      var norm = 0;
      for (i = j; i < m; i++) norm += R[i][j] * R[i][j];
      norm = Math.sqrt(norm);
      if (norm === 0) continue;
      var alpha = R[j][j] > 0 ? -norm : norm;
      var v = [];
      for (i = j; i < m; i++) v.push(R[i][j]);
      v[0] -= alpha;
      var vn = 0;
      v.forEach(function (t) { vn += t * t; });
      if (vn === 0) continue;
      for (c = j; c < n; c++) {
        var s = 0;
        for (i = j; i < m; i++) s += v[i - j] * R[i][c];
        s = 2 * s / vn;
        for (i = j; i < m; i++) R[i][c] -= s * v[i - j];
      }
      var sy = 0;
      for (i = j; i < m; i++) sy += v[i - j] * y[i];
      sy = 2 * sy / vn;
      for (i = j; i < m; i++) y[i] -= sy * v[i - j];
    }
    var maxd = 0;
    for (j = 0; j < n; j++) maxd = Math.max(maxd, Math.abs(R[j][j]));
    for (j = 0; j < n; j++) if (!(Math.abs(R[j][j]) > 1e-10 * maxd)) return { ok: false, reason: 'rank' };
    var x = new Array(n);
    for (j = n - 1; j >= 0; j--) {
      var t = y[j];
      for (c = j + 1; c < n; c++) t -= R[j][c] * x[c];
      x[j] = t / R[j][j];
    }
    return { ok: true, x: x };
  }

  function polyEval(coef, x) {
    var v = 0;
    for (var j = coef.length - 1; j >= 0; j--) v = v * x + coef[j];
    return v;
  }

  // ── 가진력 추정 — 계산/계측 오차 최소화 (2026-09-29 수강생 요청 2) ─────────
  /*
   * 관측 하나 = (RPM, 차수 k, 응답점 p): 계측 m = |계측값|, 계산 = |H_p(k·RPM/60)| × F_k(RPM)
   * 크기 기준으로 맞춥니다. 이 도구의 FRF 표는 buildFrf 에서 이미 |H| 로 바뀌어 있고, 계측 표도
   * RPM·차수별 크기(order tracking 결과)라 위상이 없습니다. 가진점이 하나인 가정에서는 |H·F| = |H|·|F| 라
   * 크기만으로 모형이 정확합니다(기획서 11장).
   */
  function observations(frf, measured, opts) {
    var byName = {};
    frf.points.forEach(function (p) { byName[p.name] = { p: p, max: maxMag(p.mag) }; });
    var ratio = toNumber(opts.antiRatio);
    if (isNaN(ratio) || ratio < 0) ratio = 0;
    var obs = [];
    measured.rows.forEach(function (m) {
      var f = excitationFreq(m.order, m.rpm);
      measured.points.forEach(function (name) {
        var ent = byName[name], meas = m.values[name];
        var o = { rpm: m.rpm, order: m.order, point: name, f: f, h: null, meas: meas == null ? null : Math.abs(meas), anti: false, status: 'ok', use: false };
        if (!ent) o.status = 'no_point';
        else if (meas == null) o.status = 'no_meas';
        else {
          var h = interpolate(frf.freq, ent.p.mag, f, opts.interp);
          if (h.status !== 'ok') o.status = h.status;
          else if (!(h.value > 0)) { o.h = h.value; o.status = 'zero_frf'; }
          else { o.h = h.value; o.anti = h.value < ratio * ent.max; o.use = !o.anti; }
        }
        obs.push(o);
      });
    });
    return obs;
  }

  function uniqSorted(arr) {
    var out = [];
    arr.slice().sort(function (a, b) { return a - b; }).forEach(function (v) { if (!out.length || out[out.length - 1] !== v) out.push(v); });
    return out;
  }

  // ── 계측 표 형식 (2026-09-29 오후 수강생 요청 1) ─────────────────────
  /*
   * 계측 표를 「열 하나 = (응답점, 차수 또는 overall)」 배정표(colMap)로 읽습니다.
   *   차수별      : RPM, 1차, 2차, …                         (응답점 하나)
   *   overall     : RPM, overall                              (차수 구분 없음)
   *   여러 지점   : 차수 우선 RPM, 지점1_1차, 지점2_1차, …, 지점1_2차, …
   *                 지점 우선 RPM, 지점1_1차, 지점1_2차, …, 지점2_1차, …
   *   지점별 시트 : 시트마다 RPM, 1차, 2차, … (또는 RPM, overall)
   * 배정은 머리행 이름(응답점 이름 + 차수 표기·overall)으로 자동으로 하거나, 위치(차수 우선/지점 우선)로 합니다.
   * 머리행 규칙(2026-09-29 저녁 확정): 지점 이름은 파일에 있는 그대로, 차수는 1차·2차 … 기본에 1·2 …, 1st·2nd …, 1X, H1, order 1 도 인식.
   */
  /** 위치로 배정. layout 'order' = 차수 우선, 'point' = 지점 우선. orders 에 'overall' 하나를 주면 overall 표 */
  function measLayoutMap(startCol, points, orders, layout) {
    var P = points.length, K = orders.length, out = [];
    for (var j = 0; j < P * K; j++) {
      var pi = layout === 'point' ? Math.floor(j / K) : j % P;
      var ki = layout === 'point' ? j % K : Math.floor(j / P);
      out.push({ col: startCol + j, point: points[pi], order: orders[ki] });
    }
    return out;
  }
  // ── 차수 표기 정규화 (2026-09-29 저녁 수강생 답변) ─────────────────────
  /*
   * 「이름은 파일에 있는 그대로, 차수는 기본 1차·2차 … 이되 1, 2 … 또는 1st, 2nd … 등 알아볼 수 있는 형태면 인식」
   * 차수 표기 하나(머리행에서 지점 이름을 뗀 나머지)를 차수 숫자로 바꿉니다. 모르는 표기는 추측하지 않고 이유와 함께 돌려줍니다.
   *   1차 · 1 차 · 1차수 · 차수1 · 차수_1        → 'kr'
   *   1 · 0.5 (숫자만, 200 이하)                 → 'num'
   *   1st · 2nd · 3rd · 4th · 11th · 1st order    → 'ordinal' (접미사가 숫자와 맞아야 함: 2st·11st 는 거부)
   *   1X · 1x · 0.5X                              → 'x'
   *   H1 · h2                                     → 'h'
   *   order 1 · Order_2 · Ord1 · ord.3 · 2 order  → 'order'
   *   1ord · 2ORD · 1 ord · ord1 · ORD 2 · ord_3  → 'order' (2026-09-30 수강생 답변: 1ord·ord1 사용)
   *   1/rev · 2 / rev · 1 per rev                 → 거부 (2026-09-30: 1/rev 는 쓰지 않음 — 추측하지 않음)
   *   overall · OA · O.A. · 전체 · 합성           → overall
   * 전각 숫자·문자(１차, ２ｎｄ)는 NFKC 로 반각으로, 대소문자·앞뒤·연속 공백은 무시합니다.
   * 끝에 붙은 괄호 단위(「1차 (m/s²)」·「2X [dB]」)는 떼고 읽습니다.
   */
  var ORDER_FORMS = { kr: 'n차', num: '숫자', ordinal: '서수(1st·2nd…)', x: 'nX', h: 'Hn', order: 'order n · 1ord · ord1', overall: 'overall' };
  var BARE_MAX = 200; // 숫자만 있는 머리행은 이보다 크면 차수로 보지 않음(연도·일련번호 오인 방지)
  function normLabel(t) {
    var s = String(t == null ? '' : t);
    if (s.normalize) s = s.normalize('NFKC');
    s = s.replace(/[ 　\s]+/g, ' ').trim().toLowerCase();
    var u;
    while ((u = s.replace(/\s*(\([^()]*\)|\[[^\[\]]*\]|\{[^{}]*\})\s*$/, '')) !== s && u) s = u.trim();
    var w = s.match(/^[(\[{]\s*(.*?)\s*[)\]}]$/); // 통째로 괄호: (1차)
    return w ? w[1] : s;
  }
  var GENERIC = '차수 표기를 알아보지 못했습니다';
  // 「1/rev」(회전당 n회) 표기는 쓰지 않는다고 확인됨(2026-09-30 수강생 답변) — 차수로 읽지 않고 이유를 알림.
  // 머리행에서는 「/」가 구분자라 따로 막지 않으면 「1/rev」가 「1」(차수) + 「rev」(지점)로 잘못 갈라집니다.
  var RE_PER_REV = /^\d+(?:\.\d+)?\s*(?:\/|per)\s*rev(?:olutions?|s)?\.?$/;
  var RE_PER_REV_IN = /\d\s*(?:\/|per)\s*rev(?:olutions?|s)?(?![a-z])/; // 「R」(오른쪽 채널)처럼 rev 가 아닌 것은 막지 않음
  var REV_REASON = '「n/rev」 표기는 쓰지 않는 것으로 확인했습니다(2026-09-30) — 1ord · ord1 · 1차 처럼 적거나 표에서 차수를 직접 골라 주십시오';
  function ordinalSuffix(n) { var t = n % 100; if (t >= 11 && t <= 13) return 'th'; return { 1: 'st', 2: 'nd', 3: 'rd' }[n % 10] || 'th'; }
  /** 반환 {ok:true, order:숫자|'overall', form} | {ok:false, reason} */
  function parseOrderLabel(t) {
    var s = normLabel(t), m;
    if (!s) return { ok: false, reason: '빈 칸' };
    if (/^(overall|o\.?\s?a\.?|전체|합성)$/.test(s)) return { ok: true, order: 'overall', form: 'overall' };
    function num(v, form) {
      var k = +v;
      if (!(k > 0) || !isFinite(k)) return { ok: false, reason: '차수는 0보다 커야 합니다' };
      return { ok: true, order: k, form: form };
    }
    if ((m = s.match(/^(\d+(?:\.\d+)?)\s*차(?:수)?$/)) || (m = s.match(/^차수\s*[_\-#:]?\s*(\d+(?:\.\d+)?)$/))) return num(m[1], 'kr');
    if ((m = s.match(/^(\d+)\s*(st|nd|rd|th)(?:[\s_\-]*(?:order|ord\.?|차))?$/))) {
      if (ordinalSuffix(+m[1]) !== m[2]) return { ok: false, reason: '서수 접미사가 맞지 않습니다(' + m[1] + ordinalSuffix(+m[1]) + ' 이어야 함)' };
      return num(m[1], 'ordinal');
    }
    if (RE_PER_REV.test(s)) return { ok: false, reason: REV_REASON };
    if ((m = s.match(/^(\d+(?:\.\d+)?)\s*x$/))) return num(m[1], 'x');
    if ((m = s.match(/^h\s*[_\-]?\s*(\d+)$/))) return num(m[1], 'h');
    if ((m = s.match(/^(?:order|ord)\.?\s*[_\-#:]?\s*(\d+(?:\.\d+)?)$/)) || (m = s.match(/^(\d+(?:\.\d+)?)\s*[_\-]?\s*(?:order|ord)\.?$/))) return num(m[1], 'order');
    if ((m = s.match(/^\d+(?:\.\d+)?$/))) {
      if (+s > BARE_MAX) return { ok: false, reason: '숫자만 있는 머리행은 ' + BARE_MAX + ' 이하만 차수로 봅니다' };
      return num(s, 'num');
    }
    return { ok: false, reason: GENERIC };
  }
  var SEP = '\\s_\\-/|:·＿－／'; // 지점 이름과 차수 사이 구분자. 소수점 「.」은 넣지 않음(0.5차)
  var RE_SEP = new RegExp('[' + SEP + ']'), RE_EDGE = new RegExp('^[' + SEP + ']+|[' + SEP + ']+$', 'g');
  /**
   * 머리행 하나 → {pointText(파일 그대로), label, order, form} | {ok:false, reason}
   * 지점 이름은 고치지 않고 앞뒤 구분자만 뗍니다. points(FRF 응답점 이름)가 머리행 앞(또는 뒤)에 그대로 있으면 먼저 그 이름으로 가릅니다.
   * 그 밖에는 구분자에서 잘라 「가장 긴 뒷부분」이 차수 표기가 되는 곳을 찾고(지점_1st order), 안 되면 앞부분(1차_지점)을 봅니다.
   */
  function splitMeasHeader(h, points) {
    var t = String(h == null ? '' : h).trim();
    if (!t) return { ok: false, pointText: '', reason: '빈 칸' };
    if (RE_PER_REV_IN.test(normLabel(t))) return { ok: false, pointText: t, reason: REV_REASON }; // 「지점_1/rev」·「1/rev_지점」
    var whole = t.replace(RE_EDGE, ''), r = parseOrderLabel(whole);
    if (r.ok) return { ok: true, pointText: '', label: whole, order: r.order, form: r.form };
    var byLen = (points || []).filter(Boolean).slice().sort(function (a, b) { return b.length - a.length; });
    for (var i = 0; i < byLen.length; i++) {
      var p = byLen[i], rest = null;
      if (t.indexOf(p) === 0) rest = t.slice(p.length);
      else if (t.length > p.length && t.lastIndexOf(p) === t.length - p.length) rest = t.slice(0, t.length - p.length);
      if (rest == null) continue;
      rest = rest.replace(RE_EDGE, '');
      r = parseOrderLabel(rest);
      if (r.ok) return { ok: true, pointText: p, label: rest, order: r.order, form: r.form };
    }
    var cut = [], why = null;
    for (var c = 0; c < t.length; c++) if (RE_SEP.test(t[c])) cut.push(c);
    for (var a = 0; a < cut.length; a++) { // 뒤가 차수: 가장 긴 뒷부분부터
      var tail = t.slice(cut[a] + 1).replace(RE_EDGE, ''), head = t.slice(0, cut[a]).replace(RE_EDGE, '');
      if (!tail || !head) continue;
      r = parseOrderLabel(tail);
      if (r.ok) return { ok: true, pointText: head, label: tail, order: r.order, form: r.form };
      if (r.reason !== GENERIC) why = r.reason; // 「2st」처럼 차수 비슷하지만 틀린 표기는 그 이유를 알림
    }
    for (var b = cut.length - 1; b >= 0; b--) { // 앞이 차수: 가장 긴 앞부분부터
      var head2 = t.slice(0, cut[b]).replace(RE_EDGE, ''), tail2 = t.slice(cut[b] + 1).replace(RE_EDGE, '');
      if (!tail2 || !head2) continue;
      r = parseOrderLabel(head2);
      if (r.ok) return { ok: true, pointText: tail2, label: head2, order: r.order, form: r.form };
    }
    return { ok: false, pointText: t, reason: why || parseOrderLabel(whole).reason };
  }
  /** 머리행에서 차수 숫자만(예전 이름 유지). overall 이나 모르는 표기는 null */
  function headerOrder(t) {
    var r = splitMeasHeader(t, []);
    return r.ok && r.order !== 'overall' ? r.order : null;
  }
  function orderText(k) { return k === 'overall' ? 'overall' : k + '차'; }
  /**
   * 가로 형식 머리행 전체를 읽어 열마다 인식 결과를 돌려줍니다(화면 「열 배정 확인」 표의 재료).
   * opts: {rpmCol, points: FRF 응답점 이름, defaultPoint: 지점 이름 없는 열의 응답점, fixedPoint: 모든 열을 이 응답점으로(지점별 시트),
   *        alias: {파일의 지점 이름: FRF 응답점}, kind: 'order'|'overall', orders: 쓸 차수 목록(없으면 전부),
   *        overrides: {열번호: {order: ''|'skip'|'overall'|숫자, point: ''|FRF 응답점}}}
   * 반환 [{col, header, pointText, label, form, order(최종), auto(머리행에서 읽은 차수), point, status, reason, overridden}]
   *   status: ok(씀) · order(차수 표기 모름) · point(응답점 짝 없음) · filtered(값 종류·차수 목록 밖) · skip(사용자가 뺌)
   */
  function analyzeMeasHeaders(headers, opts) {
    opts = opts || {};
    var points = opts.points || [], alias = opts.alias || {}, ov = opts.overrides || {}, out = [];
    (headers || []).forEach(function (h, c) {
      if (c === opts.rpmCol) return;
      var raw = String(h == null ? '' : h).trim();
      if (!raw) return;
      var s = splitMeasHeader(raw, points), e = { col: c, header: raw, pointText: s.ok ? s.pointText : '', label: s.label || '', form: s.form || '', order: s.ok ? s.order : null, auto: s.ok ? s.order : null, point: null, status: 'ok', reason: '', overridden: false };
      if (opts.fixedPoint) e.point = opts.fixedPoint;
      else if (!e.pointText) e.point = opts.defaultPoint || null;
      else if (alias[e.pointText]) e.point = alias[e.pointText];
      else if (points.indexOf(e.pointText) >= 0) e.point = e.pointText;
      var o = ov[c] || ov[String(c)];
      if (o && o.point) { e.point = o.point; e.overridden = true; }
      if (o && o.order === 'skip') { e.status = 'skip'; e.overridden = true; out.push(e); return; }
      if (o && o.order !== '' && o.order != null) {
        var k = o.order === 'overall' ? 'overall' : toNumber(o.order);
        if (k === 'overall' || k > 0) { e.order = k; e.overridden = true; }
      }
      if (e.order == null) { e.status = 'order'; e.reason = s.reason || '차수 표기를 알아보지 못했습니다'; }
      else if (!e.point) { e.status = 'point'; e.reason = e.pointText ? '「' + e.pointText + '」와 이름이 같은 FRF 응답점이 없습니다' : '응답점을 골라 주십시오'; }
      else if (opts.kind === 'overall' && e.order !== 'overall') { e.status = 'filtered'; e.reason = '값 종류가 overall 이라 차수 열은 쓰지 않음'; }
      else if (opts.kind === 'order' && e.order === 'overall') { e.status = 'filtered'; e.reason = '값 종류가 차수별이라 overall 열은 쓰지 않음'; }
      else if (opts.orders && e.order !== 'overall' && opts.orders.indexOf(e.order) < 0) { e.status = 'filtered'; e.reason = '차수 목록에 없음'; }
      out.push(e);
    });
    return out;
  }
  /** 머리행 이름으로 배정(인식된 열만). 응답점이 하나면 지점 이름이 없는 열도 그 응답점으로 봅니다 */
  function measMapByHeader(headers, points, rpmCol, opts) {
    var o = Object.assign({}, opts || {});
    o.rpmCol = rpmCol; o.points = points;
    if (o.defaultPoint === undefined && points.length === 1) o.defaultPoint = points[0];
    return analyzeMeasHeaders(headers, o).filter(function (e) { return e.status === 'ok'; }).map(function (e) { return { col: e.col, point: e.point, order: e.order }; });
  }
  /**
   * parts: [{rows(머리행 아래), rpmCol, colMap:[{col, point, order}]}] — 지점별 시트는 시트마다 part 하나
   * 반환: {ok, kind:'order'|'overall', points, orders, rows:[{rpm, order, values:{응답점: 값}}], skipped}
   *   kind 'order' 의 반환은 parseMeasured 와 같은 모양이라 기존 추정에 그대로 씁니다.
   */
  function parseMeasTable(parts) {
    var errs = [], cols = [];
    parts.forEach(function (p) { cols = cols.concat(p.colMap || []); });
    if (!cols.length) return { ok: false, errors: ['계측 값 열을 하나도 배정하지 못했습니다. 응답점·차수·열 배치를 확인해 주십시오.'] };
    var kinds = {};
    cols.forEach(function (c) { kinds[c.order === 'overall' ? 'overall' : 'order'] = true; });
    if (kinds.overall && kinds.order) return { ok: false, errors: ['overall 열과 차수별 열이 섞여 있습니다. 한 가지 형식만 골라 주십시오.'] };
    var seen = {};
    cols.forEach(function (c) {
      var key = c.point + '|' + c.order;
      if (seen[key]) errs.push('「' + c.point + '」 ' + (c.order === 'overall' ? 'overall' : c.order + '차') + ' 열이 두 번 배정됐습니다.');
      seen[key] = true;
      if (c.order !== 'overall' && !(toNumber(c.order) > 0)) errs.push('차수는 0보다 큰 숫자여야 합니다: ' + c.order);
    });
    parts.forEach(function (p) { if (p.rpmCol == null || p.rpmCol < 0) errs.push('계측 표의 RPM 열을 지정해 주십시오.'); });
    if (errs.length) return { ok: false, errors: errs };
    var recs = {}, skipped = 0, points = [];
    cols.forEach(function (c) { if (points.indexOf(c.point) < 0) points.push(c.point); });
    parts.forEach(function (p) {
      p.rows.forEach(function (r) {
        var rpm = toNumber(r[p.rpmCol]);
        if (isNaN(rpm)) { if (r.some(function (v) { return v !== '' && v != null; })) skipped++; return; }
        p.colMap.forEach(function (c) {
          var v = toNumber(r[c.col]);
          if (isNaN(v)) return;
          var k = c.order === 'overall' ? 'overall' : toNumber(c.order), key = rpm + '|' + k;
          if (!recs[key]) recs[key] = { rpm: rpm, order: k, values: {} };
          recs[key].values[c.point] = v;
        });
      });
    });
    var rows = Object.keys(recs).map(function (k) { return recs[k]; });
    if (!rows.length) return { ok: false, errors: ['RPM 과 계측값이 숫자인 행이 없습니다.'] };
    rows.forEach(function (r) { points.forEach(function (n) { if (r.values[n] == null) r.values[n] = null; }); });
    rows.sort(function (a, b) { return a.rpm - b.rpm || (a.order === 'overall' ? 0 : a.order - b.order); });
    var kind = kinds.overall ? 'overall' : 'order';
    return { ok: true, kind: kind, points: points, orders: kind === 'order' ? uniqSorted(rows.map(function (r) { return r.order; })) : [], rows: rows, skipped: skipped };
  }

  /**
   * overall 관측 — (RPM, 응답점) 하나: M = 계측 overall, 계산 = √(Σ_k (|H_p(k·RPM/60)| × F_k)²)
   * 차수별 계측이면 M = √(Σ_k m_k²) 로 만들어 씁니다(모든 차수 값이 있을 때만).
   * 반공진 기준은 쓰지 않습니다 — overall 은 |FRF| 로 나누지 않아 작은 |FRF| 에서 튀지 않습니다.
   */
  function overallObservations(frf, measured, orders, opts) {
    var byName = {};
    frf.points.forEach(function (p) { byName[p.name] = p; });
    var src = [];
    if (measured.kind === 'overall') src = measured.rows.map(function (r) { return { rpm: r.rpm, values: r.values }; });
    else {
      var g = {}, keys = [];
      measured.rows.forEach(function (r) {
        if (!g[r.rpm]) { g[r.rpm] = { rpm: r.rpm, by: {} }; keys.push(r.rpm); }
        g[r.rpm].by[r.order] = r.values;
      });
      keys.forEach(function (rpm) {
        var values = {};
        measured.points.forEach(function (n) {
          var s = 0, ok = true;
          orders.forEach(function (k) { var v = g[rpm].by[k] && g[rpm].by[k][n]; if (v == null) ok = false; else s += v * v; });
          values[n] = ok ? Math.sqrt(s) : null;
        });
        src.push({ rpm: rpm, values: values });
      });
    }
    var obs = [];
    src.forEach(function (r) {
      measured.points.forEach(function (name) {
        var p = byName[name], meas = r.values[name];
        var o = { rpm: r.rpm, order: 'overall', point: name, f: null, hs: {}, h: null, meas: meas == null ? null : Math.abs(meas), anti: false, status: 'ok', use: false };
        if (!p) o.status = 'no_point';
        else if (meas == null) o.status = 'no_meas';
        else {
          orders.forEach(function (k) {
            var h = interpolate(frf.freq, p.mag, excitationFreq(k, r.rpm), opts.interp);
            if (h.status !== 'ok') o.status = h.status; else o.hs[k] = h.value;
          });
          o.use = o.status === 'ok';
        }
        obs.push(o);
      });
    });
    return obs;
  }

  // ── 오차 기준: 평균(최소제곱) / 최대(minimax) ─────────────────────
  var LAWSON_ITERS = 400;
  /**
   * min max_i |A_i·x − b_i| (Chebyshev·minimax) 를 Lawson 반복 재가중 최소제곱으로 풉니다.
   *   w ← w_i·|r_i| / Σ w_j·|r_j| 로 가중을 옮기면 가중 최소제곱 해가 minimax 해로 모입니다.
   * 반복 중 최대 오차가 가장 작았던 해를 돌려줍니다.
   */
  function lawson(A, b) {
    var m = A.length, w = [], i, best = null, bestMax = Infinity, scale = 0;
    for (i = 0; i < m; i++) { w.push(1 / m); scale = Math.max(scale, Math.abs(b[i])); }
    if (!(scale > 0)) scale = 1;
    for (var it = 0; it < LAWSON_ITERS; it++) {
      var sw = w.map(Math.sqrt);
      var s = lstsq(A.map(function (r, k) { return r.map(function (v) { return v * sw[k]; }); }), b.map(function (v, k) { return v * sw[k]; }));
      if (!s.ok) break;
      var r = A.map(function (row, k) { var t = -b[k]; row.forEach(function (v, j) { t += v * s.x[j]; }); return Math.abs(t); });
      var mx = Math.max.apply(null, r);
      if (mx < bestMax) { bestMax = mx; best = s.x; }
      if (mx <= 1e-13 * scale) break;
      var tot = 0;
      for (i = 0; i < m; i++) tot += w[i] * r[i];
      if (!(tot > 0)) break;
      for (i = 0; i < m; i++) w[i] = w[i] * r[i] / tot;
    }
    return best ? { ok: true, x: best, maxErr: bestMax } : { ok: false, reason: 'rank' };
  }
  /** crit 'mean' = 평균 제곱오차 최소(최소제곱), 'max' = 최대 절대오차 최소(minimax) */
  function solveLinear(A, b, crit) {
    var ls = lstsq(A, b);
    if (!ls.ok || crit !== 'max') return ls;
    return lawson(A, b);
  }
  // 상대오차(계측 대비 비율)로 맞출 때 행 가중: 1/계측
  function rowWeight(o, errScale) { return errScale === 'rel' ? (o.meas > 0 ? 1 / o.meas : 0) : 1; }

  /**
   * 비선형 최소제곱 (Levenberg–Marquardt). fun(β) → {r:[잔차], J:[[∂r/∂β]]}
   * 한 걸음 = [J; √λ·D] δ = [−r; 0] 을 QR 로 풀기 (D = J 열 크기).
   */
  function levenberg(fun, beta0, iters) {
    var beta = beta0.slice(), f = fun(beta), cost = ss(f.r), lambda = 1e-3, n = beta.length;
    function ss(r) { var s = 0; r.forEach(function (v) { s += v * v; }); return s; }
    for (var it = 0; it < (iters || 300) && cost > 0; it++) {
      var D = [];
      for (var j = 0; j < n; j++) { var d = 0; f.J.forEach(function (row) { d += row[j] * row[j]; }); D.push(Math.sqrt(Math.max(d, 1e-300))); }
      var A = f.J.concat(D.map(function (d, j) { var row = []; for (var c = 0; c < n; c++) row.push(c === j ? Math.sqrt(lambda) * d : 0); return row; }));
      var b = f.r.map(function (v) { return -v; }).concat(D.map(function () { return 0; }));
      var s = lstsq(A, b);
      if (!s.ok) { lambda *= 10; if (lambda > 1e15) break; continue; }
      var nb = beta.map(function (v, j) { return v + s.x[j]; }), nf = fun(nb), nc = ss(nf.r);
      if (nc < cost) {
        var rel = (cost - nc) / cost;
        beta = nb; f = nf; cost = nc; lambda = Math.max(lambda / 3, 1e-15);
        if (rel < 1e-15) break;
      } else { lambda *= 4; if (lambda > 1e15) break; }
    }
    return { beta: beta, cost: cost };
  }

  /**
   * overall 오차 최소화 + 다항식 — 차수마다 P_k(x) = Σ_j β_kj·xʲ (x = RPM/RPM_max)
   *   계산 overall_i = √(Σ_k (h_ik·P_k(x_i))²), 잔차 = w_i·(계산_i − M_i)
   * 계수에 대해 비선형이라 Levenberg–Marquardt 로 풉니다. 최대(minimax) 기준은 Lawson 재가중을 바깥에 두릅니다.
   */
  function fitOverallPoly(use, orders, n, xs, crit, errScale) {
    var K = orders.length, NP = K * (n + 1);
    var base = use.map(function (o) { return rowWeight(o, errScale); });
    function build(beta, w) {
      var r = [], J = [];
      use.forEach(function (o, i) {
        var x = o.rpm / xs, pk = [], S = 0;
        orders.forEach(function (k, ki) { var v = 0, p = 1; for (var j = 0; j <= n; j++) { v += beta[ki * (n + 1) + j] * p; p *= x; } pk.push(v); S += Math.pow(o.hs[k] * v, 2); });
        var c = Math.sqrt(S), sw = w[i], row = [];
        r.push(sw * (c - o.meas));
        orders.forEach(function (k, ki) { var p = 1, g = c > 0 ? o.hs[k] * o.hs[k] * pk[ki] / c : 0; for (var j = 0; j <= n; j++) { row.push(sw * g * p); p *= x; } });
        J.push(row);
      });
      return { r: r, J: J };
    }
    // 시작값: 모든 차수가 같은 상수 가진력 c0 라고 보고 c0 = Σ g·M / Σ g², g = √(Σ_k h_k²)
    var num = 0, den = 0;
    use.forEach(function (o, i) { var g = 0; orders.forEach(function (k) { g += o.hs[k] * o.hs[k]; }); g = Math.sqrt(g) * base[i]; num += g * o.meas * base[i]; den += g * g; });
    var beta = [];
    for (var q = 0; q < NP; q++) beta.push(q % (n + 1) === 0 && den > 0 ? num / den : 0);
    var fit = levenberg(function (bb) { return build(bb, base); }, beta, 500);
    beta = fit.beta;
    if (crit === 'max') {
      var w = base.map(function () { return 1 / use.length; }), best = beta, bestMax = Infinity;
      for (var it = 0; it < 150; it++) {
        var sw = w.map(function (v, i) { return Math.sqrt(v) * base[i]; });
        beta = levenberg(function (bb) { return build(bb, sw); }, beta, 60).beta;
        var e = build(beta, base).r.map(Math.abs), mx = Math.max.apply(null, e);
        if (mx < bestMax) { bestMax = mx; best = beta.slice(); }
        var tot = 0; e.forEach(function (v, i) { tot += w[i] * v; });
        if (!(tot > 0) || mx < 1e-13) break;
        w = w.map(function (v, i) { return v * e[i] / tot; });
      }
      beta = best;
    }
    return beta;
  }

  function statKey(o) { return o.order === 'overall' ? 'overall' : o.order + '차'; }
  function finishFit(est, obs) {
    est.obs = obs;
    est.stats = fitStats(obs, statKey);
    est.statsByPoint = fitStats(obs, function (o) { return o.point; });
    return est;
  }
  function checkObjective(measured, opts) {
    if ((opts.objective || 'order') === 'order' && measured.kind === 'overall') return ['계측 표가 overall 값뿐이라 차수별 오차로는 맞출 수 없습니다. 비교 대상을 「overall 오차」로 골라 주십시오.'];
    if (opts.objective === 'overall' && measured.kind === 'overall' && !(opts.orders && opts.orders.length)) return ['overall 로 맞추려면 합성할 차수 목록이 필요합니다. 2. 계산 조건에 차수를 넣어 주십시오.'];
    return null;
  }

  /**
   * (a) scale factor 고정 — 기준 차수의 RPM별 크기 F_r(RPM) 를 RPM 점마다 구합니다.
   *   차수별 오차 : a = |H_p(k·RPM/60)| × s_k/s_r,       계측 m ≈ a·F_r
   *   overall 오차: g = √(Σ_k (|H_p(k·RPM/60)| × s_k/s_r)²), 계측 M ≈ g·F_r   (F_r 에 대해 선형)
   *   평균 기준 → F_r = Σ a·m / Σ a²,  최대 기준 → minimax(Lawson)
   * opts: {interp, antiRatio, ratio:{차수: s_k/s_r}, ref, objective:'order'|'overall', crit:'mean'|'max', errScale:'abs'|'rel', orders}
   */
  function estimateScaleFixed(frf, measured, opts) {
    var ce = checkObjective(measured, opts);
    if (ce) return { ok: false, errors: ce };
    var overall = opts.objective === 'overall', errs = [];
    var orders = overall ? (measured.kind === 'order' ? measured.orders : uniqSorted(opts.orders.map(Number))) : null;
    var obs = overall ? overallObservations(frf, measured, orders, opts) : observations(frf, measured, opts);
    if (!overall) orders = uniqSorted(obs.map(function (o) { return o.order; }));
    orders.forEach(function (k) {
      if (opts.ratio[k] == null) errs.push((overall && measured.kind === 'overall' ? '합성할 ' : '계측 표의 ') + k + '차에 scale factor 가 없습니다. 2. 계산 조건의 차수 목록에 ' + k + '차와 scale factor 를 넣어 주십시오.');
    });
    if (errs.length) return { ok: false, errors: errs };
    function coefOf(o) {
      if (!overall) return o.h * opts.ratio[o.order];
      var s = 0; orders.forEach(function (k) { s += Math.pow(o.hs[k] * opts.ratio[k], 2); }); return Math.sqrt(s);
    }
    var rpms = uniqSorted(obs.map(function (o) { return o.rpm; }));
    var refForce = [], used = [];
    rpms.forEach(function (r) {
      var use = obs.filter(function (o) { return o.use && o.rpm === r; });
      var A = [], b = [];
      use.forEach(function (o) { var w = rowWeight(o, opts.errScale); if (w > 0) { A.push([coefOf(o) * w]); b.push(o.meas * w); } });
      var s = A.length ? solveLinear(A, b, opts.crit) : { ok: false };
      refForce.push(s.ok ? s.x[0] : null); used.push(A.length);
    });
    var fidx = {};
    rpms.forEach(function (r, i) { fidx[r] = refForce[i]; });
    obs.forEach(function (o) {
      var F = fidx[o.rpm];
      o.force = F == null || overall ? null : opts.ratio[o.order] * F;
      o.calc = F == null || (overall ? o.status !== 'ok' : o.h == null) ? null : coefOf(o) * F;
    });
    var table = { rpm: rpms.slice(), byOrder: {} };
    orders.forEach(function (k) { table.byOrder[k] = refForce.map(function (F) { return F == null ? null : opts.ratio[k] * F; }); });
    return finishFit({
      ok: true, mode: 'scale', objective: overall ? 'overall' : 'order', crit: opts.crit === 'max' ? 'max' : 'mean', errScale: opts.errScale === 'rel' ? 'rel' : 'abs',
      ref: opts.ref, ratio: opts.ratio, rpms: rpms, refForce: refForce, used: used, orders: orders, table: table
    }, obs);
  }

  /**
   * (b) scale factor 미고정 — 차수마다 F_k(RPM) = c_0 + c_1·RPM + … + c_n·RPMⁿ.
   *   차수별 오차 : 계측 m ≈ |H_p| × Σ_j c_j·RPMʲ → 선형, 차수마다 따로 (평균 = QR 최소제곱, 최대 = Lawson)
   *   overall 오차: 계측 M ≈ √(Σ_k (|H_pk| × F_k)²) → 모든 차수 계수를 함께 Levenberg–Marquardt 로
   * 조건수를 줄이려고 x = RPM / RPM_max 로 풀고 c_j = β_j / RPM_maxʲ 로 되돌립니다.
   * opts: {interp, antiRatio, degree, objective, crit, errScale, orders}
   */
  function estimatePoly(frf, measured, opts) {
    var n = Math.round(toNumber(opts.degree));
    if (isNaN(n) || n < 0 || n > 5) return { ok: false, errors: ['다항식 차수는 0~5 사이 정수로 입력해 주십시오.'] };
    var ce = checkObjective(measured, opts);
    if (ce) return { ok: false, errors: ce };
    var overall = opts.objective === 'overall', errs = [], fits = [];
    var orders = overall ? (measured.kind === 'order' ? measured.orders : uniqSorted(opts.orders.map(Number))) : null;
    var obs = overall ? overallObservations(frf, measured, orders, opts) : observations(frf, measured, opts);
    if (!overall) orders = uniqSorted(obs.map(function (o) { return o.order; }));
    var xs = 0;
    obs.forEach(function (o) { if (o.use) xs = Math.max(xs, Math.abs(o.rpm)); });
    if (!(xs > 0)) xs = 1;
    if (overall) {
      var use = obs.filter(function (o) { return o.use && rowWeight(o, opts.errScale) > 0; });
      var need = orders.length * (n + 1), distinct = uniqSorted(use.map(function (o) { return o.rpm; })).length;
      if (use.length < need || distinct < n + 1) return { ok: false, errors: ['overall 관측이 ' + use.length + '개(RPM ' + distinct + '점)라 차수 ' + orders.length + '개 × 계수 ' + (n + 1) + '개 = ' + need + '개를 정할 수 없습니다. 다항식 차수를 낮추거나 계측을 늘려 주십시오.'] };
      var beta = fitOverallPoly(use, orders, n, xs, opts.crit, opts.errScale);
      orders.forEach(function (k, ki) {
        var coef = beta.slice(ki * (n + 1), (ki + 1) * (n + 1)).map(function (b, j) { return b / Math.pow(xs, j); });
        // overall 은 F_k 의 부호를 구분하지 못합니다(F² 만 들어감) — 계측 RPM 가운데서 양수가 되게 맞춥니다
        if (polyEval(coef, (use[0].rpm + use[use.length - 1].rpm) / 2) < 0) coef = coef.map(function (c) { return -c; });
        fits.push({ order: k, coef: coef, n: use.length, rpms: distinct });
      });
    } else {
      orders.forEach(function (k) {
        var use = obs.filter(function (o) { return o.order === k && o.use && rowWeight(o, opts.errScale) > 0; });
        var distinct = uniqSorted(use.map(function (o) { return o.rpm; })).length;
        if (distinct < n + 1) { errs.push(k + '차: 쓸 수 있는 RPM 점이 ' + distinct + '개라 ' + n + '차 다항식(계수 ' + (n + 1) + '개)을 정할 수 없습니다. 다항식 차수를 낮추거나 계측 RPM 을 늘려 주십시오.'); return; }
        var A = use.map(function (o) { var x = o.rpm / xs, w = rowWeight(o, opts.errScale), row = [], p = 1; for (var j = 0; j <= n; j++) { row.push(o.h * p * w); p *= x; } return row; });
        var sol = solveLinear(A, use.map(function (o) { return o.meas * rowWeight(o, opts.errScale); }), opts.crit);
        if (!sol.ok) { errs.push(k + '차: 계수가 하나로 정해지지 않습니다(관측이 부족하거나 한쪽에 몰림). 다항식 차수를 낮춰 주십시오.'); return; }
        fits.push({ order: k, coef: sol.x.map(function (b, j) { return b / Math.pow(xs, j); }), n: use.length, rpms: distinct });
      });
    }
    if (errs.length) return { ok: false, errors: errs };
    var byOrder = {};
    fits.forEach(function (ft) { byOrder[ft.order] = ft; });
    obs.forEach(function (o) {
      if (overall) {
        o.force = null;
        if (o.status !== 'ok') { o.calc = null; return; }
        var s = 0; orders.forEach(function (k) { s += Math.pow(o.hs[k] * polyEval(byOrder[k].coef, o.rpm), 2); });
        o.calc = Math.sqrt(s);
      } else {
        o.force = polyEval(byOrder[o.order].coef, o.rpm);
        o.calc = o.h != null ? o.h * o.force : null;
      }
    });
    var rpms = uniqSorted(obs.map(function (o) { return o.rpm; }));
    var table = { rpm: rpms.slice(), byOrder: {} };
    orders.forEach(function (k) { table.byOrder[k] = rpms.map(function (r) { return polyEval(byOrder[k].coef, r); }); });
    return finishFit({
      ok: true, mode: 'poly', objective: overall ? 'overall' : 'order', crit: opts.crit === 'max' ? 'max' : 'mean', errScale: opts.errScale === 'rel' ? 'rel' : 'abs',
      degree: n, fits: fits, rpms: rpms, orders: orders, table: table
    }, obs);
  }

  /**
   * 잔차 통계. obs 에 calc 가 채워져 있어야 합니다. 맞춤에 쓴 관측(use)만 셉니다.
   *   RMS      = √( Σ (계산 − 계측)² / n )                  (응답 단위) — 평균 기준이 줄이는 값
   *   최대     = max |계산 − 계측|                           (응답 단위) — 최대 기준이 줄이는 값
   *   dB 오차  = 20·log10(계산 / 계측)   → RMS dB = √(Σ dB² / n), 최대 |dB|
   */
  function fitStats(obs, keyFn) {
    var groups = {}, order = [];
    function acc(key) {
      if (!groups[key]) { groups[key] = { key: key, n: 0, se: 0, maxAbs: 0, nDb: 0, sdb: 0, maxDb: 0 }; order.push(key); }
      return groups[key];
    }
    obs.forEach(function (o) {
      if (!o.use || o.calc == null) return;
      [acc('전체'), keyFn ? acc(keyFn(o)) : null].forEach(function (g) {
        if (!g) return;
        var e = o.calc - o.meas;
        g.n++; g.se += e * e; if (Math.abs(e) > g.maxAbs) g.maxAbs = Math.abs(e);
        if (o.calc > 0 && o.meas > 0) {
          var d = 20 * Math.log10(o.calc / o.meas);
          g.nDb++; g.sdb += d * d; if (Math.abs(d) > g.maxDb) g.maxDb = Math.abs(d);
        }
      });
    });
    return order.map(function (k) {
      var g = groups[k];
      return { key: k, n: g.n, rms: g.n ? Math.sqrt(g.se / g.n) : null, maxAbs: g.n ? g.maxAbs : null, rmsDb: g.nDb ? Math.sqrt(g.sdb / g.nDb) : null, maxDb: g.nDb ? g.maxDb : null };
    });
  }

  /** 다항식 계수 → 사람이 읽는 식 (예: F = 12 + 0.034·RPM − 1.2e-6·RPM²) */
  function polyText(coef) {
    var parts = [];
    coef.forEach(function (c, j) {
      var s = fmt(Math.abs(c), 6) + (j === 0 ? '' : j === 1 ? '·RPM' : '·RPM' + ['', '', '²', '³', '⁴', '⁵'][j]);
      parts.push({ neg: c < 0, s: s });
    });
    return 'F = ' + parts.map(function (p, i) { return (i === 0 ? (p.neg ? '−' : '') : (p.neg ? ' − ' : ' + ')) + p.s; }).join('');
  }

  function fitToSheets(est, meta) {
    var used = {};
    var cond = [
      ['항목', '값'],
      ['자료', meta.sample ? '예시 데이터(가상) — 실제 계측·해석 결과가 아닙니다' : '사용자 파일'],
      ['FRF 파일', meta.fileName || ''],
      ['계측 파일', meta.measFile || ''],
      ['계산 일시', meta.created || ''],
      ['비교 기준', '크기 |FRF| × 가진력 vs |계측| (위상 없음 — 2026-09-29 확인)'],
      ['비교 대상', est.objective === 'overall' ? 'overall 오차 — 계산 overall = √(Σ_k (|FRF_k| × F_k)²)' : '차수별 응답 오차'],
      ['오차 기준', est.crit === 'max' ? '최대값 — 최대 절대오차 최소(minimax, Lawson 반복 재가중)' : '평균값 — 평균 제곱오차 최소(최소제곱)'],
      ['오차 단위', est.errScale === 'rel' ? '상대오차 (계산 − 계측) ÷ 계측' : '절대오차 (응답 단위)'],
      ['FRF 보간', INTERP[meta.interp] || meta.interp],
      ['반공진 경고 기준', '최대 |FRF| × ' + meta.antiRatio + ' 보다 작은 관측은 맞춤에서 뺌']
    ];
    var coefRows;
    if (est.mode === 'scale') {
      cond.push(['추정 방식', 'scale factor 고정 — 기준 ' + est.ref + '차의 RPM별 크기를 RPM 점마다 최소제곱'],
        ['식', 'F_ref(RPM) = Σ a·m ÷ Σ a²,  a = |FRF| × s_k/s_ref'],
        ['scale factor 비(s_k/s_ref)', est.orders.map(function (k) { return k + '차=' + fmt(est.ratio[k], 6); }).join(', ')]);
      coefRows = [['RPM', '기준 ' + est.ref + '차 추정 가진력', '쓴 관측 수'].concat(est.orders.map(function (k) { return k + '차 가진력(=비×기준)'; }))];
      est.rpms.forEach(function (r, i) { coefRows.push([r, est.refForce[i] == null ? '' : est.refForce[i], est.used[i]].concat(est.orders.map(function (k) { var v = est.table.byOrder[k][i]; return v == null ? '' : v; }))); });
    } else {
      cond.push(['추정 방식', '가진력 형태 지정 — 차수별 ' + est.degree + '차 다항식 F_k(RPM) = Σ c_j·RPMʲ'],
        ['식', est.objective === 'overall' ? '계측 overall ≈ √(Σ_k (|FRF_k| × Σ c_kj·RPMʲ)²) 를 Levenberg–Marquardt 로 풂 (F_k 부호는 구분 불가 — 양수로 맞춤)' : '계측 ≈ |FRF| × Σ c_j·RPMʲ 를 선형 최소제곱(Householder QR)으로 풂']);
      coefRows = [['차수', '쓴 관측 수', 'RPM 점 수'].concat(Array.apply(null, Array(est.degree + 1)).map(function (_, j) { return 'c' + j + ' (RPM^' + j + ')'; })).concat(['식'])];
      est.fits.forEach(function (ft) { coefRows.push([ft.order, ft.n, ft.rpms].concat(ft.coef).concat([polyText(ft.coef)])); });
    }
    var cmp = [['RPM', '차수', '응답점', '가진주파수(Hz)', '|FRF|', '추정 가진력', '계산 응답', '계측', '오차(계산−계측)', 'dB 오차', '맞춤에 씀', '비고']];
    est.obs.forEach(function (o) {
      var db = o.calc > 0 && o.meas > 0 ? 20 * Math.log10(o.calc / o.meas) : '';
      cmp.push([o.rpm, o.order, o.point, o.f == null ? '' : round(o.f, 6), o.h == null ? (o.hs && Object.keys(o.hs).length ? Object.keys(o.hs).map(function (k) { return k + '차 ' + fmt(o.hs[k], 6); }).join(', ') : '') : o.h, o.force == null ? '' : o.force, o.calc == null ? '' : o.calc, o.meas == null ? '' : o.meas,
        o.calc != null && o.meas != null ? o.calc - o.meas : '', db, o.use ? '예' : '', o.anti ? '반공진 부근' : (o.status === 'ok' ? '' : (STATUS_TEXT[o.status] || o.status))]);
    });
    var st = [['구분', '관측 수', 'RMS 오차(평균)', '최대 절대오차', 'RMS dB 오차', '최대 |dB| 오차']];
    est.stats.concat(est.statsByPoint.slice(1)).forEach(function (g) { st.push([g.key, g.n, g.rms == null ? '' : g.rms, g.maxAbs == null ? '' : g.maxAbs, g.rmsDb == null ? '' : g.rmsDb, g.maxDb == null ? '' : g.maxDb]); });
    return [
      { name: sheetName('추정조건', used), rows: cond },
      { name: sheetName(est.mode === 'scale' ? '기준차수_RPM별가진력' : '다항식계수', used), rows: coefRows },
      { name: sheetName('계산_vs_계측', used), rows: cmp },
      { name: sheetName('잔차', used), rows: st }
    ];
  }

  // ── 엑셀 시트 ─────────────────────────────────────────────────
  function sheetName(s, used) {
    var base = String(s).replace(/[\\\/\?\*\[\]:]/g, '_').slice(0, 31) || 'Sheet';
    var name = base, i = 2;
    while (used[name]) { var suf = '_' + i++; name = base.slice(0, 31 - suf.length) + suf; }
    used[name] = true;
    return name;
  }
  function orderLabel(k) { return k + '차'; }

  /** meta: {fileName, interp, forceMode, forceUnit, sample, created} */
  function resultToSheets(result, orders, meta) {
    var used = {}, sheets = [];
    var cond = [
      ['항목', '값'],
      ['자료', meta.sample ? '예시 데이터(가상) — 실제 해석 결과가 아닙니다' : '사용자 파일'],
      ['FRF 파일', meta.fileName || ''],
      ['계산 일시', meta.created || ''],
      ['가진 주파수', '차수 × RPM / 60 (Hz)'],
      ['FRF 보간', INTERP[meta.interp] || meta.interp],
      ['차수 성분', '|FRF(가진 주파수)| × 가진력'],
      ['overall', 'RSS = √(Σ 차수 성분²)'],
      ['가진력 입력', FORCE_MODES[meta.forceMode] || meta.forceMode],
      ['가진력 단위', meta.forceUnit || ''],
      ['차수', orders.map(function (o) { return orderLabel(o.order) + (meta.forceMode === 'const' ? '=' + o.force : ''); }).join(', ')]
    ];
    if (meta.scale) cond.push(['scale factor', '기준 ' + meta.scale.ref + '차, ' + orders.map(function (o) { return orderLabel(o.order) + '=' + meta.scale.factors[o.order]; }).join(', ') + ' — F_k = (s_k / s_기준) × F_기준']);
    sheets.push({ name: sheetName('계산조건', used), rows: cond });
    result.points.forEach(function (p) {
      var head = ['RPM'];
      orders.forEach(function (o) {
        var k = orderLabel(o.order);
        head.push(k + ' 가진주파수(Hz)', k + ' |FRF|', k + ' 가진력', k + ' 응답');
      });
      head.push('overall(RSS)', '비고');
      var rows = [head];
      p.rows.forEach(function (r) {
        var line = [r.rpm];
        var notes = [];
        r.comps.forEach(function (c) {
          line.push(round(c.f, 6), c.frf == null ? '' : c.frf, c.force == null ? '' : c.force, c.resp == null ? '' : c.resp);
          if (c.status !== 'ok') notes.push(orderLabel(c.order) + ': ' + STATUS_TEXT[c.status]);
        });
        line.push(r.overall == null ? '' : r.overall, (r.partial ? '일부 차수 제외 — ' : '') + notes.join('; '));
        rows.push(line);
      });
      sheets.push({ name: sheetName('응답_' + p.name, used), rows: rows });
    });
    return sheets;
  }

  function estimateToSheets(est, meta) {
    var used = {};
    var detail = [['RPM', '차수', '가진주파수(Hz)', '응답점', '계측값', '|FRF|', '추정 가진력', '반공진 부근 경고', '비고']];
    var sum = [['RPM', '차수', '가진주파수(Hz)', '종합 추정 가진력(최소제곱)', '쓴 응답점 수']];
    est.rows.forEach(function (r) {
      r.points.forEach(function (q) {
        var note = q.status === 'ok' ? '' : ({ no_point: 'FRF 에 없는 응답점', no_meas: '계측값 없음', zero_frf: '|FRF| 가 0', out_of_range: STATUS_TEXT.out_of_range, no_data: STATUS_TEXT.no_data })[q.status] || q.status;
        detail.push([r.rpm, r.order, round(r.f, 6), q.name, q.meas == null ? '' : q.meas, q.frf == null ? '' : q.frf, q.force == null ? '' : q.force, q.anti ? '예' : '', note]);
      });
      sum.push([r.rpm, r.order, round(r.f, 6), r.ls == null ? '' : r.ls, r.used]);
    });
    var cond = [
      ['항목', '값'],
      ['자료', meta.sample ? '예시 데이터(가상) — 실제 계측·해석 결과가 아닙니다' : '사용자 파일'],
      ['FRF 파일', meta.fileName || ''],
      ['계측 파일', meta.measFile || ''],
      ['계산 일시', meta.created || ''],
      ['추정식', '가진력 = |계측 응답| ÷ |FRF(차수 × RPM / 60)| (단일 가진점 가정)'],
      ['종합값', '반공진 경고가 없는 응답점으로 최소제곱: Σ|FRF|·|계측| ÷ Σ|FRF|²'],
      ['반공진 경고 기준', '그 응답점 최대 |FRF| × ' + meta.antiRatio + ' 보다 작을 때'],
      ['FRF 보간', INTERP[meta.interp] || meta.interp]
    ];
    return [
      { name: sheetName('추정조건', used), rows: cond },
      { name: sheetName('가진력추정_응답점별', used), rows: detail },
      { name: sheetName('가진력추정_종합', used), rows: sum }
    ];
  }

  function toCsv(rows) {
    return '﻿' + rows.map(function (r) {
      return r.map(function (v) {
        var s = v == null ? '' : String(v);
        return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
      }).join(',');
    }).join('\r\n') + '\r\n';
  }

  // ── 그래프 눈금 ────────────────────────────────────────────────
  function niceTicks(min, max, count) {
    if (!(max > min)) { max = min + 1; }
    var span = max - min, raw = span / (count || 5);
    var mag = Math.pow(10, Math.floor(Math.log(raw) / Math.LN10));
    var norm = raw / mag;
    var step = (norm < 1.5 ? 1 : norm < 3 ? 2 : norm < 7 ? 5 : 10) * mag;
    var lo = Math.floor(min / step) * step, hi = Math.ceil(max / step) * step, ticks = [];
    for (var v = lo; v <= hi + step * 1e-9; v += step) ticks.push(round(v, 10));
    return ticks;
  }

  function fmt(x, digits) {
    if (x == null || !isFinite(x)) return '';
    if (x === 0) return '0';
    var a = Math.abs(x);
    if (a >= 1e5 || a < 1e-3) return x.toExponential((digits || 4) - 1);
    return String(Number(x.toPrecision(digits || 4)));
  }

  var api = {
    FORMATS: FORMATS, INTERP: INTERP, STATUS_TEXT: STATUS_TEXT, MAX_RPM_POINTS: MAX_RPM_POINTS,
    toNumber: toNumber, round: round, guessMapping: guessMapping, guessHeaderRow: guessHeaderRow,
    magnitudeOf: magnitudeOf, buildFrf: buildFrf, frfSummary: frfSummary, maxMag: maxMag,
    interpolate: interpolate, excitationFreq: excitationFreq, rpmList: rpmList, validateOrders: validateOrders,
    parseForceTable: parseForceTable, forceAt: forceAt, rss: rss, computeResponse: computeResponse,
    parseMeasured: parseMeasured, estimateForce: estimateForce, estimateToForceTable: estimateToForceTable,
    resultToSheets: resultToSheets, estimateToSheets: estimateToSheets, sheetName: sheetName, toCsv: toCsv,
    niceTicks: niceTicks, fmt: fmt,
    FORCE_MODES: FORCE_MODES, scaleRatios: scaleRatios, constForcesByScale: constForcesByScale, splitPasted: splitPasted,
    parseForceVector: parseForceVector, expandTableByScale: expandTableByScale, lstsq: lstsq, polyEval: polyEval,
    observations: observations, fitStats: fitStats, estimateScaleFixed: estimateScaleFixed, estimatePoly: estimatePoly,
    polyText: polyText, fitToSheets: fitToSheets,
    measLayoutMap: measLayoutMap, measMapByHeader: measMapByHeader, parseMeasTable: parseMeasTable, headerOrder: headerOrder,
    parseOrderLabel: parseOrderLabel, splitMeasHeader: splitMeasHeader, analyzeMeasHeaders: analyzeMeasHeaders, orderText: orderText, ORDER_FORMS: ORDER_FORMS, cellOrder: cellOrder,
    overallObservations: overallObservations, lawson: lawson, solveLinear: solveLinear, levenberg: levenberg
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.FRFLogic = api;
})(typeof window !== 'undefined' ? window : this);
