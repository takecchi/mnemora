import { createHash } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import type { Ctx, EventStore, MemoryStore, Runtime } from "@mnemora/core";
import { createRuntime, MemoryStatusConflictError } from "@mnemora/core";
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
 * `@mnemora/postgres` の store は、入口で uuid の形の id を小文字にそろえる（store の中の正規化。Runtime から
 * 渡す値は変えない）。DB は uuid を大文字小文字を区別せずに比べて小文字で返すので、JS で id を比べる箇所・
 * 渡された id を記録に写す箇所が、大文字の UUID だけで食い違っていた。
 *
 * - `resolveContestedPair`: 渡された id のまま Map を引き、`contested_with_id` と比べていた → 「memory not found」
 *   か `MemoryStatusConflictError`。
 * - `markContestedPair`: 同じ行を小文字と大文字で渡すと、TSDoc が約束する `RangeError`（同じ id）にならず
 *   「memory not found」（`Error`）だった。
 * - `restoreSupersededBy`: `meta.supersededById` に渡された値をそのまま写していた（列の値は小文字）。
 * - `resolveOrphanedContested`: 形の崩れた `contestedWithId` で DB の例外（uuid への型変換）が漏れていた
 *   （TSDoc は `MemoryStatusConflictError` を約束する。core の Fake はそうなっている）。
 *
 * Runtime の `consolidate`・`reflect` の `{ memoryIds }`・`{ seedMemoryId }` は、`#1324` の `forget` と同じ形で
 * 鍵をそろえる。testkit の fixture の id は大文字小文字を区別するので、fixture では大文字は今どおり `not_found`。
 */
afterAll(async () => {
  await closeTestClient();
});

const upper = (id: string) => id.toUpperCase();

async function pgStore() {
  await resetTestDatabase();
  const { db } = await getTestClient();
  return { store: new PostgresMemoryStore(db), eventStore: new PostgresEventStore(db) };
}

const updatedEvent = (ctx: Ctx, memoryId: string, meta: Record<string, unknown> = {}) => ({
  tenantId: ctx.tenantId,
  memoryId,
  kind: "updated" as const,
  actor: { type: "system" as const },
  digestSnapshot: "d",
  meta,
});

describe("PostgresMemoryStore.resolveContestedPair — 大文字の UUID でも対を解決する", () => {
  async function contestedPair(tenantId: string) {
    const { store } = await pgStore();
    const ctx: Ctx = { tenantId };
    const a = await store.createMemory(ctx, buildNewMemoryFixture({ tenantId, contentHash: "a" }));
    const b = await store.createMemory(ctx, buildNewMemoryFixture({ tenantId, contentHash: "b" }));
    await store.markContestedPair!(
      ctx,
      { id: a.id, event: updatedEvent(ctx, a.id) },
      { id: b.id, event: updatedEvent(ctx, b.id) },
    );
    return { store, ctx, a, b };
  }

  it("大文字の UUID 2件（supersede）: 投げずに解決し、敗者の superseded_by_id は勝者を指す", async () => {
    const { store, ctx, a, b } = await contestedPair("tenant-upper-resolve");

    const { first, second } = await store.resolveContestedPair!(
      ctx,
      { id: upper(a.id), status: "active", event: updatedEvent(ctx, upper(a.id)) },
      {
        id: upper(b.id),
        status: "superseded",
        supersededById: upper(a.id),
        event: { ...updatedEvent(ctx, upper(b.id)), kind: "superseded" as const },
      },
    );

    expect([first.id, first.status, first.contestedWithId]).toEqual([a.id, "active", null]);
    expect([second.id, second.status, second.supersededById]).toEqual([b.id, "superseded", a.id]);
  });

  it("やりすぎの歯: 小文字の入力の結果は変わらない", async () => {
    const { store, ctx, a, b } = await contestedPair("tenant-lower-resolve");

    const { first, second } = await store.resolveContestedPair!(
      ctx,
      { id: a.id, status: "active", event: updatedEvent(ctx, a.id) },
      { id: b.id, status: "active", event: updatedEvent(ctx, b.id) },
    );

    expect([first.status, second.status]).toEqual(["active", "active"]);
  });

  it("同じ行を小文字と大文字で渡すと、TSDoc どおり RangeError を投げ、何も書かない", async () => {
    const { store, ctx, a } = await contestedPair("tenant-self-resolve");

    await expect(
      store.resolveContestedPair!(
        ctx,
        { id: a.id, status: "active", event: updatedEvent(ctx, a.id) },
        { id: upper(a.id), status: "active", event: updatedEvent(ctx, upper(a.id)) },
      ),
    ).rejects.toBeInstanceOf(RangeError);
    expect((await store.get(ctx, a.id))?.status).toBe("contested");
  });
});

describe("PostgresMemoryStore.restoreSupersededBy — meta.supersededById は列の値と揃う", () => {
  async function supersededGroup(tenantId: string) {
    const { store, eventStore } = await pgStore();
    const ctx: Ctx = { tenantId };
    const anchor = await store.createMemory(
      ctx,
      buildNewMemoryFixture({ tenantId, contentHash: "anchor" }),
    );
    const old = await store.createMemory(
      ctx,
      buildNewMemoryFixture({ tenantId, contentHash: "old" }),
    );
    await store.updateStatus(ctx, old.id, "superseded", { supersededById: anchor.id });
    return { store, eventStore, ctx, anchor, old };
  }

  it("大文字の UUID で戻すと、unsuperseded イベントの meta.supersededById は小文字（列の値）になる", async () => {
    const { store, eventStore, ctx, anchor, old } = await supersededGroup("tenant-upper-restore");

    const { restored } = await store.restoreSupersededBy!(ctx, upper(anchor.id), {
      at: new Date("2026-06-01T00:00:00.000Z"),
    });

    expect(restored.map((m) => m.id)).toEqual([old.id]);
    const events = await eventStore.list(ctx, { memoryId: old.id, kind: "unsuperseded" });
    expect(events.map((e) => e.meta.supersededById)).toEqual([anchor.id]);
  });

  it("やりすぎの歯: 小文字の入力の結果は変わらない", async () => {
    const { store, eventStore, ctx, anchor, old } = await supersededGroup("tenant-lower-restore");

    await store.restoreSupersededBy!(ctx, anchor.id, { at: new Date("2026-06-01T00:00:00.000Z") });

    const events = await eventStore.list(ctx, { memoryId: old.id, kind: "unsuperseded" });
    expect(events.map((e) => e.meta.supersededById)).toEqual([anchor.id]);
  });
});

describe("PostgresMemoryStore.resolveOrphanedContested — 形の崩れた contestedWithId は MemoryStatusConflictError", () => {
  async function contested(tenantId: string) {
    const { store } = await pgStore();
    const ctx: Ctx = { tenantId };
    const a = await store.createMemory(ctx, buildNewMemoryFixture({ tenantId, contentHash: "a" }));
    const b = await store.createMemory(ctx, buildNewMemoryFixture({ tenantId, contentHash: "b" }));
    await store.markContestedPair!(
      ctx,
      { id: a.id, event: updatedEvent(ctx, a.id) },
      { id: b.id, event: updatedEvent(ctx, b.id) },
    );
    return { store, ctx, a, b };
  }

  it("contestedWithId が uuid の形でなければ、DB の例外ではなく MemoryStatusConflictError を投げ、何も書かない", async () => {
    const { store, ctx, a, b } = await contested("tenant-orphan-malformed");

    const error = await store.resolveOrphanedContested!(ctx, {
      id: a.id,
      contestedWithId: "not-a-uuid",
      event: updatedEvent(ctx, a.id),
    }).then(
      () => null,
      (e: unknown) => e,
    );

    expect(error).toBeInstanceOf(MemoryStatusConflictError);
    expect((error as MemoryStatusConflictError).observedStatus).toBe("contested");
    const after = await store.get(ctx, a.id);
    expect([after?.status, after?.contestedWithId]).toEqual(["contested", b.id]);
  });

  it("やりすぎの歯: 形の正しい contestedWithId（小文字・大文字）は今どおり対向として突き合わせる", async () => {
    const { store, ctx, a, b } = await contested("tenant-orphan-ok");

    // 対向が一致しない（別の uuid）ときは今どおり MemoryStatusConflictError。
    await expect(
      store.resolveOrphanedContested!(ctx, {
        id: a.id,
        contestedWithId: "00000000-0000-4000-8000-000000000000",
        event: updatedEvent(ctx, a.id),
      }),
    ).rejects.toBeInstanceOf(MemoryStatusConflictError);

    const { memory } = await store.resolveOrphanedContested!(ctx, {
      id: upper(a.id),
      contestedWithId: upper(b.id),
      event: updatedEvent(ctx, upper(a.id)),
    });
    expect([memory.id, memory.status, memory.contestedWithId]).toEqual([a.id, "active", null]);
  });
});

interface Kit {
  runtime: Runtime;
  memoryStore: MemoryStore;
  eventStore: EventStore;
  embed: (ctx: Ctx, memoryId: string) => Promise<void>;
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
      const vectorStore = new InMemoryVectorStore(memoryStore);
      return {
        memoryStore,
        eventStore,
        caseInsensitive: false,
        embed: async (ctx, id) => {
          await vectorStore.upsert(ctx, TEST_EMBEDDING_SPACE, id, [1, 0, 0]);
          await memoryStore.setEmbeddingStatus(ctx, id, "ready");
        },
        runtime: createRuntime({
          ...shared,
          memoryStore,
          vectorStore,
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
      const vectorStore = new PostgresVectorStore(db);
      return {
        memoryStore,
        eventStore,
        caseInsensitive: true,
        embed: async (ctx, id) => {
          await vectorStore.upsert(ctx, TEST_EMBEDDING_SPACE, id, [1, 0, 0]);
          await memoryStore.setEmbeddingStatus(ctx, id, "ready");
        },
        runtime: createRuntime({
          ...shared,
          memoryStore,
          vectorStore,
          eventStore,
          outboxStore: new PostgresOutboxStore(db),
          tenantSettingsStore: new PostgresTenantSettingsStore(db),
        }),
      };
    },
  ],
];

describe.each(KITS)(
  "consolidate・reflect は大文字の id を store の get に従って扱う（%s、dryRun）",
  (_name, makeKit) => {
    const ctx: Ctx = { tenantId: "tenant-upper-consolidate" };
    const create = async (kit: Kit, contentHash: string) => {
      const memory = await kit.memoryStore.createMemory(
        ctx,
        buildNewMemoryFixture({ tenantId: ctx.tenantId, contentHash, recordedAt: new Date() }),
      );
      await kit.embed(ctx, memory.id);
      return memory;
    };

    it("consolidate { memoryIds }: 大文字の id でも、store が在ると言う記憶は eligible になる", async () => {
      const kit = await makeKit();
      const a = await create(kit, "c-a");
      const b = await create(kit, "c-b");

      const result = await kit.runtime.consolidate(ctx, {
        target: { memoryIds: [upper(a.id), upper(b.id)] },
        dryRun: true,
      });

      const kind = kit.caseInsensitive ? "eligible" : "not_found";
      expect(result.sources).toEqual([
        { memoryId: upper(a.id), kind },
        { memoryId: upper(b.id), kind },
      ]);
    });

    it("reflect { memoryIds }: 大文字の id でも、store が在ると言う記憶は eligible になる", async () => {
      const kit = await makeKit();
      const a = await create(kit, "r-a");
      const b = await create(kit, "r-b");

      const result = await kit.runtime.reflect(ctx, {
        target: { memoryIds: [upper(a.id), upper(b.id)] },
        dryRun: true,
      });

      const kind = kit.caseInsensitive ? "eligible" : "not_found";
      expect(result.basis).toEqual([
        { memoryId: upper(a.id), kind },
        { memoryId: upper(b.id), kind },
      ]);
    });

    it("consolidate { seedMemoryId }: 大文字の種でも、種は1回だけ先頭に置かれ eligible になる", async () => {
      const kit = await makeKit();
      const seed = await create(kit, "cs-seed");
      const neighbor = await create(kit, "cs-neighbor");

      const result = await kit.runtime.consolidate(ctx, {
        target: { seedMemoryId: upper(seed.id) },
        dryRun: true,
      });

      if (kit.caseInsensitive) {
        expect(result.sources).toEqual([
          { memoryId: upper(seed.id), kind: "eligible" },
          { memoryId: neighbor.id, kind: "eligible" },
        ]);
      } else {
        expect(result.sources).toEqual([{ memoryId: upper(seed.id), kind: "not_found" }]);
      }
    });

    it("reflect { seedMemoryId }: 大文字の種でも、種は1回だけ先頭に置かれ eligible になる", async () => {
      const kit = await makeKit();
      const seed = await create(kit, "rs-seed");
      const neighbor = await create(kit, "rs-neighbor");

      const result = await kit.runtime.reflect(ctx, {
        target: { seedMemoryId: upper(seed.id) },
        dryRun: true,
      });

      if (kit.caseInsensitive) {
        expect(result.basis).toEqual([
          { memoryId: upper(seed.id), kind: "eligible" },
          { memoryId: neighbor.id, kind: "eligible" },
        ]);
      } else {
        expect(result.basis).toEqual([{ memoryId: upper(seed.id), kind: "not_found" }]);
      }
    });

    it("やりすぎの歯: 小文字の入力（memoryIds・seedMemoryId）の結果は変わらない", async () => {
      const kit = await makeKit();
      const seed = await create(kit, "l-seed");
      const neighbor = await create(kit, "l-neighbor");

      const byIds = await kit.runtime.consolidate(ctx, {
        target: { memoryIds: [seed.id, neighbor.id] },
        dryRun: true,
      });
      const bySeed = await kit.runtime.reflect(ctx, {
        target: { seedMemoryId: seed.id },
        dryRun: true,
      });

      expect(byIds.sources).toEqual([
        { memoryId: seed.id, kind: "eligible" },
        { memoryId: neighbor.id, kind: "eligible" },
      ]);
      expect(bySeed.basis).toEqual([
        { memoryId: seed.id, kind: "eligible" },
        { memoryId: neighbor.id, kind: "eligible" },
      ]);
    });

    it("やりすぎの歯: 大文字小文字だけが違う id を同じ呼び出しに混ぜると、渡された文字列どおりに突き合わせる", async () => {
      const kit = await makeKit();
      const a = await create(kit, "m-a");
      const b = await create(kit, "m-b");

      const result = await kit.runtime.consolidate(ctx, {
        target: { memoryIds: [a.id, upper(a.id), b.id] },
        dryRun: true,
      });

      expect(result.sources).toEqual([
        { memoryId: a.id, kind: "eligible" },
        { memoryId: upper(a.id), kind: "not_found" },
        { memoryId: b.id, kind: "eligible" },
      ]);
    });
  },
);
