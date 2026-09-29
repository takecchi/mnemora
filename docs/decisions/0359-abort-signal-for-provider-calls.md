# ADR 0359: provider（LLM・埋め込み）の呼び出しに `AbortSignal` による中断を足す

- **状態**: 採用 (2026-09)
- **日付**: 2026-09-29

> **⚠ この判定は、自動化された担い手（マネージャーのセッションから切り出された担い手、クローン miku）のものである。**
> **⛔ オーナー本人の決定ではない。**本文はクローン miku の委譲先が書いた。
> 案の選択（`Ctx` ではなく各口の選択肢に載せる・runtime 自身が provider の Promise と
> abort を競わせる・abort を既存の失敗経路に倒さない・reject の値は `signal.reason`）は
> クローン miku が決めた。方向そのものの変更が要るなら、オーナー本人に問い直すこと。

**⚠ 各主張の出所を分ける**（ADR 0282 / ADR 0246 の体裁を踏む）。

- **【現物】** — この repo のコード・文書を、この ADR の書き手が自分の手で読んで確かめた。
- **【実測】** — この書き手が実際に `git` / `node` / `vitest` を走らせて確かめた。

---

## 文脈

[Issue #1200](https://github.com/takecchi/mnemora/issues/1200) は、`@mnemora/core` に
LLM・埋め込みの呼び出しを中断する口が無いことを実測で記録していた——`Ctx`・
`LLMProvider.complete`/`completeStructured`・`EmbeddingProvider.embed`・`Runtime` の口
（`observe`・`recall`・`tick`・`consolidate`・`reflect`・`reextract`）・`TickOptions` の
どれにも `AbortSignal` や時間の上限の欄が無く、runtime は provider が返るまで待ち続ける、
という「今の振る舞い」の記録である。本 issue はその欠落を埋める実装を求めている。

Issue 本文は方向を決めていない（「決めていないこと」として残している）。方向はクローン miku が決め、
委譲先への指示として渡した。以下の決定はその指示をほぼそのまま採用したものである。本 ADR はその指示を実装した結果と、実装の過程で分かったこと（特に claim key の呼び出し
順序についての実測）を記録する。

## 決めたこと

1. **中断の口 `signal?: AbortSignal` を任意の欄として足す。既定の時間の上限は持たない。**
   `signal` を渡さない既存の呼び出しは、今までどおり provider が返るまで待ち続ける
   ——挙動は1バイトも変わらない。

2. **共通の型 `AbortOptions { signal?: AbortSignal }` を新設し**
   （`packages/core/src/abort.ts`、`@mnemora/core` から export）、以下に配線した:
   - `LLMProvider.complete(ctx, req, opts?: AbortOptions)` /
     `completeStructured(ctx, req, opts?: AbortOptions)`。
   - `EmbeddingProvider.embed(ctx, texts, opts?: AbortOptions)`。
   - `Runtime.observe(ctx, input, opts?: AbortOptions)` /
     `recall(ctx, query, opts?: AbortOptions)` /
     `reextract(ctx, observationId, opts?: AbortOptions)` /
     `findCorrectionCandidates(ctx, input, opts?: AbortOptions)`——`forget(ctx, target, opts?)`
     と同じ、任意の第3引数の作法。
   - `TickOptions`・`ConsolidateOptions`・`ReflectOptions` は、既に1つの options オブジェクトを
     引数に取る形なので、`signal?: AbortSignal` を**その型に直接足す**（新しい `opts` の
     階層を作らない）。

   **`Ctx` には載せない。** 理由はクローン miku の指示のとおりである: `Ctx` は隔離境界の値
   （`tenantId`/`subjectId`）であり、store の全メソッドに渡る。`Ctx` に `signal` を足すと、
   「store も中断を守る」という誤読を招く——実際には store 側の書き込みは中断の対象では
   ない（決めたこと5参照）。加えて `{tenantId: ctx.tenantId, subjectId: ...}` の形で
   `Ctx` を作り直す箇所（`processConsolidateJob`/`processReflectJob` の `scopedCtx` 等）が
   複数あり、そこで `signal` が黙って落ちる。`CtxSchema`（zod）も変わってしまう。
   **`ObserveInput`/`RecallQuery` にも載せない**——zod の `parse`（非 strict）が知らない
   欄を落とすため、載せても静かに無視される。

3. **provider 自身が `signal` を尊重しなくても、runtime 側が provider の Promise と
   abort を競わせる**（`packages/core/src/abort.ts` の `runAbortable`）:
   - `signal` が既に abort 済みなら、provider を呼ばずに reject する。
   - `signal` が呼んでいる間に abort されたら、provider の Promise の解決を待たずに
     reject する。abort が先に起きた後、provider の Promise が遅れて解決・拒否されても、
     その結果は**捨てる**（resolve/reject のどちらでも無視する）。`run(signal)` の
     Promise には常に `.then`/`.catch` が付くため、遅れた解決が unhandled rejection には
     ならない。歯: `packages/core/src/__tests__/abort-signal.test.ts` の該当ケース
     （遅れて provider が解決/拒否しても、書き込みが起きないこと・後続のテストが
     クラッシュしないこと）。
   - **中断が効くのは、provider を待っている間と呼ぶ前だけである。** provider が
     abort より前に解決していれば、その結果を使った後続の書き込みは途中で止めない
     （部分的な状態を作らない）。

4. **abort されたら、その口が reject する**（reject の値は `signal.reason`。`reason` が
   無いときは `DOMException("...", "AbortError")` 相当——`abortReason()`。Node の
   `AbortController.abort()` は既定で `reason` を自動的に `AbortError` の `DOMException` で
   埋めるため【実測、Node v22】、`reason` 無しの経路は事実上「明示の reason を渡さなかった
   呼び出し」でしか踏まれない）。**既存の失敗経路には倒さない:**
   - `extractCandidates`（`extraction.ts`）: abort による reject は、全文フォールバック
     （`usedWholeObservationFallback: true`）へ倒さず、そのまま投げ直す。
   - `deriveClaimKeys`（`claim-key.ts`）: 同様に `DeriveClaimKeysResult.failure` へ丸めず
     投げ直す。
   - `runRecall`（`recall-runtime.ts`）: `embedding_provider_unavailable` の omission へ
     丸めず投げ直す。
   - `consolidate()`/`reflect()`: `outcome: "llm_failed"` へ丸めず投げ直す。
   - `processEmbedJob`（`runtime.ts`）: `embeddingStatus: 'failed'` へ丸めず投げ直す。
   - `tick()`: ジョブを `fail()` しない（決めたこと6）。

   判定は `isAbort(signal)`（`signal !== undefined && signal.aborted`）で行う。
   `runAbortable` は abort が起きた時点で**同期的に** reject する
   （`AbortController.abort()` は `abort` イベントを同期的に発火するため）ので、
   catch した時点で `signal.aborted` が真なら、その例外は必ず abort によるものである
   ——provider が偶然同時に本当の失敗を返す場合との取り違えは、実装上区別する手段が
   無い（下の「引き受けた負債」参照）。

5. **口ごとの abort の扱い**（すべて `packages/core/src/__tests__/abort-signal.test.ts`
   で実測・固定）:

   - **observe（sync）**: Observation と `extract` ジョブは、LLM を呼ぶ**前**に
     `createObservationWithOutbox` で書かれている（`handleExtractableObservation`）。
     abort で reject したら、`extract` ジョブは `complete()` されず、claim もされていない
     ままの行として残る——後の `tick()` がそのジョブを処理する（`processExtractJob`
     の ADR 0347 再配達ガードにより、LLM が今回何も書いていないので再抽出は正しく走る）。
     全文フォールバックの記憶は作られない。
     - **sync にしか渡らない `subjectCandidates`・`claimKey` は、後の deferred な
       再抽出（`processExtractJob`）には届かない**——これは abort 固有の話ではなく、
       `runExtraction` の既存の doc コメントが述べている一般的な制約（`processExtractJob`
       はそもそもこの2引数を渡さない）がそのまま当てはまるだけである。
     - **【実測、下調べで確認】claim key の LLM 呼び出し（`claim-key.ts`）は、抽出の
       LLM 呼び出しの後・Memory の書き込みの**前**にある**（`runExtraction` の実装順:
       `extractCandidates` → (opt-in なら) `deriveClaimKeys` → `createMemoriesFromCandidates`）。
       クローン miku の指示は「claim key の呼び出しが記憶を書いた**後**にあるなら重複を確かめる
       こと」と条件付きで指示していたが、**その条件は成立しない**——claim key はどちらの
       LLM 呼び出しも記憶の書き込みより前にあるため、abort で reject しても記憶は1件も
       書かれず、再配達で重複が生まれる余地は無い（extract 単体の abort と同じ形に帰着
       する）。ADR 0347 の再配達の規律（`processExtractJob` が LLM を呼ぶ前に
       `listBySourceObservation` を確認する）は、この経路をそのまま覆う。

   - **tick**: **abort されたら、どのジョブも `fail()` しない。** 処理中のジョブ
     （provider 呼び出しを待っている最中に abort された）も、claim 済みで未着手の
     ジョブ（`claimBatch` はループの前に1回だけ呼ぶため、abort 済みでも一括で claim
     される。ループの先頭で `signal.aborted` を見て以降の処理を止める）も、そのまま
     残る——claim されたままリースが切れるのを待ち、次の `tick` が取る。abort までに
     `complete()` した分の完了は、store への書き込みが既に起きているので残る。
     `tick()` 自体は reject する。`TickResult` に新しい欄は作らない
     （`tick()` が reject した時点で戻り値そのものが無いため）。
     - `processEmbedJob`: abort による reject は `embeddingStatus: 'failed'` に**しない**
       ——中断は「試して失敗した」ではなく「待つのをやめた」であるため。
     - `processConsolidateJob`/`processReflectJob`: `consolidate()`/`reflect()` 自身が
       abort で reject する（決めたこと4）ため、`throwIfLlmFailed` には届かず、その
       reject がそのまま `tick()` の catch まで伝わる。

   - **recall**: abort が効くのはクエリの埋め込み（`EmbeddingProvider.embed`）を待つ
     間だけ。段6（記録、`MemoryStore.createRecall`）はクエリの埋め込みの**後**にしか
     走らないため、abort の時点では recall の記録も `activity_seq`（テナント/subject の
     どちらのカウンタも）の前進も起きない。歯で確認: `createRecall` が一度も呼ばれない
     こと、`getActivitySeq` が変化しないこと。

   - **consolidate/reflect**: 内部で1回だけ呼ぶ `recall()`（`{ seedMemoryId }`/`{ query }`
     形）と、その後の LLM 呼び出し（`completeStructured`）の両方に `signal` を通す。
     LLM 呼び出しは、対象を1件も書く前（`consolidate`/`reflect` とも「eligible が0/1件
     なら打ち切る」判定より後、統合先/内省先を作るより前）にあるため、abort の時点では
     何も書かれていない。

   - **reextract**: 抽出の LLM 呼び出し（`extractCandidates`）を待つ間だけ abort が
     効く。この呼び出しは、退けた記憶の確認（`listWithdrawnBySourceObservation`）より
     後・`supersedeWithNewMemories`/`createMemoryWithOutbox` の書き込みより前にあるため、
     abort の時点では何も書かれていない。

   - **findCorrectionCandidates**: 内部で1回だけ呼ぶ `recall()` へ `opts` をそのまま
     渡すだけであり、この口自身は中断を新しく判定しない——`recall()` の扱いがそのまま
     当たる。

6. ⛔ **この PR には入れないもの**: 既定の時間の上限、「`tick` がリースを超えたことの
   名乗り」。どちらも Issue #1200 の元の調査が「決めていないこと」として残していた
   論点であり、本 ADR は abort の口を足すことだけを扱う。

## provider 実装（`@mnemora/openai`・`@mnemora/anthropic`・`@mnemora/local-embedding`）

- **`@mnemora/openai`・`@mnemora/anthropic`**: `opts?.signal` を、そのまま SDK 呼び出しの
  request options（`chat.completions.create(params, { signal })` /
  `messages.create(params, { signal })`）へ渡すだけ。`client-types.ts` の構造型
  （`OpenAIChatClient`/`OpenAIEmbeddingsClient`/`AnthropicMessagesClient`）は元々
  `options?: unknown` を持っていた（Issue #1221 の副産物）ため、型の変更は不要だった。
  歯: `packages/openai/src/__tests__/abort-signal.test.ts`・
  `packages/anthropic/src/__tests__/abort-signal.test.ts`（偽 client で、signal が
  第2引数に渡ること・signal を尊重する体の偽 client では abort で reject することを
  確認。本物の SDK の `AbortSignal` 対応そのものは検査していない——それは repo の外側の
  話である）。
- **`@mnemora/local-embedding`**: `@huggingface/transformers` のパイプライン呼び出し
  自体を中断する口が無いため、**推論の途中では止まらない**。モデルの読み込みの前後・
  推論（`pipeline.embed`）の前後で `signal.throwIfAborted()` を呼ぶだけ——推論は最後まで
  走らせ、終わった時点で abort 済みならベクトルを**返さずに**投げ直す。歯:
  `packages/local-embedding/src/__tests__/abort-signal.test.ts`（推論が「途中」の状態で
  abort しても reject が遅延すること＝止めていないことの確認を含む）。
- **`@mnemora/testkit` の conformance suite**: `describeLLMProviderConformance`/
  `describeEmbeddingProviderConformance` には abort 関連の歯を**足していない**。
  「signal を尊重すること」を必須の検査にすると、既存の実装（testkit のプレースホルダ
  実装や、signal を無視するだけの正直な adapter）を壊しうる破壊的変更になる——
  `packages/core` 側の `runAbortable` が provider の協調を前提にせず reject できる設計に
  したのは、まさにこの「provider は signal を見なくてよい」を成り立たせるためである。
  任意項目（`overLimitText` と同じ「省略時は `it.skip`」の形）として足すことも検討したが、
  「呼び出しが永久に pending のままになる provider」を conformance suite の外から一般的に
  用意する手段が無く（実 API に当てる経路では意味がなく、fake client 側の協力が要る）、
  この PR では見送った——**足さずに報告する**（クローン miku の指示が明示的に許容した選択肢）。

## 採らなかった案

- **`Ctx` に `signal?: AbortSignal` を足す案**: 決めたこと2で退けた理由のとおり
  （store が中断を守ると誤読される・`Ctx` を作り直す箇所で黙って落ちる・`CtxSchema`
  が変わる）。
- **`ObserveInput`/`RecallQuery` に `signal` を足す案**: zod の非 strict `parse` が
  知らない欄を黙って落とすため、渡したつもりで効かない形になる。
- **`LLMProvider`/`EmbeddingProvider` ごとに別の `opts` 型を作る案**: `AbortOptions` が
  今のところ `signal` 1つしか持たないため、型を分けると「同じ形の型を2つ置くと片方だけ
  直したときにずれる」という繰り返し踏んできた欠陥を新しく作る。1つの共通型に統一した。
  `TickOptions`/`ConsolidateOptions`/`ReflectOptions` にも同じ `opts` 階層を作る案は、
  これらが既に1つの options オブジェクトを取るため不要と判断し、`signal` を直接生やした。
- **`tick()` を呼ぶ前に abort 済みなら `claimBatch` 自体を呼ばない案**: 「中断が効くのは
  provider を待っている間と呼ぶ前だけでよい」という設計方針からは、`claimBatch`
  （store 呼び出し）を省く積極的な理由が無い。呼んでも害はなく（claim されたジョブは
  リース切れで回収される）、`tick()` の分岐を「ループの先頭で signal を見る」の1箇所に
  絞れる利点を優先した。
- **conformance suite に abort の歯を必須で足す案**: 上記のとおり破壊的になりうるため
  見送った。

## 引き受けた負債

- **abort とほぼ同時に provider が本当に失敗した場合の区別は無い。** `runAbortable` は
  abort が起きた時点で同期的に reject するため、実務上この競合は起こらない
  （JavaScript のイベントループは単一スレッドであり、`AbortController.abort()` の
  呼び出しと `abort` イベントの発火の間に他のコードは走らない）。
- **`@mnemora/local-embedding` は推論の途中では止まらない。** `throwIfAborted()` の
  チェックポイント（読み込みの前後・推論の前後）の間でしか効かない——重い推論の
  途中で abort しても、推論自体は最後まで走る。
- **`processExtractJob`/`processEmbedJob` 以外の tick ジョブ（`consolidate`/`reflect`）
  は、`consolidate()`/`reflect()` 自身の reject に委ねている**——`tick()` の catch 節が
  「`signal.aborted` なら `fail()` しない」で拾うため二重に判定する必要は無いが、
  `consolidate()`/`reflect()` を tick 経由でなく直接呼ぶ利用者にも同じ reject が届く
  （意図した設計であり負債ではないが、`throwIfLlmFailed` の対象から静かに外れる形なので
  記録しておく）。
- **conformance suite の abort 対応は無い**（上記のとおり）。testkit のプレースホルダ
  実装（`InMemoryVectorStore` 等ではなく、LLM/Embedding のプレースホルダがあれば）が
  signal を受け取っても無視する実装のままであっても、この PR ではそれを検査しない。

## これが覆るとしたら

- 既定の時間の上限を足すことがオーナーに認められたとき ⟹ `RuntimeConfig`（または
  各 provider の Options）に既定のタイムアウトを持たせ、`runAbortable` の `signal` を
  内部で合成した `AbortSignal.timeout(...)` と `AbortSignal.any([...])` で束ねる設計を
  検討する。
- `tick` がリースを超えたことを名乗る要求が実際に出たとき ⟹ 別の Issue でこの ADR の
  「入れなかったもの」を独立に扱う。
- `@mnemora/local-embedding` が推論の途中で本当に中断できる実行基盤（Worker の
  `terminate()` 等）に載せ替えられたとき ⟹ 「推論の途中では止まらない」という制約を
  見直す。

## 確かめたこと

- 歯: `packages/core/src/__tests__/abort-signal.test.ts`（18ケース）・
  `packages/openai/src/__tests__/abort-signal.test.ts`（5ケース）・
  `packages/anthropic/src/__tests__/abort-signal.test.ts`（3ケース）・
  `packages/local-embedding/src/__tests__/abort-signal.test.ts`（3ケース）。
  実装前の `main`（`c174953`）に対して、`packages/core` の歯は18/18が赤いことを確認した
  （タイムアウト、または `opts.signal` が provider に渡っていないことによるアサーション
  失敗）。実装後、上記すべてが green。
- `packages/core`・`packages/openai`・`packages/anthropic`・`packages/local-embedding`
  の既存スイート・typecheck は、この変更の前後で green のまま
  （`packages/core/src/__tests__/embed-batch-size.test.ts` は、`embed()` が第3引数を
  取れるようになったことに伴い、検査する正規表現を1箇所だけ緩めた——検査している
  「バッチ件数」の意味は変えていない）。

## 確かめていないこと

- 本物の OpenAI/Anthropic API に対して、実際に `AbortSignal` で中断できるかどうかの
  実測（live テスト）。
- `@mnemora/postgres` 側（store の書き込みそのもの）を abort で中断する経路——本 ADR は
  provider 呼び出しだけを対象にしており、store の書き込みは対象外（決めたこと5のとおり、
  中断が効くのは provider を待っている間だけ）。
