import test from 'node:test';
import assert from 'node:assert/strict';
import { createSwipe, OPEN_PX, LOCK_PX, FLICK_PX_PER_MS } from '../swipe.js';
import { readApp } from './helpers.mjs';

// 시간은 천천히(플릭이 아니게) 움직이도록 20ms 간격, 한 번에 2px 이하로 이동하는 헬퍼
function drag(sw, from, to, opts) {
  const o = Object.assign({ y: 0, dy: 0, stepMs: 40, steps: 10, isOpen: false }, opts);
  sw.start(from, o.y, 0, o.isOpen);
  let last = null;
  for (let i = 1; i <= o.steps; i++) {
    last = sw.move(from + ((to - from) * i) / o.steps, o.y + (o.dy * i) / o.steps, i * o.stepMs);
  }
  return { last, end: sw.end() };
}

test('작게 끌면 닫힌 채로 돌아간다(40% 미만), 충분히 끌면 열린다', () => {
  const sw = createSwipe();
  assert.deepEqual(drag(sw, 200, 200 - OPEN_PX * 0.3).end, { swiped: true, open: false });
  assert.deepEqual(drag(sw, 200, 200 - OPEN_PX * 0.5).end, { swiped: true, open: true });
  assert.deepEqual(drag(sw, 200, 200 - OPEN_PX * 0.41).end, { swiped: true, open: true }, '경계 바로 위');
  assert.deepEqual(drag(sw, 200, 200 - OPEN_PX * 0.39).end, { swiped: true, open: false }, '경계 바로 아래');
});

test('offset 은 -OPEN_PX ~ 0 으로 제한된다(오른쪽으로 더 끌어도 0, 왼쪽으로 많이 끌어도 -OPEN_PX)', () => {
  const sw = createSwipe();
  assert.equal(drag(sw, 200, 0).last.offset, -OPEN_PX);
  assert.equal(drag(sw, 200, 400).last.offset, 0);
  assert.equal(drag(sw, 200, 150).last.offset, -50);
});

test('열려 있을 때: 오른쪽으로 40% 이상 되돌리면 닫히고, 조금만 되돌리면 열린 채 유지', () => {
  const sw = createSwipe();
  assert.deepEqual(drag(sw, 100, 100 + OPEN_PX * 0.5, { isOpen: true }).end, { swiped: true, open: false });
  assert.deepEqual(drag(sw, 100, 100 + OPEN_PX * 0.2, { isOpen: true }).end, { swiped: true, open: true });
  assert.equal(drag(sw, 100, 40, { isOpen: true }).last.offset, -OPEN_PX, '이미 열린 카드를 더 왼쪽으로 끌어도 그대로');
});

test('빠르게 튕기면 거리와 상관없이 그 방향을 따른다', () => {
  const sw = createSwipe();
  sw.start(200, 0, 0, false);
  sw.move(190, 0, 10); sw.move(180, 0, 20);      // -1 px/ms, 거리는 20px(22%)
  assert.deepEqual(sw.end(), { swiped: true, open: true });
  sw.start(100, 0, 0, true);
  sw.move(110, 0, 10); sw.move(120, 0, 20);      // +1 px/ms, 되돌린 거리 20px
  assert.deepEqual(sw.end(), { swiped: true, open: false });
  assert.ok(FLICK_PX_PER_MS > 0);
});

test('세로 스크롤을 가로채지 않는다: 세로가 우세하면 y 로 잠그고 이후 가로 움직임도 무시', () => {
  const sw = createSwipe();
  sw.start(200, 200, 0, false);
  assert.deepEqual(sw.move(205, 230, 10), { lock: 'y', offset: 0 });
  assert.deepEqual(sw.move(100, 232, 20), { lock: 'y', offset: 0 }, '한 번 y 로 잠기면 가로로 많이 움직여도 열리지 않는다');
  assert.deepEqual(sw.end(), { swiped: false, open: false });
});

test('대각선 이동은 세로로 본다(가로가 세로의 1.5배를 넘어야 가로)', () => {
  const sw = createSwipe();
  sw.start(200, 200, 0, false);
  assert.equal(sw.move(170, 230, 10).lock, 'y', '45도(dx=30, dy=30)는 세로 스크롤로 본다');
});

test('방향 판정 경계: dx > dy*1.5 면 가로', () => {
  const a = createSwipe(); a.start(200, 200, 0, false);
  assert.equal(a.move(200 - 31, 200 + 20, 10).lock, 'x', 'dx=31, dy=20 (1.55배)');
  const b = createSwipe(); b.start(200, 200, 0, false);
  assert.equal(b.move(200 - 29, 200 + 20, 10).lock, 'y', 'dx=29, dy=20 (1.45배)');
});

test('LOCK_PX 미만의 움직임은 판정을 미루고(탭), 손을 떼도 스와이프가 아니다', () => {
  const sw = createSwipe();
  sw.start(100, 100, 0, false);
  assert.deepEqual(sw.move(100 - (LOCK_PX - 1), 100, 10), { lock: null, offset: 0 });
  assert.deepEqual(sw.end(), { swiped: false, open: false });
  sw.start(100, 100, 0, true);
  assert.deepEqual(sw.end(), { swiped: false, open: true }, '열린 카드를 탭만 하면 열린 상태 그대로(닫기는 앱 쪽 click 처리)');
});

test('시작 전/취소 후/끝난 뒤에 호출해도 안전하다', () => {
  const sw = createSwipe();
  assert.equal(sw.move(1, 1, 1), null);
  assert.deepEqual(sw.end(), { swiped: false, open: false });
  sw.start(0, 0, 0, false); sw.cancel();
  assert.equal(sw.move(50, 0, 10), null);
  sw.start(0, 0, 0, false); sw.move(-50, 0, 100); sw.end();
  assert.equal(sw.move(-80, 0, 120), null, 'end 뒤에는 추적하지 않는다');
});

test('순수 모듈: DOM/전역/콘솔/타이머를 쓰지 않는다', () => {
  const code = readApp('swipe.js').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\s\/\/ .*$/gm, '');
  for (const re of [/document\./, /window\./, /localStorage|sessionStorage/, /console\s*\./, /setTimeout|setInterval|requestAnimationFrame/, /Date\.now|performance\./]) assert.ok(!re.test(code), String(re));
});
