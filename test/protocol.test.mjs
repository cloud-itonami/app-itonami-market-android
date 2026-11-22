import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { INDEX, SNAPSHOT, POOL, WETH, rawCID, verifyBlock, readSnapshot } from '../src/protocol.mjs';
import { MARKETS, USDC, MARKETS_INDEX, MARKETS_SNAPSHOT, CIRCULATION_METHOD, aggregatePools, readMarketsSnapshot, unavailableCirculation, verifyMarketsBlock } from '../src/markets.mjs';
import { priceMicros, swapUSDC, legacySnapshot } from '../scripts/ethereum.mjs';

const word = (x) => BigInt.asUintN(256, x).toString(16).padStart(64, '0');
test('inverts raw WETH/USDC price and normalizes token decimals', () => {
  assert.equal(priceMicros('0x' + word(1n << 96n), MARKETS[0]), '1000000000000000000');
});
test('counts either direction once using the USDC leg', () => {
  for (const value of [25n, -25n]) {
    const event = '0x' + word(17n) + word(value) + '0'.repeat(192);
    assert.equal(swapUSDC(event, 0), 17n);
    assert.equal(swapUSDC(event, 1), 25n);
  }
});
test('CID binds bytes and anchor and refuses corruption', async () => {
  const hash = '0x' + '1'.repeat(64);
  const history = Array.from({ length: 30 }, (_, i) => ({ block: 1 + i, time: 1700000000 + i * 86400, hash, priceMicros: '20' }));
  const anchor = history.at(-1);
  const value = { schema: SNAPSHOT, chain: 1, pool: POOL, token: WETH, license: 'CC0-1.0', anchor,
    windowStart: history.at(-2), history, priceMicros: '20', supplyWei: '1000000000000000000', capMicros: '20', volumeMicros: '1' };
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  const index = { schema: INDEX, cid: await rawCID(bytes), anchor };
  assert.equal((await verifyBlock(bytes, index)).capMicros, '20');
  await assert.rejects(() => verifyBlock(bytes, { ...index, anchor: { ...anchor, block: 100 } }), /観測情報/);
  await assert.rejects(() => verifyBlock(bytes.slice(1), index), /CID/);
  assert.throws(() => readSnapshot({ ...value, capMicros: '21' }), /時価総額/);
});

test('normalizes prices using either token order with exact micro-USDC units', () => {
  assert.equal(priceMicros('0x' + word(1n << 97n), MARKETS[0]), '250000000000000000');
  assert.equal(priceMicros('0x' + word(1n << 97n), MARKETS[1]), '400000000');
});
test('weights each pool price by the same 24h USDC used in total volume', () => {
  const pools = [{priceMicros:'100',volumeMicros:'10'},{priceMicros:'200',volumeMicros:'30'}];
  assert.deepEqual(aggregatePools(pools),{priceMicros:'175',volumeMicros:'40'});
  assert.deepEqual(aggregatePools([{...pools[0],volumeMicros:'0'},pools[1]]), {priceMicros:'200',volumeMicros:'30'});
  assert.throws(() => aggregatePools([{...pools[0],volumeMicros:'0'}]), /出来高/);
});
test('v2 validates its fixed markets and common window and keeps the v1 pool values', async () => {
  const hash = '0x' + 'a'.repeat(64);
  const history = Array.from({ length:30 }, (_, i) => ({ block:i+100, time:1700000000+i*86400, hash, priceMicros:'100' }));
  const anchor = history.at(-1);
  const data = {
    schema:MARKETS_SNAPSHOT, chain:1, quote:USDC, license:'CC0-1.0', anchor, windowStart:history.at(-2),
    markets:MARKETS.map((asset) => {
      const pools=asset.pools.map((pool,i)=>({...pool,priceMicros:i===0?'100':'200',volumeMicros:i===0?'10':'30'}));
      return {token:asset.token,supplyRaw:'1000000000000000000',...aggregatePools(pools),pools,historyPool:pools[0].address,history};
    }),
  };
  const bytes = new TextEncoder().encode(JSON.stringify(data));
  const index = {schema:MARKETS_INDEX,cid:await rawCID(bytes),anchor};
  assert.equal((await verifyMarketsBlock(bytes,index)).markets.length,2);
  await assert.rejects(() => verifyMarketsBlock(bytes.slice(1),index), /CID/);
  await assert.rejects(() => verifyMarketsBlock(bytes,{...index,schema:INDEX}), /CID/);
  assert.equal(legacySnapshot(data).priceMicros,'100');
  assert.equal(legacySnapshot(data).volumeMicros,'10');
  const wrong = structuredClone(data);
  wrong.markets[1].pools[1].address = wrong.markets[1].pools[0].address;
  assert.throws(() => readMarketsSnapshot(wrong), /対象プール/);
  const corrupt = structuredClone(data);
  corrupt.markets[1].volumeMicros='41';
  assert.throws(() => readMarketsSnapshot(corrupt), /集計/);

  // Older v2 remains readable. Once the method is declared, both rows must
  // explicitly encode missing values and their asset-specific evidence gap.
  const withCirculation = {
    ...data, circulationMethod: CIRCULATION_METHOD,
    markets: data.markets.map((row, i) => ({ ...row, circulation: unavailableCirculation(MARKETS[i]) })),
  };
  const updated = new TextEncoder().encode(JSON.stringify(withCirculation));
  const verified = await verifyMarketsBlock(updated, { ...index, cid: await rawCID(updated) });
  assert.deepEqual(verified.markets.map((row) => row.circulation), [
    { supplyRaw: null, capMicros: null, reason: 'weth-backing-only' },
    { supplyRaw: null, capMicros: null, reason: 'wbtc-no-anchored-public-float' },
  ]);
  assert.throws(() => readMarketsSnapshot({ ...withCirculation, circulationMethod: 'unknown' }), /算定方法/);
  const withoutMethod = { ...withCirculation };
  delete withoutMethod.circulationMethod;
  assert.throws(() => readMarketsSnapshot(withoutMethod), /算定方法/);
  for (const bad of [
    undefined, { ...verified.markets[0].circulation, supplyRaw: verified.markets[0].supplyRaw },
    { ...verified.markets[0].circulation, capMicros: '0' }, verified.markets[1].circulation,
  ]) {
    const wrong = structuredClone(verified);
    wrong.markets[0].circulation = bad;
    assert.throws(() => readMarketsSnapshot(wrong), /根拠/);
  }
});

test('history and supply comparison expose their source containers', async () => {
  const html = await readFile(new URL('../src/guest.html', import.meta.url), 'utf8');
  assert.match(html, /<a id="history-pool"[^>]*>/);
  assert.match(html, /<tbody id="supply-rows">/);
  assert.match(html, /<div id="supply-reasons"[^>]*>/);
});
