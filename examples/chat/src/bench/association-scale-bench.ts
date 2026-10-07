#!/usr/bin/env node
/**
 * `association-scale` ベンチ。連想枠を10万行級で測る道具で、測ったことの全体像は ADR 0332 が記録する。
 * 測定であり判定ではない。exit code は結果で変えない。
 *
 * (A) は arm ごとに独立 ingest するので、`maxCount` の純粋比較にならない（`memory_id`・`recorded_at` が arm ごとに違い、
 * 同点の tie-break や HNSW 構築の非決定性が混ざりうる）。(R) は単一 ingest に4 arm を当てるので純粋比較になる。
 *
 * 段ごとの anchor 位置は (a) raw と (c) actual の2段だけ。(b) passed は公開 API から正確に取り出せず、測っていない。
 *
 * `MNEMORA_LLM=deterministic` と `MNEMORA_EMBEDDING=local` は両方省略できない。`OPENAI_API_KEY` が環境に在ると、
 * 省略した場合に抽出や `embed()` が黙って実 OpenAI API を叩き、課金される。`main()` の最初の `requireGatesOrThrow()` が
 * provider を構築する前に文字列だけで検査して落とす。
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
import { stage3_5DbMs, type VectorStoreSpy, wrapVectorStoreWithSpy } from "./vector-store-spy.js";
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
      `association-scale-bench: MNEMORA_LLM=deterministic を明示すること` +
        `(実測: "${llmMode}")。この器は OPENAI_API_KEY が既に設定されており、` +
        "明示しないと黙って実 OpenAI API へ倒れる。",
    );
  }
  const embeddingMode = selectEmbeddingMode(process.env);
  if (embeddingMode !== "local") {
    throw new Error(
      `association-scale-bench: MNEMORA_EMBEDDING=local を明示すること` +
        `(実測: "${embeddingMode}")。` +
        "省くと precomputeEmbeddingCache が実 OpenAI API を叩く（ADR 0332 追記 A.8）。",
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
): Promise<InstrumentedHandle> {
  const client = createPostgresClient(databaseUrl);
  // `createExampleRuntime` と同じ穴。`client` を作った後、`close()` を持つ handle を返す前に失敗しうる処理が続く。
  // ここで reject すると呼び出し側は handle を受け取れず `close()` できないため、ここで閉じる。
  try {
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

/** `ALTER DATABASE ... SET hnsw.ef_search` は次に張る接続からしか効かないので、変更後は必ず新しい `Pool` を張り直す。 */
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

interface CorpusTexts {
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

function parseVectorLiteral(literal: string): number[] {
  return literal.slice(1, -1).split(",").map(Number);
}

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
 * 本番の `PostgresVectorStore.search()` は `SET LOCAL hnsw.iterative_scan = relaxed_order` をトランザクション内で有効にする。
 * これを見ずに撃つと `recall()` とは別のプランを見てしまう。`SET LOCAL` はトランザクション単位なので、
 * `pool.connect()` で1本の client を握り、同じ接続で `BEGIN`→`SET LOCAL`→`EXPLAIN`→`COMMIT` を行う。
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
    // ヒューリスティック（文字列一致）。判定ではなく手掛かり。最終判断は report に載せる生の EXPLAIN テキストで人が確かめること。
    const hnswUsedHeuristic =
      /Index (Scan|Only Scan).*hnsw/i.test(text) || /idx_memory_embeddings_hnsw/i.test(text);
    return { label, limit, text, hnswUsedHeuristic };
  } finally {
    client.release();
  }
}

interface ArmConfig {
  label: string;
  /** `null` は明示的な off。`undefined`（省略）にしない。`packages/core` の連想枠は既定 on なので、キーを渡さないと off arm が既定に乗っ取られる。 */
  association: RecallAssociationQuery | null;
}

function buildArms(): ArmConfig[] {
  return [
    { label: "off", association: null },
    { label: "on-3", association: { maxCount: 3 } },
    { label: "on-5", association: { maxCount: 5 } },
    { label: "on-10", association: { maxCount: 10 } },
  ];
}

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
  aRawAnchor: boolean;
  cWithinLimitAnchor: boolean;
  dActualAnchor: boolean | null;
  goldRank: number | null;
  goldReturned: boolean;
  goldRetrievedVia: "ann" | "lexical" | "mandatory_companion" | "association" | null;
  memoryChars: number;
  latencyMedianMs: number;
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
      association: arm.association,
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
    arm.association === null ? null : (getVectorsCalls[0]?.memoryIds ?? []).includes(anchorId);

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
  const vectors = await handle.cachingEmbeddingProvider.embed({ tenantId: "explain-probe" }, [
    text,
  ]);
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
  const allTexts = [...corpus.base.map((u) => u.text), ...corpus.filler.map((f) => f.text)];
  console.log(
    `\n=== scale=${scale}: 埋め込みキャッシュを埋める(${allTexts.length}件、重複除去後) ===`,
  );
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
  const precompute = await precomputeEmbeddingCache(
    realEmbeddingForPrecompute,
    cache,
    allTexts,
    {},
  );

  const arms = buildArms();
  const armReports: ArmScaleReport[] = [];
  const bitHashByArm: Record<string, string> = {};

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

async function runModeR(
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
  const precompute = await precomputeEmbeddingCache(realEmbeddingForPrecompute, cache, allTexts, {
    batchSize: parseIntEnv("MNEMORA_ASSOC_SCALE_EMBED_BATCH", 64),
    concurrency: parseIntEnv("MNEMORA_ASSOC_SCALE_EMBED_CONCURRENCY", 1),
  });

  const tenantId = "scale-assoc";
  const handle = await createInstrumentedRuntime(databaseUrl, cache);
  await truncateAll(handle.pool);
  const ingest = await ingestCorpus(handle, tenantId, corpus);
  const { hash, rowCount } = await hashArmEmbeddings(
    handle.pool,
    handle.cachingEmbeddingProvider.space,
    ingest.memoryIdByExternalId,
  );
  await handle.close();

  const arms = buildArms();
  const armReports: ArmScaleReport[] = [];
  for (const arm of arms) {
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

  const bitHashByArm: Record<string, string> = {};
  for (const arm of arms) bitHashByArm[arm.label] = hash;

  return {
    scale,
    precompute,
    arms: armReports,
    bitIdentity: { byArm: bitHashByArm, allSame: true },
  };
}

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
    lines.push(
      "| arm | goldReturned | memoryCharsTotal | ΔmemoryChars% | latency中央値ms | Δlatencyms | 段3.5DBms |",
    );
    lines.push("|---|---|---|---|---|---|---|");
    const offEf = offArm?.efReports[efIndex];
    const offMemoryChars = offEf ? offEf.probes.reduce((s, p) => s + p.memoryChars, 0) : 0;
    const offLatency = offEf ? median(offEf.probes.map((p) => p.latencyMedianMs)) : 0;
    for (const arm of report.arms) {
      const efReport = arm.efReports[efIndex]!;
      const goldCount = efReport.probes.filter((p) => p.goldReturned).length;
      const memoryChars = efReport.probes.reduce((s, p) => s + p.memoryChars, 0);
      const deltaPct =
        offMemoryChars > 0
          ? (((memoryChars - offMemoryChars) / offMemoryChars) * 100).toFixed(2)
          : "n/a";
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
      lines.push(
        `(a)raw=${aCount}/${ASSOCIATION_PROBES.length} (c)withinLimit相当=${cCount}/${ASSOCIATION_PROBES.length}`,
      );
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
  requireGatesOrThrow();

  const databaseUrl = requireDatabaseUrl();
  const databaseName = new URL(databaseUrl).pathname.replace(/^\//, "");
  const scales = parseIntListEnv("MNEMORA_ASSOC_SCALE_SCALES", [62, 10000]);
  const efLevels = parseIntListEnv("MNEMORA_ASSOC_SCALE_EF_SEARCH", [40, 120]);
  const repeat = parseIntEnv("MNEMORA_ASSOC_SCALE_LATENCY_REPEAT", 5);
  const cacheDir =
    process.env.MNEMORA_ASSOC_SCALE_EMBED_CACHE_DIR ?? "/tmp/mnemora-assoc-scale-embcache";
  const modeEnv = process.env.MNEMORA_ASSOC_SCALE_MODE;
  const mode = modeEnv === "B" ? "B" : modeEnv === "R" ? "R" : "A";

  console.log(
    `scales=${scales.join(",")} efLevels=${efLevels.join(",")} repeat=${repeat} mode=${mode}`,
  );
  console.log(`cacheDir=${cacheDir}`);

  const { embeddingProvider: realEmbedding } = createProviders(process.env, {});
  if (!(realEmbedding instanceof LocalEmbeddingProvider)) {
    throw new Error("association-scale-bench: realEmbedding が LocalEmbeddingProvider ではない。");
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
        : mode === "R"
          ? await runModeR(databaseUrl, databaseName, scale, efLevels, repeat, cache, realEmbedding)
          : await runScale(
              databaseUrl,
              databaseName,
              scale,
              efLevels,
              repeat,
              cache,
              realEmbedding,
            );
    allReports.push(report);
    console.log(summarizeScale(report));
  }

  cache.close();

  const cleanupHandle = await createInstrumentedRuntime(
    databaseUrl,
    new FileEmbeddingCache(cacheDir, realEmbedding.space),
  );
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
