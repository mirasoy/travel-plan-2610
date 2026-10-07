import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { parseExport, sanitizeDoc, isValidId, chunk, summarize, LIMITS, COLLECTIONS } from '../trip-import.js';
import { mapOpenUrl } from '../parse.js';
import { readApp, APP_DIR } from './helpers.mjs';

const exp = extra => JSON.stringify(Object.assign({
  exportedAt: '2000-01-01T00:00:00.000Z',
  trip: { name: 'FAKE 여행', startDate: '2000-02-01', endDate: '2000-02-04', currencies: ['KRW', 'TWD'] },
  pool: [{ id: 'p1', name: 'FAKE 장소', mapUrl: 'https://maps.app.goo.gl/FAKE', placeId: null }],
  items: [{ id: 'i1', day: 1, order: 1, poolId: 'p1' }, { id: 'i2', day: 2, order: 1, poolId: 'p1' }],
  expenses: [], members: [],
  flights: [{ id: 'out', flightNo: 'XX1' }],
  lodgings: [{ id: 'stay', name: 'FAKE 숙소', checkIn: '2000-02-01', checkOut: '2000-02-04', mapUrl: '' }]
}, extra));

test('정상 파일: 컬렉션별 문서와 여행 필드를 뽑는다', () => {
  const r = parseExport(exp());
  assert.equal(r.ok, true);
  assert.deepEqual(r.counts, { pool: 1, items: 2, expenses: 0, members: 0, flights: 1, lodgings: 1 });
  assert.equal(r.docs.length, 5);
  assert.deepEqual(r.docs.find(d => d.col === 'flights'), { col: 'flights', id: 'out', data: { flightNo: 'XX1' } }, 'id 는 문서 ID 로, 데이터에는 넣지 않는다');
  assert.deepEqual(r.trip, { name: 'FAKE 여행', startDate: '2000-02-01', endDate: '2000-02-04', currencies: ['KRW', 'TWD'] });
  assert.equal(summarize(r.counts), '장소 1건, 일정 2건, 항공편 1건, 숙소 1건');
  assert.equal(r.skipped, 0);
});

test('예전 내보내기(tripId 필드 포함)와 모르는 최상위 필드는 무시한다. 키 값이 결과에 실리지 않는다', () => {
  const r = parseExport(exp({ tripId: 'FAKE-OLD-KEY', whatever: [1, 2, 3] }));
  assert.equal(r.ok, true);
  assert.ok(!JSON.stringify(r).includes('FAKE-OLD-KEY'));
});

test('파일 단위 오류: 깨진 JSON, 배열/문자열 루트, 이 앱 파일이 아님, 크기 초과, 가져올 게 없음', () => {
  assert.equal(parseExport('{not json').ok, false);
  assert.match(parseExport('{not json').message, /JSON/);
  for (const bad of ['[]', '"x"', '123', 'null', '{"a":1}', '{"pool":"x"}']) assert.equal(parseExport(bad).ok, false, bad);
  assert.equal(parseExport(undefined).ok, false);
  assert.match(parseExport('x'.repeat(LIMITS.fileBytes + 1)).message, /너무 커요/);
  assert.match(parseExport('{"pool":[]}').message, /가져올 데이터가 없어요/);
  const many = JSON.stringify({ items: Array.from({ length: LIMITS.docs + 1 }, (_, i) => ({ id: 'i' + i })) });
  assert.match(parseExport(many).message, /너무 많아요/);
});

test('문서 ID 검증: 빈 값, 슬래시, 점, 예약 형식, 128자 초과, 제어문자, 숫자 타입', () => {
  for (const ok of ['a', 'p-1', 'ChIJ_x', '한글id', 'a'.repeat(128)]) assert.equal(isValidId(ok), true, ok);
  for (const bad of ['', 'a/b', '/', '.', '..', '__x__', '__proto__', 'a'.repeat(129), 'a\nb', 'a\\b', 7, null, undefined, {}]) assert.equal(isValidId(bad), false, String(bad));
  const r = parseExport(JSON.stringify({ items: [{ id: '../x' }, { id: 'ok1' }, { id: 7 }, { name: 'no id' }, { id: 'ok1' }] }));
  assert.deepEqual([r.docs.length, r.skipped], [1, 4], '잘못된 ID 3건과 중복 1건은 건너뛴다');
});

test('위험한 문서는 통째로 건너뛴다: 예약 키(__proto__ 포함), 중첩 배열, 너무 깊은 구조, 유한하지 않은 숫자, 너무 큰 문서', () => {
  const raw = parseExport('{"items":[{"id":"a","__proto__":{"polluted":1}},{"id":"b","x":{"__y__":1}},{"id":"c","n":[[1]]},{"id":"ok"}]}');
  assert.deepEqual(raw.docs.map(d => d.id), ['ok']);
  assert.equal(raw.skipped, 3);
  assert.equal({}.polluted, undefined, 'Object.prototype 오염 없음');
  let deep = 'x'; for (let i = 0; i < 25; i++) deep = { n: deep };
  assert.equal(sanitizeDoc({ id: 'd', deep }), null);
  assert.equal(sanitizeDoc({ id: 'nan', n: NaN }), null);
  assert.equal(sanitizeDoc({ id: 'inf', n: Infinity }), null);
  assert.equal(sanitizeDoc({ id: 'big', s: 'x'.repeat(LIMITS.docBytes + 1) }), null);
  assert.equal(sanitizeDoc({ id: 'fn', f: () => 1 }), null);
});

test('mapUrl: 구글맵 https 만 남기고 나머지는 비운다(문서는 살린다)', () => {
  const cases = [
    ['https://maps.app.goo.gl/abc', true], ['https://www.google.com/maps/search/?api=1&query=x', true], ['https://goo.gl/maps/xyz', true],
    ['javascript:alert(1)', false], ['data:text/html,x', false], ['http://maps.google.com/x', false],
    ['https://evil.example/maps', false], ['https://www.google.com.evil.example/maps', false], ['https://maps.google.com.evil.example/', false],
    ['  https://maps.app.goo.gl/abc', false], ['', true]
  ];
  for (const [url, keep] of cases) {
    const d = sanitizeDoc({ id: 'x', mapUrl: url });
    assert.equal(d.data.mapUrl, keep ? url : '', url);
    assert.equal(d.sanitized, !keep && url !== '', url);
  }
  assert.equal(sanitizeDoc({ id: 'x', mapUrl: 123 }).data.mapUrl, '');
  assert.equal(sanitizeDoc({ id: 'x', mapUrl: null }).data.mapUrl, null);
  const r = parseExport(JSON.stringify({ pool: [{ id: 'a', mapUrl: 'javascript:alert(1)', name: 'n' }] }));
  assert.equal(r.sanitized, 1);
  assert.equal(r.docs[0].data.name, 'n');
});

test('여행 문서: 알려진 필드만, 날짜 형식과 길이 검사', () => {
  const t = x => parseExport(JSON.stringify({ trip: x, items: [{ id: 'a' }] })).trip;
  assert.deepEqual(t({ name: 'n', startDate: null, endDate: '2000-01-02', isAdmin: true, __x__: 1 }), { name: 'n', startDate: null, endDate: '2000-01-02' });
  assert.equal(t({ startDate: '2000/01/02', endDate: 'x' }), null);
  assert.equal(t({ name: 'x'.repeat(201) }), null);
  assert.equal(t({ currencies: ['KRW', 5] }), null);
  assert.equal(t('str'), null);
});

test('chunk / summarize', () => {
  assert.deepEqual(chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
  assert.deepEqual(chunk([], 3), []);
  assert.equal(chunk(Array.from({ length: 1000 }, (_, i) => i), 400).map(c => c.length).join(), '400,400,200');
  assert.equal(summarize({}), '없음');
  assert.deepEqual(COLLECTIONS, ['pool', 'items', 'expenses', 'members', 'flights', 'lodgings']);
});

test('렌더링 쪽 하드닝: mapOpenUrl 은 https 가 아닌 mapUrl 을 링크로 내보내지 않는다', () => {
  assert.equal(mapOpenUrl({ mapUrl: 'https://maps.app.goo.gl/abc' }, '타이베이'), 'https://maps.app.goo.gl/abc');
  assert.ok(mapOpenUrl({ mapUrl: 'javascript:alert(1)', name: '딘타이펑' }, '타이베이').startsWith('https://www.google.com/maps/search/'), 'javascript: 는 이름 검색 링크로 대체');
  assert.equal(mapOpenUrl({ mapUrl: 'javascript:alert(1)' }, '타이베이'), '');
  assert.equal(mapOpenUrl({ mapUrl: 'data:text/html,x', placeId: 'ChIJx', name: 'n' }, '').includes('query_place_id=ChIJx'), true);
});

test('순수 모듈: DOM, Firestore, 저장소, 네트워크, 콘솔을 쓰지 않는다', () => {
  const code = readApp('trip-import.js').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\s\/\/ .*$/gm, '');
  for (const re of [/document\./, /window\./, /localStorage|sessionStorage|indexedDB|caches/, /fetch\(/, /console\s*\./, /firebase|setDoc|writeBatch/i, /eval\(|new Function/]) {
    assert.ok(!re.test(code), String(re));
  }
});
