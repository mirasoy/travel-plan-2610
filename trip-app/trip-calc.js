// 여행 날짜, 앵커(시작/끝 지점), 구간 시각, 이동시간 표시 문구. DOM/Firebase 의존 없음.
// 날짜는 전부 'YYYY-MM-DD' / 'YYYY-MM-DDTHH:mm' 문자열로 다루고, 연산은 Date.UTC 로만 한다.
// (Date 의 로컬 시간대 메서드를 쓰지 않으므로 실행 환경의 시간대 때문에 하루가 밀리지 않는다.)
// 여기서 계산한 값은 어디에도 저장하지 않는다. 항상 flights/lodgings 에서 다시 계산한다.

const DAY_MS = 86400000;

export function parseYmd(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || ''));
  if (!m) return null;
  const ms = Date.UTC(+m[1], +m[2] - 1, +m[3]);
  const d = new Date(ms);
  // 2월 30일 같은 값은 Date.UTC 가 다음 달로 넘기므로 되돌려 비교해 걸러낸다.
  return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3] ? ms : null;
}

const p2 = n => String(n).padStart(2, '0');

export function fmtYmd(ms) {
  const d = new Date(ms);
  return d.getUTCFullYear() + '-' + p2(d.getUTCMonth() + 1) + '-' + p2(d.getUTCDate());
}

export function addDays(ymd, k) {
  const ms = parseYmd(ymd);
  return ms == null ? null : fmtYmd(ms + k * DAY_MS);
}

// a - b (일 수)
export function diffDays(a, b) {
  const x = parseYmd(a), y = parseYmd(b);
  return x == null || y == null ? null : Math.round((x - y) / DAY_MS);
}

export const dateOf = local => String(local || '').slice(0, 10);
export const timeOf = local => String(local || '').slice(11, 16);

export function isLocalDT(s) {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})$/.exec(String(s || ''));
  return !!m && parseYmd(m[1]) != null && +m[2] < 24 && +m[3] < 60;
}

// 'YYYY-MM-DDTHH:mm' 에 분을 더한다(자정을 넘기면 날짜도 넘어간다). 시간대 변환은 하지 않는다.
export function addMinutesLocal(local, minutes) {
  if (!isLocalDT(local)) return null;
  const ms = Date.UTC(+local.slice(0, 4), +local.slice(5, 7) - 1, +local.slice(8, 10), +local.slice(11, 13), +local.slice(14, 16));
  const d = new Date(ms + minutes * 60000);
  return fmtYmd(d.getTime()) + 'T' + p2(d.getUTCHours()) + ':' + p2(d.getUTCMinutes());
}

// Worker 의 at 값: "{날짜}T{HH:MM}:00{utcOffset}"
export function toAt(ymd, hhmm, utcOffset) {
  if (parseYmd(ymd) == null || !/^\d{2}:\d{2}$/.test(String(hhmm || ''))) return undefined;
  return ymd + 'T' + hhmm + ':00' + (utcOffset || '');
}

// 여행 날짜: 가는 편 도착일 ~ 오는 편 출발일(새벽 출발이면 전날). 시차 변환 없음.
export function computeRange(out, inn, earlyBefore) {
  const early = earlyBefore || '06:00';
  if (!out || !inn || !isLocalDT(out.arrLocal) || !isLocalDT(inn.depLocal)) return { ok: false, reason: 'incomplete' };
  const start = dateOf(out.arrLocal);
  const depDate = dateOf(inn.depLocal);
  const earlyDeparture = timeOf(inn.depLocal) < early; // 'HH:mm' 은 문자열 비교로 충분
  const end = earlyDeparture ? addDays(depDate, -1) : depDate;
  if (end < start) return { ok: false, reason: 'end_before_start', start, end };
  const dayCount = diffDays(end, start) + 1;
  return { ok: true, start, end, dayCount, nights: dayCount - 1, earlyDeparture };
}

export function nightsOf(checkIn, checkOut) {
  const n = diffDays(checkOut, checkIn);
  return n == null ? null : n;
}

// 밤 k(1..nights)의 숙소: checkIn <= date(k일차) < checkOut. 겹치면 checkIn 이 가장 늦은 숙소를 쓴다.
export function assignNights(lodgings, start, nights) {
  const out = [];
  for (let k = 1; k <= nights; k++) {
    const date = addDays(start, k - 1);
    const hits = (lodgings || []).filter(l =>
      parseYmd(l.checkIn) != null && parseYmd(l.checkOut) != null && l.checkIn <= date && date < l.checkOut);
    hits.sort((a, b) => (b.checkIn.localeCompare(a.checkIn)) || ((b.createdAt || 0) - (a.createdAt || 0)) || String(a.id).localeCompare(String(b.id)));
    out.push({
      k, date,
      status: hits.length === 0 ? 'none' : hits.length === 1 ? 'ok' : 'overlap',
      lodging: hits[0] || null,
      all: hits
    });
  }
  return out;
}

// 여행 전체 모델. flights = { out, in }(없으면 undefined), trip 문서의 startDate/endDate 는 수동 입력 폴백.
export function buildTripModel({ flights, lodgings, trip, items, cfg }) {
  const c = cfg || {};
  const out = flights && flights.out, inn = flights && flights.in;
  const warnings = [];
  let range = computeRange(out, inn, c.earlyDepartureBefore);
  let source = 'flights';

  if (!range.ok && range.reason === 'end_before_start') {
    warnings.push({ level: 'error', code: 'end_before_start', text: '오는 편 출발일이 가는 편 도착일보다 빨라요. 항공편 날짜를 확인하세요. 날짜 계산을 하지 않았어요.' });
  } else if (!range.ok) {
    // flights 가 없을 때의 폴백: trip 문서의 수동 입력
    const s = trip && trip.startDate, e = trip && trip.endDate;
    if (parseYmd(s) != null && parseYmd(e) != null && e >= s) {
      const dayCount = diffDays(e, s) + 1;
      range = { ok: true, start: s, end: e, dayCount, nights: dayCount - 1, earlyDeparture: false };
      source = 'manual';
    } else {
      source = 'none';
    }
  }

  const valid = range.ok;
  const dayCount = valid ? range.dayCount : 0;
  const nights = valid ? range.nights : 0;
  const start = valid ? range.start : null;
  const dateOfDay = k => (valid ? addDays(start, k - 1) : null);
  const nightAssign = valid ? assignNights(lodgings, start, nights) : [];

  const maxItemDay = (items || []).reduce((m, i) => Math.max(m, i.day || 0), 0);
  const outOfRangeDays = [];
  if (valid) {
    const set = new Set();
    (items || []).forEach(i => { if ((i.day || 0) > dayCount) set.add(i.day); });
    outOfRangeDays.push(...[...set].sort((a, b) => a - b));
    if (outOfRangeDays.length) {
      warnings.push({ level: 'warn', code: 'days_out_of_range',
        text: '여행 날짜 밖 일차가 있어요: ' + outOfRangeDays.join(', ') + '일차. 일정은 지우지 않았어요.' });
    }
    nightAssign.forEach(n => {
      if (n.status === 'none') warnings.push({ level: 'warn', code: 'night_none', text: n.k + '박(' + n.date + ') 숙소 미지정' });
      if (n.status === 'overlap') warnings.push({ level: 'warn', code: 'night_overlap', text: n.k + '박(' + n.date + ') 숙소 겹침. 체크인이 가장 늦은 숙소를 씁니다' });
    });
    (lodgings || []).forEach(l => {
      if (parseYmd(l.checkIn) == null || parseYmd(l.checkOut) == null) return;
      if (l.checkIn < range.start || l.checkOut > addDays(range.end, 1)) {
        warnings.push({ level: 'info', code: 'lodging_out_of_range', text: '"' + (l.name || '숙소') + '" 체크인/체크아웃이 여행 기간 밖이에요' });
      }
    });
  }
  if (out && !(out.destAirport && out.destAirport.placeId)) warnings.push({ level: 'warn', code: 'out_airport', text: '도착 공항이 확정되지 않았어요(이동시간 계산 불가)' });
  if (inn && !(inn.destAirport && inn.destAirport.placeId)) warnings.push({ level: 'warn', code: 'in_airport', text: '출국 공항이 확정되지 않았어요(이동시간 계산 불가)' });

  function airportAnchor(role, f) {
    const isArr = role === 'arrival';
    const ap = f.destAirport || null;
    const iata = isArr ? f.arrIata : f.depIata;
    const name = (ap && ap.name) || iata || '공항';
    const local = isArr ? f.arrLocal : f.depLocal;
    const t = timeOf(local);
    const label = isArr
      ? '도착 · ' + name + ' · ' + t
      : '출국 · ' + name + ' · ' + (range.earlyDeparture ? '익일 ' : '') + t;
    return { kind: 'anchor', role, placeId: (ap && ap.placeId) || null, label, target: 'flights', local };
  }
  function lodgingAnchor(k) {
    const n = nightAssign[k - 1];
    if (!n || n.status === 'none') return { kind: 'anchor', role: 'missing', placeId: null, label: '숙소 미지정', target: 'lodgings', night: k };
    const l = n.lodging;
    return { kind: 'anchor', role: 'lodging', placeId: l.placeId || null, label: '숙소 · ' + (l.name || ''), target: 'lodgings', night: k, lodging: l };
  }

  // k일차의 시작/끝 앵커. 범위 밖 일차에는 앵커가 없다.
  function anchorsForDay(k) {
    if (!valid || k < 1 || k > dayCount) return { start: null, end: null };
    let s = null, e = null;
    if (k === 1) s = out ? airportAnchor('arrival', out) : null;
    else s = lodgingAnchor(k - 1);
    if (k === dayCount) e = inn ? airportAnchor('departure', inn) : null;
    else e = lodgingAnchor(k);
    return { start: s, end: e };
  }

  return { source, range, valid, dayCount, nights, start, dateOfDay, nightAssign, warnings, maxItemDay, outOfRangeDays, anchorsForDay };
}

// 일차의 표시 순서: [시작 앵커] + 사용자 카드 + [끝 앵커]. cards 는 { item, placeId, ... } 배열(이미 정렬됨).
export function daySequence(model, day, cards) {
  const a = model.anchorsForDay(day);
  const seq = [];
  if (a.start) seq.push(a.start);
  cards.forEach(c => seq.push(c));
  if (a.end) seq.push(a.end);
  return seq;
}

// 구간 계산 가능 여부. 숙소 미지정 앵커가 낀 구간은 계산에서 제외, placeId 없으면 계산 불가.
export function legEligibility(a, b) {
  if (a.role === 'missing' || b.role === 'missing') return 'excluded';
  if (!a.placeId || !b.placeId) return 'noid';
  return 'ok';
}

// 구간 출발 시각 at. 도착 공항에서 출발하는 첫 구간은 도착 + airportBufferMin, 숙소는 defaultDepartTime,
// 카드는 카드의 time (없으면 defaultDepartTime). 날짜는 해당 일차 날짜.
export function legDepartAt(model, day, from, cfg) {
  const off = cfg.utcOffset;
  if (from.kind === 'anchor' && from.role === 'arrival') {
    const t = addMinutesLocal(from.local, cfg.airportBufferMin == null ? 60 : cfg.airportBufferMin);
    return t ? toAt(dateOf(t), timeOf(t), off) : undefined;
  }
  const date = model.dateOfDay(day);
  if (!date) return undefined;
  const hhmm = (from.kind === 'card' && from.item && from.item.time) || cfg.defaultDepartTime || '10:00';
  return toAt(date, hhmm, off);
}

// 일차 전체 경로용 지점: 시작 앵커 + placeId 있는 카드 + 끝 앵커. placeId 없는 곳은 excluded 로 센다.
export function routePoints(seq) {
  const points = [];
  let excluded = 0;
  seq.forEach(e => {
    if (e.role === 'missing') return; // 숙소 미지정 안내 카드는 장소가 아니므로 제외 수에 넣지 않는다
    if (e.placeId) points.push(e.placeId); else excluded++;
  });
  return { points, excluded };
}

// 지점이 22곳(출발 1 + 경유 20 + 도착 1)을 넘으면 22곳씩 나눈다. 구간이 이어지도록 끝점을 다음 구간의 시작점으로 겹친다.
export function chunkRoute(points, size) {
  const max = size || 22;
  if (points.length <= max) return points.length >= 2 ? [points] : [];
  const chunks = [];
  for (let i = 0; i < points.length - 1; i += max - 1) {
    const c = points.slice(i, i + max);
    if (c.length >= 2) chunks.push(c);
  }
  return chunks;
}

/* ---------- 이동시간 표시 문구 ---------- */

export const minutesOf = sec => Math.ceil(sec / 60);

export function fmtDist(m) {
  if (m < 1000) {
    const r = Math.round(m / 10) * 10;
    if (r < 1000) return r + 'm';
    return '1.0km'; // 995~999m 는 10m 단위 반올림 후 1000m 이므로 km 로 표기
  }
  return (m / 1000).toFixed(1) + 'km';
}

// 모드 하나의 표시. { text, warn }
export function fmtMode(label, mode, warnMin) {
  if (!mode) return { text: label + ' 확인 실패', warn: false, state: 'error' };
  if (mode.status === 'ok') {
    const min = minutesOf(mode.sec);
    return { text: label + ' ' + min + '분 · ' + fmtDist(mode.m), warn: label === '도보' && warnMin != null && min >= warnMin, state: 'ok', min };
  }
  if (mode.status === 'no_route') return { text: label + ' 경로 없음', warn: false, state: 'no_route' };
  return { text: label + ' 확인 실패', warn: false, state: 'error' };
}

// 일차 헤더의 기준 시각 문구. entries: [{ leg, at }] (leg = Worker 응답 leg, at = 그 구간 요청에 보낸 값).
export function basisText(entries) {
  const list = entries.filter(e => e && e.leg && e.leg.transit_basis);
  if (!list.length) return '';
  const bases = new Set(list.map(e => e.leg.transit_basis));
  if (bases.has('out_of_range')) return '출발 시각이 범위 밖이라 현재 시각 기준';
  if (bases.has('invalid')) return '출발 시각 형식 오류라 현재 시각 기준';
  if (bases.has('now')) return '현재 시각 기준';
  // given: 요청에 보낸 at(현지 오프셋 그대로)에서 날짜와 시각을 읽는다. 시간대 변환 없음.
  const ats = [...new Set(list.map(e => e.at).filter(Boolean))];
  if (!ats.length) return '지정 시각 기준';
  const m = /^\d{4}-(\d{2})-(\d{2})T(\d{2}:\d{2})/.exec(ats[0]);
  const t = m ? (+m[1]) + '/' + (+m[2]) + ' ' + m[3] : ats[0];
  return t + ' 기준' + (ats.length > 1 ? ' 등' : '');
}
