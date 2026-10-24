'use strict';

// brand/*.html 을 헤드리스 Edge(또는 Chrome)로 찍어서 public/ 의 미리보기 이미지와 아이콘을 만든다.
// 사용: npm run brand   (브라우저 경로를 직접 지정하려면 BROWSER 환경변수)
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { pathToFileURL } = require('url');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'public');

const CANDIDATES = [
  process.env.BROWSER,
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].filter(Boolean);

const browser = CANDIDATES.find(p => fs.existsSync(p));
if (!browser) {
  console.error('Edge나 Chrome을 찾지 못했어요. BROWSER 환경변수로 경로를 지정해 주세요.');
  process.exit(1);
}

const SHOTS = [
  { html: 'og.html', file: 'og-image.png', w: 1200, h: 630 },
  { html: 'icon.html', file: 'icon-512.png', w: 512, h: 512 },
  { html: 'icon.html', file: 'icon-192.png', w: 192, h: 192 },
  { html: 'icon.html', file: 'apple-touch-icon.png', w: 180, h: 180 },
  { html: 'icon.html', file: 'favicon-32.png', w: 32, h: 32 },
];

// Windows의 Edge는 실행 파일이 먼저 끝나고 하위 프로세스가 나중에 파일을 쓴다. 파일 크기가 멈출 때까지 기다린다.
function waitForFile(file, timeoutMs = 30000) {
  const until = Date.now() + timeoutMs;
  let last = -1;
  while (Date.now() < until) {
    const size = fs.existsSync(file) ? fs.statSync(file).size : -1;
    if (size > 0 && size === last) return true;
    last = size;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
  }
  return false;
}

// PNG 헤더에서 실제 크기를 읽어 창 크기대로 찍혔는지 확인한다.
function pngSize(file) {
  const buf = fs.readFileSync(file);
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
}

// 평소 쓰는 브라우저가 켜져 있으면 같은 프로필로는 찍히지 않고, 직전 실행이 프로필을 잡고 있을 수도 있어서
// 한 장마다 새 임시 프로필을 쓴다.
const profiles = [];

for (const shot of SHOTS) {
  const out = path.join(OUT, shot.file);
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'nolgether-brand-'));
  profiles.push(profile);
  fs.rmSync(out, { force: true });
  execFileSync(browser, [
    '--headless=new',
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--disable-gpu',
    '--hide-scrollbars',
    '--force-device-scale-factor=1',
    '--virtual-time-budget=8000',
    `--window-size=${shot.w},${shot.h}`,
    `--screenshot=${out}`,
    `${pathToFileURL(path.join(ROOT, 'brand', shot.html)).href}?s=${shot.w}`,
  ], { stdio: 'ignore' });
  if (!waitForFile(out)) {
    console.log(`✗ ${shot.file} 만들지 못함`);
    process.exitCode = 1;
    continue;
  }
  const size = pngSize(out);
  const ok = size.w === shot.w && size.h === shot.h;
  console.log(`${ok ? '✓' : '✗'} ${shot.file} ${size.w}x${size.h}`);
  if (!ok) process.exitCode = 1;
}

for (const profile of profiles) {
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* 브라우저가 아직 잡고 있으면 나중에 OS가 정리 */ }
}
