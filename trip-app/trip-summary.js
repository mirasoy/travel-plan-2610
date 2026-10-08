// "요약" 탭의 카드 뷰모델. Firestore 의 flights, lodgings 문서를 화면용 데이터로 바꾼다(순수 함수, DOM 없음).
// 이 앱의 HTML 에는 여행 데이터가 한 줄도 없고, 카드 내용은 전부 문서에서 온다.
//   기본 필드: 항공편(flightNo, depIata, arrIata, depLocal, arrLocal, memo), 숙소(name, checkIn, checkOut, memo)
//   부가 필드(선택): details [{label, value}] 행들, link {label, url} 버튼(구글맵 https 만)
// 문서는 키를 아는 누구나 쓸 수 있으므로 화면에 그리기 전에 한 번 더 검증한다(형식이 틀린 부가 필드는 숨긴다).
import * as TC from './trip-calc.js';
import { cleanRows, cleanLink } from './trip-import.js';

const WEEK = ['일', '월', '화', '수', '목', '금', '토'];
const str = v => (typeof v === 'string' ? v.trim() : '');

// ---- 숙소 부가 정보(config.lodgingExtras): 썸네일, 주소(+지도 버튼), 에어비앤비 링크
// 공개 저장소의 설정 파일에 두는 값이라 비밀이 아니다. 그래도 화면에 그리기 전에 한 번 더 검증한다.
const IMG_RE = /^(?!\/)(?!.*\.\.)[A-Za-z0-9_./-]{1,100}\.(?:jpe?g|png|webp)$/i;   // 앱 폴더 안의 상대 경로만(.., 절대 경로, 외부 URL 불가)

function httpsUrl(u) {
  if (typeof u !== 'string') return '';
  const raw = u.trim();
  if (!raw || raw.length > 600) return '';
  try { const p = new URL(raw); if (p.protocol !== 'https:' || p.username || p.password) return ''; } catch (e) { return ''; }
  return raw;
}

// 형식이 틀린 값은 그 항목만 버린다. 쓸 만한 게 하나도 없으면 null.
export function normalizeExtras(x) {
  if (!x || typeof x !== 'object' || Array.isArray(x)) return null;
  const image = IMG_RE.test(str(x.image)) ? str(x.image) : '';
  const e = {
    id: str(x.id), name: str(x.name).slice(0, 100), checkIn: str(x.checkIn), checkOut: str(x.checkOut),
    image, imageAlt: str(x.imageAlt).slice(0, 100),
    address: str(x.address).slice(0, 300), mapUrl: httpsUrl(x.mapUrl), airbnbUrl: httpsUrl(x.airbnbUrl)
  };
  return e.image || e.address || e.airbnbUrl ? e : null;
}

// 카드에 부가 정보를 입힌다: 이미지, 맨 위 주소 행(지도 버튼 포함), 에어비앤비 링크 버튼.
// 지도 주소나 에어비앤비 링크를 설정이 주면 문서에 있던 거리 기준 지도 링크는 중복이라 숨긴다.
function withExtras(card, e) {
  const rows = card.rows.slice();
  if (e.address) rows.unshift({ label: '주소', value: e.address, action: e.mapUrl ? { label: '지도', url: e.mapUrl } : null });
  return Object.assign({}, card, {
    image: e.image ? { src: e.image, alt: e.imageAlt || card.title } : card.image,
    rows,
    links: e.airbnbUrl ? [{ label: '에어비앤비에서 보기', url: e.airbnbUrl }] : card.links,
    link: e.mapUrl || e.airbnbUrl ? null : card.link
  });
}

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
    link: cleanLink(f.link),
    image: null,
    links: []
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
    link: cleanLink(l.link),
    image: null,
    links: []
  };
}

// 카드 하나를 DOM 노드로 만든다. h 는 app.js 의 h(tag, attrs, ...kids) (textContent 기반이라 값이 HTML 로 해석되지 않는다).
// h 는 자식 배열을 한 단계만 펴므로 dt/dd 쌍은 미리 평탄화해서 넘긴다.
export function renderCard(h, c) {
  const link = (cls, l) => h('a', { class: cls, href: l.url, target: '_blank', rel: 'noopener noreferrer' }, l.label);
  let photo = null;
  if (c.image) {
    photo = h('div', { class: 'sum-photo' });
    const img = h('img', { src: c.image.src, alt: c.image.alt || '', loading: 'lazy', decoding: 'async' });
    img.addEventListener('error', () => { photo.hidden = true; });   // 로드에 실패하면 사진 영역만 숨긴다
    photo.append(img);
  }
  const buttons = (c.links && c.links.length ? c.links : (c.link ? [c.link] : []));
  return h('div', { class: 'panel sum-card' },
    photo,
    h('div', { class: 'sum-title' }, c.title),
    c.main ? h('div', { class: 'sum-main' }, c.main) : null,
    c.sub ? h('div', { class: 'sum-sub' }, c.sub) : null,
    c.rows.length ? h('dl', { class: 'sum-rows' }, c.rows.flatMap(r => [
      h('dt', null, r.label),
      h('dd', null, r.action ? [r.value, ' ', link('mini-btn', r.action)] : r.value)   // 주소 옆 지도 버튼
    ])) : null,
    c.note ? h('div', { class: 'sum-note' }, c.note) : null,
    buttons.length ? h('div', { class: 'sum-links' }, buttons.map(l => link('btn small', l))) : null);
}

// flights: { out, in } (없으면 null), lodgings: [문서...] -> { flights: [카드], lodgings: [카드] }
// extras(config.lodgingExtras)는 id 가 같은 숙소 문서에 붙인다(id 가 안 맞아도 숙소가 하나뿐이면 그 숙소에 붙임, 여럿이면 붙이지 않음).
// 숙소 문서가 하나도 없으면 extras 의 name, checkIn, checkOut 으로 카드를 대신 만든다(문서를 가져오기 전에도 정보가 보이게).
export function buildSummary({ flights, lodgings, extras }) {
  const f = flights || {};
  const list = (lodgings || []).slice()
    .sort((x, y) => str(x.checkIn).localeCompare(str(y.checkIn)) || ((x.createdAt || 0) - (y.createdAt || 0)));
  let cards = list.map(lodgingCard);
  const e = normalizeExtras(extras);
  if (e) {
    let idx = e.id ? list.findIndex(l => l.id === e.id) : -1;
    if (idx < 0 && list.length === 1) idx = 0;
    if (idx >= 0) cards[idx] = withExtras(cards[idx], e);
    else if (list.length === 0 && e.name) cards = [withExtras(lodgingCard({ id: e.id || 'extras', name: e.name, checkIn: e.checkIn, checkOut: e.checkOut }), e)];
  }
  return { flights: ['out', 'in'].filter(id => f[id]).map(id => flightCard(id, f[id])), lodgings: cards };
}
