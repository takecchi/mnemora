#!/usr/bin/env node
/**
 * 規模を振るベンチ（テストではなくスクリプト。`pnpm --filter @mnemora/postgres run bench:scale`）。
 *
 * ## 何のためのベンチか
 *
 * 3つの未計測の穴に、1回の計測で答える。
 *
 * 1. **`docs/decisions/0011-no-window-count-in-ann-stage.md` / `docs/recall.md` §5**:
 *    `MemoryStore.aggregateScope`（目次帯・第3階の群カウント）は Phase 1 では常に厳密集計
 *    （`memories` テーブルへの `GROUP BY subject_id` 集約）であり、近似経路が無い。
 *    `docs/recall.md` は「大規模テナントでは近似を許す」と書いているが、どの規模から
 *    厳密集計が割に合わなくなるのかは誰も測っていない。
 *    `aggregateScope` は `memories` テーブルだけを読む（`memory-store.ts` の実装を参照。
 *    `JOIN` 無し）ので、**埋め込みを1件も作らずに測れる**。
 *
 * 2. **`docs/decisions/0023-subject-filter-in-ann-stage.md`**: 段1の ANN クエリに
 *    `m.subject_id = $x` を足すと、CI の実測（3,000行）でプランナが HNSW を捨てて
 *    「`idx_memories_by_subject` で絞ってから距離で Sort」という厳密な経路を選んだ。
 *    埋め込みテーブル側は `Seq Scan` になる。この経路がテナント規模に対してどう伸びるかは
 *    未測定。
 *
 *    **⟹ Part 1 / Part 2 として実装し、CI で 10k/100k を実測した結果（ADR 0023 追記）、
 *    `Seq Scan` は出ず Nested Loop が 0.9ms 横ばいだった。しかし、その計測は
 *    「小さい subject」（該当10〜21行）だけを対象にしていた。** Nested Loop が多数回
 *    まわる懸念は、むしろ**大きい subject** でこそ現実的であり、そこが埋まっていなかった。
 *
 * 3. **（本追加分）穴2の続き——subject の大きさそのものを振っていなかった。**
 *    Part 2 が固定していた「小さい subject」を、10行 / 1,000行 / 10,000行（既定）と
 *    振って計測する。**振る軸は subject の大きさだけ**（次元は 256 に固定）——
 *    2つ同時に振ると、どちらが効いたのか分からなくなるため。
 *    `aggregateScope` も同じ subject の大きさで併せて測る（穴1の「小さい subject でしか
 *    測っていない」も同時に埋まる）。
 *
 * 4. **（本追加分・Part 4）穴3——`PostgresVectorStore.search` 単体ではなく
 *    `runtime.recall()` を丸ごと1回呼んで、`RecallResult` をそのまま見る。**
 *    ADR 0023 追記の実測（Part 3、大きい subject＝全体の10%）では、`LIMIT 40` に対して
 *    ANN が6件しか返さなかった。これは段1（`PostgresVectorStore.search`）単体の観測であり、
 *    **その「6件しか無かった」という事実が `runtime.recall()` の返り値
 *    （`omitted` / `explain` / `index`）のどこかに実際に現れるのかは、まだ誰も見ていない**
 *    （[ADR 0008](../../../../docs/decisions/0008-absence-taxonomy.md) の「無いの分類」が
 *    ここで機能しているかという疑い）。**`recall-runtime.ts` を読む限り、
 *    `ann_truncated` は `annHits.length >= kPrime` のときにしか積まれない設計に見える
 *    （6 < 40 の場合は条件を満たさないため、コード上は積まれないはず）——これは読んで
 *    立てた推測であり、Part 4 はこれを実際に走らせて確かめるためだけに存在する。**
 *    測るだけで、`recall()` の挙動もフィールドも変えない。**
 *
 * ## 実行方法
 *
 * `DATABASE_URL` が本物の Postgres + pgvector を指している状態で:
 *
 * ```
 * pnpm --filter @mnemora/postgres run bench:scale
 * ```
 *
 * 既定では 10k/100k/1M の3点で `aggregateScope` を測り（安いので既定でフル規模）、
 * ベクトル検索（Part 2）は既定で 10k/100k までに留める（1M × 高次元は HNSW の
 * 逐次維持コストが非常に重くなりうるため）。Part 3（subject の大きさを振る）は
 * 既定で常に走る。以下の環境変数で調整できる:
 *
 * - `BENCH_SCOPE_SCALES`: `aggregateScope` を測る行数（カンマ区切り）。既定 `10000,100000,1000000`
 * - `BENCH_VECTOR_SCALES`: ベクトル検索を測る行数（カンマ区切り）。`BENCH_SCOPE_SCALES` の
 *   部分集合でなければならない（そのスケールの `memories` を既に流し込んだ上でベクトルだけ
 *   追加するため）。既定 `10000,100000`（1M は明示的な opt-in）
 * - `BENCH_VECTOR_DIMENSIONS`: ベクトルの次元数（Part 1 / Part 2 用）。既定 `256`
 *   （`text-embedding-3-small` 相当の 1536 は重いので既定にしない。次元数は
 *   `memory_embeddings_<space>` の行幅を決め、`Seq Scan` の費用に直接効く——
 *   高次元で測り直したい場合はこの環境変数を上げること）
 * - `BENCH_SUBJECT_SIZES`（Part 3 専用）: 狙いの subject の大きさ（行数、カンマ区切り）。
 *   既定 `10,1000,10000`。**Part 3 の次元数はこの環境変数の対象外で、常に 256 固定**
 *   （振る軸を subject の大きさだけに保つため。`BENCH_VECTOR_DIMENSIONS` は Part 3 に効かない）。
 * - `BENCH_SUBJECT_TOTAL_ROWS`（Part 3 専用）: Part 3 のテーブル全体の行数。既定 `100000`。
 *   狙いの subject 群の合計より大きくなければならない（残りは filler subject に散る）。
 * - `BENCH_SEED`: 決定的な乱数の種（`setseed` に渡す）。既定 `0.20260906`
 *   （Part 3 は同じ種から別系統の値を導出し、他の Part と乱数列を共有しない）。
 *
 * ## 使い捨てデータベース
 *
 * 規模ごとに専用のデータベースを作り（`packages/postgres/src/__tests__/temp-database.ts`
 * と同じ作法）、計測後に `dropTempDatabase` で `WITH (FORCE)` を使わずに落とす
 * （ADR 0020: `WITH (FORCE)` は「閉じ切れていないコネクションが残っている」不具合を
 * 検知不能にする）。**Part 3 は Part 1 / Part 2 とは別のデータベース
 * （`mnemora_scale_bench_subject`）を使う**——Part 1 / Part 2 の subject 分布
 * （skew を掛けた乱数割り当て）は狙った大きさの subject を作らないため、Part 3 専用の
 * 一様でない・しかし行数が既知の分布を別途作る。
 *
 * ## 行の投入
 *
 * `createMemory()` / `vectorStore.upsert()` を1件ずつ呼ぶと1M件は終わらないので、
 * `INSERT ... SELECT FROM generate_series(...)` によるバルク SQL で入れる
 * （`seedMemories` / `seedVectors` 参照）。Part 3 は同じ SQL 雛形（`memoriesInsertSql`）を
 * 再利用し、filler 用の1文 + 狙いの subject ごとの1文（`subject_id` を定数で固定）を追加で撃つ。
 * **狙いの subject の行数は `SELECT count(*)` で実測し、狙い値と並べて出力する**
 * （「狙った」と「実際にそうだった」は別ものであるため）。
 *
 * ## 手元では一切実行できていない
 *
 * この環境には PostgreSQL が無い（`DATABASE_URL` 無し・docker 無し・root 無し）。
 * このスクリプトは**一度も実行されていない**——構文・型は `tsc` で検査したのみ。
 */

import { performance } from "node:perf_hooks";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import type { Ctx, EmbeddingSpaceId, RecallResult, RecallScope, VectorFilter } from "@mnemora/core";
import { createRuntime } from "@mnemora/core";
import * as schema from "../schema.js";
import { runMigrations } from "../migrate.js";
import { registerEmbeddingSpace } from "../vector-space.js";
import { assertSafeIdentifier, embeddingSpaceTableName } from "../embedding-space-table.js";
import { PostgresMemoryStore } from "../memory-store.js";
import { PostgresVectorStore } from "../vector-store.js";
import { dropTempDatabase } from "../__tests__/temp-database.js";
import { seededRandom } from "../__tests__/test-db.js";

// ---------------------------------------------------------------------------
// 設定
// ---------------------------------------------------------------------------

const TENANT = "scale-bench-tenant";
const STATUS_FILTER: Array<"active" | "contested"> = ["active", "contested"];

/** 決定的な乱数の種。`SELECT setseed($1)` に渡す（-1..1 の範囲）。 */
const DEFAULT_SEED = 0.20260906;

/** クエリベクトルを作る `seededRandom`（JS 側、DB の `setseed` とは別系統）の種。 */
const QUERY_VECTOR_SEED = 20260906;

const DEFAULT_SCOPE_SCALES = [10_000, 100_000, 1_000_000];
/**
 * Part 3（subject の大きさを振る）の既定値。
 *
 * - 全体行数は 100,000 に固定する: Part 2 が既に 100k で Nested Loop / 0.9ms 横ばいを
 *   実測しており、その同じ全体規模の中で「subject 自体が大きくなったらどうなるか」を
 *   分離して見るため（全体規模まで同時に動かすと、どちらが効いたのか分からなくなる）。
 * - 狙いの subject の大きさは 10 / 1,000 / 10,000 行:
 *   10 は Part 2 で実測した「小さい subject」（該当10〜21行）とほぼ同じ桁に揃えた対照点、
 *   10,000 はテーブル全体（既定10万行）の10%を1つの subject が占める、現実的に大きい部類、
 *   1,000 はその中間点。
 */
const DEFAULT_SUBJECT_SIZES = [10, 1_000, 10_000];
const DEFAULT_SUBJECT_TOTAL_ROWS = 100_000;
/**
 * Part 3 で振る軸は subject の大きさ「だけ」にする。次元数を同時に振ると、
 * 時間の変化が「subject が大きくなったから」なのか「次元が変わったから」なのか
 * 区別できなくなる。だからこの値は環境変数で変えられない（Part 1 / Part 2 の
 * `BENCH_VECTOR_DIMENSIONS` とは独立）。Part 1 / Part 2 の既定 `DEFAULT_DIMENSIONS`
 * と同じ 256 を使う（比較可能にするため）。
 */
const SUBJECT_BENCH_DIMENSIONS = 256;
/**
 * ベクトル検索の既定スケールは控えめにする。1M × 高次元は HNSW 索引の（挿入のたびに
 * 逐次維持される）構築コストだけで非常に重くなりうる——このスクリプトは
 * `registerEmbeddingSpace` をそのまま使い（索引を先に作ってからデータを流し込む、
 * 本番と同じ順序）、その現実そのものを計測対象にしている。だからこそ既定では
 * 1M を含めない。
 */
const DEFAULT_VECTOR_SCALES = [10_000, 100_000];
const DEFAULT_DIMENSIONS = 256;

function parseScales(envVar: string | undefined, fallback: number[]): number[] {
  if (!envVar) {
    return fallback;
  }
  return envVar
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((s) => {
      const n = Number(s);
      if (!Number.isInteger(n) || n <= 0) {
        throw new Error(`不正な規模指定: "${s}"（正の整数のカンマ区切りで指定すること）`);
      }
      return n;
    });
}

interface BenchConfig {
  databaseUrl: string;
  scopeScales: number[];
  vectorScales: number[];
  dimensions: number;
  seed: number;
  /** Part 3: 狙いの subject の大きさ（行数）。昇順に正規化済み。 */
  subjectSizes: number[];
  /** Part 3: テーブル全体の行数。 */
  subjectTotalRows: number;
}

function loadConfig(): BenchConfig {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error(
      "DATABASE_URL が設定されていません。本物の Postgres + pgvector を指す接続文字列を" +
        "設定してから実行すること（擬似物では代替しない）。",
    );
  }
  const scopeScales = parseScales(process.env.BENCH_SCOPE_SCALES, DEFAULT_SCOPE_SCALES);
  const vectorScales = parseScales(process.env.BENCH_VECTOR_SCALES, DEFAULT_VECTOR_SCALES);
  for (const v of vectorScales) {
    if (!scopeScales.includes(v)) {
      throw new Error(
        `BENCH_VECTOR_SCALES の ${v} が BENCH_SCOPE_SCALES に含まれていない。` +
          `ベクトル検索はそのスケールの memories を既に流し込んだ上で測るため、` +
          `BENCH_SCOPE_SCALES のスケールの部分集合でなければならない。`,
      );
    }
  }
  const dimensions = process.env.BENCH_VECTOR_DIMENSIONS
    ? Number(process.env.BENCH_VECTOR_DIMENSIONS)
    : DEFAULT_DIMENSIONS;
  if (!Number.isInteger(dimensions) || dimensions <= 0) {
    throw new Error(`不正な BENCH_VECTOR_DIMENSIONS: ${process.env.BENCH_VECTOR_DIMENSIONS}`);
  }
  const seed = process.env.BENCH_SEED ? Number(process.env.BENCH_SEED) : DEFAULT_SEED;
  if (!Number.isFinite(seed) || seed < -1 || seed > 1) {
    throw new Error(`不正な BENCH_SEED: ${process.env.BENCH_SEED}（-1..1 の範囲で指定すること）`);
  }

  const subjectSizes = parseScales(process.env.BENCH_SUBJECT_SIZES, DEFAULT_SUBJECT_SIZES).sort(
    (a, b) => a - b,
  );
  if (new Set(subjectSizes).size !== subjectSizes.length) {
    throw new Error(
      "BENCH_SUBJECT_SIZES に重複がある。各 subject の大きさは一意でなければならない" +
        "（同じ大きさを2回作ると、狙いの行数がその分ずれる）。",
    );
  }
  const subjectTotalRows = process.env.BENCH_SUBJECT_TOTAL_ROWS
    ? Number(process.env.BENCH_SUBJECT_TOTAL_ROWS)
    : DEFAULT_SUBJECT_TOTAL_ROWS;
  if (!Number.isInteger(subjectTotalRows) || subjectTotalRows <= 0) {
    throw new Error(
      `不正な BENCH_SUBJECT_TOTAL_ROWS: ${process.env.BENCH_SUBJECT_TOTAL_ROWS}（正の整数で指定すること）`,
    );
  }
  const subjectSizesTotal = subjectSizes.reduce((a, b) => a + b, 0);
  if (subjectSizesTotal >= subjectTotalRows) {
    throw new Error(
      `BENCH_SUBJECT_SIZES の合計（${subjectSizesTotal}）が BENCH_SUBJECT_TOTAL_ROWS（${subjectTotalRows}）` +
        `以上になっている。filler subject に回す行が残らない。BENCH_SUBJECT_TOTAL_ROWS を増やすか、` +
        `BENCH_SUBJECT_SIZES を減らすこと。`,
    );
  }

  return {
    databaseUrl,
    scopeScales,
    vectorScales,
    dimensions,
    seed,
    subjectSizes,
    subjectTotalRows,
  };
}

// ---------------------------------------------------------------------------
// 進捗ログ（CI で長時間無言にならないため）
// ---------------------------------------------------------------------------

function log(message: string): void {
  const ts = new Date().toISOString();
  console.log(`[${ts}] ${message}`);
}

// ---------------------------------------------------------------------------
// 小さなユーティリティ
// ---------------------------------------------------------------------------

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length === 0) {
    throw new Error("median: 空配列");
  }
  return sorted.length % 2 !== 0 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

function fmtMs(ms: number): string {
  return `${ms.toFixed(1)}ms`;
}

/**
 * `warmup 1回 + 本計測3回` を行い、本計測の中央値（ミリ秒）を返す。
 * 1回だけの値は揺れるため、必ずこの形で測る（マネージャー指示）。
 */
async function measureMedian(fn: () => Promise<unknown>): Promise<number> {
  await fn(); // warm-up（捨てる）
  const samples: number[] = [];
  for (let i = 0; i < 3; i += 1) {
    const t0 = performance.now();
    await fn();
    samples.push(performance.now() - t0);
  }
  return median(samples);
}

/**
 * `pool.query` を一時的に監視し、`matcher` に一致した最初のクエリのテキスト/パラメータを
 * 捕まえる（`vector-search-subject.test.ts` の手法をそのまま踏襲）。drizzle-orm の
 * `db.execute(sql\`...\`)` は内部でこの `pool.query` を通るため、`PostgresMemoryStore` /
 * `PostgresVectorStore` が実際に発行するクエリをそのまま捕まえて、後で
 * `EXPLAIN (ANALYZE, BUFFERS)` にかけられる。
 */
async function captureQuery(
  pool: Pool,
  matcher: (text: string) => boolean,
  fn: () => Promise<unknown>,
): Promise<{ text: string; params: unknown[] }> {
  let capturedText: string | undefined;
  let capturedParams: unknown[] | undefined;
  const originalQuery = pool.query.bind(pool);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (pool as any).query = (...args: unknown[]) => {
    const [config, params] = args as [string | { text: string }, unknown[] | undefined];
    const text = typeof config === "string" ? config : config.text;
    if (matcher(text)) {
      capturedText = text;
      capturedParams = params;
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (originalQuery as any)(...args);
  };
  try {
    await fn();
  } finally {
    pool.query = originalQuery;
  }
  if (capturedText === undefined) {
    throw new Error("captureQuery: matcher に一致するクエリが観測されなかった");
  }
  return { text: capturedText, params: capturedParams ?? [] };
}

async function explainAnalyze(pool: Pool, text: string, params: unknown[]): Promise<string> {
  const result = await pool.query<{ "QUERY PLAN": string }>(
    `EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT) ${text}`,
    params,
  );
  return result.rows.map((row) => row["QUERY PLAN"]).join("\n");
}

/** EXPLAIN の全文から、報告に十分な要約を機械的に抜き出す（本文は結果に含める）。 */
function summarizePlan(plan: string): {
  usesHnsw: boolean;
  usesSubjectIndex: boolean;
  hasSeqScan: boolean;
  topLine: string;
  actualRowsLines: string[];
} {
  const usesHnsw = /idx_memory_embeddings_hnsw/.test(plan);
  const usesSubjectIndex = /idx_memories_by_subject/.test(plan);
  const hasSeqScan = /Seq Scan/.test(plan);
  const topLine = plan.split("\n")[0]?.trim() ?? "";
  const actualRowsLines = plan
    .split("\n")
    .filter((line) => /actual time=/.test(line))
    .map((line) => line.trim());
  return { usesHnsw, usesSubjectIndex, hasSeqScan, topLine, actualRowsLines };
}

// ---------------------------------------------------------------------------
// データ投入（バルク SQL。1件ずつ createMemory() を呼ばない）
// ---------------------------------------------------------------------------

/**
 * `subjectCount` は規模に応じて変える（呼び出し側が決める）。全部同じ subject だと
 * `GROUP BY subject_id` が1行しか返らず、群カウントの費用を過小評価するため。
 *
 * 分布は完全な一様分布にしない: `power(random(), 3)` で低い添字（subject-0 に近いほう）
 * に寄せる緩い skew を掛け、「一部の大きな subject + 大量の小さな subject」という
 * 現実のテナントに近い形にする（完全な Zipf 分布の実装ではない——その主張はしない）。
 * `subjectCount - 1`（分布の裾、最も小さい部類の subject）を、後段の「小さい subject を
 * subjectId で絞る」計測に使う。
 *
 * 各列の値（status / embedding_status の分布、half_life_hours 等）は
 * `aggregateScope` の `FILTER (WHERE ...)` の各枝を実際に踏ませるための最小限の作り込みで、
 * 「これが現実の分布だ」という主張はしていない。
 */
/**
 * `INSERT INTO memories ... SELECT ...` の雛形。`subjectExpr` だけが呼び出し側ごとに違う
 * （skew を掛けた乱数割り当てにするか、定数の subject_id にするか）。パラメータは常に
 * `$1` = tenant、`$2` = `subjectExpr` が使う値、`$3` = 投入行数の3つで揃える。
 */
function memoriesInsertSql(subjectExpr: string): string {
  return `
    INSERT INTO memories (
      id, tenant_id, subject_id, content, content_hash, digest, digest_source,
      provenance_kind, provenance, status, tags, occurred_at, recorded_at,
      strength, half_life_hours, decay_floor_at, embedding_status, created_at, updated_at
    )
    SELECT
      gen_random_uuid(),
      $1,
      ${subjectExpr},
      'bench memory #' || gs,
      md5('bench-content-' || gs::text),
      'bench digest #' || gs,
      'llm',
      'imported',
      '{"kind":"imported"}'::jsonb,
      (ARRAY['active','active','active','active','contested','archived','superseded','forgotten'])
        [1 + floor(random() * 8)::int],
      '{}'::text[],
      NULL,
      now() - (random() * interval '365 days'),
      1.0,
      720,
      now() + interval '30 days',
      (ARRAY['ready','ready','ready','ready','pending','failed','skipped'])
        [1 + floor(random() * 7)::int],
      now(),
      now()
    FROM generate_series(1, $3) AS gs
  `;
}

/** skew を掛けた乱数で subject を割り当てる式（Part 1 / Part 2 が使う分布）。 */
const SKEWED_SUBJECT_EXPR = "'subject-' || floor(power(random(), 3) * $2)::int";

/** `$2` をそのまま定数の subject_id として使う式（Part 3 の狙いの subject 用）。 */
const FIXED_SUBJECT_EXPR = "$2::text";

async function seedMemories(
  pool: Pool,
  tenant: string,
  rowCount: number,
  subjectCount: number,
  seed: number,
): Promise<void> {
  const client = await pool.connect();
  try {
    // setseed はセッション（このコネクション）に対して効く。同じクライアントで
    // 続けて INSERT を発行することで、乱数列を決定的にする。
    await client.query("SELECT setseed($1)", [seed]);
    await client.query(memoriesInsertSql(SKEWED_SUBJECT_EXPR), [tenant, subjectCount, rowCount]);
  } finally {
    client.release();
  }
}

/** Part 3 用の subject id（狙いの大きさをそのまま名前に埋め込む。衝突しない専用DBで使う）。 */
function subjectIdForSize(size: number): string {
  return `subject-size-${size}`;
}

/**
 * Part 3: テーブル全体を `totalRows` 行に固定し、その中に `targetSizes` の
 * 各値ぴったりの行数を持つ subject を作る（`subjectIdForSize` で名付ける）。
 * 残りの行（`totalRows - sum(targetSizes)`）は、Part 1 / Part 2 と同じ skew 分布で
 * 多数の filler subject に散らす。
 *
 * 狙いどおりの行数になっているかどうかはここでは確認しない
 * （呼び出し側が `countSubjectRows` で実測する——「狙った」と「実際にそうだった」を
 * 混同しないため、投入と確認を分離する）。
 */
async function seedSubjectSizeMemories(
  pool: Pool,
  tenant: string,
  totalRows: number,
  targetSizes: number[],
  seed: number,
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("SELECT setseed($1)", [seed]);

    const targetTotal = targetSizes.reduce((a, b) => a + b, 0);
    const fillerRows = totalRows - targetTotal;
    const fillerSubjectCount = subjectCountFor(fillerRows);
    await client.query(memoriesInsertSql(SKEWED_SUBJECT_EXPR), [
      tenant,
      fillerSubjectCount,
      fillerRows,
    ]);

    for (const size of targetSizes) {
      await client.query(memoriesInsertSql(FIXED_SUBJECT_EXPR), [
        tenant,
        subjectIdForSize(size),
        size,
      ]);
    }
  } finally {
    client.release();
  }
}

/** 狙いの subject に実際に何行入ったかを、`count(*)` で直接数える。 */
async function countSubjectRows(pool: Pool, tenant: string, subjectId: string): Promise<number> {
  const result = await pool.query<{ count: string }>(
    "SELECT count(*)::text AS count FROM memories WHERE tenant_id = $1 AND subject_id = $2",
    [tenant, subjectId],
  );
  return Number(result.rows[0]!.count);
}

/**
 * `memory_embeddings_<space>` へベクトルをバルク投入する。`vectorStore.upsert()` を
 * 1件ずつ呼ぶと1M件は終わらないので、`memories` から `INSERT ... SELECT` で1文で埋める。
 * ベクトルは `real[]` を組み立てて `::vector` にキャストする（pgvector が対応するキャスト）。
 *
 * `registerEmbeddingSpace` を先に呼んでおく前提（テーブルと HNSW 索引は既に存在する）ので、
 * この INSERT はテーブルが空でない索引へ逐次追記する形になる——本番でベクトルが
 * 継続的に流し込まれるのと同じ順序であり、まさに計測したい経路そのものである。
 */
async function seedVectors(
  pool: Pool,
  tenant: string,
  table: string,
  dimensions: number,
  seed: number,
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("SELECT setseed($1)", [seed]);
    await client.query(
      `
      INSERT INTO ${table} (tenant_id, memory_id, embedding, model, created_at)
      SELECT
        tenant_id,
        id,
        (ARRAY(SELECT (random() * 2 - 1)::real FROM generate_series(1, $2)))::vector,
        'bench-model',
        now()
      FROM memories
      WHERE tenant_id = $1
      `,
      [tenant, dimensions],
    );
  } finally {
    client.release();
  }
}

function subjectCountFor(rowCount: number): number {
  // 平均 ~50行/subject という単純な比率で規模に連動させる。
  // 10k -> 200 subject, 100k -> 2,000 subject, 1M -> 20,000 subject。
  return Math.max(20, Math.round(rowCount / 50));
}

function smallSubjectIdFor(subjectCount: number): string {
  return `subject-${subjectCount - 1}`;
}

// ---------------------------------------------------------------------------
// 使い捨てデータベースのライフサイクル
// ---------------------------------------------------------------------------

function urlForDatabase(baseUrl: string, database: string): string {
  const url = new URL(baseUrl);
  url.pathname = `/${database}`;
  return url.toString();
}

interface ScaleDatabase {
  admin: Pool;
  pool: Pool;
  db: ReturnType<typeof drizzle<typeof schema>>;
  database: string;
}

async function createScaleDatabase(baseUrl: string, database: string): Promise<ScaleDatabase> {
  const admin = new Pool({ connectionString: baseUrl, max: 1 });
  // FORCE を使わない理由は temp-database.ts 冒頭のコメント（ADR 0020）を参照。
  await dropTempDatabase(admin, database);
  await admin.query(`CREATE DATABASE ${database}`);
  const pool = new Pool({ connectionString: urlForDatabase(baseUrl, database), max: 5 });
  await runMigrations(pool);
  const db = drizzle(pool, { schema });
  return { admin, pool, db, database };
}

async function teardownScaleDatabase(handle: ScaleDatabase): Promise<void> {
  await handle.pool.end();
  await dropTempDatabase(handle.admin, handle.database);
  await handle.admin.end();
}

// ---------------------------------------------------------------------------
// Part 1: aggregateScope
// ---------------------------------------------------------------------------

interface ScopeResult {
  rows: number;
  subjectCount: number;
  variant: "全体" | "subjectId 指定（小さい subject）";
  medianMs: number;
  plan: ReturnType<typeof summarizePlan>;
}

async function benchAggregateScope(
  pool: Pool,
  db: ReturnType<typeof drizzle<typeof schema>>,
  rowCount: number,
  subjectCount: number,
): Promise<ScopeResult[]> {
  const memoryStore = new PostgresMemoryStore(db);
  const ctx: Ctx = { tenantId: TENANT };
  const smallSubjectId = smallSubjectIdFor(subjectCount);

  const variants: Array<{ label: ScopeResult["variant"]; scope: RecallScope }> = [
    { label: "全体", scope: {} },
    { label: "subjectId 指定（小さい subject）", scope: { subjectId: smallSubjectId } },
  ];

  const results: ScopeResult[] = [];
  for (const variant of variants) {
    log(`  aggregateScope（${variant.label}）を計測中...`);
    const medianMs = await measureMedian(() => memoryStore.aggregateScope(ctx, variant.scope));

    const captured = await captureQuery(
      pool,
      (text) => text.includes("GROUP BY subject_id"),
      () => memoryStore.aggregateScope(ctx, variant.scope),
    );
    const plan = summarizePlan(await explainAnalyze(pool, captured.text, captured.params));

    log(`    中央値 ${fmtMs(medianMs)} / プラン先頭行: ${plan.topLine}`);
    results.push({ rows: rowCount, subjectCount, variant: variant.label, medianMs, plan });
  }
  return results;
}

// ---------------------------------------------------------------------------
// Part 2: PostgresVectorStore.search（subject フィルタが段1にある場合）
// ---------------------------------------------------------------------------

interface VectorResult {
  rows: number;
  dimensions: number;
  variant: "subjectId 無し" | "subjectId 有り（小さい subject）";
  medianMs: number;
  plan: ReturnType<typeof summarizePlan>;
}

async function benchVectorSearch(
  pool: Pool,
  db: ReturnType<typeof drizzle<typeof schema>>,
  rowCount: number,
  subjectCount: number,
  dimensions: number,
  vectorSeed: number,
): Promise<VectorResult[]> {
  const space: EmbeddingSpaceId = {
    provider: "bench",
    model: `scale-bench-dim${dimensions}`,
    dimensions,
  };
  const table = embeddingSpaceTableName(space);
  // 生 SQL に埋め込む前の防御的チェック（`space` はこの関数内で組み立てた固定値のみだが、
  // `vector-store.ts` / `vector-space.ts` と同じ規律を踏襲する）。
  assertSafeIdentifier(table);

  log(`  埋め込み空間を登録中（table=${table}, dims=${dimensions}）...`);
  await registerEmbeddingSpace(pool, space);

  log(`  ベクトルをバルク投入中（${rowCount}行 x ${dimensions}次元）...`);
  await seedVectors(pool, TENANT, table, dimensions, vectorSeed);

  await pool.query(`ANALYZE ${table}`);
  await pool.query("ANALYZE memories");

  const vectorStore = new PostgresVectorStore(db);
  const ctx: Ctx = { tenantId: TENANT };
  // クエリベクトルは決定的な擬似乱数から作る（`test-db.ts` の `seededRandom` を再利用）。
  // ⚠ 全部 0 のベクトルは使わない——cosine 距離はゼロベクトルに対して定義できず
  // （ノルムが 0 になり 0 除算になる）、pgvector の `<=>` がエラーになる。
  const queryRand = seededRandom(QUERY_VECTOR_SEED);
  const queryVector = Array.from({ length: dimensions }, () => queryRand() * 2 - 1);
  const smallSubjectId = smallSubjectIdFor(subjectCount);

  const variants: Array<{ label: VectorResult["variant"]; filter: VectorFilter }> = [
    { label: "subjectId 無し", filter: { tenantId: TENANT, status: STATUS_FILTER } },
    {
      label: "subjectId 有り（小さい subject）",
      filter: { tenantId: TENANT, status: STATUS_FILTER, subjectId: smallSubjectId },
    },
  ];

  const results: VectorResult[] = [];
  for (const variant of variants) {
    log(`  PostgresVectorStore.search（${variant.label}）を計測中...`);
    const medianMs = await measureMedian(() =>
      vectorStore.search(ctx, space, queryVector, { limit: 40, filter: variant.filter }),
    );

    const captured = await captureQuery(
      pool,
      (text) => text.includes(table) && /order by/i.test(text),
      () => vectorStore.search(ctx, space, queryVector, { limit: 40, filter: variant.filter }),
    );
    const plan = summarizePlan(await explainAnalyze(pool, captured.text, captured.params));

    log(
      `    中央値 ${fmtMs(medianMs)} / HNSW使用=${plan.usesHnsw} / Seq Scan=${plan.hasSeqScan} / プラン先頭行: ${plan.topLine}`,
    );
    results.push({ rows: rowCount, dimensions, variant: variant.label, medianMs, plan });
  }
  return results;
}

// ---------------------------------------------------------------------------
// Part 3: subject の大きさを振る（search と aggregateScope の両方）
// ---------------------------------------------------------------------------

interface SubjectSizeResult {
  /** 狙った行数。 */
  targetSize: number;
  /** `count(*)` で実測した実際の行数。 */
  actualCount: number;
  /** テーブル全体の行数（固定）。 */
  totalRows: number;
  dimensions: number;
  operation: "search" | "aggregateScope";
  medianMs: number;
  plan: ReturnType<typeof summarizePlan>;
}

/**
 * 1つの狙いの subject サイズについて、`PostgresVectorStore.search` と
 * `aggregateScope` の両方を測る。
 */
async function benchSubjectSize(
  pool: Pool,
  db: ReturnType<typeof drizzle<typeof schema>>,
  totalRows: number,
  targetSize: number,
  space: EmbeddingSpaceId,
  queryVector: number[],
): Promise<SubjectSizeResult[]> {
  const subjectId = subjectIdForSize(targetSize);
  const table = embeddingSpaceTableName(space);
  const actualCount = await countSubjectRows(pool, TENANT, subjectId);
  log(
    `  subject=${subjectId}（狙い ${targetSize.toLocaleString()}行 / 実測 ${actualCount.toLocaleString()}行）`,
  );

  const results: SubjectSizeResult[] = [];
  const ctx: Ctx = { tenantId: TENANT };

  // 1. PostgresVectorStore.search（filter.subjectId 有り）
  const vectorStore = new PostgresVectorStore(db);
  const filter: VectorFilter = { tenantId: TENANT, status: STATUS_FILTER, subjectId };
  log(`  PostgresVectorStore.search（subject=${subjectId}）を計測中...`);
  const searchMedianMs = await measureMedian(() =>
    vectorStore.search(ctx, space, queryVector, { limit: 40, filter }),
  );
  const searchCaptured = await captureQuery(
    pool,
    (text) => text.includes(table) && /order by/i.test(text),
    () => vectorStore.search(ctx, space, queryVector, { limit: 40, filter }),
  );
  const searchPlan = summarizePlan(
    await explainAnalyze(pool, searchCaptured.text, searchCaptured.params),
  );
  log(
    `    中央値 ${fmtMs(searchMedianMs)} / HNSW使用=${searchPlan.usesHnsw} / ` +
      `Seq Scan=${searchPlan.hasSeqScan} / プラン先頭行: ${searchPlan.topLine}`,
  );
  results.push({
    targetSize,
    actualCount,
    totalRows,
    dimensions: space.dimensions,
    operation: "search",
    medianMs: searchMedianMs,
    plan: searchPlan,
  });

  // 2. aggregateScope（scope.subjectId 有り）
  const memoryStore = new PostgresMemoryStore(db);
  log(`  aggregateScope（subject=${subjectId}）を計測中...`);
  const scopeMedianMs = await measureMedian(() => memoryStore.aggregateScope(ctx, { subjectId }));
  const scopeCaptured = await captureQuery(
    pool,
    (text) => text.includes("GROUP BY subject_id"),
    () => memoryStore.aggregateScope(ctx, { subjectId }),
  );
  const scopePlan = summarizePlan(
    await explainAnalyze(pool, scopeCaptured.text, scopeCaptured.params),
  );
  log(
    `    中央値 ${fmtMs(scopeMedianMs)} / Seq Scan=${scopePlan.hasSeqScan} / ` +
      `プラン先頭行: ${scopePlan.topLine}`,
  );
  results.push({
    targetSize,
    actualCount,
    totalRows,
    dimensions: space.dimensions,
    operation: "aggregateScope",
    medianMs: scopeMedianMs,
    plan: scopePlan,
  });

  return results;
}

// ---------------------------------------------------------------------------
// Part 4: runtime.recall() を丸ごと1回呼ぶ（穴3: 「取りこぼした」と「そもそも無かった」の区別）
// ---------------------------------------------------------------------------

interface RecallOnceResult {
  variant: "subjectId 指定（狙いの大きさ）" | "subjectId 無し（比較用）";
  ctxSubjectId: string | null;
  targetSize: number;
  actualCount: number;
  /** `clock.now()` に固定した値（下のコメント参照）。 */
  referenceNowIso: string;
  memoriesLength: number;
  omitted: RecallResult["omitted"];
  index: RecallResult["index"];
  explain: RecallResult["explain"];
}

/**
 * `runtime.recall()` を丸ごと1回呼び、返り値をそのまま持ち帰る（穴3、マネージャー指示）。
 * **測るだけ**——`recall()` の実装にもフィールドにも一切手を入れない。
 *
 * Part 3 が測ったのは `PostgresVectorStore.search` 単体（段1だけ）だった。ここでは
 * `recall()` パイプライン全体を1回通し、`omitted` / `explain` / `index` を実際に見る。
 * `ctx.subjectId` に Part 3 と同じ狙いの subject（既定では最大の 10,000 行、
 * `config.subjectSizes` の末尾）を入れ、同じデータ（Part 3 の seeding をそのまま再利用、
 * 再シードしない）に対して呼ぶ。比較のため `ctx.subjectId` を指定しない呼び出しも
 * 同じデータに対して1回行う。
 *
 * ## 罠1: 時計
 *
 * `memoriesInsertSql` が入れる `recorded_at` は `now() - random() * interval '365 days'`
 * ——`now()` はシード投入時点の **Postgres 側の実時刻**であり、
 * `recall.postgres.test.ts` の `buildNewMemoryFixture` が使うような固定リテラル日付
 * （例: `2026-01-01`）ではない。`recall()` の減衰計算（`defaultScoringStrategy`）は
 * `clock.now() - recordedAt` の経過時間を使うため、ここで `clock` を省略して
 * `systemClock`（実際の壁時計）に委ねると、結果が「このプロセスが実際に何時何分に
 * このクエリを発行したか」——Part 1〜3 がここまでに要した実時間、CI ランナーの混雑具合、
 * DB 接続の遅延など、**再現性の無い雑音**——に左右されてしまう
 * （`recall.postgres.test.ts` 76-83行のコメントが警告している「実時計だと decay で
 * ほぼ0まで落ちて全部 below_threshold に化ける」と同じ罠。ただしそちらは固定リテラル
 * 日付と実時計の食い違いが原因、こちらは「実行時刻に測定結果が依存してしまう」ことが
 * 問題——原因は違うが、どちらも clock を固定しないと解けない）。
 *
 * **そこで、`recorded_at` が実際にアンカーしている時刻そのもの
 * （`SELECT MAX(recorded_at)`——乱数が0に最も近い行、つまりシード投入時刻に
 * 最も近い値）を実測し、それを固定 `clock.now()` として使う。** こうすると
 * `recall()` から見た各行の経過時間は、シードが意図した「0〜365日」の分布に厳密に
 * 一致し、このベンチが実際に何時に走ったかから完全に独立する
 * （365日というレンジ自体は `half_life_hours=720`＝30日に対して十分大きく、
 * 経過時間が長い行の一部は正しく大きく減衰する——これは意図された分布であり、
 * 「時計を固定した」こととは別の話）。
 *
 * ## 罠2: status
 *
 * Part 3 の狙いの subject 行は `memoriesInsertSql` の8択の `status` 分布のまま
 * （`active` x4 / `contested` x1 / `archived` x1 / `superseded` x1 / `forgotten` x1）
 * ——**ここを `active` に揃えて作り直すことはしない。** ADR 0023 追記が測った
 * 「`LIMIT 40` に対して6件」という数字は、まさにこの混在した分布に対する
 * `PostgresVectorStore.search` 単体の実測値であり、ここで母集団を変えると
 * その数字と直接比較できなくなる。**混在は承知の上で、内訳（`filtered(status)` /
 * `filtered(archived)`）を含めて `result.omitted` を生のまま出力する**——
 * 「窓が埋まらない」話（ann_truncated の有無）と「そもそもスコープの外」話
 * （filtered の件数）を、読む側が別々に見分けられるようにする。
 */
async function benchRecallOnce(
  pool: Pool,
  db: ReturnType<typeof drizzle<typeof schema>>,
  space: EmbeddingSpaceId,
  queryVector: number[],
  targetSize: number,
): Promise<RecallOnceResult[]> {
  const subjectId = subjectIdForSize(targetSize);
  const actualCount = await countSubjectRows(pool, TENANT, subjectId);

  const referenceNowResult = await pool.query<{ max: string | null }>(
    "SELECT max(recorded_at)::text AS max FROM memories WHERE tenant_id = $1",
    [TENANT],
  );
  const referenceNowText = referenceNowResult.rows[0]?.max;
  if (!referenceNowText) {
    throw new Error("benchRecallOnce: MAX(recorded_at) が取れなかった（memories が空？）");
  }
  const referenceNow = new Date(referenceNowText);
  log(
    `  Part 4: clock.now() を MAX(recorded_at)（${referenceNow.toISOString()}）に固定して ` +
      `runtime.recall() を実行する。`,
  );

  const memoryStore = new PostgresMemoryStore(db);
  const vectorStore = new PostgresVectorStore(db);
  const runtime = createRuntime({
    memoryStore,
    vectorStore,
    // observe()/tick() 関連の依存は recall では使わないため、buildTestRuntime
    // （recall.postgres.test.ts）と同じ作法でダミーを埋める。
    outboxStore: {
      claimBatch: async () => [],
      complete: async () => {},
      fail: async () => {},
    },
    eventStore: {
      append: async (_ctx, e) => ({ id: "evt", ...e, at: e.at ?? new Date() }),
      get: async () => null,
      list: async () => [],
    },
    tenantSettingsStore: { getDefaultHalfLifeHours: async () => 720 },
    llmProvider: {
      complete: async () => {
        throw new Error("bench: runtime.recall() では使われないはず");
      },
      completeStructured: async () => {
        throw new Error("bench: runtime.recall() では使われないはず");
      },
    },
    // クエリに `vector` を明示して渡すため embed() は呼ばれない想定
    // （呼ばれたらこのベンチの前提が崩れているので例外で気づけるようにする）。
    // `space` だけは実際に使われる（段1の ANN クエリがどの埋め込みテーブルを見るかを決める）。
    embeddingProvider: {
      space,
      embed: async () => {
        throw new Error(
          "bench: runtime.recall() には vector を明示して渡しているため embed() は呼ばれないはず",
        );
      },
    },
    hashContent: (content: string) => `sha256(${content})`,
    clock: { now: () => referenceNow },
  });

  const variants: Array<{
    variant: RecallOnceResult["variant"];
    ctxSubjectId: string | undefined;
  }> = [
    { variant: "subjectId 指定（狙いの大きさ）", ctxSubjectId: subjectId },
    { variant: "subjectId 無し（比較用）", ctxSubjectId: undefined },
  ];

  // ---- 診断（Part 4 が hits=0 を返した原因を切り分けるためのもの）----
  // recall() の段1と、同じ入力で直接叩く search() を突き合わせる。
  // 食い違えば recall() の配線、一致すれば seeding かクエリ側の前提が原因である。
  {
    const table = embeddingSpaceTableName(space);
    const cnt = await pool.query<{ n: string }>(`SELECT count(*)::text AS n FROM ${table}`);
    const memCnt = await pool.query<{ n: string }>(
      "SELECT count(*)::text AS n FROM memories WHERE tenant_id = $1",
      [TENANT],
    );
    log(
      `  [診断] 埋め込み表=${table} 行数=${cnt.rows[0]?.n} / memories(tenant)=${memCnt.rows[0]?.n}`,
    );
    log(`  [診断] queryVector.length=${queryVector.length} / space.dimensions=${space.dimensions}`);
    const direct = await vectorStore.search({ tenantId: TENANT }, space, queryVector, {
      limit: 40,
      filter: { tenantId: TENANT, status: ["active", "contested"] },
    });
    log(`  [診断] 直接 search（subject 無し・status 有り）= ${direct.length} 件`);
    const directNoStatus = await vectorStore.search({ tenantId: TENANT }, space, queryVector, {
      limit: 40,
      filter: { tenantId: TENANT },
    });
    log(`  [診断] 直接 search（filter は tenant のみ）= ${directNoStatus.length} 件`);
    const directSubject = await vectorStore.search({ tenantId: TENANT }, space, queryVector, {
      limit: 40,
      filter: { tenantId: TENANT, status: ["active", "contested"], subjectId },
    });
    log(`  [診断] 直接 search（subject 有り・status 有り）= ${directSubject.length} 件`);
  }

  const results: RecallOnceResult[] = [];
  for (const v of variants) {
    log(`  runtime.recall()（${v.variant}）を1回呼ぶ...`);
    const ctx: Ctx =
      v.ctxSubjectId !== undefined
        ? { tenantId: TENANT, subjectId: v.ctxSubjectId }
        : { tenantId: TENANT };
    const result = await runtime.recall(ctx, { vector: queryVector });
    log(
      `    memories.length=${result.memories.length} / omitted件数=${result.omitted.length} / ` +
        `index.totalInScope=${result.index.totalInScope}`,
    );
    results.push({
      variant: v.variant,
      ctxSubjectId: v.ctxSubjectId ?? null,
      targetSize,
      actualCount,
      referenceNowIso: referenceNow.toISOString(),
      memoriesLength: result.memories.length,
      omitted: result.omitted,
      index: result.index,
      explain: result.explain,
    });
  }
  return results;
}

/**
 * Part 3 全体を1つの使い捨てデータベース（`mnemora_scale_bench_subject`）で走らせる。
 * Part 1 / Part 2 とは別データベースにした理由は、ファイル冒頭のコメント
 * 「使い捨てデータベース」節を参照——Part 1 / Part 2 の skew 分布は狙った大きさの
 * subject を作らないため。
 *
 * **Part 4（`runtime.recall()` を1回呼ぶ計測）はここに同居させる**——Part 3 の seeding
 * （マネージャー指示で「そのまま再利用してよい」とされた）を再利用するため、
 * 同じ使い捨てデータベース・同じ `space`・同じクエリベクトルのまま、Part 3 のループの後に
 * 続けて実行する（再シードしない）。
 */
async function runSubjectSizeBench(
  config: BenchConfig,
): Promise<{ subjectSizeResults: SubjectSizeResult[]; recallOnceResults: RecallOnceResult[] }> {
  const database = "mnemora_scale_bench_subject";
  log(
    `=== Part 3: subject の大きさを振る（全体 ${config.subjectTotalRows.toLocaleString()}行、` +
      `狙いの大きさ ${config.subjectSizes.map((n) => n.toLocaleString()).join(" / ")}、` +
      `次元 ${SUBJECT_BENCH_DIMENSIONS} 固定）===`,
  );
  log(`使い捨てデータベース ${database} を作成中...`);
  const handle = await createScaleDatabase(config.databaseUrl, database);

  const results: SubjectSizeResult[] = [];
  try {
    // Part 1 / Part 2 とは異なる乱数系列にする（同じ種の使い回しを避ける）。
    // |seed| <= 1 なので、係数を掛けても setseed の範囲(-1..1)に収まる。
    const subjectSeed = config.seed * 0.5;
    const vectorSeed = subjectSeed * -1;

    log(
      `memories を ${config.subjectTotalRows.toLocaleString()}行バルク投入中` +
        `（狙いの subject: ${config.subjectSizes.join(", ")}）...`,
    );
    const seedStart = performance.now();
    await seedSubjectSizeMemories(
      handle.pool,
      TENANT,
      config.subjectTotalRows,
      config.subjectSizes,
      subjectSeed,
    );
    await handle.pool.query("ANALYZE memories");
    log(`  投入完了（${fmtMs(performance.now() - seedStart)}）。`);

    const space: EmbeddingSpaceId = {
      provider: "bench",
      model: `scale-bench-subject-dim${SUBJECT_BENCH_DIMENSIONS}`,
      dimensions: SUBJECT_BENCH_DIMENSIONS,
    };
    const table = embeddingSpaceTableName(space);
    assertSafeIdentifier(table);

    log(`  埋め込み空間を登録中（table=${table}, dims=${SUBJECT_BENCH_DIMENSIONS}）...`);
    await registerEmbeddingSpace(handle.pool, space);

    log(
      `  ベクトルをバルク投入中（${config.subjectTotalRows.toLocaleString()}行 x ` +
        `${SUBJECT_BENCH_DIMENSIONS}次元）...`,
    );
    await seedVectors(handle.pool, TENANT, table, SUBJECT_BENCH_DIMENSIONS, vectorSeed);
    await handle.pool.query(`ANALYZE ${table}`);
    await handle.pool.query("ANALYZE memories");

    // クエリベクトルの種も Part 1 / Part 2 とは別にする。
    const queryRand = seededRandom(QUERY_VECTOR_SEED + 1);
    const queryVector = Array.from({ length: SUBJECT_BENCH_DIMENSIONS }, () => queryRand() * 2 - 1);

    for (const targetSize of config.subjectSizes) {
      log(`--- 狙いの subject 大きさ ${targetSize.toLocaleString()}行 ---`);
      const forThisSize = await benchSubjectSize(
        handle.pool,
        handle.db,
        config.subjectTotalRows,
        targetSize,
        space,
        queryVector,
      );
      results.push(...forThisSize);
    }

    // Part 4: runtime.recall() を丸ごと1回呼ぶ。狙いの subject は「大きい subject」
    // （config.subjectSizes は昇順に正規化済みなので、末尾＝最大。既定では 10,000 行、
    // 全体の10%）——ADR 0023 追記が「6件しか返らなかった」と実測したのと同じ大きさ。
    const largestTargetSize = config.subjectSizes[config.subjectSizes.length - 1];
    if (largestTargetSize === undefined) {
      throw new Error("runSubjectSizeBench: config.subjectSizes が空（Part 4 を実行できない）");
    }
    log(
      `--- Part 4: runtime.recall() を1回呼ぶ（狙いの subject ${largestTargetSize.toLocaleString()}行）---`,
    );
    const recallOnceResults = await benchRecallOnce(
      handle.pool,
      handle.db,
      space,
      queryVector,
      largestTargetSize,
    );

    return { subjectSizeResults: results, recallOnceResults };
  } finally {
    log(`使い捨てデータベース ${database} を drop 中...`);
    await teardownScaleDatabase(handle);
  }
}

// ---------------------------------------------------------------------------
// レポート出力（markdown）
// ---------------------------------------------------------------------------

function renderScopeTable(results: ScopeResult[]): string {
  const lines = [
    "| 規模（行数） | subject 数 | 変種 | 所要時間（中央値） | プランの要点 |",
    "|---:|---:|---|---:|---|",
  ];
  for (const r of results) {
    const planNote = r.plan.hasSeqScan
      ? `Seq Scan あり（${r.plan.topLine}）`
      : `Seq Scan 無し（${r.plan.topLine}）`;
    lines.push(
      `| ${r.rows.toLocaleString()} | ${r.subjectCount.toLocaleString()} | ${r.variant} | ${fmtMs(r.medianMs)} | ${planNote} |`,
    );
  }
  return lines.join("\n");
}

function renderVectorTable(results: VectorResult[]): string {
  const lines = [
    "| 規模（行数） | 次元数 | 変種 | 所要時間（中央値） | HNSW 使用 | Seq Scan | プランの要点 |",
    "|---:|---:|---|---:|---:|---:|---|",
  ];
  for (const r of results) {
    lines.push(
      `| ${r.rows.toLocaleString()} | ${r.dimensions} | ${r.variant} | ${fmtMs(r.medianMs)} | ${r.plan.usesHnsw ? "yes" : "no"} | ${r.plan.hasSeqScan ? "yes" : "no"} | ${r.plan.topLine} |`,
    );
  }
  return lines.join("\n");
}

function renderScopeExplainDetails(results: ScopeResult[]): string {
  return results
    .map(
      (r) =>
        `### aggregateScope: rows=${r.rows.toLocaleString()}, ${r.variant}\n\n` +
        "```\n" +
        (r.plan.actualRowsLines.length > 0 ? r.plan.actualRowsLines.join("\n") : r.plan.topLine) +
        "\n```",
    )
    .join("\n\n");
}

function renderVectorExplainDetails(results: VectorResult[]): string {
  return results
    .map(
      (r) =>
        `### search: rows=${r.rows.toLocaleString()}, dims=${r.dimensions}, ${r.variant}\n\n` +
        "```\n" +
        (r.plan.actualRowsLines.length > 0 ? r.plan.actualRowsLines.join("\n") : r.plan.topLine) +
        "\n```",
    )
    .join("\n\n");
}

function renderSubjectSizeTable(results: SubjectSizeResult[]): string {
  const lines = [
    "| subject の大きさ（狙い） | subject の大きさ（実測 count） | 全体行数 | 次元数 | 操作 | 所要時間（中央値） | HNSW 使用 | Seq Scan | プランの要点 |",
    "|---:|---:|---:|---:|---|---:|---:|---:|---|",
  ];
  for (const r of results) {
    lines.push(
      `| ${r.targetSize.toLocaleString()} | ${r.actualCount.toLocaleString()} | ${r.totalRows.toLocaleString()} | ` +
        `${r.dimensions} | ${r.operation} | ${fmtMs(r.medianMs)} | ${r.plan.usesHnsw ? "yes" : "no"} | ` +
        `${r.plan.hasSeqScan ? "yes" : "no"} | ${r.plan.topLine} |`,
    );
  }
  return lines.join("\n");
}

function renderSubjectSizeExplainDetails(results: SubjectSizeResult[]): string {
  return results
    .map(
      (r) =>
        `### ${r.operation}: 狙い subject 行数=${r.targetSize.toLocaleString()}` +
        `（実測 ${r.actualCount.toLocaleString()}）, 全体=${r.totalRows.toLocaleString()}行\n\n` +
        "```\n" +
        (r.plan.actualRowsLines.length > 0 ? r.plan.actualRowsLines.join("\n") : r.plan.topLine) +
        "\n```",
    )
    .join("\n\n");
}

/**
 * Part 4 の生データをそのまま出す（マネージャー指示: 「加工しすぎないこと」）。
 * `result.omitted` / `result.explain` は JSON でそのまま出す。
 */
function renderRecallOnceDetails(results: RecallOnceResult[]): string {
  return results
    .map((r) => {
      const lines: string[] = [];
      const subjectNote =
        r.ctxSubjectId !== null
          ? `subject=${r.ctxSubjectId}（狙い ${r.targetSize.toLocaleString()}行 / 実測 ${r.actualCount.toLocaleString()}行）`
          : "scope 全体（subjectId 無し）";
      lines.push(`### runtime.recall(): ${r.variant} — ${subjectNote}`);
      lines.push("");
      lines.push(`- \`clock.now()\`（固定値。\`MAX(recorded_at)\`）: ${r.referenceNowIso}`);
      lines.push(`- \`result.memories.length\`: ${r.memoriesLength}`);
      lines.push(
        `- \`result.index.totalInScope\`: ${r.index.totalInScope}（countKind=${r.index.countKind}）`,
      );
      lines.push(`- \`result.index.groups\`: ${JSON.stringify(r.index.groups)}`);
      lines.push("");
      lines.push("`result.omitted`（生のまま）:");
      lines.push("");
      lines.push("```json");
      lines.push(JSON.stringify(r.omitted, null, 2));
      lines.push("```");
      lines.push("");
      lines.push("`result.explain`（生のまま）:");
      lines.push("");
      lines.push("```json");
      lines.push(JSON.stringify(r.explain, null, 2));
      lines.push("```");
      return lines.join("\n");
    })
    .join("\n\n");
}

/**
 * 「この計測が答えるべき問い」への回答欄。**ここでは何も先に主張しない**——
 * 実測結果（`scopeResults` / `vectorResults` / `subjectSizeResults` / `recallOnceResults`）
 * から機械的に導ける事実だけを、このセクションで実際に組み立てる（値は実行時に埋まる）。
 */
function renderAnswers(
  config: BenchConfig,
  scopeResults: ScopeResult[],
  vectorResults: VectorResult[],
  subjectSizeResults: SubjectSizeResult[],
  recallOnceResults: RecallOnceResult[],
): string {
  const lines: string[] = [];
  lines.push("## この計測が答えるべき問い");
  lines.push("");
  lines.push(
    `（測定条件: aggregateScope は ${config.scopeScales.map((n) => n.toLocaleString()).join(" / ")} 行、` +
      `ベクトル検索は ${config.vectorScales.map((n) => n.toLocaleString()).join(" / ")} 行 × ${config.dimensions} 次元で実測。` +
      `以下は実測値から機械的に導いた事実のみを記す。）`,
  );
  lines.push("");

  lines.push("### 1. `aggregateScope` は、どの規模から厳密集計が割に合わなくなるか");
  lines.push("");
  const wholeTenant = scopeResults.filter((r) => r.variant === "全体");
  if (wholeTenant.length > 0) {
    lines.push("行数と所要時間（`scope.subjectId` 無し、テナント全体）:");
    lines.push("");
    for (const r of wholeTenant) {
      const perRowUs = (r.medianMs * 1000) / r.rows;
      lines.push(
        `- ${r.rows.toLocaleString()}行: ${fmtMs(r.medianMs)}（1行あたり ${perRowUs.toFixed(3)}µs） / ` +
          `${r.plan.hasSeqScan ? "Seq Scan あり" : "Seq Scan 無し"}`,
      );
    }
    if (wholeTenant.length >= 2) {
      const first = wholeTenant[0]!;
      const last = wholeTenant[wholeTenant.length - 1]!;
      const scaleRatio = last.rows / first.rows;
      const timeRatio = last.medianMs / first.medianMs;
      lines.push("");
      lines.push(
        `行数は ${scaleRatio.toFixed(1)}倍（${first.rows.toLocaleString()} → ${last.rows.toLocaleString()}）に対し、` +
          `所要時間は ${timeRatio.toFixed(1)}倍（${fmtMs(first.medianMs)} → ${fmtMs(last.medianMs)}）。` +
          `${timeRatio > scaleRatio * 1.3 ? "行数の伸びより時間の伸びが大きい（超線形）。" : timeRatio < scaleRatio * 0.7 ? "行数の伸びより時間の伸びが小さい（劣線形）。" : "ほぼ行数に比例（線形）。"}`,
      );
    }
  }
  lines.push("");
  lines.push(
    "**この数値だけから「どの規模から割に合わなくなるか」を判断するには、比較対象" +
      "（例えば recall 全体のレイテンシ予算・許容できる P99）が要る。本ベンチはその閾値を" +
      "決めておらず、生の所要時間とスケーリングだけを出す。閾値の判断はこの表を見た人が行うこと。**",
  );
  lines.push("");

  lines.push(
    "### 2. subject で絞る段1は、規模が上がるとどうなるか。`Seq Scan` は実際に効いてくるか",
  );
  lines.push("");
  const withSubject = vectorResults.filter((r) => r.variant === "subjectId 有り（小さい subject）");
  const withoutSubject = vectorResults.filter((r) => r.variant === "subjectId 無し");
  if (withSubject.length > 0) {
    lines.push("`filter.subjectId` あり（小さい subject）の場合:");
    lines.push("");
    for (const r of withSubject) {
      lines.push(
        `- ${r.rows.toLocaleString()}行 × ${r.dimensions}次元: ${fmtMs(r.medianMs)} / ` +
          `HNSW使用=${r.plan.usesHnsw ? "yes" : "no"} / Seq Scan=${r.plan.hasSeqScan ? "yes" : "no"} / ` +
          `idx_memories_by_subject使用=${r.plan.usesSubjectIndex ? "yes" : "no"}`,
      );
    }
    if (withSubject.length >= 2) {
      const first = withSubject[0]!;
      const last = withSubject[withSubject.length - 1]!;
      lines.push("");
      lines.push(
        `${first.rows.toLocaleString()}行 → ${last.rows.toLocaleString()}行で、所要時間は ` +
          `${fmtMs(first.medianMs)} → ${fmtMs(last.medianMs)}（${(last.medianMs / first.medianMs).toFixed(1)}倍）。`,
      );
    }
  }
  if (withoutSubject.length > 0) {
    lines.push("");
    lines.push("参考: `filter.subjectId` 無しの場合（比較対象）:");
    lines.push("");
    for (const r of withoutSubject) {
      lines.push(
        `- ${r.rows.toLocaleString()}行 × ${r.dimensions}次元: ${fmtMs(r.medianMs)} / ` +
          `HNSW使用=${r.plan.usesHnsw ? "yes" : "no"} / Seq Scan=${r.plan.hasSeqScan ? "yes" : "no"}`,
      );
    }
  }
  lines.push("");
  if (config.vectorScales.every((n) => n < 1_000_000)) {
    lines.push(
      "**⚠ このベクトル検索の計測は 1M 行を含んでいない**（既定は 10k/100k まで。" +
        "`BENCH_VECTOR_SCALES=10000,100000,1000000` を指定すれば含められるが、" +
        "HNSW 索引の逐次維持コストが乗るため実行時間が大きく伸びる可能性がある）。" +
        "**したがって『100万件級でどうなるか』への直接の答えは、この実行結果には無い。**" +
        "上の 10k→100k の伸び方から外挿する以上のことは言えない。",
    );
  } else {
    lines.push(
      "上表に 1M 行のデータ点が含まれている（`BENCH_VECTOR_SCALES` で明示的に指定された）。",
    );
  }
  lines.push("");

  lines.push(
    "### 3. subject が大きくなると、Nested Loop は `Seq Scan` へ切り替わるか。時間はどう伸びるか",
  );
  lines.push("");
  lines.push(
    `（測定条件: テーブル全体 ${config.subjectTotalRows.toLocaleString()}行に固定、` +
      `次元数 ${SUBJECT_BENCH_DIMENSIONS} に固定。振ったのは subject の大きさだけ` +
      `（狙い ${config.subjectSizes.map((n) => n.toLocaleString()).join(" / ")} 行）。` +
      "以下は実測値から機械的に導いた事実のみを記す。）",
  );
  lines.push("");

  const searchBySize = subjectSizeResults.filter((r) => r.operation === "search");
  const scopeBySize = subjectSizeResults.filter((r) => r.operation === "aggregateScope");

  if (searchBySize.length > 0) {
    lines.push("`PostgresVectorStore.search`（`filter.subjectId` あり）:");
    lines.push("");
    for (const r of searchBySize) {
      lines.push(
        `- 狙い ${r.targetSize.toLocaleString()}行（実測 ${r.actualCount.toLocaleString()}行）: ` +
          `${fmtMs(r.medianMs)} / HNSW使用=${r.plan.usesHnsw ? "yes" : "no"} / ` +
          `Seq Scan=${r.plan.hasSeqScan ? "yes" : "no"} / ` +
          `idx_memories_by_subject使用=${r.plan.usesSubjectIndex ? "yes" : "no"} / ` +
          `プラン先頭行: ${r.plan.topLine}`,
      );
    }
    if (searchBySize.length >= 2) {
      const first = searchBySize[0]!;
      const last = searchBySize[searchBySize.length - 1]!;
      lines.push("");
      if (first.actualCount > 0) {
        const scaleRatio = last.actualCount / first.actualCount;
        const timeRatio = last.medianMs / first.medianMs;
        lines.push(
          `実測 subject 行数は ${scaleRatio.toFixed(1)}倍（${first.actualCount.toLocaleString()} → ` +
            `${last.actualCount.toLocaleString()}）に対し、所要時間は ${timeRatio.toFixed(1)}倍` +
            `（${fmtMs(first.medianMs)} → ${fmtMs(last.medianMs)}）。` +
            `${
              timeRatio > scaleRatio * 1.3
                ? "subject 行数の伸びより時間の伸びが大きい（超線形）。"
                : timeRatio < scaleRatio * 0.7
                  ? "subject 行数の伸びより時間の伸びが小さい（劣線形）。"
                  : "ほぼ subject 行数に比例（線形）。"
            }`,
        );
      }
      lines.push(
        `Seq Scan: 最小の subject では${first.plan.hasSeqScan ? "有り" : "無し"}、` +
          `最大の subject では${last.plan.hasSeqScan ? "有り" : "無し"}。` +
          `HNSW: 最小の subject では${first.plan.usesHnsw ? "使用" : "不使用"}、` +
          `最大の subject では${last.plan.usesHnsw ? "使用" : "不使用"}。`,
      );
    }
    lines.push("");
  }

  if (scopeBySize.length > 0) {
    lines.push("`aggregateScope`（`scope.subjectId` あり）:");
    lines.push("");
    for (const r of scopeBySize) {
      lines.push(
        `- 狙い ${r.targetSize.toLocaleString()}行（実測 ${r.actualCount.toLocaleString()}行）: ` +
          `${fmtMs(r.medianMs)} / Seq Scan=${r.plan.hasSeqScan ? "yes" : "no"} / ` +
          `プラン先頭行: ${r.plan.topLine}`,
      );
    }
    if (scopeBySize.length >= 2) {
      const first = scopeBySize[0]!;
      const last = scopeBySize[scopeBySize.length - 1]!;
      lines.push("");
      if (first.actualCount > 0) {
        const scaleRatio = last.actualCount / first.actualCount;
        const timeRatio = last.medianMs / first.medianMs;
        lines.push(
          `実測 subject 行数は ${scaleRatio.toFixed(1)}倍（${first.actualCount.toLocaleString()} → ` +
            `${last.actualCount.toLocaleString()}）に対し、所要時間は ${timeRatio.toFixed(1)}倍` +
            `（${fmtMs(first.medianMs)} → ${fmtMs(last.medianMs)}）。` +
            `${
              timeRatio > scaleRatio * 1.3
                ? "subject 行数の伸びより時間の伸びが大きい（超線形）。"
                : timeRatio < scaleRatio * 0.7
                  ? "subject 行数の伸びより時間の伸びが小さい（劣線形）。"
                  : "ほぼ subject 行数に比例（線形）。"
            }`,
        );
      }
    }
    lines.push("");
  }

  lines.push(
    "**この節も、他の問いと同じく、実測値から機械的に導ける事実のみを記す。" +
      "『Nested Loop のままで良いか』『何 ms なら割に合わないか』の閾値は、" +
      "この repo では定義していない——判断はこの表を見た人が行うこと。**",
  );
  lines.push("");
  lines.push(
    "**⚠ この計測は全体行数を " +
      `${config.subjectTotalRows.toLocaleString()}行に固定している。` +
      "全体行数そのものを増やしたときに、同じ大きさの subject でも結果が変わるかどうかは、" +
      "この計測には含まれていない（`BENCH_SUBJECT_TOTAL_ROWS` で変えて別途測る必要がある）。**",
  );
  lines.push("");

  lines.push(
    "### 4. 窓が埋まらない（`LIMIT` に対して返りが少ない）とき、呼び出し側は" +
      "『取りこぼした』と『そもそも無かった』を区別できるか",
  );
  lines.push("");
  lines.push(
    "（測定条件: `runtime.recall()`（パイプライン全体、`PostgresVectorStore.search` 単体ではない）を、" +
      "Part 3 と同じ狙いの subject・同じ8択の `status` 分布のまま、`vector` を明示して渡し1回だけ呼んだ" +
      "（embedding provider は呼ばれない）。`clock.now()` は seeding の `recorded_at` の `MAX` に固定してある" +
      "（固定の理由は `benchRecallOnce` のコメントを参照）。以下は実測値から機械的に導いた事実のみを記す。）",
  );
  lines.push("");

  const recallWithSubject = recallOnceResults.find(
    (r) => r.variant === "subjectId 指定（狙いの大きさ）",
  );
  const recallWithoutSubject = recallOnceResults.find(
    (r) => r.variant === "subjectId 無し（比較用）",
  );

  if (recallWithSubject) {
    const stage1 = recallWithSubject.explain.stages.find((s) => s.stage === "candidate_generation");
    const hits = stage1?.detail?.["hits"];
    const kPrime = stage1?.detail?.["kPrime"];
    const hasAnnTruncated = recallWithSubject.omitted.some((o) => o.kind === "ann_truncated");
    const filteredEntries = recallWithSubject.omitted.filter((o) => o.kind === "filtered");
    const notIndexedEntries = recallWithSubject.omitted.filter((o) => o.kind === "not_indexed");

    lines.push(
      `- 狙いの subject（実測 ${recallWithSubject.actualCount.toLocaleString()}行）に \`ctx.subjectId\` を` +
        `指定して呼んだ場合: \`result.memories.length\` = ${recallWithSubject.memoriesLength}、` +
        `\`result.index.totalInScope\` = ${recallWithSubject.index.totalInScope}` +
        `（countKind=${recallWithSubject.index.countKind}）。`,
    );
    lines.push(
      `- 段1（\`candidate_generation\`）の \`explain.stages\` に記録された detail: ` +
        `\`kPrime\` = ${JSON.stringify(kPrime)}、\`hits\` = ${JSON.stringify(hits)}` +
        (typeof hits === "number" && typeof kPrime === "number"
          ? hits < kPrime
            ? "（`hits < kPrime`）"
            : "（`hits >= kPrime`）"
          : "（`hits`/`kPrime` が数値として取れなかった——上の Part 4 生データを確認すること）"),
    );
    lines.push(
      `- \`result.omitted\` に \`kind: "ann_truncated"\` が` +
        `${hasAnnTruncated ? "**含まれている**" : "**含まれていない**"}。`,
    );
    lines.push(
      `- \`result.omitted\` の \`filtered\` エントリ（status/archived/period の混在由来）: ` +
        `${filteredEntries.length > 0 ? JSON.stringify(filteredEntries) : "無し"}。`,
    );
    lines.push(
      `- \`result.omitted\` の \`not_indexed\` エントリ: ` +
        `${notIndexedEntries.length > 0 ? JSON.stringify(notIndexedEntries) : "無し"}。`,
    );
    lines.push("");
    lines.push(
      "**この4点（`hits` と `kPrime` の大小関係・`ann_truncated` の有無・`filtered` の内訳・" +
        "`not_indexed` の内訳）を合わせて読むと**、段1の ANN が `kPrime` に届かず打ち切られたという事実が " +
        "`result.omitted` に `ann_truncated` として現れているか、それとも `result.index.totalInScope` や " +
        "`filtered`/`not_indexed` を全部足し合わせても `memories.length` との差が説明しきれない" +
        "『どこにも計上されない取りこぼし』が残るか——**そのどちらであるかは、上の Part 4 の生データ " +
        "（`result.omitted` の JSON 全文・`explain.stages` 全文）を直接見て判断すること。" +
        "**ここでは先に結論を書かない。**",
    );
  } else {
    lines.push(
      "（`subjectId 指定` の結果が無い——`runtime.recall()` の呼び出しが例外で終わった可能性がある。" +
        "上の Part 4 セクションのログを確認すること。）",
    );
  }
  lines.push("");

  if (recallWithoutSubject) {
    lines.push(
      "参考（`ctx.subjectId` 無し・同じデータに対する比較用の呼び出し）: " +
        `\`result.memories.length\` = ${recallWithoutSubject.memoriesLength}、` +
        `\`result.index.totalInScope\` = ${recallWithoutSubject.index.totalInScope}` +
        `（countKind=${recallWithoutSubject.index.countKind}）。` +
        "全体スコープでは大きい subject 1つ分の希釈効果が消えるため、同じ `kPrime` に対する " +
        "`hits` が変わりうる——`subjectId` 指定の場合と並べて Part 4 の生データを見比べること。",
    );
    lines.push("");
  }

  lines.push(
    "**⚠ この計測は狙いの subject 内の `status` を Part 1/2/3 と同じ8択分布のまま変えていない" +
      "（マネージャー指示: 狙いの subject の行を全部 `active` に揃えるか、混ざることを承知で内訳を" +
      "出すかを選ばせる裁量だったので、後者を選んだ——ADR 0023 追記の実測値と直接比較できるようにするため）。" +
      "したがって『窓が埋まらない』の一部は ANN の打ち切りではなく、単に `status` フィルタで" +
      "スコープ外になった行が混ざっている可能性がある。その内訳は上の `filtered` の値そのものであり、" +
      "この計測はそれを別々に出す以上のことはしていない。**",
  );

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const config = loadConfig();
  // memories とは異なる種を使う（同じ乱数列を2度使い回さない）。
  const vectorSeed = config.seed * -1;

  log("規模を振るベンチを開始する。");
  log(`Part 1（aggregateScope）の規模: ${config.scopeScales.join(", ")}`);
  log(
    `Part 2（vector search）の規模: ${config.vectorScales.join(", ")}, 次元数: ${config.dimensions}`,
  );
  log(
    `Part 3（subject の大きさ）: ${config.subjectSizes.join(", ")} 行` +
      `（全体 ${config.subjectTotalRows.toLocaleString()}行、次元 ${SUBJECT_BENCH_DIMENSIONS} 固定）`,
  );

  const scopeResults: ScopeResult[] = [];
  const vectorResults: VectorResult[] = [];

  for (const rowCount of config.scopeScales) {
    const database = `mnemora_scale_bench_${rowCount}`;
    const subjectCount = subjectCountFor(rowCount);

    log(`=== 規模 ${rowCount.toLocaleString()}行（subject数 ${subjectCount.toLocaleString()}）===`);
    log(`使い捨てデータベース ${database} を作成中...`);
    const handle = await createScaleDatabase(config.databaseUrl, database);

    try {
      log(`memories を ${rowCount.toLocaleString()}行バルク投入中...`);
      const seedStart = performance.now();
      await seedMemories(handle.pool, TENANT, rowCount, subjectCount, config.seed);
      await handle.pool.query("ANALYZE memories");
      log(`  投入完了（${fmtMs(performance.now() - seedStart)}）。`);

      log("Part 1: aggregateScope を計測中...");
      const scopeForThisScale = await benchAggregateScope(
        handle.pool,
        handle.db,
        rowCount,
        subjectCount,
      );
      scopeResults.push(...scopeForThisScale);

      if (config.vectorScales.includes(rowCount)) {
        log("Part 2: PostgresVectorStore.search を計測中...");
        const vectorForThisScale = await benchVectorSearch(
          handle.pool,
          handle.db,
          rowCount,
          subjectCount,
          config.dimensions,
          vectorSeed,
        );
        vectorResults.push(...vectorForThisScale);
      } else {
        log("  この規模は BENCH_VECTOR_SCALES に含まれていないため、Part 2 はスキップする。");
      }
    } finally {
      log(`使い捨てデータベース ${database} を drop 中...`);
      await teardownScaleDatabase(handle);
    }
  }

  log("Part 1 / Part 2 の計測が完了した。続けて Part 3（と、それに同居する Part 4）を実行する。");
  const { subjectSizeResults, recallOnceResults } = await runSubjectSizeBench(config);

  log("すべての計測が完了した。レポートを出力する。");
  console.log("");
  console.log("# 規模を振るベンチ（結果）");
  console.log("");
  console.log(
    `測定日時: ${new Date().toISOString()} / 規模: aggregateScope=[${config.scopeScales.join(", ")}], ` +
      `vector search=[${config.vectorScales.join(", ")}] / 次元数: ${config.dimensions} / ` +
      `subject サイズ=[${config.subjectSizes.join(", ")}]（全体 ${config.subjectTotalRows.toLocaleString()}行、` +
      `次元 ${SUBJECT_BENCH_DIMENSIONS} 固定） / 種: ${config.seed}`,
  );
  console.log("");
  console.log("## Part 1: `aggregateScope`（穴1）");
  console.log("");
  console.log(renderScopeTable(scopeResults));
  console.log("");
  console.log("<details><summary>EXPLAIN (ANALYZE, BUFFERS) 抜粋</summary>");
  console.log("");
  console.log(renderScopeExplainDetails(scopeResults));
  console.log("");
  console.log("</details>");
  console.log("");
  console.log("## Part 2: `PostgresVectorStore.search`（subject フィルタ、穴2）");
  console.log("");
  console.log(renderVectorTable(vectorResults));
  console.log("");
  console.log("<details><summary>EXPLAIN (ANALYZE, BUFFERS) 抜粋</summary>");
  console.log("");
  console.log(renderVectorExplainDetails(vectorResults));
  console.log("");
  console.log("</details>");
  console.log("");
  console.log("## Part 3: subject の大きさを振る（`search` / `aggregateScope`、穴2の続き + 穴1）");
  console.log("");
  console.log(renderSubjectSizeTable(subjectSizeResults));
  console.log("");
  console.log("<details><summary>EXPLAIN (ANALYZE, BUFFERS) 抜粋</summary>");
  console.log("");
  console.log(renderSubjectSizeExplainDetails(subjectSizeResults));
  console.log("");
  console.log("</details>");
  console.log("");
  console.log(
    "## Part 4: `runtime.recall()` を丸ごと1回呼ぶ（穴3: 「取りこぼした」と「そもそも無かった」の区別）",
  );
  console.log("");
  console.log(renderRecallOnceDetails(recallOnceResults));
  console.log("");
  console.log(
    renderAnswers(config, scopeResults, vectorResults, subjectSizeResults, recallOnceResults),
  );
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
