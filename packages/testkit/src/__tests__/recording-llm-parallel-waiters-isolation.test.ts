// 確かめ直し（Issue #1759、B 群 #1609 / ADR 0500）の歯。
//
// ADR 0500: `RecordingLLMProvider` は「呼び出し側へ返す値を、それぞれ別の写しにする」。
// 既存の歯（provider-fakes-llm-response-isolation.test.ts）は、並列の待ち側を `complete` で1人だけ見ていて、
// 待ち側の複製（`complete` の `structuredClone(await waiting)`・`completeStructured` の
// `schema.parse(structuredClone(await waiting))`）を外しても赤にならなかった。
// ここでは、同じ呼び出しを3つ並列に投げ、全員が別の参照を受け取り、1人が書き換えても他に漏れないことを縛る。
import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { Ctx, LLMProvider, PromptSpec } from "@mnemora/core";
import { CassetteRecorder, RecordingLLMProvider } from "../__fixtures__/cassette-recorder.js";

const ctx: Ctx = { tenantId: "llm-parallel-waiters" };
const PROMPT: PromptSpec = { messages: [{ role: "user", content: "p" }] };
const loose = z.object({ items: z.array(z.unknown()), meta: z.record(z.string(), z.unknown()) });
const live = () => ({ items: [{ n: 1 }], meta: { k: { deep: 1 } } });
const delegate = (): LLMProvider => ({
  complete: async () => ({ content: "live" }),
  completeStructured: (async () => live()) as LLMProvider["completeStructured"],
});

describe("RecordingLLMProvider: 並列に待った側が複数でも、全員が別の写しを受け取る（ADR 0500）", () => {
  it("complete: 3つ並列", async () => {
    const provider = new RecordingLLMProvider(delegate(), new CassetteRecorder(), "m");
    const results = await Promise.all([
      provider.complete(ctx, PROMPT),
      provider.complete(ctx, PROMPT),
      provider.complete(ctx, PROMPT),
    ]);
    expect(new Set(results).size).toBe(3);
    results[1]!.content = "mutated";
    expect(results[0]!.content).toBe("live");
    expect(results[2]!.content).toBe("live");
  });

  it("completeStructured（作り直されない欄）: 3つ並列", async () => {
    const provider = new RecordingLLMProvider(delegate(), new CassetteRecorder(), "m");
    const req = { prompt: PROMPT, schema: loose };
    const results = await Promise.all([
      provider.completeStructured(ctx, req),
      provider.completeStructured(ctx, req),
      provider.completeStructured(ctx, req),
    ]);
    expect(new Set(results.map((r) => r.items[0])).size).toBe(3);
    (results[1]!.items[0] as { n: number }).n = 99;
    (results[2]!.meta.k as { deep: number }).deep = 99;
    expect(results[0]).toEqual(live());
    expect((results[1]!.meta.k as { deep: number }).deep).toBe(1);
    expect((results[2]!.items[0] as { n: number }).n).toBe(1);
  });

  it("対照: 値は等しい", async () => {
    const provider = new RecordingLLMProvider(delegate(), new CassetteRecorder(), "m");
    const [a, b] = await Promise.all([
      provider.completeStructured(ctx, { prompt: PROMPT, schema: loose }),
      provider.completeStructured(ctx, { prompt: PROMPT, schema: loose }),
    ]);
    expect(a).toEqual(live());
    expect(b).toEqual(live());
  });
});
