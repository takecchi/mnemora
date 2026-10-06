# ADR 0663: 09/23 にマージされた PR の確かめ直しで見つかった穴に歯を足す（Issue #1778）

- **状態**: 採用 (2026-10)
- **日付**: 2026-10-06

**これはクローン（miku）の判断で、オーナーの判断ではない**（[ADR 0220](./0220-issue-comment-author-does-not-distinguish-owner-from-agent.md)）。出所は Issue [#1778](https://github.com/takecchi/mnemora/issues/1778)（分母はその本文、PR ごとの結果はそのコメント）。
出所の区別: 【現物】は読んだコード、【実測】は手元で走らせた結果、【受】は自分で測らずに受け取ったもの、【判断】は担い手の判定。
これは試験だけの変更で、実装・TSDoc・migration・CHANGELOG・公開の適合テスト（`*-conformance.ts`）は触らない（[ADR 0660](./0660-merged-1002-1004-recheck-teeth.md) などの試験だけの PR と同じ）。

## 経緯

2026-09-23（UTC）にマージされ、テスト以外の `src` に振る舞いの変更がある5本（#573・#603・#612・#642・#664）に、足りない側とやりすぎた側の変異を当てた。変異は `cp` で控えを取ってから当て、`cp` で戻して `cmp` で確かめた。

- #612・#642・#664 は、担い手が main `8c2b450c` で測った。
- #573・#603 は、担い手の作業者が同じ main で測った。担い手は、その2つの穴の変異（G6・AN13）を自分でも当て直して赤を確かめた。

#642・#664 は穴なしだった。

## 決定【判断】

1. **実装は変えない。**公開の適合テストにも足さない。歯は、パッケージに固有のテストに置く。
2. 次の歯を足す。

| PR・ADR | 穴（すり抜けた変異） | 足した歯 | 変異での赤 |
| --- | --- | --- | --- |
| #612（[ADR 0271](./0271-extraction-candidate-subject-id-overrides-observation.md)） | `ExtractedMemoryCandidateSchema.subjectId` の `min(1)` を外す（空文字を受ける）。PR は `Memory.subjectId` と同じ規約と書いたが、core 全体が素通り | `core/.../extracted-candidate-subject-id-nonempty.test.ts`（スキーマの段だけ） | 1本 |
| #573（[ADR 0258](./0258-restore-superseded-operation-scope.md)） | `groupSupersededCandidatesByOperation` の "unknown" 側を、reason の値ごとでなく1つにまとめる（鍵を `boundaryConfidence` にする）。以前の歯は、1入力に1種類の reason でしか試していなかった | `core/.../superseded-operation-grouping-unknown-keys.test.ts` | 1本 |
| #603（[ADR 0266](./0266-llm-provider-conformance.md)） | anthropic の `assertNotRefusedOrTruncated` が、正常に書き終わった `stop_reason: "stop_sequence"` まで途中で切れたとして断る。適合 suite の足場は `end_turn` しか使わず、anthropic の全テストも素通り | `anthropic/.../benign-stop-reasons.test.ts`（`end_turn`・`stop_sequence`・`null` で、`complete`・`completeStructured` が本文を返す） | 2本 |

## 歯にしなかったもの

- **#603 の AN11**（構造化出力を検証したうえで `{}` を返す）: ADR 0266 の負債7として既知。公開の適合 suite の歯2は緑のままだが、リポ内の歯が赤になる【受】。
- **#573 の、`onlyMemoryIds` に複数の id を渡す場面**: 公開の適合テストと core の歯には無く、「先頭1件だけ使う」変異がそこでは緑だった。だが、後から入った `restore-superseded-malformed-only-ids.postgres.test.ts` が、実行・dryRun の両方で塞いでいる【受】。公開の適合テストには足さない（決定1）。

## 確かめていないこと

- #573・#603 の変異の多くは作業者の実測であり、担い手が当て直したのは G6・AN13 の2つだけである。
- #603 の suite そのものへの変異（`*-conformance.ts` に触れない決まりのため）、`RecordedLLMProvider`、実 SDK・実 API、openai の `stop` 以外の正常な `finish_reason`（`tool_calls` など）。
- #612 で、LLM が空文字の `subjectId` を返した応答が、端から端までどう扱われるか（一覧・opt-in の有無で道が分かれる）。
