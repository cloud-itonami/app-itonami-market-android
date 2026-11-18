# 営 市場情報

[公開 Web](https://network-awai.github.io/app-itonami-market-android/) と Tauri v3 Android が同じ静的 UI を使う。発行されている最新 CID と観測ブロックを GitHub の公開 feed から取得し、Yataverse から取得した Awai FS 互換の raw ブロックをブラウザ内で SHA-256 検証する。2つの取得は正本 Kotoba broker による個別同意を必要とする。配布元は静的アセットのみを提供する。

## データ

初期対象は Ethereum mainnet の [Uniswap v3 WETH/USDC プール](https://etherscan.io/address/0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640) 1 件。USDC 建て。価格は確定ブロックの [slot0 の sqrtPriceX96](https://blog.uniswap.org/uniswap-v3-math-primer) から計算し、価格履歴は約1日間隔の30ブロックを採取する。24h 出来高は対象プールの Swap で動いた USDC の絶対値の和。供給は [WETH9](https://github.com/gnosis/canonical-weth/blob/master/contracts/WETH9.sol) の totalSupply()（コントラクトの ETH 残高）。時価総額の参考値はその供給量とプール価格の積。値は世界の暗号資産市場全体を代表しない。オンチェーン数値から独立に計算した集計を [CC0-1.0](https://creativecommons.org/publicdomain/zero/1.0/) で提供する。第三者の価格データベースは使わない。

snapshot には chain、コントラクト、観測ブロックと hash・UTC timestamp、出来高区間の先頭ブロック、履歴ブロックと集計値を記録する。公開 index は発行者が管理する可変ポインタ。CID は受信したバイトの同一性を検証する。RPC の観測値と発行者の鮮度には出典と時刻を添える。

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

本番 `node scripts/publish.mjs` は既存の Yataverse CLI の絶対パスを `MARKET_YATAVERSE_CLI` で指定する。GitHub `feed` ブランチと Yataverse の既存書き込み認可を持つ運用環境でのみ実行する。ファイルと署名済み保存レシートは `MARKET_ARCHIVE_DIR` に CID 別で保存する。公開ゲートウェイでバイト列が一致してから `feed/latest.json` を更新する。先行する発行があれば上書きしない。更新に失敗した場合は、直前の検証済み CID が公開され続ける。

macOS の発行ホストは同じ環境変数を指定して `node scripts/install-launchagent.mjs` を実行する。LaunchAgent は登録時およびローカル時刻の 00:10 / 06:10 / 12:10 / 18:10 に起動する。ホストまたはログインセッション停止中は更新が遅れ、観測から9時間経過したデータにはアプリが注意を表示する。日次履歴は約1日間隔のサンプリングで、UTC の日足終値ではない。
