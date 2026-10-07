// "요약" 탭의 카드 뷰모델. Firestore 의 flights, lodgings 문서를 화면용 데이터로 바꾼다(순수 함수, DOM 없음).
// 이 앱의 HTML 에는 여행 데이터가 한 줄도 없고, 카드 내용은 전부 문서에서 온다.
//   기본 필드: 항공편(flightNo, depIata, arrIata, depLocal, arrLocal, memo), 숙소(name, checkIn, checkOut, memo)
//   부가 필드(선택): details [{label, value}] 행들, link {label, url} 버튼(구글맵 https 만)
// 문서는 키를 아는 누구나 쓸 수 있으므로 화면에 그리기 전에 한 번 더 검증한다(형식이 틀린 부가 필드는 숨긴다).
import * as TC from './trip-calc.js';
import { cleanRows, cleanLink } from './trip-import.js';

const WEEK = ['일', '월', '화', '수', '목', '금', '토'];
const str = v => (typeof v === 'string' ? v.trim() : '');

// '2026-11-14' -> '11/14(토)'. 형식이 틀리면 ''
export function mdw(ymd) {
  const ms = TC.parseYmd(ymd);
  if (ms == null) return '';
  const d = new Date(ms);
  return (d.getUTCMonth() + 1) + '/' + d.getUTCDate() + '(' + WEEK[d.getUTCDay()] + ')';
}

// '2026-11-14T09:35' ~ '2026-11-14T11:30' -> '11/14(토) 09:35 → 11:30' (도착 날짜가 다르면 도착 쪽에도 날짜)
export function flightTime(depLocal, arrLocal) {
  if (!TC.isLocalDT(depLocal)) return '';
  const dd = TC.dateOf(depLocal);
  let s = mdw(dd) + ' ' + TC.timeOf(depLocal);
  if (TC.isLocalDT(arrLocal)) {
    const ad = TC.dateOf(arrLocal);
    s += ' → ' + (ad === dd ? '' : mdw(ad) + ' ') + TC.timeOf(arrLocal);
  }
  return s;
}

function flightCard(id, f) {
  const dep = str(f.depIata), arr = str(f.arrIata), no = str(f.flightNo);
  return {
    id,
    title: (id === 'out' ? '가는 편' : '오는 편') + (no ? ' · ' + no : ''),
    main: dep && arr ? dep + ' → ' + arr : dep || arr,
    sub: flightTime(f.depLocal, f.arrLocal),
    rows: cleanRows(f.details) || [],
    note: str(f.memo),
    link: cleanLink(f.link)
  };
}

function lodgingCard(l) {
  const n = TC.nightsOf(l.checkIn, l.checkOut);
  const a = mdw(l.checkIn), b = mdw(l.checkOut);
  return {
    id: l.id,
    title: str(l.name) || '(이름 없음)',
    main: a && b ? a + ' ~ ' + b + (n != null && n > 0 ? ' · ' + n + '박' : '') : '',
    sub: '',
    rows: cleanRows(l.details) || [],
    note: str(l.memo),
    link: cleanLink(l.link)
  };
}

// 카드 하나를 DOM 노드로 만든다. h 는 app.js 의 h(tag, attrs, ...kids) (textContent 기반이라 값이 HTML 로 해석되지 않는다).
// h 는 자식 배열을 한 단계만 펴므로 dt/dd 쌍은 미리 평탄화해서 넘긴다.
export function renderCard(h, c) {
  return h('div', { class: 'panel sum-card' },
    h('div', { class: 'sum-title' }, c.title),
    c.main ? h('div', { class: 'sum-main' }, c.main) : null,
    c.sub ? h('div', { class: 'sum-sub' }, c.sub) : null,
    c.rows.length ? h('dl', { class: 'sum-rows' }, c.rows.flatMap(r => [h('dt', null, r.label), h('dd', null, r.value)])) : null,
    c.note ? h('div', { class: 'sum-note' }, c.note) : null,
    c.link ? h('a', { class: 'btn small block', href: c.link.url, target: '_blank', rel: 'noopener' }, c.link.label) : null);
}

// flights: { out, in } (없으면 null), lodgings: [문서...] -> { flights: [카드], lodgings: [카드] }
export function buildSummary({ flights, lodgings }) {
  const f = flights || {};
  return {
    flights: ['out', 'in'].filter(id => f[id]).map(id => flightCard(id, f[id])),
    lodgings: (lodgings || []).slice()
      .sort((x, y) => str(x.checkIn).localeCompare(str(y.checkIn)) || ((x.createdAt || 0) - (y.createdAt || 0)))
      .map(lodgingCard)
  };
}
