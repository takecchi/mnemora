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
 * ADR 0541: forget・purge した記憶の本文を、外部の embedding provider に送らない。forget の前に積まれた埋め込みジョブ
 * （`createMemoryWithOutbox` の `jobKinds: ["embed"]`）が後から `tick` で走っても、`processEmbedJob` は forgotten か purge 済みの記憶なら
 * provider を呼ばずにジョブを終える（`complete`）。以前は、本文（purge 後は墓標）を provider に送り、ベクトルを書いていた。
 * 3 実装（Postgres・testkit の InMemory・core の Fake）で、呼ばれた回数と渡された入力を数える provider で見る。
 * 他の状態（active・archived・superseded・contested）は今までどおり埋め込む（やりすぎの対照）。
 * conformance suite には何も足していない（ADR 0434 決定5）。
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

const SECRET = "secret-body-XYZ";
type State = "active" | "forgotten" | "purged" | "archived" | "superseded" | "contested";

async function scenario(be: string, state: State) {
  const st = await backends[be]!();
  const { provider, calls } = countingProvider();
  const now = Date.now() + 60_000;
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
    clock: { now: () => new Date(now) },
  } as any);
  const mk = (n: string, content: string) => ({
    tenantId: ctx.tenantId,
    subjectId: null,
    sourceObservationId: null,
    extractorVersion: null,
    content,
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
    embeddingStatus: "pending",
  });
  const r = await st.memoryStore.createMemoryWithOutbox(ctx, mk("m", SECRET), ["embed"]);
  const id: string = r.memory.id;
  const other = await st.memoryStore.createMemory(ctx, mk("o", "other body"));
  if (state === "forgotten" || state === "purged") await rt.forget(ctx, { memoryId: id });
  if (state === "purged") await rt.purge(ctx, { memoryId: id });
  if (state === "archived") await st.memoryStore.updateStatus(ctx, id, "archived");
  if (state === "superseded")
    await st.memoryStore.updateStatus(ctx, id, "superseded", { supersededById: other.id });
  if (state === "contested") await rt.markContested(ctx, id, other.id);
  const t1 = await rt.tick(ctx, { leaseMs: 1000, kinds: ["embed"] });
  const t2 = await rt.tick(ctx, { leaseMs: 1000, kinds: ["embed"] });
  const m = await st.memoryStore.get(ctx, id);
  const vecs = await st.vectorStore.getVectors(ctx, SPACE, [id]);
  return {
    inputs: calls.flat(),
    callCount: calls.length,
    first: [t1.processed, t1.failed],
    second: [t2.processed, t2.failed],
    status: m.status,
    embeddingStatus: m.embeddingStatus,
    vectorWritten: vecs.length === 1,
  };
}

describe("埋め込みジョブは、forget・purge した記憶の本文を provider に送らない（ADR 0541）", () => {
  for (const be of ["pg", "testkit", "fake"]) {
    for (const state of ["forgotten", "purged"] as const) {
      it(`${be}: ${state} の記憶: provider を呼ばずにジョブを終え、再試行で回り続けない`, async () => {
        const r = await scenario(be, state);
        expect(r.inputs).toEqual([]); // 以前は forgotten は本文、purged は墓標が渡った
        expect(r.first).toEqual([1, 0]); // ジョブは complete（failed にしない）
        expect(r.second).toEqual([0, 0]); // 2回目の tick で拾い直されない
        expect(r.vectorWritten).toBe(false); // ベクトルも書かない
        expect(r.status).toBe("forgotten");
        expect(r.embeddingStatus).toBe("pending"); // embeddingStatus は触らない
      }, 120_000);
    }
    for (const state of ["active", "archived", "superseded", "contested"] as const) {
      it(`${be}: ${state} の記憶は今までどおり埋め込む（やりすぎの対照）`, async () => {
        const r = await scenario(be, state);
        expect(r.inputs).toEqual([SECRET]);
        expect(r.first).toEqual([1, 0]);
        expect(r.embeddingStatus).toBe("ready");
        expect(r.vectorWritten).toBe(true);
      }, 120_000);
    }
  }

  it("残る窓: 読んだ直後（provider を呼ぶ前）に forget されると、本文は送られる（Fake。塞げない窓の記録）", async () => {
    const st: any = await backends.fake!();
    const { provider, calls } = countingProvider();
    const now = Date.now() + 60_000;
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
      clock: { now: () => new Date(now) },
    } as any);
    const r = await st.memoryStore.createMemoryWithOutbox(
      ctx,
      {
        tenantId: ctx.tenantId,
        subjectId: null,
        sourceObservationId: null,
        extractorVersion: null,
        content: SECRET,
        contentHash: "hw",
        digest: "dw",
        digestSource: "llm",
        provenance: { kind: "imported", batchId: "m" },
        tags: [],
        occurredAt: null,
        recordedAt: new Date(),
        lastReinforcedAt: null,
        strength: 1,
        halfLifeHours: 8760,
        decayFloorAt: new Date(Date.now() + 1e12),
        embeddingStatus: "pending",
      } as any,
      ["embed"],
    );
    const realGet = st.memoryStore.get.bind(st.memoryStore);
    let forgot = false;
    st.memoryStore.get = async (c: any, id: string) => {
      const m = structuredClone(await realGet(c, id)); // Fake は行そのものを返すので、読んだ時点の写しを返す
      if (!forgot && id === r.memory.id) {
        forgot = true;
        await st.memoryStore.updateStatus(c, id, "forgotten");
      }
      return m;
    };
    await rt.tick(ctx, { leaseMs: 1000, kinds: ["embed"] });
    expect(calls.flat()).toEqual([SECRET]);
  });
});

describe("consolidate・reflect は、forget・purge した記憶の本文を LLM provider に送らない（既存の振る舞いの記録。ADR 0541）", () => {
  for (const be of ["pg", "testkit", "fake"]) {
    for (const op of ["consolidate", "reflect"] as const) {
      it(`${be}: ${op}: forgotten・purged の元は prompt に載らない。種が forgotten なら LLM を呼ばない`, async () => {
        const st: any = await backends[be]!();
        const prompts: string[] = [];
        const llm: any = {
          complete: async () => {
            throw new Error("nu");
          },
          completeStructured: async (_c: any, req: any) => {
            prompts.push(JSON.stringify(req.prompt));
            for (const cand of [
              { content: "merged", digest: "merged" },
              { outcome: "reflected", content: "r", digest: "r" },
            ]) {
              const parsed = req.schema.safeParse(cand);
              if (parsed.success) return parsed.data;
            }
            throw new Error("stub");
          },
        };
        const { provider } = countingProvider();
        const now = Date.now() + 60_000;
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
          clock: { now: () => new Date(now) },
        } as any);
        const ids: string[] = [];
        for (const [i, body] of [
          "body-FORGOTTEN-A",
          "body-PURGED-B",
          "body-active-C",
          "body-active-D",
        ].entries()) {
          const m = await st.memoryStore.createMemory(ctx, {
            tenantId: ctx.tenantId,
            subjectId: null,
            sourceObservationId: null,
            extractorVersion: null,
            content: body,
            contentHash: `h${i}`,
            digest: body,
            digestSource: "llm",
            provenance: { kind: "imported", batchId: "m" },
            tags: [],
            occurredAt: null,
            recordedAt: new Date(),
            lastReinforcedAt: null,
            strength: 1,
            halfLifeHours: 8760,
            decayFloorAt: new Date(Date.now() + 1e12),
            embeddingStatus: "ready",
          } as any);
          ids.push(m.id);
        }
        await rt.forget(ctx, { memoryId: ids[0] });
        await rt.forget(ctx, { memoryId: ids[1] });
        await rt.purge(ctx, { memoryId: ids[1] });
        const target = { memoryIds: ids };
        await rt[op](ctx, { target } as any);
        expect(prompts.length).toBe(1);
        expect(prompts[0]).toContain("body-active-C");
        expect(prompts[0]).not.toContain("body-FORGOTTEN-A");
        expect(prompts[0]).not.toContain("body-PURGED-B");
        prompts.length = 0;
        await rt[op](ctx, { target: { seedMemoryId: ids[0] } } as any);
        expect(prompts).toEqual([]);
      }, 120_000);
    }
  }
});

// 種（`seedMemoryId`）が forgotten・purged のとき、近傍（種の digest で recall して集める active な記憶）が居ても、
// recall（= embedding provider へのクエリ送信）も LLM も呼ばない。上の歯は近傍が無い状況なので、種の判定を外しても
// 結果が変わらず縛れていなかった（変異 M15・M16）。ベクトルを持つ active な近傍 C・D を置いて見る。
describe("consolidate・reflect の { seedMemoryId }: 種が forgotten・purged なら、近傍が居ても recall も LLM も呼ばない（ADR 0541）", () => {
  for (const be of ["pg", "testkit", "fake"]) {
    for (const op of ["consolidate", "reflect"] as const) {
      for (const seedState of ["active", "forgotten", "purged"] as const) {
        const expectsWork = seedState === "active"; // active は対照（近傍に届くことの確認）
        it(`${be}: ${op}: 種が ${seedState}: ${expectsWork ? "近傍を集めて LLM を呼ぶ（対照）" : "provider も LLM も呼ばない"}`, async () => {
          const st: any = await backends[be]!();
          const prompts: string[] = [];
          const llm: any = {
            complete: async () => {
              throw new Error("nu");
            },
            completeStructured: async (_c: any, req: any) => {
              prompts.push(JSON.stringify(req.prompt));
              for (const cand of [
                { content: "merged", digest: "merged" },
                { outcome: "reflected", content: "r", digest: "r" },
              ]) {
                const parsed = req.schema.safeParse(cand);
                if (parsed.success) return parsed.data;
              }
              throw new Error("stub");
            },
          };
          const { provider, calls } = countingProvider();
          const now = Date.now() + 60_000;
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
            clock: { now: () => new Date(now) },
          } as any);
          const ids: string[] = [];
          for (const [i, body] of ["seed-S", "near-active-C", "near-active-D"].entries()) {
            const m = await st.memoryStore.createMemory(ctx, {
              tenantId: ctx.tenantId,
              subjectId: null,
              sourceObservationId: null,
              extractorVersion: null,
              content: body,
              contentHash: `hs${i}`,
              digest: body,
              digestSource: "llm",
              provenance: { kind: "imported", batchId: "m" },
              tags: [],
              occurredAt: null,
              recordedAt: new Date(),
              lastReinforcedAt: null,
              strength: 1,
              halfLifeHours: 8760,
              decayFloorAt: new Date(Date.now() + 1e12),
              embeddingStatus: "ready",
            } as any);
            await st.vectorStore.upsert(ctx, SPACE, m.id, [1, 0, 0]);
            ids.push(m.id);
          }
          if (seedState !== "active") await rt.forget(ctx, { memoryId: ids[0] });
          if (seedState === "purged") await rt.purge(ctx, { memoryId: ids[0] });
          calls.length = 0; // ここまでの準備で数えた呼び出しは除く
          await rt[op](ctx, { target: { seedMemoryId: ids[0] } } as any);
          if (expectsWork) {
            expect(calls.length).toBeGreaterThan(0); // recall のクエリ埋め込み
            expect(prompts.length).toBe(1);
            expect(prompts[0]).toContain("near-active-C");
          } else {
            expect(calls).toEqual([]); // 種の digest をクエリとして embedding provider に送らない
            expect(prompts).toEqual([]); // 近傍が居ても LLM を呼ばない
          }
        }, 120_000);
      }
    }
  }
});
