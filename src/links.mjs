// The origins the app links to (KOTOBA-159 B4). A link is opened only by the user's own click and
// carries no user input or identifier: every URL below is built from fixed text or from values of
// the published, CID-verified snapshot (block numbers, contract addresses). test/links.test.mjs
// checks both. Until the canonical runtime has a host hand-off for links (KOTOBA-968), the sandboxed
// guest cannot open them and shows the address instead.
export const LINK_ORIGINS = Object.freeze(['https://etherscan.io', 'https://creativecommons.org', 'https://docs.wbtc.network']);
export const LINK_MAX_LENGTH = 200;

export const blockURL = (height) => 'https://etherscan.io/block/' + height;
export const addressURL = (address) => 'https://etherscan.io/address/' + address;

export function linkAllowed(href) {
  let url;
  try { url = new URL(href); } catch { return false; }
  return url.protocol === 'https:' && LINK_ORIGINS.includes(url.origin) && url.search === ''
    && url.username === '' && url.password === '' && href.length <= LINK_MAX_LENGTH;
}
