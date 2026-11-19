import { createClientConsentHost, createClientOperationBroker } from './kotoba-client-runtime.js';
import { capabilities, descriptor, latest, snapshot } from './descriptor.mjs';
import { GATEWAY, parseJSON, boundedResponse, assert } from './protocol.mjs';
import { MARKETS, MARKETS_POINTER, readMarketsIndex, verifyMarketsBlock } from './markets.mjs';

const ui = Object.fromEntries([...document.querySelectorAll('[id]')].map((node) => [node.id, node]));
const broker = createClientOperationBroker({
  runtime: descriptor,
  requestedCapabilities: capabilities,
  hostSupportedOperations: descriptor.operations.map(({ capability, service, operation }) => [capability, service, operation]),
  approvedOperations: descriptor.operations,
  consentHost: createClientConsentHost(),
});
const number = new Intl.NumberFormat('ja-JP', { maximumFractionDigits: 2 });
const utc = new Intl.DateTimeFormat('ja-JP', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' });
const t = (sec) => utc.format(sec * 1000) + ' UTC';
const scaled = (value, scale) => Number(value) / scale;
const usdc = (value) => number.format(scaled(value, 1e6)) + ' USDC';
const blockURL = (height) => 'https://etherscan.io/block/' + height;
const addressURL = (address) => 'https://etherscan.io/address/' + address;
const selectedMarket = () => current.markets[Number(ui.asset.value)];
let current;

async function get(operation, input, maxBytes) {
  const response = await broker.invoke(operation, { input }, { signal: AbortSignal.timeout(120_000) });
  return boundedResponse(response, maxBytes);
}
function draw() {
  if (!current) return;
  const points = selectedMarket().history;
  const { width, height } = ui.chart.getBoundingClientRect();
  if (width < 100) return;
  const ratio = Math.min(devicePixelRatio || 1, 3);
  ui.chart.width = Math.round(width * ratio);
  ui.chart.height = Math.round(height * ratio);
  const ctx = ui.chart.getContext('2d');
  if (!ctx) return;
  ctx.scale(ratio, ratio);
  const values = points.map((point) => scaled(point.priceMicros, 1e6));
  const low = Math.min(...values);
  const range = Math.max(...values) - low;
  const start = points[0].time;
  const span = points.at(-1).time - start;
  for (const fraction of [.1, .5, .9]) {
    ctx.strokeStyle = '#d3e0e4';
    ctx.beginPath();
    ctx.moveTo(8, height * fraction);
    ctx.lineTo(width - 8, height * fraction);
    ctx.stroke();
  }
  ctx.beginPath();
  ctx.strokeStyle = '#006250';
  ctx.lineWidth = 2.5;
  points.forEach((point, i) => {
    const x = 8 + (width - 16) * (point.time - start) / span;
    const y = height * (.9 - .8 * (range ? (values[i] - low) / range : .5));
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.stroke();
}
function makeRow(label, price, volume, href) {
  const row = document.createElement('tr');
  const header = document.createElement('th');
  header.scope = 'row';
  if (href) {
    const link = document.createElement('a');
    link.href = href;
    link.rel = 'noreferrer';
    link.textContent = label;
    header.append(link);
  } else {
    header.textContent = label;
  }
  const value = document.createElement('td');
  value.textContent = usdc(price);
  const turnover = document.createElement('td');
  turnover.textContent = usdc(volume);
  row.append(header, value, turnover);
  return row;
}

function renderHistory() {
  if (!current) return;
  const data = selectedMarket();
  const spec = MARKETS[Number(ui.asset.value)];
  const units = 10n ** BigInt(spec.decimals);
  const capMicros = BigInt(data.supplyRaw) * BigInt(data.priceMicros) / units;
  ui.supply.textContent = number.format(scaled(data.supplyRaw, Number(units))) + ' ' + spec.symbol;
  ui.cap.textContent = usdc(capMicros);
  ui['history-pool'].href = addressURL(data.historyPool);
  ui['supply-source'].href = addressURL(data.token);
  ui.rows.replaceChildren(...data.history.slice().reverse().map((point) => {
    const row = document.createElement('tr');
    const date = document.createElement('th');
    date.scope = 'row';
    date.textContent = t(point.time);
    const price = document.createElement('td');
    price.textContent = usdc(point.priceMicros);
    const source = document.createElement('td');
    const link = document.createElement('a');
    link.href = blockURL(point.block);
    link.rel = 'noreferrer';
    link.textContent = String(point.block);
    source.append(link);
    row.append(date, price, source);
    return row;
  }));
  draw();
}
function render(data, index) {
  current = data;
  ui.time.textContent = '観測 ' + t(data.anchor.time);
  ui.interval.textContent = '24h 集計窓 ' + t(data.anchor.time - 86400) + ' から ' + t(data.anchor.time);
  ui.cid.textContent = 'CID 検証済み · ' + index.cid;
  ui.block.href = blockURL(data.anchor.block);
  ui.window.href = blockURL(data.windowStart.block);
  ui['market-rows'].replaceChildren(...data.markets.map((asset, i) =>
    makeRow(MARKETS[i].symbol, asset.priceMicros, asset.volumeMicros)));
  ui['pool-rows'].replaceChildren(...data.markets.flatMap((asset, i) => asset.pools.map((pool) =>
    makeRow(MARKETS[i].symbol + ' ' + (pool.fee / 10000).toFixed(2) + '%',
      pool.priceMicros, pool.volumeMicros, addressURL(pool.address)))));
  ui.snapshot.hidden = false;
  renderHistory();
}
ui.asset.addEventListener('change', renderHistory);

ui.load.addEventListener('click', async () => {
  if (ui.load.disabled) return;
  ui.load.disabled = true;
  try {
    const index = readMarketsIndex(parseJSON(await get(latest, MARKETS_POINTER, 8192)));
    if (current) {
      assert(current.anchor.block <= index.anchor.block && current.anchor.time <= index.anchor.time,
        '表示中より古い観測が返されました。');
      assert(current.anchor.block !== index.anchor.block || current.anchor.hash === index.anchor.hash,
        '表示中の確定ブロックと異なるハッシュが返されました。');
    }
    const bytes = await get(snapshot, `${GATEWAY}/ipfs/${index.cid}?format=raw`);
    const data = await verifyMarketsBlock(bytes, index);
    render(data, index);
    ui.status.textContent = Date.now() / 1000 - data.anchor.time > 9 * 3600
      ? 'CID は一致しました。観測から9時間以上経過しています。' : '最新の公開スナップショットを表示しています。';
  } catch (error) {
    const message = error.message === 'client operation was not approved'
      ? '取得を取り消しました。' : '取得に失敗しました。 ' + error.message;
    ui.status.textContent = current ? message + ' 前回の検証済みデータを表示しています。' : message;
  } finally {
    ui.load.disabled = false;
  }
});
new ResizeObserver(draw).observe(ui.chart);
ui.load.disabled = false;
ui.status.textContent = '最新 CID の取得と Yataverse の読み取りを順に確認します。';
