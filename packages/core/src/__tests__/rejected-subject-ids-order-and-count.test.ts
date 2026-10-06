import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import type { LLMProvider, StructuredRequest } from "../interfaces/llm-provider.js";
import { createRuntime } from "../runtime.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";

/**
 * Issue #1746: `ObserveResult.rejectedSubjectIds` は「弾いた順、`ExtractCandidatesResult.rejectedSubjectIds` の写し」
 * （runtime.ts の TSDoc）。以前の歯は弾く値が1件の形しか見ておらず、重複を除く・先頭だけに切る変異が素通りした。
 * ここでは、弾いた候補ごとに1件ずつ（重複もそのまま）、弾いた順に並ぶことを縛る。
 */
const ctx: Ctx = { tenantId: "tenant-1" };

type Cand = {
  content: string;
  provenanceKind: "stated" | "inferred";
  subjectId?: string | null;
};

function llm(memories: Cand[]): LLMProvider {
  return {
    complete: async () => {
      throw new Error("not used");
    },
    completeStructured: async <T>(_c: Ctx, req: StructuredRequest<T>): Promise<T> =>
      req.schema.parse({ memories }) as T,
  };
}

function build(provider: LLMProvider) {
  const stores = createFakeRuntimeStores();
  const runtime = createRuntime({
    memoryStore: stores.memoryStore,
    outboxStore: stores.outboxStore,
    vectorStore: stores.vectorStore,
    eventStore: stores.eventStore,
    tenantSettingsStore: stores.tenantSettingsStore,
    llmProvider: provider,
    embeddingProvider: stores.embeddingProvider,
    hashContent: (c: string) => `sha256(${c})`,
  });
  return { runtime, stores };
}

describe("ObserveResult.rejectedSubjectIds は、弾いた候補ごとに1件ずつ、弾いた順に並ぶ（Issue #1746）", () => {
  it('一覧外の値が複数（同じ値の重複を含む）あれば、全件を重複もそのまま弾いた順に返す。一覧内・null・文字列 "null" は載らない', async () => {
    const { runtime, stores } = build(
      llm([
        { content: "一覧内", provenanceKind: "stated", subjectId: "user:a" },
        { content: "一覧外その1", provenanceKind: "stated", subjectId: "user:y" },
        { content: "主題なし", provenanceKind: "stated", subjectId: null },
        { content: "一覧外その2", provenanceKind: "stated", subjectId: "user:x" },
        // ADR 0304: 一覧に無い文字列 "null" は弾かずに主題なしとして読む。
        { content: "文字列の null", provenanceKind: "stated", subjectId: "null" },
        { content: "一覧外その3（その1と同じ値）", provenanceKind: "stated", subjectId: "user:y" },
        { content: "主題の指定なし", provenanceKind: "stated" },
      ]),
    );
    const r = await runtime.observe(ctx, {
      kind: "utterance",
      text: "発話",
      subjectId: "alice",
      subjectCandidates: ["user:a"],
    });

    expect(r.rejectedSubjectIds).toEqual(["user:y", "user:x", "user:y"]);

    // 弾いた候補も記憶としては作られ、observation の主題へ落ちる（件数を数える前提の確認）。
    const all = await stores.memoryStore.listBySourceObservationAllVersions(ctx, r.observationId);
    const subjectOf = (content: string) => all.find((m) => m.content === content)?.subjectId;
    expect(all).toHaveLength(7);
    expect(subjectOf("一覧内")).toBe("user:a");
    expect(subjectOf("一覧外その1")).toBe("alice");
    expect(subjectOf("一覧外その2")).toBe("alice");
    expect(subjectOf("一覧外その3（その1と同じ値）")).toBe("alice");
    expect(subjectOf("主題なし")).toBeNull();
    expect(subjectOf("文字列の null")).toBeNull();
  });

  it("全候補が一覧外なら、候補の数だけ並ぶ（同じ値が続いても1件にまとめない）", async () => {
    const { runtime } = build(
      llm([
        { content: "一つ目", provenanceKind: "stated", subjectId: "user:z" },
        { content: "二つ目", provenanceKind: "stated", subjectId: "user:z" },
      ]),
    );
    const r = await runtime.observe(ctx, {
      kind: "utterance",
      text: "発話",
      subjectId: "alice",
      subjectCandidates: ["user:a"],
    });
    expect(r.rejectedSubjectIds).toEqual(["user:z", "user:z"]);
  });
});
