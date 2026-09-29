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
 * `consolidate`・`reflect` の LLM を待つ間に、eligible の1件が `forget`（と `purge`）されたときの
 * 今の振る舞いを縛る（Issue #1226、ADR 0375 決定7、クローン miku の判断）。
 *
 * ⚠ **2026-09-30 訂正**: このファイルは元々「今の振る舞い」（直っていない状態）を縛って
 * いたが、もう成り立たない。**今は、LLM が返った直後・書き込みの直前に eligible を
 * 読み直し、1件でも forgotten なら書き込みを一切打ち切る**（`Runtime.consolidate`・
 * `Runtime.reflect` の doc の 2026-09-30 追記、`docs/memory-model.md` の該当箇所参照）。
 * 忘れさせた（消した）記憶の本文から新しい Memory が作られることはもう無い。
 * Postgres と testkit の fixture で同じ（testkit 側は runtime 自身の読み直しだけが保護。
 * `MemoryStore.createMemoryWithOutbox`/`supersedeWithNewMemories` の `opts.abortIfForgotten`
 * の doc コメント参照）。
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

const ctx: Ctx = { tenantId: "consolidate-reflect-forget-race" };
let seq = 0;

async function createActive(kit: Kit, content: string) {
  seq += 1;
  return kit.memoryStore.createMemory(
    ctx,
    buildNewMemoryFixture({
      tenantId: ctx.tenantId,
      contentHash: `race-${seq}`,
      content,
      digest: content,
    }),
  );
}

afterAll(async () => {
  await closeTestClient();
});

for (const [name, makeKit] of KITS) {
  describe(`${name}: LLM を待つ間に元の記憶を forget・purge したとき（打ち切る、Issue #1226 の修正後）`, () => {
    for (const withPurge of [false, true]) {
      const label = withPurge ? "forget と purge" : "forget";

      it(`consolidate の途中で A を ${label} しても、統合先は作られず、A は forgotten_before_write、B は not_attempted になる`, async () => {
        const kit = await makeKit();
        const a = await createActive(kit, "A の秘密");
        const b = await createActive(kit, "B の話");
        const hold = holdNextCall();
        const pending = kit.runtime.consolidate(ctx, { target: { memoryIds: [a.id, b.id] } });
        await hold.stopped;
        expect(lastRequest).toContain("A の秘密");
        expect((await kit.runtime.forget(ctx, { memoryId: a.id })).outcomes[0]?.kind).toBe(
          "forgotten",
        );
        if (withPurge) {
          expect((await kit.runtime.purge(ctx, { memoryId: a.id })).outcomes[0]?.kind).toBe(
            "purged",
          );
        }
        hold.resume();
        const result = await pending;

        // 何も書かれていない——打ち切り。
        expect(result.outcome).toBe("aborted_source_forgotten");
        expect(result.atomicity).toBe("not_attempted");
        expect(result.consolidatedMemoryId).toBeNull();
        expect(result.llmCalls).toBe(1);
        expect(
          result.sources.map((s) => ({ memoryId: s.memoryId, kind: s.kind })),
        ).toEqual([
          { memoryId: a.id, kind: "forgotten_before_write" },
          { memoryId: b.id, kind: "not_attempted" },
        ]);

        // A は forget/purge した状態のまま（この呼び出しでは何も動いていない）。
        const stillA = await kit.memoryStore.get(ctx, a.id);
        expect(stillA?.status).toBe("forgotten");
        expect(stillA?.purgedAt !== null).toBe(withPurge);
        // B は superseded へ動いていない——統合が一切起きていない証拠。
        const stillB = await kit.memoryStore.get(ctx, b.id);
        expect(stillB?.status).toBe("active");
        expect(stillB?.supersededById).toBeNull();
      });

      it(`reflect の途中で A を ${label} しても、内省の Memory は作られず、A は forgotten_before_write、B は eligible になる`, async () => {
        const kit = await makeKit();
        const a = await createActive(kit, "A の秘密");
        const b = await createActive(kit, "B の話");
        const hold = holdNextCall();
        const pending = kit.runtime.reflect(ctx, { target: { memoryIds: [a.id, b.id] } });
        await hold.stopped;
        expect(lastRequest).toContain("A の秘密");
        await kit.runtime.forget(ctx, { memoryId: a.id });
        if (withPurge) await kit.runtime.purge(ctx, { memoryId: a.id });
        hold.resume();
        const result = await pending;

        // 何も書かれていない——打ち切り。
        expect(result.outcome).toBe("aborted_source_forgotten");
        expect(result.reflectedMemoryId).toBeNull();
        expect(result.llmCalls).toBe(1);
        expect(result.basis.map((s) => ({ memoryId: s.memoryId, kind: s.kind }))).toEqual([
          { memoryId: a.id, kind: "forgotten_before_write" },
          { memoryId: b.id, kind: "eligible" },
        ]);

        // B は今どおり active のまま（reflect は元々既存行を動かさないが、念のため）。
        const stillB = await kit.memoryStore.get(ctx, b.id);
        expect(stillB?.status).toBe("active");
      });
    }
  });
}
