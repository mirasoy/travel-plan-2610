import { CONFIG } from './config.js';
import {
  db, doc, collection, setDoc, updateDoc, deleteDoc, onSnapshot, writeBatch
} from './firebase.js';
import { extractMapUrl, cleanMapUrl, joinShareParams, urlKey, mapOpenUrl } from './parse.js';

const CATS = [
  ['sight', '관광'], ['food', '식당'], ['massage', '마사지'], ['cafe', '카페'], ['etc', '기타']
];
const CAT_CYCLE = [null, 'sight', 'food', 'massage', 'cafe', 'etc'];
const catLabel = c => (CATS.find(x => x[0] === c) || [])[1] || '';

const tripRef = doc(db, 'trips', CONFIG.tripId);
const poolCol = collection(tripRef, 'pool');
const itemsCol = collection(tripRef, 'items');

const state = {
  trip: null,
  pool: [],
  items: [],
  itemsLoaded: false,
  tab: 'pool',
  day: 1,
  manualDays: 1,
  saveCat: null,
  editingPoolId: null,
  editingItemId: null,
  focusEdit: false
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
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 2500);
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

function parseYmd(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s || '');
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3]) : null;
}
const DAY_MS = 86400000;
const WEEK = ['일', '월', '화', '수', '목', '금', '토'];
function fmtDate(ms) {
  const d = new Date(ms);
  return (d.getUTCMonth() + 1) + '/' + d.getUTCDate() + '(' + WEEK[d.getUTCDay()] + ')';
}

const byOrder = (a, b) => ((a.order || 0) - (b.order || 0)) || a.id.localeCompare(b.id);

/* ---------- 공유 수신 ---------- */

function readShare() {
  const p = new URLSearchParams(location.search);
  const has = ['title', 'text', 'url'].some(k => p.has(k));
  let raw = null;
  if (has) {
    raw = {};
    ['title', 'text', 'url'].forEach(k => { raw[k] = p.has(k) ? p.get(k) : null; });
    try { sessionStorage.setItem('trip.share', JSON.stringify(raw)); } catch (e) { /* 무시 */ }
    // 새로고침 시 다시 채워지지 않도록 쿼리를 제거한다.
    history.replaceState(null, '', location.pathname);
    // 세 값을 이어 붙여서 입력창에 미리 채운다(저장은 사용자가 탭).
    $('#paste').value = joinShareParams(raw.title, raw.text, raw.url);
  } else {
    try { raw = JSON.parse(sessionStorage.getItem('trip.share') || 'null'); } catch (e) { raw = null; }
  }
  const show = v => (v === null ? '(파라미터 없음)' : v === '' ? '(빈 문자열)' : v);
  $('#debug').textContent = raw
    ? 'title:\n' + show(raw.title) + '\n\ntext:\n' + show(raw.text) + '\n\nurl:\n' + show(raw.url)
    : '공유로 열린 기록 없음';
}

/* ---------- 장소 풀 ---------- */

const RESOLVER_TIMEOUT_MS = 15000; // Worker 내부 대기가 길 수 있어 클라이언트는 15초
const resolving = new Set();
state.draft = null; // 저장 전 미리보기 상태
state.fill = {};    // 이름 채우기 중인 기존 항목의 미리보기 (poolId -> draft)

const MSG_RAW = '이름을 자동으로 못 나눴어요. 원문 그대로 넣었으니 고쳐주세요';
const MSG_LINK_ONLY = '자동 조회에 실패했어요. 링크만 저장하고 이름은 직접 입력하세요';
const MSG_OFF = '자동 조회가 꺼져 있어요. 링크만 저장하고 이름은 직접 입력하세요';
const MSG_NOT_PLACE = '장소 링크가 아니에요(검색 결과 링크일 수 있어요). 이름을 직접 입력해서 저장할 수 있어요';
const MSG_NO_LINK = '구글맵 링크가 아니에요. 이름을 직접 입력해서 저장할 수 있어요';

function renderChips() {
  const box = $('#cat-chips');
  box.textContent = '';
  CATS.forEach(([v, label]) => {
    box.append(h('button', {
      type: 'button',
      class: 'chip',
      'aria-pressed': String(state.saveCat === v),
      // 같은 칩을 다시 탭하면 선택 해제(미선택 허용)
      onclick: () => { state.saveCat = state.saveCat === v ? null : v; renderChips(); }
    }, label));
  });
}

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

function showDraft(d) {
  state.draft = d;
  $('#step-input').hidden = true;
  $('#step-preview').hidden = false;
  const n = $('#draft-notice');
  n.textContent = d.notice;
  n.hidden = !d.notice;
  const input = $('#draft-name');
  input.value = d.name;
  $('#draft-address').textContent = d.address;
  $('#draft-address-box').hidden = !d.address;
  renderChips();
  if (d.focus) { input.focus(); input.select(); }
}

function backToInput() {
  state.draft = null;
  $('#step-preview').hidden = true;
  $('#step-input').hidden = false;
}

async function checkPlace() {
  const text = $('#paste').value;
  if (!text.trim()) { toast('붙여넣은 내용이 없어요'); return; }
  // URL 하나만 Worker 에 보낸다. 나머지 텍스트는 이름 후보로도 쓰지 않는다.
  const inputUrl = extractMapUrl(text);
  if (!inputUrl) {
    showDraft({ mapUrl: '', name: '', address: '', rawTitle: '', placeId: null, fid: null, cid: null, notice: MSG_NO_LINK, focus: true });
    return;
  }
  const btn = $('#check-btn');
  btn.disabled = true;
  btn.textContent = '확인 중...';
  const r = await callResolver(inputUrl);
  btn.disabled = false;
  btn.textContent = '장소 확인';
  showDraft(buildDraft(inputUrl, r));
}

// 중복 판정: fid 가 같으면 같은 장소(링크 형식이 달라도). 그 외에는 정규화한 mapUrl 이 같으면 같은 장소.
// (fid 가 없는 기존 항목과도 mapUrl 로는 비교되도록 두 조건을 OR 로 둔다.)
function findDuplicate(d) {
  return state.pool.find(p =>
    (d.fid && p.fid && p.fid === d.fid) ||
    (d.mapUrl && p.mapUrl && urlKey(p.mapUrl) === urlKey(d.mapUrl)));
}

async function saveDraft() {
  const d = state.draft;
  if (!d) return;
  const name = singleLine($('#draft-name').value); // 사용자가 화면에서 확인한 값
  if (!name && !d.mapUrl) { toast('이름을 입력하세요'); $('#draft-name').focus(); return; }
  const cat = state.saveCat;

  // 중복 판정은 응답을 받은 뒤(여기)에서 한다.
  const dup = findDuplicate(d);
  if (dup) {
    const c = await choose('이미 저장된 장소',
      '"' + (dup.name || '이름 없음') + '" 과(와) 같은 장소임. 덮어쓸까?',
      [{ label: '취소', value: 'cancel' }, { label: '덮어쓰기', value: 'overwrite', kind: 'primary' }]);
    if (c !== 'overwrite') return;
    // 덮어쓰기: 새로 얻은 값만 교체. 비어 있는 새 값(이름, 식별자, 카테고리)이 기존 값을 지우지는 않는다. 메모는 유지.
    const patch = {};
    if (name) patch.name = name;
    if (d.mapUrl) patch.mapUrl = d.mapUrl;
    if (d.rawTitle) patch.rawTitle = d.rawTitle;
    if (d.placeId) patch.placeId = d.placeId;
    if (d.fid) patch.fid = d.fid;
    if (d.cid) patch.cid = d.cid;
    if (cat) patch.category = cat;
    Object.assign(dup, patch);
    updateDoc(doc(poolCol, dup.id), patch).catch(fail('덮어쓰기'));
    finishSave();
    toast('덮어썼음');
    return;
  }

  const ref = doc(poolCol);
  const data = {
    name,
    rawTitle: d.rawTitle || '',
    placeId: d.placeId,
    fid: d.fid,
    cid: d.cid,
    mapUrl: d.mapUrl,        // 입력 URL 에서 추적 파라미터만 제거한 값. 링크가 없으면 빈 문자열
    category: cat,           // null 허용
    memo: '',
    confirmedAt: null,
    createdAt: Date.now()    // 서버 시각 대신 클라이언트 시각(정렬 용도). 기기 시계 오차는 허용.
  };
  // 스냅샷은 state.pool 을 통째로 교체하므로, 낙관적 반영은 쓰기 호출보다 먼저 해야 중복이 안 생긴다.
  state.pool.push({ id: ref.id, ...data });
  // 오프라인이면 promise 가 서버 확인까지 대기하므로 await 하지 않는다.
  setDoc(ref, data).catch(fail('저장'));
  finishSave();
  renderPool();
  toast(name ? '저장했음' : '링크만 저장했음. 이름 채우기로 나중에 채울 수 있어요');
}

function finishSave() {
  $('#paste').value = '';
  state.saveCat = null;
  backToInput();
  renderChips();
}

function startPoolEdit(id) {
  state.editingPoolId = id;
  state.focusEdit = true;
  renderPool();
}

function finishPoolEdit(p, name, memo) {
  const patch = { name: singleLine(name), memo: memo.trim() };
  const fill = state.fill[p.id];
  if (fill) {
    if (fill.rawTitle) patch.rawTitle = fill.rawTitle;
    if (fill.placeId) patch.placeId = fill.placeId;
    if (fill.fid) patch.fid = fill.fid;
    if (fill.cid) patch.cid = fill.cid;
  }
  delete state.fill[p.id];
  Object.assign(p, patch);
  updateDoc(doc(poolCol, p.id), patch).catch(fail('수정'));
  state.editingPoolId = null;
  renderPool();
  renderPlan();
}

// 이름이 빈 기존 항목(링크만 저장했거나 오프라인에서 저장한 것)을 mapUrl 로 다시 조회해 채운다.
// 조회 결과는 편집 화면에 미리 채워질 뿐이고, 사용자가 저장을 눌러야 반영된다.
async function fillName(p) {
  if (resolving.has(p.id)) return;
  resolving.add(p.id);
  toast('이름을 조회하는 중');
  const r = await callResolver(p.mapUrl);
  resolving.delete(p.id);
  const cur = state.pool.find(x => x.id === p.id);
  if (!cur) return;
  if (r.kind === 'failed' || r.kind === 'off') {
    toast('이름 조회에 실패했어요. 온라인에서 다시 눌러 보세요');
    return;
  }
  const d = buildDraft(cur.mapUrl, r);
  if (r.kind === 'not_place') toast('장소 링크가 아니에요(검색 결과 링크일 수 있어요)');
  state.fill[cur.id] = d;
  startPoolEdit(cur.id);
}

function cycleCategory(p) {
  const next = CAT_CYCLE[(CAT_CYCLE.indexOf(p.category || null) + 1) % CAT_CYCLE.length];
  p.category = next;
  updateDoc(doc(poolCol, p.id), { category: next }).catch(fail('분류 변경'));
  renderPool();
}

function assignedDays(poolId) {
  return [...new Set(state.items.filter(i => i.poolId === poolId).map(i => i.day))].sort((a, b) => a - b);
}

async function deletePool(p) {
  const label = p.name || p.rawTitle || '이름 없음';
  if (!state.itemsLoaded) { toast('일정을 불러오는 중. 잠시 후 다시'); return; }
  const days = assignedDays(p.id);
  if (days.length) {
    await notice('삭제할 수 없음',
      '"' + label + '" 은(는) ' + days.join(', ') + '일차 일정에 배정돼 있음. 일정 탭에서 배정 해제 후 삭제하세요.');
    return;
  }
  const c = await choose('장소 삭제', '"' + label + '" 을(를) 삭제할까?',
    [{ label: '취소', value: 'cancel' }, { label: '삭제', value: 'delete', kind: 'danger' }]);
  if (c !== 'delete') return;
  state.pool = state.pool.filter(x => x.id !== p.id);
  deleteDoc(doc(poolCol, p.id)).catch(fail('삭제'));
  renderPool();
}

function poolCard(p) {
  const card = h('li', { class: 'card', 'data-id': p.id });
  const days = assignedDays(p.id);
  card.append(h('div', { class: 'card-top' },
    h('button', {
      type: 'button',
      class: 'badge' + (p.category ? '' : ' badge-empty'),
      onclick: () => cycleCategory(p)
    }, catLabel(p.category) || '분류 없음'),
    days.length ? h('span', { class: 'hint' }, days.join(', ') + '일차 배정') : null
  ));

  if (state.editingPoolId === p.id) {
    const fill = state.fill[p.id];
    const nameIn = h('input', { class: 'input name-input', type: 'text', value: p.name || (fill && fill.name) || '', placeholder: '장소 이름' });
    const memoIn = h('input', { class: 'input', type: 'text', value: p.memo || '', placeholder: '메모 (선택)' });
    const save = () => finishPoolEdit(p, nameIn.value, memoIn.value);
    nameIn.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); save(); } });
    const raw = p.rawTitle || (fill && fill.rawTitle);
    card.append(
      fill && fill.notice ? h('div', { class: 'notice' }, fill.notice) : null,
      raw ? h('div', { class: 'raw' }, '원문: ' + raw) : null,
      nameIn,
      fill && fill.address ? h('div', { class: 'address-box' },
        h('span', { class: 'address' }, fill.address), h('span', { class: 'attrib' }, 'Google Maps')) : null,
      memoIn,
      h('div', { class: 'row' },
        h('button', { type: 'button', class: 'btn', onclick: () => { delete state.fill[p.id]; state.editingPoolId = null; renderPool(); } }, '취소'),
        h('button', { type: 'button', class: 'btn primary', onclick: save }, '저장'))
    );
  } else {
    card.append(h('button', {
      type: 'button',
      class: 'name' + (p.name ? '' : ' name-empty'),
      onclick: () => startPoolEdit(p.id)
    }, p.name || '이름 없음. 탭해서 입력'));
    if (p.memo) card.append(h('div', { class: 'memo' }, p.memo));
    const open = mapOpenUrl(p, CONFIG.destinationCity);
    card.append(h('div', { class: 'row' },
      open ? h('a', { class: 'btn', href: open, target: '_blank', rel: 'noopener' }, '지도 열기') : null,
      h('button', { type: 'button', class: 'btn danger', onclick: () => deletePool(p) }, '삭제')));
    if (!p.name && p.mapUrl && CONFIG.resolverUrl) {
      card.append(h('div', { class: 'row' },
        h('button', { type: 'button', class: 'btn', onclick: () => fillName(p) }, '이름 채우기')));
    }
  }
  return card;
}

function renderPool() {
  // 편집 중인 입력칸이 화면에 있으면 다른 기기의 변경으로 입력이 날아가지 않게 재렌더를 미룬다.
  if (state.editingPoolId && $('#pool-list [data-id="' + state.editingPoolId + '"] input')) return;

  const list = $('#pool-list');
  list.textContent = '';
  const sorted = state.pool.slice().sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  sorted.forEach(p => list.append(poolCard(p)));
  $('#pool-count').textContent = '(' + sorted.length + ')';
  $('#pool-empty').hidden = sorted.length > 0;

  if (state.focusEdit) {
    state.focusEdit = false;
    const input = list.querySelector('.name-input');
    if (input) {
      input.scrollIntoView({ block: 'center' });
      input.focus();
      input.select();
    }
  }
}

/* ---------- 일정 ---------- */

function tripDays() {
  const s = parseYmd(state.trip && state.trip.startDate);
  const e = parseYmd(state.trip && state.trip.endDate);
  const byDates = (s != null && e != null && e >= s) ? Math.min(Math.round((e - s) / DAY_MS) + 1, 60) : 0;
  const maxItemDay = state.items.reduce((m, i) => Math.max(m, i.day || 0), 0);
  return Math.max(byDates, maxItemDay, state.manualDays, 1);
}

function dayItems(day) {
  return state.items.filter(i => i.day === day).sort(byOrder);
}

function poolOf(it) { return it.poolId ? state.pool.find(p => p.id === it.poolId) : null; }
function itemTitle(it) {
  const p = poolOf(it);
  return (p && p.name) || it.title || '(이름 없음)';
}

function renderPlan() {
  const total = tripDays();
  if (state.day > total) state.day = total;

  const s = parseYmd(state.trip && state.trip.startDate);
  const tabs = $('#day-tabs');
  tabs.textContent = '';
  for (let d = 1; d <= total; d++) {
    tabs.append(h('button', {
      type: 'button',
      class: 'day-tab',
      'aria-selected': String(d === state.day),
      onclick: () => { state.day = d; try { localStorage.setItem('trip.day', String(d)); } catch (e) { /* 무시 */ } renderPlan(); }
    }, d + '일차'));
  }
  tabs.append(h('button', {
    type: 'button', class: 'day-tab', 'aria-label': '일차 추가',
    onclick: () => { state.manualDays = total + 1; state.day = total + 1; renderPlan(); }
  }, '+'));

  $('#day-title').textContent = state.day + '일차' + (s != null ? '  ' + fmtDate(s + (state.day - 1) * DAY_MS) : '');

  const list = $('#day-items');
  if (state.editingItemId && list.querySelector('[data-id="' + state.editingItemId + '"] input')) return;
  list.textContent = '';
  const items = dayItems(state.day);
  items.forEach((it, idx) => list.append(itemCard(it, idx, items.length)));
  $('#day-empty').hidden = items.length > 0;

  if (state.focusEdit) {
    state.focusEdit = false;
    const input = list.querySelector('.first-input');
    if (input) input.focus();
  }
}

function itemCard(it, idx, n) {
  const p = poolOf(it);
  const card = h('li', { class: 'card', 'data-id': it.id });

  if (state.editingItemId === it.id) {
    const custom = !it.poolId;
    const titleIn = custom ? h('input', { class: 'input first-input', type: 'text', value: it.title || '', placeholder: '장소 이름' }) : null;
    const timeIn = h('input', { class: 'input' + (custom ? '' : ' first-input'), type: 'time', value: it.time || '' });
    const memoIn = h('input', { class: 'input', type: 'text', value: it.memo || '', placeholder: '메모 (선택)' });
    const save = () => {
      const patch = { time: timeIn.value || null, memo: memoIn.value.trim() };
      if (custom) {
        const t = singleLine(titleIn.value);
        if (!t) { toast('이름을 입력하세요'); return; }
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

  card.append(h('div', { class: 'item-head' },
    h('span', { class: 'item-time' }, it.time || '--:--'),
    h('span', { class: 'item-title' }, itemTitle(it))));
  if (it.memo) card.append(h('div', { class: 'memo' }, it.memo));
  card.append(h('div', { class: 'row' },
    h('button', { type: 'button', class: 'btn', disabled: idx === 0, 'aria-label': '위로', onclick: () => moveItem(it, -1) }, '위'),
    h('button', { type: 'button', class: 'btn', disabled: idx === n - 1, 'aria-label': '아래로', onclick: () => moveItem(it, 1) }, '아래'),
    h('button', { type: 'button', class: 'btn', onclick: () => { state.editingItemId = it.id; state.focusEdit = true; renderPlan(); } }, '수정')));
  card.append(h('div', { class: 'row' },
    p && p.mapUrl ? h('a', { class: 'btn', href: p.mapUrl, target: '_blank', rel: 'noopener' }, '지도 열기') : null,
    h('button', { type: 'button', class: 'btn danger', onclick: () => removeItem(it) }, '배정 해제')));
  return card;
}

// 위/아래 이동: 해당 일차의 order 를 1..n 으로 다시 매긴다. 동시 추가로 order 가 겹쳐도 여기서 정리된다.
function moveItem(it, dir) {
  const list = dayItems(it.day);
  const i = list.findIndex(x => x.id === it.id);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= list.length) return;
  [list[i], list[j]] = [list[j], list[i]];
  const batch = writeBatch(db);
  list.forEach((x, k) => {
    if (x.order !== k + 1) { x.order = k + 1; batch.update(doc(itemsCol, x.id), { order: k + 1 }); }
  });
  batch.commit().catch(fail('순서 변경'));
  renderPlan();
}

async function removeItem(it) {
  const c = await choose('배정 해제', '"' + itemTitle(it) + '" 을(를) 이 일차에서 뺄까? 장소 풀에는 남음.',
    [{ label: '취소', value: 'cancel' }, { label: '해제', value: 'del', kind: 'danger' }]);
  if (c !== 'del') return;
  state.items = state.items.filter(x => x.id !== it.id);
  deleteDoc(doc(itemsCol, it.id)).catch(fail('삭제'));
  renderPool();
  renderPlan();
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
  renderPool();
}

function openAddSheet() {
  const day = state.day;
  openSheet(close => {
    const filter = h('input', { class: 'input', type: 'search', placeholder: '장소 검색' });
    const listBox = h('div', null);

    const renderList = () => {
      listBox.textContent = '';
      const q = filter.value.trim().toLowerCase();
      const rows = state.pool
        .filter(p => !q || (p.name + ' ' + p.rawTitle + ' ' + p.memo).toLowerCase().includes(q))
        .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
      if (!rows.length) listBox.append(h('div', { class: 'empty' }, state.pool.length ? '검색 결과 없음' : '장소 풀이 비어 있음'));
      rows.forEach(p => {
        const cnt = state.items.filter(i => i.poolId === p.id).length;
        listBox.append(h('button', {
          type: 'button', class: 'pick',
          onclick: () => {
            addItem({ poolId: p.id, title: p.name || p.rawTitle });
            toast(day + '일차에 추가함');
            renderList();
          }
        },
          p.name || p.rawTitle || '(이름 없음)',
          h('small', null, [catLabel(p.category), cnt ? '배정 ' + cnt + '회' : ''].filter(Boolean).join(' / ') || ' ')));
      });
    };
    filter.addEventListener('input', renderList);
    renderList();

    const cTitle = h('input', { class: 'input', type: 'text', placeholder: '장소 이름' });
    const cTime = h('input', { class: 'input', type: 'time' });
    const cMemo = h('input', { class: 'input', type: 'text', placeholder: '메모 (선택)' });
    const custom = h('details', { class: 'custom' },
      h('summary', null, '풀에 없는 장소 직접 입력'),
      cTitle, cTime, cMemo,
      h('button', {
        type: 'button', class: 'btn primary block',
        onclick: () => {
          const t = singleLine(cTitle.value);
          if (!t) { toast('이름을 입력하세요'); cTitle.focus(); return; }
          addItem({ poolId: null, title: t, time: cTime.value, memo: cMemo.value.trim() });
          toast(day + '일차에 추가함');
          close();
        }
      }, '일정에 추가'));

    return h('div', null,
      h('h3', null, day + '일차에 추가'),
      custom, filter, h('div', { style: 'height:8px' }), listBox,
      h('button', { type: 'button', class: 'btn block', onclick: close }, '닫기'));
  });
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
          renderHeader();
          renderPlan();
          close();
        }
      }, '저장'))
  ));
}

/* ---------- 헤더, 탭, 초기화 ---------- */

function renderHeader() {
  $('#trip-name').textContent = CONFIG.tripName;
  const t = state.trip;
  const s = parseYmd(t && t.startDate), e = parseYmd(t && t.endDate);
  $('#trip-sub').textContent = (s != null && e != null) ? fmtDate(s) + ' - ' + fmtDate(e) : '';
}

function showTab(name) {
  state.tab = name;
  $('#tab-pool').hidden = name !== 'pool';
  $('#tab-plan').hidden = name !== 'plan';
  document.querySelectorAll('.tabbar button').forEach(b => b.classList.toggle('active', b.dataset.tab === name));
  if (name === 'plan') renderPlan();
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
    renderHeader();
    renderPlan();
  }, fail('여행 정보 읽기'));

  onSnapshot(poolCol, snap => {
    state.pool = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    renderPool();
    renderPlan();
  }, fail('장소 읽기'));

  onSnapshot(itemsCol, snap => {
    state.items = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    state.itemsLoaded = true;
    renderPool();
    renderPlan();
  }, fail('일정 읽기'));
}

function init() {
  document.documentElement.style.setProperty('--theme', CONFIG.themeColor);
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', CONFIG.themeColor);
  document.title = CONFIG.tripName;

  try { state.day = parseInt(localStorage.getItem('trip.day'), 10) || 1; } catch (e) { state.day = 1; }
  state.manualDays = state.day;

  renderHeader();
  renderChips();
  readShare();

  $('#check-btn').addEventListener('click', checkPlace);
  $('#save-btn').addEventListener('click', saveDraft);
  $('#back-btn').addEventListener('click', backToInput);
  $('#draft-name').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); saveDraft(); } });
  $('#clear-btn').addEventListener('click', () => { $('#paste').value = ''; });
  $('#add-item-btn').addEventListener('click', openAddSheet);
  $('#dates-btn').addEventListener('click', openDatesSheet);
  document.querySelectorAll('.tabbar button').forEach(b => b.addEventListener('click', () => showTab(b.dataset.tab)));

  subscribe();

  if ('serviceWorker' in navigator) {
    // 상대경로: 레포 하위 경로에 배포돼도 이 페이지와 같은 디렉터리의 sw.js 를 등록한다.
    navigator.serviceWorker.register('sw.js').catch(err => console.error('sw', err));
  }
}

init();
