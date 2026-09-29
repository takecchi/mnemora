import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import type { MemoryId } from "../ids.js";
import type { VectorStore } from "../interfaces/vector-store.js";
import type { NewMemory } from "../memory.js";
import { createRuntime } from "../runtime.js";
import { defaultDecayStrategy } from "../strategies/decay.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";

/**
 * `packages/core/README.md` が約束していて、どのテストも縛っていなかった振る舞いを縛る。
 * 今の振る舞いの固定であり、望ましい姿の主張ではない。
 *
 * - 「単体で呼べる純関数（動く最小の例）」の片は「そのまま実行できる」。`check:doc-snippets` は型しか
 *   見ないので、ここで片そのものを README から取り出して実行する。
 * - 連想枠の `anchorCount` は `limit` が天井になる（アンカーは段2で `limit` の内側に入った候補から取る）。
 * - 連想枠の既定値（`anchorCount` = `DEFAULT_ASSOCIATION_ANCHOR_COUNT`、
 *   `minSimilarity` = `DEFAULT_ASSOCIATION_MIN_SIMILARITY`、どちらも `recall.ts`）は、
 *   省略したときに実際に使われる（README.md の「連想枠」節）。
 */

const README = readFileSync(fileURLToPath(new URL("../../README.md", import.meta.url)), "utf8");

describe("README「単体で呼べる純関数（動く最小の例）」: 片はそのまま実行できる", () => {
  it('片を取り出して実行すると、counter: "heuristic" を含む説明どおりの値が返る', async () => {
    const start = README.indexOf("## 単体で呼べる純関数");
    expect(start, "README に節が在る").toBeGreaterThan(-1);
    const open = README.indexOf("```ts check\n", start);
    const code = README.slice(open + "```ts check\n".length, README.indexOf("\n```", open + 1));
    const LOG = "console.log({ decayed, total: score.total, tokens, counter });";
    expect(code).toContain('from "@mnemora/core";');
    expect(code).toContain(LOG);

    // 片の import を core の入口に向け、最後の console.log を export に置き換えるだけで、ほかは触らない。
    const index = fileURLToPath(new URL("../index.ts", import.meta.url));
    const runnable = code
      .replace('from "@mnemora/core";', `from ${JSON.stringify(index)};`)
      .replace(LOG, "export const result = { decayed, total: score.total, tokens, counter };");
    const dir = mkdtempSync(path.join(tmpdir(), "mnemora-core-readme-"));
    try {
      const file = path.join(dir, "snippet.ts");
      writeFileSync(file, runnable);
      const { result } = (await import(file)) as {
        result: { decayed: number; total: number; tokens: number; counter: string };
      };
      // 記録から時間が経っているので、強度は 1 より下がっている（0 までは落ちていない）。
      expect(result.decayed).toBeGreaterThan(0);
      expect(result.decayed).toBeLessThan(1);
      expect(Number.isFinite(result.total)).toBe(true);
      expect(result.total).toBeGreaterThanOrEqual(0);
      // "hello world"（非CJK 11字 × 0.25 の切り上げ）
      expect(result.tokens).toBe(3);
      expect(result.counter).toBe("heuristic");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("README「連想枠」: anchorCount は limit が天井になる", () => {
  const ctx: Ctx = { tenantId: "tenant-1" };
  const NOW = new Date("2026-06-01T00:00:00.000Z");

  function newMemory(i: number): NewMemory {
    const halfLifeHours = 24 * 365 * 10;
    return {
      tenantId: "tenant-1",
      subjectId: null,
      sourceObservationId: null,
      extractorVersion: null,
      content: `本文${i}`,
      contentHash: `hash-${i}`,
      digest: `digest${i}`,
      digestSource: "llm",
      provenance: { kind: "imported", batchId: "fixture" },
      tags: [],
      occurredAt: null,
      recordedAt: NOW,
      lastReinforcedAt: null,
      strength: 1,
      halfLifeHours,
      decayFloorAt: defaultDecayStrategy.floorAt({
        recordedAt: NOW,
        lastReinforcedAt: null,
        strength: 1,
        halfLifeHours,
      }),
      embeddingStatus: "ready",
    };
  }

  /** クエリ [1,0] に全部が強く当たる記憶を n 件入れ、getVectors に渡ったアンカーの数を返す。 */
  async function anchorsUsed(n: number, limit: number, anchorCount: number): Promise<number> {
    const stores = createFakeRuntimeStores();
    const calls: MemoryId[][] = [];
    const vectorStore: VectorStore = Object.assign(Object.create(stores.vectorStore), {
      getVectors: async (
        c: Ctx,
        space: Parameters<NonNullable<VectorStore["getVectors"]>>[1],
        ids: MemoryId[],
      ) => {
        calls.push(ids);
        return stores.vectorStore.getVectors(c, space, ids);
      },
    });
    for (let i = 0; i < n; i++) {
      const memory = await stores.memoryStore.createMemory(ctx, newMemory(i));
      await stores.vectorStore.upsert(ctx, stores.embeddingProvider.space, memory.id, [
        1,
        0.001 * (i + 1),
      ]);
    }
    const runtime = createRuntime({
      memoryStore: stores.memoryStore,
      outboxStore: stores.outboxStore,
      vectorStore,
      eventStore: stores.eventStore,
      tenantSettingsStore: stores.tenantSettingsStore,
      llmProvider: {
        complete: async () => {
          throw new Error("not used");
        },
        completeStructured: async () => {
          throw new Error("not used");
        },
      },
      embeddingProvider: stores.embeddingProvider,
      hashContent: (content: string) => `sha256(${content})`,
      clock: { now: () => NOW },
    });
    await runtime.recall(ctx, {
      vector: [1, 0],
      limit,
      association: { maxCount: 10, anchorCount },
    });
    expect(calls, "連想枠は getVectors を1回だけ呼ぶ").toHaveLength(1);
    return calls[0]!.length;
  }

  it("limit: 10 / anchorCount: 40 では、起点になるアンカーは10件（anchorCount だけを上げても効かない）", async () => {
    expect(await anchorsUsed(60, 10, 40)).toBe(10);
  });

  it("陽性対照: limit: 40 / anchorCount: 40 なら40件", async () => {
    expect(await anchorsUsed(60, 40, 40)).toBe(40);
  });
});

describe("README「連想枠」: 既定値（anchorCount=3 / minSimilarity=0.5）は省略時に実際に使われる", () => {
  const ctx: Ctx = { tenantId: "tenant-1" };
  const NOW = new Date("2026-06-01T00:00:00.000Z");

  function newMemory(i: number): NewMemory {
    const halfLifeHours = 24 * 365 * 10;
    return {
      tenantId: "tenant-1",
      subjectId: null,
      sourceObservationId: null,
      extractorVersion: null,
      content: `本文${i}`,
      contentHash: `hash-default-${i}`,
      digest: `digest${i}`,
      digestSource: "llm",
      provenance: { kind: "imported", batchId: "fixture" },
      tags: [],
      occurredAt: null,
      recordedAt: NOW,
      lastReinforcedAt: null,
      strength: 1,
      halfLifeHours,
      decayFloorAt: defaultDecayStrategy.floorAt({
        recordedAt: NOW,
        lastReinforcedAt: null,
        strength: 1,
        halfLifeHours,
      }),
      embeddingStatus: "ready",
    };
  }

  function buildRuntime(
    vectorStore: VectorStore,
    stores: ReturnType<typeof createFakeRuntimeStores>,
  ) {
    return createRuntime({
      memoryStore: stores.memoryStore,
      outboxStore: stores.outboxStore,
      vectorStore,
      eventStore: stores.eventStore,
      tenantSettingsStore: stores.tenantSettingsStore,
      llmProvider: {
        complete: async () => {
          throw new Error("not used");
        },
        completeStructured: async () => {
          throw new Error("not used");
        },
      },
      embeddingProvider: stores.embeddingProvider,
      hashContent: (content: string) => `sha256(${content})`,
      clock: { now: () => NOW },
    });
  }

  it("anchorCount 省略時は既定の3件をアンカーに使う——3件目までは使い、4件目は使わない（境界）", async () => {
    const stores = createFakeRuntimeStores();
    const calls: MemoryId[][] = [];
    const vectorStore: VectorStore = Object.assign(Object.create(stores.vectorStore), {
      getVectors: async (
        c: Ctx,
        space: Parameters<NonNullable<VectorStore["getVectors"]>>[1],
        ids: MemoryId[],
      ) => {
        calls.push(ids);
        return stores.vectorStore.getVectors(c, space, ids);
      },
    });
    const ids: MemoryId[] = [];
    for (let i = 0; i < 10; i++) {
      const memory = await stores.memoryStore.createMemory(ctx, newMemory(i));
      ids.push(memory.id);
      // クエリ [1,0] との類似度が i の昇順で下がるように置く（既存の「連想枠」describe と同じ配置）。
      await stores.vectorStore.upsert(ctx, stores.embeddingProvider.space, memory.id, [
        1,
        0.001 * (i + 1),
      ]);
    }
    const runtime = buildRuntime(vectorStore, stores);
    await runtime.recall(ctx, {
      vector: [1, 0],
      limit: 10,
      association: { maxCount: 10 }, // anchorCount を省略 → 既定の3が使われるはず
    });

    expect(calls, "連想枠は getVectors を1回だけ呼ぶ").toHaveLength(1);
    // 既定の anchorCount=3: 上位3件（i=0,1,2）はアンカーに使い、4件目（i=3）は使わない。
    expect(calls[0]).toEqual([ids[0], ids[1], ids[2]]);
    expect(calls[0]).not.toContain(ids[3]);
  });

  it("minSimilarity 省略時は既定の0.5——類似度ちょうど0.5の候補は連想枠に入り、直下（0.499）は入らない（境界）", async () => {
    const stores = createFakeRuntimeStores();

    const anchor = await stores.memoryStore.createMemory(ctx, newMemory(0));
    await stores.vectorStore.upsert(ctx, stores.embeddingProvider.space, anchor.id, [1, 0]);

    // クエリ [1,0] とのコサイン類似度がちょうど 0.5（丸め誤差で 0.5000000000000001 になるが、
    // >= 0.5 は確実に真になる。単位ベクトル [bx, sqrt(1-bx^2)] と [1,0] の内積は bx そのもの
    // になるため、ノルムの丸めに左右されにくい構成——このファイル追加時に実測して確認した）。
    const atBoundary = await stores.memoryStore.createMemory(ctx, newMemory(1));
    await stores.vectorStore.upsert(ctx, stores.embeddingProvider.space, atBoundary.id, [
      0.5,
      Math.sqrt(1 - 0.5 ** 2),
    ]);

    // 類似度がちょうど 0.499（既定の下限を直下で割る）。
    const belowBoundary = await stores.memoryStore.createMemory(ctx, newMemory(2));
    await stores.vectorStore.upsert(ctx, stores.embeddingProvider.space, belowBoundary.id, [
      0.499,
      Math.sqrt(1 - 0.499 ** 2),
    ]);

    const runtime = buildRuntime(stores.vectorStore, stores);
    const result = await runtime.recall(ctx, {
      vector: [1, 0],
      limit: 1, // アンカー自身だけが段1の withinLimit に入るようにする
      association: { maxCount: 10, anchorCount: 1 }, // minSimilarity を省略 → 既定の0.5が使われるはず
    });

    const atBoundaryEntry = result.memories.find((m) => m.memoryId === atBoundary.id);
    expect(atBoundaryEntry?.retrievedVia, "類似度ちょうど0.5は既定の下限以上として入る").toBe(
      "association",
    );
    expect(
      result.memories.some((m) => m.memoryId === belowBoundary.id),
      "類似度0.499（直下）は既定の下限を割り、連想枠に入らない",
    ).toBe(false);
  });
});
