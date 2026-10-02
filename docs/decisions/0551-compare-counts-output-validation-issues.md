# ADR 0551: `compare` の出力に、出力検査（`outputValidation`）の違反件数を集計する（問32 の (C)。ADR 0481 負債#1 の測定側の半分だけを閉じる）

- **状態**: 提案（Draft。オーナーの判断待ち。問32 の推奨 (C) をオーナーの判断が出る前に先に用意したもの）
- **日付**: 2026-10-03

クローンの委譲先（担い手。マネージャー mgr-021b84d7 の指示による）が書いた。**オーナーの判断ではない**（[ADR 0220](./0220-issue-comment-author-does-not-distinguish-owner-from-agent.md)）。オーナーへの問32「`examples/chat` に出力検査を付けるか（0481）」の選択肢 (A) なし (B) `"throw"` (C) 違反件数を測定出力に集計、のうち、推奨だった (C) をそのとおりに実装した Draft である。オーナーが (A) か (B) を選んだら、この ADR と PR は捨てるか作り直す。
出所の区別: 【現物】は読んだコード・文書、【実測】は手元で走らせた結果、【判断】は担い手の判定。

## 文脈【現物】

- `RecallResult.outputValidation` は `{ ok, issues: [{ path, code, message }] }`（`packages/core/src/recall.ts`）。mode が `"off"` なら `undefined`。既定は `"report"`（`recall-output-validation.ts`）。
- `examples/chat` は `outputValidation` を一度も渡さず、既定の `"report"` で動いている（`runtime-factory.ts`）。違反があっても結果に載るだけで、`compare` の `ComparisonRow` へ写す時に捨てられていた（`mnemora-path.ts` の recall の結果を `compare.ts` が行に写す所）。
- [ADR 0481](./0481-recall-output-validation-postgres-fields.md) の負債#1:「`examples/chat` の runtime は出力の自動検査を通っていない」（緊急度 低、覆る条件「測定スクリプトでも出力を検査すると決めたとき」）。代替案1「`examples/chat` の測定スクリプトにも付ける」は、「測定の出力が変わりうる」ので材料に回していた。

## 決定

1. **範囲は `compare` だけ**。`answer-bench.ts`・`time-weighting-bench.ts`・`retrieval` などのほかの bench は触らない（下の「残り」）。
2. **欄**:
   - `CompareRowJson`（と `ComparisonRow`）に省略可能な `outputValidationIssueCount` を足す。値は `recall.outputValidation.issues.length`（`ok: true` なら 0）。
   - `outputValidation` が `undefined`（`"off"`・未検証）の行は**欄そのものを出さない**。0（検査して違反なし）と区別するため。
   - 標準出力の表は、「冒頭の事実の出典に到達したか」を載せている `formatRecallQualityTable` の末尾に「出力検査の違反件数」列を1つ足す。未検証は `—`、検査して違反なしは `0`。量だけの表（`formatComparisonTable`）には足していない【判断】。既存の列の位置は変えていない（末尾に足した）。
   - `schemaVersion` は据え置き（`bandEntryCount` の先例と同じ。既存の欄の意味を変えない追加）。
3. **throw にはしない**。runtime の `outputValidation` の mode は変えず、既定の `"report"` のまま数えるだけ。
4. **門（`GATE_FIELDS`）・`DIFF_FIELDS`・基準値（`examples/chat/compare-baseline.json`）には入れない**。`scripts/compare-summary-lib.mjs` は知らない欄を無視するので、このスクリプトは変えていない。Job Summary にも出していない。
5. **`RecallResult` から件数を導く純関数** `outputValidationFieldsFromRecall`（`examples/chat/src/compare.ts`）を、`footprintFieldsFromRecall` に倣って切り出した。DB 不要で検査できる。

## ADR 0481 との関係（閉じる範囲）

- **閉じるのは、測定の側の半分だけ**。違反を数えるのは CLI の `compare` である。
- **閉じていないもの**: `examples/chat/vitest.config.mts` の `setupFiles` に `setup-recall-output-contract` を足す話（vitest が走らせる recall の出力を毎回検査し、違反で落とす系統）。これは別の系統で、この ADR では何も変えていない。0481 の負債#1 は、この意味では**開いたまま**である。
- 古い ADR（0481 を含む）は書き換えていない。

## 比較の連続性【実測】

- 既存の欄・`DIFF_FIELDS`・門・基準値は変わらない。`compare-baseline.json` は触っていない。
- 新しい欄は、古い実測 JSON（CI の artifact を含む）には無い。無い行は「未検証」ではなく「この欄が導入される前」の意味にもなりうる点に注意（読み手は欄の有無だけで検査の有無を断定しないこと）。
- 記録の再生（`MNEMORA_PROVIDER_SOURCE=recorded`、手元の PostgreSQL 17 + pgvector）での実測: **全12行で `outputValidationIssueCount` は 0**。`schemaVersion` は 1。`node scripts/compare-summary.mjs --measured <その JSON> --baseline examples/chat/compare-baseline.json` は **exit 0**（門が見ない欄も12会話長すべてで基準値と一致）。0 でなかった行は無いので、違反の中身は無い。
- ⚠ この 0 は「記録の再生で、既定の `"report"` のまま、12会話長の recall が自分のスキーマを満たした」ことだけを言う。実 API・ほかの bench・ほかの query については何も言わない。

## 変異試験【実測】

足したテスト `examples/chat/src/__tests__/compare-output-validation-fields.test.ts`（5本）を、実装を壊して走らせた。

| # | 壊し方 | 結果 |
|---|---|---|
| M1 | 純関数が常に 0 件を返す | 赤（`ok:false` の件数） |
| M2 | `undefined` を 0 にして欄を出す | 赤（未検証なら欄なし） |
| M3 | `ok:false` を常に 1 件と数える | 赤（`ok:false` の件数） |
| M4 | `buildCompareJson` が欄を落とす | 赤（JSON の形） |
| M5 | `buildCompareJson` が未検証を 0 にして書く | 赤（JSON の形） |
| M6 | 表が未検証を `0` と表示する | 赤（表の列） |

元に戻した後は 5 本とも緑。

## 残り

- **ほかの bench**（`answer-bench.ts`・`time-weighting-bench.ts`・`retrieval` など）は数えていない。
- **門と基準値に入れるか**。入れていない。入れるなら、基準値の更新手順（2回以上の run の一致）と偽陽性の天井（[ADR 0254](./0254-no-gate-without-a-false-positive-ceiling.md)）の話になる。実測は全行 0 の1回だけで、門にする根拠はまだ無い。
- **setup 系の検査**（`setupFiles` に `setup-recall-output-contract`）。上のとおり別の系統で、閉じていない。

## 検討した代替案

- (A) 付けない: 負債#1 は低緊急として残る。測定の出力は変わらない。
- (B) `"throw"`: 違反で測定が落ちる。runtime の mode を変えるので、既定の変更に近く、オーナーの領分。採っていない。

## これが覆るとしたら

オーナーが (A) か (B) を選んだとき。`RecallOutputValidation` の形が変わったとき（`issues` が無くなる、など）。

## 測っていないこと

実 API の鍵が要る測定（走らせていない）。違反が実際に出たときの `compare` の表示（`ok:false` の実物は作れていない。純関数とテストは手で組んだ `RecallResult` で縛った）。
