/* eslint-disable @typescript-eslint/no-explicit-any -- 3 実装の store を同じ形で突き合わせる試験 */
import { describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
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
 * outbox のジョブ経由（`tick`）の `consolidate`・`reflect` で、`created` イベントの `meta.sources`（と作られた記憶の
 * `provenance.sources`・`superseded` イベントの `memoryId`）が小文字の行の id になることを、3 実装（Postgres・testkit の InMemory・
 * core の Fake）で見る。
 *
 * (A) 通常の入口: ジョブの payload `{ memoryId }` は store が `createMemoryWithOutbox` で作った行の id から組む（利用者が id を渡す口は無い）。
 *     ここでは、積まれた payload が小文字の行の id そのものであることと、`tick` の結果が小文字であることを縛る。
 * (B) 届かないはずの入口: payload を直接大文字に書き換えた行（DB を直接触る・別の書き手がいる場合）を `tick` が受けても、
 *     `meta.sources` は小文字（直しを外すと、この (B) だけが赤）。
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
type Env = {
  seed?: string;
  st: any;
  rt: any;
  ids: string[];
  setNow: (n: number) => void;
  getNow: () => number;
};

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

const lowerOnly = (xs: unknown, e: Env) =>
  (xs as string[]).map((id) =>
    e.ids.includes(id) || id === e.seed
      ? id === e.seed
        ? "seed"
        : `c${e.ids.indexOf(id)}`
      : `NOT-LOWER:${id}`,
  );

async function viaTick(be: string, kind: "consolidate" | "reflect", payloadUpper: boolean) {
  const e = (await mkEnv(be)) as Env & { seed?: string };
  const at = new Date(); // 壁時計（時計を壁時計より先へ進めるので、減衰の起点もそろえる）
  // seed: ジョブ付きで作る（ready・同じベクトル）。ジョブの available_at は runtime の時計と同じ領域にそろえる。
  const r = await e.st.memoryStore.createMemoryWithOutbox(
    ctx,
    {
      tenantId: ctx.tenantId,
      subjectId: null,
      sourceObservationId: null,
      extractorVersion: null,
      content: "seed a",
      contentHash: "hseed",
      digest: "dseed",
      digestSource: "llm",
      provenance: { kind: "imported", batchId: "m" },
      tags: ["a"],
      occurredAt: null,
      recordedAt: at,
      lastReinforcedAt: null,
      strength: 1,
      halfLifeHours: 8760,
      decayFloorAt: new Date(Date.now() + 1e12),
      embeddingStatus: "ready",
    } as any,
    [kind],
  );
  e.seed = r.memory.id;
  await e.st.vectorStore.upsert(ctx, TEST_EMBEDDING_SPACE, r.memory.id, [1, 0, 0]);
  for (let i = 0; i < 2; i++) {
    const m = await e.st.memoryStore.createMemory(ctx, {
      tenantId: ctx.tenantId,
      subjectId: null,
      sourceObservationId: null,
      extractorVersion: null,
      content: "banana neighbor",
      contentHash: `hn${i}`,
      digest: "banana neighbor",
      digestSource: "llm",
      provenance: { kind: "imported", batchId: "m" },
      tags: ["a"],
      occurredAt: null,
      recordedAt: at,
      lastReinforcedAt: null,
      strength: 1,
      halfLifeHours: 8760,
      decayFloorAt: new Date(Date.now() + 1e12),
      embeddingStatus: "ready",
    } as any);
    await e.st.vectorStore.upsert(ctx, TEST_EMBEDDING_SPACE, m.id, [1, 0, 0]);
    e.ids.push(m.id);
  }
  const payloadId = r.jobs[0].payload.memoryId as string;
  if (payloadUpper) {
    if (be === "pg") {
      const { db } = await getTestClient();
      await db.execute(
        sql`UPDATE outbox SET payload = jsonb_build_object('memoryId', upper(payload->>'memoryId')) WHERE kind = ${kind}`,
      );
    } else {
      const jobs =
        be === "testkit"
          ? e.st.memoryStore.outboxJobs
          : (e.st.outboxStore as any).backing.outboxJobs;
      for (const j of jobs)
        if (j.kind === kind) j.payload = { memoryId: String(j.payload.memoryId).toUpperCase() };
    }
  }
  e.setNow(Date.now() + 60_000);
  const t = await e.rt.tick(ctx, { leaseMs: 1000, kinds: [kind] });
  const evs = await e.st.eventStore.list(ctx, { limit: 1000 });
  const created = evs.filter(
    (x: any) =>
      x.kind === "created" &&
      x.meta?.reason === (kind === "consolidate" ? "consolidated" : "reflected"),
  );
  const sup = evs
    .filter((x: any) => x.kind === "superseded")
    .map((x: any) => lowerOnly([x.memoryId], e)[0])
    .sort();
  const meta = created.map((c: any) => lowerOnly(c.meta.sources, e).sort());
  const prov: string[][] = [];
  for (const c of created)
    prov.push(
      lowerOnly((await e.st.memoryStore.get(ctx, c.memoryId)).provenance.sources, e).sort(),
    );
  return {
    payloadIsRowId: payloadId === r.memory.id && payloadId === payloadId.toLowerCase(),
    processed: t.processed,
    failed: t.failed,
    meta,
    prov,
    sup,
  };
}

describe("tick 経由の consolidate・reflect の created の meta.sources は小文字（ADR 0532）", () => {
  for (const kind of ["consolidate", "reflect"] as const) {
    for (const upper of [false, true]) {
      it(`${kind}: payload ${upper ? "を大文字に書き換えた行（届かないはずの入口）" : "は store が作った行の id（通常の入口）"}`, async () => {
        const base = await viaTick("pg", kind, false);
        expect(base.payloadIsRowId).toBe(true);
        expect(base.processed).toBe(1);
        expect(base.failed).toBe(0);
        expect(base.meta.length).toBe(1);
        expect(base.meta[0]!.every((x: string) => !x.startsWith("NOT-LOWER"))).toBe(true);
        for (const be of ["pg", "testkit", "fake"]) {
          const got = await viaTick(be, kind, upper);
          if (be === "fake") {
            // Fake は語彙の一致を持たず、種の digest を検索語にした近傍が取れない（`consolidate`・`reflect` の
            // 種の形は近傍 0 件で何もしない）。ジョブが処理されたこと・入口の payload・書かれた欄がすべて小文字であることだけを見る。
            expect([got.payloadIsRowId, got.processed, got.failed]).toEqual([true, 1, 0]);
            expect(got.meta.flat().every((x: string) => !x.startsWith("NOT-LOWER"))).toBe(true);
          } else {
            expect(got).toEqual(base);
          }
        }
      }, 120_000);
    }
  }
});
