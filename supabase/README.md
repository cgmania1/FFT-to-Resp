# Supabase DB 스크립트 — FRF RPM별 응답 계산기

이 폴더에는 지금 브라우저에 저장되는 해석 작업 상태를 Supabase(PostgreSQL) 표로 옮기기 위한 스크립트가 들어 있습니다.
스크립트만 먼저 준비해 둔 단계이며, 앱은 아직 localStorage 로 동작합니다.

## 왜 DB 가 필요한가

지금 도구는 작업 상태 전체를 브라우저의 localStorage(`data09-04.state`) 한 칸에 통째로 저장합니다.
그 안에는 불러온 엑셀 파일 내용까지 들어 있어 다음 문제가 생깁니다.

- FRF 해석 결과 엑셀은 주파수 행 수천 개 × 응답점 여러 개라 금방 커집니다. 브라우저 저장 한도(보통 5MB 안팎)를 넘으면 도구가 「파일이 커서 브라우저 저장소에 담지 못했습니다」를 띄우고, 창을 닫으면 불러온 파일이 사라집니다.
- 한 번에 한 건만 담을 수 있어, 설계 변경 전·후 FRF 처럼 여러 해석 건을 나란히 남겨 비교할 수 없습니다(기획서 5장 「해석 이력 비교」).
- 해석 담당자와 소음·진동 담당자가 같은 조건(RPM 범위·차수·가진력 표)을 함께 볼 수 없습니다.

DB 로 옮기면 파일 크기 걱정 없이 여러 해석 건을 쌓고, 본인 외에는 아무도 볼 수 없게 DB 가 직접 막습니다(RLS).

## 테이블

| 테이블 | 용도 | localStorage 대응 |
|---|---|---|
| `analysis_cases` | 해석 건 — 제목, 예시 여부, 계산 조건(RPM 시작·끝·간격, 가진력 입력 방식·단위, 보간 방식, 반공진 경고 기준), FRF 확인할 점 | `data09-04.state` 의 `sample`·`settings`·`frfWarnings` |
| `case_files` | 불러온 파일 — FRF·가진력·계측 파일마다 한 행. 시트 내용·고른 시트·머리행·열 지정 | `frfFile`+`frfMap`, `forceFile`(+`map`), `measFile`+`measMap` |
| `frf_points` | 만든 FRF 표 — 응답점마다 이름·단위·주파수 배열·크기 배열 | `frf` (`freq`, `points[].mag`) |
| `case_orders` | 차수 목록과 차수별 상수 가진력 | `settings.orders` |
| `force_table_values` | RPM × 차수 가진력 표를 한 칸 = 한 행으로 편 것 | `forceTable` (`rpm`, `byOrder`) |

필드 이름은 도구의 이름을 snake_case 로 바꿔 씁니다(`rpmStart` → `rpm_start`, `antiRatio` → `anti_ratio` 등).
차수 `order` 는 SQL 예약어라 `order_no` 로 적었습니다.
계산 결과(RPM별 응답·가진력 추정값)는 도구도 저장하지 않고 필요할 때 다시 계산하므로 표를 두지 않았습니다.

도구의 규칙은 DB 제약으로도 걸려 있습니다.

- 보간 방식은 `linear`·`nearest`·`loglog`, 가진력 입력은 `const`·`table`
- RPM 간격은 0 보다 크고, RPM 끝은 시작보다 작을 수 없음. 반공진 경고 기준은 0~1 사이
- 한 건에 파일은 종류(frf·force·meas)마다 하나. 「추정값에서 온 가진력 표」는 가진력 표에만
- FRF 는 주파수가 2개 이상이고 주파수·크기 배열 길이가 같아야 함(보간할 수 있어야 하므로). 한 건 안에서 응답점 이름은 겹치지 않음
- 차수는 0 보다 큼. 같은 건·같은 RPM·같은 차수의 가진력은 하나

## 권한 규칙

도구에 사용자 역할 구분이 없으므로 모든 행은 만든 사람만 보고 고칩니다.

| 누가 | 볼 수 있는 것 | 할 수 있는 것 |
|---|---|---|
| 로그인한 본인 | 자기 해석 건과 그 하위 자료 | 자기 행 추가·수정·삭제 |
| 다른 로그인 사용자 | 없음 | 없음 |
| 비로그인 | 없음 | 없음 |

- 하위 표(파일·FRF·차수·가진력 표)는 행의 주인이 본인이어야 할 뿐 아니라, 붙이려는 해석 건도 본인 것이어야 저장됩니다. 남의 해석 건 번호를 알아도 거기에 행을 끼워 넣을 수 없습니다.
- 해석 건을 지우면 그 건의 파일·FRF·차수·가진력 표도 함께 지워집니다.

## 적용 방법

1. [supabase.com](https://supabase.com) 에 가입합니다.
2. New project 로 본인 프로젝트를 만듭니다.
3. 왼쪽 메뉴에서 SQL Editor 를 엽니다.
4. `supabase/schema.sql` 내용을 통째로 붙여 넣습니다.
5. Run 을 누릅니다.

여러 번 실행해도 안전합니다. 이미 있는 표와 데이터는 그대로 두고 정책·함수만 다시 만듭니다.

## 확인 방법

- Table Editor 에 위 5개 표가 보이는지 확인합니다.
- 표마다 RLS 가 켜져 있고(Enabled) 정책 4개(읽기·추가·수정·삭제)가 붙어 있는지 확인합니다.
- SQL Editor 에서 다음을 실행해 5개 표 모두 `true` 인지 봅니다.

```sql
select relname, relrowsecurity from pg_class
where relnamespace = 'public'::regnamespace and relkind = 'r' order by relname;
```

## 앱 연결은 다음 단계입니다

이 스크립트는 DB 틀만 만듭니다. 화면(`js/store.js`)은 아직 localStorage 를 씁니다.
앱을 DB 에 연결하는 작업(Supabase 클라이언트 추가, 로그인 추가, 상태 한 덩어리를 표 단위로 나눠 저장·조회)은 다음 단계에서 진행합니다.
연결할 때 upsert 는 `onConflict` 를 반드시 지정합니다(파일 `case_id,kind`, 차수 `case_id,order_no`, 가진력 표 `case_id,rpm,order_no`).
원본 엑셀 파일을 그대로 보관해야 한다면 표 대신 Supabase Storage 의 비공개 버킷을 쓰는 것이 알맞습니다. 이 스크립트는 도구가 지금 저장하는 형태(시트 내용)만 옮깁니다.

## 로컬 검증

운영 프로젝트에 올리기 전에 내 컴퓨터의 임시 PostgreSQL 에 실제로 적용해 검사합니다.
PostgreSQL 17(또는 16)이 설치되어 있어야 합니다(macOS: `brew install postgresql@17`).

```sh
./scripts/sqltest/run.sh
```

임시 DB 를 만들어 `schema.sql` 을 두 번 적용하고(재실행 안전성), 사용자 A·B·비로그인으로 바꿔 가며 RLS·제약·함수 권한을 검사한 뒤 지웁니다.
마지막 줄에 「SQL 검증 통과.」가 나오면 성공입니다.
`scripts/sqltest/*.local.sql` 은 검증 전용이며 운영 DB 에서는 스스로 실행을 멈춥니다. SQL Editor 에 붙여 넣지 않습니다.
