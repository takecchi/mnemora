# ADR 0433: claim key の長さに上限を置く・負の類似度の順位を文書に書く・未登録の埋め込み空間を型付きの例外にする・`reembed` の `limit` を入口で検査する

- **状態**: 採用 (2026-10)
- **日付**: 2026-10-01

クローンの委譲先（マネージャー mgr-0629e6a2）が書いた。直し方はクローンが決めた。オーナーの判断ではない（[ADR 0220](./0220-issue-comment-author-does-not-distinguish-owner-from-agent.md)）。
**オーナーが覆せる点は「これが覆るとしたら」にまとめてある。**
出所の区別: 【現物】は読んだコード、【実測】は手元で走らせた結果、【判断】は担い手の判定。

- **文脈**:

  穴探しの13巡目で見つかった4件を、1本の PR にまとめた。どれも「呼び出し側が渡した値・状態が、今の実装の想定を外れたときに、分かりにくい落ち方をする」ものである。

  **(1) claim key の長さ。**【現物】`ClaimKeySchema`（`packages/core/src/claim-key.ts`）は `z.string().min(1)` だけで、`deriveClaimKeys` は正規化（NFKC・trim・小文字化・空白を `_` に畳む）と、空文字列になった要素の `null` 化だけを行う。一方 Postgres の `idx_memories_claim_key`（migration 0021、btree、`(tenant_id, subject_id, claim_key_subject, claim_key_predicate)`）は、1行が 2704 バイトを超えると INSERT が落ちる。
  【実測】偽の LLM が subject と predicate に 3200 字の hex を返すと、`observe(... claimKey: { enabled: true })` が `Failed query: INSERT INTO memories ...`（`index row size 6448 exceeds btree version 4 maximum 2704 for index "idx_memories_claim_key"`）を投げ、observation だけが残り memory は 0 件になった。
  ⚠ 同じ長さでも `"ab".repeat(1600)` のような繰り返しは落ちない（Postgres が索引の値を圧縮するため。実測）。落ちるのは圧縮が効かない値である。

  **(2) 負の類似度と順位。**【現物】連想枠の席の順位キーは `hit.similarity * score.total`（`recall-runtime.ts`）、段2の並びは `score.total` の降順で、`RecallAssociationQuery.minSimilarity`（`z.number().optional()`）も `scoreThreshold` も値の範囲を検査していない。類似度（`1 - distance`）は −1 まで下がるので、これらを負にすると負の類似度の候補が通り、順位キーが「絶対値の小さいほど上」になる。`decay` が小さい（古く弱い）記憶ほど 0 に近く、上位に来る。

  **(3) 未登録の埋め込み空間。**【現物】`PostgresVectorStore` は空間ごとの表 `memory_embeddings_<space>` を引く。`registerEmbeddingSpace` を呼んでいない空間で recall すると、drizzle が包んだ、`kind` を持たない素の `Error`（`cause` が SQLSTATE 42P01 の `relation "memory_embeddings_..." does not exist`）が出る。ADR 0418 が整えた「`kind` と判定関数を持つ store 例外」の形に、この例外だけ入っていなかった。

  **(4) `Runtime.reembed` の `limit`。**【現物】`reembed` は `opts` を検査せず `MemoryStore.requeueEmbedJobs` へ素通しし、Postgres 実装は `LIMIT ${opts.limit}` に渡す。`limit` を省くと `syntax error at or near "FOR"` になる。

- **決めたこと**:

  1. **`deriveClaimKeys` は、正規化のあとで長さが上限を超えた `subject`・`predicate` の要素を含む鍵を `null` にする。**
     - **上限は 256 コードポイント**（`subject`・`predicate` のそれぞれに。値は `claim-key.ts` の `MAX_CLAIM_KEY_PART_CODE_POINTS`）。**数え方はコードポイント**（`Array.from(value).length`。UTF-16 の単位数ではない。絵文字などのサロゲートペアを1と数える）で、**正規化（NFKC・小文字化・`_` への畳み込み）のあとの文字列**を測る。NFKC で伸びる文字（`ﬃ` は 3 文字になる）も、伸びたあとの長さで数える。
     - **形と場所は、空白だけの要素を `null` にする既存の扱いと同じ**（`deriveClaimKeys` の `claims.map` の中の同じ条件）。`ClaimKeySchema` に `.max` を足して throw させる形は採らなかった（代替案1）。
     - **根拠（バイトの見積もり）**: 索引の1行は「`tenant_id` + `subject_id` + `claim_key_subject` + `claim_key_predicate` + 行の見出し」で、2704 バイトまで。UTF-8 で1コードポイントは最大4バイトなので、256 字 × 4 バイト × 2（subject と predicate）= **2048 バイト**。残り 656 バイトを `tenant_id`・`subject_id`・見出しに残す。
       - 【実測】（手元の Postgres 17）行のサイズは、値の合計バイト数 + `tenant_id` と `subject_id` のバイト数 + 約 24 バイトだった（合計 2400 + ids 600 のとき `index row size 3024`）。**256 字の4バイト文字を subject と predicate の両方に入れ、`tenant_id`・`subject_id` に 300 字ずつ入れても INSERT できた**（2048 + 600 + 約 24）。4バイト文字で 300 字ずつ（合計 2400）に ids 600 を足すと落ちた（`index row size 3024`）。
       - **目安に置いていた 512 字は採らなかった**。【実測】512 字ずつでは、4バイト文字（合計 4096）は ids が 1 バイトずつでも落ち（`index row size 4120`）、3バイトの漢字（合計 3072）も ids が 300 バイトずつで落ちた（`index row size 3696`）。「複数バイト文字でも届かない余裕」を満たすには、512 字では足りない。
     - **印は付けない**。【現物】`DeriveClaimKeysResult.failure` は LLM 呼び出し全体の失敗と件数の不一致（`claim_key_length_mismatch`）のためのもので、要素ごとの `null`（空白だけの要素）には印が無い。上限超えも同じ扱いにした。呼び出し側から見えるのは `claimKeys[i] === null` までで、「長すぎたから」と「LLM が鍵を返さなかったから」は区別できない（引き受けた負債）。
     - `tenant_id`・`subject_id` の長さは mnemora が制限していない（利用者が渡す値）。この2つが長ければ、256 字でも索引の行が超えうる（引き受けた負債）。
  2. **負の類似度の順位は、文書だけを直す。** `docs/recall.md` §9.2（手順の直後、`anchorCount` の天井の節の前）と、TSDoc（`RecallAssociationQuery.minSimilarity`・`RecallQuery.scoreThreshold`）に、負にすると連想枠の席の順位・段2の並びが単調でなくなる（古く弱い記憶ほど上位になりうる）ことを書いた。値の範囲の検査は足していない（代替案2）。
     - 【判断】`minSimilarity` は既定 0.5 で、負の類似度を通さない。逆転が起きるのは `minSimilarity` を**負にしたときだけ**。段2も、`scoreThreshold`（既定 0.1）を**負にしたときだけ**（`total` が負で閾値以上になる）。依頼文は「`scoreThreshold <= 0` かつ `similarity < 0`」と書いていたが、`total = 負` は `scoreThreshold = 0` では `total >= 0` を満たさず落ちるので、文書には「負」と書いた。
  3. **未登録の埋め込み空間は、`kind: "embedding_space_not_registered"` を持つ `EmbeddingSpaceNotRegisteredError` を投げる。**
     - **置き場**は `@mnemora/core` の `interfaces/vector-store.ts`（他の store 例外と同じ。判定関数は ADR 0418 の `matchesStoreErrorKind` を使う）。公開する: クラス `EmbeddingSpaceNotRegisteredError`（`space`・`kind`・`cause`）と判定関数 `isEmbeddingSpaceNotRegisteredError`。公開 API は追加のみ（`scripts/__snapshots__/public-api/core.d.ts` に6行）。
     - **包む口**は、【実測】未登録の空間で落ちる5つ: `PostgresVectorStore` の `upsert`・`search`・`searchMany`・`delete`・`getVectors`。全 space を列挙して掃く `deleteAcrossSpaces`・`eraseTenant` は、もともと未登録の空間を引かないので変えていない。
     - **Postgres の 42P01（`undefined_table`）を見分けて包む。**判定は「`cause` の連鎖のどこかが `code === "42P01"` で、message がその空間の表名の `does not exist` を指している」こと。`memories` など別の表が無いときの 42P01 は包まない（生のまま出る）。原因の Error は `cause` に残す。
     - **投げる入力そのものは変えない**。今 throw しない入力（形式不正な id だけの `delete`・`getVectors`、空の `searchMany`、登録済みの空間）は throw しない（歯で縛った）。
     - 他の adapter（testkit の in-memory など）がこの例外を投げることは、適合テストの要件にしていない（`packages/testkit/src/*-conformance.ts` に足していない）。
  4. **`Runtime.reembed` は入口で `limit` を検査し、`RangeError`（`Runtime.reembed: limit must be a non-negative integer (got …)`）を投げる。** store を呼ぶ前に投げる。
     - **例外の型**は、`Runtime` が opts の値を検査する既存の口 `findCorrectionCandidates` の `limit`（`RangeError`）に揃えた。【現物】`Runtime` の入力を zod で検査する口（`observe`・`recall`）は、複数の欄を持つ入力の全体を schema で検査するもので、`RangeError` の口は1つの欄を手で見るものである。`reembed` の `opts` は `RequeueEmbedJobsOptions` を store と共有する型で、schema を持たないので、後者に揃えた。
     - **断る値は、今も例外になっている値だけ**: 省略（`undefined`）、数で 0 以上の整数でないもの（負・小数・`NaN`・±`Infinity`）。
     - 【実測】（手元の Postgres 17、対象の行が在る状態で `PostgresMemoryStore.requeueEmbedJobs` に渡した）**今成功する値**は、`0`（何も積み直さない）、2^63 未満の正の整数（`Number.MAX_SAFE_INTEGER` 以上の `2^62` を含む）、`null`（Postgres の `LIMIT NULL` は無制限）、数字の文字列（`"10"`）、`bigint`。**今例外になる値**は、`undefined`（`syntax error at or near "FOR"`）、`1.5`・`NaN`・`±Infinity`（`invalid input syntax for type bigint`）、`-1`（`LIMIT must not be negative`）、2^63 以上の数、数字でない文字列・真偽値・配列・オブジェクト。testkit の in-memory は整数でなければ、負なら、2^63 以上なら `Error` を投げる。
     - **`0` は断らない**（依頼文は不正な値の例に 0 を挙げていたが、0 は今成功する）。数以外の型（`null`・`"10"`・`bigint`）も断らない（今 Postgres で成功する）。2^63 以上の数も Runtime では見ない（今と同じく store の側で例外になる）。この3点は、依頼の「今成功している値は断らず報告」に従った。

- **検討した代替案**:

  1. **決定1で、`ClaimKeySchema` に `.max(...)` を足して、上限超えを throw させる。** 採らなかった。`ClaimKeyBatchResultSchema` は LLM の構造化応答の検証にも使われ、1要素が schema に合わないと、バッチ全体の検証が落ちる（他の要素の鍵まで取れなくなる）。空白だけの要素を `null` にする既存の扱いは「その要素だけ鍵が取れなかった」形で、こちらに揃えるほうが影響が小さい。クローンの指示でもある。
  2. **決定2で、負の `minSimilarity`・`scoreThreshold` を断る。** 採らなかった。値の範囲を絞るのは公開の入力の変更であり、今成功している呼び出しを断ることになる。クローンの指示は文書だけだった。
  3. **決定1で、上限を 512 コードポイントにする（依頼文の目安）。** 採らなかった。上の実測のとおり、512 字は最悪の場合（4バイト文字、3バイトの漢字）で 2704 バイトに届かない余裕が無い。
  4. **決定1で、上限をバイトで測る。** 採らなかった。要素の切り捨てではなく `null` にするので、どこで切れるかは問題にならないが、利用者・LLM が見るのは文字であり、コードポイントのほうが説明しやすい。最悪のバイト数（×4）で余裕を取るので、上限の判定を文字で行っても索引の行の上限は守れる。
  5. **決定1で、`subject`・`predicate` の合計で上限を掛ける。** 採らなかった。要素ごとの上限のほうが判定が単純で、空白だけの要素の扱い（要素ごと）と同じ形になる。
  6. **決定3で、Postgres 固有のクラスを `@mnemora/postgres` に置く。** 採らなかった。store 例外は core の `interfaces/*.ts` に置き、判定関数を公開する作法（ADR 0418）で揃っている。空間が登録されていない、という概念は Postgres 固有ではなく `VectorStore` の契約にある。
  7. **決定3で、`PostgresVectorStore` の5つの口に private メソッドを足して包む。** 採らなかった。公開 API の snapshot が `private xxxBody;` の行で動く。代わりに、各口の SQL を発行する箇所（`this.db.execute`・`withRelaxedOrderScan`）だけを `translateUnregisteredSpace` で包んだ。
  8. **決定3で、空間の存在を先に問い合わせてから引く。** 採らなかった。往復が1つ増える。落ちたあとに 42P01 を見分けるほうが、正常経路の費用を変えない。
  9. **決定4で、`limit` を省いたときの既定値を置く。** 採らなかった。`RequeueEmbedJobsOptions` の doc（ADR 0079）が、`limit` に既定値を置かないと決めている。
  10. **決定4で、`0` も断る。** 採らなかった。今成功する値を断ることになる（実測）。

- **引き受けた負債**:

  - **上限超えの鍵が黙って `null` になる。**呼び出し側は「長すぎた」ことを知れない。`observe` の結果の `claimKey` 側にも、`failure` にも出ない。空白だけの要素と同じ扱いである。
  - **`tenant_id`・`subject_id` が長いと、256 字の鍵でも索引の行が 2704 バイトを超えうる。**この2つの長さは mnemora が制限していない。実測で確かめたのは、両方 300 バイトのとき 256 字 × 4 バイト × 2 が通ることまで。
  - **`reembed` の `limit` に `null`・`"10"`・`bigint` を渡す呼び出しは、今も検査を通る**（Postgres が受け付けて成功するため）。とくに `null` は「無制限に積み直す」になる。断る直しは、今成功する呼び出しを壊すので、していない。
  - **`EmbeddingSpaceNotRegisteredError` を投げるのは `PostgresVectorStore` だけ。**他の adapter は、未登録の空間で従来の（自前の）落ち方のまま。`isEmbeddingSpaceNotRegisteredError` が `false` を返すことは、その空間が登録済みであることを意味しない。
  - **`PostgresVectorStore` の例外の `cause` には、drizzle の `Failed query: … params: …` が残る。** `Runtime` を通れば `omitParamsFromError`（ADR 0423）が `cause` の連鎖まで `params` を落とすが、store を直接呼ぶ呼び出しでは落ちない（ADR 0430 の負債と同じ）。
  - 決定2は文書だけで、負の値で順位が逆転する挙動そのものは残っている。

- **これが覆るとしたら**:

  - 上限超えの鍵に印が要る（呼び出し側が「長すぎた」を区別したい）という要求が出たとき。`DeriveClaimKeysResult` に欄を足す形になり、公開の型の変更になる。
  - `tenant_id`・`subject_id` の長さに上限が入ったとき。256 字の根拠（残り 656 バイト）を、その上限に合わせて見直せる（上限を広げる余地が出る）。
  - 負の `minSimilarity`・`scoreThreshold` を実際に使う呼び出し側が現れたとき。文書の警告ではなく、順位キーの側（絶対値ではなく `similarity` の符号を見る形）を直す判断になる。それは検索品質の設計の変更であり、オーナーの判断になる。
  - 他の adapter にも同じ例外を投げさせたいとき。適合テストに足す判断になる（`packages/testkit/src/*-conformance.ts` はこの ADR では触っていない）。
  - `reembed` の `limit` に `null` などを断りたいとき。今成功する呼び出しを断る変更で、破壊的変更として扱う。

- **測ったこと**（【実測】2026-10-01、手元の Postgres 17、UTF8（`C.UTF-8`）。歯を先に走らせて赤を見てから直した）:

  - 決定1:
    - `packages/core/src/__tests__/claim-key-oversized-part.test.ts`（3本）。直す前は3本とも赤（256/257 の境界、コードポイントの数え方と NFKC で伸びる文字、3200 字を返す偽の LLM でも `observe` が成功して鍵が `null`）。直した後は3本とも緑。既存の `claim-key.test.ts` を含む 36 件が緑。
    - `packages/postgres/src/__tests__/claim-key-oversized-part.postgres.test.ts`（2本）。直す前は「3200 字の hex（圧縮が効かない値）」の1本が赤（`index row size 6448 exceeds btree version 4 maximum 2704 for index "idx_memories_claim_key"`）で、もう1本（上限ちょうど、4バイト文字 × 256 を subject と predicate の両方に、`tenant_id`・`subject_id` は 300 字ずつ）は直す前から緑。直した後は2本とも緑。
  - 決定2: 文書だけ。走らせたテストは無い。`node scripts/check-doc-snippets.mjs` と、ADR・CHANGELOG・markdown-link 系の scripts のテストが通ることを確かめた。
  - 決定3: `packages/postgres/src/__tests__/vector-store-unregistered-space.postgres.test.ts`（8本: 5つの口それぞれ、今 throw しない入力、登録済みの空間の陽性対照、別の relation の 42P01 は包まない）。直す前は判定関数が無く 6本が赤（型が無いという理由）。直した後は 8本緑。`translateUnregisteredSpace` の判定を潰す変異（`if (false && …)`）で5つの口の5本が赤になり、戻すと緑に戻った（歯が噛むことの確認）。`store-error-guards.test.ts` に判定関数の項目を足した（88件が緑）。
  - 決定4: `packages/core/src/__tests__/reembed-limit-validation.test.ts`（8本: 省略・負・小数・`NaN`・±`Infinity` が store を呼ぶ前に `RangeError`、`limit` を欠いたオブジェクト、`0`・1・10・`Number.MAX_SAFE_INTEGER` が今までどおり通る）。直す前は7本が赤（`RangeError` ではなく testkit の fixture の `Error`）、通る1本は緑。直した後は8本とも緑。
  - 公開 API: `node scripts/check-public-api-surface.mjs` の差分は core への追加のみ（`EmbeddingSpaceNotRegisteredError`・`isEmbeddingSpaceNotRegisteredError`）。`--write` で snapshot を更新した。
  - **測っていないこと**: 2^63 以上の `limit` を Runtime で断らない挙動は、テストで縛っていない。`ﬃ` 以外の NFKC で伸びる文字。Postgres の SQL_ASCII の DB での claim key の歯。`deleteAcrossSpaces`・`eraseTenant` は未登録の空間を引かないことをコードで読み、`deleteAcrossSpaces` は歯に入れたが、`eraseTenant` は入れていない。`deriveClaimKeys` を通らない経路（`MemoryStore.createMemory` の `claimKey` に長い値を直接渡す呼び出し）は変えておらず、今も索引の上限で落ちると読んでいるが、走らせて確かめていない。
