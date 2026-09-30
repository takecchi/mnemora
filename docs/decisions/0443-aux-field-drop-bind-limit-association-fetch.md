# ADR 0443: LLM の補助の欄が保存できないときはその欄だけを落とす・id と検索クエリの件数によるバインド上限の崖を無くす・連想枠のアンカーごとの取得件数は絞らない

- **状態**: 採用 (2026-10)
- **日付**: 2026-10-01

クローンの委譲先（マネージャー）の委譲先が書いた。直し方はクローンが決めた。オーナーの判断ではない（[ADR 0220](./0220-issue-comment-author-does-not-distinguish-owner-from-agent.md)）。
**オーナーが覆せる点は「これが覆るとしたら」にまとめてある。**
出所の区別: 【現物】は読んだコード、【実測】は手元で走らせた結果、【判断】は担い手の判定。

- **文脈**:

  穴探しの続きで見つかった3件を、1本の PR にまとめた。

  **(1) 補助の欄。**【現物】抽出の候補（`ExtractedMemoryCandidate`）は、本文のほかに LLM が返す `digest`・`tags`、別の構造化呼び出しで得る claim key を持つ。これらのどれか1つが保存できない値だと、本文が正しくても `createMemoryWithOutbox` が拒み、候補ごと落ちていた（[ADR 0347](./0347-extract-write-path-redelivery-and-unsaveable-candidates.md) の「保存できない候補」の経路。落ちた候補は `created` の `meta.droppedCandidates` に残る）。補助の欄は要約や索引のための値で、本文より軽い。本文を道連れにするのは釣り合わない（[ADR 0433](./0433-claim-key-length-space-error-reembed-limit.md) が claim key の長さで同じ判断をした）。
  【実測】（手元の Postgres 17、UTF8 の `C.UTF-8`）保存できない値は2つあった。
  - **NUL（U+0000）を含む文字列**: text 列に入らない（`digest`・`tags`・claim key の3つとも）。testkit の fixture も `digest`・`tags` の NUL を拒む。
  - **`tags` の巨大な要素**: `idx_memories_tags`（GIN、`(tenant_id, tags)`）は、1要素が圧縮後でおよそ 2712 バイトを超えると INSERT が落ちる（`index row size 2816 exceeds maximum 2712`）。4バイト文字のランダムな値は、512 字（UTF-8 で 2048 バイト）は通り、700 字（2800 バイト）で落ちた。⚠ ADR 0433 と同じく、繰り返しなど圧縮が効く値は同じ長さでも通る。
  - **`digest` の長さ**: 索引が無い。【実測】10MB の値が text 列に入った（`memories` ではなく使い捨ての表で。`memories` への INSERT は、テストで 10 万字の digest が通ることを確かめた）。長さで落ちる根拠が見つからなかったので、長さは見ない。
  claim key の長さは ADR 0433 が決定済みである（256 コードポイントを超えれば `null`）。NUL は見ていなかった。

  **(2) id の数の崖。**【現物】`PostgresMemoryStore.reinforceMany` は、強化する行の `decay_floor_at` などを `VALUES ($1::uuid, $2::timestamptz, $3::boolean, $4::bigint, $5::bigint), …` と行ごとに5個のバインドパラメータで持ち込む。`memory_usage` の観測（`handleMemoryUsage`）は `recordUsageAndReinforce` → `reinforceManyOn` を通る。`PostgresVectorStore.searchMany` は `VALUES ($i::int, $vec::vector), …` と1クエリごとに2個を並べる。Postgres のバインドパラメータは 65535 個までである。
  【実測】`reinforceMany` は 13106 件が通り、13107 件で `bind message has 3 parameter formats but 0 parameters`（drizzle の `Failed query: … params: <全部>` に包まれ、message が数 MB になる）。40000 件では drizzle の `sql.join` が `Maximum call stack size exceeded` で落ちた。`searchMany` は 32000 件が通り、32767 件で落ちた。`memory_usage` は 13107 件の使用報告で落ちた。

  **(3) 連想枠のアンカー。**【現物】`recall-runtime.ts` の段3.5は、アンカー1つごとに `kPrime`（= `limit × overFetchFactor`）件まで引く。アンカー数は `min(anchorCount, limit, 段2を通った候補数)` なので、引く件数は最大でアンカー数 × `kPrime`、つまり `anchorCount` と `limit` の両方を上げると積で増える。クローンは「アンカーごとに引く件数を必要な分に抑える形を試し、結果が完全に一致すると示せたときだけ変える」と決めた。

- **決めたこと**:

  1. **補助の欄は、保存できない値だけを落とし、候補は残す。**
     - `digest` が NUL を含めば、無い（`undefined`）ことにする。あとの `resolveDigest` が、空・欠落と同じく本文の先頭を切り出したフォールバック（`digestSource: "fallback"`）へ倒す。
     - `tags` は、NUL を含む要素と、512 コードポイントを超える要素だけを捨てる。ほかの要素の並び・重複・前後の空白は残す。512 の根拠は、4バイト文字で 512 × 4 = 2048 バイトが、圧縮が効かなくても GIN の1エントリの上限（約 2712 バイト）に届かないこと（ADR 0433 の 256 字と同じ考え方）。数え方はコードポイント（`Array.from`）。
     - claim key は、正規化のあとの `subject`・`predicate` のどちらかが NUL を含めば `null` にする（`deriveClaimKeys`。長さの上限と同じ場所・同じ形。`failure` の印は付けない）。
     - 処理は `packages/core/src/llm-aux-fields.ts`（内部。`index.ts` からは出さない）。`observe`（sync・deferred）と `reextract` が、抽出の直後・claim key を引く前に `digest`・`tags` を通す。
     - **落とした欄は、`created` イベントの `meta.droppedFields` に残す**（何も落とさなければ `meta` の形は変わらない）。1件が `{ index, contentHash, field: "digest" | "tags", reason: "nul_character" | "too_long", count?, tagIndexes? }`。候補は `droppedCandidates` と同じ `index`（LLM が返した順の 0 起点）と `contentHash` で指し、**値そのものは写さない**。`tags` の `count` は捨てた数、`tagIndexes` は LLM が返した `tags` の中の添字で、先頭から 20 個まで（何万件でも `meta` を膨らませない）。同じ抽出で作られた記憶すべての `created` に同じ配列が入る（`droppedCandidates` と同じ形）。
     - 本文（`content`）の NUL はこの直しの対象ではない。従来どおり候補ごと落ちる（本文は落とせない）。
  2. **`reinforceMany` は `VALUES` をやめ、列ごとの配列5個を `unnest` で渡す。`searchMany` はクエリを 16384 件ずつに分けて、同じトランザクションの中で1文ずつ撃つ。**
     - `reinforceMany`: パラメータは件数によらず5個（と `tenant`・`at`）。1文のまま（原子性・往復数の「定数2往復」は変わらない）。`memory_usage` の観測は同じ口を通るので、同時に直る。
     - `searchMany`: 1クエリ 2 個 × 16384 = 32768 個と固定のパラメータで、65535 に収まる。各クエリの結果は他に依存しない（`LATERAL` の各行は独立）ので、分けても集合・順序は変わらない（歯で `search()` と比べた）。添字は全体の通し番号のまま送る。`SET LOCAL hnsw.iterative_scan` は同じトランザクションに1回。
     - **`searchMany` を `unnest` にしなかった理由**: クエリベクトルの配列を `vector[]` として渡すと `q.qvec` の型と実行計画が変わりうる。実行計画が変わらない形（同じ `VALUES`）のまま分けるほうが、`search-many-primary-key-lookup.postgres.test.ts` などの既存の歯の前提を保てる。
     - 例外の message: 崖より下の件数では例外にならない。【実測】存在しない id が混ざる 20000 件の `reinforceMany` の例外は `memory not found for tenant: <id>` の1行で、2000 文字に収まる（直す前は、同じ 20000 件で drizzle の `Failed query … params: …` が message になった）。
  3. **連想枠のアンカーごとの取得件数は絞らない。コードは変えず、TSDoc（`RecallAssociationQuery.anchorCount`）と `docs/recall.md` §9.2 に計算量（O(anchorCount × limit)）を書く。**
     - 試した形: 1アンカーあたりの件数を `min(kPrime, 席の過取得数 + 除外集合の大きさ)` にする（席に着きうる件数 + 除外される件数以上を引けば十分、という見積もり）。
     - 【実測】乱数の種を固定（`mulberry32`、種は 1〜300 と、`search` のみの `VectorStore` / `searchMany` ありの2種）し、同点が多くなる粗い格子のベクトル、ランダムな `limit`（2〜13）・`maxCount`（1〜8）・`anchorCount`（1〜12）・`minSimilarity`（−1〜0.8）・`overFetchFactor`（1〜3）で、絞る前と後の `recall()` の全結果（JSON。`recallId` だけ除く）を比べた。同じ入力を絞らずに2回走らせた差（ノイズ）は 0 件だった。
       - `search` のみ: 900 通り（うち連想の席が出たのは 769）で、`memories` の順序・同点の並び・score が食い違ったのが 57 通り、`memories` は同じで `omitted` だけ食い違ったのが 98 通り。
       - `searchMany` あり: 900 通り（連想が出たのは 760）で、`memories` が食い違ったのが 64 通り、`omitted` だけが 122 通り。
       - 食い違った `omitted` は `over_limit(stage: 'association')` の `count`（`countKind: "exact"`）である。絞ると、切り落とされた分だけ数が減り、`exact` と名乗る数が嘘になる。`memories` が変わる理由は、複数のアンカーが同じ記憶を引いたとき「最初に当たったアンカーが取る」重複除外が、前のアンカーの切り落とされた分に依存するため（取る側のアンカーと類似度が変わる）。
     - クローンの条件（完全一致を示せたときだけ変える）を満たさないので、コードは変えない。
  4. **既定値は変えていない。**

- **検討した代替案**:

  1. **決定1で、長さの判定を置かない**（WIP の初版の案。圧縮が効く値は上限を超えても通るため、今保存できている値を落とさない）。採らなかった。長さで落ちるかどうかが値の中身（圧縮のされ方）で決まり、adapter（fixture は通す）でも変わる。中身で分けるより、コードポイントで上限を置くほうが説明できる（ADR 0433 と同じ）。引き受けた負債に、圧縮が効く 513 字以上の tag を落とすことを書いた。
  2. **決定1で、`digest` にも長さの上限を置く。** 採らなかった。索引が無く、落ちる根拠が見つからなかった。
  3. **決定1で、落とす欄を `created` の `meta` ではなく `droppedCandidates` に混ぜる。** 採らなかった。`droppedCandidates` は「候補ごと落ちた」の記録で、意味が違う。欄が落ちても候補は残る。
  4. **決定1で、保存を試みてから落ちた欄を特定して撃ち直す。** 採らなかった。`createMemoryWithOutbox` の例外から落ちた欄を特定するのは adapter の message に依存し、二重に書きうる（ADR 0410 と同じ）。事前に値を見るほうが単純。
  5. **決定2で、`reinforceMany` をチャンクに分けて複数の文にする。** 採らなかった。`reinforceMany` を直接呼ぶ呼び出しで、途中で落ちると一部だけ強化された状態が残る。`unnest` なら1文のまま原子的である。
  6. **決定2で、`searchMany` を `unnest` で1文にする。** 採らなかった（上）。
  7. **決定3で、`anchorCount` に上限を置く。** 採らなかった。公開の入力の変更であり、今成功する呼び出しを断る。

- **引き受けた負債**:

  - **圧縮が効く 513 字以上の tag が落ちる。** 以前は Postgres で通っていた値である（繰り返しなど）。`meta.droppedFields` に `too_long` で残る。
  - **NUL を含む・長い claim key を落としたことは記録されない。** `deriveClaimKeys` の戻り値に `null` の理由が無く、空白だけの要素・長さの超過と同じ扱いにした（ADR 0433 の負債と同じ）。`meta.droppedFields` には claim key は現れない。`droppedFields` の型は `field: "claimKey"` を許すが、今は書いていない。
  - **`consolidate`・`reflect` が書く `digest`・`tags` は対象にしていない。** LLM の値が NUL を含むと、その操作は今も例外になる（抽出の候補の経路だけを直した）。
  - **`searchMany` の例外の `cause` には、1文ぶんの `params`（最大 16384 件のベクトル）が残る。** `Runtime` を通れば `omitParamsFromError`（ADR 0423）が落とすが、store を直接呼ぶ呼び出しでは落ちない（ADR 0430 の負債と同じ）。
  - **`searchMany` が分けた文は、同じトランザクションの中だが別々の文である。** 文の間に別の書き込みが入ると、チャンクごとに見える行が違いうる（読み取りコミット）。`search()` を1件ずつ呼ぶのと同程度の一貫性である。
  - 連想枠の取得件数は、`anchorCount` × `limit` で増えたままである。

- **これが覆るとしたら**:

  - `tags` の上限を、圧縮を見た判定（バイト数で測る、`pg_column_size` を使う）にしたいとき。落とす値が減る代わりに adapter 依存になる。
  - 落とした claim key を呼び出し側が知る必要が出たとき。`DeriveClaimKeysResult` に欄を足す公開の型の変更になる。
  - `consolidate`・`reflect` の補助の欄も同じ扱いにしたいとき。
  - 連想枠のコストが実運用で問題になったとき。席に着く件数を先に見積もる別の設計（段階的に広げる取得など）を、結果が変わることを承知のうえで検討する。
  - 件数の崖より多い `searchMany` を頻繁に呼ぶ利用者が現れ、チャンクの大きさを変えたいとき。

- **測ったこと**（【実測】2026-10-01、手元の Postgres 17、UTF8（`C.UTF-8`）。歯を先に走らせて赤を見てから直した）:

  - 決定1: `packages/postgres/src/__tests__/observe-aux-field-drop.postgres.test.ts`（2実装 × 8本。digest の NUL、tags の NUL・巨大、添字の上限、claim key の NUL、deferred、reextract、本文の NUL は従来どおり候補ごと落ちる、保存できる値は変えない）。`sanitizeCandidateAuxFields` の呼び出しを外し、claim key の NUL の判定を外す変異で 12 本が赤（ほかの 4 本は「やりすぎ」を見る歯で、直す前から緑）。戻すと 16 本とも緑。
  - 決定2: `packages/postgres/src/__tests__/bind-parameter-limit-cliff.postgres.test.ts`（11本）。直す前は、`reinforceMany` は 13106 件が緑・13107 件が赤（40000 件でも赤を確認したあと、CI の 30 秒の時間切れを避けるため歯の大きさを 30000 件にした）、`memory_usage` は 13106 件が緑・13107 件が赤、`searchMany` は 32000 件が緑・32767 / 32768 / 40000 件とチャンクをまたぐ一致の歯が赤、存在しない id を含む 20000 件の message の歯が赤。直した後は 11 本とも緑。`reinforce-many-equivalence`・`vector-store-search-many`・`vector-search-many-diff`・`record-usage-and-reinforce`・`search-many-primary-key-lookup` ほか、関連する既存の歯が緑。
  - 決定3: 上の差分試験（使い捨て。CI には載せていない）。
  - **測っていないこと**: `searchMany` の実行計画が、チャンクに分けても同じであること（`EXPLAIN` は取っていない。分けた各文の形は以前と同じ `VALUES` である）。チャンクの大きさ（16384）が最速かどうか。SQL_ASCII の DB での補助の欄の歯。
