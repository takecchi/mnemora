#!/usr/bin/env node
/**
 * `association-scale-bench.ts` の段2（Issue #337）中に見つかった逆転
 * ——1万行スケールで **on-3 だけ 4/12 届き、on-5/on-10 は 0/12**——を切り分ける、
 * 使い捨ての診断スクリプト（`pnpm --filter @mnemora/example-chat exec tsx
 * src/bench/association-scale-investigate.ts`）。
 *
 * ⛔ **別データベースで走らせること。** `association-scale-bench.ts` の配置(A)が
 * 使っている DB（`TRUNCATE` を挟む）を壊さないため、`DATABASE_URL` は
 * `mnemora_investigate`（本スクリプト用に別途 `createdb` したもの）を指す。
 *
 * ## 何を見るか
 *
 * `recall-runtime.ts`(現物)を読むと、連想枠の最終選抜は次の形をしている
 * （`packages/core` は変更していない——読んで確かめただけ）:
 *
 * 1. 各アンカー(既定 anchorCount=3、`maxCount` に依らず同じ3件)ごとに
 *    `vectorStore.search(limit: kPrime=40)` で生の近傍を集める→`associationHits`
 *    （重複除去・`minSimilarity` で足切り、アンカー類似度降順）。
 * 2. `rankFetchCount = max(maxCount, round(maxCount × overFetchFactor(4)))`
 *    ——`maxCount=3→12, 5→20, 10→40`。**`associationHits` の先頭 `rankFetchCount` 件**
 *    だけを `rankedCandidates` の母集合にする(Issue #402)。
 * 3. `rankKey = similarity(アンカーとの近さ) × score.total(decay×tagMatch×freshness×strength)`
 *    で並べ替え、先頭 `maxCount` 件だけを実際の連想枠にする。
 *
 * ⟹ **`associationHits` 自体は `maxCount` に依らず同じ**(同じ3アンカー・同じ検索)。
 * `maxCount` が動かすのは (a) 母集合を先頭何件まで広げるか(`rankFetchCount`)、
 * (b) 実際に席に着ける件数、の2つだけ。**母集合が広がるほど、フィラー
 * （`buildDistinctFiller` のテンプレ生成、1万行なら9938件、corpus の99.6%）が
 * 混入する機会が増える**——これが「maxCount を増やすと届かなくなる」の
 * 仮説である。**本スクリプトはこれを実測で確かめる**(推測のままにしない)。
 *
 * ## 何を出すか(per-probe)
 *
 * - `result.memories` のうち `retrievedVia === "association"` の並び(=実際に
 *   席へ着いた連想枠)を、externalId を解決した上で役割分類
 *   (`own-gold`/`own-anchor`/`own-distractor`/`other-probe`/`haystack`/`filler`/`unknown`)
 *   して出す。gold が席に着いていれば、そのgoldの `associationOf`(=どのアンカー
 *   経由か)を externalId で示す——probe自身のアンカーか、別 probe のアンカーか
 *   （後者なら「anchor自体は正しいがgoldが違うprobeの連想として出た」という
 *   別の壊れ方になる）。
 * - `result.omitted` のうち `kind==="over_limit", stage==="association"` の `count`
 *   ——`maxCount` が増えるにつれてどう動くか(母集合が広がれば増えるはず)。
 * - `dActualAnchor`(既存の spy 技法)——3アンカーが `maxCount` に依らず同一かを
 *   確認する(理論通りなら on-3/on-5/on-10 で完全一致するはず)。
 *
 * ⛔ **これも測定であり判定ではない。** 見つかったことをそのまま出す。
 */
import type {
  Ctx,
  MemoryId,
  RecallAssociationQuery,
  RecalledMemory,
  Runtime,
  VectorHit,
  VectorStore,
} from "@mnemora/core";
import { createRuntime } from "@mnemora/core";
import { LocalEmbeddingProvider } from "@mnemora/local-embedding";
import type { PostgresClient } from "@mnemora/postgres";
import {
  PostgresEventStore,
  PostgresLexicalStore,
  PostgresMemoryStore,
  PostgresOutboxStore,
  PostgresTenantSettingsStore,
  PostgresVectorStore,
  closePostgresClient,
  createPostgresClient,
  registerEmbeddingSpace,
  runMigrations,
  sha256Hex,
} from "@mnemora/postgres";
import {
  ASSOCIATION_HAYSTACK_SIZE,
  ASSOCIATION_PROBES,
  associationAnchorExternalId,
  associationDistractorExternalId,
  associationGoldExternalId,
  buildAssociationProbeSetConversation,
} from "../association-probe-set.js";
import { drainEmbedTicks } from "../embed-drain.js";
import { warmupLocalEmbedding } from "../local-embedding-warmup.js";
import { createProviders } from "../providers.js";
import { resolveExternalId } from "../provenance-trace.js";
import { CachingEmbeddingProvider, FileEmbeddingCache } from "./embedding-cache.js";

function requireDatabaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL が無い");
  return url;
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

interface VectorStoreSpy {
  getVectorsCalls: MemoryId[][];
  reset(): void;
}

function wrapVectorStoreWithSpy(inner: VectorStore, spy: VectorStoreSpy): VectorStore {
  return {
    upsert: (ctx, space, memoryId, vector) => inner.upsert(ctx, space, memoryId, vector),
    delete: (ctx, space, memoryId) => inner.delete(ctx, space, memoryId),
    search: (ctx, space, query, opts) => inner.search(ctx, space, query, opts),
    getVectors: async (ctx, space, memoryIds) => {
      spy.getVectorsCalls.push([...memoryIds]);
      return inner.getVectors!(ctx, space, memoryIds);
    },
  };
}

interface Handle {
  runtime: Runtime;
  memoryStore: PostgresMemoryStore;
  spy: VectorStoreSpy;
  pool: PostgresClient["pool"];
  close(): Promise<void>;
}

async function createHandle(databaseUrl: string, cache: FileEmbeddingCache): Promise<Handle> {
  const client = createPostgresClient(databaseUrl);
  await runMigrations(client.pool);
  const { embeddingProvider: realEmbedding, llmProvider, llmMode } = createProviders(process.env, {});
  if (llmMode !== "deterministic") {
    throw new Error(`association-scale-investigate: MNEMORA_LLM=deterministic を明示すること(実測: "${llmMode}")`);
  }
  if (!(realEmbedding instanceof LocalEmbeddingProvider)) {
    throw new Error("association-scale-investigate: MNEMORA_EMBEDDING=local を指定すること");
  }
  const cachingEmbeddingProvider = new CachingEmbeddingProvider(realEmbedding, cache);
  await registerEmbeddingSpace(client.pool, cachingEmbeddingProvider.space);

  const spy: VectorStoreSpy = {
    getVectorsCalls: [],
    reset() {
      this.getVectorsCalls = [];
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
    close: () => closePostgresClient(client),
  };
}

async function truncateAll(pool: PostgresClient["pool"]): Promise<void> {
  await pool.query(`
    TRUNCATE TABLE
      memories, memory_embeddings_local_ruri_v3_30m_sym_256, memory_events,
      observations, outbox, recall_usages, recalls, tenant_activity, tenant_settings
    RESTART IDENTITY CASCADE
  `);
}

type Role =
  | "own-gold"
  | "own-anchor"
  | "own-distractor"
  | "other-probe"
  | "haystack"
  | "filler"
  | "unknown";

function classifyRole(
  currentProbeId: string,
  externalId: string,
  haystackExternalIds: ReadonlySet<string>,
): Role {
  if (externalId === associationGoldExternalId(currentProbeId)) return "own-gold";
  if (externalId === associationAnchorExternalId(currentProbeId)) return "own-anchor";
  if (externalId === associationDistractorExternalId(currentProbeId)) return "own-distractor";
  for (const probe of ASSOCIATION_PROBES) {
    if (probe.id === currentProbeId) continue;
    if (
      externalId === associationGoldExternalId(probe.id) ||
      externalId === associationAnchorExternalId(probe.id) ||
      externalId === associationDistractorExternalId(probe.id)
    ) {
      return "other-probe";
    }
  }
  if (haystackExternalIds.has(externalId)) return "haystack";
  if (externalId.startsWith("scale-assoc-filler-")) return "filler";
  return "unknown";
}

const PROBE_QUERY_BY_ID = new Map(ASSOCIATION_PROBES.map((p) => [p.id, p.query]));

async function main(): Promise<void> {
  const databaseUrl = requireDatabaseUrl();
  const scale = Number(process.env.MNEMORA_ASSOC_INVESTIGATE_SCALE ?? 10000);
  const cacheDir = process.env.MNEMORA_ASSOC_SCALE_EMBED_CACHE_DIR ?? "/tmp/mnemora-assoc-scale-embcache";
  const armsToRun = [3, 5, 10];

  const { embeddingProvider: realEmbedding, llmMode } = createProviders(process.env, {});
  if (llmMode !== "deterministic") {
    throw new Error(`MNEMORA_LLM=deterministic を明示すること(実測: "${llmMode}")`);
  }
  const warmup = await warmupLocalEmbedding(realEmbedding);
  if (!warmup.ok) {
    console.error(warmup.detail);
    process.exitCode = 1;
    return;
  }
  console.log(warmup.detail);
  const cache = new FileEmbeddingCache(cacheDir, realEmbedding.space);

  const base = buildAssociationProbeSetConversation();
  const filler = buildDistinctFiller(scale - ASSOCIATION_HAYSTACK_SIZE);
  const haystackExternalIds = new Set(
    base.filter((u) => u.kind === "haystack").map((u) => u.externalId),
  );

  console.log(`\n=== investigate: scale=${scale} DATABASE_URL=${databaseUrl} ===`);

  const tenantId = "investigate";
  const handle = await createHandle(databaseUrl, cache);
  await truncateAll(handle.pool);

  const ctx: Ctx = { tenantId };
  const anchorIds = new Map<string, MemoryId>();
  const goldIds = new Map<string, MemoryId>();
  let expectedEmbedJobs = 0;

  const tIngest0 = Date.now();
  for (const u of base) {
    const r = await handle.runtime.observe(ctx, { kind: "utterance", text: u.text, externalId: u.externalId });
    expectedEmbedJobs += r.memoryIds.length;
    if (u.kind === "anchor" || u.kind === "gold") {
      if (r.memoryIds.length !== 1) throw new Error(`${u.externalId}: sync抽出が1件を作らなかった`);
      if (u.kind === "anchor") anchorIds.set(u.probeId!, r.memoryIds[0]!);
      else goldIds.set(u.probeId!, r.memoryIds[0]!);
    }
  }
  for (const f of filler) {
    const r = await handle.runtime.observe(ctx, { kind: "utterance", text: f.text, externalId: f.externalId });
    expectedEmbedJobs += r.memoryIds.length;
  }
  const ingestSeconds = (Date.now() - tIngest0) / 1000;
  const tDrain0 = Date.now();
  await drainEmbedTicks(handle.runtime, ctx, { expectedProcessed: expectedEmbedJobs });
  const drainSeconds = (Date.now() - tDrain0) / 1000;
  await handle.pool.query("ANALYZE");
  console.log(`ingest=${ingestSeconds.toFixed(1)}s drain=${drainSeconds.toFixed(1)}s`);

  interface ProbeArmDetail {
    probeId: string;
    goldReturned: boolean;
    goldRank: number | null;
    frame: { externalId: string; role: Role; rank: number; anchorExternalId: string | null }[];
    overLimitAssociationCount: number | null;
    actualAnchorExternalIds: string[];
  }

  const byArm = new Map<number, ProbeArmDetail[]>();

  for (const maxCount of armsToRun) {
    const details: ProbeArmDetail[] = [];
    for (const probe of ASSOCIATION_PROBES) {
      const goldId = goldIds.get(probe.id)!;
      handle.spy.reset();
      const association: RecallAssociationQuery = { maxCount };
      const result = await handle.runtime.recall(ctx, { text: probe.query, association });

      const resolvedExternalIds = await Promise.all(
        result.memories.map((m) => resolveExternalId(handle.memoryStore, ctx, m.memoryId)),
      );
      const goldIndex = result.memories.findIndex((m) => m.memoryId === goldId);
      const goldRank = goldIndex === -1 ? null : goldIndex + 1;

      const frame: ProbeArmDetail["frame"] = [];
      for (let i = 0; i < result.memories.length; i += 1) {
        const m: RecalledMemory = result.memories[i]!;
        if (m.retrievedVia !== "association") continue;
        const externalId = resolvedExternalIds[i] ?? m.memoryId;
        let anchorExternalId: string | null = null;
        if (m.associationOf !== undefined) {
          const resolved = await resolveExternalId(handle.memoryStore, ctx, m.associationOf);
          anchorExternalId = resolved ?? m.associationOf;
        }
        frame.push({
          externalId,
          role: classifyRole(probe.id, externalId, haystackExternalIds),
          rank: i + 1,
          anchorExternalId,
        });
      }

      const overLimitEntry = result.omitted.find(
        (o) => o.kind === "over_limit" && o.stage === "association",
      );
      const overLimitAssociationCount =
        overLimitEntry && overLimitEntry.kind === "over_limit" ? overLimitEntry.count : null;

      const actualAnchorMemoryIds = handle.spy.getVectorsCalls[0] ?? [];
      const actualAnchorExternalIds = await Promise.all(
        actualAnchorMemoryIds.map(async (id) => (await resolveExternalId(handle.memoryStore, ctx, id)) ?? id),
      );

      details.push({
        probeId: probe.id,
        goldReturned: goldRank !== null,
        goldRank,
        frame,
        overLimitAssociationCount,
        actualAnchorExternalIds,
      });
    }
    byArm.set(maxCount, details);
  }

  await handle.close();

  console.log("\n=== per-probe detail ===");
  for (const probe of ASSOCIATION_PROBES) {
    console.log(`\n--- probe=${probe.id} (own-anchor=${associationAnchorExternalId(probe.id)}, own-gold=${associationGoldExternalId(probe.id)}) ---`);
    for (const maxCount of armsToRun) {
      const d = byArm.get(maxCount)!.find((x) => x.probeId === probe.id)!;
      console.log(
        `  maxCount=${maxCount}: goldReturned=${d.goldReturned} goldRank=${d.goldRank} ` +
          `overLimit(association).count=${d.overLimitAssociationCount} ` +
          `actualAnchors=${JSON.stringify(d.actualAnchorExternalIds)}`,
      );
      for (const f of d.frame) {
        console.log(
          `    frame[${f.rank}] ${f.externalId} role=${f.role} anchor=${f.anchorExternalId}`,
        );
      }
    }
  }

  console.log("\n=== summary: gold到達の推移(maxCount順) ===");
  for (const probe of ASSOCIATION_PROBES) {
    const row = armsToRun.map((mc) => byArm.get(mc)!.find((x) => x.probeId === probe.id)!.goldReturned);
    console.log(`${probe.id}: on-3=${row[0]} on-5=${row[1]} on-10=${row[2]}`);
  }

  console.log("\n=== summary: over_limit(association).count の推移(maxCount順、全12probe平均) ===");
  for (const maxCount of armsToRun) {
    const details = byArm.get(maxCount)!;
    const counts = details.map((d) => d.overLimitAssociationCount ?? 0);
    const avg = counts.reduce((a, b) => a + b, 0) / counts.length;
    console.log(`maxCount=${maxCount}: avg over_limit(association).count=${avg.toFixed(2)}`);
  }

  console.log("\n=== summary: frame内のrole分布(全12probe合計、maxCount別) ===");
  for (const maxCount of armsToRun) {
    const details = byArm.get(maxCount)!;
    const roleCounts: Record<string, number> = {};
    for (const d of details) {
      for (const f of d.frame) {
        roleCounts[f.role] = (roleCounts[f.role] ?? 0) + 1;
      }
    }
    console.log(`maxCount=${maxCount}: ${JSON.stringify(roleCounts)}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
