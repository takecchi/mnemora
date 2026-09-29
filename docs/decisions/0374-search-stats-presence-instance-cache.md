# ADR 0374: `search()`/`searchMany()` の統計あり・無し切り替えを、1本の SQL の中の One-Time Filter から、インスタンス単位の記憶（`StatsPresenceGate`）へ変える（Issue #1415）

- **状態**: 採用 (2026-09)
- **日付**: 2026-09-29

> **⚠ 本文はクローン miku の委譲先が書いた。オーナー本人の執筆ではない。**
> この担い手・マネージャーの署名は repo 上では `takecchi` になり、オーナー本人と
> 区別が付かない（[ADR 0220](./0220-issue-comment-author-does-not-distinguish-owner-from-agent.md)）。

**⚠ 各主張の出所を分ける**（ADR 0362 / ADR 0367 の体裁を踏む）。

- **【現物】** — この repo のコード・文書を、この ADR の書き手が自分の手で読んで確かめた。
- **【実測】** — この書き手が実際に `psql`/`vitest`/`tsc`/`pnpm`/`git` を走らせて確かめた。
- **【受】** — 報告・外部ドキュメントとして受け取り、自分では再導出していない（出所を明記する）。

- **文脈**:

  [ADR 0362](./0362-searchmany-lateral-forces-memories-primary-key-lookup.md) は
  Issue #1181（`searchMany()` が統計の無い小さい DB で `memories` を `Join Filter`
  越しに全数比較する悪いプランを選ぶ）を、`pg_class.reltuples` を1本の SQL の中の
  スカラー副問い合わせとして埋め込み、Postgres の「One-Time Filter」
  （`LATERAL` の繰り返しに関係なく1回だけ評価される）で統計あり・無しの2形を
  切り替える形（「案2」）で直した。

  [Issue #1415](https://github.com/takecchi/mnemora/issues/1415) は、`search()`
  （段1、`searchMany()` の単一クエリ版）が同じ欠陥を持っていることの調査を依頼した。
  【実測】`search()` は実際に同じ欠陥を持っていた——統計が無い小さいテナントで
  `memories_pkey` を経由せず、`Join Filter: (m.id = e.memory_id)` を伴う
  `Nested Loop` を選ぶ（EXPLAIN で確認、`search-primary-key-lookup.postgres.test.ts`
  の1つ目の歯がこれを固定する）。

  ADR 0362 と同じ「案2」（reltuples + One-Time Filter）を `search()` にそのまま
  適用し、[本 Issue の依頼どおりの手順](https://github.com/takecchi/mnemora/issues/1415)
  で固い測り直し（12往復×25回の中央値、統計がある場面、N=200・アンカー3）を
  行ったところ、**diff の中央値が +5.06ms** だった——ADR 0362 が固定した許容線
  （約2ms）を大きく超える。N=3000・アンカー3は +1.84ms で線内に収まったが、
  依頼主（マネージャー）は「N=200 で線を大きく超える」ことを理由に、この案2を
  `search()`/`searchMany()` の両方から外し、別の仕組み（本 ADR、通称「案A」）へ
  切り替えると決めた——「線を緩める」判断は、Issue #1181 の測定でも同じ理由で
  一度退けられている（下の「案2をこのまま `search()` に使う案」参照）。

  **なぜ案2は `search()` で `searchMany()` より高くつくのか（推測）**: `search()` の
  4枝ぶんの `UNION ALL`（実際は2枝＋統計判定の分岐、`searchMany()` は
  `LATERAL` 越しにアンカー数ぶん繰り返す1本の複雑な SQL）に対して、`search()` は
  そもそも1回きりの単純な2枝の `UNION ALL` であり、母数となる実行時間そのものが
  小さい。同じ絶対量の「reltuples を読むオーバーヘッド」でも、母数が小さいほど
  相対的な影響（測った diff の中央値）が大きく出る、という以上のことはこの ADR
  では確かめていない（下の「確かめていないこと」）。

- **決定**:

  ## 決定1: 「案A」——`PostgresVectorStore` インスタンスが、表ごとに一度だけ確かめる

  `ADR 0367`（[Issue #1301](https://github.com/takecchi/mnemora/issues/1301) の
  `PgvectorCapabilityGate`）と同じ形の、インスタンス単位の記憶を持つ
  `StatsPresenceGate` クラス（`packages/postgres/src/vector-store.ts`）を新設する。

  ```ts
  class StatsPresenceGate {
    private readonly confirmed = new Set<string>();

    async bothPresent(db: Db, table: string): Promise<boolean> {
      if (this.confirmed.has(table) && this.confirmed.has("memories")) {
        return true;
      }
      const result = await db.execute(sql`
        SELECT
          (SELECT reltuples FROM pg_class WHERE oid = to_regclass(${table})) AS embedding_reltuples,
          (SELECT reltuples FROM pg_class WHERE oid = to_regclass('memories')) AS memories_reltuples
      `);
      const row = result.rows[0] as unknown as {
        embedding_reltuples: string | number;
        memories_reltuples: string | number;
      };
      if (Number(row.embedding_reltuples) >= 0) this.confirmed.add(table);
      if (Number(row.memories_reltuples) >= 0) this.confirmed.add("memories");
      return this.confirmed.has(table) && this.confirmed.has("memories");
    }
  }
  ```

  `PostgresVectorStore` インスタンスに `statsPresenceGate` フィールドを1つ持ち、
  `search()`/`searchMany()` の両方が共有する（`pgvectorCapabilityGate` と同じ並び）。

  `search()`/`searchMany()` はどちらも、本体の SQL を発行する**前**に
  `const statsPresent = await this.statsPresenceGate.bothPresent(this.db, table);`
  を呼び、JavaScript 側で分岐する:

  - **`statsPresent === true`**（表・`memories` の両方が確認済み）——
    `buildStatsPresentBranches`（今日の main と同じ、素の
    `JOIN memories m ON m.id = e.memory_id AND m.tenant_id = e.tenant_id`）を使う。
    **この枝は ADR 0362 以前の main、および Issue #1415 の前の `search()` と
    1バイトも変わらない**——`reltuples` の副問い合わせも、One-Time Filter も、
    候補D の痕跡も一切含まない。
  - **`statsPresent === false`**（表・`memories` のどちらかが未確認）——
    `buildStatsMissingBranches`（候補D、`CROSS JOIN LATERAL (SELECT * FROM
    memories WHERE id = e.memory_id OFFSET 0) m`、ADR 0362 が実測で固定した形を
    そのまま流用）を使う。

  `search()`/`searchMany()` は今後この**1つの仕組み**を共有する——ADR 0362 の
  One-Time Filter（1本の SQL に両形を並べて `reltuples` の副問い合わせで切り替える
  やり方）は、`searchMany()` からも撤去する。

  ## 決定2: 状態の範囲は「インスタンス・表ごと」——大域変数・`static` にしない、テナントごとには持たない

  `PgvectorCapabilityGate`（ADR 0367 決定4）と同じ設計判断を、表という次元を
  1つ足して踏襲する。

  - **表ごと**: `memories` は全空間で共有される1テーブルだが、埋め込み表は空間
    （`EmbeddingSpaceId`）ごとに別の物理テーブル（`memory_embeddings_<space>`）を
    持つ。ある空間の埋め込み表の統計が確認済みでも、別の空間の埋め込み表は
    まだ未確認のことがある——`confirmed: Set<string>` は埋め込み表の名前ごとに
    別々のエントリを持つ（`memories` は表名を持たない特別な1エントリとして
    同じ `Set` に同居する）。
  - **インスタンスごと**（大域変数・`static` にしない）: プロセス内に複数の
    `PostgresVectorStore` インスタンスが在るとき、片方が確認済みでも、もう片方は
    別に確認する。共有すると「別のインスタンスはまだ確認していない」という
    前提に依存したテストで覚え間違いを検出できなくなる。
  - **テナントごとには持たない**: `pg_class.reltuples` は表単位の統計であり、
    テナント単位の情報ではない——テナントが変わっても、確認済みの状態は同じ
    インスタンス・同じ表の中で共有される。

  【実測】この3点は `search-stats-presence-scope.postgres.test.ts`（新設）が、
  `StatsPresenceGate` のプライベートな状態を直接覗かず、**副作用**
  （`countMatchingQueries` で `reltuples` を含むクエリの発行回数を数える）を
  通して確かめている:

  - 表Aを確認済みにしても、統計の無い別の表Bは相変わらず未確認（往復1回のまま）。
  - 別の `PostgresVectorStore` インスタンスは、確認済みの表でも自分ではまだ
    未確認として扱う（大域・`static` で共有していないことの直接の証拠）。
  - テナントを変えても、確認済みの状態は同じインスタンス・表の中で共有される
    （往復が増えない）。

  ## 決定3: 統計が後で消えても（`TRUNCATE`・表の作り直し）確認し直さない——結果は変わらず、遅くなるだけ

  **一度 `true` を覚えたら、そのインスタンスの寿命の間ずっと `true` のまま。**
  統計が後で消えても（`TRUNCATE`・表の作り直し等）確認し直さない設計を、
  マネージャー・依頼主が明示的に受け入れた。

  この場合に起きるのは「統計が無いのに、あると思い込んだ SQL（今日の main の形）を
  送る」ことだけである——Issue #1181/#1415 が直す前と同じ、統計に基づく誤ったプラン
  （悪くても `Join Filter` 越しの全数比較）に**戻りうる**が、`filter` が指す集合・
  順序・同点の決着は、統計の有無に関わらず一致する（`buildStatsPresentBranches`/
  `buildStatsMissingBranches` は同じ `WHERE`/`ORDER BY`/`LIMIT` の骨格を共有する
  よう作ってあり、`search-stats-presence-result-equivalence.postgres.test.ts`
  （新設）・既存の `search-many-primary-key-lookup.postgres.test.ts` が結果一致を
  縛っている）。⟹ **引き受けた負債は「遅くなりうる」だけであり、「間違った結果を
  返す」ことは含まない。**

  この負債を引き受ける理由: `TRUNCATE`・表の作り直しは、通常運用では稀な操作
  （テストの後始末、意図的なデータ全消去等）であり、この稀な場合のためだけに
  「確認済みでも定期的に再確認する」仕組み（新しい閾値・タイマー・TTL）を足すと、
  ADR 0362 が最初に踏んだのと同じ「統計がある定常状態でも `reltuples` を読み
  続けるコストを払う」問題を、形を変えて呼び戻すことになる。

  ## 決定4: 案2（1本の SQL・One-Time Filter）は `search()`/`searchMany()` の
  両方から撤去する。ADR 0362 の本文は書き換えない

  ADR 0362 の「決定」節・実測データはそのまま残す（歴史的な記録として）。
  本 ADR は ADR 0362 が採った One-Time Filter の仕組みそのものを置き換える
  ——ADR 0362 の末尾に、本 ADR を指す短い追記だけを足す（本文は書き換えない）。

- **測定**（同じ許容線: 統計がある場面の `recall()` 全体、アンカー3の既定、diff の
  中央値が N=200・N=3000 のどちらでも2ms以内、かつ N とともに伸びないこと。
  12往復以上、1点=20〜30回の中央値、alternating before/after、別 worktree/別ビルド。
  [PR #1410 の測定](https://github.com/takecchi/mnemora/pull/1410) と同じ手法）:

  `recall()` は既定で `search()`（主チャンネル）と `searchMany()`（連想枠のアンカー
  一括）の両方を1回の呼び出しの中で使うため、`recall()` 全体を測ることで両方の
  変更を同時に検算する（12往復、各点は warmup5回を捨てた後の25回の中央値、
  `/tmp` 配下の別 worktree・別ビルドを交互に呼ぶ）。

  【実測・案A（本 ADR）、統計がある場面。diff = after(本ADR) − before(main)】

  | N | アンカー数 | diff 中央値 |
  |---|---|---|
  | 200 | 3 | -0.54ms |
  | 3000 | 3 | -1.25ms |
  | 200 | 10 | -0.73ms |
  | 3000 | 10 | -0.26ms |

  4点とも許容線（2ms）以内、かつ N とともに伸びていない（むしろ全点で `after` が
  `before` と同等かわずかに速い側に振れた——`main` の One-Time Filter が
  `reltuples` を毎回読みに行っていたコストが、本 ADR で無くなった分と解釈できるが、
  ばらつきの範囲内でもあり、これ以上の主張はしない）。

  【実測・統計が無い場面、改善値（N=200、`recall()` は既定 `limit:40`）】

  | 対象 | アンカー数 | before（main） | after（本ADR） |
  |---|---|---|---|
  | `recall()` 全体 | 3 | 72.7ms | 33.0ms |
  | `recall()` 全体 | 10 | 57.3ms | 36.6ms |
  | `search()` 単体 | — | 10.5ms | 4.3ms |
  | `searchMany()` 単体 | 3 | 6.3ms | 5.0ms |
  | `searchMany()` 単体 | 10 | 9.0ms | 8.0ms |

  `search()` 単体・`recall()` 全体は、`search()` に候補D が初めて入ったことで
  明確に速くなった（`memories_pkey` 経由、`Join Filter` 無し）。`searchMany()`
  単体は ADR 0362 で既に候補D 経由になっていたため改善幅は小さいが、悪化はして
  いない——`reltuples` を毎回 SQL の中で読んでいた分（One-Time Filter）が、
  本 ADR では「未確認の間だけ余分な往復1回」に変わったことと整合する。

  【実測】`recall-roundtrip-count.postgres.test.ts` 歯6（新設）で、`recall()` の
  往復数が「`StatsPresenceGate` が未確認の間だけ+1、確認済みになったら今日と同じ
  数へ戻る」ことを、専用の（他ファイルと共有しない、一度も `ANALYZE` していない）
  埋め込み表を使って直接確認した——4回連続で `runtime.recall()` を呼び、
  1回目→2回目で pgvector 能力検査ぶんの+1が消え、2回目→3回目（ANALYZE を挟む）
  は変わらず、3回目→4回目で `StatsPresenceGate` ぶんの+1が消えることを実測した。

- **テストの並列/直列判断（ADR 0371 の基準に基づく）**:

  ADR 0371 が直列の群に入れる基準は「DB を分けても隔離できない、クラスタ全体に
  効く操作」（`pg_stat_activity`/`pg_terminate_backend`/`pg_locks`/`CREATE ROLE`）
  である。本 Issue で新設した歯はどれもこれらを使わないため、直列の群
  （`SERIAL_TEST_FILES`）には追加していない。

  **`ANALYZE memories` を打つ歯が、並列の群で他のファイルに影響しないか**
  ——これが本 Issue の依頼で名指しされた懸念であり、以下のとおり確かめた:

  - 【現物】ADR 0371 の設計により、`postgres-db-parallel` project の worker は
    ファイルを**1本ずつ順に**処理する（同じ worker 内でファイルが同時に走ることは
    無い）——worker ごとの専用 DB（`mnemora_test_w<N>`）は、あるワーカーが
    同時に処理する複数ファイル間の競合を防ぐためではなく、**別のワーカー**同士の
    競合を防ぐためのものである。⟹ 同じ worker DB を使う2つのテストファイルが
    `memories` に対して同時に `ANALYZE`/`INSERT` を打つことは、そもそも起こらない。
  - 残る懸念は「同じ worker DB を使う、**先に**走った別のファイルが `memories` を
    実データで `ANALYZE` 済みにしていて、後から走るこの歯の前提（統計が無い）が
    崩れないか」——【実測・ADR 0362 が既に記録した事実】`migrations/0005_analyze_memories.sql`
    が新規インストールの空テーブルに対して `ANALYZE` を打つため、`memories.reltuples`
    は worker DB が TEMPLATE から複製された時点で既に `0`（`-1` ではない、
    「統計あり」側）に固定されている——**どの worker DB でも、`memories` は
    最初から `StatsPresenceGate` にとって「確認済み」である。** ⟹ 本 Issue の
    新設した歯が「統計が無い」状態を作れるかどうかは、実質的に**埋め込み表側**の
    `reltuples`（`registerEmbeddingSpace` が都度、一意な名前で新しく作る物理テーブル
    であり、他のファイルの活動に関わらず必ず `-1` から始まる）だけに懸かっている
    ——`memories` 側の状態は、他のファイルが何をしていようと変わらない。
  - この理由により、`search-primary-key-lookup.postgres.test.ts` /
    `search-many-primary-key-lookup.postgres.test.ts`（既存、PR #1410）/
    `search-stats-presence-result-equivalence.postgres.test.ts` は、いずれも
    共有の worker DB（`getTestClient()`）をそのまま使う——各歯が一意な
    `EmbeddingSpaceId`（`randomUUID()` を含むモデル名）で都度新しい埋め込み表を
    登録するため、他のファイルの `ANALYZE`/行数の蓄積から隔離されている。
    **各歯末尾の自己検算**（`search-stats-presence-result-equivalence...` の
    `unanalyzedUsedCandidateD`/`analyzedUsedCandidateD` アサーション）が、
    万一この前提が崩れた場合に沈黙せず落ちるようにしてある。
  - `search-stats-presence-scope.postgres.test.ts`（新設）だけは、
    `memories-statistics.postgres.test.ts` と同じ「専用の使い捨てデータベース」
    パターンを採った——この歯は複数の表・複数のインスタンスにまたがる往復数の
    精密な数え上げ（`countMatchingQueries` で厳密に 0/1 を検算する）を何度も
    連続して行うため、共有 worker DB 上の他の活動（例えば autovacuum・他プロセスの
    接続）による偶発的なノイズの可能性を、上の推論に頼らず構造的に無くしておく
    ほうが安全だと判断した——**これは必須ではなく、防御的な選択である**（上の
    推論のとおり、`memories` 側は他ファイルの影響を受けない設計だが、この歯は
    「往復が0回か1回か」という際どい数を何度も検算するため、疑いの余地を
    構造的に消しておく価値がある）。
  - **2026-09-29 追記（直列の群へ移した）**: `recall-roundtrip-count`・`search-many-primary-key-lookup`・`search-primary-key-lookup`・`search-stats-presence-result-equivalence`（いずれも `.postgres.test.ts`）を `SERIAL_TEST_FILES` へ移した——worker 専用 DB の `memories` に `ANALYZE` を明示的に打つので、上の推論（`StatsPresenceGate` の判定は変わらない）とは別に、同じ DB を後から使うファイル（統計の有無を前提にする `memories-statistics` や、プランの形を縛る歯）の見積もりを変えうるため。`search-stats-presence-scope` は専用の使い捨て DB で `ANALYZE` を打ち、他のファイルと DB を共有しないので、並列の群に残した。

- **採らなかった案**:

  - **案2（1本の SQL・One-Time Filter）をこのまま `search()` にも使う案**——
    上の「文脈」節の実測（+5.06ms、N=200・アンカー3）が線を超えたため却下。
    「N=3000 では線内、N=200 だけ超える」ことを理由に線を緩める判断は、
    Issue #1181 の測定で一度退けられた「外れ値が押し上げているだけ」という
    読みと同じ性質の判断であり、認めなかった。
  - **統計が後で消えたときに再確認する仕組み（TTL・定期再検査）を足す案**——
    決定3で却下。稀な操作のために、確認済みの定常状態でも `reltuples` を
    読み続けるコストを新たに背負うことになり、本 ADR が解決したい問題を
    形を変えて呼び戻す。
  - **`StatsPresenceGate` の状態をテナントごとに持つ案**——決定2で却下。
    `pg_class.reltuples` はテナントを区別しない表単位の統計であり、テナント単位
    で持つ理由が無い（無駄な区別を増やすだけ）。
  - **`StatsPresenceGate` の状態を大域変数・`static` で持つ案**——決定2で却下。
    `PgvectorCapabilityGate`（ADR 0367）と同じ理由——インスタンスをまたいで
    共有すると、テストで「別のインスタンスはまだ確認していない」という前提が
    壊れ、覚え間違いを検出できなくなる。

- **引き受けた負債**:

  - 統計が後で消えても（`TRUNCATE`・表の作り直し）確認し直さない——結果は
    変わらないが、遅くなりうる（決定3）。
  - `memories.reltuples` 単独では「統計が無い」を検出できない、という ADR 0362
    が既に引き受けていた限界を、そのまま引き継いでいる（本 ADR では変えていない）。
  - `search()`/`searchMany()` の初回呼び出し（表ごとに未確認の間）は、
    `StatsPresenceGate` ぶんの往復が1回余分に掛かる——`PgvectorCapabilityGate`
    が既に持つのと同じ性質の、恒久的な初期化コスト。

- **確かめていないこと**:

  - なぜ案2のコストが `searchMany()` より `search()` で相対的に大きく出たのか
    （「文脈」節の推測に留まる）。
  - `StatsPresenceGate` が未確認のまま極めて多くの回数呼ばれ続ける場面
    （例えば統計が恒久的に得られない・自動 ANALYZE が無効化された環境）での、
    累積コストの実測——12往復程度の測定に留まる。
  - PostgreSQL 18 系・pgvector の異なる版での再現性（本 ADR 自身は
    PostgreSQL 17 でのみ実測、ADR 0362 と同じ限界）。

- **これが覆るとしたら**:

  - `search()`/`searchMany()` 以外の経路（例えば将来の第3の ANN 検索口）が
    同じ欠陥を持つと分かった場合、同じ `StatsPresenceGate` を再利用するか、
    新しい表の組み合わせのために拡張するかの判断が要る。
  - 統計が後で消える場面が実運用で頻繁に起きることが分かった場合、決定3の
    負債（結果は正しいが遅くなる）が許容できなくなり、再確認の仕組みを
    検討し直す必要が出るかもしれない。

## 追記（2026-09-30）—— 「memories 側の状態は、他のファイルが何をしていようと変わらない」は成り立たない（実測で訂正）

⛔ 上の本文は1バイトも書き換えていない。同じ形で追記する。

クローン miku の委譲先が書いた（オーナーではない）。レビューで見つかった所見を受けて書く。

上の「**`ANALYZE memories` を打つ歯が、並列の群で他のファイルに影響しないか**」節は、
`migrations/0005_analyze_memories.sql` が新規インストールの空テーブルに `ANALYZE` を
打つため `memories.reltuples` が worker DB の複製直後から `0`（統計あり側）に固定されて
いることを根拠に、**「`memories` 側の状態は、他のファイルが何をしていようと変わらない」**
と書いていた。**これは TEMPLATE 複製直後の1点だけを見た記述であり、`resetTestDatabase()`
（各テストファイルが最初に呼ぶ、`TRUNCATE ... RESTART IDENTITY CASCADE`）がその後に
`memories.reltuples` に何をするかは確かめていなかった。**

**実測（2026-09-30、PostgreSQL 17.11、この作業専用の使い捨て DB、`packages/postgres` の
migration を素の状態から適用した直後）**:

```sql
-- 1) migrate 直後（= worker DB が TEMPLATE から複製された直後と同じ状態）
SELECT reltuples FROM pg_class WHERE relname = 'memories';
-- => 0

-- 2) 45,000行 INSERT（provenance_kind='imported' の最小行）→ ANALYZE
--    INSERT INTO memories (...) SELECT ... FROM generate_series(1, 45000);
ANALYZE memories;
SELECT reltuples FROM pg_class WHERE relname = 'memories';
-- => 45000
SELECT attname, n_distinct FROM pg_stats WHERE tablename = 'memories' AND attname = 'status';
-- => status | 1   （全行 status='active' なので n_distinct=1）

-- 3) resetTestDatabase() と同じ操作
TRUNCATE TABLE memories RESTART IDENTITY CASCADE;
SELECT reltuples FROM pg_class WHERE relname = 'memories';
-- => -1   （「未 ANALYZE」のセンチネルへ戻る）
SELECT attname, n_distinct FROM pg_stats WHERE tablename = 'memories' AND attname = 'status';
-- => status | 1   （消えずに残る。列統計は TRUNCATE では掃除されない）
```

⟹ **`TRUNCATE` は `memories.reltuples` を「未 ANALYZE」（`-1`）へ戻す。**
`StatsPresenceGate`（決定1のコード片）は `reltuples >= 0` かどうかで「統計あり」を
判定するため、**`TRUNCATE` の直後は「未確認」の状態に戻る。**一方 `pg_stats`
（列統計、`n_distinct` 等）は `TRUNCATE` では消えない——今回の実測では値そのものは
変わらなかったが、「消えずに残る」こと自体が「他のファイルが何をしていようと変わらない」
という本文の主張と食い違う（`reltuples` と `pg_stats` とで `TRUNCATE` に対する挙動が違う、
という区別を本文は書いていなかった）。

⟹ **本文「`memories` 側の状態は、他のファイルが何をしていようと変わらない」は、
TEMPLATE 複製直後の1点にしか当てはまらない。**同じ worker DB を使う別のファイル
（または同じファイルの前のテスト）が `resetTestDatabase()` を呼んだ後は、
`memories.reltuples` は `-1` に戻っている——**「変わらない」ではなく「そのテストが
呼んだ直近の `resetTestDatabase()` の直後の状態に依存する」が正しい。**

**実害は確認されていない**——`search-primary-key-lookup`・`search-many-primary-key-lookup`・
`search-stats-presence-result-equivalence`・`recall-roundtrip-count` は、上の
2026-09-29追記により既に `SERIAL_TEST_FILES` へ移してある。本追記の書き手は、残る
並列の群のうち `memories`/`ANALYZE` に触れる11ファイル（`analyze-memories`・
`claim-key-index`・`embedding-statistics`・`memories-statistics`・
`recall-filter-selectivity`・`recall`・`search-stats-presence-scope`・
`trigram-lexical-store-index`・`superseded-and-extraction-index`・
`vector-search-zero-norm`・`vector-store-search-many`、いずれも `.postgres.test.ts`。
`packages/postgres/src/__tests__/*.postgres.test.ts` を `grep -rln "ANALYZE memories"`
で当たった範囲——列挙した場所の網羅は示せない）を `vitest run --project
postgres-db-parallel` でまとめて実行し（2026-09-30 実測）、**61件全て green** だった。
各ファイルが自分の呼ぶ `resetTestDatabase()` の直後の状態から検算しているため、
他のファイルの `ANALYZE`/`TRUNCATE` の影響を受けていない、と読める。

**ただし、これは「今の歯がすべて自衛している」ことの確認であり、「今後書かれる歯も
自動的に安全」という保証ではない。**`resetTestDatabase()` を呼ばず、または呼んだ後に
統計が「ある」ことを前提にする歯を新しく書くと、その歯は「直前にどのファイルが
どの順で `memories` を ANALYZE 済みにしたか」という実行順に依存しうる——並列の群では
worker DB を共有する複数ファイルの実行順は保証されない。

**直列/並列の分類基準は、統計が無い状態を意図して作るファイルだけを直列にする、と
決めた。クローン miku の判断（オーナーではない）。**基準の中身と材料は、すぐ下の追記
「直列の群へ入れる基準を書き直す」に書いた。本追記は「本文の主張が成り立たない」ことの
訂正に留め、`vitest.config.mts` の `SERIAL_TEST_FILES` は変更していない。

### この追記が確かめていないこと

- `pg_stats` の他の列・他の欄（`n_distinct` 以外）が `TRUNCATE` でどう振る舞うかは、
  `status` 列の `n_distinct` 1点しか見ていない。
- 上に挙げた11ファイル以外に、`memories`/`ANALYZE` に触れる並列の群のファイルが
  無いことは、`grep` 1回の結果でしかなく、網羅を示す手段は取っていない。
- 実際の CI（`postgres-db-parallel` ジョブ、この実測より多いファイル数・別の
  `maxWorkers`）での再現は行っていない——本追記の実測はこの作業専用の使い捨て DB
  1本の上で行った。
- `StatsPresenceGate` の instance 単位のキャッシュ（`confirmed` Set、決定1）が
  `TRUNCATE` 後も「確認済み」のまま残る場合（本文「引き受けた負債」1番目が既に
  記録している論点）との関係は、この追記では検証し直していない——今回の実測は
  `reltuples`/`pg_stats` という DB 側の状態だけを見ており、`StatsPresenceGate`
  インスタンスの `confirmed` Set の中身までは覗いていない。

## 追記（2026-09-30）—— 直列の群へ入れる基準を書き直す

クローン miku の委譲先が書いた（オーナーではない）。

**統計が無い状態を意図して作るファイルだけを直列にする。クローン miku の判断
（オーナーではない、2026-09-30）である。**直列/並列の分類基準を、ここで決める。
**上の本文と「2026-09-29 追記（直列の群へ移した）」は書き換えていない。**

**新しい基準**:

- **直列の群に入れるのは、統計が*無い*状態（`memories`・埋め込み表の `reltuples` の
  有無）を意図して作る、またはその有無の移り変わりそのものを確かめるファイルである。**
  `StatsPresenceGate` が見るのは `reltuples` の有無であり、同じ worker DB を使う別の
  ファイルの `resetTestDatabase()`（`TRUNCATE` で `reltuples` が -1 に戻る——上の追記）や
  `ANALYZE` が、その前提を横から変えうるためである。いま直列の群にある
  `recall-roundtrip-count`・`search-many-primary-key-lookup`・`search-primary-key-lookup`・
  `search-stats-presence-result-equivalence`（いずれも `.postgres.test.ts`）はこれに当たる
  （各ファイルが「統計が無い」表を作り、`ANALYZE` を挟んで確認済みへ移ることを確かめている）。
  ⟹ **2026-09-29 追記の「`memories` に `ANALYZE` を明示的に打つので直列へ」という理由付けは、
  この基準で置き換える。**4本の分類そのものは変わらない。
- **並列の群でよいのは、統計を*使う* `EXPLAIN` の歯のうち、`resetTestDatabase()` の後に
  自分のデータを入れ、列を絞らない `ANALYZE memories` を打ってから assert するものである。**
  列を絞らない `ANALYZE` は全列の統計を置き換えるので、前に同じ worker DB を使った
  ファイルが残した `pg_stats`（`TRUNCATE` 後も残る——上の追記）は、assert の時点では
  残っていない。

**この決定の材料（2026-09-30、レビューでの調査）**:

- **構造**: `ANALYZE memories` を打ち、共有の worker DB（`getTestClient()`）を使い、並列の
  群にいるファイル（`grep -lE 'ANALYZE (memories|"?memories)'` から、直列の群にあるものと
  `CREATE DATABASE` で専用の DB を作るものを除いた18本）を読み、18本すべてが
  「reset → 自分のデータ → 列を絞らない `ANALYZE memories` → `EXPLAIN` の assert」の順で
  あることを確かめた。
- **悪い形での実測**: worker DB の TEMPLATE の複製元に、60,000行をすべて1テナント・
  1 subject・`status = 'forgotten'`・claim key の subject 固定で入れて `ANALYZE` し、
  `tenant_id`・`subject_id`・`status`・`claim_key_subject` の `n_distinct` を1に偏らせた。
  この統計を引き継いだ worker DB で `claim-key-index.postgres.test.ts`（6件、
  `Seq Scan on memories` を含まないことの assert を含む）と `vector-search-subject.test.ts`
  （3件、`idx_memories_by_subject` を選ぶことの assert を含む）を走らせ、**どちらも緑だった。**
  残る16本は構造を読んだだけで、実測していない。
- **費用の見積もり**: 18本を直列の群へ移すと、CI の postgres ジョブの `test:db` は、
  UTF8 の脚で約 +60〜+175秒、SQL_ASCII の脚で約 +65〜+140秒（どちらも中心は**約1.5分**）
  延びると見積もった。根拠は、成功した CI の1回分のファイルごとの所要時間（並列の群は
  3 workers）と、手元で18本を1 worker で走らせた時間である。UTF8 の脚はいま最長の
  ジョブなので、延びた分はほぼそのまま CI 全体の待ち時間に乗る。**見積もりは推測である**
  （CI の実測は1回分だけ。並列の群への配分が均等だというのも仮定）。
- ⟹ 揺れる経路は構造上閉じており、移すと費用だけが乗る。**18本は並列の群に残す。**
  `vitest.config.mts` の `SERIAL_TEST_FILES` は変えていない（同じ PR でコメントだけ
  新しい基準に合わせた）。

**これが覆るとしたら**: 統計を使う歯のうち、`ANALYZE` を打たずに `EXPLAIN` するもの、
列を絞った `ANALYZE memories (…)` しか打たないもの、あるいは reset をしないものが
並列の群に入ったとき。そのファイルは、前のファイルが残した `pg_stats` の上で assert する
ことになる。**この条件を機械で見張る歯は無い**（レビューの `grep` で確かめただけである）。

### この追記が確かめていないこと

- 18本のうち16本は、構造を読んだだけで、偏らせた統計の上での実測はしていない。
- CI の見積もりは1回分の run からの推測であり、複数の run での平均は取っていない。
- 18本の抽出は `grep` 1回の結果であり、網羅は示していない。
