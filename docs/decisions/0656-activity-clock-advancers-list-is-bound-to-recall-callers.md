# ADR 0656: 活動時計を進める入口の一覧は、`recall(` の呼び出し元の集合に縛る（ADR 0394 決定3 の「掃引」の誤記の訂正）

- **状態**: 採用 (2026-10)
- **日付**: 2026-10-06

> **⚠ この判断はクローン（依頼主）の指示を担い手が実装したものであり、⛔ オーナー本人の判定ではない**（[ADR 0220](./0220-issue-comment-author-does-not-distinguish-owner-from-agent.md)）。
> 活動時計を進める入口の扱い自体は、オーナーへのまとめ問い 374f6f88 の問14で**未決**であり、**本 ADR は触っていない**。

## 文脈

- 【現物】[ADR 0394](./0394-activity-clock-writes-use-memorys-own-subject.md) 決定3 と `runtime.ts` の 🔴 負債コメントは、活動時計を進める保守の操作に「掃引（`sweepArchive`）」を挙げていた。
- 【現物】`sweepArchive` は `memoryStore.archiveDecayed` を呼ぶだけで `recall()` を呼ばない。活動時計は読むだけである。進めるのは `runRecall`（`advanceActivityClock`）を通る呼び出しで、`runtime.ts` では公開の `recall`・`findCorrectionCandidates`・`consolidate`・`reflect`。
- 手で書いた一覧は、コードが変わると黙ってずれる。

## 決定

1. ADR 0394 に訂正の追記を足す（本文は書き換えない）。
2. 一覧の正本を `runtime.ts` の `resolveActivityClockBase` の TSDoc の `- ADVANCER: 名前` の行にする。
3. `packages/core/src/__tests__/activity-clock-advancers-doc.test.ts` が、コメントを除いた `runtime.ts` から `recall(`/`runRecall(` の呼び出しを囲む関数名の集合を実行時に求め、TSDoc の集合と**集合として一致**することを確かめる。件数も名前も検査側に持たない（空振りしない健全性だけ見る）。`sweepArchive` のように呼び出しの無い関数は、集合に入らないので、一覧に載れば赤になる。
4. **挙動は1バイトも変えない。**内部 `recall` で時計を進めないようにする修正はしない。

## 引き受けた負債

- 囲む関数の検出は、`runtime.ts` の行頭 0〜2 字下げの `function` 宣言を字句で拾う簡易なものである。入れ子の関数や別名・変数経由の呼び出し（`const r = recall; r(...)`）は拾えない。
- コメントの除去も字句で、文字列リテラル内の `/* ` を誤って消す可能性がある。

## 試験

変異（`sweepArchive` を一覧に足す／`reflect` を一覧から消す）でどちらも赤になることを確認した。詳細は PR 本文。
