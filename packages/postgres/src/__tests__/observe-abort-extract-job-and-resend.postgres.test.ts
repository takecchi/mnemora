import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
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
 * ADR 0454（穴探し30巡目）:
 *
 * 1. `extract: 'sync'` の `observe` が abort された後の extract ジョブは、**未 claim ではなく、observe が claim したまま**
 *    （`claimed_by: "runtime.observe:sync"`・`attempts: 1`）残る（ADR 0407）。`leaseMs` の内側の `tick` は拾わず、
 *    リースが切れた後の `tick` が取り直して処理する。`Runtime.observe` の TSDoc は以前「claim もされていないまま」と書いていた。
 * 2. その間に同じ `externalId` で再送しても抽出はやり直されない（`skipped`・`memoryIds: []`。#897 と同じ分岐）。
 * 3. 冪等な再送の戻り値には、`subjectCandidates`・`claimKey` を渡していても `rejectedSubjectIds`・`claimKeyFailure`・
 *    `contestedDetection` の欄が無い（`ObserveResult` の各欄の doc）。
 *
 * testkit の InMemory と Postgres の両方に同じ入力を当てる。
 */

let contents: string[] = ["X"];
let gate: (() => Promise<void>) | undefined;

const llmProvider: LLMProvider = {
  complete: async () => ({ content: "unused" }),
  completeStructured: async (_ctx, req) => {
    const extracted = req.schema.safeParse({
      memories: contents.map((content) => ({ content, provenanceKind: "stated" })),
    });
    if (extracted.success) {
      if (gate) await gate();
      return extracted.data;
    }
    return req.schema.parse({
      claims: contents.map(() => ({ subject: "user", predicate: "pet" })),
    });
  },
};

const embeddingProvider = {
  space: TEST_EMBEDDING_SPACE,
  embed: async (_ctx: Ctx, texts: string[]) => texts.map(() => [1, 0, 0]),
};
const hashContent = (content: string) => createHash("sha256").update(content).digest("hex");

interface Kit {
  runtime: Runtime;
  memoryStore: MemoryStore;
  /** extract ジョブの `claimed_by:attempts:状態` の並び。 */
  extractJobs: () => Promise<string[]>;
}

const KITS: Array<[string, () => Promise<Kit>]> = [
  [
    "testkit の InMemory",
    async () => {
      const memoryStore = new InMemoryMemoryStore();
      return {
        memoryStore,
        runtime: createRuntime({
          llmProvider,
          embeddingProvider,
          hashContent,
          memoryStore,
          eventStore: new InMemoryEventStore(memoryStore, memoryStore.events),
          vectorStore: new InMemoryVectorStore(memoryStore),
          outboxStore: new InMemoryOutboxStore(memoryStore.outboxJobs),
          tenantSettingsStore: new InMemoryTenantSettingsStore(memoryStore.activitySeq),
        }),
        extractJobs: async () =>
          memoryStore.outboxJobs
            .filter((job) => job.kind === "extract")
            .map(
              (job) =>
                `${job.claimedBy ?? "-"}:${job.attempts}:${job.completedAt ? "done" : job.failedAt ? "failed" : "open"}`,
            ),
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
          llmProvider,
          embeddingProvider,
          hashContent,
          memoryStore,
          eventStore: new PostgresEventStore(db),
          vectorStore: new PostgresVectorStore(db),
          outboxStore: new PostgresOutboxStore(db),
          tenantSettingsStore: new PostgresTenantSettingsStore(db),
        }),
        extractJobs: async () => {
          const result = await db.execute(
            sql`SELECT claimed_by, attempts, completed_at, failed_at FROM outbox WHERE kind = 'extract' AND tenant_id = ${ctx.tenantId}`,
          );
          return (
            result.rows as Array<{
              claimed_by: string | null;
              attempts: number;
              completed_at: unknown;
              failed_at: unknown;
            }>
          ).map(
            (row) =>
              `${row.claimed_by ?? "-"}:${row.attempts}:${row.completed_at ? "done" : row.failed_at ? "failed" : "open"}`,
          );
        },
      };
    },
  ],
];

const ctx: Ctx = { tenantId: "observe-abort-extract-job-and-resend" };
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

afterAll(async () => {
  await closeTestClient();
});

for (const [name, makeKit] of KITS) {
  describe(`${name}: sync の observe が abort された後の extract ジョブと、同じ externalId の再送（ADR 0454）`, () => {
    it("ジョブは observe が claim したまま残り、リースの内側の tick は拾わず、切れた後の tick が取り直す。その間の再送は skipped", async () => {
      contents = ["X"];
      const kit = await makeKit();
      const controller = new AbortController();
      let release: () => void = () => {};
      let reached: () => void = () => {};
      const reachedPromise = new Promise<void>((resolve) => (reached = resolve));
      gate = () =>
        new Promise<void>((resolve) => {
          release = resolve;
          reached();
        });
      const pending = kit.runtime
        .observe(
          ctx,
          { kind: "utterance", text: "u", externalId: "e1" },
          { signal: controller.signal },
        )
        .then(
          () => "resolved",
          () => "rejected",
        );
      await reachedPromise;
      controller.abort();
      expect(await pending).toBe("rejected");
      release();
      gate = undefined;

      // 未 claim ではなく、observe が claim したまま（attempts: 1）。
      expect(await kit.extractJobs()).toEqual(["runtime.observe:sync:1:open"]);

      // リースの内側の tick は拾わない。
      const inside = await kit.runtime.tick(ctx, { leaseMs: 60_000, kinds: ["extract"] });
      expect(inside.processed).toBe(0);

      // 同じ externalId の再送は、抽出をやり直さない。
      const resend = await kit.runtime.observe(ctx, {
        kind: "utterance",
        text: "u",
        externalId: "e1",
      });
      expect(resend).toMatchObject({ memoryIds: [], extraction: "skipped" });
      expect(
        await kit.memoryStore.listBySourceObservationAllVersions(ctx, resend.observationId),
      ).toHaveLength(0);

      // リースが切れた後の tick は取り直し（attempts: 2）、処理する。
      await sleep(30);
      const after = await kit.runtime.tick(ctx, { leaseMs: 5, kinds: ["extract"] });
      expect(after.processed).toBe(1);
      expect(await kit.extractJobs()).toEqual(["runtime.tick:2:done"]);
      expect(
        await kit.memoryStore.listBySourceObservationAllVersions(ctx, resend.observationId),
      ).toHaveLength(1);
    });

    it("冪等な再送の戻り値には、claimKey・subjectCandidates を渡していても claimKeyFailure・contestedDetection・rejectedSubjectIds の欄が無い", async () => {
      contents = ["X"];
      const kit = await makeKit();
      const first = await kit.runtime.observe(ctx, {
        kind: "utterance",
        text: "u",
        externalId: "e2",
        subjectCandidates: ["alice"],
        claimKey: { enabled: true, detectContested: true },
      });
      // 対照: 最初の呼び出しは3つの欄を持つ。
      expect(first).toHaveProperty("claimKeyFailure");
      expect(first).toHaveProperty("contestedDetection");
      expect(first).toHaveProperty("rejectedSubjectIds");

      const resend = await kit.runtime.observe(ctx, {
        kind: "utterance",
        text: "u",
        externalId: "e2",
        subjectCandidates: ["alice"],
        claimKey: { enabled: true, detectContested: true },
      });

      expect(resend).toMatchObject({ memoryIds: [], extraction: "skipped" });
      expect(resend).not.toHaveProperty("claimKeyFailure");
      expect(resend).not.toHaveProperty("contestedDetection");
      expect(resend).not.toHaveProperty("rejectedSubjectIds");
    });
  });
}
