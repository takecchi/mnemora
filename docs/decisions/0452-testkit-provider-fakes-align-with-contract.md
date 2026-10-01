# ADR 0452: testkit の provider の fake・カセットを `EmbeddingProvider`・`LLMProvider` の約束と本物に揃える・`recall()` のクエリ埋め込みが数値の型付き配列も受ける

- **状態**: 採用 (2026-10)
- **日付**: 2026-10-01

クローン miku の委譲先（担い手。マネージャー mgr-86b4be97 の指示による）が書いた。直し方の線（何を直し、何をオーナーに回すか）はクローン miku が決めた。オーナーの判断ではない（[ADR 0220](./0220-issue-comment-author-does-not-distinguish-owner-from-agent.md)）。
**オーナーが覆せる点は「これが覆るとしたら」にまとめてある。**
出所の区別: 【現物】は読んだコード、【実測】は手元で走らせた結果、【判断】は担い手の判定。

- **文脈**:

  穴探し24巡目の調査Aが、`@mnemora/testkit` が公開している provider の fake・カセット（`DeterministicEmbeddingProvider`・`RecordedEmbeddingProvider`・`SeededEmbeddingProvider`/`SeededLLMProvider`・`CassetteRecorder`・`RecordingEmbeddingProvider`/`RecordingLLMProvider`）と、
  `packages/core` の interface の約束・本物の provider（`@mnemora/openai`・`@mnemora/local-embedding`）とのずれを、読み・実走・変異試験で見つけた【実測】。
  conformance suite への約束の追加（オーナー判断。[ADR 0434](./0434-testkit-fixtures-align-nul-int4-invalid-date-purged-at.md) 決定5、`packages/testkit/src/index.ts` 冒頭の Issue #809 の方針）と、カセットの鍵の導出の変更（A-7）はこの ADR の対象外。

- **決めたこと**（候補の番号は調査A のもの）:

  1. **A-1: `SeededEmbeddingProvider` は構築時に、種の空間と `delegate.space` の食い違いを断る。** 以前は「種 vs `expectedSpace`」しか照合せず、`space` は `delegate.space` を名乗るので、別のモデルの種のベクトルを、別の空間を名乗る `space` の下で返せた【実測】。
     `SeededLLMProvider` に同じ形の穴は無い: `LLMProvider` には委譲先のモデル名を読む口が無く、照合する相手が無い（【現物】）。
  2. **A-2: Seeded\*・Recording\* は `opts`（`AbortOptions`）をそのまま delegate へ渡す。** 以前は4経路とも渡さず、abort 済みでも delegate が呼ばれ、abort 後も裏の実リクエストが切れなかった【実測】。
     ADR 0359 が決めたのは「conformance suite に abort の歯を足さない」「API に当てない擬似物が signal を無視してよい」であり、実 provider を包むラッパーの転送漏れは扱っていない（【判断】）。
  3. **A-3: Recording\* は進行中の呼び出しも memo する。** 同じ入力を並列に呼んでも delegate は1回だけ呼ばれ、呼び出し側が見た値と記録に残る値が一致する。以前は両方が delegate を呼び、後勝ちで先に呼んだ側の値が記録から消えた【実測】
     （`RecordingLLMProvider` の docstring の「記録は自分自身と矛盾しなくなる」は逐次の呼びでしか成り立っていなかった）。
     失敗した呼び出しは memo に残さない（待っていた側は同じ失敗を受け、次の呼び出しは delegate を呼び直す）。待つ側の `completeStructured` は、記録済みの値と同じく自分の `schema` で検証し直す。
     ⚠ 待っている側は、先に呼んだ側の `opts.signal` の abort も共有する（docstring に書いた）。
  4. **A-4: `CassetteRecorder` は、2回目以降の記録で埋め込み空間・モデル名が最初と違えば落とす。** 以前は後勝ちで上書きし、2つの空間のベクトルが混ざったカセットがヘッダだけ最後の空間を名乗った【実測】。同じ空間・モデルの2回目以降（同じキーの上書きも）は今までどおり。
  5. **A-5: 成分が有限の数であること・`space.dimensions` が正の整数であることを、読む時点（`assertCassette`）と再生の時点（`RecordedEmbeddingProvider.embed`）で確かめる。** 本物（`@mnemora/openai`・`@mnemora/local-embedding`）は応答の有限性を検査し、`space` は正の整数と決まっている（`EmbeddingProvider` の doc、conformance suite の既存の要件）。
     - **`entry.text` と鍵の元の一致も `assertCassette` に入れた。** 約束があると読んだ: `EmbeddingCassetteEntry.text`/`LLMCassetteEntry.prompt` の doc が「鍵の元になった入力。デバッグのために必ず併記する」と書いている（`cassette.ts`）。
       `examples/chat/cassettes/*.json` の全ファイル（埋め込み・LLM とも鍵が一致、成分は有限、次元はヘッダと一致）がこの検査を通ることを確かめた【実測。`.mgr-notes/r24-cassette-keys.mts`】。
     - **`RecordingEmbeddingProvider` は、delegate の壊れた戻り（次元違い・有限でない成分・配列でない）を記録せずに落とす。** 約束に照らして決めた: 壊れた値は `EmbeddingProvider` の約束違反で、記録するとカセットが壊れた値を持ち、再生で別の形で落ちる。
       ADR 0051 の「記録は素通し」は、約束を守った戻りを加工しないという意味に読み、約束違反の戻りまで素通しにする意味とは読まない（【判断】）。有限で次元の合う戻りは今までどおり記録して返す。
     - 入れなかったこと: カセットを読む時点でのベクトルの長さとヘッダの `dimensions` の照合。今は `embed` で当たった項目だけが落ちる。読む時点に前倒しすると、使わない項目が1つ古いだけでカセット全体が読めなくなり、落ちる入力が増える（【判断】）。
  6. **A-6: 返すベクトルと `space` の参照の共有をやめる。** `RecordedEmbeddingProvider`・`RecordingEmbeddingProvider`・`SeededEmbeddingProvider` は記録・種の配列のコピーを返す（呼び出し側が書き換えても次の再生・記録に漏れない）。
     `RecordedEmbeddingProvider`・`DeterministicEmbeddingProvider` の `space` はコピーを凍結したもの（以前はカセット／構築子の引数のオブジェクトそのもので、構築後に書き換わると `space.dimensions` とベクトル長が変わった）【実測】。
  7. **A-8: `DeterministicEmbeddingProvider` の構築子は、`dimensions` が正の整数でなければ断る。** 以前は 1.5・負・NaN は `embed` で `RangeError: Invalid array length`、`0` は空のベクトル（`[[]]`）を返していた【実測】。
     `0` も断る: conformance suite が `space.dimensions` に正の整数を要求している（既存の約束）。pgvector も0次元を受けない。今 `embed` が落ちるものの前倒しに、`0` を足した形。
  8. **`recall()` のクエリ埋め込みは、`Float32Array` などの数値の型付き配列も受ける（落ちる入力を減らす直し。ADR 0455 には分けず、この ADR に含めた）。**
     - **弾いていた場所**【現物】: `packages/core/src/recall-runtime.ts` の `if (!Array.isArray(vector)) { throw new QueryEmbeddingFailure("no_vector", …) }`（ADR 0393 の検査。当時の1106行目付近）。`vector.length`・`findIndex` は型付き配列でも使える。
       embed ジョブ（`runtime.ts` の `processEmbedJob`）は `Array.isArray` を見ず、型付き配列をそのまま `VectorStore.upsert` に渡す。`@mnemora/postgres` の `toVectorLiteral` は `vector.join(",")` なので通る。つまり、ingest は通るのに recall だけが `embedding_provider_unavailable` になる、という食い違いだった。
     - **直した形**: `toPlainVector`（配列、または数値の型付き配列。`DataView` は除く）で普通の `number[]` にしてから、既存の次元・有限性の検査をかけ、`VectorStore.search` へは配列で渡す。変更は `recall-runtime.ts` の1か所（約15行）で、`VectorStore`・`@mnemora/postgres` の bind・`processEmbedJob` には触れていない。
       配列でないもの（`undefined`・`DataView`・文字列・`length` だけのオブジェクト）、次元違い、有限でない成分は、今までどおり `embedding_provider_unavailable`。
     - **ADR 0455 に分けなかった理由**【判断】: 他の口へ波及しない（上のとおり1か所）、振る舞いが ingest と揃う、落ちる入力を減らすだけで新しい断りを足さない。
     - ⚠ これは conformance suite に足す話とは別。suite には足していない（`number[]` を要件にするかはオーナー判断のまま）。
  9. **触らなかったもの**: A-7（`embeddingCassetteKey` の孤立サロゲートの衝突、`llmCassetteKey` の `system: undefined` と `""` の別キー。キーを変えると既存カセット全部に影響する）。`*-conformance.ts`。

- **検討した代替案**:

  1. **Recording の memo をプロバイダーごとではなく `CassetteRecorder` に持たせる。** 採らなかった。1つの記録器を複数の provider で共有するのは想定外で、進行中の Promise は provider の呼び出しに属する。
  2. **Recording で、delegate の壊れた戻りも素通しで記録する。** 採らなかった（決定5）。
  3. **`assertCassette` で読む時点にベクトル長とヘッダの次元を照合する。** 採らなかった（決定5）。
  4. **Float32Array を `processEmbedJob` 側でも配列に変換する。** 採らなかった。今通っている経路を触らない（変更を recall だけに留める）。
  5. **型付き配列の受け入れを、別 PR（ADR 0455）にする。** 採らなかった（決定8）。

- **歯と変異試験**【実測】:

  - 歯: `packages/testkit/src/__tests__/provider-fakes-align.test.ts`（42 本）、`packages/core/src/__tests__/recall-query-embedding-typed-array.test.ts`（8 本）。
  - **直す前で赤**: testkit 42 本のうち 31 本が赤、core 8 本のうち 2 本（`Float32Array`・`Float64Array`）が赤。出力は作業メモの `red-before-0452-testkit.txt`・`red-before-0452-core.txt`（リポジトリには入れていない）。
  - **やりすぎで赤**（変異。結果は `mutations-0452.txt`）:
    - A-4: 同じ空間でも2回目の記録を落とす → 赤（22 本）。
    - A-3: 失敗した Promise を memo に残す（`finally` の削除を消す） → その歯が赤。
    - A-5: `assertCassette` が有限の正しいベクトルまで断る → 2 本赤。`Recording` が有限で次元の合うベクトルまで断る → 5 本赤。
    - A-8: 正の整数（1）まで断る → 1 本赤。
    - A-1: 同じ空間でも Seeded の構築を断る → 3 本赤。
    - A-6: `Recorded` が記録の配列をそのまま返す → 1 本赤。
    - core: 型付き配列を受けるが配列に変換せず `vectorStore` へ渡す → 2 本赤。
    - ⚠ core の「配列でないものまで受ける」変異は、次元・有限性の下流の検査が拾うため結果が変わらず、歯では区別できない（害の無い方向）。
  - 直したあとは両方とも全部緑。

- **引き受けた負債**:

  - 並列に待つ側が、先に呼んだ側の abort を共有する（決定3）。
  - A-7 は未着手。conformance suite に約束を足す話（`number[]` の要件・重複入力の件数）もオーナーの判断のまま。
  - `RecordedLLMProvider`/`Recording`/`Seeded` が返す LLM の応答オブジェクトは、記録の参照のまま（A-6 は埋め込みと `space` だけ）。
  - `@mnemora/testkit` の公開の振る舞いが変わる（不正な `dimensions`・壊れたカセット・違う空間の記録が、落ちるようになる）。落ちる入力が増える変更で、CHANGELOG に書いた。

- **これが覆るとしたら**:

  - オーナーが、testkit の fake の約束を本物より緩く保つ（壊れたカセット・不正な次元を黙って通す）と決めたとき。
  - `number[]` 以外のベクトルを `EmbeddingProvider` の契約として認めない（型付き配列を断る）と決めたとき。その場合、`processEmbedJob` 側も断る形に揃える。

- **測っていないこと**: 実 API。型付き配列を受けたときの Postgres への実際の保存（`join` で通ることを読んだだけで、`recall` の歯は store をフェイクで測っている）。
