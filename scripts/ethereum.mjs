import { setTimeout as delay } from 'node:timers/promises';
import { POOL, WETH, SWAP_TOPIC, SNAPSHOT, assert, boundedResponse, readSnapshot } from '../src/protocol.mjs';

const fn = { slot0: '0x3850c7bd', supply: '0x18160ddd', token0: '0x0dfe1681', token1: '0xd21220a7' };
const usdc = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
const tag = (number) => '0x' + number.toString(16);
const blockAt = (height) => ['eth_getBlockByNumber', [height, false]];
const callAt = (to, data, height) => ['eth_call', [{ to, data }, height]];

function uint(value) {
  assert(typeof value === 'string' && /^0x[0-9a-f]+$/i.test(value), 'Invalid Ethereum quantity');
  return BigInt(value);
}
function block(row) {
  return { block: Number(uint(row.number)), hash: row.hash, time: Number(uint(row.timestamp)) };
}

// sqrtPriceX96 is sqrt(raw WETH / raw USDC) * 2^96. Invert and
// account for 18/6 decimals. The result is truncated to micro-USDC.
export function priceMicros(slot0) {
  const ratio = uint(slot0.slice(0, 66));
  assert(ratio > 0n, 'Uninitialized Uniswap price');
  return ((1n << 192n) * 10n ** 18n / (ratio * ratio)).toString();
}
export function swapUSDC(data) {
  assert(typeof data === 'string' && /^0x[0-9a-f]{320}$/i.test(data), 'Malformed Swap event');
  const amount = BigInt.asIntN(256, uint(data.slice(0, 66)));
  return amount < 0n ? -amount : amount;
}

export function rpcFor(endpoint) {
  const url = new URL(endpoint);
  assert(url.protocol === 'https:' || (url.protocol === 'http:' && url.hostname === '127.0.0.1'), 'Use HTTPS or an explicitly local Ethereum RPC');
  return async function rpc(calls) {
    if (calls.length > 3) return chunked(calls, 3, rpc);
    const body = JSON.stringify(calls.map(([method, params], id) => ({ jsonrpc: '2.0', id, method, params })));
    for (let attempt = 0; attempt < 3; attempt++) {
      const response = await fetch(url, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body,
        redirect: 'error', signal: AbortSignal.timeout(25_000),
      });
      if ((response.status === 429 || response.status >= 500) && attempt < 2) {
        await response.body?.cancel();
        await delay(1500 * (attempt + 1));
        continue;
      }
      const bytes = await boundedResponse(response, 6 * 1024 * 1024);
      const rows = JSON.parse(new TextDecoder().decode(bytes));
      assert(Array.isArray(rows) && rows.length === calls.length, 'Incomplete RPC batch');
      return calls.map(([method], id) => {
        const item = rows.find((row) => row.id === id);
        assert(item?.jsonrpc === '2.0' && !item.error && item.result !== undefined && item.result !== null,
          `Ethereum RPC ${method}: ${item?.error?.message ?? 'missing result'}`);
        return item.result;
      });
    }
  };
}

async function chunked(items, size, task) {
  const output = [];
  for (let i = 0; i < items.length; i += size) output.push(...await task(items.slice(i, i + size)));
  return output;
}

async function firstInWindow(rpc, end, startTime) {
  let low = end - 7500;
  let high = end;
  const [earlier] = await rpc([blockAt(tag(low))]);
  assert(block(earlier).time < startTime, 'Insufficient block search range');
  while (low + 1 < high) {
    const mid = Math.floor((low + high) / 2);
    const [row] = await rpc([blockAt(tag(mid))]);
    if (block(row).time < startTime) low = mid;
    else high = mid;
  }
  const [first] = await rpc([blockAt(tag(high))]);
  return block(first);
}

async function poolVolume(rpc, first, last) {
  const segments = [];
  for (let from = first; from <= last; from += 100) segments.push([from, Math.min(from + 99, last)]);
  const result = await chunked(segments, 3, (group) => rpc(group.map(([from, to]) =>
    ['eth_getLogs', [{ address: POOL, topics: [SWAP_TOPIC], fromBlock: tag(from), toBlock: tag(to) }]])));
  const seen = new Set();
  let volume = 0n;
  for (const [index, logs] of result.entries()) {
    const [from, to] = segments[index];
    assert(Array.isArray(logs), 'Invalid Swap response');
    for (const event of logs) {
      const number = Number(uint(event.blockNumber));
      const identity = event.blockHash + ':' + event.logIndex;
      assert(event.removed === false && event.address.toLowerCase() === POOL && event.topics[0] === SWAP_TOPIC
        && number >= from && number <= to && !seen.has(identity), 'Unexpected or duplicate Swap');
      seen.add(identity);
      volume += swapUSDC(event.data);
    }
  }
  return volume.toString();
}

export async function observe(rpc, now = Date.now()) {
  const [chain, final] = await rpc([['eth_chainId', []], blockAt('finalized')]);
  assert(chain === '0x1', 'Expected Ethereum mainnet');
  const anchor = block(final);
  const age = Math.floor(now / 1000) - anchor.time;
  assert(age >= -120 && age <= 3600, 'Current finalized Ethereum data is outside the freshness window');
  const height = tag(anchor.block);
  const [slot, supply, token0, token1] = await rpc([
    callAt(POOL, fn.slot0, height), callAt(WETH, fn.supply, height),
    callAt(POOL, fn.token0, height), callAt(POOL, fn.token1, height),
  ]);
  assert('0x' + token0.slice(-40).toLowerCase() === usdc && '0x' + token1.slice(-40).toLowerCase() === WETH,
    'Unexpected pool token ordering');
  const price = priceMicros(slot);
  const supplyRaw = uint(supply);
  const windowStart = await firstInWindow(rpc, anchor.block, anchor.time - 86400);
  const volume = await poolVolume(rpc, windowStart.block, anchor.block);

  // Height samples about a day apart. Each point carries its actual block time
  // and hash, so no sample is presented as an exact UTC close.
  const heights = Array.from({ length: 29 }, (_, i) => tag(anchor.block - (29 - i) * 7150));
  const history = await chunked(heights, 3, async (group) => {
    const results = await rpc(group.flatMap((item) => [blockAt(item), callAt(POOL, fn.slot0, item)]));
    return group.map((_, i) => ({ ...block(results[i * 2]), priceMicros: priceMicros(results[i * 2 + 1]) }));
  });
  history.push({ ...anchor, priceMicros: price });
  return readSnapshot({
    schema: SNAPSHOT, chain: 1, pool: POOL, token: WETH, license: 'CC0-1.0', anchor, windowStart,
    priceMicros: price, supplyWei: supplyRaw.toString(), capMicros: (supplyRaw * BigInt(price) / 10n ** 18n).toString(),
    volumeMicros: volume, history,
  });
}
