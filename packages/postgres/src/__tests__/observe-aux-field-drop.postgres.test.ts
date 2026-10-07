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

/** 候補ごと落とさず、その欄だけを落とす。digest はフォールバックに、claim key は null に、tags はその要素だけ捨てる。落とした欄は `created` イベントの `meta.droppedFields` に残る（値そのものは写さない）。 */

interface FakeCandidate {
  content: string;
  digest?: string;
  tags?: string[];
  claim?: { subject: string; predicate: string };
}
let candidates: FakeCandidate[] = [];
const llm: LLMProvider = {
  complete: async () => ({ content: "unused" }),
  completeStructured: async (_ctx, req) => {
    if (req.prompt.system?.includes("claim key")) {
      return req.schema.parse({
        claims: candidates.map((c) => c.claim ?? { subject: "user", predicate: "likes" }),
      });
    }
    return req.schema.parse({
      memories: candidates.map(({ content, digest, tags }) => ({
        content,
        provenanceKind: "stated",
        ...(digest === undefined ? {} : { digest }),
        ...(tags === undefined ? {} : { tags }),
      })),
    });
  },
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

const ctx: Ctx = { tenantId: "observe-aux-field-drop" };
const NUL = "ab\u0000cd";
/** 圧縮が効く 4 バイト文字の 513 字。以前から保存できていた値で、字数では落とさない（ADR 0443 決定1）。 */
const LONG_COMPRESSIBLE_TAG = "\u{1F600}".repeat(513);

async function observeWith(
  kit: Kit,
  given: FakeCandidate[],
  externalId: string,
  extra: { claimKey?: boolean; extract?: "sync" | "deferred" } = {},
) {
  candidates = given;
  const input = {
    kind: "utterance" as const,
    text: "発話",
    externalId,
    extract: extra.extract ?? ("sync" as const),
    ...(extra.claimKey === true ? { claimKey: { enabled: true } } : {}),
  };
  const result = await kit.runtime.observe(ctx, input);
  if (extra.extract === "deferred") {
    await kit.runtime.tick(ctx, { kinds: ["extract"], leaseMs: 60_000 });
  }
  const memories = await kit.memoryStore.listBySourceObservation(ctx, result.observationId, "v1");
  const created = await kit.eventStore.list(ctx, { kind: "created" });
  const byContent = (content: string) => memories.find((m) => m.content === content);
  return { result, memories, byContent, createdMetas: created.map((e) => e.meta ?? {}) };
}

afterAll(async () => {
  await closeTestClient();
});

for (const [name, makeKit] of KITS) {
  describe(`${name}: 補助の欄が保存できない値のときは、その欄だけを落とす（ADR 0443）`, () => {
    it("digest に NUL: 候補は残り、digest はフォールバックになる。meta.droppedFields に残る（値は写さない）", async () => {
      const kit = await makeKit();
      const got = await observeWith(
        kit,
        [{ content: "一件目の事実" }, { content: "二件目の事実", digest: NUL }],
        "digest-nul",
      );
      expect(got.memories.map((m) => m.content).sort()).toEqual(["一件目の事実", "二件目の事実"]);
      const second = got.byContent("二件目の事実")!;
      expect(second.digestSource).toBe("fallback");
      expect(second.digest).not.toContain("\u0000");
      expect(got.createdMetas).toHaveLength(2);
      for (const meta of got.createdMetas) {
        expect(meta.droppedFields).toEqual([
          {
            index: 1,
            contentHash: hashContent("二件目の事実"),
            field: "digest",
            reason: "nul_character",
          },
        ]);
        expect(meta).not.toHaveProperty("droppedCandidates");
        expect(JSON.stringify(meta)).not.toContain("\\u0000");
      }
    });

    it("tags: NUL の要素だけを捨て、圧縮が効く 513 字以上の要素を含むほかの要素は並びも含めて残す", async () => {
      const kit = await makeKit();
      const got = await observeWith(
        kit,
        [
          {
            content: "一件目の事実",
            digest: "要旨",
            tags: ["a", NUL, "b", LONG_COMPRESSIBLE_TAG, "a"],
          },
        ],
        "tags",
      );
      const memory = got.byContent("一件目の事実")!;
      expect(memory.tags).toEqual(["a", "b", LONG_COMPRESSIBLE_TAG, "a"]);
      expect(memory.digest).toBe("要旨");
      expect(memory.digestSource).toBe("llm");
      expect(got.createdMetas).toHaveLength(1);
      expect(got.createdMetas[0]!.droppedFields).toEqual([
        {
          index: 0,
          contentHash: hashContent("一件目の事実"),
          field: "tags",
          reason: "nul_character",
          count: 1,
          tagIndexes: [1],
        },
      ]);
    });

    it("tags が何万件も NUL でも、meta の添字は上限で切る", async () => {
      const kit = await makeKit();
      const got = await observeWith(
        kit,
        [{ content: "一件目の事実", tags: Array.from({ length: 5000 }, () => NUL) }],
        "tags-many",
      );
      expect(got.byContent("一件目の事実")!.tags).toEqual([]);
      const dropped = got.createdMetas[0]!.droppedFields as Array<Record<string, unknown>>;
      expect(dropped[0]!.count).toBe(5000);
      expect(dropped[0]!.tagIndexes).toHaveLength(20);
    });

    it("claim key に NUL: 候補は残り、claimKey は null になる", async () => {
      const kit = await makeKit();
      const got = await observeWith(
        kit,
        [
          { content: "一件目の事実", claim: { subject: "user", predicate: "likes\u0000" } },
          { content: "二件目の事実", claim: { subject: "user", predicate: "eats" } },
        ],
        "claim-nul",
        { claimKey: true },
      );
      expect(got.memories).toHaveLength(2);
      expect(got.byContent("一件目の事実")!.claimKey).toBeNull();
      expect(got.byContent("二件目の事実")!.claimKey).toEqual({
        subject: "user",
        predicate: "eats",
      });
    });

    it("deferred の extract ジョブでも同じ", async () => {
      const kit = await makeKit();
      const got = await observeWith(
        kit,
        [{ content: "一件目の事実", digest: NUL, tags: [NUL, "x"] }],
        "deferred",
        { extract: "deferred" },
      );
      const memory = got.byContent("一件目の事実")!;
      expect(memory.digestSource).toBe("fallback");
      expect(memory.tags).toEqual(["x"]);
    });

    it("reextract でも同じ（候補は残り、created の meta に残る）", async () => {
      const kit = await makeKit();
      await observeWith(kit, [{ content: "旧い事実" }], "reextract");
      const observed = await kit.runtime.observe(ctx, {
        kind: "utterance",
        text: "発話2",
        externalId: "reextract-2",
      });
      candidates = [{ content: "新しい事実", digest: NUL, tags: ["x", NUL] }];
      const result = await kit.runtime.reextract(ctx, observed.observationId);
      expect(result.extraction).toBe("ok");
      const memory = await kit.memoryStore.get(ctx, result.memoryIds[0]!);
      expect(memory?.digestSource).toBe("fallback");
      expect(memory?.tags).toEqual(["x"]);
      const created = await kit.eventStore.list(ctx, { kind: "created" });
      const fields = created
        .filter((e) => e.memoryId === result.memoryIds[0])
        .map((e) => (e.meta?.droppedFields as Array<{ field: string }>).map((f) => f.field));
      expect(fields).toEqual([["digest", "tags"]]);
    });

    it("本文の NUL は従来どおり候補ごと落ちる（補助の欄だけを落とす対象は本文ではない）", async () => {
      const kit = await makeKit();
      const got = await observeWith(
        kit,
        [{ content: "一件目の事実" }, { content: NUL, digest: NUL }],
        "content-nul",
      );
      expect(got.memories.map((m) => m.content)).toEqual(["一件目の事実"]);
      const dropped = got.createdMetas[0]!.droppedCandidates as Array<{ index: number }>;
      expect(dropped.map((d) => d.index)).toEqual([1]);
    });

    it("保存できる補助の欄は1文字も変えない（512 字ちょうどの tag・前後の空白・長い digest）", async () => {
      const kit = await makeKit();
      const tag512 = "\u{1F600}".repeat(512);
      const longDigest = "あ".repeat(100_000);
      const got = await observeWith(
        kit,
        [{ content: "一件目の事実", digest: longDigest, tags: [tag512, " x "] }],
        "ok",
      );
      const memory = got.byContent("一件目の事実")!;
      expect(memory.digest).toBe(longDigest);
      expect(memory.digestSource).toBe("llm");
      expect(memory.tags).toEqual([tag512, " x "]);
      expect(Object.keys(got.createdMetas[0]!).sort()).toEqual(
        ["extractorVersion", "reason", "sourceObservationId"].sort(),
      );
    });
  });
}
