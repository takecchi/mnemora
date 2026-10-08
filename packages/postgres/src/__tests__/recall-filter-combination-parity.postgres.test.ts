import { createHash } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import type {
  Ctx,
  MemoryStore,
  RecallQuery,
  RecallResult,
  Runtime,
  VectorStore,
} from "@mnemora/core";
import { createRuntime } from "@mnemora/core";
import { buildNewMemoryFixture } from "@mnemora/testkit";
import {
  InMemoryEventStore,
  InMemoryLexicalStore,
  InMemoryMemoryStore,
  InMemoryOutboxStore,
  InMemoryTenantSettingsStore,
  InMemoryVectorStore,
} from "@mnemora/testkit/fixtures";
import { closePostgresClient, createPostgresClient, type PostgresClient } from "../client.js";
import { PostgresMemoryStore } from "../memory-store.js";
import { PostgresVectorStore } from "../vector-store.js";
import { PostgresLexicalStore } from "../lexical-store.js";
import { PostgresEventStore } from "../event-store.js";
import { PostgresOutboxStore } from "../outbox-store.js";
import { PostgresTenantSettingsStore } from "../tenant-settings-store.js";
import {
  closeTestClient,
  getTestClient,
  requireDatabaseUrl,
  resetTestDatabase,
  seededRandom,
  TEST_EMBEDDING_SPACE,
} from "./test-db.js";

/**
 * recall の絞り込み（filter）の組み合わせを、種を固定した乱数で作り、testkit の InMemory と Postgres に当てる（property-based の形）。
 * 連想枠は切る（`association: null`。別の段で既存の検査器が当てている）。
 *
 * 1. 2実装が同じ結果: 返る記憶の並び（id・`retrievedVia`・`score.total`）と `omitted`。
 *    Postgres は `enable_indexscan = off` の接続で段1を厳密にする（HNSW の近似は約束の内の揺れ）。
 *    `lexical_truncated` が立った recall は比べない（`LexicalHit.rank` の尺度は adapter ごとに違う）。
 *    数値は相対 1e-4 まで同じとみなす（pgvector は float4）。文字列に埋め込まれた数値も同じ丸めで比べる。
 * 2. 絞り込みを破らない。`labels: []` は絞り込み無し。
 * 3. 黙って0件にしない: 0件の recall には `omitted` の理由が1つ以上付く。
 * 4. HNSW を通しうる接続の返る集合が厳密な脚と違うのは、`ann_unreached` を名乗ったときだけ。
 */

const SEEDS = Number(process.env.RECALL_FILTER_COMBO_SEEDS ?? 8);
const QUERIES = Number(process.env.RECALL_FILTER_COMBO_QUERIES ?? 12);
const FIRST_SEED = Number(process.env.RECALL_FILTER_COMBO_FIRST_SEED ?? 1);
const N = 40;
const NOW = Date.parse("2026-06-01T00:00:00.000Z");
const TENANT = "recall-filter-combo";
const TAGS = ["a", "b", "c", "d"] as const;
const KINDS = ["imported", "consolidated", "reflected", "stated"] as const;

let queryVector = [1, 0, 0];
const shared = {
  llmProvider: {
    complete: async () => ({ content: "" }),
    completeStructured: async () => {
      throw new Error("unused");
    },
  },
  embeddingProvider: {
    space: TEST_EMBEDDING_SPACE,
    embed: async (_ctx: Ctx, texts: string[]) => texts.map(() => queryVector),
  },
  hashContent: (content: string) => createHash("sha256").update(content).digest("hex"),
  clock: { now: () => new Date(NOW) },
};

interface Kit {
  runtime: Runtime;
  memoryStore: MemoryStore;
  vectorStore: VectorStore;
}

let exactClient: PostgresClient | undefined;

async function postgresKit(mode: "exact" | "planner"): Promise<Kit> {
  await resetTestDatabase();
  const plannerClient = await getTestClient();
  if (mode === "exact" && exactClient === undefined) {
    exactClient = createPostgresClient(requireDatabaseUrl(), {
      options: "-c enable_indexscan=off",
    });
  }
  const { db } = mode === "exact" ? exactClient! : plannerClient;
  const memoryStore = new PostgresMemoryStore(db);
  const vectorStore = new PostgresVectorStore(db);
  return {
    memoryStore,
    vectorStore,
    runtime: createRuntime({
      ...shared,
      memoryStore,
      vectorStore,
      lexicalStore: new PostgresLexicalStore(db),
      outboxStore: new PostgresOutboxStore(db),
      eventStore: new PostgresEventStore(db),
      tenantSettingsStore: new PostgresTenantSettingsStore(db),
    }),
  };
}

async function testkitKit(): Promise<Kit> {
  const memoryStore = new InMemoryMemoryStore();
  const vectorStore = new InMemoryVectorStore(memoryStore);
  return {
    memoryStore,
    vectorStore,
    runtime: createRuntime({
      ...shared,
      memoryStore,
      vectorStore,
      lexicalStore: new InMemoryLexicalStore(memoryStore),
      outboxStore: new InMemoryOutboxStore(memoryStore.outboxJobs),
      eventStore: new InMemoryEventStore(memoryStore, memoryStore.events),
      tenantSettingsStore: new InMemoryTenantSettingsStore(memoryStore.activitySeq),
    }),
  };
}

const pick = <T>(r: () => number, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!;
const subset = <T>(r: () => number, xs: readonly T[], p = 0.4): T[] => xs.filter(() => r() < p);
const daysAgo = (d: number) => new Date(NOW - d * 86_400_000);

interface MemoryMeta {
  subjectId: string | null;
  tags: string[];
  kind: string;
  effectiveTime: number;
  validFrom: number | null;
  validUntil: number | null;
  vector: number[];
}

async function seedMemories(kit: Kit, s: number): Promise<{ ids: string[]; meta: MemoryMeta[] }> {
  const r = seededRandom(s * 7919 + 1);
  const ctx: Ctx = { tenantId: TENANT };
  const observation = await kit.memoryStore.createObservation(ctx, {
    tenantId: TENANT,
    subjectId: null,
    externalId: null,
    kind: "utterance",
    payload: { text: "x" },
    occurredAt: null,
    recordedAt: new Date(NOW - 1000),
  });
  const ids: string[] = [];
  const meta: MemoryMeta[] = [];
  for (let i = 0; i < N; i++) {
    const kind = pick(r, KINDS);
    const tags = subset(r, TAGS);
    const occurredAt = r() < 0.3 ? null : daysAgo(Math.floor(r() * 400));
    const validFrom = r() < 0.2 ? daysAgo(Math.floor(r() * 200)) : null;
    const rawUntil = r() < 0.2 ? daysAgo(Math.floor(r() * 100) - 50) : null;
    const validUntil = rawUntil && validFrom && rawUntil <= validFrom ? null : rawUntil;
    const subjectId = pick(r, ["s1", "s2", null] as const);
    const recordedAt = new Date(NOW - Math.floor(r() * 1e8));
    const provenance =
      kind === "stated"
        ? { kind, sourceObservationId: observation.id, at: new Date(NOW).toISOString() }
        : kind === "consolidated"
          ? { kind, sources: ["x"] }
          : kind === "reflected"
            ? { kind }
            : { kind, batchId: "b" };
    const memory = await kit.memoryStore.createMemory(
      ctx,
      buildNewMemoryFixture({
        tenantId: TENANT,
        subjectId,
        content: `mem ${i} ${tags.join(" ")}`,
        contentHash: `combo-${s}-${i}`,
        digest: `digest ${i}`,
        tags,
        occurredAt,
        recordedAt,
        halfLifeHours: 1e6,
        decayFloorAt: new Date("2100-01-01T00:00:00.000Z"),
        embeddingStatus: "ready",
        validFrom,
        validUntil,
        provenance: provenance as never,
        ...(kind === "stated"
          ? { sourceObservationId: observation.id, extractorVersion: "v1" }
          : {}),
      }),
    );
    ids.push(memory.id);
    const vector = [r() * 2 - 1, r() * 2 - 1, r() * 2 - 1];
    meta.push({
      subjectId,
      tags,
      kind,
      effectiveTime: (occurredAt ?? recordedAt).getTime(),
      validFrom: validFrom?.getTime() ?? null,
      validUntil: validUntil?.getTime() ?? null,
      vector,
    });
    await kit.vectorStore.upsert(ctx, TEST_EMBEDDING_SPACE, memory.id, vector);
  }
  return { ids, meta };
}

interface Probe {
  ctx: Ctx;
  query: RecallQuery;
  vector: number[];
}

function buildProbes(s: number): Probe[] {
  const r = seededRandom(s * 104729 + 7);
  const probes: Probe[] = [];
  for (let k = 0; k < QUERIES; k++) {
    const q: Record<string, unknown> = {
      text: pick(r, ["a", "a b", "b c d", "mem"]),
      limit: 1 + Math.floor(r() * 10),
      association: null,
    };
    const channels = pick(r, [["ann"], ["lexical"], ["ann", "lexical"], undefined]);
    if (channels !== undefined) q.channels = channels;
    if (r() < 0.4) q.labels = subset(r, TAGS, 0.5);
    if (r() < 0.3) q.tags = subset(r, TAGS, 0.5);
    if (r() < 0.3) q.excludeProvenanceKinds = subset(r, KINDS, 0.4);
    if (r() < 0.3) q.occurredAfter = daysAgo(Math.floor(r() * 400));
    if (r() < 0.3) q.occurredBefore = daysAgo(Math.floor(r() * 200));
    if (r() < 0.3) q.validAt = daysAgo(Math.floor(r() * 150) - 30);
    if (r() < 0.2) q.includeOutsideValidity = true;
    if (r() < 0.3) q.includeSubjectless = r() < 0.5;
    const subjectId = pick(r, [undefined, "s1", "s2"]);
    probes.push({
      ctx: subjectId === undefined ? { tenantId: TENANT } : { tenantId: TENANT, subjectId },
      query: q as RecallQuery,
      vector: [r() * 2 - 1, r() * 2 - 1, r() * 2 - 1],
    });
  }
  return probes;
}

const roundNumber = (n: number) => Math.round(n * 1e4) / 1e4;
function normalize(result: RecallResult, ids: string[]): unknown {
  const alias = (value: string) => (ids.includes(value) ? `m${ids.indexOf(value)}` : value);
  const deep = (x: unknown): unknown => {
    if (typeof x === "number") return roundNumber(x);
    if (typeof x === "string") {
      return alias(x).replace(/-?\d+\.\d+(e-?\d+)?/g, (m) => String(roundNumber(Number(m))));
    }
    if (Array.isArray(x)) return x.map(deep);
    if (x !== null && typeof x === "object") {
      return Object.fromEntries(Object.entries(x).map(([k, v]) => [k, deep(v)]));
    }
    return x;
  };
  return deep({
    // `affinityMeasured: false`（連想枠・必須の同伴取得）の score は total を欄として持たないので、undefined で揃えて比べる。
    memories: result.memories.map((m) => [
      m.memoryId,
      m.retrievedVia,
      m.score.affinityMeasured === false ? undefined : m.score.total,
    ]),
    omitted: result.omitted,
  });
}

function violatedFilters(probe: Probe, m: MemoryMeta): string[] {
  const q = probe.query;
  const bad: string[] = [];
  const subject = probe.ctx.subjectId;
  if (
    subject !== undefined &&
    !(m.subjectId === subject || (q.includeSubjectless === true && m.subjectId === null))
  ) {
    bad.push("subject");
  }
  // `labels: []` は絞り込み無し（`RecallQuery.labels` の doc）。open モード・全ラベル proposed なので、
  // 渡した名前はすべて参加資格を持つ。
  if (q.labels !== undefined && q.labels.length > 0 && !m.tags.some((t) => q.labels!.includes(t))) {
    bad.push("labels");
  }
  if (q.excludeProvenanceKinds?.includes(m.kind as never)) bad.push("excludeProvenanceKinds");
  if (q.occurredAfter !== undefined && !(m.effectiveTime >= q.occurredAfter.getTime()))
    bad.push("occurredAfter");
  if (q.occurredBefore !== undefined && !(m.effectiveTime <= q.occurredBefore.getTime()))
    bad.push("occurredBefore");
  if (q.includeOutsideValidity !== true) {
    const at = (q.validAt ?? new Date(NOW)).getTime();
    if (m.validFrom !== null && m.validFrom > at) bad.push("validFrom");
    if (m.validUntil !== null && m.validUntil <= at) bad.push("validUntil");
  }
  return bad;
}

/**
 * 端ちょうどの問い（Issue #1922 の続き）。乱数の問いは日単位の値を記憶と独立に引くので、絞り込みの端
 * （`>=` と `>`、`<=` と `<`）にちょうど乗る記憶がめったに出ず、端を取り違えた実装を既定の8種で見分けられなかった。
 * 種の記憶の値そのものを端に置く。
 */
function boundaryProbes(meta: MemoryMeta[]): Probe[] {
  const base = { text: "mem", limit: N, association: null };
  const queries: Array<Record<string, unknown>> = [];
  for (const m of meta.filter((x) => x.validFrom === null && x.validUntil === null).slice(0, 3)) {
    queries.push({ ...base, occurredAfter: new Date(m.effectiveTime) });
    queries.push({ ...base, occurredBefore: new Date(m.effectiveTime) });
  }
  const validFrom = meta.find((x) => x.validFrom !== null)?.validFrom;
  if (validFrom != null) queries.push({ ...base, validAt: new Date(validFrom) });
  const validUntil = meta.find((x) => x.validUntil !== null)?.validUntil;
  if (validUntil != null) queries.push({ ...base, validAt: new Date(validUntil) });
  const probes: Probe[] = [];
  for (const q of queries) {
    for (const channels of [["ann"], ["lexical"]]) {
      probes.push({
        ctx: { tenantId: TENANT },
        query: { ...q, channels } as RecallQuery,
        vector: [1, 0, 0],
      });
    }
  }
  // 段1で取りすぎた記憶は core が後段で絞り直すので、席に余裕があると store の絞り漏れは結果に出ない。
  // 席を1つにし（`limit: 1`・`overFetchFactor: 1`）、締め出されるべき記憶そのもののベクトルで引いて、漏れた1件に席を取らせる。
  const narrow = { ...base, limit: 1, overFetchFactor: 1, channels: ["ann"] };
  for (const m of meta.filter((x) => x.validUntil !== null).slice(0, 2)) {
    probes.push({
      ctx: { tenantId: TENANT },
      query: { ...narrow, validAt: new Date(m.validUntil!) } as RecallQuery,
      vector: m.vector,
    });
  }
  const alwaysValid = meta.filter((x) => x.validFrom === null && x.validUntil === null);
  for (const [subjectId, outsider] of [
    ["s1", alwaysValid.find((x) => x.subjectId === "s2")],
    ["s2", alwaysValid.find((x) => x.subjectId === "s1")],
    ["s1", alwaysValid.find((x) => x.subjectId === null)],
  ] as const) {
    if (outsider === undefined) continue;
    probes.push({
      ctx: { tenantId: TENANT, subjectId },
      query: { ...narrow, includeSubjectless: false } as RecallQuery,
      vector: outsider.vector,
    });
  }
  return probes;
}

async function runAll(kit: Kit, s: number, randomProbes: Probe[]) {
  const { ids, meta } = await seedMemories(kit, s);
  const probes = [...randomProbes, ...boundaryProbes(meta)];
  const results: RecallResult[] = [];
  for (const probe of probes) {
    queryVector = probe.vector;
    results.push(await kit.runtime.recall(probe.ctx, probe.query));
  }
  return { ids, meta, results, probes };
}

afterAll(async () => {
  if (exactClient !== undefined) await closePostgresClient(exactClient);
  await closeTestClient();
});

describe("recall の絞り込みの組み合わせ: testkit と Postgres が同じ結果を返し、絞り込みを破らない", () => {
  const seeds = Array.from({ length: SEEDS }, (_, i) => FIRST_SEED + i);
  it.each(seeds)(
    "種 %i",
    async (s) => {
      const randomProbes = buildProbes(s);
      const tk = await runAll(await testkitKit(), s, randomProbes);
      const exact = await runAll(await postgresKit("exact"), s, randomProbes);
      const planner = await runAll(await postgresKit("planner"), s, randomProbes);
      // 端の問いは種の記憶から作るので、3つの脚で同じ問いになっていることを先に確かめる。
      expect(exact.probes).toEqual(tk.probes);
      expect(planner.probes).toEqual(tk.probes);

      tk.probes.forEach((probe, i) => {
        const where = `種 ${s} 問 ${i}: ${JSON.stringify({ subjectId: probe.ctx.subjectId ?? null, ...probe.query })}`;
        for (const [name, run] of [
          ["testkit", tk],
          ["Postgres（厳密）", exact],
          ["Postgres（planner）", planner],
        ] as const) {
          const result = run.results[i]!;
          // 2. 絞り込みを破らない
          for (const m of result.memories) {
            const meta = run.meta[run.ids.indexOf(m.memoryId)]!;
            expect(
              violatedFilters(probe, meta),
              `${name} ${where} m${run.ids.indexOf(m.memoryId)}`,
            ).toEqual([]);
          }
          // 3. 黙って0件にしない
          if (result.memories.length === 0) {
            expect(
              result.omitted.length,
              `${name} ${where}: 0件なのに omitted が空`,
            ).toBeGreaterThan(0);
          }
        }

        // 1. testkit と Postgres（厳密）が同じ結果（lexical_truncated が立った recall は比べない）
        const truncated = (x: RecallResult) =>
          x.omitted.some((o) => o.kind === "lexical_truncated");
        if (!truncated(tk.results[i]!) && !truncated(exact.results[i]!)) {
          expect(normalize(exact.results[i]!, exact.ids), where).toEqual(
            normalize(tk.results[i]!, tk.ids),
          );
        }

        // 4. HNSW を通しうる脚が、ann_unreached を名乗らずに集合を変えない
        const set = (run: typeof exact) =>
          run.results[i]!.memories.map((m) => `m${run.ids.indexOf(m.memoryId)}`).sort();
        if (!planner.results[i]!.omitted.some((o) => o.kind === "ann_unreached")) {
          expect(set(planner), `${where}: planner の集合が厳密な脚と違う`).toEqual(set(exact));
        }
      });
    },
    300_000,
  );
});
