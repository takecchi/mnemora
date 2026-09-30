import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import type { LLMProvider } from "../interfaces/llm-provider.js";
import { defaultDecayStrategy } from "../strategies/decay.js";
import type { NewMemory } from "../memory.js";
import type { MemoryId } from "../ids.js";
import { createRuntime } from "../runtime.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";

/**
 * ADR 0396 の測定道具（**門ではない**）。群の大きさ × `RecallQuery.relationMaxCount` で、
 * `usage.chars` と `over_limit(relation)` の件数を決定的に数える。鍵も DB も要らない
 * （core の Fake ストアと決定的な埋め込み）。
 *
 * - 環境変数 `MNEMORA_MEASURE_RELATION_MAX_COUNT=1` のときだけ表を標準出力に出す。
 *   付けなければ何も出さず、下の式の検査だけが走る。
 * - 検査するのは**式**（同伴の数 = min(上限, 群-1)、切った数 = 群-1-同伴の数、exact/lower_bound の別）
 *   であって、`usage.chars` の値ではない——値は digest の長さで動くので、ここに焼き込まない。
 * - 質（想起が良くなるか）は測れない（鍵が無い）。これは量だけである。
 *
 * 走らせ方: `MNEMORA_MEASURE_RELATION_MAX_COUNT=1 pnpm --filter @mnemora/core exec vitest run src/__tests__/recall-relation-max-count-measure.test.ts`
 */

const ctx: Ctx = { tenantId: "tenant-relation-measure" };
const NOW = new Date("2026-06-01T00:00:00.000Z");
const SIZES = [3, 5, 10, 20, 50, 150];
const CAPS: (number | undefined)[] = [undefined, 3, 20, 50];
/** 実運用の要約に近い長さ（日本語20字）の固定 digest。番号だけが変わる。 */
const digestOf = (i: number) => `顧客の連絡先の記録その${String(i).padStart(3, "0")}です`;

function newMemory(overrides: Partial<NewMemory>): NewMemory {
  const strength = 1;
  const halfLifeHours = 24 * 365 * 10;
  return {
    tenantId: ctx.tenantId,
    subjectId: null,
    sourceObservationId: null,
    extractorVersion: null,
    content: "本文",
    contentHash: `hash-${Math.random()}`,
    digest: "digest",
    digestSource: "llm",
    provenance: { kind: "imported", batchId: "fixture" },
    tags: [],
    occurredAt: null,
    recordedAt: NOW,
    lastReinforcedAt: null,
    strength,
    halfLifeHours,
    decayFloorAt: defaultDecayStrategy.floorAt({
      recordedAt: NOW,
      lastReinforcedAt: null,
      strength,
      halfLifeHours,
    }),
    embeddingStatus: "pending",
    ...overrides,
  };
}

const notUsedLlm: LLMProvider = {
  complete: async () => {
    throw new Error("not used");
  },
  completeStructured: async () => {
    throw new Error("not used");
  },
};

describe("段3 relationMaxCount の量の測定（門ではない）", () => {
  it("群の大きさ × 上限の表", async () => {
    const rows: string[] = [
      "| 群の大きさ | relationMaxCount | 同伴 | over_limit(relation) | countKind | usage.chars | estimatedTokens |",
      "|---:|---|---:|---:|---|---:|---:|",
    ];
    for (const size of SIZES) {
      const stores = createFakeRuntimeStores();
      const runtime = createRuntime({
        memoryStore: stores.memoryStore,
        outboxStore: stores.outboxStore,
        vectorStore: stores.vectorStore,
        eventStore: stores.eventStore,
        tenantSettingsStore: stores.tenantSettingsStore,
        llmProvider: notUsedLlm,
        embeddingProvider: stores.embeddingProvider,
        hashContent: (c: string) => `sha256(${c})`,
        clock: { now: () => NOW },
        relationStore: stores.relationStore,
      });
      const ids: MemoryId[] = [];
      for (let i = 0; i < size; i++) {
        const m = await stores.memoryStore.createMemory(
          ctx,
          newMemory({ digest: digestOf(i), validFrom: new Date(Date.UTC(2020, 0, 1 + i)) }),
        );
        ids.push(m.id);
      }
      await runtime.markContestedGroup!(ctx, ids);
      await stores.vectorStore.upsert(ctx, stores.embeddingProvider.space, ids[0]!, [1, 0]);

      for (const cap of CAPS) {
        const result = await runtime.recall(ctx, {
          vector: [1, 0],
          ...(cap === undefined ? {} : { relationMaxCount: cap }),
        });
        const companions = result.memories.filter(
          (m) => m.retrievedVia === "mandatory_companion",
        ).length;
        const over = result.omitted.filter(
          (o) => o.kind === "over_limit" && o.stage === "relation",
        );
        const effective = cap ?? 10;
        // 式の検査（値ではなく式）。
        expect(companions).toBe(Math.min(effective, size - 1));
        const visited = Math.min(size, effective * 10);
        const cut = Math.max(0, visited - 1 - effective);
        if (cut === 0) {
          expect(over).toEqual([]);
        } else {
          expect(over).toEqual([
            {
              kind: "over_limit",
              stage: "relation",
              count: cut,
              countKind: size > effective * 10 ? "lower_bound" : "exact",
            },
          ]);
        }
        const o = over[0];
        rows.push(
          `| ${size} | ${cap === undefined ? "省略(=10)" : cap} | ${companions} | ${
            o && o.kind === "over_limit" ? o.count : 0
          } | ${o && o.kind === "over_limit" ? o.countKind : "-"} | ${result.usage.chars} | ${
            result.usage.estimatedTokens
          } |`,
        );
      }
    }
    if (process.env["MNEMORA_MEASURE_RELATION_MAX_COUNT"] === "1") {
      process.stdout.write("\n" + rows.join("\n") + "\n");
    }
  }, 120_000);
});
