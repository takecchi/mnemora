import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { spawnSyncWithDeadline } from "./spawn-with-deadline.mjs";

const script = fileURLToPath(new URL("../public-api-breaking-diff.mjs", import.meta.url));

describe("public-api-breaking-diff.mjs: exit code は常に 0", () => {
  it("想定外の失敗（知らない引数）も最上位で拾い、exit 0 で失敗の内容を Markdown に出す", () => {
    const result = spawnSyncWithDeadline("node", [script, "--no-such-flag"], {
      encoding: "utf8",
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("印字に失敗した");
    expect(result.stdout).toContain("不明な引数: --no-such-flag");
  });
});
