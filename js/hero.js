/* 첫 화면 개념도 — 가진 주파수(캠벨 선도) → FRF → RPM별 응답 (2026-09-30)
 *
 * 계산 로직(js/logic.js)과 무관한 설명용 그림입니다. 값은 모두 가상의 모형입니다.
 *   가진 주파수  f_k = k × n / 60          (차수 k, 회전수 n rpm)
 *   차수 응답    X_k(n) = |H(f_k)| × F_k    (H = 2모드 FRF 모형)
 *   overall      X(n) = √(Σ X_k²)
 * 회전수 표시선 n 이 600~3000 rpm 을 오가며 세 그림이 같은 n 으로 함께 움직입니다.
 * 움직임 줄이기 설정이면 멈춘 그림, 탭이 숨겨지거나 화면 밖이면 멈춥니다.
 * 그림 위에 포인터를 올리면 그 회전수로 옮겨 볼 수 있습니다.
 */
(function (root) {
  'use strict';
  var NS = 'http://www.w3.org/2000/svg';
  var N0 = 600, N1 = 3000, FMAX = 200;          // 회전수 범위(rpm), 주파수 범위(Hz)
  var ORDERS = [
    { k: 1, F: 1.0, cls: 'o1', label: '1차' },
    { k: 2, F: 0.7, cls: 'o2', label: '2차' },
    { k: 4, F: 0.45, cls: 'o4', label: '4차' }
  ];
  var MODES = [{ fn: 42, z: 0.07, a: 1 }, { fn: 108, z: 0.05, a: 0.6 }];
  var PERIOD = 11000;                              // 한 번 왕복(ms)

  function H(f) {                                 // 2모드 FRF 크기(가상)
    var s = 0;
    MODES.forEach(function (m) {
      var r = f / m.fn;
      s += m.a / Math.sqrt(Math.pow(1 - r * r, 2) + Math.pow(2 * m.z * r, 2));
    });
    return s;
  }
  var HMAX = 0;
  for (var f0 = 0; f0 <= FMAX; f0 += 0.25) HMAX = Math.max(HMAX, H(f0));
  function resp(n) {
    var xs = ORDERS.map(function (o) { var f = o.k * n / 60; return f <= FMAX ? H(f) / HMAX * o.F : null; });
    var sum = 0; xs.forEach(function (x) { if (x != null) sum += x * x; });
    return { xs: xs, all: Math.sqrt(sum) };
  }
  var XMAX = 0;
  for (var n0 = N0; n0 <= N1; n0 += 5) XMAX = Math.max(XMAX, resp(n0).all);

  function s(tag, attrs, txt) {
    var e = document.createElementNS(NS, tag);
    if (attrs) Object.keys(attrs).forEach(function (k) { e.setAttribute(k, attrs[k]); });
    if (txt != null) e.textContent = txt;
    return e;
  }
  function fmtRpm(n) { return String(Math.round(n / 10) * 10).replace(/\B(?=(\d{3})+(?!\d))/g, ','); }

  // 좁은 화면은 가로가 짧은 판(W=340)을 그려 글자가 작아지지 않게 합니다.
  function geometry(compact) {
    var W = compact ? 340 : 520;
    var g = {
      W: W, H: compact ? 350 : 416, compact: compact,
      cx0: compact ? 30 : 46, cx1: compact ? 210 : 330,           // 캠벨·응답 가로(회전수)
      fx0: compact ? 232 : 356, fx1: W - (compact ? 10 : 14),      // FRF 가로(|H|)
      cy0: compact ? 30 : 34, cy1: compact ? 170 : 206,            // 캠벨·FRF 세로(주파수)
      ry0: compact ? 222 : 268, ry1: compact ? 318 : 384           // 응답 세로
    };
    g.X = function (n) { return g.cx0 + (n - N0) / (N1 - N0) * (g.cx1 - g.cx0); };
    g.Fy = function (f) { return g.cy1 - f / FMAX * (g.cy1 - g.cy0); };
    g.Hx = function (h) { return g.fx0 + h / HMAX * (g.fx1 - g.fx0) * 0.94; };
    g.Ry = function (x) { return g.ry1 - x / XMAX * (g.ry1 - g.ry0) * 0.92; };
    return g;
  }

  function path(pts) {
    return pts.map(function (p, i) { return (i ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1); }).join('');
  }

  function draw(g, uid) {
    var svg = s('svg', { viewBox: '0 0 ' + g.W + ' ' + g.H, class: 'hero-svg', role: 'img', 'aria-labelledby': uid + 't ' + uid + 'd' });
    svg.appendChild(s('title', { id: uid + 't' }, '응답 계산 개념도'));
    svg.appendChild(s('desc', { id: uid + 'd' }, '왼쪽 위 캠벨 선도에서 회전수 n 의 차수 k 가진 주파수 f = k·n/60 을 읽고, 오른쪽 위 FRF 곡선에서 그 주파수의 크기 |H(f)| 를 옮겨 와, 아래 그래프에서 차수 응답 X = |H|×F 와 overall = √ΣX² 를 회전수에 따라 그립니다.'));
    var defs = s('defs');
    var clip = s('clipPath', { id: uid + 'c' }); var clipRect = s('rect', { x: g.cx0, y: g.ry0 - 6, width: 0, height: g.ry1 - g.ry0 + 12 });
    clip.appendChild(clipRect); defs.appendChild(clip); svg.appendChild(defs);

    // 판 바탕
    function panel(x0, y0, x1, y1) { svg.appendChild(s('rect', { class: 'hd-panel', x: x0 - 6, y: y0 - 6, width: x1 - x0 + 12, height: y1 - y0 + 12, rx: 8 })); }
    panel(g.cx0, g.cy0, g.cx1, g.cy1); panel(g.fx0, g.cy0, g.fx1, g.cy1); panel(g.cx0, g.ry0, g.cx1, g.ry1);

    // 판 제목
    function tag(x, y, num, label) {
      svg.appendChild(s('circle', { class: 'hd-num', cx: x + 7, cy: y - 4.5, r: 7.5 }));
      svg.appendChild(s('text', { class: 'hd-numt', x: x + 7, y: y - 0.5, 'text-anchor': 'middle' }, String(num)));
      svg.appendChild(s('text', { class: 'hd-tag', x: x + 20, y: y }, label));
    }
    var ty = g.cy0 - (g.compact ? 12 : 14);
    tag(g.cx0 - 6, ty, 1, g.compact ? '가진 주파수' : '가진 주파수  f = k·n / 60');
    tag(g.fx0 - 6, ty, 2, 'FRF |H(f)|');
    tag(g.cx0 - 6, g.ry0 - (g.compact ? 12 : 14), 3, g.compact ? '응답 X = |H|×F' : '응답  X_k = |H(f_k)| × F_k');

    // 격자·눈금
    [50, 100, 150].forEach(function (f) {
      var y = g.Fy(f);
      svg.appendChild(s('line', { class: 'hd-grid', x1: g.cx0, x2: g.cx1, y1: y, y2: y }));
      svg.appendChild(s('line', { class: 'hd-grid', x1: g.fx0, x2: g.fx1, y1: y, y2: y }));
      if (!g.compact) svg.appendChild(s('text', { class: 'hd-tick', x: g.cx0 - 8, y: y + 4, 'text-anchor': 'end' }, String(f)));
    });
    [1000, 2000, 3000].forEach(function (n) {
      var x = g.X(n);
      svg.appendChild(s('line', { class: 'hd-grid', x1: x, x2: x, y1: g.cy0, y2: g.cy1 }));
      svg.appendChild(s('line', { class: 'hd-grid', x1: x, x2: x, y1: g.ry0, y2: g.ry1 }));
      if (!g.compact) svg.appendChild(s('text', { class: 'hd-tick', x: x, y: g.ry1 + 18, 'text-anchor': n === 3000 ? 'end' : 'middle' }, String(n)));
    });
    // 축
    function axis(x0, y0, x1, y1) { svg.appendChild(s('path', { class: 'hd-axis', d: 'M' + x0 + ' ' + y0 + 'V' + y1 + 'H' + x1 })); }
    axis(g.cx0, g.cy0, g.cx1, g.cy1); axis(g.fx0, g.cy0, g.fx1, g.cy1); axis(g.cx0, g.ry0, g.cx1, g.ry1);
    svg.appendChild(s('text', { class: 'hd-axl', x: g.cx1, y: g.cy1 + (g.compact ? 15 : 18), 'text-anchor': 'end' }, 'n (rpm)'));
    svg.appendChild(s('text', { class: 'hd-axl', x: g.fx1, y: g.cy1 + (g.compact ? 15 : 18), 'text-anchor': 'end' }, '|H|'));
    svg.appendChild(s('text', { class: 'hd-axl', x: g.cx0 + 4, y: g.cy0 + 12 }, 'f (Hz)'));
    svg.appendChild(s('text', { class: 'hd-axl', x: g.cx0 + 4, y: g.ry0 + 12 }, 'X'));
    if (g.compact) svg.appendChild(s('text', { class: 'hd-axl', x: g.cx1, y: g.ry1 + 15, 'text-anchor': 'end' }, 'n (rpm)'));

    // 고유진동수(모드) — 캠벨의 가로 점선, 차수선과 만나는 곳이 공진 회전수
    MODES.forEach(function (m) {
      var y = g.Fy(m.fn);
      svg.appendChild(s('line', { class: 'hd-mode', x1: g.cx0, x2: g.fx1, y1: y, y2: y }));
      ORDERS.forEach(function (o) {
        var nc = m.fn * 60 / o.k;
        if (nc >= N0 && nc <= N1) svg.appendChild(s('circle', { class: 'hd-crit', cx: g.X(nc), cy: y, r: g.compact ? 3.2 : 3.6 }));
      });
    });
    if (!g.compact) svg.appendChild(s('text', { class: 'hd-note', x: g.fx1 - 2, y: g.Fy(MODES[1].fn) - 6, 'text-anchor': 'end' }, '고유진동수'));

    // 캠벨 차수선
    ORDERS.forEach(function (o) {
      var nEnd = Math.min(N1, FMAX * 60 / o.k);
      svg.appendChild(s('line', { class: 'hd-line ' + o.cls, x1: g.X(N0), y1: g.Fy(o.k * N0 / 60), x2: g.X(nEnd), y2: g.Fy(o.k * nEnd / 60) }));
      var lx = g.X(nEnd) + (nEnd < N1 ? 4 : -2), ly = g.Fy(o.k * nEnd / 60) + (nEnd < N1 ? 4 : -6);
      svg.appendChild(s('text', { class: 'hd-olab ' + o.cls, x: lx, y: ly, 'text-anchor': nEnd < N1 ? 'start' : 'end' }, o.label));
    });

    // FRF 곡선(세로축 = 주파수, 캠벨과 같은 축)
    var fp = []; for (var f = 0; f <= FMAX; f += 1) fp.push([g.Hx(H(f)), g.Fy(f)]);
    svg.appendChild(s('path', { class: 'hd-frf', d: path(fp) }));

    // 응답 곡선 — 옅은 전체 + 표시선까지 밝게(clip)
    var curves = ORDERS.map(function (o, i) {
      var pts = [];
      for (var n = N0; n <= N1; n += 10) { var x = resp(n).xs[i]; if (x != null) pts.push([g.X(n), g.Ry(x)]); }
      return path(pts);
    });
    var ap = []; for (var n2 = N0; n2 <= N1; n2 += 10) ap.push([g.X(n2), g.Ry(resp(n2).all)]);
    var ghost = s('g', { class: 'hd-ghost' }), lit = s('g', { 'clip-path': 'url(#' + uid + 'c)' });
    ORDERS.forEach(function (o, i) {
      ghost.appendChild(s('path', { class: 'hd-line thin ' + o.cls, d: curves[i] }));
      lit.appendChild(s('path', { class: 'hd-line thin ' + o.cls, d: curves[i] }));
    });
    ghost.appendChild(s('path', { class: 'hd-all', d: path(ap) }));
    lit.appendChild(s('path', { class: 'hd-all', d: path(ap) }));
    svg.appendChild(ghost); svg.appendChild(lit);
    if (!g.compact) svg.appendChild(s('text', { class: 'hd-note strong', x: g.cx1 - 2, y: g.ry0 + 12, 'text-anchor': 'end' }, 'overall = √ΣX²'));

    // 움직이는 표시선
    var mv = s('g', { class: 'hd-live' });
    var vline = s('line', { class: 'hd-sweep', y1: g.cy0 - 2, y2: g.ry1 + 2 });
    mv.appendChild(vline);
    var parts = ORDERS.map(function (o) {
      var guide = s('line', { class: 'hd-guide ' + o.cls });
      var d1 = s('circle', { class: 'hd-dot ' + o.cls, r: g.compact ? 3.6 : 4.2 });
      var d2 = s('circle', { class: 'hd-dot ' + o.cls, r: g.compact ? 3.6 : 4.2 });
      var d3 = s('circle', { class: 'hd-dot ' + o.cls, r: g.compact ? 3 : 3.4 });
      mv.appendChild(guide); mv.appendChild(d1); mv.appendChild(d2); mv.appendChild(d3);
      return { guide: guide, d1: d1, d2: d2, d3: d3 };
    });
    var dAll = s('circle', { class: 'hd-dot all', r: g.compact ? 4 : 4.8 });
    mv.appendChild(dAll);

    // 오른쪽 아래 — 지금 n 에서의 차수 응답 막대(= |H| × F) 와 overall
    var bx0 = g.fx0 + (g.compact ? 26 : 56), bx1 = g.fx1, rowH = (g.ry1 - g.ry0) / 4;
    svg.appendChild(s('text', { class: 'hd-tag', x: g.fx0 - 6, y: g.ry0 - (g.compact ? 12 : 14) }, g.compact ? '지금 n' : '지금 n 의 응답'));
    var bars = ORDERS.map(function (o) { return { cls: o.cls, label: o.label }; }).concat([{ cls: 'all', label: g.compact ? 'all' : 'overall' }]).map(function (b, i) {
      var y = g.ry0 + rowH * i + rowH / 2;
      svg.appendChild(s('text', { class: 'hd-olab ' + b.cls, x: g.fx0 - 2, y: y + 4 }, b.label));
      svg.appendChild(s('rect', { class: 'hd-track', x: bx0, y: y - 4, width: bx1 - bx0, height: 8, rx: 4 }));
      var r = s('rect', { class: 'hd-bar ' + b.cls, x: bx0, y: y - 4, width: 0, height: 8, rx: 4 });
      mv.appendChild(r);
      return r;
    });
    var badgeW = g.compact ? 70 : 84;
    var badge = s('g', { class: 'hd-badge' });
    var bRect = s('rect', { y: g.cy0 + 4, width: badgeW, height: g.compact ? 20 : 22, rx: 11 });
    var bText = s('text', { y: g.cy0 + (g.compact ? 18 : 19.5), 'text-anchor': 'middle' });
    badge.appendChild(bRect); badge.appendChild(bText); mv.appendChild(badge);
    svg.appendChild(mv);

    function set(n) {
      var x = g.X(n);
      vline.setAttribute('x1', x); vline.setAttribute('x2', x);
      clipRect.setAttribute('width', Math.max(0, x - g.cx0 + 0.5));
      var r = resp(n);
      ORDERS.forEach(function (o, i) {
        var f = o.k * n / 60, p = parts[i], on = f <= FMAX;
        [p.guide, p.d1, p.d2, p.d3].forEach(function (e) { e.style.display = on ? '' : 'none'; });
        if (!on) return;
        var y = g.Fy(f), hx = g.Hx(H(f));
        p.d1.setAttribute('cx', x); p.d1.setAttribute('cy', y);
        p.guide.setAttribute('x1', x); p.guide.setAttribute('x2', hx); p.guide.setAttribute('y1', y); p.guide.setAttribute('y2', y);
        p.d2.setAttribute('cx', hx); p.d2.setAttribute('cy', y);
        p.d3.setAttribute('cx', x); p.d3.setAttribute('cy', g.Ry(r.xs[i]));
      });
      dAll.setAttribute('cx', x); dAll.setAttribute('cy', g.Ry(r.all));
      r.xs.concat([r.all]).forEach(function (v, i) { bars[i].setAttribute('width', v == null ? 0 : Math.max(0, v / XMAX * (bx1 - bx0))); });
      var bx = Math.min(Math.max(x, g.cx0 + (g.compact ? 38 : 46) + badgeW / 2), g.cx1 - badgeW / 2);   // 「f (Hz)」 글자를 가리지 않게
      bRect.setAttribute('x', bx - badgeW / 2); bText.setAttribute('x', bx);
      bText.textContent = fmtRpm(n) + ' rpm';
    }
    return { svg: svg, set: set, g: g };
  }

  // ── 움직임 ──────────────────────────────────────────────────
  var reduce = root.matchMedia ? root.matchMedia('(prefers-reduced-motion: reduce)') : { matches: false };
  var narrow = root.matchMedia ? root.matchMedia('(max-width: 560px)') : { matches: false };
  var STILL_N = 2150;
  var elapsed = PERIOD * 0.12, last = null, raf = 0, current = null, seq = 0;   // 멈춘 동안은 시간이 흐르지 않음

  function nAt(t) {                                // 부드러운 왕복
    var ph = (t % PERIOD) / PERIOD;
    var u = 0.5 - 0.5 * Math.cos(ph * 2 * Math.PI);
    return N0 + u * (N1 - N0);
  }
  function tick(now) {
    raf = 0;
    if (!current || !current.fig.isConnected) { current = null; return; }
    if (last != null) elapsed += Math.min(now - last, 50);
    last = now;
    if (!current.hover) current.d.set(nAt(elapsed));
    schedule();
  }
  function schedule() {
    if (raf || !current || reduce.matches || document.hidden || !current.visible) return;
    raf = root.requestAnimationFrame(tick);
  }
  function stop() { if (raf) { root.cancelAnimationFrame(raf); raf = 0; } last = null; }
  document.addEventListener('visibilitychange', function () { if (document.hidden) stop(); else schedule(); });
  function onReduce() { stop(); if (current) { if (reduce.matches) current.d.set(STILL_N); schedule(); } }
  if (reduce.addEventListener) reduce.addEventListener('change', onReduce);

  function mount(fig) {
    var uid = 'hd' + (++seq);
    var d = draw(geometry(narrow.matches), uid);
    fig.insertBefore(d.svg, fig.firstChild);
    var c = { fig: fig, d: d, hover: false, visible: true };
    d.set(reduce.matches ? STILL_N : nAt(elapsed));
    // 포인터로 회전수 옮겨 보기
    d.svg.addEventListener('pointermove', function (ev) {
      var r = d.svg.getBoundingClientRect(); if (!r.width) return;
      var ux = (ev.clientX - r.left) / r.width * d.g.W;
      if (ux < d.g.cx0 || ux > d.g.cx1) { c.hover = false; return; }
      c.hover = true;
      d.set(N0 + (ux - d.g.cx0) / (d.g.cx1 - d.g.cx0) * (N1 - N0));
    });
    d.svg.addEventListener('pointerleave', function () { c.hover = false; if (reduce.matches) d.set(STILL_N); });
    if ('IntersectionObserver' in root) {
      new IntersectionObserver(function (es) { c.visible = es[0].isIntersecting; if (c.visible) schedule(); else if (current === c) stop(); }).observe(d.svg);
    }
    return c;
  }

  function build() {
    var fig = document.createElement('figure');
    fig.className = 'hero-figure';
    var cap = document.createElement('figcaption');
    cap.className = 'hero-caption';
    [['1', '가진 주파수', 'f = 차수 × RPM / 60'], ['2', 'FRF 값 읽기', '그 주파수의 |H(f)| 보간'], ['3', '응답 합성', 'X = |H| × F, RSS 로 overall']].forEach(function (it) {
      var sp = document.createElement('span');
      var i = document.createElement('i'); i.textContent = it[0]; i.setAttribute('aria-hidden', 'true');
      var b = document.createElement('b'); b.textContent = it[1];
      sp.appendChild(i); sp.appendChild(b); sp.appendChild(document.createTextNode(it[2]));
      cap.appendChild(sp);
    });
    fig.appendChild(cap);
    stop();
    current = mount(fig);
    schedule();
    return fig;
  }
  // 화면 폭이 좁은 판/넓은 판 경계를 넘으면 그림만 다시 그립니다.
  function onNarrow() {
    if (!current || !current.fig.isConnected) return;
    var fig = current.fig; fig.removeChild(current.d.svg);
    stop(); current = mount(fig); schedule();
  }
  if (narrow.addEventListener) narrow.addEventListener('change', onNarrow);

  // _setRpm 은 화면 검사용(자동 움직임을 멈추고 그 회전수로 고정)
  root.FRFHero = { build: build, _setRpm: function (n) { if (current) { current.hover = true; current.d.set(n); } }, _model: { H: H, resp: resp, N0: N0, N1: N1 } };
})(window);
