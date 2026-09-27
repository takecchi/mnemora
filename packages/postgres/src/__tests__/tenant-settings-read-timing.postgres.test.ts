import { createHash } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import type { Ctx, LLMProvider, MemoryStore, Runtime, TenantSettingsStore } from "@mnemora/core";
import { ConsolidationLLMResultSchema, ExtractionResultSchema, createRuntime } from "@mnemora/core";
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
 * `TenantSettingsStore` の doc（`packages/core/src/interfaces/tenant-settings-store.ts`）に書いた
 * 今の振る舞いを、Postgres と testkit の fixture の両方で縛る（振る舞いは変えていない）。
 *
 * 1. `getEventRetention` の `unset` は「設定の行が1つも無い」ことであり、保持期間以外の設定を
 *    1つ書くと `unlimited` になる。別テナントは `unset` のまま。
 * 2. runtime が設定を読む時点: `observe`・`consolidate` は LLM の応答の後に読む（LLM を待っている
 *    間に変えた半減期が、その呼び出しで書く記憶に効く）。`recall` は呼び出しの始めに読む
 *    （埋め込みを待っている間に変えた taxonomy は、その呼び出しには効かず、次の呼び出しから効く）。
 */

let release: () => void = () => {};
let reached: () => void = () => {};
let gate: Promise<void> = Promise.resolve();
/** 次の LLM／埋め込みの呼び出しを止める。止まったら解決する Promise と、再開する関数を返す。 */
function holdNextCall(): { stopped: Promise<void>; resume: () => void } {
  gate = new Promise((resolve) => (release = resolve));
  const stopped = new Promise<void>((resolve) => (reached = resolve));
  return { stopped, resume: () => release() };
}
async function passGate(): Promise<void> {
  reached();
  await gate;
}

const llm: LLMProvider = {
  complete: async () => ({ content: "" }),
  completeStructured: async (_ctx, req) => {
    await passGate();
    if ((req.schema as unknown) === ExtractionResultSchema) {
      return req.schema.parse({
        memories: [{ content: `事実 ${Math.random()}`, provenanceKind: "stated" }],
      });
    }
    if ((req.schema as unknown) === ConsolidationLLMResultSchema) {
      return req.schema.parse({ content: `統合 ${Math.random()}` });
    }
    throw new Error("unexpected schema");
  },
};

const shared = {
  llmProvider: llm,
  embeddingProvider: {
    space: TEST_EMBEDDING_SPACE,
    embed: async (_ctx: Ctx, texts: string[]) => {
      await passGate();
      return texts.map(() => [1, 0, 0]);
    },
  },
  hashContent: (content: string) => createHash("sha256").update(content).digest("hex"),
};

type Settings = TenantSettingsStore &
  Required<
    Pick<TenantSettingsStore, "setTaxonomyMode" | "setDecayClock" | "setDefaultHalfLifeRecalls">
  >;

interface Kit {
  runtime: Runtime;
  memoryStore: MemoryStore;
  settings: Settings;
  /** 既定の半減期（時間）を書く。Postgres には口が無いので列へ直に書く（#1013）。 */
  setDefaultHalfLifeHours: (ctx: Ctx, hours: number) => Promise<void>;
  upsertVector: (ctx: Ctx, memoryId: string) => Promise<void>;
}

const KITS: Array<[string, () => Promise<Kit>]> = [
  [
    "testkit の InMemory",
    async () => {
      const memoryStore = new InMemoryMemoryStore();
      const settings = new InMemoryTenantSettingsStore(memoryStore.activitySeq);
      const vectorStore = new InMemoryVectorStore(memoryStore);
      return {
        memoryStore,
        settings: settings as Settings,
        setDefaultHalfLifeHours: async (ctx, hours) =>
          settings.setDefaultHalfLifeHours(ctx.tenantId, hours),
        upsertVector: (ctx, id) => vectorStore.upsert(ctx, TEST_EMBEDDING_SPACE, id, [1, 0, 0]),
        runtime: createRuntime({
          ...shared,
          memoryStore,
          vectorStore,
          outboxStore: new InMemoryOutboxStore(memoryStore.outboxJobs),
          eventStore: new InMemoryEventStore(memoryStore, memoryStore.events),
          tenantSettingsStore: settings,
        }),
      };
    },
  ],
  [
    "Postgres",
    async () => {
      await resetTestDatabase();
      const { db, pool } = await getTestClient();
      const memoryStore = new PostgresMemoryStore(db);
      const settings = new PostgresTenantSettingsStore(db);
      const vectorStore = new PostgresVectorStore(db);
      return {
        memoryStore,
        settings: settings as Settings,
        setDefaultHalfLifeHours: async (ctx, hours) => {
          await pool.query(
            `INSERT INTO tenant_settings (tenant_id, default_half_life_hours, updated_at) VALUES ($1, $2, now())
             ON CONFLICT (tenant_id) DO UPDATE SET default_half_life_hours = EXCLUDED.default_half_life_hours`,
            [ctx.tenantId, hours],
          );
        },
        upsertVector: (ctx, id) => vectorStore.upsert(ctx, TEST_EMBEDDING_SPACE, id, [1, 0, 0]),
        runtime: createRuntime({
          ...shared,
          memoryStore,
          vectorStore,
          outboxStore: new PostgresOutboxStore(db),
          eventStore: new PostgresEventStore(db),
          tenantSettingsStore: settings,
        }),
      };
    },
  ],
];

const ctx: Ctx = { tenantId: "tenant-settings-read-timing" };
const other: Ctx = { tenantId: "tenant-settings-read-timing-other" };

afterAll(async () => {
  await closeTestClient();
});

for (const [name, makeKit] of KITS) {
  describe(`${name}: テナント設定の読み方（今の振る舞い）`, () => {
    it.each([
      ["setDecayClock", (s: Settings) => s.setDecayClock(ctx, "wall")],
      ["setDefaultHalfLifeRecalls", (s: Settings) => s.setDefaultHalfLifeRecalls(ctx, 720)],
      ["setTaxonomyMode", (s: Settings) => s.setTaxonomyMode(ctx, "open")],
    ] as const)(
      "保持期間を触らずに %s だけ書くと、getEventRetention は unset から unlimited になる（別テナントは unset のまま）",
      async (_label, write) => {
        const { settings } = await makeKit();
        expect(await settings.getEventRetention(ctx)).toEqual({ kind: "unset" });
        await write(settings);
        expect(await settings.getEventRetention(ctx)).toEqual({ kind: "unlimited" });
        expect(await settings.getEventRetention(other)).toEqual({ kind: "unset" });
      },
    );

    it("observe: LLM を待っている間に変えた既定の半減期が、その呼び出しで書く記憶に効く", async () => {
      const kit = await makeKit();
      const hold = holdNextCall();
      const pending = kit.runtime.observe(ctx, { kind: "utterance", text: "発話" });
      await hold.stopped;
      await kit.setDefaultHalfLifeHours(ctx, 10);
      hold.resume();
      const result = await pending;
      expect((await kit.memoryStore.get(ctx, result.memoryIds[0]!))?.halfLifeHours).toBe(10);
    });

    it("consolidate: LLM を待っている間に変えた既定の半減期が、統合した記憶に効く", async () => {
      const kit = await makeKit();
      const ids = [];
      for (const content of ["統合元 a", "統合元 b"]) {
        const memory = await kit.memoryStore.createMemory(
          ctx,
          buildNewMemoryFixture({ tenantId: ctx.tenantId, content, contentHash: content }),
        );
        ids.push(memory.id);
      }
      const hold = holdNextCall();
      const pending = kit.runtime.consolidate(ctx, { target: { memoryIds: ids } });
      await hold.stopped;
      await kit.setDefaultHalfLifeHours(ctx, 10);
      hold.resume();
      const result = await pending;
      expect(result.outcome).toBe("consolidated");
      expect((await kit.memoryStore.get(ctx, result.consolidatedMemoryId!))?.halfLifeHours).toBe(
        10,
      );
    });

    it("recall: 埋め込みを待っている間に変えた taxonomy は、その呼び出しには効かず、次の呼び出しから効く", async () => {
      const kit = await makeKit();
      const memory = await kit.memoryStore.createMemory(
        ctx,
        buildNewMemoryFixture({
          tenantId: ctx.tenantId,
          content: "ラベル付き",
          contentHash: "labelled",
          tags: ["topic"],
          embeddingStatus: "ready",
          decayFloorAt: new Date("2100-01-01T00:00:00.000Z"),
        }),
      );
      await kit.upsertVector(ctx, memory.id);
      const query = { text: "ラベル付き", labels: ["topic"], limit: 5 };
      const isTaxonomyFiltered = (o: { kind: string }) =>
        o.kind === "filtered" && (o as { condition?: string }).condition === "taxonomy";

      const hold = holdNextCall();
      const pending = kit.runtime.recall(ctx, query);
      await hold.stopped;
      await kit.settings.setTaxonomyMode(ctx, "strict");
      hold.resume();
      const thisCall = await pending;
      // 始めに読んだ open のまま動く: proposed ラベルの記憶は taxonomy では落ちない。
      expect(thisCall.omitted.filter(isTaxonomyFiltered)).toEqual([]);

      const nextCall = await kit.runtime.recall(ctx, query);
      expect(nextCall.omitted.filter(isTaxonomyFiltered)).toHaveLength(1);
    });
  });
}
