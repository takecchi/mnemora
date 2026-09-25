#!/usr/bin/env node
/**
 * `association-scale-nondeterminism` ベンチ
 * （`pnpm --filter @mnemora/example-chat run association-scale-nondeterminism`）。
 *
 * [ADR 0332](../../../../docs/decisions/0332-association-default-100k-measurement.md) §5 が
 * 記録した「同じベクトルでも ingest をやり直すたびに連想枠の到達・probe自身の anchor が
 * 段1の生 ANN 窓（kPrime=40）に残る数が 0/12〜11/12 と揺れる」を切り分ける診断ベンチ
 * （Issue #337 のフォローアップ、マネージャー依頼）。
 *
 * ⛔ **これは測定であり判定ではない。** CI には載せない。exit code は結果で変えない
 * （`association-scale-bench.ts` と同じ規律）。
 *
 * ## 何を切り分けるか（ADR 0332 §5.4 が挙げた2つの仮説 + tie-break の順序依存）
 *
 * 1. **(a) tie-break**: `PostgresVectorStore.search()` の3段 tie-break
 *    （距離 → `recorded_at` DESC → `memory_id` ASC、`vector-store.ts`）が、同点（距離が
 *    float8 で完全一致）の filler 同士の勝敗を ingest のたびに変えている可能性。
 * 2. **(b) HNSW 構築の乱数**: pgvector の HNSW 索引構築時のレベル割り当てに使う乱数が、
 *    同じベクトル集合でも ingest のたびに近似最近傍探索の結果自体を変えている可能性。
 * 3. **(c) 挿入順**: `buildDistinctFiller` の filler 挿入順が変わると
 *    （`recorded_at` の相対順が変わるため）tie-break の勝敗が変わる可能性。
 *
 * ## 測定の組
 *
 * 独立 ingest を3回（I1・I2・I3。I3 だけ filler の挿入順を反転する——base/anchor/gold の
 * 順序は変えない）。各 ingest ごとに TRUNCATE → ingest → drain → ANALYZE の後、同じ
 * DB 状態に対して5つの測定点を撮る:
 *
 * - **M0**: ingest 中の逐次挿入で育った HNSW をそのまま測る（本番と同じ状態）。
 * - **EXACT**: 同じ DB・同じ行に対して、`enable_indexscan`/`enable_bitmapscan` を
 *   `off` にしたセッション（`createPostgresClient` の `options` startup parameter、
 *   `client.ts` の docstring が明記する機構）で厳密探索する。`memory_id`・
 *   `recorded_at`・行そのものは M0 と同一——**索引を経由しない厳密順位**が
 *   `PostgresVectorStore.search()` と同じ3段 tie-break で求まる。
 * - **R1〜R3**: `REINDEX INDEX`（HNSW 索引だけ）→ `ANALYZE` を3回繰り返し、そのたびに
 *   M0 と同じ測定をする。行・`memory_id`・`recorded_at`・tie-break は一切変わらない
 *   ——**HNSW の乱数だけが動く**状況を作る。
 *
 * 判定の筋（走らせる前に決めた読み方）:
 *
 * - R1〜R3 で aRaw/到達が揺れる ⟹ (b) HNSW 構築の乱数だけで揺れが出る。
 * - EXACT が I1〜I3 で一致するなら、(b) を除けば揺れない ⟹ (a) tie-break・(c) 挿入順は
 *   主因でない。EXACT が I1〜I3 で違うなら (a) か (c)（I3 だけ違うなら挿入順依存）。
 * - 厳密順位で anchor が40位より深い probe は、HNSW が「本来入らない anchor を拾って
 *   いた」ことになる。浅いのに aRaw で落ちるなら HNSW の recall 失敗。
 *
 * ## `association-scale-bench.ts` との関係 —— 複製であって改変ではない
 *
 * **`association-scale-bench.ts` 自体は一切変更していない。** `buildDistinctFiller` /
 * `ingestCorpus` / `createInstrumentedRuntime` / `wrapVectorStoreWithSpy` 相当のロジックは
 * このファイルへ複製した——依頼文（「既存ファイルを export 追加で変える必要があるなら
 * 最小限で可」）と、この repo の ⛔ 規律（「既存ベンチのコードも変えない」）が同じ依頼の
 * 中で両立しない指示だったため、より安全な側（複製、無変更）を採った。この判断は
 * report で明示する。`CachingEmbeddingProvider`/`FileEmbeddingCache`/
 * `precomputeEmbeddingCache`（`./embedding-cache.js`）・`buildAssociationProbeSetConversation`/
 * `ASSOCIATION_PROBES`/`ASSOCIATION_HAYSTACK_SIZE`（`../association-probe-set.js`）・
 * `drainEmbedTicks`（`../embed-drain.js`）・`createProviders`/`selectLLMMode`/
 * `selectEmbeddingMode`（`../providers.js`）は、既に export 済みの既存関数をそのまま
 * import しているだけであり、複製していない。
 *
 * ## 実行方法
 *
 * ```
 * DATABASE_URL=postgresql://worker@127.0.0.1:55743/mnemora_test \
 * MNEMORA_EMBEDDING=local \
 * MNEMORA_LLM=deterministic \
 * MNEMORA_ASSOC_NONDET_SCALE=10000 \
 * MNEMORA_ASSOC_NONDET_EMBED_CACHE_DIR=/tmp/mgr-243b5dc9/embcache \
 * MNEMORA_ASSOC_NONDET_JSON=/tmp/mgr-243b5dc9/results/nondeterminism.json \
 * pnpm --filter @mnemora/example-chat run association-scale-nondeterminism
 * ```
 *
 * ⚠ **`MNEMORA_LLM=deterministic` と `MNEMORA_EMBEDDING=local` は両方省略できない**
 * ——`main()` の最初の行（`requireGatesOrThrow()`）が、**どんな provider も構築する前に**
 * `selectLLMMode`/`selectEmbeddingMode`（文字列レベルの判定、`../providers.js`。
 * provider のインスタンスを1つも作らない）で検査し、どちらかが違えば例外で落ちる。
 * この順序にしたのは、`association-scale-bench.ts` の実測で見つけた穴——
 * `MNEMORA_LLM=deterministic` だけ明示し `MNEMORA_EMBEDDING` を省いた場合、
 * `createInstrumentedRuntime` 内の `instanceof LocalEmbeddingProvider` 検査に達する
 * **前** に、`precomputeEmbeddingCache` が `realEmbedding`（`OPENAI_API_KEY` が環境に
 * あれば `OpenAIEmbeddingProvider` になっている）へ直接 `embed()` を呼び、実 OpenAI API
 * を叩いていた——を塞ぐため。詳細は本 PR の報告（歯の確認節）参照。
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type {
  Ctx,
  EmbeddingSpaceId,
  MemoryId,
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
  embeddingSpaceIndexName,
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
import { createProviders, selectEmbeddingMode, selectLLMMode } from "../providers.js";
import {
  CachingEmbeddingProvider,
  FileEmbeddingCache,
  precomputeEmbeddingCache,
} from "./embedding-cache.js";

// ---------------------------------------------------------------------------
// 歯 —— 何よりも先に置く（実 API を絶対に叩かないため）。
// ---------------------------------------------------------------------------

/**
 * provider を1つも構築する前に、環境変数の**文字列**だけで判定する
 * （`selectLLMMode`/`selectEmbeddingMode` は provider のインスタンスを作らない
 * 純関数——`../providers.ts` 参照）。ここを通らない限り、後続のどのコードも
 * 実行しない。
 */
function requireGatesOrThrow(): void {
  const llmMode = selectLLMMode(process.env);
  if (llmMode !== "deterministic") {
    throw new Error(
      `association-scale-nondeterminism: MNEMORA_LLM=deterministic を明示すること` +
        `(実測: "${llmMode}")。この器は OPENAI_API_KEY が既に設定されており、` +
        "明示しないと黙って実 OpenAI API へ倒れる。",
    );
  }
  const embeddingMode = selectEmbeddingMode(process.env);
  if (embeddingMode !== "local") {
    throw new Error(
      `association-scale-nondeterminism: MNEMORA_EMBEDDING=local を明示すること` +
        `(実測: "${embeddingMode}")。` +
        "association-scale-bench.ts の実測で見つけた穴（この値を省くと precompute が" +
        "実 OpenAI API を叩く）をここで塞ぐ。",
    );
  }
}

function requireDatabaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error("DATABASE_URL が無い");
  }
  return url;
}

function parseIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

// ---------------------------------------------------------------------------
// corpus —— `association-scale-bench.ts` の複製 + filler挿入順のパラメータ化。
// ---------------------------------------------------------------------------

type FillerOrder = "forward" | "reversed";

function buildDistinctFiller(
  count: number,
  order: FillerOrder,
): { externalId: string; text: string }[] {
  const indices = Array.from({ length: count }, (_, i) => i);
  if (order === "reversed") {
    indices.reverse();
  }
  return indices.map((i) => ({
    externalId: `scale-assoc-filler-${i}`,
    text: `log entry ${i}: node-${i % 997} reported status code ${i % 53} at tick ${i * 7 + 3}, batch ${Math.floor(i / 31)}, checksum ${(i * 2654435761) >>> 0}`,
  }));
}

interface CorpusTexts {
  base: { externalId: string; text: string; kind: string; probeId?: string }[];
  filler: { externalId: string; text: string }[];
}

function buildCorpus(scale: number, fillerOrder: FillerOrder): CorpusTexts {
  if (scale < ASSOCIATION_HAYSTACK_SIZE) {
    throw new Error(`buildCorpus: scale(${scale}) が小さすぎる`);
  }
  const base = buildAssociationProbeSetConversation();
  const filler = buildDistinctFiller(scale - ASSOCIATION_HAYSTACK_SIZE, fillerOrder);
  return { base, filler };
}

// ---------------------------------------------------------------------------
// VectorStore spy —— `association-scale-bench.ts` の複製。
// ---------------------------------------------------------------------------

interface SpyCall {
  kind: "search" | "getVectors";
  hits?: VectorHit[];
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
      const hits = await inner.search(ctx, space, query, opts);
      spy.calls.push({ kind: "search", hits });
      return hits;
    },
    getVectors: async (ctx, space, memoryIds) => {
      const result = await inner.getVectors!(ctx, space, memoryIds);
      spy.calls.push({ kind: "getVectors", memoryIds: [...memoryIds] });
      return result;
    },
  };
}

// ---------------------------------------------------------------------------
// runtime handle —— `association-scale-bench.ts` の `createInstrumentedRuntime` の
// 複製 + 追加の `PoolConfig`（EXACT 用の `options: "-c enable_indexscan=off ..."`）。
// ---------------------------------------------------------------------------

interface InstrumentedHandle {
  runtime: Runtime;
  memoryStore: PostgresMemoryStore;
  spy: VectorStoreSpy;
  pool: PostgresClient["pool"];
  cachingEmbeddingProvider: CachingEmbeddingProvider;
  close(): Promise<void>;
}

async function createInstrumentedRuntime(
  databaseUrl: string,
  cache: FileEmbeddingCache,
  extraOptions?: string,
): Promise<InstrumentedHandle> {
  const client = createPostgresClient(
    databaseUrl,
    extraOptions !== undefined ? { options: extraOptions } : undefined,
  );
  await runMigrations(client.pool);

  const { embeddingProvider: realEmbedding, llmProvider } = createProviders(process.env, {});
  if (!(realEmbedding instanceof LocalEmbeddingProvider)) {
    throw new Error(
      "association-scale-nondeterminism: MNEMORA_EMBEDDING=local を指定すること。",
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

// ---------------------------------------------------------------------------
// ingest —— `association-scale-bench.ts` の `ingestCorpus` の複製。
// ---------------------------------------------------------------------------

interface IngestResult {
  anchorIds: Map<string, MemoryId>;
  goldIds: Map<string, MemoryId>;
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
  }

  const ingestSeconds = (Date.now() - tIngest0) / 1000;

  const tDrain0 = Date.now();
  await drainEmbedTicks(handle.runtime, ctx, { expectedProcessed: expectedEmbedJobs });
  const drainSeconds = (Date.now() - tDrain0) / 1000;

  await handle.pool.query("ANALYZE");

  return { anchorIds, goldIds, ingestSeconds, drainSeconds };
}

// ---------------------------------------------------------------------------
// REINDEX（HNSW索引だけ）—— R1〜R3。行・memory_id・recorded_at・tie-breakは不変。
// ---------------------------------------------------------------------------

/**
 * ⚠ この器の `/dev/shm` は62MB しかない（【実測】`df -h /dev/shm`）。既定の
 * `max_parallel_maintenance_workers=2` のまま REINDEX すると、並列ワーカーの
 * 共有メモリ確保が `could not resize shared memory segment ... No space left on
 * device` で落ちる（【実測】I1のR1で実際に踏んだ）。並列ワーカーを使わせない
 * ことで塞ぐ——**索引の中身・HNSW構築アルゴリズム自体は変えない**（並列/直列は
 * ビルドの実行方式であって、レベル割り当てに使う乱数列や採用するグラフ構造の
 * 決定則を変えるものではない、という前提を置く。この前提自体は検証していない
 * ——確かめていないこととして報告に残す）。
 */
async function reindexHnsw(pool: PostgresClient["pool"], space: EmbeddingSpaceId): Promise<void> {
  const index = embeddingSpaceIndexName(space);
  assertSafeIdentifier(index);
  const client = await pool.connect();
  try {
    await client.query("SET max_parallel_maintenance_workers = 0");
    await client.query(`REINDEX INDEX ${index}`);
  } finally {
    client.release();
  }
  await pool.query("ANALYZE");
}

// ---------------------------------------------------------------------------
// probe ごとの測定(aRaw/到達 off・on-3・on-10/dActual) —— 既存ベンチの定義を踏む。
// ---------------------------------------------------------------------------

interface ProbeMeasurement {
  probeId: string;
  /** (a) raw — probe自身の anchor が段1の生ANN窓(kPrime=40)に入っていたか。 */
  aRaw: boolean;
  aRawRank: number | null;
  /** 到達 — gold が retrievedVia:"association" で返ったか(armごと)。 */
  reachedOff: boolean;
  reachedOn3: boolean;
  reachedOn10: boolean;
  /** 連想が実際にアンカーにした3件(anchorCount既定3、on-3のgetVectors呼び出し)に
   *  probe自身のanchorが入っていたか。 */
  dActual: boolean;
}

async function measureAllProbes(
  handle: InstrumentedHandle,
  tenantId: string,
  anchorIds: ReadonlyMap<string, MemoryId>,
  goldIds: ReadonlyMap<string, MemoryId>,
): Promise<ProbeMeasurement[]> {
  const ctx: Ctx = { tenantId };
  const out: ProbeMeasurement[] = [];
  for (const probe of ASSOCIATION_PROBES) {
    const anchorId = anchorIds.get(probe.id)!;
    const goldId = goldIds.get(probe.id)!;

    // off（同時に aRaw を測る — 段1のANN検索はarmに依らず同じkPrimeを使う）。
    handle.spy.reset();
    const offResult = await handle.runtime.recall(ctx, { text: probe.query });
    const searchCalls = handle.spy.calls.filter((c) => c.kind === "search");
    const rawHits = searchCalls[0]?.hits ?? [];
    const aRawIdx = rawHits.findIndex((h) => h.memoryId === anchorId);
    const aRaw = aRawIdx !== -1;
    const reachedOff = offResult.memories.some(
      (m) => m.memoryId === goldId && m.retrievedVia === "association",
    );

    // on-3（同時に dActual を測る）。
    handle.spy.reset();
    const on3Result = await handle.runtime.recall(ctx, {
      text: probe.query,
      association: { maxCount: 3 },
    });
    const reachedOn3 = on3Result.memories.some(
      (m) => m.memoryId === goldId && m.retrievedVia === "association",
    );
    const getVectorsCalls = handle.spy.calls.filter((c) => c.kind === "getVectors");
    const actualAnchorIds = getVectorsCalls[0]?.memoryIds ?? [];
    const dActual = actualAnchorIds.includes(anchorId);

    // on-10。
    handle.spy.reset();
    const on10Result = await handle.runtime.recall(ctx, {
      text: probe.query,
      association: { maxCount: 10 },
    });
    const reachedOn10 = on10Result.memories.some(
      (m) => m.memoryId === goldId && m.retrievedVia === "association",
    );

    out.push({
      probeId: probe.id,
      aRaw,
      aRawRank: aRaw ? aRawIdx + 1 : null,
      reachedOff,
      reachedOn3,
      reachedOn10,
      dActual,
    });
  }
  return out;
}

function summarizeMeasurement(label: string, probes: ProbeMeasurement[]): string {
  const n = probes.length;
  const aRawCount = probes.filter((p) => p.aRaw).length;
  const reachedOff = probes.filter((p) => p.reachedOff).length;
  const reachedOn3 = probes.filter((p) => p.reachedOn3).length;
  const reachedOn10 = probes.filter((p) => p.reachedOn10).length;
  const dActualCount = probes.filter((p) => p.dActual).length;
  return (
    `  [${label}] aRaw=${aRawCount}/${n} 到達(off/on-3/on-10)=${reachedOff}/${n} ` +
    `${reachedOn3}/${n} ${reachedOn10}/${n} dActual=${dActualCount}/${n}`
  );
}

// ---------------------------------------------------------------------------
// 厳密順位・距離・境界の同点 —— EXACT測定の中核。
// ---------------------------------------------------------------------------

function toVectorLiteral(vector: number[]): string {
  return `[${vector.join(",")}]`;
}

interface ExactRankResult {
  probeId: string;
  rank: number | null;
  distance: number | null;
  rank40Distance: number | null;
  rank41Distance: number | null;
  boundaryWindow: { rank: number; memoryId: string; distance: number }[];
  /** 境界(35〜45位)に、anchorと距離がfloat8で完全一致する別の行があるか。 */
  tieAtBoundary: boolean;
}

async function cachedVectorOrThrow(
  provider: CachingEmbeddingProvider,
  text: string,
): Promise<number[]> {
  const vectors = await provider.embed({ tenantId: "explain-probe" }, [text]);
  return vectors[0]!;
}

async function measureExactRanks(
  pool: PostgresClient["pool"],
  space: EmbeddingSpaceId,
  tenantId: string,
  anchorIds: ReadonlyMap<string, MemoryId>,
  cachingEmbeddingProvider: CachingEmbeddingProvider,
  opts: { noParallel?: boolean } = {},
): Promise<ExactRankResult[]> {
  const table = embeddingSpaceTableName(space);
  assertSafeIdentifier(table);
  const out: ExactRankResult[] = [];
  for (const probe of ASSOCIATION_PROBES) {
    const anchorId = anchorIds.get(probe.id)!;
    const queryVector = await cachedVectorOrThrow(cachingEmbeddingProvider, probe.query);
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL enable_indexscan = off");
      await client.query("SET LOCAL enable_bitmapscan = off");
      if (opts.noParallel) {
        await client.query("SET LOCAL max_parallel_workers_per_gather = 0");
      }
      const { rows } = await client.query(
        `SELECT e.memory_id AS memory_id, (e.embedding <=> $1::vector)::float8 AS distance
         FROM ${table} e
         JOIN memories m ON m.id = e.memory_id AND m.tenant_id = e.tenant_id
         WHERE e.tenant_id = $2
         ORDER BY e.embedding <=> $1::vector, m.recorded_at DESC, e.memory_id`,
        [toVectorLiteral(queryVector), tenantId],
      );
      await client.query("COMMIT");
      const idx = rows.findIndex((r: { memory_id: string }) => r.memory_id === anchorId);
      const rank = idx === -1 ? null : idx + 1;
      const distance =
        idx === -1 ? null : Number((rows[idx] as { distance: number }).distance);
      const rank40Distance = rows[39]
        ? Number((rows[39] as { distance: number }).distance)
        : null;
      const rank41Distance = rows[40]
        ? Number((rows[40] as { distance: number }).distance)
        : null;
      const boundaryWindow = rows
        .slice(34, 45)
        .map((r: { memory_id: string; distance: number }, i: number) => ({
          rank: 35 + i,
          memoryId: r.memory_id,
          distance: Number(r.distance),
        }));
      const tieAtBoundary =
        distance !== null &&
        boundaryWindow.some((w) => w.memoryId !== anchorId && w.distance === distance);
      out.push({
        probeId: probe.id,
        rank,
        distance,
        rank40Distance,
        rank41Distance,
        boundaryWindow,
        tieAtBoundary,
      });
    } finally {
      client.release();
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// EXPLAIN —— 索引使用の有無を確かめる（判定ではなくヒューリスティック、AGENTS.md「機械には検出まで」）。
// ---------------------------------------------------------------------------

interface ExplainCapture {
  label: string;
  text: string;
  hnswUsedHeuristic: boolean;
  seqScanHeuristic: boolean;
}

async function captureExplainAt(
  pool: PostgresClient["pool"],
  table: string,
  tenantId: string,
  label: string,
  vector: number[],
  limit: number,
  setupSql: string[],
): Promise<ExplainCapture> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const s of setupSql) {
      await client.query(s);
    }
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
    const hnswUsedHeuristic =
      /Index (Scan|Only Scan).*hnsw/i.test(text) || /idx_memory_embeddings_hnsw/i.test(text);
    const seqScanHeuristic = /Seq Scan/i.test(text);
    return { label, text, hnswUsedHeuristic, seqScanHeuristic };
  } finally {
    client.release();
  }
}

async function showEfSearch(pool: PostgresClient["pool"]): Promise<string> {
  const { rows } = await pool.query("SHOW hnsw.ef_search");
  return JSON.stringify(rows);
}

/**
 * `captureExplainAt`と違い、`memories`へのJOINと3段tie-break（`vector-store.ts`の
 * `search()`と1バイトも違わない形）を含む——**ef_searchが上がると、この JOIN
 * 付きクエリと JOIN 無しの `captureExplainAt` とでプランナのコスト推定が乖離し、
 * 索引を諦める閾値(Seq Scanへ切り替わるef値)がずれる**ことを実機で確認した
 * (ef=400で`captureExplainAt`はSeq Scanと報告したが、この関数(JOIN付き、
 * 本番と同形)ではef=500まで索引が使われ、ef=600以降でSeq Scanに切り替わった
 * ——`/tmp/mgr-243b5dc9/`での実測、2026-09-26)。**aRaw/到達の実測値自体は
 * `measureEfPoint`が本物の`runtime.recall()`(`PostgresVectorStore.search()`)を
 * 経由するため、この関数の結果に依存せず正しい**——この関数は「その値が
 * 本当に索引を使って得られたのか、それともプランナが黙って厳密探索へ
 * 倒れた結果なのか」を切り分ける診断専用。
 */
async function captureExplainAtProduction(
  pool: PostgresClient["pool"],
  table: string,
  tenantId: string,
  label: string,
  vector: number[],
  limit: number,
  setupSql: string[],
): Promise<ExplainCapture> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const s of setupSql) {
      await client.query(s);
    }
    const { rows } = await client.query(
      `EXPLAIN (ANALYZE, BUFFERS)
       SELECT e.memory_id AS memory_id, e.embedding <=> $1::vector AS distance
       FROM ${table} e
       JOIN memories m ON m.id = e.memory_id AND m.tenant_id = e.tenant_id
       WHERE e.tenant_id = $2
       ORDER BY e.embedding <=> $1::vector, m.recorded_at DESC, e.memory_id
       LIMIT $3`,
      [toVectorLiteral(vector), tenantId, limit],
    );
    await client.query("COMMIT");
    const text = rows.map((r: { "QUERY PLAN": string }) => r["QUERY PLAN"]).join("\n");
    const hnswUsedHeuristic =
      /Index (Scan|Only Scan).*hnsw/i.test(text) || /idx_memory_embeddings_hnsw/i.test(text);
    const seqScanHeuristic = /Seq Scan/i.test(text);
    return { label, text, hnswUsedHeuristic, seqScanHeuristic };
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------------
// 1測定点(M0/EXACT/R1..R3)ぶんのレポート型。
// ---------------------------------------------------------------------------

interface MeasurementReport {
  label: string;
  probes: ProbeMeasurement[];
  explainQuery: ExplainCapture;
  explainAnchor: ExplainCapture;
  efSearch: string;
}

interface ExactMeasurementReport extends MeasurementReport {
  exactRanks: ExactRankResult[];
}

interface IngestReport {
  label: string;
  fillerOrder: FillerOrder;
  ingestSeconds: number;
  drainSeconds: number;
  m0: MeasurementReport;
  exact: ExactMeasurementReport;
  r: MeasurementReport[];
  /** I1だけ: max_parallel_workers_per_gather=0 の有無で厳密順位が変わるか(余力があれば)。 */
  exactNoParallelRanks?: ExactRankResult[];
}

async function buildMeasurementReport(
  handle: InstrumentedHandle,
  tenantId: string,
  space: EmbeddingSpaceId,
  anchorIds: ReadonlyMap<string, MemoryId>,
  goldIds: ReadonlyMap<string, MemoryId>,
  label: string,
  explainSetupSql: string[],
): Promise<MeasurementReport> {
  const probes = await measureAllProbes(handle, tenantId, anchorIds, goldIds);
  const table = embeddingSpaceTableName(space);
  assertSafeIdentifier(table);
  const kPrime = Math.max(1, Math.round(DEFAULT_RECALL_LIMIT * DEFAULT_OVER_FETCH_FACTOR));
  const repProbe = ASSOCIATION_PROBES[0]!;
  const queryVector = await cachedVectorOrThrow(handle.cachingEmbeddingProvider, repProbe.query);
  const anchorVector = await cachedVectorOrThrow(handle.cachingEmbeddingProvider, repProbe.anchor);
  const explainQuery = await captureExplainAt(
    handle.pool,
    table,
    tenantId,
    `${label}(query視点)`,
    queryVector,
    kPrime,
    explainSetupSql,
  );
  const explainAnchor = await captureExplainAt(
    handle.pool,
    table,
    tenantId,
    `${label}(anchor視点)`,
    anchorVector,
    kPrime,
    explainSetupSql,
  );
  const efSearch = await showEfSearch(handle.pool);
  return { label, probes, explainQuery, explainAnchor, efSearch };
}

// ---------------------------------------------------------------------------
// repeat-ef モード(マネージャー追加依頼、2026-09-26) —— 以下の3点を追加で測る。
//
// 1. M0だけの追加反復(I4〜I8、filler順はforward固定)。ADR 0332の1万行(A)では
//    独立ingestのaRawが0,9,1,0と揺れた——本ファイルのmainモード(I1〜I3)では
//    3回とも0/12でほぼ揺れなかったため、反復数を増やして分布を見る。
// 2. I4の索引をそのまま(REINDEXしない)使い、hnsw.ef_search=40/120/400/1000を
//    本番経路(PostgresVectorStore.search、ADR 0284のrelaxed_order込み)で掃引。
//    aRaw・到達(on-3/on-10)・aRawに入ったときの順位を見る——「取りこぼしが
//    探索幅の問題か(efで戻るか)、ef=1000でも戻らないか(グラフ到達性の問題を
//    示唆)」を分けるため。EXPLAINでHNSW使用を確認する。
// 3. (余力があれば)I4・ef=40の上で、hnsw.iterative_scan=off と relaxed_order
//    でaRawが変わるか。**production経路(PostgresVectorStore.search)は
//    ADR 0284によりrelaxed_orderを無条件にSET LOCALするため、iterative_scan=off
//    はproduction経路からは再現できない**——ここだけは生SQL(EXACT測定と同じ
//    `pool.connect()`→`BEGIN`→`SET LOCAL`→`SELECT`→`COMMIT`の形)で、
//    LIMIT=kPrime・索引は使わせたまま(enable_indexscanは弄らない)、
//    `hnsw.iterative_scan`の値だけを変えて生ANN候補の集合を直接比べる。
// ---------------------------------------------------------------------------

/** `association-scale-bench.ts` の `setEfSearchAndReconnect` と同じ形の複製。 */
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

interface EfProbeResult {
  probeId: string;
  aRaw: boolean;
  aRawRank: number | null;
  reachedOn3: boolean;
  reachedOn10: boolean;
}

/** ef_search掃引の1点ぶん —— 本番経路(runtime.recall、spy)でaRaw/rank/到達(on-3/on-10)を測る。 */
async function measureEfPoint(
  handle: InstrumentedHandle,
  tenantId: string,
  anchorIds: ReadonlyMap<string, MemoryId>,
  goldIds: ReadonlyMap<string, MemoryId>,
): Promise<EfProbeResult[]> {
  const ctx: Ctx = { tenantId };
  const out: EfProbeResult[] = [];
  for (const probe of ASSOCIATION_PROBES) {
    const anchorId = anchorIds.get(probe.id)!;
    const goldId = goldIds.get(probe.id)!;

    handle.spy.reset();
    await handle.runtime.recall(ctx, { text: probe.query });
    const searchCalls = handle.spy.calls.filter((c) => c.kind === "search");
    const rawHits = searchCalls[0]?.hits ?? [];
    const idx = rawHits.findIndex((h) => h.memoryId === anchorId);
    const aRaw = idx !== -1;

    handle.spy.reset();
    const on3 = await handle.runtime.recall(ctx, {
      text: probe.query,
      association: { maxCount: 3 },
    });
    const reachedOn3 = on3.memories.some(
      (m) => m.memoryId === goldId && m.retrievedVia === "association",
    );

    handle.spy.reset();
    const on10 = await handle.runtime.recall(ctx, {
      text: probe.query,
      association: { maxCount: 10 },
    });
    const reachedOn10 = on10.memories.some(
      (m) => m.memoryId === goldId && m.retrievedVia === "association",
    );

    out.push({
      probeId: probe.id,
      aRaw,
      aRawRank: aRaw ? idx + 1 : null,
      reachedOn3,
      reachedOn10,
    });
  }
  return out;
}

interface EfSweepPoint {
  ef: number;
  efSearchShown: string;
  probes: EfProbeResult[];
  explainQuery: ExplainCapture;
}

/** 生ANN候補(memory_id, distance)をLIMIT件、指定したsetupSqlの下で1本の接続内で撮る。 */
async function rawAnnHits(
  pool: PostgresClient["pool"],
  table: string,
  tenantId: string,
  vector: number[],
  limit: number,
  setupSql: string[],
): Promise<{ memoryId: string; distance: number }[]> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const s of setupSql) {
      await client.query(s);
    }
    const { rows } = await client.query(
      `SELECT e.memory_id AS memory_id, (e.embedding <=> $1::vector)::float8 AS distance
       FROM ${table} e
       JOIN memories m ON m.id = e.memory_id AND m.tenant_id = e.tenant_id
       WHERE e.tenant_id = $2
       ORDER BY e.embedding <=> $1::vector, m.recorded_at DESC, e.memory_id
       LIMIT $3`,
      [toVectorLiteral(vector), tenantId, limit],
    );
    await client.query("COMMIT");
    return rows.map((r: { memory_id: string; distance: number }) => ({
      memoryId: r.memory_id,
      distance: Number(r.distance),
    }));
  } finally {
    client.release();
  }
}

interface IterativeScanComparisonRow {
  probeId: string;
  aRawRelaxedOrder: boolean;
  aRawOff: boolean;
}

/**
 * I4・ef=40の上で、`hnsw.iterative_scan`を`relaxed_order`(production既定)と`off`の
 * 2通りに変えたときの生ANN(kPrime=40)候補にanchorが入るかを比べる。**索引は
 * 使わせたまま**(enable_indexscanには触れない)——変えるのは`iterative_scan`だけ。
 */
async function runIterativeScanComparison(
  pool: PostgresClient["pool"],
  space: EmbeddingSpaceId,
  tenantId: string,
  anchorIds: ReadonlyMap<string, MemoryId>,
  cachingEmbeddingProvider: CachingEmbeddingProvider,
): Promise<IterativeScanComparisonRow[]> {
  const table = embeddingSpaceTableName(space);
  assertSafeIdentifier(table);
  const kPrime = Math.max(1, Math.round(DEFAULT_RECALL_LIMIT * DEFAULT_OVER_FETCH_FACTOR));
  const out: IterativeScanComparisonRow[] = [];
  for (const probe of ASSOCIATION_PROBES) {
    const anchorId = anchorIds.get(probe.id)!;
    const vector = await cachedVectorOrThrow(cachingEmbeddingProvider, probe.query);
    const relaxed = await rawAnnHits(pool, table, tenantId, vector, kPrime, [
      "SET LOCAL hnsw.iterative_scan = relaxed_order",
    ]);
    const off = await rawAnnHits(pool, table, tenantId, vector, kPrime, [
      "SET LOCAL hnsw.iterative_scan = off",
    ]);
    out.push({
      probeId: probe.id,
      aRawRelaxedOrder: relaxed.some((r) => r.memoryId === anchorId),
      aRawOff: off.some((r) => r.memoryId === anchorId),
    });
  }
  return out;
}

interface RepeatReport {
  label: string;
  ingestSeconds: number;
  drainSeconds: number;
  m0: MeasurementReport;
}

interface RepeatEfReport {
  repeats: RepeatReport[];
  efSweep: EfSweepPoint[];
  iterativeScanComparison: IterativeScanComparisonRow[];
}

// ⚠ [40,120,400,1000]の粗い掃引では「ef=1000で全回復」に見えたが、
// `captureExplainAtProduction`による実機検証(2026-09-26)で、本番と同形のクエリは
// ef=500まで索引を使い、ef=600以降でプランナがSeq Scan(厳密探索)へ切り替わる
// ことが分かった——⟹ 1000は索引が効いていない領域。500近辺の解像度を上げて、
// 「索引が効いている範囲内でaRawが改善するか」を見られるようにする。
const EF_SWEEP_VALUES = [40, 120, 400, 500, 550, 600, 700, 1000];

/**
 * I4(または単独ingestのef-sweepモード)の索引をそのまま使い、ef_search掃引 +
 * (余力)iterative_scan比較を行う。呼び出し側が既にingest済みのanchorIds/goldIds/
 * spaceを渡す——**REINDEXもTRUNCATEもしない**(索引・行は不変のまま、ef_searchと
 * iterative_scanという「検索時」パラメータだけを動かす)。
 */
async function runEfSweepAndIterativeScan(
  databaseUrl: string,
  databaseName: string,
  cache: FileEmbeddingCache,
  tenantId: string,
  anchorIds: ReadonlyMap<string, MemoryId>,
  goldIds: ReadonlyMap<string, MemoryId>,
  space: EmbeddingSpaceId,
): Promise<{ efSweep: EfSweepPoint[]; iterativeScanComparison: IterativeScanComparisonRow[] }> {
  const table = embeddingSpaceTableName(space);
  assertSafeIdentifier(table);
  const efSweep: EfSweepPoint[] = [];

  for (const ef of EF_SWEEP_VALUES) {
    const efHandle = await setEfSearchAndReconnect(databaseUrl, databaseName, ef, cache);
    const check = await efHandle.pool.query("show hnsw.ef_search");
    const efSearchShown = JSON.stringify(check.rows);
    const probes = await measureEfPoint(efHandle, tenantId, anchorIds, goldIds);
    const kPrime = Math.max(1, Math.round(DEFAULT_RECALL_LIMIT * DEFAULT_OVER_FETCH_FACTOR));
    const repProbe = ASSOCIATION_PROBES[0]!;
    const queryVector = await cachedVectorOrThrow(efHandle.cachingEmbeddingProvider, repProbe.query);
    // ⚠ 本番と同形(JOIN + 3段tie-break込み)のEXPLAINを撮る——`captureExplainAt`
    // (JOIN無し)はef_searchが上がったときのプランナのコスト推定がずれ、
    // 索引を諦める閾値を読み違える(2026-09-26の実機検証、上のコメント参照)。
    const explainQuery = await captureExplainAtProduction(
      efHandle.pool,
      table,
      tenantId,
      `ef=${ef}`,
      queryVector,
      kPrime,
      ["SET LOCAL hnsw.iterative_scan = relaxed_order"],
    );
    const aRawCount = probes.filter((p) => p.aRaw).length;
    const on3Count = probes.filter((p) => p.reachedOn3).length;
    const on10Count = probes.filter((p) => p.reachedOn10).length;
    console.log(
      `  [efSweep ef=${ef}] ef_search実測=${efSearchShown} aRaw=${aRawCount}/12 ` +
        `到達on-3=${on3Count}/12 到達on-10=${on10Count}/12 ` +
        `hnsw(本番形)=${explainQuery.hnswUsedHeuristic} seq(本番形)=${explainQuery.seqScanHeuristic}`,
    );
    for (const p of probes) {
      console.log(
        `    [ef=${ef}] ${p.probeId}: aRaw=${p.aRaw} rank=${p.aRawRank} on3=${p.reachedOn3} on10=${p.reachedOn10}`,
      );
    }
    efSweep.push({ ef, efSearchShown, probes, explainQuery });
    await efHandle.close();
  }

  // --- 余力: ef=40の上でiterative_scan=off vs relaxed_orderの比較(生SQL) ---
  const ef40Handle = await setEfSearchAndReconnect(databaseUrl, databaseName, 40, cache);
  const iterativeScanComparison = await runIterativeScanComparison(
    ef40Handle.pool,
    space,
    tenantId,
    anchorIds,
    ef40Handle.cachingEmbeddingProvider,
  );
  const diffCount = iterativeScanComparison.filter((r) => r.aRawRelaxedOrder !== r.aRawOff).length;
  console.log(`  [iterativeScan比較] relaxed_order vs off で差が出たprobe: ${diffCount}/12`);
  for (const r of iterativeScanComparison) {
    console.log(`    ${r.probeId}: relaxed_order=${r.aRawRelaxedOrder} off=${r.aRawOff}`);
  }
  await ef40Handle.close();

  // ef_searchをDB既定へ戻す(呼び出し側の後続測定に漏れないように)。
  const resetHandle = await createInstrumentedRuntime(databaseUrl, cache);
  await resetHandle.pool.query(`ALTER DATABASE ${databaseName} RESET hnsw.ef_search`);
  await resetHandle.close();

  return { efSweep, iterativeScanComparison };
}

/** 単独ingest(I9)1回だけしてef-sweepを行う軽量モード(`MNEMORA_ASSOC_NONDET_MODE=ef-sweep`)。
 * I4〜I8のM0反復(既に別実行で測定済み)を再実行せずに済ませるため。 */
async function runEfSweepOnlyMode(
  databaseUrl: string,
  databaseName: string,
  scale: number,
  cache: FileEmbeddingCache,
): Promise<{
  ingest: { label: string; ingestSeconds: number; drainSeconds: number; m0: MeasurementReport };
  efSweep: EfSweepPoint[];
  iterativeScanComparison: IterativeScanComparisonRow[];
}> {
  const tenantId = "nondet-efsweep";
  console.log(`\n########## I9 (fillerOrder=forward, ef-sweep単独モード) ##########`);
  const corpus = buildCorpus(scale, "forward");
  const handle = await createInstrumentedRuntime(databaseUrl, cache);
  await truncateAll(handle.pool);
  const ingest = await ingestCorpus(handle, tenantId, corpus);
  console.log(`  ingest=${ingest.ingestSeconds.toFixed(1)}s drain=${ingest.drainSeconds.toFixed(1)}s`);
  const space = handle.cachingEmbeddingProvider.space;

  const m0 = await buildMeasurementReport(
    handle,
    tenantId,
    space,
    ingest.anchorIds,
    ingest.goldIds,
    "M0",
    ["SET LOCAL hnsw.iterative_scan = relaxed_order"],
  );
  console.log(summarizeMeasurement("M0", m0.probes));
  await handle.close();

  const { efSweep, iterativeScanComparison } = await runEfSweepAndIterativeScan(
    databaseUrl,
    databaseName,
    cache,
    tenantId,
    ingest.anchorIds,
    ingest.goldIds,
    space,
  );

  return {
    ingest: {
      label: "I9",
      ingestSeconds: ingest.ingestSeconds,
      drainSeconds: ingest.drainSeconds,
      m0,
    },
    efSweep,
    iterativeScanComparison,
  };
}

async function runRepeatEfMode(
  databaseUrl: string,
  databaseName: string,
  scale: number,
  cache: FileEmbeddingCache,
): Promise<RepeatEfReport> {
  const tenantId = "nondet-repeat";
  const labels = ["I4", "I5", "I6", "I7", "I8"];
  const repeats: RepeatReport[] = [];
  let efSweep: EfSweepPoint[] = [];
  let iterativeScanComparison: IterativeScanComparisonRow[] = [];

  for (const label of labels) {
    console.log(`\n########## ${label} (fillerOrder=forward, repeat-efモード) ##########`);
    const corpus = buildCorpus(scale, "forward");
    const handle = await createInstrumentedRuntime(databaseUrl, cache);
    await truncateAll(handle.pool);
    const ingest = await ingestCorpus(handle, tenantId, corpus);
    console.log(`  ingest=${ingest.ingestSeconds.toFixed(1)}s drain=${ingest.drainSeconds.toFixed(1)}s`);
    const space = handle.cachingEmbeddingProvider.space;

    const m0 = await buildMeasurementReport(
      handle,
      tenantId,
      space,
      ingest.anchorIds,
      ingest.goldIds,
      "M0",
      ["SET LOCAL hnsw.iterative_scan = relaxed_order"],
    );
    console.log(summarizeMeasurement("M0", m0.probes));
    repeats.push({ label, ingestSeconds: ingest.ingestSeconds, drainSeconds: ingest.drainSeconds, m0 });

    if (label === "I4") {
      // --- I4の索引そのまま(REINDEXしない)でef_search掃引 + iterative_scan比較 ---
      // (共通ロジックは runEfSweepAndIterativeScan、ef-sweep単独モードと共有)
      const result = await runEfSweepAndIterativeScan(
        databaseUrl,
        databaseName,
        cache,
        tenantId,
        ingest.anchorIds,
        ingest.goldIds,
        space,
      );
      efSweep = result.efSweep;
      iterativeScanComparison = result.iterativeScanComparison;
    }

    await handle.close();
  }

  return { repeats, efSweep, iterativeScanComparison };
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  // ⛔ 何よりも先に。provider を1つも作らない歯。
  requireGatesOrThrow();

  const databaseUrl = requireDatabaseUrl();
  const databaseName = new URL(databaseUrl).pathname.replace(/^\//, "");
  const scale = parseIntEnv("MNEMORA_ASSOC_NONDET_SCALE", 10000);
  const cacheDir =
    process.env.MNEMORA_ASSOC_NONDET_EMBED_CACHE_DIR ?? "/tmp/mnemora-assoc-nondet-embcache";
  const jsonPath = process.env.MNEMORA_ASSOC_NONDET_JSON;
  const tenantId = "nondet";
  const modeEnv = process.env.MNEMORA_ASSOC_NONDET_MODE;
  const mode = modeEnv === "repeat-ef" ? "repeat-ef" : modeEnv === "ef-sweep" ? "ef-sweep" : "main";

  console.log(`scale=${scale} cacheDir=${cacheDir} mode=${mode}`);

  const { embeddingProvider: realEmbedding } = createProviders(process.env, {});
  if (!(realEmbedding instanceof LocalEmbeddingProvider)) {
    // requireGatesOrThrow() が文字列レベルで既に検査しているので、ここに来るのは
    // 「文字列は local と名乗ったのに実際は違うインスタンスだった」という、それ自体が
    // 壊れの証拠になるケースだけである。多層防御として残す。
    throw new Error("association-scale-nondeterminism: realEmbedding が LocalEmbeddingProvider ではない。");
  }
  const warmup = await warmupLocalEmbedding(realEmbedding);
  if (!warmup.ok) {
    console.error(warmup.detail);
    process.exitCode = 1;
    return;
  }
  console.log(warmup.detail);

  const cache = new FileEmbeddingCache(cacheDir, realEmbedding.space);

  // precompute: I1/I2/I3(/I4〜I8) は filler の「挿入順」だけが違い、テキスト集合自体は
  // 同じ——一度の precompute で全 ingest ぶんのキャッシュが埋まる。
  const forwardCorpus = buildCorpus(scale, "forward");
  const allTexts = [
    ...forwardCorpus.base.map((u) => u.text),
    ...forwardCorpus.filler.map((f) => f.text),
  ];
  console.log(`\n=== 埋め込みキャッシュを埋める(${allTexts.length}件、重複除去後) ===`);
  const precompute = await precomputeEmbeddingCache(realEmbedding, cache, allTexts, {
    batchSize: 64,
    concurrency: 1,
  });
  console.log(
    `  precompute: unique=${precompute.uniqueTextCount} hit=${precompute.hitCount} ` +
      `miss=${precompute.missCount} ms=${precompute.ms.toFixed(0)}`,
  );

  if (mode === "repeat-ef") {
    const report = await runRepeatEfMode(databaseUrl, databaseName, scale, cache);
    cache.close();
    if (jsonPath) {
      mkdirSync(dirname(jsonPath), { recursive: true });
      writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf-8");
      console.log(`\n[association-scale-nondeterminism] repeat-efモードの結果を書き出した: ${jsonPath}`);
    }
    return;
  }

  if (mode === "ef-sweep") {
    const report = await runEfSweepOnlyMode(databaseUrl, databaseName, scale, cache);
    cache.close();
    if (jsonPath) {
      mkdirSync(dirname(jsonPath), { recursive: true });
      writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf-8");
      console.log(`\n[association-scale-nondeterminism] ef-sweepモードの結果を書き出した: ${jsonPath}`);
    }
    return;
  }

  const plans: { label: string; fillerOrder: FillerOrder }[] = [
    { label: "I1", fillerOrder: "forward" },
    { label: "I2", fillerOrder: "forward" },
    { label: "I3", fillerOrder: "reversed" },
  ];

  const reports: IngestReport[] = [];

  for (const plan of plans) {
    console.log(`\n########## ${plan.label} (fillerOrder=${plan.fillerOrder}) ##########`);
    const corpus = buildCorpus(scale, plan.fillerOrder);

    // --- TRUNCATE + ingest + drain + ANALYZE ---
    const handle = await createInstrumentedRuntime(databaseUrl, cache);
    await truncateAll(handle.pool);
    const ingest = await ingestCorpus(handle, tenantId, corpus);
    console.log(`  ingest=${ingest.ingestSeconds.toFixed(1)}s drain=${ingest.drainSeconds.toFixed(1)}s`);
    const space = handle.cachingEmbeddingProvider.space;

    // --- M0: そのまま ---
    const m0 = await buildMeasurementReport(
      handle,
      tenantId,
      space,
      ingest.anchorIds,
      ingest.goldIds,
      "M0",
      ["SET LOCAL hnsw.iterative_scan = relaxed_order"],
    );
    console.log(summarizeMeasurement("M0", m0.probes));
    console.log(
      `    explain(query) hnsw=${m0.explainQuery.hnswUsedHeuristic} seq=${m0.explainQuery.seqScanHeuristic} ` +
        `explain(anchor) hnsw=${m0.explainAnchor.hnswUsedHeuristic} seq=${m0.explainAnchor.seqScanHeuristic} ` +
        `ef_search=${m0.efSearch}`,
    );
    await handle.close();

    // --- EXACT: enable_indexscan/enable_bitmapscan off の別 runtime ---
    const exactHandle = await createInstrumentedRuntime(
      databaseUrl,
      cache,
      "-c enable_indexscan=off -c enable_bitmapscan=off",
    );
    const exactBase = await buildMeasurementReport(
      exactHandle,
      tenantId,
      space,
      ingest.anchorIds,
      ingest.goldIds,
      "EXACT",
      ["SET LOCAL enable_indexscan = off", "SET LOCAL enable_bitmapscan = off"],
    );
    console.log(summarizeMeasurement("EXACT", exactBase.probes));
    console.log(
      `    explain(query) hnsw=${exactBase.explainQuery.hnswUsedHeuristic} seq=${exactBase.explainQuery.seqScanHeuristic} ` +
        `explain(anchor) hnsw=${exactBase.explainAnchor.hnswUsedHeuristic} seq=${exactBase.explainAnchor.seqScanHeuristic}`,
    );
    const exactRanks = await measureExactRanks(
      exactHandle.pool,
      space,
      tenantId,
      ingest.anchorIds,
      exactHandle.cachingEmbeddingProvider,
    );
    for (const r of exactRanks) {
      console.log(
        `    exactRank[${r.probeId}] rank=${r.rank} distance=${r.distance} ` +
          `rank40=${r.rank40Distance} rank41=${r.rank41Distance} tieAtBoundary=${r.tieAtBoundary}`,
      );
    }
    const exact: ExactMeasurementReport = { ...exactBase, exactRanks };

    // I1 だけ、余力があれば: max_parallel_workers_per_gather=0 の有無で厳密順位が動くか。
    let exactNoParallelRanks: ExactRankResult[] | undefined;
    if (plan.label === "I1") {
      exactNoParallelRanks = await measureExactRanks(
        exactHandle.pool,
        space,
        tenantId,
        ingest.anchorIds,
        exactHandle.cachingEmbeddingProvider,
        { noParallel: true },
      );
      const diffCount = exactRanks.filter((r, i) => {
        const other = exactNoParallelRanks![i]!;
        return r.rank !== other.rank || r.distance !== other.distance;
      }).length;
      console.log(`  [I1限定] max_parallel_workers_per_gather=0 有無での差分: ${diffCount}/12 probe`);
    }
    await exactHandle.close();

    // --- R1..R3: REINDEX(HNSWだけ) -> ANALYZE -> M0と同じ測定 ---
    const rReports: MeasurementReport[] = [];
    for (let i = 1; i <= 3; i += 1) {
      const rHandle = await createInstrumentedRuntime(databaseUrl, cache);
      await reindexHnsw(rHandle.pool, space);
      const rReport = await buildMeasurementReport(
        rHandle,
        tenantId,
        space,
        ingest.anchorIds,
        ingest.goldIds,
        `R${i}`,
        ["SET LOCAL hnsw.iterative_scan = relaxed_order"],
      );
      console.log(summarizeMeasurement(`R${i}`, rReport.probes));
      console.log(
        `    explain(query) hnsw=${rReport.explainQuery.hnswUsedHeuristic} seq=${rReport.explainQuery.seqScanHeuristic}`,
      );
      rReports.push(rReport);
      await rHandle.close();
    }

    reports.push({
      label: plan.label,
      fillerOrder: plan.fillerOrder,
      ingestSeconds: ingest.ingestSeconds,
      drainSeconds: ingest.drainSeconds,
      m0,
      exact,
      r: rReports,
      ...(exactNoParallelRanks ? { exactNoParallelRanks } : {}),
    });
  }

  cache.close();

  if (jsonPath) {
    mkdirSync(dirname(jsonPath), { recursive: true });
    writeFileSync(jsonPath, `${JSON.stringify(reports, null, 2)}\n`, "utf-8");
    console.log(`\n[association-scale-nondeterminism] 機械可読な結果を書き出した: ${jsonPath}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
