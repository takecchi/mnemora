import { createHash } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import type { Ctx, EventStore, MemoryStore, Runtime } from "@mnemora/core";
import { createRuntime } from "@mnemora/core";
import { buildNewMemoryFixture, DeterministicLLMProvider } from "@mnemora/testkit";
import {
  InMemoryEventStore,
  InMemoryMemoryStore,
  InMemoryOutboxStore,
  InMemoryTenantSettingsStore,
  InMemoryVectorStore,
} from "@mnemora/testkit/fixtures";
import { PostgresMemoryStore } from "../memory-store.js";
import { PostgresVectorStore } from "../vector-store.js";
import { PostgresEventStore } from "../event-store.js";
import { PostgresOutboxStore } from "../outbox-store.js";
import { PostgresTenantSettingsStore } from "../tenant-settings-store.js";
import {
  closeTestClient,
  getTestClient,
  resetTestDatabase,
  TEST_EMBEDDING_SPACE,
} from "./test-db.js";

/**
 * 大文字の UUID を渡したときに、store が「在る」と言う記憶を「在る」と扱うか。
 *
 * - `PostgresMemoryStore.reinforceMany` は、`reinforce` を1件ずつ呼んだのと同じ結果になる
 *   （`MemoryStore.reinforceMany?` の TSDoc）。`@mnemora/postgres` は大文字の UUID も正しい形として受け付け、
 *   `get`・`reinforce` は同じ記憶を返す。`reinforceMany` も、大文字の UUID で「memory not found」を投げない。
 * - `Runtime.forget`・`restoreArchived`・`purge`・`markContested`: store が返した id と渡された id を
 *   小文字にして突き合わせる。store へ渡す id は変えない。
 * - testkit の fixture の id も、大文字小文字を区別しない。
 *   store ごとの差は store の `get` の差であり、Runtime はそれに従う。
 */
afterAll(async () => {
  await closeTestClient();
});

const upper = (id: string) => id.toUpperCase();
// 最初の英小文字だけを大文字にする——store の id（小文字）とも `upper` とも綴りが違う、同じ記憶の id。
const capitalizeFirstLetter = (id: string) => id.replace(/[a-z]/, (c) => c.toUpperCase());

describe("PostgresMemoryStore.reinforceMany — 大文字の UUID でも reinforce と同じ結果になる", () => {
  async function setup() {
    await resetTestDatabase();
    const { db } = await getTestClient();
    const store = new PostgresMemoryStore(db);
    const ctx: Ctx = { tenantId: "tenant-upper-reinforce" };
    const create = (contentHash: string) =>
      store.createMemory(ctx, buildNewMemoryFixture({ tenantId: ctx.tenantId, contentHash }));
    return { store, ctx, create };
  }

  it("大文字の UUID 1件: 投げず、reinforce と同じ行（小文字の id・書いた lastReinforcedAt）を返す", async () => {
    const { store, ctx, create } = await setup();
    const viaMany = await create("upper-many");
    const viaSingle = await create("upper-single");
    const at = new Date("2026-06-01T00:00:00.000Z");

    const single = await store.reinforce(ctx, upper(viaSingle.id), at);
    const many = await store.reinforceMany!(ctx, [upper(viaMany.id)], at);

    expect(single.id).toBe(viaSingle.id);
    expect(single.lastReinforcedAt?.toISOString()).toBe(at.toISOString());
    expect(many).toHaveLength(1);
    expect(many[0]!.id).toBe(viaMany.id);
    expect(many[0]!.lastReinforcedAt?.toISOString()).toBe(at.toISOString());
    expect(many[0]!.decayFloorAt.toISOString()).toBe(single.decayFloorAt.toISOString());
    expect((await store.get(ctx, viaMany.id))?.lastReinforcedAt?.toISOString()).toBe(
      at.toISOString(),
    );
  });

  it("同じ記憶を小文字と大文字で並べても、同じ長さ・同じ順で、どちらも同じ最終状態の行を返す", async () => {
    const { store, ctx, create } = await setup();
    const memory = await create("upper-mixed");
    const other = await create("upper-mixed-other");
    const at = new Date("2026-06-01T00:00:00.000Z");

    const many = await store.reinforceMany!(
      ctx,
      [memory.id, upper(other.id), upper(memory.id)],
      at,
    );

    expect(many.map((m) => m.id)).toEqual([memory.id, other.id, memory.id]);
    expect(many.map((m) => m.lastReinforcedAt?.toISOString())).toEqual([
      at.toISOString(),
      at.toISOString(),
      at.toISOString(),
    ]);
  });

  it("やりすぎの歯: 小文字の入力の結果は変わらない（存在しない id は今どおり投げる）", async () => {
    const { store, ctx, create } = await setup();
    const memory = await create("lower-only");
    const at = new Date("2026-06-01T00:00:00.000Z");

    const many = await store.reinforceMany!(ctx, [memory.id], at);
    expect(many.map((m) => [m.id, m.lastReinforcedAt?.toISOString()])).toEqual([
      [memory.id, at.toISOString()],
    ]);
    await expect(
      store.reinforceMany!(ctx, ["00000000-0000-4000-8000-000000000000"], at),
    ).rejects.toThrow(/memory not found/);
    await expect(
      store.reinforceMany!(ctx, [upper("00000000-0000-4000-8000-00000000abcd")], at),
    ).rejects.toThrow(/memory not found/);
  });
});

describe("PostgresMemoryStore.markContestedPair — 大文字の UUID でも在る記憶を対にする", () => {
  async function setup() {
    await resetTestDatabase();
    const { db } = await getTestClient();
    const store = new PostgresMemoryStore(db);
    const ctx: Ctx = { tenantId: "tenant-upper-contested" };
    const create = (contentHash: string) =>
      store.createMemory(ctx, buildNewMemoryFixture({ tenantId: ctx.tenantId, contentHash }));
    const side = (id: string, digest: string) => ({
      id,
      event: {
        tenantId: ctx.tenantId,
        memoryId: id,
        kind: "updated" as const,
        actor: { type: "system" as const },
        digestSnapshot: digest,
        meta: { reason: "contested" },
      },
    });
    return { store, ctx, create, side };
  }

  it("大文字の UUID 2件: 投げずに両側を contested にし、相手を互いに指す", async () => {
    const { store, ctx, create, side } = await setup();
    const a = await create("pair-a");
    const b = await create("pair-b");

    const { first, second } = await store.markContestedPair!(
      ctx,
      side(upper(a.id), a.digest),
      side(upper(b.id), b.digest),
    );

    expect([first.id, first.status, first.contestedWithId]).toEqual([a.id, "contested", b.id]);
    expect([second.id, second.status, second.contestedWithId]).toEqual([b.id, "contested", a.id]);
  });

  it("やりすぎの歯: 小文字の入力の結果は変わらない", async () => {
    const { store, ctx, create, side } = await setup();
    const a = await create("pair-lower-a");
    const b = await create("pair-lower-b");

    const { first, second } = await store.markContestedPair!(
      ctx,
      side(a.id, a.digest),
      side(b.id, b.digest),
    );

    expect([first.status, second.status]).toEqual(["contested", "contested"]);
  });

  // ⚠ store の入口で uuid の形の id を小文字にそろえるので、この入力は TSDoc が約束する「同じ id なら RangeError」を
  // 投げる（「memory not found」の `Error` ではない）。投げる入力の集合は増えない（`uppercase-uuid-store-entry.postgres.test.ts`）。
  it("投げる入力を増やさない: 同じ記憶を小文字と大文字で渡すと、TSDoc どおり RangeError を投げ、何も書かない", async () => {
    const { store, ctx, create, side } = await setup();
    const a = await create("pair-self");

    const error = await store.markContestedPair!(
      ctx,
      side(a.id, a.digest),
      side(upper(a.id), a.digest),
    ).then(
      () => null,
      (e: unknown) => e,
    );

    expect(error).toBeInstanceOf(RangeError);
    expect((error as Error).message).toMatch(/must differ/);
    expect((await store.get(ctx, a.id))?.status).toBe("active");
  });
});

interface Kit {
  runtime: Runtime;
  memoryStore: MemoryStore;
  eventStore: EventStore;
  /** 大文字の UUID の記憶を「在る」と言う store か（`get(大文字)` が記憶を返すか）。 */
  caseInsensitive: boolean;
}

const shared = {
  llmProvider: new DeterministicLLMProvider(),
  embeddingProvider: {
    space: TEST_EMBEDDING_SPACE,
    embed: async (_ctx: Ctx, texts: string[]) => texts.map(() => [1, 0, 0]),
  },
  hashContent: (content: string) => createHash("sha256").update(content).digest("hex"),
};

const KITS: Array<[string, () => Promise<Kit>]> = [
  [
    "testkit の fixture",
    async () => {
      const memoryStore = new InMemoryMemoryStore();
      const eventStore = new InMemoryEventStore(memoryStore, memoryStore.events);
      return {
        memoryStore,
        eventStore,
        caseInsensitive: true, // ADR 0521: fixture も大文字小文字を区別しない（以前は false）
        runtime: createRuntime({
          ...shared,
          memoryStore,
          vectorStore: new InMemoryVectorStore(memoryStore),
          eventStore,
          outboxStore: new InMemoryOutboxStore(memoryStore.outboxJobs),
          tenantSettingsStore: new InMemoryTenantSettingsStore(memoryStore.activitySeq),
        }),
      };
    },
  ],
  [
    "Postgres",
    async () => {
      await resetTestDatabase();
      const { db } = await getTestClient();
      const memoryStore = new PostgresMemoryStore(db);
      const eventStore = new PostgresEventStore(db);
      return {
        memoryStore,
        eventStore,
        caseInsensitive: true,
        runtime: createRuntime({
          ...shared,
          memoryStore,
          vectorStore: new PostgresVectorStore(db),
          eventStore,
          outboxStore: new PostgresOutboxStore(db),
          tenantSettingsStore: new PostgresTenantSettingsStore(db),
        }),
      };
    },
  ],
];

describe.each(KITS)(
  "Runtime は大文字の id を store の get に従って扱う（%s）",
  (_name, makeKit) => {
    const ctx: Ctx = { tenantId: "tenant-upper-runtime" };
    const create = (kit: Kit, contentHash: string, status?: "archived" | "forgotten") =>
      kit.memoryStore.createMemory(
        ctx,
        buildNewMemoryFixture({
          tenantId: ctx.tenantId,
          contentHash,
          ...(status ? { status } : {}),
        }),
      );

    it("前提: store の get は、大文字の id について caseInsensitive のとおりに答える", async () => {
      const kit = await makeKit();
      const memory = await create(kit, "premise");
      const got = await kit.memoryStore.get(ctx, upper(memory.id));
      expect(got?.id ?? null).toBe(kit.caseInsensitive ? memory.id : null);
    });

    it("forget: 大文字の id でも、store が在ると言う記憶は forgotten になり、イベントが1件積まれる", async () => {
      const kit = await makeKit();
      const memory = await create(kit, "forget-upper");

      const result = await kit.runtime.forget(ctx, { memoryIds: [upper(memory.id)] });

      const events = await kit.eventStore.list(ctx, { memoryId: memory.id, kind: "forgotten" });
      const after = await kit.memoryStore.get(ctx, memory.id);
      if (kit.caseInsensitive) {
        expect(result.outcomes).toEqual([
          { memoryId: upper(memory.id), kind: "forgotten", previousStatus: "active" },
        ]);
        expect(after?.status).toBe("forgotten");
        expect(events).toHaveLength(1);
      } else {
        expect(result.outcomes).toEqual([{ memoryId: upper(memory.id), kind: "not_found" }]);
        expect(after?.status).toBe("active");
        expect(events).toHaveLength(0);
      }
    });

    it("やりすぎの歯: 大文字小文字だけが違う id を同じ呼び出しに混ぜると、渡された文字列どおりに突き合わせる（大文字の側は今どおり not_found）", async () => {
      const kit = await makeKit();
      const memory = await create(kit, "forget-mixed");

      const result = await kit.runtime.forget(ctx, { memoryIds: [memory.id, upper(memory.id)] });

      // getMany の戻りだけでは「store がどちらも在ると言った」と「片方だけ在ると言った」を区別できない
      // （fixture の `mem-3` と `MEM-3`）。⟹ 両方の store で、そろえる前と同じ結果にとどめる。
      expect(result.outcomes).toEqual([
        { memoryId: memory.id, kind: "forgotten", previousStatus: "active" },
        { memoryId: upper(memory.id), kind: "not_found" },
      ]);
      const events = await kit.eventStore.list(ctx, { memoryId: memory.id, kind: "forgotten" });
      expect(events).toHaveLength(1);
    });

    it("やりすぎの歯: 混ぜたときに not_found になるのは、並びの位置ではなく store の id と綴りが違う側である（大文字を先に渡しても大文字の側）", async () => {
      const kit = await makeKit();
      const memory = await create(kit, "forget-mixed-upper-first");

      const result = await kit.runtime.forget(ctx, { memoryIds: [upper(memory.id), memory.id] });

      expect(result.outcomes).toEqual([
        { memoryId: upper(memory.id), kind: "not_found" },
        { memoryId: memory.id, kind: "forgotten", previousStatus: "active" },
      ]);
      const events = await kit.eventStore.list(ctx, { memoryId: memory.id, kind: "forgotten" });
      expect(events).toHaveLength(1);
    });

    it("やりすぎの歯: 混ぜたどの綴りも store の id と違えば、全部が not_found になり、何も書かない", async () => {
      const kit = await makeKit();
      const memory = await create(kit, "forget-mixed-no-exact");
      const capitalized = capitalizeFirstLetter(memory.id);
      expect([capitalized === memory.id, capitalized === upper(memory.id)]).toEqual([false, false]);

      const result = await kit.runtime.forget(ctx, {
        memoryIds: [capitalized, upper(memory.id)],
      });

      expect(result.outcomes).toEqual([
        { memoryId: capitalized, kind: "not_found" },
        { memoryId: upper(memory.id), kind: "not_found" },
      ]);
      expect((await kit.memoryStore.get(ctx, memory.id))?.status).toBe("active");
    });

    it("やりすぎの歯: forget の小文字の入力の結果は変わらない", async () => {
      const kit = await makeKit();
      const memory = await create(kit, "forget-lower");

      const result = await kit.runtime.forget(ctx, { memoryIds: [memory.id] });

      expect(result.outcomes).toEqual([
        { memoryId: memory.id, kind: "forgotten", previousStatus: "active" },
      ]);
    });

    it("restoreArchived: 大文字の id でも、store が在ると言う archived の記憶は restored になる", async () => {
      const kit = await makeKit();
      const memory = await create(kit, "restore-upper", "archived");

      const result = await kit.runtime.restoreArchived(ctx, { memoryIds: [upper(memory.id)] });

      const after = await kit.memoryStore.get(ctx, memory.id);
      if (kit.caseInsensitive) {
        expect(result.outcomes.map((o) => [o.memoryId, o.kind])).toEqual([
          [upper(memory.id), "restored"],
        ]);
        expect(after?.status).toBe("active");
      } else {
        expect(result.outcomes).toEqual([{ memoryId: upper(memory.id), kind: "not_found" }]);
        expect(after?.status).toBe("archived");
      }
    });

    it("purge: 大文字の id でも、store が在ると言う forgotten の記憶は purged になる", async () => {
      const kit = await makeKit();
      const memory = await create(kit, "purge-upper", "forgotten");

      const result = await kit.runtime.purge(ctx, { memoryIds: [upper(memory.id)] });

      const after = await kit.memoryStore.get(ctx, memory.id);
      if (kit.caseInsensitive) {
        expect(result.outcomes).toEqual([
          { memoryId: upper(memory.id), kind: "purged", previousStatus: "forgotten" },
        ]);
        expect(after?.purgedAt).not.toBeNull();
      } else {
        expect(result.outcomes).toEqual([{ memoryId: upper(memory.id), kind: "not_found" }]);
        expect(after?.purgedAt ?? null).toBeNull();
      }
    });

    it("markContested: 大文字の id でも、store が在ると言う2件は contested になる", async () => {
      const kit = await makeKit();
      const first = await create(kit, "contested-first");
      const second = await create(kit, "contested-second");

      const result = await kit.runtime.markContested(ctx, upper(first.id), upper(second.id));

      const statuses = [
        (await kit.memoryStore.get(ctx, first.id))?.status,
        (await kit.memoryStore.get(ctx, second.id))?.status,
      ];
      if (kit.caseInsensitive) {
        expect(result.outcome.kind).toBe("contested");
        expect(statuses).toEqual(["contested", "contested"]);
      } else {
        expect(result.outcome).toEqual({
          kind: "ineligible",
          sides: [
            { memoryId: upper(first.id), kind: "not_found" },
            { memoryId: upper(second.id), kind: "not_found" },
          ],
        });
        expect(statuses).toEqual(["active", "active"]);
      }
    });

    it("markContested: 同じ記憶を小文字と大文字で渡しても、投げずに今どおり ineligible を返し、何も書かない", async () => {
      const kit = await makeKit();
      const memory = await create(kit, "contested-self");

      const result = await kit.runtime.markContested(ctx, memory.id, upper(memory.id));

      expect(result.outcome).toEqual({
        kind: "ineligible",
        sides: [
          { memoryId: memory.id, kind: "eligible" },
          { memoryId: upper(memory.id), kind: "not_found" },
        ],
      });
      expect((await kit.memoryStore.get(ctx, memory.id))?.status).toBe("active");
    });

    it("markContested: 大文字を先に渡しても、not_found になるのは大文字の側である（位置によらない。TSDoc の手順3）", async () => {
      const kit = await makeKit();
      const memory = await create(kit, "contested-self-upper-first");

      const result = await kit.runtime.markContested(ctx, upper(memory.id), memory.id);

      expect(result.outcome).toEqual({
        kind: "ineligible",
        sides: [
          { memoryId: upper(memory.id), kind: "not_found" },
          { memoryId: memory.id, kind: "eligible" },
        ],
      });
      expect((await kit.memoryStore.get(ctx, memory.id))?.status).toBe("active");
    });

    it("markContested: どちらの側も store の id と綴りが違えば、両側とも not_found（TSDoc の手順3）", async () => {
      const kit = await makeKit();
      const memory = await create(kit, "contested-self-no-exact");
      const capitalized = capitalizeFirstLetter(memory.id);
      expect([capitalized === memory.id, capitalized === upper(memory.id)]).toEqual([false, false]);

      const result = await kit.runtime.markContested(ctx, capitalized, upper(memory.id));

      expect(result.outcome).toEqual({
        kind: "ineligible",
        sides: [
          { memoryId: capitalized, kind: "not_found" },
          { memoryId: upper(memory.id), kind: "not_found" },
        ],
      });
      expect((await kit.memoryStore.get(ctx, memory.id))?.status).toBe("active");
    });
  },
);
