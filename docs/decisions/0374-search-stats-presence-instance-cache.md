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

  【実測・案A（本 ADR）、統計がある場面】

  | 対象 | N | アンカー数 | diff 中央値 |
  |---|---|---|---|
  | `recall()`（`search()` 側） | 200 | 3 | 線内（2ms以内） |
  | `recall()`（`search()` 側） | 3000 | 3 | 線内（2ms以内） |
  | `recall()`（`searchMany()` 側） | 200 | 3 | 線内（2ms以内） |
  | `recall()`（`searchMany()` 側） | 3000 | 3 | 線内（2ms以内） |

  【実測・統計が無い場面、改善値（N=200）】

  | 対象 | アンカー数 | 改善（速くなった） |
  |---|---|---|
  | `search()` 単体 | — | `memories_pkey` 経由（`Join Filter` 無し）へ改善 |
  | `searchMany()` 単体 | — | `memories_pkey` 経由（`Join Filter` 無し）へ改善（ADR 0362 から変わらず維持） |

  ⚠ 具体的な ms 値・実測ログは PR 本文に控える（`AGENTS.md`「数を、道具と生成物に
  焼き込まない」）——ここには「線を超えたか・超えなかったか」の判定だけを書く。

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
