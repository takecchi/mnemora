# ADR 0525: 構成値の検査の例外の型を揃える — `createBullmqTickDriver` と `DeterministicEmbeddingProvider` を、型の誤りは `TypeError`・範囲の誤りは `RangeError` にする

- **状態**: 採用 (2026-10)
- **日付**: 2026-10-02

クローン miku の決定。担い手が書いた。オーナーではない（[ADR 0220](./0220-issue-comment-author-does-not-distinguish-owner-from-agent.md)）。
出所の区別: 【現物】は読んだコード、【実測】は手元で走らせた結果、【判断】は担い手の判定、【未確認】は確かめていないこと。

- **文脈**: [ADR 0498](./0498-constructor-config-checks.md) は provider のコンストラクタの数値オプションを「型が違えば `TypeError`、数として不正なら `RangeError`」で断ったが、`createBullmqTickDriver` の `everyMs`・`jobName` は既存の `resolveConcurrency` に合わせて素の `Error` にした（0498 決定1）。同じ「構成値が壊れている」検査なのに、パッケージによって型が違う。ADR 0523 の突き合わせがこの不揃いを見つけ、文書は型を約束していないのでずれではないが、揃えるかは決めていない、と書いた。クローンが「揃える」と決めた。
- **決定**:
  1. **構成値（コンストラクタ・ファクトリ関数のオプション）の検査で素の `Error` を投げていた所を、型の誤りは `TypeError`、範囲の誤りは `RangeError` にする。** 形は `packages/openai/src/option-check.ts` の `assertPositiveSafeInteger`・`assertFiniteNonNegative`（`typeof` が違えば `TypeError`、そうでなければ `RangeError`）。
  2. **文言は変えない。型だけを変える。** 型と範囲を1つの条件でまとめて判定していた所は、条件を `typeof` の判定と範囲の判定に分けて投げ分ける。message の文字列は同じ変数に1度だけ組み、2つの `throw` で共有した。
  3. 対象（【現物】）:

     | 場所 | 型の誤り（`TypeError`） | 範囲の誤り（`RangeError`） |
     |---|---|---|
     | `packages/bullmq/src/tick-driver.ts` `resolveConcurrency`（`concurrency`） | 数でない（`"2"`・`null`・bigint・オブジェクト） | 小数・`NaN`・`Infinity`・`1` 未満 |
     | 同 `assertEveryMs`（`everyMs`） | 数でない（`"50"`・`null`・`undefined`・bigint） | 非有限・`1` 未満・`MAX_SAFE_INTEGER` 超 |
     | 同 `resolveJobName`（`jobName`） | 文字列でない（渡したとき） | 空文字 |
     | `packages/testkit/src/__fixtures__/deterministic-embedding-provider.ts` コンストラクタ（`space.dimensions`） | 数でない | 小数・非有限・`0` 以下 |
  4. **公開 API は増えない。** 新しい例外クラスは作らない（組み込みの `TypeError`・`RangeError` だけ）。既定値も変えない。落ちる入力は増えも減りもしない（以前から落ちていた入力が、別の型で落ちるだけ）。
  5. 歯: `packages/bullmq/src/__tests__/tick-driver.option-passthrough.test.ts`・`tick-driver.test.ts`、`packages/testkit/src/__tests__/provider-fakes-align.test.ts`。`toThrow(TypeError)` だけでなく `.not.toThrow(RangeError)`（逆も）を置いたので、2つの型の取り違えも赤になる。message の逐語の歯も足した（文言を変えていない証拠）。
  6. 文書: CHANGELOG `[1.2.0]` の `### Changed`、migration-v1 の 🟡「v1.1.0 → 次の版で、挙動が変わるが手順は要らないもの」、`CreateBullmqTickDriverOptions` の TSDoc（`everyMs`・`jobName`・`concurrency`）、`packages/bullmq/README.md` の表。0498 の項目（CHANGELOG `### Breaking`・migration-v1 🔴 56）にあった「bullmq は素の `Error`」の括弧は、現在の状態を指すポインタなので、本ADRへ向けて直した（ADR 0498 本文は触っていない）。
- **見える変化**: どちらも `Error` の子なので `instanceof Error` は壊れない。`err.name`・`err.constructor` を `Error` と比べる呼び出し側にだけ見える。そのような呼び出し側は、migration-v1 の 🟡 で見直しを促した。
- **探した範囲と判定**【現物・実測】: `packages/{core,testkit,openai,postgres,anthropic,local-embedding,bullmq}/src` の `.ts`（`__tests__`・`*.test.ts`・`bench/` を除く。`testkit` の `__fixtures__` は publish 対象なので含める）に、次の形を当てた。
  - `grep -rnE "new Error\(" <各 src>`（素の `Error` の生成。ヒットを全部読んで分類した）
  - `grep -rnE "throw Error\(|= Error\("`（`new` 無しの形。ヒット無し）
  - `grep -rnE "extends (Error|TypeError|RangeError)"`（独自の例外クラスの一覧。構成値の検査に使われているものは無かった）
  - `grep -rnE "new (TypeError|RangeError)\("`（既に揃っている所の一覧）
  - `grep -rnE "function (resolve|assert|validate|check|normalize|parse)[A-Za-z]*\("`（構成を解決・検査する関数の洗い出し。`new Error(` に出ない経路を探すため）
  - `grep -rnE "throw [a-zA-Z]+\("`（`throw fail(...)`・`throw memoryNotFound(...)` のような、例外を作る関数経由の形）
  陽性対照: `new Error\(` の形が、既知の bullmq の3件（`resolveConcurrency`・`assertEveryMs`・`resolveJobName`）を `packages/bullmq/src/tick-driver.ts` から拾うことを、変更前の状態で確かめた（`start()` の `stop()` 後の呼び出しの1件とあわせて4件が出た）。変更後は同じ形で構成値の3件が出なくなる。
  判定（ヒットのまとまりごと）:
  - **対象**: 上の表の4か所。
  - **対象外（状態の誤り）**: bullmq `start()` を `stop()` 後に呼ぶ検査、local-embedding の `#assertNotDisposed`（`dispose()` 後の呼び出し）、postgres `buildArchiveDecayedTargetSelect` の `opts.nowSeq` 必須（メソッド引数と clock の組）。
  - **対象外（実行時の入力・メソッド引数・store の行）**: core の `Runtime.*`（`observe`・`tick`・`reextract` など。0496・0500 の面）、`tenant-settings-store.ts` の `assertValid*`（設定を書くメソッドの引数）、postgres の `PostgresMemoryStore` などの `memory not found for tenant`・`half-life-float4.ts`（`NewMemory` の入力）・`input-check.ts`（NUL）、testkit InMemory の `limit` の検査（メソッド引数）、`assertStorable*`（書き込む行）。
  - **対象外（外部の応答・自分以外の契約違反）**: openai・local-embedding の応答の件数・index・次元・有限性、`RelationStore.listRelatedMany` の戻りの件数、LLM が空白だけの content を返した、anthropic の `z.record` の検査（スキーマの内容）、postgres の `migrate.ts` の失敗の包み。
  - **対象外（テスト・ベンチの道具）**: testkit の conformance suite、`bench/` の環境変数の検査（公開しない CLI の道具）。
  - **境目（変えていない。下の「オーナーの判断を仰ぐ・決めきれなかったもの」）**: `assertSafeSchemaName`・`assertSafeIdentifier`（postgres。文字種・長さ）、`registerEmbeddingSpace` の `space.dimensions`、openai・anthropic の `assertApiKeyFitsInHeader`、local-embedding の `repo`/`modelId` の組、testkit の `SeededLLMProvider`・`SeededEmbeddingProvider`・`RecordedLLMProvider`・`RecordedEmbeddingProvider` の期待との不一致、`CassetteRecorder` の記録の不一致、core `recall` の `lexicalStore` 無しで `channels` に `lexical`。
- **オーナーの判断を仰ぐ・決めきれなかったもの**（変えていない）:
  1. **文字列の形式の誤り**（`assertSafeSchemaName`・`assertSafeIdentifier`・`assertApiKeyFitsInHeader`）: 型は合っている（`string`）のに、中身が許す形でない。`TypeError` とも `RangeError` とも言い切れない。`schema`・`extensionSchema` は `createPostgresClient`・`runMigrations`・CLI から呼ばれ、`assertSafeIdentifier` はメソッドの内部（`table` の導出）からも呼ばれる共有の関数なので、構成の検査とだけは言えない。
  2. **値どうしの不一致**（seeded・recorded の期待との不一致、local-embedding の `repo`/`modelId`）: 型でも範囲でもなく、2つの構成が食い違っている。
  3. **`registerEmbeddingSpace` の `space.dimensions`**: 範囲の誤りだが、コンストラクタでもファクトリでもなく、DB に表を作る関数の引数。構成の検査か実行時の入力かが決めきれない。直すなら `RangeError`/`TypeError` の分け方は本ADRと同じで足りる。
  4. **例外クラスを足さない**: 呼び出し側が構成の誤りを `catch` で見分けたいなら、組み込みの `TypeError`・`RangeError` の2つで足りる（本ADR）。専用のクラスや `code` を足すのは公開 API の拡張で、オーナーの領分。
- **採らなかった案**:
  1. **素の `Error` のまま、provider 側を `Error` に戻す。** 0498 が `TypeError`/`RangeError` を選んだ理由（呼び出し側が型で見分けられる、`eraseTenant`・`Runtime.tick` など既存の面と同じ）が、bullmq にも当たる。クローンが「揃える」と決めた。
  2. **共有の検査関数を作る（core などに置く）。** 公開 API が増える（オーナーの領分）。0498 の負債1（3パッケージへの重複）を増やさないよう、bullmq には関数を足さず、既存の3つの関数の中で分けた。
  3. **message を型ごとに直す**（「must be a number」「must be >= 1」）。依頼で「文言は変えない」と決まっている。message を変えると、message を比べている呼び出し側にも壊れが及ぶ。
  4. **境目のものまで一緒に変える。** 上の1〜3は型の分け方自体に議論の余地があるので、変えずに分けた。
- **引き受けた負債**:

  | # | 負債 | 再現 | 結果 | 緊急度 | 覆る条件 |
  |---|---|---|---|---|---|
  | 1 | 構成値の検査の型が、境目のもの（文字列の形式・値の不一致・`registerEmbeddingSpace`）では素の `Error` のまま残り、パッケージの中に2つの流儀が混ざる | `createPostgresClient("...", { schema: "Bad" })` は素の `Error` | 型で見分ける呼び出し側は、これらだけ `Error` で受ける必要がある | 低 | オーナーが、形式の誤りの型（例えば `RangeError`）を決めたとき |
  | 2 | 検査の関数が、provider の3パッケージ・bullmq・testkit に別々に在る | 各ファイル | 規則を変えるとき複数を直す | 低 | 共有の置き場を作ると決まったとき（0498 の負債1と同じ） |
  | 3 | 走らせた歯は Redis・DB を要らないものだけ（`vi.mock("bullmq")` の形）。実 Redis の歯（`*.redis.test.ts`）は正しい値しか渡さないので影響しないはずだが、走らせていない | — | — | — | — |

- **これが覆るとしたら**: 呼び出し側が `err.name === "Error"` や `err.constructor === Error` で構成の誤りを見分けており、更新後に見落とした害が大きいと分かったとき。文字列の形式の誤りに別の型（例えば専用のクラス）を与えると決まったとき。

- **赤→緑・変異**【実測。ファイルを名指しして走らせた】:
  - bullmq（`tick-driver.test.ts`・`tick-driver.option-passthrough.test.ts`、56 本）: 変更後は全部緑。`TypeError` と `RangeError` の両方を `Error` に戻す変異 → 18 本赤。`TypeError` だけを `Error` に戻す → 9 本赤。`RangeError` だけを `Error` に戻す → 10 本赤。いずれも元に戻すと 56 本緑。
  - testkit（`provider-fakes-align.test.ts`、52 本）: 変更後は全部緑。両方を `Error` に戻す変異 → 9 本赤（`ADR 0525: dimensions=…` の名前の it）。元に戻すと 52 本緑。
  - 変異の戻しは、ファイルの退避コピーを上書きする形で行った（`git checkout` は使っていない）。
- **測っていないこと**: 実 Redis での `createBullmqTickDriver`、`pnpm api:check`、全パッケージの全テスト（名指しした2パッケージ・3ファイルだけ走らせた）。`examples/chat` が `err.name`・`constructor` で例外を見分けていないことは、grep で見た範囲では無い【判断】。
