-- ============================================================================
-- data09-04 — 지게차 소음·진동 해석 결과 분석·RPM별 응답 계산 자동화
-- Supabase(PostgreSQL) 스키마 + RLS
--
--  무엇인가 : 지금은 브라우저 localStorage('data09-04.state') 한 칸에 통째로 들어 있는
--             작업 상태(불러온 FRF·가진력·계측 파일, 열 지정, 만든 FRF 표, 계산 조건,
--             가진력 표)를 DB 표로 나눠 옮기기 위한 스크립트입니다.
--             필드 이름은 도구(js/app.js 의 state · settings, js/logic.js)의 이름을
--             snake_case 로 바꿔 씁니다. 계산 결과는 도구도 저장하지 않고 다시 계산하므로
--             표를 두지 않습니다.
--  실행 위치 : 수강생 본인 Supabase 프로젝트의 SQL Editor 에서 실행
--  재실행    : 안전합니다 (IF NOT EXISTS / CREATE OR REPLACE / DROP ... IF EXISTS 선행)
--
--  본인 프로젝트에 올리는 것을 전제로 하므로 테이블 이름에 접두사를 붙이지 않았습니다.
--  도구에 사용자 역할 구분이 없으므로 모든 행은 만든 사람만 보고 고칩니다.
--
--  테이블 (5)
--    analysis_cases      해석 건 — 도구의 state 한 벌 + 계산 조건(settings)
--    case_files          불러온 파일 (FRF · 가진력 · 계측) + 시트·머리행·열 지정
--    frf_points          만든 FRF 표 — 응답점마다 주파수·크기 배열
--    case_orders         차수 목록 (settings.orders)
--    force_table_values  RPM × 차수 가진력 표 (state.forceTable)
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 0. 실행 위치 가드 — 드림아이티비즈 공용 프로젝트에서는 여기서 멈춘다
--   이 파일은 접두사 없는 이름(analysis_cases · case_files · set_updated_at() …)을 쓴다. 공용 프로젝트에는 같은 이름의
--   개체가 이미 있을 수 있고 다른 사이트 정책이 그것을 쓰므로, 실행하면 그 사이트들이
--   깨진다(2026-09-30 실제 사고 — data09-01 schema.sql 이 공용 프로젝트의 is_admin() 을 덮어씀).
-- ----------------------------------------------------------------------------
do $guard$
begin
  if to_regclass('public.www_profiles') is not null or to_regclass('public.user_profiles') is not null then
    raise exception '공용 프로젝트입니다 — schema.sql 은 수강생 본인 Supabase 프로젝트 전용입니다. 공용 프로젝트에서는 실행하지 마세요.';
  end if;
end;
$guard$;

-- ----------------------------------------------------------------------------
-- 1. 테이블
-- ----------------------------------------------------------------------------

-- 해석 건 — 설계 변경 전·후처럼 여러 건을 나란히 남길 수 있게 한 건 = 한 행
create table if not exists public.analysis_cases (
  id           bigint generated always as identity primary key,
  title        text not null check (length(trim(title)) > 0),
  sample       boolean not null default false,              -- 예시 데이터로 만든 건인가
  -- 계산 조건 (settings). 입력 전에는 비어 있을 수 있다
  rpm_start    numeric check (rpm_start >= 0),
  rpm_end      numeric check (rpm_end >= 0),
  rpm_step     numeric check (rpm_step > 0),
  force_mode   text not null default 'const',                -- 차수별 상수 / RPM 연동 벡터 / RPM별 표 파일 (제약은 아래 1-1)
  force_unit   text not null default 'N',
  interp       text not null default 'linear' check (interp in ('linear', 'nearest', 'loglog')),  -- logic.js INTERP
  anti_ratio   numeric not null default 0.05 check (anti_ratio > 0 and anti_ratio < 1),         -- 반공진 경고 기준
  frf_warnings text[] not null default '{}',                -- FRF 표를 만들 때 나온 확인할 점
  owner_id     uuid not null default auth.uid(),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  constraint analysis_cases_rpm_range check (rpm_start is null or rpm_end is null or rpm_end >= rpm_start)
);
create index if not exists analysis_cases_owner_idx on public.analysis_cases (owner_id, created_at desc);

-- 1-1. 2026-09-29 수강생 추가 요청 — scale factor · RPM 연동 벡터 · 추정 방식
--  이미 만든 표에도 붙도록 add column if not exists, 제약은 지우고 다시 건다(재실행 안전)
alter table public.analysis_cases add column if not exists scale_on     boolean not null default false;  -- 차수별 scale factor 사용
alter table public.analysis_cases add column if not exists ref_order    numeric;                         -- 기준 차수
alter table public.analysis_cases add column if not exists force_vector jsonb not null default '[]'::jsonb; -- settings.vectorRows [{rpm, v:{차수: 값}}]
alter table public.analysis_cases add column if not exists est_mode     text not null default 'each';   -- 추정 방식
alter table public.analysis_cases add column if not exists poly_degree  int  not null default 1;        -- 다항식 차수
alter table public.analysis_cases drop constraint if exists analysis_cases_force_mode_check;
alter table public.analysis_cases add constraint analysis_cases_force_mode_check check (force_mode in ('const', 'vector', 'table'));
alter table public.analysis_cases drop constraint if exists analysis_cases_ref_order_check;
alter table public.analysis_cases add constraint analysis_cases_ref_order_check check (ref_order is null or ref_order > 0);
alter table public.analysis_cases drop constraint if exists analysis_cases_force_vector_check;
alter table public.analysis_cases add constraint analysis_cases_force_vector_check check (jsonb_typeof(force_vector) = 'array');
alter table public.analysis_cases drop constraint if exists analysis_cases_est_mode_check;
alter table public.analysis_cases add constraint analysis_cases_est_mode_check check (est_mode in ('each', 'scale', 'poly'));
alter table public.analysis_cases drop constraint if exists analysis_cases_poly_degree_check;
alter table public.analysis_cases add constraint analysis_cases_poly_degree_check check (poly_degree between 0 and 5);

-- 1-2. 2026-09-29 오후 — 추정 비교 대상·오차 기준·오차 단위. 계측 표 형식(가로·지점별 시트·긴 형식)과
--      열 배정은 case_files.map(jsonb) 에 {format, rpmCol, wide:{…}, sheets:{…}} 로 들어가 칼럼이 필요 없다
alter table public.analysis_cases add column if not exists est_objective text not null default 'order';  -- 차수별 / overall 오차
alter table public.analysis_cases add column if not exists est_crit      text not null default 'mean';   -- 평균값 / 최대값
alter table public.analysis_cases add column if not exists est_err_scale text not null default 'abs';    -- 절대 / 상대오차
alter table public.analysis_cases drop constraint if exists analysis_cases_est_objective_check;
alter table public.analysis_cases add constraint analysis_cases_est_objective_check check (est_objective in ('order', 'overall'));
alter table public.analysis_cases drop constraint if exists analysis_cases_est_crit_check;
alter table public.analysis_cases add constraint analysis_cases_est_crit_check check (est_crit in ('mean', 'max'));
alter table public.analysis_cases drop constraint if exists analysis_cases_est_err_scale_check;
alter table public.analysis_cases add constraint analysis_cases_est_err_scale_check check (est_err_scale in ('abs', 'rel'));

-- 불러온 파일 — 한 건에 종류별로 하나 (frfFile · forceFile · measFile)
--  sheets 는 엑셀 시트 내용을 그대로 담는다({시트명: [[셀…]…]}). 파일이 커서
--  localStorage 에 못 담기던 것이 이 도구가 DB 를 가장 필요로 하는 이유다.
create table if not exists public.case_files (
  id          bigint generated always as identity primary key,
  case_id     bigint not null references public.analysis_cases (id) on delete cascade,
  kind        text not null check (kind in ('frf', 'force', 'meas')),
  source      text not null default 'file' check (source in ('file', 'estimate')),  -- 'estimate' = 4단계 추정값에서 온 가진력 표
  name        text not null check (length(trim(name)) > 0),
  sheet_names text[] not null default '{}',
  sheet       text,                                         -- 고른 시트
  header_row  int not null default 0 check (header_row >= 0),
  sheets      jsonb not null default '{}'::jsonb check (jsonb_typeof(sheets) = 'object'),
  -- 열 지정: frf = {freqCol, format, points:[{name,a,b,unit}]} (frfMap)
  --          force = {rpmCol, orderCols:[{order,col}]}      (forceFile.map)
  --          meas = {rpmCol, orderCol, pointCols:{…}}         (measMap)
  map         jsonb not null default '{}'::jsonb check (jsonb_typeof(map) = 'object'),
  owner_id    uuid not null default auth.uid(),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  -- 'estimate' 는 가진력 표에만 있다
  constraint case_files_estimate_is_force check (source = 'file' or kind = 'force'),
  -- ⚠ 프런트에서 upsert 할 때 onConflict 를 'case_id,kind' 로 반드시 지정할 것
  constraint case_files_case_kind_key unique (case_id, kind)
);

-- FRF 표 — 응답점마다 한 행. freq·mag 는 같은 길이의 배열 (도구의 frf.freq, points[i].mag)
--  |FRF| 를 보간하려면 주파수가 2개 이상이어야 한다(buildFrf 와 같은 규칙).
--  mag 의 빈 칸(숫자가 아닌 값)은 null 로 둔다.
create table if not exists public.frf_points (
  id         bigint generated always as identity primary key,
  case_id    bigint not null references public.analysis_cases (id) on delete cascade,
  point_no   int not null check (point_no >= 0),            -- 응답점 순서
  name       text not null check (length(trim(name)) > 0),
  unit       text not null default '',                      -- 예: Pa/N
  freq       double precision[] not null,                   -- Hz, 오름차순
  mag        double precision[] not null,                   -- |FRF|
  owner_id   uuid not null default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint frf_points_len check (cardinality(freq) >= 2 and cardinality(freq) = cardinality(mag)),
  constraint frf_points_case_no_key   unique (case_id, point_no),
  constraint frf_points_case_name_key unique (case_id, name)
);

-- 차수 목록 — 도구 필드 `order` 는 SQL 예약어라 order_no 로 적는다
create table if not exists public.case_orders (
  id         bigint generated always as identity primary key,
  case_id    bigint not null references public.analysis_cases (id) on delete cascade,
  order_no   numeric not null check (order_no > 0),         -- 회전 차수 (1, 2, 0.5 …)
  force      numeric,                                       -- 차수별 상수 가진력 (force_mode='const' 일 때)
  owner_id   uuid not null default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- ⚠ 프런트에서 upsert 할 때 onConflict 를 'case_id,order_no' 로 반드시 지정할 것
  constraint case_orders_case_order_key unique (case_id, order_no)
);

-- RPM × 차수 가진력 표 — 도구의 forceTable {rpm:[…], byOrder:{차수:[…]}} 을 한 칸 = 한 행으로 편다
create table if not exists public.force_table_values (
  id         bigint generated always as identity primary key,
  case_id    bigint not null references public.analysis_cases (id) on delete cascade,
  rpm        numeric not null check (rpm >= 0),
  order_no   numeric not null check (order_no > 0),
  force      numeric,                                       -- 빈 칸은 null
  owner_id   uuid not null default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- ⚠ 프런트에서 upsert 할 때 onConflict 를 'case_id,rpm,order_no' 로 반드시 지정할 것
  constraint force_table_values_key unique (case_id, rpm, order_no)
);

-- 차수별 scale factor (settings.orders[].scale) — 기준 차수 대비 비율로 쓴다
alter table public.case_orders add column if not exists scale numeric;
alter table public.case_orders drop constraint if exists case_orders_scale_check;
alter table public.case_orders add constraint case_orders_scale_check check (scale is null or scale > 0);

-- ----------------------------------------------------------------------------
-- 2. 함수 — search_path 고정
-- ----------------------------------------------------------------------------

-- updated_at 자동 갱신
create or replace function public.set_updated_at()
returns trigger language plpgsql set search_path = public as $fn$
begin
  new.updated_at := now();
  return new;
end;
$fn$;

do $trg$
declare t text;
begin
  foreach t in array array['analysis_cases','case_files','frf_points','case_orders','force_table_values']
  loop
    execute format('drop trigger if exists %I on public.%I', t || '_updated_at', t);
    execute format('create trigger %I before update on public.%I for each row execute function public.set_updated_at()',
                   t || '_updated_at', t);
  end loop;
end;
$trg$;

-- ----------------------------------------------------------------------------
-- 3. RLS — 본인 행만 보고 쓴다. 비로그인(anon)은 정책이 없어 아무것도 못 한다
--
--  하위 표(case_files 등)는 owner_id 가 본인이어야 할 뿐 아니라, 붙이려는 해석 건도
--  본인 것이어야 한다. 그렇지 않으면 남의 case_id 를 알아내 거기에 행을 끼워 넣을 수 있다.
--  (정책 안의 analysis_cases 조회에도 RLS 가 걸리므로 본인 건만 보인다)
-- ----------------------------------------------------------------------------

alter table public.analysis_cases     enable row level security;
alter table public.case_files         enable row level security;
alter table public.frf_points         enable row level security;
alter table public.case_orders        enable row level security;
alter table public.force_table_values enable row level security;

drop policy if exists analysis_cases_read   on public.analysis_cases;
drop policy if exists analysis_cases_insert on public.analysis_cases;
drop policy if exists analysis_cases_update on public.analysis_cases;
drop policy if exists analysis_cases_delete on public.analysis_cases;
create policy analysis_cases_read   on public.analysis_cases for select to authenticated
  using (owner_id = auth.uid());
create policy analysis_cases_insert on public.analysis_cases for insert to authenticated
  with check (owner_id = auth.uid());
create policy analysis_cases_update on public.analysis_cases for update to authenticated
  using (owner_id = auth.uid()) with check (owner_id = auth.uid());
create policy analysis_cases_delete on public.analysis_cases for delete to authenticated
  using (owner_id = auth.uid());

do $rls$
declare
  t text;
  v_own text := 'owner_id = auth.uid() and exists (select 1 from public.analysis_cases c '
                'where c.id = case_id and c.owner_id = auth.uid())';
begin
  foreach t in array array['case_files','frf_points','case_orders','force_table_values']
  loop
    execute format('drop policy if exists %I on public.%I', t || '_read',   t);
    execute format('drop policy if exists %I on public.%I', t || '_insert', t);
    execute format('drop policy if exists %I on public.%I', t || '_update', t);
    execute format('drop policy if exists %I on public.%I', t || '_delete', t);
    execute format('create policy %I on public.%I for select to authenticated using (owner_id = auth.uid())',
                   t || '_read', t);
    execute format('create policy %I on public.%I for insert to authenticated with check (%s)',
                   t || '_insert', t, v_own);
    execute format('create policy %I on public.%I for update to authenticated using (owner_id = auth.uid()) with check (%s)',
                   t || '_update', t, v_own);
    execute format('create policy %I on public.%I for delete to authenticated using (owner_id = auth.uid())',
                   t || '_delete', t);
  end loop;
end;
$rls$;

-- ----------------------------------------------------------------------------
-- 4. 함수 실행 권한
--
--  ⚠ GRANT 만으로는 제한되지 않는다. PostgreSQL 이 PUBLIC 에, Supabase 가
--    anon·authenticated·service_role 에 EXECUTE 를 미리 붙이므로 둘 다 끊는다.
--  트리거 전용 함수는 authenticated 를 남긴다(직접 호출하면 "can only be called
--  as trigger" 로 죽어 무해하다).
-- ----------------------------------------------------------------------------

revoke all on function public.set_updated_at() from public, anon;
grant execute on function public.set_updated_at() to authenticated;
