// 테스트 하네스. 외부 라이브러리 없이 node:test 만 쓴다. 실행: node --test "trip-app/test/*.test.mjs"
// 테스트 값은 전부 가짜다. 실제 예약번호, 이름, 토큰은 어디에도 넣지 않는다.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const APP_DIR = path.join(HERE, '..');
export const readApp = name => fs.readFileSync(path.join(APP_DIR, name), 'utf8');

// 가짜 값(테스트 전용)
export const FAKE_TOKEN = 'FAKE-TOKEN-0000';
export const FAKE_DATA = {
  updatedAt: '2000-01-01',
  groups: [
    { title: 'FAKE-GROUP-A', items: [{ label: 'FAKE-LABEL-1', value: 'FAKE-VALUE-ONE' }, { label: 'FAKE-LABEL-2', value: 'FAKE-VALUE-TWO' }] },
    { title: 'FAKE-GROUP-B', items: [{ label: 'FAKE-LABEL-3', value: 'FAKE-VALUE-THREE' }] }
  ]
};
export const ALL_FAKE_VALUES = FAKE_DATA.groups.flatMap(g => g.items.map(i => i.value));

/* ---------- 가짜 DOM ---------- */

class FakeText { constructor(t) { this.nodeType = 3; this.text = t; this.parent = null; } }

export class FakeElement {
  constructor(tag) {
    this.nodeType = 1;
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.parent = null;
    this.attrs = {};
    this.listeners = {};
    this.className = '';
    this.value = '';
    this.checked = false;
  }
  append(...kids) {
    for (const k of kids) {
      const node = typeof k === 'string' ? new FakeText(k) : k;
      if (node.parent) node.remove();
      node.parent = this;
      this.children.push(node);
    }
  }
  remove() {
    if (!this.parent) return;
    this.parent.children = this.parent.children.filter(c => c !== this);
    this.parent = null;
  }
  get textContent() { return this.children.map(c => (c.nodeType === 3 ? c.text : c.textContent)).join(''); }
  set textContent(v) {
    for (const c of this.children) c.parent = null;
    this.children = [];
    if (v) this.append(String(v));
  }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return this.attrs[k] == null ? null : this.attrs[k]; }
  addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); }
  removeEventListener(type, fn) { this.listeners[type] = (this.listeners[type] || []).filter(f => f !== fn); }
  // 실제 DOM 처럼 조상으로 버블링한다.
  dispatch(type, ev) {
    const e = Object.assign({ type, target: this, preventDefault() {} }, ev || {});
    for (let n = this; n; n = n.parent) (n.listeners[type] || []).slice().forEach(fn => fn(e));
  }
}

export function walk(root, fn) {
  fn(root);
  (root.children || []).forEach(c => c.nodeType === 1 ? walk(c, fn) : fn(c));
}
export function findAll(root, pred) {
  const out = [];
  walk(root, n => { if (n.nodeType === 1 && pred(n)) out.push(n); });
  return out;
}
export const byTag = (root, tag) => findAll(root, n => n.tagName === tag.toUpperCase());
export const byClass = (root, cls) => findAll(root, n => n.className.split(' ').includes(cls));
export const byText = (root, text) => findAll(root, n => n.tagName === 'BUTTON' && n.textContent === text);

export class FakeDocument {
  constructor() { this.visibilityState = 'visible'; this.listeners = {}; }
  createElement(tag) { return new FakeElement(tag); }
  addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); }
  removeEventListener(type, fn) { this.listeners[type] = (this.listeners[type] || []).filter(f => f !== fn); }
  listenerCount(type) { return (this.listeners[type] || []).length; }
  setVisibility(state) { this.visibilityState = state; (this.listeners.visibilitychange || []).slice().forEach(fn => fn({})); }
}

/* ---------- 앱 소스에서 h, openSheet 를 그대로 꺼내 쓴다(복제 없이) ---------- */

function extract(name, re) {
  const m = readApp('app.js').match(re);
  if (!m) throw new Error('app.js 에서 ' + name + ' 를 찾지 못함');
  return m[0];
}
export function loadAppHelpers(document, modalRoot) {
  const hSrc = extract('h', /^function h\(tag, attrs, \.\.\.kids\) \{[\s\S]*?^\}/m);
  const sheetSrc = extract('openSheet', /^function openSheet\([\s\S]*?^\}/m);
  const h = new Function('document', hSrc + '\nreturn h;')(document);
  const $ = sel => { if (sel === '#modal-root') return modalRoot; throw new Error('예상 밖 셀렉터 ' + sel); };
  const openSheet = new Function('h', '$', sheetSrc + '\nreturn openSheet;')(h, $);
  return { h, openSheet };
}

/* ---------- 가짜 타이머, 저장소, 네트워크 ---------- */

export function fakeTimers() {
  let now = 0, seq = 0;
  const q = new Map();
  return {
    setTimeout(fn, ms) { seq += 1; q.set(seq, { at: now + ms, fn }); return seq; },
    clearTimeout(id) { q.delete(id); },
    advance(ms) {
      const end = now + ms;
      for (;;) {
        let next = null;
        for (const [id, t] of q) if (t.at <= end && (!next || t.at < next[1].at)) next = [id, t];
        if (!next) break;
        q.delete(next[0]);
        now = next[1].at;
        next[1].fn();
      }
      now = end;
    },
    pending() { return q.size; }
  };
}

export class FakeStorage {
  constructor() { this.map = new Map(); this.writes = 0; this.removes = 0; }
  getItem(k) { return this.map.has(k) ? this.map.get(k) : null; }
  setItem(k, v) { this.writes += 1; this.map.set(k, String(v)); }
  removeItem(k) { this.removes += 1; this.map.delete(k); }
  keys() { return [...this.map.keys()]; }
  dump() { return [...this.map.entries()].map(([k, v]) => k + '=' + v).join('\n'); }
}

export function fakeResponse(status, body, headers) {
  const hs = headers || {};
  return { status, headers: { get: k => (hs[k] == null ? null : hs[k]) }, json: async () => body };
}

// handler(url, init) -> Response | Error 를 던지면 네트워크 실패. 호출 기록은 calls.
export function fakeFetch(handler) {
  const calls = [];
  const fn = async (url, init) => { calls.push({ url, init }); return handler(url, init); };
  fn.calls = calls;
  return fn;
}

export const flush = () => new Promise(r => setImmediate(r));
