import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import type { Ctx } from "../ctx.js";
import type { LLMProvider } from "../interfaces/llm-provider.js";
import { truncateForFallbackDigest } from "../extraction.js";
import { ProvenanceSchema } from "../provenance.js";
import { createRuntime } from "../runtime.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";

// 既定の定数は公開していないので、doc の値は `runtime.ts` の TSDoc を読んで、実装の値は config を省いた runtime の振る舞いから、
// どちらも実行時に取って突き合わせる。どちらか片方だけを直すと赤くなる。

const RUNTIME_SOURCE = readFileSync(
  fileURLToPath(new URL("../runtime.ts", import.meta.url)),
  "utf8",
);

/** `export interface RuntimeConfig { … }` の中で、`field?:` の直前の TSDoc を返す。 */
function docOf(field: string): string {
  const start = RUNTIME_SOURCE.indexOf("export interface RuntimeConfig {");
  const end = RUNTIME_SOURCE.indexOf("\n}\n", start);
  const block = RUNTIME_SOURCE.slice(start, end);
  const at = block.indexOf(`\n  ${field}?:`);
  if (at < 0) throw new Error(`RuntimeConfig.${field} が見つからない`);
  const docStart = block.lastIndexOf("/**", at);
  return block.slice(docStart, at);
}

/** TSDoc に書かれた既定値（「省略時（…）は `"v1"`」「既定 200」「既定は `false`」の形）を取り出す。 */
function documentedDefault(field: string): string {
  const doc = docOf(field);
  const m =
    doc.match(/省略時(?:（[^）]*）)?は\s*`"?([^`"]+)"?`/) ??
    doc.match(/既定は\s*`([^`]+)`/) ??
    doc.match(/既定\s+([0-9]+)/);
  if (!m) throw new Error(`RuntimeConfig.${field} の TSDoc に既定値の記述が見つからない`);
  return m[1]!;
}

const ctx: Ctx = { tenantId: "runtime-config-defaults-doc" };
const LONG_CONTENT = "あ".repeat(500);

describe("RuntimeConfig の既定値は TSDoc の値と一致する", () => {
  it("extractorVersion・llmModelId・promptVersion・digestFallbackLength・autoQueueConsolidateReflectOnExtract", async () => {
    const stores = createFakeRuntimeStores();
    const llm: LLMProvider = {
      complete: async () => ({ content: "unused" }),
      completeStructured: async (_c, req) =>
        req.schema.parse({ memories: [{ content: LONG_CONTENT, provenanceKind: "inferred" }] }),
    };
    const createWithOutbox = vi.spyOn(stores.memoryStore, "createMemoryWithOutbox");
    const runtime = createRuntime({
      ...stores,
      llmProvider: llm,
      hashContent: (c: string) => `h:${c}`,
    });

    const result = await runtime.observe(ctx, { kind: "utterance", text: "発話" });
    const memory = (await stores.memoryStore.get(ctx, result.memoryIds[0]!))!;

    expect(memory.extractorVersion).toBe(documentedDefault("extractorVersion"));
    expect(memory.provenance).toMatchObject({
      kind: "inferred",
      model: documentedDefault("llmModelId"),
      promptVersion: documentedDefault("promptVersion"),
    });
    expect(memory.digestSource).toBe("fallback");
    expect(memory.digest).toBe(
      truncateForFallbackDigest(LONG_CONTENT, Number(documentedDefault("digestFallbackLength"))),
    );
    expect(documentedDefault("autoQueueConsolidateReflectOnExtract")).toBe("false");
    expect(createWithOutbox.mock.calls.map((call) => call[2])).toEqual([["embed"]]);
  });

  /** `config` を渡して inferred の候補を1件抽出させ、書かれた provenance を返す。 */
  async function inferredProvenanceWith(config: { llmModelId?: string; promptVersion?: string }) {
    const stores = createFakeRuntimeStores();
    const runtime = createRuntime({
      ...stores,
      llmProvider: {
        complete: async () => ({ content: "unused" }),
        completeStructured: async (_c, req) =>
          req.schema.parse({ memories: [{ content: "推論", provenanceKind: "inferred" }] }),
      },
      hashContent: (c: string) => `h:${c}`,
      config,
    });
    const result = await runtime.observe(ctx, { kind: "utterance", text: "発話" });
    return (await stores.memoryStore.get(ctx, result.memoryIds[0]!))!.provenance;
  }

  it("llmModelId・promptVersion の空文字は省略と同じに扱い、既定値を書く（provenance は ProvenanceSchema を通る）", async () => {
    const provenance = await inferredProvenanceWith({ llmModelId: "", promptVersion: "" });
    expect(provenance).toMatchObject({
      kind: "inferred",
      model: documentedDefault("llmModelId"),
      promptVersion: documentedDefault("promptVersion"),
    });
    expect(ProvenanceSchema.safeParse(provenance).success).toBe(true);
  });

  it("対照: 空でない値は、空白だけの値も含めて、そのまま書く（既定値に倒すのは空文字だけ）", async () => {
    expect(
      await inferredProvenanceWith({ llmModelId: "gpt-x", promptVersion: "p9" }),
    ).toMatchObject({
      model: "gpt-x",
      promptVersion: "p9",
    });
    expect(await inferredProvenanceWith({ llmModelId: " ", promptVersion: " " })).toMatchObject({
      model: " ",
      promptVersion: " ",
    });
  });

  it("defaultClaimedBy", async () => {
    const stores = createFakeRuntimeStores();
    const claim = vi.spyOn(stores.outboxStore, "claimBatch");
    const runtime = createRuntime({
      ...stores,
      llmProvider: {
        complete: async () => ({ content: "unused" }),
        completeStructured: async () => {
          throw new Error("not used");
        },
      },
      hashContent: (c: string) => `h:${c}`,
    });

    await runtime.tick(ctx, { leaseMs: 60_000 });

    expect(claim.mock.calls[0]?.[1].claimedBy).toBe(documentedDefault("defaultClaimedBy"));
  });

  /** `config.defaultClaimedBy` と `tick` の `opts.claimedBy` を渡して、`claimBatch` に渡った `claimedBy` を返す。 */
  async function claimedByWith(
    config: { defaultClaimedBy?: string } | undefined,
    opts: { claimedBy?: string },
  ) {
    const stores = createFakeRuntimeStores();
    const claim = vi.spyOn(stores.outboxStore, "claimBatch");
    const runtime = createRuntime({
      ...stores,
      llmProvider: {
        complete: async () => ({ content: "unused" }),
        completeStructured: async () => {
          throw new Error("not used");
        },
      },
      hashContent: (c: string) => `h:${c}`,
      ...(config === undefined ? {} : { config }),
    });

    await runtime.tick(ctx, { leaseMs: 60_000, ...opts });

    return claim.mock.calls[0]?.[1].claimedBy;
  }

  it("defaultClaimedBy の空文字は既定に倒れず、そのまま claimBatch に渡る", async () => {
    expect(await claimedByWith({ defaultClaimedBy: "" }, {})).toBe("");
  });

  it("tick の opts.claimedBy の空文字は、defaultClaimedBy にも既定にも倒れず、そのまま claimBatch に渡る", async () => {
    expect(await claimedByWith({ defaultClaimedBy: "worker-x" }, { claimedBy: "" })).toBe("");
    expect(await claimedByWith(undefined, { claimedBy: "" })).toBe("");
  });

  it("対照: 空でない値は、opts.claimedBy が defaultClaimedBy より、defaultClaimedBy が既定より優先される", async () => {
    expect(await claimedByWith({ defaultClaimedBy: "worker-x" }, {})).toBe("worker-x");
    expect(await claimedByWith({ defaultClaimedBy: "worker-x" }, { claimedBy: "worker-y" })).toBe(
      "worker-y",
    );
    expect(await claimedByWith(undefined, { claimedBy: "worker-y" })).toBe("worker-y");
  });
});
