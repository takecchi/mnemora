import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { ANSWER_CASE_SET_DEV } from "../answer-case-set.dev.js";
import { ANSWER_CASE_SET_EVAL } from "../answer-case-set.eval.js";
import { requireDatabaseUrl } from "./test-db.js";

// 子プロセスで起動する。cli.ts は末尾で main() を無条件に実行するので、import 越しに runAnswer() だけを呼べない（ADR 0068）。
// ケースごとの verdict と pass/fail の件数は assert しない。記録に自然発生の fail が入っており、
// supersede が直ったときに、直したことが赤になる（ADR 0236）。件数は数字で書かず、ケース集合から導く。

const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));

// it の第3引数で個別に伸ばす。vitest.config.mts の testTimeout は触らない（上げると他のテストの遅延が隠れる）。
const CLI_TIMEOUT_MS = 180_000;

let workDir: string | undefined;

afterEach(() => {
  if (workDir) {
    rmSync(workDir, { recursive: true, force: true });
    workDir = undefined;
  }
});

function runAnswerCli(env: Record<string, string | undefined>) {
  return spawnSync("pnpm", ["--filter", "@mnemora/example-chat", "run", "answer"], {
    cwd: repoRoot,
    env,
    encoding: "utf8",
    timeout: CLI_TIMEOUT_MS,
  });
}

describe("examples/chat answer: 記録の再生で最後まで通る(本物の CLI を子プロセスで起動。Issue #547)", () => {
  it(
    "recorded で exit 0 になり、MNEMORA_ANSWER_JSON を設定すれば書く／未設定なら1バイトも挙動を変えない",
    () => {
      workDir = mkdtempSync(join(tmpdir(), "answer-cli-wiring-"));
      const jsonPath = join(workDir, "answer.json");

      const baseEnv: Record<string, string | undefined> = {
        ...process.env,
        DATABASE_URL: requireDatabaseUrl(),
        MNEMORA_PROVIDER_SOURCE: "recorded",
        // 明示指定は、再生に要らなくなった今も残す。明示指定の道が効き続けることを測るため。
        MNEMORA_LLM: "recorded",
        MNEMORA_EMBEDDING: "recorded",
      };
      // ⚠ 二重に塞ぐ。片方だけでは実 API に倒れうる。
      delete baseEnv.OPENAI_API_KEY;

      const withEnv = runAnswerCli({ ...baseEnv, MNEMORA_ANSWER_JSON: jsonPath });
      expect(withEnv.status, `stderr:\n${withEnv.stderr}\nstdout:\n${withEnv.stdout}`).toBe(0);

      expect(withEnv.stdout).toContain("provider source の予定: recorded");
      expect(withEnv.stdout).toContain("[answer] 機械可読な結果を書き出した");
      expect(existsSync(jsonPath), "MNEMORA_ANSWER_JSON を設定したのにファイルが無い").toBe(true);

      const json = JSON.parse(readFileSync(jsonPath, "utf8"));
      expect(json.llmMode).toBe("recorded");
      expect(json.embeddingMode).toBe("recorded");
      expect(json.qualityClaimable).toBe(true);
      expect(json.commit === null || /^[0-9a-f]{40}$/.test(json.commit)).toBe(true);
      expect(() => new Date(json.measuredAt).toISOString()).not.toThrow();

      const expectedCaseCount = ANSWER_CASE_SET_DEV.length + ANSWER_CASE_SET_EVAL.length;
      expect(json.caseCount).toBe(expectedCaseCount);
      expect(json.cases).toHaveLength(expectedCaseCount);
      expect(new Set(json.cases.map((c: { id: string }) => c.id)).size).toBe(expectedCaseCount);
      expect(json.cases.map((c: { id: string }) => c.id).sort()).toEqual(
        [...ANSWER_CASE_SET_DEV, ...ANSWER_CASE_SET_EVAL].map((c) => c.id).sort(),
      );

      const originalCasesById = new Map(
        [...ANSWER_CASE_SET_DEV, ...ANSWER_CASE_SET_EVAL].map((c) => [c.id, c]),
      );

      for (const answerCase of json.cases) {
        for (const path of [answerCase.naive, answerCase.mnemora]) {
          expect(typeof path.inputChars).toBe("number");
          expect(path.inputChars).toBeGreaterThan(0);
          expect(typeof path.inputEstimatedTokens).toBe("number");
          expect(typeof path.answer).toBe("string");
          expect(["pass", "fail", "indeterminate"]).toContain(path.verdict);
          expect(typeof path.contentPreservation.applicable).toBe("boolean");
          expect(typeof path.contentPreservation.preserved).toBe("boolean");
          expect(Array.isArray(path.contentPreservation.matchedAcceptTerms)).toBe(true);
        }
        expect(answerCase.cost.answerLLMCalls).toBeGreaterThan(0);
        expect(answerCase.cost.judgeLLMCalls).toBeGreaterThan(0);
      }

      for (const answerCase of json.cases) {
        const original = originalCasesById.get(answerCase.id);
        expect(original, `${answerCase.id}: ケース集合に見つからない`).toBeDefined();
        if (original === undefined || original.expected.kind !== "closed-value") {
          continue;
        }
        expect(
          answerCase.mnemora.contentPreservation.applicable,
          `${answerCase.id}: closed-value なので applicable=true のはず`,
        ).toBe(true);
        expect(
          answerCase.mnemora.contentPreservation.preserved,
          `${answerCase.id}: mnemora の digest に expected.accept が残っているはず` +
            `（残っていなければ、記録済みカセットの digest が変わった——録り直しを検討すること）`,
        ).toBe(true);
      }

      // 削減率の値は固定しない（記録を録り直すと動く）。
      expect(json.inputReduction.naiveInputChars).toBe(
        json.cases.reduce(
          (sum: number, c: { naive: { inputChars: number } }) => sum + c.naive.inputChars,
          0,
        ),
      );
      expect(json.inputReduction.mnemoraInputChars).toBe(
        json.cases.reduce(
          (sum: number, c: { mnemora: { inputChars: number } }) => sum + c.mnemora.inputChars,
          0,
        ),
      );

      const rmJsonPath = join(workDir, "should-not-appear.json");
      const withoutEnv = runAnswerCli(baseEnv);
      expect(
        withoutEnv.status,
        `stderr:\n${withoutEnv.stderr}\nstdout:\n${withoutEnv.stdout}`,
      ).toBe(0);
      expect(withoutEnv.stdout).not.toContain("[answer] 機械可読な結果を書き出した");
      expect(existsSync(rmJsonPath)).toBe(false);
    },
    CLI_TIMEOUT_MS,
  );

  it(
    "MNEMORA_* を一切指定しなくても recorded で走り、画面と実際の provider が一致する（Issue #577）",
    () => {
      workDir = mkdtempSync(join(tmpdir(), "answer-cli-default-env-"));
      const jsonPath = join(workDir, "answer.json");

      const env: Record<string, string | undefined> = {
        ...process.env,
        DATABASE_URL: requireDatabaseUrl(),
        MNEMORA_ANSWER_JSON: jsonPath,
      };
      // `MNEMORA_PROVIDER_SOURCE=recorded` は置かない（置くと既定の道でなくなる）。実 API を止めているのは
      // `OPENAI_API_KEY` を消すことだけ。`MNEMORA_*` も環境から紛れ込むので落とす。
      delete env.OPENAI_API_KEY;
      delete env.MNEMORA_LLM;
      delete env.MNEMORA_EMBEDDING;
      delete env.MNEMORA_PROVIDER_SOURCE;

      const result = runAnswerCli(env);
      expect(result.status, `stderr:\n${result.stderr}\nstdout:\n${result.stdout}`).toBe(0);

      expect(result.stdout).toContain("[cassette] カセットを読んだ");
      expect(result.stdout).not.toContain("記録した応答を再生する");

      expect(result.stdout).toContain(
        "[provider] LLM       : 記録した実 API 応答の再生（ADR 0051）",
      );
      expect(result.stdout).not.toContain("決定的な擬似 provider");

      const json = JSON.parse(readFileSync(jsonPath, "utf8"));
      expect(json.qualityClaimable).toBe(true);
      expect(json.llmMode).toBe("recorded");
      expect(json.embeddingMode).toBe("recorded");
    },
    CLI_TIMEOUT_MS,
  );

  it(
    "⭐ MNEMORA_LLM/MNEMORA_EMBEDDING に deterministic を明示したら、明示が勝ち ⛔⛔⛔ バナーが出続ける（Issue #577 / ADR 0068）",
    () => {
      workDir = mkdtempSync(join(tmpdir(), "answer-cli-explicit-deterministic-"));
      const jsonPath = join(workDir, "answer.json");

      const env: Record<string, string | undefined> = {
        ...process.env,
        DATABASE_URL: requireDatabaseUrl(),
        MNEMORA_ANSWER_JSON: jsonPath,
        MNEMORA_LLM: "deterministic",
        MNEMORA_EMBEDDING: "deterministic",
      };
      // `MNEMORA_PROVIDER_SOURCE` は落とす（環境から紛れ込むと、明示指定だけを置いた形でなくなる）。
      delete env.OPENAI_API_KEY;
      delete env.MNEMORA_PROVIDER_SOURCE;

      const result = runAnswerCli(env);
      expect(result.status, `stderr:\n${result.stderr}\nstdout:\n${result.stdout}`).toBe(0);

      expect(result.stdout).toContain("回答品質は測っていない");

      expect(result.stdout).toContain(
        "[provider] LLM       : @mnemora/testkit の決定的な擬似 provider",
      );

      expect(result.stdout).toContain("読み込んだカセットは、この実行では使っていない");

      expect(result.stdout).not.toContain("記録した応答を再生する");
      expect(result.stdout).toContain("[cassette] カセットを読んだ");

      const json = JSON.parse(readFileSync(jsonPath, "utf8"));
      expect(json.qualityClaimable).toBe(false);
      expect(json.llmMode).toBe("deterministic");
      expect(json.embeddingMode).toBe("deterministic");
    },
    CLI_TIMEOUT_MS,
  );
});
