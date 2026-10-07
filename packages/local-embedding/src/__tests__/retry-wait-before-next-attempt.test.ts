import { describe, expect, it } from "vitest";
import type { Ctx } from "@mnemora/core";
import { LocalEmbeddingProvider } from "../local-embedding-provider.js";
import type { CreateLocalEmbeddingPipeline } from "../pipeline.js";
import { LocalEmbeddingProviderError } from "../errors.js";

const ctx: Ctx = { tenantId: "test-tenant" };

const settleMicrotasksAndTimers = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe("読み込みの再試行の待ち", () => {
  it("sleep が解決するまで、次の試行を始めない", async () => {
    let calls = 0;
    const createPipeline: CreateLocalEmbeddingPipeline = async () => {
      calls += 1;
      throw new Error("落ちる");
    };
    const releases: Array<() => void> = [];
    const provider = new LocalEmbeddingProvider({
      createPipeline,
      retry: { attempts: 3, delayMs: () => 10 },
      sleep: () => new Promise<void>((resolve) => releases.push(resolve)),
    });

    const settled = provider.embed(ctx, ["テキスト"]).then(
      () => null,
      (reason: unknown) => reason,
    );
    await settleMicrotasksAndTimers();
    expect(calls).toBe(1);
    expect(releases).toHaveLength(1);

    releases[0]?.();
    await settleMicrotasksAndTimers();
    expect(calls).toBe(2);
    expect(releases).toHaveLength(2);

    releases[1]?.();
    const error = await settled;
    expect(calls).toBe(3);
    expect((error as Error).message).toMatch(/モデルを読み込めなかった/);
  });

  it("kind の付いた失敗は、待たずに投げ直す", async () => {
    const waited: number[] = [];
    const createPipeline: CreateLocalEmbeddingPipeline = async () => {
      throw new LocalEmbeddingProviderError("unknown_input_limit", "モデルが上限を宣言していない");
    };
    const provider = new LocalEmbeddingProvider({
      createPipeline,
      retry: { attempts: 3, delayMs: () => 10 },
      sleep: async (ms) => {
        waited.push(ms);
      },
    });

    await expect(provider.embed(ctx, ["テキスト"])).rejects.toBeInstanceOf(
      LocalEmbeddingProviderError,
    );
    expect(waited).toEqual([]);
  });
});
