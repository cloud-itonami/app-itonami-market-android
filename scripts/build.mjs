import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';

const revision = '44c9df8e83d1d00fbe4e91e5ae86bd7851420614';
const upstream = `https://raw.githubusercontent.com/kotoba-lang/kotoba/${revision}/lib/kotoba.wasmWebcomponent/src/`;
const pins = {
  'kotoba-client-runtime.js': '9c875d7720696fa964f82f489a1337d72d8c8cf382127c594da54fb503ef077e',
  'kotoba-client-consent.css': 'eb1caab0619c5ca4428df637ae140bc3774582fa3f0b95a44bbd39b27b6b9086',
};
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const files = {};
for (const [file, expected] of Object.entries(pins)) {
  const response = await fetch(upstream + file, { redirect: 'error', signal: AbortSignal.timeout(20_000) });
  if (!response.ok) throw new Error(`Cannot retrieve canonical Kotoba runtime: ${file} (${response.status})`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (sha256(bytes) !== expected) throw new Error(`Canonical Kotoba digest mismatch: ${file}`);
  files[file] = bytes;
}

const { clientRuntimeConnectSrc } = await import(`data:text/javascript;base64,${Buffer.from(files['kotoba-client-runtime.js']).toString('base64')}`);
const { descriptor, capabilities } = await import('../src/descriptor.mjs');
const connectSrc = clientRuntimeConnectSrc(descriptor, capabilities);
for (const file of ['protocol.mjs', 'markets.mjs', 'app.mjs', 'descriptor.mjs', 'style.css']) {
  files[file] = await readFile(new URL('../src/' + file, import.meta.url));
}
const html = await readFile(new URL('../src/index.html', import.meta.url), 'utf8');
if (!html.includes('@CONNECT_SRC@')) throw new Error('HTML has no CSP build marker');
files['index.html'] = html.replace('@CONNECT_SRC@', connectSrc);
files['descriptor.json'] = JSON.stringify(descriptor, null, 2) + '\n';
files['release.json'] = JSON.stringify({
  schema: 'awai.app.artifact.v1',
  id: 'itonami-market-android',
  version: '0.2.0',
  canonicalRuntime: { revision, source: upstream, files: pins },
  files: Object.fromEntries(Object.entries(files).map(([file, bytes]) => [file, sha256(bytes)])),
}, null, 2) + '\n';
const dist = new URL('../dist/', import.meta.url);
await mkdir(dist, { recursive: true });
await Promise.all(Object.entries(files).map(([file, bytes]) => writeFile(new URL(file, dist), bytes)));
console.log(`Static artifact: ${dist.pathname}`);
