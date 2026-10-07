# ADR 0685: 09/28 にマージされた E 群（#1339・#1382）の確かめ直しで見つかった穴に歯を足す（Issue #1827）

- **状態**: 採用 (2026-10)
- **日付**: 2026-10-07

**これはクローン（miku）の判断で、オーナーの判断ではない**（[ADR 0220](./0220-issue-comment-author-does-not-distinguish-owner-from-agent.md)）。出所は Issue [#1827](https://github.com/takecchi/mnemora/issues/1827)。
これは試験だけの変更で、実装（`src` の非テストのファイル・scripts の道具・`package.json`）は触らない。

## 経緯【実測】

E 群は scripts の門・出荷の道具を変えた2本である。#1339 は `check:consumer-install` に CommonJS の `require` の段（`buildSmokeCjs`）を足した。#1382 は `@mnemora/bullmq` を npm 公開の対象にする準備（`PUBLISH_TARGETS`・`NEVER_PUBLISHED_TARGETS`・`EXACT_PINNED_DEPENDENCY_EXEMPTIONS`・`EXPECTED_ENTRY_POINTS`・`package.json`）をした。
約束は PR 本文・差分・ADR 0351 から列挙し、足りない側とやりすぎた側の変異を両方当てた。後の変更で約束が動いた点は、いまの約束に当てた。

- ADR 0441 は `buildSmokeCjs` に値の名前の検査を足した（広がっただけ）。いまの約束に当てた。
- #1454 で `@mnemora/bullmq` は `NEVER_PUBLISHED_TARGETS` から外れ、一覧は空になった（仕組みだけを残す）。「bullmq が一覧に載る」約束は当てず、「一覧に載った名前は version 検査と版揃いの数から外れる」仕組みの約束を当てた。
- 「未公開のものは `PUBLISH_TARGETS` の末尾」は、bullmq が公開済みになって根拠が消えたので当てなかった。

## 決定【判断】

1. 足すのは、すり抜けた変異のうち約束の内にあるものを塞ぐ歯だけで、新しい試験ファイル3本に置く。
   - `scripts/__tests__/check-consumer-install-smoke-cjs-behavior.test.mjs`（`smoke.cjs` を実行して、require の失敗・全入口・`node_modules` の外への解決・export が1つの入口を見る。`check-consumer-install.mjs` が CommonJS の段の失敗を捨てない配線を、ソースの文字列で見る）。
   - `scripts/__tests__/check-publish-pack-never-published-mechanism.test.mjs`（合成した repo へ門を写し、一覧の中身を変えて、version 検査と版揃いの数から外れることを見る）。
   - `scripts/__tests__/bullmq-publish-dependency-pin.test.mjs`（bullmq は完全固定のまま、免除は bullmq だけ）。
2. 塞がないもの：等価な変異（`Object.keys(mod).length === 0` の検査は値の名前の検査と重なる、`continue` の有無など）。約束の外（bullmq を末尾以外に置く）。
3. 歯は、元の変異で赤になることを確かめてから入れた。

## 確かめていないこと

- `check:consumer-install` の実際の install は走らせていない（歯は合成した package と子プロセスで見る）。
- 道具の誤りは見つけていない。
