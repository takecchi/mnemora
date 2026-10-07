import { describe, expect, it } from "vitest";
import type { Ctx } from "@mnemora/core";
import { LocalEmbeddingProvider } from "../local-embedding-provider.js";
import type { CreateLocalEmbeddingPipeline, LocalEmbeddingPipeline } from "../pipeline.js";

/** 共有の読み込み（複数の embed が待つ `#load`）は止めず、待ちだけを signal ごとに切る。ある呼び出しの abort が、別の呼び出しの待つ読み込みを巻き添えにしない。`createPipeline` / `sleep` の注入で組み、実モデルは落とさない。 */
const ctx: Ctx = { tenantId: "test-tenant" };

function pipelineOf(): LocalEmbeddingPipeline {
  return {
    maxInputTokens: Number.MAX_SAFE_INTEGER,
    countTokens: (texts) => texts.map(() => 0),
    embed: async (texts) => texts.map(() => [0, 1]),
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

describe("LocalEmbeddingProvider — 読み込み中の abort", () => {
  it("読み込み中に abort すると、読み込みの完了を待たずに signal.reason で reject する", async () => {
    const gate = deferred<LocalEmbeddingPipeline>();
    const provider = new LocalEmbeddingProvider({
      createPipeline: () => gate.promise,
      dimensions: 2,
    });
    const controller = new AbortController();
    const reason = new Error("caller-reason");

    const promise = provider.embed(ctx, ["a"], { signal: controller.signal });
    await tick();
    controller.abort(reason);

    await expect(promise).rejects.toBe(reason);
    gate.resolve(pipelineOf());
  });

  it("再試行の待ち（sleep）の最中に abort すると、sleep の完了を待たずに signal.reason で reject する", async () => {
    const sleepGate = deferred<void>();
    let createCalls = 0;
    const createPipeline: CreateLocalEmbeddingPipeline = async () => {
      createCalls += 1;
      throw new Error("transient");
    };
    const provider = new LocalEmbeddingProvider({
      createPipeline,
      dimensions: 2,
      retry: { attempts: 3 },
      sleep: () => sleepGate.promise,
    });
    const controller = new AbortController();
    const reason = new Error("caller-reason");

    const promise = provider.embed(ctx, ["a"], { signal: controller.signal });
    await tick();
    expect(createCalls).toBe(1);
    controller.abort(reason);

    await expect(promise).rejects.toBe(reason);
    sleepGate.resolve();
    await tick();
  });

  it("abort 後の reject は「モデルを読み込めなかった」Error ではなく signal.reason である（失敗し続ける pipeline）", async () => {
    const sleepGate = deferred<void>();
    const provider = new LocalEmbeddingProvider({
      createPipeline: async () => {
        throw new Error("always fails");
      },
      dimensions: 2,
      retry: { attempts: 3 },
      sleep: () => sleepGate.promise,
    });
    const controller = new AbortController();
    const reason = new Error("caller-reason");

    const promise = provider.embed(ctx, ["a"], { signal: controller.signal });
    await tick();
    controller.abort(reason);
    const outcome = await promise.then(
      () => "resolved",
      (error: unknown) => error,
    );
    expect(outcome).toBe(reason);
    sleepGate.resolve();
    await tick();
  });

  it("A を abort しても、同じ読み込みを待つ B は成功する（共有の読み込みは止まらない）", async () => {
    const gate = deferred<LocalEmbeddingPipeline>();
    let createCalls = 0;
    const provider = new LocalEmbeddingProvider({
      createPipeline: () => {
        createCalls += 1;
        return gate.promise;
      },
      dimensions: 2,
    });
    const a = new AbortController();
    const b = new AbortController();
    const reason = new Error("a-reason");

    const promiseA = provider.embed(ctx, ["a"], { signal: a.signal });
    const promiseB = provider.embed(ctx, ["b"], { signal: b.signal });
    await tick();
    a.abort(reason);
    await expect(promiseA).rejects.toBe(reason);

    gate.resolve(pipelineOf());
    await expect(promiseB).resolves.toEqual([[0, 1]]);
    expect(createCalls).toBe(1);
  });

  it("A を abort しても、共有の再試行は続き、B は再試行の末に成功する", async () => {
    const sleepGate = deferred<void>();
    let createCalls = 0;
    const provider = new LocalEmbeddingProvider({
      createPipeline: async () => {
        createCalls += 1;
        if (createCalls < 2) throw new Error("transient");
        return pipelineOf();
      },
      dimensions: 2,
      retry: { attempts: 3 },
      sleep: () => sleepGate.promise,
    });
    const a = new AbortController();
    const reason = new Error("a-reason");

    const promiseA = provider.embed(ctx, ["a"], { signal: a.signal });
    const promiseB = provider.embed(ctx, ["b"]);
    await tick();
    a.abort(reason);
    await expect(promiseA).rejects.toBe(reason);

    sleepGate.resolve();
    await expect(promiseB).resolves.toEqual([[0, 1]]);
    expect(createCalls).toBe(2);
  });

  it("全員が abort しても、共有の読み込みは終わりまで走り、次の embed はそれを使う", async () => {
    const gate = deferred<LocalEmbeddingPipeline>();
    let createCalls = 0;
    const provider = new LocalEmbeddingProvider({
      createPipeline: () => {
        createCalls += 1;
        return gate.promise;
      },
      dimensions: 2,
    });
    const a = new AbortController();
    const promiseA = provider.embed(ctx, ["a"], { signal: a.signal });
    await tick();
    a.abort();
    await expect(promiseA).rejects.toBe(a.signal.reason);

    gate.resolve(pipelineOf());
    await expect(provider.embed(ctx, ["c"])).resolves.toEqual([[0, 1]]);
    expect(createCalls).toBe(1);
  });

  it("全員が abort した読み込みが失敗しても unhandled rejection にならない", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (error: unknown) => unhandled.push(error);
    process.on("unhandledRejection", onUnhandled);
    try {
      const gate = deferred<LocalEmbeddingPipeline>();
      const provider = new LocalEmbeddingProvider({
        createPipeline: () => gate.promise,
        dimensions: 2,
        retry: { attempts: 1 },
      });
      const a = new AbortController();
      const promiseA = provider.embed(ctx, ["a"], { signal: a.signal });
      await tick();
      a.abort();
      await expect(promiseA).rejects.toBe(a.signal.reason);
      gate.reject(new Error("load failed"));
      await tick(20);
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });
});
