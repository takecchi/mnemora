import { describe, expect, it, vi } from "vitest";
import { type FuzzBackend, fuzzSeeds } from "./recall-invariant-fuzz-harness.js";

/**
 * recall の不変条件を、シードつきのランダムな操作列で検査する（Issue #1019・#1020・#1021 を
 * 見つけた検査器を、固定シードで回す形にしたもの）。Fake（`runtime-fakes.ts`）だけで完結する。
 *
 * 操作と不変条件（I1〜I12）の一覧は `recall-invariant-fuzz-harness.ts` に在る（ここには写さない）。
 * 同じ検査器を Postgres の上で回すのは
 * `packages/postgres/src/__tests__/recall-invariant-fuzz.postgres.test.ts`。
 *
 * `RECALL_FUZZ_SEEDS`・`RECALL_FUZZ_LEN` で本数と長さを変えられる。
 */

const SEEDS = Number(process.env.RECALL_FUZZ_SEEDS ?? 40);
const LEN = Number(process.env.RECALL_FUZZ_LEN ?? 60);

const fakeBackend: FuzzBackend = {
  // I9: Fake の id はモジュール単位の続き番号で振られるので、実行ごとに読み直して揃える。
  async setup() {
    vi.resetModules();
    const { createFakeRuntimeStores } = await import("./runtime-fakes.js");
    const { createRuntime } = await import("../runtime.js");
    return { stores: createFakeRuntimeStores(), createRuntime };
  },
  vector: (v) => [...v],
};

describe("recall の不変条件（シードつきのランダムな操作列、Fake）", () => {
  it(`${SEEDS} シード × ${LEN} 操作で、I1〜I12 の違反が無い`, async () => {
    const report = await fuzzSeeds(fakeBackend, {
      seeds: SEEDS,
      len: LEN,
      checkDeterminism: true,
    });
    expect(report).toBe("");
  }, 600_000);
});
