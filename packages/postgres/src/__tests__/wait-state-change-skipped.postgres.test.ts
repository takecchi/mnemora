import { createHash } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import type { Ctx, EventStore, LLMProvider, MemoryStore, Runtime } from "@mnemora/core";
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
 * LLM を待つ間に元の記憶が `contested`（と、訂正の解決で負けた `superseded`）になったとき、
 * `reextract`・`consolidate`・`reflect` の3経路が書かずに打ち切ること（ADR 0544。ADR 0406 の
 * 「引き受けた負債」1 と ADR 0454 の負債1・5 を覆す）。
 *
 * 対照の歯（従来どおりの振る舞いが変わっていないこと）も同じ場所に置く:
 * 待つ間に何も変わらなければ従来どおり書かれる／archived は（LLM の前の門が通すので）従来どおり。
 * 世代の往復（ADR 0454 負債6）は変えない（ADR 0544 決定4）——そちらの歯は
 * `reextract-anchor-must-be-active.postgres.test.ts`。
 *
 * testkit の InMemory と Postgres を、`supersedeWithNewMemories` の口の有無の2経路ずつ（計4通り）で当てる。
 */

let release: () => void = () => {};
let reached: () => void = () => {};
let gate: Promise<void> = Promise.resolve();
let holding = false;
let extractContents: string[] = [];
function holdNextCall(): { stopped: Promise<void>; resume: () => void } {
  holding = true;
  gate = new Promise((resolve) => (release = resolve));
  const stopped = new Promise<void>((resolve) => (reached = resolve));
  return { stopped, resume: () => release() };
}

const llm: LLMProvider = {
  complete: async () => ({ content: "unused" }),
  completeStructured: async (_ctx, req) => {
    if (holding) {
      holding = false;
      reached();
      await gate;
    }
    const extraction = req.schema.safeParse({
      memories: extractContents.map((content) => ({ content, provenanceKind: "stated" as const })),
    });
    if (extraction.success) return extraction.data;
    const reflected = req.schema.safeParse({
      outcome: "reflected",
      content: "内省",
      digest: "内省",
    });
    if (reflected.success) return reflected.data;
    return req.schema.parse({ content: "統合", digest: "統合" });
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
  eventStore: EventStore;
}

function withoutSupersedePort(store: MemoryStore): MemoryStore {
  return new Proxy(store, {
    get(target, prop) {
      if (prop === "supersedeWithNewMemories") return undefined;
      const value = Reflect.get(target, prop, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

async function makeInMemoryKit(hidePort: boolean): Promise<Kit> {
  const base = new InMemoryMemoryStore();
  const eventStore = new InMemoryEventStore(base, base.events);
  const memoryStore = hidePort ? withoutSupersedePort(base) : base;
  return {
    memoryStore,
    eventStore,
    runtime: createRuntime({
      ...shared,
      memoryStore,
      eventStore,
      vectorStore: new InMemoryVectorStore(base),
      outboxStore: new InMemoryOutboxStore(base.outboxJobs),
      tenantSettingsStore: new InMemoryTenantSettingsStore(base.activitySeq),
    }),
  };
}

async function makePostgresKit(hidePort: boolean): Promise<Kit> {
  await resetTestDatabase();
  const { db } = await getTestClient();
  const base = new PostgresMemoryStore(db);
  const eventStore = new PostgresEventStore(db);
  const memoryStore = hidePort ? withoutSupersedePort(base) : base;
  return {
    memoryStore,
    eventStore,
    runtime: createRuntime({
      ...shared,
      memoryStore,
      eventStore,
      vectorStore: new PostgresVectorStore(db),
      outboxStore: new PostgresOutboxStore(db),
      tenantSettingsStore: new PostgresTenantSettingsStore(db),
    }),
  };
}

const KITS: Array<[string, () => Promise<Kit>]> = [
  ["testkit の InMemory", () => makeInMemoryKit(false)],
  ["testkit の InMemory・supersedeWithNewMemories の口なし", () => makeInMemoryKit(true)],
  ["Postgres", () => makePostgresKit(false)],
  ["Postgres・supersedeWithNewMemories の口なし", () => makePostgresKit(true)],
];

const ctx: Ctx = { tenantId: "wait-state-change-skipped" };
let seq = 0;

afterAll(async () => {
  await closeTestClient();
});

async function createActive(kit: Kit, content: string) {
  seq += 1;
  return kit.memoryStore.createMemory(
    ctx,
    buildNewMemoryFixture({
      tenantId: ctx.tenantId,
      contentHash: `wait-state-${seq}`,
      content,
      digest: content,
    }),
  );
}

async function statusOf(kit: Kit, id: string) {
  return (await kit.memoryStore.get(ctx, id))!.status;
}

for (const [name, makeKit] of KITS) {
  describe(`${name}: reextract が LLM を待つ間に、元の記憶の状態が変わったとき（ADR 0544）`, () => {
    /** X を観測から作り、別の記憶 Y を作る（X と Y を訂正の対にするために使う）。 */
    async function setup(kit: Kit) {
      extractContents = ["猫は3匹"];
      const first = await kit.runtime.observe(ctx, { kind: "utterance", text: "猫は3匹いる" });
      const x = first.memoryIds[0]!;
      const y = (await createActive(kit, "猫は2匹")).id;
      return { first, x, y };
    }

    it("X が contested になったら、言い換えは書かれず、skipped に status: contested が載る", async () => {
      const kit = await makeKit();
      const { first, x, y } = await setup(kit);
      extractContents = ["猫を3匹飼っている"];
      const hold = holdNextCall();
      const pending = kit.runtime.reextract(ctx, first.observationId);
      await hold.stopped;
      await kit.runtime.markContested(ctx, x, y);
      hold.resume();
      const result = await pending;

      expect(result).toMatchObject({
        memoryIds: [],
        supersededMemoryIds: [],
        atomicity: "not_attempted",
        extraction: "skipped",
        extractionFailure: null,
      });
      expect(result.skipped).toEqual([
        { kind: "status_not_active", memoryId: x, status: "contested" },
      ]);
      const all = await kit.memoryStore.listBySourceObservationAllVersions(
        ctx,
        first.observationId,
      );
      expect(all.map((m) => ({ id: m.id, status: m.status }))).toEqual([
        { id: x, status: "contested" },
      ]);
    });

    it("X が訂正の解決で負けて superseded になったら、言い換えは書かれない", async () => {
      const kit = await makeKit();
      const { first, x, y } = await setup(kit);
      extractContents = ["猫を3匹飼っている"];
      const hold = holdNextCall();
      const pending = kit.runtime.reextract(ctx, first.observationId);
      await hold.stopped;
      await kit.runtime.markContested(ctx, x, y);
      await kit.runtime.resolveContested(ctx, x, y, { kind: "supersede", winnerId: y });
      hold.resume();
      const result = await pending;

      expect(result).toMatchObject({
        memoryIds: [],
        supersededMemoryIds: [],
        extraction: "skipped",
      });
      expect(result.skipped).toEqual([
        { kind: "status_not_active", memoryId: x, status: "superseded" },
      ]);
      const all = await kit.memoryStore.listBySourceObservationAllVersions(
        ctx,
        first.observationId,
      );
      expect(all.map((m) => m.status)).toEqual(["superseded"]);
    });

    it("2件のうち X だけが contested になっても、もう1件 Z は置き換えられず、何も書かれない", async () => {
      const kit = await makeKit();
      extractContents = ["猫は3匹", "犬は1匹"];
      const first = await kit.runtime.observe(ctx, { kind: "utterance", text: "猫は3匹、犬は1匹" });
      const [x, z] = first.memoryIds as [string, string];
      const y = (await createActive(kit, "猫は2匹")).id;
      extractContents = ["猫を3匹飼っている", "犬を1匹飼っている"];
      const hold = holdNextCall();
      const pending = kit.runtime.reextract(ctx, first.observationId);
      await hold.stopped;
      await kit.runtime.markContested(ctx, x, y);
      hold.resume();
      const result = await pending;

      expect(result.memoryIds).toEqual([]);
      expect(result.supersededMemoryIds).toEqual([]);
      expect(result.skipped).toEqual([
        { kind: "status_not_active", memoryId: x, status: "contested" },
      ]);
      expect(await statusOf(kit, z)).toBe("active");
      const all = await kit.memoryStore.listBySourceObservationAllVersions(
        ctx,
        first.observationId,
      );
      expect(all).toHaveLength(2);
    });

    it("対照: 待つ間に何も変わらなければ、従来どおり言い換えが書かれ、X は置き換えられる", async () => {
      const kit = await makeKit();
      const { first, x } = await setup(kit);
      extractContents = ["猫を3匹飼っている"];
      const hold = holdNextCall();
      const pending = kit.runtime.reextract(ctx, first.observationId);
      await hold.stopped;
      hold.resume();
      const result = await pending;

      expect(result.extraction).toBe("ok");
      expect(result.memoryIds).toHaveLength(1);
      expect(result.supersededMemoryIds).toEqual([x]);
      expect(await statusOf(kit, x)).toBe("superseded");
    });

    it("対照: 待つ間に X が archived になっても、従来どおり言い換えが書かれる（LLM の前の門も archived は通す）", async () => {
      const kit = await makeKit();
      const { first, x } = await setup(kit);
      extractContents = ["猫を3匹飼っている"];
      const hold = holdNextCall();
      const pending = kit.runtime.reextract(ctx, first.observationId);
      await hold.stopped;
      await kit.memoryStore.updateStatus(ctx, x, "archived", { expectedStatus: "active" });
      hold.resume();
      const result = await pending;

      expect(result.extraction).toBe("ok");
      expect(result.memoryIds).toHaveLength(1);
      expect(await statusOf(kit, x)).toBe("archived");
    });
  });

  describe(`${name}: consolidate・reflect が LLM を待つ間に、元の記憶が contested になったとき（ADR 0544）`, () => {
    it("consolidate: A が contested になったら、統合先を作らず aborted_source_status_changed で打ち切る（B は active のまま）", async () => {
      const kit = await makeKit();
      const a = await createActive(kit, "A");
      const b = await createActive(kit, "B");
      const other = await createActive(kit, "A'");
      const hold = holdNextCall();
      const pending = kit.runtime.consolidate(ctx, { target: { memoryIds: [a.id, b.id] } });
      await hold.stopped;
      await kit.runtime.markContested(ctx, a.id, other.id);
      hold.resume();
      const result = await pending;

      expect(result.outcome).toBe("aborted_source_status_changed");
      expect(result.consolidatedMemoryId).toBeNull();
      expect(result.sources).toEqual([
        { memoryId: a.id, kind: "status_changed_concurrently", observedStatus: "contested" },
        { memoryId: b.id, kind: "not_attempted" },
      ]);
      expect(await statusOf(kit, a.id)).toBe("contested");
      expect(await statusOf(kit, b.id)).toBe("active");
    });

    it("reflect: 材料の A が contested になったら、内省を作らず aborted_source_status_changed で打ち切る", async () => {
      const kit = await makeKit();
      const a = await createActive(kit, "A");
      const b = await createActive(kit, "B");
      const other = await createActive(kit, "A'");
      const hold = holdNextCall();
      const pending = kit.runtime.reflect(ctx, { target: { memoryIds: [a.id, b.id] } });
      await hold.stopped;
      await kit.runtime.markContested(ctx, a.id, other.id);
      hold.resume();
      const result = await pending;

      expect(result.outcome).toBe("aborted_source_status_changed");
      expect(result.reflectedMemoryId).toBeNull();
      expect(result.basis).toEqual([
        { memoryId: a.id, kind: "status_changed_before_write", observedStatus: "contested" },
        { memoryId: b.id, kind: "eligible" },
      ]);
    });

    it("対照: consolidate は待つ間に何も変わらなければ従来どおり統合される", async () => {
      const kit = await makeKit();
      const a = await createActive(kit, "A");
      const b = await createActive(kit, "B");
      const hold = holdNextCall();
      const pending = kit.runtime.consolidate(ctx, { target: { memoryIds: [a.id, b.id] } });
      await hold.stopped;
      hold.resume();
      const result = await pending;
      expect(result.outcome).toBe("consolidated");
    });

    it("対照: reflect は待つ間に何も変わらなければ従来どおり内省が書かれる", async () => {
      const kit = await makeKit();
      const a = await createActive(kit, "A");
      const b = await createActive(kit, "B");
      const hold = holdNextCall();
      const pending = kit.runtime.reflect(ctx, { target: { memoryIds: [a.id, b.id] } });
      await hold.stopped;
      hold.resume();
      const result = await pending;
      expect(result.outcome).toBe("reflected");
    });

    it("対照: consolidate は A だけ archived になった場合、従来どおり部分成功する（ADR 0420 の約束）", async () => {
      const kit = await makeKit();
      const a = await createActive(kit, "A");
      const b = await createActive(kit, "B");
      const hold = holdNextCall();
      const pending = kit.runtime.consolidate(ctx, { target: { memoryIds: [a.id, b.id] } });
      await hold.stopped;
      await kit.memoryStore.updateStatus(ctx, a.id, "archived", { expectedStatus: "active" });
      hold.resume();
      const result = await pending;
      expect(result.outcome).toBe("consolidated");
      expect(result.sources[0]).toMatchObject({
        kind: "status_changed_concurrently",
        observedStatus: "archived",
      });
    });

    it("対照: reflect は材料の A が archived になっても、従来どおり内省が書かれる", async () => {
      const kit = await makeKit();
      const a = await createActive(kit, "A");
      const b = await createActive(kit, "B");
      const hold = holdNextCall();
      const pending = kit.runtime.reflect(ctx, { target: { memoryIds: [a.id, b.id] } });
      await hold.stopped;
      await kit.memoryStore.updateStatus(ctx, a.id, "archived", { expectedStatus: "active" });
      hold.resume();
      const result = await pending;
      expect(result.outcome).toBe("reflected");
    });
  });
}
