import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import type { LLMProvider, StructuredRequest } from "../interfaces/llm-provider.js";
import { createRuntime } from "../runtime.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";

/**
 * Issue #1436・ADR 0491: 相対的な期間（「去年」「今年」）だけが違う、**どちらも正しい** 2 主張が
 * **別々の observation** に分かれると、`detectContested` は contested にする（今の振る舞い。直し方 (a)(b) は
 * オーナーの判断待ち）。
 *
 * 機序: 「去年」「今年」は `validFrom`/`validUntil` に入らない（どちらの抽出でも null）ので、ADR 0324 決定4 の
 * 有効期間の重なり判定は「重なる」と答え、同じ claim key・`contentHash` が違う 2 件が一致する。同じ observation の
 * 兄弟どうしなら ADR 0377 で除かれる（`claim-key-same-observation-not-contested.test.ts` の (a)）が、別の
 * observation は除かれない。
 *
 * ⚠ **この歯は「今は contested になる」ことを記録する。** 誰かが (a) 抽出で相対時期を `validFrom`/`validUntil` に
 * 入れる、(b) claim key のプロンプトで期間違いを別の predicate にする、のどちらかを入れて、この対が contested に
 * ならなくなったら、この歯が赤くなる。そのときは ADR 0491 と Issue #1436 を読み直し、歯を「contested にならない」
 * 向きに替えること。
 *
 * 作り方は `claim-key-same-observation-not-contested.test.ts` と同じ（core の Fake、固定の LLM の応答）。
 */

const ctx: Ctx = { tenantId: "tenant-1436" };

function sequencedLlm(responses: unknown[]): LLMProvider {
  let index = 0;
  return {
    complete: async () => {
      throw new Error("not used");
    },
    completeStructured: async <T>(_ctx: Ctx, req: StructuredRequest<T>): Promise<T> => {
      if (index >= responses.length) {
        throw new Error(`sequencedLlm: no response configured for call #${index + 1}`);
      }
      return req.schema.parse(responses[index++]) as T;
    },
  };
}

function buildRuntime(llmProvider: LLMProvider) {
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
  });
  return { runtime, stores };
}

const CLAIM_KEY = { enabled: true, detectContested: true } as const;

describe("claim key の検出: 別々の observation に分かれた、相対期間だけが違う正しい 2 主張（Issue #1436、ADR 0491）", () => {
  it("今の振る舞い: 「去年は札幌」と「今年は福岡」が別ターンなら、validFrom/validUntil が null のまま重なり、contested になる", async () => {
    const llm = sequencedLlm([
      { memories: [{ content: "去年は札幌で働いていた", provenanceKind: "stated" }] },
      { claims: [{ subject: "user", predicate: "work_location" }] },
      { memories: [{ content: "今年は福岡で働いている", provenanceKind: "stated" }] },
      { claims: [{ subject: "user", predicate: "work_location" }] },
    ]);
    const { runtime, stores } = buildRuntime(llm);

    const first = await runtime.observe(ctx, {
      kind: "utterance",
      text: "去年は札幌で働いていました。",
      claimKey: CLAIM_KEY,
    });
    const second = await runtime.observe(ctx, {
      kind: "utterance",
      text: "今年は福岡で働いています。",
      claimKey: CLAIM_KEY,
    });

    const lastYearId = first.memoryIds[0]!;
    const thisYearId = second.memoryIds[0]!;
    const lastYear = await stores.memoryStore.get(ctx, lastYearId);
    const thisYear = await stores.memoryStore.get(ctx, thisYearId);

    // 相対的な期間は有効期間に入っていない（どちらも null）。これが「重なる」と答えられる理由。
    expect(lastYear?.validFrom ?? null).toBeNull();
    expect(lastYear?.validUntil ?? null).toBeNull();
    expect(thisYear?.validFrom ?? null).toBeNull();
    expect(thisYear?.validUntil ?? null).toBeNull();

    expect(second.contestedDetection).toEqual([
      expect.objectContaining({
        matchCount: 1,
        result: expect.objectContaining({ kind: "contested", withMemoryId: lastYearId }),
      }),
    ]);
    expect(lastYear?.status).toBe("contested");
    expect(thisYear?.status).toBe("contested");
    expect(lastYear?.contestedWithId).toBe(thisYearId);
    expect(thisYear?.contestedWithId).toBe(lastYearId);
  });

  it("陽性対照: 同じ 2 主張でも、1 回の observe（同じ発話）から出た兄弟なら contested にならない（ADR 0377）", async () => {
    const llm = sequencedLlm([
      {
        memories: [
          { content: "去年は札幌で働いていた", provenanceKind: "stated" },
          { content: "今年は福岡で働いている", provenanceKind: "stated" },
        ],
      },
      {
        claims: [
          { subject: "user", predicate: "work_location" },
          { subject: "user", predicate: "work_location" },
        ],
      },
    ]);
    const { runtime, stores } = buildRuntime(llm);

    const result = await runtime.observe(ctx, {
      kind: "utterance",
      text: "去年は札幌で働いていました。今年は福岡で働いています。",
      claimKey: CLAIM_KEY,
    });
    expect(result.memoryIds).toHaveLength(2);
    expect(result.contestedDetection).toEqual([
      expect.objectContaining({ matchCount: 0, result: { kind: "no_conflict" } }),
      expect.objectContaining({ matchCount: 0, result: { kind: "no_conflict" } }),
    ]);
    const memories = await Promise.all(
      result.memoryIds.map((id) => stores.memoryStore.get(ctx, id)),
    );
    expect(memories.map((m) => m?.status)).toEqual(["active", "active"]);
  });

  it("陽性対照: 有効期間が明示され、重ならない 2 主張なら、別ターンでも contested にならない（ADR 0324 決定4）", async () => {
    const llm = sequencedLlm([
      { memories: [{ content: "札幌で働いていた", provenanceKind: "stated" }] },
      { claims: [{ subject: "user", predicate: "work_location" }] },
      { memories: [{ content: "福岡で働いている", provenanceKind: "stated" }] },
      { claims: [{ subject: "user", predicate: "work_location" }] },
    ]);
    const { runtime, stores } = buildRuntime(llm);

    const first = await runtime.observe(ctx, {
      kind: "utterance",
      text: "札幌で働いていました。",
      validFrom: new Date("2020-01-01T00:00:00Z"),
      validUntil: new Date("2025-01-01T00:00:00Z"),
      claimKey: CLAIM_KEY,
    });
    const second = await runtime.observe(ctx, {
      kind: "utterance",
      text: "福岡で働いています。",
      validFrom: new Date("2025-01-01T00:00:00Z"),
      claimKey: CLAIM_KEY,
    });
    expect(second.contestedDetection).toEqual([
      expect.objectContaining({ matchCount: 0, result: { kind: "no_conflict" } }),
    ]);
    const a = await stores.memoryStore.get(ctx, first.memoryIds[0]!);
    const b = await stores.memoryStore.get(ctx, second.memoryIds[0]!);
    expect([a?.status, b?.status]).toEqual(["active", "active"]);
  });
});
