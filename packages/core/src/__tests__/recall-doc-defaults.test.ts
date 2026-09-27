import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import * as core from "../index.js";
import type { Ctx } from "../ctx.js";
import type { NewMemory } from "../memory.js";
import type { VectorStore } from "../interfaces/vector-store.js";
import { defaultDecayStrategy } from "../strategies/decay.js";
import { createRuntime } from "../runtime.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";

/**
 * `docs/recall.md` に書かれた既定値・上限・式が、`recall()` の実装と一致することを縛る。
 * **doc の値は `docs/recall.md` を実行時に読んで取り**、**実装の値は `recall()` の振る舞いから取る**
 * （公開の定数を参照するだけのテストは、doc が古くなっても緑のままなので突き合わせにならない）。
 * どちらか片方だけを直すと赤くなる。
 *
 * 対象は「これからの実行に当てている記述」だけである。日付つきの実測の記録
 * （「【実測 2026-09-21・合成コーパス】」の飽和件数の表など）は凍結された記録なので読まない——
 * その表の元になった式（帯1件のコスト）のほうを、定数と振る舞いの両方から計算して縛る。
 */

const RECALL_DOC = readFileSync(
  fileURLToPath(new URL("../../../../docs/recall.md", import.meta.url)),
  "utf8",
);

function docMatch(pattern: RegExp): RegExpMatchArray {
  const m = RECALL_DOC.match(pattern);
  if (!m) throw new Error(`docs/recall.md に ${pattern} の記述が見つからない`);
  return m;
}

const NOW = new Date("2026-06-01T00:00:00.000Z");
const ctx: Ctx = { tenantId: "recall-doc-defaults" };

function buildRuntime(wrapVectorStore?: (vs: VectorStore) => VectorStore) {
  const stores = createFakeRuntimeStores();
  const runtime = createRuntime({
    ...stores,
    vectorStore: wrapVectorStore ? wrapVectorStore(stores.vectorStore) : stores.vectorStore,
    llmProvider: {
      complete: async () => {
        throw new Error("not used");
      },
      completeStructured: async () => {
        throw new Error("not used");
      },
    },
    hashContent: (content: string) => `sha256(${content})`,
    clock: { now: () => NOW },
  });
  return { runtime, stores };
}

let seq = 0;
async function addMemory(
  stores: ReturnType<typeof createFakeRuntimeStores>,
  overrides: Partial<NewMemory> = {},
): Promise<string> {
  const recordedAt = overrides.recordedAt ?? NOW;
  const strength = overrides.strength ?? 1;
  const halfLifeHours = overrides.halfLifeHours ?? 24 * 365 * 10;
  seq += 1;
  const memory = await stores.memoryStore.createMemory(ctx, {
    tenantId: ctx.tenantId,
    subjectId: null,
    sourceObservationId: null,
    extractorVersion: null,
    content: `本文${seq}`,
    contentHash: `hash-${seq}`,
    digest: "d",
    digestSource: "llm",
    provenance: { kind: "imported", batchId: "fixture" },
    tags: [],
    occurredAt: null,
    recordedAt,
    lastReinforcedAt: null,
    strength,
    halfLifeHours,
    decayFloorAt: defaultDecayStrategy.floorAt({
      recordedAt,
      lastReinforcedAt: null,
      strength,
      halfLifeHours,
    }),
    embeddingStatus: "ready",
    ...overrides,
  });
  await stores.vectorStore.upsert(ctx, stores.embeddingProvider.space, memory.id, [1, 0]);
  return memory.id;
}

describe("docs/recall.md の既定値・上限・式は recall() の振る舞いと一致する", () => {
  it("§3 の過取得の係数（k' = k × N）", async () => {
    const m = docMatch(/既定案は \*\*k' = k × (\d+)\*\*（k=(\d+) なら k'=(\d+)/);
    const factor = Number(m[1]);
    // 例の数字どうしも式に合っていること（例だけが古くなる腐り方を拾う）
    expect(Number(m[2]) * factor).toBe(Number(m[3]));

    const limits: number[] = [];
    const { runtime, stores } = buildRuntime((vs) => {
      const original = vs.search.bind(vs);
      vs.search = async (c, space, query, opts) => {
        limits.push(opts.limit);
        return original(c, space, query, opts);
      };
      return vs;
    });
    await addMemory(stores);

    const k = 7;
    await runtime.recall(ctx, { vector: [1, 0], limit: k, association: null });
    expect(limits).toEqual([k * factor]);
  });

  it("目次帯の件数上限の既定と下限（`digestBandLimit` の呼び出し例の注記）", async () => {
    const m = docMatch(
      /digestBandLimit: \d+, \/\/ 既定 (\d+) から下げる。(\d+) は渡せない（(\d+) が下限）/,
    );
    const documentedDefault = Number(m[1]);
    const documentedRejected = Number(m[2]);
    const documentedMin = Number(m[3]);

    const { runtime, stores } = buildRuntime();
    // digest が短く、文字数の上限より先に件数の上限に当たる量を置く
    for (let i = 0; i < documentedDefault * 2; i += 1) await addMemory(stores);

    const omitted = await runtime.recall(ctx, { vector: [1, 0], limit: 1, association: null });
    expect(omitted.index.digestBand).toHaveLength(documentedDefault);
    expect(omitted.index.digestBandCoverage?.limitedBy).toBe("entry_limit");

    await expect(
      runtime.recall(ctx, {
        vector: [1, 0],
        limit: 1,
        association: null,
        digestBandLimit: documentedRejected,
      }),
    ).rejects.toThrow();
    const atMin = await runtime.recall(ctx, {
      vector: [1, 0],
      limit: 1,
      association: null,
      digestBandLimit: documentedMin,
    });
    expect(atMin.index.digestBand).toHaveLength(documentedMin);
  });

  it("目次帯の1件のコストの式——doc の式を実装の定数で計算した飽和件数が、recall() の帯の件数と一致する", async () => {
    const block = docMatch(/帯1件の内部コストは\s*```\s*\n([\s\S]*?)```/)[1]!;
    const terms = block.split("+").map((t) => t.replace(/\s+/g, ""));
    const constant = (name: string): number => {
      const value = (core as Record<string, unknown>)[name];
      if (typeof value !== "number") throw new Error(`@mnemora/core に数の定数 ${name} が無い`);
      return value;
    };
    const cost = (digestLength: number): number =>
      terms.reduce((sum, term) => {
        const min = term.match(/^min\((.+),(.+)\)$/);
        const value = (x: string) => (x === "digest長" ? digestLength : constant(x));
        return sum + (min ? Math.min(value(min[1]!), value(min[2]!)) : value(term));
      }, 0);
    const maxChars = constant(docMatch(/帯全体の文字数上限（`([A-Z_]+)`/)[1]!);

    // 件数の上限を外して文字数の上限だけを効かせ、digest の長さを1字刻みで振る。1件のコストが
    // 1字ずれるだけでも、どこかの長さで飽和件数が変わる（1件あたりの上限を超える長さも含める）
    const mismatches: { digestLength: number; predicted: number; actual: number | undefined }[] =
      [];
    for (let digestLength = 1; digestLength <= 150; digestLength += 1) {
      const predicted = Math.floor(maxChars / cost(digestLength));
      const { runtime, stores } = buildRuntime();
      for (let i = 0; i < predicted + 5; i += 1) {
        await addMemory(stores, { digest: "あ".repeat(digestLength) });
      }
      const result = await runtime.recall(ctx, {
        vector: [1, 0],
        limit: 1,
        association: null,
        digestBandLimit: predicted + 5,
      });
      const actual = result.index.digestBand?.length;
      if (actual !== predicted || result.index.digestBandCoverage?.limitedBy !== "char_budget") {
        mismatches.push({ digestLength, predicted, actual });
      }
    }
    expect(mismatches).toEqual([]);
  });

  it("段2の既定 `scoreThreshold` と、`nearMisses` の件数", async () => {
    const threshold = Number(docMatch(/`DEFAULT_SCORE_THRESHOLD` = `([0-9.]+)`/)[1]);
    const nearMissCount = Number(
      docMatch(/\.nearMisses`\*\* は `belowThreshold`（`total` 降順）の先頭(\d+)件/)[1],
    );

    const { runtime, stores } = buildRuntime();
    // strength で total を閾値の上下に散らす（下側は nearMisses の件数より多く置く）。
    // 忘却ゲートで先に落ちないよう、decayFloorAt は先に置く
    const strengths = [0.02, 0.03, 0.04, 0.05, 0.06, 0.07, 0.08, 0.09, 0.2, 0.3, 0.5];
    const decayFloorAt = new Date(NOW.getTime() + 365 * 24 * 3_600_000);
    for (const strength of strengths) await addMemory(stores, { strength, decayFloorAt });

    const all = await runtime.recall(ctx, {
      vector: [1, 0],
      limit: 50,
      association: null,
      scoreThreshold: 0,
    });
    const totals = new Map(all.memories.map((r) => [r.memoryId, r.score.total]));
    expect(totals.size).toBe(strengths.length);
    const expectedPassed = [...totals].filter(([, t]) => t >= threshold).map(([id]) => id);
    const expectedBelow = [...totals].filter(([, t]) => t < threshold);
    // 境目の両側に候補があること（無ければこの歯は何も見ていない）
    expect(expectedPassed.length).toBeGreaterThan(0);
    expect(expectedBelow.length).toBeGreaterThan(nearMissCount);

    const byDefault = await runtime.recall(ctx, { vector: [1, 0], limit: 50, association: null });
    expect(byDefault.memories.map((r) => r.memoryId).sort()).toEqual(expectedPassed.sort());

    const below = byDefault.omitted.find((o) => o.kind === "below_threshold");
    const nearMisses = below?.kind === "below_threshold" ? below.nearMisses : undefined;
    const topBelow = expectedBelow
      .sort((a, b) => b[1] - a[1])
      .slice(0, nearMissCount)
      .map(([id]) => id);
    expect(nearMisses?.map((n) => n.memoryId)).toEqual(topBelow);
  });

  it("§7.1 `timeWeighting` の省略時の値と、`eventAwareFreshness` で固定される `freshness`", async () => {
    const documentedDefault = docMatch(/\*\*省略時は `"([a-zA-Z]+)"`。\*\*/)[1]!;
    const fixedFreshness = Number(
      docMatch(/`freshness` を (\d+)（`MAX_FRESHNESS`、ADR 0036 の上限そのもの）に固定できる/)[1],
    );
    const other = documentedDefault === "legacy" ? "eventAwareFreshness" : "legacy";

    const { runtime, stores } = buildRuntime();
    // occurredAt が無く、recordedAt が半減期より古い記憶（2つの方針で freshness が分かれる）
    await addMemory(stores, {
      recordedAt: new Date(NOW.getTime() - 3 * 24 * 3_600_000),
      halfLifeHours: 24,
      decayFloorAt: new Date(NOW.getTime() + 365 * 24 * 3_600_000),
    });
    const freshness = async (timeWeighting?: "legacy" | "eventAwareFreshness") => {
      const r = await runtime.recall(ctx, {
        vector: [1, 0],
        limit: 5,
        association: null,
        scoreThreshold: 0,
        ...(timeWeighting !== undefined ? { timeWeighting } : {}),
      });
      return r.memories[0]!.score.freshness;
    };

    const omitted = await freshness();
    expect(omitted).toBe(await freshness(documentedDefault as "legacy" | "eventAwareFreshness"));
    expect(omitted).not.toBe(await freshness(other));
    expect(await freshness("eventAwareFreshness")).toBe(fixedFreshness);
  });
});
