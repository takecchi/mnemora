#!/usr/bin/env node
/**
 * ⚠ 既存の ADR は1本もリネームしない。動かすのは、このブランチが `origin/main` に対して新しく追加した
 * `docs/decisions/*.md` のうち、番号が `origin/main` 側で既に使われているものだけ。
 *
 * `--next` は助けにしかならない。他の PR が同時に同じ番号を選べば衝突しうるので、
 * 確定させるのは引数無しの既定動作のほう。
 *
 * ⛔ この道具自身は `gh` を呼ばない。付け替え後の PR タイトル・本文の直しは、警告で促すだけ。
 * 付け替えが起きなかったときは何も出さない(毎回出ると読み飛ばされる)。
 *
 * 🔴 `rewriteReferencesInText` は `ADR ` に直接続く旧番号しか書き換えない。`ADR 0270 / 0271` の
 * ような連なりの2番目以降は届かないので、`performRenumber()` は残った旧番号を `file:line` つきで
 * 標準エラーへ出し、`process.exitCode = 1` で終わる。
 * ⛔ 書き換えはしない。射程を広げると無関係な4桁数字を巻き込む。確定と書き込みは人に残す。
 */
import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { assertWellFormedAdrFilenames, isAdrFilename } from "./generate-adr-index-lib.mjs";
import {
  addedLineNumbers,
  findUnrewrittenAdrReferences,
  parseAdrFilename,
  pickNextFreeNumber,
  planRenumbering,
  renumberedReferenceWarning,
  rewriteReferencesInText,
} from "./adr-renumber-lib.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..");
const decisionsPrefix = "docs/decisions/";

function run(cmd, args, options = {}) {
  const result = spawnSync(cmd, args, { cwd: repoRoot, encoding: "utf8", ...options });
  if (result.status !== 0) {
    const err = new Error(
      `${cmd} ${args.join(" ")} が失敗した (exit ${result.status}): ${result.stderr}`,
    );
    err.stderr = result.stderr;
    err.status = result.status;
    throw err;
  }
  return result.stdout;
}

function tryRun(cmd, args, options = {}) {
  try {
    return run(cmd, args, options);
  } catch {
    return null;
  }
}

function adrNumbersFromRef(ref, { strict = false } = {}) {
  const out = tryRun("git", ["ls-tree", "-r", "--name-only", ref, "--", "docs/decisions/"]);
  if (out === null) return [];
  const paths = out
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  // `origin/main` の分だけ strict。他のブランチの分は、その枝の持ち主の責任。
  if (strict) assertWellFormedAdrFilenames(directChildNames(paths));
  return paths
    .map((path) => basename(path))
    .filter((filename) => isAdrFilename(filename))
    .map((filename) => parseAdrFilename(filename).number);
}

function directChildNames(paths) {
  return paths
    .filter((p) => p.startsWith(decisionsPrefix) && !p.slice(decisionsPrefix.length).includes("/"))
    .map((p) => p.slice(decisionsPrefix.length));
}

function parseArgs(argv) {
  const modes = argv.filter((a) => a === "--check" || a === "--next");
  if (modes.length > 1) {
    console.error("--check と --next は同時に指定できません。");
    process.exit(3);
  }
  return { check: argv.includes("--check"), next: argv.includes("--next") };
}

function loadAddedAdrFiles() {
  // 二点 diff(working tree 対 origin/main)を使う。三点 diff は commit 済みの差分しか見ず、
  // この CLI 自身が行う `git mv` はコミット前の作業木の変更なので拾えない。
  const diffOut = run("git", [
    "diff",
    "--diff-filter=A",
    "--name-only",
    "origin/main",
    "--",
    "docs/decisions/",
  ]);
  const addedPaths = diffOut
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && line.startsWith(decisionsPrefix));
  assertWellFormedAdrFilenames(directChildNames(addedPaths));
  return addedPaths
    .map((path) => basename(path))
    .filter((filename) => isAdrFilename(filename))
    .map((filename) => ({ filename }));
}

function buildPlan() {
  const mainNumbers = adrNumbersFromRef("origin/main", { strict: true });
  const addedFiles = loadAddedAdrFiles();
  const plan = planRenumbering(mainNumbers, addedFiles);
  return { plan, addedCount: addedFiles.length };
}

function runCheck() {
  tryRun("git", ["fetch", "origin", "main", "--quiet"]);
  const { plan, addedCount } = buildPlan();
  if (addedCount === 0) {
    console.log("origin/main に対して新しく追加された ADR ファイルはありません。");
    process.exit(0);
  }
  const conflicts = plan.filter((p) => p.renamed);
  if (conflicts.length === 0) {
    for (const p of plan) {
      console.log(`衝突なし: docs/decisions/${p.oldFilename}`);
    }
    process.exit(0);
  }
  console.error(`衝突あり: ${conflicts.length} 件。`);
  for (const c of conflicts) {
    console.error(
      `  docs/decisions/${c.oldFilename} — 番号 ${c.oldNumber} は origin/main で既に使われています（次の空き番号: ${c.newNumber}）`,
    );
  }
  process.exit(1);
}

function runNext() {
  tryRun("git", ["fetch", "origin", "main", "--quiet"]);
  const fetchBranchesResult = tryRun("git", [
    "fetch",
    "origin",
    "+refs/heads/*:refs/remotes/origin/*",
    "--quiet",
  ]);
  if (fetchBranchesResult === null) {
    console.error(
      "⚠ リモートブランチの一覧を更新できませんでした（ネットワーク不通等）。ローカルに既にある refs/remotes/origin/* だけを使います。",
    );
  }

  const mainNumbers = adrNumbersFromRef("origin/main");

  const refsOut = tryRun("git", [
    "for-each-ref",
    "--format=%(refname:short)",
    "refs/remotes/origin",
  ]);
  const branchRefs =
    refsOut === null
      ? []
      : refsOut
          .split("\n")
          .map((l) => l.trim())
          .filter((l) => l.length > 0 && l !== "origin/HEAD" && l !== "origin/main");

  const branchNumbers = new Set();
  for (const ref of branchRefs) {
    for (const n of adrNumbersFromRef(ref)) branchNumbers.add(n);
  }

  const prNumbers = new Set();
  let ghAvailable = true;
  const prListOut = tryRun("gh", [
    "pr",
    "list",
    "--state",
    "open",
    "--json",
    "number",
    "-q",
    ".[].number",
  ]);
  if (prListOut === null) {
    ghAvailable = false;
  } else {
    const prList = prListOut
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
    for (const prNumber of prList) {
      const filesOut = tryRun("gh", [
        "pr",
        "view",
        prNumber,
        "--json",
        "files",
        "-q",
        ".files[].path",
      ]);
      if (filesOut === null) continue;
      for (const path of filesOut
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l.length > 0)) {
        if (!path.startsWith(decisionsPrefix)) continue;
        const filename = basename(path);
        if (isAdrFilename(filename)) prNumbers.add(parseAdrFilename(filename).number);
      }
    }
  }

  if (!ghAvailable) {
    console.error(
      "⚠ `gh` が使えないため、open な PR の主張は見ていません。origin/main と他のリモートブランチだけで判定します（静かに劣化させていません——この行がその告知です）。",
    );
  }

  const used = new Set([...mainNumbers, ...branchNumbers, ...prNumbers]);
  console.log(`origin/main の ADR 数: ${mainNumbers.length}`);
  console.log(`見た他のリモートブランチ: ${branchRefs.length} 本`);
  console.log(
    `見た open な PR: ${ghAvailable ? prNumbers.size + " 本の ADR 主張" : "(gh 不可のため無し)"}`,
  );
  const next = pickNextFreeNumber(used);
  console.log(`次の空き番号（楽観的な最初の1本用。確定はマージ直前の既定動作が行う）: ${next}`);
}

function performRenumber() {
  tryRun("git", ["fetch", "origin", "main", "--quiet"]);
  const { plan, addedCount } = buildPlan();

  if (addedCount === 0) {
    console.log("origin/main に対して新しく追加された ADR ファイルはありません。何もしません。");
    process.exit(0);
  }

  const conflicts = plan.filter((p) => p.renamed);
  if (conflicts.length === 0) {
    console.log(`衝突なし（新しく追加された ADR ${addedCount} 本）。何も変更しません。`);
    for (const p of plan) console.log(`  docs/decisions/${p.oldFilename}`);
    process.exit(0);
  }

  console.log(`衝突を検出しました（${conflicts.length} 件）。付け替えます:`);
  for (const c of conflicts) {
    const oldPath = `docs/decisions/${c.oldFilename}`;
    const newPath = `docs/decisions/${c.newFilename}`;
    console.log(`  git mv ${oldPath} ${newPath}`);
    run("git", ["mv", oldPath, newPath]);
  }

  const renames = conflicts.map((c) => ({
    oldNumber: c.oldNumber,
    newNumber: c.newNumber,
    slug: c.slug,
  }));

  // ⚠ 書き換えは「origin/main に対してこのブランチが変更した行」だけ。継承した行には、
  // 衝突した番号への正当な言及が多数あるので、巻き込まない。
  const changedFiles = run("git", ["diff", "--name-only", "origin/main"])
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  let touchedFiles = 0;
  // 🔴 ⛔ `rewriteReferencesInText` が届かない位置の旧番号は、検出して人に渡すだけで書き換えない。
  const unrewrittenHits = [];
  for (const relPath of changedFiles) {
    const absPath = join(repoRoot, relPath);
    let buf;
    try {
      buf = readFileSync(absPath);
    } catch {
      continue;
    }
    if (buf.includes(0)) continue;

    const diffText = run("git", ["diff", "--unified=0", "origin/main", "--", relPath]);
    const addedLines = addedLineNumbers(diffText);
    if (addedLines.size === 0) continue;

    const lines = buf.toString("utf8").split("\n");
    const fileChanges = [];
    for (const lineNo of addedLines) {
      const idx = lineNo - 1;
      if (idx < 0 || idx >= lines.length) continue;
      const { text: newLine, changes } = rewriteReferencesInText(lines[idx], renames);
      // 書き換えの成否に関わらず見る。何も書き換わらなかった行にも旧番号が残りうる。
      for (const hit of findUnrewrittenAdrReferences(newLine, renames)) {
        unrewrittenHits.push({ file: relPath, lineNo, lineText: newLine, ...hit });
      }
      if (changes.length === 0) continue;
      lines[idx] = newLine;
      fileChanges.push(...changes);
    }
    if (fileChanges.length === 0) continue;

    writeFileSync(absPath, lines.join("\n"), "utf8");
    touchedFiles += 1;
    console.log(`${relPath}:`);
    for (const c of fileChanges) {
      const label = c.type === "stem" ? "ファイル名参照" : '"ADR NNNN" 表記';
      console.log(`  ${label}: ADR ${c.oldNumber} -> ADR ${c.newNumber}（${c.count} 箇所）`);
    }
  }

  console.log(
    `完了。${conflicts.length} 本の ADR を付け替え、${touchedFiles} ファイルの参照を書き換えました。`,
  );

  const warning = renumberedReferenceWarning(conflicts);
  if (warning) {
    console.error(warning);
  }

  if (unrewrittenHits.length > 0) {
    console.error(
      `\n🔴 付け替えられずに残った参照が ${unrewrittenHits.length} 件あります` +
        "（`ADR NNNN / MMMM` のような略記の連なりの2番目以降は、この道具の書き換えが構造的に届きません）。",
    );
    for (const h of unrewrittenHits) {
      console.error(`  ${h.file}:${h.lineNo}: ADR ${h.oldNumber} が残っています —— ${h.match}`);
      console.error(`    ${h.lineText.trim()}`);
    }
    console.error(
      "\n⟹ 機械はここまでしか見ません。上の行を人が読んで、正しい新番号へ手で直してください" +
        "（この道具は書き換えません——AGENTS.md「⚠ 機械には『検出』まで」）。",
    );
    process.exitCode = 1;
  }
}

function main() {
  const { check, next } = parseArgs(process.argv.slice(2));
  if (next) {
    runNext();
    return;
  }
  if (check) {
    runCheck();
    return;
  }
  performRenumber();
}

main();
