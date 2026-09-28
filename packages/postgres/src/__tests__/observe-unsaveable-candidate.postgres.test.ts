import { createHash } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import type { Ctx, EventStore, LLMProvider, MemoryStore, Runtime } from "@mnemora/core";
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
 * LLM の抽出結果が schema は通るが store に保存できない値を含むときの、抽出の書き込みを縛る
 * （Issue #1063。`Runtime.observe` の doc）。
 *
 * - 保存できない候補だけを落とし、残りの候補は書く。`observe()` は投げない。落とした候補は、残った候補の
 *   `created` イベントの `meta.droppedCandidates` に残る（`observe()` の戻り値には出ない）。
 * - 全件が保存できなければ、今どおり最初の例外を投げ、何も書かない。
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

const hashContent = (content: string) => createHash("sha256").update(content).digest("hex");
const shared = {
  llmProvider: llm,
  embeddingProvider: {
    space: TEST_EMBEDDING_SPACE,
    embed: async (_ctx: Ctx, texts: string[]) => texts.map(() => [1, 0, 0]),
  },
  hashContent,
};

interface Kit {
  runtime: Runtime;
  memoryStore: MemoryStore;
  eventStore: EventStore;
}

const KITS: Array<[string, () => Promise<Kit>]> = [
  [
    "testkit の InMemory",
    async () => {
      const memoryStore = new InMemoryMemoryStore();
      const eventStore = new InMemoryEventStore(memoryStore, memoryStore.events);
      return {
        memoryStore,
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
      const memoryStore = new PostgresMemoryStore(db);
      const eventStore = new PostgresEventStore(db);
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
    },
  ],
];

const ctx: Ctx = { tenantId: "observe-unsaveable-candidate" };
/** 語の多い 1MB 超の本文（Postgres の tsvector の上限を超える、#1222）。 */
const HUGE = Array.from({ length: 200_000 }, (_, i) => `w${i}`).join(" ");
const NUL = "二件目\u0000";

/**
 * `candidates` で observe し、例外の有無・その Observation から作られた本文・`created` の meta・
 * extract ジョブが完了したか（あとの `tick` が拾わないか）を返す。
 */
async function observeWith(
  kit: Kit,
  given: string[],
  externalId: string,
  extract: "sync" | "deferred" = "sync",
) {
  candidates = given;
  const input = { kind: "utterance" as const, text: "発話", externalId, extract };
  const threw = await kit.runtime.observe(ctx, input).then(
    () => false,
    () => true,
  );
  // 同じ externalId の再送は抽出をやり直さず、Observation の id だけを返す。
  const resent = await kit.runtime.observe(ctx, input);
  expect(resent.extraction).toBe("skipped");
  const tick = await kit.runtime.tick(ctx, { kinds: ["extract"], leaseMs: 60_000 });
  const memories = await kit.memoryStore.listBySourceObservation(ctx, resent.observationId, "v1");
  const created = await kit.eventStore.list(ctx, { kind: "created" });
  return {
    threw,
    contents: memories.map((m) => m.content).sort(),
    createdMetas: created.map((e) => e.meta ?? {}),
    tick: { processed: tick.processed, failed: tick.failed },
  };
}

afterAll(async () => {
  await closeTestClient();
});

for (const [name, makeKit] of KITS) {
  describe(`${name}: 保存できない候補を含む抽出結果（#1063）`, () => {
    it("本文に NUL: その候補だけを落として残りを書き、observe は投げない。落とした候補は created の meta に残る", async () => {
      const kit = await makeKit();
      const got = await observeWith(kit, ["一件目の事実", NUL, "三件目の事実"], "nul");
      expect(got.threw).toBe(false);
      expect(got.contents).toEqual(["一件目の事実", "三件目の事実"]);
      // sync の extract ジョブは完了している（あとの tick が拾い直さない）。
      expect(got.tick).toEqual({ processed: 0, failed: 0 });
      expect(got.createdMetas).toHaveLength(2);
      for (const meta of got.createdMetas) {
        expect(meta.reason).toBe("extracted");
        const dropped = meta.droppedCandidates as Array<Record<string, unknown>>;
        expect(dropped).toHaveLength(1);
        expect(dropped[0]).toMatchObject({ index: 1, contentHash: hashContent(NUL) });
        expect(typeof dropped[0]!.message).toBe("string");
        // 理由は最も内側の原因から取る: Postgres は pg のエラー（SQLSTATE 22021）、fixture は code を名乗らない。
        expect(dropped[0]!.code).toBe(name === "Postgres" ? "22021" : null);
        // 保存できない値（NUL）そのものは写さない。
        expect(JSON.stringify(dropped[0])).not.toContain("\\u0000");
      }
    });

    it(
      name === "Postgres"
        ? "語の多い 1MB 超の本文: Postgres はその候補だけを落として残りを書く"
        : "語の多い 1MB 超の本文: testkit の fixture は受け入れ、3件とも書く",
      async () => {
        const kit = await makeKit();
        const got = await observeWith(kit, ["一件目の事実", HUGE, "三件目の事実"], "huge");
        expect(got.threw).toBe(false);
        if (name === "Postgres") {
          expect(got.contents).toEqual(["一件目の事実", "三件目の事実"]);
          const dropped = got.createdMetas[0]!.droppedCandidates as Array<Record<string, unknown>>;
          expect(dropped.map((d) => d.index)).toEqual([1]);
          // 落とした記録に本文を写さない（1MB を meta に載せない）。
          expect(JSON.stringify(got.createdMetas).length).toBeLessThan(10_000);
        } else {
          expect(got.contents).toHaveLength(3);
          expect(got.createdMetas.every((m) => !("droppedCandidates" in m))).toBe(true);
        }
      },
    );

    it("deferred の extract ジョブでも、保存できない候補だけを落として残りを書き、ジョブは完了する", async () => {
      const kit = await makeKit();
      const got = await observeWith(
        kit,
        ["一件目の事実", NUL, "三件目の事実"],
        "deferred",
        "deferred",
      );
      expect(got.threw).toBe(false);
      expect(got.contents).toEqual(["一件目の事実", "三件目の事実"]);
      expect(got.tick).toEqual({ processed: 1, failed: 0 });
    });

    // ---- やりすぎを捕まえる歯 ----

    it("全件が保存できなければ、今どおり observe は例外で、何も書かない", async () => {
      const kit = await makeKit();
      const got = await observeWith(kit, [NUL, "三件目\u0000"], "all-bad");
      expect(got.threw).toBe(true);
      expect(got.contents).toEqual([]);
      expect(got.createdMetas).toEqual([]);
      // 今どおり: sync の extract ジョブは完了にならずに残り、tick の再試行も同じ所で落ちる。
      expect(got.tick).toEqual({ processed: 0, failed: 1 });
    });

    it("正常な候補だけなら、今どおり全件を書き、created の meta も変わらない", async () => {
      const kit = await makeKit();
      const got = await observeWith(kit, ["一件目の事実", "二件目の事実", "三件目の事実"], "ok");
      expect(got.threw).toBe(false);
      expect(got.contents).toEqual(["一件目の事実", "三件目の事実", "二件目の事実"]);
      expect(got.tick).toEqual({ processed: 0, failed: 0 });
      expect(got.createdMetas).toHaveLength(3);
      for (const meta of got.createdMetas) {
        expect(Object.keys(meta).sort()).toEqual(
          ["extractorVersion", "reason", "sourceObservationId"].sort(),
        );
      }
    });
  });
}
