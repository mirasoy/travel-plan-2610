import test from 'node:test';
import assert from 'node:assert/strict';
import { createVault, MESSAGES } from '../vault.js';
import { openVaultModal, MASK } from '../vault-ui.js';
import {
  FakeElement, FakeDocument, FakeStorage, fakeTimers, fakeFetch, fakeResponse, flush, loadAppHelpers,
  byTag, byClass, byText, walk, FAKE_TOKEN, FAKE_DATA, ALL_FAKE_VALUES
} from './helpers.mjs';

const BASE = 'https://resolver.example.test';
const okBody = { success: true, data: FAKE_DATA };

function setup(opts) {
  const o = opts || {};
  const document = new FakeDocument();
  const modalRoot = new FakeElement('div');
  const { h, openSheet } = loadAppHelpers(document, modalRoot);
  const timers = fakeTimers();
  const local = new FakeStorage();
  const session = new FakeStorage();
  if (o.remembered) { local.setItem('vaultToken', o.remembered); local.writes = 0; }
  const fetchFn = fakeFetch(o.handler || (() => fakeResponse(200, okBody)));
  const vault = createVault({ getBaseUrl: () => BASE, fetchFn, storage: local, timers });
  const toasts = [];
  const copied = [];
  const clipboard = o.clipboard === undefined ? { writeText: async v => { copied.push(v); } } : o.clipboard;
  const env = { document, modalRoot, timers, local, session, fetchFn, toasts, copied, close: null };
  env.open = () => (env.close = openVaultModal({ h, openSheet, toast: m => toasts.push(m), vault, timers, doc: document, clipboard }));
  env.text = () => modalRoot.textContent;
  env.field = type => byTag(modalRoot, 'input').find(i => i.attrs.type === type);
  env.submitToken = async (token, remember) => {
    env.field('password').value = token;
    env.field('checkbox').checked = !!remember;
    byTag(modalRoot, 'form')[0].dispatch('submit');
    await flush();
  };
  env.vals = () => byClass(modalRoot, 'vault-val');
  env.root = () => byClass(modalRoot, 'vault')[0];
  env.shutdown = () => { if (env.close) env.close(); };
  return env;
}

// 화면 트리 전체(텍스트 + 속성값)를 하나의 문자열로
function everything(root) {
  const parts = [];
  walk(root, n => {
    if (n.nodeType === 3) parts.push(n.text);
    else parts.push(...Object.values(n.attrs), n.value || '');
  });
  return parts.join('\n');
}

const hasAnyValue = s => ALL_FAKE_VALUES.some(v => s.includes(v));

test('정상 표시: 그룹 제목과 라벨은 보이고 값은 점으로 가려져 있다(텍스트와 속성 어디에도 값이 없다)', async t => {
  const env = setup(); t.after(env.shutdown); env.open();
  const pw = env.field('password');
  assert.equal(pw.attrs.autocomplete, 'current-password');
  assert.equal(env.field('checkbox').checked, false, '기억 체크박스 기본은 꺼짐');
  assert.ok(env.text().includes('이 기기에서 기억'));

  await env.submitToken(FAKE_TOKEN, false);
  assert.equal(env.fetchFn.calls.length, 1);
  const text = env.text();
  for (const g of FAKE_DATA.groups) {
    assert.ok(text.includes(g.title));
    for (const it of g.items) assert.ok(text.includes(it.label));
  }
  assert.equal(env.vals().length, 3);
  assert.ok(env.vals().every(v => v.textContent === MASK));
  assert.ok(!hasAnyValue(everything(env.modalRoot)), '가려진 동안 DOM 어디에도 값이 없다');
  assert.ok(!everything(env.modalRoot).includes(FAKE_TOKEN), '화면에 토큰이 남아 있지 않다');
  assert.equal(env.field('password'), undefined, '입력칸은 사라졌다');
});

test('값 보기: 탭하면 10초 뒤 자동으로 다시 가려진다, 다시 탭하면 즉시 가린다', async t => {
  const env = setup(); t.after(env.shutdown); env.open();
  await env.submitToken(FAKE_TOKEN);
  const [v1, v2] = env.vals();

  v1.dispatch('click');
  assert.equal(v1.textContent, 'FAKE-VALUE-ONE');
  assert.equal(v2.textContent, MASK, '다른 항목은 그대로 가려져 있다');
  env.timers.advance(9999);
  assert.equal(v1.textContent, 'FAKE-VALUE-ONE');
  env.timers.advance(1);
  assert.equal(v1.textContent, MASK);
  assert.ok(!hasAnyValue(everything(env.modalRoot)));

  v2.dispatch('click');
  assert.equal(v2.textContent, 'FAKE-VALUE-TWO');
  v2.dispatch('click');
  assert.equal(v2.textContent, MASK, '보이는 중에 다시 탭하면 즉시 가린다');
});

test('복사: 클립보드에는 값이 가고, 토스트에는 값이 없다. 클립보드 불가/실패 시 안내', async t => {
  const env = setup(); t.after(env.shutdown); env.open();
  await env.submitToken(FAKE_TOKEN);
  byText(env.modalRoot, '복사')[0].dispatch('click');
  await flush();
  assert.deepEqual(env.copied, ['FAKE-VALUE-ONE']);
  assert.deepEqual(env.toasts, ['복사했어요']);
  assert.ok(env.vals()[0].textContent === MASK, '복사해도 화면에 값을 드러내지 않는다');
  env.shutdown();

  const none = setup({ clipboard: null }); t.after(none.shutdown); none.open();
  await none.submitToken(FAKE_TOKEN);
  byText(none.modalRoot, '복사')[0].dispatch('click');
  await flush();
  assert.deepEqual(none.toasts, ['복사하지 못했어요']);
  none.shutdown();

  const rej = setup({ clipboard: { writeText: () => Promise.reject(new Error('denied')) } }); t.after(rej.shutdown); rej.open();
  await rej.submitToken(FAKE_TOKEN);
  byText(rej.modalRoot, '복사')[0].dispatch('click');
  await flush();
  assert.deepEqual(rej.toasts, ['복사하지 못했어요']);
});

test('오류 문구: 401 / 429 / 503 / 500 / 네트워크 실패. 토큰과 응답 내용은 화면에 없다', async t => {
  const cases = [
    [() => fakeResponse(401, { error: 'unauthorized' }), '토큰이 달라요'],
    [() => fakeResponse(429, { error: 'too_many_attempts' }, { 'Retry-After': '180' }), '잠시 뒤에 다시 시도해 주세요(3분 뒤)'],
    [() => fakeResponse(429, { error: 'too_many_attempts' }), '잠시 뒤에 다시 시도해 주세요'],
    [() => fakeResponse(503, { error: 'vault_not_configured', detail: FAKE_TOKEN }), '서버 설정을 확인해 주세요'],
    [() => fakeResponse(500, { error: 'vault_misconfigured' }), '서버 설정을 확인해 주세요'],
    [() => { throw new Error('offline ' + FAKE_TOKEN); }, '연결을 확인해 주세요']
  ];
  for (const [handler, expected] of cases) {
    const env = setup({ handler }); env.open();
    await env.submitToken(FAKE_TOKEN, false);
    const alert = byClass(env.modalRoot, 'notice')[0];
    assert.equal(alert.textContent, expected);
    assert.equal(alert.attrs.role, 'alert');
    assert.ok(!everything(env.modalRoot).includes(FAKE_TOKEN), '화면에 토큰이 없다');
    assert.ok(env.field('password'), '다시 입력할 수 있게 입력칸으로 돌아온다');
    assert.equal(env.local.writes, 0, '실패했으니 아무것도 저장하지 않는다');
    env.shutdown();
  }
});

test('빈 토큰 제출은 요청 없이 안내만', async t => {
  const env = setup(); t.after(env.shutdown); env.open();
  await env.submitToken('   ');
  assert.equal(env.fetchFn.calls.length, 0);
  assert.equal(byClass(env.modalRoot, 'notice')[0].textContent, MESSAGES.empty);
});

test('60초 무조작: 데이터와 보이던 값이 DOM 에서 사라지고, 다시 조회는 메모리의 토큰을 쓴다', async t => {
  const env = setup(); t.after(env.shutdown); env.open();
  await env.submitToken(FAKE_TOKEN, false);
  env.vals()[0].dispatch('click'); // 값이 보이는 상태로 두고 시작
  env.timers.advance(59999);
  assert.ok(env.text().includes('FAKE-GROUP-A'));
  env.timers.advance(1);
  const s = everything(env.modalRoot);
  assert.ok(!s.includes('FAKE-GROUP') && !s.includes('FAKE-LABEL') && !hasAnyValue(s), '그룹, 라벨, 값이 모두 지워졌다');
  assert.ok(s.includes('60초 동안 조작이 없어서'));
  assert.equal(env.timers.pending(), 0, '남은 타이머가 없다');

  byText(env.modalRoot, '다시 조회')[0].dispatch('click');
  await flush();
  assert.equal(env.fetchFn.calls.length, 2);
  assert.equal(env.fetchFn.calls[1].init.headers.Authorization, 'Bearer ' + FAKE_TOKEN);
  assert.ok(env.text().includes('FAKE-GROUP-A'));
});

test('조작(탭, 키 입력)이 있으면 60초 타이머가 다시 시작된다', async t => {
  const env = setup(); t.after(env.shutdown); env.open();
  await env.submitToken(FAKE_TOKEN);
  env.timers.advance(59000);
  env.vals()[1].dispatch('pointerdown'); // 버블링으로 모달 루트의 poke 에 도달
  env.timers.advance(59000);
  assert.ok(env.text().includes('FAKE-GROUP-A'), '조작 뒤 59초까지는 유지');
  env.root().dispatch('keydown');
  env.timers.advance(59999);
  assert.ok(env.text().includes('FAKE-GROUP-A'));
  env.timers.advance(1);
  assert.ok(!env.text().includes('FAKE-GROUP-A'));
});

test('탭이 백그라운드로 가면 즉시 지운다. 조회 중에 백그라운드로 가면 결과를 표시하지 않는다', async t => {
  const env = setup(); t.after(env.shutdown); env.open();
  await env.submitToken(FAKE_TOKEN);
  env.vals()[0].dispatch('click');
  env.document.setVisibility('hidden');
  const s = everything(env.modalRoot);
  assert.ok(!s.includes('FAKE-GROUP') && !hasAnyValue(s));
  assert.ok(s.includes('백그라운드'));
  env.shutdown();

  let release;
  const slow = setup({ handler: () => new Promise(r => { release = () => r(fakeResponse(200, okBody)); }) });
  t.after(slow.shutdown); slow.open();
  await slow.submitToken(FAKE_TOKEN);        // 응답 대기 중
  slow.document.setVisibility('hidden');
  release();
  await flush();
  const s2 = everything(slow.modalRoot);
  assert.ok(!s2.includes('FAKE-GROUP') && !hasAnyValue(s2), '숨겨진 상태로 도착한 데이터는 그리지 않는다');
  assert.ok(s2.includes('백그라운드'));
});

test('모달을 닫으면(버튼, 바깥 탭 모두) DOM, 리스너, 타이머가 정리되고 토큰은 다시 물어본다', async t => {
  for (const how of ['button', 'overlay']) {
    const env = setup(); t.after(env.shutdown); env.open();
    await env.submitToken(FAKE_TOKEN, false);
    env.vals()[0].dispatch('click');
    assert.equal(env.document.listenerCount('visibilitychange'), 1);

    if (how === 'button') byText(env.modalRoot, '닫기')[0].dispatch('click');
    else { const ov = env.modalRoot.children[0]; ov.dispatch('click', { target: ov }); }

    assert.equal(env.modalRoot.children.length, 0, how + ': 오버레이가 사라졌다');
    assert.equal(env.modalRoot.textContent, '');
    assert.equal(env.document.listenerCount('visibilitychange'), 0);
    assert.equal(env.timers.pending(), 0);

    const before = env.fetchFn.calls.length;
    env.open();                                    // 다시 열면 자동 조회 없이 토큰부터 물어본다
    assert.equal(env.fetchFn.calls.length, before);
    assert.ok(env.field('password'));
    assert.ok(!env.text().includes('FAKE-GROUP'));
    env.shutdown();
  }
});

test('조회 중에 닫으면 늦게 도착한 응답을 버린다', async t => {
  let release;
  const env = setup({ handler: () => new Promise(r => { release = () => r(fakeResponse(200, okBody)); }) });
  t.after(env.shutdown); env.open();
  await env.submitToken(FAKE_TOKEN, true);   // 기억을 켰어도 성공 처리 전에 닫혔으니 저장되면 안 된다
  env.close();
  release();
  await flush();
  assert.equal(env.modalRoot.children.length, 0);
  assert.equal(env.modalRoot.textContent, '');
  assert.equal(env.local.writes, 0, '닫힌 뒤에 도착한 응답으로 저장이 일어나지 않는다');
});

test('모달 중복 오픈 방지: 두 번째 호출은 무시, 닫은 뒤에는 다시 열린다', t => {
  const env = setup(); t.after(env.shutdown);
  env.open();
  const first = env.close;
  const second = env.open();
  assert.equal(second, null);
  env.close = first;
  assert.equal(env.modalRoot.children.length, 1);
  first();
  assert.ok(env.open(), '닫은 뒤에는 다시 열린다');
});

test('기억 끔: localStorage, sessionStorage 어디에도 쓰지 않는다', async t => {
  const env = setup(); t.after(env.shutdown); env.open();
  await env.submitToken(FAKE_TOKEN, false);
  assert.deepEqual(env.local.keys(), []);
  assert.equal(env.local.writes, 0);
  assert.equal(env.session.writes, 0);
  assert.ok(!env.local.dump().includes(FAKE_TOKEN));
});

test('기억 켬: localStorage 의 vaultToken 하나에만 토큰을 저장하고, 다음에 열면 자동 조회한다', async t => {
  const env = setup(); t.after(env.shutdown); env.open();
  await env.submitToken(FAKE_TOKEN, true);
  assert.deepEqual(env.local.keys(), ['vaultToken']);
  assert.equal(env.local.getItem('vaultToken'), FAKE_TOKEN);
  assert.equal(env.session.writes, 0);
  env.close();

  env.open();                                     // 저장된 토큰으로 열자마자 조회
  await flush();
  assert.equal(env.fetchFn.calls.length, 2);
  assert.equal(env.fetchFn.calls[1].init.headers.Authorization, 'Bearer ' + FAKE_TOKEN);
  assert.ok(env.text().includes('FAKE-GROUP-A'));
});

test('기억한 토큰: 401 이면 지우고, 429/네트워크 오류면 남기며 재조회 버튼을 준다', async t => {
  const bad = setup({ remembered: FAKE_TOKEN, handler: () => fakeResponse(401, {}) }); t.after(bad.shutdown);
  bad.open(); await flush();
  assert.deepEqual(bad.local.keys(), [], '틀린 것으로 판명된 저장 토큰은 지운다');
  assert.equal(byClass(bad.modalRoot, 'notice')[0].textContent, '토큰이 달라요');
  // 새 토큰을 기억 끔으로 입력하면 아무것도 저장되지 않는다
  await bad.submitToken('FAKE-TOKEN-NEW', false);
  assert.deepEqual(bad.local.keys(), []);
  bad.shutdown();

  for (const handler of [() => fakeResponse(429, {}, { 'Retry-After': '60' }), () => { throw new Error('x'); }]) {
    const env = setup({ remembered: FAKE_TOKEN, handler }); env.open(); await flush();
    assert.deepEqual(env.local.keys(), ['vaultToken'], '토큰 탓이 아닌 실패에는 저장 토큰을 남긴다');
    assert.ok(byText(env.modalRoot, '저장된 토큰으로 다시 조회').length === 1);
    assert.equal(env.field('checkbox').checked, true, '기억 체크박스가 켜진 상태로 보인다');
    env.shutdown();
  }
});

test('기억 중에는 데이터 화면에서 "이 기기에서 토큰 잊기"로 지울 수 있다', async t => {
  const env = setup({ remembered: FAKE_TOKEN }); t.after(env.shutdown);
  env.open(); await flush();
  byText(env.modalRoot, '이 기기에서 토큰 잊기')[0].dispatch('click');
  assert.deepEqual(env.local.keys(), []);
  assert.deepEqual(env.toasts, ['이 기기에서 토큰을 지웠어요']);
  assert.equal(byText(env.modalRoot, '이 기기에서 토큰 잊기').length, 0);
  assert.ok(env.text().includes('FAKE-GROUP-A'), '화면의 데이터는 그대로');
});

test('전 과정에서 응답 데이터가 어떤 저장소, 캐시, 콘솔에도 남지 않는다', async t => {
  // 접근 자체를 세는 스파이. vault 모듈이 이 이름들을 건드리면 카운트가 오른다.
  const touched = [];
  const names = ['sessionStorage', 'localStorage', 'caches', 'indexedDB', 'BroadcastChannel'];
  const saved = names.map(n => [n, Object.getOwnPropertyDescriptor(globalThis, n)]);
  names.forEach(n => Object.defineProperty(globalThis, n, { configurable: true, get() { touched.push(n); return undefined; } }));
  const consoleCalls = [];
  const cm = ['log', 'info', 'warn', 'error', 'debug', 'trace'];
  const origConsole = cm.map(k => [k, console[k]]);
  cm.forEach(k => { console[k] = (...a) => consoleCalls.push([k, a]); });
  t.after(() => {
    saved.forEach(([n, d]) => { if (d) Object.defineProperty(globalThis, n, d); else delete globalThis[n]; });
    origConsole.forEach(([k, f]) => { console[k] = f; });
  });

  const env = setup(); t.after(env.shutdown); env.open();
  await env.submitToken(FAKE_TOKEN, true);
  env.vals().forEach(v => v.dispatch('click'));
  byText(env.modalRoot, '복사')[1].dispatch('click');
  await flush();
  env.timers.advance(60000);                       // 무조작 잠금
  byText(env.modalRoot, '다시 조회')[0].dispatch('click');
  await flush();
  env.document.setVisibility('hidden');            // 백그라운드 잠금
  env.close();

  assert.deepEqual(touched, [], '금고 모듈은 전역 저장소/캐시에 접근하지 않는다: ' + touched.join(','));
  assert.deepEqual(consoleCalls, [], '콘솔 출력 없음');
  assert.deepEqual(env.local.keys(), ['vaultToken'], '저장소에 있는 것은 토큰 키 하나뿐');
  assert.equal(env.session.writes, 0);
  const stored = env.local.dump();
  assert.ok(!hasAnyValue(stored) && !stored.includes('FAKE-GROUP') && !stored.includes('FAKE-LABEL'), '저장소에 응답 데이터가 없다');
});
