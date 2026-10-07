import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { blankOutWorkflowComments } from "../workflow-comment-blank-lib.mjs";

/**
 * - cache 段は `key:` が `local-embedding` で始まることで見分け、`path:` では見分けない。`path:` を書き換える変異が同定手段を壊し、歯が空回りする。
 * - 対の個数は固定せず、空回りを防ぐ下限だけを `toBeGreaterThanOrEqual(2)` で固定する（`toBe` にしない）。
 * - cache 段が同じ `key` を共有していることは壊さない。`key` の一意性は要求しない。
 * - `blankOutWorkflowComments` を通してから照合する。通さないと、地の文コメントが `path:` や `MNEMORA_LOCAL_EMBEDDING_CACHE_DIR` を引用しているだけで一致する。
 * - YAML は構造として解析せず文字列で見る（依存追加はオーナー専権）。壊れたときは、配線が変わったのか書き方が変わったのかを見て、配線が変わっていないなら取り出し方を直す。
 */

const workflowPath = fileURLToPath(new URL("../../.github/workflows/ci.yml", import.meta.url));
const rawWorkflow = readFileSync(workflowPath, "utf8");
const { text: workflow, unhandled: workflowUnhandled } = blankOutWorkflowComments(rawWorkflow);

/**
 * @param {string} yaml
 * @returns {string[]}
 */
function listJobIds(yaml) {
  const lines = yaml.split("\n");
  const jobsAt = lines.findIndex((line) => line === "jobs:");
  if (jobsAt === -1) {
    throw new Error("ci.yml に `jobs:` が無い(トップレベルの構造が変わった)。");
  }
  const ids = [];
  for (let i = jobsAt + 1; i < lines.length; i += 1) {
    const matched = /^ {2}([A-Za-z0-9_-]+):$/.exec(lines[i]);
    if (matched) {
      ids.push(matched[1]);
    }
  }
  return ids;
}

/**
 * @param {string} yaml
 * @param {string} jobId
 */
function extractJob(yaml, jobId) {
  const lines = yaml.split("\n");
  const start = lines.findIndex((line) => line === `  ${jobId}:`);
  if (start === -1) {
    throw new Error(`ci.yml に \`  ${jobId}:\` のジョブが無い(見つからなくなった)。`);
  }
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^ {2}\S/.test(lines[i])) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join("\n");
}

/**
 * @param {string} jobBlock
 * @returns {string[]}
 */
function splitSteps(jobBlock) {
  const lines = jobBlock.split("\n");
  const stepsAt = lines.findIndex((line) => line === "    steps:");
  if (stepsAt === -1) {
    throw new Error("ジョブブロックに `    steps:` が無い。");
  }
  /** @type {string[]} */
  const chunks = [];
  /** @type {string[]} */
  let current = [];
  for (let i = stepsAt + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (/^ {6}- name: /.test(line)) {
      if (current.length > 0) {
        chunks.push(current.join("\n"));
      }
      current = [line];
      continue;
    }
    if (current.length > 0) {
      current.push(line);
    }
  }
  if (current.length > 0) {
    chunks.push(current.join("\n"));
  }
  return chunks;
}

/**
 * @param {string} jobBlock
 * @returns {{ path: string, key: string }[]}
 */
function localEmbeddingCacheSteps(jobBlock) {
  const steps = splitSteps(jobBlock);
  /** @type {{ path: string, key: string }[]} */
  const result = [];
  for (const step of steps) {
    if (!/^\s*uses: actions\/cache@v\d+\s*$/m.test(step)) {
      continue;
    }
    const keyMatched = /^\s*key:\s*(.+)$/m.exec(step);
    if (!keyMatched) {
      continue;
    }
    const key = keyMatched[1].trim();
    if (!key.startsWith("local-embedding")) {
      continue;
    }
    const pathMatched = /^\s*path:\s*(.+)$/m.exec(step);
    if (!pathMatched) {
      throw new Error(`key: ${key} を持つ actions/cache 段に with.path が無い(段の形が変わった)。`);
    }
    result.push({ path: pathMatched[1].trim(), key });
  }
  return result;
}

/**
 * @param {string} jobBlock
 * @returns {string[]}
 */
function cacheDirEnvValues(jobBlock) {
  return [...jobBlock.matchAll(/^[ \t]*MNEMORA_LOCAL_EMBEDDING_CACHE_DIR:\s*(.+)$/gm)].map(
    (matched) => matched[1].trim(),
  );
}

const jobIds = listJobIds(workflow);

describe("ci.yml の local-embedding cache 配線(Issue #162 F / #164)", () => {
  it("🔴 コメント潰しが「扱えない」形に当たっていない(無視できないAPIにする)", () => {
    expect(workflowUnhandled).toEqual([]);
  });

  it("ジョブが1本以上見つかる(listJobIds の土台が崩れていない)", () => {
    expect(jobIds.length).toBeGreaterThan(0);
  });

  it("⭐ 各ジョブで、local-embedding cache 段の path 集合と MNEMORA_LOCAL_EMBEDDING_CACHE_DIR の値集合が一致する(両向き)", () => {
    for (const jobId of jobIds) {
      const jobBlock = extractJob(workflow, jobId);
      const cachePaths = localEmbeddingCacheSteps(jobBlock).map((step) => step.path);
      const envDirs = cacheDirEnvValues(jobBlock);
      const cachePathSet = [...new Set(cachePaths)].sort();
      const envDirSet = [...new Set(envDirs)].sort();
      expect(
        cachePathSet,
        `${jobId}: cache 段の path 集合(${JSON.stringify(cachePathSet)})と ` +
          `MNEMORA_LOCAL_EMBEDDING_CACHE_DIR の値集合(${JSON.stringify(envDirSet)})が食い違っている`,
      ).toEqual(envDirSet);
    }
  });

  it("⚠ 対を持つジョブが最低2つ在る(空回り防止の下限。対の本数そのものはハードコードしない)", () => {
    // `toBe` にしない。健全な対が増えても赤くならないよう、下限だけを固定する。
    const jobsWithCacheStep = jobIds.filter((jobId) => {
      const jobBlock = extractJob(workflow, jobId);
      return localEmbeddingCacheSteps(jobBlock).length > 0;
    });
    expect(jobsWithCacheStep.length).toBeGreaterThanOrEqual(2);
  });

  it("同じ path を指す local-embedding cache 段は、同じ key を持つ(意図的なキー共有を固定する。一意性は要求しない)", () => {
    /** @type {Map<string, Set<string>>} */
    const keysByPath = new Map();
    for (const jobId of jobIds) {
      const jobBlock = extractJob(workflow, jobId);
      for (const { path, key } of localEmbeddingCacheSteps(jobBlock)) {
        if (!keysByPath.has(path)) {
          keysByPath.set(path, new Set());
        }
        keysByPath.get(path)?.add(key);
      }
    }
    for (const [path, keys] of keysByPath) {
      expect(
        [...keys],
        `path: ${path} に対して複数の key が使われている(${[...keys]})`,
      ).toHaveLength(1);
    }
  });
});
