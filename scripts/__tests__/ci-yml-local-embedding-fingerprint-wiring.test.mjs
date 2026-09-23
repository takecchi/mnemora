import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { blankOutWorkflowComments } from "../workflow-comment-blank-lib.mjs";

/**
 * ⭐ **この歯が測っているもの（消す前に読むこと）**
 *
 * `.github/workflows/ci.yml` の `example-chat` ジョブに、
 * `scripts/check-local-embedding-fingerprint.mjs`（local-embedding が実際に
 * 読み込んだ重みが、宣言された Hugging Face repo の内容と今まさに一致しているかを
 * 照合する門）を走らせるステップが**正しい形**で配線されていること:
 *
 * 1. そのステップが実在し、`check-local-embedding-fingerprint.mjs` を実行している。
 * 2. `MNEMORA_LOCAL_EMBEDDING_CACHE_DIR` を渡している。
 * 3. **`test:db` ステップより後**に在る（モデルはテスト実行中に取得されるため、
 *    それより前に置いても検査対象がまだ存在しない）。
 * 4. `continue-on-error` を持たない（この段は門であり、依頼者が明示的に禁じた
 *    設定である。付いていると exit 1（不一致）まで素通りしてしまう）。
 * 5. ステップの本体が `GITHUB_STEP_SUMMARY` へ書き出している（一致・保留の
 *    どちらでも Job Summary に1行残す設計——「何も出ていない」を「ステップが
 *    走らなかった」と区別できるようにするため）。
 *
 * ⚠ **YAML は構造として解析していない（文字列で見ている）。**既存の wiring 歯
 * （`ci-yml-local-embedding-cache-wiring.test.mjs` 等）と同じ判断——依存追加は
 * オーナー専権（`docs/autonomy.md`）。壊れたときは「配線が変わった」か
 * 「取り出し方が古い」かを見て、配線が変わっていないなら取り出し方を直すこと。
 *
 * 🔴 **`blankOutWorkflowComments` を必ず通してから照合している。** これを通さずに
 * `ci.yml` の生テキストへ `toContain` を当てると、地の文のコメントが
 * `MNEMORA_LOCAL_EMBEDDING_CACHE_DIR` や `GITHUB_STEP_SUMMARY` を**引用しているだけ**
 * でも一致してしまう（`ci-yml-local-embedding-cache-wiring.test.mjs` と同じ理由）。
 *
 * ## 確かめていないこと
 *
 * - この CLI が実際に緑・赤・保留を正しく判定するかは、
 *   `scripts/__tests__/check-local-embedding-fingerprint-lib.test.mjs`（純関数側）と
 *   依頼者が手元で行った変異試験（実モデルに対する実行）が見ている。この歯は
 *   「配線」だけを見る——`node scripts/check-local-embedding-fingerprint.mjs` を
 *   実際には1度も実行しない。
 * - **`run:` の中身に埋め込んだ `case` 文が、exit コードごとに判定表どおりに
 *   分岐するか（exit 2 だけをジョブ失敗にせず飲み込むか）は、この歯では
 *   シェルとして実行して確かめていない。** 静的なテキスト検査（このファイル）と、
 *   **`ci-yml-local-embedding-fingerprint-shell.test.mjs`**（`run:` 本文を
 *   `ci.yml` から逐語で取り出し、実際に `bash` へ食わせて `exit 0/1/2/3` の
 *   4分岐を固定する歯。Issue #574）とで役割を分けている。
 */

const workflowPath = fileURLToPath(new URL("../../.github/workflows/ci.yml", import.meta.url));
const rawWorkflow = readFileSync(workflowPath, "utf8");
const { text: workflow, unhandled: workflowUnhandled } = blankOutWorkflowComments(rawWorkflow);

const JOB_ID = "example-chat";

/**
 * `jobs:` の下の1ジョブ(`  <id>:` から、次の同じ深さの `  <id>:` まで)を切り出す
 * (既存の wiring 歯群と同じ形)。
 *
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
 * ジョブブロックを `steps:` のリストの要素(段)ごとの生テキストへ切り分ける
 * (`ci-yml-local-embedding-cache-wiring.test.mjs` の `splitSteps` と同じ形)。
 *
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

const jobBlock = extractJob(workflow, JOB_ID);
const steps = splitSteps(jobBlock);

const testDbStepIndex = steps.findIndex((step) =>
  step.includes("run: pnpm --filter @mnemora/example-chat run test:db"),
);
const fingerprintStepIndex = steps.findIndex((step) =>
  step.includes("check-local-embedding-fingerprint.mjs"),
);

describe("ci.yml の local-embedding fingerprint 配線(example-chat ジョブ)", () => {
  it("🔴 コメント潰しが「扱えない」形に当たっていない(無視できないAPIにする)", () => {
    expect(workflowUnhandled).toEqual([]);
  });

  it("test:db ステップが見つかる(このテスト自身の土台)", () => {
    expect(testDbStepIndex).toBeGreaterThanOrEqual(0);
  });

  it("⭐ check-local-embedding-fingerprint.mjs を実行するステップが存在する", () => {
    expect(fingerprintStepIndex).toBeGreaterThanOrEqual(0);
  });

  it("🔴 fingerprint ステップは test:db ステップより後にある(モデルはテスト実行中に取得されるため)", () => {
    expect(fingerprintStepIndex).toBeGreaterThan(testDbStepIndex);
  });

  it("MNEMORA_LOCAL_EMBEDDING_CACHE_DIR を渡している", () => {
    const step = steps[fingerprintStepIndex];
    expect(step).toContain("MNEMORA_LOCAL_EMBEDDING_CACHE_DIR");
  });

  it("⛔ continue-on-error を持たない(この段は門である)", () => {
    const step = steps[fingerprintStepIndex];
    expect(/^\s*continue-on-error:/m.test(step)).toBe(false);
  });

  it("⭐ ステップの本体が GITHUB_STEP_SUMMARY へ書き出している(一致・保留のどちらでも1行残す設計)", () => {
    const step = steps[fingerprintStepIndex];
    expect(step).toContain("GITHUB_STEP_SUMMARY");
  });

  it("⚠ 陰性対照: 架空のステップ名では見つからない(検査そのものが常に true を返すだけに退化していないことの根拠)", () => {
    const bogusIndex = steps.findIndex((step) =>
      step.includes("check-nonexistent-fingerprint-tool.mjs"),
    );
    expect(bogusIndex).toBe(-1);
  });
});
