import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  MANIFEST_RELATIVE_PATH,
  MIGRATIONS_RELATIVE_DIR,
  appendUnpinned,
  compareChecksums,
  computeChecksums,
  describeFailure,
  parseManifest,
} from "./migration-checksums-lib.mjs";

/**
 * exit: 0 一致 / 1 書き換え・削除 / 2 名簿を読めない。
 */

const args = process.argv.slice(2);
const rootIdx = args.indexOf("--root");
const root = rootIdx >= 0 ? args[rootIdx + 1] : fileURLToPath(new URL("..", import.meta.url));
const write = args.includes("--write");

const manifestPath = join(root, MANIFEST_RELATIVE_PATH);
const actual = computeChecksums(join(root, MIGRATIONS_RELATIVE_DIR));

let pinned = {};
if (existsSync(manifestPath)) {
  try {
    pinned = parseManifest(readFileSync(manifestPath, "utf8"));
  } catch (err) {
    console.error(`migration checksum: 名簿を読めない: ${err.message}`);
    process.exit(2);
  }
} else if (!write) {
  console.error(
    `migration checksum: 名簿が無い（${MANIFEST_RELATIVE_PATH}）。` +
      "初回は `node scripts/check-migration-checksums.mjs --write` で作ること。",
  );
  process.exit(2);
}

if (write) {
  const result = compareChecksums(pinned, actual);
  if (result.changed.length > 0 || result.missing.length > 0) {
    // 既存の行は書き換えない。書き換えられたファイルを名簿に追従させてはいけない。
    console.error(describeFailure(result));
    console.error("名簿は書き換えていない。");
    process.exit(1);
  }
  writeFileSync(manifestPath, appendUnpinned(pinned, actual));
  console.log(`migration checksum: 名簿に ${result.unpinned.length} 件を足した。`);
  process.exit(0);
}

const result = compareChecksums(pinned, actual);
if (result.changed.length > 0 || result.missing.length > 0) {
  console.error("migration checksum: 出荷済みの migration が変わっている。");
  console.error(describeFailure(result));
  process.exit(1);
}
if (result.unpinned.length > 0) {
  console.log(
    `migration checksum: 名簿に無い新しいファイルがある（赤にはしない）: ${result.unpinned.join(", ")}。` +
      "出すときに `--write` で名簿へ足すこと。",
  );
}
console.log("migration checksum: 名簿のファイルはすべて一致");
