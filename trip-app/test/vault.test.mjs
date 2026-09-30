import test from 'node:test';
import assert from 'node:assert/strict';
import { createVault, normalizeVault, tooManyMessage, MESSAGES, TOKEN_KEY } from '../vault.js';
import { FAKE_TOKEN, FAKE_DATA, FakeStorage, fakeTimers, fakeFetch, fakeResponse } from './helpers.mjs';

const BASE = 'https://resolver.example.test';
const okBody = { success: true, fetchedAt: '2000-01-01T00:00:00Z', data: FAKE_DATA };

function make(handler, extra) {
  const fetchFn = fakeFetch(handler);
  const storage = new FakeStorage();
  const timers = fakeTimers();
  const vault = createVault(Object.assign({ getBaseUrl: () => BASE, fetchFn, storage, timers }, extra));
  return { vault, fetchFn, storage, timers };
}

test('요청: POST /vault, 토큰은 Authorization 헤더에만, 본문과 쿼리 없음', async () => {
  const { vault, fetchFn } = make(() => fakeResponse(200, okBody), { getBaseUrl: () => BASE + '/' });
  const r = await vault.fetchVault('  ' + FAKE_TOKEN + '  ');
  assert.equal(r.ok, true);
  const { url, init } = fetchFn.calls[0];
  assert.equal(url, BASE + '/vault');            // 끝 슬래시 중복 없음
  assert.equal(init.method, 'POST');
  assert.equal(init.headers.Authorization, 'Bearer ' + FAKE_TOKEN); // 앞뒤 공백 제거
  assert.ok(!('body' in init), '본문을 보내지 않는다');
  assert.ok(!url.includes(FAKE_TOKEN) && !url.includes('?'), 'URL 에 토큰이나 쿼리가 없다');
  assert.equal(init.cache, 'no-store');
  assert.equal(init.credentials, 'omit');
});

test('성공 응답: 계약된 구조만 남기고 나머지 필드는 버린다', async () => {
  const body = { success: true, data: { updatedAt: 5, secretExtra: 'X', groups: [{ title: 'T', junk: 1, items: [{ label: 'L', value: 7, extra: 'E' }, null] }, null] } };
  const { vault } = make(() => fakeResponse(200, body));
  const r = await vault.fetchVault(FAKE_TOKEN);
  assert.deepEqual(r.data, {
    updatedAt: '5',
    groups: [{ title: 'T', items: [{ label: 'L', value: '7' }, { label: '', value: '' }] }, { title: '', items: [] }]
  });
});

test('상태코드별 문구', async () => {
  const cases = [
    [401, {}, 'unauthorized', MESSAGES.unauthorized],
    [503, {}, 'serverConfig', MESSAGES.serverConfig],
    [500, {}, 'serverConfig', MESSAGES.serverConfig],
    [403, {}, 'serverConfig', MESSAGES.serverConfig],
    [404, {}, 'unknown', MESSAGES.unknown],
    [429, { 'Retry-After': '90' }, 'tooMany', '잠시 뒤에 다시 시도해 주세요(2분 뒤)']
  ];
  for (const [status, headers, kind, message] of cases) {
    const { vault } = make(() => fakeResponse(status, { error: 'FAKE-BODY-SHOULD-NOT-LEAK' }, headers));
    const r = await vault.fetchVault(FAKE_TOKEN);
    assert.equal(r.ok, false, String(status));
    assert.equal(r.kind, kind, String(status));
    assert.equal(r.message, message, String(status));
  }
});

test('429 Retry-After 계산: 올림, 60초는 1분, 3601초는 61분, 헤더 없음/이상값은 시간 없이', () => {
  assert.equal(tooManyMessage('1'), '잠시 뒤에 다시 시도해 주세요(1분 뒤)');
  assert.equal(tooManyMessage('60'), '잠시 뒤에 다시 시도해 주세요(1분 뒤)');
  assert.equal(tooManyMessage('61'), '잠시 뒤에 다시 시도해 주세요(2분 뒤)');
  assert.equal(tooManyMessage('3601'), '잠시 뒤에 다시 시도해 주세요(61분 뒤)');
  for (const bad of [null, undefined, '', '0', '-5', 'abc', 'Wed, 21 Oct 2026 07:28:00 GMT']) {
    assert.equal(tooManyMessage(bad), '잠시 뒤에 다시 시도해 주세요', String(bad));
  }
});

test('네트워크 실패와 200 응답의 깨진 본문은 각각 다른 문구', async () => {
  const net = make(() => { throw new Error('FAKE-NET-ERR ' + FAKE_TOKEN); });
  const r1 = await net.vault.fetchVault(FAKE_TOKEN);
  assert.deepEqual([r1.kind, r1.message], ['network', MESSAGES.network]);
  assert.ok(!JSON.stringify(r1).includes(FAKE_TOKEN), '예외 메시지의 토큰이 결과에 실리지 않는다');

  const badJson = make(() => ({ status: 200, headers: { get: () => null }, json: async () => { throw new Error('bad'); } }));
  assert.equal((await badJson.vault.fetchVault(FAKE_TOKEN)).kind, 'unknown');

  for (const body of [null, {}, { success: false, data: FAKE_DATA }, { success: true }, { success: true, data: { groups: 'x' } }]) {
    const m = make(() => fakeResponse(200, body));
    assert.equal((await m.vault.fetchVault(FAKE_TOKEN)).kind, 'unknown', JSON.stringify(body));
  }
});

test('오류 결과에는 토큰도 응답 본문도 실리지 않는다', async () => {
  for (const status of [401, 429, 500, 503, 403, 418]) {
    const { vault } = make(() => fakeResponse(status, { error: 'FAKE-BODY-SHOULD-NOT-LEAK', detail: FAKE_TOKEN }, { 'Retry-After': '30' }));
    const s = JSON.stringify(await vault.fetchVault(FAKE_TOKEN));
    assert.ok(!s.includes(FAKE_TOKEN) && !s.includes('FAKE-BODY-SHOULD-NOT-LEAK'), String(status));
  }
});

test('빈 토큰, 주소 없음이면 요청 자체를 보내지 않는다', async () => {
  const a = make(() => fakeResponse(200, okBody));
  assert.equal((await a.vault.fetchVault('   ')).message, MESSAGES.empty);
  assert.equal((await a.vault.fetchVault(null)).kind, 'empty');
  assert.equal(a.fetchFn.calls.length, 0);
  const b = make(() => fakeResponse(200, okBody), { getBaseUrl: () => '' });
  assert.equal((await b.vault.fetchVault(FAKE_TOKEN)).kind, 'noResolver');
  assert.equal(b.fetchFn.calls.length, 0);
});

test('15초 넘게 응답이 없으면 중단하고 네트워크 실패로 처리, 타이머는 정리한다', async () => {
  const hang = make((url, init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(new Error('aborted')))));
  const p = hang.vault.fetchVault(FAKE_TOKEN);
  hang.timers.advance(15000);
  const r = await p;
  assert.equal(r.kind, 'network');
  assert.equal(hang.timers.pending(), 0);

  const fast = make(() => fakeResponse(200, okBody));
  await fast.vault.fetchVault(FAKE_TOKEN);
  assert.equal(fast.timers.pending(), 0, '성공 뒤에도 타임아웃 타이머가 남지 않는다');
});

test('토큰 저장소: 키는 vaultToken 하나, 저장소가 던져도 죽지 않는다', () => {
  const { vault, storage } = make(() => fakeResponse(200, okBody));
  assert.equal(vault.getRememberedToken(), null);
  assert.equal(vault.rememberToken(FAKE_TOKEN), true);
  assert.deepEqual(storage.keys(), [TOKEN_KEY]);
  assert.equal(TOKEN_KEY, 'vaultToken');
  assert.equal(vault.getRememberedToken(), FAKE_TOKEN);
  vault.forgetToken();
  assert.deepEqual(storage.keys(), []);

  const boom = { getItem() { throw new Error('x'); }, setItem() { throw new Error('x'); }, removeItem() { throw new Error('x'); } };
  const v2 = createVault({ getBaseUrl: () => BASE, fetchFn: fakeFetch(() => fakeResponse(200, okBody)), storage: boom, timers: fakeTimers() });
  assert.equal(v2.getRememberedToken(), null);
  assert.equal(v2.rememberToken(FAKE_TOKEN), false);
  assert.doesNotThrow(() => v2.forgetToken());
});

test('normalizeVault: success 가 true 가 아니면 null', () => {
  assert.equal(normalizeVault({ success: 'true', data: FAKE_DATA }), null);
  assert.equal(normalizeVault(undefined), null);
});
