import { describe, expect, it } from "vitest";
import type { Ctx, NewMemory, NewMemoryEvent } from "@mnemora/core";
import { InMemoryEventStore } from "../__fixtures__/in-memory-event-store.js";
import { InMemoryMemoryStore } from "../__fixtures__/in-memory-memory-store.js";
import { buildNewMemoryFixture, buildNewObservationFixture } from "../test-data.js";

/**
 * `memories` の列挙の列（`status`・`digest_source`・`embedding_status`・`provenance_kind`）に型の列挙に
 * 無い値を渡すと、testkit の fixture も Postgres と同じく拒み、何も書かない。Postgres は CHECK 制約
 * （`memories_status_check` など）で拒む。
 *
 * 2実装を並べた歯は `packages/postgres/src/__tests__/memories-enum-check.postgres.test.ts`
 * （DB が要る）。ここは DB 無しで走る側の歯である。
 */

const ctx: Ctx = { tenantId: "memory-enum-check" };

/** 型を外した呼び出しを模す（列挙に無い値）。 */
const BOGUS = "bogus" as never;

function event(memoryId: string): NewMemoryEvent {
  return { tenantId: ctx.tenantId, memoryId, kind: "updated", actor: { type: "system" }, meta: {} };
}

function build() {
  const memoryStore = new InMemoryMemoryStore();
  const eventStore = new InMemoryEventStore(memoryStore, memoryStore.events);
  return { memoryStore, eventStore };
}

describe("testkit の fixture は memories の列挙の列に無い値を拒む", () => {
  const createCases: Array<[string, Partial<NewMemory>, RegExp]> = [
    [
      "status",
      { status: BOGUS },
      /^memories\.status must be one of active, superseded, contested, archived, forgotten \(got "bogus"\)$/,
    ],
    [
      "digestSource",
      { digestSource: BOGUS },
      /^memories\.digest_source must be one of llm, fallback \(got "bogus"\)$/,
    ],
    [
      "embeddingStatus",
      { embeddingStatus: BOGUS },
      /^memories\.embedding_status must be one of pending, ready, failed, skipped \(got "bogus"\)$/,
    ],
    [
      "provenance.kind",
      { provenance: { kind: BOGUS } },
      /^memories\.provenance_kind must be one of stated, inferred, consolidated, reflected, imported \(got "bogus"\)$/,
    ],
  ];
  for (const [field, override, message] of createCases) {
    it(`createMemory・createMemoryWithOutbox は列挙に無い ${field} を拒み、何も書かない`, async () => {
      const { memoryStore } = build();
      // 冪等の鍵（観測・抽出器の版・contentHash）を持たせ、何も書いていないことを「同じ鍵の正しい
      // 入力が新しく作られる（created: true）」で確かめる。
      const observation = await memoryStore.createObservation(
        ctx,
        buildNewObservationFixture({ tenantId: ctx.tenantId }),
      );
      const valid = buildNewMemoryFixture({
        tenantId: ctx.tenantId,
        contentHash: `enum-${field}`,
        sourceObservationId: observation.id,
        extractorVersion: "v1",
      });
      const input = { ...valid, ...override };

      await expect(memoryStore.createMemory(ctx, input)).rejects.toThrow(message);
      await expect(memoryStore.createMemoryWithOutbox(ctx, input, ["embed"])).rejects.toThrow(
        message,
      );

      expect(memoryStore.outboxJobs).toHaveLength(0);
      const retried = await memoryStore.createMemoryWithOutbox(ctx, valid, ["embed"]);
      expect(retried.created).toBe(true);
    });
  }

  it("updateStatus・updateStatusWithEvent は拒み、状態もイベントも変えない", async () => {
    const { memoryStore } = build();
    const m = await memoryStore.createMemory(
      ctx,
      buildNewMemoryFixture({ tenantId: ctx.tenantId, contentHash: "enum-update" }),
    );

    await expect(memoryStore.updateStatus(ctx, m.id, BOGUS)).rejects.toThrow(
      /^memories\.status must be one of /,
    );
    await expect(
      memoryStore.updateStatusWithEvent(ctx, m.id, BOGUS, {}, event(m.id)),
    ).rejects.toThrow(/^memories\.status must be one of /);

    expect(await memoryStore.get(ctx, m.id)).toEqual(m);
    expect(memoryStore.events).toHaveLength(0);
  });

  it("見つからない id・CAS の食い違いは、列挙の検査より先に決まる（Postgres は更新する行が無ければ CHECK に届かない）", async () => {
    const { memoryStore } = build();
    const m = await memoryStore.createMemory(
      ctx,
      buildNewMemoryFixture({ tenantId: ctx.tenantId, contentHash: "enum-order" }),
    );

    await expect(memoryStore.updateStatus(ctx, "mem-missing", BOGUS)).rejects.toThrow(
      /memory not found/,
    );
    await expect(
      memoryStore.updateStatus(ctx, m.id, BOGUS, { expectedStatus: "archived" }),
    ).rejects.toMatchObject({ name: "MemoryStatusConflictError" });
    await expect(memoryStore.setEmbeddingStatus(ctx, "mem-missing", BOGUS)).rejects.toThrow(
      /memory not found/,
    );
  });

  it("setEmbeddingStatus は拒み、状態を変えない", async () => {
    const { memoryStore } = build();
    const m = await memoryStore.createMemory(
      ctx,
      buildNewMemoryFixture({ tenantId: ctx.tenantId, contentHash: "enum-embedding" }),
    );

    await expect(memoryStore.setEmbeddingStatus(ctx, m.id, BOGUS)).rejects.toThrow(
      /^memories\.embedding_status must be one of /,
    );

    expect(await memoryStore.get(ctx, m.id)).toEqual(m);
  });

  it("resolveContestedPair は拒み、2件とも contested のまま残し、イベントも書かない", async () => {
    const { memoryStore } = build();
    const a = await memoryStore.createMemory(
      ctx,
      buildNewMemoryFixture({ tenantId: ctx.tenantId, contentHash: "enum-pair-a" }),
    );
    const b = await memoryStore.createMemory(
      ctx,
      buildNewMemoryFixture({ tenantId: ctx.tenantId, contentHash: "enum-pair-b" }),
    );
    await memoryStore.markContestedPair(
      ctx,
      { id: a.id, event: event(a.id) },
      { id: b.id, event: event(b.id) },
    );
    const eventsBefore = memoryStore.events.length;

    await expect(
      memoryStore.resolveContestedPair(
        ctx,
        { id: a.id, status: "active", event: event(a.id) },
        { id: b.id, status: BOGUS, event: event(b.id) },
      ),
      // ADR 0499 で、列挙の検査より手前に resolveContestedPair 固有の検査（"active" か
      // "superseded" か）が入った。列挙の外の値はそちらで先に断られる。
    ).rejects.toThrow(/^resolveContestedPair: second\.status must be "active" or "superseded"/);

    expect((await memoryStore.get(ctx, a.id))?.status).toBe("contested");
    expect((await memoryStore.get(ctx, b.id))?.status).toBe("contested");
    expect(memoryStore.events).toHaveLength(eventsBefore);
  });
});
