// Static build for restricted-wasm-v1 (KOTOBA-159). dist/index.html is the trusted host page
// (src/host.html, src/host.mjs) with the canonical runtime. The app itself is one self-contained
// guest document (src/guest.html with protocol.mjs, markets.mjs and guest.mjs inlined as one module
// script), pinned by SHA-256 and the source commit in dist/host-data.js. The host verifies it with
// verifyClientArtifact and mounts it with mountRestrictedClientApp in an opaque-origin sandbox. The
// page policy admits exactly the runtime's guest preamble, the guest script and the guest style, by
// hash. The canonical runtime is fetched at a pinned commit and refused unless its SHA-256 matches.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';

export const RUNTIME_REVISION = 'e58ae70b4bdc818b3feec767f7ac9908cd6e7a2c';
export const RUNTIME_SOURCE = `https://raw.githubusercontent.com/kotoba-lang/kotoba/${RUNTIME_REVISION}/lib/kotoba.wasmWebcomponent/src/`;
export const RUNTIME_PINS = Object.freeze({
  'kotoba-client-runtime.js': '37e826338686eefbb2b9c7a731b73c53f7f5d6864158c0790edad60f25682d6d',
  'kotoba-client-consent.css': 'c76ed61a1a59cc1d84f9ec19afd9f49562df6c28a4c6078ccfb7dec8f34240bb',
});
export const GUEST_SOURCES = Object.freeze(['protocol.mjs', 'markets.mjs', 'links.mjs', 'guest.mjs']);
import { LINK_ORIGINS } from '../src/links.mjs';
const MOUNT_BUDGET = 8388608; // mountRestrictedClientApp refuses guest HTML longer than this

const src = new URL('../src/', import.meta.url);
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const cspHash = (text) => `'sha256-${createHash('sha256').update(text, 'utf8').digest('base64')}'`;
const read = (file) => readFile(new URL(file, src), 'utf8');

/** The guest's one inline script: the three modules with their imports and `export` keywords removed. */
export async function guestScript() {
  const parts = [];
  for (const file of GUEST_SOURCES) {
    const text = await read(file);
    parts.push(text.replace(/^import .* from '\.\/[a-z-]+\.mjs';\n/gm, '').replace(/^export /gm, ''));
  }
  const script = parts.join('\n');
  if (/^\s*(import|export)\b/m.test(script)) throw new Error('the guest script still has an import or export');
  if (/<\/script/i.test(script)) throw new Error('the guest script contains </script');
  return script;
}

export async function guestStyle() {
  const style = await read('style.css');
  if (/<\/style/i.test(style)) throw new Error('src/style.css contains </style');
  return style;
}

/** The inline script mountRestrictedClientApp puts before the guest (KOTOBA-159 R6). */
export function guestPreamble(runtimeText) {
  const m = /^const GUEST_PREAMBLE = '<script>([^'\\]*)<\/script>';$/m.exec(runtimeText);
  if (!m) throw new Error('the canonical runtime has no GUEST_PREAMBLE this build can hash');
  return m[1];
}

export function hostPolicy({ preamble, script, style, connectSrc }) {
  return `default-src 'none'; script-src 'self' ${cspHash(preamble)} ${cspHash(script)}; style-src 'self' ${cspHash(style)}; base-uri 'none'; form-action 'none'; ${connectSrc}`;
}

function sourceState(env) {
  try {
    const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: new URL('..', import.meta.url), encoding: 'utf8' }).trim();
    const dirty = execFileSync('git', ['status', '--porcelain'], { cwd: new URL('..', import.meta.url), encoding: 'utf8' }).trim() !== '';
    return { commit, dirty };
  } catch {
    const commit = env.ITONAMI_SOURCE_COMMIT ?? null;
    return { commit, dirty: env.ITONAMI_SOURCE_DIRTY === 'true' };
  }
}

async function fetchRuntime() {
  const files = {};
  for (const [file, expected] of Object.entries(RUNTIME_PINS)) {
    const response = await fetch(RUNTIME_SOURCE + file, { redirect: 'error', signal: AbortSignal.timeout(20_000) });
    if (!response.ok) throw new Error(`Cannot retrieve canonical Kotoba runtime: ${file} (${response.status})`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (sha256(bytes) !== expected) throw new Error(`Canonical Kotoba digest mismatch: ${file}`);
    files[file] = bytes;
  }
  return files;
}

export async function build({ env = process.env, out = new URL('../dist/', import.meta.url), runtimeFiles } = {}) {
  const files = runtimeFiles ? { ...runtimeFiles } : await fetchRuntime();
  for (const [file, expected] of Object.entries(RUNTIME_PINS)) {
    if (sha256(files[file]) !== expected) throw new Error(`Canonical Kotoba digest mismatch: ${file}`);
  }
  const runtimeText = new TextDecoder().decode(files['kotoba-client-runtime.js']);
  const runtime = await import(`data:text/javascript;base64,${Buffer.from(files['kotoba-client-runtime.js']).toString('base64')}`);
  const { descriptor, capabilities, declared } = await import('../src/descriptor.mjs');
  const problems = runtime.clientRuntimeProblems(descriptor, capabilities, 'https://cloud-itonami.github.io');
  if (problems.length) throw new Error(`invalid descriptor: ${JSON.stringify(problems)}`);
  const connectSrc = runtime.clientRuntimeConnectSrc(descriptor, capabilities);

  const state = sourceState(env);
  if (!state.commit || !/^[0-9a-f]{40}$/.test(state.commit)) throw new Error('restricted-wasm-v1 pins the guest to its source commit: build from a git checkout or set ITONAMI_SOURCE_COMMIT');

  const script = await guestScript();
  const style = await guestStyle();
  const preamble = guestPreamble(runtimeText);
  const selectors = Object.fromEntries(Object.entries(declared()).map(([name, op]) =>
    [name, op ? { capability: op.capability, service: op.service, operation: op.operation } : null]));
  const operations = JSON.stringify(selectors).replace(/</g, '\\u003c');
  const template = await read('guest.html');
  for (const marker of ['{{STYLE}}', '{{OPERATIONS}}', '{{SCRIPT}}']) {
    if (template.split(marker).length !== 2) throw new Error(`guest.html must contain ${marker} once`);
  }
  const guest = template.replace('{{STYLE}}', () => style).replace('{{OPERATIONS}}', () => operations).replace('{{SCRIPT}}', () => script);
  if (guest.length > MOUNT_BUDGET) throw new Error('the guest exceeds the 8 MiB mount budget');
  const guestBytes = new TextEncoder().encode(guest);
  const artifact = { revision: state.commit, sha256: sha256(guestBytes), 'max-bytes': guestBytes.byteLength };

  const csp = hostPolicy({ preamble, script, style, connectSrc });
  const host = await read('host.html');
  if (host.split('@CSP@').length !== 2) throw new Error('host.html has no CSP build marker');
  files['index.html'] = host.replace('@CSP@', () => csp);
  for (const file of ['host.mjs', 'host.css', 'allowed-sending.mjs', 'disclosures.mjs']) files[file] = await read(file);
  files['host-data.js'] = `export default ${JSON.stringify({ descriptor, artifact, guest }, null, 1)};\n`;
  files['descriptor.json'] = JSON.stringify(descriptor, null, 2) + '\n';
  const digests = Object.fromEntries(Object.entries(files).map(([file, bytes]) => [file, sha256(bytes)]));
  files['release.json'] = JSON.stringify({
    schema: 'awai.app.artifact.v1',
    id: 'itonami-market-android',
    version: JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')).version,
    profile: descriptor.profile,
    canonicalRuntime: { revision: RUNTIME_REVISION, source: RUNTIME_SOURCE, files: RUNTIME_PINS },
    links: LINK_ORIGINS,
    guest: artifact,
    source_commit: state.commit,
    dirty: state.dirty,
    files: digests,
  }, null, 2) + '\n';
  await mkdir(out, { recursive: true });
  await Promise.all(Object.entries(files).map(([file, bytes]) => writeFile(new URL(file, out), bytes)));
  return { out, files, descriptor, artifact, csp, guest, script, style, preamble };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { out } = await build();
  console.log(`Static artifact: ${out.pathname}`);
}
