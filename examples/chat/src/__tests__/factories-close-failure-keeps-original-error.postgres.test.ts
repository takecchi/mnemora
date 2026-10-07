import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as MnemoraPostgres from "@mnemora/postgres";

vi.mock("@mnemora/postgres", async (importOriginal) => {
  const actual = await importOriginal<typeof MnemoraPostgres>();
  return {
    ...actual,
    closePostgresClient: vi.fn(async (client: Parameters<typeof actual.closePostgresClient>[0]) => {
      await actual.closePostgresClient(client);
      throw new Error("close failed on purpose");
    }),
  };
});

import { createAnswerBenchRuntime } from "../answer-bench.js";
import { createExampleRuntime } from "../runtime-factory.js";
import { createTimeWeightingBenchRuntime } from "../time-weighting-bench.js";
import { closePostgresClient } from "@mnemora/postgres";
import { requireDatabaseUrl } from "./test-db.js";

describe("examples/chat: ファクトリの失敗時に Pool を閉じ、close() が失敗しても元のエラーが届く（本物の Postgres）", () => {
  beforeEach(() => {
    vi.mocked(closePostgresClient).mockClear();
  });

  const cases = [
    [
      "createExampleRuntime",
      () =>
        createExampleRuntime(requireDatabaseUrl(), {
          MNEMORA_LLM: "deterministic",
          MNEMORA_EMBEDDING: "deterministic",
          MNEMORA_LEXICAL_STORE: "bogus-value-that-does-not-exist",
        }),
      /MNEMORA_LEXICAL_STORE/,
    ],
    [
      "createAnswerBenchRuntime",
      () => createAnswerBenchRuntime(requireDatabaseUrl(), { MNEMORA_LLM: "bogus-value" }),
      /MNEMORA_LLM/,
    ],
    [
      "createTimeWeightingBenchRuntime",
      () => createTimeWeightingBenchRuntime(requireDatabaseUrl(), { MNEMORA_LLM: "bogus-value" }),
      /MNEMORA_LLM/,
    ],
  ] as const;

  for (const [name, run, original] of cases) {
    it(`${name}: 失敗したら Pool を1回閉じ、close() が reject しても、元のエラーで reject する`, async () => {
      const rejection = await run().then(
        () => undefined,
        (err: unknown) => err,
      );
      expect(rejection).toBeInstanceOf(Error);
      expect((rejection as Error).message).toMatch(original);
      expect((rejection as Error).message).not.toMatch(/close failed on purpose/);
      expect(closePostgresClient).toHaveBeenCalledTimes(1);
    });
  }
});
