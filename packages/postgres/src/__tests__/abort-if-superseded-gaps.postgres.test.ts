import { createHash } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import type { Ctx, LLMProvider, MemoryStore, Runtime } from "@mnemora/core";
import { createRuntime } from "@mnemora/core";
import { buildNewMemoryFixture } from "@mnemora/testkit";
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

afterAll(async () => {
  await closeTestClient();
});

const ctx: Ctx = { tenantId: "abort-if-superseded-gaps" };
let seq = 0;

async function createActive(store: MemoryStore, label: string) {
  seq += 1;
  return store.createMemory(
    ctx,
    buildNewMemoryFixture({
      tenantId: ctx.tenantId,
      contentHash: `gaps-${label}-${seq}`,
      content: `${label}-${seq}`,
      digest: `${label}-${seq}`,
    }),
  );
}

async function createSuperseded(store: MemoryStore, label: string) {
  const source = await createActive(store, `${label}-source`);
  const replacement = await createActive(store, `${label}-replacement`);
  await store.updateStatus(ctx, source.id, "superseded", {
    supersededById: replacement.id,
    expectedStatus: "active",
  });
  return source;
}

async function createForgotten(store: MemoryStore, label: string) {
  const source = await createActive(store, `${label}-forgotten`);
  await store.updateStatus(ctx, source.id, "forgotten", { expectedStatus: "active" });
  return source;
}

function newInput(label: string) {
  seq += 1;
  return buildNewMemoryFixture({
    tenantId: ctx.tenantId,
    contentHash: `gaps-new-${label}-${seq}`,
    content: `new-${label}-${seq}`,
    digest: `new-${label}-${seq}`,
  });
}

describe("PostgresMemoryStore: abortIfSuperseded の確かめ直し（ADR 0420）", () => {
  it("createMemoryWithOutbox: forgotten と superseded の両方に当たるときは、forgotten が先（SourceMemoryForgottenError）", async () => {
    await resetTestDatabase();
    const { db } = await getTestClient();
    const store = new PostgresMemoryStore(db);
    const forgotten = await createForgotten(store, "precedence-cwo");
    const superseded = await createSuperseded(store, "precedence-cwo");

    const rejection = store.createMemoryWithOutbox(ctx, newInput("precedence-cwo"), ["embed"], {
      abortIfForgotten: [forgotten.id, superseded.id],
      abortIfSuperseded: [forgotten.id, superseded.id],
    });
    await expect(rejection).rejects.toMatchObject({ name: "SourceMemoryForgottenError" });
  });

  it("supersedeWithNewMemories: forgotten と superseded の両方に当たるときは、forgotten が先（SourceMemoryForgottenError）", async () => {
    await resetTestDatabase();
    const { db } = await getTestClient();
    const store = new PostgresMemoryStore(db);
    const forgotten = await createForgotten(store, "precedence-swn");
    const superseded = await createSuperseded(store, "precedence-swn");

    const rejection = store.supersedeWithNewMemories!(
      ctx,
      [{ input: newInput("precedence-swn"), jobKinds: [] }],
      [],
      {
        abortIfForgotten: [forgotten.id, superseded.id],
        abortIfSuperseded: [forgotten.id, superseded.id],
      },
    );
    await expect(rejection).rejects.toMatchObject({ name: "SourceMemoryForgottenError" });
  });

  it("changed は id の昇順で返る（呼び出し側が渡した順・書き込みの順ではない）", async () => {
    await resetTestDatabase();
    const { db } = await getTestClient();
    const store = new PostgresMemoryStore(db);
    const sources = [];
    for (let i = 0; i < 8; i += 1) {
      sources.push(await createSuperseded(store, `order-${i}`));
    }
    const ids = sources.map((s) => s.id);
    // 渡す順は降順にして、作った順・渡した順のどちらとも違う並びにする。
    const passed = [...ids].sort().reverse();

    const rejection = store.createMemoryWithOutbox(ctx, newInput("order"), ["embed"], {
      abortIfSuperseded: passed,
    });
    const error = (await rejection.catch((e: unknown) => e)) as {
      name: string;
      changed: Array<{ id: string }>;
    };
    expect(error.name).toBe("SourceMemoryStatusChangedError");
    expect(error.changed.map((c) => c.id)).toEqual([...ids].sort());
  });
});

type Kit = { runtime: Runtime; memoryStore: MemoryStore };

let nextContent = "最初の本文";
const llm: LLMProvider = {
  complete: async () => ({ content: "unused" }),
  completeStructured: async (_ctx, req) => {
    const extracted = req.schema.safeParse({
      memories: [{ content: nextContent, provenanceKind: "stated" }],
    });
    return extracted.success ? extracted.data : req.schema.parse({ content: nextContent });
  },
};
const shared = {
  llmProvider: llm,
  embeddingProvider: {
    space: TEST_EMBEDDING_SPACE,
    embed: async (_ctx: Ctx, texts: string[]) => texts.map(() => [1, 0, 0]),
  },
  hashContent: (content: string) => createHash("sha256").update(content).digest("hex"),
};

const KITS: Array<[string, () => Promise<Kit>]> = [
  [
    "testkit の InMemory",
    async () => {
      const memoryStore = new InMemoryMemoryStore();
      return {
        memoryStore,
        runtime: createRuntime({
          ...shared,
          memoryStore,
          eventStore: new InMemoryEventStore(memoryStore, memoryStore.events),
          vectorStore: new InMemoryVectorStore(memoryStore),
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
          eventStore: new PostgresEventStore(db),
          vectorStore: new PostgresVectorStore(db),
          outboxStore: new PostgresOutboxStore(db),
          tenantSettingsStore: new PostgresTenantSettingsStore(db),
        }),
      };
    },
  ],
];

for (const [name, makeKit] of KITS) {
  describe(`${name}: reextract は abortIfAllConflicted を渡さない（ADR 0420 決定5）`, () => {
    it("置き換え元が書き込みの直前に archived になって CAS に全件弾かれても、reextract は例外にならず skipped で返る", async () => {
      nextContent = "最初の本文";
      const kit = await makeKit();
      const first = await kit.runtime.observe(ctx, { kind: "utterance", text: "猫は3匹いる" });
      const x = first.memoryIds[0]!;
      expect(x).toBeDefined();
      nextContent = "訂正後の本文";

      const holder = kit.memoryStore as unknown as Record<
        string,
        (...args: unknown[]) => Promise<unknown>
      >;
      const original = holder["supersedeWithNewMemories"]!.bind(kit.memoryStore);
      let injected = false;
      holder["supersedeWithNewMemories"] = async (...args: unknown[]) => {
        if (!injected) {
          injected = true;
          await kit.memoryStore.updateStatus(ctx, x, "archived", { expectedStatus: "active" });
        }
        return original(...args);
      };

      const result = await kit.runtime.reextract(ctx, first.observationId);

      expect(injected).toBe(true);
      expect(result.supersededMemoryIds).toEqual([]);
      expect(result.skipped).toContainEqual(
        expect.objectContaining({
          kind: "status_changed_concurrently",
          memoryId: x,
          observedStatus: "archived",
        }),
      );
    });
  });
}
