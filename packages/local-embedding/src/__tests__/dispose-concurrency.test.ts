import { describe, expect, it } from "vitest";
import type { Ctx } from "@mnemora/core";
import { LocalEmbeddingProvider } from "../local-embedding-provider.js";
import type { CreateLocalEmbeddingPipeline, LocalEmbeddingPipeline } from "../pipeline.js";

/**
 * Issue #1734（2026-09-30 マージ分の確かめ直し）の歯。PR #1518（ADR 0419）の変異試験で、`dispose()` の
 * 並行・順序の隅の4つがすり抜けた。担当はクローン（miku）の判断で進めている作業であり、オーナーの判断ではない。
 * 重みは取らない——`createPipeline` の注入口と擬似の pipeline だけで測る（`dispose.test.ts` と同じ）。
 *
 * - M4: `dispose()` を**並行に**呼ぶと、上流の `dispose()` は1回で、2つの返り値は同じ Promise（ADR 0419 決定5）。
 *   既存の歯は `await dispose()` の後に2回目を呼ぶ形（直列）だけで、並行の呼びでは上流を2回呼ぶ変異が緑だった。
 * - M6: 読み込みの**最中に** `dispose()` を呼び、その後で読み込みが失敗しても、`dispose()` は reject しない。
 *   既存の歯は、先に `warmup()` が失敗してから `dispose()` を呼ぶ形（そのとき `#ready` は null）だった。
 * - M8: 上流の `dispose()` が reject したら、`dispose()` も同じ理由で reject する（握りつぶさない）。
 * - M9: `dispose()` を呼んだ時点から（解放の完了を待たずに）、`embed()`・`warmup()` は素の `Error` で断られる。
 */

const ctx: Ctx = { tenantId: "test-tenant" };

interface Gate {
  promise: Promise<void>;
  open: () => void;
}
function gate(): Gate {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

function pipelineOf(dispose: () => Promise<void>): LocalEmbeddingPipeline {
  return {
    maxInputTokens: Number.MAX_SAFE_INTEGER,
    countTokens: (texts) => texts.map(() => 0),
    embed: async (texts) => texts.map(() => [1, 2]),
    dispose,
  };
}

function providerOf(createPipeline: CreateLocalEmbeddingPipeline): LocalEmbeddingProvider {
  return new LocalEmbeddingProvider({ createPipeline, dimensions: 2, retry: { attempts: 1 } });
}

describe("LocalEmbeddingProvider.dispose() の並行・順序の隅（Issue #1734 / PR #1518 のすり抜け）", () => {
  it("M4: 解放が終わる前に dispose() を2回呼んでも、上流の dispose は1回で、返り値は同じ Promise", async () => {
    let disposeCalls = 0;
    const release = gate();
    const provider = providerOf(async () =>
      pipelineOf(async () => {
        disposeCalls += 1;
        await release.promise;
      }),
    );
    await provider.warmup();

    const first = provider.dispose();
    const second = provider.dispose();
    expect(second).toBe(first);
    await tick();
    expect(disposeCalls).toBe(1);

    release.open();
    await Promise.all([first, second]);
    expect(disposeCalls).toBe(1);
  });

  it("M6: 読み込みの最中に dispose() を呼び、その後で読み込みが失敗しても、dispose() は reject しない（warmup は reject する）", async () => {
    const loading = gate();
    let createCalls = 0;
    const provider = providerOf(async () => {
      createCalls += 1;
      await loading.promise;
      throw new Error("読み込みの失敗");
    });
    const warm = provider.warmup();
    const warmOutcome = warm.then(
      () => "resolved",
      (error: unknown) => (error as Error).message,
    );
    while (createCalls === 0) await tick();

    const disposing = provider.dispose();
    const disposeOutcome = disposing.then(
      () => "resolved",
      (error: unknown) => `rejected: ${(error as Error).message}`,
    );
    loading.open();

    expect(await disposeOutcome).toBe("resolved");
    // 対照: 読み込みの失敗は warmup 側には届く（探り棒が生きている）。
    expect(await warmOutcome).toContain("モデルを読み込めなかった");
  });

  it("M8: 上流の dispose() が reject したら、dispose() も同じ理由で reject する（2回目以降も同じ）", async () => {
    const failure = new Error("上流の解放の失敗");
    const provider = providerOf(async () =>
      pipelineOf(async () => {
        throw failure;
      }),
    );
    await provider.warmup();

    await expect(provider.dispose()).rejects.toBe(failure);
    await expect(provider.dispose()).rejects.toBe(failure);
  });

  it("M9: dispose() を呼んだ直後（解放の完了を待たず、推論中のうち）から、embed・warmup は断られる", async () => {
    const inference = gate();
    let embedCalls = 0;
    const pipeline = pipelineOf(async () => {});
    pipeline.embed = async (texts) => {
      embedCalls += 1;
      await inference.promise;
      return texts.map(() => [1, 2]);
    };
    const provider = providerOf(async () => pipeline);
    const running = provider.embed(ctx, ["a"]);
    while (embedCalls === 0) await tick();

    // 走っている embed が終わるまで、解放は終わらない。dispose() は await しない。
    const disposing = provider.dispose();

    await expect(provider.embed(ctx, ["b"])).rejects.toThrow(/dispose/);
    await expect(provider.warmup()).rejects.toThrow(/dispose/);
    // 断られた embed は pipeline に届いていない。
    expect(embedCalls).toBe(1);

    inference.open();
    await expect(running).resolves.toEqual([[1, 2]]);
    await disposing;
  });
});
