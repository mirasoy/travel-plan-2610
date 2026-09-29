import { CONFIG } from './config.js';
import {
  db, doc, collection, setDoc, updateDoc, deleteDoc, onSnapshot, writeBatch
} from './firebase.js';
import { parseShare, joinShareParams, urlKey } from './parse.js';

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

async function savePool() {
  const text = $('#paste').value;
  const { mapUrl, rawTitle, name } = parseShare(text);
  if (!mapUrl && !name) { toast('붙여넣은 내용이 없음'); return; }

  const cat = state.saveCat;
  const dup = mapUrl ? state.pool.find(p => p.mapUrl && urlKey(p.mapUrl) === urlKey(mapUrl)) : null;

  if (dup) {
    const c = await choose('이미 저장된 링크',
      '"' + (dup.name || dup.rawTitle || '이름 없음') + '" 과(와) 같은 지도 링크임. 덮어쓸까?',
      [{ label: '취소', value: 'cancel' }, { label: '덮어쓰기', value: 'overwrite', kind: 'primary' }]);
    if (c !== 'overwrite') return;
    // 덮어쓰기: 링크/원문/이름을 새 값으로 교체. 새 이름이 비었거나 카테고리 미선택이면 기존 값 유지. 메모는 유지.
    const patch = { rawTitle, mapUrl };
    if (name) patch.name = name;
    if (cat) patch.category = cat;
    Object.assign(dup, patch);
    updateDoc(doc(poolCol, dup.id), patch).catch(fail('덮어쓰기'));
    finishSave();
    if (!dup.name) startPoolEdit(dup.id);
    toast('덮어썼음');
    return;
  }

  const ref = doc(poolCol);
  const data = {
    rawTitle,
    name,            // 초기값은 rawTitle 과 같은 텍스트(줄바꿈만 공백으로). 이후 사용자가 수정.
    category: cat,   // null 허용
    memo: '',
    mapUrl,          // URL 이 없으면 빈 문자열
    confirmedAt: null,
    createdAt: Date.now() // 서버 시각 대신 클라이언트 시각(정렬 용도). 기기 시계 오차는 허용.
  };
  // 스냅샷은 state.pool 을 통째로 교체하므로, 낙관적 반영은 쓰기 호출보다 먼저 해야 중복이 안 생긴다.
  state.pool.push({ id: ref.id, ...data });
  // 오프라인이면 promise 가 서버 확인까지 대기하므로 await 하지 않는다.
  setDoc(ref, data).catch(fail('저장'));
  finishSave();

  if (!name) {
    // URL 만 있고 이름이 없음: 링크는 저장했고, 이름 입력칸에 바로 포커스
    startPoolEdit(ref.id);
    toast('링크 저장됨. 이름을 입력하세요');
  } else {
    renderPool();
    toast('저장했음');
  }
}

function finishSave() {
  $('#paste').value = '';
  state.saveCat = null;
  renderChips();
}

function startPoolEdit(id) {
  state.editingPoolId = id;
  state.focusEdit = true;
  renderPool();
}

function finishPoolEdit(p, name, memo) {
  const patch = { name: singleLine(name), memo: memo.trim() };
  Object.assign(p, patch);
  updateDoc(doc(poolCol, p.id), patch).catch(fail('수정'));
  state.editingPoolId = null;
  renderPool();
  renderPlan();
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
    const nameIn = h('input', { class: 'input name-input', type: 'text', value: p.name || '', placeholder: '장소 이름' });
    const memoIn = h('input', { class: 'input', type: 'text', value: p.memo || '', placeholder: '메모 (선택)' });
    const save = () => finishPoolEdit(p, nameIn.value, memoIn.value);
    nameIn.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); save(); } });
    card.append(
      h('div', { class: 'raw' }, '원문: ' + (p.rawTitle || '(없음)')),
      nameIn, memoIn,
      h('div', { class: 'row' },
        h('button', { type: 'button', class: 'btn', onclick: () => { state.editingPoolId = null; renderPool(); } }, '취소'),
        h('button', { type: 'button', class: 'btn primary', onclick: save }, '저장'))
    );
  } else {
    card.append(h('button', {
      type: 'button',
      class: 'name' + (p.name ? '' : ' name-empty'),
      onclick: () => startPoolEdit(p.id)
    }, p.name || '이름 없음. 탭해서 입력'));
    if (p.memo) card.append(h('div', { class: 'memo' }, p.memo));
    card.append(h('div', { class: 'row' },
      p.mapUrl ? h('a', { class: 'btn', href: p.mapUrl, target: '_blank', rel: 'noopener' }, '지도 열기') : null,
      h('button', { type: 'button', class: 'btn danger', onclick: () => deletePool(p) }, '삭제')));
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

  $('#save-btn').addEventListener('click', savePool);
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
