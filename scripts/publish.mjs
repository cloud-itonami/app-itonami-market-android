import { spawnSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { observe, rpcFor } from './ethereum.mjs';
import { assert, INDEX, GATEWAY, boundedResponse, rawCID, readIndex, verifyBlock } from '../src/protocol.mjs';

const repo = 'network-awai/app-itonami-market-android';
const output = resolve(process.env.MARKET_ARCHIVE_DIR ?? '.agent-output/feed-archive');
const cli = process.env.MARKET_YATAVERSE_CLI;
const invoke = (tool, args, input) => spawnSync(tool, args, {
  input, encoding: 'utf8', timeout: 120_000, maxBuffer: 256 * 1024,
});
function requireSuccess(result, operation) {
  if (result.error || result.status !== 0) {
    // Avoid emitting provider/client error bodies, which may include credentials or account identifiers.
    throw new Error(operation + ' failed (exit ' + (result.status ?? 'unknown') + ').');
  }
  return JSON.parse(result.stdout);
}
async function saveOnce(path, bytes) {
  try {
    await writeFile(path, bytes, { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if (error.code !== 'EEXIST' || !(await readFile(path)).equals(bytes)) throw error;
  }
}
const ghPath = 'repos/' + repo + '/contents/latest.json';
function currentIndex() {
  const result = invoke('gh', ['api', ghPath + '?ref=feed']);
  if (result.status !== 0 && result.stderr.includes('HTTP 404')) return null;
  const entry = requireSuccess(result, 'Read feed');
  return {
    sha: entry.sha,
    index: readIndex(JSON.parse(Buffer.from(entry.content, 'base64').toString('utf8'))),
  };
}

const dryRun = process.argv.length === 3 && process.argv[2] === '--dry-run';
assert(dryRun || (process.argv.length === 2 && cli?.startsWith('/')), 'Set MARKET_YATAVERSE_CLI to the absolute verified CLI path');
const current = dryRun ? null : currentIndex();
const endpoint = process.env.MARKET_ETHEREUM_RPC ?? 'https://eth.drpc.org';
const data = await observe(rpcFor(endpoint));
if (current && current.index.anchor.block >= data.anchor.block) {
  assert(current.index.anchor.block > data.anchor.block || current.index.anchor.hash === data.anchor.hash,
    'Previously published finalized block hash changed');
  console.log(JSON.stringify({ result: 'already-current', block: current.index.anchor.block }));
} else {
  const bytes = Buffer.from(JSON.stringify(data) + '\n');
  const cid = await rawCID(bytes);
  const index = readIndex({ schema: INDEX, cid, anchor: data.anchor });
  await verifyBlock(bytes, index);
  await mkdir(output, { recursive: true, mode: 0o700 });
  const rawPath = join(output, cid + '.json');
  await saveOnce(rawPath, bytes);
  if (!dryRun) {
    const receiptPath = join(output, cid + '.receipt.json');
    let receipt;
    try {
      receipt = JSON.parse(await readFile(receiptPath, 'utf8'));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      receipt = requireSuccess(invoke(process.execPath, [cli, 'put', rawPath]), 'Yataverse put');
      assert(receipt.cid === cid && receipt.bytes === bytes.length && receipt.receiptVerified === true
        && receipt.verified === true && receipt.receipt?.sig, 'Yataverse verified receipt required');
      await saveOnce(receiptPath, Buffer.from(JSON.stringify(receipt) + '\n'));
    }
    assert(receipt.cid === cid && receipt.bytes === bytes.length && receipt.receiptVerified === true
      && receipt.verified === true && receipt.receipt?.sig, 'Cached verified receipt required');
    const response = await fetch(`${GATEWAY}/ipfs/${cid}?format=raw`, { redirect: 'error', signal: AbortSignal.timeout(25_000) });
    const readback = Buffer.from(await boundedResponse(response));
    await verifyBlock(readback, index);
    assert(readback.equals(bytes), 'Yataverse readback differs');
    const payload = JSON.stringify({
      branch: 'feed', message: 'JUN-1366 Publish market snapshot at block ' + data.anchor.block,
      content: Buffer.from(JSON.stringify(index) + '\n').toString('base64'),
      ...(current ? { sha: current.sha } : {}),
    });
    requireSuccess(invoke('gh', ['api', '--method', 'PUT', ghPath, '--input', '-'], payload), 'Publish latest CID');
  }
  console.log(JSON.stringify({ result: dryRun ? 'dry-run' : 'published', cid, bytes: bytes.length, block: data.anchor.block, utc: new Date(data.anchor.time * 1000).toISOString() }));
}
