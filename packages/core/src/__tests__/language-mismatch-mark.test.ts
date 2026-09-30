import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import type { LLMProvider } from "../interfaces/llm-provider.js";
import { createRuntime } from "../runtime.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";

/**
 * Issue #1370（ADR 0391）: 言語の事後検査の印が、すべての抽出経路（sync・deferred・reextract）で
 * `created` イベントの `meta.languageMismatch` に出る。鍵なし（偽の LLM）で効く。
 * 印は付けるだけ——Memory は今までどおり作られ、再試行も全文フォールバックもしない（LLM は1回だけ呼ばれる）。
 */

const ctx: Ctx = { tenantId: "language-mismatch-mark" };
const JA_TEXT = "今日は渋谷のパン屋で働いています。毎朝パンを焼くのが好きです。";
const EN_CONTENT = "The user works at a bakery in Shibuya and enjoys baking bread every morning.";
const JA_CONTENT = "ユーザーは渋谷のパン屋で働いており、毎朝パンを焼くのが好き。";

let llmCalls = 0;
/** extract の LLM が順に返す本文。`null` は LLM の失敗。 */
let outputs: Array<string | null> = [];
const llm: LLMProvider = {
  complete: async () => ({ content: "" }),
  completeStructured: async (_ctx, req) => {
    llmCalls += 1;
    const next = outputs.shift();
    if (next === null) throw new Error("LLM が落ちた");
    if (next === undefined) throw new Error("unexpected LLM call");
    return req.schema.parse({ memories: [{ content: next, provenanceKind: "stated" }] });
  },
};

function makeKit() {
  llmCalls = 0;
  const stores = createFakeRuntimeStores();
  const runtime = createRuntime({
    memoryStore: stores.memoryStore,
    outboxStore: stores.outboxStore,
    vectorStore: stores.vectorStore,
    eventStore: stores.eventStore,
    tenantSettingsStore: stores.tenantSettingsStore,
    llmProvider: llm,
    embeddingProvider: stores.embeddingProvider,
    hashContent: (content) => `h:${content}`,
    clock: { now: () => new Date(Date.now() + 60_000) },
  });
  return {
    runtime,
    createdMetas: async () =>
      (await stores.eventStore.list(ctx, { kind: "created" })).map((e) => e.meta ?? {}),
  };
}

describe("言語の事後検査の印（#1370、ADR 0391）", () => {
  it("sync: 日本語の観測から英語の本文が出たら、created の meta.languageMismatch に印が出る。Memory は作られる", async () => {
    const kit = makeKit();
    outputs = [EN_CONTENT];
    const result = await kit.runtime.observe(ctx, { kind: "utterance", text: JA_TEXT });
    expect(result.extraction).toBe("ok");
    expect(result.memoryIds).toHaveLength(1);
    const metas = await kit.createdMetas();
    expect(metas).toHaveLength(1);
    expect(metas[0]!.reason).toBe("extracted");
    expect(metas[0]!.languageMismatch).toMatchObject({ rule: "cjk_observation_latin_content" });
    expect(llmCalls).toBe(1); // 再試行しない
  });

  it("deferred: tick が走らせる抽出でも同じ印が出る", async () => {
    const kit = makeKit();
    outputs = [EN_CONTENT];
    await kit.runtime.observe(ctx, { kind: "utterance", text: JA_TEXT, extract: "deferred" });
    const tick = await kit.runtime.tick(ctx, { kinds: ["extract"], leaseMs: 60_000 });
    expect(tick.processed).toBe(1);
    const metas = await kit.createdMetas();
    expect(metas).toHaveLength(1);
    expect(metas[0]!.languageMismatch).toMatchObject({ rule: "cjk_observation_latin_content" });
    expect(llmCalls).toBe(1);
  });

  it("reextract: 全文フォールバックの後にやり直した抽出が英語なら、その新しい Memory の created に印が出る", async () => {
    const kit = makeKit();
    outputs = [null, EN_CONTENT];
    const observed = await kit.runtime.observe(ctx, { kind: "utterance", text: JA_TEXT });
    expect(observed.extraction).toBe("llm_failed_whole_observation");
    const result = await kit.runtime.reextract(ctx, observed.observationId);
    expect(result.extraction).toBe("ok");
    expect(result.memoryIds).toHaveLength(1);
    const metas = await kit.createdMetas();
    const marked = metas.filter((m) => m.languageMismatch !== undefined);
    expect(marked).toHaveLength(1);
    expect(marked[0]!.reason).toBe("extracted");
    // 全文フォールバックの Memory（本文は観測そのもの）には印が付かない。
    const fallback = metas.find((m) => m.reason === "extraction_failed_whole_observation_fallback");
    expect(fallback).toBeDefined();
    expect(fallback!.languageMismatch).toBeUndefined();
  });

  it("日本語の本文なら印は出ない（created の meta の形は今までどおり）", async () => {
    const kit = makeKit();
    outputs = [JA_CONTENT];
    await kit.runtime.observe(ctx, { kind: "utterance", text: JA_TEXT });
    const metas = await kit.createdMetas();
    expect(Object.keys(metas[0]!).sort()).toEqual(
      ["extractorVersion", "reason", "sourceObservationId"].sort(),
    );
  });

  it("偽陽性の側: 固有名詞だけの本文・コード片では印は出ない（runtime を通しても）", async () => {
    const kit = makeKit();
    outputs = ["Tokyo Disneyland", "npm run build"];
    await kit.runtime.observe(ctx, {
      kind: "utterance",
      text: "週末は東京ディズニーランドに行った",
    });
    await kit.runtime.observe(ctx, {
      kind: "utterance",
      text: "ビルドするときは次のコマンドを打つ",
    });
    const metas = await kit.createdMetas();
    expect(metas).toHaveLength(2);
    for (const meta of metas) expect(meta.languageMismatch).toBeUndefined();
  });

  it("英語の観測から英語の本文なら印は出ない", async () => {
    const kit = makeKit();
    outputs = [EN_CONTENT];
    await kit.runtime.observe(ctx, { kind: "utterance", text: "I work at a bakery in Shibuya." });
    const metas = await kit.createdMetas();
    expect(metas[0]!.languageMismatch).toBeUndefined();
  });
});
