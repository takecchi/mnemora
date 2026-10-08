import { afterEach, describe, expect, it, vi } from "vitest";
import type { Ctx } from "@mnemora/core";
import {
  DEFAULT_LOCAL_EMBEDDING_DIMENSIONS,
  DEFAULT_LOCAL_EMBEDDING_MODEL_ID,
  DEFAULT_LOCAL_EMBEDDING_RETRY_ATTEMPTS,
  LOCAL_EMBEDDING_PROVIDER_ID,
  LocalEmbeddingProvider,
  defaultLocalEmbeddingRetryDelayMs,
} from "../local-embedding-provider.js";
import type {
  CreateLocalEmbeddingPipeline,
  LocalEmbeddingModelSpec,
  LocalEmbeddingPipeline,
} from "../pipeline.js";
import { LocalEmbeddingProviderError, isLocalEmbeddingProviderError } from "../errors.js";

/** `createPipeline` を注入して、本物のモデルは一切落とさない。擬似にしているのは「モデルを読み込んで推論する」往復だけで、256 次元を返すことや日本語での近さは `live.local-embedding.test.ts`（opt-in）が測る。 */

const ctx: Ctx = { tenantId: "test-tenant" };

/** このファイルは上限の検査を測らない（`input-token-limit.test.ts` の役目）ので、`maxInputTokens` / `countTokens` はダミーの値で埋める。実モデルの上限値を書かないこと。 */
function fakeLocalEmbeddingPipeline(
  embed: (texts: string[]) => Promise<number[][]>,
): LocalEmbeddingPipeline {
  return {
    maxInputTokens: Number.MAX_SAFE_INTEGER,
    countTokens: (texts) => texts.map(() => 0),
    embed,
  };
}

function createRecordingPipeline(
  options: {
    dimensions?: number;
    countDelta?: number;
    gate?: Promise<void>;
  } = {},
) {
  const dimensions = options.dimensions ?? DEFAULT_LOCAL_EMBEDDING_DIMENSIONS;
  const state = {
    createCalls: 0,
    specs: [] as LocalEmbeddingModelSpec[],
    embeddedBatches: [] as string[][],
  };

  const pipeline: LocalEmbeddingPipeline = fakeLocalEmbeddingPipeline(async (texts) => {
    state.embeddedBatches.push([...texts]);
    const count = texts.length + (options.countDelta ?? 0);
    return Array.from({ length: Math.max(count, 0) }, (_, row) =>
      Array.from({ length: dimensions }, (_, column) => (row + column) / 1000),
    );
  });

  const createPipeline: CreateLocalEmbeddingPipeline = async (spec) => {
    state.createCalls += 1;
    state.specs.push(spec);
    if (options.gate) await options.gate;
    return pipeline;
  };

  return {
    createPipeline,
    specs: state.specs,
    embeddedBatches: state.embeddedBatches,
    get calls(): number {
      return state.createCalls;
    },
  };
}

describe("space（コンストラクタで同期に確定する）", () => {
  it("new した直後に既定値で確定している（pipeline の読み込みを待たない）", () => {
    const recorder = createRecordingPipeline();
    const provider = new LocalEmbeddingProvider({ createPipeline: recorder.createPipeline });

    expect(provider.space).toEqual({
      provider: LOCAL_EMBEDDING_PROVIDER_ID,
      model: DEFAULT_LOCAL_EMBEDDING_MODEL_ID,
      dimensions: 256,
    });
    // 既定値そのものを書き下す。定数を参照するだけだと、既定値が変わったことをこの歯が検知できない。
    expect(provider.space.provider).toBe("local");
    expect(provider.space.model).toBe("ruri-v3-30m/sym");
    expect(provider.space.dimensions).toBe(256);
  });

  it("space を読むためにモデルを読み込まない", () => {
    const recorder = createRecordingPipeline();
    const provider = new LocalEmbeddingProvider({ createPipeline: recorder.createPipeline });
    void provider.space.model;
    expect(recorder.calls).toBe(0);
  });

  it("凍結されている（走っている途中で書き換えられない）", () => {
    const recorder = createRecordingPipeline();
    const provider = new LocalEmbeddingProvider({ createPipeline: recorder.createPipeline });

    expect(Object.isFrozen(provider.space)).toBe(true);
    expect(() => {
      (provider.space as { dimensions: number }).dimensions = 999;
    }).toThrow(TypeError);
    expect(provider.space.dimensions).toBe(256);
  });

  it("modelId / dimensions は差し替えられる", () => {
    const recorder = createRecordingPipeline({ dimensions: 8 });
    const provider = new LocalEmbeddingProvider({
      modelId: "ruri-v3-30m/asym",
      dimensions: 8,
      createPipeline: recorder.createPipeline,
    });
    expect(provider.space.model).toBe("ruri-v3-30m/asym");
    expect(provider.space.dimensions).toBe(8);
  });
});

describe("遅延ロード", () => {
  /** Promise を握らない素朴な実装（読み込み済みの pipeline だけを持つ形）では、同時に来た8本の `embed()` が全員モデルを読み込み、557ms / 406MB が 3,138ms / 1,009MB になる。`createPipeline` の呼び出し回数を数えることで、その形へ戻ったら赤くなる。ゲートで読み込みを止めたまま8本を投げる（止めないと、1本目がマイクロタスク1つで解決して競合の窓が開かないことがある）。 */
  it("並行する embed() 8本でも、モデルの読み込みは1回だけ", async () => {
    let openGate = (): void => {};
    const gate = new Promise<void>((resolve) => {
      openGate = resolve;
    });
    const recorder = createRecordingPipeline({ gate });
    const provider = new LocalEmbeddingProvider({ createPipeline: recorder.createPipeline });

    const inFlight = Array.from({ length: 8 }, (_, index) =>
      provider.embed(ctx, [`テキスト ${index}`]),
    );
    openGate();
    const results = await Promise.all(inFlight);

    expect(recorder.calls).toBe(1);
    expect(results).toHaveLength(8);
    for (const vectors of results) {
      expect(vectors).toHaveLength(1);
      expect(vectors[0]).toHaveLength(256);
    }
  });

  it("続けて呼んでも読み込みは増えない", async () => {
    const recorder = createRecordingPipeline();
    const provider = new LocalEmbeddingProvider({ createPipeline: recorder.createPipeline });

    await provider.embed(ctx, ["1本目"]);
    await provider.embed(ctx, ["2本目"]);
    await provider.embed(ctx, ["3本目"]);

    expect(recorder.calls).toBe(1);
  });

  /** 失敗した Promise を握り続けると、一度の一時的な失敗でそのインスタンスが永久に使えなくなる。`retry: { attempts: 1 }` で1回の `#load()` の中のリトライを無効にする。確かめたいのは、使い切って失敗したあとの次の `embed()` が新しい `#load()` をやり直せることで、リトライの回数は下の describe が見る。 */
  it("読み込みに失敗しても、次の呼び出しで再試行できる", async () => {
    let attempts = 0;
    const createPipeline: CreateLocalEmbeddingPipeline = async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("ネットワークが落ちていた");
      return fakeLocalEmbeddingPipeline(async (texts) =>
        texts.map(() => Array.from({ length: 256 }, () => 0.1)),
      );
    };
    const provider = new LocalEmbeddingProvider({ createPipeline, retry: { attempts: 1 } });

    // 失敗は包まれるので、cause 側で確かめる。
    await expect(provider.embed(ctx, ["1回目"])).rejects.toThrow(/モデルを読み込めなかった/);
    const vectors = await provider.embed(ctx, ["2回目"]);

    expect(attempts).toBe(2);
    expect(vectors).toHaveLength(1);
  });

  it("createPipeline が同期に throw しても、reject として返る（例外が素通りしない）", async () => {
    const createPipeline = (() => {
      throw new Error("同期に落ちた");
    }) as unknown as CreateLocalEmbeddingPipeline;
    const provider = new LocalEmbeddingProvider({ createPipeline, retry: { attempts: 1 } });

    const error = await provider.embed(ctx, ["テキスト"]).then(
      () => undefined,
      (reason: unknown) => reason,
    );
    expect((error as Error | undefined)?.cause).toBeInstanceOf(Error);
    expect(((error as Error).cause as Error).message).toBe("同期に落ちた");
  });

  // `retry: { attempts: 1 }` にする。確かめたいのは `#ready` の並行時の畳み方で、リトライではない。
  it("同時に来た8本が全部失敗しても、読み込みは1回だけで、その後再試行できる", async () => {
    let attempts = 0;
    const createPipeline: CreateLocalEmbeddingPipeline = async (_spec) => {
      attempts += 1;
      await Promise.resolve();
      if (attempts === 1) throw new Error("落ちた");
      return fakeLocalEmbeddingPipeline(async (texts) =>
        texts.map(() => Array.from({ length: 256 }, () => 0.1)),
      );
    };
    const provider = new LocalEmbeddingProvider({ createPipeline, retry: { attempts: 1 } });

    const results = await Promise.allSettled(
      Array.from({ length: 8 }, () => provider.embed(ctx, ["テキスト"])),
    );
    expect(results.every((r) => r.status === "rejected")).toBe(true);
    expect(attempts).toBe(1);

    await expect(provider.embed(ctx, ["テキスト"])).resolves.toHaveLength(1);
    expect(attempts).toBe(2);
  });
});

describe("読み込みの再試行 (Issue #261 / ADR 0141)", () => {
  /** `sleep` を注入して実時間を消費しない（待つこと自体は `defaultLocalEmbeddingRetryDelayMs` の歯が見る）。 */
  it("種類の分かっていない失敗は、既定の設定でも同じ embed() 呼び出しの中で吸収される", async () => {
    let calls = 0;
    const createPipeline: CreateLocalEmbeddingPipeline = async () => {
      calls += 1;
      if (calls < 2) throw new Error("cause: fetch failed");
      return fakeLocalEmbeddingPipeline(async (texts) =>
        texts.map(() => Array.from({ length: 256 }, () => 0.1)),
      );
    };
    // retry オプションは既定値のまま。「CI が何も指定しなくても直る」ことを確かめるため。
    const provider = new LocalEmbeddingProvider({ createPipeline, sleep: async () => {} });

    const vectors = await provider.embed(ctx, ["1回だけ失敗しても通る"]);

    expect(vectors).toHaveLength(1);
    expect(calls).toBe(2);
  });

  it("既定の試行回数（3回）を使い切ると、それ以上は増やさずに失敗として返す", async () => {
    let calls = 0;
    const createPipeline: CreateLocalEmbeddingPipeline = async () => {
      calls += 1;
      throw new Error("cause: fetch failed（毎回）");
    };
    const provider = new LocalEmbeddingProvider({ createPipeline, sleep: async () => {} });

    await expect(provider.embed(ctx, ["テキスト"])).rejects.toThrow(/モデルを読み込めなかった/);
    expect(calls).toBe(DEFAULT_LOCAL_EMBEDDING_RETRY_ATTEMPTS);
  });

  it("試行回数は options.retry.attempts で変えられる", async () => {
    let calls = 0;
    const createPipeline: CreateLocalEmbeddingPipeline = async () => {
      calls += 1;
      throw new Error("落ちる");
    };
    const provider = new LocalEmbeddingProvider({
      createPipeline,
      sleep: async () => {},
      retry: { attempts: 5 },
    });

    await expect(provider.embed(ctx, ["テキスト"])).rejects.toThrow(/モデルを読み込めなかった/);
    expect(calls).toBe(5);
  });

  /** `retry: { attempts: NaN }` だと `Math.max(1, NaN)` が `NaN` のままになり、`#startLoad` のループが一度も回らず、`createPipeline` を呼ばずに「モデルを読み込めなかった」が投げられる（「一度も試さない、は許さない」への違反）。 */
  it("試行回数に NaN を渡しても、createPipeline は少なくとも1回は呼ばれる", async () => {
    const recorder = createRecordingPipeline();
    const provider = new LocalEmbeddingProvider({
      createPipeline: recorder.createPipeline,
      sleep: async () => {},
      retry: { attempts: NaN },
    });

    const vectors = await provider.embed(ctx, ["テキスト"]);

    expect(vectors).toHaveLength(1);
    expect(recorder.calls).toBeGreaterThanOrEqual(1);
  });

  it("失敗のたびに、指定した delayMs(attempt) の分だけ sleep する", async () => {
    const waited: number[] = [];
    const createPipeline: CreateLocalEmbeddingPipeline = async () => {
      throw new Error("落ちる");
    };
    const provider = new LocalEmbeddingProvider({
      createPipeline,
      retry: { attempts: 3, delayMs: (attempt) => attempt * 100 },
      sleep: async (ms) => {
        waited.push(ms);
      },
    });

    await expect(provider.embed(ctx, ["テキスト"])).rejects.toThrow(/モデルを読み込めなかった/);
    expect(waited).toEqual([100, 200]);
  });

  it("attempts が整数でなくても、最後の試行の後には待たない（試行の回数と投げる例外は変わらない）", async () => {
    const waited: number[] = [];
    let calls = 0;
    const createPipeline: CreateLocalEmbeddingPipeline = async () => {
      calls += 1;
      throw new Error(`失敗 ${calls} 回目`);
    };
    const provider = new LocalEmbeddingProvider({
      createPipeline,
      retry: { attempts: 2.5, delayMs: (attempt) => attempt * 100 },
      sleep: async (ms) => {
        waited.push(ms);
      },
    });

    const error = await provider.embed(ctx, ["テキスト"]).then(
      () => expect.fail("例外が投げられなかった"),
      (reason: unknown) => reason as Error,
    );
    // 2.5 のとき試すのは2回（待つのはその間の1回だけ）。
    expect(calls).toBe(2);
    expect(waited).toEqual([100]);
    expect(error.message).toMatch(/^LocalEmbeddingProvider: モデルを読み込めなかった/);
    expect(error.message).toContain("2 回試したが取得できなかった");
    expect((error.cause as Error).message).toBe("失敗 2 回目");
  });

  it("最後まで失敗したときの cause は、最後の試行のエラーである", async () => {
    let calls = 0;
    const createPipeline: CreateLocalEmbeddingPipeline = async () => {
      calls += 1;
      throw new Error(`失敗 ${calls} 回目`);
    };
    const provider = new LocalEmbeddingProvider({ createPipeline, sleep: async () => {} });

    const error = await provider.embed(ctx, ["テキスト"]).then(
      () => null,
      (reason: unknown) => reason,
    );
    expect((error as Error).cause).toBeInstanceOf(Error);
    expect(((error as Error).cause as Error).message).toBe(
      `失敗 ${DEFAULT_LOCAL_EMBEDDING_RETRY_ATTEMPTS} 回目`,
    );
  });

  it("メッセージに試行回数が入る（1回試すだけの設定では入らない）", async () => {
    const createPipeline: CreateLocalEmbeddingPipeline = async () => {
      throw new Error("落ちる");
    };

    const retried = await new LocalEmbeddingProvider({
      createPipeline,
      sleep: async () => {},
      retry: { attempts: 3 },
    })
      .embed(ctx, ["テキスト"])
      .then(
        () => null,
        (reason: unknown) => reason,
      );
    expect((retried as Error).message).toContain("3 回試したが取得できなかった");

    const single = await new LocalEmbeddingProvider({
      createPipeline,
      retry: { attempts: 1 },
    })
      .embed(ctx, ["テキスト"])
      .then(
        () => null,
        (reason: unknown) => reason,
      );
    expect((single as Error).message).not.toContain("回試したが取得できなかった");
  });

  it("メッセージの試行回数は、実際に試した整数の回数である（attempts が整数でなくても設定値をそのまま書かない）", async () => {
    let calls = 0;
    const createPipeline: CreateLocalEmbeddingPipeline = async () => {
      calls += 1;
      throw new Error("落ちる");
    };
    const error = await new LocalEmbeddingProvider({
      createPipeline,
      sleep: async () => {},
      retry: { attempts: 2.5 },
    })
      .embed(ctx, ["テキスト"])
      .then(
        () => null,
        (reason: unknown) => reason,
      );
    expect(calls).toBe(2);
    expect((error as Error).message).toContain("2 回試したが取得できなかった");
    expect((error as Error).message).not.toContain("2.5 回");
  });

  /** `kind` の付いた失敗は入力・設定の問題で、再試行しても結果は変わらず、待ち時間を足すだけなのでリトライしない。 */
  it("kind の付いたエラー（unknown_input_limit 等）はリトライせず、1回で即座に投げ直す", async () => {
    let calls = 0;
    const createPipeline: CreateLocalEmbeddingPipeline = async () => {
      calls += 1;
      throw new LocalEmbeddingProviderError("unknown_input_limit", "モデルが上限を宣言していない");
    };
    const provider = new LocalEmbeddingProvider({ createPipeline, sleep: async () => {} });

    const error = await provider.embed(ctx, ["テキスト"]).then(
      () => null,
      (reason: unknown) => reason,
    );
    expect(calls).toBe(1);
    expect(isLocalEmbeddingProviderError(error)).toBe(true);
    expect((error as LocalEmbeddingProviderError).kind).toBe("unknown_input_limit");
    expect((error as Error).message).not.toMatch(/モデルを読み込めなかった/);
  });
});

describe("defaultLocalEmbeddingRetryDelayMs（既定のバックオフ）", () => {
  it("attempt が増えるほど、上限が指数的に伸びる（full jitter なので毎回 [0, 上限) を確かめる）", () => {
    for (let trial = 0; trial < 50; trial += 1) {
      expect(defaultLocalEmbeddingRetryDelayMs(1)).toBeGreaterThanOrEqual(0);
      expect(defaultLocalEmbeddingRetryDelayMs(1)).toBeLessThan(200);
      expect(defaultLocalEmbeddingRetryDelayMs(2)).toBeLessThan(400);
      expect(defaultLocalEmbeddingRetryDelayMs(3)).toBeLessThan(800);
    }
  });

  it("上限は 4000ms で頭打ちになる（試行回数が増えても待たせすぎない）", () => {
    for (let trial = 0; trial < 20; trial += 1) {
      expect(defaultLocalEmbeddingRetryDelayMs(10)).toBeLessThan(4_000);
      expect(defaultLocalEmbeddingRetryDelayMs(20)).toBeLessThan(4_000);
    }
  });

  /** 本物の乱数では、上限の手前まで届いたか（頭打ちが 4000ms より低くないか）も、jitter を掛けているかも見分けられない。`Math.random` を [0, 1) の両端に固定して見る（ADR 0141: 200ms 起点・4000ms で頭打ち・full jitter）。 */
  describe("Math.random を両端に固定したとき", () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it("乱数が 0 なら、どの attempt でも 0ms（full jitter は下端が 0）", () => {
      vi.spyOn(Math, "random").mockReturnValue(0);

      for (const attempt of [1, 2, 5, 6, 20]) {
        expect(defaultLocalEmbeddingRetryDelayMs(attempt)).toBe(0);
      }
    });

    it.each([
      [1, 200],
      [2, 400],
      [3, 800],
      [4, 1_600],
      [5, 3_200],
      [6, 4_000],
      [7, 4_000],
      [20, 4_000],
    ])(
      "乱数が 1 の手前なら、attempt %i の待ちは上限 %ims のすぐ手前（200ms 起点で倍々、4000ms で頭打ち）",
      (attempt, upper) => {
        vi.spyOn(Math, "random").mockReturnValue(1 - 2 ** -53);

        const delay = defaultLocalEmbeddingRetryDelayMs(attempt);

        expect(delay).toBeLessThan(upper);
        expect(delay).toBeCloseTo(upper, 6);
      },
    );
  });
});

describe("読み込み失敗のメッセージ", () => {
  /** 既定の repo は個人の変換 repo で消えうる。それを承知で選べているのは、元モデルが公式（`cl-nagoya/ruri-v3-30m`, apache-2.0）で変換をやり直せるからで、その情報は repo が消えて落ちた人が最初に見る例外のメッセージに載せる。文面は全文一致で固定しない（文言のほうを直せなくなる）。見るのは「必要なものが入っているか」だけ。 */
  const failing: CreateLocalEmbeddingPipeline = async () => {
    throw new Error("HTTP 404: model not found");
  };

  async function loadFailure(
    options: ConstructorParameters<typeof LocalEmbeddingProvider>[0],
  ): Promise<Error> {
    const provider = new LocalEmbeddingProvider(options);
    const reason = await provider.embed(ctx, ["テキスト"]).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(reason, "読み込みが失敗したのに reject しなかった").toBeInstanceOf(Error);
    return reason as Error;
  }

  it("実際に使った repo 名が入る（既定値ではなく）", async () => {
    // modelId も明示する。既定と異なる repo だけを渡すと、コンストラクタの repo/modelId 宣言食い違い検査が先に throw する（`repo-model-id-declaration-guard.test.ts` が別に測る）。
    const error = await loadFailure({
      repo: "someone/my-own-conversion",
      modelId: "someone-custom-model",
      createPipeline: failing,
    });
    expect(error.message).toContain("someone/my-own-conversion");
    expect(error.message).not.toContain("sirasagi62/ruri-v3-30m-ONNX");
  });

  it("既定で使ったときは既定の repo 名が入る", async () => {
    const error = await loadFailure({ createPipeline: failing });
    expect(error.message).toContain("sirasagi62/ruri-v3-30m-ONNX");
  });

  it("実際に使った dtype と cacheDir が入る", async () => {
    const error = await loadFailure({
      dtype: "fp32",
      cacheDir: "/tmp/mnemora-models",
      createPipeline: failing,
    });
    expect(error.message).toContain("fp32");
    expect(error.message).toContain("/tmp/mnemora-models");
  });

  it("元の例外を cause に保持している（404 とネットワーク断と dtype 誤りを潰さない）", async () => {
    const original = new Error("HTTP 404: model not found");
    const error = await loadFailure({
      createPipeline: async () => {
        throw original;
      },
    });
    expect(error.cause).toBe(original);
  });

  it("やり直せること（元モデル・変換・repo オプション）が書いてある", async () => {
    const error = await loadFailure({ createPipeline: failing });
    expect(error.message).toContain("cl-nagoya/ruri-v3-30m");
    expect(error.message).toContain("repo");
    expect(error.message).toContain("README");
  });

  /** キャッシュのファイルが壊れていると、再試行を使い切っても次のプロセスでも同じように落ち続ける（cause は `Protobuf parsing failed`・`Unexpected end of JSON input` など）。メッセージはネットワーク断・repo の消滅・dtype 名の誤りだけでなく、キャッシュの破損と、消せば取り直せる場所に届かなければならない。 */
  it("キャッシュのファイルの破損を原因の候補に挙げ、消す場所（cacheDir の下の repo）を名指す", async () => {
    const error = await loadFailure({ cacheDir: "/tmp/mnemora-models", createPipeline: failing });
    expect(error.message).toContain("壊れ");
    expect(error.message).toContain("/tmp/mnemora-models/sirasagi62/ruri-v3-30m-ONNX");
  });

  // 注入した `createPipeline` の置き場所はこのクラスには分からないので、特定の場所を断言しないことを縛る。既定の `createPipeline` のときに実際の場所を名指すことは `load-failure-cache-place.test.ts` が縛る。
  it("cacheDir が未指定で、createPipeline を注入したなら、特定の場所を断言せず env.cacheDir を指す", async () => {
    const error = await loadFailure({ createPipeline: failing });
    expect(error.message).toContain("壊れ");
    expect(error.message).not.toContain("node_modules/@huggingface/transformers/.cache/");
    expect(error.message).toContain("env.cacheDir");
    expect(error.message).toContain("sirasagi62/ruri-v3-30m-ONNX");
  });

  // `retry: { attempts: 1 }`。確かめたいのは「包むことと握り続けることは別」（#ready を早期に手放すこと）で、リトライではない。
  it("包んでも、次の呼び出しで再試行できる（包むことと握り続けることは別）", async () => {
    let attempts = 0;
    const createPipeline: CreateLocalEmbeddingPipeline = async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("HTTP 404: model not found");
      return fakeLocalEmbeddingPipeline(async (texts) =>
        texts.map(() => Array.from({ length: 256 }, () => 0.1)),
      );
    };
    const provider = new LocalEmbeddingProvider({ createPipeline, retry: { attempts: 1 } });

    await expect(provider.embed(ctx, ["1回目"])).rejects.toThrow(/モデルを読み込めなかった/);
    await expect(provider.embed(ctx, ["2回目"])).resolves.toHaveLength(1);
    expect(attempts).toBe(2);
  });
});

describe("warmup()", () => {
  it("読み込みを起こし、その後の embed() は読み込み直さない", async () => {
    const recorder = createRecordingPipeline();
    const provider = new LocalEmbeddingProvider({ createPipeline: recorder.createPipeline });

    expect(recorder.calls).toBe(0);
    await provider.warmup();
    expect(recorder.calls).toBe(1);

    await provider.embed(ctx, ["ウォームアップ後の1本目"]);
    expect(recorder.calls).toBe(1);
  });

  it("推論は走らせない（モデルへ勝手な入力を流さない）", async () => {
    const recorder = createRecordingPipeline();
    const provider = new LocalEmbeddingProvider({ createPipeline: recorder.createPipeline });

    await provider.warmup();
    expect(recorder.embeddedBatches).toEqual([]);
  });

  it("2回呼んでも読み込みは1回", async () => {
    const recorder = createRecordingPipeline();
    const provider = new LocalEmbeddingProvider({ createPipeline: recorder.createPipeline });

    await Promise.all([provider.warmup(), provider.warmup()]);
    await provider.warmup();

    expect(recorder.calls).toBe(1);
  });
});

describe("embed(ctx, [])", () => {
  it("[] を返し、モデルを一度も読み込まない", async () => {
    const recorder = createRecordingPipeline();
    const provider = new LocalEmbeddingProvider({ createPipeline: recorder.createPipeline });

    await expect(provider.embed(ctx, [])).resolves.toEqual([]);
    // 空配列ではウォームアップできない。`warmup()` が要る理由がこれ。
    expect(recorder.calls).toBe(0);
  });
});

describe("次元の検査", () => {
  /** 宣言と中身が食い違ったまま DB へ入ると、`EmbeddingSpaceId` はテーブル名スラグの導出元なので、後から分けられない。 */
  it("宣言した次元と実物が食い違うと、初回 embed() で例外になる", async () => {
    const recorder = createRecordingPipeline({ dimensions: 384 });
    const provider = new LocalEmbeddingProvider({
      dimensions: 256,
      createPipeline: recorder.createPipeline,
    });

    await expect(provider.embed(ctx, ["テキスト"])).rejects.toThrow(/LocalEmbeddingProvider/);
  });

  it("例外のメッセージに、宣言値と実測値の両方が入る", async () => {
    const recorder = createRecordingPipeline({ dimensions: 384 });
    const provider = new LocalEmbeddingProvider({
      dimensions: 256,
      createPipeline: recorder.createPipeline,
    });

    await expect(provider.embed(ctx, ["テキスト"])).rejects.toThrow(/256/);
    await expect(provider.embed(ctx, ["テキスト"])).rejects.toThrow(/384/);
  });

  it("次元が合っていれば通る", async () => {
    const recorder = createRecordingPipeline({ dimensions: 256 });
    const provider = new LocalEmbeddingProvider({ createPipeline: recorder.createPipeline });

    const vectors = await provider.embed(ctx, ["あ", "い"]);
    expect(vectors.map((v) => v.length)).toEqual([256, 256]);
  });

  it.each([255, 257])("宣言（256）と1次元だけ違う（%i 次元）ときも例外になる", async (actual) => {
    const recorder = createRecordingPipeline({ dimensions: actual });
    const provider = new LocalEmbeddingProvider({
      dimensions: 256,
      createPipeline: recorder.createPipeline,
    });

    await expect(provider.embed(ctx, ["テキスト"])).rejects.toThrow(
      new RegExp(`256.*${actual} 次元`, "s"),
    );
  });

  it("2本目以降のベクトルだけ次元が違っても例外になり、何番目かを名指しする", async () => {
    const provider = new LocalEmbeddingProvider({
      dimensions: 2,
      createPipeline: async () =>
        fakeLocalEmbeddingPipeline(async () => [
          [0.1, 0.2],
          [0.1, 0.2],
          [0.1, 0.2, 0.3],
        ]),
    });

    await expect(provider.embed(ctx, ["あ", "い", "う"])).rejects.toThrow(/3 次元だった（2 番目）/);
  });

  it("例外の型は素の Error で、kind を持たない", async () => {
    const recorder = createRecordingPipeline({ dimensions: 384 });
    const provider = new LocalEmbeddingProvider({
      dimensions: 256,
      createPipeline: recorder.createPipeline,
    });

    const error = await provider.embed(ctx, ["テキスト"]).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(Error);
    expect(isLocalEmbeddingProviderError(error)).toBe(false);
  });

  it("件数が maxBatchSize を超えて分割されても、次元の食い違いは例外になる", async () => {
    const recorder = createRecordingPipeline({ dimensions: 384 });
    const provider = new LocalEmbeddingProvider({
      dimensions: 256,
      maxBatchSize: 2,
      createPipeline: recorder.createPipeline,
    });

    await expect(provider.embed(ctx, ["あ", "い", "う"])).rejects.toThrow(/256.*384 次元/s);
    expect(recorder.embeddedBatches).toHaveLength(2);
  });
});

describe("成分の検査（Issue #992）", () => {
  /** NaN / Infinity は provider を素通りすると、pgvector への書き込み（`NaN not allowed in vector`）で初めて失敗し、原因から離れた SQL の失敗として現れる。次元の検査と同じ位置で、注入された pipeline の出力を信じずに確かめる。 */
  function providerReturning(vector: number[]) {
    return new LocalEmbeddingProvider({
      dimensions: vector.length,
      createPipeline: async () =>
        fakeLocalEmbeddingPipeline(async (texts) => texts.map(() => [...vector])),
    });
  }

  it("NaN を含むベクトルは例外になる", async () => {
    await expect(providerReturning([Number.NaN, 1]).embed(ctx, ["テキスト"])).rejects.toThrow(
      /LocalEmbeddingProvider/,
    );
  });

  it("Infinity / -Infinity を含むベクトルも例外になる", async () => {
    await expect(
      providerReturning([1, Number.POSITIVE_INFINITY]).embed(ctx, ["テキスト"]),
    ).rejects.toThrow(/LocalEmbeddingProvider/);
    await expect(
      providerReturning([Number.NEGATIVE_INFINITY, 1]).embed(ctx, ["テキスト"]),
    ).rejects.toThrow(/LocalEmbeddingProvider/);
  });

  it("例外のメッセージは何番目のベクトルの何番目の成分かを名指しする", async () => {
    const provider = new LocalEmbeddingProvider({
      dimensions: 2,
      createPipeline: async () =>
        fakeLocalEmbeddingPipeline(async () => [
          [0.5, 0.5],
          [0.5, Number.NaN],
        ]),
    });

    await expect(provider.embed(ctx, ["あ", "い"])).rejects.toThrow(/1 番目.*1 番目の成分.*NaN/s);
  });

  it("例外の型は次元の検査と同じ素の Error で、kind を持たない", async () => {
    const error = await providerReturning([Number.NaN, 1])
      .embed(ctx, ["テキスト"])
      .catch((err: unknown) => err);

    expect(error).toBeInstanceOf(Error);
    expect(isLocalEmbeddingProviderError(error)).toBe(false);
  });
});

describe("件数の検査", () => {
  it("返ったベクトルの件数が入力件数と違えば例外になる", async () => {
    const recorder = createRecordingPipeline({ countDelta: -1 });
    const provider = new LocalEmbeddingProvider({ createPipeline: recorder.createPipeline });

    // 黙って返すと、呼び出し側で memory とベクトルが1つずれて対応する。
    await expect(provider.embed(ctx, ["あ", "い", "う"])).rejects.toThrow(/3 件.*2 件/s);
  });

  it("多すぎても例外になる", async () => {
    const recorder = createRecordingPipeline({ countDelta: 1 });
    const provider = new LocalEmbeddingProvider({ createPipeline: recorder.createPipeline });

    await expect(provider.embed(ctx, ["あ"])).rejects.toThrow(/1 件.*2 件/s);
  });

  it("例外の型は素の Error で、kind を持たない", async () => {
    const recorder = createRecordingPipeline({ countDelta: -1 });
    const provider = new LocalEmbeddingProvider({ createPipeline: recorder.createPipeline });

    const error = await provider.embed(ctx, ["あ", "い"]).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(Error);
    expect(isLocalEmbeddingProviderError(error)).toBe(false);
  });

  it("件数が maxBatchSize を超えて分割されても、連結した件数の食い違いは例外になる", async () => {
    // 各チャンクで1件ずつ欠けるので、3件（[あ,い] [う]）に対して1件しか返らない。
    const recorder = createRecordingPipeline({ countDelta: -1 });
    const provider = new LocalEmbeddingProvider({
      maxBatchSize: 2,
      createPipeline: recorder.createPipeline,
    });

    await expect(provider.embed(ctx, ["あ", "い", "う"])).rejects.toThrow(/3 件.*1 件/s);
    expect(recorder.embeddedBatches).toHaveLength(2);
  });
});

describe("prefix", () => {
  it("既定（空文字）では、テキストに何も足さない", async () => {
    const recorder = createRecordingPipeline();
    const provider = new LocalEmbeddingProvider({ createPipeline: recorder.createPipeline });

    await provider.embed(ctx, ["紅茶が好き", "コーヒーが好き"]);

    expect(recorder.embeddedBatches).toEqual([["紅茶が好き", "コーヒーが好き"]]);
  });

  it("明示すると、全件に同じものが付く（クエリと文書を区別しない）", async () => {
    const recorder = createRecordingPipeline();
    const provider = new LocalEmbeddingProvider({
      prefix: "検索文書: ",
      createPipeline: recorder.createPipeline,
    });

    await provider.embed(ctx, ["紅茶が好き", "コーヒーが好き"]);

    // 「全件に同じもの」が仕様。embed() は渡されたテキストがクエリなのか文書なのかを知らないので、区別できるふりをしない。
    expect(recorder.embeddedBatches).toEqual([
      ["検索文書: 紅茶が好き", "検索文書: コーヒーが好き"],
    ]);
  });

  /** 呼び出し側が渡した配列を下流へ素通ししない。`prefix` が空のときだけ `texts` をそのまま `createPipeline` の先へ渡していた実績がある（書き換える pipeline を注入すると、既定の設定でだけ呼び出し側の配列が壊れた）。2つの設定の両方で測る。片方だけだと、また分岐が生えたときに気づけない。 */
  it.each([
    ["既定（prefix が空）", undefined],
    ["prefix を設定したとき", "検索文書: "],
  ])("%s、下流が書き換えても呼び出し側の配列は壊れない", async (_label, prefix) => {
    const createPipeline = async (): Promise<LocalEmbeddingPipeline> =>
      fakeLocalEmbeddingPipeline(async (texts) => {
        texts[0] = "下流が書き換えた";
        return texts.map(() => [0, 0]);
      });
    const provider = new LocalEmbeddingProvider({ dimensions: 2, prefix, createPipeline });

    const mine = ["紅茶が好き", "コーヒーが好き"];
    await provider.embed(ctx, mine);

    expect(mine).toEqual(["紅茶が好き", "コーヒーが好き"]);
  });

  it("prefix を付けても、返るベクトルの件数は入力どおり", async () => {
    const recorder = createRecordingPipeline();
    const provider = new LocalEmbeddingProvider({
      prefix: "検索文書: ",
      createPipeline: recorder.createPipeline,
    });

    await expect(provider.embed(ctx, ["あ", "い", "う"])).resolves.toHaveLength(3);
  });
});

describe("モデル指定が createPipeline へ届く（配線）", () => {
  it("既定値がそのまま渡る", async () => {
    const recorder = createRecordingPipeline();
    const provider = new LocalEmbeddingProvider({ createPipeline: recorder.createPipeline });

    await provider.warmup();

    expect(recorder.specs[0]).toEqual({
      repo: "sirasagi62/ruri-v3-30m-ONNX",
      dtype: "q8",
      cacheDir: undefined,
      numThreads: 4,
    });
  });

  it("差し替えた値がそのまま渡る", async () => {
    const recorder = createRecordingPipeline();
    // modelId も明示する。既定と異なる repo だけを渡すと、コンストラクタの repo/modelId 宣言食い違い検査が先に throw する（`repo-model-id-declaration-guard.test.ts` が別に測る）。
    const provider = new LocalEmbeddingProvider({
      repo: "someone/other-onnx",
      modelId: "someone-custom-model",
      dtype: "fp32",
      cacheDir: "/tmp/mnemora-models",
      numThreads: 1,
      createPipeline: recorder.createPipeline,
    });

    await provider.warmup();

    expect(recorder.specs[0]).toEqual({
      repo: "someone/other-onnx",
      dtype: "fp32",
      cacheDir: "/tmp/mnemora-models",
      numThreads: 1,
    });
  });
});
