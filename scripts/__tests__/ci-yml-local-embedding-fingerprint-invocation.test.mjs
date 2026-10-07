import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { blankOutWorkflowComments } from "../workflow-comment-blank-lib.mjs";

// YAML は構造として解析せず文字列で見る（依存追加はオーナー専権）。

const raw = readFileSync(
  fileURLToPath(new URL("../../.github/workflows/ci.yml", import.meta.url)),
  "utf8",
);
const { text: workflow } = blankOutWorkflowComments(raw);

function jobOf(yaml, jobId) {
  const lines = yaml.split("\n");
  const start = lines.findIndex((l) => l === `  ${jobId}:`);
  if (start === -1) throw new Error(`ci.yml に ${jobId} が無い`);
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^ {2}\S/.test(lines[i])) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end);
}

function stepsOf(jobLines) {
  const chunks = [];
  let cur = null;
  for (const l of jobLines) {
    if (/^ {6}- /.test(l)) {
      if (cur) chunks.push(cur);
      cur = [l];
    } else if (cur) cur.push(l);
  }
  if (cur) chunks.push(cur);
  return chunks;
}

const jobLines = jobOf(workflow, "example-chat");
const steps = stepsOf(jobLines);
const gate = steps.filter((s) =>
  s.some((l) => l.includes("check-local-embedding-fingerprint.mjs")),
);
const cacheStep = steps.filter((s) => s.some((l) => /uses:\s*actions\/cache@/.test(l)));

describe("重みの指紋の門の呼び方（example-chat ジョブ）", () => {
  it("門のステップはちょうど1つ、重みの cache 段もちょうど1つ", () => {
    expect(gate).toHaveLength(1);
    expect(cacheStep).toHaveLength(1);
  });

  it('呼び出しは `node scripts/check-local-embedding-fingerprint.mjs --cache-dir "${MNEMORA_LOCAL_EMBEDDING_CACHE_DIR}"` だけである（`--api-base` などを足さない）', () => {
    const text = gate[0].join("\n");
    const at = text.indexOf("node scripts/check-local-embedding-fingerprint.mjs");
    expect(at).toBeGreaterThan(-1);
    const rest = text.slice(at).split("\n");
    const parts = [];
    for (const l of rest) {
      const t = l.trim();
      parts.push(t.replace(/\\$/, "").trim());
      if (!t.endsWith("\\")) break;
    }
    expect(parts.join(" ").replace(/\s+/g, " ")).toBe(
      'node scripts/check-local-embedding-fingerprint.mjs --cache-dir "${MNEMORA_LOCAL_EMBEDDING_CACHE_DIR}"',
    );
  });

  it("門が環境変数で受けるのは `MNEMORA_LOCAL_EMBEDDING_CACHE_DIR` だけで、値は cache 段の `path:` と同じ場所", () => {
    const envKeys = gate[0]
      .map((l) => /^ {10}([A-Za-z_][A-Za-z0-9_]*):/.exec(l)?.[1])
      .filter(Boolean);
    expect(envKeys).toEqual(["MNEMORA_LOCAL_EMBEDDING_CACHE_DIR"]);
    const envValue = gate[0]
      .find((l) => /^ {10}MNEMORA_LOCAL_EMBEDDING_CACHE_DIR:/.test(l))
      .split(":")
      .slice(1)
      .join(":")
      .trim();
    const cachePath = cacheStep[0]
      .find((l) => /^\s+path:/.test(l))
      .split(":")
      .slice(1)
      .join(":")
      .trim();
    expect(envValue).toBe(cachePath);
  });
});
