// Real-browser check of the restricted-wasm-v1 build (KOTOBA-159). Not part of `npm test`: it needs
// Chrome and the network. Run after `npm run build`:
//   CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" node scripts/verify-browser.mjs
// It serves dist/ on 127.0.0.1, drives Chrome over the DevTools protocol, answers the canonical
// consent dialog with trusted input (Input.dispatchMouseEvent) and records every request the page
// makes. It prints one JSON report and exits non-zero when a check fails.
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';

const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const dist = new URL('../dist/', import.meta.url);
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };
const server = createServer(async (req, res) => {
  const path = new URL(req.url, 'http://x').pathname.replace(/^\/$/, '/index.html');
  try {
    const body = await readFile(new URL('.' + path, dist));
    res.writeHead(200, { 'content-type': types[extname(path)] ?? 'application/octet-stream' });
    res.end(body);
  } catch { res.writeHead(404); res.end(); }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const appURL = `http://127.0.0.1:${server.address().port}/`;

const profile = await mkdtemp(join(tmpdir(), 'market-android-cdp-'));
const chrome = spawn(CHROME, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', '--window-size=1100,900', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
const wsURL = await new Promise((resolve, reject) => {
  let err = '';
  chrome.stderr.on('data', (d) => { err += d; const m = /DevTools listening on (ws:\/\/\S+)/.exec(err); if (m) resolve(m[1]); });
  setTimeout(() => reject(new Error('Chrome did not start')), 20000);
});
const targets = await (await fetch(wsURL.replace('ws://', 'http://').replace(/\/devtools\/browser\/.*/, '/json/list'))).json();
const ws = new WebSocket(targets.find((t) => t.type === 'page').webSocketDebuggerUrl);
await new Promise((resolve) => ws.addEventListener('open', resolve, { once: true }));
let seq = 0;
const pending = new Map();
const listeners = [];
ws.addEventListener('message', ({ data }) => {
  const msg = JSON.parse(data);
  if (msg.id && pending.has(msg.id)) { const { resolve, reject } = pending.get(msg.id); pending.delete(msg.id); msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result); }
  else for (const l of listeners) l(msg);
});
const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => { const id = ++seq; pending.set(id, { resolve, reject }); ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const requests = [];
const contexts = new Map();
const consoleErrors = [];
// A sandboxed (opaque-origin) iframe runs out of process: it is its own target, attached flat.
const ctxKey = (sessionId, id) => `${sessionId ?? 'page'}:${id}`;
listeners.push((m) => {
  if (m.method === 'Target.attachedToTarget') {
    const sid = m.params.sessionId;
    Promise.all([send('Network.enable', {}, sid), send('Runtime.enable', {}, sid), send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }, sid)])
      .then(() => send('Runtime.runIfWaitingForDebugger', {}, sid)).catch(() => {});
  }
  if (m.method === 'Target.detachedFromTarget') for (const k of [...contexts.keys()]) if (k.startsWith(`${m.params.sessionId}:`)) contexts.delete(k);
  if (m.method === 'Network.requestWillBeSent') requests.push({ url: m.params.request.url, frame: m.params.frameId, session: m.sessionId ?? null });
  if (m.method === 'Runtime.executionContextCreated') contexts.set(ctxKey(m.sessionId, m.params.context.id), { ...m.params.context, sessionId: m.sessionId });
  if (m.method === 'Runtime.executionContextDestroyed') contexts.delete(ctxKey(m.sessionId, m.params.executionContextId));
  if (m.method === 'Runtime.executionContextsCleared') for (const k of [...contexts.keys()]) if (k.startsWith(`${m.sessionId ?? 'page'}:`)) contexts.delete(k);
  if (m.method === 'Runtime.exceptionThrown') consoleErrors.push(m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text);
});
await send('Network.enable');
await send('Runtime.enable');
await send('Page.enable');
await send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
const evalIn = async (context, expression) => {
  if (!context) throw new Error('no such context');
  const r = await send('Runtime.evaluate', { expression, contextId: context.id, awaitPromise: true, returnByValue: true }, context.sessionId);
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
  return r.result.value;
};
const hostContext = () => [...contexts.values()].find((c) => !c.sessionId && c.auxData?.isDefault && c.origin === appURL.slice(0, -1));
const guestContext = () => [...contexts.values()].filter((c) => c.sessionId && c.auxData?.isDefault).at(-1);
async function waitFor(fn, label, ms = 15000) {
  const end = Date.now() + ms;
  for (;;) { const v = await fn().catch(() => null); if (v) return v; if (Date.now() > end) throw new Error('timeout: ' + label); await sleep(150); }
}
async function trustedClick(selector) {
  const box = await evalIn(hostContext(), `(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
  for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'left', clickCount: 1 });
}
const guestStatus = () => evalIn(guestContext(), `document.getElementById('status').textContent`);
const dialogOpen = () => evalIn(hostContext(), `!!document.querySelector('dialog[open]')`);
const external = () => requests.filter((r) => !r.url.startsWith(appURL) && !r.url.startsWith('data:') && !r.url.startsWith('about:'));

const report = { appURL, checks: {} };
const check = (name, ok, detail) => { report.checks[name] = { ok: !!ok, detail }; };
try {
  await send('Page.navigate', { url: appURL });
  await waitFor(async () => guestContext() && (await guestStatus()).includes('GitHub'), 'guest ready');
  const frame = await evalIn(hostContext(), `(() => { const f = document.querySelector('#app > iframe'); return { sandbox: f.getAttribute('sandbox'), srcdoc: f.hasAttribute('srcdoc'), src: f.getAttribute('src') }; })()`);
  check('guest is a sandboxed srcdoc iframe', frame.sandbox === 'allow-scripts' && frame.srcdoc && frame.src === null, frame);
  const origin = await evalIn(guestContext(), `self.origin`);
  check('guest origin is null', origin === 'null', origin);
  const storage = await evalIn(guestContext(), `(() => { try { localStorage.length; return 'available'; } catch (e) { return e.name; } })()`);
  check('guest has no localStorage', storage !== 'available', storage);
  const direct = await evalIn(guestContext(), `fetch('https://raw.githubusercontent.com/').then(() => 'sent', (e) => 'refused: ' + e.message)`);
  check('guest cannot fetch directly (connect-src)', direct.startsWith('refused'), direct);
  const parent = await evalIn(guestContext(), `(() => { try { return String(parent.document.title); } catch (e) { return e.name; } })()`);
  check('guest cannot read the host DOM', parent === 'SecurityError', parent);

  // Deny: no request.
  let before = external().length;
  await evalIn(guestContext(), `document.getElementById('load').click()`);
  await waitFor(dialogOpen, 'dialog for deny');
  const dialogText = await evalIn(hostContext(), `document.querySelector('dialog[open]').innerText`);
  check('dialog names the recipient and the withdrawal place', dialogText.includes('GitHub, Inc.') && dialogText.includes('設定 › 許可した送信') && dialogText.includes('許可しない場合、この情報は送られません。'), dialogText.slice(0, 400));
  const denyButton = await evalIn(hostContext(), `[...document.querySelectorAll('dialog[open] button')].map((b) => b.textContent)`);
  await evalIn(hostContext(), `[...document.querySelectorAll('dialog[open] button')].find((b) => b.textContent === '許可しない').click()`);
  await waitFor(async () => (await guestStatus()).includes('取り消しました'), 'deny status');
  await sleep(1000);
  check('deny sends nothing', external().length === before, { buttons: denyButton, after: external().slice(before) });

  // Allow with trusted input: one request, to the declared origin only.
  before = external().length;
  await evalIn(guestContext(), `document.getElementById('load').click()`);
  await waitFor(dialogOpen, 'dialog for allow');
  await sleep(800); // Allow is armed after 600 ms
  await evalIn(hostContext(), `(() => { const b = [...document.querySelectorAll('dialog[open] button')].find((x) => x.textContent === '許可する'); b.id = 'cdp-allow'; })()`);
  await trustedClick('#cdp-allow');
  const status = await waitFor(async () => { const s = await guestStatus(); return s.includes('最新の CID は') || s.includes('失敗') ? s : null; }, 'allow status', 30000);
  await sleep(500);
  const sent = external().slice(before).map((r) => r.url);
  check('allow sends exactly one request, to raw.githubusercontent.com', sent.length === 1 && sent[0] === 'https://raw.githubusercontent.com/cloud-itonami/app-itonami-market-android/refs/heads/feed/latest-v2.json', sent);
  check('allow shows the latest CID and that the snapshot read is off', status.includes('最新の CID は bafkrei') && status.includes('読み取りは無効'), status);

  // A synthetic click on Allow does not approve.
  before = external().length;
  await evalIn(guestContext(), `document.getElementById('load').click()`);
  await waitFor(dialogOpen, 'dialog for synthetic');
  await sleep(800);
  await evalIn(hostContext(), `[...document.querySelectorAll('dialog[open] button')].find((x) => x.textContent === '許可する').click()`);
  await sleep(800);
  const stillOpen = await dialogOpen();
  await evalIn(hostContext(), `[...document.querySelectorAll('dialog[open] button')].find((b) => b.textContent === '許可しない').click()`);
  await sleep(800);
  check('a synthetic click on Allow does not send', stillOpen && external().length === before, { stillOpen, after: external().slice(before) });

  // Link: shown as an address, the guest stays mounted.
  await evalIn(guestContext(), `(() => { const a = document.createElement('a'); a.href = 'https://creativecommons.org/publicdomain/zero/1.0/'; a.textContent = 'x'; document.body.append(a); a.click(); })()`);
  await sleep(500);
  const note = await evalIn(guestContext(), `document.getElementById('link-note').textContent`);
  check('a link click shows the address and keeps the guest', note.includes('https://creativecommons.org/publicdomain/zero/1.0/'), note);
  await evalIn(guestContext(), `(() => { const a = document.createElement('a'); a.href = 'https://example.com/?q=1'; a.textContent = 'y'; document.body.append(a); a.click(); })()`);
  await sleep(300);
  const refusedNote = await evalIn(guestContext(), `document.getElementById('link-note').textContent`);
  check('an undeclared link is refused', refusedNote.includes('宣言されていません'), refusedNote);

  // Withdraw in 設定 › 許可した送信: the guest is remounted and the send is refused before any dialog.
  await evalIn(hostContext(), `(() => { document.getElementById('allowed-sending').open = true; [...document.querySelectorAll('#allowed-list button')][0].click(); })()`);
  await waitFor(async () => guestContext() && (await guestStatus()).includes('GitHub'), 'remount after withdraw');
  before = external().length;
  await evalIn(guestContext(), `document.getElementById('load').click()`);
  const withdrawn = await waitFor(async () => { const s = await guestStatus(); return s.includes('取り消されています') ? s : null; }, 'withdrawn status');
  const noDialog = !(await dialogOpen());
  check('a withdrawn service sends nothing and opens no dialog', noDialog && external().length === before, { status: withdrawn, noDialog });
  const persisted = await evalIn(hostContext(), `localStorage.getItem('itonami.market-android.allowed-sending.v1')`);
  check('the withdrawal is kept in host storage', /"github-raw":\{"status":"withdrawn"/.test(persisted), persisted);
  await evalIn(hostContext(), `[...document.querySelectorAll('#allowed-list button')][0].click()`);
  await waitFor(async () => guestContext() && (await guestStatus()).includes('GitHub'), 'remount after restore');

  check('every external request went to a declared origin', external().every((r) => r.url.startsWith('https://raw.githubusercontent.com/')), external().map((r) => r.url));
  check('no uncaught exception', consoleErrors.length === 0, consoleErrors);
} catch (error) {
  check('run', false, String(error?.stack ?? error));
  report.diagnostics = {
    contexts: [...contexts.values()].map((c) => ({ id: c.id, origin: c.origin, isDefault: c.auxData?.isDefault, frame: c.auxData?.frameId, session: c.sessionId ?? null })),
    host: await evalIn(hostContext(), `document.body.innerText.slice(0, 500)`).catch((e) => String(e)),
    errors: consoleErrors,
  };
} finally {
  report.externalRequests = external().map((r) => r.url);
  report.ok = Object.values(report.checks).every((c) => c.ok);
  console.log(JSON.stringify(report, null, 2));
  ws.close(); server.close();
  const exited = new Promise((resolve) => chrome.once('exit', resolve));
  chrome.kill(); await exited;
  await rm(profile, { recursive: true, force: true, maxRetries: 5 });
  process.exitCode = report.ok ? 0 : 1;
}
