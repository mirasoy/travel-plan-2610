import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { normalizeKey, extractKey, resolveKey, saveKey, clearKey, inviteLink, KEY_STORAGE } from '../trip-key.js';
import { FakeStorage, APP_DIR, readApp } from './helpers.mjs';

// 테스트용 가짜 키(실제 키가 아님)
const K1 = '11111111-2222-4333-8444-555555555555';
const K1_HEX = '11111111222243338444555555555555';
const K2 = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

function env(opts) {
  const o = opts || {};
  const replaced = [];
  const location = { origin: 'https://site.example.test', pathname: '/trip-app/', search: o.search || '', hash: o.hash || '' };
  const history = { replaceState: (...a) => { if (o.historyThrows) throw new Error('x'); replaced.push(a[2]); } };
  const storage = o.storage || new FakeStorage();
  return { location, history, storage, replaced };
}

test('normalizeKey: 대시 있음/없음, 대문자는 소문자로. 형식이 틀리면 null', () => {
  assert.equal(normalizeKey(K1), K1);
  assert.equal(normalizeKey(K1_HEX), K1_HEX);
  assert.equal(normalizeKey('  ' + K1.toUpperCase() + '\n'), K1);
  for (const bad of ['', null, undefined, 'abc', K1 + 'x', 'x' + K1, K1.slice(1), '../' + K1, K1.replace(/1/g, 'g'), '11111111-2222-4333-8444-55555555555']) {
    assert.equal(normalizeKey(bad), null, String(bad));
  }
});

test('extractKey: 키만, 전체 링크(#k=, ?k=), 공백/줄바꿈 포함 붙여넣기. 그 밖은 null', () => {
  assert.equal(extractKey(K1), K1);
  assert.equal(extractKey('https://site.example.test/trip-app/#k=' + K1), K1);
  assert.equal(extractKey('https://site.example.test/trip-app/?x=1&k=' + K1.toUpperCase() + '#a=b'), K1);
  assert.equal(extractKey('  \n#k=' + K1 + '\n'), K1);
  assert.equal(extractKey('#a=1&k=' + K1_HEX), K1_HEX);
  assert.equal(extractKey('#k=%E0%A4%A'), null, '깨진 % 인코딩에도 예외 없이 null');
  for (const bad of ['', null, 'hello', 'https://site.example.test/', '#k=short', '#kk=' + K1, 'k=' + K1.slice(2)]) {
    assert.equal(extractKey(bad), null, String(bad));
  }
});

test('주소의 #k= : 저장하고, 주소창에서는 k 만 지운다(검색어, 다른 해시 파라미터는 보존)', () => {
  const e = env({ hash: '#k=' + K1, search: '?x=1' });
  const r = resolveKey(e);
  assert.deepEqual(r, { key: K1, source: 'url' });
  assert.equal(e.storage.getItem(KEY_STORAGE), K1);
  assert.deepEqual(e.replaced, ['/trip-app/?x=1']);

  const e2 = env({ hash: '#a=1&k=' + K1 + '&b=2' });
  resolveKey(e2);
  assert.deepEqual(e2.replaced, ['/trip-app/#a=1&b=2']);
});

test('저장소에 있으면 그것을 쓴다. 주소의 키가 저장된 키보다 우선이고 덮어쓴다(다른 여행으로 갈아타기)', () => {
  const storage = new FakeStorage(); storage.setItem(KEY_STORAGE, K1);
  const a = env({ storage });
  assert.deepEqual(resolveKey(a), { key: K1, source: 'storage' });
  assert.deepEqual(a.replaced, [], '해시가 없으면 주소를 건드리지 않는다');

  const b = env({ storage, hash: '#k=' + K2 });
  assert.deepEqual(resolveKey(b), { key: K2, source: 'url' });
  assert.equal(storage.getItem(KEY_STORAGE), K2);
});

test('키가 어디에도 없으면 null, 형식이 틀린 k 는 무시하고 지운다', () => {
  const none = env();
  assert.deepEqual(resolveKey(none), { key: null, source: null });
  assert.deepEqual(none.replaced, []);

  const storage = new FakeStorage(); storage.setItem(KEY_STORAGE, K1);
  const bad = env({ storage, hash: '#k=not-a-key' });
  assert.deepEqual(resolveKey(bad), { key: K1, source: 'storage' }, '잘못된 k 는 저장된 키를 덮지 못한다');
  assert.deepEqual(bad.replaced, ['/trip-app/']);

  const corrupt = new FakeStorage(); corrupt.setItem(KEY_STORAGE, 'garbage');
  assert.deepEqual(resolveKey(env({ storage: corrupt })), { key: null, source: null }, '저장소의 값이 깨졌으면 없는 것으로 본다');
});

test('저장이 막힌 브라우저: 키는 이번 방문에 쓰되 주소창에서 지우지 않는다(새로고침해도 접근 유지)', () => {
  const blocked = { getItem() { return null; }, setItem() { throw new Error('quota'); }, removeItem() {} };
  const e = env({ storage: blocked, hash: '#k=' + K1 });
  assert.deepEqual(resolveKey(e), { key: K1, source: 'url' });
  assert.deepEqual(e.replaced, []);

  const silent = { getItem() { return null; }, setItem() {}, removeItem() {} }; // 쓰기는 되는 척하지만 읽히지 않음
  const e2 = env({ storage: silent, hash: '#k=' + K1 });
  assert.equal(resolveKey(e2).key, K1);
  assert.deepEqual(e2.replaced, [], '읽기 검증에 실패하면 해시를 남긴다');

  const throwing = { getItem() { throw new Error('x'); }, setItem() { throw new Error('x'); }, removeItem() { throw new Error('x'); } };
  assert.deepEqual(resolveKey(env({ storage: throwing })), { key: null, source: null });
  assert.doesNotThrow(() => clearKey(throwing));
  assert.equal(saveKey(throwing, K1), false);
});

test('replaceState 가 던져도 앱은 죽지 않는다', () => {
  const e = env({ hash: '#k=' + K1, historyThrows: true });
  assert.equal(resolveKey(e).key, K1);
});

test('inviteLink: 오리진+경로+#k=키 뿐(쿼리와 다른 해시는 넣지 않는다), clearKey 로 지워진다', () => {
  const e = env({ search: '?title=x&text=y', hash: '#other=1' });
  assert.equal(inviteLink(e.location, K1), 'https://site.example.test/trip-app/#k=' + K1);
  e.storage.setItem(KEY_STORAGE, K1); clearKey(e.storage);
  assert.equal(e.storage.getItem(KEY_STORAGE), null);
});

test('회귀 방지: 소스에 여행 키(UUID/32자리 hex)가 박혀 있지 않다, config.js 에 tripId 없음, 내보내기에 키를 넣지 않는다', () => {
  const root = path.join(APP_DIR, '..');
  const hexRe = /\b[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}\b/i;
  const hits = [];
  (function walk(dir) {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      if (ent.name === '.git' || ent.name === 'node_modules' || ent.name === 'test') continue;
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) { walk(p); continue; }
      if (!/\.(js|mjs|html|css|json|md|txt)$/.test(ent.name)) continue;
      if (hexRe.test(fs.readFileSync(p, 'utf8'))) hits.push(path.relative(root, p));
    }
  })(root);
  assert.deepEqual(hits, [], '키처럼 생긴 값이 소스에 있음');
  assert.ok(!/tripId/.test(readApp('config.js').replace(/\/\/.*$/gm, '')), 'config.js 에 tripId 가 남아 있다');
  const exp = readApp('app.js').match(/^async function exportJson\(\) \{[\s\S]*?^\}/m)[0];
  assert.ok(!/TRIP_KEY|tripId|KEY\b/.test(exp), '내보내기 파일에 키가 들어간다');
});
