import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import type { LLMProvider, StructuredRequest } from "../interfaces/llm-provider.js";
import { defaultDecayStrategy } from "../strategies/decay.js";
import type { NewMemory } from "../memory.js";
import { createRuntime, groupSupersededCandidatesByOperation } from "../runtime.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";

/**
 * Issue #765 項目3（ADR 0089「引き受けた負債」3、ADR 0074 の予言）の歯。
 *
 * `groupSupersededCandidatesByOperation`（`superseded-operation-grouping.test.ts`）は
 * `"consolidated"` / `"contested_resolved"` / それ以外（`"reextract_superseded"` を含む）
 * という**文字列リテラルを手で打った入力**で分岐を固定している。`memory_events.meta` は
 * `Record<string, unknown>` であり型で守られていないため（Issue #765 項目3）、この一致は
 * 実行時の規約でしかない——3つの書き手のどれかが将来リテラルを変えても、TypeScript は
 * 検出できない。
 *
 * 既存の歯を数え直すと:
 * - `consolidate.test.ts`（`superseded イベントの meta.reason === 'consolidated'`）と
 *   `resolve-contested.test.ts`（`meta.reason='contested_resolved'`）は、**それぞれ自分の
 *   書き手が積むリテラルだけ**を個別に固定している。`reextract` は実際の呼び出しで
 *   `meta.reason` を検査する歯が無い（`restore-superseded.test.ts` にある
 *   `"reextract_superseded"` は `eventStore.append` へ手で積んだ値であり、`reextract()` を
 *   呼んで確認したものではない）。
 * - どの歯も、実際の書き手が積んだ値を `groupSupersededCandidatesByOperation` へ
 *   流していない——「書き手のリテラル」と「grouping の分岐リテラル」を**1つの歯の中で**
 *   結びつけたものが無かった。
 *
 * この歯は3つの書き手を実際に呼び、書き込まれた `meta.reason` を
 * `groupSupersededCandidatesByOperation` へそのまま渡し、`boundaryConfidence` が
 * `runtime.ts` の doc コメントどおり（`"consolidated"` → `"structural"`、
 * `"contested_resolved"` → `"per_item"`、`"reextract_superseded"` → `"unknown"`）に
 * なることを確認する。**挙動は変えていない**——`runtime.ts` を1バイトも触っていない。
 */

const ctx: Ctx = { tenantId: "tenant-1" };
const NOW = new Date("2026-06-01T00:00:00.000Z");

function newMemory(overrides: Partial<NewMemory> = {}): NewMemory {
  const recordedAt = overrides.recordedAt ?? NOW;
  const strength = overrides.strength ?? 1;
  const halfLifeHours = overrides.halfLifeHours ?? 24 * 365 * 10;
  return {
    tenantId: "tenant-1",
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

function buildRuntime(llmProvider: LLMProvider = notUsedLlm) {
  const stores = createFakeRuntimeStores();
  const runtime = createRuntime({
    memoryStore: stores.memoryStore,
    outboxStore: stores.outboxStore,
    vectorStore: stores.vectorStore,
    eventStore: stores.eventStore,
    tenantSettingsStore: stores.tenantSettingsStore,
    llmProvider,
    embeddingProvider: stores.embeddingProvider,
    hashContent: (content: string) => `sha256(${content})`,
    clock: { now: () => NOW },
  });
  return { runtime, stores };
}

function supersededReasonFor(
  stores: ReturnType<typeof createFakeRuntimeStores>,
  memoryId: string,
): string | null {
  const event = stores.eventStore.events.find(
    (e) => e.memoryId === memoryId && e.kind === "superseded",
  );
  const reason = event?.meta?.["reason"];
  return typeof reason === "string" ? reason : null;
}

describe("書き手が積む meta.reason と groupSupersededCandidatesByOperation の分岐は一致する（Issue #765 項目3）", () => {
  it("consolidate: 実際に積む reason は 'consolidated'、group は boundaryConfidence: 'structural' になる", async () => {
    const { runtime, stores } = buildRuntime({
      complete: async () => {
        throw new Error("not used");
      },
      completeStructured: async <T>(_ctx: Ctx, req: StructuredRequest<T>): Promise<T> =>
        req.schema.parse({ content: "統合後" }) as T,
    });
    const a = await stores.memoryStore.createMemory(ctx, newMemory({ content: "A" }));
    const b = await stores.memoryStore.createMemory(ctx, newMemory({ content: "B" }));

    const result = await runtime.consolidate(ctx, { target: { memoryIds: [a.id, b.id] } });
    expect(result.outcome).toBe("consolidated");

    const reasonA = supersededReasonFor(stores, a.id);
    const reasonB = supersededReasonFor(stores, b.id);
    expect(reasonA).toBe("consolidated");
    expect(reasonB).toBe("consolidated");

    const groups = groupSupersededCandidatesByOperation([
      { memoryId: a.id, supersededReason: reasonA },
      { memoryId: b.id, supersededReason: reasonB },
    ]);
    expect(groups).toEqual([
      { supersededReason: "consolidated", memoryIds: [a.id, b.id], boundaryConfidence: "structural" },
    ]);
  });

  it("resolveContested: 実際に積む reason は 'contested_resolved'、group は1件ずつ boundaryConfidence: 'per_item' になる", async () => {
    const { runtime, stores } = buildRuntime();
    const a = await stores.memoryStore.createMemory(ctx, newMemory({ content: "A" }));
    const b = await stores.memoryStore.createMemory(ctx, newMemory({ content: "B" }));
    const marked = await runtime.markContested(ctx, a.id, b.id);
    expect(marked.outcome.kind).toBe("contested");

    const result = await runtime.resolveContested(ctx, a.id, b.id, {
      kind: "supersede",
      winnerId: a.id,
    });
    expect(result.outcome.kind).toBe("resolved");

    // 敗者（b）だけが kind: 'superseded' イベントを積む——勝者（a）は kind: 'updated'
    // （`resolve-contested.test.ts` 参照）。`groupSupersededCandidatesByOperation` は
    // `previewRestoreSupersededBy?` が返す「superseded になった候補」を受け取る関数なので、
    // ここで結びつけるのも敗者側の reason だけでよい。
    const reasonB = supersededReasonFor(stores, b.id);
    expect(reasonB).toBe("contested_resolved");

    const groups = groupSupersededCandidatesByOperation([
      { memoryId: b.id, supersededReason: reasonB },
    ]);
    expect(groups).toEqual([
      { supersededReason: "contested_resolved", memoryIds: [b.id], boundaryConfidence: "per_item" },
    ]);
  });

  it("reextract: 実際に積む reason は 'reextract_superseded'、group は同じ reason ならまとめて boundaryConfidence: 'unknown' になる", async () => {
    const { runtime: runtime1, stores } = buildRuntime({
      complete: async () => {
        throw new Error("not used");
      },
      completeStructured: async () => {
        throw new Error("simulated LLM outage");
      },
    });
    // runtime2 は runtime1 と同じ stores を共有し、成功する LLM を持つ
    // （`runtime.test.ts` の `buildReextractScenario` と同じ形——provider が復旧した後を模す）。
    const runtime2 = createRuntime({
      memoryStore: stores.memoryStore,
      outboxStore: stores.outboxStore,
      vectorStore: stores.vectorStore,
      eventStore: stores.eventStore,
      tenantSettingsStore: stores.tenantSettingsStore,
      llmProvider: {
        complete: async () => {
          throw new Error("not used");
        },
        completeStructured: async <T>(_ctx: Ctx, req: StructuredRequest<T>): Promise<T> =>
          req.schema.parse({
            memories: [{ content: "新しい抽出結果", digest: "要旨", provenanceKind: "stated" }],
          }) as T,
      },
      embeddingProvider: stores.embeddingProvider,
      hashContent: (content: string) => `sha256(${content})`,
      clock: { now: () => NOW },
    });

    // LLM 障害時は全文フォールバックの Memory が1件残る（`runtime.observe` の既定挙動）。
    const observeResult = await runtime1.observe(ctx, {
      kind: "utterance",
      text: "障害時に取り込まれた発話",
    });
    expect(observeResult.extraction).toBe("llm_failed_whole_observation");
    const fallbackId = observeResult.memoryIds[0]!;

    const reextractResult = await runtime2.reextract(ctx, observeResult.observationId);
    expect(reextractResult.supersededMemoryIds).toEqual([fallbackId]);

    const reason = supersededReasonFor(stores, fallbackId);
    expect(reason).toBe("reextract_superseded");

    // ⛔ 1件ずつには分割しない（`reextract` のアンカーは複数呼び出しで同じ候補を
    // 共有しうるため、既存の情報だけでは操作単位に分割できない——`runtime.ts` の
    // `onlyMemoryIds` doc コメント、ADR 0230 訂正4、ADR 0258）。
    const groups = groupSupersededCandidatesByOperation([
      { memoryId: fallbackId, supersededReason: reason },
    ]);
    expect(groups).toEqual([
      {
        supersededReason: "reextract_superseded",
        memoryIds: [fallbackId],
        boundaryConfidence: "unknown",
      },
    ]);
  });
});
