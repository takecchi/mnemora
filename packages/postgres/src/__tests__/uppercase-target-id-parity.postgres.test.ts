import { describe, expect, it } from "vitest";
import { createRuntime } from "@mnemora/core";
import {
  InMemoryEventStore,
  InMemoryLexicalStore,
  InMemoryMemoryStore,
  InMemoryOutboxStore,
  InMemoryRelationStore,
  InMemoryTenantSettingsStore,
  InMemoryVectorStore,
} from "@mnemora/testkit/fixtures";
import { createFakeRuntimeStores } from "../../../core/src/__tests__/runtime-fakes.js";
import { PostgresMemoryStore } from "../memory-store.js";
import { PostgresVectorStore } from "../vector-store.js";
import { PostgresLexicalStore } from "../lexical-store.js";
import { PostgresEventStore } from "../event-store.js";
import { PostgresOutboxStore } from "../outbox-store.js";
import { PostgresTenantSettingsStore } from "../tenant-settings-store.js";
import { PostgresRelationStore } from "../relation-store.js";
import { getTestClient, resetTestDatabase, TEST_EMBEDDING_SPACE } from "./test-db.js";

/**
 * ADR 0521: 操作の対象の id（記憶・observation・recall・outbox のジョブ）を大文字で渡したときの振る舞いを、
 * `@mnemora/postgres` を正として、testkit の `InMemory*`・core の Fake が同じにするための 3 実装の突き合わせ。
 * ADR 0446 が「既存の違い」としていた点（Postgres は大文字の uuid を同じ行として受け、fixture は別 id として
 * 不在扱いにする）を、ADR 0521 で fixture 側を Postgres に揃えた。
 *
 * 各 `it` は 1 つの口について、(1) Postgres で大文字が小文字と同じ結果（返り値・最終状態・積まれたイベントの
 * `memoryId` が小文字）になること＝基準、(2) InMemory・Fake の大文字・小文字が、Postgres と同じになること、を見る。
 * 返り値の中の id の綴りの echo（呼び出し側が渡した綴りで返る outcome の `memoryId`）と、順序を規定しない配列の並びは
 * 比べない。conformance suite には何も足していない（ADR 0434 決定5。約束を足すのはオーナーの判断）。
 */

const ctx = { tenantId: "tenant-1" };
const emb: any = {
  space: TEST_EMBEDDING_SPACE,
  embed: async (_c: unknown, t: string[]) => t.map(() => [1, 0, 0]),
};
const backends: Record<string, () => Promise<any>> = {
  pg: async () => {
    await resetTestDatabase();
    const { db } = await getTestClient();
    return {
      memoryStore: new PostgresMemoryStore(db),
      outboxStore: new PostgresOutboxStore(db),
      vectorStore: new PostgresVectorStore(db),
      lexicalStore: new PostgresLexicalStore(db),
      eventStore: new PostgresEventStore(db),
      tenantSettingsStore: new PostgresTenantSettingsStore(db),
      relationStore: new PostgresRelationStore(db),
      embeddingProvider: emb,
    };
  },
  testkit: async () => {
    const m = new InMemoryMemoryStore();
    return {
      memoryStore: m,
      outboxStore: new InMemoryOutboxStore(m.outboxJobs),
      vectorStore: new InMemoryVectorStore(m),
      lexicalStore: new InMemoryLexicalStore(m),
      eventStore: new InMemoryEventStore(m, m.events),
      tenantSettingsStore: new InMemoryTenantSettingsStore(),
      relationStore: new InMemoryRelationStore(m, m.relations),
      embeddingProvider: emb,
    };
  },
  fake: async () => createFakeRuntimeStores(),
};

const T0 = new Date("2026-06-01T00:00:00.000Z").getTime();
type Env = { st: any; rt: any; ids: string[]; setNow: (n: number) => void; getNow: () => number };

async function mkEnv(be: string): Promise<Env> {
  const st = await backends[be]!();
  let now = T0;
  const llm: any = {
    complete: async () => {
      throw new Error("nu");
    },
    completeStructured: async (_c: any, req: any) => {
      for (const cand of [{ content: "merged", digest: "merged" }]) {
        const p = req.schema.safeParse(cand);
        if (p.success) return p.data;
      }
      throw new Error("stub");
    },
  };
  const rt = createRuntime({
    memoryStore: st.memoryStore,
    outboxStore: st.outboxStore,
    vectorStore: st.vectorStore,
    lexicalStore: st.lexicalStore,
    relationStore: st.relationStore,
    eventStore: st.eventStore,
    tenantSettingsStore: st.tenantSettingsStore,
    llmProvider: llm,
    embeddingProvider: st.embeddingProvider,
    hashContent: (c: string) => `sha(${c})`,
    clock: { now: () => new Date(now) },
  } as any);
  const ids: string[] = [];
  for (let i = 0; i < 4; i++) {
    const at = new Date(now);
    const m = await st.memoryStore.createMemory(ctx, {
      tenantId: ctx.tenantId,
      subjectId: null,
      sourceObservationId: null,
      extractorVersion: null,
      content: `content ${i} a`,
      contentHash: `h${i}`,
      digest: `d${i}`,
      digestSource: "llm",
      provenance: { kind: "imported", batchId: "m" },
      tags: ["a"],
      occurredAt: null,
      recordedAt: at,
      lastReinforcedAt: null,
      strength: 1,
      halfLifeHours: i === 3 ? 1 : 8760,
      decayFloorAt: new Date(now + 1e9 * (i === 3 ? 0 : 1)),
      embeddingStatus: "ready",
    } as any);
    await st.vectorStore.upsert(ctx, TEST_EMBEDDING_SPACE, m.id, [1, 0, 0]);
    ids.push(m.id);
    now += 1000;
  }
  return { st, rt, ids, setNow: (n) => (now = n), getNow: () => now };
}

const up = (s: string | undefined) => s!.toUpperCase();
function canon(v: unknown): unknown {
  if (Array.isArray(v))
    return v.map(canon).sort((a, b) => (JSON.stringify(a) < JSON.stringify(b) ? -1 : 1));
  // 記憶の行は、この試験が見る欄（status・対の相互参照・置き換えた側）だけに絞る。`halfLifeRecalls` などの欄の有無は
  // 3 実装で元から違い（null と欠落）、大文字の id とは関係がない。
  if (v !== null && typeof v === "object" && "contentHash" in (v as object)) {
    const m = v as {
      status?: unknown;
      contestedWithId?: unknown;
      supersededById?: unknown;
      digest?: unknown;
    };
    return {
      digest: m.digest,
      status: m.status,
      contestedWithId: m.contestedWithId ?? null,
      supersededById: m.supersededById ?? null,
    };
  }
  if (v !== null && typeof v === "object" && !(v instanceof Date)) {
    return Object.fromEntries(Object.entries(v as object).map(([k, x]) => [k, canon(x)]));
  }
  return v;
}
function alias(env: Env, v: unknown): unknown {
  if (typeof v === "string") {
    let out = v;
    env.ids.forEach((id, i) => {
      out = out.split(id).join(`<c${i}>`).split(up(id)).join(`<c${i}>`);
    });
    return out;
  }
  if (Array.isArray(v)) return v.map((x) => alias(env, x));
  if (v !== null && typeof v === "object" && !(v instanceof Date)) {
    return Object.fromEntries(Object.entries(v as object).map(([k, x]) => [k, alias(env, x)]));
  }
  return v;
}
function render(env: Env, v: unknown): string {
  const s =
    JSON.stringify(canon(alias(env, v)), (_k, x) =>
      x instanceof Date ? "<date>" : x === undefined ? "<undef>" : x,
    ) ?? "undefined";
  return s
    .replace(
      /"(id|eventId|recallId|observationId|consolidatedMemoryId|supersedingMemoryId)":"[^"]*"/g,
      '"$1":"<x>"',
    )
    .replace(
      /"(at|createdAt|updatedAt|recordedAt|occurredAt|lastReinforcedAt|decayFloorAt)":"[^"]*"/g,
      '"$1":"<t>"',
    );
}

async function states(env: Env): Promise<string> {
  const out: string[] = [];
  for (const id of env.ids) {
    const m = await env.st.memoryStore.get(ctx, id);
    out.push(
      m
        ? `${m.status}${m.purgedAt ? "+purged" : ""}${m.contestedWithId ? "~" : ""}${m.supersededById ? ">" : ""}`
        : "missing",
    );
  }
  const evs = await env.st.eventStore.list(ctx, { limit: 1000 });
  // 積まれたイベントの memoryId は、渡した綴りに依らず小文字（render は大文字小文字を同じ別名に潰すので、ここだけは生で比べる）。
  const ev = evs
    .filter((e: any) => e.kind !== "created")
    .map(
      (e: any) =>
        `${e.kind}:${e.memoryId === null ? "null" : e.memoryId === e.memoryId.toLowerCase() ? "lower" : "NOT-LOWER"}`,
    )
    .sort();
  return `${out.join(",")} ev=[${ev.join(" ")}]`;
}

const mkObs = async (e: Env) => {
  const o = await e.st.memoryStore.createObservation(ctx, {
    tenantId: ctx.tenantId,
    subjectId: null,
    externalId: null,
    kind: "utterance",
    payload: { text: "x" },
    occurredAt: null,
  } as any);
  (e as any).obsId = o.id;
  e.ids.push(o.id);
};
type Case = {
  name: string;
  pre?: (e: Env) => Promise<any>;
  run: (e: Env, f: (i: number) => string) => Promise<any>;
};
const arch = async (e: Env) => {
  e.setNow(e.getNow() + 400 * 24 * 3600e3);
  await e.rt.sweepArchive(ctx, { now: new Date(e.getNow()), limit: 50 });
};
const cases: Case[] = [
  { name: "rt.forget", run: (e, f) => e.rt.forget(ctx, { memoryId: f(0) }) },
  { name: "rt.forget(memoryIds)", run: (e, f) => e.rt.forget(ctx, { memoryIds: [f(0), f(1)] }) },
  {
    name: "rt.purge",
    pre: (e) => e.rt.forget(ctx, { memoryId: e.ids[0] }),
    run: (e, f) => e.rt.purge(ctx, { memoryId: f(0) }),
  },
  {
    name: "rt.restoreArchived",
    pre: arch,
    run: (e, f) => e.rt.restoreArchived(ctx, { memoryId: f(3) }),
  },
  { name: "rt.markContested", run: (e, f) => e.rt.markContested(ctx, f(0), f(1)) },
  {
    name: "rt.resolveContested(supersede)",
    pre: (e) => e.rt.markContested(ctx, e.ids[0], e.ids[1]),
    run: (e, f) => e.rt.resolveContested(ctx, f(0), f(1), { kind: "supersede", winnerId: f(0) }),
  },
  {
    name: "rt.resolveContested(both_active)",
    pre: (e) => e.rt.markContested(ctx, e.ids[0], e.ids[1]),
    run: (e, f) => e.rt.resolveContested(ctx, f(0), f(1), { kind: "both_active" }),
  },
  {
    name: "rt.consolidate",
    run: (e, f) => e.rt.consolidate(ctx, { target: { memoryIds: [f(0), f(1)] } }),
  },
  {
    name: "rt.restoreSuperseded",
    pre: async (e) => {
      const r = await e.rt.consolidate(ctx, { target: { memoryIds: [e.ids[0], e.ids[1]] } });
      e.ids.push(r.consolidatedMemoryId);
    },
    run: (e, f) => e.rt.restoreSuperseded(ctx, { supersededById: f(4) }),
  },
  {
    name: "rt.markContestedGroup",
    run: (e, f) => e.rt.markContestedGroup(ctx, [f(0), f(1), f(2)]),
  },
  {
    name: "rt.resolveContestedGroup",
    pre: (e) => e.rt.markContestedGroup(ctx, [e.ids[0], e.ids[1], e.ids[2]]),
    run: (e, f) =>
      e.rt.resolveContestedGroup(ctx, [f(0), f(1), f(2)], { kind: "supersede", winnerId: f(0) }),
  },
  {
    name: "rt.observe(memory_usage)",
    pre: async (e) => {
      (e as any).rec = await e.rt.recall(ctx, { vector: [1, 0, 0], limit: 10 });
    },
    run: (e, f) =>
      e.rt.observe(ctx, {
        kind: "memory_usage",
        recallId: (e as any).rec.recallId,
        usedMemoryIds: [f(0), f(1)],
      }),
  },
  {
    name: "rt.findCorrectionCandidates(exclude)",
    run: async (e, f) => {
      const r = await e.rt.findCorrectionCandidates(ctx, { text: "a", excludeMemoryIds: [f(0)] });
      return { ids: r.candidates.map((c: any) => c.memoryId), excluded: r.excludedCount };
    },
  },
  {
    name: "rt.applyCorrection",
    pre: async (e) => {
      (e as any).disc = await e.rt.findCorrectionCandidates(ctx, { text: "a" });
    },
    run: (e, f) =>
      e.rt.applyCorrection(ctx, {
        discovery: (e as any).disc,
        correctedId: f(0),
        correctingId: f(1),
        resolution: { kind: "supersede", winnerId: f(1) },
      }),
  },
  {
    name: "edge.markContested(a, A)",
    run: (e, f) => e.rt.markContested(ctx, e.ids[0], up(e.ids[0])),
  },
  {
    name: "edge.forget([a, A])",
    run: (e, f) => e.rt.forget(ctx, { memoryIds: [e.ids[0], up(e.ids[0])] }),
  },
  {
    name: "edge.markContestedGroup([a, A, b])",
    run: (e, f) => e.rt.markContestedGroup(ctx, [e.ids[0], up(e.ids[0]), e.ids[1]]),
  },
  {
    name: "edge.resolveContested(winner=UP, ids lo)",
    pre: (e) => e.rt.markContested(ctx, e.ids[0], e.ids[1]),
    run: (e, f) =>
      e.rt.resolveContested(ctx, e.ids[0], e.ids[1], { kind: "supersede", winnerId: up(e.ids[0]) }),
  },
  {
    name: "edge.resolveContested(second=UP only)",
    pre: (e) => e.rt.markContested(ctx, e.ids[0], e.ids[1]),
    run: (e, f) => e.rt.resolveContested(ctx, e.ids[0], up(e.ids[1]), { kind: "both_active" }),
  },
  {
    name: "edge.markContested(supersededById UP via updateStatus)",
    run: (e, f) =>
      e.st.memoryStore
        .updateStatus(ctx, e.ids[0], "superseded", { supersededById: up(e.ids[1]) })
        .then((m: any) => ({ id: m.id, by: m.supersededById })),
  },
  {
    name: "edge.restoreArchived([lo, UP])",
    pre: arch,
    run: (e, f) => e.rt.restoreArchived(ctx, { memoryIds: [e.ids[3], up(e.ids[3])] }),
  },
  {
    name: "edge.purge twice (lo then UP)",
    pre: async (e) => {
      await e.rt.forget(ctx, { memoryId: e.ids[0] });
      await e.rt.purge(ctx, { memoryId: e.ids[0] });
    },
    run: (e, f) => e.rt.purge(ctx, { memoryId: up(e.ids[0]) }),
  },
  {
    name: "m5.aggregateScope(digestBand.excludeMemoryIds)",
    run: (e, f) =>
      e.st.memoryStore
        .aggregateScope(ctx, {}, { digestBand: { limit: 10, excludeMemoryIds: [f(0)] } })
        .then((r: any) => ({
          digests: (r.digests ?? r.digestBand?.digests ?? []).map((d: any) => d.memoryId),
          eligible: r.digestEligible,
        })),
  },
  {
    name: "m5.requeueEmbedJobs(memoryIds)",
    pre: async (e) => {
      const m = await e.st.memoryStore.createMemory(ctx, {
        tenantId: ctx.tenantId,
        subjectId: null,
        sourceObservationId: null,
        extractorVersion: null,
        content: "rq",
        contentHash: "rqh",
        digest: "rq",
        digestSource: "llm",
        provenance: { kind: "imported", batchId: "m" },
        tags: [],
        occurredAt: null,
        recordedAt: new Date(e.getNow()),
        lastReinforcedAt: null,
        strength: 1,
        halfLifeHours: 8760,
        decayFloorAt: new Date(e.getNow() + 1e9),
        embeddingStatus: "pending",
      } as any);
      e.ids.push(m.id);
    },
    run: (e, f) =>
      e.st.memoryStore.requeueEmbedJobs(
        ctx,
        { statuses: ["pending"], memoryIds: [f(4)], limit: 10 },
        { now: new Date(e.getNow()) },
      ),
  },
  {
    name: "m5.vs.deleteAcrossSpaces",
    run: (e, f) =>
      e.st.vectorStore.deleteAcrossSpaces(ctx, [f(0)]).then(
        async () =>
          (
            await e.st.vectorStore.search(ctx, TEST_EMBEDDING_SPACE, [1, 0, 0], {
              limit: 10,
              filter: { tenantId: ctx.tenantId },
            } as any)
          ).length,
      ),
  },
  {
    name: "m5.vs.getVectors",
    run: (e, f) =>
      e.st.vectorStore
        .getVectors(ctx, TEST_EMBEDDING_SPACE, [f(0), f(0)])
        .then((x: any[]) => x.map((v) => v.memoryId)),
  },
  {
    name: "m5.ms.previewRestoreSupersededBy",
    pre: async (e) => {
      const r = await e.rt.consolidate(ctx, { target: { memoryIds: [e.ids[0], e.ids[1]] } });
      e.ids.push(r.consolidatedMemoryId);
    },
    run: (e, f) =>
      e.st.memoryStore
        .previewRestoreSupersededBy(ctx, f(4), { onlyMemoryIds: [f(0)] })
        .then((x: any) => x.candidates.map((c: any) => c.memoryId)),
  },
  {
    name: "m5.ms.restoreSupersededBy(onlyMemoryIds UP)",
    pre: async (e) => {
      const r = await e.rt.consolidate(ctx, { target: { memoryIds: [e.ids[0], e.ids[1]] } });
      e.ids.push(r.consolidatedMemoryId);
    },
    run: (e, f) =>
      e.st.memoryStore
        .restoreSupersededBy(
          ctx,
          e.ids[4],
          { at: new Date(e.getNow()), actor: { type: "system" } } as any,
          { onlyMemoryIds: [f(0)] },
        )
        .then((x: any) => x.restored.map((m: any) => m.id)),
  },
  {
    name: "m5.outbox.complete(jobId UP)",
    pre: async (e) => {
      const at = new Date(e.getNow());
      const r = await e.st.memoryStore.createMemoryWithOutbox(
        ctx,
        {
          tenantId: ctx.tenantId,
          subjectId: null,
          sourceObservationId: null,
          extractorVersion: null,
          content: "jobmem",
          contentHash: "jobh",
          digest: "jd",
          digestSource: "llm",
          provenance: { kind: "imported", batchId: "m" },
          tags: [],
          occurredAt: null,
          recordedAt: at,
          lastReinforcedAt: null,
          strength: 1,
          halfLifeHours: 8760,
          decayFloorAt: new Date(e.getNow() + 1e9),
          embeddingStatus: "pending",
        } as any,
        ["embed"],
      );
      (e as any).job = r.jobs[0];
    },
    run: async (e, f) => {
      const claimed = await e.st.outboxStore.claimBatch(ctx, {
        limit: 10,
        now: new Date(Date.now() + 3600e3),
        claimedBy: "w",
        leaseMs: 1000,
      });
      const j = claimed[0];
      const idv = (e as any).variantUP ? j.id.toUpperCase() : j.id;
      await e.st.outboxStore.complete(ctx, idv, j.attempts);
      const left = await e.st.outboxStore.claimBatch(ctx, {
        limit: 10,
        now: new Date(Date.now() + 10 * 3600e3),
        claimedBy: "w",
        leaseMs: 1000,
      });
      return { remaining: left.length };
    },
  },
  {
    name: "m5.outbox.fail(jobId UP)",
    pre: async (e) => {
      const at = new Date(e.getNow());
      const r = await e.st.memoryStore.createMemoryWithOutbox(
        ctx,
        {
          tenantId: ctx.tenantId,
          subjectId: null,
          sourceObservationId: null,
          extractorVersion: null,
          content: "jobmem",
          contentHash: "jobh",
          digest: "jd",
          digestSource: "llm",
          provenance: { kind: "imported", batchId: "m" },
          tags: [],
          occurredAt: null,
          recordedAt: at,
          lastReinforcedAt: null,
          strength: 1,
          halfLifeHours: 8760,
          decayFloorAt: new Date(e.getNow() + 1e9),
          embeddingStatus: "pending",
        } as any,
        ["embed"],
      );
      (e as any).job = r.jobs[0];
    },
    run: async (e, f) => {
      const claimed = await e.st.outboxStore.claimBatch(ctx, {
        limit: 10,
        now: new Date(Date.now() + 3600e3),
        claimedBy: "w",
        leaseMs: 1000,
      });
      const j = claimed[0];
      const idv = (e as any).variantUP ? j.id.toUpperCase() : j.id;
      await e.st.outboxStore.fail(ctx, idv, "x", j.attempts);
      const left = await e.st.outboxStore.claimBatch(ctx, {
        limit: 10,
        now: new Date(Date.now() + 10 * 3600e3),
        claimedBy: "w",
        leaseMs: 1000,
      });
      return { remaining: left.length };
    },
  },
  {
    name: "o6.getObservation(UP)",
    pre: mkObs,
    run: (e, f) => e.st.memoryStore.getObservation(ctx, f(4)).then((o: any) => o && { id: o.id }),
  },
  {
    name: "o6.createMemory(sourceObservationId UP)",
    pre: mkObs,
    run: (e, f) =>
      e.st.memoryStore
        .createMemory(ctx, {
          tenantId: ctx.tenantId,
          subjectId: null,
          sourceObservationId: f(4),
          extractorVersion: null,
          content: "s",
          contentHash: "sh",
          digest: "s",
          digestSource: "llm",
          provenance: { kind: "imported", batchId: "m" },
          tags: [],
          occurredAt: null,
          recordedAt: new Date(e.getNow()),
          lastReinforcedAt: null,
          strength: 1,
          halfLifeHours: 8760,
          decayFloorAt: new Date(e.getNow() + 1e9),
          embeddingStatus: "pending",
        } as any)
        .then((m: any) => ({ src: m.sourceObservationId })),
  },
  {
    name: "o6.listBySourceObservation(UP)",
    pre: async (e) => {
      await mkObs(e);
      await e.st.memoryStore.createMemory(ctx, {
        tenantId: ctx.tenantId,
        subjectId: null,
        sourceObservationId: e.ids[4],
        extractorVersion: "v1",
        content: "s",
        contentHash: "sh",
        digest: "s",
        digestSource: "llm",
        provenance: { kind: "imported", batchId: "m" },
        tags: [],
        occurredAt: null,
        recordedAt: new Date(e.getNow()),
        lastReinforcedAt: null,
        strength: 1,
        halfLifeHours: 8760,
        decayFloorAt: new Date(e.getNow() + 1e9),
        embeddingStatus: "pending",
      } as any);
    },
    run: (e, f) =>
      e.st.memoryStore.listBySourceObservation(ctx, f(4), "v1").then((x: any[]) => x.length),
  },
  {
    name: "o6.getRecall(UP)",
    pre: async (e) => {
      (e as any).rec = await e.rt.recall(ctx, { vector: [1, 0, 0], limit: 10 });
    },
    run: (e, f) => {
      const id = (e as any).rec.recallId;
      return e.st.memoryStore
        .getRecall(ctx, (e as any).variantUP ? id.toUpperCase() : id)
        .then((r: any) => r && { found: true });
    },
  },
  {
    name: "o6.recordUsage(recallId UP)",
    pre: async (e) => {
      (e as any).rec = await e.rt.recall(ctx, { vector: [1, 0, 0], limit: 10 });
    },
    run: (e, f) => {
      const id = (e as any).rec.recallId;
      return e.st.memoryStore.recordUsage(ctx, (e as any).variantUP ? id.toUpperCase() : id, [
        e.ids[0],
      ]);
    },
  },
  { name: "ms.get", run: (e, f) => e.st.memoryStore.get(ctx, f(0)) },
  {
    name: "ms.getMany",
    run: (e, f) =>
      e.st.memoryStore.getMany(ctx, [f(0), e.ids[0], f(1)]).then((x: any[]) => x.map((m) => m.id)),
  },
  {
    name: "ms.updateStatus",
    run: (e, f) => e.st.memoryStore.updateStatus(ctx, f(0), "forgotten", {}).then((m: any) => m.id),
  },
  {
    name: "ms.setEmbeddingStatus",
    run: (e, f) => e.st.memoryStore.setEmbeddingStatus(ctx, f(0), "pending").then((m: any) => m.id),
  },
  {
    name: "ms.reinforce",
    run: (e, f) =>
      e.st.memoryStore.reinforce(ctx, f(0), new Date(e.getNow())).then((m: any) => m.id),
  },
  {
    name: "ms.reinforceMany",
    run: (e, f) =>
      e.st.memoryStore
        .reinforceMany(ctx, [f(0), f(1)], new Date(e.getNow()))
        .then((x: any[]) => x.map((m) => m.id)),
  },
  {
    name: "ms.recordUsage",
    pre: async (e) => {
      (e as any).rec = await e.rt.recall(ctx, { vector: [1, 0, 0], limit: 10 });
    },
    run: (e, f) => e.st.memoryStore.recordUsage(ctx, (e as any).rec.recallId, [f(0), f(1)]),
  },
  {
    name: "ms.restoreSupersededBy",
    pre: async (e) => {
      const r = await e.rt.consolidate(ctx, { target: { memoryIds: [e.ids[0], e.ids[1]] } });
      e.ids.push(r.consolidatedMemoryId);
    },
    run: (e, f) =>
      e.st.memoryStore
        .restoreSupersededBy(ctx, f(4), {
          at: new Date(e.getNow()),
          actor: { type: "system" },
        } as any)
        .then((x: any) => x.restored.map((m: any) => m.id)),
  },
  {
    name: "vs.upsert",
    run: (e, f) => e.st.vectorStore.upsert(ctx, TEST_EMBEDDING_SPACE, f(0), [0, 1, 0]),
  },
  {
    name: "vs.delete",
    run: (e, f) =>
      e.st.vectorStore.delete(ctx, TEST_EMBEDDING_SPACE, f(0)).then(
        async () =>
          (
            await e.st.vectorStore.search(ctx, TEST_EMBEDDING_SPACE, [1, 0, 0], {
              limit: 10,
              filter: { tenantId: ctx.tenantId },
            } as any)
          ).length,
      ),
  },
  {
    name: "es.list(memoryId)",
    pre: (e) => e.rt.forget(ctx, { memoryId: e.ids[0] }),
    run: (e, f) =>
      e.st.eventStore
        .list(ctx, { memoryId: f(0) })
        .then((x: any[]) => x.map((ev) => ev.kind + ":" + ev.memoryId)),
  },
  {
    name: "rs.link",
    run: async (e, f) => {
      await e.st.relationStore.link(ctx, "contradicts", f(0), f(1));
      return e.st.relationStore.listRelated(ctx, e.ids[0], "contradicts");
    },
  },
  {
    name: "rs.listRelated",
    pre: (e) => e.st.relationStore.link(ctx, "contradicts", e.ids[0], e.ids[1]),
    run: (e, f) => e.st.relationStore.listRelated(ctx, f(0), "contradicts"),
  },
  {
    name: "rs.unlink",
    pre: (e) => e.st.relationStore.link(ctx, "contradicts", e.ids[0], e.ids[1]),
    run: async (e, f) => {
      await e.st.relationStore.unlink(ctx, "contradicts", f(0), f(1));
      return e.st.relationStore.listRelated(ctx, e.ids[0], "contradicts");
    },
  },
];

async function observe(be: string, c: Case, variant: "lo" | "UP"): Promise<string> {
  const e = await mkEnv(be);
  (e as any).variantUP = variant === "UP";
  let res: string;
  try {
    if (c.pre) await c.pre(e);
    const f = (i: number) => (variant === "UP" ? up(e.ids[i]!) : e.ids[i]!);
    const v = await c.run(e, f);
    res = "ok " + render(e, v);
  } catch (err) {
    res =
      "THROW " +
      String((err as Error).message)
        .replace(/[0-9a-f]{8}-[0-9a-f-]{27}/gi, "<uuid>")
        .replace(/(MEM|mem|OBS|obs|RCL|rcl|JOB|job)-\d+/g, "<id>")
        .slice(0, 120);
  }
  return `${res} || ${await states(e)}`;
}

// Fake は全文の語彙一致を持たず、text だけの recall は候補を返さない（ADR 0492 の fuzz も `fcc` は `excludeMemoryIds` の除外だけを見る）。
const SKIP_FAKE = new Set(["rt.findCorrectionCandidates(exclude)", "rt.applyCorrection"]);

describe("操作の対象の id を大文字で渡したとき、3 実装が同じになる（ADR 0521）", () => {
  for (const c of cases) {
    it(
      c.name,
      async () => {
        const pgLo = await observe("pg", c, "lo");
        const pgUp = await observe("pg", c, "UP");
        // 基準: Postgres は大文字を小文字と同じ記憶・同じ行として扱う。
        expect(pgUp).toBe(pgLo);
        for (const be of ["testkit", "fake"]) {
          if (be === "fake" && SKIP_FAKE.has(c.name)) continue;
          expect(await observe(be, c, "lo")).toBe(pgLo);
          expect(await observe(be, c, "UP")).toBe(pgUp);
        }
      },
      120_000,
    );
  }
});
