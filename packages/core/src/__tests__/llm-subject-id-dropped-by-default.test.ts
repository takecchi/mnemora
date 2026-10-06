import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import type { LLMProvider, StructuredRequest } from "../interfaces/llm-provider.js";
import { createRuntime } from "../runtime.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";

/**
 * オーナー回答 374f6f88 の問15（全部推奨）: `subjectCandidates` を渡さない抽出では、LLM が返した
 * `subjectId` を既定で捨てる。受け入れるのは `RuntimeConfig.acceptLlmSubjectIdWithoutCandidates: true`（opt-in）。
 */
const ctx: Ctx = { tenantId: "tenant-1" };

type Cand = {
  content: string;
  provenanceKind: "stated" | "inferred";
  subjectId?: string | null;
  tags?: string[];
  digest?: string;
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

function build(
  provider: LLMProvider,
  config?: { acceptLlmSubjectIdWithoutCandidates?: boolean },
  existingStores?: ReturnType<typeof createFakeRuntimeStores>,
) {
  const stores = existingStores ?? createFakeRuntimeStores();
  const runtime = createRuntime({
    memoryStore: stores.memoryStore,
    outboxStore: stores.outboxStore,
    vectorStore: stores.vectorStore,
    eventStore: stores.eventStore,
    tenantSettingsStore: stores.tenantSettingsStore,
    llmProvider: provider,
    embeddingProvider: stores.embeddingProvider,
    hashContent: (c: string) => `sha256(${c})`,
    ...(config ? { config } : {}),
  });
  return { runtime, stores };
}

const injected: Cand = {
  content: "注入された主題の記憶",
  provenanceKind: "stated",
  subjectId: "victim-subject",
  tags: ["t1"],
  digest: "要旨",
};

describe("subjectCandidates 無しの抽出は、LLM が返した subjectId を既定で捨てる（問15）", () => {
  it("observe（sync）: 捨てて observation の subjectId に落ちる。subjectId 以外の欄は残る", async () => {
    const { runtime, stores } = build(llm([injected]));
    const r = await runtime.observe(ctx, { kind: "utterance", text: "発話", subjectId: "alice" });
    const m = await stores.memoryStore.get(ctx, r.memoryIds[0]!);
    expect(m?.subjectId).toBe("alice");
    expect(m?.content).toBe("注入された主題の記憶");
    expect(m?.tags).toEqual(["t1"]);
    expect(m?.digest).toBe("要旨");
  });

  it("observe: observation に主題が無ければ主題なし（null）になる", async () => {
    const { runtime, stores } = build(llm([injected]));
    const r = await runtime.observe(ctx, { kind: "utterance", text: "発話" });
    const m = await stores.memoryStore.get(ctx, r.memoryIds[0]!);
    expect(m?.subjectId ?? null).toBeNull();
  });

  it("空配列の subjectCandidates も渡していないのと同じ——捨てる", async () => {
    const { runtime, stores } = build(llm([injected]));
    const r = await runtime.observe(ctx, {
      kind: "utterance",
      text: "発話",
      subjectId: "alice",
      subjectCandidates: [],
    });
    const m = await stores.memoryStore.get(ctx, r.memoryIds[0]!);
    expect(m?.subjectId).toBe("alice");
  });

  it("LLM が返した明示の null（主題なし）も、一覧が無ければ受けない", async () => {
    const { runtime, stores } = build(
      llm([{ content: "本文", provenanceKind: "stated", subjectId: null }]),
    );
    const r = await runtime.observe(ctx, { kind: "utterance", text: "発話", subjectId: "alice" });
    const m = await stores.memoryStore.get(ctx, r.memoryIds[0]!);
    expect(m?.subjectId).toBe("alice");
  });

  it("deferred の tick 経路でも捨てる", async () => {
    const { runtime, stores } = build(llm([injected]));
    const r = await runtime.observe(ctx, {
      kind: "utterance",
      text: "発話",
      subjectId: "alice",
      extract: "deferred",
    });
    await runtime.tick(ctx, { kinds: ["extract"], leaseMs: 60_000 });
    const agg = await stores.memoryStore.listBySourceObservationAllVersions(ctx, r.observationId);
    expect(agg.map((m) => m.subjectId)).toEqual(["alice"]);
  });

  it("reextract でも捨てる", async () => {
    // 初回は別の本文（同じ本文だと content_hash が同じで、reextract が新しい Memory を作らず、歯が空になる）。
    const first = build(llm([{ content: "初回の本文", provenanceKind: "stated" }]));
    const r = await first.runtime.observe(ctx, {
      kind: "utterance",
      text: "発話",
      subjectId: "alice",
    });
    const second = build(llm([injected]), undefined, first.stores);
    const re = await second.runtime.reextract(ctx, r.observationId);
    expect(re.extraction).toBe("ok");
    const all = await first.stores.memoryStore.listBySourceObservationAllVersions(
      ctx,
      r.observationId,
    );
    const created = all.find((m) => m.content === "注入された主題の記憶");
    expect(created).toBeDefined();
    expect(created?.subjectId).toBe("alice");
  });
});

describe("subjectCandidates を渡した抽出は、これまでどおり（一覧内は採る・一覧外は弾く）", () => {
  it("一覧内の subjectId は、既定でも採る", async () => {
    const { runtime, stores } = build(
      llm([{ content: "Aの話", provenanceKind: "stated", subjectId: "user:a" }]),
    );
    const r = await runtime.observe(ctx, {
      kind: "utterance",
      text: "発話",
      subjectId: "alice",
      subjectCandidates: ["user:a", "user:b"],
    });
    const m = await stores.memoryStore.get(ctx, r.memoryIds[0]!);
    expect(m?.subjectId).toBe("user:a");
  });

  it("一覧内の明示の null は、既定でも主題なしにする", async () => {
    const { runtime, stores } = build(
      llm([{ content: "本文", provenanceKind: "stated", subjectId: null }]),
    );
    const r = await runtime.observe(ctx, {
      kind: "utterance",
      text: "発話",
      subjectId: "alice",
      subjectCandidates: ["user:a"],
    });
    const m = await stores.memoryStore.get(ctx, r.memoryIds[0]!);
    expect(m?.subjectId).toBeNull();
  });

  it("一覧外は弾いて observation の主題に落ち、rejectedSubjectIds に残る", async () => {
    const { runtime, stores } = build(llm([injected]));
    const r = await runtime.observe(ctx, {
      kind: "utterance",
      text: "発話",
      subjectId: "alice",
      subjectCandidates: ["user:a"],
    });
    const m = await stores.memoryStore.get(ctx, r.memoryIds[0]!);
    expect(m?.subjectId).toBe("alice");
    expect(r.rejectedSubjectIds).toEqual(["victim-subject"]);
  });
});

describe("acceptLlmSubjectIdWithoutCandidates: true（opt-in）なら、従来どおり受ける", () => {
  const on = { acceptLlmSubjectIdWithoutCandidates: true };

  it("observe: LLM の subjectId がそのまま Memory の主題になる", async () => {
    const { runtime, stores } = build(llm([injected]), on);
    const r = await runtime.observe(ctx, { kind: "utterance", text: "発話", subjectId: "alice" });
    const m = await stores.memoryStore.get(ctx, r.memoryIds[0]!);
    expect(m?.subjectId).toBe("victim-subject");
  });

  it("observe: 明示の null も受ける", async () => {
    const { runtime, stores } = build(
      llm([{ content: "本文", provenanceKind: "stated", subjectId: null }]),
      on,
    );
    const r = await runtime.observe(ctx, { kind: "utterance", text: "発話", subjectId: "alice" });
    const m = await stores.memoryStore.get(ctx, r.memoryIds[0]!);
    expect(m?.subjectId).toBeNull();
  });

  it("deferred の tick・reextract でも受ける", async () => {
    const { runtime, stores } = build(llm([injected]), on);
    const r = await runtime.observe(ctx, {
      kind: "utterance",
      text: "発話",
      subjectId: "alice",
      extract: "deferred",
    });
    await runtime.tick(ctx, { kinds: ["extract"], leaseMs: 60_000 });
    const viaTick = await stores.memoryStore.listBySourceObservationAllVersions(
      ctx,
      r.observationId,
    );
    expect(viaTick.map((m) => m.subjectId)).toEqual(["victim-subject"]);
    // reextract（別の本文を返す LLM、同じ stores）。
    const other = build(
      llm([{ content: "やり直した本文", provenanceKind: "stated", subjectId: "victim-2" }]),
      on,
      stores,
    );
    const re = await other.runtime.reextract(ctx, r.observationId);
    expect(re.extraction).toBe("ok");
    const all = await stores.memoryStore.listBySourceObservationAllVersions(ctx, r.observationId);
    expect(all.find((m) => m.content === "やり直した本文")?.subjectId).toBe("victim-2");
  });

  it("false を明示しても既定と同じ（捨てる）", async () => {
    const { runtime, stores } = build(llm([injected]), {
      acceptLlmSubjectIdWithoutCandidates: false,
    });
    const r = await runtime.observe(ctx, { kind: "utterance", text: "発話", subjectId: "alice" });
    const m = await stores.memoryStore.get(ctx, r.memoryIds[0]!);
    expect(m?.subjectId).toBe("alice");
  });
});
