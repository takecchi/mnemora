import { beforeEach, describe, expect, it, vi } from "vitest";
import { createLocalEmbeddingPipeline, type LocalEmbeddingModelSpec } from "../pipeline.js";

/**
 * Issue #1239 の直し方（`pipeline.ts` の `env.cacheDir` の差し替え + 直列化）そのものを縛る歯。
 *
 * `cache-dir-preflight-default-cache.test.ts` は「結果としてネットワークへ出ないこと」を
 * 本物の transformers.js で縛っている。ここはその**仕組み**——`env.cacheDir` を差し替えて
 * 戻す・複数の読み込みを直列化する——を、`@huggingface/transformers` を丸ごと `vi.mock` で
 * 差し替えて、実際にモデルを読み込まずに縛る。
 *
 * `env` は素のオブジェクトを1つだけ用意し、`createLocalEmbeddingPipeline` がそれを
 * どう書き換えるかを直接観測する。`pipeline` はテストごとに手で resolve/reject できる
 * 「保留中の Promise」を返すので、2本の呼び出しが実際に重ならないこと（直列化）を、
 * 実時間のタイマーに頼らずマイクロタスクの粒度で確かめられる。
 */

const pipelineMock = vi.hoisted(() => vi.fn());
const envMock = vi.hoisted(() => ({ cacheDir: "/original/cache" }) as { cacheDir: unknown });

vi.mock("@huggingface/transformers", () => ({ pipeline: pipelineMock, env: envMock }));

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function defer<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/**
 * 保留中のマイクロタスクを掃く。`await` の連鎖を手繰るためだけの道具。
 *
 * ⚠ **マイクロタスクの回数を数えるのではなく、マクロタスク（`setImmediate`）まで進める。**
 * `import("@huggingface/transformers")`（`vi.mock` 差し替え）は、vitest のモジュールローダを
 * 経由するぶん、素の `Promise.resolve()` の連鎖よりマイクロタスクの段数が深い（版が変われば
 * 段数も変わりうる）。段数を決め打たず、`setImmediate` で「今たまっているマイクロタスクを
 * 全部片付けてから戻る」形にすることで、内部の実装詳細に依存しない歯にする。
 */
async function flushMicrotasks(times = 2): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

function fakeExtractor(modelMaxLength: number) {
  return Object.assign(async () => ({ tolist: () => [] }), {
    tokenizer: { model_max_length: modelMaxLength },
  });
}

function baseSpec(overrides: Partial<LocalEmbeddingModelSpec> = {}): LocalEmbeddingModelSpec {
  return {
    repo: "example/some-model",
    dtype: "q8",
    cacheDir: undefined,
    numThreads: 1,
    ...overrides,
  };
}

describe("createLocalEmbeddingPipeline: env.cacheDir の差し替えと直列化（Issue #1239）", () => {
  beforeEach(() => {
    pipelineMock.mockReset();
    envMock.cacheDir = "/original/cache";
  });

  it("(a) 成功した後、env.cacheDir は元の値に戻る", async () => {
    pipelineMock.mockImplementation(async () => fakeExtractor(512));
    await createLocalEmbeddingPipeline(baseSpec({ cacheDir: "/warm/cache" }));
    expect(envMock.cacheDir).toBe("/original/cache");
  });

  it("(a) 失敗した後も、env.cacheDir は元の値に戻る", async () => {
    pipelineMock.mockImplementation(async () => {
      throw new Error("boom");
    });
    await expect(createLocalEmbeddingPipeline(baseSpec({ cacheDir: "/warm/cache" }))).rejects.toThrow(
      "boom",
    );
    expect(envMock.cacheDir).toBe("/original/cache");
  });

  it("(b) cacheDir が違う2つの読み込みを並行させても、それぞれの pipeline() 呼び出しは自分の cacheDir しか見ない（重ならない）", async () => {
    const deferredA = defer<ReturnType<typeof fakeExtractor>>();
    const deferredB = defer<ReturnType<typeof fakeExtractor>>();
    const observedCacheDirAtCall: unknown[] = [];
    let calls = 0;
    pipelineMock.mockImplementation(async () => {
      calls += 1;
      observedCacheDirAtCall.push(envMock.cacheDir);
      return calls === 1 ? deferredA.promise : deferredB.promise;
    });

    const resultA = createLocalEmbeddingPipeline(baseSpec({ cacheDir: "/cache/A" }));
    const resultB = createLocalEmbeddingPipeline(baseSpec({ cacheDir: "/cache/B" }));

    // A が先に待ち行列へ入り、pipeline() を1回だけ呼んだ時点で止まっている
    // （B はまだ pipeline() に届いていない——直列化されている証拠）。
    await flushMicrotasks();
    expect(pipelineMock).toHaveBeenCalledTimes(1);
    expect(observedCacheDirAtCall).toEqual(["/cache/A"]);
    // A の pipeline() 呼び出しの最中は、env.cacheDir が A の値に差し替わったままである。
    expect(envMock.cacheDir).toBe("/cache/A");

    deferredA.resolve(fakeExtractor(111));
    await flushMicrotasks();

    // A が終わると env.cacheDir は元に戻り、その直後に B が始まる——
    // B が観測する env.cacheDir は B 自身の値であり、A の値ではない（漏れていない）。
    expect(pipelineMock).toHaveBeenCalledTimes(2);
    expect(observedCacheDirAtCall).toEqual(["/cache/A", "/cache/B"]);
    expect(envMock.cacheDir).toBe("/cache/B");

    deferredB.resolve(fakeExtractor(222));

    const pipelineA = await resultA;
    const pipelineB = await resultB;
    expect(pipelineA.maxInputTokens).toBe(111);
    expect(pipelineB.maxInputTokens).toBe(222);
    expect(envMock.cacheDir).toBe("/original/cache");
  });

  it("(c) cacheDir を渡さない読み込みを、cacheDir 付きの読み込みと並行させても、元の値しか見ない", async () => {
    const deferredWithCacheDir = defer<ReturnType<typeof fakeExtractor>>();
    const deferredWithoutCacheDir = defer<ReturnType<typeof fakeExtractor>>();
    const observedCacheDirAtCall: unknown[] = [];
    let calls = 0;
    pipelineMock.mockImplementation(async () => {
      calls += 1;
      observedCacheDirAtCall.push(envMock.cacheDir);
      return calls === 1 ? deferredWithCacheDir.promise : deferredWithoutCacheDir.promise;
    });

    const withCacheDir = createLocalEmbeddingPipeline(baseSpec({ cacheDir: "/cache/A" }));
    const withoutCacheDir = createLocalEmbeddingPipeline(baseSpec({ cacheDir: undefined }));

    await flushMicrotasks();
    expect(pipelineMock).toHaveBeenCalledTimes(1);
    deferredWithCacheDir.resolve(fakeExtractor(1));
    await flushMicrotasks();

    // cacheDir を渡さなかった呼び出しは、待ち行列で自分の番が来ても、
    // 他方が差し替えた "/cache/A" ではなく、常にアンビエントな既定値を見る。
    expect(pipelineMock).toHaveBeenCalledTimes(2);
    expect(observedCacheDirAtCall).toEqual(["/cache/A", "/original/cache"]);
    // cacheDir を渡さない呼び出しは env.cacheDir に触らない——待っている間もそのままである。
    expect(envMock.cacheDir).toBe("/original/cache");

    deferredWithoutCacheDir.resolve(fakeExtractor(2));
    await withCacheDir;
    await withoutCacheDir;
  });

  it("(d) 前の読み込みが失敗しても、次の読み込みは待ち行列で進む", async () => {
    const deferredFirst = defer<ReturnType<typeof fakeExtractor>>();
    const deferredSecond = defer<ReturnType<typeof fakeExtractor>>();
    let calls = 0;
    pipelineMock.mockImplementation(async () => {
      calls += 1;
      return calls === 1 ? deferredFirst.promise : deferredSecond.promise;
    });

    const first = createLocalEmbeddingPipeline(baseSpec({ cacheDir: "/cache/fails" }));
    const second = createLocalEmbeddingPipeline(baseSpec({ cacheDir: "/cache/succeeds" }));

    await flushMicrotasks();
    expect(pipelineMock).toHaveBeenCalledTimes(1);

    deferredFirst.reject(new Error("network down"));
    await expect(first).rejects.toThrow("network down");
    await flushMicrotasks();

    // 1本目が失敗しても、待ち行列は詰まらず2本目が進む。
    expect(pipelineMock).toHaveBeenCalledTimes(2);
    deferredSecond.resolve(fakeExtractor(256));
    const secondPipeline = await second;
    expect(secondPipeline.maxInputTokens).toBe(256);
    expect(envMock.cacheDir).toBe("/original/cache");
  });
});
