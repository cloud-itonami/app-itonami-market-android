import { setTimeout as delay } from 'node:timers/promises';
import { POOL, WETH, SWAP_TOPIC, SNAPSHOT, assert, boundedResponse, readSnapshot } from '../src/protocol.mjs';
import { FACTORY, USDC, MARKETS, MARKETS_SNAPSHOT, aggregatePools, readMarketsSnapshot } from '../src/markets.mjs';

const fn = { slot0: '0x3850c7bd', supply: '0x18160ddd', token0: '0x0dfe1681', token1: '0xd21220a7', decimals: '0x313ce567' };
const q192 = 1n << 192n;
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

// The sqrt price squares to raw token1/token0. Exactly one token is USDC.
// Its 6 decimals coincide with the required micro-USDC output.
export function priceMicros(slot0, asset) {
  const ratio = uint(slot0.slice(0, 66));
  assert(ratio > 0n, 'Uninitialized Uniswap price');
  const squared = ratio * ratio;
  const units = 10n ** BigInt(asset.decimals);
  return (asset.quoteSide === 0 ? q192 * units / squared : squared * units / q192).toString();
}
export function swapUSDC(data, quoteSide) {
  assert(typeof data === 'string' && /^0x[0-9a-f]{320}$/i.test(data), 'Malformed Swap event');
  const offset = 2 + quoteSide * 64;
  const amount = BigInt.asIntN(256, uint('0x' + data.slice(offset, offset + 64)));
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

const pools = MARKETS.flatMap((asset) => asset.pools.map((pool) => ({ asset, ...pool })));
const byAddress = new Map(pools.map((pool) => [pool.address, pool]));
const addresses = [...byAddress.keys()];

async function poolVolumes(rpc, first, last) {
  const segments = [];
  for (let from = first; from <= last; from += 100) segments.push([from, Math.min(from + 99, last)]);
  const results = await chunked(segments, 2, (group) => rpc(group.map(([from, to]) =>
    ['eth_getLogs', [{ address: addresses, topics: [SWAP_TOPIC], fromBlock: tag(from), toBlock: tag(to) }]])));
  const seen = new Set();
  const volume = new Map(addresses.map((address) => [address, 0n]));
  for (const [index, logs] of results.entries()) {
    const [from, to] = segments[index];
    assert(Array.isArray(logs), 'Invalid Swap response');
    for (const event of logs) {
      const number = Number(uint(event.blockNumber));
      const address = event.address.toLowerCase();
      const pool = byAddress.get(address);
      const identity = event.blockHash + ':' + uint(event.logIndex);
      assert(event.removed === false && pool && event.topics[0] === SWAP_TOPIC
        && /^0x[0-9a-f]{64}$/.test(event.blockHash) && number >= from && number <= to && !seen.has(identity),
      'Unexpected or duplicate Swap');
      seen.add(identity);
      volume.set(address, volume.get(address) + swapUSDC(event.data, pool.asset.quoteSide));
    }
  }
  return volume;
}

const abiWord = (value) => value.toString(16).replace(/^0x/, '').padStart(64, '0');
function factoryLookup(pool) {
  return '0x1698ee82' + abiWord(pool.asset.token) + abiWord(USDC) + abiWord(pool.fee);
}

export async function observeMarkets(rpc, now = Date.now()) {
  const [chain, final] = await rpc([['eth_chainId', []], blockAt('finalized')]);
  assert(chain === '0x1', 'Expected Ethereum mainnet');
  const anchor = block(final);
  const age = Math.floor(now / 1000) - anchor.time;
  assert(age >= -120 && age <= 3600, 'Current finalized Ethereum data is outside the freshness window');
  const height = tag(anchor.block);
  const [quoteDecimals, ...decimals] = await rpc([callAt(USDC, fn.decimals, height),
    ...MARKETS.map(({ token }) => callAt(token, fn.decimals, height))]);
  assert(uint(quoteDecimals) === 6n && MARKETS.every((asset, i) => uint(decimals[i]) === BigInt(asset.decimals)),
    'Unexpected token decimals');
  const prices = new Map();
  for (const pool of pools) {
    const [registered, slot, token0, token1] = await rpc([
      callAt(FACTORY, factoryLookup(pool), height), callAt(pool.address, fn.slot0, height),
      callAt(pool.address, fn.token0, height), callAt(pool.address, fn.token1, height),
    ]);
    const address = (value) => '0x' + value.slice(-40).toLowerCase();
    const tokens = [address(token0), address(token1)];
    assert(address(registered) === pool.address && tokens[pool.asset.quoteSide] === USDC
      && tokens[1 - pool.asset.quoteSide] === pool.asset.token, 'Unexpected Uniswap pool identity or token order');
    prices.set(pool.address, priceMicros(slot, pool.asset));
  }

  const windowStart = await firstInWindow(rpc, anchor.block, anchor.time - 86400);
  const volumes = await poolVolumes(rpc, windowStart.block, anchor.block);
  // Observe the reference pool for each asset at the same set of heights.
  const heights = Array.from({ length: 29 }, (_, i) => tag(anchor.block - (29 - i) * 7150));
  const samples = await chunked(heights, 1, async ([item]) => {
    const [meta, ...slots] = await rpc([blockAt(item), ...MARKETS.map((asset) =>
      callAt(asset.pools[0].address, fn.slot0, item))]);
    return [{ anchor: block(meta), slots }];
  });
  const supply = await rpc(MARKETS.map((asset) => callAt(asset.token, fn.supply, height)));
  const markets = MARKETS.map((asset, index) => {
    const historyPool = asset.pools[0].address;
    const rows = asset.pools.map((pool) => ({ ...pool, priceMicros: prices.get(pool.address),
      volumeMicros: volumes.get(pool.address).toString() }));
    const history = samples.map(({ anchor: point, slots }) => ({ ...point, priceMicros: priceMicros(slots[index], asset) }));
    history.push({ ...anchor, priceMicros: prices.get(historyPool) });
    return { token: asset.token, supplyRaw: uint(supply[index]).toString(), ...aggregatePools(rows), pools: rows, historyPool, history };
  });
  const [readback] = await rpc([blockAt(height)]);
  assert(block(readback).hash === anchor.hash, 'Finalized Ethereum block changed during observation');
  return readMarketsSnapshot({ schema: MARKETS_SNAPSHOT, chain: 1, quote: USDC, license: 'CC0-1.0', anchor, windowStart, markets });
}

export function legacySnapshot(data) {
  const weth = data.markets[0];
  const pool = weth.pools[0];
  return readSnapshot({ schema: SNAPSHOT, chain: 1, pool: POOL, token: WETH, license: 'CC0-1.0',
    anchor: data.anchor, windowStart: data.windowStart, priceMicros: pool.priceMicros, supplyWei: weth.supplyRaw,
    capMicros: (BigInt(weth.supplyRaw) * BigInt(pool.priceMicros) / 10n ** 18n).toString(),
    volumeMicros: pool.volumeMicros, history: weth.history });
}
