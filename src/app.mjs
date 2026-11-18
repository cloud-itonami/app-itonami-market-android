import { createClientConsentHost, createClientOperationBroker } from './kotoba-client-runtime.js';
import { capabilities, descriptor, latest, snapshot } from './descriptor.mjs';
import { GATEWAY, POINTER, readIndex, parseJSON, verifyBlock, boundedResponse, assert } from './protocol.mjs';

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
let current;

async function get(operation, input, maxBytes) {
  const response = await broker.invoke(operation, { input }, { signal: AbortSignal.timeout(120_000) });
  return boundedResponse(response, maxBytes);
}
function draw() {
  if (!current) return;
  const points = current.history;
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
function render(data, index) {
  current = data;
  ui.time.textContent = '観測 ' + t(data.anchor.time);
  ui.price.textContent = usdc(data.priceMicros);
  ui.supply.textContent = number.format(scaled(data.supplyWei, 1e18)) + ' WETH';
  ui.cap.textContent = usdc(data.capMicros);
  ui.volume.textContent = usdc(data.volumeMicros);
  ui.cid.textContent = 'CID 検証済み · ' + index.cid;
  ui.block.href = blockURL(data.anchor.block);
  ui.window.href = blockURL(data.windowStart.block);
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
  ui.snapshot.hidden = false;
  draw();
}

ui.load.addEventListener('click', async () => {
  if (ui.load.disabled) return;
  ui.load.disabled = true;
  try {
    const index = readIndex(parseJSON(await get(latest, POINTER, 8192)));
    if (current) {
      assert(current.anchor.block <= index.anchor.block && current.anchor.time <= index.anchor.time,
        '表示中より古い観測が返されました。');
      assert(current.anchor.block !== index.anchor.block || current.anchor.hash === index.anchor.hash,
        '表示中の確定ブロックと異なるハッシュが返されました。');
    }
    const bytes = await get(snapshot, `${GATEWAY}/ipfs/${index.cid}?format=raw`);
    const data = await verifyBlock(bytes, index);
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
