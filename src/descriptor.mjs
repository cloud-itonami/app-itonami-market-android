import { GATEWAY } from './protocol.mjs';
import { MARKETS_POINTER } from './markets.mjs';
import { DISCLOSURES } from './disclosures.mjs';

const indexURL = new URL(MARKETS_POINTER);
function get(capability, service, operation, origin, route, categories) {
  return { capability, service, operation, endpoint: { origin, routes: [{ method: 'GET', ...route }] },
    'data-categories': categories, consent: 'each-operation' };
}

// The operations this app would use. Only those whose service has a confirmed disclosure are
// declared (src/disclosures.mjs); the others stay out of the descriptor and are refused.
export const candidates = Object.freeze({
  latest: get('market/index', 'github-raw', 'read-latest-market-cid', indexURL.origin,
    { path: indexURL.pathname, 'query-params': [] }, ['public-market-feed-id', 'network-address']),
  snapshot: get('market/block', 'yataverse', 'read-market-block', GATEWAY,
    { 'path-prefix': '/ipfs/', 'query-params': ['format'], 'query-values': { format: 'raw' } },
    ['public-snapshot-cid', 'network-address']),
});

export function declared(disclosures = DISCLOSURES) {
  return Object.fromEntries(Object.entries(candidates).map(([name, op]) =>
    [name, disclosures[op.service] ? { ...op, disclosure: disclosures[op.service] } : null]));
}

export function buildDescriptor(disclosures = DISCLOSURES) {
  return {
    schema: 'kotoba.app.client-runtime.v1', target: 'browser', profile: 'restricted-wasm-v1',
    entry: 'index.html', 'local-state': { adapter: 'memory', schema: 'itonami.onchain-market.v2', version: 1 },
    workers: [], operations: Object.values(declared(disclosures)).filter(Boolean),
  };
}

export const descriptor = buildDescriptor();
export const capabilities = descriptor.operations.map(({ capability }) => capability);
export const undecidedServices = (disclosures = DISCLOSURES) =>
  [...new Set(Object.values(candidates).map(({ service }) => service))].filter((service) => !disclosures[service]);
