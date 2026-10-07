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
 * `Runtime.reembed`（`MemoryStore.requeueEmbedJobs`）は、`active`・`contested` の記憶だけを積み直す。
 * forgotten・purge 済み・archived・superseded の記憶は、`embeddingStatus` が対象でも選ばない（3実装とも `status IN ('active','contested')` で絞る）。
 * 3 実装（Postgres・testkit の InMemory・core の Fake）で見る。
 */

const ctx = { tenantId: "tenant-1" };
const SPACE = TEST_EMBEDDING_SPACE;
function countingProvider() {
  const calls: string[][] = [];
  const provider: any = {
    space: SPACE,
    embed: async (_c: unknown, texts: string[]) => {
      calls.push([...texts]);
      return texts.map(() => [1, 0, 0]);
    },
  };
  return { provider, calls };
}
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
      embeddingProvider: undefined,
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
      embeddingProvider: undefined,
    };
  },
  fake: async () => createFakeRuntimeStores(),
};

type State = "active" | "contested" | "archived" | "superseded" | "forgotten" | "purged";
const mk = (n: string) => ({
  tenantId: ctx.tenantId,
  subjectId: null,
  sourceObservationId: null,
  extractorVersion: null,
  content: `body-${n}`,
  contentHash: `h-${n}`,
  digest: `d-${n}`,
  digestSource: "llm",
  provenance: { kind: "imported", batchId: "m" },
  tags: [],
  occurredAt: null,
  recordedAt: new Date(),
  lastReinforcedAt: null,
  strength: 1,
  halfLifeHours: 8760,
  decayFloorAt: new Date(Date.now() + 1e12),
  embeddingStatus: "failed",
});

async function env(be: string) {
  const st = await backends[be]!();
  const { provider } = countingProvider();
  const llm: any = {
    complete: async () => {
      throw new Error("nu");
    },
    completeStructured: async () => {
      throw new Error("nu");
    },
  };
  const rt: any = createRuntime({
    memoryStore: st.memoryStore,
    outboxStore: st.outboxStore,
    vectorStore: st.vectorStore,
    lexicalStore: st.lexicalStore,
    relationStore: st.relationStore,
    eventStore: st.eventStore,
    tenantSettingsStore: st.tenantSettingsStore,
    llmProvider: llm,
    embeddingProvider: provider,
    hashContent: (c: string) => `sha(${c})`,
    clock: { now: () => new Date() },
  } as any);
  return { st, rt };
}

async function toState(st: any, rt: any, id: string, state: State, partner: string) {
  if (state === "forgotten" || state === "purged") await rt.forget(ctx, { memoryId: id });
  if (state === "purged") await rt.purge(ctx, { memoryId: id });
  if (state === "archived") await st.memoryStore.updateStatus(ctx, id, "archived");
  if (state === "superseded")
    await st.memoryStore.updateStatus(ctx, id, "superseded", { supersededById: partner });
  if (state === "contested") await rt.markContested(ctx, id, partner);
}

describe("reembed は forgotten・purge 済みの記憶のジョブを積まない（ADR 0542。今の振る舞いの記録）", () => {
  for (const be of ["pg", "testkit", "fake"]) {
    for (const [state, requeued] of [
      ["active", 1],
      ["contested", 2], // 相方も failed で contested になるので2件
      ["archived", 0],
      ["superseded", 0],
      ["forgotten", 0],
      ["purged", 0],
    ] as const) {
      it(`${be}: ${state} の記憶 (embeddingStatus: failed): 積む件数 ${requeued}`, async () => {
        const { st, rt } = await env(be);
        const m = await st.memoryStore.createMemory(ctx, mk("m"));
        const partner = await st.memoryStore.createMemory(ctx, mk("p"));
        await toState(st, rt, m.id, state, partner.id);
        const r = await rt.reembed(ctx, { statuses: ["failed"], limit: 10 });
        const ids: string[] = r.memoryIds;
        // partner は active のまま（superseded・archived・forgotten・purged では相方も対象の active）。
        const expected = state === "active" ? 2 : state === "contested" ? 2 : 1;
        expect(r.requeued).toBe(expected);
        expect(ids.includes(m.id)).toBe(requeued > 0);
      }, 120_000);
    }

    it(`${be}: limit との関係: 先に外してから limit 件まで詰める（forgotten が最も古くても limit 件返る）`, async () => {
      const { st, rt } = await env(be);
      const f = await st.memoryStore.createMemory(ctx, mk("f"));
      await rt.forget(ctx, { memoryId: f.id }); // updated_at が最も古い（以降に作る記憶より前）
      const a = await st.memoryStore.createMemory(ctx, mk("a"));
      const b = await st.memoryStore.createMemory(ctx, mk("b"));
      const c = await st.memoryStore.createMemory(ctx, mk("c"));
      const r = await rt.reembed(ctx, { statuses: ["failed"], limit: 2 });
      expect(r.requeued).toBe(2);
      expect(r.memoryIds).not.toContain(f.id);
      expect([a.id, b.id, c.id]).toEqual(expect.arrayContaining(r.memoryIds));
    }, 120_000);

    it(`${be}: memoryIds で forgotten を名指ししても積まない`, async () => {
      const { st, rt } = await env(be);
      const f = await st.memoryStore.createMemory(ctx, mk("f"));
      await rt.forget(ctx, { memoryId: f.id });
      const r = await rt.reembed(ctx, { statuses: ["failed"], memoryIds: [f.id], limit: 10 });
      expect(r).toEqual({ requeued: 0, memoryIds: [] });
    }, 120_000);
  }
});
