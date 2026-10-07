import { afterEach, describe, expect, it, vi } from "vitest";
import type { Ctx, NewMemoryEvent } from "@mnemora/core";
import { buildNewMemoryFixture, buildNewObservationFixture } from "../test-data.js";
import { InMemoryMemoryStore } from "../__fixtures__/in-memory-memory-store.js";

/** 適合テストは持ち主のテナント側から見て無傷であることしか見ない。InMemory 固有の余計な書き込み（失敗の前に別テナントの行の `updatedAt` を書く、呼んだ側の履歴にイベントを積む）はここで縛り、適合テストには足さない。 */

const ctxA: Ctx = { tenantId: "tenant-a" };
const ctxB: Ctx = { tenantId: "tenant-b" };
const NOT_FOUND = /memory not found for tenant/;

afterEach(() => {
  vi.useRealTimers();
});

function eventsFor(store: InMemoryMemoryStore, memoryId: string): unknown[] {
  return store.events.filter((e) => e.memoryId === memoryId);
}

describe("InMemoryMemoryStore — 別テナントの行を対象にした失敗は、何も書かない", () => {
  it("setEmbeddingStatus: 別テナントの呼び出しが失敗しても、持ち主の行は updatedAt を含めて丸ごと変わらない", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const store = new InMemoryMemoryStore();
    const memoryA = await store.createMemory(
      ctxA,
      buildNewMemoryFixture({ tenantId: ctxA.tenantId, embeddingStatus: "pending" }),
    );
    const before = await store.get(ctxA, memoryA.id);

    // 時計を進めてから呼ぶ（余計な書き込みが `updatedAt` に現れるように）。
    vi.setSystemTime(new Date("2026-01-02T00:00:00.000Z"));
    await expect(store.setEmbeddingStatus(ctxB, memoryA.id, "ready")).rejects.toThrow(NOT_FOUND);

    expect(await store.get(ctxA, memoryA.id)).toEqual(before);
  });

  it("updateStatusWithEvent: 別テナントの呼び出しが失敗しても、呼んだ側（B）のテナントの履歴にもイベントが積まれない", async () => {
    const store = new InMemoryMemoryStore();
    const memoryA = await store.createMemory(
      ctxA,
      buildNewMemoryFixture({ tenantId: ctxA.tenantId }),
    );
    const event: NewMemoryEvent = {
      tenantId: ctxB.tenantId,
      memoryId: memoryA.id,
      kind: "archived",
      actor: { type: "system" },
      digestSnapshot: memoryA.digest,
      sizeBeforeBytes: null,
      meta: {},
    };
    const eventsBefore = store.events.length;

    await expect(
      store.updateStatusWithEvent(ctxB, memoryA.id, "archived", {}, event),
    ).rejects.toThrow(NOT_FOUND);

    expect(eventsFor(store, memoryA.id)).toEqual([]);
    expect(store.events.length).toBe(eventsBefore);
    expect((await store.get(ctxA, memoryA.id))?.status).toBe("active");
  });

  it("supersedeWithNewMemories: 別テナントの行を対象にして失敗しても、B 側にもイベントが積まれない。expectedStatus 付きでも conflicted にならず例外", async () => {
    const store = new InMemoryMemoryStore();
    const oldA = await store.createMemory(
      ctxA,
      buildNewMemoryFixture({ tenantId: ctxA.tenantId, contentHash: "xt-old-a" }),
    );
    const observation = await store.createObservation(
      ctxB,
      buildNewObservationFixture({ tenantId: ctxB.tenantId }),
    );
    const newsInput = buildNewMemoryFixture({
      tenantId: ctxB.tenantId,
      sourceObservationId: observation.id,
      extractorVersion: "xt-supersede-v1",
      contentHash: "xt-new-b",
    });
    const eventsBefore = store.events.length;

    for (const expectedStatus of [undefined, "active" as const]) {
      await expect(
        store.supersedeWithNewMemories!(
          ctxB,
          [{ input: newsInput, jobKinds: [] }],
          [
            {
              id: oldA.id,
              supersededByIndex: 0,
              ...(expectedStatus === undefined ? {} : { expectedStatus }),
              event: {
                tenantId: ctxB.tenantId,
                memoryId: oldA.id,
                kind: "superseded",
                actor: { type: "system" },
                digestSnapshot: oldA.digest,
                sizeBeforeBytes: null,
                meta: { reason: "xt-test" },
              },
            },
          ],
        ),
      ).rejects.toThrow(NOT_FOUND);
    }

    expect(eventsFor(store, oldA.id)).toEqual([]);
    expect(store.events.length).toBe(eventsBefore);
    expect((await store.get(ctxA, oldA.id))?.status).toBe("active");
  });
});

describe("InMemoryMemoryStore.registerLabel — 冪等（registeredAt を上書きしない。ADR 0318 約束4。Issue #1775 の #717 の変異15）", () => {
  it("2回目の registerLabel は、時計が進んでいても registeredAt を1回目のまま返す", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const store = new InMemoryMemoryStore();
    const first = await store.registerLabel(ctxA, "alpha");

    vi.setSystemTime(new Date("2026-01-02T00:00:00.000Z"));
    const second = await store.registerLabel(ctxA, "alpha");

    expect(first.registeredAt?.toISOString()).toBe("2026-01-01T00:00:00.000Z");
    expect(second.registeredAt?.toISOString()).toBe("2026-01-01T00:00:00.000Z");
  });
});
