import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runNodeScript } from "./spawn-with-deadline.mjs";

/**
 * #1789（ADR 0666）の確かめ直し（Issue #1877）。キャッシュ置き場の `.` で始まるファイル・ディレクトリを
 * 読み飛ばす変異（`readdirSync` の結果から `.` で始まる名前を除く）が `check-local-embedding-fingerprint-cli.test.mjs` を
 * 素通りした。手元に在って HF の tree に無いものは、隠しファイルでも「素性不明」で赤にする。
 */

const script = fileURLToPath(new URL("../check-local-embedding-fingerprint.mjs", import.meta.url));
const providerSource = fileURLToPath(
  new URL("../../packages/local-embedding/src/local-embedding-provider.ts", import.meta.url),
);

function declaredRepo() {
  const line = readFileSync(providerSource, "utf8")
    .split("\n")
    .find((l) => l.includes("export const DEFAULT_LOCAL_EMBEDDING_REPO"));
  return line.split('"')[1];
}

function gitBlobSha1(bytes) {
  return createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
}

async function withCache(files, treePaths, fn) {
  const repo = declaredRepo();
  const cacheDir = mkdtempSync(join(tmpdir(), "mnemora-fp-edges-"));
  const tree = [];
  for (const [rel, contents] of Object.entries(files)) {
    const bytes = Buffer.from(contents, "utf8");
    const abs = join(cacheDir, repo, rel);
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, bytes);
    if (treePaths.includes(rel)) tree.push({ type: "file", path: rel, oid: gitBlobSha1(bytes) });
  }
  const server = createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(req.url.includes("/tree/") ? tree : { id: repo }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const origin = `http://127.0.0.1:${server.address().port}`;
    return await fn({ origin, cacheDir });
  } finally {
    rmSync(cacheDir, { recursive: true, force: true });
    await new Promise((resolve) => server.close(() => resolve()));
  }
}

describe("手元の `.` で始まるファイルも照合の対象になる", () => {
  it("tree に在って一致する通常ファイルだけなら緑（やりすぎの対）", async () => {
    await withCache({ "config.json": "{}\n" }, ["config.json"], async (f) => {
      const r = await runNodeScript(script, ["--cache-dir", f.cacheDir, "--api-base", f.origin]);
      expect(r.code).toBe(0);
    });
  });

  it("tree に無い隠しファイル（`.marker`）が在ると赤（exit 1）で、名前を出す", async () => {
    await withCache(
      { "config.json": "{}\n", ".marker": "x\n" },
      ["config.json"],
      async (f) => {
        const r = await runNodeScript(script, ["--cache-dir", f.cacheDir, "--api-base", f.origin]);
        expect(r.code).toBe(1);
        expect(r.stdout).toContain(".marker");
      },
    );
  });

  it("隠しディレクトリの中のファイル（`.hidden/blob`）も、tree に無ければ赤", async () => {
    await withCache(
      { "config.json": "{}\n", ".hidden/blob": "x\n" },
      ["config.json"],
      async (f) => {
        const r = await runNodeScript(script, ["--cache-dir", f.cacheDir, "--api-base", f.origin]);
        expect(r.code).toBe(1);
        expect(r.stdout).toContain(".hidden/blob");
      },
    );
  });
});
