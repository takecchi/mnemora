#!/usr/bin/env node
/**
 * ⚠ `packages/<pkg>/package.json` の `version` は権威ある値ではない。権威は Release の tag。
 * 確かめるときは registry に訊く(`npm view @mnemora/core version`)。
 * 判定(tag → 版・dist-tag)は `./release-version.mjs` の純関数が持つ。ここは書くことと書けたことの確認だけをする。
 */
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PUBLISH_TARGETS } from "./publish-targets.mjs";
import { distTagFor, versionFromTag } from "./release-version.mjs";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

const tag = process.env.RELEASE_TAG;
const githubPrerelease = process.env.GITHUB_PRERELEASE === "true";

const parsed = versionFromTag(tag);
if (!parsed.ok) {
  console.error(`::error::Release の tag から版を決められません: ${parsed.reason}`);
  process.exit(1);
}
const { version } = parsed;

const { npmTag, warnings } = distTagFor({ version, githubPrerelease });
for (const w of warnings) console.log(`::warning::${w}`);

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * ⚠ JSON として読んで `JSON.stringify` で書き戻さない。prettier は `"files": ["dist"]` を1行に畳むが、
 * `JSON.stringify` は展開するので `format:check` が赤くなり、直後の門で publish が止まる。
 * `version` の行だけを差し替える。先頭2スペースに錨を打つのは、入れ子の `"version"` を掴まないため。
 */
const changed = [];
for (const target of PUBLISH_TARGETS) {
  const path = join(repoRoot, target.dir, "package.json");
  const source = readFileSync(path, "utf8");
  const manifest = JSON.parse(source);

  if (manifest.name !== target.name) {
    console.error(
      `::error::${target.dir} の name が ${JSON.stringify(manifest.name)} で、期待した ${target.name} と違います。`,
    );
    process.exit(1);
  }

  const before = manifest.version;
  const pattern = new RegExp(`^(  "version": )"${escapeRegExp(before)}"`, "m");
  if (!pattern.test(source)) {
    console.error(
      `::error::${target.name} の package.json に、差し替えるべき version の行が見つかりません` +
        `（現在の値: ${JSON.stringify(before)}）。整形が変わった可能性があります。`,
    );
    process.exit(1);
  }
  writeFileSync(path, source.replace(pattern, `$1"${version}"`));
  changed.push({ name: target.name, before, after: version });
}

// 書けたことは、書いた値ではなく読み直した値で確かめる。
for (const target of PUBLISH_TARGETS) {
  const path = join(repoRoot, target.dir, "package.json");
  const actual = JSON.parse(readFileSync(path, "utf8")).version;
  if (actual !== version) {
    console.error(
      `::error::${target.name} の version を ${version} に書いたはずが、読み直すと ${JSON.stringify(actual)} でした。`,
    );
    process.exit(1);
  }
}

console.log(`版: ${version} / dist-tag: ${npmTag}`);
for (const c of changed) {
  console.log(
    `  ${c.name}: ${c.before} -> ${c.after}${c.before === c.after ? "（変化なし）" : ""}`,
  );
}

if (process.env.GITHUB_OUTPUT) {
  appendFileSync(process.env.GITHUB_OUTPUT, `version=${version}\nnpm_tag=${npmTag}\n`);
}
