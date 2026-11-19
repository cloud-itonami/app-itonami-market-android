import { spawnSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { observeMarkets, legacySnapshot, rpcFor } from './ethereum.mjs';
import { assert, INDEX, GATEWAY, boundedResponse, rawCID, readIndex, verifyBlock } from '../src/protocol.mjs';
import { MARKETS_INDEX, readMarketsIndex, verifyMarketsBlock } from '../src/markets.mjs';

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
const ghPath = (file) => 'repos/' + repo + '/contents/' + file;
function currentIndex(path, reader) {
  const result = invoke('gh', ['api', path + '?ref=feed']);
  if (result.status !== 0 && result.stderr.includes('HTTP 404')) return null;
  const entry = requireSuccess(result, 'Read feed');
  return {
    sha: entry.sha,
    index: reader(JSON.parse(Buffer.from(entry.content, 'base64').toString('utf8'))),
  };
}

const dryRun = process.argv.length === 3 && process.argv[2] === '--dry-run';
assert(dryRun || (process.argv.length === 2 && cli?.startsWith('/')), 'Set MARKET_YATAVERSE_CLI to the absolute verified CLI path');
const feeds = [
  { file: 'latest-v2.json', schema: MARKETS_INDEX, read: readMarketsIndex, verify: verifyMarketsBlock },
  { file: 'latest.json', schema: INDEX, read: readIndex, verify: verifyBlock },
];

async function publishFeed(feed, data, current) {
  const path = ghPath(feed.file);
  if (current && current.index.anchor.block >= data.anchor.block) {
    assert(current.index.anchor.block > data.anchor.block || current.index.anchor.hash === data.anchor.hash,
      'Previously published finalized block hash changed');
    console.log(JSON.stringify({ result: 'already-current', feed: feed.file, cid: current.index.cid, block: current.index.anchor.block }));
    return;
  }
  const bytes = Buffer.from(JSON.stringify(data) + '\n');
  const cid = await rawCID(bytes);
  const index = feed.read({ schema: feed.schema, cid, anchor: data.anchor });
  await feed.verify(bytes, index);
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
    await feed.verify(readback, index);
    assert(readback.equals(bytes), 'Yataverse readback differs');
    const payload = JSON.stringify({
      branch: 'feed', message: 'JUN-1376 Publish ' + feed.file + ' at block ' + data.anchor.block,
      content: Buffer.from(JSON.stringify(index) + '\n').toString('base64'),
      ...(current ? { sha: current.sha } : {}),
    });
    requireSuccess(invoke('gh', ['api', '--method', 'PUT', path, '--input', '-'], payload), 'Publish latest CID');
  }
  console.log(JSON.stringify({ result: dryRun ? 'dry-run' : 'published', feed: feed.file, cid, bytes: bytes.length, block: data.anchor.block, utc: new Date(data.anchor.time * 1000).toISOString() }));
}

const current = feeds.map((feed) => dryRun ? null : currentIndex(ghPath(feed.file), feed.read));
const data = await observeMarkets(rpcFor(process.env.MARKET_ETHEREUM_RPC ?? 'https://eth.drpc.org'));
const snapshots = [data, legacySnapshot(data)];
// Each index has its own compare-and-update SHA. If one update fails, still
// attempt the other and report a failed run with both outcomes in the log.
const failures = [];
for (const [index, feed] of feeds.entries()) {
  try {
    await publishFeed(feed, snapshots[index], current[index]);
  } catch (error) {
    console.error(feed.file + ': ' + error.message);
    failures.push(error);
  }
}
if (failures.length) process.exitCode = 1;
