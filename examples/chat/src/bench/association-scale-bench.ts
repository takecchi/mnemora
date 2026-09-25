#!/usr/bin/env node
/**
 * `association-scale` ベンチ（`pnpm --filter @mnemora/example-chat run association-scale-bench`）。
 *
 * [Issue #337](https://github.com/takecchi/mnemora/issues/337)「連想枠（段3.5、ADR 0151）を
 * 既定 on にするかを10万行級で測ってから判断する」の**段1**（62件の陽性対照 + 1万行）。
 * 10万行（段2）は本ベンチの対象外——`MNEMORA_ASSOC_SCALE_SCALES` に足せば同じコードで
 * 走らせられる作りにはしてあるが、実行はしていない（実行報告を見ること）。
 *
 * ## これは何を測るか
 *
 * arm は4つ——`off`（連想枠なし）/ `on-3` / `on-5` / `on-10`（`maxCount` だけを振り、
 * `anchorCount`・`limit` は `packages/core` の既定のまま）。各 arm・各 `hnsw.ef_search`
 * （40/120）について:
 *
 * - **到達**: `ASSOCIATION_PROBES`（12件、`../association-probe-set.js`）ごとに、
 *   gold が `retrievedVia === "association"` で返ったか。
 * - **memoryChars**: `RecallResult.usage.chars`。`off` 比の増分%。
 * - **段3.5の追加レイテンシ**: `recall()` の壁時計を `off` と比べる（`MNEMORA_ASSOC_SCALE_LATENCY_REPEAT`
 *   回反復し中央値を取る）。加えて、`VectorStore` の spy が計測した「段3.5 由来の DB 呼び出し
 *   （2回目以降の `search()` + `getVectors()`）に使った ms の合計」を、段3.5**だけ**の時間の
 *   近似値として別に出す（CPU 内の処理時間は含まない下限——厳密な内訳は
 *   `packages/core` を変更しないと取れない）。
 *
 * ## 移植元との違い — `anchorPool` に依存しない
 *
 * 閉じた PR #723 の枝（commit `2675576`）の
 * `examples/chat/src/bench/association-anchor-pool-scale-bench.ts` を土台にしたが、
 * その道具は main に無い `RecallAssociationQuery.anchorPool`（ADR 0308、提案のまま・
 * 未採用）に依存していた。本ベンチは `anchorPool` を一切使わない。
 *
 * **段ごとの anchor 位置は (a) raw と (c) actual の2段だけ** ——元の4段
 * （raw / passed / withinLimit / actual anchor）のうち **(b) passed（limit の外・
 * kPrime の内、閾値を通った全候補）は測っていない**。`anchorPool: "passed"` の
 * spy トリック無しにこの集合だけを公開 API から正確に取り出す経路が無いため
 * （`partitionByThreshold`/`defaultScoringStrategy` は公開 export だが、`recall-runtime.ts`
 * 内部の `decayScoringExtras` 相当を含めて完全に再現するのはこのベンチの射程外と判断した
 * ——`docs/autonomy.md`「やりすぎない」）。(c) は `withinLimit` と等価
 * （`off` の実際の `recall()` 結果に anchor が `ann`/`lexical` で載っているか）であり、
 * 元ベンチの `cWithinLimit` と同じ定義。**確かめていないこと**として明記する。
 *
 * ## 埋め込みキャッシュ（Issue #337 段1の依頼）
 *
 * `./embedding-cache.js` の `FileEmbeddingCache`/`CachingEmbeddingProvider` で、
 * テキスト→ベクトル（`local` / ruri-v3-30m の実 ONNX 推論）をファイルにキャッシュし、
 * 全 arm で共有する。詳細はそちらの docstring。
 *
 * ## 配置 — (A) と (B)
 *
 * - **(A) 「きれいな比較」**: scale ごとに、arm の数だけ `TRUNCATE` → 同じテナント
 *   （`scale-assoc`）へ ingest → 測定、を繰り返す（本ベンチの既定・本実行はこちらのみ）。
 *   4回の独立した ingest が**同じ埋め込みキャッシュ**を共有するので、DB へ実際に入った
 *   埋め込みが arm 間でビット単位（pgvector の float4 丸め後）で一致するはずである
 *   ——`hashArmEmbeddings()` で実際に確かめ、4 arm のハッシュが一致するかを結果に出す。
 * - **(B) 「4 arm を4テナントとして同じ表に並べる」**（[#363 の閉じコメント](https://github.com/takecchi/mnemora/issues/363#issuecomment-5806513012)・
 *   #671「同じベクトル・relaxed_order」の確認用）: `runModeB()` に実装してあるが、
 *   **本実行では呼んでいない**——段1の依頼は「(A) だけでよいが (B) も走らせられる作りに」。
 *
 * ## 実行方法
 *
 * ```
 * DATABASE_URL=postgresql://worker@127.0.0.1:55491/mnemora_test \
 * MNEMORA_EMBEDDING=local \
 * MNEMORA_LLM=deterministic \
 * MNEMORA_ASSOC_SCALE_SCALES=62,10000 \
 * MNEMORA_ASSOC_SCALE_EF_SEARCH=40,120 \
 * MNEMORA_ASSOC_SCALE_EMBED_CACHE_DIR=/tmp/mgr-fac332f3/embcache \
 * pnpm --filter @mnemora/example-chat run association-scale-bench
 * ```
 *
 * ⚠ **`MNEMORA_LLM=deterministic` は省略できない**(main() が起動直後に検査して
 * 落とす)。この器では `OPENAI_API_KEY` が既に環境に在り(他用途)、明示しないと
 * `selectProviderMode`(`providers.ts`)が「キー在り ⟹ openai」に倒れ、`observe()`
 * の抽出が黙って実 OpenAI API を叩く——【実測】1呼び出し ~1.5〜2s(cache 済みの
 * `local` embedding 単体なら観測は ~10ms/呼び出し)、かつ実課金。
 * `MNEMORA_EMBEDDING=local` は embedding 側だけの指定であり、LLM 側の分岐
 * （`selectLLMMode`）には効かない——2つは独立の環境変数である。
 *
 * `MNEMORA_ASSOC_SCALE_JSON` を指定すると機械可読な結果も書き出す。
 * ⛔ **これは測定であり判定ではない。** exit code は結果で変えない
 * （`lexical-tie-density-bench.ts` / `packages/postgres/src/bench/scale-bench.ts` と同じ規律）。
 */
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import type {
  Ctx,
  EmbeddingProvider,
  EmbeddingSpaceId,
  MemoryId,
  RecallAssociationQuery,
  RecallResult,
  Runtime,
  VectorHit,
  VectorStore,
} from "@mnemora/core";
import { DEFAULT_OVER_FETCH_FACTOR, DEFAULT_RECALL_LIMIT, createRuntime } from "@mnemora/core";
import { LocalEmbeddingProvider } from "@mnemora/local-embedding";
import type { PostgresClient } from "@mnemora/postgres";
import {
  PostgresEventStore,
  PostgresLexicalStore,
  PostgresMemoryStore,
  PostgresOutboxStore,
  PostgresTenantSettingsStore,
  PostgresVectorStore,
  assertSafeIdentifier,
  closePostgresClient,
  createPostgresClient,
  embeddingSpaceTableName,
  registerEmbeddingSpace,
  runMigrations,
  sha256Hex,
} from "@mnemora/postgres";
import {
  ASSOCIATION_HAYSTACK_SIZE,
  ASSOCIATION_PROBES,
  buildAssociationProbeSetConversation,
} from "../association-probe-set.js";
import { drainEmbedTicks } from "../embed-drain.js";
import { warmupLocalEmbedding } from "../local-embedding-warmup.js";
import { createProviders } from "../providers.js";
import {
  CachingEmbeddingProvider,
  FileEmbeddingCache,
  precomputeEmbeddingCache,
} from "./embedding-cache.js";

function requireDatabaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error("DATABASE_URL が無い");
  }
  return url;
}

function parseIntListEnv(name: string, fallback: number[]): number[] {
  const raw = process.env[name];
  if (!raw) {
    return fallback;
  }
  return raw
    .split(",")
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n) && n >= 0);
}

function parseIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) {
    return fallback;
  }
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * 構成上ゼロ重複の filler（`association-anchor-pool-scale-bench.ts` の
 * `buildDistinctFiller` を踏襲）。`i` ごとに一意な文字列になる式なので、
 * どれだけ大きい `count` でも（10万でも）重複しない——「10万行の filler が
 * 移植元の生成器で重複なく作れるか」の可否そのものはこの式の構造が答えている
 * （実際に10万件生成して確かめる処理は本ベンチには無い。可否と見積もりは報告に書く）。
 */
function buildDistinctFiller(count: number): { externalId: string; text: string }[] {
  const out: { externalId: string; text: string }[] = [];
  for (let i = 0; i < count; i += 1) {
    out.push({
      externalId: `scale-assoc-filler-${i}`,
      text: `log entry ${i}: node-${i % 997} reported status code ${i % 53} at tick ${i * 7 + 3}, batch ${Math.floor(i / 31)}, checksum ${(i * 2654435761) >>> 0}`,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// VectorStore spy(時間つき) — packages/core/postgres は変更しない。このファイルの中だけ。
// ---------------------------------------------------------------------------

interface SpyCall {
  kind: "search" | "getVectors";
  ms: number;
  /** search のときだけ。 */
  hits?: VectorHit[];
  /** getVectors のときだけ。 */
  memoryIds?: MemoryId[];
}

interface VectorStoreSpy {
  calls: SpyCall[];
  reset(): void;
}

function wrapVectorStoreWithSpy(inner: VectorStore, spy: VectorStoreSpy): VectorStore {
  return {
    upsert: (ctx, space, memoryId, vector) => inner.upsert(ctx, space, memoryId, vector),
    delete: (ctx, space, memoryId) => inner.delete(ctx, space, memoryId),
    search: async (ctx, space, query, opts) => {
      const t0 = performance.now();
      const hits = await inner.search(ctx, space, query, opts);
      spy.calls.push({ kind: "search", ms: performance.now() - t0, hits });
      return hits;
    },
    getVectors: async (ctx, space, memoryIds) => {
      const t0 = performance.now();
      const result = await inner.getVectors!(ctx, space, memoryIds);
      spy.calls.push({ kind: "getVectors", ms: performance.now() - t0, memoryIds: [...memoryIds] });
      return result;
    },
  };
}

/** 段3.5 由来と見なす DB 呼び出しの ms 合計(1回目の search() = 段1、それ以降は段3.5)。 */
function stage3_5DbMs(spy: VectorStoreSpy): number {
  const searchCalls = spy.calls.filter((c) => c.kind === "search");
  const afterFirstSearch = spy.calls.filter(
    (c) => c.kind === "getVectors" || (c.kind === "search" && c !== searchCalls[0]),
  );
  return afterFirstSearch.reduce((sum, c) => sum + c.ms, 0);
}

interface InstrumentedHandle {
  runtime: Runtime;
  memoryStore: PostgresMemoryStore;
  spy: VectorStoreSpy;
  pool: PostgresClient["pool"];
  cachingEmbeddingProvider: CachingEmbeddingProvider;
  close(): Promise<void>;
}

/**
 * `association-anchor-pool-scale-bench.ts` の `createInstrumentedRuntime` と同じ形
 * ——`VectorStore` を spy で包み、`EmbeddingProvider` を `CachingEmbeddingProvider` で包む。
 * どちらも `examples/chat` の中だけに閉じたラッパーであり、`packages/core`/
 * `packages/postgres` は一切変更していない。
 */
async function createInstrumentedRuntime(
  databaseUrl: string,
  cache: FileEmbeddingCache,
): Promise<InstrumentedHandle> {
  const client = createPostgresClient(databaseUrl);
  await runMigrations(client.pool);

  const { embeddingProvider: realEmbedding, llmProvider } = createProviders(process.env, {});
  if (!(realEmbedding instanceof LocalEmbeddingProvider)) {
    throw new Error(
      "association-scale-bench: MNEMORA_EMBEDDING=local を指定すること" +
        "（`local` / ruri-v3-30m の実 ONNX 推論だけを対象にするベンチである）。",
    );
  }
  const cachingEmbeddingProvider = new CachingEmbeddingProvider(realEmbedding, cache);
  await registerEmbeddingSpace(client.pool, cachingEmbeddingProvider.space);

  const spy: VectorStoreSpy = {
    calls: [],
    reset() {
      this.calls = [];
    },
  };
  const vectorStore = wrapVectorStoreWithSpy(new PostgresVectorStore(client.db), spy);
  const memoryStore = new PostgresMemoryStore(client.db);

  const runtime = createRuntime({
    memoryStore,
    outboxStore: new PostgresOutboxStore(client.db),
    vectorStore,
    lexicalStore: new PostgresLexicalStore(client.db),
    eventStore: new PostgresEventStore(client.db),
    tenantSettingsStore: new PostgresTenantSettingsStore(client.db),
    llmProvider,
    embeddingProvider: cachingEmbeddingProvider,
    hashContent: sha256Hex,
  });

  return {
    runtime,
    memoryStore,
    spy,
    pool: client.pool,
    cachingEmbeddingProvider,
    close: () => closePostgresClient(client),
  };
}

async function truncateAll(pool: PostgresClient["pool"]): Promise<void> {
  await pool.query(`
    TRUNCATE TABLE
      memories,
      memory_embeddings_local_ruri_v3_30m_sym_256,
      memory_events,
      observations,
      outbox,
      recall_usages,
      recalls,
      tenant_activity,
      tenant_settings
    RESTART IDENTITY CASCADE
  `);
}

/**
 * `ALTER DATABASE ... SET hnsw.ef_search` は次に張る接続からしか効かない
 * （`postgres`/`pg` の一般的な挙動。`ALTER DATABASE ... SET` はセッション既定値を
 * 変えるだけ）ので、変更後は必ず新しい `Pool` を張り直す。
 */
async function setEfSearchAndReconnect(
  databaseUrl: string,
  databaseName: string,
  ef: number,
  cache: FileEmbeddingCache,
): Promise<InstrumentedHandle> {
  assertSafeIdentifier(databaseName);
  const alterHandle = await createInstrumentedRuntime(databaseUrl, cache);
  await alterHandle.pool.query(`ALTER DATABASE ${databaseName} SET hnsw.ef_search = ${ef}`);
  await alterHandle.close();
  return createInstrumentedRuntime(databaseUrl, cache);
}

// ---------------------------------------------------------------------------
// ingest
// ---------------------------------------------------------------------------

interface CorpusTexts {
  /** `buildAssociationProbeSetConversation()`(既定 62件の haystack)。 */
  base: { externalId: string; text: string; kind: string; probeId?: string }[];
  filler: { externalId: string; text: string }[];
}

function buildCorpus(scale: number): CorpusTexts {
  if (scale < ASSOCIATION_HAYSTACK_SIZE) {
    throw new Error(
      `buildCorpus: scale(${scale}) は ASSOCIATION_HAYSTACK_SIZE(${ASSOCIATION_HAYSTACK_SIZE})` +
        "未満を指定できない(最小点は62文の陽性対照そのものであるため)。",
    );
  }
  const base = buildAssociationProbeSetConversation();
  const filler = buildDistinctFiller(scale - ASSOCIATION_HAYSTACK_SIZE);
  return { base, filler };
}

interface IngestResult {
  anchorIds: Map<string, MemoryId>;
  goldIds: Map<string, MemoryId>;
  /** externalId -> memoryId。ingest した全件(base + filler)。ビット同一性の検算に使う。 */
  memoryIdByExternalId: Map<string, MemoryId>;
  ingestSeconds: number;
  drainSeconds: number;
}

async function ingestCorpus(
  handle: InstrumentedHandle,
  tenantId: string,
  corpus: CorpusTexts,
): Promise<IngestResult> {
  const ctx: Ctx = { tenantId };
  const anchorIds = new Map<string, MemoryId>();
  const goldIds = new Map<string, MemoryId>();
  const memoryIdByExternalId = new Map<string, MemoryId>();

  const tIngest0 = Date.now();
  let expectedEmbedJobs = 0;

  for (const utterance of corpus.base) {
    const result = await handle.runtime.observe(ctx, {
      kind: "utterance",
      text: utterance.text,
      externalId: utterance.externalId,
    });
    expectedEmbedJobs += result.memoryIds.length;
    if (utterance.kind === "anchor" || utterance.kind === "gold") {
      if (result.memoryIds.length !== 1) {
        throw new Error(
          `ingestCorpus: ${utterance.externalId} の sync 抽出が期待通りに1件の Memory を` +
            `作らなかった(${result.memoryIds.length}件)`,
        );
      }
      const probeId = utterance.probeId!;
      if (utterance.kind === "anchor") {
        anchorIds.set(probeId, result.memoryIds[0]!);
      } else {
        goldIds.set(probeId, result.memoryIds[0]!);
      }
    }
    if (result.memoryIds.length === 1) {
      memoryIdByExternalId.set(utterance.externalId, result.memoryIds[0]!);
    }
  }
  if (anchorIds.size !== ASSOCIATION_PROBES.length || goldIds.size !== ASSOCIATION_PROBES.length) {
    throw new Error(
      `ingestCorpus: anchorIds(${anchorIds.size})/goldIds(${goldIds.size})が` +
        `probe数(${ASSOCIATION_PROBES.length})と一致しない`,
    );
  }

  for (const f of corpus.filler) {
    const result = await handle.runtime.observe(ctx, {
      kind: "utterance",
      text: f.text,
      externalId: f.externalId,
    });
    expectedEmbedJobs += result.memoryIds.length;
    if (result.memoryIds.length === 1) {
      memoryIdByExternalId.set(f.externalId, result.memoryIds[0]!);
    }
  }

  const ingestSeconds = (Date.now() - tIngest0) / 1000;

  const tDrain0 = Date.now();
  await drainEmbedTicks(handle.runtime, ctx, { expectedProcessed: expectedEmbedJobs });
  const drainSeconds = (Date.now() - tDrain0) / 1000;

  await handle.pool.query("ANALYZE");

  return { anchorIds, goldIds, memoryIdByExternalId, ingestSeconds, drainSeconds };
}

// ---------------------------------------------------------------------------
// ビット同一性 — 「キャッシュのベクトルと、各armのDBに実際に入った埋め込みが
// arm間でビット単位で同じであることを確かめる手段」(Issue #337 段1)
// ---------------------------------------------------------------------------

/** pgvector のテキスト表現("[1,2,3]")を `number[]` にパースする(`vector-store.ts` の逆変換と同じ形)。 */
function parseVectorLiteral(literal: string): number[] {
  return literal
    .slice(1, -1)
    .split(",")
    .map(Number);
}

/**
 * このテナントの embedding を **externalId のソート順**（memory_id はランダムな
 * UUID で ingest のたびに振り直されるため、テナント横断で決定的な順序にならない
 * ——`vector-store.ts` の3段 tie-break の docstring と同じ理由）に並べ、Float64 として
 * 正規化して連結した sha256 を返す。
 *
 * DB に格納されている値は pgvector の `vector(dims)`＝float4 精度である（列型は
 * `packages/postgres/src/vector-space.ts` の `CREATE TABLE`）。ここで比較しているのは
 * **float4 に丸められた後の値**——`FileEmbeddingCache`(Float64)が保証しているのは
 * 「INSERT 直前の JS 配列が arm 間で同じ」ことだけであり(そちらの docstring 参照)、
 * この関数は「実際に Postgres に着地した後」まで確かめる。
 */
async function hashArmEmbeddings(
  pool: PostgresClient["pool"],
  space: EmbeddingSpaceId,
  memoryIdByExternalId: ReadonlyMap<string, MemoryId>,
): Promise<{ hash: string; rowCount: number }> {
  const table = embeddingSpaceTableName(space);
  assertSafeIdentifier(table);
  const sortedExternalIds = Array.from(memoryIdByExternalId.keys()).sort();
  const memoryIds = sortedExternalIds.map((id) => memoryIdByExternalId.get(id)!);
  if (memoryIds.length === 0) {
    return { hash: createHash("sha256").digest("hex"), rowCount: 0 };
  }
  const { rows } = await pool.query(
    `SELECT memory_id, embedding FROM ${table} WHERE memory_id = ANY($1::uuid[])`,
    [memoryIds],
  );
  const vectorByMemoryId = new Map<string, string>(
    rows.map((r: { memory_id: string; embedding: string }) => [r.memory_id, r.embedding]),
  );
  const hash = createHash("sha256");
  let rowCount = 0;
  for (const memoryId of memoryIds) {
    const literal = vectorByMemoryId.get(memoryId);
    if (literal === undefined) {
      throw new Error(`hashArmEmbeddings: memory_id ${memoryId} の embedding が見つからない`);
    }
    const nums = parseVectorLiteral(literal);
    const buf = Buffer.alloc(nums.length * 8);
    nums.forEach((n, i) => buf.writeDoubleLE(n, i * 8));
    hash.update(buf);
    rowCount += 1;
  }
  return { hash: hash.digest("hex"), rowCount };
}

// ---------------------------------------------------------------------------
// EXPLAIN(ANALYZE) — 段1(query視点)/段3.5(anchor視点)、それぞれ同じ shape
// (`ORDER BY embedding <=> $vector LIMIT kPrime`) を代表 1 probe のベクトルで撃つ。
// 「段1の検索」と「段3.5の検索」は `recall-runtime.ts` の実装上 **同じ LIMIT(kPrime)**
// を使う(段3.5はアンカーごとに `limit: kPrime` で `VectorStore.search` を呼ぶ——
// `rankFetchCount`(`maxCount` 由来)は getVectors 側でしか効かない)。⟹ 2回撃つのは
// 「違う shape を見るため」ではなく「実際に使われる2種類のクエリベクトル(query/anchor)
// それぞれで HNSW が選ばれるかを、代表点で確かめるため」である。
// ---------------------------------------------------------------------------

interface ExplainCapture {
  label: string;
  limit: number;
  text: string;
  hnswUsedHeuristic: boolean;
}

function toVectorLiteral(vector: number[]): string {
  return `[${vector.join(",")}]`;
}

/**
 * ADR 0284: 本番の `PostgresVectorStore.search()` は `SET LOCAL hnsw.iterative_scan
 * = relaxed_order` を**トランザクション内**で無条件に有効にする（`vector-store.ts`
 * の該当行）。この EXPLAIN 診断がそれを見ずに既定（`off`）のまま撃つと、実際に
 * `recall()` が発行するのとは**別の**プランを見てしまう——`SET LOCAL` は
 * トランザクション単位で効くため、`pool.query()`（呼ぶたびに別接続を借りうる）を
 * 素朴に複数回叩いても scope が繋がらない。ここでは `pool.connect()` で1本の
 * client を握り、`BEGIN`→`SET LOCAL`→`EXPLAIN`→`COMMIT` を同じ接続の上で行う
 * （`vector-store.ts` の `db.transaction()` と同じ規律を、生 SQL 側で踏襲する）。
 */
async function captureExplain(
  pool: PostgresClient["pool"],
  space: EmbeddingSpaceId,
  tenantId: string,
  label: string,
  vector: number[],
  limit: number,
): Promise<ExplainCapture> {
  const table = embeddingSpaceTableName(space);
  assertSafeIdentifier(table);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL hnsw.iterative_scan = relaxed_order");
    const { rows } = await client.query(
      `EXPLAIN (ANALYZE, BUFFERS)
       SELECT e.memory_id, e.embedding <=> $1::vector AS distance
       FROM ${table} e
       WHERE e.tenant_id = $2
       ORDER BY e.embedding <=> $1::vector
       LIMIT $3`,
      [toVectorLiteral(vector), tenantId, limit],
    );
    await client.query("COMMIT");
    const text = rows.map((r: { "QUERY PLAN": string }) => r["QUERY PLAN"]).join("\n");
    // ⚠ ヒューリスティック(文字列一致)。**判定ではなく手掛かり**——
    // 「機械には検出まで」(AGENTS.md)。最終判断は report に載せる生の EXPLAIN テキストで
    // 人が確かめること。
    const hnswUsedHeuristic =
      /Index (Scan|Only Scan).*hnsw/i.test(text) || /idx_memory_embeddings_hnsw/i.test(text);
    return { label, limit, text, hnswUsedHeuristic };
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------------
// arm 定義
// ---------------------------------------------------------------------------

interface ArmConfig {
  label: string;
  association?: RecallAssociationQuery;
}

function buildArms(): ArmConfig[] {
  return [
    { label: "off", association: undefined },
    { label: "on-3", association: { maxCount: 3 } },
    { label: "on-5", association: { maxCount: 5 } },
    { label: "on-10", association: { maxCount: 10 } },
  ];
}

// ---------------------------------------------------------------------------
// probe ごとの測定
// ---------------------------------------------------------------------------

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

function indexOfMemory(memories: readonly { memoryId: MemoryId }[], id: MemoryId): number | null {
  const idx = memories.findIndex((m) => m.memoryId === id);
  return idx === -1 ? null : idx + 1;
}

interface ProbeArmResult {
  probeId: string;
  /** (a) raw ANN kPrime に probe自身のanchorが入っていたか(offのsearch spyから)。 */
  aRawAnchor: boolean;
  /** (c) 実際に返った(ann/lexicalで)withinLimit相当にanchorが入っていたか。 */
  cWithinLimitAnchor: boolean;
  /** (d) 連想が実際にgetVectorsへ渡したmemoryIdにanchorが入っていたか。offはnull。 */
  dActualAnchor: boolean | null;
  goldRank: number | null;
  goldReturned: boolean;
  goldRetrievedVia: "ann" | "lexical" | "mandatory_companion" | "association" | null;
  memoryChars: number;
  /** recall() の壁時計(ms)、repeat回の中央値。 */
  latencyMedianMs: number;
  /** 段3.5由来と見なすDB呼び出し(ms合計、最後のrepeat1回分)。offは0。 */
  stage3_5DbMs: number;
}

const PROBE_QUERY_BY_ID = new Map(ASSOCIATION_PROBES.map((p) => [p.id, p.query]));

async function measureProbeArm(
  handle: InstrumentedHandle,
  ctx: Ctx,
  probeId: string,
  anchorId: MemoryId,
  goldId: MemoryId,
  arm: ArmConfig,
  repeat: number,
): Promise<ProbeArmResult> {
  const query = PROBE_QUERY_BY_ID.get(probeId)!;

  const times: number[] = [];
  let lastResult: RecallResult | null = null;
  let lastStage35Ms = 0;
  for (let i = 0; i < repeat; i += 1) {
    handle.spy.reset();
    const t0 = performance.now();
    const result = await handle.runtime.recall(ctx, {
      text: query,
      ...(arm.association ? { association: arm.association } : {}),
    });
    times.push(performance.now() - t0);
    if (i === repeat - 1) {
      lastResult = result;
      lastStage35Ms = stage3_5DbMs(handle.spy);
    }
  }
  const result = lastResult!;

  const searchCalls = handle.spy.calls.filter((c) => c.kind === "search");
  const rawHits = searchCalls[0]?.hits ?? [];
  const aRawAnchor = rawHits.some((h) => h.memoryId === anchorId);
  const cWithinLimitAnchor = result.memories.some(
    (m) => m.memoryId === anchorId && (m.retrievedVia === "ann" || m.retrievedVia === "lexical"),
  );
  const getVectorsCalls = handle.spy.calls.filter((c) => c.kind === "getVectors");
  const dActualAnchor =
    arm.association === undefined
      ? null
      : (getVectorsCalls[0]?.memoryIds ?? []).includes(anchorId);

  const goldRank = indexOfMemory(result.memories, goldId);
  const goldMemory = goldRank === null ? null : result.memories[goldRank - 1]!;

  return {
    probeId,
    aRawAnchor,
    cWithinLimitAnchor,
    dActualAnchor,
    goldRank,
    goldReturned: goldRank !== null,
    goldRetrievedVia: goldMemory ? goldMemory.retrievedVia : null,
    memoryChars: result.usage.chars,
    latencyMedianMs: median(times),
    stage3_5DbMs: lastStage35Ms,
  };
}

// ---------------------------------------------------------------------------
// scale × ef × arm の1点
// ---------------------------------------------------------------------------

interface ArmEfReport {
  armLabel: string;
  ef: number;
  probes: ProbeArmResult[];
  explain: ExplainCapture[];
}

interface ArmScaleReport {
  armLabel: string;
  ingestSeconds: number;
  drainSeconds: number;
  embeddingRowCount: number;
  bitHash: string;
  efReports: ArmEfReport[];
}

interface ScaleReport {
  scale: number;
  precompute: { uniqueTextCount: number; hitCount: number; missCount: number; ms: number };
  arms: ArmScaleReport[];
  bitIdentity: { byArm: Record<string, string>; allSame: boolean };
}

async function measureArmAtEf(
  handle: InstrumentedHandle,
  tenantId: string,
  space: EmbeddingSpaceId,
  arm: ArmConfig,
  ef: number,
  anchorIds: Map<string, MemoryId>,
  goldIds: Map<string, MemoryId>,
  repeat: number,
): Promise<ArmEfReport> {
  const ctx: Ctx = { tenantId };
  const probes: ProbeArmResult[] = [];
  for (const probe of ASSOCIATION_PROBES) {
    const anchorId = anchorIds.get(probe.id)!;
    const goldId = goldIds.get(probe.id)!;
    const r = await measureProbeArm(handle, ctx, probe.id, anchorId, goldId, arm, repeat);
    probes.push(r);
  }

  const kPrime = Math.max(1, Math.round(DEFAULT_RECALL_LIMIT * DEFAULT_OVER_FETCH_FACTOR));
  const repProbe = ASSOCIATION_PROBES[0]!;
  const queryVector = handle.cachingEmbeddingProvider.space
    ? await cachedVectorOrThrow(handle, repProbe.query)
    : [];
  const anchorVector = await cachedVectorOrThrow(handle, repProbe.anchor);
  const explain = [
    await captureExplain(handle.pool, space, tenantId, "段1(query視点)", queryVector, kPrime),
    await captureExplain(handle.pool, space, tenantId, "段3.5(anchor視点)", anchorVector, kPrime),
  ];

  return { armLabel: arm.label, ef, probes, explain };
}

async function cachedVectorOrThrow(handle: InstrumentedHandle, text: string): Promise<number[]> {
  const vectors = await handle.cachingEmbeddingProvider.embed({ tenantId: "explain-probe" }, [text]);
  return vectors[0]!;
}

async function runScale(
  databaseUrl: string,
  databaseName: string,
  scale: number,
  efLevels: number[],
  repeat: number,
  cache: FileEmbeddingCache,
  realEmbeddingForPrecompute: EmbeddingProvider,
): Promise<ScaleReport> {
  const corpus = buildCorpus(scale);
  const allTexts = [
    ...corpus.base.map((u) => u.text),
    ...corpus.filler.map((f) => f.text),
  ];
  console.log(`\n=== scale=${scale}: 埋め込みキャッシュを埋める(${allTexts.length}件、重複除去後) ===`);
  const precompute = await precomputeEmbeddingCache(realEmbeddingForPrecompute, cache, allTexts, {
    batchSize: parseIntEnv("MNEMORA_ASSOC_SCALE_EMBED_BATCH", 64),
    concurrency: parseIntEnv("MNEMORA_ASSOC_SCALE_EMBED_CONCURRENCY", 1),
  });
  console.log(
    `  precompute: unique=${precompute.uniqueTextCount} hit=${precompute.hitCount} ` +
      `miss=${precompute.missCount} ms=${precompute.ms.toFixed(0)}`,
  );

  const tenantId = "scale-assoc";
  const arms = buildArms();
  const armReports: ArmScaleReport[] = [];
  const bitHashByArm: Record<string, string> = {};

  for (const arm of arms) {
    console.log(`\n--- scale=${scale} arm=${arm.label}: TRUNCATE + ingest ---`);
    const handle = await createInstrumentedRuntime(databaseUrl, cache);
    await truncateAll(handle.pool);
    const ingest = await ingestCorpus(handle, tenantId, corpus);
    console.log(
      `  ingest=${ingest.ingestSeconds.toFixed(1)}s drain=${ingest.drainSeconds.toFixed(1)}s`,
    );

    const { hash, rowCount } = await hashArmEmbeddings(
      handle.pool,
      handle.cachingEmbeddingProvider.space,
      ingest.memoryIdByExternalId,
    );
    bitHashByArm[arm.label] = hash;
    await handle.close();

    const efReports: ArmEfReport[] = [];
    for (const ef of efLevels) {
      const efHandle = await setEfSearchAndReconnect(databaseUrl, databaseName, ef, cache);
      const check = await efHandle.pool.query("show hnsw.ef_search");
      console.log(`  [ef_search確認] arm=${arm.label} ef=${ef} -> ${JSON.stringify(check.rows)}`);
      const report = await measureArmAtEf(
        efHandle,
        tenantId,
        efHandle.cachingEmbeddingProvider.space,
        arm,
        ef,
        ingest.anchorIds,
        ingest.goldIds,
        repeat,
      );
      efReports.push(report);
      await efHandle.close();
    }

    armReports.push({
      armLabel: arm.label,
      ingestSeconds: ingest.ingestSeconds,
      drainSeconds: ingest.drainSeconds,
      embeddingRowCount: rowCount,
      bitHash: hash,
      efReports,
    });
  }

  const hashes = Object.values(bitHashByArm);
  const allSame = hashes.every((h) => h === hashes[0]);

  return { scale, precompute, arms: armReports, bitIdentity: { byArm: bitHashByArm, allSame } };
}

// ---------------------------------------------------------------------------
// (B) 4 arm を4テナントとして同じ表に並べる — 建てるだけ、本実行では呼ばない。
// ---------------------------------------------------------------------------

/**
 * 設計 (B): `TRUNCATE` を挟まず、4 arm を4つの別テナント(`scale-assoc-<armLabel>`)として
 * 同じ物理テーブルへ ingest する。[#363 の閉じコメント](https://github.com/takecchi/mnemora/issues/363#issuecomment-5806513012)・
 * #671「同じベクトル・relaxed_order」——複数テナントが同じ表を共有する状況で
 * tie-break・索引選択が (A) と違わないかを確かめるための器。
 *
 * ⛔ **Issue #337 段1では呼んでいない。** 呼び出し可能な形にしてあるだけ
 * （`MNEMORA_ASSOC_SCALE_MODE=B` で `main()` から到達できる)。
 */
async function runModeB(
  databaseUrl: string,
  databaseName: string,
  scale: number,
  efLevels: number[],
  repeat: number,
  cache: FileEmbeddingCache,
  realEmbeddingForPrecompute: EmbeddingProvider,
): Promise<ScaleReport> {
  const corpus = buildCorpus(scale);
  const allTexts = [...corpus.base.map((u) => u.text), ...corpus.filler.map((f) => f.text)];
  const precompute = await precomputeEmbeddingCache(realEmbeddingForPrecompute, cache, allTexts, {});

  const arms = buildArms();
  const armReports: ArmScaleReport[] = [];
  const bitHashByArm: Record<string, string> = {};

  // 1回だけ TRUNCATE してから、4テナントぶんまとめて ingest する(truncate は arm 間で挟まない)。
  const truncHandle = await createInstrumentedRuntime(databaseUrl, cache);
  await truncateAll(truncHandle.pool);
  await truncHandle.close();

  const ingestByArm = new Map<string, IngestResult>();
  for (const arm of arms) {
    const tenantId = `scale-assoc-${arm.label}`;
    const handle = await createInstrumentedRuntime(databaseUrl, cache);
    const ingest = await ingestCorpus(handle, tenantId, corpus);
    ingestByArm.set(arm.label, ingest);
    const { hash, rowCount } = await hashArmEmbeddings(
      handle.pool,
      handle.cachingEmbeddingProvider.space,
      ingest.memoryIdByExternalId,
    );
    bitHashByArm[arm.label] = hash;
    await handle.close();

    const efReports: ArmEfReport[] = [];
    for (const ef of efLevels) {
      const efHandle = await setEfSearchAndReconnect(databaseUrl, databaseName, ef, cache);
      const report = await measureArmAtEf(
        efHandle,
        tenantId,
        efHandle.cachingEmbeddingProvider.space,
        arm,
        ef,
        ingest.anchorIds,
        ingest.goldIds,
        repeat,
      );
      efReports.push(report);
      await efHandle.close();
    }
    armReports.push({
      armLabel: arm.label,
      ingestSeconds: ingest.ingestSeconds,
      drainSeconds: ingest.drainSeconds,
      embeddingRowCount: rowCount,
      bitHash: hash,
      efReports,
    });
  }

  const hashes = Object.values(bitHashByArm);
  const allSame = hashes.every((h) => h === hashes[0]);
  return { scale, precompute, arms: armReports, bitIdentity: { byArm: bitHashByArm, allSame } };
}

// ---------------------------------------------------------------------------
// レポート整形
// ---------------------------------------------------------------------------

function summarizeScale(report: ScaleReport): string {
  const lines: string[] = [];
  lines.push(`\n### scale=${report.scale}`);
  lines.push(
    `bit-identity: allSame=${report.bitIdentity.allSame} ` +
      `hashes=${JSON.stringify(report.bitIdentity.byArm)}`,
  );

  const offArm = report.arms.find((a) => a.armLabel === "off");

  for (const efIndex of report.arms[0]?.efReports.map((_, i) => i) ?? []) {
    const ef = report.arms[0]!.efReports[efIndex]!.ef;
    lines.push(`\n#### scale=${report.scale} ef_search=${ef}`);
    lines.push("| arm | goldReturned | memoryCharsTotal | ΔmemoryChars% | latency中央値ms | Δlatencyms | 段3.5DBms |");
    lines.push("|---|---|---|---|---|---|---|");
    const offEf = offArm?.efReports[efIndex];
    const offMemoryChars = offEf ? offEf.probes.reduce((s, p) => s + p.memoryChars, 0) : 0;
    const offLatency = offEf ? median(offEf.probes.map((p) => p.latencyMedianMs)) : 0;
    for (const arm of report.arms) {
      const efReport = arm.efReports[efIndex]!;
      const goldCount = efReport.probes.filter((p) => p.goldReturned).length;
      const memoryChars = efReport.probes.reduce((s, p) => s + p.memoryChars, 0);
      const deltaPct =
        offMemoryChars > 0 ? (((memoryChars - offMemoryChars) / offMemoryChars) * 100).toFixed(2) : "n/a";
      const latency = median(efReport.probes.map((p) => p.latencyMedianMs));
      const deltaLatency = (latency - offLatency).toFixed(2);
      const stage35 = median(efReport.probes.map((p) => p.stage3_5DbMs)).toFixed(2);
      lines.push(
        `| ${arm.armLabel} | ${goldCount}/${ASSOCIATION_PROBES.length} | ${memoryChars} | ` +
          `${deltaPct}% | ${latency.toFixed(2)} | ${deltaLatency} | ${stage35} |`,
      );
    }
    lines.push("\nanchor到達(a raw / c withinLimit相当、armに依らずoffの値):");
    if (offEf) {
      const aCount = offEf.probes.filter((p) => p.aRawAnchor).length;
      const cCount = offEf.probes.filter((p) => p.cWithinLimitAnchor).length;
      lines.push(`(a)raw=${aCount}/${ASSOCIATION_PROBES.length} (c)withinLimit相当=${cCount}/${ASSOCIATION_PROBES.length}`);
    }
    lines.push("\nEXPLAIN の HNSW ヒューリスティック(offのみ抜粋):");
    if (offEf) {
      for (const e of offEf.explain) {
        lines.push(`- ${e.label}(limit=${e.limit}): hnswUsedHeuristic=${e.hnswUsedHeuristic}`);
      }
    }
  }
  return lines.join("\n");
}

async function main(): Promise<void> {
  const databaseUrl = requireDatabaseUrl();
  const databaseName = new URL(databaseUrl).pathname.replace(/^\//, "");
  const scales = parseIntListEnv("MNEMORA_ASSOC_SCALE_SCALES", [62, 10000]);
  const efLevels = parseIntListEnv("MNEMORA_ASSOC_SCALE_EF_SEARCH", [40, 120]);
  const repeat = parseIntEnv("MNEMORA_ASSOC_SCALE_LATENCY_REPEAT", 5);
  const cacheDir = process.env.MNEMORA_ASSOC_SCALE_EMBED_CACHE_DIR ?? "/tmp/mnemora-assoc-scale-embcache";
  const mode = process.env.MNEMORA_ASSOC_SCALE_MODE === "B" ? "B" : "A";

  console.log(`scales=${scales.join(",")} efLevels=${efLevels.join(",")} repeat=${repeat} mode=${mode}`);
  console.log(`cacheDir=${cacheDir}`);

  // ⚠ 【実測 2026-09-25】この器では `OPENAI_API_KEY` が環境に既に在り(他用途)、
  // `MNEMORA_LLM` を明示しないと `selectProviderMode` が「キー在り ⟹ openai」に
  // 倒れ、`observe()` の抽出が**黙って実 OpenAI API を叩く**(1呼び出し ~1.5〜2s、
  // かつ実課金)。`MNEMORA_EMBEDDING=local` を指定しても LLM 側には効かない
  // ——独立の分岐(`selectLLMMode`/`selectEmbeddingMode`、`providers.ts`)。
  // ⟹ **このベンチは LLM を明示的に `deterministic` に固定する**(ADR 0308 §7.0 の
  // 器と同じ「LLM: deterministic」)。黙って実 API へ倒れる経路を作らない
  // ——`providers.ts` 自身の「黙って擬似物へフォールバックしない」原則の逆向き版。
  const { embeddingProvider: realEmbedding, llmMode } = createProviders(process.env, {});
  if (llmMode !== "deterministic") {
    throw new Error(
      `association-scale-bench: LLM は "deterministic" 固定である(実測: "${llmMode}")。` +
        "MNEMORA_LLM=deterministic を明示すること" +
        "(この環境は OPENAI_API_KEY が既に設定されており、明示しないと黙って実 OpenAI API へ倒れる)。",
    );
  }
  const warmup = await warmupLocalEmbedding(realEmbedding);
  if (!warmup.ok) {
    console.error(warmup.detail);
    process.exitCode = 1;
    return;
  }
  console.log(warmup.detail);

  const cache = new FileEmbeddingCache(cacheDir, realEmbedding.space);

  const allReports: ScaleReport[] = [];
  for (const scale of scales) {
    const report =
      mode === "B"
        ? await runModeB(databaseUrl, databaseName, scale, efLevels, repeat, cache, realEmbedding)
        : await runScale(databaseUrl, databaseName, scale, efLevels, repeat, cache, realEmbedding);
    allReports.push(report);
    console.log(summarizeScale(report));
  }

  cache.close();

  // 後始末: ef_search をデータベース既定へ戻す。
  const cleanupHandle = await createInstrumentedRuntime(databaseUrl, new FileEmbeddingCache(cacheDir, realEmbedding.space));
  await cleanupHandle.pool.query(`ALTER DATABASE ${databaseName} RESET hnsw.ef_search`);
  await cleanupHandle.close();

  const jsonPath = process.env.MNEMORA_ASSOC_SCALE_JSON;
  if (jsonPath) {
    writeFileSync(jsonPath, `${JSON.stringify(allReports, null, 2)}\n`, "utf-8");
    console.log(`\n[association-scale-bench] 機械可読な結果を書き出した: ${jsonPath}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
