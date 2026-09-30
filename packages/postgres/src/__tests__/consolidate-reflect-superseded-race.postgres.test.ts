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

/**
 * `consolidate`・`reflect` の LLM を待つ間に、統合元・材料が **superseded** になったとき、
 * および統合元が**すべて** CAS で弾かれるときの振る舞いを縛る（ADR 0420）。
 *
 * forget に対する打ち切り（ADR 0375 決定7・ADR 0406）と同じ形を superseded にも広げた。
 * 退けた古い本文から作った統合記憶・内省が active のまま残らない。
 *
 * 「LLM の中で別の操作を先に commit させる」差し込みで競合を作る（`consolidate-reflect-forget-race`
 * と同じ作法）。Postgres と testkit の fixture の両方で見る。
 */

let release: () => void = () => {};
let reached: () => void = () => {};
let gate: Promise<void> = Promise.resolve();
let lastRequest = "";
function holdNextCall(): { stopped: Promise<void>; resume: () => void } {
  gate = new Promise((resolve) => (release = resolve));
  const stopped = new Promise<void>((resolve) => (reached = resolve));
  return { stopped, resume: () => release() };
}

const llm: LLMProvider = {
  complete: async () => ({ content: "unused" }),
  completeStructured: async (_ctx, req) => {
    lastRequest = JSON.stringify(req);
    reached();
    await gate;
    const reflected = req.schema.safeParse({
      outcome: "reflected",
      content: "内省",
      digest: "内省",
    });
    return reflected.success
      ? reflected.data
      : req.schema.parse({ content: "統合", digest: "統合" });
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

interface Kit {
  runtime: Runtime;
  memoryStore: MemoryStore;
}

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

const ctx: Ctx = { tenantId: "consolidate-reflect-superseded-race" };
let seq = 0;

async function createActive(kit: Kit, content: string) {
  seq += 1;
  return kit.memoryStore.createMemory(
    ctx,
    buildNewMemoryFixture({
      tenantId: ctx.tenantId,
      contentHash: `sup-race-${seq}`,
      content,
      digest: content,
    }),
  );
}

/** reextract が S を X で置き換えて commit した後の状態を作る（S は superseded、X は active）。 */
async function supersedeByReextractLike(kit: Kit, sourceId: string, newContent: string) {
  const x = await createActive(kit, newContent);
  await kit.memoryStore.updateStatus(ctx, sourceId, "superseded", {
    supersededById: x.id,
    expectedStatus: "active",
  });
  return x;
}

/** `method` の呼び出しの直前に、`before` を1回だけ実行する（recheck と書き込みの間の窓を作る）。 */
function injectBefore(
  store: MemoryStore,
  method: "supersedeWithNewMemories" | "createMemoriesWithOutboxAndEvents",
  before: () => Promise<void>,
): void {
  const holder = store as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;
  const original = holder[method]!.bind(store);
  let done = false;
  holder[method] = async (...args: unknown[]) => {
    if (!done) {
      done = true;
      await before();
    }
    return original(...args);
  };
}

afterAll(async () => {
  await closeTestClient();
});

for (const [name, makeKit] of KITS) {
  describe(`${name}: 統合元・材料が superseded になったとき（ADR 0420）`, () => {
    it("R2: consolidate の LLM 待ちの間に A が別の記憶で置き換えられたら、統合先を作らず打ち切る", async () => {
      const kit = await makeKit();
      const a = await createActive(kit, "A の古い本文");
      const b = await createActive(kit, "B の話");
      const hold = holdNextCall();
      const pending = kit.runtime.consolidate(ctx, { target: { memoryIds: [a.id, b.id] } });
      await hold.stopped;
      const x = await supersedeByReextractLike(kit, a.id, "A の新しい本文");
      hold.resume();
      const result = await pending;

      expect(result.outcome).toBe("aborted_source_status_changed");
      expect(result.atomicity).toBe("not_attempted");
      expect(result.consolidatedMemoryId).toBeNull();
      expect(result.sources.map((s) => ({ memoryId: s.memoryId, kind: s.kind }))).toEqual([
        { memoryId: a.id, kind: "status_changed_concurrently" },
        { memoryId: b.id, kind: "not_attempted" },
      ]);
      // B は動いていない、X は active のまま。
      expect((await kit.memoryStore.get(ctx, b.id))?.status).toBe("active");
      expect((await kit.memoryStore.get(ctx, x.id))?.status).toBe("active");
    });

    it("R1: 同じ ids の consolidate が2本走ったら、後から書く側は打ち切られ、統合先は1件だけ active", async () => {
      const kit = await makeKit();
      const a = await createActive(kit, "A");
      const b = await createActive(kit, "B");
      const hold = holdNextCall();
      const first = kit.runtime.consolidate(ctx, { target: { memoryIds: [a.id, b.id] } });
      await hold.stopped;
      gate = Promise.resolve(); // 2本目は止めない。
      const second = await kit.runtime.consolidate(ctx, { target: { memoryIds: [a.id, b.id] } });
      expect(second.outcome).toBe("consolidated");
      hold.resume();
      const firstResult = await first;

      expect(firstResult.outcome).toBe("aborted_source_status_changed");
      expect(firstResult.consolidatedMemoryId).toBeNull();
      const survivor = await kit.memoryStore.get(ctx, second.consolidatedMemoryId!);
      expect(survivor?.status).toBe("active");
    });

    it("R1（store 側の窓）: 統合元がすべて CAS で弾かれたら、統合先は commit されない", async () => {
      const kit = await makeKit();
      const a = await createActive(kit, "A");
      const b = await createActive(kit, "B");
      injectBefore(kit.memoryStore, "supersedeWithNewMemories", async () => {
        await kit.memoryStore.updateStatus(ctx, a.id, "archived", { expectedStatus: "active" });
        await kit.memoryStore.updateStatus(ctx, b.id, "archived", { expectedStatus: "active" });
      });
      const result = await kit.runtime.consolidate(ctx, { target: { memoryIds: [a.id, b.id] } });

      expect(result.outcome).toBe("aborted_source_status_changed");
      expect(result.consolidatedMemoryId).toBeNull();
      expect(result.sources.map((s) => ({ memoryId: s.memoryId, kind: s.kind }))).toEqual([
        { memoryId: a.id, kind: "status_changed_concurrently" },
        { memoryId: b.id, kind: "status_changed_concurrently" },
      ]);
    });

    it("R1（store 側の窓・部分成功は今どおり）: 1件だけ弾かれ1件残るなら、consolidated のまま", async () => {
      const kit = await makeKit();
      const a = await createActive(kit, "A");
      const b = await createActive(kit, "B");
      injectBefore(kit.memoryStore, "supersedeWithNewMemories", async () => {
        await kit.memoryStore.updateStatus(ctx, a.id, "archived", { expectedStatus: "active" });
      });
      const result = await kit.runtime.consolidate(ctx, { target: { memoryIds: [a.id, b.id] } });

      expect(result.outcome).toBe("consolidated");
      expect(result.sources.map((s) => ({ memoryId: s.memoryId, kind: s.kind }))).toEqual([
        { memoryId: a.id, kind: "status_changed_concurrently" },
        { memoryId: b.id, kind: "superseded" },
      ]);
      expect((await kit.memoryStore.get(ctx, result.consolidatedMemoryId!))?.status).toBe("active");
    });

    it("R2（store 側の窓）: recheck の後・書き込みの前に A が置き換えられても、統合先は作られない", async () => {
      const kit = await makeKit();
      const a = await createActive(kit, "A の古い本文");
      const b = await createActive(kit, "B の話");
      injectBefore(kit.memoryStore, "supersedeWithNewMemories", async () => {
        await supersedeByReextractLike(kit, a.id, "A の新しい本文");
      });
      const result = await kit.runtime.consolidate(ctx, { target: { memoryIds: [a.id, b.id] } });

      expect(result.outcome).toBe("aborted_source_status_changed");
      expect(result.consolidatedMemoryId).toBeNull();
      expect((await kit.memoryStore.get(ctx, b.id))?.status).toBe("active");
    });

    it("R2: reflect の LLM 待ちの間に A が置き換えられたら、内省を作らず打ち切る", async () => {
      const kit = await makeKit();
      const a = await createActive(kit, "A の古い本文");
      const b = await createActive(kit, "B の話");
      const hold = holdNextCall();
      const pending = kit.runtime.reflect(ctx, { target: { memoryIds: [a.id, b.id] } });
      await hold.stopped;
      await supersedeByReextractLike(kit, a.id, "A の新しい本文");
      hold.resume();
      const result = await pending;

      expect(result.outcome).toBe("aborted_source_status_changed");
      expect(result.reflectedMemoryId).toBeNull();
      expect(result.basis.map((s) => ({ memoryId: s.memoryId, kind: s.kind }))).toEqual([
        { memoryId: a.id, kind: "status_changed_before_write" },
        { memoryId: b.id, kind: "eligible" },
      ]);
    });

    it("R2（store 側の窓）: reflect も recheck の後・書き込みの前に A が置き換えられたら、内省は作られない", async () => {
      const kit = await makeKit();
      const a = await createActive(kit, "A の古い本文");
      const b = await createActive(kit, "B の話");
      injectBefore(kit.memoryStore, "createMemoriesWithOutboxAndEvents", async () => {
        await supersedeByReextractLike(kit, a.id, "A の新しい本文");
      });
      const result = await kit.runtime.reflect(ctx, { target: { memoryIds: [a.id, b.id] } });

      expect(result.outcome).toBe("aborted_source_status_changed");
      expect(result.reflectedMemoryId).toBeNull();
    });
  });
}
