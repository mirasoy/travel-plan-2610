import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import { readApp, APP_DIR } from './helpers.mjs';

const ORIGIN = 'https://app.example.test';

// 실제 sw.js 소스를 그대로 vm 에서 실행하고, 등록된 이벤트 핸들러를 꺼낸다.
function loadSw() {
  const handlers = {};
  const calls = { cachesOpen: 0, cachesMatch: 0, fetch: 0, put: 0 };
  const cache = { addAll: async () => {}, put: async () => { calls.put += 1; } };
  const ctx = {
    self: { addEventListener: (t, fn) => { handlers[t] = fn; }, skipWaiting() {}, clients: { claim: async () => {} } },
    location: { origin: ORIGIN },
    URL, Promise,
    caches: {
      open: async () => { calls.cachesOpen += 1; return cache; },
      match: async () => { calls.cachesMatch += 1; return undefined; },
      keys: async () => [], delete: async () => true
    },
    fetch: async () => { calls.fetch += 1; return { clone() { return this; } }; }
  };
  vm.runInNewContext(readApp('sw.js'), ctx);
  return { handlers, calls, cache };
}

// 브라우저처럼 fetch 이벤트를 흘려보내 respondWith 가 불렸는지 본다.
function fire(sw, url, method, mode) {
  let responded = false;
  sw.handlers.fetch({ request: { url, method: method || 'GET', mode: mode || 'cors' }, respondWith() { responded = true; } });
  return responded;
}

test('/vault 요청은 오리진, 메서드, 쿼리, 하위 경로, 슬래시와 상관없이 가로채지도 캐시하지도 않는다', () => {
  const urls = [
    ['POST', 'https://resolver.example.test/vault'],          // 실제 형태: 다른 오리진의 Worker
    ['POST', ORIGIN + '/vault'],
    ['GET', ORIGIN + '/vault'],                                // 같은 오리진 GET 은 원래 네트워크 우선 캐시 대상이었다
    ['GET', ORIGIN + '/vault?x=1'],
    ['GET', ORIGIN + '/vault/'],
    ['GET', ORIGIN + '/trip-app/vault'],
    ['GET', 'https://resolver.example.test/api/vault'],
    ['PUT', 'https://resolver.example.test/vault']
  ];
  for (const [method, url] of urls) {
    const sw = loadSw();
    assert.equal(fire(sw, url, method), false, method + ' ' + url + ' 을 가로챘다');
    assert.deepEqual(sw.calls, { cachesOpen: 0, cachesMatch: 0, fetch: 0, put: 0 }, method + ' ' + url + ' 이 캐시/네트워크를 건드렸다');
  }
  const nav = loadSw();
  assert.equal(fire(nav, ORIGIN + '/vault', 'GET', 'navigate'), false, '네비게이션 모드도 통과');
});

test('대조군: 일반 같은 오리진 GET 은 기존처럼 가로채 캐시한다(위 테스트가 실제로 감지력이 있다는 증거)', async () => {
  const sw = loadSw();
  assert.equal(fire(sw, ORIGIN + '/app.js'), true);
  assert.equal(fire(sw, ORIGIN + '/trip-app/vault.js'), true, 'vault.js 앱 파일은 다른 파일처럼 캐시 대상이다(정규식이 파일명까지 삼키지 않는다)');
  assert.equal(fire(sw, ORIGIN + '/trip-app/vault-ui.js'), true);
  assert.equal(fire(sw, ORIGIN + '/vaults'), true, '/vaults 는 금고 경로가 아니다');
  assert.equal(fire(sw, ORIGIN + '/x', 'GET', 'navigate'), true);
  assert.equal(fire(sw, 'https://other.example.test/x'), false, '다른 오리진 일반 GET 은 기존처럼 건드리지 않는다');
  assert.equal(fire(sw, ORIGIN + '/app.js', 'POST'), false, '일반 POST 는 기존처럼 통과');
  await new Promise(r => setImmediate(r));
  assert.ok(sw.calls.fetch >= 1, '가로챈 요청은 네트워크 우선으로 처리된다');
});

test('설치: 셸 목록의 모든 파일이 실제로 있고 금고 모듈이 포함돼 있다, 캐시 버전은 올라갔다', async () => {
  const src = readApp('sw.js');
  const list = src.match(/const SHELL = \[([\s\S]*?)\];/)[1].match(/'([^']+)'/g).map(s => s.slice(1, -1));
  assert.ok(list.includes('vault.js') && list.includes('vault-ui.js'));
  for (const f of list) {
    if (f === './') continue;
    assert.ok(fs.existsSync(path.join(APP_DIR, f)), '셸 목록에 있지만 파일이 없음: ' + f);
  }
  assert.match(src, /const CACHE = 'trip-shell-v(\d+)'/);
  assert.ok(Number(src.match(/trip-shell-v(\d+)/)[1]) >= 7, '새 파일을 셸에 넣었으니 캐시 버전을 올려야 한다');
});
