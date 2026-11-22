// The deploy gate (Decision 2026-11-22). Negative control: even when DNS is up and every disclosure
// page answers 200, the deploy stays blocked while a feature from before the move is still off.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { deployAllowed, disabledFeatures, disclosurePages } from '../scripts/deploy-gate.mjs';
import { undecidedServices } from '../src/descriptor.mjs';

const ok200 = async () => new Response('', { status: 200 });
const down = async () => { throw new Error('fetch failed'); };

test('negative control: disclosure pages answer 200, a feature is still off -> blocked', async () => {
  const features = await disabledFeatures();
  assert.ok(features.length > 0);
  const result = await deployAllowed({ fetchImpl: ok200 });
  assert.equal(result.ok, false);
  assert.ok(result.reasons.every((r) => r.startsWith('feature still off:')), 'only the feature gate blocks');
});

test('disclosure pages down -> blocked, whatever the features', async () => {
  assert.equal((await deployAllowed({ fetchImpl: down, features: [] })).ok, false);
});

test('positive control: pages answer 200 and no feature is off -> allowed', async () => {
  assert.deepEqual(await deployAllowed({ fetchImpl: ok200, features: [] }), { ok: true, reasons: [] });
  assert.deepEqual(disclosurePages(), ['https://disclosures.awai.network/network.awai.itonami.market/foreign-info.html']);
});

test('the list matches the code: snapshot-read is listed exactly while the Yataverse read is undeclared', async () => {
  const ids = (await disabledFeatures()).map((f) => f.id);
  assert.equal(ids.includes('snapshot-read'), undecidedServices().includes('yataverse'));
  for (const id of ids) assert.ok(['snapshot-read'].includes(id), id);
});

test('CI runs the deploy gate before the Pages upload', async () => {
  const wf = await readFile(new URL('../.github/workflows/market-pages.yml', import.meta.url), 'utf8');
  const gate = wf.indexOf('node scripts/deploy-gate.mjs');
  assert.ok(gate > 0 && gate < wf.indexOf('upload-pages-artifact'));
});
