import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSummary, flightTime, mdw, renderCard } from '../trip-summary.js';
import { cleanRows, cleanLink, parseExport, sanitizeDoc, ROW_LIMITS } from '../trip-import.js';
import { readApp, FakeDocument, FakeElement, loadAppHelpers, walk, byTag, byClass } from './helpers.mjs';

const OUT = { id: 'out', flightNo: 'XX1', depIata: 'ICN', arrIata: 'TPE', depLocal: '2000-02-03T09:35', arrLocal: '2000-02-03T11:30', memo: ' 메모 ', details: [{ label: '항공사', value: 'FAKE항공' }] };
const IN = { id: 'in', flightNo: 'XX2', depIata: 'TPE', arrIata: 'ICN', depLocal: '2000-02-06T12:40', arrLocal: '2000-02-06T16:00' };

test('날짜/시간 포맷: 요일, 같은 날/다음 날 도착, 형식 오류는 빈 문자열', () => {
  assert.equal(mdw('2026-11-14'), '11/14(토)');
  assert.equal(mdw('2026-02-30'), '');
  assert.equal(mdw(''), '');
  assert.equal(flightTime('2026-11-14T09:35', '2026-11-14T11:30'), '11/14(토) 09:35 → 11:30');
  assert.equal(flightTime('2026-11-14T23:30', '2026-11-15T02:10'), '11/14(토) 23:30 → 11/15(일) 02:10', '자정을 넘기면 도착 날짜도 표시');
  assert.equal(flightTime('2026-11-14T09:35', undefined), '11/14(토) 09:35');
  assert.equal(flightTime('garbage', '2026-11-14T11:30'), '');
  assert.equal(flightTime('2026-11-14T25:00', '2026-11-14T11:30'), '');
});

test('항공 카드: 가는 편/오는 편 순서, 제목, 경로, 시간, 메모, 부가 행', () => {
  const s = buildSummary({ flights: { in: IN, out: OUT }, lodgings: [] });
  assert.deepEqual(s.flights.map(c => c.id), ['out', 'in'], '문서 순서와 상관없이 가는 편이 먼저');
  assert.deepEqual(s.flights[0], {
    id: 'out', title: '가는 편 · XX1', main: 'ICN → TPE', sub: '2/3(목) 09:35 → 11:30',
    rows: [{ label: '항공사', value: 'FAKE항공' }], note: '메모', link: null
  });
  assert.equal(s.flights[1].rows.length, 0);
});

test('항공 카드: 문서가 없거나 필드가 비어도 죽지 않는다', () => {
  assert.deepEqual(buildSummary({ flights: null, lodgings: null }), { flights: [], lodgings: [] });
  assert.deepEqual(buildSummary({ flights: { out: null, in: null }, lodgings: [] }).flights, []);
  const c = buildSummary({ flights: { out: { id: 'out' } }, lodgings: [] }).flights[0];
  assert.deepEqual([c.title, c.main, c.sub, c.note], ['가는 편', '', '', '']);
  const odd = buildSummary({ flights: { out: { id: 'out', flightNo: 5, depIata: {}, memo: ['x'] } }, lodgings: [] }).flights[0];
  assert.deepEqual([odd.title, odd.main, odd.note], ['가는 편', '', ''], '문자열이 아닌 값은 무시');
});

test('숙소 카드: 체크인 순 정렬, 박수 계산, 이름 없음, 날짜 오류', () => {
  const s = buildSummary({ flights: {}, lodgings: [
    { id: 'b', name: '두번째', checkIn: '2026-11-17', checkOut: '2026-11-18' },
    { id: 'a', name: '첫번째', checkIn: '2026-11-14', checkOut: '2026-11-17', memo: 'm' },
    { id: 'c', checkIn: 'x', checkOut: 'y' }
  ] });
  assert.deepEqual(s.lodgings.map(c => c.title), ['첫번째', '두번째', '(이름 없음)'], '체크인 순, 날짜가 깨진 문서는 맨 뒤(설정 화면의 숙소 정렬과 같은 규칙)');
  assert.equal(s.lodgings[0].main, '11/14(토) ~ 11/17(화) · 3박');
  assert.equal(s.lodgings[0].note, 'm');
  assert.equal(s.lodgings[2].main, '', '날짜가 깨지면 기간 표시 없음');
  assert.equal(buildSummary({ flights: {}, lodgings: [{ id: 'z', name: 'n', checkIn: '2026-11-14', checkOut: '2026-11-14' }] }).lodgings[0].main, '11/14(토) ~ 11/14(토)', '0박은 박수 생략');
});

test('부가 행(details): 형식이 틀리면 통째로 숨기고, 너무 많거나 긴 값도 숨긴다', () => {
  assert.deepEqual(cleanRows(undefined), []);
  assert.deepEqual(cleanRows([]), []);
  assert.deepEqual(cleanRows([{ label: ' a ', value: ' b ' }]), [{ label: 'a', value: 'b' }], '공백 제거');
  for (const bad of ['x', {}, [1], [{ label: 'a' }], [{ label: 'a', value: 5 }], [{ label: '', value: 'v' }], [{ label: 'a', value: '  ' }],
    [{ label: 'x'.repeat(ROW_LIMITS.label + 1), value: 'v' }], [{ label: 'a', value: 'x'.repeat(ROW_LIMITS.value + 1) }], [[{ label: 'a', value: 'b' }]],
    Array.from({ length: ROW_LIMITS.rows + 1 }, () => ({ label: 'a', value: 'b' }))]) {
    assert.equal(cleanRows(bad), null, JSON.stringify(bad).slice(0, 40));
  }
  assert.equal(cleanRows(Array.from({ length: ROW_LIMITS.rows }, () => ({ label: 'a', value: 'b' }))).length, ROW_LIMITS.rows, '한도 딱 맞는 개수는 통과');
  const c = buildSummary({ flights: { out: { id: 'out', details: 'bad' } }, lodgings: [] }).flights[0];
  assert.deepEqual(c.rows, [], '카드는 그리되 잘못된 부가 행은 숨김');
});

test('링크 버튼: 구글맵 https 만. javascript:, 외부 도메인, 비 https, 라벨 없음은 제거', () => {
  const ok = { label: '지도', url: 'https://www.google.com/maps/search/?api=1&query=x' };
  assert.deepEqual(cleanLink(ok), ok);
  for (const bad of [null, 'x', {}, { label: '지도' }, { url: ok.url }, { label: '', url: ok.url }, { label: 'a', url: 'javascript:alert(1)' },
    { label: 'a', url: 'http://www.google.com/maps/x' }, { label: 'a', url: 'https://evil.example/maps' }, { label: 'a', url: 'https://www.google.com.evil.example/maps' },
    { label: 'a', url: 'data:text/html,x' }, { label: 'x'.repeat(41), url: ok.url }, { label: 'a', url: 5 }]) {
    assert.equal(cleanLink(bad), null, JSON.stringify(bad));
  }
  const s = buildSummary({ flights: {}, lodgings: [{ id: 'l', name: 'n', link: { label: 'a', url: 'javascript:alert(1)' } }, { id: 'm', name: 'n2', link: ok }] });
  assert.equal(s.lodgings.find(c => c.id === 'l').link, null, '화면 쪽에서도 한 번 더 걸러낸다');
  assert.deepEqual(s.lodgings.find(c => c.id === 'm').link, ok);
});

test('가져오기 검증: details/link 는 형식이 틀리면 그 필드만 버리고 문서는 살린다(건수에 반영)', () => {
  const r = parseExport(JSON.stringify({ flights: [
    { id: 'out', flightNo: 'X', details: [{ label: 'a', value: 'b' }], link: { label: 'L', url: 'https://maps.app.goo.gl/x' } },
    { id: 'in', flightNo: 'Y', details: 'oops', link: { label: 'L', url: 'javascript:alert(1)' } }
  ] }));
  assert.equal(r.ok, true);
  assert.deepEqual(r.docs.find(d => d.id === 'out').data.details, [{ label: 'a', value: 'b' }]);
  const bad = r.docs.find(d => d.id === 'in').data;
  assert.deepEqual([bad.flightNo, 'details' in bad, 'link' in bad], ['Y', false, false]);
  assert.equal(r.sanitized, 1);
});

test('순수 모듈: DOM, 저장소, 네트워크, 콘솔, Firestore 를 쓰지 않는다', () => {
  const code = readApp('trip-summary.js').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\s\/\/ .*$/gm, '');
  for (const re of [/document\./, /window\./, /localStorage|sessionStorage|indexedDB|caches/, /fetch\(/, /console\s*\./, /firebase|setDoc|getDoc/i, /eval\(|new Function/]) assert.ok(!re.test(code), String(re));
});

test('가져오기 타입 검증: 앱이 문자열로 쓰는 필드에 객체/숫자가 오면 그 필드만 버린다(렌더링이 깨지지 않게)', () => {
  const r = parseExport(JSON.stringify({
    lodgings: [{ id: 'l', name: { x: 1 }, checkIn: 5, checkOut: '2000-01-02', memo: ['a'], createdAt: '1' }],
    items: [{ id: 'i', day: '1', order: 2, poolId: 7, title: null, time: 5, memo: 'ok' }],
    flights: [{ id: 'out', flightNo: 9, depIata: 'ICN', destAirport: 'str' }, { id: 'in', destAirport: { iata: 'TPE' } }],
    pool: [{ id: 'p', name: 'n', placeId: 5, cid: null, confirmedAt: 'x', createdAt: 1 }]
  }));
  const d = id => r.docs.find(x => x.id === id).data;
  assert.deepEqual(d('l'), { checkOut: '2000-01-02' }, 'name(객체), checkIn(숫자), memo(배열), createdAt(문자열) 제거');
  assert.deepEqual(d('i'), { order: 2, memo: 'ok' }, 'day(문자열), poolId(숫자), title(null), time(숫자) 제거');
  assert.deepEqual(d('out'), { depIata: 'ICN' }, 'flightNo(숫자), destAirport(문자열) 제거');
  assert.deepEqual(d('in'), { destAirport: { iata: 'TPE' } }, '올바른 객체는 유지');
  assert.deepEqual(d('p'), { name: 'n', cid: null, createdAt: 1 }, 'placeId(숫자), confirmedAt(문자열) 제거, null 허용 필드는 유지');
  assert.equal(r.sanitized, 4, '정리된 문서 4건(l, i, out, p). 올바른 in 은 제외');
  assert.equal(sanitizeDoc({ id: 'x', name: 5 }).data.name, 5, 'col 을 안 주면 타입 검사를 하지 않는다(컬렉션별 규칙)');
});

test('카드 렌더링(app.js 의 실제 h 사용): 행이 dt/dd 쌍으로 그려지고 [object ...] 가 글자로 찍히지 않는다, 값은 텍스트로만', () => {
  const doc = new FakeDocument();
  const { h } = loadAppHelpers(doc, new FakeElement('div'));
  const card = buildSummary({ flights: { out: Object.assign({}, OUT, { details: [{ label: 'A', value: 'a' }, { label: 'B', value: '<img src=x onerror=alert(1)>' }], link: { label: '지도', url: 'https://maps.app.goo.gl/x' } }) }, lodgings: [] }).flights[0];
  const node = renderCard(h, card);
  const text = node.textContent;
  assert.ok(!/\[object/.test(text), '자식 배열 평탄화 누락: ' + text);
  const dl = byTag(node, 'dl')[0];
  assert.deepEqual(dl.children.map(c => c.tagName), ['DT', 'DD', 'DT', 'DD']);
  assert.deepEqual(dl.children.map(c => c.textContent), ['A', 'a', 'B', '<img src=x onerror=alert(1)>']);
  let injected = 0; walk(node, n => { if (n.nodeType === 1 && n.tagName === 'IMG') injected += 1; });
  assert.equal(injected, 0, 'HTML 은 요소가 되지 않는다');
  const a = byTag(node, 'a')[0];
  assert.deepEqual([a.attrs.href, a.attrs.target, a.attrs.rel, a.textContent], ['https://maps.app.goo.gl/x', '_blank', 'noopener', '지도']);
  assert.deepEqual(byClass(node, 'sum-title').map(n => n.textContent), ['가는 편 · XX1']);
  const bare = renderCard(h, buildSummary({ flights: { in: { id: 'in' } }, lodgings: [] }).flights[0]);
  assert.equal(byTag(bare, 'dl').length + byTag(bare, 'a').length, 0, '비어 있으면 행/링크 요소를 만들지 않는다');
});
