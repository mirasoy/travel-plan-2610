import { CONFIG } from './config.js';
import {
  db, doc, collection, getDoc, getDocs, setDoc, updateDoc, deleteDoc, onSnapshot, writeBatch
} from './firebase.js';
import { extractMapUrl, cleanMapUrl, joinShareParams, urlKey, mapOpenUrl } from './parse.js';
import * as TC from './trip-calc.js';
import { createLegsService, legKey } from './legs.js';
import { createVault } from './vault.js';
import { openVaultModal } from './vault-ui.js';
import { resolveKey, extractKey, saveKey, clearKey, inviteLink } from './trip-key.js';
import { parseExport, summarize, chunk, COLLECTIONS, LIMITS, BATCH_SIZE } from './trip-import.js';
import { buildSummary, renderCard } from './trip-summary.js';
import { createSwipe, OPEN_PX } from './swipe.js';
import { createWiki, renderPhoto, hasVisiblePhoto, shouldLookup } from './wiki.js';


// 여행 키는 초대 링크(#k=)로만 들어온다. 없으면 init() 이 잠금 화면만 띄우고 Firestore 에는 아무것도 읽거나 쓰지 않는다.
// (아래 '_nokey' 는 참조 객체를 만들기 위한 자리표시일 뿐, 키가 없을 땐 구독도 쓰기도 일어나지 않는다.)
const keyStore = {
  getItem: k => localStorage.getItem(k),
  setItem: (k, v) => localStorage.setItem(k, v),
  removeItem: k => localStorage.removeItem(k)
};
const TRIP_KEY = resolveKey({ location, history, storage: keyStore }).key;

const tripRef = doc(db, 'trips', TRIP_KEY || '_nokey');
const poolCol = collection(tripRef, 'pool');
const itemsCol = collection(tripRef, 'items');
const flightsCol = collection(tripRef, 'flights');   // 문서 ID 고정: out, in
const lodgingsCol = collection(tripRef, 'lodgings');

const state = {
  trip: null,
  pool: [],
  items: [],
  flights: { out: null, in: null },
  lodgings: [],
  itemsLoaded: false,
  tab: 'plan',
  poolLoaded: false,
  onPool: null,
  day: 1,
  manualDays: 1,
  saveCat: null,
  editingPoolId: null,
  editingItemId: null,
  focusEdit: false,
  dragging: false,
  swipeOpenId: null   // 삭제 버튼이 드러나 있는 카드(다시 그려도 열린 채 유지)
};

/* ---------- 유틸 ---------- */

const $ = s => document.querySelector(s);

// textContent 기반 DOM 생성. 공유 텍스트가 무엇이든 HTML 로 해석되지 않는다.
function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'value') el.value = v;
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, v);
  }
  for (const c of kids.flat()) {
    if (c == null || c === false) continue;
    el.append(c.nodeType ? c : String(c));
  }
  return el;
}

let toastTimer = null;
// action: { label, onclick } 를 주면 토스트에 버튼이 붙고 5초 유지된다(실행취소 용).
function toast(msg, action) {
  const t = $('#toast');
  t.textContent = msg;
  if (action) {
    t.append(h('button', { type: 'button', class: 'toast-act', onclick: () => { t.hidden = true; clearTimeout(toastTimer); action.onclick(); } }, action.label));
  }
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, action ? 5000 : 2500);
}

function fail(prefix) {
  return err => {
    console.error(err);
    toast(prefix + ' 실패: ' + (err && err.code ? err.code : '알 수 없는 오류'));
  };
}

// 하단 시트 모달. build(close) 가 시트 안에 넣을 노드를 반환한다.
function openSheet(build, onClose) {
  const root = $('#modal-root');
  const overlay = h('div', { class: 'overlay' });
  const sheet = h('div', { class: 'sheet' });
  const close = () => { overlay.remove(); if (onClose) onClose(); };
  overlay.addEventListener('click', e => { if (e.target === overlay) close(); });
  sheet.append(build(close));
  overlay.append(sheet);
  root.append(overlay);
  return close;
}

// buttons: [{label, value, kind}] -> 선택된 value 로 resolve. 바깥 탭은 null.
function choose(title, message, buttons) {
  return new Promise(resolve => {
    let done = false;
    const finish = v => { if (!done) { done = true; resolve(v); } };
    openSheet(close => h('div', null,
      h('h3', null, title),
      h('p', null, message),
      h('div', { class: 'row' }, buttons.map(b =>
        h('button', {
          type: 'button',
          class: 'btn ' + (b.kind || ''),
          onclick: () => { finish(b.value); close(); }
        }, b.label)))
    ), () => finish(null)); // 바깥 탭으로 닫히면 null
  });
}

const notice = (title, message) => choose(title, message, [{ label: '확인', value: true, kind: 'primary' }]);

function singleLine(s) { return String(s || '').replace(/\s+/g, ' ').trim(); }

const parseYmd = TC.parseYmd;
const WEEK = ['일', '월', '화', '수', '목', '금', '토'];
// 'YYYY-MM-DD' -> 'M/D(요일)'. UTC 기준 파싱이라 실행 환경의 시간대와 무관하다.
function fmtDate(ymd) {
  const ms = parseYmd(ymd);
  if (ms == null) return '';
  const d = new Date(ms);
  return (d.getUTCMonth() + 1) + '/' + d.getUTCDate() + '(' + WEEK[d.getUTCDay()] + ')';
}
const fmtMD = ymd => ymd ? (+ymd.slice(5, 7)) + '/' + (+ymd.slice(8, 10)) : '';

const byOrder = (a, b) => ((a.order || 0) - (b.order || 0)) || a.id.localeCompare(b.id);

/* ---------- 공유 수신 ---------- */

// 공유로 열렸으면 일정 탭을 열고, 장소 추가 시트의 등록 화면에 공유 내용을 채워서 띄운다(저장은 사용자가 탭).
// 새로고침 때 다시 뜨지 않도록 쿼리를 바로 지운다.
function readShare() {
  const p = new URLSearchParams(location.search);
  if (!['title', 'text', 'url'].some(k => p.has(k))) return;
  const text = joinShareParams(p.get('title'), p.get('text'), p.get('url'));
  history.replaceState(null, '', location.pathname);
  state.sharedText = text;
}

/* ---------- 장소 풀 ---------- */

const RESOLVER_TIMEOUT_MS = 15000; // Worker 내부 대기가 길 수 있어 클라이언트는 15초

const MSG_RAW = '이름을 자동으로 못 나눴어요. 원문 그대로 넣었으니 고쳐주세요';
const MSG_LINK_ONLY = '자동 조회에 실패했어요. 링크만 저장하고 이름은 직접 입력하세요';
const MSG_OFF = '자동 조회가 꺼져 있어요. 링크만 저장하고 이름은 직접 입력하세요';
const MSG_NOT_PLACE = '장소 링크가 아니에요(검색 결과 링크일 수 있어요). 이름을 직접 입력해서 저장할 수 있어요';
const MSG_NO_LINK = '구글맵 링크가 아니에요. 이름을 직접 입력해서 저장할 수 있어요';

// Worker 호출 1회(사용자 탭 1번 = 호출 1번, 자동 재시도 없음). 결과를 화면 흐름용 kind 로 정규화한다.
// kind: off | failed | not_place | places404 | places | raw
async function callResolver(url) {
  if (!CONFIG.resolverUrl) return { kind: 'off' };
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), RESOLVER_TIMEOUT_MS);
  try {
    const res = await fetch(CONFIG.resolverUrl + '/?url=' + encodeURIComponent(url), { signal: ctl.signal });
    let j = null;
    try { j = await res.json(); } catch (e) { return { kind: 'failed', reason: 'not_json' }; }
    if (res.status === 403) {
      console.error('[resolver] 403 origin_not_allowed: resolver의 ALLOWED_ORIGINS를 확인하세요', j);
      return { kind: 'failed', reason: 'origin_not_allowed' };
    }
    if (!res.ok || !j || typeof j !== 'object') {
      console.error('[resolver] http ' + res.status, j && j.error, j && j.detail);
      return { kind: 'failed', reason: (j && j.error) || 'http_' + res.status };
    }
    if (j.success === false) {
      if (j.error === 'not_a_place_url') return { kind: 'not_place' };
      console.error('[resolver] success:false', j.error, j.detail);
      return { kind: 'failed', reason: j.error || 'unknown' };
    }
    const ps = j.places_status;
    if (ps === 'http_404') {
      // place ID 대응 실패: 링크만 저장 흐름
      console.error('[resolver] places http_404 (place ID 대응 안 됨)', { placeId: j.placeId, fid: j.fid });
      return { kind: 'places404', resp: j };
    }
    if (ps === 'http_403' || ps === 'http_429') {
      console.error('[resolver] places_status ' + ps + ' (API 키 제한 또는 한도 문제)');
    } else if (ps && ps !== 'ok' && ps !== 'skipped' && ps !== 'no_key') {
      console.warn('[resolver] places_status', ps);
    }
    return { kind: j.source === 'places' ? 'places' : 'raw', resp: j };
  } catch (e) {
    return { kind: 'failed', reason: e && e.name === 'AbortError' ? 'timeout' : 'network' };
  } finally {
    clearTimeout(timer);
  }
}

// 응답을 미리보기(draft)로 바꾼다. name 은 화면에서 사용자가 확인/수정한 뒤에만 저장된다.
// address 는 미리보기 전용이며 저장하지 않는다(구글 약관의 캐싱 제한).
function buildDraft(inputUrl, r) {
  const d = {
    mapUrl: inputUrl ? cleanMapUrl(inputUrl) : '',
    name: '', address: '', rawTitle: '', placeId: null, fid: null, cid: null,
    notice: '', focus: true
  };
  const resp = r.resp;
  if (resp) {
    d.rawTitle = resp.rawTitle || '';
    d.placeId = resp.placeId || null;
    d.fid = resp.fid || null;
    d.cid = resp.cid == null || resp.cid === '' ? null : String(resp.cid);
    d.address = resp.address || '';
  }
  switch (r.kind) {
    case 'places':
      d.name = (resp.name || '').trim();
      d.focus = !d.name;
      if (!d.name) d.notice = MSG_LINK_ONLY;
      break;
    case 'raw':
      d.name = (resp.name || resp.rawTitle || '').trim();
      d.notice = d.name ? MSG_RAW : MSG_LINK_ONLY;
      break;
    case 'places404':
      d.notice = MSG_LINK_ONLY; // 이름은 비워 둔다
      break;
    case 'not_place': d.notice = MSG_NOT_PLACE; break;
    case 'off': d.notice = MSG_OFF; break;
    default: d.notice = MSG_LINK_ONLY;
  }
  return d;
}

// 중복 판정: fid 가 같으면 같은 장소(링크 형식이 달라도). 그 외에는 정규화한 mapUrl 이 같으면 같은 장소.
// (fid 가 없는 기존 항목과도 mapUrl 로는 비교되도록 두 조건을 OR 로 둔다.)
function findDuplicate(d) {
  return state.pool.find(p =>
    (d.fid && p.fid && p.fid === d.fid) ||
    (d.mapUrl && p.mapUrl && urlKey(p.mapUrl) === urlKey(d.mapUrl)));
}

// 장소 등록(한 단계): 입력 -> (링크면 Worker 조회) -> 풀에 저장 -> 일정에 추가.
// 가정: 구글맵 링크가 없으면 입력 전체를 이름으로 쓴다. 링크인데 이름을 못 얻은 경우에만 이름 입력을 한 번 더 받는다.
// 이미 등록된 장소(fid 또는 링크 동일)면 새로 만들지 않고 기존 장소를 그대로 일정에 넣는다.
// 반환: { done: true } | { needName: true, draft } | { error: '메시지' }
async function registerAndAdd(text, pending, nameOverride) {
  let d = pending;
  if (!d) {
    const raw = String(text || '');
    if (!raw.trim()) return { error: '입력한 내용이 없어요' };
    const url = extractMapUrl(raw);
    if (url) {
      d = buildDraft(url, await callResolver(url));
    } else {
      const nm = singleLine(raw);
      if (!nm) return { error: '입력한 내용이 없어요' };
      d = { mapUrl: '', name: nm, rawTitle: '', placeId: null, fid: null, cid: null, notice: '' };
    }
  }
  const name = singleLine(nameOverride != null ? nameOverride : d.name);
  if (!name && !d.mapUrl) return { error: '이름을 입력하세요' };
  if (!name) return { needName: true, draft: d };

  let poolId;
  const dup = findDuplicate(d);
  if (dup) {
    poolId = dup.id;
    if (!dup.name) { dup.name = name; updateDoc(doc(poolCol, dup.id), { name }).catch(fail('이름 저장')); requestPhoto(dup.id, name); }
  } else {
    const ref = doc(poolCol);
    const data = {
      name, rawTitle: d.rawTitle || '', placeId: d.placeId, fid: d.fid, cid: d.cid,
      mapUrl: d.mapUrl, category: null, memo: '', confirmedAt: null,
      createdAt: Date.now()
    };
    // 스냅샷은 state.pool 을 통째로 교체하므로 낙관적 반영을 쓰기 호출보다 먼저 한다.
    state.pool.push({ id: ref.id, ...data });
    setDoc(ref, data).catch(fail('저장')); // 오프라인 대기 방지: await 하지 않는다
    requestPhoto(ref.id, name);            // 사진은 저장이 끝난 뒤 따로 조회한다(기다리지 않는다)
    poolId = ref.id;
  }
  addItem({ poolId, title: name });
  return { done: true, dup: !!dup };
}

/* ---------- 일정 ---------- */

// 여행 날짜, 앵커, 숙소 배정은 항상 flights/lodgings 에서 다시 계산한다(저장하지 않는다).
function model() {
  return TC.buildTripModel({ flights: state.flights, lodgings: state.lodgings, trip: state.trip, items: state.items, cfg: CONFIG });
}

// 이동시간은 메모리에만 둔다(약관의 캐싱 제한). 새로고침하면 다시 계산한다.
const legs = createLegsService({ getResolverUrl: () => CONFIG.resolverUrl });
let legSeq = 0;          // 요청 번호: 늦게 도착한 오래된 응답이 최신 화면을 덮지 않게 한다
let legTimer = null;
let legImmediate = false; // 일차 화면을 막 열었을 때는 디바운스 없이 바로 요청

function dayCards(day) {
  return dayItems(day).map(it => {
    const p = poolOf(it);
    return { kind: 'card', item: it, placeId: (p && p.placeId) || null };
  });
}

// 표시 순서(앵커 + 카드)에서 인접 쌍마다 구간 하나. 계산 가능한 쌍에는 요청 pair 를 붙인다.
function legSlots(m, day, seq) {
  const slots = [];
  for (let i = 0; i < seq.length - 1; i++) {
    const a = seq[i], b = seq[i + 1];
    const elig = TC.legEligibility(a, b);
    const slot = { a, b, elig, pair: null };
    if (elig === 'ok') slot.pair = { from: a.placeId, to: b.placeId, at: TC.legDepartAt(m, day, a, CONFIG) };
    slots.push(slot);
  }
  return slots;
}

function scheduleLegs() {
  clearTimeout(legTimer);
  const delay = legImmediate ? 0 : 500; // 순서나 시간이 바뀐 뒤에는 500ms 디바운스
  legImmediate = false;
  legTimer = setTimeout(runLegs, delay);
}

async function runLegs() {
  const m = model();
  const day = state.day;
  const seq = TC.daySequence(m, day, dayCards(day));
  const pairs = legSlots(m, day, seq).filter(s => s.pair).map(s => s.pair);
  const pendingNow = pairs.some(p => { const r = legs.get(legKey(p)); return r && r.pending; });
  if (!legs.missing(pairs).length && !pendingNow) return;
  const mine = ++legSeq;
  const done = legs.ensure(pairs); // 캐시에 없는 쌍만 모아 한 번의 POST(20쌍 초과 시 순차 분할)
  renderPlan();                    // 스켈레톤 표시
  await done;
  if (mine !== legSeq) return;     // 더 새로운 요청이 시작됐으면 이 응답으로 화면을 덮지 않는다
  renderPlan();
}

function dayItems(day) {
  return state.items.filter(i => i.day === day).sort(byOrder);
}

function poolOf(it) { return it.poolId ? state.pool.find(p => p.id === it.poolId) : null; }
function itemTitle(it) {
  const p = poolOf(it);
  return (p && p.name) || it.title || '(이름 없음)';
}

function renderPlanBody() {
  if (state.dragging) return; // 드래그 중에는 갱신하지 않는다(드롭 때 다시 그림)
  const m = model();
  const total = Math.max(m.dayCount, m.maxItemDay, state.manualDays, 1);
  if (state.day > total) state.day = total;
  const day = state.day;

  const tabs = $('#day-tabs');
  tabs.textContent = '';
  for (let d = 1; d <= total; d++) {
    tabs.append(h('button', {
      type: 'button',
      class: 'day-tab',
      'data-day': String(d),
      'aria-selected': String(d === day),
      onclick: () => {
        state.day = d;
        try { localStorage.setItem('trip.day', String(d)); } catch (e) { /* 무시 */ }
        legImmediate = true; // 일차 화면을 열 때는 바로 요청
        renderPlan();
      }
    }, d + '일차' + (m.valid && d > m.dayCount ? ' (날짜 밖)' : '')));
  }
  tabs.append(h('button', {
    type: 'button', class: 'day-tab', 'aria-label': '일차 추가',
    onclick: () => { state.manualDays = total + 1; state.day = total + 1; renderPlan(); }
  }, '+'));

  const date = m.dateOfDay(day);
  $('#day-title').textContent = day + '일차' + (date ? '  ' + fmtDate(date) : '');

  const warn = $('#day-warn');
  warn.textContent = '';
  if (m.valid && day > m.dayCount) warn.append(h('div', { class: 'w warn' }, '여행 날짜 밖 일차예요. 일정은 그대로 남아 있어요.'));
  if (!m.valid && m.source !== 'none') warn.append(h('div', { class: 'w error' }, '날짜 계산 오류. 설정 화면에서 항공편을 확인하세요.'));
  m.nightAssign.filter(n => n.status === 'overlap' && (n.k === day || n.k === day - 1))
    .forEach(n => warn.append(h('div', { class: 'w warn' }, n.k + '박 숙소가 겹쳐요. 체크인이 가장 늦은 숙소를 씁니다.')));
  warn.hidden = !warn.childNodes.length;

  const list = $('#day-items');
  if (state.editingItemId && list.querySelector('[data-id="' + state.editingItemId + '"] input')) return;
  list.textContent = '';
  const cards = dayCards(day);
  const seq = TC.daySequence(m, day, cards);
  const slots = legSlots(m, day, seq);
  let userIdx = 0;
  seq.forEach((e, i) => {
    if (e.kind === 'anchor') list.append(anchorCard(e));
    else list.append(itemCard(e.item, userIdx++, cards.length));
    if (i < slots.length) list.append(legBadge(slots[i]));
  });
  $('#day-empty').hidden = cards.length > 0;

  // 기준 시각(한 번만)과 출처 표기
  const entries = slots.filter(s => s.pair).map(s => {
    const r = legs.get(legKey(s.pair));
    return r && r.leg && r.leg.status === 'ok' ? { leg: r.leg, at: s.pair.at } : null;
  }).filter(Boolean);
  const basis = TC.basisText(entries);
  $('#day-basis').textContent = basis;
  $('#day-basis').hidden = !basis;
  $('#legs-credit').hidden = !entries.length;

  // 지도 관련 버튼은 embedKey 가 있을 때만
  $('#route-btn').hidden = !(CONFIG.embedKey && TC.routePoints(seq).points.length >= 2);

  if (state.focusEdit) {
    state.focusEdit = false;
    const input = list.querySelector('.first-input');
    if (input) input.focus();
  }

  if (slots.some(s => s.pair) && legs.missing(slots.filter(s => s.pair).map(s => s.pair)).length) scheduleLegs();
}

function renderPlan() {
  renderPlanBody();
  reanchorMenu();
}

function goSettings(target) {
  showTab('settings');
  const el = document.getElementById(target === 'lodgings' ? 'sec-lodgings' : 'sec-flights');
  if (el) el.scrollIntoView({ block: 'start' });
}

// 가상 카드: 저장하지 않고 삭제, 이동, 편집이 없다. 탭하면 해당 입력 화면으로 이동한다.
function anchorCard(e) {
  const sub = e.role === 'missing' ? '탭해서 숙소를 추가하세요'
    : !e.placeId ? '장소 ID 없음: 이동시간 계산 불가' : '';
  return h('li', { class: 'card anchor' + (e.role === 'missing' ? ' missing' : ''), 'data-anchor': e.role },
    h('button', { type: 'button', class: 'anchor-btn', onclick: () => goSettings(e.target) },
      h('div', { class: 'a-label' }, e.label),
      sub ? h('div', { class: 'a-sub' }, sub) : null));
}

// 구간 배지 하나. 표시: "도보 12분 · 0.9km | 대중교통 8분 · 1.4km" (항상 둘 다)
function legBadge(slot) {
  const stat =text => h('li', null, h('div', { class: 'leg static' }, text));
  if (slot.elig === 'excluded') return stat('계산 제외 (숙소 미지정)');
  if (slot.elig === 'noid') return stat('계산 불가 (장소 ID 없음)');

  const key = legKey(slot.pair);
  const r = legs.get(key);
  if (!r || r.pending) return h('li', null, h('div', { class: 'leg skeleton', 'aria-busy': 'true' }, '이동시간 확인 중'));

  const retry = () => {
    legs.retry([slot.pair]).then(() => renderPlan());
    renderPlan(); // 스켈레톤
  };
  if (r.failed) {
    return h('li', null, h('button', { type: 'button', class: 'leg', onclick: retry }, '확인 실패. 탭해서 다시 시도'));
  }
  const leg = r.leg;
  if (leg.status === 'no_place_id') return stat('계산 불가 (장소 ID 없음)');
  if (leg.status === 'same') return stat('같은 장소');

  const w = TC.fmtMode('도보', leg.walk, null);
  const t = TC.fmtMode('대중교통', leg.transit, null);
  const hasError = w.state === 'error' || t.state === 'error';
  // 도보가 walkLongMin(기본 60분) 이상이면 대중교통을 앞에 둔다. 강조 색은 쓰지 않는다.
  const walkFirst = !(w.state === 'ok' && w.min >= CONFIG.walkLongMin);
  const parts = walkFirst ? [w, t] : [t, w];
  const onTap = hasError
    ? retry                                            // 실패가 있으면 탭 = 수동 재시도
    : (CONFIG.embedKey ? () => openLegMap(slot, leg) : null);
  const inner = [
    h('span', { class: 'mode' }, parts[0].text),
    h('span', { class: 'sep' }, '|'),
    h('span', { class: 'mode' }, parts[1].text)
  ];
  return h('li', null, onTap
    ? h('button', { type: 'button', class: 'leg', onclick: onTap }, inner)
    : h('div', { class: 'leg static' }, inner));
}

/* ---------- 구간 지도 / 일차 전체 경로 (Embed directions) ---------- */

// URLSearchParams 로 만든다. place_id: 접두사와 | 구분자는 퍼센트 인코딩되지만 디코딩하면 원래 값이 된다.
function embedSrc(params) {
  const u = new URL('https://www.google.com/maps/embed/v1/directions');
  u.searchParams.set('key', CONFIG.embedKey);
  Object.keys(params).forEach(k => u.searchParams.set(k, params[k]));
  return u.toString();
}

function embedFrame(src) {
  return h('iframe', {
    class: 'embed', src, title: '경로 지도',
    referrerpolicy: 'strict-origin-when-cross-origin', loading: 'lazy', allowfullscreen: true
  });
}

function openLegMap(slot, leg) {
  const walkMin = leg.walk && leg.walk.status === 'ok' ? TC.minutesOf(leg.walk.sec) : null;
  // 기본값: 도보 시간이 walkWarnMin 미만이면 walking, 이상이면 transit. 도보 정보가 없으면 transit.
  let mode = walkMin != null && walkMin < CONFIG.walkWarnMin ? 'walking' : 'transit';
  openSheet(close => {
    const box = h('div', null);
    const wBtn = h('button', { type: 'button', class: 'btn', onclick: () => { mode = 'walking'; draw(); } }, '도보');
    const tBtn = h('button', { type: 'button', class: 'btn', onclick: () => { mode = 'transit'; draw(); } }, '대중교통');
    const draw = () => {
      wBtn.setAttribute('aria-pressed', String(mode === 'walking'));
      tBtn.setAttribute('aria-pressed', String(mode === 'transit'));
      box.textContent = '';
      box.append(embedFrame(embedSrc({
        origin: 'place_id:' + slot.pair.from,
        destination: 'place_id:' + slot.pair.to,
        mode
      })));
    };
    draw();
    return h('div', null,
      h('h3', null, '구간 지도'),
      h('div', { class: 'label' }, entryName(slot.a) + ' -> ' + entryName(slot.b)),
      h('div', { class: 'seg' }, wBtn, tBtn),
      box,
      h('button', { type: 'button', class: 'btn block', onclick: close }, '닫기'));
  });
}

function entryName(e) {
  return e.kind === 'card' ? itemTitle(e.item) : e.label;
}

// 일차 전체 경로: 시작 앵커 + placeId 있는 카드 + 끝 앵커, 도보 고정. 22곳(출발 1 + 경유 20 + 도착 1)씩 나눈다.
function openRouteSheet() {
  const m = model();
  const day = state.day;
  const seq = TC.daySequence(m, day, dayCards(day));
  const { points, excluded } = TC.routePoints(seq);
  const chunks = TC.chunkRoute(points, 22);
  if (!chunks.length) { toast('경로를 만들 곳이 2곳 이상 필요해요'); return; }
  openSheet(close => {
    const kids = [h('h3', null, day + '일차 전체 경로 (도보)')];
    if (excluded) kids.push(h('div', { class: 'label' }, excluded + '곳 제외됨 (장소 ID 없음)'));
    if (chunks.length > 1) kids.push(h('div', { class: 'label' }, '22곳을 넘어 ' + chunks.length + '개 구간으로 나눴어요. 각 구간은 이어져 있어요.'));
    chunks.forEach((c, i) => {
      const params = { origin: 'place_id:' + c[0], destination: 'place_id:' + c[c.length - 1], mode: 'walking' };
      if (c.length > 2) params.waypoints = c.slice(1, -1).map(id => 'place_id:' + id).join('|');
      if (chunks.length > 1) kids.push(h('div', { class: 'label' }, (i + 1) + '/' + chunks.length + ' 구간 (' + c.length + '곳)'));
      kids.push(embedFrame(embedSrc(params)));
    });
    kids.push(h('button', { type: 'button', class: 'btn block', onclick: close }, '닫기'));
    return h('div', null, ...kids);
  });
}

/* ---------- 장소 대표 사진(위키미디어) ---------- */
// 새 장소를 저장할 때와, 이름이 정해지거나 바뀔 때만 Worker /wiki 를 한 번 부른다(목록을 열 때마다 부르지 않는다).
// 저장은 응답을 기다리지 않는다. 찾으면 확인 없이 장소 문서의 photo 에 반영하고, 못 찾거나 실패하면 아무것도 하지 않는다(조용히).
// 같은 이름으로는 다시 부르지 않고, 사용자가 숨긴 사진은 다시 적용하지 않는다. 구글 사진은 어디에도 저장하지 않는다.
const wikiTimers = { setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: id => clearTimeout(id) };
const wiki = createWiki({
  getBaseUrl: () => CONFIG.resolverUrl,
  getCenter: () => CONFIG.destinationCenter,
  getRadiusKm: () => CONFIG.wikiRadiusKm,
  fetchFn: (url, init) => fetch(url, init),
  timers: wikiTimers,
  now: () => Date.now()
});
const wikiTried = new Map(); // 장소 ID -> 마지막으로 조회한 이름(같은 이름 중복 호출 방지)

function requestPhoto(poolId, name) {
  if (!CONFIG.resolverUrl) return;
  const p = state.pool.find(x => x.id === poolId);
  const nm = shouldLookup(wikiTried, poolId, singleLine(name), p && p.photo);   // 빈 이름, 숨긴 사진, 같은 이름 중복 호출을 막는다
  if (!nm) return;
  wiki.lookup(nm).then(r => {
    if (!r.ok) return;
    const cur = state.pool.find(x => x.id === poolId);
    if (!cur || singleLine(cur.name) !== nm) return;      // 그 사이 삭제됐거나 이름이 또 바뀜
    if (cur.photo && cur.photo.hidden === true) return;
    cur.photo = r.photo;
    updateDoc(doc(poolCol, poolId), { photo: r.photo }).catch(() => { /* 사진은 부가 정보라 조용히 넘어간다 */ });
    renderPlan();
  });
}

// 카드 메뉴의 "사진 숨기기"(선택 기능). 숨기면 photo.hidden = true 로 저장하고 다시 자동 적용하지 않는다. 실행취소로 되돌릴 수 있다.
function hidePhoto(poolId) {
  const p = state.pool.find(x => x.id === poolId);
  if (!p || !p.photo) return;
  const setHidden = v => {
    const cur = state.pool.find(x => x.id === poolId);
    if (cur && cur.photo) cur.photo = Object.assign({}, cur.photo, { hidden: v });
    updateDoc(doc(poolCol, poolId), { 'photo.hidden': v }).catch(fail(v ? '사진 숨기기' : '사진 되살리기'));
    renderPlan();
  };
  setHidden(true);
  toast('사진을 숨겼어요', { label: '실행취소', onclick: () => setHidden(false) });
}

/* ---------- 카드 스와이프(삭제 버튼)와 더보기 메뉴 ---------- */

// 카드를 열면(삭제 버튼 노출) 다른 열린 카드는 닫는다. 열림 상태는 다시 그려도 유지된다(state.swipeOpenId).
function setCardOpen(li, id, open, opt) {
  const body = li.querySelector('.swipe-body'), del = li.querySelector('.swipe-del');
  if (!body || !del) return;
  if (open) {
    document.querySelectorAll('#day-items li.item.open').forEach(o => { if (o !== li) setCardOpen(o, o.dataset.id, false); });
    state.swipeOpenId = id;
  } else if (state.swipeOpenId === id) {
    state.swipeOpenId = null;
  }
  li.classList.toggle('open', open);
  body.style.transform = open ? 'translateX(' + (-OPEN_PX) + 'px)' : '';
  del.tabIndex = open ? 0 : -1;
  del.setAttribute('aria-hidden', open ? 'false' : 'true');
  if (open && opt && opt.focus) del.focus();
}

// 포인터(터치, 마우스) 스와이프. 판정은 swipe.js(순수 함수). 순서 핸들에서 시작한 입력은 건드리지 않는다.
function attachSwipe(li, body, it) {
  const sw = createSwipe();
  let tracking = false, pid = null, engaged = false, swallowClick = false;
  body.addEventListener('pointerdown', e => {
    if ((e.button !== undefined && e.button !== 0) || state.dragging || e.target.closest('.handle')) return;
    sw.start(e.clientX, e.clientY, e.timeStamp, li.classList.contains('open'));
    tracking = true; engaged = false; pid = e.pointerId;
  });
  body.addEventListener('pointermove', e => {
    if (!tracking || e.pointerId !== pid) return;
    const r = sw.move(e.clientX, e.clientY, e.timeStamp);
    if (!r) return;
    if (r.lock === 'y') { tracking = false; sw.cancel(); return; }  // 세로 스크롤은 브라우저에 맡긴다
    if (r.lock === 'x') {
      if (!engaged) { engaged = true; li.classList.add('swiping'); try { body.setPointerCapture(e.pointerId); } catch (err) { /* 무시 */ } }
      body.style.transform = 'translateX(' + r.offset + 'px)';
    }
  });
  const finish = e => {
    if (!tracking || e.pointerId !== pid) return;
    tracking = false;
    const r = sw.end();
    li.classList.remove('swiping');
    if (!r.swiped) return;
    setCardOpen(li, it.id, r.open);
    // 마우스는 밀고 놓은 자리에서 click 이 한 번 더 발생한다(터치는 안 생김). 그 click 이 방금 연 카드를 닫거나
    // 지도 링크, 더보기를 누르지 않게 삼킨다. 같은 click 핸들러가 플래그로 처리한다(별도 리스너는 실행 순서 때문에 늦다).
    swallowClick = true;
    setTimeout(() => { swallowClick = false; }, 60);
  };
  body.addEventListener('pointerup', finish);
  body.addEventListener('pointercancel', finish);
  // 열린 카드의 본문을 탭하면 닫기만 한다(수정, 지도 등이 실수로 눌리지 않게).
  body.addEventListener('click', e => {
    if (swallowClick) { swallowClick = false; e.preventDefault(); e.stopPropagation(); return; }
    if (li.classList.contains('open')) { e.preventDefault(); e.stopPropagation(); setCardOpen(li, it.id, false); }
  }, true);
}

// 더보기(⋯) 메뉴: 화면 고정 위치의 작은 팝업. 바깥 탭, Esc, 스크롤, 크기 변경으로 닫히고, 다시 그려져도 같은 카드 옆에 유지된다.
let openMenu = null; // { node, anchor, itemId, off }

function placeMenu(node, anchor) {
  const r = anchor.getBoundingClientRect();
  const mw = node.offsetWidth, mh = node.offsetHeight;
  const left = Math.min(Math.max(8, r.right - mw), window.innerWidth - mw - 8);
  let top = r.bottom + 6;
  if (top + mh > window.innerHeight - 8) top = Math.max(8, r.top - mh - 6); // 아래가 모자라면 위로
  node.style.left = left + 'px';
  node.style.top = top + 'px';
}

function closeMenu(refocus) {
  if (!openMenu) return;
  const m = openMenu;
  openMenu = null;
  m.off();
  m.node.remove();
  m.anchor.setAttribute('aria-expanded', 'false');
  if (refocus && m.anchor.isConnected) m.anchor.focus();
}

function openItemMenu(anchor, itemId, entries) {
  if (openMenu && openMenu.anchor === anchor) { closeMenu(); return; }
  closeMenu();
  const node = h('div', { class: 'menu', role: 'menu', 'aria-label': '일정 메뉴' },
    entries.map(en => h('button', { type: 'button', class: 'menu-item', role: 'menuitem', onclick: () => { closeMenu(); en.run(); } }, en.label)));
  document.body.append(node);
  placeMenu(node, anchor);
  anchor.setAttribute('aria-expanded', 'true');
  const onDown = e => { if (!node.contains(e.target) && !openMenu.anchor.contains(e.target)) closeMenu(); };
  const onKey = e => {
    if (e.key === 'Escape') { e.preventDefault(); closeMenu(true); return; }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const items = [...node.querySelectorAll('.menu-item')];
      const i = items.indexOf(document.activeElement);
      items[(i + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length].focus();
    }
  };
  const onScroll = () => closeMenu();
  document.addEventListener('pointerdown', onDown, true);
  document.addEventListener('keydown', onKey, true);
  window.addEventListener('scroll', onScroll, true);
  window.addEventListener('resize', onScroll);
  openMenu = { node, anchor, itemId, off: () => {
    document.removeEventListener('pointerdown', onDown, true);
    document.removeEventListener('keydown', onKey, true);
    window.removeEventListener('scroll', onScroll, true);
    window.removeEventListener('resize', onScroll);
  } };
  node.querySelector('.menu-item').focus();
}

// 목록이 다시 그려져 앵커가 새 노드가 되면 메뉴를 새 위치에 붙인다(앵커가 없어졌으면 닫는다).
function reanchorMenu() {
  if (!openMenu) return;
  const a = document.querySelector('#day-items li[data-id="' + CSS.escape(openMenu.itemId) + '"] .kebab');
  if (!a) { closeMenu(); return; }
  openMenu.anchor = a;
  a.setAttribute('aria-expanded', 'true');
  placeMenu(openMenu.node, a);
}

function itemCard(it, idx, n) {
  const p = poolOf(it);
  const card = h('li', { class: 'card', 'data-id': it.id });

  if (state.editingItemId === it.id) {
    // 저장된 장소에 연결된 카드는 이름을 고치면 장소 자체의 이름이 바뀐다(같은 장소를 쓰는 다른 일차 카드에도 반영).
    const titleIn = h('input', { class: 'input first-input', type: 'text', value: p ? (p.name || '') : (it.title || ''), placeholder: '장소 이름' });
    const timeIn = h('input', { class: 'input', type: 'time', value: it.time || '' });
    const memoIn = h('input', { class: 'input', type: 'text', value: it.memo || '', placeholder: '메모 (선택)' });
    const save = () => {
      const patch = { time: timeIn.value || null, memo: memoIn.value.trim() };
      const t = singleLine(titleIn.value);
      if (!t) { toast('이름을 입력하세요'); return; }
      if (p) {
        if (t !== p.name) {
          p.name = t;
          updateDoc(doc(poolCol, p.id), { name: t }).catch(fail('이름 수정'));
          requestPhoto(p.id, t);
        }
        patch.title = t;
      } else {
        patch.title = t;
      }
      Object.assign(it, patch);
      updateDoc(doc(itemsCol, it.id), patch).catch(fail('수정'));
      state.editingItemId = null;
      renderPlan();
    };
    card.append(
      h('div', { class: 'item-title' }, itemTitle(it)),
      titleIn, timeIn, memoIn,
      h('div', { class: 'row' },
        h('button', { type: 'button', class: 'btn', onclick: () => { state.editingItemId = null; renderPlan(); } }, '취소'),
        h('button', { type: 'button', class: 'btn primary', onclick: save }, '저장'))
    );
    return card;
  }

  card.classList.add('item');
  const handle = h('button', {
    type: 'button', class: 'handle', 'aria-label': '순서 이동 (드래그, 또는 위/아래 방향키). 왼쪽 방향키로 삭제 버튼 열기',
    onpointerdown: e => startDrag(e, it, card),
    onkeydown: e => {
      if (e.key === 'ArrowUp') { e.preventDefault(); moveItem(it, -1); focusHandle(it.id); }
      else if (e.key === 'ArrowDown') { e.preventDefault(); moveItem(it, 1); focusHandle(it.id); }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); setCardOpen(card, it.id, true, { focus: true }); }
      else if (e.key === 'ArrowRight' || e.key === 'Escape') { e.preventDefault(); setCardOpen(card, it.id, false); handle.focus(); }
    }
  });
  handle.innerHTML = '<svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><circle cx="5" cy="3" r="1.4"/><circle cx="11" cy="3" r="1.4"/><circle cx="5" cy="8" r="1.4"/><circle cx="11" cy="8" r="1.4"/><circle cx="5" cy="13" r="1.4"/><circle cx="11" cy="13" r="1.4"/></svg>';
  const main = h('div', { class: 'item-main' },
    h('div', { class: 'item-head' },
      h('span', { class: 'item-time' }, it.time || '--:--'),
      h('span', { class: 'item-title' }, itemTitle(it))));
  if (it.memo) main.append(h('div', { class: 'memo' }, it.memo));
  const photoNode = p ? renderPhoto(h, p.photo) : null;   // 위키미디어 대표 사진(있을 때만). 본문 줄 아래에 카드 폭으로 붙인다

  // 오른쪽 도구: 지도 아이콘(링크가 있을 때만), 더보기(수정, 일차 이동). 삭제는 카드를 왼쪽으로 밀어서 한다.
  const mapHref = p ? mapOpenUrl(p, CONFIG.destinationCity) : '';
  const menuEntries = [
    { label: '수정', run: () => { state.editingItemId = it.id; state.focusEdit = true; renderPlan(); } },
    { label: '일차 이동', run: () => openMoveDaySheet(it) }
  ];
  if (p && hasVisiblePhoto(p.photo)) menuEntries.push({ label: '사진 숨기기', run: () => hidePhoto(p.id) }); // 선택 기능
  const tools = h('div', { class: 'item-tools' },
    mapHref ? h('a', { class: 'icon-btn map-btn', href: mapHref, target: '_blank', rel: 'noopener', 'aria-label': '지도 열기', title: '지도' },
      h('img', { src: 'icons/map.png', alt: '', width: '26', height: '26', draggable: 'false' })) : null,
    h('button', {
      type: 'button', class: 'icon-btn kebab', 'aria-label': '더보기', 'aria-haspopup': 'menu', 'aria-expanded': 'false',
      onclick: e => openItemMenu(e.currentTarget, it.id, menuEntries)
    }));
  tools.querySelector('.kebab').innerHTML = '<svg width="20" height="20" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true"><circle cx="4" cy="10" r="1.8"/><circle cx="10" cy="10" r="1.8"/><circle cx="16" cy="10" r="1.8"/></svg>';

  const body = h('div', { class: 'swipe-body' }, handle, main, tools, photoNode);
  const del = h('button', {
    type: 'button', class: 'swipe-del', tabindex: '-1', 'aria-hidden': 'true',
    onclick: () => { setCardOpen(card, it.id, false); removeItem(it); }
  }, '삭제');
  card.append(del, body);
  attachSwipe(card, body, it);
  if (state.swipeOpenId === it.id) setCardOpen(card, it.id, true);
  return card;
}

// 순서 변경: 해당 일차의 order 를 1..n 으로 다시 매긴다. 동시 추가로 order 가 겹쳐도 여기서 정리된다.
function reorderItem(it, toIdx) {
  const list = dayItems(it.day);
  const from = list.findIndex(x => x.id === it.id);
  if (from < 0 || toIdx < 0 || toIdx >= list.length || from === toIdx) return false;
  list.splice(toIdx, 0, list.splice(from, 1)[0]);
  const batch = writeBatch(db);
  list.forEach((x, k) => {
    if (x.order !== k + 1) { x.order = k + 1; batch.update(doc(itemsCol, x.id), { order: k + 1 }); }
  });
  batch.commit().catch(fail('순서 변경'));
  return true;
}

function moveItem(it, dir) {
  const i = dayItems(it.day).findIndex(x => x.id === it.id);
  if (reorderItem(it, i + dir)) renderPlan();
}

function focusHandle(id) {
  const b = document.querySelector('#day-items [data-id="' + id + '"] .handle');
  if (b) b.focus();
}

// ---- 드래그 정렬 (Pointer Events: 터치, 마우스, 펜 공통). 핸들에서만 시작한다. ----
// 가정: 앵커(공항, 숙소) 카드와 이동시간 배지는 고정이고, 사용자 카드끼리만 순서를 바꾼다.
// 드래그 중 Firestore 스냅샷이 오면 화면 갱신을 미루고, 드롭 후 한 번 다시 그린다.
function startDrag(e, it, card) {
  if (e.button !== undefined && e.button !== 0) return;
  const list = $('#day-items');
  const cards = [...list.querySelectorAll('li.item')];
  const from = cards.indexOf(card);
  if (from < 0) return;
  e.preventDefault();
  const handle = e.currentTarget;
  try { handle.setPointerCapture(e.pointerId); } catch (err) { /* 무시 */ }

  const startY = e.clientY;
  const startScroll = window.scrollY;
  const rects = cards.map(c => c.getBoundingClientRect());
  let to = from;
  let lastY = startY;
  let lastX = e.clientX;
  let hoverDay = 0; // 드래그 중 일차 탭 위에 있으면 그 일차
  let raf = 0;

  state.dragging = true;
  card.classList.add('dragging');
  list.classList.add('is-dragging');
  cards.forEach((c, i) => { if (i !== from) c.classList.add('shifting'); });

  card.style.pointerEvents = 'none'; // elementFromPoint 가 카드 아래(일차 탭)를 볼 수 있게
  const apply = () => {
    raf = 0;
    const under = document.elementFromPoint(lastX, lastY);
    const tab = under && under.closest ? under.closest('.day-tab[data-day]') : null;
    const hd = tab && +tab.dataset.day !== it.day ? +tab.dataset.day : 0;
    if (hd !== hoverDay) {
      document.querySelectorAll('.day-tab.drop-target').forEach(x => x.classList.remove('drop-target'));
      if (tab && hd) tab.classList.add('drop-target');
      hoverDay = hd;
    }
    const dy = lastY - startY + (window.scrollY - startScroll);
    card.style.transform = 'translateY(' + dy + 'px) scale(1.02)';
    // 드래그 중인 카드의 중심이 어느 카드 위에 있는지로 목표 위치를 정한다(문서 좌표 기준)
    const center = rects[from].top + startScroll + rects[from].height / 2 + dy;
    let t = from;
    cards.forEach((c, i) => {
      if (i === from) return;
      const mid = rects[i].top + startScroll + rects[i].height / 2;
      if (i < from && center < mid) t = Math.min(t, i);
      if (i > from && center > mid) t = Math.max(t, i);
    });
    to = hoverDay ? from : t;
    // 새 순서로 다시 쌓았을 때 각 카드의 top 을 계산한다(카드 사이의 이동시간 배지 간격을 그대로 유지)
    const order = cards.map((c, i) => i);
    order.splice(from, 1);
    order.splice(to, 0, from);
    let cursor = rects[0].top;
    order.forEach((ci, k) => {
      if (ci !== from) {
        const shift = cursor - rects[ci].top;
        cards[ci].style.transform = shift ? 'translateY(' + shift + 'px)' : '';
      }
      cursor += rects[ci].height + (k < cards.length - 1 ? rects[k + 1].top - rects[k].bottom : 0);
    });
  };
  const schedule = () => { if (!raf) raf = requestAnimationFrame(apply); };

  // 화면 가장자리에서 자동 스크롤
  let scrollTimer = setInterval(() => {
    const edge = 70;
    if (lastY < edge) window.scrollBy(0, -12);
    else if (lastY > window.innerHeight - edge) window.scrollBy(0, 12);
    else return;
    schedule();
  }, 16);

  const move = ev => { lastY = ev.clientY; lastX = ev.clientX; schedule(); };
  const finish = commit => {
    clearInterval(scrollTimer);
    if (raf) cancelAnimationFrame(raf);
    handle.removeEventListener('pointermove', move);
    handle.removeEventListener('pointerup', up);
    handle.removeEventListener('pointercancel', cancel);
    try { handle.releasePointerCapture(e.pointerId); } catch (err) { /* 무시 */ }
    state.dragging = false;
    list.classList.remove('is-dragging');
    document.querySelectorAll('.day-tab.drop-target').forEach(x => x.classList.remove('drop-target'));
    if (commit && hoverDay) { moveItemToDay(it, hoverDay); return; }
    if (commit) reorderItem(it, to);
    renderPlan(); // 인라인 transform 을 모두 지우고 새 순서로 다시 그린다
    if (commit) { legImmediate = false; scheduleLegs(); }
  };
  const up = () => finish(true);
  const cancel = () => finish(false);
  handle.addEventListener('pointermove', move);
  handle.addEventListener('pointerup', up);
  handle.addEventListener('pointercancel', cancel);
}

// 확인창 없이 바로 지우고, 토스트의 실행취소로 같은 문서 ID 그대로 되살린다(장소 풀은 건드리지 않는다).
function removeItem(it) {
  const data = { day: it.day, order: it.order || 0, poolId: it.poolId || null, title: it.title || '', time: it.time || null, memo: it.memo || '' };
  state.items = state.items.filter(x => x.id !== it.id);
  deleteDoc(doc(itemsCol, it.id)).catch(fail('삭제'));
  renderPlan();
  toast('"' + itemTitle(it) + '" 삭제함', {
    label: '실행취소',
    onclick: () => {
      if (!state.items.some(x => x.id === it.id)) state.items.push({ id: it.id, ...data });
      setDoc(doc(itemsCol, it.id), data).catch(fail('되살리기'));
      renderPlan();
    }
  });
}

// 다른 일차로 이동: 대상 일차의 맨 뒤에 붙이고, 원래 일차는 order 가 비어도 정렬에 문제없다.
function moveItemToDay(it, day) {
  if (!day || day === it.day) return;
  const order = dayItems(day).reduce((m, x) => Math.max(m, x.order || 0), 0) + 1;
  const patch = { day, order };
  Object.assign(it, patch);
  updateDoc(doc(itemsCol, it.id), patch).catch(fail('일차 이동'));
  legImmediate = true;
  renderPlan();
  toast(itemTitle(it) + ' -> ' + day + '일차로 옮김');
}

function totalDays() {
  const m = model();
  return Math.max(m.dayCount, m.maxItemDay, state.manualDays, 1);
}

function openMoveDaySheet(it) {
  openSheet(close => {
    const m = model();
    const total = totalDays();
    const btns = [];
    for (let d = 1; d <= total; d++) {
      if (d === it.day) continue;
      const date = m.dateOfDay(d);
      btns.push(h('button', { type: 'button', class: 'pick', onclick: () => { close(); moveItemToDay(it, d); } },
        d + '일차', h('small', null, date ? fmtDate(date) : ' ')));
    }
    return h('div', null,
      h('h3', null, '어느 일차로 옮길까'),
      h('p', null, itemTitle(it)),
      ...btns,
      h('button', { type: 'button', class: 'btn block', onclick: close }, '닫기'));
  });
}

function addItem(fields) {
  const day = state.day;
  const order = dayItems(day).reduce((m, x) => Math.max(m, x.order || 0), 0) + 1;
  const ref = doc(itemsCol);
  const data = {
    day, order,
    poolId: fields.poolId || null,
    title: fields.title,
    time: fields.time || null,
    memo: fields.memo || ''
  };
  state.items.push({ id: ref.id, ...data });
  setDoc(ref, data).catch(fail('일정 추가'));
  renderPlan();
}

// 저장된 장소 삭제. 일정에 쓰이는 장소는 삭제하지 않는다(카드가 이름을 잃는다).
async function deletePlace(p) {
  if (!state.itemsLoaded) { toast('일정을 불러오는 중. 잠시 후 다시'); return; }
  const used = [...new Set(state.items.filter(i => i.poolId === p.id).map(i => i.day))].sort((a, b) => a - b);
  const label = p.name || p.rawTitle || '이름 없음';
  if (used.length) { toast('"' + label + '" 은(는) ' + used.join(', ') + '일차 일정에서 쓰는 중이라 삭제할 수 없어요'); return; }
  state.pool = state.pool.filter(x => x.id !== p.id);
  deleteDoc(doc(poolCol, p.id)).catch(fail('삭제'));
  if (state.onPool) state.onPool();
  toast('"' + label + '" 삭제함');
}

// 장소 추가 시트: 목록 화면(저장된 장소 선택)과 등록 화면(한 칸 입력)을 한 시트 안에서 전환한다.
// opts.register 가 true 면 등록 화면으로 바로 열고 opts.text 를 미리 채운다(공유로 열린 경우).
function openAddSheet(opts) {
  opts = opts || {};
  const day = state.day;
  let closeSheet = () => {};

  const view = h('div', null);
  const done = () => { state.onPool = null; closeSheet(); };

  const showList = () => {
    view.textContent = '';
    const filter = h('input', { class: 'input', type: 'search', placeholder: '저장된 장소 검색' });
    const listBox = h('div', null);
    const renderList = () => {
      listBox.textContent = '';
      const q = filter.value.trim().toLowerCase();
      const rows = state.pool
        .filter(p => !q || ((p.name || '') + ' ' + (p.rawTitle || '') + ' ' + (p.memo || '')).toLowerCase().includes(q))
        .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
      if (!rows.length) listBox.append(h('div', { class: 'empty' }, state.pool.length ? '검색 결과 없음' : '저장된 장소가 없어요. 위의 장소 등록으로 추가하세요'));
      rows.forEach(p => {
        const cnt = state.items.filter(i => i.poolId === p.id).length;
        listBox.append(h('div', { class: 'pick-row' },
          h('button', {
            type: 'button', class: 'pick',
            onclick: () => {
              addItem({ poolId: p.id, title: p.name || p.rawTitle });
              toast(day + '일차에 추가함');
              done(); // 추가 후 시트도 닫는다
            }
          },
            p.name || p.rawTitle || '(이름 없음)',
            h('small', null, cnt ? '배정 ' + cnt + '회' : ' ')),
          h('button', { type: 'button', class: 'pick-del', 'aria-label': '저장된 장소 삭제', onclick: () => deletePlace(p) }, '삭제')));
      });
    };
    filter.addEventListener('input', renderList);
    state.onPool = renderList; // 다른 기기에서 장소가 추가되면 목록도 갱신
    renderList();
    view.append(
      h('h3', null, day + '일차에 추가'),
      h('button', { type: 'button', class: 'btn primary block reg-open', onclick: () => showRegister('') }, '+ 장소 등록'),
      h('div', { style: 'height:12px' }), filter, h('div', { style: 'height:8px' }), listBox,
      h('button', { type: 'button', class: 'btn block', onclick: done }, '닫기'));
  };

  const showRegister = (text) => {
    state.onPool = null;
    view.textContent = '';
    let pending = null; // 링크는 읽었지만 이름을 못 얻어 이름 입력을 기다리는 상태
    const input = h('textarea', { class: 'input', rows: 3, placeholder: '구글맵 링크 또는 장소 이름' });
    input.value = text || '';
    const nameIn = h('input', { class: 'input', type: 'text', placeholder: '장소 이름' });
    const msg = h('div', { class: 'notice' });
    const nameBox = h('div', { hidden: true }, msg, nameIn);
    const go = h('button', { type: 'button', class: 'btn primary block' }, day + '일차에 저장하고 추가');
    let busy = false;
    const submit = async () => {
      if (busy) return;
      if (!state.poolLoaded) { toast('장소를 불러오는 중이에요. 잠시 후 다시'); return; }
      busy = true; go.disabled = true; go.textContent = '확인 중...';
      const r = await registerAndAdd(input.value, pending, pending ? nameIn.value : null);
      busy = false; go.disabled = false; go.textContent = day + '일차에 저장하고 추가';
      if (r.error) { toast(r.error); (pending ? nameIn : input).focus(); return; }
      if (r.needName) {
        pending = r.draft;
        msg.textContent = r.draft.notice;
        nameIn.value = r.draft.name || '';
        nameBox.hidden = false;
        nameIn.focus();
        return;
      }
      toast(r.dup ? '이미 있는 장소라 그대로 ' + day + '일차에 추가함' : day + '일차에 추가함');
      done();
    };
    go.addEventListener('click', submit);
    nameIn.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); submit(); } });
    // 링크를 고쳐 붙이면 이전에 읽은 결과는 버린다
    input.addEventListener('input', () => { pending = null; nameBox.hidden = true; });
    view.append(
      h('h3', null, '장소 등록'),
      input, nameBox, go,
      h('button', { type: 'button', class: 'btn block', onclick: showList }, '뒤로'));
    setTimeout(() => input.focus(), 0);
  };

  closeSheet = openSheet(() => {
    if (opts.register) showRegister(opts.text); else showList();
    return view;
  }, () => { state.onPool = null; });
}

function openDatesSheet() {
  const start = h('input', { class: 'input', type: 'date', value: (state.trip && state.trip.startDate) || '' });
  const end = h('input', { class: 'input', type: 'date', value: (state.trip && state.trip.endDate) || '' });
  openSheet(close => h('div', null,
    h('h3', null, '여행 기간'),
    h('div', { class: 'label' }, '출발일'), start,
    h('div', { class: 'label' }, '귀국일'), end,
    h('div', { class: 'row' },
      h('button', { type: 'button', class: 'btn', onclick: close }, '취소'),
      h('button', {
        type: 'button', class: 'btn primary',
        onclick: () => {
          const s = parseYmd(start.value), e = parseYmd(end.value);
          if (s == null || e == null || e < s) { toast('날짜를 확인하세요 (귀국일이 출발일보다 빠름)'); return; }
          // merge: 문서가 아직 없어도 안전하고, 다른 필드(name, currencies)는 건드리지 않는다.
          setDoc(tripRef, { startDate: start.value, endDate: end.value }, { merge: true }).catch(fail('저장'));
          state.trip = Object.assign({}, state.trip, { startDate: start.value, endDate: end.value });
          renderAll();
          close();
        }
      }, '저장'))
  ));
}

/* ---------- 설정: 항공편 / 숙소 / 내보내기 ---------- */

const IATA_RE = /^[A-Z]{3}$/;
const upper = s => String(s || '').trim().toUpperCase();

// Worker GET /airport?code=TPE[&name=힌트]. 최대 3개 후보. 사용자 탭 1번 = 호출 1번, 자동 재시도 없음.
async function callAirport(code, hint) {
  if (!CONFIG.resolverUrl) return { kind: 'failed', reason: 'off' };
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), RESOLVER_TIMEOUT_MS);
  try {
    let url = CONFIG.resolverUrl + '/airport?code=' + encodeURIComponent(code);
    if (hint) url += '&name=' + encodeURIComponent(hint);
    const res = await fetch(url, { signal: ctl.signal });
    let j = null;
    try { j = await res.json(); } catch (e) { return { kind: 'failed', reason: 'not_json' }; }
    if (res.status === 403) console.error('[airport] 403 origin_not_allowed: resolver의 ALLOWED_ORIGINS를 확인하세요', j);
    else if (res.status === 503) console.error('[airport] 503 no_key: Worker 의 GOOGLE_PLACES_KEY 를 확인하세요', j);
    else if (res.status === 502) console.error('[airport] 502 places_failed, places_status=' + (j && j.places_status), j);
    else if (!res.ok || !j || j.success === false) console.error('[airport] http ' + res.status, j && j.error, j && j.detail);
    if (!res.ok || !j || j.success === false) return { kind: 'failed', reason: (j && j.error) || 'http_' + res.status };
    const c = (Array.isArray(j.candidates) ? j.candidates : []).filter(x => x && x.placeId).slice(0, 3);
    return { kind: 'ok', candidates: c };
  } catch (e) {
    return { kind: 'failed', reason: e && e.name === 'AbortError' ? 'timeout' : 'network' };
  } finally {
    clearTimeout(timer);
  }
}

function saveFlight(id, data, prev) {
  const isOut = id === 'out';
  const dest = isOut ? data.arrIata : data.depIata;
  const patch = Object.assign({}, data);
  // 목적지 쪽 IATA 가 바뀌면 이전에 확정한 공항은 더 이상 유효하지 않다.
  if (prev && prev.destAirport && prev.destAirport.iata !== dest) patch.destAirport = null;
  state.flights[id] = Object.assign({ id }, prev || {}, patch);
  setDoc(doc(flightsCol, id), patch, { merge: true }).catch(fail('항공편 저장'));
}

function flightBox(id) {
  const isOut = id === 'out';
  const f = state.flights[id] || {};
  const flightNo = h('input', { class: 'input', type: 'text', value: f.flightNo || '', placeholder: '편명 (선택)' });
  const depIata = h('input', { class: 'input', type: 'text', maxlength: '3', value: f.depIata || '', placeholder: '출발 IATA', autocapitalize: 'characters' });
  const arrIata = h('input', { class: 'input', type: 'text', maxlength: '3', value: f.arrIata || '', placeholder: '도착 IATA', autocapitalize: 'characters' });
  const depLocal = h('input', { class: 'input', type: 'datetime-local', value: f.depLocal || '' });
  const arrLocal = h('input', { class: 'input', type: 'datetime-local', value: f.arrLocal || '' });
  const memo = h('input', { class: 'input', type: 'text', value: f.memo || '', placeholder: '메모 (선택)' });
  const apBox = h('div', { class: 'ap-ok' });

  const destLabel = isOut ? '도착' : '출국';
  const ap = f.destAirport;
  if (ap && ap.placeId) {
    apBox.append(h('div', null, destLabel + ' 공항 확정: ' + (ap.name || ap.iata) + ' (' + ap.iata + ')'));
  } else {
    apBox.append(h('div', { class: 'notice info' }, destLabel + ' 공항이 확정되지 않았어요. 저장한 뒤 "공항 확정"을 누르세요.'));
  }
  apBox.append(h('button', { type: 'button', class: 'btn small', style: 'margin-top:8px', onclick: () => openAirportSheet(id) },
    ap && ap.placeId ? '공항 다시 지정' : '공항 확정'));

  const save = () => {
    const d = {
      flightNo: flightNo.value.trim(),
      depIata: upper(depIata.value), arrIata: upper(arrIata.value),
      depLocal: depLocal.value, arrLocal: arrLocal.value,
      memo: memo.value.trim()
    };
    if ((d.depIata && !IATA_RE.test(d.depIata)) || (d.arrIata && !IATA_RE.test(d.arrIata))) { toast('IATA 는 영문 3글자예요 (예: TPE)'); return; }
    if ((d.depLocal && !TC.isLocalDT(d.depLocal)) || (d.arrLocal && !TC.isLocalDT(d.arrLocal))) { toast('일시 형식을 확인하세요'); return; }
    saveFlight(id, d, state.flights[id]);
    toast('저장했음');
    renderSettings(); renderPlan(); renderHeader();
  };

  return h('div', { class: 'panel fbox' },
    h('h3', null, isOut ? '가는 편' : '오는 편'),
    flightNo,
    h('div', { class: 'two' },
      h('div', null, h('div', { class: 'label' }, isOut ? '출발 (집 쪽) IATA' : '출발 (여행지) IATA'), depIata),
      h('div', null, h('div', { class: 'label' }, isOut ? '도착 (여행지) IATA' : '도착 (집 쪽) IATA'), arrIata)),
    h('div', { class: 'label' }, '출발 일시 (현지 시각 그대로)'), depLocal,
    h('div', { class: 'label' }, '도착 일시 (현지 시각 그대로)'), arrLocal,
    memo, apBox,
    h('button', { type: 'button', class: 'btn primary block', onclick: save }, '항공편 저장'));
}

// 목적지 쪽 공항 place ID 확정: /airport 후보 탭, 이름 힌트 재검색, 구글맵 링크 지정.
function openAirportSheet(id) {
  const isOut = id === 'out';
  const f = state.flights[id] || {};
  const code = upper(isOut ? f.arrIata : f.depIata);
  if (!IATA_RE.test(code)) { toast('IATA 3글자를 입력하고 저장하세요'); return; }
  openSheet(close => {
    const list = h('div', null);
    const linkBox = h('div', null);
    const hint = h('input', { class: 'input', type: 'text', placeholder: '공항 이름 힌트 (예: Taoyuan International Airport)' });
    const link = h('input', { class: 'input', type: 'text', placeholder: '구글맵 링크 붙여넣기' });

    const confirmAirport = ap => {
      const prev = state.flights[id] || {};
      state.flights[id] = Object.assign({ id }, prev, { destAirport: ap });
      setDoc(doc(flightsCol, id), { destAirport: ap }, { merge: true }).catch(fail('공항 확정'));
      close();
      toast('공항을 확정했어요');
      renderSettings(); renderPlan();
    };

    const search = async nameHint => {
      list.textContent = '';
      list.append(h('div', { class: 'label' }, '검색 중'));
      const r = await callAirport(code, nameHint);
      list.textContent = '';
      if (r.kind !== 'ok') {
        list.append(h('div', { class: 'notice' }, '공항 조회에 실패했어요. 이름 힌트로 다시 찾거나 구글맵 링크로 지정하세요.'));
        return;
      }
      if (!r.candidates.length) {
        list.append(h('div', { class: 'notice' }, '후보가 없어요. 이름 힌트로 다시 찾거나 구글맵 링크로 지정하세요.'));
        return;
      }
      r.candidates.forEach(c => list.append(h('button', {
        type: 'button', class: 'pick',
        onclick: () => confirmAirport({ iata: code, placeId: c.placeId, name: c.name || code })
      }, c.name || c.placeId)));
    };

    const byLink = async () => {
      const url = extractMapUrl(link.value);
      linkBox.textContent = '';
      if (!url) { linkBox.append(h('div', { class: 'notice' }, '구글맵 링크가 아니에요')); return; }
      linkBox.append(h('div', { class: 'label' }, '확인 중'));
      const r = await callResolver(url);
      const d = buildDraft(url, r);
      linkBox.textContent = '';
      if (!d.placeId) {
        linkBox.append(h('div', { class: 'notice' }, '장소 ID를 얻지 못했어요. 다른 링크를 붙여넣어 보세요.'));
        return;
      }
      const nameIn = h('input', { class: 'input', type: 'text', value: d.name || '', placeholder: '공항 이름' });
      linkBox.append(
        d.notice ? h('div', { class: 'notice' }, d.notice) : null,
        nameIn,
        d.address ? h('div', { class: 'address-box' }, h('span', { class: 'address' }, d.address), h('span', { class: 'attrib' }, 'Google Maps')) : null,
        h('button', {
          type: 'button', class: 'btn primary block',
          onclick: () => confirmAirport({ iata: code, placeId: d.placeId, name: singleLine(nameIn.value) || code })
        }, '이 공항으로 확정'));
    };

    search(undefined); // 열 때 한 번만 조회
    return h('div', null,
      h('h3', null, (isOut ? '도착' : '출국') + ' 공항 확정 (' + code + ')'),
      h('div', { class: 'label' }, '후보를 탭해서 확정하세요'),
      list,
      h('div', { class: 'label' }, '이름 힌트로 다시 찾기'),
      hint,
      h('button', { type: 'button', class: 'btn block', onclick: () => search(hint.value.trim() || undefined) }, '재검색'),
      h('div', { class: 'label', style: 'margin-top:12px' }, '구글맵 링크로 직접 지정'),
      link,
      h('button', { type: 'button', class: 'btn block', onclick: byLink }, '링크로 지정'),
      linkBox,
      h('button', { type: 'button', class: 'btn ghost block', onclick: close }, '닫기'));
  });
}

async function deleteLodging(l) {
  const c = await choose('숙소 삭제', '"' + (l.name || '이름 없음') + '" 을(를) 삭제할까?',
    [{ label: '취소', value: 'cancel' }, { label: '삭제', value: 'delete', kind: 'danger' }]);
  if (c !== 'delete') return;
  state.lodgings = state.lodgings.filter(x => x.id !== l.id);
  deleteDoc(doc(lodgingsCol, l.id)).catch(fail('삭제'));
  renderSettings(); renderPlan();
}

// 숙소 추가/수정. 추가는 구글맵 링크 -> 기존 링크 해석 흐름 재사용 -> 이름 확정 -> 체크인/체크아웃.
// 숙소는 장소 풀(pool)에 넣지 않는다. address 는 미리보기 전용이라 저장하지 않는다.
function openLodgingSheet(existing) {
  const m = model();
  let draft = existing
    ? { name: existing.name || '', address: '', notice: '', focus: false, rawTitle: existing.rawTitle || '', placeId: existing.placeId || null,
        fid: existing.fid || null, cid: existing.cid || null, mapUrl: existing.mapUrl || '', checkIn: existing.checkIn || '', checkOut: existing.checkOut || '', memo: existing.memo || '' }
    : null;
  openSheet(close => {
    const root = h('div', null);
    const draw = () => {
      root.textContent = '';
      if (!draft) {
        const paste = h('textarea', { class: 'input', rows: '3', placeholder: '숙소의 구글맵 링크 붙여넣기' });
        const check = h('button', { type: 'button', class: 'btn primary grow' }, '장소 확인');
        check.addEventListener('click', async () => {
          const text = paste.value;
          if (!text.trim()) { toast('붙여넣은 내용이 없어요'); return; }
          const url = extractMapUrl(text);
          if (!url) {
            draft = { mapUrl: '', name: '', address: '', rawTitle: '', placeId: null, fid: null, cid: null, notice: MSG_NO_LINK, focus: true };
          } else {
            check.disabled = true; check.textContent = '확인 중';
            draft = buildDraft(url, await callResolver(url));
          }
          draw();
        });
        root.append(h('h3', null, '숙소 추가'), paste,
          h('div', { class: 'row' }, h('button', { type: 'button', class: 'btn ghost', onclick: close }, '취소'), check));
        return;
      }
      const nameIn = h('input', { class: 'input', type: 'text', value: draft.name, placeholder: '숙소 이름' });
      // 기본값 = 여행 시작일/종료일(여행 날짜가 없으면 직접 입력)
      const inIn = h('input', { class: 'input', type: 'date', value: draft.checkIn || (m.valid ? m.range.start : '') });
      const outIn = h('input', { class: 'input', type: 'date', value: draft.checkOut || (m.valid ? m.range.end : '') });
      const memoIn = h('input', { class: 'input', type: 'text', value: draft.memo || '', placeholder: '메모 (선택)' });
      const save = () => {
        const name = singleLine(nameIn.value); // 사용자가 화면에서 확인한 값
        if (!name) { toast('숙소 이름을 입력하세요'); nameIn.focus(); return; }
        const ci = inIn.value, co = outIn.value;
        if (parseYmd(ci) == null || parseYmd(co) == null || co <= ci) { toast('체크인/체크아웃 날짜를 확인하세요 (최소 1박)'); return; }
        if (existing) {
          const patch = { name, checkIn: ci, checkOut: co, memo: memoIn.value.trim() };
          Object.assign(existing, patch);
          updateDoc(doc(lodgingsCol, existing.id), patch).catch(fail('숙소 수정'));
        } else {
          const ref = doc(lodgingsCol);
          const data = {
            name, rawTitle: draft.rawTitle || '', placeId: draft.placeId, fid: draft.fid, cid: draft.cid, mapUrl: draft.mapUrl,
            checkIn: ci, checkOut: co, memo: memoIn.value.trim(), createdAt: Date.now()
          };
          state.lodgings.push({ id: ref.id, ...data });
          setDoc(ref, data).catch(fail('숙소 저장'));
        }
        close();
        toast('숙소를 저장했어요');
        renderSettings(); renderPlan();
      };
      nameIn.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); save(); } });

      // 메인 페이지에서 확정한 숙소처럼 장소 ID 가 없는 숙소는, 구글맵 링크로 장소 ID 를 채워야 이동시간이 계산된다.
      // 이름은 그대로 두고 링크 해석 결과의 식별자만 반영한다.
      let placeIdBox = null;
      if (existing) {
        const linkIn = h('input', { class: 'input', type: 'text', placeholder: '구글맵 링크 붙여넣기 (장소 ID 채우기)' });
        const linkBtn = h('button', { type: 'button', class: 'btn small' }, '장소 ID 채우기');
        linkBtn.addEventListener('click', async () => {
          const url = extractMapUrl(linkIn.value);
          if (!url) { toast('구글맵 링크가 아니에요'); return; }
          linkBtn.disabled = true; linkBtn.textContent = '확인 중';
          const d = buildDraft(url, await callResolver(url));
          linkBtn.disabled = false; linkBtn.textContent = '장소 ID 채우기';
          if (!d.placeId) { toast('장소 ID를 얻지 못했어요. 다른 링크를 붙여넣어 보세요'); return; }
          const patch = { placeId: d.placeId, fid: d.fid, cid: d.cid, mapUrl: d.mapUrl, rawTitle: d.rawTitle };
          Object.assign(existing, patch);
          updateDoc(doc(lodgingsCol, existing.id), patch).catch(fail('장소 ID 저장'));
          toast('장소 ID를 채웠어요');
          close();
          renderSettings(); renderPlan();
        });
        placeIdBox = h('div', null,
          h('div', { class: 'label' }, existing.placeId ? '장소 ID: 있음 (다른 링크로 바꿀 수 있어요)' : '장소 ID: 없음 (이동시간 계산 불가)'),
          linkIn, h('div', { style: 'height:8px' }), linkBtn);
      }

      root.append(
        h('h3', null, existing ? '숙소 수정' : '숙소 추가'),
        draft.notice ? h('div', { class: 'notice' }, draft.notice) : null,
        h('div', { class: 'label' }, '이름 (탭해서 고칠 수 있음)'), nameIn,
        draft.address ? h('div', { class: 'address-box' }, h('span', { class: 'address' }, draft.address), h('span', { class: 'attrib' }, 'Google Maps')) : null,
        h('div', { class: 'two' },
          h('div', null, h('div', { class: 'label' }, '체크인'), inIn),
          h('div', null, h('div', { class: 'label' }, '체크아웃'), outIn)),
        memoIn,
        placeIdBox,
        h('div', { class: 'row' },
          h('button', { type: 'button', class: 'btn ghost', onclick: existing ? close : () => { draft = null; draw(); } }, existing ? '취소' : '뒤로'),
          h('button', { type: 'button', class: 'btn primary grow', onclick: save }, '저장')));
      if (draft.focus) { nameIn.focus(); nameIn.select(); }
    };
    draw();
    return root;
  });
}

function renderLodgings(m) {
  const box = $('#lodgings-box');
  box.textContent = '';
  const list = state.lodgings.slice().sort((a, b) => (a.checkIn || '').localeCompare(b.checkIn || '') || ((a.createdAt || 0) - (b.createdAt || 0)));
  list.forEach(l => {
    const n = TC.nightsOf(l.checkIn, l.checkOut);
    box.append(h('div', { class: 'lod' },
      h('div', { class: 'l-name' }, l.name || '(이름 없음)'),
      h('div', { class: 'l-sub' }, (l.checkIn || '?') + ' ~ ' + (l.checkOut || '?') + (n != null ? ' · ' + n + '박' : '')),
      l.placeId ? null : h('div', { class: 'l-sub' }, '장소 ID 없음: 이동시간 계산 불가 (수정에서 구글맵 링크로 채울 수 있어요)'),
      h('div', { class: 'row' },
        h('button', { type: 'button', class: 'btn small', onclick: () => openLodgingSheet(l) }, '수정'),
        h('button', { type: 'button', class: 'btn small danger', onclick: () => deleteLodging(l) }, '삭제'))));
  });
  if (!list.length) box.append(h('div', { class: 'empty' }, '등록된 숙소가 없음'));
  box.append(h('button', { type: 'button', class: 'btn primary block', onclick: () => openLodgingSheet(null) }, '숙소 추가'));

  if (m.valid && m.nights > 0) {
    const nl = h('div', { class: 'night-list' }, h('div', { class: 'label' }, '밤별 배정'));
    m.nightAssign.forEach(n => {
      const text = n.k + '박 (' + fmtMD(n.date) + '): ' +
        (n.status === 'ok' ? '정상 · ' + (n.lodging.name || '') : n.status === 'none' ? '미지정' : '겹침 · ' + n.all.map(x => x.name).join(', '));
      nl.append(h('div', { class: n.status === 'ok' ? '' : n.status }, text));
    });
    box.append(nl);
  }
}

function renderSettings() {
  // 입력 중인 칸이 있으면 다른 기기의 변경으로 입력이 날아가지 않게 미룬다.
  const a = document.activeElement;
  if (a && $('#tab-settings').contains(a) && a.matches('input, textarea')) return;
  const m = model();
  const sum = $('#trip-summary');
  sum.textContent = m.valid
    ? fmtMD(m.range.start) + ' ~ ' + fmtMD(m.range.end) + ' · ' + m.dayCount + '일 ' + m.nights + '박' + (m.source === 'manual' ? ' (직접 입력)' : '')
    : (m.source === 'none' ? '항공편을 입력하면 여행 날짜가 계산돼요' : '날짜를 계산할 수 없어요');
  const wl = $('#trip-warns');
  wl.textContent = '';
  m.warnings.forEach(w => wl.append(h('div', { class: 'w ' + w.level }, w.text)));
  const fb = $('#flights-box');
  fb.textContent = '';
  fb.append(flightBox('out'), flightBox('in'));
  renderLodgings(m);
}

// JSON 내보내기: 해당 여행의 trip, pool, items, expenses, members, flights, lodgings 전체.
// 이동시간과 거리는 저장한 적이 없으므로 포함되지 않는다.
async function exportJson() {
  try {
    const all = async name => (await getDocs(collection(tripRef, name))).docs.map(d => ({ id: d.id, ...d.data() }));
    const tripSnap = await getDoc(tripRef);
    const data = {
      exportedAt: new Date().toISOString(),
      trip: tripSnap.exists() ? tripSnap.data() : null,
      pool: await all('pool'),
      items: await all('items'),
      expenses: await all('expenses'),
      members: await all('members'),
      flights: await all('flights'),
      lodgings: await all('lodgings')
    };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const a = h('a', { href: URL.createObjectURL(blob), download: 'trip-' + data.exportedAt.slice(0, 10) + '.json' });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  } catch (e) {
    fail('내보내기')(e);
  }
}

/* ---------- 내 정보(금고) ---------- */
// 조회는 Worker 의 POST {resolverUrl}/vault 뿐이다. 응답은 화면 밖 어디에도 저장하지 않는다(vault.js, vault-ui.js 참고).
// 저장소는 localStorage 어댑터: "기억"을 켠 경우에만 토큰 하나를 쓴다. 접근이 막혀도 예외는 vault 코어가 삼킨다.
const vaultTimers = { setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: id => clearTimeout(id) };
const vault = createVault({
  getBaseUrl: () => CONFIG.resolverUrl,
  fetchFn: (url, init) => fetch(url, init),
  storage: {
    getItem: k => localStorage.getItem(k),
    setItem: (k, v) => localStorage.setItem(k, v),
    removeItem: k => localStorage.removeItem(k)
  },
  timers: vaultTimers
});

function openVault() {
  openVaultModal({ h, openSheet, toast, vault, timers: vaultTimers, doc: document, clipboard: navigator.clipboard });
}

/* ---------- 초대 링크(여행 키) ---------- */
// 키는 접근 권한 그 자체다: 화면, 로그, 내보내기 파일에 노출하지 않는다. 복사하는 순간에만 링크로 만든다.

// 키가 없을 때: 아무것도 읽거나 쓰지 않고 키 입력 화면만 보여준다(iOS 홈 화면 앱은 사파리와 저장소가 분리돼 있어 직접 입력이 필요할 수 있다).
function showLocked() {
  $('main').hidden = true;
  document.querySelector('.tabbar').hidden = true;
  $('#locked').hidden = false;
  $('#locked-form').addEventListener('submit', e => {
    e.preventDefault();
    const input = $('#locked-input');
    const key = extractKey(input.value);
    input.value = '';
    if (!key) { $('#locked-msg').textContent = '초대 링크 또는 키 형식이 아니에요'; return; }
    if (!saveKey(keyStore, key)) location.hash = 'k=' + key; // 저장이 막힌 브라우저: 이번 방문은 주소의 키로 연다
    location.reload();
  });
}

async function copyInvite() {
  const link = inviteLink(location, TRIP_KEY);
  try {
    await navigator.clipboard.writeText(link);
    toast('초대 링크를 복사했어요');
  } catch (e) {
    notice('초대 링크', link); // 복사가 막히면 화면에 보여 줘서 직접 복사하게 한다
  }
}

async function forgetKey() {
  const ok = await choose('이 기기에서 키 지우기', '이 기기에서 이 여행에 들어오는 키를 지워요. 여행 데이터는 지워지지 않고, 다시 들어오려면 초대 링크가 필요해요.',
    [{ label: '취소', value: false }, { label: '지우기', value: true, kind: 'danger' }]);
  if (!ok) return;
  clearKey(keyStore);
  location.replace(location.pathname); // 주소에서 키를 없애고 잠금 화면으로
}

function registerServiceWorker() {
  if ('serviceWorker' in navigator) {
    // 상대경로: 레포 하위 경로에 배포돼도 이 페이지와 같은 디렉터리의 sw.js 를 등록한다.
    navigator.serviceWorker.register('sw.js').catch(err => console.error('sw', err));
  }
}

// JSON 가져오기: 파일 -> 검증(trip-import.js) -> 미리보기(개수, 기존 데이터 경고) -> 확인 후 배치로 쓴다.
// 같은 ID 의 문서는 가져온 필드만 바뀌고(merge) 나머지 필드와 문서는 그대로다. 삭제는 하지 않는다. 같은 파일을 다시 가져와도 결과가 같다(멱등).
function pickImportFile() {
  const input = h('input', { type: 'file', accept: 'application/json,.json' });
  input.addEventListener('change', () => { const f = input.files && input.files[0]; if (f) importJson(f); });
  input.click();
}

async function countExisting() {
  let n = 0;
  for (const c of COLLECTIONS) n += (await getDocs(collection(tripRef, c))).size;
  return n;
}

function confirmImport(parsed, existingCount) {
  return new Promise(resolve => {
    let done = false;
    const finish = v => { if (!done) { done = true; resolve(v); } };
    openSheet(close => h('div', null,
      h('h3', null, 'JSON 가져오기'),
      h('p', null, '가져올 데이터: ' + summarize(parsed.counts) + (parsed.trip ? ' + 여행 정보' : '')),
      parsed.skipped ? h('div', { class: 'notice' }, '형식이 맞지 않아 건너뛰는 문서 ' + parsed.skipped + '건') : null,
      parsed.sanitized ? h('div', { class: 'notice' }, '지도 링크가 안전하지 않아 링크만 비우는 문서 ' + parsed.sanitized + '건') : null,
      existingCount
        ? h('div', { class: 'notice' }, '이 여행에는 이미 ' + existingCount + '건이 있어요. 같은 ID 의 문서는 가져온 필드만 바뀌고(나머지 필드는 유지), 파일에 없는 문서는 그대로 남아요. 삭제는 하지 않아요.')
        : h('p', null, '이 여행은 비어 있어요.'),
      h('div', { class: 'row' },
        h('button', { type: 'button', class: 'btn', onclick: () => { finish(false); close(); } }, '취소'),
        h('button', { type: 'button', class: 'btn primary', onclick: () => { finish(true); close(); } }, '가져오기'))
    ), () => finish(false));
  });
}

async function writeImport(parsed) {
  let written = 0;
  try {
    if (parsed.trip) await setDoc(tripRef, parsed.trip, { merge: true });
    for (const part of chunk(parsed.docs, BATCH_SIZE)) {
      const batch = writeBatch(db);
      part.forEach(d => batch.set(doc(collection(tripRef, d.col), d.id), d.data, { merge: true })); // 가져온 필드만 바꾸고 나머지 필드(예: 확정한 공항)는 유지
      await batch.commit();
      written += part.length;
      toast('가져오는 중... ' + written + '/' + parsed.docs.length);
    }
    toast(written + '건을 가져왔어요');
  } catch (e) {
    console.error(e);
    notice('일부만 가져왔어요', written + '/' + parsed.docs.length + '건을 쓴 뒤 멈췄어요. 같은 파일을 다시 가져오면 이어서 돼요. 오류: ' + (e && e.code ? e.code : '알 수 없음'));
  }
}

async function importJson(file) {
  try {
    if (file.size > LIMITS.fileBytes) { notice('가져올 수 없어요', '파일이 너무 커요 (최대 5MB)'); return; }
    if (navigator.onLine === false) { notice('오프라인이에요', '인터넷에 연결된 상태에서 가져와 주세요.'); return; }
    const parsed = parseExport(await file.text());
    if (!parsed.ok) { notice('가져올 수 없어요', parsed.message); return; }
    if (!(await confirmImport(parsed, await countExisting()))) return;
    await writeImport(parsed);
  } catch (e) {
    fail('가져오기')(e);
  }
}

/* ---------- 요약 탭: 확정된 항공편, 숙소 (Firestore 문서에서 그린다) ---------- */

function renderSummary() {
  const s = buildSummary({ flights: state.flights, lodgings: state.lodgings, extras: CONFIG.lodgingExtras });
  const fill = (sel, cards, emptyText) => {
    const box = $(sel);
    box.textContent = '';
    if (cards.length) cards.forEach(c => box.append(renderCard(h, c)));
    else box.append(h('div', { class: 'panel empty' }, emptyText));
  };
  fill('#summary-flights', s.flights, '등록된 항공편이 없어요. 설정에서 입력하거나 JSON 가져오기로 넣을 수 있어요');
  fill('#summary-lodgings', s.lodgings, '등록된 숙소가 없어요. 설정에서 추가하거나 JSON 가져오기로 넣을 수 있어요');
}

/* ---------- 헤더, 탭, 초기화 ---------- */

function renderHeader() {
  $('#trip-name').textContent = CONFIG.tripName;
  const m = model();
  $('#trip-sub').textContent = m.valid ? fmtDate(m.range.start) + ' - ' + fmtDate(m.range.end) : '';
}

function renderAll() {
  renderHeader();
  renderSummary();
  renderPlan();
  renderSettings();
}

function showTab(name) {
  state.tab = name;
  $('#tab-plan').hidden = name !== 'plan';
  $('#tab-summary').hidden = name !== 'summary';
  $('#tab-settings').hidden = name !== 'settings';
  document.querySelectorAll('.tabbar button').forEach(b => b.classList.toggle('active', b.dataset.tab === name));
  if (name === 'plan') { legImmediate = true; renderPlan(); } // 일차 화면을 열 때
  if (name === 'settings') renderSettings();
  if (name === 'summary') renderSummary();
  window.scrollTo(0, 0);
}

function subscribe() {
  onSnapshot(tripRef, snap => {
    if (snap.exists()) {
      state.trip = snap.data();
    } else if (!snap.metadata.fromCache) {
      // 서버가 "없음"이라고 확인해 준 경우에만 최초 생성한다(캐시 미스로 기존 값을 덮는 사고 방지).
      setDoc(tripRef, { name: CONFIG.tripName, startDate: null, endDate: null, currencies: [] }).catch(fail('여행 생성'));
    }
    renderAll();
  }, fail('여행 정보 읽기'));

  onSnapshot(poolCol, snap => {
    state.pool = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    state.poolLoaded = true;
    renderPlan();
    if (state.onPool) state.onPool();
  }, fail('장소 읽기'));

  onSnapshot(itemsCol, snap => {
    state.items = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    state.itemsLoaded = true;
    renderAll();
  }, fail('일정 읽기'));

  onSnapshot(flightsCol, snap => {
    const f = { out: null, in: null };
    snap.docs.forEach(d => { if (d.id === 'out' || d.id === 'in') f[d.id] = { id: d.id, ...d.data() }; });
    state.flights = f;
    renderAll();
  }, fail('항공편 읽기'));

  onSnapshot(lodgingsCol, snap => {
    state.lodgings = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    renderAll();
  }, fail('숙소 읽기'));
}

function init() {
  document.documentElement.style.setProperty('--theme', CONFIG.themeColor);
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', CONFIG.themeColor);
  document.title = CONFIG.tripName;

  if (!TRIP_KEY) { showLocked(); registerServiceWorker(); return; }

  try { state.day = parseInt(localStorage.getItem('trip.day'), 10) || 1; } catch (e) { state.day = 1; }
  state.manualDays = state.day;

  renderHeader();
  readShare();

  $('#add-item-btn').addEventListener('click', () => openAddSheet());
  $('#dates-btn').addEventListener('click', openDatesSheet);
  $('#route-btn').addEventListener('click', openRouteSheet);
  $('#export-btn').addEventListener('click', exportJson);
  $('#import-btn').addEventListener('click', pickImportFile);
  $('#vault-btn-settings').addEventListener('click', openVault);
  $('#vault-btn-flights').addEventListener('click', openVault);
  $('#vault-btn-summary').addEventListener('click', openVault);
  $('#invite-btn').addEventListener('click', copyInvite);
  $('#forget-key-btn').addEventListener('click', forgetKey);
  document.querySelectorAll('.tabbar button').forEach(b => b.addEventListener('click', () => showTab(b.dataset.tab)));

  subscribe();
  showTab('plan');
  if (state.sharedText) openAddSheet({ register: true, text: state.sharedText });

  registerServiceWorker();
}

init();
