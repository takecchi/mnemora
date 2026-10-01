# ADR 0489: 穴探し58巡目 — `RuntimeDeps.embeddingInput`（利用者のフック）の戻り値が `string` でないとき・端の値のときの `processEmbedJob`（草稿・作業中）

- **状態**: 草稿 (2026-10。作業中。実測の結果で書き換える)
- **日付**: 2026-10-02

クローン miku の委譲先（担い手。マネージャー mgr-0d3098f9 の指示による）が書いた。直す線（約束に実装を戻す・落ちる入力を減らす・文書の直し・前例のある同種の穴は直す。オーナーの領分の6つ〔前例の無い新しい断り・既定値の変更・公開 API を足す・suite に約束を足す・遡ってのデータの書き換え・適用済みの migration の編集〕は材料に回す）は依頼主が決めた。オーナーの判断ではない（[ADR 0220](./0220-issue-comment-author-does-not-distinguish-owner-from-agent.md)）。
出所の区別: 【現物】は読んだコード・文書、【実測】は手元で走らせた結果、【判断】は担い手の判定、【未確認】は確かめていないこと。

## 下調べの要点（この草稿の時点。器の入れ替えで文脈が失われても引き継げるように、先に書く）

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

## 実測の結果

（作業中。追記する。）
