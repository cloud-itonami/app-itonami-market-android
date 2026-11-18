export const POOL = '0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640';
export const WETH = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2';
export const SWAP_TOPIC = '0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67';
export const SNAPSHOT = 'itonami.onchain-market.v1';
export const INDEX = 'itonami.market-index.v1';
export const RAW_CID = /^bafkrei[a-h][a-z2-7]{50}[aeimquy4]$/;
export const POINTER = 'https://raw.githubusercontent.com/network-awai/app-itonami-market-android/refs/heads/feed/latest.json';
export const GATEWAY = 'https://yataverse.com';
export const MAX_BYTES = 128 * 1024;

export function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const quantity = (value) => typeof value === 'string' && /^(0|[1-9][0-9]{0,35})$/.test(value);
const hash = (value) => typeof value === 'string' && /^0x[0-9a-f]{64}$/.test(value);
const unix = (value) => Number.isSafeInteger(value) && value > 1_600_000_000 && value < 4_102_444_800;
function anchor(point) {
  return point && Number.isSafeInteger(point.block) && point.block > 0 && hash(point.hash) && unix(point.time);
}

export function readIndex(index) {
  assert(index?.schema === INDEX && typeof index.cid === 'string' && RAW_CID.test(index.cid)
    && anchor(index.anchor), '最新 CID の形式が正しくありません。');
  assert(index.anchor.time <= Math.floor(Date.now() / 1000) + 120, '最新 CID の観測時刻が未来です。');
  return index;
}

export function readSnapshot(data) {
  assert(data?.schema === SNAPSHOT && data.chain === 1 && data.pool === POOL
    && data.token === WETH && data.license === 'CC0-1.0' && anchor(data.anchor)
    && anchor(data.windowStart) && data.windowStart.block < data.anchor.block
    && data.windowStart.time >= data.anchor.time - 86400 && data.windowStart.time <= data.anchor.time - 86300
    && [data.priceMicros, data.supplyWei, data.capMicros, data.volumeMicros].every(quantity)
    && BigInt(data.priceMicros) > 0n && BigInt(data.supplyWei) > 0n,
  '市場スナップショットの形式が正しくありません。');
  assert(BigInt(data.capMicros) === BigInt(data.supplyWei) * BigInt(data.priceMicros) / 10n ** 18n,
    '時価総額の計算が一致しません。');
  assert(Array.isArray(data.history) && data.history.length === 30, '価格履歴は30観測点が必要です。');
  let previous = { block: 0, time: 0 };
  for (const point of data.history) {
    assert(anchor(point) && quantity(point.priceMicros) && BigInt(point.priceMicros) > 0n
      && point.block > previous.block && point.time > previous.time && point.block <= data.anchor.block
      && point.time <= data.anchor.time, '履歴の順序または値が正しくありません。');
    previous = point;
  }
  assert(previous.block === data.anchor.block && previous.time === data.anchor.time
    && previous.hash === data.anchor.hash && previous.priceMicros === data.priceMicros, '価格履歴の末尾が観測ブロックと一致しません。');
  return data;
}

export async function rawCID(bytes) {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  const alphabet = 'abcdefghijklmnopqrstuvwxyz234567';
  let bits = 0;
  let buffer = 0;
  let out = 'b';
  for (const byte of [1, 0x55, 0x12, 32, ...digest]) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += alphabet[(buffer >>> bits) & 31];
    }
  }
  if (bits) out += alphabet[(buffer << (5 - bits)) & 31];
  return out;
}

export function parseJSON(bytes) {
  assert(bytes.byteLength <= MAX_BYTES, '応答サイズが上限を超えています。');
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
}

export async function verifyBlock(bytes, candidate) {
  const index = readIndex(candidate);
  assert(bytes.byteLength <= MAX_BYTES && await rawCID(bytes) === index.cid, '受信データが指定 CID と一致しません。');
  const data = readSnapshot(parseJSON(bytes));
  assert(['block', 'hash', 'time'].every((field) => data.anchor[field] === index.anchor[field]),
    '最新 CID の観測情報とスナップショットが一致しません。');
  return data;
}

export async function boundedResponse(response, maxBytes = MAX_BYTES) {
  assert(response.ok && response.body, `取得できませんでした (HTTP ${response.status})。`);
  const reader = response.body.getReader();
  const parts = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw new Error('応答サイズが上限を超えています。');
      }
      parts.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const result = new Uint8Array(size);
  let offset = 0;
  for (const bytes of parts) {
    result.set(bytes, offset);
    offset += bytes.length;
  }
  return result;
}
