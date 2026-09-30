# ADR 0424: 「同じ内容」の比較を正規化し（NFC + trim、core で除く）、testkit と Postgres の入力の境界を揃える

- **状態**: 採用 (2026-09)
- **日付**: 2026-09-30

クローン miku の委譲先が書いた。オーナーの判断ではない（[ADR 0220](./0220-issue-comment-author-does-not-distinguish-owner-from-agent.md)）。
**オーナーが覆せる点は「これが覆るとしたら」にまとめてある。**

- **文脈**:

  探索（hunt-o）で、testkit と Postgres が揃っていない境界と、正規化されていない比較が見つかった。3つを1本の PR で直す。

  1. **O-3: contested の検出が、NFC と NFD の違いや末尾の空白1つだけで、同じ文を矛盾と判定する。**
     `MemoryStore.findActiveByClaimKey?` / `findContestedByClaimKey?` は「同じ内容」の行を生の `content_hash <> …` だけで除く。
     `content_hash` は生の文字列の sha256（`packages/postgres/src/content-hash.ts`）なので、見た目が同じ「が」（NFC と NFD）や、
     末尾の空白1つだけが違う文は別の hash になり、一致に数えられて `contested` になる。
  2. **O-5: `packDigestBand` の1件の切り詰めが UTF-16 単位で切る**（`sliceWithoutSplittingSurrogatePair`）。サロゲートペアの内側は避けるが、
     書記素の途中は避けない。NFD の「が」（`か` + 結合濁点）は「か」になり、ZWJ で繋いだ絵文字は ZWJ だけが残る。
  3. **O-6: testkit と Postgres で入力の境界が揃っていない。**
     (1) lexical の検索語の NUL: Postgres は DB の生の例外（`invalid byte sequence for encoding "UTF8": 0x00`）、testkit は0件を返す。
     (2) `vector` の成分が float4 に収まらない（`1e308`）: Postgres の upsert と検索は `"1e+308" is out of range for type vector` の生の例外、
     testkit は `Math.fround` で Infinity にして保存し、距離が `NaN` になる。
     (3) `contentHash` の NUL: Postgres は生の例外、testkit は検査が無く保存する（`content`・`digest`・`tags`・`subjectId` の NUL は既に明示の例外）。

- **決めたこと**:

  1. **O-3: 比較用の正規化は NFC の後に `trim()`。core の `Runtime.detectClaimKeyContested` が、store から返った行について
     `content` を正規化し、検出中の memory の `content`（同じ正規化）と等しい行を、件数を数える前に除く。**
     既存の `sourceObservationId` の除外（[ADR 0377](./0377-claim-key-contested-detection-excludes-same-observation-siblings.md)）と同じ場所・同じ形で行う。
     `matches` を使う分岐（1件の `markContested`・`contested_group`・evidence だけ）は、すべてこの除外の後の値を見る。
     正規化の関数は1箇所（`packages/core/src/content-comparison.ts` の `normalizeContentForComparison`。公開しない）。
  2. **`content_hash` の値は変えない。** 保存値（`content`）も変えない。正規化は比較の前だけで使う。
     hash を正規化した文字列の sha256 にすると、既存の行の hash と互換がなくなる。再取り込みの冪等性の一意制約
     （`uq_memories_extraction` は `content_hash` を含む）が既存の行に対して崩れるか、DB の移行と再計算が要る。
  3. **store の口の契約・引数は変えない。** 除外は core が返り値を使うときに行う（ADR 0377 と同じ判断）。
     SQL 側（`normalize()`）には入れない——Postgres の `normalize()` は `SQL_ASCII` の DB で使えない（CI に SQL_ASCII の脚がある）。
     core で行えば、DB の encoding にも adapter にも依らず、自前の `MemoryStore` 実装も同じ規則になる。
  4. **O-5: 切り詰めは書記素の境界で行う。** `packages/core/src/text-truncation.ts` に `sliceAtGraphemeBoundary` を足し（`Intl.Segmenter`、
     `maxLength`（UTF-16 コードユニット）以下に収まる最長の書記素の並びを返す。最初の書記素だけで超えるなら空文字列）、
     `packDigestBand` だけがこれを使う。単位は UTF-16 コードユニットのまま（`maxEntryChars` の意味は変えない）。
     `Intl.Segmenter` は Node 22 の組み込みで、依存は増えない（`engines.node >= 22`。`lib: ES2022` の型に在る）。
     **`sliceWithoutSplittingSurrogatePair` の他の呼び出し元（`extraction.ts` のフォールバック digest、`failure-description.ts`）は変えていない。**
     同じ欠陥を持つが、フォールバック digest は保存される値であり、`failure-description.ts` は診断文であって、別の影響の見積もりが要る。
  5. **O-6: 3つとも、testkit と Postgres の両方で、DB に触れる前の明示の例外で断る。** 例外の種類と文言は既存の NUL 拒否（testkit の
     `InMemoryMemoryStore` の `content`・`digest` など）に倣う。
     - lexical の検索語の NUL: `Error`（`… query must not contain NUL characters (U+0000)`）。`PostgresLexicalStore` と
       `PostgresTrigramLexicalStore` の両方。
     - `contentHash` の NUL: `Error`（`… contentHash must not contain NUL characters (U+0000)`）。Postgres は `createMemory`・
       `createMemoryWithOutbox`・`createMemoriesWithOutboxAndEvents`（候補ごとの SAVEPOINT の中なので、その候補だけが落ちる）・
       `supersedeWithNewMemories`（トランザクションを開く前）。
     - `vector` の upsert の成分が float4 に収まらない: `RangeError`（`… vector component [i] does not fit in a float4 (pgvector) value`）。
       `Math.fround` が有限にならない成分（`1e308`、`NaN`、`Infinity`）が対象。
     - **`vector` の検索のクエリは投げない（依頼の文面からの逸脱。下に理由）。**
     適合テスト（`describeLexicalStoreConformance`・`describeVectorStoreConformance`・`describeMemoryStoreConformance`）に `it` を足し、
     破壊的変更として数える。

- **検討した代替案**:

  - **O-3: `content_hash` を正規化した文字列の sha256 にする。** 上の決めたこと2の理由で不採用。
  - **O-3: SQL 側で `normalize(content, NFC)` を比べる。** `SQL_ASCII` で使えない。口の契約も変わる。不採用。
  - **O-3: store の口に「比較用の hash」の引数を足す。** 口の契約の変更になり、自前の実装全部に波及する。不採用。
  - **O-5: `sliceWithoutSplittingSurrogatePair` 自体を書記素の境界に変える。** 呼び出し元3つの振る舞いが一度に変わる。今回は `packDigestBand` だけ。
  - **O-6(2): 検索のクエリも float4 に収まらなければ投げる。** 依頼の文面はそうだったが、採らなかった。`NaN`・`Infinity`・次元の不一致のクエリは、
    Postgres が既に「比較不能（全 0 ベクトルに差し替える）」として投げない設計であり（`toComparableQuery`、[ADR 0040](./0040-zero-vector-never-returned.md)
    の経路。`recall()` は `score_not_comparable` に数える）、testkit も以前から距離を `NaN` にしていた。`1e308` だけ投げると、`RecallQuerySchema` の
    `z.number()` を通る有限の値で `recall()` 全体が reject される一方、`Infinity` は通らない、という非対称ができる。
    **有限でない値と同じ扱い（投げない）に Postgres を揃えた。** 投げる形に変えるなら、`toComparableQuery` の1条件と適合テストの1本を変えるだけで足りる。
  - **O-6: 識別子（tenantId など）の NUL も同じ関数で断る。** 別の担当（O-1）の範囲。この ADR では扱わない。

- **引き受けた負債**:

  - 正規化は NFC + trim だけである。NFKC（互換文字。全角と半角など）、大文字小文字、内部の空白の畳み込み、ゼロ幅文字の除去は扱わない。
    それらが違う文は、今までどおり別の文として矛盾になりうる。
  - store は今も生の hash で除くので、NFC と NFD だけが違う行を余計に返す（core が後で除く）。件数の大きい claim key では、余計な行を読む。
    `LIMIT` の規定が口に無いのは ADR 0377 と同じ。
  - `sliceWithoutSplittingSurrogatePair` の他の呼び出し元（`extraction.ts`・`failure-description.ts`）は、書記素の途中でまだ切る。
  - `findActiveByClaimKey?` などの `contentHash` の引数に NUL を渡した場合の Postgres の例外は、生の例外のまま（書く口だけを揃えた）。
  - 適合テストの `it` は自前の実装にも課される（破壊的変更として数える。`docs/migration-v1.md` の項目43〜45）。

- **これが覆るとしたら**:

  - 比較用の正規化を NFKC などへ広げたい、または正規化した hash を持ちたい、という判断が出たとき（hash の移行を伴う）。
  - `vector` の検索のクエリも投げる方が良い、と決まったとき（上の代替案。1条件で変えられる）。
  - store の口が「比較用の hash」を持つ設計に変わったとき（その時点で core の除外は要らなくなる）。

- **測ったこと**:

  - 赤→緑はいずれも PR の commit 列に残る（赤のテストだけの commit を先に push した）。O-3 は core の Fake と Postgres（UTF8・SQL_ASCII）の両方で、
    NFC/NFD の組と末尾の空白1つの組が `contested` にならないことを検査する（陽性対照として、本当に違う文は `contested` になる）。
  - O-6 の元の失敗は `hunt-o/m18.mjs`・`m22.mjs` 相当を再実行して確かめた: Postgres（UTF8・SQL_ASCII）は
    `invalid byte sequence for encoding "UTF8": 0x00`（contentHash・検索語）と `"1e+308" is out of range for type vector`（vector）、testkit は保存または0件だった。
  - 【確かめていないこと】自前の `MemoryStore` 実装が、追加した `it` でどれだけ落ちるか。`Intl.Segmenter` の書記素の規則が Node の版で変わったときの境界の差。
