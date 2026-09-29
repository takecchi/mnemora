# ADR 0387: README の「CommonJS からは require(esm) で読める」を、registry に出ない切り出し版で毎 PR の CI に入れる

- **状態**: 採用 (2026-09)
- **日付**: 2026-09-30

> **⚠ 本文はクローン miku の委譲先が書いた。オーナー本人の執筆ではない。**

---

## 問い

README.md（`packages/core`・`packages/postgres` ほかの「前提」）は
「**Node.js >= 22 と ESM が要る（CommonJS からは Node 22.12 以降の `require(esm)` で読める）**」
と約束している。この約束を確かめる歯は既に在る——`scripts/check-consumer-install.mjs` の
6段目（`smoke.cjs`）。だが同スクリプトは [ADR 0346](./0346-check-consumer-install-tool-and-release-gate.md)
が既定の CI に入れないと決めたものであり、`.github/workflows/ci.yml` からは呼ばれていない
（同スクリプト冒頭のコメント、リリース前に人が打つ）。⟹ **この約束は、今のところ「壊れたら
リリース前に気づく」だけで、「壊れたら PR の時点で気づく」形になっていない。**

毎 PR で確かめる形にできないか。

## 前提を自分の手で確認した

- **ADR 0346 が既定の CI に入れない理由は2つ**（同 ADR「測ったこと」）: (1) npm registry から
  依存を取り直す（キャッシュが空なら約 550MB、大半は onnxruntime-node）、(2) ロックファイル無しで
  依存の範囲を解決するため、上流の新しい版で PR と無関係に赤になりうる（実測: 同 ADR の日、
  `zod` 4.6.5 対ロックの 4.5.4、`vitest` 5.0.2 対 5.0.0 で既にずれていた）。**どちらも「registry へ
  新しく取りに行くこと」が原因である。**
- **6段目（`smoke.cjs`）だけを見るなら、registry に出る理由は無い。**確かめたいのは
  「tarball の `exports` の `require`/`default` 条件を経由した `require` が通るか」だけであり、
  依存の実体は**この作業ツリーが `pnpm install --frozen-lockfile`（CI のこのジョブの手前の
  ステップ）で既に解決済みのもの**をそのまま使えば足りる。【実測、この器、2026-09-30】
  `packages/{core,openai,anthropic,postgres,local-embedding,bullmq}` の各 `dependencies`
  （`zod`・`openai`・`@anthropic-ai/sdk`・`drizzle-orm`・`pg`・`@huggingface/transformers`・
  `bullmq`・`ioredis`）と、`packages/testkit` の `peerDependencies`（`vitest`。`@mnemora/testkit`
  の入口 `index.js` が `memory-store-conformance.js` 等を re-export し、それらが top-level で
  `vitest` を import するため実行時に要る）は、いずれも `node:module` の `createRequire` で
  対象パッケージ自身のディレクトリから解決でき、実体は `node_modules/.pnpm/<name>@<version>/…`
  に単一の版で存在した（バージョンが割れている——同じ名前が2つの実体に解決する——ケースは
  無かった）。
- **`pnpm add --offline` は使えない。**【実測】`pnpm add --offline zod@4.5.4`（この作業ツリーの
  ロックが指す版そのもの、`node_modules/.pnpm/zod@4.5.4/` に実体が既に在る状態）ですら
  `ERR_PNPM_NO_OFFLINE_META`（`Failed to resolve zod@4.5.4 in package mirror
  ".../metadata/…/zod.jsonl"`）で落ちた。`pnpm install --frozen-lockfile` は
  ロックファイルの版へ直接（メタデータの解決を経ずに）実体を持ってくるが、`pnpm add`／
  ロック無しの `pnpm install` は範囲解決のための registry メタデータを別途要求し、
  それは「フローズンロックファイルで入れた」だけでは手元に揃わない。⟹ **pnpm/npm の
  install コマンドを経由する限り、オフラインでも「メタデータ」という形で registry への
  依存が残る。**
- ⟹ **install コマンドを使わず、自分で node_modules を組み立てる。**tarball は
  `node_modules/<パッケージ名>` へ自分で展開し（`npm install` を使わない）、tarball の
  外部依存（`@mnemora/*` 以外）は、対象パッケージ自身の視点から `createRequire(...).resolve(name)`
  で見つけた実体のルートディレクトリへ symlink する。Node の module 解決は symlink を realpath
  まで辿ってから続きを解決するため、symlink 先（pnpm の `.pnpm/<name>@<version>/node_modules/<name>`）
  がその依存自身のさらに先の依存も同じ pnpm の仕組みで既に持っているぶん、**1段の symlink だけで
  再帰的な解決が成立する**（実測: `@huggingface/transformers` のようなネストした依存を持つ
  パッケージでも、1段の symlink で `require` が通った）。

## 決めたこと

1. **`scripts/check-cjs-require-smoke.mjs`（`pnpm run check:cjs-require-smoke`）を新設する。**
   `scripts/pack-publish-targets.mjs` で tarball を作り→ 自分で `node_modules/<name>` へ展開 →
   外部の実行時依存をこの作業ツリーの解決済みの実体へ symlink → `./check-consumer-install-lib.mjs`
   の `buildSmokeCjs(EXPECTED_ENTRY_POINTS)` で作った `smoke.cjs` を node で実行する。
   **npm/pnpm の install コマンドを一切呼ばない**——registry に一切出ない。
2. **既存の `EXPECTED_ENTRY_POINTS`・`buildSmokeCjs`（`scripts/check-consumer-install-lib.mjs`）を
   再利用する。**見るものを増やさない・重複させない——README の約束の定義は1箇所のままにする。
3. **純関数の部分（依存名の抽出・node 版の判定）は `scripts/check-cjs-require-smoke-lib.mjs` に
   分ける**（`scripts/check-consumer-install-lib.mjs` と本体の分割と同じ形——本体側は import
   された瞬間に pack・展開・symlink・node 実行まで始めるトップレベルの処理を持つため、歯から
   直接 import すると実際に tarball を作り始めてしまう）。歯は
   `scripts/__tests__/check-cjs-require-smoke.test.mjs`。
4. **`.github/workflows/ci.yml` に、`cjs-require-smoke` ジョブを新設する。**`required` にはしない
   （`.github/required-status-checks.json` は変更しない）——`bullmq` ジョブと同じ形
   （branch protection の設定変更はオーナー領分、本 PR の範囲外）。node は `"22"`
   （`actions/setup-node@v6` は 2026-09-30 時点で常に 22.12 より新しい最新パッチを解決する
   ため、README が要求する最低版を満たす）。スクリプト自身も `process.version` を見て
   22.12 未満なら実行前に赤で止まる（二重の安全弁。将来この器の既定 Node 22 系が万一
   22.12 を割る事態への備え）。
5. **`scripts/check-consumer-install.mjs`（ADR 0346）の6段目は変更しない・削除しない。**
   同スクリプトのコメントを更新し、「6段目と同じ約束は、registry に出ない別の道具が
   毎 PR の CI で見ている」ことを明記する。**残りの5段（型・ESM 経路・入口一覧の突き合わせ・
   依存の宣言漏れ検出・registry とのずれ）は、引き続きこの道具だけが見る**——リリース前に
   人が打つ運用は変えない。

## 測ったこと

【実測、この器、2026-09-30、`pnpm run check:cjs-require-smoke` を素の clone で複数回】

| 段 | 所要 |
|---|---|
| pack（`pnpm pack` × 7 対象。各 `prepack` が `tsc` で自分の dist を作り直す） | 約 31〜41 秒 |
| tarball の展開（`tar`、npm install を使わない） | 0.1 秒 |
| 外部依存の symlink | 0.0 秒 |
| `smoke.cjs` の実行（`require(esm)`） | 1.2〜1.4 秒 |
| **合計** | **約 34〜42 秒** |

- **時間の大半（9割以上）は pack 段——各対象の `prepack`（`tsc -p tsconfig.build.json`）が
  かかる。**これは `pack:check`（既定の CI の `build` ジョブに既に在る）と同じ費用であり、
  この段だけの追加費用ではない。
- **`.github/workflows/ci.yml` の既存ジョブは `timeout-minutes: 15`（測定ジョブ群）〜既定 360 分
  （未設定のジョブ）であり、Postgres/Redis のサービスコンテナを立てて実データベースへ対して
  テストする `postgres`・`bullmq` ジョブ、実 API のカセットを再生する `example-chat`・測定系の
  各ジョブは、いずれもこの新ジョブの数十秒よりずっと長い。**新ジョブは独立した並列ジョブであり、
  既存の最長の脚（`postgres`・`retrieval-quality` 等、`timeout-minutes: 15` を持つ測定ジョブ群）
  を延ばさない。
- **`pnpm add --offline` が registry メタデータ不足で落ちること**は上の「前提を自分の手で
  確認した」に実測を書いた。

### 陽性対照（変異試験。別 worktree `/tmp/mgr-edb8390a-mut` で実施、元のファイルへは1バイトも commit していない）

【実測、2026-09-30、`git worktree add -b ci/cjs-require-esm-smoke-default-ci-mut` で作った別ツリー】
変異前に `node scripts/check-cjs-require-smoke.mjs` が緑（exit 0）であることを確認した上で、
`packages/core/package.json` の `exports` の `"."` から `default` 条件を落とし、`import` 条件だけに
した（`node_modules` の再構築は不要——`check-cjs-require-smoke.mjs` は毎回 `pnpm pack` で tarball を
作り直すため、ソースの `package.json` の変更がそのまま tarball に反映される）。結果（標準出力・
標準エラーの逐語、exit 1）:

```
✔ pack（scripts/pack-publish-targets.mjs）（35.3 秒）
✔ tarball を consumer の node_modules へ自分で展開する（npm install を使わない）（0.1 秒）
✔ 外部の実行時依存を、この作業ツリーが既に解決済みの実体へ symlink する（registry に出ない）（0.0 秒）
✖ CommonJS で全入口を require（require(esm)、README の約束そのもの）（1.3 秒）
@mnemora/core: ERR_PACKAGE_PATH_NOT_EXPORTED: No "exports" main defined in
/tmp/mnemora-cjs-smoke-consumer-ITMexj/node_modules/@mnemora/core/package.json

✖ CommonJS require(esm) の確認に失敗した（入口 8 個、合計 36.7 秒）。
```

要点: `require`/`default` 条件が無いと、`require()` は `"."` の入口に一致する条件を見つけられず
`ERR_PACKAGE_PATH_NOT_EXPORTED` で失敗する——これがこの検査の見ている約束そのものである。
その後 `cp` で元の `package.json` へ戻し、同じコマンドが再び緑（exit 0）に戻ることも確認した
（`git status --porcelain` が空であることも確認済み）。変異は commit していない。worktree・
一時ブランチは使用後に削除した（`git worktree remove` / `git branch -D`）。

## 採らなかった案

- **`scripts/check-consumer-install.mjs`（1〜6段すべて）をそのまま既定の CI に入れる。**
  ADR 0346 が測った理由（registry から約550MB・ロックファイル無しで上流とずれる）が
  変わっていない——毎 PR で走らせると、PR の変更と無関係な赤が出うる
  （`AGENTS.md`「偽陽性率に上限を置けない検査は門にしない」）。
- **`overrides` で依存を repo のロックの版に固定した上で、丸ごと既定の CI に入れる。**
  ADR 0346 が「これが覆るとしたら」に残した案。registry への依存（キャッシュが空なら
  約550MB の取得）は残るため、この PR の狙い（軽く・速く・揺れなく）には合わない。
  6段目だけを切り出す本 ADR の案のほうが、費用を実質ゼロにできた。
- **`pnpm add`/`npm install` に `--offline` を付けて既存の install ベースの構成のまま使う。**
  上の実測（`ERR_PNPM_NO_OFFLINE_META`）で不成立と分かった。

## 引き受けた負債

- **依存の宣言漏れ（`package.json` に書き忘れた実行時依存）はこの新しい段では見逃しうる。**
  このスクリプトは各パッケージの実行時依存を「この作業ツリーで今どう解決されているか」から
  そのまま symlink するので、たとえ書き忘れていても、モノレポ内の別の場所でその依存が
  解決できれば見逃す。`scripts/check-consumer-install.mjs` の `--install-strategy=nested`
  （ADR 0346 決定3）が防ぐ形は、この新しい段では防げない——引き続き `check:consumer-install`
  （リリース前）の持ち場である。
- **型・ESM 経路・入口一覧の突き合わせ・registry とのずれは見ない。**入口一覧の突き合わせだけは
  既に `scripts/__tests__/check-consumer-install-lib.test.mjs` が registry 不要で既定の CI
  （`pnpm run test`）に持っている。残りはリリース前の `check:consumer-install` の持ち場のまま。
- **`required` にしていない**ため、この新ジョブが赤くても GitHub の Merge ボタンは単独では
  止まらない（`bullmq` ジョブと同じ形。branch protection の変更はオーナー領分）。

## これが覆るとしたら

- pnpm/npm がオフラインでの範囲解決（メタデータ無しの `install`/`add`）をサポートするようになり、
  「install コマンドを避けて自分で node_modules を組み立てる」という設計の複雑さに見合う理由が
  無くなったとき——素直に `pnpm install --offline` 相当へ戻すことを検討する。
- 依存の宣言漏れをこの段でも捕まえたいという要求が具体的に出たとき——
  `--install-strategy=nested` 相当の隔離（例: 対象パッケージごとに専用のディレクトリへ
  symlink し、他パッケージの依存が見えないようにする）を足すかどうかを検討する。
