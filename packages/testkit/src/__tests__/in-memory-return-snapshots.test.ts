import { describe, expect, it } from "vitest";
import type { Ctx, LLMProvider, Memory, MemoryId, NewMemoryEvent } from "@mnemora/core";
import { createRuntime } from "@mnemora/core";
import { buildNewMemoryEventFixture, buildNewMemoryFixture } from "../test-data.js";
import { InMemoryEventStore } from "../__fixtures__/in-memory-event-store.js";
import { InMemoryMemoryStore } from "../__fixtures__/in-memory-memory-store.js";
import { InMemoryOutboxStore } from "../__fixtures__/in-memory-outbox-store.js";
import { InMemoryTenantSettingsStore } from "../__fixtures__/in-memory-tenant-settings-store.js";
import { InMemoryVectorStore } from "../__fixtures__/in-memory-vector-store.js";

/**
 * `InMemoryMemoryStore` が返す Memory（と入れ子の値）は、**返した時点の複製**である
 * ——`PostgresMemoryStore` が毎回行を読み直した新しいオブジェクトを返すのと同じ（Issue #1108）。
 *
 * 【実測 2026-09-27】以前は内部に持っている Memory の実体そのものを返し、後の書き込みが
 * その実体をその場で書き換えていた。そのため、呼び手が一度受け取った値が、後の別の操作で
 * 遡って変わった——`runtime.applyCorrection` の返り値の中の「contested にした」という
 * 結果の Memory が、同じ呼び出しの後の resolve で `superseded` と名乗っていた（Postgres は
 * 印を付けた時点の `contested`）。
 *
 * 2つのことを見る:
 * 1. 依頼の場面: `applyCorrection` の返り値が、後から書き換わらない。
 * 2. 返す口の一覧: `MemoryStore` の Memory を返す口それぞれで、
 *    (a) 後の書き込み（`reinforce`）で、受け取った値が変わらない
 *    (b) 受け取った値を書き換えても（入れ子の配列も含めて）、store の中身が変わらない
 */

const ctx: Ctx = { tenantId: "in-memory-return-snapshots" };
const LATER = new Date("2099-01-01T00:00:00.000Z");

function event(
  memoryId: MemoryId | null = null,
  kind: NewMemoryEvent["kind"] = "updated",
): NewMemoryEvent {
  return buildNewMemoryEventFixture({ tenantId: ctx.tenantId, memoryId, kind });
}

let counter = 0;
async function create(
  store: InMemoryMemoryStore,
  overrides: Parameters<typeof buildNewMemoryFixture>[0] = {},
) {
  counter += 1;
  return store.createMemory(
    ctx,
    buildNewMemoryFixture({
      tenantId: ctx.tenantId,
      contentHash: `snapshot-${counter}`,
      tags: ["original-tag"],
      ...overrides,
    }),
  );
}

describe("applyCorrection の返り値が、後から書き換わらない（Issue #1108）", () => {
  it("resolved の markResult の Memory は、印を付けた時点の contested のまま", async () => {
    const memoryStore = new InMemoryMemoryStore();
    const vectorStore = new InMemoryVectorStore(memoryStore);
    const llm: LLMProvider = {
      complete: async () => ({ content: "unused" }),
      completeStructured: async () => {
        throw new Error("unused");
      },
    };
    const runtime = createRuntime({
      memoryStore,
      outboxStore: new InMemoryOutboxStore(memoryStore.outboxJobs),
      vectorStore,
      eventStore: new InMemoryEventStore(memoryStore, memoryStore.events),
      tenantSettingsStore: new InMemoryTenantSettingsStore(memoryStore.activitySeq),
      llmProvider: llm,
      embeddingProvider: {
        space: { provider: "test", model: "snapshot", dimensions: 3 },
        embed: async (_ctx, texts) => texts.map(() => [1, 0, 0]),
      },
      hashContent: (content: string) => `sha256(${content})`,
    });
    const space = { provider: "test", model: "snapshot", dimensions: 3 };
    const corrected = await create(memoryStore, {
      recordedAt: new Date(),
      embeddingStatus: "ready",
    });
    const correcting = await create(memoryStore, {
      recordedAt: new Date(),
      embeddingStatus: "ready",
    });
    await vectorStore.upsert(ctx, space, corrected.id, [1, 0, 0]);
    await vectorStore.upsert(ctx, space, correcting.id, [1, 0, 0]);

    const discovery = await runtime.findCorrectionCandidates(ctx, { text: "訂正" });
    expect(discovery.candidates.map((c) => c.memoryId)).toContain(corrected.id);

    const result = await runtime.applyCorrection(ctx, {
      discovery,
      correctedId: corrected.id,
      correctingId: correcting.id,
      resolution: { kind: "supersede", winnerId: correcting.id },
    });

    expect(result.kind).toBe("resolved");
    if (result.kind !== "resolved") throw new Error("unreachable");
    const marked = result.markResult.outcome;
    expect(marked.kind).toBe("contested");
    if (marked.kind !== "contested") throw new Error("unreachable");
    expect(marked.first.status).toBe("contested");
    expect(marked.second.status).toBe("contested");
  });
});

/** Memory を返す口を1つ呼び、返った Memory を並べる。`target` は後の書き込みを当てる Memory。 */
type Returner = (store: InMemoryMemoryStore) => Promise<{ returned: Memory[] }>;

const RETURNERS: Array<[string, Returner]> = [
  ["createMemory", async (s) => ({ returned: [await create(s)] })],
  [
    "createMemoryWithOutbox",
    async (s) => {
      counter += 1;
      const r = await s.createMemoryWithOutbox(
        ctx,
        buildNewMemoryFixture({
          tenantId: ctx.tenantId,
          contentHash: `snapshot-${counter}`,
          tags: ["original-tag"],
        }),
        ["embed"],
      );
      return { returned: [r.memory] };
    },
  ],
  ["get", async (s) => ({ returned: [(await s.get(ctx, (await create(s)).id))!] })],
  ["getMany", async (s) => ({ returned: await s.getMany(ctx, [(await create(s)).id]) })],
  [
    "listBySourceObservation",
    async (s) => {
      const obs = await s.createObservation(ctx, {
        tenantId: ctx.tenantId,
        subjectId: null,
        externalId: null,
        kind: "utterance",
        payload: { text: "x" },
        occurredAt: null,
        recordedAt: new Date(),
      });
      await create(s, {
        sourceObservationId: obs.id,
        extractorVersion: "v1",
        provenance: { kind: "stated", sourceObservationId: obs.id, at: "2026-01-01T00:00:00Z" },
      });
      return { returned: await s.listBySourceObservation(ctx, obs.id, "v1") };
    },
  ],
  [
    "updateStatus",
    async (s) => ({ returned: [await s.updateStatus(ctx, (await create(s)).id, "archived")] }),
  ],
  [
    "updateStatusWithEvent",
    async (s) => {
      const m = await create(s);
      return {
        returned: [
          (await s.updateStatusWithEvent(ctx, m.id, "forgotten", {}, event(m.id, "forgotten")))
            .memory,
        ],
      };
    },
  ],
  [
    "setEmbeddingStatus",
    async (s) => ({ returned: [await s.setEmbeddingStatus(ctx, (await create(s)).id, "ready")] }),
  ],
  [
    "reinforce",
    async (s) => ({
      returned: [await s.reinforce(ctx, (await create(s)).id, new Date("2030-01-01"))],
    }),
  ],
  [
    "reinforceMany",
    async (s) => ({
      returned: await s.reinforceMany(ctx, [(await create(s)).id], new Date("2030-01-01")),
    }),
  ],
  [
    "supersedeWithNewMemories",
    async (s) => {
      const old = await create(s);
      counter += 1;
      const r = await s.supersedeWithNewMemories(
        ctx,
        [
          {
            input: buildNewMemoryFixture({
              tenantId: ctx.tenantId,
              contentHash: `snapshot-${counter}`,
              tags: ["original-tag"],
            }),
            jobKinds: [],
          },
        ],
        [{ id: old.id, supersededByIndex: 0, event: event(old.id, "superseded") }],
      );
      return { returned: r.created.map((c) => c.memory) };
    },
  ],
  [
    "purgeMemory",
    async (s) => {
      const m = await create(s);
      await s.updateStatusWithEvent(ctx, m.id, "forgotten", {}, event(m.id, "forgotten"));
      return {
        returned: [
          (
            await s.purgeMemory(
              ctx,
              m.id,
              { content: "[purged]", digest: "[purged]" },
              event(m.id, "purged"),
            )
          ).memory,
        ],
      };
    },
  ],
  [
    "markContestedPair",
    async (s) => {
      const a = await create(s);
      const b = await create(s);
      const r = await s.markContestedPair(
        ctx,
        { id: a.id, event: event(a.id) },
        { id: b.id, event: event(b.id) },
      );
      return { returned: [r.first, r.second] };
    },
  ],
  [
    "resolveContestedPair",
    async (s) => {
      const a = await create(s);
      const b = await create(s);
      await s.markContestedPair(
        ctx,
        { id: a.id, event: event(a.id) },
        { id: b.id, event: event(b.id) },
      );
      const r = await s.resolveContestedPair(
        ctx,
        { id: a.id, status: "active", event: event(a.id) },
        { id: b.id, status: "active", event: event(b.id) },
      );
      return { returned: [r.first, r.second] };
    },
  ],
  [
    "resolveOrphanedContested",
    async (s) => {
      const a = await create(s);
      const b = await create(s);
      await s.markContestedPair(
        ctx,
        { id: a.id, event: event(a.id) },
        { id: b.id, event: event(b.id) },
      );
      await s.updateStatusWithEvent(ctx, b.id, "forgotten", {}, event(b.id, "forgotten"));
      const r = await s.resolveOrphanedContested(ctx, {
        id: a.id,
        contestedWithId: b.id,
        event: event(a.id),
      });
      return { returned: [r.memory] };
    },
  ],
  [
    "findActiveByClaimKey",
    async (s) => {
      const key = { subject: "user", predicate: `p-${counter}` };
      await create(s, { claimKey: key });
      const probe = await create(s);
      return {
        returned: await s.findActiveByClaimKey(ctx, {
          subjectId: null,
          claimKey: key,
          excludeMemoryId: probe.id,
          contentHash: "no-such-hash",
          validFrom: null,
          validUntil: null,
        }),
      };
    },
  ],
  [
    "restoreSupersededBy",
    async (s) => {
      const winner = await create(s);
      const loser = await create(s);
      await s.updateStatus(ctx, loser.id, "superseded", { supersededById: winner.id });
      return {
        returned: (await s.restoreSupersededBy(ctx, winner.id, { at: new Date() })).restored,
      };
    },
  ],
  // 以下は、上の17口の別の分岐と、一覧に無かった口（#1114 の歯の足し）。
  [
    "createMemoryWithOutbox（冪等の再送。created: false）",
    async (s) => {
      const obs = await s.createObservation(ctx, {
        tenantId: ctx.tenantId,
        subjectId: null,
        externalId: null,
        kind: "utterance",
        payload: { text: "x" },
        occurredAt: null,
        recordedAt: new Date(),
      });
      const input = () =>
        buildNewMemoryFixture({
          tenantId: ctx.tenantId,
          contentHash: "snapshot-resend",
          tags: ["original-tag"],
          sourceObservationId: obs.id,
          extractorVersion: "v1",
        });
      await s.createMemoryWithOutbox(ctx, input(), ["embed"]);
      const resent = await s.createMemoryWithOutbox(ctx, input(), ["embed"]);
      expect(resent.created).toBe(false);
      return { returned: [resent.memory] };
    },
  ],
  [
    "setEmbeddingStatus（何もしない分岐。ready → failed）",
    async (s) => {
      const m = await create(s, { embeddingStatus: "ready" });
      return { returned: [await s.setEmbeddingStatus(ctx, m.id, "failed")] };
    },
  ],
  [
    "reinforce（何もしない分岐。起点より古い at）",
    async (s) => ({
      returned: [await s.reinforce(ctx, (await create(s)).id, new Date(0))],
    }),
  ],
  [
    "listBySourceObservationAllVersions",
    async (s) => {
      const obs = await s.createObservation(ctx, {
        tenantId: ctx.tenantId,
        subjectId: null,
        externalId: null,
        kind: "utterance",
        payload: { text: "x" },
        occurredAt: null,
        recordedAt: new Date(),
      });
      await create(s, {
        sourceObservationId: obs.id,
        extractorVersion: "v1",
        provenance: { kind: "stated", sourceObservationId: obs.id, at: "2026-01-01T00:00:00Z" },
      });
      return { returned: await s.listBySourceObservationAllVersions(ctx, obs.id) };
    },
  ],
  [
    "findContestedByClaimKey",
    async (s) => {
      const key = { subject: "user", predicate: `p-contested-${counter}` };
      const a = await create(s, { claimKey: key });
      const b = await create(s, { claimKey: key });
      await s.markContestedPair(
        ctx,
        { id: a.id, event: event(a.id) },
        { id: b.id, event: event(b.id) },
      );
      const probe = await create(s);
      return {
        returned: await s.findContestedByClaimKey(ctx, {
          subjectId: null,
          claimKey: key,
          excludeMemoryId: probe.id,
          contentHash: "no-such-hash",
          validFrom: null,
          validUntil: null,
        }),
      };
    },
  ],
  [
    "markContestedGroup",
    async (s) => {
      const members = [await create(s), await create(s), await create(s)];
      const r = await s.markContestedGroup(
        ctx,
        members.map((m) => ({ id: m.id, event: event(m.id) })),
      );
      return { returned: r.members };
    },
  ],
  [
    "resolveContestedGroup",
    async (s) => {
      const members = [await create(s), await create(s), await create(s)];
      await s.markContestedGroup(
        ctx,
        members.map((m) => ({ id: m.id, event: event(m.id) })),
      );
      const r = await s.resolveContestedGroup(
        ctx,
        members.map((m) => ({ id: m.id, status: "active" as const, event: event(m.id) })),
      );
      return { returned: r.members };
    },
  ],
];

describe("InMemoryMemoryStore の Memory を返す口は、返した時点の複製を返す（Issue #1108）", () => {
  it.each(RETURNERS)("%s", async (_label, returner) => {
    const store = new InMemoryMemoryStore();
    const { returned } = await returner(store);
    expect(returned.length).toBeGreaterThan(0);
    const snapshot = JSON.stringify(returned);

    // (a) 後の書き込み（reinforce は status を問わず lastReinforcedAt を書き換える）で、受け取った値が変わらない。
    for (const memory of returned) {
      await store.reinforce(ctx, memory.id, LATER);
    }
    expect(JSON.stringify(returned)).toBe(snapshot);

    // (b) 受け取った値を書き換えても（入れ子の配列も含めて）、store の中身が変わらない。
    const target = returned[0]!;
    const before = JSON.stringify(await store.get(ctx, target.id));
    (target as { status: string }).status = "mutated-by-caller";
    target.tags.push("mutated-by-caller");
    expect(JSON.stringify(await store.get(ctx, target.id))).toBe(before);
  });
});

describe("InMemoryMemoryStore.createMemory は、呼び手の入力と切り離して保存する（Issue #1108）", () => {
  it("作成の後に呼び手が入力（入れ子の配列・オブジェクト）を書き換えても、保存した値は変わらない", async () => {
    const store = new InMemoryMemoryStore();
    const input = buildNewMemoryFixture({
      tenantId: ctx.tenantId,
      contentHash: "input-detached",
      tags: ["original-tag"],
      attributes: { region: "jp" },
      claimKey: { subject: "user", predicate: "home_city" },
    });
    const created = await store.createMemory(ctx, input);
    const before = JSON.stringify(await store.get(ctx, created.id));

    input.tags.push("mutated-by-caller");
    (input.attributes as Record<string, string>).region = "mutated-by-caller";
    (input.claimKey as { predicate: string }).predicate = "mutated-by-caller";

    expect(JSON.stringify(await store.get(ctx, created.id))).toBe(before);
  });
});
