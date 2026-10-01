# ADR 0481: 穴探し52巡目 — 実 Postgres のテストが一度も渡していない `RecallQuery` の欄を、`outputValidation: "throw"` で当てる（ずれは見つからなかった）

- **状態**: 採用 (2026-10)
- **日付**: 2026-10-02

クローン miku の委譲先（担い手。マネージャー mgr-0d3098f9 の指示による）が書いた。直す線（約束に実装を戻す・落ちる入力を減らす・文書の直し・前例のある同種の穴は直す。オーナーの領分の6つ〔前例の無い新しい断り・既定値の変更・公開 API を足す・suite に約束を足す・遡ってのデータの書き換え・適用済みの migration の編集〕は材料に回す）は依頼主が決めた。オーナーの判断ではない（[ADR 0220](./0220-issue-comment-author-does-not-distinguish-owner-from-agent.md)）。
出所の区別: 【現物】は読んだコード・文書、【実測】は手元で走らせた結果、【判断】は担い手の判定、【未確認】は確かめていないこと。

- **文脈**: 52巡目は、ADR 0434 以降の穴探しで当てていない公開の面を選ぶところから始めた。公開の名前（`scripts/__snapshots__/public-api/{core,postgres}.d.ts`）ごとに、ADR 0430〜0480 に出る行数と、テストに出るファイル数を数え、`outputValidation`（`RecallOutputValidationMode`・`validateRecallOutput`）が 0 行だった。避けた面: 50巡目（テナント設定、ADR 0479）、47巡目（labels の deadlock、ADR 0476）、0480（`RecallRecord`・`getRecall`）。

## 選んだ理由（初稿の前提を訂正した）

- **初稿の前提（誤り）**: 「`outputValidation` を名指すテストは core の 4 ファイルだけで、実 Postgres に当てた歯は無い」と書いた。grep で `packages/postgres` に `outputValidation` が 0 件だったためだが、**見落としだった**。
- **現物**【実測。grep と読み】: `packages/postgres` の vitest は、**全テスト**で `setup-recall-output-contract.ts`（`vitest.config.mts:67`）を読み込み、`createRuntime` が返す `Runtime` の `recall()` の戻り値を `checkRecallResultContract`（`packages/core/src/__tests__/runtime-fakes.ts:4007`。`RecallResultSchema` を通ること、`outputValidation.ok` が真であること、TSDoc の約束〔`nearMisses` の個数と降順、`ann_truncated.safetyRatio`、`filtered.scopeRelation` など〕）に通している。つまり **「実 Postgres の recall が自分のスキーマを満たす」自動検査は既にある**。
- **残る隙間**: その検査が走るのは、**テストが `RecallQuery` のその欄を渡したときだけ**である。実 Postgres のテストが各欄を渡しているファイル数を数えると【実測。`grep -rlw` で `packages/postgres/src/__tests__` を数えた】:

  | `RecallQuery` の欄 | 実 Postgres のテストのファイル数 | core のテスト |
  |---|---|---|
  | `digestBandLimit` | **0** | 6 |
  | `timeWeighting` | **0** | 3 |
  | `relationMaxCount` | **0** | 3 |
  | `taxonomyGroups` | 1 | 2 |
  | `activityCounting` | 2 | 2 |
  | `overFetchFactor` | 2 | 15 |
  | （参考）`includeFullyDecayed` / `includeOutsideValidity` / `includeSubjectless` / `excludeProvenanceKinds` / `scoreThreshold` | 5 / 4 / 6 / 7 / 4 | — |

  `digestBandLimit` は目次帯の SQL の `LIMIT` に効く経路なので、実 Postgres で一度も走っていないのは SQL の挙動差が入りうる場所である。gh は `outputValidation` が closed の issue 4・PR 10、`RecallOutputValidation` が closed の issue 1、open は 0（既出の中身は mode の導入、Issue #131・ADR 0098）。

## 決定（線の内側＝歯だけ。実装は変えていない）

- 歯 `packages/postgres/src/__tests__/recall-output-validation.postgres.test.ts`: 実 Postgres + fake の LLM・埋め込みで、`outputValidation: "throw"` の runtime（違反があれば `RecallOutputValidationError` で落ちる）に、次の 17 形の `RecallQuery` を当て、戻り値の `outputValidation` が `{ ok: true, issues: [] }` であることを見る（記憶 6 件、subject あり、`occurredAt`・`validFrom`/`validUntil`・`tags` を混ぜた）:
  - `digestBandLimit`: 1／3／100000（帯の上限を超える大きい値）
  - `timeWeighting`: `eventAwareFreshness`／`legacy`
  - `relationMaxCount: 1`、`activityCounting`: `subject`／`tenant`
  - `association`（`maxCount: 3`）／`association: null`
  - `budget`（`maxMemoryChars` で切り詰める）、`scopeAggregate: "skip"`
  - `validAt` が全記憶の有効期間の外／`includeOutsideValidity: true`
  - `labels` + `taxonomyGroups`、`overFetchFactor: 0.5`（k' が limit を下回る）、`tags`（クエリ側の重複を含む。ADR 0474）
  - 陽性対照: 既定の query は `ok` で記憶が返る。
- **実測の結果**【実測。手元の PostgreSQL 17（`initdb`、UTF8 + C.UTF-8）+ pgvector、node v22.23.3】: 18 本（陽性対照 1 + 17 形）すべて緑。**`outputValidation.ok` が偽になる形は見つからなかった**。
- **歯が赤くなることの陽性対照**【実測。変異】: `recall-runtime.ts` の `draft` の `usage` を `{ ...usage, chars: "x" }` に壊すと、18 本すべてが `RecallOutputValidationError: … usage.chars: Invalid input: expected number, received string` で赤になった（`cp` で退避して戻し、戻した後は 18 本緑）。core 側の `recall-output-validation.test.ts`（`ok: false` と `"throw"` を縛る既存の歯）と `recall-pipeline.test.ts` も緑（124 本）。

## 探した形の一覧

- 当てた形: 上の 17 形。うち、実 Postgres のテストが渡していなかった欄は `digestBandLimit`・`timeWeighting`・`relationMaxCount`・`activityCounting`（`subject`）。
- 当てていない形（今回の範囲外）: `channels: ["ann","lexical"]`・`PostgresTrigramLexicalStore`（実 Postgres のテストが既にある。`recall-channels` 系）、`taxonomyGroups` の strict モード・labels の登録状態の組み合わせ（47巡目 taxonomy の面）、テナント設定が絡む `decayClock` の組み合わせ（50巡目の面）、`recall` と `getRecall` の戻り値の比較（ADR 0480 の面）、実 OpenAI／local 埋め込みでの出力（`outputValidation` は provider に依らない形なので、`vector` の値の違いだけ）。
- 見送った候補: `createOptionalTrigramIndex[Concurrently]` の失敗経路（INVALID な索引の掃除まで TSDoc にあり、テスト 3 ファイルが見ている。ADR 0460・0464 の隣）、`listActiveClaimPredicates?`（テスト 14 ファイルが厚く、ADR 0473 の隣）、`InlineScheduler`（3 行の class）、`getObservation` の payload 往復（uuid の大文字小文字は今日の面、jsonb 往復は ADR 0472 の隣）。

## 検討した代替案

1. **`outputValidation` の自動検査を、`examples/chat` の測定スクリプトにも付ける。** 採らなかった。`examples/chat` は `createRuntime` を直接使う CLI で、テストの setup の仕組みが無い。付けるなら測定の出力が変わりうる（`outputValidation` が結果に載る）ので、材料。
2. **全欄の組み合わせ（直積）を当てる。** 採らなかった。欄が 20 を超え、直積は膨らむ。core には `recall-invariant-fuzz-harness.ts` がある（実 Postgres 側は `recall-invariant-fuzz.postgres.test.ts`）。この歯は「一度も渡されていない欄」に絞った。

## 引き受けた負債（材料）

| # | 負債 | 再現 | 結果 | 緊急度 | 覆る条件 |
|---|---|---|---|---|---|
| 1 | `examples/chat` の runtime は出力の自動検査を通っていない | `examples/chat/vitest.config.mts` の `setupFiles` に `setup-recall-output-contract` が無い | 測定スクリプトが走らせる recall の出力は検査されない（既定の `"report"` で結果に `outputValidation` が載るだけ） | 低 | 測定スクリプトでも出力を検査すると決めたとき |
| 2 | 実 Postgres の歯は「欄を渡す」形の列挙で、直積ではない | 上 | 欄どうしの組み合わせで初めて出る不一致は拾えない | 低 | fuzz（`recall-invariant-fuzz.postgres.test.ts`）に欄を足すと決めたとき |

## これが覆るとしたら

`RecallQuery` に欄が増えたとき（新しい欄は、この歯の表に足すこと。足さなければ、その欄は実 Postgres で検査されない）。`RecallResultSchema` を緩める・締めると決まったとき。

## 測っていないこと

実 OpenAI／local 埋め込みでの出力、`channels` の lexical／trigram の組み合わせ（既存の歯に委ねた）、PostgreSQL 17 以外、`examples/chat` が走らせる recall の出力。
