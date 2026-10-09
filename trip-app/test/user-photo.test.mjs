import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanPhotoUrl, cleanDataUrl, cleanUserPhoto, importableUserPhoto, fitSize, shrinkToLimit, renderUserPhoto, DATA_MAX, CAPTION } from '../user-photo.js';
import { sanitizeDoc, parseExport } from '../trip-import.js';
import { FakeDocument, loadAppHelpers, FakeElement, byTag, byClass } from './helpers.mjs';

const okData = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQ==';

test('cleanPhotoUrl: https 만, 계정정보/공백/javascript/data/http 거부, 입력 문자열 그대로(쿼리 보존)', () => {
  assert.equal(cleanPhotoUrl('  https://img.example.test/a.jpg?x=1&y=2 '), 'https://img.example.test/a.jpg?x=1&y=2');
  for (const bad of ['', null, 5, 'http://img.example.test/a.jpg', 'javascript:alert(1)', 'data:image/png;base64,AAAA', 'https://u:p@img.example.test/a.jpg', 'https://img.example.test/a b.jpg', 'ftp://x/a.jpg', 'https://', 'not a url', 'https://x.test/' + 'a'.repeat(2000)]) {
    assert.equal(cleanPhotoUrl(bad), '', String(bad).slice(0, 40));
  }
});

test('cleanDataUrl: 우리가 만든 jpeg data URL 만, 크기 상한, 다른 형식/문자 거부', () => {
  assert.equal(cleanDataUrl(okData), okData);
  for (const bad of ['', null, 'data:image/png;base64,AAAA', 'data:image/svg+xml;base64,AAAA', 'data:image/jpeg;base64,AA AA', 'data:image/jpeg;base64,AA"onerror="x', 'https://x.test/a.jpg', 'data:image/jpeg;base64,']) {
    assert.equal(cleanDataUrl(bad), '', String(bad));
  }
  assert.equal(cleanDataUrl('data:image/jpeg;base64,' + 'A'.repeat(DATA_MAX)), '', '상한 초과');
  assert.notEqual(cleanDataUrl('data:image/jpeg;base64,' + 'A'.repeat(DATA_MAX - 23)), '', '상한 딱 맞는 크기는 허용');
});

test('cleanUserPhoto: url/upload 만, 형식 틀리면 null. importable 은 url 만', () => {
  assert.deepEqual(cleanUserPhoto({ kind: 'url', url: 'https://a.test/x.jpg', extra: 1 }), { kind: 'url', url: 'https://a.test/x.jpg' });
  assert.deepEqual(cleanUserPhoto({ kind: 'upload', updatedAt: 5 }), { kind: 'upload', updatedAt: 5 });
  assert.deepEqual(cleanUserPhoto({ kind: 'upload', updatedAt: 'x' }), { kind: 'upload', updatedAt: 0 });
  for (const bad of [null, undefined, 'x', [], { kind: 'url', url: 'http://a.test' }, { kind: 'other' }, {}]) assert.equal(cleanUserPhoto(bad), null);
  assert.equal(importableUserPhoto({ kind: 'upload', updatedAt: 5 }), null);
  assert.deepEqual(importableUserPhoto({ kind: 'url', url: 'https://a.test/x.jpg' }), { kind: 'url', url: 'https://a.test/x.jpg' });
});

test('fitSize: 긴 변 기준 비율 유지, 키우지 않음, 0 이하는 0', () => {
  assert.deepEqual(fitSize(4000, 3000, 800), { w: 800, h: 600 });
  assert.deepEqual(fitSize(3000, 4000, 800), { w: 600, h: 800 });
  assert.deepEqual(fitSize(400, 300, 800), { w: 400, h: 300 });
  assert.deepEqual(fitSize(10000, 1, 800), { w: 800, h: 1 });
  assert.deepEqual(fitSize(0, 5, 800), { w: 0, h: 0 });
});

test('shrinkToLimit: 첫 시도가 맞으면 그대로, 크면 화질 -> 크기 순으로 낮추고, 끝내 안 되면 null', () => {
  const big = 'data:image/jpeg;base64,' + 'A'.repeat(DATA_MAX);
  const calls = [];
  const r1 = shrinkToLimit(4000, 3000, (w, h, q) => { calls.push([w, h, q]); return okData; });
  assert.deepEqual(r1, { dataUrl: okData, w: 800, h: 600 });
  assert.deepEqual(calls, [[800, 600, 0.8]]);

  const seq = [];
  const r2 = shrinkToLimit(4000, 3000, (w, h, q) => { seq.push([w, q]); return w <= 640 && q <= 0.65 ? okData : big; });
  assert.deepEqual(seq, [[800, 0.8], [800, 0.65], [800, 0.5], [640, 0.8], [640, 0.65]]);
  assert.equal(r2.w, 640);

  assert.equal(shrinkToLimit(4000, 3000, () => big), null);
  assert.equal(shrinkToLimit(0, 0, () => okData), null);
  assert.equal(shrinkToLimit(100, 100, () => 'data:image/png;base64,AAAA'), null, '인코더가 jpeg 가 아닌 걸 주면 거부');
});

test('renderUserPhoto: img 하나 + 출처 글자, 주소 없으면 null, 로드 실패하면 영역 숨김, 이벤트 속성 없음', () => {
  const { h } = loadAppHelpers(new FakeDocument(), new FakeElement('div'));
  assert.equal(renderUserPhoto(h, ''), null);
  const fig = renderUserPhoto(h, 'https://img.example.test/a.jpg');
  const imgs = byTag(fig, 'img');
  assert.equal(imgs.length, 1);
  assert.equal(imgs[0].getAttribute('src'), 'https://img.example.test/a.jpg');
  assert.equal(imgs[0].getAttribute('referrerpolicy'), 'no-referrer');
  assert.equal(byClass(fig, 'photo-credit')[0].textContent, CAPTION);
  imgs[0].dispatch('error');
  assert.equal(fig.hidden, true);
});

test('가져오기: pool 의 userPhoto 는 주소 방식만 남고, 올린 사진 표시와 위험한 값은 버려진다(문서는 살림)', () => {
  const keep = sanitizeDoc({ id: 'p', name: 'x', userPhoto: { kind: 'url', url: 'https://a.test/x.jpg', junk: 1 } }, 'pool');
  assert.deepEqual(keep.data.userPhoto, { kind: 'url', url: 'https://a.test/x.jpg' });
  for (const bad of [{ kind: 'upload', updatedAt: 1 }, { kind: 'url', url: 'javascript:alert(1)' }, { kind: 'url', url: 'http://a.test/x.jpg' }, 'str', [1]]) {
    const r = sanitizeDoc({ id: 'p', name: 'x', userPhoto: bad }, 'pool');
    assert.ok(r && !('userPhoto' in r.data) && r.sanitized === true && r.data.name === 'x');
  }
  const none = sanitizeDoc({ id: 'p', name: 'x' }, 'pool');
  assert.ok(!('userPhoto' in none.data) && none.sanitized === false);
  const p = parseExport(JSON.stringify({ pool: [{ id: 'a', name: 'n', userPhoto: { kind: 'url', url: 'https://a.test/1.jpg' } }] }));
  assert.equal(p.ok, true);
  assert.equal(p.docs[0].data.userPhoto.url, 'https://a.test/1.jpg');
});
