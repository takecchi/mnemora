#!/usr/bin/env node
/**
 * `association-scale-nondeterminism` ベンチ。ingest をやり直すたびに連想枠の到達が揺れる原因を切り分ける診断。
 * 測定であり判定ではない。CI には載せず、exit code は結果で変えない。
 *
 * `association-scale-bench.ts` のロジックは複製しており、あちらは変更しない。既存ベンチのコードを変えない規律と、
 * export 追加で変えてよいという依頼が両立しなかったため、複製（無変更）の側を採った。
 *
 * `MNEMORA_LLM=deterministic` と `MNEMORA_EMBEDDING=local` は両方省略できない。`OPENAI_API_KEY` が環境に在ると、
 * 省略した場合に `precomputeEmbeddingCache` が実 OpenAI API へ `embed()` を呼ぶ。`requireGatesOrThrow()` が
 * provider を構築する前に文字列だけで検査して落とす。
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Ctx, EmbeddingSpaceId, MemoryId, Runtime } from "@mnemora/core";
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
import { type VectorStoreSpy, wrapVectorStoreWithSpy } from "./vector-store-spy.js";
import { warmupLocalEmbedding } from "../local-embedding-warmup.js";
import { createProviders, selectEmbeddingMode, selectLLMMode } from "../providers.js";
import {
  CachingEmbeddingProvider,
  FileEmbeddingCache,
  precomputeEmbeddingCache,
} from "./embedding-cache.js";

/** provider を構築する前に、環境変数の文字列だけで判定する。ここを通らない限り、後続のコードは実行しない（実 API を叩かないため）。 */
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
  // `createExampleRuntime` と同じ穴。`client` を作った後、`close()` を持つ handle を返す前に失敗しうる処理が続く。
  // ここで reject すると呼び出し側は handle を受け取れず `close()` できないため、ここで閉じる。
  try {
    await runMigrations(client.pool);

    const { embeddingProvider: realEmbedding, llmProvider } = createProviders(process.env, {});
    if (!(realEmbedding instanceof LocalEmbeddingProvider)) {
      throw new Error("association-scale-nondeterminism: MNEMORA_EMBEDDING=local を指定すること。");
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
  } catch (err) {
    await closePostgresClient(client).catch(() => {});
    throw err;
  }
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

/**
 * この器の `/dev/shm` は62MB しかなく、既定の `max_parallel_maintenance_workers=2` のまま REINDEX すると
 * 並列ワーカーの共有メモリ確保が落ちる。並列ワーカーを使わせない。並列/直列はビルドの実行方式で、HNSW の乱数や
 * 構造の決定則を変えないという前提を置くが、この前提は検証していない。
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

interface ProbeMeasurement {
  probeId: string;
  aRaw: boolean;
  aRawRank: number | null;
  reachedOff: boolean;
  reachedOn3: boolean;
  reachedOn10: boolean;
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

    handle.spy.reset();
    // association: null — 明示的な off。`association` を省略すると既定 on になり得るので、off の測定点を守る。
    const offResult = await handle.runtime.recall(ctx, { text: probe.query, association: null });
    const searchCalls = handle.spy.calls.filter((c) => c.kind === "search");
    const rawHits = searchCalls[0]?.hits ?? [];
    const aRawIdx = rawHits.findIndex((h) => h.memoryId === anchorId);
    const aRaw = aRawIdx !== -1;
    const reachedOff = offResult.memories.some(
      (m) => m.memoryId === goldId && m.retrievedVia === "association",
    );

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
      const distance = idx === -1 ? null : Number((rows[idx] as { distance: number }).distance);
      const rank40Distance = rows[39] ? Number((rows[39] as { distance: number }).distance) : null;
      const rank41Distance = rows[40] ? Number((rows[40] as { distance: number }).distance) : null;
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
 * `captureExplainAt` と違い、`memories` への JOIN と3段 tie-break を含む本番と同形のクエリ。ef_search が上がると
 * JOIN の有無でプランナのコスト推定が乖離し、索引を諦める閾値がずれる。aRaw/到達の実測値は本物の `runtime.recall()` を
 * 経由するのでこの関数に依存せず、この関数は「索引を使って得られた値か」を切り分ける診断専用。
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
    // association: null — 明示的な off。`association` を省略すると既定 on になるので、off の測定点を守る。
    await handle.runtime.recall(ctx, { text: probe.query, association: null });
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

const EF_SWEEP_VALUES = [40, 120, 400, 500, 550, 600, 700, 1000];

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
    const queryVector = await cachedVectorOrThrow(
      efHandle.cachingEmbeddingProvider,
      repProbe.query,
    );
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

  const resetHandle = await createInstrumentedRuntime(databaseUrl, cache);
  await resetHandle.pool.query(`ALTER DATABASE ${databaseName} RESET hnsw.ef_search`);
  await resetHandle.close();

  return { efSweep, iterativeScanComparison };
}

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
  console.log(
    `  ingest=${ingest.ingestSeconds.toFixed(1)}s drain=${ingest.drainSeconds.toFixed(1)}s`,
  );
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
    console.log(
      `  ingest=${ingest.ingestSeconds.toFixed(1)}s drain=${ingest.drainSeconds.toFixed(1)}s`,
    );
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
    repeats.push({
      label,
      ingestSeconds: ingest.ingestSeconds,
      drainSeconds: ingest.drainSeconds,
      m0,
    });

    if (label === "I4") {
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

type IngestOrder = "base-first" | "base-last" | "base-interleaved";

interface OrderedUtterance {
  externalId: string;
  text: string;
  kind: string;
  probeId?: string;
}

function buildOrderedCorpus(scale: number, order: IngestOrder): OrderedUtterance[] {
  const base = buildAssociationProbeSetConversation();
  const filler: OrderedUtterance[] = buildDistinctFiller(
    scale - ASSOCIATION_HAYSTACK_SIZE,
    "forward",
  ).map((f) => ({ ...f, kind: "filler" }));
  if (order === "base-first") {
    return [...base, ...filler];
  }
  if (order === "base-last") {
    return [...filler, ...base];
  }
  const out: OrderedUtterance[] = [];
  const ratio = filler.length / base.length;
  let baseIdx = 0;
  for (let i = 0; i < filler.length; i += 1) {
    out.push(filler[i]!);
    if (baseIdx < base.length && i + 1 >= Math.round((baseIdx + 1) * ratio)) {
      out.push(base[baseIdx]!);
      baseIdx += 1;
    }
  }
  while (baseIdx < base.length) {
    out.push(base[baseIdx]!);
    baseIdx += 1;
  }
  if (out.length !== base.length + filler.length) {
    throw new Error(
      `buildOrderedCorpus: interleaveの結果件数(${out.length})がbase+filler` +
        `(${base.length + filler.length})と一致しない`,
    );
  }
  return out;
}

async function ingestOrderedCorpus(
  handle: InstrumentedHandle,
  tenantId: string,
  utterances: OrderedUtterance[],
): Promise<IngestResult> {
  const ctx: Ctx = { tenantId };
  const anchorIds = new Map<string, MemoryId>();
  const goldIds = new Map<string, MemoryId>();

  const tIngest0 = Date.now();
  let expectedEmbedJobs = 0;

  for (const utterance of utterances) {
    const result = await handle.runtime.observe(ctx, {
      kind: "utterance",
      text: utterance.text,
      externalId: utterance.externalId,
    });
    expectedEmbedJobs += result.memoryIds.length;
    if (utterance.kind === "anchor" || utterance.kind === "gold") {
      if (result.memoryIds.length !== 1) {
        throw new Error(
          `ingestOrderedCorpus: ${utterance.externalId} の sync 抽出が期待通りに1件の` +
            `Memoryを作らなかった(${result.memoryIds.length}件)`,
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
      `ingestOrderedCorpus: anchorIds(${anchorIds.size})/goldIds(${goldIds.size})が` +
        `probe数(${ASSOCIATION_PROBES.length})と一致しない`,
    );
  }

  const ingestSeconds = (Date.now() - tIngest0) / 1000;

  const tDrain0 = Date.now();
  await drainEmbedTicks(handle.runtime, ctx, { expectedProcessed: expectedEmbedJobs });
  const drainSeconds = (Date.now() - tDrain0) / 1000;

  await handle.pool.query("ANALYZE");

  return { anchorIds, goldIds, ingestSeconds, drainSeconds };
}

interface OrderPointReport {
  label: string;
  order: IngestOrder;
  ingestSeconds: number;
  drainSeconds: number;
  m0: MeasurementReport;
  explain400: ExplainCapture;
  exact?: ExactMeasurementReport;
}

/**
 * `MNEMORA_ASSOC_NONDET_MODE=order`。base の ingest 位置を変えると `recorded_at` の新旧関係が変わり、
 * 段2の並べ替え（freshness）が到達に影響しうる。aRaw（段1の生ANN、並べ替え前）を主指標として読み、到達は参考値にする。
 */
async function runOrderExperimentMode(
  databaseUrl: string,
  databaseName: string,
  scale: number,
  cache: FileEmbeddingCache,
): Promise<{ points: OrderPointReport[] }> {
  const tenantId = "nondet-order";
  const plans: { label: string; order: IngestOrder; withExact: boolean }[] = [
    { label: "P1a-base-last", order: "base-last", withExact: true },
    { label: "P1b-base-last", order: "base-last", withExact: false },
    { label: "P2-base-interleaved", order: "base-interleaved", withExact: false },
    { label: "control-base-first", order: "base-first", withExact: false },
  ];

  const points: OrderPointReport[] = [];

  for (const plan of plans) {
    console.log(`\n########## ${plan.label} (order=${plan.order}) ##########`);
    const utterances = buildOrderedCorpus(scale, plan.order);

    const handle = await createInstrumentedRuntime(databaseUrl, cache);
    await truncateAll(handle.pool);
    const ingest = await ingestOrderedCorpus(handle, tenantId, utterances);
    console.log(
      `  ingest=${ingest.ingestSeconds.toFixed(1)}s drain=${ingest.drainSeconds.toFixed(1)}s`,
    );
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
    for (const p of m0.probes) {
      console.log(
        `    ${p.probeId}: aRaw=${p.aRaw} rank=${p.aRawRank} off=${p.reachedOff} ` +
          `on3=${p.reachedOn3} on10=${p.reachedOn10} dActual=${p.dActual}`,
      );
    }

    let exact: ExactMeasurementReport | undefined;
    if (plan.withExact) {
      const exactHandle = await createInstrumentedRuntime(
        databaseUrl,
        cache,
        "-c enable_indexscan=off -c enable_bitmapscan=off",
      );
      const exactBaseReport = await buildMeasurementReport(
        exactHandle,
        tenantId,
        space,
        ingest.anchorIds,
        ingest.goldIds,
        "EXACT",
        ["SET LOCAL enable_indexscan = off", "SET LOCAL enable_bitmapscan = off"],
      );
      const exactRanks = await measureExactRanks(
        exactHandle.pool,
        space,
        tenantId,
        ingest.anchorIds,
        exactHandle.cachingEmbeddingProvider,
      );
      console.log(summarizeMeasurement("EXACT", exactBaseReport.probes));
      for (const r of exactRanks) {
        console.log(`    exactRank[${r.probeId}] rank=${r.rank} distance=${r.distance}`);
      }
      exact = { ...exactBaseReport, exactRanks };
      await exactHandle.close();
    }

    await handle.close();

    const table = embeddingSpaceTableName(space);
    assertSafeIdentifier(table);
    const ef400Handle = await setEfSearchAndReconnect(databaseUrl, databaseName, 400, cache);
    const repProbe = ASSOCIATION_PROBES[0]!;
    const queryVector = await cachedVectorOrThrow(
      ef400Handle.cachingEmbeddingProvider,
      repProbe.query,
    );
    const kPrime = Math.max(1, Math.round(DEFAULT_RECALL_LIMIT * DEFAULT_OVER_FETCH_FACTOR));
    const explain400 = await captureExplainAtProduction(
      ef400Handle.pool,
      table,
      tenantId,
      `${plan.label}(ef=400)`,
      queryVector,
      kPrime,
      ["SET LOCAL hnsw.iterative_scan = relaxed_order"],
    );
    console.log(
      `  [ef=400本番形EXPLAIN] hnsw=${explain400.hnswUsedHeuristic} seq=${explain400.seqScanHeuristic}`,
    );
    await ef400Handle.close();
    const resetHandle = await createInstrumentedRuntime(databaseUrl, cache);
    await resetHandle.pool.query(`ALTER DATABASE ${databaseName} RESET hnsw.ef_search`);
    await resetHandle.close();

    points.push({
      label: plan.label,
      order: plan.order,
      ingestSeconds: ingest.ingestSeconds,
      drainSeconds: ingest.drainSeconds,
      m0,
      explain400,
      ...(exact ? { exact } : {}),
    });
  }

  return { points };
}

// order-scale モード。既存モード（main/repeat-ef/ef-sweep/order）のコード・挙動は変えず、新しい関数だけを足す。
// `MNEMORA_ASSOC_NONDET_MODE` を指定しなければ、これまで通り "main" モードが動く。

interface OrderScaleProbeResult {
  probeId: string;
  aRaw: boolean;
  aRawRank: number | null;
  reachedOff: boolean;
  reachedOn3: boolean;
  reachedOn5: boolean;
  reachedOn10: boolean;
}

async function measureOrderScaleProbes(
  handle: InstrumentedHandle,
  tenantId: string,
  anchorIds: ReadonlyMap<string, MemoryId>,
  goldIds: ReadonlyMap<string, MemoryId>,
): Promise<OrderScaleProbeResult[]> {
  const ctx: Ctx = { tenantId };
  const out: OrderScaleProbeResult[] = [];
  for (const probe of ASSOCIATION_PROBES) {
    const anchorId = anchorIds.get(probe.id)!;
    const goldId = goldIds.get(probe.id)!;

    handle.spy.reset();
    // association: null — 明示的な off。`association` を省略すると既定 on になり得るので、off の測定点を守る。
    const offResult = await handle.runtime.recall(ctx, { text: probe.query, association: null });
    const searchCalls = handle.spy.calls.filter((c) => c.kind === "search");
    const rawHits = searchCalls[0]?.hits ?? [];
    const aRawIdx = rawHits.findIndex((h) => h.memoryId === anchorId);
    const aRaw = aRawIdx !== -1;
    const reachedOff = offResult.memories.some(
      (m) => m.memoryId === goldId && m.retrievedVia === "association",
    );

    const on3Result = await handle.runtime.recall(ctx, {
      text: probe.query,
      association: { maxCount: 3 },
    });
    const reachedOn3 = on3Result.memories.some(
      (m) => m.memoryId === goldId && m.retrievedVia === "association",
    );

    const on5Result = await handle.runtime.recall(ctx, {
      text: probe.query,
      association: { maxCount: 5 },
    });
    const reachedOn5 = on5Result.memories.some(
      (m) => m.memoryId === goldId && m.retrievedVia === "association",
    );

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
      reachedOn5,
      reachedOn10,
    });
  }
  return out;
}

function summarizeOrderScale(label: string, probes: OrderScaleProbeResult[]): string {
  const n = probes.length;
  const aRawCount = probes.filter((p) => p.aRaw).length;
  const off = probes.filter((p) => p.reachedOff).length;
  const on3 = probes.filter((p) => p.reachedOn3).length;
  const on5 = probes.filter((p) => p.reachedOn5).length;
  const on10 = probes.filter((p) => p.reachedOn10).length;
  return (
    `  [${label}] aRaw=${aRawCount}/${n} 到達(off/on-3/on-5/on-10)=` +
    `${off}/${n} ${on3}/${n} ${on5}/${n} ${on10}/${n}`
  );
}

async function recreateHnswIndexWithParams(
  pool: PostgresClient["pool"],
  space: EmbeddingSpaceId,
  m: number,
  efConstruction: number,
): Promise<void> {
  const table = embeddingSpaceTableName(space);
  const index = embeddingSpaceIndexName(space);
  assertSafeIdentifier(table);
  assertSafeIdentifier(index);
  if (!Number.isInteger(m) || m <= 0 || !Number.isInteger(efConstruction) || efConstruction <= 0) {
    throw new Error(
      `recreateHnswIndexWithParams: m(${m})/ef_construction(${efConstruction}) が不正`,
    );
  }
  await pool.query(`DROP INDEX IF EXISTS ${index}`);
  await pool.query(`
    CREATE INDEX ${index}
      ON ${table}
      USING hnsw (embedding vector_cosine_ops)
      WITH (m = ${m}, ef_construction = ${efConstruction})
  `);
}

function parseOrderTypesEnv(name: string, fallback: IngestOrder[]): IngestOrder[] {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parts = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const valid: IngestOrder[] = [];
  for (const p of parts) {
    if (p === "base-first" || p === "base-last" || p === "base-interleaved") {
      valid.push(p);
    } else {
      throw new Error(`parseOrderTypesEnv(${name}): 不明な order 型 "${p}"`);
    }
  }
  return valid.length > 0 ? valid : fallback;
}

interface OrderScaleIterationReport {
  scale: number;
  order: IngestOrder;
  rep: number;
  hnsw: { m: number; efConstruction: number; overridden: boolean };
  ingestSeconds: number;
  drainSeconds: number;
  probes: OrderScaleProbeResult[];
  explainProduction: ExplainCapture;
  exact?: { ranks: ExactRankResult[]; probes: OrderScaleProbeResult[] };
}

async function runOrderScaleMode(
  databaseUrl: string,
  scale: number,
  cache: FileEmbeddingCache,
  jsonPath: string | undefined,
): Promise<OrderScaleIterationReport[]> {
  const tenantId = "nondet-order-scale";
  const orderTypes = parseOrderTypesEnv("MNEMORA_ASSOC_NONDET_ORDER_TYPES", [
    "base-first",
    "base-last",
    "base-interleaved",
  ]);
  const repeats = parseIntEnv("MNEMORA_ASSOC_NONDET_ORDER_REPEATS", 3);
  const exactRepeats = parseIntEnv("MNEMORA_ASSOC_NONDET_EXACT_REPEATS", 1);
  const hnswMRaw = process.env.MNEMORA_ASSOC_NONDET_HNSW_M;
  const hnswEfcRaw = process.env.MNEMORA_ASSOC_NONDET_HNSW_EF_CONSTRUCTION;
  const hnswOverride =
    hnswMRaw !== undefined && hnswEfcRaw !== undefined
      ? { m: Number(hnswMRaw), efConstruction: Number(hnswEfcRaw) }
      : undefined;

  console.log(
    `[order-scale] scale=${scale} orderTypes=${orderTypes.join(",")} repeats=${repeats} ` +
      `exactRepeats=${exactRepeats} hnswOverride=${hnswOverride ? JSON.stringify(hnswOverride) : "無(既定m=16,ef_construction=64)"}`,
  );

  const results: OrderScaleIterationReport[] = [];
  const kPrime = Math.max(1, Math.round(DEFAULT_RECALL_LIMIT * DEFAULT_OVER_FETCH_FACTOR));

  for (const order of orderTypes) {
    for (let rep = 1; rep <= repeats; rep += 1) {
      const label = `${order}-rep${rep}`;
      console.log(`\n########## order-scale ${label} (scale=${scale}) ##########`);
      const utterances = buildOrderedCorpus(scale, order);

      const handle = await createInstrumentedRuntime(databaseUrl, cache);
      await truncateAll(handle.pool);
      let hnswUsed = { m: 16, efConstruction: 64, overridden: false };
      if (hnswOverride) {
        await recreateHnswIndexWithParams(
          handle.pool,
          handle.cachingEmbeddingProvider.space,
          hnswOverride.m,
          hnswOverride.efConstruction,
        );
        hnswUsed = { ...hnswOverride, overridden: true };
      }
      const ingest = await ingestOrderedCorpus(handle, tenantId, utterances);
      console.log(
        `  ingest=${ingest.ingestSeconds.toFixed(1)}s drain=${ingest.drainSeconds.toFixed(1)}s`,
      );
      const space = handle.cachingEmbeddingProvider.space;

      const probes = await measureOrderScaleProbes(
        handle,
        tenantId,
        ingest.anchorIds,
        ingest.goldIds,
      );
      console.log(summarizeOrderScale(label, probes));

      const table = embeddingSpaceTableName(space);
      assertSafeIdentifier(table);
      const repProbe = ASSOCIATION_PROBES[0]!;
      const queryVector = await cachedVectorOrThrow(
        handle.cachingEmbeddingProvider,
        repProbe.query,
      );
      const explainProduction = await captureExplainAtProduction(
        handle.pool,
        table,
        tenantId,
        `${label}(本番ef)`,
        queryVector,
        kPrime,
        ["SET LOCAL hnsw.iterative_scan = relaxed_order"],
      );
      console.log(
        `    explain hnsw=${explainProduction.hnswUsedHeuristic} seq=${explainProduction.seqScanHeuristic}`,
      );

      let exact: { ranks: ExactRankResult[]; probes: OrderScaleProbeResult[] } | undefined;
      if (rep <= exactRepeats) {
        const exactHandle = await createInstrumentedRuntime(
          databaseUrl,
          cache,
          "-c enable_indexscan=off -c enable_bitmapscan=off",
        );
        const exactProbes = await measureOrderScaleProbes(
          exactHandle,
          tenantId,
          ingest.anchorIds,
          ingest.goldIds,
        );
        const exactRanks = await measureExactRanks(
          exactHandle.pool,
          space,
          tenantId,
          ingest.anchorIds,
          exactHandle.cachingEmbeddingProvider,
        );
        console.log(summarizeOrderScale(`${label}-EXACT`, exactProbes));
        exact = { ranks: exactRanks, probes: exactProbes };
        await exactHandle.close();
      }

      await handle.close();

      results.push({
        scale,
        order,
        rep,
        hnsw: hnswUsed,
        ingestSeconds: ingest.ingestSeconds,
        drainSeconds: ingest.drainSeconds,
        probes,
        explainProduction,
        ...(exact ? { exact } : {}),
      });

      // 逐次書き出し。長時間測定の途中でプロセスが落ちても、それまでの分は残す。
      if (jsonPath) {
        mkdirSync(dirname(jsonPath), { recursive: true });
        writeFileSync(jsonPath, `${JSON.stringify(results, null, 2)}\n`, "utf-8");
        console.log(`  [order-scale] 途中結果を書き出した(${results.length}件): ${jsonPath}`);
      }
    }
  }

  return results;
}

async function main(): Promise<void> {
  requireGatesOrThrow();

  const databaseUrl = requireDatabaseUrl();
  const databaseName = new URL(databaseUrl).pathname.replace(/^\//, "");
  const scale = parseIntEnv("MNEMORA_ASSOC_NONDET_SCALE", 10000);
  const cacheDir =
    process.env.MNEMORA_ASSOC_NONDET_EMBED_CACHE_DIR ?? "/tmp/mnemora-assoc-nondet-embcache";
  const jsonPath = process.env.MNEMORA_ASSOC_NONDET_JSON;
  const tenantId = "nondet";
  const modeEnv = process.env.MNEMORA_ASSOC_NONDET_MODE;
  const mode =
    modeEnv === "repeat-ef"
      ? "repeat-ef"
      : modeEnv === "ef-sweep"
        ? "ef-sweep"
        : modeEnv === "order"
          ? "order"
          : modeEnv === "order-scale"
            ? "order-scale"
            : "main";

  console.log(`scale=${scale} cacheDir=${cacheDir} mode=${mode}`);

  const { embeddingProvider: realEmbedding } = createProviders(process.env, {});
  if (!(realEmbedding instanceof LocalEmbeddingProvider)) {
    // requireGatesOrThrow() が文字列で既に検査しているので、ここに来るのは「local と名乗ったのに実際は違うインスタンス」という壊れのときだけ。多層防御として残す。
    throw new Error(
      "association-scale-nondeterminism: realEmbedding が LocalEmbeddingProvider ではない。",
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
      console.log(
        `\n[association-scale-nondeterminism] repeat-efモードの結果を書き出した: ${jsonPath}`,
      );
    }
    return;
  }

  if (mode === "ef-sweep") {
    const report = await runEfSweepOnlyMode(databaseUrl, databaseName, scale, cache);
    cache.close();
    if (jsonPath) {
      mkdirSync(dirname(jsonPath), { recursive: true });
      writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf-8");
      console.log(
        `\n[association-scale-nondeterminism] ef-sweepモードの結果を書き出した: ${jsonPath}`,
      );
    }
    return;
  }

  if (mode === "order") {
    const report = await runOrderExperimentMode(databaseUrl, databaseName, scale, cache);
    cache.close();
    if (jsonPath) {
      mkdirSync(dirname(jsonPath), { recursive: true });
      writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf-8");
      console.log(
        `\n[association-scale-nondeterminism] orderモードの結果を書き出した: ${jsonPath}`,
      );
    }
    return;
  }

  if (mode === "order-scale") {
    const results = await runOrderScaleMode(databaseUrl, scale, cache, jsonPath);
    cache.close();
    console.log(
      `\n[association-scale-nondeterminism] order-scaleモード完了: ${results.length}件` +
        (jsonPath ? ` (${jsonPath})` : ""),
    );
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

    const handle = await createInstrumentedRuntime(databaseUrl, cache);
    await truncateAll(handle.pool);
    const ingest = await ingestCorpus(handle, tenantId, corpus);
    console.log(
      `  ingest=${ingest.ingestSeconds.toFixed(1)}s drain=${ingest.drainSeconds.toFixed(1)}s`,
    );
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
    console.log(
      `    explain(query) hnsw=${m0.explainQuery.hnswUsedHeuristic} seq=${m0.explainQuery.seqScanHeuristic} ` +
        `explain(anchor) hnsw=${m0.explainAnchor.hnswUsedHeuristic} seq=${m0.explainAnchor.seqScanHeuristic} ` +
        `ef_search=${m0.efSearch}`,
    );
    await handle.close();

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
      console.log(
        `  [I1限定] max_parallel_workers_per_gather=0 有無での差分: ${diffCount}/12 probe`,
      );
    }
    await exactHandle.close();

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
