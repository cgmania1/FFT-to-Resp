/*
 * 예시 데이터 — 화면 시연과 계산 확인용으로 만든 가상의 값입니다.
 * 실제 지게차 해석(OptiStruct) 결과나 계측 결과가 아닙니다.
 * 고유진동수·감쇠·가진력·응답점 이름은 모두 지어낸 값이며, 이름에 「예시」를 붙였습니다.
 *
 *  FRF  : 가상의 모드 5개를 겹친 크기+위상 표 (0~400 Hz, 1 Hz 간격)
 *  계측 : 아래 「가상 참 가진력」 × FRF 에 ±2% 흔들림을 넣은 RPM·차수 표 — 가진력 추정 시연용
 *  가진력 표 : 가상 참 가진력을 RPM 200 간격으로 적은 표 — 「RPM별 가진력 표」 입력 시연용
 */
(function (root) {
  'use strict';
  var MODES = [32, 58, 96, 145, 230];   // 가상 고유진동수(Hz)
  var ZETA = 0.06;                       // 가상 감쇠비
  var POINTS = [
    { name: '예시_운전석바닥_진동', unit: '(m/s²)/N', amp: [0.012, 0.004, 0.009, -0.003, 0.002] },
    { name: '예시_운전자귀_소음', unit: 'Pa/N', amp: [0.020, 0.030, -0.010, 0.015, 0.008] },
    { name: '예시_핸들_진동', unit: '(m/s²)/N', amp: [0.006, -0.008, 0.012, 0.010, -0.004] }
  ];
  var ORDERS = [1, 2, 4];
  var BASE_FORCE = { 1: 120, 2: 60, 4: 25 }; // 가상 가진력(N)

  function H(point, f) {
    var re = 0, im = 0;
    MODES.forEach(function (fn, i) {
      var r = f / fn, a = 1 - r * r, b = 2 * ZETA * r, d = a * a + b * b;
      re += point.amp[i] * a / d;
      im += -point.amp[i] * b / d;
    });
    return { re: re, im: im };
  }
  function r6(x) { return Math.round(x * 1e6) / 1e6; }
  function sig(x) { return Number(x.toPrecision(6)); }

  // 가상 참 가진력: RPM 이 오를수록 커지는 모양(800rpm 에서 기준의 0.8배, 3000rpm 에서 1.2배)
  function trueForce(order, rpm) { return BASE_FORCE[order] * (0.8 + 0.4 * (rpm - 800) / 2200); }

  function build() {
    var head = ['Frequency [Hz]'];
    POINTS.forEach(function (p) { head.push(p.name + ' Mag', p.name + ' Phase'); });
    var frfRows = [head];
    for (var f = 0; f <= 400; f += 1) {
      var row = [f];
      POINTS.forEach(function (p) {
        var h = H(p, f);
        row.push(sig(Math.sqrt(h.re * h.re + h.im * h.im)), r6(Math.atan2(h.im, h.re) * 180 / Math.PI));
      });
      frfRows.push(row);
    }
    // 결정적 흔들림(매번 같은 값): 간단한 선형합동 난수
    var seed = 20260928;
    function rnd() { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; }
    var measRows = [['RPM', '차수'].concat(POINTS.map(function (p) { return p.name; }))];
    for (var rpm = 800; rpm <= 3000; rpm += 200) {
      ORDERS.forEach(function (k) {
        var fk = k * rpm / 60, line = [rpm, k];
        POINTS.forEach(function (p) {
          var h = H(p, fk), mag = Math.sqrt(h.re * h.re + h.im * h.im);
          line.push(sig(mag * trueForce(k, rpm) * (1 + (rnd() - 0.5) * 0.04)));
        });
        measRows.push(line);
      });
    }
    // 2026-09-29 오후 — 같은 계측값을 수강생이 정의한 여러 형식으로도 적어 둡니다(불러오기 시연·테스트용)
    var byKey = {};
    measRows.slice(1).forEach(function (r) { byKey[r[0] + '|' + r[1]] = r.slice(2); });
    var RPMS = [];
    for (var q = 800; q <= 3000; q += 200) RPMS.push(q);
    function val(rpm, k, pi) { return byKey[rpm + '|' + k][pi]; }
    function ovl(rpm, pi) { var s = 0; ORDERS.forEach(function (k) { s += Math.pow(val(rpm, k, pi), 2); }); return sig(Math.sqrt(s)); }
    var names = POINTS.map(function (p) { return p.name; });
    var meas = {
      // 한 지점, 차수별 열: RPM, 1차, 2차, …
      single: [['RPM'].concat(ORDERS.map(function (k) { return k + '차'; }))].concat(RPMS.map(function (r) { return [r].concat(ORDERS.map(function (k) { return val(r, k, 0); })); })),
      // 한 지점, overall 만: RPM, overall
      singleOverall: [['RPM', 'overall']].concat(RPMS.map(function (r) { return [r, ovl(r, 0)]; })),
      // 여러 지점, 차수 우선: 지점1_1차, 지점2_1차, …, 지점1_2차, …
      orderMajor: [['RPM'].concat([].concat.apply([], ORDERS.map(function (k) { return names.map(function (n) { return n + '_' + k + '차'; }); })))]
        .concat(RPMS.map(function (r) { return [r].concat([].concat.apply([], ORDERS.map(function (k) { return names.map(function (n, pi) { return val(r, k, pi); }); }))); })),
      // 여러 지점, 지점 우선: 지점1_1차, 지점1_2차, …, 지점2_1차, …
      pointMajor: [['RPM'].concat([].concat.apply([], names.map(function (n) { return ORDERS.map(function (k) { return n + '_' + k + '차'; }); })))]
        .concat(RPMS.map(function (r) { return [r].concat([].concat.apply([], names.map(function (n, pi) { return ORDERS.map(function (k) { return val(r, k, pi); }); }))); })),
      // 여러 지점, overall 만
      multiOverall: [['RPM'].concat(names.map(function (n) { return n + '_overall'; }))].concat(RPMS.map(function (r) { return [r].concat(names.map(function (n, pi) { return ovl(r, pi); })); })),
      // 2026-09-29 저녁 — 머리행 표기가 제각각인 파일(지점 우선). 지점 이름은 그대로, 차수는 1st·2nd order·4th / 1X·2x·4X / H1·Ord2·４차(전각).
      // 「온도(℃)」 열은 차수 표기가 아니어서 인식하지 못함으로 표시되고 계산에 쓰이지 않아야 합니다.
      mixed: (function () {
        var labels = [['_1st', '_2nd order', '_4th'], [' 1X', ' 2x', ' 4X'], ['_H1', '_Ord2', '_\uff14차']];
        var head = ['RPM', '온도(℃)'];
        names.forEach(function (n, pi) { labels[pi].forEach(function (l) { head.push(n + l); }); });
        return [head].concat(RPMS.map(function (r) { return [r, 25].concat([].concat.apply([], names.map(function (n, pi) { return ORDERS.map(function (k) { return val(r, k, pi); }); }))); }));
      })(),
      // 지점별 시트: 시트 이름 = 응답점, 시트마다 RPM, 1차, 2차, …
      sheets: names.map(function (n, pi) { return { name: n, rows: [['RPM'].concat(ORDERS.map(function (k) { return k + '차'; }))].concat(RPMS.map(function (r) { return [r].concat(ORDERS.map(function (k) { return val(r, k, pi); })); })) }; })
    };
    var forceRows = [['RPM'].concat(ORDERS.map(function (k) { return k + '차 가진력(N)'; }))];
    for (var r2 = 800; r2 <= 3000; r2 += 200) forceRows.push([r2].concat(ORDERS.map(function (k) { return r6(trueForce(k, r2)); })));
    return {
      frfRows: frfRows,
      measRows: measRows,
      meas: meas,
      forceRows: forceRows,
      units: POINTS.reduce(function (o, p) { o[p.name] = p.unit; return o; }, {}),
      settings: {
        rpmStart: 800, rpmEnd: 3000, rpmStep: 50,
        // scale factor 는 가상 기준 가진력 비(120 : 60 : 25)를 1차 = 1 로 적은 값
        orders: ORDERS.map(function (k) { return { order: k, force: BASE_FORCE[k], scale: r6(BASE_FORCE[k] / BASE_FORCE[1]) }; }),
        refOrder: 1, vectorStep: 200,
        vectorRows: forceRows.slice(1).map(function (row) { var v = {}; ORDERS.forEach(function (k, j) { v[k] = row[j + 1]; }); return { rpm: row[0], v: v }; }),
        forceMode: 'const', forceUnit: 'N', interp: 'linear', antiRatio: 0.05
      },
      trueForce: trueForce
    };
  }

  var api = {
    build: build, FILE_FRF: '예시데이터_FRF', FILE_MEAS: '예시데이터_계측응답', FILE_FORCE: '예시데이터_가진력표',
    // 계측 형식별 예시 파일 (2026-09-29 오후)
    FILE_MEAS_FORMS: { single: '예시데이터_계측_1지점_차수별', singleOverall: '예시데이터_계측_1지점_overall', orderMajor: '예시데이터_계측_다지점_차수우선', pointMajor: '예시데이터_계측_다지점_지점우선', multiOverall: '예시데이터_계측_다지점_overall', mixed: '예시데이터_계측_다지점_머리행혼합', sheets: '예시데이터_계측_지점별시트' }
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.FRFSample = api;
})(typeof window !== 'undefined' ? window : this);
