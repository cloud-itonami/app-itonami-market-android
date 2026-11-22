// What the canonical consent dialog tells the user before each send (KOTOBA-159 finding 9). The
// runtime requires, per operation: the recipient's official legal name, its country, the data in
// words a user reads, the purpose, how often, and where permission is withdrawn; a recipient
// outside Japan also needs country-name and a foreign-info-url page with the 施行規則 17 条 2 項
// information. Nothing here is guessed: a service whose recipient is not confirmed stays `null`,
// and src/descriptor.mjs leaves its operations out of the descriptor (the broker has nothing to
// invoke, so nothing is sent).
//
// Legal review 2026-11-22 (AWAI-3828, draft wt/itonami/k159-rw/disclosures-draft.md): GitHub, Inc.
// for raw.githubusercontent.com. The yataverse.com operator is not confirmed yet (Itonami item 68).

export const WITHDRAWAL_PLACE = '設定 › 許可した送信';
// The foreign-information page is published in one place for every app (Decision 2026-11-22):
// network-awai/app-disclosures on GitHub Pages at disclosures.awai.network, as
// https://disclosures.awai.network/<app id>/foreign-info.html#<country section>. Its content for this
// app is a PR to that repository. The declaration must not reach production before that page answers
// 200 (scripts/check-disclosure-pages.mjs).
export const APP_ID = 'itonami-market-android';
export const DISCLOSURES_BASE = 'https://disclosures.awai.network/';
export const FOREIGN_INFO_URL = `${DISCLOSURES_BASE}${APP_ID}/foreign-info.html`;

const IP = '端末の IP アドレス';
const TIME = '送信の時刻';
const BROWSER = 'ブラウザの種類と版';
const common = { 'special-care': false, frequency: 'one-time', withdrawal: WITHDRAWAL_PLACE };

export const DISCLOSURES = Object.freeze({
  'github-raw': Object.freeze({
    ...common, recipient: 'GitHub, Inc.', country: 'US', 'country-name': 'アメリカ合衆国',
    'foreign-info-url': FOREIGN_INFO_URL + '#us',
    data: ['取得するファイルの名前（最新のスナップショットの番号の一覧）', IP, TIME, BROWSER],
    purpose: '公開されている最新の市場スナップショットの番号を GitHub から取得するため',
  }),
  yataverse: null,
});

// Why a service is still undecided. Shown in tests and the PR; not used by the runtime.
export const UNDECIDED = Object.freeze({
  yataverse: 'operator of the yataverse.com gateway (legal entity and country) not confirmed; the owner is confirming it (Itonami item 68)',
});
