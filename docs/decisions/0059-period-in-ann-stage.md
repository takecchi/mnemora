# ADR 0059: 段1の ANN クエリで `period` を絞る（`COALESCE(occurred_at, recorded_at)` の式索引を1本足す）

- **状態**: 採用 (2026-09)

- **文脈**:

  `docs/recall.md` §3 の段1（ANN 検索、`VectorFilter` を渡す `VectorStore.search`）は、
  `tenant_id` / `status` は絞るが、`period`（`occurredAfter`/`occurredBefore`）は絞らずに
  ANN を実行し、`period` は段2（`recall-runtime.ts` の後段フィルタ）でのみ捨てていた。
  これは[ADR 0023](./0023-subject-filter-in-ann-stage.md)が明示的に決めたことである——
  `subjectId` は等値比較なので段1へ降ろしたが、`period` は連続値の範囲比較であり、
  `docs/recall.md` が指摘する「partial index は離散値・低カーディナリティのフィルタに
  向くが、連続値の範囲比較には向かない」（`docs/recall.md:135`）という制約に関わる
  ——降ろすには索引設計（バケット列か式索引か）に踏み込む判断が要るとして、
  ADR 0023 の範囲では見送った。

  ⟹ ADR 0023 が `subjectId` について指摘したのと同じ構造の穴が `period` にも空いている。
  **大規模テナントで狭い時間窓（例:「直近1日」）を指定すると、over-fetch の窓
  （`k' = limit × overFetchFactor`、既定40）がテナント全体の近傍で埋まり、
  窓内の記憶が1件も残らないまま黙って落ちうる。**[ADR 0056](./0056-exclude-provenance-kinds-in-ann-stage.md)
  は同じ構造の穴を `excludeProvenanceKinds`（離散値の等値比較）について塞いだが、
  `period` は「今回も降ろさない」と明記して見送った——ADR 0023 の却下理由（連続値の
  範囲比較）がそのまま残っていたためである。

  **本 ADR で、その却下理由を実際に解消する**: 式索引
  `(tenant_id, status, COALESCE(occurred_at, recorded_at))` を1本追加することで、
  連続値の範囲比較を索引で支える。ADR 0023 が「バケット列を足すか、というスキーマに
  踏み込む判断が要る」と書いた、その判断そのものである。

  `docs/roadmap.md:249`（オーナー回答 2026-09-06、マネージャー経由で伝達）は
  「テナントあたりの想定記憶数は100万件級を前提に設計する」と確定している。
  ⟹ 本 ADR が扱う穴（狭い窓 × 大規模テナントの取りこぼし）は、この前提の下で
  実際に起こりうる規模の問題として扱う。

- **決定**:

  1. **段1の `WHERE` 句に `period` の述語を降ろす。** 比較対象は
     `COALESCE(occurred_at, recorded_at)`（[ADR 0039](./0039-period-boundary-conformance.md)が
     定義した「実効時刻」——4箇所あった判定規則の5箇所目になる）。両端とも包含
     （`occurredAfter` は `>=`、`occurredBefore` は `<=`）——`RecallQuery.occurredAfter`・
     `memory-store.ts` の `aggregateScope` が既に使っている厳密経路と同じ境界の含み方に
     揃える。
  2. **`VectorFilter`（`packages/core/src/interfaces/vector-store.ts`）に
     `occurredAfter?: Date` / `occurredBefore?: Date` を足す。** `recall-runtime.ts` の
     段1呼び出しに `occurredAfter: scope.occurredAfter` / `occurredBefore:
     scope.occurredBefore` を渡す。
  3. **段2の後段フィルタ（`effectiveTime` による `continue`）は残す。** ADR 0023・ADR 0056
     と同じ多層防御——`VectorFilter` は adapter が実際に適用しなければならない契約
     （ADR 0034）だが、正しさの責任は後段にも置く。
  4. **`(tenant_id, status, COALESCE(occurred_at, recorded_at))` の3列の式索引を1本、
     追加だけで入れる**（`packages/postgres/migrations/0003_period_ann_stage_index.sql`、
     `idx_memories_period_ann_stage`）。**既存の `idx_memories_recall_gate`
     （`tenant_id, status, decay_floor_at`）は作り直さない。** 詳細は「採らなかった案」参照。
  5. **`hnsw.iterative_scan` は入れない。** これは「良い案だが今回は採らない」ではなく、
     **別の PR・別の ADR の腕として意図的に切り出した**——`docs/recall.md` §3 が
     「フィルタ問題」と「スコア問題」を別機構で解くと決めた枠組みの中で、`period` の
     押し下げは前者に対する一つの手（索引側で候補を絞る）であり、`hnsw.iterative_scan`
     はもう一つの独立した手（ANN の探索側を深くする）である。両方を同じ PR に混ぜると
     「どちらの効果か」が実測で切り分けられなくなるため、腕を分けた。棄却したのではなく、
     **測る対象を1PRにつき1つに絞った。**

- **理由**:

  1. **ADR 0023 が `period` を降ろさなかった理由は、索引設計に踏み込む判断が要るという
     一点だった。** 本 ADR はその判断を実際に行っている——式索引という形で、連続値の
     範囲比較を索引に支えさせた。ADR 0023 の却下理由は解消された。
  2. **段1と段2の二重構造そのもの（多層防御）は変えない。** `subjectId` /
     `excludeProvenanceKinds` と同じ枠組みに `period` を合流させるだけであり、
     `VectorStore` の契約（絞る義務を持つが、正しさの責任は後段にもある）に
     新しい例外を作らない。
  3. **式索引を選び、バケット列を選ばなかった。** バケット列（例:「直近30日」)は
     離散化のために新しい列とその再計算ロジックが要り、粒度の設計（何日単位か）という
     別の判断を持ち込む。式索引は既存の2列（`occurred_at`/`recorded_at`）から
     `COALESCE` で計算できる値をそのまま索引化するだけで、新しい列もバッチ更新も
     要らない。

- **⚠ 実測値 — 出どころの明記**:

  以下の数値は、**別の委譲（前任者）が 100,000行・256次元・1点のみで測ったと報告した値
  である。マネージャーはこれを裏取りしていない。前任者自身も「引き写しであり裏取りして
  いない」と書いている。本 ADR の作業者（このドキュメントを書いている本人）も、この
  作業環境には測定用の PostgreSQL / `DATABASE_URL` が無く、裏取りしていない。**
  以下は伝聞の引き写しとして扱うこと。

  - 狭い窓（0.1%）では、96件が実在するのに `recall()` は0件を返す。この索引（本 ADR、
    以下 P2 と呼ぶ）を入れると40件返る——厳密・基準線（索引なし）より速い
    （1.9ms vs 8.5ms、と報告されている）。
  - P2は現状より悪くなる窓が無いと報告されている——広い窓（10%/50%）では現状＋後段
    フィルタと構造的に同一プランになり、返却数も一致する（10%: 7 vs 7、50%: 21 vs 21）。
    ⟹ 実測4点（0.1%・1%・10%・50%の4窓、と推定される。前任者の報告に窓の一覧は
    明示されていないため、本 ADR で断定はしない）で退行なしの片側改善、という報告。
  - 静かには落ちないと報告されている（`annHits.length < kPrime && annHits.length <
    eligible` で `Omission { kind: 'ann_unreached' }` が立つ）が、`countKind: 'unknown'`
    なので「0/96 だった」ことは呼び出し側には伝わらない。

  **⭐ 上記のうち、`ann_unreached` の発火条件と `countKind: 'unknown'` の部分は、
  本 ADR の作業者がコードを読んで確認した**（伝聞ではない）。
  `packages/core/src/recall-runtime.ts:632-644` に、
  `candidateGenerationExecuted && kPrime > 0 && annHits.length < kPrime &&
  annHits.length < eligible` の条件で `omitted.push({ kind: "ann_unreached",
  countKind: "unknown" })` が立つコードがある。`eligible` は
  `aggregate.totalInScope - notIndexedTotal`（段5の集約に依存）であり、
  `countKind` は常にリテラル `"unknown"` で、`period` によって取りこぼした件数
  （上の例で言えば 96 件）を運ぶ欄はどこにも無い。⟹ 呼び出し側が受け取る `omitted` は
  「近似索引がこの scope に届かなかった」という定性的な事実だけで、
  「0件のはずが実は96件在った」という定量的な事実は伝わらない、という報告の記述は、
  コード上正確である。

- **測っていないこと（本 ADR の要）**:

  - **実測は 100,000行・256次元の1点のみ。** オーナーは100万件級を前提に設計すると
    決めている（`docs/roadmap.md:249`、2026-09-06、マネージャー経由）。**この決定が
    前提とする規模の1桁下でしか測っていない。**
  - **1,536次元は未測定。** 実運用で使う OpenAI 埋め込み（`text-embedding-3-small` 相当）
    の次元数であり、256次元とは埋め込みテーブルの行幅が異なる——プラン選択・費用が
    変わりうることは ADR 0023 が別の軸（次元ではなく規模）について既に指摘している
    通りである。
  - **クエリベクトルは1本のみ**測定に使われたと報告されている。
  - **同時実行下では未測定。** 単発クエリの中央値のみ、という報告。
  - **広い窓（10%/50%）の絞りは効かないまま残る。** 本 ADR はこれを塞がない
    ——現状＋後段フィルタと同一プランになる、という報告そのものが「広い窓では
    索引が効かず、従来と同じ挙動になる」ことを意味する。
  - **式索引は段5（`aggregateScope`）には効かない。** これは実測で反証済みと
    報告されている——`period` の述語は段5の `WHERE` ではなく
    `count(*) FILTER (WHERE ...)` の中に在る（`packages/postgres/src/memory-store.ts:724`
    付近、`filteredPeriod: { count: sum("period_filtered"), ... }`）ため、索引の
    有無でプランが変わらない。索引在り 32.2ms / 索引無し 36.0ms、プランは完全に同一、
    という値も前任者からの引き写しであり、裏取りしていない。

- **🔴 根拠に使ってはいけないもの（明示的に排除する）**:

  1. **「厳密経路の費用はテナント行数に比例して伸びる」（ADR 0023 の当初の代償節）は、
     本 ADR の根拠に使わない。** ADR 0023 自身の追記
     （`0023-subject-filter-in-ann-stage.md:187-196`「この実測が言っていること、
     そして見立ての訂正」節）が、これを自分で撤回している。**本 ADR の作業者が
     現物を読んで確認した要約**: ADR 0023 の当初の代償節は「上のプランは埋め込み
     テーブル側を `Seq Scan` している……この経路の費用はテナントの行数に比例して
     伸びる」と書いていたが、これは 3,000行・100 subject という小さい規模での
     観測だった。同じ ADR の追記（10,000行・100,000行で subject フィルタを再測定）
     では `Seq Scan` は一度も出ず、`idx_memories_by_subject` → 埋め込み表の主キーの
     `Nested Loop` が選ばれ、所要時間はほぼ横ばい（1.1ms→0.9ms、1.2ms→0.9ms）だった。
     ADR 0023 自身が「当時観測した3,000行での `Seq Scan` は、表が小さいときの産物
     だった可能性が高い」と結論している。⟹ 「厳密経路は規模に比例して重くなる」を、
     本 ADR の穴（式索引を追加すべき理由）の根拠として引用しない。
  2. **ADR 0011 の数字とその機構を、そのまま `period` に転用しない。** ADR 0011 の
     実測値は `1.5 ms → 156 ms`である（本 ADR の作業者が `grep` で現物を確認済み。
     `0.9ms → 228ms` という数字は本 ADR の対象リポジトリのどこにも存在しない誤りである）。
     **さらに機構が違う**——ADR 0011 が測ったのは `count(*) OVER ()`、すなわち
     **窓関数の集約**が索引を殺す現象であり、`period` は単なる**フィルタ**
     （`WHERE` 句の等値/範囲条件）である。ADR 0011 自身が `docs/recall.md` の
     「フィルタ問題」と「スコア問題」を区別しており、`count(*) OVER ()` は後者に近い
     集約の問題、`period` の押し下げは前者のフィルタの問題である。**同じ形の劣化
     （索引が死んで100倍遅くなる）が `period` にも起きる、と結論しない。**
     測ってはいないが、機構が違う以上、ADR 0011 の数字を根拠として引用しない。

- **採らなかった案**:

  - **`hnsw.iterative_scan` を有効化する**: 採らない。上記「決定」5. の通り、
    棄却ではなく別の腕として切り出した——本 ADR が扱う「索引側でフィルタを支える」
    手と、`hnsw.iterative_scan` の「ANN の探索を深くする」手は独立した対処であり、
    同じ PR に混ぜると効果が切り分けられない。
  - **既存の `idx_memories_recall_gate`（`tenant_id, status, decay_floor_at`）を、
    `period` も含む形に作り直す**: 却下。この索引は
    [ADR 0011](./0011-no-window-count-in-ann-stage.md)が「Phase 2 で
    `decay_floor_at` を読み取りフィルタに使い始める際に索引の作り直しが要らないように」
    という理由で3列目に `decay_floor_at` を持たせて設計したものであり、既に別の
    将来の判断（Phase 2 の decay 読み取り）のために予約されている列を持つ。ここへ
    `period` を混ぜると、`decay_floor_at` を使い始める Phase 2 の変更と、`period` を
    使う本 ADR の変更が同じ索引の同じ列を取り合う形になり、片方の都合でもう片方の
    索引設計が壊れる余地を持ち込む。**追加だけで独立した索引を1本作るほうが、
    将来の変更同士を疎に保てる。**
  - **2列 `(tenant_id, COALESCE(occurred_at, recorded_at))` の索引**: 却下。
    段1のクエリは既に `status IN ('active', 'contested')` で絞っており
    （`docs/recall.md` §3 の段1クエリ骨格）、`status` を索引の2列目に含めない場合、
    `status` は索引スキャン後の `Filter` として効くだけで、索引の絞り込みそのものには
    寄与しない。2列目に `status` を挟むことで、索引の時点で `status` の等値条件まで
    畳み込める。列順は「等値条件を前に、範囲条件を最後に」という B-tree の一般則
    （`tenant_id` 等値 → `status` 等値 → `COALESCE(...)` 範囲）に従っている。
  - **段1に降ろさず、後段フィルタだけで済ませる現状維持**: 却下。ADR 0023 が
    `subjectId` について指摘し、ADR 0056 が `excludeProvenanceKinds` について繰り返した
    同じ構造の穴（狭い絞り × 大規模テナントでの窓の取りこぼし）が `period` にも
    残ったままになる。上の実測（伝聞、裏取りなし）が正しければ、狭い窓では
    96件中0件しか返らない、という規模の取りこぼしであり、現状維持の負債としては
    大きい。

- **移行（migration）についての判断**:

  `packages/postgres/migrations/0003_period_ann_stage_index.sql` は**素の
  `CREATE INDEX`**（`CONCURRENTLY` を付けない）である。**これは意図的であり、正しい。**

  理由（本 ADR の作業者が `packages/postgres/src/migrate.ts` の現物を読んで確認した）:
  各マイグレーションは `migrate.ts:340` の `await client.query("BEGIN");` から
  `migrate.ts:349` の `await client.query("COMMIT");` までの間で実行される
  ——つまり**1マイグレーション＝1トランザクション**であり、`CREATE INDEX
  CONCURRENTLY` はトランザクションブロックの内側では実行できない（PostgreSQL の制約。
  `CONCURRENTLY` はトランザクションの外側でしか使えない）。⟹ この実行系を使う限り、
  `CONCURRENTLY` という選択肢はそもそも存在しない。既存の
  `0002_outbox_claim_lease_index.sql` も同じ理由で素の `CREATE INDEX` を使っており、
  本マイグレーションはその先例と整合している。

  **引き受ける負債として記録する**:

  1. **索引作成中は `memories` テーブルに `ACCESS EXCLUSIVE` ロックが掛かり、
     その間 `memories` への書き込み（`observe()` からの挿入・`reinforce`・
     `setEmbeddingStatus` 等すべて）が止まる。** 100万件級のテーブルでは、
     この停止時間が実運用上無視できない長さになりうる——具体的にどれだけ止まるかは
     測っていない。
  2. **`CONCURRENTLY` が使えないのは、実行系（`migrate.ts`）が各マイグレーションを
     トランザクションで包んでいるという設計上の制約による。** マイグレーションの
     内容側の選択ではない——`0003_period_ann_stage_index.sql` だけを直しても解決しない。

  **⚠ 非トランザクションの移行経路を別に作るかどうかは、本 ADR の範囲を超える、
  もっと大きい判断である。** 本 ADR はこれを「そうすべきだ」とは決めない
  ——「別の判断として残っている」とだけ書く。決めるとしたら、既存の全マイグレーションの
  実行モデル（advisory lock によるプロセス間排他、ADR 0017）との整合を含めて
  再設計が要り、1本の索引追加のために決めることではない。

- **これが覆るとしたら**:

  - **1,536次元・100万件級・同時実行下での実測**が行われ、狭い窓での改善が
    256次元・100,000行の実測と同じ傾向を示さなかったら、この索引の設計
    （列順・式）を見直す。
  - **索引作成の `ACCESS EXCLUSIVE` ロックが実運用で許容できない長さになる**ことが
    判明したら、非トランザクションの移行経路（`CONCURRENTLY` を使える実行系）を
    別途設計する、より大きな判断を起こす引き金になる。
  - **広い窓（10%/50%）での取りこぼしが実際に問題として顕在化したら**、
    `hnsw.iterative_scan` の腕、あるいは段5側の集約高速化を別 ADR で検討する。
  - **`period` の取りこぼしが `omitted` から読み取れないこと（`countKind: 'unknown'`
    のまま）が運用上困る**と分かったら、`ann_unreached` の情報量を増やす設計
    （ADR 0025/0026 の延長）を検討し直す。

- **確かめていないこと（まとめ）**:

  - 上の「実測値」「測っていないこと」節にある通り、本 ADR の実測はすべて伝聞
    （前任者の報告）であり、本 ADR の作業者は測定用 PostgreSQL を持たず、
    一度も再現していない。
  - `ann_unreached` の発火条件・`countKind: 'unknown'` の記述のみ、コードを読んで
    確認済み（伝聞ではない）。
  - `migrate.ts` のトランザクション構造・`ACCESS EXCLUSIVE` ロックの発生自体は
    現物のコードと PostgreSQL の一般的な仕様から導いたものであり、実際に本番規模で
    ロック待ちがどれだけ発生するかは測っていない。
  - ADR 0039 が指摘した「実効時刻の定義が5箇所に増える」ことについて、
    `VectorFilter.occurredAfter`/`occurredBefore` の境界規則（両端包含）が
    他の4箇所と揃っていることは、本 PR の実装（`packages/postgres/src/vector-store.ts`
    の `>=`/`<=`）を読んで確認した。**境界の歯も実際にこの5箇所目を狙って書かれている
    ことは、本 ADR の作業者が `packages/testkit/src/vector-store-conformance.ts` の
    差分を読んで確認した**——境界ちょうど・`COALESCE` のフォールバック（`occurredAt`
    が `null` のとき `recordedAt` を使う）を検査する3本が追加され、postgres/in-memory
    両方の適合テストに配線されている（`conformance.postgres.test.ts`・
    `in-memory-fixtures.conformance.test.ts` の差分）。**ただしこれはコードを読んで
    確認しただけであり、この作業環境には測定用 PostgreSQL / `DATABASE_URL` が無いため、
    postgres 側の歯を実際に実行して緑になることまでは確認していない。**
