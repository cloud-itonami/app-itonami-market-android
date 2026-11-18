import { test } from 'node:test';
import assert from 'node:assert/strict';
import { INDEX, SNAPSHOT, POOL, WETH, rawCID, verifyBlock, readSnapshot } from '../src/protocol.mjs';
import { priceMicros, swapUSDC } from '../scripts/ethereum.mjs';

const word = (x) => BigInt.asUintN(256, x).toString(16).padStart(64, '0');
test('inverts raw WETH/USDC price and normalizes token decimals', () => {
  assert.equal(priceMicros('0x' + word(1n << 96n)), '1000000000000000000');
});
test('counts either direction once using the USDC leg', () => {
  for (const value of [25n, -25n]) assert.equal(swapUSDC('0x' + word(value) + '0'.repeat(256)), 25n);
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
