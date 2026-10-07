import { createHash } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import type { Ctx, MemoryStore, Runtime } from "@mnemora/core";
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

interface Kit {
  runtime: Runtime;
  memoryStore: MemoryStore;
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
      return {
        memoryStore,
        runtime: createRuntime({
          ...shared,
          memoryStore,
          vectorStore: new InMemoryVectorStore(memoryStore),
          eventStore: new InMemoryEventStore(memoryStore, memoryStore.events),
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
      return {
        memoryStore,
        runtime: createRuntime({
          ...shared,
          memoryStore,
          vectorStore: new PostgresVectorStore(db),
          eventStore: new PostgresEventStore(db),
          outboxStore: new PostgresOutboxStore(db),
          tenantSettingsStore: new PostgresTenantSettingsStore(db),
        }),
      };
    },
  ],
];

const ctx: Ctx = { tenantId: "tenant-upper-spelling-position" };
const upper = (id: string) => id.toUpperCase();
const capitalizeFirstLetter = (id: string) => id.replace(/[a-z]/, (c) => c.toUpperCase());

const create = (kit: Kit, contentHash: string, status?: "archived" | "forgotten") =>
  kit.memoryStore.createMemory(
    ctx,
    buildNewMemoryFixture({
      tenantId: ctx.tenantId,
      contentHash,
      ...(status ? { status } : {}),
    }),
  );

const kindsOf = (outcomes: Array<{ memoryId: string; kind: string }>) =>
  outcomes.map((o) => [o.memoryId, o.kind]);

afterAll(async () => {
  await closeTestClient();
});

describe.each(KITS)(
  "大文字小文字だけが違う id を混ぜたとき、位置によらず綴りで突き合わせる（%s）",
  (_name, makeKit) => {
    it("restoreArchived: 大文字を先に渡しても、not_found になるのは大文字の側で、小文字の側だけが restored になる", async () => {
      const kit = await makeKit();
      const memory = await create(kit, "restore-upper-first", "archived");

      const result = await kit.runtime.restoreArchived(ctx, {
        memoryIds: [upper(memory.id), memory.id],
      });

      expect(kindsOf(result.outcomes)).toEqual([
        [upper(memory.id), "not_found"],
        [memory.id, "restored"],
      ]);
      expect((await kit.memoryStore.get(ctx, memory.id))?.status).toBe("active");
    });

    it("restoreArchived: どの綴りも store の id と違えば、全部が not_found になり、archived のまま", async () => {
      const kit = await makeKit();
      const memory = await create(kit, "restore-no-exact", "archived");
      const capitalized = capitalizeFirstLetter(memory.id);
      expect([capitalized === memory.id, capitalized === upper(memory.id)]).toEqual([false, false]);

      const result = await kit.runtime.restoreArchived(ctx, {
        memoryIds: [capitalized, upper(memory.id)],
      });

      expect(kindsOf(result.outcomes)).toEqual([
        [capitalized, "not_found"],
        [upper(memory.id), "not_found"],
      ]);
      expect((await kit.memoryStore.get(ctx, memory.id))?.status).toBe("archived");
    });

    it("purge: 大文字を先に渡しても、not_found になるのは大文字の側で、小文字の側だけが purged になる", async () => {
      const kit = await makeKit();
      const memory = await create(kit, "purge-upper-first", "forgotten");

      const result = await kit.runtime.purge(ctx, { memoryIds: [upper(memory.id), memory.id] });

      expect(kindsOf(result.outcomes)).toEqual([
        [upper(memory.id), "not_found"],
        [memory.id, "purged"],
      ]);
      expect((await kit.memoryStore.get(ctx, memory.id))?.purgedAt ?? null).not.toBeNull();
    });

    it("purge: どの綴りも store の id と違えば、全部が not_found になり、何も消さない", async () => {
      const kit = await makeKit();
      const memory = await create(kit, "purge-no-exact", "forgotten");
      const capitalized = capitalizeFirstLetter(memory.id);

      const result = await kit.runtime.purge(ctx, { memoryIds: [capitalized, upper(memory.id)] });

      expect(kindsOf(result.outcomes)).toEqual([
        [capitalized, "not_found"],
        [upper(memory.id), "not_found"],
      ]);
      expect((await kit.memoryStore.get(ctx, memory.id))?.purgedAt ?? null).toBeNull();
    });

    it("consolidate: 大文字を先に渡しても、not_found になるのは大文字の側である", async () => {
      const kit = await makeKit();
      const memory = await create(kit, "consolidate-upper-first");

      const result = await kit.runtime.consolidate(ctx, {
        target: { memoryIds: [upper(memory.id), memory.id] },
      });

      expect(kindsOf(result.sources)).toEqual([
        [upper(memory.id), "not_found"],
        [memory.id, expect.not.stringMatching(/^not_found$/)],
      ]);
    });

    it("consolidate: どの綴りも store の id と違えば、全部が not_found になる", async () => {
      const kit = await makeKit();
      const memory = await create(kit, "consolidate-no-exact");
      const capitalized = capitalizeFirstLetter(memory.id);

      const result = await kit.runtime.consolidate(ctx, {
        target: { memoryIds: [capitalized, upper(memory.id)] },
      });

      expect(kindsOf(result.sources)).toEqual([
        [capitalized, "not_found"],
        [upper(memory.id), "not_found"],
      ]);
      expect((await kit.memoryStore.get(ctx, memory.id))?.status).toBe("active");
    });

    it("reflect: 大文字を先に渡しても、not_found になるのは大文字の側である", async () => {
      const kit = await makeKit();
      const memory = await create(kit, "reflect-upper-first");

      const result = await kit.runtime.reflect(ctx, {
        target: { memoryIds: [upper(memory.id), memory.id] },
      });

      expect(kindsOf(result.basis)).toEqual([
        [upper(memory.id), "not_found"],
        [memory.id, expect.not.stringMatching(/^not_found$/)],
      ]);
    });

    it("reflect: どの綴りも store の id と違えば、全部が not_found になる", async () => {
      const kit = await makeKit();
      const memory = await create(kit, "reflect-no-exact");
      const capitalized = capitalizeFirstLetter(memory.id);

      const result = await kit.runtime.reflect(ctx, {
        target: { memoryIds: [capitalized, upper(memory.id)] },
      });

      expect(kindsOf(result.basis)).toEqual([
        [capitalized, "not_found"],
        [upper(memory.id), "not_found"],
      ]);
    });
  },
);
