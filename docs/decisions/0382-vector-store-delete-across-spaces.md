# ADR 0382: `VectorStore` に `deleteAcrossSpaces`（必須メソッド）を足す——`purge` が全 space の embedding を消す

- **状態**: 採用 (2026-09)

- **文脈**:

  [Issue #1425](https://github.com/takecchi/mnemora/issues/1425)（クローン miku の委譲先が
  起票、オーナーではない）が指摘した欠陥: `Runtime.purge` は
  [ADR 0124](./0124-purge-physical-delete.md) 決定5により、`purgeMemory` の成功後
  `deps.vectorStore.delete(ctx, deps.embeddingProvider.space, id)` をベストエフォートで
  呼ぶが、**これは「今の」`embeddingProvider.space`（1つの空間）の行しか消せない**。
  埋め込みモデルを移した（`EmbeddingSpaceId` の `provider`/`model`/`dimensions` の組を
  変えた）後、旧 space に残っている embedding 行は purge の対象外のまま残る——本文から
  作ったベクトルが、purge の後も残る（[Issue #995](https://github.com/takecchi/mnemora/issues/995)
  が最初に指摘）。

  [ADR 0375](./0375-purge-scope-widened.md) はこの欠陥を認識した上で、決定5で
  「口が無い以上、この PR ではその口を足さない」として Issue #1425 に切り出した。
  同 ADR の決定5・「引き受けた負債」4・「これが覆るとしたら」が書いた2つの未決事項——
  (1) 必須メソッドにするか任意メソッドにするか、(2) 「このテナントが過去に使った
  space の一覧」をどこかに持たせる必要があるか——を、本 ADR で決定する。

  **本 ADR は、ADR 0124 決定5・ADR 0375 決定5／「引き受けた負債」4／「これが覆るとしたら」を、
  追記ではなくこちらから指して上書きする。** 0124・0375 の本文には一切触れていない
  （両 ADR は「本文は書き換えない」規律のとおり、当時の記録のまま残す。
  `docs/decisions/README.md` の規律1）。**この上書きを読む側は、0124 決定5・0375 決定5を
  読んだら、その先にこの ADR が在ることを覚えておくこと**——0124・0375 側には
  「上書きされた」という追記は無い（マネージャーの指示により、この形を選んだ。
  通常この repo は上書き元の ADR に追記して辿れるようにする作法
  [ADR 0124 追記（2026-09-29）「決定4の『唯一の場所』は ADR 0375 で上書きした」が前例]
  だが、本 PR ではその追記を行わない）。

- **決定**:

  1. **`VectorStore` に `deleteAcrossSpaces(ctx: Ctx, memoryIds: readonly MemoryId[]):
     Promise<void>` を**必須**メソッドとして足す。** `ctx.tenantId` に属する
     `memoryIds` の行を、その adapter が持つ**全 space**から消す——`upsert`/`search`/
     `delete` と違い `space` 引数を受け取らない。契約（`packages/core/src/interfaces/
     vector-store.ts` の doc コメント）:
     - 対象の行が無ければ何もしない（`void`、べき等）。
     - 形式不正な `memoryId`（adapter の期待する形式に合わないもの）も「存在しない」の
       一種として扱い、例外を投げない——`delete` の `isUuidLike` と同じ規律
       （`packages/postgres/src/mapping.ts`）。
     - `ctx.tenantId` に属さない行は消さない（他テナントの行が偶然同じ `memoryId` を
       持っていても触れない）。
     - `memoryIds` が空配列なら何もしない（往復を発生させない）。

     **必須にした理由**: ADR 0375 決定5「検討したこと」が既に指摘したとおり、
     `archiveDecayed?`/`purgeExpiredEvents?`/`purgeMemory?`（`MemoryStore`）や
     `getVectors?`/`searchMany?`（`VectorStore` 自身）と同じ「無くても adapter として
     成立する」任意メソッドの形に倣うと、**対応していない adapter では、別 space の
     embedding が結局消えないという限界がそのまま残る**——Issue #1425 が指摘した欠陥を、
     「直せる adapter だけ直る」形に矮小化してしまう。`Runtime.purge` の doc コメントが
     法的要求（実際に消える）への応答であると明言している以上、この口を持たない
     adapter が存在し続けることは望ましくない、と判断した。

     **破壊的変更である。** `@mnemora/core` は npm 公開済みであり、既存の第三者
     `VectorStore` adapter はこの新しい必須メソッドを実装しなければ型検査で落ちる
     （[ADR 0100](./0100-supersede-with-new-memories.md) 決定1・ADR 0124 決定4と同じ
     理由）。**v1.X.0 での破壊的変更はオーナーが許可済み**（ask_human `6911db12`）。
     `docs/migration-v1.md` 項目30・`CHANGELOG.md` `[1.1.0]` 節 `### Breaking` に記録する。

  2. **`PostgresVectorStore.deleteAcrossSpaces` は、1つのトランザクションの中で、
     カタログ（`pg_class`/`pg_constraint`/`pg_attribute`）から対象テーブルを列挙し、
     テーブルごとに `DELETE FROM <t> WHERE tenant_id = $1 AND memory_id = ANY($2)` を
     打つ。台帳は持たない**——[ADR 0002](./0002-embedding-space-tables.md) が
     「space ごとに別テーブル」を決めた設計そのものが、カタログを読めば列挙できる形に
     なっている。「このテナントが過去に使った space の一覧」を別表（台帳）として
     `MemoryStore` 側・`VectorStore` 側のどちらにも新設しない——ADR 0375「検討したこと」
     が挙げた未決事項(2)への回答である。

     **列挙の条件は3つ**（それぞれの理由）:

     | # | 条件 | 理由 |
     |---|---|---|
     | 1 | `current_schema()` の中のテーブルだけ（スキーマを跨がない） | [ADR 0057](./0057-dedicated-schema-namespace.md)（dedicated-schema）で、1つの DB に複数の mnemora デプロイが別スキーマで同居しうる。`PostgresVectorStore` の DML は元から `search_path` 任せで書かれており（`schema-namespace.ts` のクラス doc）、この規約をここでも保つ。加えて、テーブル名の列挙をスキーマで絞らないと、他スキーマにしか無い名前のテーブルを列挙してしまい、`DELETE`（`sql.identifier` で組む未修飾の識別子——他のメソッドと同じ、`search_path` 任せの形）が「relation does not exist」で例外になる（このテーブルは呼び出し側の接続の `search_path` から見えないため）——「別スキーマの行を誤って消す」だけでなく「無関係な purge がスキーマの組み合わせ次第で突然落ちる」という、より実害の大きい壊れ方を招く。実測で確認した（下記「確かめたこと」）。 |
     | 2 | テーブル名が `memory_embeddings_` で始まる（`EMBEDDING_SPACE_TABLE_PREFIX`） | `embeddingSpaceTableName`（`embedding-space-table.ts`）の導出と同じ接頭辞。列挙の対象を、そもそも embedding 用に作られた形のテーブルへ絞る最初の足切り。 |
     | 3 | `memory_id` 列が、同じスキーマの `memories(id)` を外部キーで参照している（`pg_constraint`/`pg_attribute` で確かめる） | 条件1・2だけでは、利用者が同じ命名慣習（`memory_embeddings_` で始まる名前）で作った無関係なテーブル（例えばそのテーブル自身の分析用に別名で保持しているデータ）まで巻き込みうる。`registerEmbeddingSpace`（`vector-space.ts`）が作るテーブルは必ず `memory_id uuid NOT NULL REFERENCES memories(id)` という単一列の外部キーを持つ——この形を持つテーブルだけに絞ることで、「mnemora が実際に作った space テーブル」と「名前が似ているだけの利用者のテーブル」を区別する。 |

     `registerEmbeddingSpace` が作るテーブルは、この3条件をすべて満たす（`tenant_id`/
     `memory_id` の複合主キー、`memory_id uuid NOT NULL REFERENCES memories(id)`）。

  3. **`already_purged` のときも、`Runtime.purge` は同じくベストエフォートで
     `deleteAcrossSpaces(ctx, [id])` を呼ぶ（`dryRun` のときは呼ばない）。** 既に
     purge 済みの記憶を、埋め込みモデルを移した後に再実行すると、旧 space に残った
     embedding をこの再実行で後始末できる——1回目の purge の時点でまだ存在しなかった
     space（後から `registerEmbeddingSpace` された空間）の行や、1回目の
     `deleteAcrossSpaces` 自体が失敗して埋め込みが残った場合の再試行にも当たる。
     `PurgeOutcome` の `kind`・意味は変えない——`already_purged` は今までどおり
     「`MemoryStore` への書き込みは一切起きていない」ことだけを意味し、埋め込みの
     削除はその外側の、ベストエフォートの副作用である。

  4. **`PurgeResult`/`PurgeOutcome` の型は変えない。** `deleteAcrossSpaces` が何件
     消したか・成功したかを表す派生値（例えば「消した embedding 行数」）を持たせない
     ——[ADR 0124](./0124-purge-physical-delete.md) 決定5と同じ理由がそのまま当たる:
     ベストエフォートの操作は「0件だった」と「失敗した」を区別できない（`try`/`catch`
     で握り潰す設計そのものが、成功した0件と失敗した0件を同じ顔にする）。件数のような
     派生値を `outcomes` の外に複製すると、このリポジトリが繰り返し踏んできた「片方だけ
     直してずれる」欠陥を新しく作ることになる（`ForgetResult`/`RestoreArchivedResult`
     が同じ理由で `purgedCount` 相当の欄を持たないのと同じ規律）。

  5. **`runtime.ts:4812`（embed ジョブが purge と競合したときの後始末）の
     `deps.vectorStore.delete(ctx, deps.embeddingProvider.space, memory.id)` は
     置き換えずに残す。** この箇所は `Issue #1035 / ADR 0124 決定5` が閉じた別のレース
     ——embed ジョブが Memory を読んでから provider を呼んでいる間に purge が完了すると、
     ジョブは purge 前の内容から作ったベクトルを、purge の削除より後に書いてしまう。
     この後始末が消すべき embedding は「そのジョブ自身がこの直前の `upsert` で今の
     `space` に書いたばかりの1行」だけであり、旧 space に残っているかもしれない他の
     embedding とは無関係——このジョブは `deps.embeddingProvider.space` 以外の space に
     一度も書いていない。全 space を対象にした `deleteAcrossSpaces` に広げる理由が無く、
     むしろ「このジョブが書いた分だけをピンポイントで消す」という元の意図（Issue #1035）
     を保つほうが正確である。

  6. **ロックについて**: 列挙のクエリ（決定2の3条件）は `pg_class`/`pg_constraint`/
     `pg_attribute` というシステムカタログを読むだけで、対象の embedding テーブル自体には
     一切触れない——行ロック・テーブルロックのどちらも取らない。各 `DELETE` は該当
     テーブルの対象行だけを行ロックする（通常の `DELETE` と同じ）。⟹ **テーブルの本数が
     多くても、特定のテーブルを長く掴み続けることは無いはずである。** ただしこれは
     **推測であり、実測していない**——「確かめていないこと」参照。

- **検討した代替案**:

  1. **任意メソッド（`deleteAcrossSpaces?`）にする。** ⛔ 採らなかった——決定1参照。
     対応していない adapter では別 space の embedding が結局消えないという、Issue #1425
     が指摘した欠陥そのものが残る。
  2. **「このテナントが過去に使った space の一覧」を台帳として持つ**（`MemoryStore` 側に
     新しい表を足す、または `VectorStore` 側にメタデータ表を足す）。⛔ 採らなかった
     ——決定2参照。Postgres は space ごとに別テーブルという設計（ADR 0002）そのものが、
     カタログを読めば列挙できる形になっており、別に台帳を持つと「台帳の更新を忘れる」
     という新しい不整合の種を作る（`registerEmbeddingSpace` を呼ぶたびに台帳へも書く、
     という二重更新が必要になる）。カタログを都度読む形なら、台帳の更新漏れという
     失敗モード自体が存在しない。
  3. **`deleteAcrossSpaces` の引数に `space` の配列を受け取らせ、呼び出し側
     （`Runtime.purge`）が「消したい space の一覧」を渡す形にする。** ⛔ 採らなかった
     ——結局、呼び出し側が「このテナントが使った space の一覧」をどこかから得る必要が
     あり、代替案2と同じ台帳問題に帰着する。adapter 自身がカタログを読んで解決できる
     以上、呼び出し側に一覧を持たせる理由が無い。
  4. **`already_purged` では `deleteAcrossSpaces` を呼ばない**（`"purged"` になった
     その1回だけ呼ぶ）。⛔ 採らなかった——決定3参照。埋め込みモデルの移行は purge の
     タイミングと無関係に起こりうるため、「1回目の purge の時点でまだ存在しなかった
     space」「1回目の削除自体が失敗した」という場合の後始末の経路が無くなる。
     ベストエフォートで良いので、コストは呼び出し1回分の往復（既に purge 済みと
     分かった直後）だけであり、安全側に倒す判断をした。

- **引き受けた負債**:

  1. 🔴 **`deleteAcrossSpaces` が実際に失敗した場合、埋め込み行が消えずに残る
     可能性がある。** ADR 0124「引き受けた負債」1と同じ性質の負債——ベストエフォートで
     あり、自動リトライは持たない。`already_purged` の再実行（決定3）がこの負債を
     部分的に緩和する（再実行のたびに再試行の機会がある）が、呼び出し側が実際に
     再実行しない限り、失敗は検知されないまま残る。
  2. **`PostgresVectorStore.deleteAcrossSpaces` の列挙は、テーブル数に比例した
     コストを持つ。** 列挙クエリ自体は1回のカタログ読み取りだが、対象テーブルごとに
     `DELETE` 文を1本ずつ発行する（`for` ループ、1トランザクション内）——`purge` が
     大量の id を一度に処理する呼び出し（`{ memoryIds: [...] }`）でも、テーブル数 ×
     1呼び出し分の往復になる。テーブル数（= このテナントが使ってきた space の総数）が
     大きくなる運用は現状想定していない。
  3. **ロックについて（決定6）は実測していない、推測である。** テーブル数が多い場合に
     実際にロック競合・待ちが増えないかは確かめていない。
  4. **`runtime.ts:4812` の埋め込み削除は、依然として今の space だけを対象にする
     （決定5）。** この箇所自体は Issue #1425 の対象外だが、「purge 関連で
     `vectorStore.delete` を呼ぶ箇所が2種類（1つは `deleteAcrossSpaces` に置き換えた、
     もう1つは `delete` のまま）ある」という非対称は、コードを読む人が両者を混同
     しないよう、コメントで明示する必要がある（本 PR で対応済み）。

- **これが覆るとしたら**:

  - **`already_purged` の再実行に頼らない、もっと確実な後始末の仕組みが要ると
    判断されたとき**（負債1）——`deleteAcrossSpaces` の失敗を運用側が検知・再試行する
    独立した保守操作（`purgeExpiredEvents`/`archiveDecayed` と同じ形の明示呼び出しのみの
    任意メソッド）を追加する判断が要る。
  - **テナントが使う space の本数が実運用で大きくなり、決定2の列挙コスト（負債2）が
    無視できなくなったとき**——台帳を持つ設計（検討した代替案2）を採る判断が要る。
    そのときは「台帳の更新漏れ」という新しい失敗モードを引き受ける代わりに、列挙の
    コストを O(1) に近づけるトレードオフになる。
  - **ロックの実測（負債3）で長時間のロック保持が確認されたとき**——列挙・削除の
    やり方（バッチ化・並列化・`LOCK TABLE` の明示的な回避策等）を見直す判断が要る。
  - **`VectorStore` を独自実装している第三者が、この必須メソッドの追加を理由に
    アップグレードを見送ったという実例が観測されたとき**——決定1（必須にする）を
    見直し、任意メソッドへ緩める判断が要る（ただしその場合、Issue #1425 の欠陥は
    「対応していない adapter では直らない」形で再び残る）。

- **確かめたこと**（【実測】、この作業者が自分専用の PostgreSQL 17 + pgvector で
  手元で確認した）:

  - 2つの space（`registerEmbeddingSpace` で登録）に同じ `memoryId` の embedding を
    upsert し、`Runtime.purge` を呼ぶと、**両方の space の行が消える**（直す前は
    今の `embeddingProvider.space` の行しか消えなかった——陽性対照）。Fake（core）・
    本物の Postgres の両方で確認した。
  - `already_purged` の再実行でも、後から見つかった旧 space の embedding が
    ベストエフォートで消える（`dryRun: true` のときは消えないことも確認した）。
  - **列挙の条件3（外部キー）を落とす変異**（`memory_id` の外部キー制約を確かめる
    JOIN・WHERE 句を外し、スキーマ・接頭辞の一致だけに緩める）を入れると、
    `memory_embeddings_` で始まるが `memories(id)` を参照していない利用者のテーブルの
    行が消えてしまい、対応する歯が赤くなることを確認した。戻すと緑に戻った。
  - **列挙の条件1（`current_schema()`）を落とす変異**（スキーマの絞りを外す）を
    入れると、別スキーマにしか無い space のテーブル名まで列挙してしまい、
    その名前が呼び出し側の接続の `search_path` から解決できずに `DELETE` が
    「relation does not exist」で例外になる——「別スキーマの行を誤って消す」ではなく
    「無関係な purge が突然落ちる」という形で対応する歯が赤くなることを確認した
    （2つの schema に**同じ名前**の embedding テーブルを置いた構成では、この変異は
    赤くならなかった——`DELETE` 文自体が未修飾の識別子で `search_path` 任せに解決される
    ため、たまたま両スキーマに同名のテーブルがあると、列挙がどちらの OID を返しても
    最終的に呼び出し側の `search_path` が解決する側のテーブルにしか触れない。この
    ADR の歯は、別スキーマに**しか無い**名前のテーブルを使うことで、この見かけ上の
    安全を回避し、実際に条件1を検査している）。戻すと緑に戻った。
  - `InMemoryVectorStore.deleteAcrossSpaces` を「今の space（fixture の既定 space）
    だけを消す」ように壊すと、testkit の conformance の「複数 space にある同じ
    memoryId の行が、全部消える」歯が赤くなることを確認した。戻すと緑に戻った。

- **確かめていないこと**:

  - 決定6のロック時間（テーブル数が多い場合に `DELETE` の直列発行がどれだけの時間を
    要するか、他の書き込みと競合するか）は実測していない——推測にとどまる。
  - テナントが実際に多数の space（例えば数十〜数百）を使い続けた運用での列挙・削除の
    実測コストは測っていない。
  - `deleteAcrossSpaces` が実際に失敗する場面（ネットワーク断・DB 接続断等）を、
    本物の環境で発生させて確認していない——ベストエフォートの設計は推論に基づく
    （ADR 0124「確かめていないこと」の同種の限界をそのまま引き継ぐ）。
