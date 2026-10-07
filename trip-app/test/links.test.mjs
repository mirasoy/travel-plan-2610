import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { APP_DIR } from './helpers.mjs';

const ROOT = path.join(APP_DIR, '..');
const rel = p => path.relative(ROOT, p);
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');

function htmlFiles() {
  const out = ['index.html', 'trip-app/index.html'];
  const dir = path.join(ROOT, 'archive');
  if (fs.existsSync(dir)) for (const f of fs.readdirSync(dir)) if (f.endsWith('.html')) out.push('archive/' + f);
  return out;
}
const skip = r => /^(https?:|\/\/|mailto:|tel:|data:|javascript:|#|blob:)/i.test(r) || r === '';
function resolveRef(file, ref) {
  const clean = ref.split('#')[0].split('?')[0];
  let target = path.resolve(path.dirname(path.join(ROOT, file)), decodeURIComponent(clean));
  if (clean === '' ) return null;
  if (clean.endsWith('/') || (fs.existsSync(target) && fs.statSync(target).isDirectory())) target = path.join(target, 'index.html');
  return target;
}

test('모든 HTML 의 상대 링크/리소스(href, src)가 실제 파일을 가리킨다(루트 이동 후 깨진 링크 방지)', () => {
  const broken = [];
  for (const f of htmlFiles()) {
    for (const m of read(f).matchAll(/\b(?:href|src)="([^"]*)"/g)) {
      if (skip(m[1])) continue;
      const t = resolveRef(f, m[1]);
      if (t && !fs.existsSync(t)) broken.push(f + ' -> ' + m[1]);
    }
  }
  assert.deepEqual(broken, []);
});

test('trip-app 의 JS 모듈 import(상대 경로)가 모두 존재한다', () => {
  const missing = [];
  const dir = path.join(ROOT, 'trip-app');
  for (const f of fs.readdirSync(dir).filter(n => n.endsWith('.js'))) {
    for (const m of fs.readFileSync(path.join(dir, f), 'utf8').matchAll(/\bfrom\s+['"](\.[^'"]+)['"]/g)) {
      if (!fs.existsSync(path.resolve(dir, m[1]))) missing.push(f + ' -> ' + m[1]);
    }
  }
  assert.deepEqual(missing, []);
});

test('보관한 페이지는 archive/ 에 있고 루트에는 index.html 말고 여행 페이지가 없다', () => {
  const rootHtml = fs.readdirSync(ROOT).filter(n => n.endsWith('.html'));
  assert.deepEqual(rootHtml, ['index.html']);
  for (const f of ['past.html', 'archive.html', 'vote.html', 'modern.css']) assert.ok(fs.existsSync(path.join(ROOT, 'archive', f)), f);
  assert.ok(!fs.existsSync(path.join(ROOT, 'modern.css')));
  assert.match(read('archive/vote.html'), /href="\.\.\/trip-app\/"/, '투표 페이지의 돌아가기는 여행 플래너로');
  assert.match(read('archive/past.html'), /href="\.\.\/trip-app\/"/);
  assert.match(read('trip-app/index.html'), /href="\.\.\/archive\/past\.html"/, '앱에서 지난 기록으로 가는 링크');
});

test('루트 index.html 은 데이터 없는 리다이렉트: 쿼리(공유)와 해시(초대 키)를 그대로 넘긴다', () => {
  const html = read('index.html');
  assert.ok(html.length < 1200, '루트 페이지가 커지면 안 된다');
  assert.ok(!/firebase|LJ\d|2026|Airbnb|항공|숙소/i.test(html), '루트에 여행 데이터가 없다');
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
  assert.equal(scripts.length, 1);
  for (const [search, hash, expected] of [['', '', 'trip-app/'], ['?title=a&text=b', '', 'trip-app/?title=a&text=b'], ['', '#k=FAKE', 'trip-app/#k=FAKE'], ['?x=1', '#k=FAKE', 'trip-app/?x=1#k=FAKE']]) {
    let went = null;
    vm.runInNewContext(scripts[0], { location: { search, hash, replace: u => { went = u; } } });
    assert.equal(went, expected);
  }
  assert.match(html, /<noscript>[\s\S]*url=trip-app\/[\s\S]*<\/noscript>/, 'JS 없이도 이동');
});
