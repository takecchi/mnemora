import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import type { LLMProvider } from "../interfaces/llm-provider.js";
import type { NewMemory } from "../memory.js";
import { createRuntime } from "../runtime.js";
import { defaultDecayStrategy } from "../strategies/decay.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";

/**
 * `tick()` は `claimBatch` で最大 `limit` 件を**一括で** claim し（全件の `claimed_at` は同じ now）、
 * 1件ずつ順に処理する。リースは各ジョブの処理開始からではなく**バッチの claim 時点**から数えるので、
 * 後ろのジョブは自分の番が来る前に（あるいは自分の処理の途中で）リースが切れうる。
 *
 * この歯は「その性質が今こうである」を実測で固定する。1件あたりの処理時間 (600ms) は
 * `leaseMs` (1000ms) より短い——つまり1件だけなら安全な値でも、2件目は 600ms 待たされた分だけ
 * 遅れて始まるので 1200ms 時点で切れる。別の worker（tick B）が2件目を再 claim でき、
 * A が遅れて `complete` すると CAS（ADR 0142）で `leaseConflicts` に積まれる。
 * **処理（provider 呼び出しと upsert）は二重に走る**——CAS が無害化するのは完了の記録だけである。
 * 性質を変える（各ジョブの前にリースを延ばす等）ときは、この歯を意図して書き換えること。
 */

const ctx: Ctx = { tenantId: "tenant-1" };
const T0 = Date.now() + 60_000; // 以前の Fake は outbox 行の `availableAt` を実時刻で付けた名残（今の Fake は `opts.now` に従う。ADR 0555。組み替えは「残り」）
const LEASE_MS = 1000;

const notUsedLlm: LLMProvider = {
  complete: async () => {
    throw new Error("not used");
  },
  completeStructured: async () => {
    throw new Error("not used");
  },
};

function newMemory(n: number): NewMemory {
  const recordedAt = new Date(T0);
  return {
    tenantId: "tenant-1",
    subjectId: null,
    sourceObservationId: null,
    extractorVersion: null,
    content: `本文${n}`,
    contentHash: `hash-${n}`,
    digest: "digest",
    digestSource: "llm",
    provenance: { kind: "imported", batchId: "fixture" },
    tags: [],
    occurredAt: null,
    recordedAt,
    lastReinforcedAt: null,
    strength: 1,
    halfLifeHours: 24,
    decayFloorAt: defaultDecayStrategy.floorAt({
      recordedAt,
      lastReinforcedAt: null,
      strength: 1,
      halfLifeHours: 24,
    }),
    embeddingStatus: "pending",
  };
}

describe("tick — 1バッチ内で後ろのジョブのリースが先に切れる", () => {
  it("2件目の処理中にリースが切れ、別 tick が再 claim する。処理は二重に走り、A の complete は leaseConflicts になる", async () => {
    const stores = createFakeRuntimeStores();
    let nowA = T0;
    let nowB = T0;
    const make = (read: () => number) =>
      createRuntime({
        memoryStore: stores.memoryStore,
        outboxStore: stores.outboxStore,
        vectorStore: stores.vectorStore,
        eventStore: stores.eventStore,
        tenantSettingsStore: stores.tenantSettingsStore,
        llmProvider: notUsedLlm,
        embeddingProvider: stores.embeddingProvider,
        hashContent: (content: string) => `sha256(${content})`,
        clock: { now: () => new Date(read()) },
      });
    const runtimeA = make(() => nowA);
    const runtimeB = make(() => nowB);
    await stores.memoryStore.createMemoryWithOutbox(ctx, newMemory(1), ["embed"]);
    await stores.memoryStore.createMemoryWithOutbox(ctx, newMemory(2), ["embed"]);

    let upserts = 0;
    const originalUpsert = stores.vectorStore.upsert.bind(stores.vectorStore);
    stores.vectorStore.upsert = async (...args) => {
      upserts += 1;
      return originalUpsert(...args);
    };

    let embedCalls = 0;
    let resultB: Awaited<ReturnType<typeof runtimeB.tick>> | undefined;
    stores.embeddingProvider.beforeEmbedReturn = async () => {
      embedCalls += 1;
      if (embedCalls === 1) {
        // A の1件目: 600ms かかった（leaseMs より短い）。
        nowA = T0 + 600;
      } else if (embedCalls === 2) {
        // A の2件目の処理中: バッチの claim (T0) から 1200ms 経った——2件目は 600ms しか
        // 処理していないのに、リースは切れている。ここで別の worker が tick する。
        nowA = T0 + 1200;
        nowB = T0 + 1200;
        resultB = await runtimeB.tick(ctx, { leaseMs: LEASE_MS, claimedBy: "worker-b" });
      }
    };

    const resultA = await runtimeA.tick(ctx, {
      leaseMs: LEASE_MS,
      limit: 2,
      claimedBy: "worker-a",
    });

    // B は A の2件目を再 claim して最後まで処理した。
    expect(resultB).toEqual({ processed: 1, failed: 0, unsupported: [], leaseConflicts: [] });
    // A は2件処理したが、2件目の complete は CAS で弾かれた（processed に数えない）。
    expect(resultA.processed).toBe(1);
    expect(resultA.failed).toBe(0);
    expect(resultA.leaseConflicts).toHaveLength(1);
    expect(resultA.leaseConflicts[0]).toMatchObject({
      kind: "embed",
      attemptedOutcome: "complete",
    });
    // 処理は二重に走った: provider 呼び出し 2件+1件、upsert も 3 回（2件目は2回）。
    expect(embedCalls).toBe(3);
    expect(upserts).toBe(3);
    // 結果は壊れない: 2件とも完了し、2件目は再 claim で attempts が 2。
    const jobs = stores.outboxStore.listJobs(ctx).sort((a, b) => a.attempts - b.attempts);
    expect(jobs.every((j) => j.completedAt !== null && j.failedAt === null)).toBe(true);
    expect(jobs.map((j) => j.attempts)).toEqual([1, 2]);
  });
});

describe("TickOptions.leaseMs の TSDoc — この性質を書いてある", () => {
  it("リースはバッチの claim 時点から数える・後ろのジョブは切れうる・処理は二重に走る、を名指ししている", () => {
    const source = readFileSync(fileURLToPath(new URL("../runtime.ts", import.meta.url)), "utf8");
    const start = source.indexOf("export interface TickOptions {");
    const end = source.indexOf("\n  leaseMs: number;", start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const doc = source.slice(start, end);
    // 1バッチ（`limit` 件）は同じ now で一括 claim され、リースは各ジョブの処理開始からではない。
    expect(doc).toContain("バッチの claim 時点");
    expect(doc).toContain("後ろのジョブ");
    // 処理（provider 呼び出しと upsert）は二重に走り、CAS が無害化するのは完了の記録だけ。
    expect(doc).toContain("二重に走る");
    // 実測した歯への住所。
    expect(doc).toContain("tick-batch-lease-expiry.test.ts");
  });
});
