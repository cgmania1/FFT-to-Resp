-- ============================================================================
-- 로컬 검증 전용 — data09-04 프로젝트별 검증 (운영 실행 금지, 가드 내장)
--
--  역할 전환으로 실제 사용자처럼 질의한다.
--    set role authenticated + request.jwt.claim.sub = 사용자 uuid  → auth.uid()
--    set role anon                                                   → 비로그인
-- ============================================================================
do $guard$
begin
  if exists (select 1 from pg_roles where rolname in ('supabase_admin', 'authenticator'))
     or exists (select 1 from pg_namespace where nspname = 'graphql') then
    raise exception '이 파일은 로컬 검증 전용입니다. 운영 데이터베이스에서 실행할 수 없습니다.';
  end if;
end;
$guard$;

do $t$ begin raise notice '[프로젝트] data09-04 — 재실행 · 제약 · RLS · 함수 권한'; end $t$;

-- ── 0. 재실행 안전 (run.sh 가 schema.sql 을 두 번 적용한 뒤다) ──────────────
do $t$
declare v_n int;
begin
  perform public._assert_eq(
    (select count(*)::int from pg_tables where schemaname = 'public'
      and tablename in ('analysis_cases','case_files','frf_points','case_orders','force_table_values')),
    5, '표 5개가 한 번씩만 있다 (두 번 적용 후)');
  select count(*) into v_n from pg_trigger t where not t.tgisinternal and t.tgname like '%\_updated\_at';
  perform public._assert_eq(v_n, 5, 'updated_at 트리거가 표마다 하나씩 (중복 생성 없음)');
  select count(*) into v_n from pg_policy p join pg_class c on c.oid = p.polrelid
   where c.relnamespace = 'public'::regnamespace;
  perform public._assert_eq(v_n, 20, '정책이 표마다 4개씩, 중복 없이 20개');
end $t$;

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-00000000000a', 'a@example.com'),
  ('00000000-0000-0000-0000-00000000000b', 'b@example.com')
on conflict (id) do nothing;

-- ── 1. 사용자 A ──────────────────────────────────────────────────────────
set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000a';

do $t$
declare v_case bigint; v_raised boolean;
begin
  insert into public.analysis_cases (title, rpm_start, rpm_end, rpm_step, force_mode, interp)
  values ('A 의 해석', 800, 2800, 50, 'table', 'linear') returning id into v_case;
  insert into public.case_files (case_id, kind, name, sheet_names, sheet, sheets, map)
  values (v_case, 'frf', 'frf.xlsx', array['Sheet1'], 'Sheet1',
          '{"Sheet1": [["Freq(Hz)", "P1"], [10, 0.1], [20, 0.2]]}',
          '{"freqCol": 0, "format": "mag", "points": [{"name": "P1", "a": 1, "b": -1, "unit": ""}]}');
  insert into public.frf_points (case_id, point_no, name, unit, freq, mag)
  values (v_case, 0, 'P1', 'Pa/N', array[10, 20, 30], array[0.1, null, 0.3]);
  insert into public.case_orders (case_id, order_no, force) values (v_case, 1, 100), (v_case, 2, 50);
  insert into public.force_table_values (case_id, rpm, order_no, force)
  values (v_case, 800, 1, 100), (v_case, 800, 2, null), (v_case, 850, 1, 110);

  v_raised := false;
  begin insert into public.analysis_cases (title, interp) values ('X', 'cubic');
  exception when check_violation then v_raised := true; end;
  perform public._assert(v_raised, '보간 방식은 linear·nearest·loglog 만 (CHECK)');

  v_raised := false;
  begin insert into public.analysis_cases (title, force_mode) values ('X', 'file');
  exception when check_violation then v_raised := true; end;
  perform public._assert(v_raised, '가진력 입력은 const·vector·table 만 (CHECK)');

  -- 2026-09-29 — RPM 연동 벡터 · scale factor · 추정 방식
  insert into public.analysis_cases (title, force_mode, scale_on, ref_order, force_vector, est_mode, poly_degree)
  values ('벡터', 'vector', true, 2, '[{"rpm": 800, "v": {"2": 60}}]', 'poly', 3);
  insert into public.case_orders (case_id, order_no, scale)
  select id, 3, 0.2 from public.analysis_cases where title = '벡터';

  v_raised := false;
  begin insert into public.analysis_cases (title, est_mode) values ('X', 'nn');
  exception when check_violation then v_raised := true; end;
  perform public._assert(v_raised, '추정 방식은 each·scale·poly 만 (CHECK)');

  v_raised := false;
  begin insert into public.analysis_cases (title, poly_degree) values ('X', 6);
  exception when check_violation then v_raised := true; end;
  perform public._assert(v_raised, '다항식 차수는 0~5 (CHECK)');

  v_raised := false;
  begin insert into public.analysis_cases (title, force_vector) values ('X', '{"rpm": 1}');
  exception when check_violation then v_raised := true; end;
  perform public._assert(v_raised, 'RPM 연동 벡터는 배열 (CHECK)');

  v_raised := false;
  begin insert into public.case_orders (case_id, order_no, scale) values (v_case, 5, 0);
  exception when check_violation then v_raised := true; end;
  perform public._assert(v_raised, 'scale factor 는 0 보다 커야 한다 (CHECK)');
  perform public._assert_eq((select scale from public.case_orders where order_no = 3), 0.2::numeric, 'scale factor 가 저장된다');

  -- 2026-09-29 오후 — 비교 대상·오차 기준·오차 단위
  update public.analysis_cases set est_objective = 'overall', est_crit = 'max', est_err_scale = 'rel' where title = '벡터';
  v_raised := false;
  begin insert into public.analysis_cases (title, est_crit) values ('X', 'median');
  exception when check_violation then v_raised := true; end;
  perform public._assert(v_raised, '오차 기준은 mean·max 만 (CHECK)');
  v_raised := false;
  begin insert into public.analysis_cases (title, est_objective) values ('X', 'db');
  exception when check_violation then v_raised := true; end;
  perform public._assert(v_raised, '비교 대상은 order·overall 만 (CHECK)');
  delete from public.analysis_cases where title = '벡터';   -- 아래 개수 검증에 섞이지 않게 (차수 행은 cascade)

  v_raised := false;
  begin insert into public.analysis_cases (title, rpm_start, rpm_end) values ('X', 3000, 1000);
  exception when check_violation then v_raised := true; end;
  perform public._assert(v_raised, 'RPM 끝이 시작보다 작으면 CHECK 가 막는다');

  v_raised := false;
  begin insert into public.analysis_cases (title, rpm_step) values ('X', 0);
  exception when check_violation then v_raised := true; end;
  perform public._assert(v_raised, 'RPM 간격은 0 보다 커야 한다 (CHECK)');

  v_raised := false;
  begin insert into public.analysis_cases (title, anti_ratio) values ('X', 1.5);
  exception when check_violation then v_raised := true; end;
  perform public._assert(v_raised, '반공진 경고 기준은 0~1 사이 (CHECK)');

  v_raised := false;
  begin insert into public.case_files (case_id, kind, name) values (v_case, 'frf', 'again.xlsx');
  exception when unique_violation then v_raised := true; end;
  perform public._assert(v_raised, '한 건에 FRF 파일은 하나 (UNIQUE case_id,kind)');

  v_raised := false;
  begin insert into public.case_files (case_id, kind, name) values (v_case, 'erp', 'erp.xlsx');
  exception when check_violation then v_raised := true; end;
  perform public._assert(v_raised, '파일 종류는 frf·force·meas 만 (CHECK)');

  v_raised := false;
  begin insert into public.case_files (case_id, kind, source, name) values (v_case, 'meas', 'estimate', '추정');
  exception when check_violation then v_raised := true; end;
  perform public._assert(v_raised, '「추정값에서 온 파일」은 가진력 표에만 (CHECK)');

  v_raised := false;
  begin insert into public.frf_points (case_id, point_no, name, freq, mag)
        values (v_case, 1, 'P2', array[10, 20], array[0.1]);
  exception when check_violation then v_raised := true; end;
  perform public._assert(v_raised, 'FRF 주파수·크기 배열 길이가 다르면 CHECK 가 막는다');

  v_raised := false;
  begin insert into public.frf_points (case_id, point_no, name, freq, mag)
        values (v_case, 1, 'P2', array[10], array[0.1]);
  exception when check_violation then v_raised := true; end;
  perform public._assert(v_raised, 'FRF 주파수가 2개 미만이면 CHECK 가 막는다 (보간 불가)');

  v_raised := false;
  begin insert into public.frf_points (case_id, point_no, name, freq, mag)
        values (v_case, 1, 'P1', array[10, 20], array[0.1, 0.2]);
  exception when unique_violation then v_raised := true; end;
  perform public._assert(v_raised, '한 건 안에서 응답점 이름은 겹칠 수 없다 (UNIQUE)');

  v_raised := false;
  begin insert into public.case_orders (case_id, order_no) values (v_case, 0);
  exception when check_violation then v_raised := true; end;
  perform public._assert(v_raised, '차수는 0 보다 커야 한다 (CHECK)');

  v_raised := false;
  begin insert into public.force_table_values (case_id, rpm, order_no, force) values (v_case, 800, 1, 999);
  exception when unique_violation then v_raised := true; end;
  perform public._assert(v_raised, '같은 RPM·차수 가진력은 하나 (UNIQUE)');
end $t$;

-- ── 2. 사용자 B — A 의 자료를 못 보고, 못 고치고, A 의 건에 끼워 넣지 못한다 ───
-- B 가 A 의 case_id 를 어떻게든 알아냈다고 가정한다 (postgres 로 읽어 전달)
reset role;
select set_config('test.a_case', (select id::text from public.analysis_cases where title = 'A 의 해석'), false) \gset
set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000b';
do $t$
declare v_n int; v_raised boolean; v_t text; v_a_case bigint;
begin
  foreach v_t in array array['analysis_cases','case_files','frf_points','case_orders','force_table_values']
  loop
    execute format('select count(*)::int from public.%I', v_t) into v_n;
    perform public._assert_eq(v_n, 0, 'B 는 A 의 ' || v_t || ' 을 못 본다');
  end loop;

  update public.analysis_cases set title = '조작';
  get diagnostics v_n = row_count;
  perform public._assert_eq(v_n, 0, 'B 는 A 의 해석 건을 고칠 수 없다');
  delete from public.frf_points;
  get diagnostics v_n = row_count;
  perform public._assert_eq(v_n, 0, 'B 는 A 의 FRF 표를 지울 수 없다');

  v_a_case := current_setting('test.a_case')::bigint;
  perform public._assert(v_a_case is not null, 'A 의 case_id 를 넘겨받았다');
  v_raised := false;
  begin insert into public.case_orders (case_id, order_no, force) values (v_a_case, 3, 1);
  exception when insufficient_privilege then v_raised := true; end;
  perform public._assert(v_raised, 'B 는 자기 owner_id 로라도 A 의 해석 건에 행을 붙일 수 없다');

  v_raised := false;
  begin insert into public.analysis_cases (title, owner_id) values ('남의 이름', '00000000-0000-0000-0000-00000000000a');
  exception when insufficient_privilege then v_raised := true; end;
  perform public._assert(v_raised, 'B 는 남의 owner_id 로 행을 만들 수 없다');
end $t$;

-- A 의 건은 그대로다
set request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000a';
do $t$
declare v_before timestamptz; v_after timestamptz;
begin
  perform public._assert_eq((select count(*) from public.case_orders), 2::bigint,
    'A 의 차수 목록은 B 의 시도 뒤에도 2개 그대로');
  perform public._assert_eq((select title from public.analysis_cases), 'A 의 해석', 'A 의 해석 건 제목이 그대로');
  select updated_at into v_before from public.analysis_cases;
  perform pg_sleep(0.01);
  update public.analysis_cases set interp = 'loglog';
  select updated_at into v_after from public.analysis_cases;
  perform public._assert(v_after > v_before, 'updated_at 트리거가 수정 시각을 갱신한다');
  -- 건을 지우면 하위 자료도 함께 지워진다
  delete from public.analysis_cases;
  perform public._assert_eq((select count(*) from public.force_table_values), 0::bigint,
    '해석 건을 지우면 가진력 표도 함께 지워진다 (on delete cascade)');
end $t$;

-- ── 3. 비로그인(anon) ─────────────────────────────────────────────────────
reset role;
set role anon;
set request.jwt.claim.sub = '';
do $t$
declare v_ok boolean; v_raised boolean := false; v_t text;
begin
  foreach v_t in array array['analysis_cases','case_files','frf_points','case_orders','force_table_values']
  loop
    execute format('select count(*) = 0 from public.%I', v_t) into v_ok;
    perform public._assert(v_ok, 'anon 은 ' || v_t || ' 을 한 행도 못 본다');
  end loop;
  begin
    insert into public.analysis_cases (title, owner_id) values ('anon', '00000000-0000-0000-0000-00000000000a');
  exception when insufficient_privilege then v_raised := true; end;
  perform public._assert(v_raised, 'anon 은 쓸 수 없다');
end $t$;
reset role;

-- anon 이 "못 본다" 가 빈 표라서 통과한 것이 아님을 확인한다 (postgres 로 행을 넣고 다시 본다)
insert into public.analysis_cases (title, owner_id) values ('anon 확인용', '00000000-0000-0000-0000-00000000000a');
set role anon;
do $t$ begin
  perform public._assert_eq((select count(*) from public.analysis_cases), 0::bigint,
    'anon 은 행이 있어도 해석 건을 못 본다');
end $t$;
reset role;

-- ── 4. 함수 ACL — PUBLIC·anon 에 EXECUTE 가 없다 (proacl 직접 확인) ───────────
--    함수는 트리거 함수 하나뿐이고, 정책 식은 함수 대신 EXISTS 하위 질의를 쓰므로
--    anon 예외가 없다.
do $t$
declare v_bad text;
begin
  select string_agg(p.proname, ', ') into v_bad
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    cross join lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
   where n.nspname = 'public' and p.proname not like '\_assert%'
     and a.privilege_type = 'EXECUTE'
     and (a.grantee = 0 or a.grantee = 'anon'::regrole);
  perform public._assert(v_bad is null,
    'proacl 에 PUBLIC·anon EXECUTE 가 없다' || coalesce(' (발견: ' || v_bad || ')', ''));
  perform public._assert(
    (select proconfig @> array['search_path=public'] from pg_proc where proname = 'set_updated_at'),
    'set_updated_at 의 search_path=public 고정');
end $t$;

do $t$ begin raise notice ''; raise notice '전부 통과했습니다.'; end $t$;
