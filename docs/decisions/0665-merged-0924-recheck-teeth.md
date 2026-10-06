# ADR 0665: 09/24 にマージされた PR の確かめ直しで見つかった穴に歯を足す（Issue #1776）

- **状態**: 採用 (2026-10)
- **日付**: 2026-10-07

**これはクローン（miku）の判断で、オーナーの判断ではない**（[ADR 0220](./0220-issue-comment-author-does-not-distinguish-owner-from-agent.md)）。出所は Issue [#1776](https://github.com/takecchi/mnemora/issues/1776)。
出所の区別: 【現物】は読んだコード、【実測】は手元で走らせた結果、【受】は自分で測らずに受け取ったもの、【判断】は担い手の判定。
これは試験だけの変更で、実装・TSDoc・migration・CHANGELOG・公開の適合テスト（`*-conformance.ts`）は触らない（[ADR 0663](./0663-merged-0923-recheck-teeth.md) と同じ）。

## 経緯

2026-09-24（UTC）にマージされ、テスト以外の `src` に振る舞いの変更がある14本（#672・#673・#676・#679・#682・#684・#703・#680・#694・#678・#695・#698・#699・#700）に、足りない側とやりすぎた側の変異を当てた記録が #1776 の13本のコメントにある（#673 のコメントは本 ADR と同じ担い手が測った）。【受】#673 以外の測定は、別の担い手が main `ebce65ae` で行った。

すり抜けた変異のうち、**約束の内で、同値でないもの35本**に歯を足した。足した歯ごとに、元の変異を当てて赤になること、戻して緑になることを確かめた。

## 決定【判断】

1. **実装は変えない。**公開の適合テストにも足さない。歯は、各パッケージに固有のテストに置く。
2. 次の歯を足す。「赤」は、元のすり抜けの変異を `cp` で当てた状態で、足した歯が落ちたこと。戻して `cmp` が一致し、緑に戻ることも確かめた。

| PR（ADR） | すり抜けた変異 | 足した歯（置き場所） | 変異での赤 |
| --- | --- | --- | --- |
| #673（0284） | `search()` から `SET LOCAL` だけを外す（能力検査・transaction は残す） | 実際に発行される SQL を記録し、SELECT の前の同じトランザクションに `SET LOCAL hnsw.iterative_scan = relaxed_order` が1回だけあり、ほかの SET が無いことを見る（`packages/postgres` の新規 `vector-store-iterative-scan.postgres.test.ts`） | 赤（1） |
| #673 | `searchMany()` から `SET LOCAL` だけを外す | 同上（`searchMany` の SELECT で） | 赤（1） |
| #673 | `SET LOCAL` を SELECT の後ろへ動かす | 同上（順序を見る） | 赤（2） |
| #673 | `SET LOCAL` → `SET`（セッションへの漏れ） | 同上＋`max: 1` のプールで、呼び出しの後に同じ接続の `hnsw.iterative_scan` が `off` のままであること | 赤（3） |
| #673 | `hnsw.max_scan_tuples` も SET する | 同上（SET が1文だけであること） | 赤（2） |
| #673 | `getVectors()` までヘルパー経由にして SET を広げる | `getVectors`・`upsert`・`delete`・`deleteAcrossSpaces` がどの SET も発行しないこと | 赤（1） |
| #694（0299） | `event` の文脈を保存しない／`event` のスキーマから `extractionContext` を外す（zod が捨てる）／`document` も同じ2本 | 3種（`utterance`・`event`・`document`）すべてで、payload への保存・プロンプト JSON の `context`・`timeZone`・reextract の一致（`packages/core` の新規 `extraction-context-all-kinds-and-bounds.test.ts`） | 赤（各1。5本） |
| #694 | messages の上限を 8 → 7 | 8件ちょうどが通り9件が断られること。8件の文脈がプロンプトに欠けず入ること | 赤（2） |
| #694 | text の上限を 2000 → 1999 | 2000字ちょうどが通ること | 赤（2） |
| #694 | speaker の上限を 200 → 200000 | speaker 200字が通り201字が断られること | 赤（1） |
| #694 | プロンプトの文脈を黙って先頭4件に切る | 8件・各2000字の文脈が、プロンプトの `context` と完全に一致すること | 赤（1） |
| #678（#597 案(a)） | 宣言の `sha` が空文字でも採る（鍵を組み立てる）、`scripts/print-local-embedding-cache-key.mjs` | `{"sha": ""}` の宣言でフォールバック鍵と警告が出て exit 0（`scripts/__tests__/local-embedding-cache-key.test.mjs`）。**本 PR では足さない**：同じ検査が、先にマージされた #1789（ADR 0666、Issue #1784）で同じファイルに入ったため、そちらが受け持つ | 赤（1。main の #1789 の歯で確かめ直した） |
| #678 | `localEmbeddingPinnedRevision` が空の sha を通す | `{"sha": ""}` で投げること（`examples/chat/src/__tests__/providers.test.ts`） | 赤（1） |
| #695（0294） | 「総候補数 ≤ limit」を `<` にする | 行数 = limit で `boundaryGroup` が `undefined`・分断が `false`（`examples/chat/src/__tests__/lexical-tie-density-lib.test.ts`） | 赤（1） |
| #695 | 最大タイ集団を `max` でなく合計にする | 2・3・1行の3集団で、最大の列が `3` | 赤（1） |
| #695 | レポートの `n/a` の条件を `<` にする | 行数 = limit で `n/a（LIMIT未到達）` が出ること | 赤（1） |
| #698（0295） | 同伴の印の条件から `retrievedVia === "mandatory_companion"` を外す | `companionOf` を持つが `retrievedVia: "ann"` の行に印が出ないこと（`provenance-prompt-contract.test.ts`） | 赤（1） |
| #698 | `basisLost` が `false` でも `[根拠:失われた]` を出す | `basisLost: false` の行に出ないこと（`basis-lost-prompt-roundtrip.test.ts`） | 赤（1） |
| #699（0296） | 正規化せずに照合する／プロンプト側だけ正規化する／全 accept を要求する | 全角・大文字・句読点でしか一致しない入力（両向き）と、accept の片方だけが見つかる入力（`answer-content-preservation.test.ts`） | 赤（2・1・1） |
| #699 | 表示の1行の分母に `must-abstain` も含める | `must-abstain` 入りの結果で `2/2`・`1/2`（`answer-format.test.ts`） | 赤（1） |
| #699 | JSON の分母に `must-abstain` も含める／mnemora の集計に naive を入れる／`schemaVersion` を 3 → 2 | `must-abstain` 入りの結果の `buildAnswerJson`（`answer-json.test.ts`、新規。DB 不要） | 赤（各1） |
| #699 | `runAnswerCase` が mnemora の層2を naive の直列化文字列から計算する | 全 dev ケース＋「naive には残るが mnemora が渡さない」派生ケースで、各経路の値が自分の `promptSpec` の直列化からの値と一致する（`answer-bench.postgres.test.ts`）。逆向き（naive を mnemora から計算）も赤 | 赤（1。逆向きも1） |
| #700 | `applyRetentionMutation` が、対象が見つからなくても投げない | 対象を含まない `PromptSpec` で投げること（`answer-retention-mutation.test.ts`、新規。DB 不要） | 赤（1） |
| #700 | `messages` が空のとき投げずに素通しする | `messages: []` で投げること。成功時に `system`・`messages[1..]` が変わらないこと | 赤（1） |
| #672（0285） | `annWindowUnderfilled` から `candidateGenerationExecuted` を外す | 空クエリ（scope に ready の記憶が3件）で、ANN の trace が `executed: false` で、detail に `annReturnedFewerThanReachable` が無いこと（`packages/core` の `recall-pipeline.test.ts`） | 赤（1） |
| #684（0289）・#703（0298） | 永続化する記録の `returnedMemories` に `speaker`・`subjectId`／`recordedAt`・`occurredAt` を足す | `getRecall` の `returnedMemories.memories` のキーが `memoryId`・`score`・`retrievedVia`（と `companionOf`・`associationOf`）だけであること。ann と連想の枠の両方（`packages/core` の新規 `recall-record-returned-memories-keys.test.ts`） | 赤（各1。2本） |
| #679（0286） | 連想枠（段3.5）の `search()` の filter から `includeSubjectless` を外す | 連想枠の `search()` の filter に `includeSubjectless` が載ること。省略時は `undefined` のまま（`recall-subjectless-filter.test.ts`） | 赤（1） |

**数え方**: 塞いだのは35本（#673 の6・#694 の7・#678 の2・#695 の3・#698 の2・#699 の8・#700 の2・#672 の2・#684 と #703 の各1・#679 の1。#672 の2本は同じ1点で、同じ歯が受け持つ）。歯の確認では、これに足して2本（#694 の `document` のスキーマ、#699 の逆向き）を当て、合わせて37本を当てた。【実測】すべて、足した歯に変異を当てて赤、戻して緑を確かめた。

## 歯にしなかったもの【判断】

- **#673 の変異14**（`buildFilterConditions` から `e.tenant_id` の2条件を外す）: **約束の外**。#673 ではなく、#1050・ADR 0362・0374（テナント境界）の約束で、統計がある枝の WHERE が対象。#673 のコメントに記録済み。`search-ctx-tenant-boundary.postgres.test.ts` を ANALYZE 済みでも走らせる案は、別 PR の主題として残す。
- **#676 の2本**（`Math.max(0, …)` を外す・`reachableLowerBound > 0` を外す）: **同値**。互いに守り合っており、出力が変わらない。
- **#672 の「`kPrime > 0` も外す」変異**: `kPrime` は 1 以上に丸められるので同値。「`candidateGenerationExecuted` だけを外す」変異で歯を作り、2本とも同じ歯が受け持つ。【判断】両方を外した版は走らせていない。

## 確かめていないこと

- #673 の #671 の再現（10万行・他テナントの near-duplicate で0件になること）。歯は、発行される SQL と接続の状態を見る形にした（**`SET LOCAL` が効いているかそのものは、DB の挙動では見ていない**）。小さい表で再現できるかは測っていない。
- #678 の Hugging Face への実接続・#699 の実 API・#700 の記録側（`record answer`）。
- 各歯の「戻して緑」は、足したテストファイルと、その近傍の既存ファイル（`examples/chat`・`packages/core`・`packages/postgres` の名指しのもの）で確かめた。ルートの全テストは走らせていない。
- CI は走らせていない（Draft PR で出す）。
