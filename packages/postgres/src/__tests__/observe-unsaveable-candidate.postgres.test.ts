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
 * LLM の抽出結果が schema は通るが store に保存できない値を含むときの、`observe()`（同期の抽出）の今の振る舞いを
 * 縛る（Issue #1063。`Runtime.observe` の doc の 2026-09-28 追記）。振る舞いは変えていない。
 *
 * - 候補は1件ずつ書かれ、1つのトランザクションではない。⟹ 保存できない候補の手前の候補は書かれたまま、
 *   `observe()` が例外を投げる。全文フォールバックの Memory は作られない（LLM 自体は成功しているため）。
 * - 保存できる値の範囲は store で違う: 本文の NUL は2実装とも拒む。語の多い 1MB 超の本文は、Postgres が
 *   tsvector の上限で拒み、testkit の fixture は受け入れる。
 */

let candidates: string[] = [];
const llm: LLMProvider = {
  complete: async () => ({ content: "unused" }),
  completeStructured: async (_ctx, req) =>
    req.schema.parse({
      memories: candidates.map((content) => ({ content, provenanceKind: "stated" })),
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

const ctx: Ctx = { tenantId: "observe-unsaveable-candidate" };
/** 語の多い 1MB 超の本文（Postgres の tsvector の上限を超える、#1222）。 */
const HUGE = Array.from({ length: 200_000 }, (_, i) => `w${i}`).join(" ");

/** 3件の候補の2件目を `bad` にして observe し、例外の有無と、その Observation から作られた本文を返す。 */
async function observeWithBadSecond(kit: Kit, bad: string, externalId: string) {
  candidates = ["一件目の事実", bad, "三件目の事実"];
  const input = { kind: "utterance" as const, text: "発話", externalId };
  const threw = await kit.runtime.observe(ctx, input).then(
    () => false,
    () => true,
  );
  // 同じ externalId の再送は抽出をやり直さず、Observation の id だけを返す。
  const resent = await kit.runtime.observe(ctx, input);
  expect(resent.extraction).toBe("skipped");
  const memories = await kit.memoryStore.listBySourceObservation(ctx, resent.observationId, "v1");
  return { threw, contents: memories.map((m) => m.content).sort() };
}

afterAll(async () => {
  await closeTestClient();
});

for (const [name, makeKit] of KITS) {
  describe(`${name}: 保存できない候補を含む抽出結果（今の振る舞い）`, () => {
    it("本文に NUL: observe は例外で、手前の1件目だけが残る（全文フォールバックは無い）", async () => {
      const kit = await makeKit();
      expect(await observeWithBadSecond(kit, "二件目\u0000", "nul")).toEqual({
        threw: true,
        contents: ["一件目の事実"],
      });
    });

    it(
      name === "Postgres"
        ? "語の多い 1MB 超の本文: Postgres は例外で、手前の1件目だけが残る"
        : "語の多い 1MB 超の本文: testkit の fixture は受け入れ、3件とも書く",
      async () => {
        const kit = await makeKit();
        const got = await observeWithBadSecond(kit, HUGE, "huge");
        if (name === "Postgres") {
          expect(got).toEqual({ threw: true, contents: ["一件目の事実"] });
        } else {
          expect(got.threw).toBe(false);
          expect(got.contents).toHaveLength(3);
        }
      },
    );
  });
}
