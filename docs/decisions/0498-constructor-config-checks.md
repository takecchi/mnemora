# ADR 0498: 壊れた構成値を構築時に断る — `createBullmqTickDriver` の `everyMs`・`jobName`、provider のコンストラクタの数値オプション

- **状態**: 採用 (2026-10)
- **日付**: 2026-10-02

クローン miku の決定。担い手が書いた。オーナーではない（[ADR 0220](./0220-issue-comment-author-does-not-distinguish-owner-from-agent.md)）。
前提: オーナーが v1.X.0 で破壊的変更を許したので、壊れた構成値を構築時に新しく例外で断る直しは、クローンが決めてよくなった。migration-v1 の 🔴 項目は 56。
出所の区別: 【現物】は読んだコード、【実測】は手元で走らせた結果、【判断】は担い手の判定、【未確認】は確かめていないこと。

- **文脈**: 2つの未解決の材料が、同じ形（構築時に断る）で直せる。
  - [ADR 0477](./0477-bullmq-tick-driver-everyms-jobname-queuename-not-checked.md): `createBullmqTickDriver` は `concurrency` だけ検査し、`everyMs`・`jobName` は BullMQ に渡す。負・`1` 未満・`1e21` 以上の `everyMs` と空文字の `jobName` は、`start()` が成功したまま tick が数回で止まり、`onTickError` も鳴らない（0477 の実 Redis の測定）。案1（構築時に検査）を「新しく断る入力」として材料に回していた。
  - [ADR 0467](./0467-recall-footprint-nonfinite-inputs-fallback-digest-grapheme.md) 面C: provider のコンストラクタが `dimensions`・`maxTokens`・`temperature`・`numThreads` を検査しない。見送っていた。

- **現物の確認**【現物】（着手前。依頼の記述と食い違ったところは「食い違い」に書く）:
  - `packages/bullmq/src/tick-driver.ts`: `resolveConcurrency` だけが検査していた。`jobName` は `opts.jobName ?? "mnemora-tick"`。
  - `packages/openai/src/embedding-provider.ts`: `dimensions` は `space.dimensions` にそのまま入る。`packages/openai/src/llm-provider.ts`: 数値は `temperature` だけ（`maxTokens` 等の欄は無い）。`packages/anthropic/src/llm-provider.ts`: `maxTokens` だけ（`temperature` の欄は無い）。`packages/local-embedding/src/local-embedding-provider.ts`: `numThreads` に加え、**`dimensions` の欄もある**（`space.dimensions` に入る）。
  - 既存の作法: `apiKey` の検査（`api-key.ts`）は秘密なので値を message に入れない。数値の検査（`resolveConcurrency`・`eraseTenant` の `limit`）は値を message に入れる。

- **食い違い**: 依頼は `local-embedding` で `numThreads` だけを挙げていたが、同じ provider に `dimensions` の欄もあり、規則（`dimensions` は正の安全な整数）がそのまま当たる。**両方に当てた**。`maxBatchSize`・`retry.attempts` は、既存の doc が「素通しせずに丸める」と決めた別の流儀なので、触っていない。

- **決定**:
  1. **`createBullmqTickDriver`**: `Queue`・`Worker` を作る前に、`everyMs` は `typeof number`・有限・`1` 以上・`Number.MAX_SAFE_INTEGER` 以下を要求する（小数は通す——BullMQ が切り捨てて今も動く。文字列 `"50"` は断る）。`jobName` は省略（`undefined`）なら既定、渡すなら空でない文字列。違えば素の `Error`（`resolveConcurrency` と同じ型・同じ場所・同じ作法で、値を message に入れる）。`queueName` は BullMQ が空文字・`:` を同期的に投げるので触らない。
  2. **provider**: `OpenAIEmbeddingProvider.dimensions`・`AnthropicLLMProvider.maxTokens`（渡すなら）・`LocalEmbeddingProvider.dimensions`/`numThreads`（渡すなら）は正の安全な整数。`OpenAILLMProvider.temperature`（渡すなら）は有限で `0` 以上（上限は API・モデルごとに違うので見ない）。型が違えば `TypeError`、数として不正なら `RangeError`。message は `<クラス名>: <欄> must be …, got <値>`。値は秘密でないので入れる（`apiKey` は入れない作法のまま）。**省略（`undefined`）の既定は変えない**（`temperature` は省略なら API へ渡さない）。
  3. 検査の関数は各パッケージの内部（`option-check.ts`、index から export しない）。**公開 API は増えない**。パッケージ間で共有する置き場（core など）は無いので、小さい関数を3パッケージに置いた（重複は承知。下の負債）。
  4. 歯: `packages/bullmq/src/__tests__/tick-driver.option-passthrough.test.ts`（ADR 0477 の「そのまま渡す」の歯を、意図どおり「断る」に書き換えた。`bullmq` をモックに差し替える Redis 不要の形）と、`packages/{openai,anthropic,local-embedding}/src/__tests__/constructor-numeric-options.test.ts`。
  5. 文書: 各 TSDoc、`packages/bullmq/README.md` の節（「検査しない」→「構築時に検査する」）、`packages/openai`・`anthropic`・`local-embedding` の README、CHANGELOG `### Breaking`、migration-v1 の 🔴 56。ADR 0477・0467 に追記（本文は書き換えない）。

- **採らなかった案**:
  1. **`start()` の中で検査して reject する**（0477 案2）。構築時のほうが早く、`resolveConcurrency` と並ぶ。`start()` が呼ばれない構成でも壊れた設定に気づく。
  2. **正規化する**（0477 案3）。黙って別の値で動くのは、断るより悪い。`jobName: ""` を既定に倒すのは公開の挙動の変更でもある。
  3. **scheduler の `every` を読み戻して確かめる**（0477 案4）。往復が1つ増え、`start()` が reject しうる。構築時の検査で原因の入力は塞がる。
  4. **`everyMs` を整数に限る。** 採らなかった。`1.5` は今動いており（BullMQ が切り捨てる）、断る理由が無い。決めた規則は小数を通す。
  5. **`temperature` に上限（2 など）を置く。** 採らなかった。上限は API・モデルごとに違う（Anthropic は 1 まで、OpenAI は 2 まで）。超えた値は API が断る。
  6. **新しい例外クラス・共有 export を作る。** 採らなかった。公開 API を増やすのはオーナーの領分。素の `TypeError`／`RangeError`／`Error` にした。
  7. **`typeof` と `Number.isFinite` の二重の確認を1つにする。** `Number.isFinite` は数でない値（文字列・bigint・null）に `false` を返すので、`everyMs` の `typeof` は実質冗長である【実測。変異で確かめた】。ただし `TypeError` と `RangeError` を分けるため、provider 側の `typeof` は意味を持つ。bullmq 側は読み手への明示として残した。

- **赤→緑・変異**【実測。ファイルを名指しして走らせた】:
  - 直す前の実装に当てた結果: bullmq `tick-driver.option-passthrough.test.ts` は 32 本中 17 本が赤（`everyMs` の不正値13・`jobName` の不正値4）。openai `constructor-numeric-options.test.ts` は 26 本中 17 本赤、anthropic は 14 本中 9 本赤、local-embedding は 21 本中 17 本赤。陽性対照（通る値・省略）は直す前から緑。
  - 直した後: すべて緑（bullmq 32、openai 26、anthropic 14、local-embedding 21）。
  - 変異（足りない実装）: `everyMs` の上限を外す→2本赤／下限を `< 0` に緩める→2本赤／`jobName` の空文字の検査を外す→1本赤／`temperature` の検査を外す→7本赤／`maxTokens` の検査を外す→9本赤／`numThreads`・`dimensions`（local-embedding）の検査を外す→各9本赤／`isSafeInteger` を外して `< 1` だけにする→openai 4本・local-embedding 8本赤、anthropic で `value < 1` を外す→3本赤。
  - 変異（やりすぎの実装）: `everyMs` に整数を要求→`1.5` の歯が赤／上限を `>=` にする→`MAX_SAFE_INTEGER` の歯が赤／下限を `<= 1` にする→`1` の歯が赤／`jobName` に `trim` を足す→空白の歯が赤／整数の判定を `isInteger` にする→`MAX_SAFE_INTEGER` 超の歯が赤／`value < 2`・`<= 0` にする→下限の歯が赤／`temperature` に上限 2 を置く→`5` の歯が赤。
  - 生き残った変異: bullmq の `typeof everyMs !== "number"` を外しても赤にならない（上の案7。`Number.isFinite` が同じ入力を断る等価な変異）。

- **引き受けた負債**:

  | # | 負債 | 再現 | 結果 | 緊急度 | 覆る条件 |
  |---|---|---|---|---|---|
  | 1 | 検査の小さい関数を3パッケージ（openai・anthropic・local-embedding）に重複して置いた | `option-check.ts` | 規則を変えるとき3箇所を直す | 低 | core などに共有の置き場を作ると決まったとき（公開 API の話） |
  | 2 | `everyMs` の `2^31` 以上など、大きすぎて実用にならない値は通る（`MAX_SAFE_INTEGER` 以下ならよい。次の発火が数十日〜数万年先になる） | `everyMs: 2 ** 40` | tick がほぼ来ない。止まるのでなく遅い | 低 | 上限を実用の値（24.8 日など）に引くと決まったとき |
  | 3 | `queueName` は検査しない（BullMQ が空文字・`:` を投げる。空白・日本語・300 文字は動く） | ADR 0477 | 変わらない | 低 | — |
  | 4 | `temperature` の上限は見ない | `temperature: 99` | API が 400 で断る | 低 | API ごとの上限を型で持つと決まったとき |
  | 5 | `maxBatchSize`・`retry.attempts` などの丸める流儀は残る（断る流儀と混在） | local-embedding の doc | 変わらない | 低 | 丸めを断るに替えると決まったとき |
  | 6 | 実 Redis で走る歯（`*.redis.test.ts`）は走らせていない | 下 | — | — | — |

- **これが覆るとしたら**: 実際に `"50"` や `NaN` の設定で動かしていた利用者が多く、構築時に落ちる害が大きいと分かったとき（文字列の数値を通す緩和を検討する）。`temperature` に API 共通の上限ができたとき。

- **測っていないこと**: 実 Redis での挙動（この変更は構築時に投げるだけで Redis へ繋ぐ前に落ちる。実 Redis の歯 `*.redis.test.ts` は、手元に Redis が無いので走らせていない。それらは正しい `everyMs`・`jobName` だけを使っているので、影響は受けないはず【判断】）。実 API（OpenAI・Anthropic）と実モデル（local-embedding）。`pnpm api:check`（build が要る。`index.ts` の export は変えていない）。examples（`examples/chat`）が壊れた値を渡していないこと（`temperature`・`dimensions` の呼び出しは読んだ範囲では正当な値だが、全部は走らせていない）。

- **追記（Issue #1785、2026-10-07）: `retry.attempts` の `±Infinity` だけを構築時に断る**。クローン miku の判断で、オーナーの判断ではない（[ADR 0220](./0220-issue-comment-author-does-not-distinguish-owner-from-agent.md)）。本文は書き換えていない。
  - **決めたこと**: `LocalEmbeddingProvider` の `retry.attempts` は、`Infinity`・`-Infinity` なら構築時に `RangeError`（`LocalEmbeddingProvider: retry.attempts must not be infinite, got Infinity`）。**丸める流儀は残す**——`NaN`・0以下は1回に丸め、小数は `<=` 比較で実質切り捨てる（`2.5` は2回）。ここは今までと同じ。有限でない値だけが、丸めの対象の外に出た。
  - **理由**【実測】: 構築時の検査が無かった間、`Infinity` は `#startLoad` のループを成功するまで回し続けた（注入した `sleep` を500回目で打ち切るまで、`createPipeline` は500回呼ばれた）。失敗が続くかぎり `warmup()`・`embed()` は返らず、`signal` の abort は呼び出しの「待ち」を切るだけで読み込みは止まらない。`-Infinity` は黙って1回に丸められていた。「無限」は有限の回数に丸めようがないので、丸める欄でもここは丸めの外に置く理由が立つ。
  - **採らなかった案**:
    1. **正の整数以外を全部断る**（`dimensions`・`numThreads` と同じ規則に揃える）。採らなかった。この ADR 本文が「丸める流儀のまま残す」と決めたこと、[ADR 0358](./0358-local-embedding-provider-splits-large-batches.md) 決定3が `maxBatchSize` を `retry.attempts` に揃えて丸めると決めたことを覆し、`NaN`・0・負・小数を渡している利用者まで壊す。Issue #1785 が問うているのは `Infinity` だけである。
    2. **`Infinity` を1回または既定の3回に丸める。** 採らなかった。この ADR の採らなかった案2（正規化する）が退けた「黙って別の値で動く」に当たる。
    3. **`Infinity` を「成功するまで再試行」という有効な値として約束する。** 採らなかった。失敗が続くと `warmup()` が返らず、abort でも止まらない振る舞いを、約束として引き受けることになる。
  - **破壊的変更**: 壊れるのは `retry.attempts` に `±Infinity` を渡している利用者だけ（`+Infinity` は構築時の例外になり、`-Infinity` は1回への丸めから例外になる）。オーナーが v1.X.0 での破壊的変更を許している前提は、本文の冒頭と同じ。
  - **引き受けた負債 #5 との関係**: 「丸める流儀が断る流儀と混在する」は残る。ただし `Infinity` はその外に出た。
  - **範囲外として残したこと**: `maxBatchSize` の `Infinity`（「分割しない」を表す有効な値。これまでどおり通す）。`retry.delayMs` の戻り値（`NaN`・負・`Infinity` を検証せず `sleep` に渡す。既定の `sleep` では約1msで発火する）と、`delayMs` に関数でない値を渡したときの扱い（構築は通り、失敗後に reject する）。
  - **測っていないこと**: 本物のモデル・実ネットワークでの挙動（注入した `createPipeline` だけで測った）。外部の利用者が `Infinity` を使っているかどうか。

- **追記（Issue #1963、2026-10-09）: 「生き残った変異」の bullmq の `typeof everyMs !== "number"` は、いまは生き残らない**。クローン miku の判断で、オーナーの判断ではない（[ADR 0220](./0220-issue-comment-author-does-not-distinguish-owner-from-agent.md)）。本文は書き換えていない。
  - **何が変わったか**: 上の「生き残った変異」は、この ADR を書いた時点の記録である。いまは `packages/bullmq/src/__tests__/tick-driver.option-passthrough.test.ts` の「⭐ ADR 0525: everyMs が %s（数でない）なら TypeError」（152 行目の `expect(() => make({ everyMs: value })).toThrow(TypeError)`）が、この検査を外すと赤になる。`Number.isFinite` が同じ入力を断る点は変わらないが、断る例外の型が `RangeError` になるので、`TypeError` を求める歯が見分ける（等価な変異ではなくなった）。
  - **確かめ方**【実測。2026-10-09、main `8dad21bc`】: `packages/bullmq/src/tick-driver.ts` の `assertEveryMs` の `if (typeof everyMs !== "number") {` を `if (false) {` に置き換え（1件一致のときだけ書き込む）、この試験ファイルだけを走らせた。この試験は `bullmq` を `vi.mock` で差し替えており Redis は要らない。結果は 84 本中 4 本赤（文字列 `'50'`・`null`・`undefined`・`bigint`。どれも `expected error to be instance of TypeError`）。控えから戻して `cmp` でバイト一致を確かめ、戻した後は 84 本とも緑。
  - **出所**: Issue #1963 のコメント（別の棚卸しが、この歯を読んで指摘した）。上の実測で、読んだ判定を確かめ直した。
