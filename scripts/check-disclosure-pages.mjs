// Gate before deployment (Decision 2026-11-22): a declaration must not reach production before the
// pages it names answer 200. Checks every declared operation's disclosure['foreign-info-url'] (the
// page, without its #section). Exits non-zero, listing the pages, when one is not reachable.
import { descriptor } from '../src/descriptor.mjs';

const pages = [...new Set(descriptor.operations
  .map((op) => op.disclosure?.['foreign-info-url'])
  .filter(Boolean)
  .map((url) => { const u = new URL(url); u.hash = ''; return u.href; }))];
const failures = [];
for (const page of pages) {
  try {
    const response = await fetch(page, { redirect: 'error', signal: AbortSignal.timeout(20_000) });
    if (response.status !== 200) failures.push(`${page}: HTTP ${response.status}`);
  } catch (error) { failures.push(`${page}: ${error.message}`); }
}
if (failures.length) {
  console.error('Disclosure pages are not published yet; do not deploy the declaration:\n' + failures.join('\n'));
  process.exitCode = 1;
} else console.log(`Disclosure pages answer 200: ${pages.join(', ') || '(none declared)'}`);
