import { GATEWAY } from './protocol.mjs';
import { MARKETS_POINTER } from './markets.mjs';

const indexURL = new URL(MARKETS_POINTER);
function get(capability, service, operation, origin, route, categories) {
  return { capability, service, operation, endpoint: { origin, routes: [{ method: 'GET', ...route }] },
    'data-categories': categories, consent: 'each-operation' };
}

export const latest = get('market/index', 'github-raw', 'read-latest-market-cid', indexURL.origin,
  { path: indexURL.pathname, 'query-params': [] }, ['public-market-feed-id', 'network-address']);
export const snapshot = get('market/block', 'yataverse', 'read-market-block', GATEWAY,
  { 'path-prefix': '/ipfs/', 'query-params': ['format'], 'query-values': { format: 'raw' } },
  ['public-snapshot-cid', 'network-address']);

export const descriptor = {
  schema: 'kotoba.app.client-runtime.v1', target: 'browser', profile: 'trusted-page-v1',
  entry: 'index.html', 'local-state': { adapter: 'memory', schema: 'itonami.onchain-market.v2', version: 1 },
  workers: [], operations: [latest, snapshot],
};
export const capabilities = descriptor.operations.map(({ capability }) => capability);
