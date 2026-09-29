import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import type { LLMProvider, StructuredRequest } from "../interfaces/llm-provider.js";
import { ExtractionResultSchema } from "../extraction.js";
import { createRuntime } from "../runtime.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";

/**
 * Issue #933 PR1、2026-09-30 の穴埋め（ADR 0378 追記）: 一致がちょうど1件で、その1件が
 * 既に `contested` だった場合の歯。
 *
 * `findContestedByClaimKey?`（Issue #933 案2）が既に `contested` な相手も一致に数える
 * ようになった結果、「一致がちょうど1件」の分岐に、`active` な相手だけでなく
 * `contested` な相手が唯一の一致として入ってくることがある——**この直しの前は**、
 * その1件を無条件に `markContested(ctx, memory.id, other.id, ...)` へ渡していたため、
 * 相手が既に `contested`（＝`active` でない）なので CAS が `ineligible` を返し、
 * 検出中の Memory は `active` のまま・`memory_events` にも痕跡が残らなかった。
 *
 * 再現の形（この歯が使うシナリオ）: 1件目・2件目が対になって `contested` になった後、
 * 3件目の有効期間が、その対のうち**片方とだけ**重なる。3件目にとっての一致は
 * ちょうど1件（重なるほうの1件、既に `contested`）——**この歯が直す穴そのもの**。
 *
 * **直した後**: 一致がちょうど1件でも、その1件が `contested` なら `markContested` へは
 * 進まず、2件以上のときと同じ形（`unresolved_conflict`、`memory_events` へ evidence）で
 * 扱う。
 */

const ctx: Ctx = { tenantId: "tenant-933-single-contested" };

/** 抽出には発話をそのまま1件返し、claim key の導出にはいつも同じ鍵を返す偽の LLM。 */
function sameKeyLlm(contents: string[]): LLMProvider {
  let next = 0;
  return {
    complete: async () => {
      throw new Error("not used");
    },
    completeStructured: async <T>(_ctx: Ctx, req: StructuredRequest<T>): Promise<T> => {
      if ((req.schema as unknown) === ExtractionResultSchema) {
        const content = contents[next++]!;
        return req.schema.parse({ memories: [{ content, provenanceKind: "stated" }] });
      }
      return req.schema.parse({ claims: [{ subject: "user", predicate: "address" }] });
    },
  };
}

function buildRuntimeWithStores(contents: string[]) {
  const stores = createFakeRuntimeStores();
  const runtime = createRuntime({
    memoryStore: stores.memoryStore,
    outboxStore: stores.outboxStore,
    vectorStore: stores.vectorStore,
    eventStore: stores.eventStore,
    tenantSettingsStore: stores.tenantSettingsStore,
    llmProvider: sameKeyLlm(contents),
    embeddingProvider: stores.embeddingProvider,
    hashContent: (content: string) => `sha256(${content})`,
  });
  return { runtime, stores };
}

describe("claim key の検出: 一致がちょうど1件で、その1件が既に contested な場合（Issue #933 PR1 の穴埋め、core の Fake）", () => {
  it("3件目の有効期間が対のうち片方とだけ重なる: markContested へ進まず unresolved_conflict になり、evidence が積まれる。対は壊れない", async () => {
    const { runtime, stores } = buildRuntimeWithStores([
      "住所は東京",
      "住所は大阪",
      "住所は名古屋",
    ]);

    const first = await runtime.observe(ctx, {
      kind: "utterance",
      text: "住所は東京",
      claimKey: { enabled: true, detectContested: true },
      validFrom: new Date("2020-01-01T00:00:00Z"),
      validUntil: new Date("2025-01-01T00:00:00Z"),
    });
    const second = await runtime.observe(ctx, {
      kind: "utterance",
      text: "住所は大阪",
      claimKey: { enabled: true, detectContested: true },
      validFrom: new Date("2019-01-01T00:00:00Z"),
      validUntil: new Date("2021-01-01T00:00:00Z"),
    });
    // 1件目・2件目は重なる（2020-2021）ので対になる——前提の確認。
    expect(second.contestedDetection).toEqual([
      expect.objectContaining({
        matchCount: 1,
        result: expect.objectContaining({ kind: "contested", withMemoryId: first.memoryIds[0] }),
      }),
    ]);

    const third = await runtime.observe(ctx, {
      kind: "utterance",
      text: "住所は名古屋",
      claimKey: { enabled: true, detectContested: true },
      // 1件目（2020-2025）とだけ重なり、2件目（2019-2021）とは重ならない
      // （2024 は 2021 より後）。
      validFrom: new Date("2024-01-01T00:00:00Z"),
      validUntil: new Date("2026-01-01T00:00:00Z"),
    });

    // 直す前は matchCount: 1, result.kind: "contested"（そのまま markContested へ進み、
    // ineligible になって痕跡が残らなかった）。直した後は unresolved_conflict になる。
    expect(third.contestedDetection).toEqual([
      expect.objectContaining({
        matchCount: 1,
        result: expect.objectContaining({ kind: "unresolved_conflict" }),
      }),
    ]);

    const thirdMemory = await stores.memoryStore.get(ctx, third.memoryIds[0]!);
    expect(thirdMemory?.status).toBe("active");
    expect(thirdMemory?.contestedWithId ?? null).toBeNull();

    // 1件目・2件目の対は壊れない。
    const firstMemory = await stores.memoryStore.get(ctx, first.memoryIds[0]!);
    const secondMemory = await stores.memoryStore.get(ctx, second.memoryIds[0]!);
    expect(firstMemory?.status).toBe("contested");
    expect(firstMemory?.contestedWithId).toBe(second.memoryIds[0]);
    expect(secondMemory?.status).toBe("contested");
    expect(secondMemory?.contestedWithId).toBe(first.memoryIds[0]);

    // evidence が3件目に積まれる。1件目には積まれない（markContested の経路ではない）。
    const events = await stores.eventStore.list(ctx, { memoryId: third.memoryIds[0]! });
    const unresolvedEvents = events.filter(
      (e) => (e.meta as { reason?: string } | null)?.reason === "claim_key_conflict_unresolved",
    );
    expect(unresolvedEvents).toHaveLength(1);
    const note = JSON.parse((unresolvedEvents[0]!.meta as { note: string }).note) as {
      matchCount: number;
      matches: Array<{ id: string; status: string }>;
    };
    expect(note.matchCount).toBe(1);
    expect(note.matches).toEqual([
      expect.objectContaining({ id: first.memoryIds[0], status: "contested" }),
    ]);

    const firstEvents = await stores.eventStore.list(ctx, { memoryId: first.memoryIds[0]! });
    expect(
      firstEvents.filter(
        (e) => (e.meta as { reason?: string } | null)?.reason === "claim_key_conflict_unresolved",
      ),
    ).toEqual([]);
  });
});
