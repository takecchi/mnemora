#!/usr/bin/env node
/**
 * `association-anchor-pool-scale` ベンチ
 * （`pnpm --filter @mnemora/example-chat run association-anchor-pool-scale-bench`）。
 *
 * ## これは何を測るか
 *
 * [Issue #377](https://github.com/takecchi/mnemora/issues/377) / [ADR 0308](../../../docs/decisions/0308-association-anchor-pool.md)
 * が足した `RecallAssociationQuery.anchorPool` が、テナントの規模（filler 件数）が
 * 伸びるにつれて実際に何を取り戻すか・取り戻さないかを、本物の Postgres + pgvector +
 * `@mnemora/local-embedding` に対して測る。
 *
 * ⛔ **これは測定であり、判定ではない。** どの数字が出ても exit code は変えない
 * （`lexical-tie-density-bench.ts`／`packages/postgres/src/bench/scale-bench.ts` と同じ規律）。
 *
 * ## なぜ gold 到達だけでなく段ごとの内訳を数えるか
 *
 * gold 到達（`goldReturned`）は、連想枠のパイプライン全体（アンカー選定 → アンカー近傍探索
 * → 再結合）が繋がって初めて 1 になる合成指標であり、「どの段で取りこぼしたか」を
 * 区別しない。ADR 0308「引き受けた負債」1番が明記する通り、`anchorPool: 'passed'` は
 * 「そもそも `passed` に入っていない probe」を救わない——⟹ **probe 自身の anchor** が
 * パイプラインのどの段まで生き残ったかを、段ごとに数える:
 *
 * - **(a) raw** — 段1の ANN が返した `kPrime` 件の生の近傍（`VectorStore.search` の
 *   戻り値そのもの）に、probe 自身の anchor が入っているか。
 * - **(b) passed** — 段2の閾値分割を通った全候補（`limit` で切る前）に入っているか。
 * - **(c) withinLimit** — さらに `limit` の内側（既定10件）に入っているか。
 * - **(d) actual anchor** — その arm の実際の設定（`anchorCount`/`anchorPool`）の下で、
 *   本当にアンカーとして選ばれたか（`VectorStore.getVectors` に実際に渡ったか）。
 *
 * (a) ⊇ (b) ⊇ (c) は常に成り立つ（`recall-runtime.ts` の実装がそう作っている）。
 * (d) は arm ごとの `anchorCount`/`anchorPool` 次第で (c) か (b) のどちらかの先頭
 * `anchorCount` 件に一致する。
 *
 * ## どう測るか — `packages/core`/`packages/postgres` は1行も変えずに測る
 *
 * (a) は `VectorStore.search` を spy で包み、段1の呼び出し（`association` を渡さない
 * `recall()` 呼び出しで発生する唯一の `search` 呼び出し）が返した `VectorHit[]` を
 * そのまま見る。
 *
 * (b)/(c)/(d) はどれも「`recall()` が実際に `VectorStore.getVectors` へ渡した
 * memoryId」を spy で数える——[ADR 0188](../../../docs/decisions/0188-association-over-limit-omission.md)
 * 等が前提にしている実測どおり、`packages/core` が `getVectors` を呼ぶのは段3.5
 * （連想）のこの1箇所だけである（`packages/core/src/__tests__/runtime-fakes.ts` の
 * `withGetVectorsSpy` の doc コメントと同じ事実、擬似実装ではなく本物の Postgres に
 * 対して確かめる）。
 *
 * - (c) は `anchorPool: 'withinLimit'`（既定）・`anchorCount` を `kPrime` の上限
 *   （既定 `limit(10) × overFetchFactor(4) = 40`）より大きい値にした呼び出しで
 *   `getVectors` に渡った memoryId 集合——`withinLimit` 全体と一致する
 *   （`anchorCount` が天井にならないほど大きいため）。
 * - (b) は `anchorPool: 'passed'`・同じ大きな `anchorCount` にした呼び出しで
 *   `getVectors` に渡った memoryId 集合——`passed` 全体と一致する。
 * - (d) は各 arm が実際に使う `anchorCount`/`anchorPool`（`limit` を上げる場合は
 *   `limit` も）そのままの呼び出しで `getVectors` に渡った memoryId 集合。
 *
 * ⟹ **`packages/core`/`packages/postgres` のプロダクションコードは一切変更していない**
 * ——spy はこのベンチファイルの中だけに閉じた `VectorStore` の薄いラッパーである
 * （`runtime-fakes.ts` の `withGetVectorsSpy` と同じ形を、本物の adapter に対して行う）。
 *
 * ## probe の anchor/gold/distractor の memoryId をどう特定するか
 *
 * `runtime.observe()` は sync 抽出（既定）のとき `ObserveResult.memoryIds` に
 * 実際に作られた Memory の id を返す（`packages/core/src/runtime.ts` の doc）。
 * ⟹ ingest 時にこの戻り値をそのまま記録する——`digest` の文字列比較は一切しない
 * （旧 `tmp-scale-bench-377.ts` はこれをしていた。digest が `MNEMORA_LLM=deterministic`
 * の下でも入力テキストと1バイトも違わない保証は無く、脆い。本ベンチはこの脆さを持たない）。
 *
 * ## `hnsw.ef_search` をどう振るか
 *
 * `ALTER DATABASE ... SET hnsw.ef_search = N` でデータベース既定値を変え、**その後に
 * 新しい接続プールを張り直す**（`ALTER DATABASE ... SET` は次に張る接続のセッション
 * 既定値を変えるだけで、既存の接続には効かない——`postgres` のドキュメント通りの挙動。
 * 使い回すと古い ef_search のまま測ってしまう）。ingest はスケールごとに1回だけ行い
 * （embedding を作り直すコストが支配的なため）、`ef_search` はその後の *測定* 側だけを
 * 振り直す——索引の構築自体は `ef_search` に依存しない。
 *
 * ## 実行方法
 *
 * ```
 * DATABASE_URL=postgresql://worker@127.0.0.1:55437/mnemora_test \
 * MNEMORA_EMBEDDING=local \
 * MNEMORA_ANCHOR_POOL_SCALES=62,1000,3000,10000 \
 * MNEMORA_ANCHOR_POOL_EF_SEARCH=40,120 \
 * pnpm --filter @mnemora/example-chat run association-anchor-pool-scale-bench
 * ```
 *
 * 既定値は上と同じ4スケール×2 ef_search。`MNEMORA_ANCHOR_POOL_JSON` を指定すると
 * 機械可読な結果も書き出す。
 *
 * ## 確かめていないこと
 *
 * - 62件（`ASSOCIATION_HAYSTACK`）以外の小規模点（例: 500件）は測っていない——
 *   4点で十分に傾向が見えたため増やさなかった。
 * - `hnsw.m`/`hnsw.ef_construction`（索引構築側のパラメータ）は既定のまま振っていない
 *   ——このベンチが振るのは検索側の `ef_search` だけである。
 * - 複数テナントが同じ物理テーブルを共有する状況（本番でありうる）は再現していない
 *   ——スケールごとに `TRUNCATE` して単一テナントだけを積む。
 */
import { writeFileSync } from "node:fs";
import type {
  Ctx,
  EmbeddingProvider,
  MemoryId,
  RecallAssociationQuery,
  Runtime,
  VectorHit,
  VectorStore,
} from "@mnemora/core";
import {
  DEFAULT_ASSOCIATION_ANCHOR_COUNT,
  DEFAULT_OVER_FETCH_FACTOR,
  DEFAULT_RECALL_LIMIT,
  createRuntime,
} from "@mnemora/core";
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
  buildAssociationProbeSetConversation,
} from "../association-probe-set.js";
import { drainEmbedTicks } from "../embed-drain.js";
import { warmupLocalEmbedding } from "../local-embedding-warmup.js";
import { createProviders } from "../providers.js";

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

/**
 * 構成上ゼロ重複の filler（`tmp-scale-bench-377.ts` から引き継いだ生成規則。
 * 語彙はプローブの anchor/gold/distractor/query と重ならないよう内容語を避けている）。
 */
function buildDistinctFiller(count: number): { externalId: string; text: string }[] {
  const out: { externalId: string; text: string }[] = [];
  for (let i = 0; i < count; i += 1) {
    out.push({
      externalId: `scale-377-filler-${i}`,
      text: `log entry ${i}: node-${i % 997} reported status code ${i % 53} at tick ${i * 7 + 3}, batch ${Math.floor(i / 31)}, checksum ${(i * 2654435761) >>> 0}`,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// VectorStore spy — packages/core/postgres は変更しない。このファイルの中だけで包む。
// ---------------------------------------------------------------------------

interface VectorStoreSpy {
  /** 直近の `recall()` 呼び出し中に発生した `search()` の呼び出し一覧（呼ぶたびに reset）。 */
  searchCalls: { limit: number; hits: VectorHit[] }[];
  /** 直近の `recall()` 呼び出し中に発生した `getVectors()` の呼び出し一覧。 */
  getVectorsCalls: MemoryId[][];
  reset(): void;
}

function wrapVectorStoreWithSpy(inner: VectorStore, spy: VectorStoreSpy): VectorStore {
  return {
    upsert: (ctx, space, memoryId, vector) => inner.upsert(ctx, space, memoryId, vector),
    delete: (ctx, space, memoryId) => inner.delete(ctx, space, memoryId),
    search: async (ctx, space, query, opts) => {
      const hits = await inner.search(ctx, space, query, opts);
      spy.searchCalls.push({ limit: opts.limit, hits });
      return hits;
    },
    getVectors: async (ctx, space, memoryIds) => {
      spy.getVectorsCalls.push([...memoryIds]);
      return inner.getVectors!(ctx, space, memoryIds);
    },
  };
}

interface InstrumentedHandle {
  runtime: Runtime;
  spy: VectorStoreSpy;
  pool: PostgresClient["pool"];
  embeddingProvider: EmbeddingProvider;
  close(): Promise<void>;
}

/**
 * `runtime-factory.ts` の `createExampleRuntime` と同じ配線を、`VectorStore` だけ
 * spy で包んで行う（`createExampleRuntime` 自体は変更しない——このベンチ専用の
 * 配線をここに複製する）。
 */
async function createInstrumentedRuntime(databaseUrl: string): Promise<InstrumentedHandle> {
  const client = createPostgresClient(databaseUrl);
  await runMigrations(client.pool);

  const { llmProvider, embeddingProvider } = createProviders(process.env, {});
  await registerEmbeddingSpace(client.pool, embeddingProvider.space);

  const spy: VectorStoreSpy = {
    searchCalls: [],
    getVectorsCalls: [],
    reset() {
      this.searchCalls = [];
      this.getVectorsCalls = [];
    },
  };
  const vectorStore = wrapVectorStoreWithSpy(new PostgresVectorStore(client.db), spy);

  const runtime = createRuntime({
    memoryStore: new PostgresMemoryStore(client.db),
    outboxStore: new PostgresOutboxStore(client.db),
    vectorStore,
    lexicalStore: new PostgresLexicalStore(client.db),
    eventStore: new PostgresEventStore(client.db),
    tenantSettingsStore: new PostgresTenantSettingsStore(client.db),
    llmProvider,
    embeddingProvider,
    hashContent: sha256Hex,
  });

  return {
    runtime,
    spy,
    pool: client.pool,
    embeddingProvider,
    close: () => closePostgresClient(client),
  };
}

// ---------------------------------------------------------------------------
// 段ごとの内訳
// ---------------------------------------------------------------------------

interface ArmConfig {
  label: string;
  limit?: number;
  association?: RecallAssociationQuery;
}

/** `passed`/`withinLimit` 全体を確実に覆う大きさ（kPrime の既定上限40より十分大きい）。 */
const PROBE_ANCHOR_COUNT = 200;

function buildArms(): ArmConfig[] {
  return [
    { label: "off", association: undefined },
    {
      label: "on-default（maxCount=10, anchorCount既定=3, pool既定=withinLimit）",
      association: { maxCount: 10 },
    },
    {
      label: "on-旧回避策（maxCount=10, anchorCount=40, limit=40, pool既定=withinLimit）",
      limit: 40,
      association: { maxCount: 10, anchorCount: 40 },
    },
    {
      label: "on-新修正（maxCount=10, anchorCount=40, pool=passed, limitは既定10のまま）",
      association: { maxCount: 10, anchorCount: 40, anchorPool: "passed" },
    },
    {
      label: "on-新修正-控えめ（maxCount=10, anchorCount=10, pool=passed, limitは既定10のまま）",
      association: { maxCount: 10, anchorCount: 10, anchorPool: "passed" },
    },
  ];
}

interface ProbeStageResult {
  probeId: string;
  aRaw: boolean;
  bPassed: boolean;
  cWithinLimit: boolean;
  /** arm label -> このprobeのanchorが実際にアンカーとして選ばれたか。offはnull。 */
  dActualAnchor: Record<string, boolean | null>;
  /** arm label -> gold の順位（1始まり）。返っていなければ null。 */
  goldRank: Record<string, number | null>;
  /** arm label -> recall() のレイテンシ(ms)。 */
  latencyMs: Record<string, number>;
}

async function measureProbe(
  runtime: Runtime,
  spy: VectorStoreSpy,
  ctx: Ctx,
  probeId: string,
  anchorId: MemoryId,
  goldId: MemoryId,
  arms: ArmConfig[],
): Promise<ProbeStageResult> {
  // --- (a)/(c): association を渡さない呼び出し。search() が1回だけ発生する。 ---
  spy.reset();
  const t0 = performance.now();
  const offResult = await runtime.recall(ctx, { text: findProbeQuery(probeId) });
  const offMs = performance.now() - t0;
  const rawHits = spy.searchCalls[0]?.hits ?? [];
  const aRaw = rawHits.some((h) => h.memoryId === anchorId);
  const cWithinLimit = offResult.memories.some(
    (m) => m.memoryId === anchorId && (m.retrievedVia === "ann" || m.retrievedVia === "lexical"),
  );

  // --- (b): anchorPool:'passed' + 大きな anchorCount で passed 全体を getVectors に流す。 ---
  spy.reset();
  await runtime.recall(ctx, {
    text: findProbeQuery(probeId),
    association: { maxCount: 1, anchorCount: PROBE_ANCHOR_COUNT, anchorPool: "passed" },
  });
  const passedIds = spy.getVectorsCalls[0] ?? [];
  const bPassed = passedIds.includes(anchorId);

  const dActualAnchor: Record<string, boolean | null> = {};
  const goldRank: Record<string, number | null> = {};
  const latencyMs: Record<string, number> = { off: offMs };

  for (const arm of arms) {
    if (arm.label === "off") {
      dActualAnchor[arm.label] = null;
      goldRank[arm.label] = indexOfMemory(offResult.memories, goldId);
      continue;
    }
    spy.reset();
    const t1 = performance.now();
    const result = await runtime.recall(ctx, {
      text: findProbeQuery(probeId),
      ...(arm.limit !== undefined ? { limit: arm.limit } : {}),
      ...(arm.association ? { association: arm.association } : {}),
    });
    latencyMs[arm.label] = performance.now() - t1;
    const anchors = spy.getVectorsCalls[0] ?? [];
    dActualAnchor[arm.label] = anchors.includes(anchorId);
    goldRank[arm.label] = indexOfMemory(result.memories, goldId);
  }

  return { probeId, aRaw, bPassed, cWithinLimit, dActualAnchor, goldRank, latencyMs };
}

function indexOfMemory(memories: readonly { memoryId: MemoryId }[], id: MemoryId): number | null {
  const idx = memories.findIndex((m) => m.memoryId === id);
  return idx === -1 ? null : idx + 1;
}

const PROBE_QUERY_BY_ID = new Map(ASSOCIATION_PROBES.map((p) => [p.id, p.query]));
function findProbeQuery(probeId: string): string {
  const q = PROBE_QUERY_BY_ID.get(probeId);
  if (!q) {
    throw new Error(`unknown probeId: ${probeId}`);
  }
  return q;
}

// ---------------------------------------------------------------------------
// スケール1点分の ingest + 測定
// ---------------------------------------------------------------------------

interface ScaleReport {
  scale: number;
  efSearch: number;
  probes: ProbeStageResult[];
  ingestSeconds: number;
  drainSeconds: number;
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

async function setEfSearch(
  pool: PostgresClient["pool"],
  databaseName: string,
  ef: number,
): Promise<void> {
  await pool.query(`ALTER DATABASE ${databaseName} SET hnsw.ef_search = ${ef}`);
}

/**
 * `scale` 件の filler で ingest する。**下限は `ASSOCIATION_HAYSTACK_SIZE`（62件）**
 * ——それ未満は指定できない。理由: 最小点は ADR 0168 が既に確立している「62文の
 * haystack」（`ASSOCIATION_HAYSTACK`、手書きの生活雑事60文 + Issue #317 で足した2文）
 * をそのまま使う。これは陽性対照（AGENTS.md「先に陽性対照を示す」）を兼ねる——
 * `buildAssociationProbeSetConversation()` は CI の `association-probes` ジョブが
 * 使っているのと**同じ**関数であり、ここで得られる62件時点の値は、その CI ジョブが
 * 実際に測っている値と直接比較できる。
 *
 * `scale` が62を超える分（`scale - 62` 件）は、`buildDistinctFiller` が作る合成 filler
 * （プローブの語彙と一切重ならない、構成上ゼロ重複のログ風テンプレート）を追加で積む
 * ——`ASSOCIATION_HAYSTACK` は手書き60文の巡回複製ではなく1点しか無いため、規模を
 * 稼ぐには別の生成規則が要る（`tmp-scale-bench-377.ts` の旧設計と同じ理由。
 * `buildHaystackUtterance` の巡回複製を使わない理由は `association-probe-set.ts`
 * の `ASSOCIATION_HAYSTACK` docstring 参照——近傍が単一クラスタになり連想枠の
 * プールを埋め尽くす）。
 */
async function ingestScale(
  databaseUrl: string,
  scale: number,
): Promise<{ anchorIds: Map<string, MemoryId>; goldIds: Map<string, MemoryId> }> {
  if (scale < ASSOCIATION_HAYSTACK_SIZE) {
    throw new Error(
      `ingestScale: scale(${scale}) は ASSOCIATION_HAYSTACK_SIZE(${ASSOCIATION_HAYSTACK_SIZE})未満を指定できない` +
        "（最小点は62文の陽性対照そのものであるため）",
    );
  }
  const handle = await createInstrumentedRuntime(databaseUrl);
  try {
    await truncateAll(handle.pool);
    const ctx: Ctx = { tenantId: "scale-377" };
    const anchorIds = new Map<string, MemoryId>();
    const goldIds = new Map<string, MemoryId>();

    // ⭐ 62件時点の陽性対照そのもの——probe 36件 + ASSOCIATION_HAYSTACK 62文を、
    // CI の association-probes ジョブと同じ関数で組む（ブリッジ語漏れ・query 語彙漏れの
    // 歯もここで一緒に噛む）。
    const baseUtterances = buildAssociationProbeSetConversation();
    for (const utterance of baseUtterances) {
      const result = await handle.runtime.observe(ctx, {
        kind: "utterance",
        text: utterance.text,
        externalId: utterance.externalId,
      });
      if (utterance.kind === "anchor" || utterance.kind === "gold") {
        if (result.memoryIds.length !== 1) {
          throw new Error(
            `ingestScale: ${utterance.externalId} の sync 抽出が期待通りに1件のMemoryを作らなかった` +
              `(${result.memoryIds.length}件)`,
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
    if (
      anchorIds.size !== ASSOCIATION_PROBES.length ||
      goldIds.size !== ASSOCIATION_PROBES.length
    ) {
      throw new Error(
        `ingestScale: anchorIds(${anchorIds.size})/goldIds(${goldIds.size})が` +
          `probe数(${ASSOCIATION_PROBES.length})と一致しない`,
      );
    }

    // 62件を超える分は合成 filler で稼ぐ。
    const extra = scale - ASSOCIATION_HAYSTACK_SIZE;
    const filler = buildDistinctFiller(extra);
    for (const f of filler) {
      await handle.runtime.observe(ctx, {
        kind: "utterance",
        text: f.text,
        externalId: f.externalId,
      });
    }

    await drainEmbedTicks(handle.runtime, ctx);
    await handle.pool.query("ANALYZE");

    return { anchorIds, goldIds };
  } finally {
    await handle.close();
  }
}

async function measureAtEfSearch(
  databaseUrl: string,
  databaseName: string,
  scale: number,
  ef: number,
  anchorIds: Map<string, MemoryId>,
  goldIds: Map<string, MemoryId>,
): Promise<ScaleReport> {
  // ALTER DATABASE の既定値は「次に張る接続」から効く——張り直す。
  const alterHandle = await createInstrumentedRuntime(databaseUrl);
  await setEfSearch(alterHandle.pool, databaseName, ef);
  await alterHandle.close();

  const handle = await createInstrumentedRuntime(databaseUrl);
  try {
    const check = await handle.pool.query("show hnsw.ef_search");
    console.log(`  [ef_search確認] show hnsw.ef_search -> ${JSON.stringify(check.rows)}`);

    const ctx: Ctx = { tenantId: "scale-377" };
    const arms = buildArms();
    const probes: ProbeStageResult[] = [];
    for (const probe of ASSOCIATION_PROBES) {
      const anchorId = anchorIds.get(probe.id)!;
      const goldId = goldIds.get(probe.id)!;
      const r = await measureProbe(
        handle.runtime,
        handle.spy,
        ctx,
        probe.id,
        anchorId,
        goldId,
        arms,
      );
      probes.push(r);
    }
    return { scale, efSearch: ef, probes, ingestSeconds: 0, drainSeconds: 0 };
  } finally {
    await handle.close();
  }
}

// ---------------------------------------------------------------------------
// レポート整形
// ---------------------------------------------------------------------------

function summarize(report: ScaleReport, arms: ArmConfig[]): string {
  const lines: string[] = [];
  lines.push(`\n### scale=${report.scale} ef_search=${report.efSearch}`);
  const aCount = report.probes.filter((p) => p.aRaw).length;
  const bCount = report.probes.filter((p) => p.bPassed).length;
  const cCount = report.probes.filter((p) => p.cWithinLimit).length;
  lines.push(
    `anchor到達: (a)raw ANN kPrime=${aCount}/12 (b)passed=${bCount}/12 (c)withinLimit=${cCount}/12`,
  );
  lines.push("| arm | (d)actual anchor | goldReturned | avgLatencyMs |");
  lines.push("|---|---|---|---|");
  for (const arm of arms) {
    const dCount = report.probes.filter((p) => p.dActualAnchor[arm.label] === true).length;
    const goldCount = report.probes.filter((p) => p.goldRank[arm.label] !== null).length;
    const avgMs =
      report.probes.reduce((sum, p) => sum + (p.latencyMs[arm.label] ?? 0), 0) /
      report.probes.length;
    const dLabel = arm.label === "off" ? "n/a" : `${dCount}/12`;
    lines.push(`| ${arm.label} | ${dLabel} | ${goldCount}/12 | ${avgMs.toFixed(2)} |`);
  }
  lines.push("\nper-probe detail:");
  lines.push("| probeId | a | b | c | " + arms.map((a) => `d:${a.label}`).join(" | ") + " |");
  for (const p of report.probes) {
    const dCells = arms.map((a) =>
      p.dActualAnchor[a.label] === null ? "n/a" : p.dActualAnchor[a.label] ? "1" : "0",
    );
    lines.push(
      `| ${p.probeId} | ${p.aRaw ? 1 : 0} | ${p.bPassed ? 1 : 0} | ${p.cWithinLimit ? 1 : 0} | ${dCells.join(" | ")} |`,
    );
  }
  return lines.join("\n");
}

async function main(): Promise<void> {
  const databaseUrl = requireDatabaseUrl();
  const databaseName = new URL(databaseUrl).pathname.replace(/^\//, "");
  const scales = parseIntListEnv("MNEMORA_ANCHOR_POOL_SCALES", [62, 1000, 3000, 10000]);
  const efSearchLevels = parseIntListEnv("MNEMORA_ANCHOR_POOL_EF_SEARCH", [40, 120]);

  console.log(`scales=${scales.join(",")} efSearchLevels=${efSearchLevels.join(",")}`);
  console.log(
    `kPrime既定 = limit(${DEFAULT_RECALL_LIMIT}) * overFetchFactor(${DEFAULT_OVER_FETCH_FACTOR}) = ${
      DEFAULT_RECALL_LIMIT * DEFAULT_OVER_FETCH_FACTOR
    }, anchorCount既定 = ${DEFAULT_ASSOCIATION_ANCHOR_COUNT}`,
  );

  // warmup を先に済ませる(識別子ベンチ等と同じ規律)。
  {
    const warmupHandle = await createInstrumentedRuntime(databaseUrl);
    const warmup = await warmupLocalEmbedding(warmupHandle.embeddingProvider);
    await warmupHandle.close();
    if (!warmup.ok) {
      console.error(warmup.detail);
      process.exitCode = 1;
      return;
    }
    console.log(warmup.detail);
  }

  const arms = buildArms();
  const allReports: ScaleReport[] = [];

  for (const scale of scales) {
    console.log(`\n=== ingest scale=${scale} ===`);
    const tIngest0 = Date.now();
    const { anchorIds, goldIds } = await ingestScale(databaseUrl, scale);
    const ingestSeconds = (Date.now() - tIngest0) / 1000;
    console.log(`  ingest+drain done in ${ingestSeconds.toFixed(1)}s`);

    for (const ef of efSearchLevels) {
      console.log(`\n--- measure scale=${scale} ef_search=${ef} ---`);
      const report = await measureAtEfSearch(
        databaseUrl,
        databaseName,
        scale,
        ef,
        anchorIds,
        goldIds,
      );
      report.ingestSeconds = ingestSeconds;
      allReports.push(report);
      console.log(summarize(report, arms));
    }
  }

  // 後始末: ef_search をデータベース既定へ戻す(このDBを他の測定と共有する可能性があるため)。
  const cleanupHandle = await createInstrumentedRuntime(databaseUrl);
  await cleanupHandle.pool.query(`ALTER DATABASE ${databaseName} RESET hnsw.ef_search`);
  await cleanupHandle.close();

  const jsonPath = process.env.MNEMORA_ANCHOR_POOL_JSON;
  if (jsonPath) {
    writeFileSync(jsonPath, `${JSON.stringify(allReports, null, 2)}\n`, "utf-8");
    console.log(`\n[association-anchor-pool-scale-bench] 機械可読な結果を書き出した: ${jsonPath}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
