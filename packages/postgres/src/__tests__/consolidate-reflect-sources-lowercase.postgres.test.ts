/* eslint-disable @typescript-eslint/no-explicit-any -- 3 実装の store を同じ形で突き合わせる試験 */
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
 * ADR 0527: `consolidate`・`reflect` が積む `created` イベントの `meta.sources` は、渡された `memoryIds`・`seedMemoryId`（大文字でもよい）の
 * 綴りではなく、store が返した行の id（小文字の正規形）で書く。3 実装（Postgres・testkit の InMemory・core の Fake）で、
 * 大文字で渡したときの `created` の `meta.sources` が、小文字で渡したときと同じ（小文字）になることを突き合わせる。
 * 作られた記憶の `provenance.sources`・`superseded` イベントの `memoryId` は元から正規形（それも見る）。
 * conformance suite には何も足していない（ADR 0434 決定5）。
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
      for (const cand of [
        { content: "merged", digest: "merged" },
        { outcome: "reflected", content: "reflection", digest: "reflection" },
      ]) {
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
async function sourcesOf(be: string, op: string, variant: "lo" | "UP") {
  const e = await mkEnv(be);
  const f = (i: number) => (variant === "UP" ? up(e.ids[i]) : e.ids[i]!);
  let newId: string;
  if (op === "consolidate") {
    newId = (await e.rt.consolidate(ctx, { target: { memoryIds: [f(0), f(1)] } }))
      .consolidatedMemoryId;
  } else if (op === "reflect") {
    const r = await e.rt.reflect(ctx, { target: { memoryIds: [f(0), f(1)] } } as any);
    newId = r.reflectedMemoryId ?? r.memoryId;
  } else {
    const r = await e.rt.reflect(ctx, { target: { seedMemoryId: f(0) } } as any);
    newId = r.reflectedMemoryId ?? r.memoryId;
  }
  const evs = await e.st.eventStore.list(ctx, { limit: 1000 });
  const created = evs.find((x: any) => x.kind === "created" && x.memoryId === newId);
  const idx = (id: string) => e.ids.indexOf(id);
  const meta = (created.meta.sources as string[]).map((id) =>
    idx(id) >= 0 ? `c${idx(id)}` : `NOT-LOWER:${id}`,
  );
  const m = await e.st.memoryStore.get(ctx, newId);
  const prov = (m.provenance.sources as string[]).map((id) =>
    idx(id) >= 0 ? `c${idx(id)}` : `NOT-LOWER:${id}`,
  );
  const sup = evs
    .filter((x: any) => x.kind === "superseded")
    .map((x: any) => (idx(x.memoryId) >= 0 ? `c${idx(x.memoryId)}` : `NOT-LOWER`))
    .sort();
  // seed の近傍の並びは同点のとき id 順で、実装ごとに id の形が違うので、seed の形は並びを問わない。
  return op === "reflect-seed"
    ? { meta: [...meta].sort(), prov: [...prov].sort(), sup }
    : { meta, prov, sup };
}

describe("consolidate・reflect の created イベントの meta.sources は小文字（ADR 0527）", () => {
  for (const op of ["consolidate", "reflect", "reflect-seed"]) {
    it(
      op,
      async () => {
        const base = await sourcesOf("pg", op, "lo");
        expect(base.meta.every((x: string) => /^c\d$/.test(x))).toBe(true);
        for (const be of ["pg", "testkit", "fake"]) {
          for (const variant of ["lo", "UP"] as const) {
            const got = await sourcesOf(be, op, variant);
            if (op === "reflect-seed") {
              // 近傍の取れ方（件数・並び）は実装の ANN の差。ここで見るのは、種を大文字で渡しても綴りが小文字で残ること。
              expect(got.meta).toContain("c0");
              expect([...got.meta, ...got.prov].every((x: string) => /^c\d$/.test(x))).toBe(true);
            } else {
              expect(got).toEqual(base);
            }
          }
        }
      },
      120_000,
    );
  }
});
