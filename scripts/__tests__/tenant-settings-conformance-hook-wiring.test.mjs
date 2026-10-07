import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { findCallsMissingHook, findConformanceCalls } from "../conformance-hook-wiring-lib.mjs";

// 型を必須にしない理由: @mnemora/testkit は公開済みで、必須化は公開パッケージへの破壊的変更になる
// （版を上げる判断はオーナーの領域）。型は変えず、この歯で代替している。
// ソースは文字列で走査する（歯のために依存を足さない）。書き方の変更に弱い。

const CONFORMANCE_FN = "describeTenantSettingsStoreConformance";
const REQUIRED_HOOK = "setDefaultHalfLifeHours";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

const SKIP_DIRS = new Set(["node_modules", "dist", ".git", "coverage"]);

/**
 * @returns {string[]} リポジトリルートからの相対パス
 */
function collectSourceFiles() {
  /** @type {string[]} */
  const files = [];
  /** @param {string} dir */
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      if (SKIP_DIRS.has(entry)) {
        continue;
      }
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      if (/\.(ts|mts|cts)$/.test(entry) && !entry.endsWith(".d.ts")) {
        files.push(relative(repoRoot, full));
      }
    }
  };
  for (const top of ["packages", "examples"]) {
    walk(join(repoRoot, top));
  }
  return files;
}

const sourceFiles = collectSourceFiles();

const callerFiles = sourceFiles.filter(
  (file) =>
    findConformanceCalls(readFileSync(join(repoRoot, file), "utf8"), CONFORMANCE_FN).length > 0,
);

describe(`${CONFORMANCE_FN} の呼び出し側が ${REQUIRED_HOOK} を渡していること（Issue #184 の追測）`, () => {
  it("🔴 走査が呼び出しを実際に見つけている（⛔ 空回りの検出点）", () => {
    // 本番の主張は「空集合」の形なので、走査が壊れて1件も見つけなくても緑になる。先に「見つけている」ことを固定する。
    expect(
      new Set(callerFiles),
      `${CONFORMANCE_FN}(…) の呼び出しをリポジトリ内に1つも見つけられなかった。` +
        "⟹ 適合テストの配線が消えたか、走査の取り出し方が古くなっている。" +
        "どちらにせよ、この下の歯は何も測っていない。",
    ).not.toEqual(new Set());
  });

  it("⭐ すべての呼び出しが setDefaultHalfLifeHours を渡している", () => {
    const offenders = callerFiles.flatMap((file) =>
      findCallsMissingHook(
        readFileSync(join(repoRoot, file), "utf8"),
        CONFORMANCE_FN,
        REQUIRED_HOOK,
      ).map((call) => ({ where: `${file}:${call.line}`, reason: call.reason })),
    );

    expect(
      new Set(offenders.map((o) => o.where)),
      "🔴 赤の意味: この呼び出しが " +
        `${REQUIRED_HOOK} を渡していない。渡さないと ` +
        "`packages/testkit/src/tenant-settings-store-conformance.ts` の " +
        "`if (setDefaultHalfLifeHours) { it(…) }` に入っている**2本の歯** " +
        "（`設定済みのテナントにはその値を返す` と " +
        "`⭐ half-life だけを設定した…テナントは unlimited`）が、" +
        "**`it.skip` にすらならず登録もされず、テストの出力から丸ごと消える** " +
        "——「通った」のか「そもそも走らなかった」のかが外から区別できなくなる。\n" +
        offenders.map((o) => `  ${o.where}: ${o.reason}`).join("\n"),
    ).toEqual(new Set());
  });

  it("🔴 陰性対照（空回り防止）: 現物の呼び出しから1つだけフックを剥がすと、その1つだけが挙がる", () => {
    // 弾くものと弾いてはいけないものを混ぜた陰性対照（空=空だけの歯は、何も測っていない場合と区別できない）。
    expect(
      new Set(callerFiles.slice(0, 2)),
      "現物の呼び出し側が2つ未満しか無いので、この混合の陰性対照は成立しない。",
    ).toHaveProperty("size", 2);

    const [target, untouched] = callerFiles;
    const strippedSource = readFileSync(join(repoRoot, target), "utf8").replace(
      new RegExp(`(^\\s*)${REQUIRED_HOOK}(\\s*:)`, "m"),
      "$1__hook_removed_by_this_tooth__$2",
    );

    const flagged = new Set([
      ...findCallsMissingHook(strippedSource, CONFORMANCE_FN, REQUIRED_HOOK).map(
        (call) => `${target}:${call.line}`,
      ),
      ...findCallsMissingHook(
        readFileSync(join(repoRoot, untouched), "utf8"),
        CONFORMANCE_FN,
        REQUIRED_HOOK,
      ).map((call) => `${untouched}:${call.line}`),
    ]);

    const targetLine = findConformanceCalls(
      readFileSync(join(repoRoot, target), "utf8"),
      CONFORMANCE_FN,
    )[0].line;

    expect(flagged).toEqual(new Set([`${target}:${targetLine}`]));
  });
});
