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
 * リースは各ジョブの処理開始からではなくバッチの claim 時点から数えるので、後ろのジョブは自分の番が来る前に（あるいは自分の処理の途中で）リースが切れうる。
 * この歯は「その性質が今こうである」を実測で固定する。1件あたりの処理時間 (600ms) は `leaseMs` (1000ms) より短いが、
 * 2件目は 600ms 待たされた分だけ遅れて始まるので 1200ms 時点で切れ、別の worker（tick B）が再 claim できる。
 * 処理（provider 呼び出しと upsert）は二重に走り、CAS が無害化するのは完了の記録だけである。
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
        nowA = T0 + 600;
      } else if (embedCalls === 2) {
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

    expect(resultB).toEqual({ processed: 1, failed: 0, unsupported: [], leaseConflicts: [] });
    expect(resultA.processed).toBe(1);
    expect(resultA.failed).toBe(0);
    expect(resultA.leaseConflicts).toHaveLength(1);
    expect(resultA.leaseConflicts[0]).toMatchObject({
      kind: "embed",
      attemptedOutcome: "complete",
    });
    expect(embedCalls).toBe(3);
    expect(upserts).toBe(3);
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

  it("見出しの結論は「切れうる」（切れない、とは書いていない）", () => {
    const doc = readTickOptionsDoc();
    // 結論の向き。事実と逆（「前でも切れない」等）に書き換えても、上の語の検査は通ってしまう。
    expect(doc).toContain("切れうる");
  });

  it("TSDoc の「既定 N」は、実装の DEFAULT_TICK_LIMIT と同じ数である", () => {
    const source = readFileSync(fileURLToPath(new URL("../runtime.ts", import.meta.url)), "utf8");
    const constant = /const DEFAULT_TICK_LIMIT = (\d+);/.exec(source);
    expect(constant).not.toBeNull();
    const doc = readTickOptionsDoc();
    expect(doc).toContain(`既定 ${constant?.[1]}`);
  });
});

describe("TickOptions.limit の TSDoc — 既定の数と、リースの注意への参照を書いてある", () => {
  it("TSDoc の「既定 N」は、実装の DEFAULT_TICK_LIMIT と同じ数である", () => {
    const source = readFileSync(fileURLToPath(new URL("../runtime.ts", import.meta.url)), "utf8");
    const constant = /const DEFAULT_TICK_LIMIT = (\d+);/.exec(source);
    expect(constant).not.toBeNull();
    expect(readTickLimitDoc()).toContain(`既定 ${constant?.[1]}`);
  });

  it("後ろのジョブが二重に処理されうることを書き、leaseMs の注意を指している", () => {
    const doc = readTickLimitDoc();
    expect(doc).toContain("二重に処理されうる");
    expect(doc).toContain("{@link TickOptions.leaseMs}");
  });
});

function readTickLimitDoc(): string {
  const source = readFileSync(fileURLToPath(new URL("../runtime.ts", import.meta.url)), "utf8");
  const start = source.indexOf(
    "\n  leaseMs: number;",
    source.indexOf("export interface TickOptions {"),
  );
  const end = source.indexOf("\n  limit?: number | undefined;", start);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
}

function readTickOptionsDoc(): string {
  const source = readFileSync(fileURLToPath(new URL("../runtime.ts", import.meta.url)), "utf8");
  const start = source.indexOf("export interface TickOptions {");
  const end = source.indexOf("\n  leaseMs: number;", start);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
}
