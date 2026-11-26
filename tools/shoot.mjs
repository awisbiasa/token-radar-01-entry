// Screenshot the dashboard with the Playwright Chromium binary, driven over the Chrome DevTools Protocol.
// No npm, no network: Node's own fetch and WebSocket talk to the browser's local debugging port.
//   node shoot.mjs <file:///…/index.html> <out-dir> [width] [height]
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const CHROME = '/root/.cache/ms-playwright/chromium-1255/chrome-linux64/chrome';
const page = process.argv[2];
const outDir = process.argv[3];
const W = Number(process.argv[4] ?? 1440);
const H = Number(process.argv[5] ?? 900);
mkdirSync(outDir, { recursive: true });

const port = 9222 + Math.floor(Math.random() * 500);
const chrome = spawn(CHROME, [
  '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
  '--hide-scrollbars', '--force-device-scale-factor=1', '--allow-file-access-from-files',
  `--remote-debugging-port=${port}`, `--window-size=${W},${H}`, 'about:blank',
], { stdio: ['ignore', 'ignore', 'pipe'] });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function wsUrl() {
  for (let i = 0; i < 120; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/list`);
      const list = await r.json();
      const target = list.find((t) => t.type === 'page');
      if (target) return target.webSocketDebuggerUrl;
    } catch { /* not up yet */ }
    await sleep(100);
  }
  throw new Error('chromium did not open its debugging port');
}

const url = await wsUrl();
const ws = new WebSocket(url);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

let id = 0;
const waiting = new Map();
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && waiting.has(msg.id)) {
    const { resolve, reject } = waiting.get(msg.id);
    waiting.delete(msg.id);
    if (msg.error) reject(new Error(msg.error.message)); else resolve(msg.result);
  }
};
function send(method, params = {}) {
  const myId = ++id;
  return new Promise((resolve, reject) => {
    waiting.set(myId, { resolve, reject });
    ws.send(JSON.stringify({ id: myId, method, params }));
  });
}
async function evalJs(expression) {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r && r.exceptionDetails) throw new Error(r.exceptionDetails.text);
  return r && r.result ? r.result.value : undefined;
}

await send('Page.enable');
await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false });

async function shoot(name, expr) {
  if (expr) { await evalJs(expr); await sleep(650); }
  const { data } = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  const buf = Buffer.from(data, 'base64');
  writeFileSync(join(outDir, name), buf);
  console.log(`${name} ${buf.length} bytes`);
}

await send('Page.navigate', { url: page });
await sleep(1800);

// 1: the board — scroll so the panel top sits under the sticky toolbar
await evalJs('window.scrollTo(0,0)');
await sleep(200);
const boardTop = await evalJs("(function(){var b=document.querySelector('#board');return b?Math.max(0, b.getBoundingClientRect().top + window.scrollY - 118):0;})()");
await evalJs(`window.scrollTo(0, ${boardTop})`);
await sleep(500);
await shoot('1-board.png');

// 2: a detail view — the focus layout: one protocol's full page, arithmetic and farm plan in view
await evalJs("(function(){var rows=document.querySelectorAll('tbody tr'); var r=rows[2]||rows[0]; if(r) r.click();})()");
await sleep(400);
await evalJs("(function(){var bs=document.querySelectorAll('.tools .btn'); for (var i=0;i<bs.length;i++){ if(bs[i].textContent.indexOf('Focus')>=0){bs[i].click(); break;} }})()");
await sleep(600);
const detTop = await evalJs("(function(){var b=document.querySelector('#board');return b?Math.max(0, b.getBoundingClientRect().top + window.scrollY - 118):0;})()");
await evalJs(`window.scrollTo(0, ${detTop})`);
await sleep(500);
await shoot('2-detail.png');
// back to the board layout for the filter shot
await evalJs("(function(){var bs=document.querySelectorAll('.tools .btn'); for (var i=0;i<bs.length;i++){ if(bs[i].textContent.indexOf('Board view')>=0){bs[i].click(); break;} }})()");
await sleep(500);

// 3: a filtered view — a category filter plus a search term
const boardTop2 = await evalJs("(function(){var b=document.querySelector('#board');return b?Math.max(0, b.getBoundingClientRect().top + window.scrollY - 118):0;})()");
await shoot('3-filtered.png', `(function(){
  var inp = document.querySelector('input[type=search]');
  if (inp) { inp.value = 'Capital'; inp.dispatchEvent(new Event('input')); }
  setTimeout(function(){ var t = document.querySelector('.toolbar'); if (t) window.scrollTo(0, Math.max(0, t.getBoundingClientRect().top + window.scrollY - 62)); }, 60);
})()`);

ws.close();
chrome.kill('SIGKILL');
process.exit(0);
