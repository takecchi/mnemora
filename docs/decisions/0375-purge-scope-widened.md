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
     新しい `memoryLabels` を対象として組み込んだ。`packages/testkit` の
     `InMemoryMemoryStore` は公開の fixture なので、`.d.ts` に private メンバ
     `memoryLabels`・`memoryLabelKey` が現れる（公開 API の snapshot
     `scripts/__snapshots__/public-api/testkit.d.ts` を更新した）。`private` なので
     利用者のコードからは参照できず、型としては非破壊である（PR #1114 の `rawGet` と同じ扱い）。

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

---

## 追記（2026-09-30）: #1226（consolidate/reflect のレース）を PR2 で実装した

クローン miku の委譲先が書いた。オーナーではない（[ADR 0220](./0220-issue-comment-author-does-not-distinguish-owner-from-agent.md)）。

**上の本文（決定1〜8・検討した代替案・引き受けた負債・確かめたこと・確かめていないこと）は
書き換えていない。**当時の記録として残す。決定7は「実装・実測は本 PR に含めない」と
明記していた——その実装・実測をこの追記が記録する。

**実装した方向**: 決定7が既に記録したとおり——`consolidate`/`reflect` は、LLM 呼び出しが
返った直後・書き込みの直前に材料（`eligible`）を読み直し、1件でも `forgotten`
（`forget()` のみ・`purge()` 済みのどちらも含む。`purge()` は `forgotten` でない
Memory を拒むため、両者は同じ条件で判定できる）なら、**統合先・内省の Memory を一切
作らずに打ち切る**（新しい `outcome: 'aborted_source_forgotten'`。`ConsolidateSourceOutcome`/
`ReflectBasisOutcome` に新しい `kind: 'forgotten_before_write'` を足した）。

**口の設計**: `MemoryStore.createMemoryWithOutbox`/`supersedeWithNewMemories?` の `opts` に
`abortIfForgotten?: ReadonlyArray<MemoryId>` を新設した（両方とも既存の任意/必須メソッドへの
新しいパラメータであり、型としては非破壊——union に値を足す変更・opts への省略可能な
フィールド追加は「数え方の規律への追記（2026-09-28）」で非破壊と決まっている）。

- **`@mnemora/postgres`**: `opts.abortIfForgotten` を渡されると、`news`/`supersede`
  どちらの書き込みより前に、対象行を `SELECT … FOR UPDATE` で読み直す
  （`assertNotForgottenForUpdate`、`memory-store.ts`）。1件でも `forgotten` なら
  `SourceMemoryForgottenError` を投げ、トランザクション全体が rollback される
  （`news` も `supersede` も一切コミットされない）——**decision 2 が要求した
  「同一トランザクション内の `SELECT … FOR UPDATE`」「1件でも forgotten/purged なら
  全体を書かない（all-or-nothing）」をそのまま実装した。**
- **既存の「部分成功を許す」設計との関係**: `supersedeWithNewMemories` の `conflicted`
  （CAS に弾かれた対象だけ飛ばして他は commit する）は変えていない——`forgotten` 以外の
  理由（例: 別の呼び出しが先に `superseded`/`contested` へ動かした）で CAS が破れた場合は、
  今どおり `conflicted` に積まれ、統合先は書かれる。`abortIfForgotten` の見直しは
  `conflicted` の判定より**前**（トランザクションの先頭）に行われ、`forgotten` を見つけたら
  `news` の INSERT すら実行しない——「部分成功」の対象外という新しい特別扱いを、
  `forgotten`/`purged` という1つの理由だけに絞って足した形である。
- **`@mnemora/testkit`/`@mnemora/core` の Fake**: `opts.abortIfForgotten` を実装しない
  （渡しても無視される）。これらの adapter では、runtime 自身が LLM 呼び出しの直後に行う
  「書く直前の読み直し」（`getMany`、`abortIfForgotten` とは別の、単なる再読）だけが保護になり、
  **その読み直しと書き込みの間に小さな窓が残る**——decision 3 が「それ以外の経路は書く直前に
  読み直すだけで窓が残る」と書いたとおりである。

**陽性対照（decision の「実測は PR2 で行う」を満たす実測。2026-09-30 に consolidate・
reflect 両方で実測——当初は consolidate だけだったが、CI の型検査が壊れた棚卸しの過程で
reflect 側の陽性対照も同じ作法で足した）**: `packages/postgres/src/__tests__/consolidate-reflect-source-forgotten-for-update-race.postgres.test.ts`。runtime の「書く直前の読み直し」が終わった直後・書き込みメソッド（consolidate は `supersedeWithNewMemories`、reflect は `createMemoryWithOutbox`）の呼び出しそのものが実行される直前で障壁を置き（`purge-during-embed-job.postgres.test.ts` ＝ Issue #1035 と同じ「障壁で止めて、その間に割り込ませる」作法）、止めている間に forget → purge を完了させてから障壁を外す。

| 対象 | 条件 | 結果 |
|---|---|---|
| `consolidate`（`supersedeWithNewMemories` の `SELECT … FOR UPDATE`） | 新実装（見直しあり） | **10/10 緑**（`outcome: 'aborted_source_forgotten'`、統合先は作られない） |
| `consolidate`（同上） | `assertNotForgottenForUpdate` の呼び出しを1行コメントアウトして外した変異 | **10/10 赤**（`outcome: 'consolidated'`——見直しが無いと、runtime の書く直前の読み直しだけでは閉じない窓から、消した内容が統合先に残ることを再現） |
| `reflect`（`createMemoryWithOutbox` の `SELECT … FOR UPDATE`） | 新実装（見直しあり） | **10/10 緑**（`outcome: 'aborted_source_forgotten'`、内省の Memory は作られない） |
| `reflect`（同上） | `createMemoryWithOutbox` 側の `assertNotForgottenForUpdate` 呼び出しを1行コメントアウトして外した変異 | **10/10 赤**（`outcome: 'reflected'`——見直しが無いと、消した内容が内省の Memory に残ることを再現。この変異では `consolidate` 側の10本は影響を受けず green のまま——2つの書き込みメソッドの見直しが互いに独立していることも確認した） |

変異試験は、それぞれ別の（`origin/main` から切った）使い捨て worktree に、本 PR の新実装
一式を `cp` で持ち込んで green を確認した後、対象のメソッド（`supersedeWithNewMemories`/
`createMemoryWithOutbox`）内の `assertNotForgottenForUpdate` の呼び出し1行だけを
コメントアウトして赤を確認した（`cp` で復元すれば green に戻る。`diff` で元ファイルと
一致することは確認していない——1行のコメントアウトなので目視で確認した）。

**残る窓（decision 3 が「実測は PR2 で行う」とした部分）**: `@mnemora/testkit`/`@mnemora/core`
の Fake（`opts.abortIfForgotten` を実装しない adapter）では、runtime の「書く直前の
読み直し」と実際の書き込み呼び出しの間に、別々の非同期呼び出しであるがゆえの窓が残る
——**この窓の大きさは実測していない**（JS の単一スレッド実行モデル上、この窓を突く
には2つの `await` の継続の間に別のマイクロタスクが割り込む必要があり、`consolidate`/
`reflect` の呼び出し1回の中でその割り込みを意図的に起こすテストは、この PR には
含めていない）。`@mnemora/postgres` については、上の陽性対照が示すとおり、この窓は
`SELECT … FOR UPDATE` により実質ゼロである。

**破壊的変更として数えたもの**: `packages/testkit` の `MemoryStoreConformanceOptions` に
任意フラグ `supportsAbortIfForgotten?: boolean` を足し、`true` を宣言した adapter に対して
`opts.abortIfForgotten` の契約の歯（forgotten な id を含めると
`SourceMemoryForgottenError` を投げ何も書かない、forgotten でなければ今日どおり書く）を
実行するようにした——「数え方の規律への追記（2026-09-28）」規律2の「conformance
スイートの判定を厳しくする変更は…数える」に当たる。`docs/migration-v1.md` 項目26に
登録した。`opts.abortIfForgotten` 自体（新しい省略可能フィールド）・新しい outcome
（`aborted_source_forgotten`）・新しい `kind`（`forgotten_before_write`）・新しい
`SourceMemoryForgottenError` は、いずれも非破壊（追加のみ）——この判定自体は変えていない。

**⚠ 2026-09-30 追記2（同日）: union に値を足す変更が「型検査で気づかれる」実例が
本 PR 自身で起きた。** `examples/chat/src/consolidation-cost.ts` は
`outcomes[result.outcome] += 1` という形で `ConsolidateOutcome` を index に使っており
（`ConsolidationOutcomeCountsJson` という、`ConsolidateOutcome` の全値と1対1の欄を
持つ型を経由）、`"aborted_source_forgotten"` を足したことで CI の typecheck が
`TS7053`（index の型に無い値がある）で落ちた。**「union に値を足す変更は破壊的と
数えない」という規律（`docs/migration-v1.md` の数え方の規律）はここでは変えていない**
——数え方の規律は「破壊的変更として計上するかどうか」の話であり、「型検査に一切
影響しないか」とは別である。**網羅的な `Record`/`switch` で `ConsolidateOutcome`/
`ReflectOutcome`/`ConsolidateSourceOutcome`/`ReflectBasisOutcome` を扱っている
利用者は、この手の追加でも型検査が落ちうる**——`docs/migration-v1.md` 項目26と
CHANGELOG の同項目に、この実例を影響の一言として書いた（計上の判定は変えていない）。

**確かめていないこと（この追記の範囲）**:

- Fake の「書く直前の読み直し」だけで保護される場合の、窓の大きさの実測。
- `reextract`（`supersedeWithNewMemories` の別の呼び出し元）には `abortIfForgotten` を
  渡していない——reextract が作る新しい Memory は、供える記憶の本文からではなく
  Observation を抽出した結果であり、供える記憶が forgotten になっても本文が漏れる
  という Issue #1226 と同種の問題を起こさないため、この PR の範囲外とした（意図的な
  除外であり、見落としではない）。

**⚠ 2026-09-30 追記3（同日。この除外は受け入れられた。上の箇条書きは書き換えず、
実測結果をここに足す）**: 除外の理由を一行で言うと——**reextract は元の Observation
から抽出し直す操作で、forget された記憶の本文を材料にしないため**（`extractCandidates`
に渡すのは `observation` であり、既存 Memory の `content` を読んで渡す経路は無い）。

**実測（使い捨てのテスト、Fake・Postgres の両方。commit していない）**: `forget`（と
`forget` → `purge`）した記憶を持つ Observation を、**同じ `extractorVersion`** で
`reextract()` すると、`packages/postgres/src/__tests__/reextract-withdrawn-memories.postgres.test.ts`
（Issue #1079・#1149、既存の歯、今回あわせて再実行して確認）が縛るとおり——`listWithdrawnBySourceObservation`
が forgotten（purge 済みかどうかは問わない。`purge()` は `forgotten` でない記憶を拒むため、
両者は同じ条件で判定できる）を検出し、**LLM を呼ばず・何も書かずに `extraction: "skipped"`
を返す**。forgotten の場合と purged の場合で結果に違いは無い（どちらも `status:
"forgotten"` として同じ分岐に入る）。ここでは新しい active な記憶は一切書かれない。

**別の runtime インスタンス（`extractorVersion` を上げたもの）で reextract すると、
挙動が変わる**——これは Issue #873（2026-09-26 追記、`Runtime.reextract` の doc コメント）
が既に記録している「`extractorVersion` は runtime インスタンスに固定され、
`listBySourceObservation`/`listWithdrawnBySourceObservation` は同じ `extractorVersion`
の記憶しか見ない」という性質の、forgotten/purged な記憶についての具体化である。使い捨ての
テストで実測した: `v1` の runtime で観測・抽出した記憶を forget→purge した後、**`v2`**
の runtime インスタンス（同じ `MemoryStore`・同じテナント・同じ Observation）で
`reextract()` を呼ぶと、`v1` の forgotten な記憶は `listWithdrawnBySourceObservation`
（`v2` の `extractorVersion` でしか見ない）に一切現れず、**LLM が呼ばれ、新しい
`active` な Memory が `extractorVersion: "v2"` として作られる**（`outcome` 相当:
`extraction: "ok"`、`memoryIds` に1件）。その本文は、確かめたとおり Observation を
渡した抽出結果であり（材料はやはり Observation の payload/text）、`v1` の forgotten な
記憶の `content` 列を読む経路は無い——ただし、同じ Observation（同じ元の発話）を
材料にしている以上、実運用の LLM では「forget したはずの事実と意味的に同じ内容」が
新しい `active` な記憶として書かれうる。Fake・Postgres の両方で同じ結果だった。

**気になる点として報告する（判断はしない）**: 上の「別の `extractorVersion` での
reextract」は、forget（および purge）した事実が、抽出器の版を上げるという運用操作
だけで、本文としては別経路（`observation` 経由）からではあるが、意味的には同じ内容が
`active` として書き直されうる、という形に見える。これが Issue #1226 の範囲
（LLM 呼び出しの最中の forget/purge の割り込み）とは別の軸の問題であること、
`extractorVersion` を上げる操作自体が Issue #873 で既に別の性質として記録済み
であることから、本 PR ではこれ以上追わない。

---

## 追記（2026-09-30）: `purgeMemory` の待ち（決定6の費用）と #1428（決定7）の `FOR UPDATE` の相互作用

クローン miku の委譲先が書いた（オーナーではない）。レビューで見つかった所見を受けて書く。

**上の本文（決定1〜8）とすぐ上の「#1226（consolidate/reflect のレース）を PR2 で実装した」
追記は、どちらも書き換えていない。**この追記が足すのは、その2つを組み合わせたときに
初めて見える相互作用である。

**組み合わせ**: `purgeMemory`（`packages/postgres/src/memory-store.ts`）は、同じ
`db.transaction` の中で (1) `memories` の対象行を `UPDATE`（行ロックを取り、`COMMIT` まで
保持——Postgres の行ロックの一般的な性質）、(2) `memory_events` への `INSERT`、
(3) `memory_labels`/`labels` の書き換え（決定2）、(4) 対象テナントの `recalls` 全体を
舐める `index_band` の書き換え（決定3・決定6が費用を実測済み——索引が無いため実質
フルスキャン）を順に行い、最後に `COMMIT` する。一方 #1428（決定7、上の「#1226」追記）の
`assertNotForgottenForUpdate` は、`consolidate`/`reflect` の書き込み直前に同じ `memories`
行を `SELECT … FOR UPDATE` で見直す。**`purgeMemory` が (1) で取った行ロックは (4) の
`recalls` 書き換えの間も保持され続けるため、`assertNotForgottenForUpdate` は `purgeMemory`
が `COMMIT` するまで待たされる**——決定6が実測した `recalls` 書き換えの費用が、
そのまま `assertNotForgottenForUpdate` の待ち時間に乗る形になる。

**実測（2026-09-30、PostgreSQL 17.11、この作業専用の使い捨てデータベース。
再現用のファイルは作らず、commit していない）**: 対象テナントの `recalls` に
`digestBand` 5エントリ（うち1件が対象 `memoryId`）を持つ行を10万件（このテナントの
`recalls` の物理サイズ、実測 `pg_total_relation_size` で約135MB——決定6の実測（10万行・
約57MB）とは行の中身（`digestBand` のエントリ数・文字列長）が違うため単純比較はできない、
同じ「10万行」という規模だけを揃えた）投入し、`purgeMemory` が発行する4文
（上の(1)〜(4)、`COMMIT` を含む）を1つのトランザクションとして`psql`で発行しつつ、
別接続から `SELECT id, status FROM memories WHERE id = ANY(...) FOR UPDATE` を
0.3秒後に発行して待ち時間を計測した:

| 区間 | 実測 |
|---|---|
| `UPDATE memories`（(1)） | 5.6ms |
| `INSERT memory_events`（(2)） | 1.6ms |
| `UPDATE recalls`（(4)、決定6の費用） | **3,436.6ms** |
| `COMMIT` | 21.6ms |
| purge トランザクション全体（`BEGIN`〜`COMMIT`） | 約3.48秒 |
| 別接続の `FOR UPDATE`（purge の `COMMIT` 前に発行） | **約3.21秒**待たされ、purge の `COMMIT` の約30ms後に返った |

⟹ **別接続の `FOR UPDATE` は、`purgeMemory` の `COMMIT` とほぼ同時（今回の実測では
30ms後）に返った。**待っていた間、`assertNotForgottenForUpdate` 自身は何も壊れていない
——`purgeMemory` が `COMMIT` した後に読み直すと対象行は `status = 'forgotten'` のまま
であり（`purgeMemory` は `status` 列を更新しない——本文コード doc 参照）、
`assertNotForgottenForUpdate` は正しく `forgotten` を検出して呼び出し元を
`SourceMemoryForgottenError` で打ち切る（今回の実測でも `status` 列は `forgotten` の
まま読めた。呼び出し元での `SourceMemoryForgottenError` 送出そのものは、この実測では
生の SQL のみを打っており、アプリケーション層を経由していないため確認していない
——下の「確かめていないこと」参照）。**正しさは壊れない**——決定6・#1226 の追記が
それぞれ引き受けた設計のとおりである。

**壊れうるのは正しさではなく待ち時間である**: この実測での約3.2秒という待ちは、
`recalls` の対象テナントの行数・`digestBand` のエントリ数に比例して伸びうる
（決定6が同じ理由で実測している——索引が無いフルスキャン）。`consolidate`/`reflect`
の呼び出し元（runtime・その先の HTTP/ジョブの呼び出し元）が短い `statement_timeout`/
呼び出しタイムアウトを設定していれば、`purgeMemory` の `recalls` 書き換えが長引くほど
`assertNotForgottenForUpdate` 側がタイムアウトで先に切られる可能性がある——この
可能性はこの追記も上の決定6・#1226 の追記も、これまで検討していなかった。

**分類・対処（索引を張るか・timeout をどうするか等）はこの追記では判断しない**——
決定6が既に「`index_band` へ GIN 索引を張る案は書き込み経路の別の負債を引き受ける」と
検討・保留している範囲の延長にあり、あわせてオーナー判断待ちとして残す。

### この追記が確かめていないこと

- `assertNotForgottenForUpdate` が実際に `SourceMemoryForgottenError` を投げるところ
  （アプリケーション層、`@mnemora/postgres` の `PostgresMemoryStore` 経由）は、この
  追記では確かめていない——生の SQL で `FOR UPDATE` が同じだけ待たされ、待った後に
  `status = 'forgotten'` が読めることまでしか確かめていない。
- `consolidate`/`reflect` の呼び出し元（runtime・ジョブ）が実際にどれだけの
  タイムアウトを設定しているか・このシナリオで実際にタイムアウトが trip するかは、
  この追記では調べていない。
- `recalls` が10万行を大きく超える規模（決定6の「確かめていないこと」と同じ範囲）
  での待ち時間の伸び方は測っていない。
- 実測は単一の使い捨て DB・単一のクライアント接続ペアで行った——実運用の
  接続プール・複数の同時 `purge`/`consolidate`/`reflect` が重なる場面は測っていない。
- 測定に使った再現手順（SQL・シェルスクリプト）はリポジトリにコミットしていない
  （`/tmp` に置いて実行し、削除した）。同じ数字の再現性は、同じ手順を打ち直さない
  限り保証しない——上の数字は「この測定での値」であり、恒久的な基準値ではない。

---

## 追記（2026-09-30）: 決定5・「引き受けた負債」4・「これが覆るとしたら」は ADR 0382 で上書きした

クローン miku の委譲先が書いた。オーナーではない（[ADR 0220](./0220-issue-comment-author-does-not-distinguish-owner-from-agent.md)）。

**上の本文（決定1〜8・検討した代替案・引き受けた負債・確かめたこと・確かめていないこと）は
書き換えていない。**当時の記録として残す。

決定5は「別の space の embedding は、この PR では消さない。新しい Issue に切り出す」
とし、`VectorStore` に「全 space を列挙・削除する口」が無いこと・口を新設するなら
必須/任意のどちらにするか・「テナントが過去に使った space の一覧」の台帳をどこに
持たせるかが未決であることを記録し、[Issue #1425](https://github.com/takecchi/mnemora/issues/1425)
に切り出した。「引き受けた負債」4は「別 space の embedding は残ったまま（決定5）。
Issue #1425 に切り出しただけで、この PR は1行も直していない」と書き、「これが覆る
としたら」は「`VectorStore` に space を列挙する口が別 Issue で決まったとき ⟹
`Runtime.purge` がその口を使って全 space の embedding を消すよう決定5を上書きする」
と予告していた。

**[ADR 0382](./0382-vector-store-delete-across-spaces.md) が、この予告のとおり決定5・
「引き受けた負債」4・「これが覆るとしたら」を上書きした。** `VectorStore` に**必須**
メソッド `deleteAcrossSpaces(ctx, memoryIds)` を足し（決定5が未決としていた
「必須/任意のどちらか」は必須と決めた——任意にすると、対応していない adapter では
別 space の embedding が結局消えないという限界が残るため）、`Runtime.purge` がこれを
呼んで全 space の embedding を消すようになった。「台帳をどこに持たせるか」（決定5の
もう1つの未決事項）には、`@mnemora/postgres` の実装はカタログ（`pg_constraint` 等）を
読んで空間を列挙する形で答え、別表の台帳は新設していない——[ADR 0002](./0002-embedding-space-tables.md)
の「space ごとに別テーブル」という設計そのものが、カタログを読めば列挙できる形に
なっている。この ADR 0375 本文は書き換えず、この追記で指し先を更新するだけに留める。
