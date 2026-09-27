// クローン miku の委譲先が書いた回帰テスト。オーナーではない。
//
// `InMemoryMemoryStore` にトランザクションは無く、「まだ何も書いていないうちに投げる」ことで
// `packages/postgres` の1トランザクションを模す（クラス doc と各メソッドの doc）。ここでは、
// 書き始めた後に投げる経路が残っていないことを見る——投げたら、Memory・outbox・ラベル・
// イベントのどれも、呼ぶ前と同じであること。
//
// `packages/postgres` の側は、最後の書き込みを DB に失敗させても何も残らないことを
// `packages/postgres/src/__tests__/store-write-atomicity.postgres.test.ts` が縛っている。
//
// このテストは fixture を直接呼ぶだけで、`*-conformance.ts` には触れていない（Issue #809）。

import { describe, expect, it } from "vitest";
import type { Ctx, MemoryId, NewMemoryEvent, ObservationId } from "@mnemora/core";
import { buildNewMemoryFixture } from "../test-data.js";
import { InMemoryMemoryStore } from "../__fixtures__/in-memory-memory-store.js";

const ctx: Ctx = { tenantId: "no-partial-write" };
let seq = 0;

/** structuredClone できない値（Postgres は JSON にするときに欄ごと落とす。#1211 の表の外）。 */
const uncloneable = { f: () => 1 };

function event(memoryId: MemoryId, kind: NewMemoryEvent["kind"], meta: object = {}): NewMemoryEvent {
  return { memoryId, kind, actor: { type: "system" }, meta } as NewMemoryEvent;
}

async function memory(store: InMemoryMemoryStore, over: object = {}) {
  seq += 1;
  return store.createMemory(
    ctx,
    buildNewMemoryFixture({
      content: `content ${seq}`,
      contentHash: `hash-${seq}`,
      tags: [`tag-${seq}`],
      ...over,
    } as never),
  );
}

/** 呼ぶ前と後で比べる、store の中身の写し（プリミティブへ写し取る）。 */
async function stateOf(store: InMemoryMemoryStore): Promise<string> {
  return JSON.stringify({
    memories: store
      .listByTenant(ctx)
      .map((m) => [m.id, m.status, m.content, m.digest, m.supersededById, m.contestedWithId])
      .sort(),
    outbox: store.outboxJobs.length,
    events: store.events.length,
    labels: await store.listLabels(ctx),
  });
}

describe("InMemoryMemoryStore: 途中で投げても、書いた分を残さない（Postgres の1トランザクションと同じ）", () => {
  describe("supersedeWithNewMemories: news の2件目が書けないとき、1件目の Memory・outbox・ラベルも残さない", () => {
    for (const [label, bad] of [
      ["本文に NUL", { content: "bad\u0000" }],
      [
        "元の Observation が無い",
        { sourceObservationId: "00000000-0000-4000-8000-000000000000" as ObservationId },
      ],
    ] as const) {
      it(label, async () => {
        const store = new InMemoryMemoryStore();
        const old = await memory(store);
        const before = await stateOf(store);
        await expect(
          store.supersedeWithNewMemories(
            ctx,
            [
              {
                input: buildNewMemoryFixture({ content: "new 1", contentHash: "new-1", tags: ["fresh"] } as never),
                jobKinds: ["embed"],
              },
              {
                input: buildNewMemoryFixture({ content: "new 2", contentHash: "new-2", ...bad } as never),
                jobKinds: ["embed"],
              },
            ],
            [{ id: old.id, supersededByIndex: 0, expectedStatus: "active", event: event(old.id, "superseded") }],
          ),
        ).rejects.toThrow();
        expect(await stateOf(store)).toBe(before);
      });
    }

    it("陽性対照: 2件とも書けるなら、両方と outbox・ラベル・イベントが書かれる", async () => {
      const store = new InMemoryMemoryStore();
      const old = await memory(store);
      const before = await stateOf(store);
      await store.supersedeWithNewMemories(
        ctx,
        [
          {
            input: buildNewMemoryFixture({ content: "new 1", contentHash: "new-1", tags: ["fresh"] } as never),
            jobKinds: ["embed"],
          },
          { input: buildNewMemoryFixture({ content: "new 2", contentHash: "new-2" } as never), jobKinds: ["embed"] },
        ],
        [{ id: old.id, supersededByIndex: 0, expectedStatus: "active", event: event(old.id, "superseded") }],
      );
      expect(await stateOf(store)).not.toBe(before);
      expect(store.listByTenant(ctx)).toHaveLength(3);
      expect(store.outboxJobs).toHaveLength(2);
    });
  });

  describe("イベントの meta が structuredClone できないとき、状態を書き換えない", () => {
    it("updateStatusWithEvent", async () => {
      const store = new InMemoryMemoryStore();
      const m = await memory(store);
      const before = await stateOf(store);
      await expect(
        store.updateStatusWithEvent(ctx, m.id, "forgotten", { expectedStatus: "active" }, event(m.id, "forgotten", uncloneable)),
      ).rejects.toThrow();
      expect(await stateOf(store)).toBe(before);
    });

    it("supersedeWithNewMemories（supersede 側のイベント）", async () => {
      const store = new InMemoryMemoryStore();
      const old = await memory(store);
      const before = await stateOf(store);
      await expect(
        store.supersedeWithNewMemories(
          ctx,
          [{ input: buildNewMemoryFixture({ content: "new", contentHash: "new" } as never), jobKinds: ["embed"] }],
          [{ id: old.id, supersededByIndex: 0, expectedStatus: "active", event: event(old.id, "superseded", uncloneable) }],
        ),
      ).rejects.toThrow();
      expect(await stateOf(store)).toBe(before);
    });

    it("投げる入力は増やさない: CAS に弾かれてイベントを書かない対象なら、meta が写せなくても今までどおり conflicted で返る", async () => {
      const store = new InMemoryMemoryStore();
      const old = await memory(store);
      await store.updateStatus(ctx, old.id, "forgotten");
      const result = await store.supersedeWithNewMemories(
        ctx,
        [{ input: buildNewMemoryFixture({ content: "new", contentHash: "new" } as never), jobKinds: [] }],
        [{ id: old.id, supersededByIndex: 0, expectedStatus: "active", event: event(old.id, "superseded", uncloneable) }],
      );
      expect(result.conflicted).toEqual([{ id: old.id, observedStatus: "forgotten" }]);
    });

    it("markContestedPair（2件目のイベント）", async () => {
      const store = new InMemoryMemoryStore();
      const a = await memory(store);
      const b = await memory(store);
      const before = await stateOf(store);
      await expect(
        store.markContestedPair(ctx, { id: a.id, event: event(a.id, "updated") }, { id: b.id, event: event(b.id, "updated", uncloneable) }),
      ).rejects.toThrow();
      expect(await stateOf(store)).toBe(before);
    });

    it("resolveContestedPair（2件目のイベント）", async () => {
      const store = new InMemoryMemoryStore();
      const a = await memory(store);
      const b = await memory(store);
      await store.markContestedPair(ctx, { id: a.id, event: event(a.id, "updated") }, { id: b.id, event: event(b.id, "updated") });
      const before = await stateOf(store);
      await expect(
        store.resolveContestedPair(
          ctx,
          { id: a.id, status: "active", event: event(a.id, "updated") },
          { id: b.id, status: "superseded", supersededById: a.id, event: event(b.id, "superseded", uncloneable) },
        ),
      ).rejects.toThrow();
      expect(await stateOf(store)).toBe(before);
    });

    it("resolveOrphanedContested", async () => {
      const store = new InMemoryMemoryStore();
      const a = await memory(store);
      const b = await memory(store);
      await store.markContestedPair(ctx, { id: a.id, event: event(a.id, "updated") }, { id: b.id, event: event(b.id, "updated") });
      const before = await stateOf(store);
      await expect(
        store.resolveOrphanedContested(ctx, { id: a.id, contestedWithId: b.id, event: event(a.id, "updated", uncloneable) }),
      ).rejects.toThrow();
      expect(await stateOf(store)).toBe(before);
    });

    it("purgeMemory", async () => {
      const store = new InMemoryMemoryStore();
      const m = await memory(store);
      await store.updateStatus(ctx, m.id, "forgotten");
      const before = await stateOf(store);
      await expect(
        store.purgeMemory(ctx, m.id, { content: "[purged]", digest: "[purged]" }, event(m.id, "purged", uncloneable)),
      ).rejects.toThrow();
      expect(await stateOf(store)).toBe(before);
    });
  });

  describe("restoreSupersededBy: イベントが書けないとき、1件目も戻さない", () => {
    for (const [label, ev] of [
      ["at が Invalid Date", { at: new Date(Number.NaN) }],
      ["actor が structuredClone できない", { at: new Date(), actor: { type: "system", ...uncloneable } }],
    ] as const) {
      it(label, async () => {
        const store = new InMemoryMemoryStore();
        const anchor = await memory(store);
        for (let i = 0; i < 2; i++) {
          const m = await memory(store);
          await store.updateStatus(ctx, m.id, "superseded", { supersededById: anchor.id });
        }
        const before = await stateOf(store);
        await expect(store.restoreSupersededBy(ctx, anchor.id, ev as never)).rejects.toThrow();
        expect(await stateOf(store)).toBe(before);
      });
    }

    it("投げる入力は増やさない: 戻す対象が無ければ、at が Invalid Date でも今までどおり空で返る（Postgres は拒む）", async () => {
      const store = new InMemoryMemoryStore();
      const anchor = await memory(store);
      await expect(store.restoreSupersededBy(ctx, anchor.id, { at: new Date(Number.NaN) })).resolves.toEqual({
        restored: [],
      });
    });

    it("陽性対照: イベントが書けるなら、2件とも戻す", async () => {
      const store = new InMemoryMemoryStore();
      const anchor = await memory(store);
      for (let i = 0; i < 2; i++) {
        const m = await memory(store);
        await store.updateStatus(ctx, m.id, "superseded", { supersededById: anchor.id });
      }
      const { restored } = await store.restoreSupersededBy(ctx, anchor.id, { at: new Date() });
      expect(restored).toHaveLength(2);
      expect(store.events).toHaveLength(2);
    });
  });
});
