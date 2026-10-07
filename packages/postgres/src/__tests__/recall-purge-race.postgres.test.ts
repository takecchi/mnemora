import { createHash } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import type { Ctx, LLMProvider, MemoryStore, Runtime } from "@mnemora/core";
import { createRuntime } from "@mnemora/core";
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
 * `recall` の途中（`createRecall` に着く前）で、目次帯（`indexBand.digestBand`）に載る記憶が `forget` → `purge` されたときの振る舞い。
 *
 * `purge` が書き換えるのは「purge の時点で在る `recalls` の行」だけである。`recall` は目次帯を組んだ後で `createRecall` が行を INSERT するため、
 * その間に purge が終わると、purge 前の digest が INSERT される。約束しているのは「purge より前に撃った recall」で、同時に走っている recall は書かれていない。
 */

const llm: LLMProvider = {
  complete: async () => ({ content: "unused" }),
  completeStructured: async (_ctx, req) =>
    req.schema.parse({
      memories: [{ content: "猫は3匹いる", provenanceKind: "stated" as const }],
    }),
};

const shared = {
  llmProvider: llm,
  embeddingProvider: {
    space: TEST_EMBEDDING_SPACE,
    embed: async (_ctx: Ctx, texts: string[]) => texts.map(() => [1, 0, 0]),
  },
  hashContent: (content: string) => createHash("sha256").update(content).digest("hex"),
};

interface Gate {
  stopped: Promise<void>;
  resume: () => void;
}

function gateCreateRecall(store: MemoryStore): { store: MemoryStore; holdNext: () => Gate } {
  let holding = false;
  let release: () => void = () => {};
  let reached: () => void = () => {};
  let gate: Promise<void> = Promise.resolve();
  const wrapped = new Proxy(store, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target);
      if (prop === "createRecall") {
        return async (...args: Parameters<MemoryStore["createRecall"]>) => {
          if (holding) {
            holding = false;
            reached();
            await gate;
          }
          return target.createRecall(...args);
        };
      }
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return {
    store: wrapped,
    holdNext: () => {
      holding = true;
      gate = new Promise((resolve) => (release = resolve));
      const stopped = new Promise<void>((resolve) => (reached = resolve));
      return { stopped, resume: () => release() };
    },
  };
}

interface Kit {
  runtime: Runtime;
  memoryStore: MemoryStore;
  holdNext: () => Gate;
}

async function makeInMemoryKit(): Promise<Kit> {
  const base = new InMemoryMemoryStore();
  const { store, holdNext } = gateCreateRecall(base);
  return {
    memoryStore: store,
    holdNext,
    runtime: createRuntime({
      ...shared,
      memoryStore: store,
      eventStore: new InMemoryEventStore(base, base.events),
      vectorStore: new InMemoryVectorStore(base),
      outboxStore: new InMemoryOutboxStore(base.outboxJobs),
      tenantSettingsStore: new InMemoryTenantSettingsStore(base.activitySeq),
    }),
  };
}

async function makePostgresKit(): Promise<Kit> {
  await resetTestDatabase();
  const { db } = await getTestClient();
  const { store, holdNext } = gateCreateRecall(new PostgresMemoryStore(db));
  return {
    memoryStore: store,
    holdNext,
    runtime: createRuntime({
      ...shared,
      memoryStore: store,
      eventStore: new PostgresEventStore(db),
      vectorStore: new PostgresVectorStore(db),
      outboxStore: new PostgresOutboxStore(db),
      tenantSettingsStore: new PostgresTenantSettingsStore(db),
    }),
  };
}

const KITS: Array<[string, () => Promise<Kit>]> = [
  ["testkit の InMemory", makeInMemoryKit],
  ["Postgres", makePostgresKit],
];

const ctx: Ctx = { tenantId: "recall-purge-race" };

afterAll(async () => {
  await closeTestClient();
});

for (const [name, makeKit] of KITS) {
  describe(`${name}: recall が createRecall に着く前に、目次帯の記憶が forget → purge されたとき`, () => {
    // ⚠ 負債（望ましい姿ではなく、今の振る舞いを縛っている）。
    // 望ましいのは「purge が終わった後に記録された recall にも、元の digest は残らない」だが、
    // 直すには公開の約束（store 契約）か recall の熱い経路を動かす必要があるため、ここでは直さない。
    // 直したらこの it は「元の digest が残らない」へ書き換える。
    it("【負債】purge 後に記録された recall の digestBand には、purge 前の digest が残る（今の振る舞い）", async () => {
      const kit = await makeKit();
      const first = await kit.runtime.observe(ctx, { kind: "utterance", text: "猫は3匹いる" });
      const x = first.memoryIds[0]!;
      const original = (await kit.memoryStore.get(ctx, x))!.digest;
      expect(original).not.toBe("[purged]");

      const hold = kit.holdNext();
      const pending = kit.runtime.recall(ctx, { text: "猫" });
      await hold.stopped;
      expect((await kit.runtime.forget(ctx, { memoryId: x })).outcomes[0]?.kind).toBe("forgotten");
      expect((await kit.runtime.purge(ctx, { memoryId: x })).outcomes[0]?.kind).toBe("purged");
      hold.resume();
      const result = await pending;

      const record = await kit.runtime.getRecall(ctx, result.recallId);
      // 前提: この記憶は目次帯に載っていた（載っていなければ、この歯は何も見ていない）。
      const band = record!.indexBand.digestBand!;
      expect(band.map((e) => e.memoryId)).toEqual([x]);
      // 今の振る舞い: purge の書き換えは purge 時点の recalls 行にしか届かず、後から INSERT された行には元の digest が入る。
      expect(band).toEqual([{ memoryId: x, digest: original }]);
    });
  });
}
