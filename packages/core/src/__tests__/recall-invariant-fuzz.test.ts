import { describe, expect, it, vi } from "vitest";
import { type FuzzBackend, fuzzSeeds } from "./recall-invariant-fuzz-harness.js";

const SEEDS = Number(process.env.RECALL_FUZZ_SEEDS ?? 40);
const LEN = Number(process.env.RECALL_FUZZ_LEN ?? 60);
const FIELDS_SEEDS = Number(process.env.RECALL_FUZZ_FIELDS_SEEDS ?? 20);
const RELATIONS_SEEDS = Number(process.env.RECALL_FUZZ_RELATIONS_SEEDS ?? 20);
const ARG_SEEDS = Number(process.env.RECALL_FUZZ_ARG_SEEDS ?? 20);
const CHANNELS_SEEDS = Number(process.env.RECALL_FUZZ_CHANNELS_SEEDS ?? 20);

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

  it(`fields: ${FIELDS_SEEDS} シード × ${LEN} 操作で、I1〜I12 の違反が無い（\`timeWeighting\`・\`digestBandLimit\`・クエリの \`tags\`・\`occurredAt\`、ADR 0492）`, async () => {
    const report = await fuzzSeeds(fakeBackend, {
      seeds: FIELDS_SEEDS,
      len: LEN,
      checkDeterminism: true,
      profile: "fields",
    });
    expect(report).toBe("");
  }, 600_000);

  for (const profile of ["relations", "argdead", "argupper"] as const) {
    it(`${profile}: ${profile === "relations" ? RELATIONS_SEEDS : ARG_SEEDS} シード × ${LEN} 操作で、I1〜I12 の違反が無い（ADR 0494）`, async () => {
      const report = await fuzzSeeds(fakeBackend, {
        seeds: profile === "relations" ? RELATIONS_SEEDS : ARG_SEEDS,
        len: LEN,
        checkDeterminism: true,
        profile,
      });
      expect(report).toBe("");
    }, 600_000);
  }

  it(`channels: ${CHANNELS_SEEDS} シード × ${LEN} 操作で、I1〜I12・I16 の違反が無い（\`channels\` の組と語彙の \`text\`、ADR 0509）`, async () => {
    const report = await fuzzSeeds(fakeBackend, {
      seeds: CHANNELS_SEEDS,
      len: LEN,
      checkDeterminism: true,
      profile: "channels",
    });
    expect(report).toBe("");
  }, 600_000);
});
