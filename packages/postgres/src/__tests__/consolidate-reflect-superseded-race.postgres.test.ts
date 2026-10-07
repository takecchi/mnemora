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

let release: () => void = () => {};
let reached: () => void = () => {};
let gate: Promise<void> = Promise.resolve();
function holdNextCall(): { stopped: Promise<void>; resume: () => void } {
  gate = new Promise((resolve) => (release = resolve));
  const stopped = new Promise<void>((resolve) => (reached = resolve));
  return { stopped, resume: () => release() };
}

const llm: LLMProvider = {
  complete: async () => ({ content: "unused" }),
  completeStructured: async (_ctx, req) => {
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
  method:
    "supersedeWithNewMemories" | "createMemoriesWithOutboxAndEvents" | "createMemoryWithOutbox",
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

/**
 * 新しい `opts`（`abortIfSuperseded`・`abortIfAllConflicted`）を**無視する** adapter を真似る
 * （任意の欄なので、実装しない第三者の adapter は在りうる）。この状態で効くのは、runtime 自身の
 * 「LLM が返った直後の読み直し」だけ——その層の歯を、store 側の層と分けて見るために使う。
 */
function ignoreAbortOpts(store: MemoryStore): void {
  const holder = store as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;
  for (const method of [
    "supersedeWithNewMemories",
    "createMemoriesWithOutboxAndEvents",
    "createMemoryWithOutbox",
  ]) {
    const original = holder[method]?.bind(store);
    if (original === undefined) continue;
    holder[method] = (...args: unknown[]) =>
      original(
        ...args.map((arg) => {
          if (typeof arg !== "object" || arg === null || !("abortIfForgotten" in arg)) return arg;
          const {
            abortIfSuperseded: _s,
            abortIfAllConflicted: _c,
            ...rest
          } = arg as Record<string, unknown>;
          return rest;
        }),
      );
  }
}

afterAll(async () => {
  await closeTestClient();
});

for (const [name, makeKit] of KITS) {
  describe(`${name}: 統合元・材料が superseded になったとき（ADR 0420）`, () => {
    for (const storeIgnoresOpts of [false, true]) {
      const layer = storeIgnoresOpts ? "（store は opts を無視）" : "";
      const kitFor = async (): Promise<Kit> => {
        const kit = await makeKit();
        if (storeIgnoresOpts) ignoreAbortOpts(kit.memoryStore);
        return kit;
      };
      it(`R2: consolidate の LLM 待ちの間に A が別の記憶で置き換えられたら、統合先を作らず打ち切る${layer}`, async () => {
        const kit = await kitFor();
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
        expect((await kit.memoryStore.get(ctx, b.id))?.status).toBe("active");
        expect((await kit.memoryStore.get(ctx, x.id))?.status).toBe("active");
      });

      it(`R1: 同じ ids の consolidate が2本走ったら、後から書く側は打ち切られ、統合先は1件だけ active${layer}`, async () => {
        const kit = await kitFor();
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

      it(`R2: reflect の LLM 待ちの間に A が置き換えられたら、内省を作らず打ち切る${layer}`, async () => {
        const kit = await kitFor();
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

      it(`R1: LLM 待ちの間に統合元がすべて archived になったら、統合先を作らず打ち切る${layer}`, async () => {
        const kit = await kitFor();
        const a = await createActive(kit, "A");
        const b = await createActive(kit, "B");
        const hold = holdNextCall();
        const pending = kit.runtime.consolidate(ctx, { target: { memoryIds: [a.id, b.id] } });
        await hold.stopped;
        await kit.memoryStore.updateStatus(ctx, a.id, "archived", { expectedStatus: "active" });
        await kit.memoryStore.updateStatus(ctx, b.id, "archived", { expectedStatus: "active" });
        hold.resume();
        const result = await pending;

        expect(result.outcome).toBe("aborted_source_status_changed");
        expect(result.consolidatedMemoryId).toBeNull();
        expect(result.sources.map((s) => ({ memoryId: s.memoryId, kind: s.kind }))).toEqual([
          { memoryId: a.id, kind: "status_changed_concurrently" },
          { memoryId: b.id, kind: "status_changed_concurrently" },
        ]);
      });
    }

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
    it("R2（口の無い adapter の経路）: consolidate も、recheck の後・書き込みの前に A が置き換えられたら統合先は作られない", async () => {
      const kit = await makeKit();
      // `supersedeWithNewMemories` を持たない adapter（2 段の書き込みの経路）にする。
      (kit.memoryStore as { supersedeWithNewMemories?: unknown }).supersedeWithNewMemories =
        undefined;
      const a = await createActive(kit, "A の古い本文");
      const b = await createActive(kit, "B の話");
      injectBefore(kit.memoryStore, "createMemoryWithOutbox", async () => {
        await supersedeByReextractLike(kit, a.id, "A の新しい本文");
      });
      const result = await kit.runtime.consolidate(ctx, { target: { memoryIds: [a.id, b.id] } });

      expect(result.outcome).toBe("aborted_source_status_changed");
      expect(result.consolidatedMemoryId).toBeNull();
      expect((await kit.memoryStore.get(ctx, b.id))?.status).toBe("active");
    });

    it("R2（口の無い adapter の経路）: reflect も、recheck の後・書き込みの前に A が置き換えられたら内省は作られない", async () => {
      const kit = await makeKit();
      // `createMemoriesWithOutboxAndEvents` を持たない adapter（`createMemoryWithOutbox` の経路）にする。
      (
        kit.memoryStore as { createMemoriesWithOutboxAndEvents?: unknown }
      ).createMemoriesWithOutboxAndEvents = undefined;
      const a = await createActive(kit, "A の古い本文");
      const b = await createActive(kit, "B の話");
      injectBefore(kit.memoryStore, "createMemoryWithOutbox", async () => {
        await supersedeByReextractLike(kit, a.id, "A の新しい本文");
      });
      const result = await kit.runtime.reflect(ctx, { target: { memoryIds: [a.id, b.id] } });

      expect(result.outcome).toBe("aborted_source_status_changed");
      expect(result.reflectedMemoryId).toBeNull();
    });
  });
}
