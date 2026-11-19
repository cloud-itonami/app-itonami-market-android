import { POOL, WETH, POINTER, assert, quantity, readIndex, snapshotWindow, validateHistory, verifyBlock } from './protocol.mjs';

export const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
export const FACTORY = '0x1f98431c8ad98523631ae4a59f267346ea31f984';
export const MARKETS_INDEX = 'itonami.market-index.v2';
export const MARKETS_SNAPSHOT = 'itonami.onchain-market.v2';
export const MARKETS_POINTER = POINTER.replace('/latest.json', '/latest-v2.json');

const pool = (address, fee) => Object.freeze({ address, fee });
const market = (symbol, token, decimals, pools) => Object.freeze({
  symbol, token, decimals, quoteSide: USDC < token ? 0 : 1, pools: Object.freeze(pools),
});
export const MARKETS = Object.freeze([
  market('WETH', WETH, 18, [pool(POOL, 500), pool('0x8ad599c3a0ff1de082011efddc58f1908eb6e6d8', 3000)]),
  market('WBTC', '0x2260fac5e5542a773aa44fbcfedf7c193bc2c599', 8, [
    pool('0x9a772018fbd77fcd2d25657e5c547baff3fd7d16', 500),
    pool('0x99ac8ca7087fa4a2a1fb6357269965a2014abc35', 3000),
  ]),
]);

// All values use micro-USDC, so summing volumes and applying their exact
// proportion as the weight needs no floating point or implicit FX conversion.
export function aggregatePools(pools) {
  let priceByVolume = 0n;
  let volume = 0n;
  for (const item of pools) {
    assert(quantity(item?.priceMicros) && quantity(item.volumeMicros) && BigInt(item.priceMicros) > 0n,
      'プールの価格または出来高が無効です。');
    const weight = BigInt(item.volumeMicros);
    priceByVolume += BigInt(item.priceMicros) * weight;
    volume += weight;
  }
  assert(volume > 0n, '対象銘柄に24時間の出来高がありません。');
  return { priceMicros: (priceByVolume / volume).toString(), volumeMicros: volume.toString() };
}

export function readMarketsSnapshot(data) {
  assert(data?.schema === MARKETS_SNAPSHOT && data.chain === 1 && data.quote === USDC
    && data.license === 'CC0-1.0' && snapshotWindow(data)
    && Array.isArray(data.markets) && data.markets.length === MARKETS.length, '市場スナップショットの形式が正しくありません。');
  for (const [i, spec] of MARKETS.entries()) {
    const row = data.markets[i];
    assert(row?.token === spec.token && Array.isArray(row.pools) && row.pools.length === spec.pools.length
      && quantity(row.supplyRaw) && BigInt(row.supplyRaw) > 0n
      && row.historyPool === spec.pools[0].address, '銘柄または対象プールが一致しません。');
    for (const [j, item] of row.pools.entries()) {
      assert(item?.address === spec.pools[j].address && item.fee === spec.pools[j].fee, '対象プールが一致しません。');
    }
    const aggregate = aggregatePools(row.pools);
    assert(row.priceMicros === aggregate.priceMicros && row.volumeMicros === aggregate.volumeMicros,
      '価格または出来高の集計が一致しません。');
    validateHistory(row.history, data.anchor, row.pools[0].priceMicros);
  }
  return data;
}

export const readMarketsIndex = (data) => readIndex(data, MARKETS_INDEX);
export const verifyMarketsBlock = (bytes, index) => verifyBlock(bytes, index, MARKETS_INDEX, readMarketsSnapshot);
