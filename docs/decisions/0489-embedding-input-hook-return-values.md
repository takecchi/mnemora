# ADR 0489: 穴探し58巡目 — `RuntimeDeps.embeddingInput`（利用者のフック）の戻り値が `string` でないとき・端の値のときの `processEmbedJob`（ずれは見つからなかった）

- **状態**: 採用 (2026-10)
- **日付**: 2026-10-02

クローン miku の委譲先（担い手。マネージャー mgr-0d3098f9 の指示による）が書いた。直す線（約束に実装を戻す・落ちる入力を減らす・文書の直し・前例のある同種の穴は直す。オーナーの領分の6つ〔前例の無い新しい断り・既定値の変更・公開 API を足す・suite に約束を足す・遡ってのデータの書き換え・適用済みの migration の編集〕は材料に回す）は依頼主が決めた。オーナーの判断ではない（[ADR 0220](./0220-issue-comment-author-does-not-distinguish-owner-from-agent.md)）。
出所の区別: 【現物】は読んだコード・文書、【実測】は手元で走らせた結果、【判断】は担い手の判定、【未確認】は確かめていないこと。

## 下調べの要点

- **選んだ面**: `RuntimeDeps.embeddingInput?: ((memory: Memory) => string)`（Issue #753、ADR 0336）の**戻り値**が、型どおりの `string` でないとき（`undefined`・数・オブジェクト）・端の値のとき（空文字・巨大な文字列・NUL・孤立サロゲート）の、`processEmbedJob` の振る舞い。
- **現物**【読んだ範囲】:
  - `packages/core/src/runtime.ts:356`（型）と、その直前の TSDoc（`:325-355`）。TSDoc の約束は「省略時は `memory.content` をそのまま `embed()` へ送る」「`Memory.content` 自体は変えない」「**フックが例外を投げた場合、`processEmbedJob` は今までどおり `embeddingStatus` を `'failed'` にしてから再送出する——このフックのために新しい throw の経路を既定側へ作らない**」。
  - `resolveEmbeddingInput`（`:5910-5912`）は `deps.embeddingInput ? deps.embeddingInput(memory) : memory.content` で、**戻り値を検査せずに返す**。呼び出し側の `processEmbedJob`（`:5924` 付近）は、`embeddingProvider.embed(ctx, [resolveEmbeddingInput(memory)])` を try の中で呼び、例外なら `embeddingStatus: "failed"` にして再送出する。
  - 既存の歯: `packages/core/src/__tests__/embed-job-error-cause.test.ts`（失敗の `cause`）ほか、`embed-job-*.test.ts` が provider の応答の端（次元・非有限・欠落）を縛っている。フックの戻り値の端を名指した歯は見当たらない。
- **根拠**: `embeddingInput` は gh で closed の issue 2・PR 5、open は 0。ADR 0434 以降に 4 行（導入は ADR 0336）。
- **見込みが低いこと**: 型は `string` を要求し、フックは利用者のコード。戻り値が非 string なら、provider（`OpenAIEmbeddingProvider` の openai SDK など）が自分の文面で落ちるだけの公算が高い。**何も出ない可能性が高く、その場合は当てた記録と歯が成果**。
- **当て方**: core の fake の Runtime（`createFakeRuntimeStores`）と、渡された入力を記録する偽の provider。フックが `undefined`・数・オブジェクト・空文字・巨大な文字列・NUL・孤立サロゲートを返したとき、(1) `embeddingStatus`、(2) ジョブの終端（`tick` の結果）、(3) 例外の文面と `cause`、(4) provider に何が渡ったか、(5) 静かな破損（非 string が `ready` のまま誤ったベクトルを書く、など）が無いか、を見る。従: `reembed` で `failed` を戻した後の `tick` で、同じフックが再び呼ばれること。陽性対照: フックが投げると `failed`（既存の振る舞い）、通常の文字列で `ready`。
- **線**: 戻り値を検査して断るのは新しく断る入力なので外側（材料）。内側は、今の振る舞いを TSDoc に書く文書の直しと、それを縛る歯。静かな破損が見つかって TSDoc の約束と違うなら、直す前に止まって報告する。
- **見送った候補**: B `EventStore.list`（46巡目 `EventStore.append` の隣。同値の `at` の順序とページングの限界は TSDoc が書いている）、C `package.json`（`exports`・`bin`・`files`・`engines`）と dist・README の突き合わせ（consumer-smoke〔ADR 0441〕が見ている可能性が高く、当てるには `pnpm pack` が要る。`engines` と使用 API の整合は確認済み）、D `OpenAILLMProvider`／`AnthropicLLMProvider` の `PromptSpec` の端（`provider-parity.test.ts` が並べている。42・39・20巡目の隣）。
- **避けた面**: ADR 0480〜0488（`RecallRecord`・`getRecall`、`recall` の `outputValidation`、`event.data` の JSON、`TokenCounter`、`channels` の合流、`findCorrectionCandidates` の除外、testkit fixture の `createObservation`）。

## 決定（線の内側＝文書の直しと歯だけ。実装は変えていない）

- **TSDoc**（`packages/core/src/runtime.ts` の `embeddingInput`）に、今の振る舞いを足した: 戻り値は検査も変換もしない・型の外の値も含めてそのまま `embed()` に渡る・受け入れるかは provider が決める（落ちれば `failed`、受け入れれば `ready`）・`reembed()` の後にフックがもう一度呼ばれる。
- **歯** `packages/core/src/__tests__/embedding-input-hook-return.test.ts`（15 本）:
  - 陽性対照: 通常の文字列は provider にそのまま渡り `ready`、`Memory.content` は元のまま。フックが投げると `failed` で、job の `lastError` に元の例外。
  - 文字列の端（空文字・NUL・孤立サロゲート・20 万字）: 変換されず provider に渡り、受け入れる provider なら `ready`。
  - 型の外の値（`undefined`・数・オブジェクト・`null`）: 変換されず provider に渡る。`text.length` を読む fake の provider に渡すと `failed` になり、`ready` に偽装されない。
  - `reembed()` で `failed` を戻した後の `tick` で、フックが 2 回目に呼ばれ、通れば `ready`。
- **実測の結果**【実測。core の fake、node v22.23.3】: 15 本すべて緑。既存の `embed-job-error-cause.test.ts` も緑（合わせて 16 本）。**静かな破損も、TSDoc の約束との食い違いも見つからなかった**。「戻り値を検査して断る」経路が既定側に無いことは、TSDoc の約束（新しい throw の経路を既定側へ作らない）どおり。
- **歯が赤くなることの陽性対照**【実測。変異】: `resolveEmbeddingInput` に「非 string か空文字なら投げる」検査を足すと、「空文字」と「型の外の値 4 つ」の 5 本が赤になった（15 本中 5 本）。`cp` で退避して戻し、戻した後は 15 本緑。→ **誰かがフックの戻り値の検査を足すと歯が赤くなる**。その場合は、この ADR（検査して断るのは新しく断る入力）と TSDoc を読み直すこと。

## 探した形の一覧

- 当てた形: 通常の文字列、空文字、NUL を含む、孤立サロゲートを含む、20 万字、`undefined`・数・オブジェクト・`null`（受け入れる provider と、`text.length` を読む fake の provider の両方）、フックが投げる、`reembed()` の後の再呼び出し。
- 見つからなかった形: 型の外の値で `ready` のまま誤ったベクトルを書く（provider が決めた固定のベクトルが `ready` で書かれるのは、provider が受け入れたことの帰結で、Runtime の不具合ではない）。
- 当てていない形: 実 provider（`OpenAIEmbeddingProvider` が空文字で 400 になることは README が表にしている。`LocalEmbeddingProvider` の空文字は未確認）、実 Postgres（`embeddingInput` は Runtime の中の純粋な呼び出しで、store に依らない）、フックが `Promise` を返す場合（型は同期の `string`。`Promise` を返すと `embed()` に `Promise` が渡る。型の外の値と同じ扱いで、歯の表の「オブジェクト」の一種）。

## 検討した代替案

1. **戻り値が `string` でなければ `processEmbedJob` が明示のエラーで断る。** 採らなかった。新しく断る入力で、TSDoc の「新しい throw の経路を既定側へ作らない」とも合わない。provider が既に落ちる（または受け入れる）。外側（材料）。
2. **空文字を `memory.content` に倒す（フックの戻り値が空ならフックを使わない）。** 採らなかった。黙って別の入力を送る。フックを使う利用者の意図を隠す。外側（挙動の変更）。

## 引き受けた負債（材料）

| # | 負債 | 再現 | 結果 | 緊急度 | 覆る条件 |
|---|---|---|---|---|---|
| 1 | フックの戻り値が型の外だと、失敗の文面が provider の文面になる（フックが原因だと分かりにくい） | 戻り値 `undefined` を `text.length` を読む provider に渡す | `failed` になるが、`lastError` は `TypeError`（フックの名前は出ない） | 低 | 戻り値を検査して断ると決めたとき（歯が赤くなる） |

## これが覆るとしたら

フックの戻り値を検査して断ると決まったとき（歯の表の「そのまま渡る」行が赤くなる）。`embeddingInput` を非同期（`Promise<string>`）にすると決まったとき。

## 測っていないこと

実 provider（`LocalEmbeddingProvider` の空文字・孤立サロゲートの扱い）、`embeddingInput` を渡した状態の `recall` 側のクエリの埋め込み（`embeddingInput` は `processEmbedJob` 専用で、recall のクエリには使わない）。
