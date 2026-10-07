import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { shouldEnforceAdrIndexFreshness } from "../adr-index-freshness-branch-lib.mjs";
import {
  buildAdrEntries,
  buildIndexTable,
  extractGeneratedIndex,
  extractIndexedNumbers,
} from "../generate-adr-index-lib.mjs";
import { execSyncWithDeadline, isDeadlineError } from "./spawn-with-deadline.mjs";

/** 手元（`GITHUB_REF` が無い環境）では `main` のときだけ有効にする。ADR を足す PR は索引の生成前に陳腐化した状態になり、手元の `pnpm run test` を赤くしてしまう（ADR 0137・0192）。 */

const decisionsDir = fileURLToPath(new URL("../../docs/decisions", import.meta.url));

/** @param {typeof execSyncWithDeadline} [run] */
function detectGitBranch(run = execSyncWithDeadline) {
  try {
    return run("git rev-parse --abbrev-ref HEAD", {
      cwd: decisionsDir,
      encoding: "utf8",
    }).trim();
  } catch (error) {
    if (isDeadlineError(error)) throw error;
    return undefined;
  }
}

const enforceFreshnessNow = shouldEnforceAdrIndexFreshness({
  githubRef: process.env.GITHUB_REF,
  gitBranch: detectGitBranch(),
  forceOverride: process.env.ADR_INDEX_FRESHNESS_FORCE === "1",
});

function readActualEntriesAndReadme() {
  const filenames = readdirSync(decisionsDir).filter((f) => f !== "README.md");
  const files = filenames.map((filename) => ({
    filename,
    content: readFileSync(`${decisionsDir}/${filename}`, "utf8"),
  }));
  const entries = buildAdrEntries(files);
  const readmeText = readFileSync(`${decisionsDir}/README.md`, "utf8");
  return { entries, readmeText };
}

describe.skipIf(!enforceFreshnessNow)(
  "docs/decisions/README.md の生成部分が最新か（main の push・CI の pull_request 限定、ADR 0192）",
  () => {
    it("docs/decisions/*.md から生成した表が、README.md に commit されている表と一致する", () => {
      const { entries, readmeText } = readActualEntriesAndReadme();
      const expectedTable = buildIndexTable(entries);
      const actualTable = extractGeneratedIndex(readmeText);

      if (expectedTable === actualTable) {
        expect(actualTable).toBe(expectedTable);
        return;
      }

      const expectedNumbers = new Set(entries.map((e) => e.number));
      const actualNumbers = new Set(extractIndexedNumbers(actualTable));
      const missing = [...expectedNumbers].filter((n) => !actualNumbers.has(n)).sort();
      const extra = [...actualNumbers].filter((n) => !expectedNumbers.has(n)).sort();

      const detail = [
        missing.length > 0 ? `索引に無い ADR: ${JSON.stringify(missing)}` : null,
        extra.length > 0 ? `ファイルの無い索引行: ${JSON.stringify(extra)}` : null,
        missing.length === 0 && extra.length === 0
          ? "番号の集合は一致しているが、題・状態欄の内容が生成結果と食い違っている"
          : null,
      ]
        .filter(Boolean)
        .join(" / ");

      const howToFix = [
        "ADR を足す PR で、索引をまだ生成していないときに出る赤である。",
        "⭐ この PR の側で、PR ブランチ上で次を実行してコミット・push すれば緑になる:",
        "  node scripts/generate-adr-index.mjs",
        "  git add docs/decisions/README.md",
        '  git commit -m "docs(adr): 索引に <番号> を足す（生成器で作り直した）"',
        "  git push",
        "ほかの ADR の PR と索引の行が衝突したら、main を merge で取り込み、",
        "上の生成器で作り直す（衝突を手で解かない）。",
        "（ADR 0137「決定」2番は「作成者は触らない」と読めるが、実際の運用はこちら。",
        "  docs/decisions/0137-adr-index-generated-from-source.md 末尾の 2026-09-30 の追記。）",
        "この検査を CI の pull_request でも有効にした理由・引き受けた負債は",
        "docs/decisions/0192-adr-index-freshness-enforced-in-pull-request-ci.md。",
      ].join("\n");

      expect(
        actualTable,
        `docs/decisions/README.md が陳腐化している: ${detail}\n\n${howToFix}`,
      ).toBe(expectedTable);
    });

    it("空振り防止: ADR ファイルが1件以上ある", () => {
      const { entries } = readActualEntriesAndReadme();
      expect(entries.length).toBeGreaterThan(0);
    });
  },
);

describe("detectGitBranch: 期限の例外だけは、読み替えずに投げ直す", () => {
  const hang = `${JSON.stringify(process.execPath)} -e "setInterval(() => {}, 1000)"`;

  it("子が期限を超えたら、undefined（＝強制しない）に読み替えずに投げる", () => {
    expect(() =>
      detectGitBranch((_command, options) =>
        execSyncWithDeadline(hang, { ...options, timeoutMs: 500 }),
      ),
    ).toThrow(/秒で終わらなかった/);
  }, 20_000);

  it("期限でない失敗（非0の終了）は、従来どおり undefined", () => {
    expect(
      detectGitBranch((_command, options) =>
        execSyncWithDeadline("exit 3", { ...options, stdio: "pipe" }),
      ),
    ).toBeUndefined();
  });
});
