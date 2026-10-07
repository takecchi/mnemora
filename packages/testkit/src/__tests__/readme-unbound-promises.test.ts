import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createRuntime, type Ctx } from "@mnemora/core";
import * as fixtures from "../fixtures.js";
import * as testkit from "../index.js";
import { DeterministicEmbeddingProvider } from "../__fixtures__/deterministic-embedding-provider.js";
import { DeterministicLLMProvider } from "../__fixtures__/deterministic-llm-provider.js";
import { buildNewMemoryFixture } from "../test-data.js";

/** 今の振る舞いの固定であり、望ましい姿の主張ではない。 */

const README = readFileSync(fileURLToPath(new URL("../../README.md", import.meta.url)), "utf8");
const PACKAGE = JSON.parse(
  readFileSync(fileURLToPath(new URL("../../package.json", import.meta.url)), "utf8"),
) as {
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
};

describe("README「インストール」: vitest は peerDependencies である", () => {
  it("vitest は peerDependencies に在り、dependencies には無い（同梱しない）", () => {
    expect(README).toContain("**`vitest` は `peerDependencies` である**");
    expect(PACKAGE.peerDependencies?.vitest).toBeDefined();
    expect(PACKAGE.dependencies?.vitest).toBeUndefined();
  });
});

describe("README「決定的な擬似 provider」: DeterministicEmbeddingProvider は既定で8次元", () => {
  it("引数を省くと space.dimensions は 8 で、embed はその次元のベクトルを返す", async () => {
    expect(README).toContain("new DeterministicEmbeddingProvider(); // 既定で 8次元");
    const provider = new DeterministicEmbeddingProvider();
    expect(provider.space.dimensions).toBe(8);
    const [vector] = await provider.embed({ tenantId: "t" }, ["abc"]);
    expect(vector).toHaveLength(8);
  });
});

describe("README「@mnemora/testkit/fixtures」: インメモリの store は別の入口からだけ出す", () => {
  const NAMES = [
    "InMemoryMemoryStore",
    "InMemoryVectorStore",
    "InMemoryLexicalStore",
    "InMemoryEventStore",
    "InMemoryOutboxStore",
    "InMemoryTenantSettingsStore",
  ];

  it("README が挙げる6つは /fixtures の入口から export されている", () => {
    for (const name of NAMES) {
      expect(README, name).toContain(`\`${name}\``);
      expect(typeof (fixtures as Record<string, unknown>)[name], name).toBe("function");
    }
  });

  it("入口 `.` からは InMemory* を1つも export していない（describe*Conformance に渡せないようにするため）", () => {
    expect(Object.keys(testkit).filter((name) => name.startsWith("InMemory"))).toEqual([]);
  });
});

describe("README「テストデータのひな型」: buildNewMemoryFixture の既定値のまま実時計で recall すると0件になる", () => {
  const ctx: Ctx = { tenantId: "tenant-1" };
  // 実時計の代わりに、既定の減衰の床より後の固定の日付を使う。
  const NOW = new Date("2026-09-28T00:00:00.000Z");

  async function recallCount(
    overrides: Parameters<typeof buildNewMemoryFixture>[0],
  ): Promise<number> {
    const memoryStore = new fixtures.InMemoryMemoryStore();
    const vectorStore = new fixtures.InMemoryVectorStore(memoryStore);
    const embeddingProvider = new DeterministicEmbeddingProvider();
    const runtime = createRuntime({
      memoryStore,
      vectorStore,
      eventStore: new fixtures.InMemoryEventStore(memoryStore),
      outboxStore: new fixtures.InMemoryOutboxStore(memoryStore.outboxJobs),
      tenantSettingsStore: new fixtures.InMemoryTenantSettingsStore(),
      llmProvider: new DeterministicLLMProvider(),
      embeddingProvider,
      hashContent: (content) => `hash(${content})`,
      clock: { now: () => NOW },
    });
    const memory = await memoryStore.createMemory(
      ctx,
      buildNewMemoryFixture({ embeddingStatus: "ready", ...overrides }),
    );
    const [vector] = await embeddingProvider.embed(ctx, [memory.content]);
    await vectorStore.upsert(ctx, embeddingProvider.space, memory.id, vector!);
    const result = await runtime.recall(ctx, { vector: vector!, association: null });
    return result.memories.length;
  }

  it("既定の減衰の床は 2026-05-10T15:47Z（TSDoc の値）", () => {
    const floor = buildNewMemoryFixture().decayFloorAt;
    expect(floor?.toISOString().slice(0, 16)).toBe("2026-05-10T15:47");
  });

  it("既定値のままでは0件、recordedAt を明示すれば1件（陽性対照）", async () => {
    expect(await recallCount({})).toBe(0);
    expect(await recallCount({ recordedAt: NOW })).toBe(1);
  });
});
