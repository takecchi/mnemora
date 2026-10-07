import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// 空のキャッシュを渡して、読み込めないことを確かめる。実モデルも実 API も要らない。
// 見るのは「測るだけ」の約束（失敗しても exit 0、出力は1行）と、fetch の差し替えが transformers.js を読み込む前に効いていること（効いていなければ requests が 0 になる）。

const chatDir = fileURLToPath(new URL("../..", import.meta.url));
const TIMEOUT_MS = 90_000;

describe("local-embedding-offline-load-check.ts: 温めていないキャッシュ", () => {
  it(
    "読み込めなくても exit 0 で、1行だけ出し、HF へ出ようとした回数と最初の URL を数える",
    () => {
      const cacheDir = mkdtempSync(join(tmpdir(), "offline-load-check-"));
      try {
        const env: Record<string, string | undefined> = {
          ...process.env,
          MNEMORA_LOCAL_EMBEDDING_CACHE_DIR: cacheDir,
        };
        delete env.OPENAI_API_KEY;
        const result = spawnSync(
          "pnpm",
          ["exec", "tsx", "src/scripts/local-embedding-offline-load-check.ts"],
          { cwd: chatDir, env, encoding: "utf8", timeout: TIMEOUT_MS },
        );
        expect(result.status).toBe(0);
        const lines = result.stdout.split("\n").filter((l) => l.trim() !== "");
        expect(lines).toHaveLength(1);
        expect(lines[0]).toMatch(/^\[offline-load-check\] ok=false requests=([1-9]\d*) /);
        expect(lines[0]).toContain("first=/sirasagi62/ruri-v3-30m-ONNX/resolve/");
        expect(lines[0]).not.toContain("https://huggingface.co");
      } finally {
        rmSync(cacheDir, { recursive: true, force: true });
      }
    },
    TIMEOUT_MS,
  );
});
