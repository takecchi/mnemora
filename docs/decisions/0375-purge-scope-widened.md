# ADR 0375: `purge()` が消す範囲を広げる——`tags`/`attributes`/claim key・label の紐付け・`recalls.index_band` の digest 帯

- **状態**: 採用 (2026-09)

- **文脈**:

  [ADR 0124](./0124-purge-physical-delete.md) 決定4は「purge 後、元の digest が残る
  唯一の場所はこの監査ログである（`content` は事後もどこにも残らない）」と書いた。
  [Issue #994](https://github.com/takecchi/mnemora/issues/994)・
  [Issue #995](https://github.com/takecchi/mnemora/issues/995)・
  [Issue #1207](https://github.com/takecchi/mnemora/issues/1207)（いずれもクローン miku の
  委譲先が実測して起票、直していない）は、この文言が実装と食い違っていることを示した:

  - **#994**: purge より前に撃った `recall()` の記録（`recalls.index_band` の
    `digestBand`）に、元の digest がそのまま残る。`consolidate`/`reflect` の自動ジョブが
    種の digest を `text` にして撃った recall の `recalls.query` にも残る（後者は
    `memoryId` で特定できない）。
  - **#995**: `memories.tags`・`attributes`・claim key（`claim_key_subject`/
    `claim_key_predicate`）・`labels`/`memory_labels`・別 space の埋め込み・元の
    Observation は、purge の約束が何も言っておらず、すべて元のまま残る。
  - **#1207**: 1つのテナントの全記憶を forget→purge し、イベントの保持期間を掃除した
    後も、`recalls`（行そのもの・`query`・`explain`）・`recall_usages`・完了した
    `outbox`・`provenance.speaker`・呼び手が渡した識別子（`subject_id`/`external_id`）が
    残る。

  3件とも「直すかどうかは決めていない」まま、purge の法的な射程の決定としてオーナーへ
  上げられた。オーナー代理（クローン miku）が決定した約束は次のとおりである:

  > purge の約束 = 「その記憶の本文と、本文から直接たどれる派生物（digest を含む記録・
  > 埋め込み・tags などの付帯情報）を消す」。

  本 ADR はこの約束を、どの列・どの表について「消す」を実装するか（(a)）、どこまでを
  「残る」と約束し直すか（(b)）に具体化し、PR1 として実装する。#1226（consolidate/
  reflect のレース）は別の決定として本 ADR に記録するが、実装・実測は別 PR（PR2）で行う。

- **決めたこと**:

  1. **(a) 消す。`MemoryStore.purgeMemory` の書き込みに、次を追加する。**

     | 表 | 欄 | 消し方 | 理由 |
     |---|---|---|---|
     | `memories` | `tags` | `'{}'`（空配列）で上書き | LLM が本文から作った話題の要約——本文の内容が語の形で残っていた（#995） |
     | `memories` | `attributes` | `'{}'::jsonb`（空オブジェクト）で上書き | 呼び手が申告した属性——個人を指す値が残りうる（#995） |
     | `memories` | `claim_key_subject`・`claim_key_predicate` | `NULL` で上書き | 「誰について何の主張だったか」が残っていた（#995） |
     | `memory_labels` | 該当 `memory_id` の行 | 削除 | Memory と label の紐付けそのもの——本文から直接たどれる派生物 |
     | `labels` | `proposed_count` | 外した本数だけ `GREATEST(…, 0)` で減算。**`status = 'proposed'` の行だけ**（`registered` は触らない） | [ADR 0318](./0318-taxonomy-labels.md) が `proposed_count` を近似値と既に引き受けている——この減算も同じ近似の中にいる。他の Memory が同じ label を使い続けていれば、その分は残る |
     | `recalls` | `index_band.digestBand[].digest`（該当 `memoryId` のエントリのみ） | `tombstone.digest`（`purgeMemory` に渡された値、既定 `"[purged]"`）で上書き。`truncated` は落とす | #994 が指摘した「recall の記録に残る元の digest」の主な経路 |

     いずれも `PostgresMemoryStore.purgeMemory` の**同一トランザクション**（`memories`
     の CAS UPDATE・`memory_events` への INSERT と同じ `db.transaction`）で行う——
     CAS が弾かれれば（`status !== 'forgotten'` または `purgedAt` が非 `null`）、この
     PR で足した書き込みも含めて一切何も起きない。`packages/testkit` の
     `InMemoryMemoryStore`・`packages/core/src/__tests__/runtime-fakes.ts` の
     `FakeMemoryStore`（どちらも `purgeMemory` を実装する fake）も同じ範囲を実装する。

     **`memories` の行自体は消さない**（ADR 0124 決定4のまま——`memory_events` からの
     外部キー参照整合性、`superseded_by_id`/`contested_with_id` の参照先として必要）。

  2. **Fake の内部構造を変える。** `packages/testkit/src/__fixtures__/in-memory-memory-store.ts`・
     `packages/core/src/__tests__/runtime-fakes.ts` は、どちらも「`labels` の集計値
     （`proposedCount` 等）だけを持ち、どの Memory がどの label に紐づくかを個別には
     追跡していなかった」——`upsertProposedLabels` が `tags` から label を増やす一方、
     どの Memory がその増分を担ったかを覚えていない構造だった。**purge が「この
     Memory の紐付けだけを外す」を実装するには、この個別の紐付けを新設する必要が
     あった**——両ファイルに `memoryLabels: Map<"(tenantId,memoryId)", Set<labelName>>`
     を追加し、`upsertProposedLabels` の呼び出しごとに書き込み、`purgeMemory` で読んで
     消費する形にした。`packages/testkit` 側は `supersedeWithNewMemories` の
     ロールバック（CAS 失敗時に「まだ何も書いていない」へ戻す既存の作法）にも、この
     新しい `memoryLabels` を対象として組み込んだ。

  3. **(a) の実装は破壊的変更として数える。** `packages/testkit` の conformance
     suite（`describeMemoryStoreConformance`）に、この3点（tags/attributes/claim key
     が消える・label の紐付けが外れる・`recalls.index_band` の digest が伏せられる）を
     縛る `it` を足した——`docs/migration-v1.md`「数え方の規律への追記
     （2026-09-28）」規律2 の ⛔（「conformance スイートの判定を厳しくする変更は、
     これまでどおり…数える」）に当たる。加えて `MemoryStore.purgeMemory?` を自前実装
     している第三者 adapter は、この PR より前の版に対して書いた「purge は content/
     digest 以外を変えない」という前提のテストが、この PR のあとに揃えた
     conformance を当てると通らなくなりうる（型は変えていないので型検査は壊れない
     ——実行時の契約が厳しくなる）。`docs/migration-v1.md` 項目25・CHANGELOG
     `[1.1.0]` 節 `### Breaking` に記録した。

  4. **(b) 残る。これらは purge の約束の対象外のまま、文言で明記する。**

     | 表 / 値 | 残る理由 |
     |---|---|
     | `recalls.query`（利用者が撃った recall の問いの本文・`consolidate`/`reflect` が種の digest を `text` にして撃った recall の分を含む） | **`memoryId` で特定できない。** `query` は `RecallQuery` をそのまま保存した jsonb であり、どの Memory の digest から作られた `text` かという対応は保存されていない——文字列の完全一致でしか探せず、「別の記憶がたまたま同じ文字列を持っていた」場合と区別できないため、誤って別の記憶の記録を書き換える危険のほうが大きい（Issue #994 のコメント参照） |
     | `memories.content_hash` | ADR 0124「引き受けた負債」4 で既に残ると明記済み——同じ本文を持っていたかを突き合わせる目的の列で、`content` 自体が読めなければ実害は小さいと判断済み |
     | `memories.provenance.speaker`（`stated` な記憶の話者） | `provenance`（`sources` を含む）は [Issue #883](https://github.com/takecchi/mnemora/issues/883) の `basisLost` の解決に要る——`consolidate`/`reflect` の統合物が「元の記憶が失われたこと」を検出・説明するために `sources` を辿る必要があり、`provenance` 全体を空にすると `basisLost` の判定そのものが壊れる。`speaker` だけを選んで消す個別対応は、`provenance` が判別共用体（種類ごとに形が違う）であるため実装コストと脆さが見合わない、と判断した |
     | `memories.subject_id`・`observations.subject_id`/`external_id` | 呼び手が渡した不透明な識別子（[ADR 0007](./0007-tenant-scoping.md) が言う「テナントの台帳を持たない」設計と同型——mnemora はこれが何を指すか関知しない）。消すと `basisLost`/`aggregateScope` 等、他の記憶の集計・解決が参照できなくなる副作用が大きく、今回の切り出しでは対象にしない |
     | `observations.payload`・`attributes` | ADR 0124 の射程外——`docs/memory-model.md` §2 が明記するとおり Observation は追記専用で forget/purge の経路がコードに無い。Observation を消せるようにするかどうかは、mnemora の「事実の記録は追記専用」という既存原則を覆すかどうかの別判断であり、本 PR の範囲外（#1207 コメントでオーナーへ問いを残す） |
     | `memory_events.digest_snapshot`（監査ログ） | **意図的に残す。** 監査ログは「何が起きたか」の記録であり、そもそも `content` を持たない設計（`docs/memory-model.md` §9「本文は残さない」）——digest のスナップショットは、`purged`/`forgotten` イベントが「何を forget/purge したか」を後から追跡可能にするための唯一の記録であり、これを消すと監査ログ自体の目的（「消えたことが見える」）が成立しなくなる |
     | `recall_usages`・完了した `outbox` の行 | どちらも `id` だけの行（#1207 の実測——`recall_usages` は memory_id 自体は残るが本文由来の情報を持たない、outbox の `payload` は完了後 id のみ）。保持方針そのもの（いつまで残すか）は [ADR 0290](./0290-activity-seq-read-path-documented-not-implemented.md) が「`recalls` の保持方針」を先の話としている範囲で、本 PR はそこに触れない |
     | **別の `EmbeddingSpaceId` の embedding** | 決定5参照（下） |

  5. **別の space の embedding は、この PR では消さない。新しい Issue に切り出す。**
     `VectorStore` interface（`packages/core/src/interfaces/vector-store.ts`）を確認
     した——`upsert`/`search`/`searchMany?`/`delete`/`getVectors?` のいずれも
     `space: EmbeddingSpaceId` を明示的な引数として要求し、**「このテナントの全 space
     を列挙する」「全 space から特定の memoryId を消す」という口が存在しない**
     （`rg -n "listSpaces|allSpaces|deleteAll" packages/core/src/interfaces/vector-store.ts`
     で確認、0件）。`Runtime.purge` が今の `deps.embeddingProvider.space` にしか
     `vectorStore.delete` を呼べないのは、この口が無いことの直接の帰結である
     （ADR 0124 決定5はこの1点をベストエフォートと定義しただけで、複数 space を
     跨ぐ削除は最初から扱っていない）。

     **口が無い以上、この PR ではその口を足さない。** 口を新設するなら:
     - `VectorStore` に必須メソッドを足すのか、既存の任意メソッドの慣例
       （`archiveDecayed?`/`purgeExpiredEvents?`/`purgeMemory?` と同じ「無くても
       `VectorStore` として成立する」形）に倣った任意メソッドにするのか。
     - 必須にするなら、`@mnemora/core` は npm 公開済みであり、第三者の `VectorStore`
       adapter に新しい義務を課す破壊的変更になる（ADR 0100 決定1・ADR 0124 決定4と
       同じ理由）。
     - 「全 space を列挙する」ためには、そもそも「このテナントが過去に使った
       space の一覧」をどこかが持っている必要があるが、今の設計にその台帳は無い
       （`EmbeddingSpaceId` は呼び出し側が `embeddingProvider.space` として渡す値
       でしかなく、mnemora 側は使われた space の集合を記録していない）。

     この決定と未決事項を、[Issue #1425](https://github.com/takecchi/mnemora/issues/1425)
     に切り出した。**(b) 表に「別 space の embedding は残る」と明記し、決めていないことを
     doc に残す。**

  6. **`recalls.index_band` の書き換えの費用を実測する。** #994 のコメントが
     「テナント全体の走査が避けられない」と算術で見積もっていた部分を、実測に
     置き換えた。

     **手順**（再現可能。commit はしていない使い捨てスクリプト/SQL）:
     1. 自分専用の PostgreSQL 17 + pgvector に、`packages/postgres` の migration を
        フルに当てた使い捨て DB（`mnemora_bench`）を用意する。
     2. テナント `benchtenant` に、`recalls` を10万行 INSERT する。各行の
        `index_band.digestBand` は5エントリ（1エントリあたり日本語の要約
        文字列、現実的な長さ）を持つ。うち1%（1,000行）に、対象の `memoryId`
        を1エントリとして含める——「その記憶が作られた後、テナントが recall を
        100回撃つごとに1回、この記憶が目次帯に載った」という想定。
        テーブルサイズは `pg_total_relation_size` で **約180MB**。
     3. `PostgresMemoryStore.purgeMemory` が発行する `recalls` の `UPDATE` 文
        そのものを、`psql \timing` で7回連続測定する（対象行は既に書き換え済みでも
        `memoryId` の一致条件は変わらないため、繰り返し測定してもスキャン費用は
        変わらない）。
     4. `EXPLAIN (ANALYZE, BUFFERS)` で、フィルタの内訳を確認する。

     **結果**（【実測 2026-09-29】、単一接続・他の負荷が無い状態）:

     | 試行 | 1 | 2 | 3 | 4 | 5 | 6 | 7 |
     |---|---|---|---|---|---|---|---|
     | 時間(ms) | 330.9 | 342.3 | 285.4 | 273.3 | 278.6 | 282.4 | 285.6 |

     **中央値 ≈ 285ms**（範囲 273〜342ms）。`EXPLAIN (ANALYZE, BUFFERS)` は、
     `idx_recalls_by_subject (tenant_id, subject_id, created_at)` でテナントへ
     絞り込んだ後、`index_band` に索引が無いため **Bitmap Heap Scan で10万行の
     ヒープブロック（20,200ブロック）を全部読み、jsonb の containment 演算子で
     行ごとにフィルタする**（99,000行がフィルタで落ちる）ことを示した——
     `EXPLAIN` 自体の実行だけで約309msかかっている。

     **この PR ではこの費用を受け入れる**（テナント全体の `recalls` を走査する
     コストは、Issue #994 のコメントが実装前から見積もっていたとおりであり、
     purge は本来まれな操作である——法的要求への応答として、1回あたり数百msの
     追加費用は許容範囲と判断した）。**索引を足す最適化はこの PR の範囲外**——
     `index_band` へ GIN 索引（`jsonb_path_ops` 等）を張る案は、書き込み経路
     （`createRecall` の頻度は purge よりずっと高い）側のコストとのトレードオフを
     要する別判断であり、`docs/memory-model.md` に「決めていない」として残す。

  7. **[Issue #1226](https://github.com/takecchi/mnemora/issues/1226)（consolidate/
     reflect のレース）は PR2 で扱う。本 PR では実装・実測しない。** ただし、
     オーナー代理（クローン miku）が既に決めた方向をここに記録する:

     - `consolidate`/`reflect` は、LLM 呼び出しの直前に材料（`sources` が指す
       Memory）を読み直し、**forget でも purge でも打ち切る**（現状は `purge()` が
       `"purged"` を返した後でも、待っていた LLM 呼び出しが完了すると統合先・
       内省の Memory が `active` で書かれてしまう——本文中の「文脈」節参照）。
     - `@mnemora/postgres` の `store_supported` 経路（`purgeMemory?`/
       `updateStatusWithEvent` を持つ adapter）は、**同一トランザクション内で
       材料行を `SELECT … FOR UPDATE` で見直してから書く**——`embed` ジョブの
       同種のレースを閉じた [Issue #1035](https://github.com/takecchi/mnemora/issues/1035)
       と同じ形。
     - それ以外の経路（`purgeMemory?` を持たない adapter、`store_unsupported`
       のとき）は、**書く直前に読み直すだけ**（トランザクションで行ロックを
       取れないため、読み直しと書き込みの間に小さな窓が残る）。この窓の大きさ・
       実測は PR2 で行う——本 ADR は「窓が残ることを明記する」ところまでを決定
       として持つ。
     - 実装・変異試験・実測の一切は本 PR に含めない。

  8. **破壊的変更として数える。** 決定3の理由により、`docs/migration-v1.md` の
     「未リリース」節に項目として足し、CHANGELOG `[1.1.0]` の `### Breaking` に
     詳細を書く。

- **検討した代替案**:

  1. **(b) をすべて (a) に含める（recall の記録・Observation・provenance も含めて
     全部消す）。** ⛔ 採らなかった——`recalls.query`（`memoryId` で特定できない）・
     `provenance`（`basisLost` の解決に要る）・`observations`（追記専用という既存
     原則）は、それぞれ独立した理由で「消す」を選べない。オーナーへ上げる前に
     クローン miku が既に線引きした区別（#1207 コメント）をそのまま引き継いだ。
  2. **`VectorStore` に「全 space を列挙・削除する」口を今回新設する。** ⛔
     採らなかった——決定5参照。既存 interface に無い機能を、この PR の切り出しの
     範囲外で足すと、第三者 adapter への義務を増やすかどうかという別の判断を
     混ぜ込むことになる。
  3. **`recalls.index_band` の digest 帯を、エントリごと配列から削除する（redact
     ではなく remove）。** ⛔ 採らなかった——`digestBandCoverage`（帯がどの上限で
     切れたかの記録、`count`/`limitedBy`）は帯の**件数**を前提にした集計であり、
     エントリを削除すると「元は何件あったか」という別の事実まで書き換わる。
     `digest` の値だけを伏せる（トゥームストーンへ置換、エントリは残す）ほうが、
     影響範囲が小さい。
  4. **`labels`/`memory_labels` の行自体を削除する。** ⛔ 採らなかった——
     [ADR 0318](./0318-taxonomy-labels.md) は「ラベルの行は作られるだけで消えない」
     という不変条件を既に確立しており（`docs/memory-model.md` §8 の
     2026-09-27 追記）、この PR単独でその不変条件を覆す理由が無い。`memory_labels`
     （紐付け）だけを外し、`labels`（語彙の行）は残す——「その記憶が使った語」は
     消えるが、「その語がテナントの語彙に存在したこと」は残る、という区別。
  5. **`recalls` の書き換えを別トランザクション・非同期のバッチにする。** ⛔
     採らなかった——`purgeMemory` が返した後にまだ元の digest が読める窓ができ、
     「purge が完了したのに古い digest が読める」という、ADR 0124 決定5が
     `VectorStore.delete` について懸念したのと同種の誤読を呼び込む。同一
     トランザクションに含め、費用は決定6で実測して受け入れる方を選んだ。

- **引き受けた負債**:

  1. **`recalls.index_band` の書き換えは、対象テナントの `recalls` 全体を走査する
     （決定6）。** purge を大量に呼ぶ運用（例: テナント単位の一括消去を今後
     実装した場合）では、この費用が積み上がる。索引を足す判断は別 PR。
  2. **`labels.proposed_count` は、この PR の後も近似値のままである。** ADR 0318
     「引き受けた負債」1が既に引き受けている近似に、purge の減算も乗る——
     複数の Memory が同じタイミングで同じ label を purge すると、競合下での
     正確な減算は保証しない（Postgres 側は行ロックで直列化されるため最終的な値は
     正しいが、「減算の途中経過」を見る読み取りは考慮していない）。
  3. **`recalls.query` の元 digest（#994 の後半）は、この PR の後も残ったまま
     である。** (b) 決定4のとおり、`memoryId` で特定できないという構造上の理由に
     よる——解決するには `recalls.query` に memoryId の対応を持たせる別のスキーマ
     変更が要る。
  4. **別 space の embedding は残ったまま（決定5）。**
     [Issue #1425](https://github.com/takecchi/mnemora/issues/1425) に切り出した
     だけで、この PR は1行も直していない。
  5. **#1226（consolidate/reflect のレース）は、方向だけ決めて実装していない
     （決定7）。** forget/purge との交差は、この PR の後も実際に発生しうる。

- **これが覆るとしたら**:

  - オーナーが「テナント単位で全表から消す口を新設する」と判断したとき ⟹
    #1207「考えられる方向」1が動き出し、`recalls`/`recall_usages`/`outbox` の
    保持方針もあわせて決める必要が生じる。
  - `VectorStore` に space を列挙する口が別 Issue で決まったとき ⟹ `Runtime.purge`
    がその口を使って全 space の embedding を消すよう決定5を上書きする。
  - Observation に purge の経路を足すとオーナーが決めたとき（#1207 コメントで
    問いを残した）⟹ 「追記専用」という既存原則そのものを見直す、より大きな
    ADR が要る。
  - `index_band` への書き込み頻度が purge より重要になった場合（例: purge が
    テナント単位の一括操作として高頻度に呼ばれるようになった）⟹ 決定6の
    「索引を足さない」判断を見直す。

- **確かめたこと（赤の証拠・変異試験）**:

  **赤の証拠**（`git checkout origin/main -- <path>` は使わず、`origin/main` から
  切った使い捨て worktree に、この PR が変更した/追加したテストファイルだけを
  `cp` でコピーして実行した。実装ファイルは worktree のまま——origin/main 時点の
  古い実装):

  | テストファイル | 使い捨て worktree での結果（旧実装） |
  |---|---|
  | `packages/testkit/src/memory-store-conformance.ts`（新設した3本） | 3 failed（`purgeMemory` の tags/attributes/claim key・label 紐付け・index_band の3テスト、2 adapter（postgres・in-memory）双方） |
  | `packages/core/src/__tests__/purge.test.ts`（新設した3本） | 3 failed（同じ3観点を `Runtime.purge` 経由で） |
  | `packages/postgres/src/__tests__/tenant-erasure-residue.postgres.test.ts`（更新後） | 1 failed（`tags` が空にならない） |

  **変異試験**（別の使い捨て worktree に、この PR の新実装一式を `cp` で持ち込んで
  一度 green を確認した後、`packages/postgres/src/memory-store.ts` の
  `purgeMemory` を1か所ずつ壊し、対応する歯だけが赤くなることを確認、`cp` で
  復元して green に戻ることを確認した）:

  | # | 壊し方 | 赤くなった歯 | 他の歯 |
  |---|---|---|---|
  | 1 | 主 `UPDATE memories` の `SET` から `tags`/`attributes`/`claim_key_*` の4行を削除 | 「purgeMemory は tags・attributes・claim key を消す」のみ | 13 passed |
  | 2 | `memory_labels` の DELETE と `labels.proposed_count` の UPDATE のブロックを削除 | 「purgeMemory は label の紐付けを外し…」のみ | 13 passed |
  | 3 | `recalls.index_band` の UPDATE ブロックを削除 | 「purgeMemory は recalls.index_band の digestBand から…」＋`tenant-erasure-residue`（index_band の LIKE 検査） | 13 passed（conformance 側） |

  3件とも、復元後 `diff` で元ファイルと完全一致することを確認した。

- **確かめていないこと**:

  - 並行下での `labels.proposed_count` の減算・`recalls.index_band` の書き換えの
    正確性（Postgres の行ロックにより最終値は正しいはずだが、専用の並行の歯は
    本 PR に含めていない）。
  - `recalls` が10万行を大きく超える規模（100万行以上等）での費用——決定6の
    実測は10万行級に限る。
  - 本番相当のネットワーク越しの Postgres（自分専用インスタンス、ローカル
    ソケット接続での実測である）。
