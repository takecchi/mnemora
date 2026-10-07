import { createHash } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import type { Ctx, EventStore, LLMProvider, Runtime } from "@mnemora/core";
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

/** core の Fake の store では jsonb の往復（数値の `contentLatinShare` が数のまま戻るか、キーが落ちないか）を見られないので、実 adapter（testkit の InMemory と Postgres）にも sync・deferred・`reextract` の3経路を当てる。 */

const JA_TEXT = "今日は渋谷のパン屋で働いています。毎朝パンを焼くのが好きです。";
const EN_CONTENT = "The user works at a bakery in Shibuya and enjoys baking bread every morning.";
const JA_CONTENT = "ユーザーは渋谷のパン屋で働いており、毎朝パンを焼くのが好き。";
/** 本文のラテン文字は 62 字、割合は 1（`EN_CONTENT` を数えた値。判定の規則を変えたらここも見直す）。 */
const EXPECTED_MARK = {
  rule: "cjk_observation_latin_content",
  contentLatinLetters: 62,
  contentLatinShare: 1,
};

/** extract の LLM が順に返す本文。`null` は LLM の失敗。 */
let outputs: Array<string | null> = [];
const llm: LLMProvider = {
  complete: async () => ({ content: "unused" }),
  completeStructured: async (_ctx, req) => {
    const next = outputs.shift();
    if (next === null) throw new Error("LLM が落ちた");
    if (next === undefined) throw new Error("unexpected LLM call");
    return req.schema.parse({ memories: [{ content: next, provenanceKind: "stated" }] });
  },
};

const shared = {
  clock: { now: () => new Date() },
  llmProvider: llm,
  embeddingProvider: {
    space: TEST_EMBEDDING_SPACE,
    embed: async (_ctx: Ctx, texts: string[]) => texts.map(() => [1, 0, 0]),
  },
  hashContent: (content: string) => createHash("sha256").update(content).digest("hex"),
};

interface Kit {
  runtime: Runtime;
  eventStore: EventStore;
}

const KITS: Array<[string, () => Promise<Kit>]> = [
  [
    "testkit の InMemory",
    async () => {
      const memoryStore = new InMemoryMemoryStore();
      const eventStore = new InMemoryEventStore(memoryStore, memoryStore.events);
      return {
        eventStore,
        runtime: createRuntime({
          ...shared,
          memoryStore,
          eventStore,
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
      const eventStore = new PostgresEventStore(db);
      return {
        eventStore,
        runtime: createRuntime({
          ...shared,
          memoryStore: new PostgresMemoryStore(db),
          eventStore,
          vectorStore: new PostgresVectorStore(db),
          outboxStore: new PostgresOutboxStore(db),
          tenantSettingsStore: new PostgresTenantSettingsStore(db),
        }),
      };
    },
  ],
];

const ctx: Ctx = { tenantId: "language-mismatch-mark-postgres" };

afterAll(async () => {
  await closeTestClient();
});

async function createdMetas(kit: Kit) {
  return (await kit.eventStore.list(ctx, { kind: "created" })).map((e) => e.meta ?? {});
}

describe.each(KITS)(
  "言語の事後検査の印は実 adapter を通っても同じ形で読み戻る: %s",
  (_name, make) => {
    it("sync: 英語の本文なら印が付き、値が数のまま戻る", async () => {
      const kit = await make();
      outputs = [EN_CONTENT];
      await kit.runtime.observe(ctx, { kind: "utterance", text: JA_TEXT });
      const metas = await createdMetas(kit);
      expect(metas).toHaveLength(1);
      expect(metas[0]!.languageMismatch).toEqual(EXPECTED_MARK);
    });

    it("deferred: tick の抽出でも同じ印が付く", async () => {
      const kit = await make();
      outputs = [EN_CONTENT];
      await kit.runtime.observe(ctx, { kind: "utterance", text: JA_TEXT, extract: "deferred" });
      const tick = await kit.runtime.tick(ctx, { kinds: ["extract"], leaseMs: 60_000 });
      expect(tick.processed).toBe(1);
      const metas = await createdMetas(kit);
      expect(metas).toHaveLength(1);
      expect(metas[0]!.languageMismatch).toEqual(EXPECTED_MARK);
    });

    it("reextract: 作り直した記憶の created に印が付き、reextracted の印と同居する", async () => {
      const kit = await make();
      outputs = [JA_CONTENT, EN_CONTENT];
      const observed = await kit.runtime.observe(ctx, { kind: "utterance", text: JA_TEXT });
      await kit.runtime.reextract(ctx, observed.observationId);
      const metas = await createdMetas(kit);
      expect(metas).toHaveLength(2);
      const marked = metas.filter((m) => m.languageMismatch !== undefined);
      expect(marked).toHaveLength(1);
      expect(marked[0]!.languageMismatch).toEqual(EXPECTED_MARK);
      expect(marked[0]!.reextracted).toBe(true);
      const plain = metas.find((m) => m.languageMismatch === undefined);
      expect(Object.keys(plain!).sort()).toEqual(
        ["extractorVersion", "reason", "sourceObservationId"].sort(),
      );
    });

    it("日本語の本文なら、キー自体が無い（null も入らない）", async () => {
      const kit = await make();
      outputs = [JA_CONTENT];
      await kit.runtime.observe(ctx, { kind: "utterance", text: JA_TEXT });
      const metas = await createdMetas(kit);
      expect(metas).toHaveLength(1);
      expect("languageMismatch" in metas[0]!).toBe(false);
    });
  },
);
