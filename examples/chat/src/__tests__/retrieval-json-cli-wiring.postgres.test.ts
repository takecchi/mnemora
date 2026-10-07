import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { requireDatabaseUrl } from "./test-db.js";

// cli.ts は末尾で main() を無条件に実行するので import 越しに呼べない。子プロセスとして実際に起動する（ADR 0068）。
// 実 API は叩かない。MNEMORA_PROVIDER_SOURCE=recorded を明示し、OPENAI_API_KEY を env から消して二重に塞ぐ。

const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));

let workDir: string | undefined;

afterEach(() => {
  if (workDir) {
    rmSync(workDir, { recursive: true, force: true });
    workDir = undefined;
  }
});

function runRetrievalCli(env: Record<string, string | undefined>) {
  return spawnSync("pnpm", ["--filter", "@mnemora/example-chat", "run", "retrieval"], {
    cwd: repoRoot,
    env,
    encoding: "utf8",
    timeout: 120_000,
  });
}

describe("examples/chat retrieval: MNEMORA_RETRIEVAL_JSON の配線(本物の CLI を子プロセスで起動)", () => {
  it("設定すれば書く。未設定なら1バイトも挙動を変えない(同じコマンドを2回、env だけ変えて起動する)", () => {
    workDir = mkdtempSync(join(tmpdir(), "retrieval-json-wiring-"));
    const jsonPath = join(workDir, "retrieval-quality.json");

    const baseEnv: Record<string, string | undefined> = {
      ...process.env,
      DATABASE_URL: requireDatabaseUrl(),
      MNEMORA_PROVIDER_SOURCE: "recorded",
    };
    delete baseEnv.OPENAI_API_KEY;

    const withEnv = runRetrievalCli({ ...baseEnv, MNEMORA_RETRIEVAL_JSON: jsonPath });
    expect(withEnv.status, `stderr:\n${withEnv.stderr}\nstdout:\n${withEnv.stdout}`).toBe(0);
    expect(existsSync(jsonPath), "MNEMORA_RETRIEVAL_JSON を設定したのにファイルが無い").toBe(true);
    expect(withEnv.stdout).toContain("[retrieval] 機械可読な結果を書き出した");

    const json = JSON.parse(readFileSync(jsonPath, "utf8"));
    expect(json.schemaVersion).toBe(1);
    expect(json.providerSource).toBe("recorded");
    expect(json.cassette).not.toBeNull();
    expect(json.cassette.embedding.model).toBe("text-embedding-3-small");
    expect(json.cassette.embedding.dimensions).toBe(256);
    expect(json.commit === null || /^[0-9a-f]{40}$/.test(json.commit)).toBe(true);
    expect(() => new Date(json.measuredAt).toISOString()).not.toThrow();
    expect(json.arms).toHaveLength(3);
    for (const arm of json.arms) {
      expect(typeof arm.armLabel).toBe("string");
      expect(["deterministic", "recorded", "openai"]).toContain(arm.llmMode);
      expect(["deterministic", "recorded", "openai"]).toContain(arm.embeddingMode);
      expect(typeof arm.mrrOverall).toBe("number");
      expect(typeof arm.hit1Count).toBe("number");
      expect(typeof arm.hit10Count).toBe("number");
      expect(arm.probeCount).toBe(7);
    }
    expect(new Set(json.arms.map((a: { armLabel: string }) => a.armLabel)).size).toBe(3);

    const rmJsonPath = join(workDir, "should-not-appear.json");
    const withoutEnv = runRetrievalCli(baseEnv);
    expect(withoutEnv.status, `stderr:\n${withoutEnv.stderr}\nstdout:\n${withoutEnv.stdout}`).toBe(
      0,
    );
    expect(withoutEnv.stdout).not.toContain("[retrieval] 機械可読な結果を書き出した");
    expect(existsSync(rmJsonPath)).toBe(false);
  }, 180_000);
});
