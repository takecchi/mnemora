# ADR 0657: `ObserveResult.rejectedSubjectIds` の件数・順・重複を歯で縛る（Issue #1746）

- **状態**: 採用 (2026-10)
- **日付**: 2026-10-06

**これはクローン（miku）の判断で、オーナーの判断ではない**（[ADR 0220](./0220-issue-comment-author-does-not-distinguish-owner-from-agent.md)）。出所は Issue [#1746](https://github.com/takecchi/mnemora/issues/1746)（PR #1737 の確かめ直しで見つかった生き残り）。
出所の区別: 【現物】は読んだコード、【実測】は手元で走らせた結果、【判断】は担い手の判定。
これは試験だけの変更で、実装・TSDoc・migration・CHANGELOG は触らない（[ADR 0621](./0621-merged-0930-1465-recheck-teeth.md) などの試験だけの PR と同じ）。

## 経緯

`ObserveResult.rejectedSubjectIds` の TSDoc は「弾いた順、`ExtractCandidatesResult.rejectedSubjectIds` の写し」と書いている【現物】。
値は2段で作られる【現物】。
- `extraction.ts` の `sanitizeExtractionCandidates` が、`sanitizeCandidateSubjectId` が `rejected: true` を返した候補ごとに1件ずつ `push` する。
- `runtime.ts` の `runExtraction` が、それを `rawRejectedSubjectIds ?? []` で写す。

既存の歯は、どれも弾く値が1件の形でしか照合していなかった（`runtime.test.ts` の subjectCandidates の節、`extraction.test.ts`、`llm-subject-id-dropped-by-default.test.ts`）。
そのため、`runtime.ts` の写しで重複を除く変異（E）と、先頭1件に切る変異（F）は、`packages/core` の全テストと `packages/postgres` の関係する3本を素通りした【実測。Issue #1746】。

## 決定【判断】

1. **実装は変えない。**
2. **今の振る舞い（弾いた候補ごとに1件、弾いた順、同じ値の重複もそのまま）を歯で縛る。**
   TSDoc の「写し」と、`extraction.ts` が候補ごとに `push` している現物に合わせた。
   重複を除く実装にすると、「LLM が何件の候補で一覧外の値を返したか」という監査の情報（この欄の目的。TSDoc の「黙って戻さない」）が減るので、除く側には倒さない。
   ⚠ 重複を残すことは、これまで文書にも歯にも明記されていなかった。今回、担い手がそれを仕様として固定した。覆すなら、この歯と一緒に変えること。
3. 歯は `packages/core/src/__tests__/rejected-subject-ids-order-and-count.test.ts`（新規）に置く。`observe()` を一覧付きで呼び、`rejectedSubjectIds` を `toEqual` で照合する。2つの形で当てる。
   - (a) 一覧内・一覧外・`null`・文字列 `"null"`・指定なしが混ざった7候補では、`["user:y", "user:x", "user:y"]` になる。
   - (b) 全候補が同じ一覧外の値なら、候補の数だけ並ぶ。

## 実測（2026-10-06、main `f682b21f`）

足した歯は、main で緑だった。下の変異を当てると赤になり、`cp` で戻して `cmp` で一致させたあと、`packages/core` の全テストが緑に戻った（3848 passed + expected fail 100）。

| 変異 | 場所 | 足した歯 | 既存の歯 |
| --- | --- | --- | --- |
| E: 写しで重複を除く（`[...new Set(...)]`） | `runtime.ts` `runExtraction` | (a)(b) 赤 | 素通り（Issue #1746） |
| F: 写しを先頭1件に切る（`.slice(0, 1)`） | `runtime.ts` `runExtraction` | (a)(b) 赤 | 素通り（Issue #1746） |
| E′: `push` の時点で重複を除く | `extraction.ts` `sanitizeExtractionCandidates` | (a)(b) 赤 | 素通り（`packages/core` の全テスト。※） |
| X（やりすぎ）: 文字列 `"null"` を主題なしへ読み替えた候補まで、弾いた扱いで載せる | `extraction.ts` `sanitizeExtractionCandidates` | (a) 赤 | `runtime.test.ts` の ADR 0304 の1本も赤 |

※ E′ の全体実行では、ほかに2本が 5 秒台の時間切れで落ちた（`recall-relation-max-count`・暦日の全域の歯）。戻したあとの全体実行では緑だったので、負荷による時間切れと見ている。

## 確かめていないこと

- `packages/postgres` の adapter で、この歯と同じ形を走らせてはいない。値は core の中で作られ、adapter を通らない【現物】。
- 冪等な再送（`rejectedSubjectIds: []` を返す経路、ADR 0454）は、この歯の対象外。既存の歯が縛っている。
