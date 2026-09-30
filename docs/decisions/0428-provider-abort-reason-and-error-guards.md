# ADR 0428: provider を直に呼んだときの abort の reject を `signal.reason` に揃え、openai・anthropic の例外に判定関数を足す

- **状態**: 採用 (2026-09)
- **日付**: 2026-09-30

クローンの委譲先（マネージャー mgr-0629e6a2）が書いた。直し方はクローンが決めた。オーナーの判断ではない（[ADR 0220](./0220-issue-comment-author-does-not-distinguish-owner-from-agent.md)）。
**オーナーが覆せる点は「これが覆るとしたら」にまとめてある。**

- **文脈**:

  [ADR 0359](./0359-abort-signal-for-provider-calls.md) 決定4は、`signal` を渡した provider 呼び出しについて、reject の値は `abortReason(signal)`
  （`signal.reason`）であり、呼ぶ前に abort 済みなら provider を呼ばずに reject する、と約束した（core の `abort.ts` の `AbortOptions` の doc も同じ）。
  この約束は core の `runtime` が provider の Promise と abort を競わせる（`runAbortable`）ことで、runtime 経由の呼び出しには効いていた。
  一方、**provider を直に呼ぶ**呼び出しでは、次の2つが約束と食い違っていた。localhost の擬似 HTTP サーバに実物の SDK を向けて測った。

  1. **openai・anthropic**（`packages/openai/src/llm-provider.ts`・`embedding-provider.ts`、`packages/anthropic/src/llm-provider.ts`）は
     `{ signal: opts?.signal }` を SDK に渡すだけだった。abort 済みでも途中 abort でも、reject の値は SDK の `APIUserAbortError`
     （`signal.reason` ではない）になった。さらに 429 + `retry-after: 3` の応答に対し 200ms で abort しても、約3秒後（SDK の再試行待ちが終わる頃）まで
     返らなかった。SDK の再試行待ちは abort で切れていなかった。
  2. **local-embedding**（`packages/local-embedding/src/local-embedding-provider.ts`）は、モデルの読み込み中・読み込みの再試行中に abort を見なかった。
     読み込みが約800msかかる pipeline に100msで abort しても、約800ms後に返った。`attempts: 3` で失敗し続ける pipeline では、abort 後も3回試し、
     最後に返るのは abort ではなく「モデルを読み込めなかった」`Error` だった。

  もう1つ、[ADR 0418](./0418-store-error-kind-guards.md) の本文が「provider のエラーは既に判定関数を持つ」と書いたのは、openai・anthropic には当たらなかった
  （どちらも `kind` は持つが、`instanceof` を使わない判定関数が無かった）。この点の訂正は ADR 0418 の末尾の追記に置いた。

- **決めたこと**:

  1. **openai・anthropic の SDK 呼び出しを、core の `runAbortable` で包む。**`complete`・`completeStructured`・`embed` の SDK 呼び出しを
     `runAbortable(opts?.signal, (signal) => client….create(params, { signal }))` にした。`signal` は SDK にも渡すので、裏のリクエストも切れる。
     abort が先に起きたときの reject の値は `abortReason(signal)`（`signal.reason`。`reason` 無しの `abort()` なら `AbortError` の `DOMException`）で、
     SDK が後から `APIUserAbortError` で reject してもその結果は捨てられる（unhandled rejection にならない）。呼ぶ前に abort 済みなら、SDK を呼ばずに reject する。
     SDK の再試行待ちの最中でも、abort の時点で reject する（待っているのは `runAbortable` であり、SDK の内部の sleep ではない）。
     `signal` を渡さなければ、素通しで今までどおりである。
  2. **local-embedding は、共有の読み込みを止めず、`signal` ごとに待ちだけを切る。**`#embed` の `await this.#load()` を
     `await runAbortable(opts?.signal, () => this.#load())` にした。`#load()`（と、その中の `#startLoad` の再試行ループ・`sleep`）は、`#ready` に握られた
     共有の Promise であり、複数の `embed()`・`warmup()` が同じものを待つ。abort された呼び出しは `abortReason(signal)` で即座に reject するが、
     読み込みとその再試行は続く。ある呼び出しの abort が、同じ読み込みを待つ別の呼び出しを巻き添えにしない。
     「各回の前と sleep の後で abort を見る」という意図は、共有ループの中では見ずに、**待っている呼び出しの側で反映した**——ループの各回・`sleep` は
     すべて `runAbortable` が待つ Promise の内側にあるので、abort された呼び出しは、どの回のどの待ちの最中でも、その時点で `signal.reason` で返る。
     共有ループの中で abort を見ると、1人の abort が全員の読み込みを止める（または abort した人の signal を、他人の読み込みが参照する）ことになるので採らなかった。
  3. **読み込みそのものが abort で止まらないことを TSDoc と README に書く。**`embed` の TSDoc に、待ちだけが切れること・全員が abort しても読み込みは終わりまで走り
     成功すればモデルが保持されること・推論の途中は止まらないこと（ADR 0359 のまま）・`warmup()` は `signal` を取らないことを書いた。
  4. **openai・anthropic の例外に判定関数を足す。**`isOpenAILLMProviderError`・`isAnthropicLLMProviderError` を公開 export にした。
     [ADR 0418](./0418-store-error-kind-guards.md) の作法で、`instanceof` を使わず「`kind` があればその値が各パッケージの `*LLMFailureKind` のいずれかであることを、
     `kind` が無ければ `name` が `"OpenAILLMProviderError"` / `"AnthropicLLMProviderError"` であることを」見る。`kind` は既に在ったので足していない。
     ただし `kind` の値は openai と anthropic で重なる（`"refusal"` など）ので、`kind` が在っても `name` が文字列なら、それが自分のクラス名であることも見る
     （`name` を持たない素の値は `kind` だけで見る）。ADR 0418 の「`kind`、無ければ `name`」から一歩締めた形で、相手の provider の例外を取り違えないためである。
  5. **README の訂正。**`packages/openai/README.md` の `kind` の列挙に、型 `OpenAILLMFailureKind` の4種目 `schema_unsupported` を足した。
     3つの provider の README に、`signal` の振る舞いを1節ずつ書いた。

- **検討した代替案**:

  1. **provider 側で `signal.aborted` を見て `APIUserAbortError` を `signal.reason` に付け替える（catch して投げ直す）。** 採らなかった。
     SDK の再試行待ちが切れず（約3秒待つ）、待ち時間の問題が残る。core が既に持つ `runAbortable` と同じ作法で揃えるほうが、runtime と provider の約束が1本で済む。
  2. **SDK の `maxRetries` を 0 にする。** 採らなかった。`client` を注入する呼び出し側の設定であり、既定の再試行を消すのは挙動の変更が大きい
     （README の「`client` を省略すると SDK 既定の再試行・timeout が効く」節）。
  3. **local-embedding の `#startLoad` の中で、各回の前と `sleep` の後に abort を見る。** 採らなかった（決めたこと2）。読み込みは複数の呼び出しで共有され、
     どの signal を見るかが定まらない。最初に読み込みを起こした呼び出しの signal を見ると、その呼び出しの abort が他の呼び出しの読み込みを止める。
  4. **全員が abort したら読み込みも止める（参照の数え上げ）。** 採らなかった。`createPipeline` に中断の口が無い（`@huggingface/transformers` の読み込みは途中で止められない）ので、
     止められるのは再試行ループだけであり、その効果に対して実装が大きい。再試行の途中で止めると、次の `embed()` が最初からやり直すことになる。
  5. **エラーの判定関数を `@mnemora/core` に共通で置く。** 採らなかった。`matchesStoreErrorKind` は store 例外用の内部の道具で公開していない。provider のエラーは
     パッケージごとに `kind` の体系が別（`@mnemora/local-embedding` も同じ形で持つ）で、共通化しても各パッケージの型ガードは別に要る。

- **引き受けた負債**:

  - **local-embedding で、全員が abort しても読み込みの再試行は続く。**失敗し続ける pipeline で `attempts: 3` なら、abort 後も3回試し終えるまで裏で走る
    （呼び出し側には返っている）。失敗した読み込みは `#ready` から外れるので、次の `embed()` は新しく始める。読み込みの費用（ネットワーク・CPU）は abort で節約できない。
  - openai・anthropic で、abort 後に SDK が遅れて完了・失敗しても結果は捨てる（`runAbortable` の仕様）。裏のリクエストは `signal` を渡しているので切れるはずだが、
    サーバ側の処理までは止まらない。実 API では確かめていない。
  - 推論の途中は止まらない（ADR 0359のまま）。
  - openai・anthropic の判定関数は、`name` を持たない素の値を `kind` だけで見る。`name` を持たず、たまたま同じ `kind` の値（`"refusal"` 等）を持つ別のパッケージの値は true になる。
    `name` は偽装もできる。`instanceof` を使わない判定関数の一般的な限界であり、provider は利用者が自分で配線する信頼された部品なので許容した。

- **これが覆るとしたら**:

  local-embedding の読み込みに中断の口（`createPipeline` の引数に `signal` など）が足されるなら、全員が abort したときに読み込みも止める設計
  （代替案4）を再検討してよい。その場合も、待ちを `signal` ごとに切る今の形は残せる。SDK が abort の reject の値を `signal.reason` にするようになるなら、
  openai・anthropic の `runAbortable` は冗長になるが、再試行待ちを切る役は残る。

- **測ったこと**:

  - 歯は実 API・鍵・実モデルを使わない。openai・anthropic は、`client` に**実物の SDK**（`openai`・`@anthropic-ai/sdk`）を注入し、localhost の擬似 HTTP サーバ
    （応答しない・429 + `retry-after: 3`）に向けた（`packages/openai/src/__tests__/abort-reason-real-sdk.test.ts`・`packages/anthropic/src/__tests__/abort-reason-real-sdk.test.ts`）。
    local-embedding は `createPipeline`・`sleep` の注入（`packages/local-embedding/src/__tests__/abort-load-wait.test.ts`）。
  - **直す前は赤、直した後は緑。** openai は12本すべて赤（`complete`・`completeStructured`・`embed` × abort 済み・途中 abort・reason 無し abort・429 中 abort。
    値は `APIUserAbortError` で `signal.reason` と食い違い、429 の3本は約3000msかかった）。anthropic は8本すべて赤（同じ形）。
    local-embedding は7本すべて赤（読み込みの gate が開くまで reject せず、5秒のテスト timeout）。実装後は openai 12本・anthropic 8本・local-embedding 7本とも緑。
  - 判定関数の歯（`packages/openai/src/__tests__/error-guard.test.ts`・`packages/anthropic/src/__tests__/error-guard.test.ts`）は、実装のあとに書いた
    （実装前の赤は見ていない）。ただし「kind の値が重なる相手の provider の例外（`name` が違う）を true と判定しない」の1本は、`kind` だけを見る最初の実装に当てて
    両パッケージで赤を見てから、`name` も見る形に締めて緑にした。
  - 公開 API の表面（`scripts/__snapshots__/public-api/openai.d.ts`・`anthropic.d.ts`）の差分は、判定関数の `export declare function` が各1行増えただけ（追加のみ）。
  - **測っていないこと**: 実 API での abort・再試行待ち（擬似サーバ＋実物の SDK まで）。本物のモデルの読み込み中の abort。
