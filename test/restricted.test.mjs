// restricted-wasm-v1 build (KOTOBA-159): profile, declared operations and disclosures, pinned
// runtime, host policy, guest artifact, links and 設定 › 許可した送信. The build fetches the canonical
// runtime at its pinned commit (as CI does) and refuses any byte difference.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build, guestPreamble, RUNTIME_PINS } from '../scripts/build.mjs';
import { buildDescriptor, candidates, declared, undecidedServices } from '../src/descriptor.mjs';
import { DISCLOSURES, FOREIGN_INFO_URL } from '../src/disclosures.mjs';
import { LINK_ORIGINS, addressURL, blockURL, linkAllowed } from '../src/links.mjs';
import { MARKETS } from '../src/markets.mjs';
import { createAllowedSending, memoryStorage } from '../src/allowed-sending.mjs';

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const cspHash = (text) => `'sha256-${createHash('sha256').update(text, 'utf8').digest('base64')}'`;
const out = await mkdtemp(join(tmpdir(), 'market-android-dist-'));
const built = await build({ out: new URL(`file://${out}/`), env: { ITONAMI_SOURCE_COMMIT: '0123456789abcdef0123456789abcdef01234567' } });
const runtime = await import(`file://${out}/kotoba-client-runtime.js`);
test.after(() => rm(out, { recursive: true, force: true }));

test('the vendored runtime is byte-identical to the pinned canonical files', async () => {
  for (const [file, expected] of Object.entries(RUNTIME_PINS)) {
    assert.equal(sha256(await readFile(join(out, file))), expected, file);
  }
  assert.equal(RUNTIME_PINS['kotoba-client-runtime.js'], '37e826338686eefbb2b9c7a731b73c53f7f5d6864158c0790edad60f25682d6d');
});

test('the descriptor is restricted-wasm-v1 and declares only operations with a confirmed disclosure', () => {
  const d = built.descriptor;
  assert.equal(d.profile, 'restricted-wasm-v1');
  assert.deepEqual(d['local-state'], { adapter: 'memory', schema: 'itonami.onchain-market.v2', version: 1 });
  assert.deepEqual(d.operations.map((op) => [op.service, op.operation]), [['github-raw', 'read-latest-market-cid']]);
  assert.deepEqual(undecidedServices(), ['yataverse']);
  assert.equal(DISCLOSURES.yataverse, null);
  const capabilities = d.operations.map((op) => op.capability);
  assert.deepEqual(runtime.clientRuntimeProblems(d, capabilities, 'https://cloud-itonami.github.io'), []);
  assert.deepEqual(runtime.clientRuntimeProblems(d, capabilities, 'http://tauri.localhost'), []);
  assert.equal(runtime.clientRuntimeConnectSrc(d, capabilities), 'connect-src https://raw.githubusercontent.com');
  const op = d.operations[0];
  assert.equal(op.endpoint.routes[0].path, '/cloud-itonami/app-itonami-market-android/refs/heads/feed/latest-v2.json');
  assert.equal(op.disclosure.recipient, 'GitHub, Inc.');
  assert.equal(op.disclosure['foreign-info-url'], 'https://disclosures.awai.network/network.awai.itonami.market/foreign-info.html#us');
  assert.equal(op.disclosure.withdrawal, '設定 › 許可した送信');
  assert.deepEqual(runtime.clientDisclosureProblems(op.disclosure), []);
});

test('the declared operation is the existing one, unchanged apart from its disclosure', () => {
  const { disclosure, ...rest } = built.descriptor.operations[0];
  assert.ok(disclosure);
  assert.deepEqual(rest, candidates.latest);
});

test('a confirmed Yataverse disclosure would declare the snapshot read again (synthetic, test only)', () => {
  const synthetic = { ...DISCLOSURES['github-raw'], recipient: 'Synthetic Test Recipient', country: 'JP' };
  delete synthetic['country-name']; delete synthetic['foreign-info-url'];
  const d = buildDescriptor({ ...DISCLOSURES, yataverse: synthetic });
  assert.deepEqual(d.operations.map((op) => op.service), ['github-raw', 'yataverse']);
  assert.deepEqual(runtime.clientRuntimeProblems(d, d.operations.map((op) => op.capability), 'https://cloud-itonami.github.io'), []);
  assert.equal(declared({ ...DISCLOSURES, yataverse: synthetic }).snapshot.service, 'yataverse');
});

test('negative controls: the canonical runtime refuses incomplete disclosures', () => {
  const op = built.descriptor.operations[0];
  for (const field of ['recipient', 'country', 'data', 'purpose', 'frequency', 'withdrawal', 'foreign-info-url']) {
    const { [field]: _gone, ...disclosure } = op.disclosure;
    const d = { ...built.descriptor, operations: [{ ...op, disclosure }] };
    const problems = runtime.clientRuntimeProblems(d, [op.capability], 'https://cloud-itonami.github.io');
    assert.ok(problems.some((p) => p.error === 'invalid-disclosure'), field);
  }
  const { disclosure: _none, ...bare } = op;
  assert.ok(runtime.clientRuntimeProblems({ ...built.descriptor, operations: [bare] }, [op.capability], 'https://cloud-itonami.github.io').length);
});

test('the host page admits exactly the guest preamble, script and style by hash, and runs no inline script', async () => {
  const index = await readFile(join(out, 'index.html'), 'utf8');
  const csp = /http-equiv="Content-Security-Policy" content="([^"]+)"/.exec(index)[1];
  assert.equal(csp, built.csp);
  const runtimeText = await readFile(join(out, 'kotoba-client-runtime.js'), 'utf8');
  for (const text of [guestPreamble(runtimeText), built.script]) assert.ok(csp.includes(cspHash(text)));
  assert.ok(csp.includes(`style-src 'self' ${cspHash(built.style)}`));
  assert.match(csp, /^default-src 'none'; /);
  assert.ok(csp.endsWith('connect-src https://raw.githubusercontent.com'));
  for (const tag of index.matchAll(/<script\b[^>]*>/gi)) assert.match(tag[0], /src=/);
  assert.ok(!/<style[\s>]/i.test(index));
});

test('the guest is one self-contained document, pinned and verified by the canonical runtime', async () => {
  const { default: host } = await import(`file://${out}/host-data.js`);
  assert.deepEqual(host.descriptor, built.descriptor);
  const release = JSON.parse(await readFile(join(out, 'release.json'), 'utf8'));
  assert.match(host.artifact.revision, /^[0-9a-f]{40}$/);
  assert.equal(host.artifact.revision, release.source_commit);
  assert.deepEqual(release.guest, host.artifact);
  assert.ok(host.guest.length <= 8388608);
  const artifact = await runtime.verifyClientArtifact(new TextEncoder().encode(host.guest), host.artifact);
  assert.equal(artifact.verified, true);
  await assert.rejects(runtime.verifyClientArtifact(new TextEncoder().encode(host.guest.replace('営', '宮')), host.artifact), /digest mismatch/);
  const scripts = [...host.guest.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)];
  const executable = scripts.filter(([, attrs]) => !/type="application\/json"/.test(attrs));
  assert.equal(executable.length, 1);
  assert.equal(executable[0][2], built.script);
  assert.ok(!/<link\b|<script\b[^>]*\bsrc=/i.test(host.guest), 'the guest loads no file');
  const operations = JSON.parse(/<script type="application\/json" id="operations">([\s\S]*?)<\/script>/.exec(host.guest)[1]);
  assert.deepEqual(operations, { latest: { capability: 'market/index', service: 'github-raw', operation: 'read-latest-market-cid' }, snapshot: null });
  // The inlined script parses as one module.
  const file = join(out, 'guest-script-check.mjs');
  await writeFile(file, built.script);
  execFileSync(process.execPath, ['--check', file]);
});

test('links: declared origins only, no query, no user input; the guest never opens a page itself', async () => {
  assert.deepEqual(LINK_ORIGINS, ['https://etherscan.io', 'https://creativecommons.org', 'https://docs.wbtc.network']);
  // Every URL the guest builds comes from these builders or fixed text, over snapshot values.
  for (const url of [blockURL(26460627), addressURL(MARKETS[0].token) + '#code', ...MARKETS.map((m) => m.circulation.source),
    ...MARKETS.flatMap((m) => m.pools.map((p) => addressURL(p.address)))]) assert.ok(linkAllowed(url), url);
  const guestHtml = await readFile(new URL('../src/guest.html', import.meta.url), 'utf8');
  for (const [, href] of guestHtml.matchAll(/href="([^"]+)"/g)) assert.ok(linkAllowed(href), href);
  for (const refused of ['https://etherscan.io/address/0x1?ref=me', 'https://example.com/', 'http://etherscan.io/block/1',
    'https://user@etherscan.io/', 'https://etherscan.io/' + 'a'.repeat(300), 'javascript:alert(1)']) assert.equal(linkAllowed(refused), false, refused);
  const guest = await readFile(new URL('../src/guest.mjs', import.meta.url), 'utf8');
  for (const [, rhs] of guest.matchAll(/\.href = ([^;]+);/g)) assert.match(rhs, /^(blockURL|addressURL|spec\.circulation\.source|contractURL|href)\b/, rhs);
  // `href` is makeRow's parameter: every call passes addressURL(...) or nothing.
  for (const [call] of guest.matchAll(/makeRow\((?:[^()]|\([^()]*\))*\)/g)) {
    if (call.startsWith('makeRow(label')) continue; // the definition
    const args = call.slice(8, -1);
    assert.ok(!/,\s*[^,]+,\s*[^,]+,\s*[^,]+$/.test(args) || /addressURL\(/.test(args), call);
  }
  assert.ok(!/window\.open|location\.(assign|replace|href\s*=)|\.target\s*=/.test(guest), 'the guest never navigates');
  assert.match(guest, /addEventListener\('click'[\s\S]*?event\.preventDefault\(\);[\s\S]*?linkAllowed\(link\.href\)/);
});

test('設定 › 許可した送信: a withdrawn service is not eligible; restore brings it back; bad storage is ignored', () => {
  const storage = memoryStorage();
  let changes = 0;
  const allowed = createAllowedSending(storage, { now: () => '2026-11-22T00:00:00.000Z' });
  allowed.onChange(() => { changes += 1; });
  const ops = built.descriptor.operations;
  assert.deepEqual(allowed.eligible(ops), ops);
  allowed.withdraw('github-raw');
  assert.deepEqual(allowed.eligible(ops), []);
  assert.deepEqual(storage.peek(), { schema: 'itonami.market-android.allowed-sending.v1', services: { 'github-raw': { status: 'withdrawn', withdrawnAt: '2026-11-22T00:00:00.000Z' } } });
  assert.equal(createAllowedSending(storage).isWithdrawn('github-raw'), true, 'kept across a reload');
  allowed.restore('github-raw');
  assert.deepEqual(allowed.eligible(ops), ops);
  assert.equal(changes, 2);
  assert.equal(createAllowedSending(memoryStorage({ schema: 'other', services: { 'github-raw': { status: 'withdrawn' } } })).isWithdrawn('github-raw'), false);
  assert.equal(createAllowedSending({ load() { throw new Error('blocked'); }, save() { throw new Error('blocked'); } }).isWithdrawn('github-raw'), false);
});

test('the foreign-information page is the shared disclosures location, under the package id', async () => {
  const conf = JSON.parse(await readFile(new URL('../src-tauri/tauri.conf.json', import.meta.url), 'utf8'));
  assert.equal(FOREIGN_INFO_URL, `https://disclosures.awai.network/${conf.identifier}/foreign-info.html`);
  assert.equal(FOREIGN_INFO_URL, 'https://disclosures.awai.network/network.awai.itonami.market/foreign-info.html');
});
