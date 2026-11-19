# 営 市場情報

[公開 Web](https://network-awai.github.io/app-itonami-market-android/) と Tauri v3 Android が同じ静的 UI を使う。発行されている最新 CID と観測ブロックを GitHub の公開 feed から取得し、Yataverse から取得した Awai FS 互換の raw ブロックをブラウザ内で SHA-256 検証する。2つの取得は正本 Kotoba broker による個別同意を必要とする。配布元は静的アセットのみを提供する。

## データ

Ethereum mainnet の [Uniswap v3 factory](https://docs.uniswap.org/contracts/v3/reference/deployments/ethereum-deployments) が返す WETH/USDC と WBTC/USDC を対象とする。銘柄ごとに手数料 0.05% と 0.30% の2プールを集計する。発行時に factory のアドレス、プールのトークン順、各トークンの小数桁を確定ブロックで照合する。

| 銘柄 | 手数料0.05% | 手数料0.30% |
|---|---|---|
| WETH | [0x88e6…5640](https://etherscan.io/address/0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640) | [0x8ad5…e6d8](https://etherscan.io/address/0x8ad599c3a0ff1de082011efddc58f1908eb6e6d8) |
| WBTC | [0x9a77…7d16](https://etherscan.io/address/0x9a772018fbd77fcd2d25657e5c547baff3fd7d16) | [0x99ac…bc35](https://etherscan.io/address/0x99ac8ca7087fa4a2a1fb6357269965a2014abc35) |

- **共通の観測と集計窓**。両銘柄を同じ確定ブロックで観測する。24時間の開始は観測時刻の86,400秒前。最初にその時刻を満たすブロックから観測ブロックまでを両端を含めて集計する。
- **プール価格**。観測ブロックの [slot0 の sqrtPriceX96](https://blog.uniswap.org/uniswap-v3-math-primer) をトークン順に沿って USDC 建てに換算する。
- **24h 出来高**。各 Swap の USDC 側の絶対値を合計する。ブロックハッシュと log index でイベントの重複を検査し、銘柄ごとに対象プールの値を足す。
- **銘柄価格**。各対象プールの観測時点価格をそのプールの24h USDC 出来高で加重する。ゼロ出来高のプールは重みゼロ。銘柄の合計がゼロ、検証不一致、取得失敗の場合は既存の公開 CID を維持する。内部値は USDC の最小単位で整数計算し、加重平均を切り捨てる。
- **価格履歴**。全銘柄で同じ30ブロックを観測し、銘柄ごとに手数料0.05%の参照プール価格を表示する。
- **流通供給量**。対象は Ethereum メインネットで公開市場に流通する数量。集計価格と同じ確定ブロックで、公開・再配布可能なデータから確認する。WETH9 の `totalSupply()` は契約の ETH 残高を返す。WBTC の Ethereum 契約は発行残高を返し、公式のチェーン別供給情報は同じ確定ブロックの流通内訳を提供しない。契約の報告値は別欄に参考表示する。
- **時価総額**。集計価格（USDC）× 検証済み流通供給量。根拠が不足する場合は両方を欠損とする。v2 の `circulationMethod` と銘柄別の `circulation` は現在の算定方法、欠損値（`supplyRaw: null` と `capMicros: null`）、銘柄別理由を CID 検証の対象として記録する。旧 v2 に算定結果が未収録の場合も、表示は欠損となる。
- **出典と公開条件**。共通観測ブロック、24h 窓の先頭ブロック、対象プールと手数料、履歴ブロックの出典を明示する。オンチェーン数値から独立に計算した集計を [CC0-1.0](https://creativecommons.org/publicdomain/zero/1.0/) で提供する。集計対象は記載の4プール。出典時刻と USDC 建てを画面に表示する。

## 確認

Node 22+。正本 runtime は commit と SHA-256 で固定してビルドする。

```sh
npm ci
npm run build
npm test
npm run android
```

Android のビルドには Rust の aarch64-linux-android、JDK 21、Android SDK/NDK が要る。ネイティブ層に独自の IPC コマンドや HTTP プラグインはない。Android の WebView オリジンは既存の Yataverse 読み取り許可に含まれる。Web は同じ静的成果物を GitHub Pages へ配布する。

## 発行運用

`node scripts/publish.mjs --dry-run` で Ethereum archive RPC の観測、集計、CID 算出を行う。既定の RPC は dRPC 公開 Ethereum archive API。運用者は `MARKET_ETHEREUM_RPC` で管理下の Ethereum archive node を指定できる。

本番 `node scripts/publish.mjs` は既存の Yataverse CLI の絶対パスを `MARKET_YATAVERSE_CLI` で指定する。GitHub `feed` ブランチと Yataverse の既存書き込み認可を持つ運用環境でのみ実行する。ファイルと署名済み保存レシートは `MARKET_ARCHIVE_DIR` に CID 別で保存する。公開ゲートウェイでバイト列が一致してから v2 の `feed/latest-v2.json` と旧クライアント向け v1 の `feed/latest.json` を個別に更新する。v1 は観測を共有し、従来どおり WETH/USDC 0.05% プールの値を返す。各 index は GitHub Contents API の SHA を使い、先行する発行があれば上書きしない。更新に失敗した index は直前の検証済み CID を保持する。

macOS の発行ホストは同じ環境変数を指定して `node scripts/install-launchagent.mjs` を実行する。LaunchAgent は登録時およびローカル時刻の 00:10 / 06:10 / 12:10 / 18:10 に起動する。ホストまたはログインセッション停止中は更新が遅れ、観測から9時間経過したデータにはアプリが注意を表示する。日次履歴は約1日間隔のサンプリングで、UTC の日足終値ではない。
