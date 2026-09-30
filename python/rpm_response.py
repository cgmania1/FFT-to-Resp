"""RPM별 응답 계산 — 웹 도구(js/logic.js)와 같은 계산을 파이썬 표준 라이브러리만으로 합니다.

웹 도구 결과를 교차 확인하거나 코랩에서 같은 계산을 돌려 보는 용도입니다.

  가진 주파수 f = 차수 × RPM / 60 (Hz)          (가정: 회전 차수 기준)
  차수 성분     = |FRF(f)| × 가진력               (원문 참고 1)
  overall       = √(Σ 차수 성분²)                 (원문 참고 2, RSS)

실행 예:
  python3 python/rpm_response.py samples/예시데이터_FRF.csv \
      --orders 1,2,4 --forces 120,60,25 --rpm 800 3000 100 --point 예시_운전석바닥_진동

입력 CSV: 첫 행이 머리행, 첫 열이 주파수(Hz).
응답점 열은 「이름」(크기만) / 「이름 Mag」+「이름 Phase」 / 「이름 Real」+「이름 Imag」 중 하나로 찾습니다.
결과는 CSV 로 표준출력에 씁니다(마지막 열이 overall).

가진력 입력 (2026-09-29 추가, 웹 도구 2. 계산 조건과 같음)
  --forces 120,60,25                      차수별 상수
  --scales 1,0.5,0.2 --ref-order 1 --forces 120
                                          scale factor: 기준 차수 하나만 넣으면 F_k = (s_k/s_기준) × F_기준
  --force-vector 벡터.csv                 RPM 연동 벡터: 열 = RPM, 차수별 가진력(--orders 순서).
                                          --scales 를 함께 주면 열 = RPM, 기준 차수 가진력 두 개만.

가진력 추정 (2026-09-29 추가, 웹 도구 4. 가진력 추정과 같음 — 계산/계측 오차 최소화)
  python3 python/rpm_response.py samples/예시데이터_FRF.csv --point 응답점1,응답점2 \
      --estimate samples/예시데이터_계측응답.csv --degree 1          차수별 1차 다항식 계수
  ... --estimate 계측.csv --orders 1,2,4 --scales 1,0.5,0.2 --ref-order 1
                                          scale 고정: 기준 차수의 RPM별 크기
  계측 CSV: 열 = RPM, 차수, 응답점 이름… (웹 도구의 예시 계측 표와 같은 형식)

머리행 규칙 (2026-09-29 저녁 확정)
  지점 이름은 파일에 있는 그대로 FRF 응답점 이름과 맞춥니다(다르면 --alias 파일이름=FRF이름;…).
  차수: 1차·2차 기본 + 1·2, 1st·2nd·3rd·4th, 1X·1x, H1, order 1·1st order·Ord1·1ord·ord1(1/rev 는 쓰지 않음 — 거부), 전각 숫자, 공백·대소문자 무시.
  알아보지 못한 머리행은 쓰지 않고 표준오류에 이유를 적습니다.
"""
import argparse
import csv
import math
import re
import sys
import unicodedata


def read_frf(path, point):
    with open(path, encoding="utf-8-sig", newline="") as fp:
        rows = list(csv.reader(fp))
    head = [h.strip() for h in rows[0]]

    def col(name):
        return head.index(name) if name in head else -1

    if col(point) >= 0:
        fmt, a, b = "mag", col(point), -1
    elif col(point + " Mag") >= 0:
        fmt, a, b = "magphase", col(point + " Mag"), col(point + " Phase")
    elif col(point + " Real") >= 0:
        fmt, a, b = "reim", col(point + " Real"), col(point + " Imag")
    else:
        sys.exit("응답점 열을 찾지 못했습니다: " + point)
    recs = {}
    for r in rows[1:]:
        try:
            f = float(r[0])
            va = float(r[a])
            vb = float(r[b]) if b >= 0 else 0.0
        except (ValueError, IndexError):
            continue
        if f in recs:
            continue  # 같은 주파수는 처음 값만 (웹 도구와 같음)
        recs[f] = math.hypot(va, vb) if fmt == "reim" else abs(va)
    freq = sorted(recs)
    return freq, [recs[f] for f in freq]


def interpolate(freq, vals, f, method="linear"):
    if not (freq[0] <= f <= freq[-1]):
        return None
    lo, hi = 0, len(freq) - 1
    while hi - lo > 1:
        mid = (lo + hi) // 2
        if freq[mid] <= f:
            lo = mid
        else:
            hi = mid
    if freq[lo] == f:
        return vals[lo]
    if freq[hi] == f:
        return vals[hi]
    f0, f1, v0, v1 = freq[lo], freq[hi], vals[lo], vals[hi]
    if method == "nearest":
        return v0 if f - f0 <= f1 - f else v1
    t = (f - f0) / (f1 - f0)
    if method == "loglog" and f0 > 0 and v0 > 0 and v1 > 0:
        tl = math.log(f / f0) / math.log(f1 / f0)
        return math.exp(math.log(v0) + tl * (math.log(v1) - math.log(v0)))
    return v0 + t * (v1 - v0)


def rpm_list(start, end, step):
    n = int(math.floor((end - start) / step + 1e-9)) + 1
    out = [round(start + i * step, 9) for i in range(n)]
    if round(out[-1], 6) < round(end, 6):
        out.append(end)
    return out


def scale_ratios(orders, scales, ref):
    """F_k = (s_k / s_ref) × F_ref 의 비 s_k / s_ref"""
    if len(scales) != len(orders):
        sys.exit("차수와 scale factor 개수가 다릅니다.")
    if ref not in orders:
        sys.exit("기준 차수가 차수 목록에 없습니다.")
    if any(s <= 0 for s in scales):
        sys.exit("scale factor 는 0 보다 커야 합니다.")
    sref = scales[orders.index(ref)]
    return {k: s / sref for k, s in zip(orders, scales)}


def read_force_vector(path, keys):
    """RPM 연동 가진력 벡터 CSV → (rpm 오름차순, {차수: [값…]}). 숫자가 아닌 머리행은 건너뜁니다."""
    with open(path, encoding="utf-8-sig", newline="") as fp:
        recs = []
        for r in csv.reader(fp):
            try:
                recs.append((float(r[0]), [float(r[j + 1]) for j in range(len(keys))]))
            except (ValueError, IndexError):
                continue
    recs.sort()
    return [r for r, _ in recs], {k: [v[j] for _, v in recs] for j, k in enumerate(keys)}


# ── 최소제곱 (Householder QR) — js/logic.js 의 lstsq 와 같은 방법 ─────────────
def lstsq(A, b):
    m, n = len(A), len(A[0])
    if m < n:
        return None
    R = [row[:] for row in A]
    y = b[:]
    for j in range(n):
        norm = math.sqrt(sum(R[i][j] ** 2 for i in range(j, m)))
        if norm == 0:
            continue
        alpha = -norm if R[j][j] > 0 else norm
        v = [R[i][j] for i in range(j, m)]
        v[0] -= alpha
        vn = sum(t * t for t in v)
        if vn == 0:
            continue
        for c in range(j, n):
            s = 2 * sum(v[i - j] * R[i][c] for i in range(j, m)) / vn
            for i in range(j, m):
                R[i][c] -= s * v[i - j]
        s = 2 * sum(v[i - j] * y[i] for i in range(j, m)) / vn
        for i in range(j, m):
            y[i] -= s * v[i - j]
    maxd = max(abs(R[j][j]) for j in range(n))
    if any(not abs(R[j][j]) > 1e-10 * maxd for j in range(n)):
        return None
    x = [0.0] * n
    for j in range(n - 1, -1, -1):
        x[j] = (y[j] - sum(R[j][c] * x[c] for c in range(j + 1, n))) / R[j][j]
    return x


def _read_csv(path):
    with open(path, encoding="utf-8-sig", newline="") as fp:
        return list(csv.reader(fp))


def _num(v):
    try:
        return float(str(v).replace(",", "").strip())
    except ValueError:
        return None


# ── 차수 표기 정규화 (2026-09-29 저녁 — 웹 도구 parseOrderLabel·splitMeasHeader 와 같은 규칙) ──
# 지점 이름은 파일 그대로, 차수는 1차·2차 기본 + 1·2, 1st·2nd, 1X, H1, order 1, Ord1, 1ord, ord1, 전각 숫자, 공백·대소문자 무시.
# 모르는 표기는 추측하지 않고 이유를 돌려줍니다(웹 화면은 「열 배정 확인」 표에 표시, 여기서는 표준오류로 알림).
GENERIC = "차수 표기를 알아보지 못했습니다"
# 「1/rev」 표기는 쓰지 않는다고 확인됨(2026-09-30 수강생 답변) — 차수로 읽지 않고 이유를 알림(웹과 같은 규칙).
# 머리행에서는 「/」가 구분자라 따로 막지 않으면 「1/rev」가 「1」(차수) + 「rev」(지점)로 잘못 갈라진다.
RE_PER_REV = re.compile(r"^\d+(?:\.\d+)?\s*(?:/|per)\s*rev(?:olutions?|s)?\.?$")
RE_PER_REV_IN = re.compile(r"\d\s*(?:/|per)\s*rev(?:olutions?|s)?(?![a-z])")
REV_REASON = "「n/rev」 표기는 쓰지 않는 것으로 확인했습니다(2026-09-30) — 1ord · ord1 · 1차 처럼 적거나 표에서 차수를 직접 골라 주십시오"
BARE_MAX = 200
SEP = r"\s_\-/|:·＿－／"
RE_EDGE = re.compile("^[" + SEP + "]+|[" + SEP + "]+$")
RE_SEPC = re.compile("[" + SEP + "]")


def _norm_label(t):
    s = unicodedata.normalize("NFKC", "" if t is None else str(t))
    s = re.sub(r"[\u00a0\u3000\s]+", " ", s).strip().lower()
    while True:
        u = re.sub(r"\s*(\([^()]*\)|\[[^\[\]]*\]|\{[^{}]*\})\s*$", "", s)
        if u == s or not u:
            break
        s = u.strip()
    w = re.match(r"^[(\[{]\s*(.*?)\s*[)\]}]$", s)
    return w.group(1) if w else s


def _ordinal_suffix(n):
    if 11 <= n % 100 <= 13:
        return "th"
    return {1: "st", 2: "nd", 3: "rd"}.get(n % 10, "th")


def parse_order_label(t):
    """차수 표기 하나 → (차수 | 'overall' | None, 형태 또는 거부 이유)"""
    s = _norm_label(t)
    if not s:
        return None, "빈 칸"
    if re.match(r"^(overall|o\.?\s?a\.?|전체|합성)$", s):
        return "overall", "overall"

    def num(v, form):
        k = float(v)
        return (k, form) if k > 0 else (None, "차수는 0보다 커야 합니다")

    m = re.match(r"^(\d+(?:\.\d+)?)\s*차(?:수)?$", s) or re.match(r"^차수\s*[_\-#:]?\s*(\d+(?:\.\d+)?)$", s)
    if m:
        return num(m.group(1), "kr")
    m = re.match(r"^(\d+)\s*(st|nd|rd|th)(?:[\s_\-]*(?:order|ord\.?|차))?$", s)
    if m:
        if _ordinal_suffix(int(m.group(1))) != m.group(2):
            return None, "서수 접미사가 맞지 않습니다(%s%s 이어야 함)" % (m.group(1), _ordinal_suffix(int(m.group(1))))
        return num(m.group(1), "ordinal")
    if RE_PER_REV.match(s):
        return None, REV_REASON
    m = re.match(r"^(\d+(?:\.\d+)?)\s*x$", s)
    if m:
        return num(m.group(1), "x")
    m = re.match(r"^h\s*[_\-]?\s*(\d+)$", s)
    if m:
        return num(m.group(1), "h")
    m = re.match(r"^(?:order|ord)\.?\s*[_\-#:]?\s*(\d+(?:\.\d+)?)$", s) or re.match(r"^(\d+(?:\.\d+)?)\s*[_\-]?\s*(?:order|ord)\.?$", s)
    if m:
        return num(m.group(1), "order")
    if re.match(r"^\d+(?:\.\d+)?$", s):
        if float(s) > BARE_MAX:
            return None, "숫자만 있는 머리행은 %d 이하만 차수로 봅니다" % BARE_MAX
        return num(s, "num")
    return None, GENERIC


def split_meas_header(h, points=()):
    """머리행 → (지점 이름(파일 그대로, 없으면 ''), 차수 | 'overall' | None, 이유)"""
    t = ("" if h is None else str(h)).strip()
    if not t:
        return "", None, "빈 칸"
    if RE_PER_REV_IN.search(_norm_label(t)):  # 「지점_1/rev」·「1/rev_지점」
        return t, None, REV_REASON
    whole = RE_EDGE.sub("", t)
    k, why = parse_order_label(whole)
    if k is not None:
        return "", k, why
    for p in sorted([p for p in points if p], key=len, reverse=True):
        rest = None
        if t.startswith(p):
            rest = t[len(p):]
        elif len(t) > len(p) and t.endswith(p):
            rest = t[:len(t) - len(p)]
        if rest is None:
            continue
        k, _ = parse_order_label(RE_EDGE.sub("", rest))
        if k is not None:
            return p, k, ""
    cut = [i for i, ch in enumerate(t) if RE_SEPC.match(ch)]
    reason = None
    for c in cut:
        head, tail = RE_EDGE.sub("", t[:c]), RE_EDGE.sub("", t[c + 1:])
        if not head or not tail:
            continue
        k, r = parse_order_label(tail)
        if k is not None:
            return head, k, ""
        if r != GENERIC:
            reason = r
    for c in reversed(cut):
        head, tail = RE_EDGE.sub("", t[:c]), RE_EDGE.sub("", t[c + 1:])
        if not head or not tail:
            continue
        k, _ = parse_order_label(head)
        if k is not None:
            return tail, k, ""
    return t, None, reason or parse_order_label(whole)[1]


def _cell_order(v):
    """긴 형식의 차수 칸: 1 · 1차 · 1st · H1 · 1X … (overall·모르는 표기는 None)"""
    k, _ = parse_order_label(v)
    return None if k == "overall" else k


def header_order(t):
    """머리행에서 차수 숫자만 (overall·모르는 표기는 None)"""
    _, k, _ = split_meas_header(t)
    return None if k == "overall" else k


def meas_map(head, points, orders, layout, alias=None, warn=None, fixed=None):
    """열 배정 [(열, 응답점, 차수|'overall')]. layout: order(차수 우선) / point(지점 우선) / header(머리행 이름)
    header: 지점 이름이 FRF 응답점과 같거나 alias 로 짝지은 열만 씀. 응답점이 하나면 지점 이름 없는 열은 그 응답점.
            fixed 를 주면(지점별 파일) 모든 열이 그 응답점."""
    if layout == "header":
        alias = alias or {}
        out = []
        for c, h in enumerate(head[1:], start=1):
            h = h.strip()
            if not h:
                continue
            pt_text, k, why = split_meas_header(h, points)
            if fixed:
                pt = fixed
            elif pt_text:
                pt = alias.get(pt_text) or (pt_text if pt_text in points else None)
            else:
                pt = points[0] if len(points) == 1 else None
            if k is None or pt is None:
                if warn is not None:
                    warn.append("%s열 「%s」: %s" % (c + 1, h, why if k is None else "지점 이름 「%s」와 같은 응답점이 없습니다(--alias 로 짝지어 주십시오)" % pt_text))
                continue
            if k == "overall" or orders is None or k in orders:
                out.append((c, pt, k))
        return out
    P, K = len(points), len(orders)
    out = []
    for j in range(P * K):
        pi, ki = (j // K, j % K) if layout == "point" else (j % P, j // P)
        out.append((1 + j, points[pi], orders[ki]))
    return out


def read_measured(path, points, fmt="long", layout="header", orders=None, alias=None, warn=None, fixed=None):
    """계측 CSV → [(rpm, 차수|'overall', 응답점, |계측|)] — 웹 도구 「계측 표 형식」과 같은 형식들
      long : RPM, 차수, 응답점…          wide : RPM, 값 열들 (layout 으로 배정, 첫 열 = RPM)
      files: path 가 쉼표로 여러 개 — points 순서대로 한 파일 = 한 지점 (RPM, 1차, 2차 …)"""
    out = []
    if fmt == "files":
        for p, one in zip(points, path.split(",")):
            out += read_measured(one, [p], "wide", layout, orders, alias, warn, fixed=p)
        return out
    rows = _read_csv(path)
    head = [h.strip() for h in rows[0]]
    if fmt == "long":
        cols = {p: head.index(p) for p in points if p in head}
        for r in rows[1:]:
            rpm, k = (_num(r[0]), _cell_order(r[1])) if len(r) > 1 else (None, None)
            if rpm is None or k is None:
                continue
            for p, c in cols.items():
                v = _num(r[c]) if c < len(r) else None
                if v is not None:
                    out.append((rpm, k, p, abs(v)))
        return out
    cmap = meas_map(head, points, orders, layout, alias, warn, fixed)
    for r in rows[1:]:
        rpm = _num(r[0]) if r else None
        if rpm is None:
            continue
        for c, p, k in cmap:
            v = _num(r[c]) if c < len(r) else None
            if v is not None:
                out.append((rpm, k, p, abs(v)))
    return out


# ── 오차 기준: 평균(최소제곱) / 최대(minimax — Lawson 반복 재가중) ──────────
def lawson(A, b, iters=400):
    m = len(A)
    w = [1.0 / m] * m
    scale = max(abs(v) for v in b) or 1.0
    best, best_max = None, float("inf")
    for _ in range(iters):
        sw = [math.sqrt(v) for v in w]
        x = lstsq([[v * sw[i] for v in row] for i, row in enumerate(A)], [v * sw[i] for i, v in enumerate(b)])
        if x is None:
            break
        r = [abs(sum(v * x[j] for j, v in enumerate(row)) - b[i]) for i, row in enumerate(A)]
        mx = max(r)
        if mx < best_max:
            best, best_max = x, mx
        if mx <= 1e-13 * scale:
            break
        tot = sum(wi * ri for wi, ri in zip(w, r))
        if not tot > 0:
            break
        w = [wi * ri / tot for wi, ri in zip(w, r)]
    return best


def solve_linear(A, b, crit):
    x = lstsq(A, b)
    return x if x is None or crit != "max" else lawson(A, b)


def levenberg(fun, beta, iters=300):
    r, J = fun(beta)
    cost = sum(v * v for v in r)
    lam, n = 1e-3, len(beta)
    it = 0
    while it < iters and cost > 0:
        it += 1
        D = [math.sqrt(max(sum(row[j] ** 2 for row in J), 1e-300)) for j in range(n)]
        A = J + [[math.sqrt(lam) * D[j] if c == j else 0.0 for c in range(n)] for j in range(n)]
        d = lstsq(A, [-v for v in r] + [0.0] * n)
        if d is None:
            lam *= 10
            if lam > 1e15:
                break
            continue
        nb = [v + d[j] for j, v in enumerate(beta)]
        nr, nJ = fun(nb)
        nc = sum(v * v for v in nr)
        if nc < cost:
            rel = (cost - nc) / cost
            beta, r, J, cost = nb, nr, nJ, nc
            lam = max(lam / 3, 1e-15)
            if rel < 1e-15:
                break
        else:
            lam *= 4
            if lam > 1e15:
                break
    return beta


def estimate(frfs, meas, interp, anti_ratio, degree=None, ratio=None, objective="order", crit="mean", rel=False, orders=None):
    """계산과 계측의 오차(평균 = 제곱 평균, 최대 = 최대 절대값)를 최소화. js/logic.js 의 estimateScaleFixed·estimatePoly 와 같은 계산.
      objective order  : 계산 = |H_p(k·RPM/60)| × F_k(RPM)
      objective overall: 계산 = √(Σ_k (|H_pk| × F_k)²)   (차수별 계측이면 계측 overall = √Σ m_k²)
    degree 가 있으면 차수별 다항식 계수, ratio 가 있으면 기준 차수의 RPM별 크기를 돌려줍니다."""
    kinds = {k == "overall" for _, k, _, _ in meas}
    if objective == "order" and True in kinds:
        sys.exit("계측이 overall 값뿐이면 --objective overall 로 맞춰 주십시오.")
    wt = (lambda m: 1.0 / m if m > 0 else 0.0) if rel else (lambda m: 1.0)
    obs = []  # order: (rpm, k, h, m) / overall: (rpm, {k: h}, M)
    if objective == "overall":
        if True in kinds:
            src = {(rpm, p): m for rpm, _, p, m in meas}
            ks = sorted(orders)
        else:
            ks = sorted({k for _, k, _, _ in meas})
            g = {}
            for rpm, k, p, m in meas:
                g.setdefault((rpm, p), {})[k] = m
            src = {key: math.sqrt(sum(v * v for v in d.values())) for key, d in g.items() if all(k in d for k in ks)}
        for (rpm, p), M in sorted(src.items()):
            freq, mag = frfs[p]
            hs = {k: interpolate(freq, mag, k * rpm / 60.0, interp) for k in ks}
            if all(h is not None for h in hs.values()) and wt(M) > 0:
                obs.append((rpm, hs, M))
    else:
        for rpm, k, p, m in meas:
            freq, mag = frfs[p]
            h = interpolate(freq, mag, k * rpm / 60.0, interp)
            if h is None or not h > 0 or h < anti_ratio * max(mag):
                continue  # 범위 밖·반공진 부근은 맞춤에서 뺌 (웹 도구와 같음)
            obs.append((rpm, k, h, m))
        ks = sorted({o[1] for o in obs})
    if ratio is not None:
        res = {}
        for rpm in sorted({o[0] for o in obs}):
            A, b = [], []
            for o in obs:
                if o[0] != rpm:
                    continue
                if objective == "overall":
                    a, m = math.sqrt(sum((o[1][k] * ratio[k]) ** 2 for k in ks)), o[2]
                else:
                    a, m = o[2] * ratio[o[1]], o[3]
                w = wt(m)
                if w > 0:
                    A.append([a * w])
                    b.append(m * w)
            x = solve_linear(A, b, crit) if A else None
            res[rpm] = x[0] if x else None
        return res
    xs = max(abs(o[0]) for o in obs) or 1.0
    n = degree
    fits = {}
    if objective == "overall":
        base = [wt(o[2]) for o in obs]

        def build(beta, w):
            r, J = [], []
            for i, (rpm, hs, M) in enumerate(obs):
                x = rpm / xs
                pk = [sum(beta[ki * (n + 1) + j] * x ** j for j in range(n + 1)) for ki in range(len(ks))]
                c = math.sqrt(sum((hs[k] * pk[ki]) ** 2 for ki, k in enumerate(ks)))
                r.append(w[i] * (c - M))
                J.append([w[i] * (hs[k] ** 2 * pk[ki] / c if c > 0 else 0.0) * x ** j for ki, k in enumerate(ks) for j in range(n + 1)])
            return r, J
        num = den = 0.0
        for i, (rpm, hs, M) in enumerate(obs):
            g = math.sqrt(sum(h * h for h in hs.values())) * base[i]
            num += g * M * base[i]
            den += g * g
        beta = [(num / den if den > 0 else 0.0) if q % (n + 1) == 0 else 0.0 for q in range(len(ks) * (n + 1))]
        beta = levenberg(lambda bb: build(bb, base), beta, 500)
        if crit == "max":
            w = [1.0 / len(obs)] * len(obs)
            best, best_max = beta, float("inf")
            for _ in range(150):
                sw = [math.sqrt(v) * base[i] for i, v in enumerate(w)]
                beta = levenberg(lambda bb: build(bb, sw), beta, 60)
                e = [abs(v) for v in build(beta, base)[0]]
                mx = max(e)
                if mx < best_max:
                    best, best_max = beta[:], mx
                tot = sum(wi * ei for wi, ei in zip(w, e))
                if not tot > 0 or mx < 1e-13:
                    break
                w = [wi * ei / tot for wi, ei in zip(w, e)]
            beta = best
        mid = (obs[0][0] + obs[-1][0]) / 2
        for ki, k in enumerate(ks):
            coef = [b / xs ** j for j, b in enumerate(beta[ki * (n + 1):(ki + 1) * (n + 1)])]
            if sum(c * mid ** j for j, c in enumerate(coef)) < 0:
                coef = [-c for c in coef]  # overall 은 F_k 부호를 구분하지 못함 — 양수로 맞춤
            fits[k] = coef
        return fits
    for k in ks:
        use = [o for o in obs if o[1] == k and wt(o[3]) > 0]
        A = [[h * (rpm / xs) ** j * wt(m) for j in range(n + 1)] for rpm, _, h, m in use]
        beta = solve_linear(A, [m * wt(m) for *_, m in use], crit)
        if beta is None:
            sys.exit("%g차: 계수가 정해지지 않습니다. 다항식 차수를 낮춰 주십시오." % k)
        fits[k] = [b / xs ** j for j, b in enumerate(beta)]
    return fits


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("frf_csv")
    ap.add_argument("--point", required=True, help="응답점 이름 (추정은 쉼표로 여러 개)")
    ap.add_argument("--orders", help="차수 목록, 예: 1,2,4")
    ap.add_argument("--forces", help="차수별 가진력, 예: 120,60,25 (scale 사용 시 기준 차수 값 하나)")
    ap.add_argument("--scales", help="차수별 scale factor, 예: 1,0.5,0.2")
    ap.add_argument("--ref-order", type=float, help="scale factor 의 기준 차수")
    ap.add_argument("--force-vector", help="RPM 연동 가진력 벡터 CSV")
    ap.add_argument("--rpm", nargs=3, type=float, metavar=("시작", "끝", "간격"))
    ap.add_argument("--interp", default="linear", choices=["linear", "nearest", "loglog"])
    ap.add_argument("--estimate", metavar="계측CSV", help="가진력 추정 모드")
    ap.add_argument("--degree", type=int, help="추정: 차수별 다항식 차수 (scale 미고정)")
    ap.add_argument("--anti-ratio", type=float, default=0.05, help="추정: 반공진 경고 기준 (기본 0.05)")
    ap.add_argument("--meas-format", default="long", choices=["long", "wide", "files"], help="계측 표 형식 (기본 long)")
    ap.add_argument("--layout", default="header", choices=["header", "order", "point"], help="wide: 머리행 이름 / 차수 우선 / 지점 우선")
    ap.add_argument("--alias", help="머리행 지점 이름 ↔ FRF 응답점 짝, 예: 운전석=예시_운전석바닥_진동;핸들=예시_핸들_진동")
    ap.add_argument("--meas-orders", help="wide·files 의 차수 목록(열 순서대로) 또는 overall")
    ap.add_argument("--objective", default="order", choices=["order", "overall"], help="추정: 차수별 오차 / overall 오차")
    ap.add_argument("--crit", default="mean", choices=["mean", "max"], help="추정: 오차 기준 평균(최소제곱) / 최대(minimax)")
    ap.add_argument("--rel", action="store_true", help="추정: 상대오차(계측 대비)로 맞춤")
    a = ap.parse_args()
    orders = [float(x) for x in a.orders.split(",")] if a.orders else []
    ratio = None
    if a.scales:
        ratio = scale_ratios(orders, [float(x) for x in a.scales.split(",")], a.ref_order)
    w = csv.writer(sys.stdout, lineterminator="\n")

    if a.estimate:
        points = a.point.split(",")
        frfs = {p: read_frf(a.frf_csv, p) for p in points}
        mo = None
        if a.meas_orders:
            mo = ["overall"] if a.meas_orders.strip() == "overall" else [float(x) for x in a.meas_orders.split(",")]
        alias = dict(x.split("=", 1) for x in a.alias.split(";") if "=" in x) if a.alias else None
        warn = []
        meas = read_measured(a.estimate, points, a.meas_format, a.layout, mo, alias, warn)
        for x in warn:
            print("인식하지 못한 머리행 — 쓰지 않음: " + x, file=sys.stderr)
        kw = dict(objective=a.objective, crit=a.crit, rel=a.rel, orders=orders)
        if ratio is not None:
            res = estimate(frfs, meas, a.interp, a.anti_ratio, ratio=ratio, **kw)
            w.writerow(["RPM", "기준 %g차 추정 가진력" % a.ref_order])
            for rpm, F in res.items():
                w.writerow(["%g" % rpm, "" if F is None else repr(F)])
        else:
            if a.degree is None:
                sys.exit("--degree(다항식 차수) 또는 --scales/--ref-order 를 지정해 주십시오.")
            res = estimate(frfs, meas, a.interp, a.anti_ratio, degree=a.degree, **kw)
            w.writerow(["차수"] + ["c%d" % j for j in range(a.degree + 1)])
            for k, coef in res.items():
                w.writerow(["%g" % k] + [repr(c) for c in coef])
        return

    if not orders or not a.rpm:
        sys.exit("--orders 와 --rpm 을 지정해 주십시오.")
    if a.force_vector:
        keys = [a.ref_order] if ratio is not None else orders
        vrpm, cols = read_force_vector(a.force_vector, keys)
        if ratio is not None:
            cols = {k: [ratio[k] * v for v in cols[a.ref_order]] for k in orders}

        def force(k, rpm):
            return interpolate(vrpm, cols[k], rpm, "linear")  # RPM 사이 선형 보간, 범위 밖은 None
    else:
        if not a.forces:
            sys.exit("--forces 또는 --force-vector 를 지정해 주십시오.")
        forces = [float(x) for x in a.forces.split(",")]
        if ratio is not None:
            if len(forces) != 1:
                sys.exit("scale factor 를 쓸 때는 --forces 에 기준 차수 값 하나만 넣습니다.")
            forces = [ratio[k] * forces[0] for k in orders]
        if len(orders) != len(forces):
            sys.exit("차수와 가진력 개수가 다릅니다.")
        const = dict(zip(orders, forces))

        def force(k, rpm):
            return const[k]

    freq, mag = read_frf(a.frf_csv, a.point)
    w.writerow(["RPM"] + ["%g차 응답" % k for k in orders] + ["overall"])
    for rpm in rpm_list(*a.rpm):
        comps = []
        for k in orders:
            h = interpolate(freq, mag, k * rpm / 60.0, a.interp)
            F = force(k, rpm)
            comps.append(None if h is None or F is None else h * F)
        s = [c for c in comps if c is not None]
        overall = math.sqrt(sum(c * c for c in s)) if s else ""
        w.writerow(["%g" % rpm] + ["" if c is None else repr(c) for c in comps] + [repr(overall) if s else ""])


if __name__ == "__main__":
    main()
