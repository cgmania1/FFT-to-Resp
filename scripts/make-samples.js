// 예시 데이터 파일 생성: node scripts/make-samples.js
// js/sample-data.js(가상 값)를 samples/ 에 xlsx·csv 로 씁니다. 모두 「예시데이터_」로 시작합니다.
const fs = require('fs');
const path = require('path');
const XLSX = require('../vendor/xlsx.full.min.js');
const L = require('../js/logic.js');
const Sample = require('../js/sample-data.js');

const out = path.join(__dirname, '..', 'samples');
fs.mkdirSync(out, { recursive: true });
const s = Sample.build();
const note = [['이 파일의 값은 시연용으로 만든 가상의 예시 데이터입니다. 실제 해석·계측 결과가 아닙니다.']];

function writeXlsx(name, rows) {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), '예시데이터');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(note), '안내');
  fs.writeFileSync(path.join(out, name + '.xlsx'), XLSX.write(wb, { bookType: 'xlsx', type: 'buffer' }));
}
writeXlsx(Sample.FILE_FRF, s.frfRows);
fs.writeFileSync(path.join(out, Sample.FILE_FRF + '.csv'), L.toCsv(s.frfRows));
fs.writeFileSync(path.join(out, Sample.FILE_MEAS + '.csv'), L.toCsv(s.measRows));
writeXlsx(Sample.FILE_MEAS, s.measRows);
fs.writeFileSync(path.join(out, Sample.FILE_FORCE + '.csv'), L.toCsv(s.forceRows));
// 계측 형식별 예시 (2026-09-29 오후): csv + xlsx, 지점별 시트는 xlsx 하나(+ 시트마다 csv — 파이썬용)
const F = Sample.FILE_MEAS_FORMS;
['single', 'singleOverall', 'orderMajor', 'pointMajor', 'multiOverall', 'mixed'].forEach(k => {
  fs.writeFileSync(path.join(out, F[k] + '.csv'), L.toCsv(s.meas[k]));
  writeXlsx(F[k], s.meas[k]);
});
{
  const wb = XLSX.utils.book_new();
  s.meas.sheets.forEach(sh => XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(sh.rows), L.sheetName(sh.name, {})));
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(note), '안내');
  fs.writeFileSync(path.join(out, F.sheets + '.xlsx'), XLSX.write(wb, { bookType: 'xlsx', type: 'buffer' }));
  s.meas.sheets.forEach(sh => fs.writeFileSync(path.join(out, F.sheets + '_' + sh.name + '.csv'), L.toCsv(sh.rows)));
}

// 검증: xlsx 를 앱과 같은 방식으로 다시 읽어 같은 FRF 표가 되는지
const wb = XLSX.read(fs.readFileSync(path.join(out, Sample.FILE_FRF + '.xlsx')), { type: 'buffer' });
const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, raw: true, defval: '' });
const a = L.buildFrf(rows.slice(1), L.guessMapping(rows[0]));
const b = L.buildFrf(s.frfRows.slice(1), L.guessMapping(s.frfRows[0]));
if (JSON.stringify(a.frf) !== JSON.stringify(b.frf)) { console.error('xlsx 왕복 불일치'); process.exit(1); }
console.log('samples/ 작성 완료 — FRF ' + (s.frfRows.length - 1) + '행, 계측 ' + (s.measRows.length - 1) + '행, 가진력 표 ' + (s.forceRows.length - 1) + '행');
