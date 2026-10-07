#!/usr/bin/env node
/**
 * ⛔ `npm install` は `--install-strategy=nested`（hoist しない）で行う。hoist すると、`dependencies` に
 * 宣言し忘れた依存も別のパッケージが持っていれば解決できてしまい、pnpm の厳格な配置の利用者だけが
 * `Cannot find package` で止まる形を見逃す。
 * `--ignore-scripts` は、依存の install スクリプト（onnxruntime-node の CUDA 用バイナリなど）が
 * registry の外へ取りに行くのを止める。
 * ⚠ 既定の CI には入れていない（リリース前に人が打つ）。registry から依存を取り、ロックファイル無しで
 * 範囲を解決するので、上流の新しい版で PR と無関係に赤になりうる。
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  EXPECTED_ENTRY_POINTS,
  buildSmokeCjs,
  buildSmokeMjs,
  buildSmokeTs,
  buildTsconfig,
  collectValueNamesForEntries,
  compareEntryPoints,
  entryPointsFromExports,
} from "./check-consumer-install-lib.mjs";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const keep = process.argv.includes("--keep");
const rootPkg = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8"));

const steps = [];
function step(name, fn) {
  const started = Date.now();
  const result = fn();
  steps.push({ name, ms: Date.now() - started, ok: result.ok });
  const mark = result.ok ? "✔" : "✖";
  console.log(`${mark} ${name}（${((Date.now() - started) / 1000).toFixed(1)} 秒）`);
  if (!result.ok) {
    console.error(result.reason);
  }
  return result;
}
function run(cmd, args, cwd) {
  const r = spawnSync(cmd, args, { cwd, encoding: "utf8" });
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`.trim();
  return r.status === 0
    ? { ok: true, out }
    : {
        ok: false,
        reason: `\`${cmd} ${args.join(" ")}\` が exit ${r.status}:\n${out.slice(-4000)}`,
      };
}

const packDir = mkdtempSync(join(tmpdir(), "mnemora-consumer-pack-"));
const consumerDir = mkdtempSync(join(tmpdir(), "mnemora-consumer-"));
let failed = false;
try {
  let tarballs = [];
  const pack = step("pack（scripts/pack-publish-targets.mjs）", () => {
    const r = run(
      process.execPath,
      [join(REPO_ROOT, "scripts/pack-publish-targets.mjs"), packDir],
      REPO_ROOT,
    );
    if (!r.ok) return r;
    tarballs = readFileSync(join(packDir, "publish-order.txt"), "utf8")
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
    return tarballs.length > 0
      ? { ok: true }
      : { ok: false, reason: "publish-order.txt が空だった。" };
  });
  if (!pack.ok) throw new Error("pack");

  const entries = step("tarball の exports と、利用者が頼ってよい入口の一覧の突き合わせ", () => {
    const actual = [];
    for (const tgz of tarballs) {
      const r = run("tar", ["-xzOf", tgz, "package/package.json"], packDir);
      if (!r.ok) return r;
      actual.push(...entryPointsFromExports(JSON.parse(r.out)));
    }
    const { missing, unexpected } = compareEntryPoints(EXPECTED_ENTRY_POINTS, actual);
    if (missing.length === 0 && unexpected.length === 0) return { ok: true };
    return {
      ok: false,
      reason:
        (missing.length > 0 ? `tarball の exports に無い入口: ${missing.join(", ")}\n` : "") +
        (unexpected.length > 0
          ? `一覧に無い入口（新しく足したなら scripts/check-consumer-install-lib.mjs の EXPECTED_ENTRY_POINTS にも足すこと）: ${unexpected.join(", ")}`
          : ""),
    };
  });
  if (!entries.ok) failed = true;

  writeFileSync(
    join(consumerDir, "package.json"),
    `${JSON.stringify({ name: "mnemora-consumer-install-check", private: true, version: "0.0.0", type: "module" }, null, 2)}\n`,
  );
  const install = step(
    "repo の外へ npm install（--ignore-scripts、--install-strategy=nested）",
    () =>
      run(
        "npm",
        [
          "install",
          "--no-audit",
          "--no-fund",
          "--ignore-scripts",
          "--install-strategy=nested",
          ...tarballs.map((t) => `file:${t}`),
          `typescript@${rootPkg.devDependencies.typescript}`,
          `@types/node@${rootPkg.devDependencies["@types/node"]}`,
        ],
        consumerDir,
      ),
  );
  if (!install.ok) throw new Error("install");

  const valueNames = collectValueNamesForEntries(EXPECTED_ENTRY_POINTS, REPO_ROOT);
  writeFileSync(join(consumerDir, "smoke.ts"), buildSmokeTs(EXPECTED_ENTRY_POINTS));
  writeFileSync(join(consumerDir, "smoke.mjs"), buildSmokeMjs(EXPECTED_ENTRY_POINTS, valueNames));
  writeFileSync(join(consumerDir, "smoke.cjs"), buildSmokeCjs(EXPECTED_ENTRY_POINTS, valueNames));
  const tsc = join(consumerDir, "node_modules", "typescript", "bin", "tsc");
  for (const mr of ["node16", "bundler"]) {
    writeFileSync(join(consumerDir, `tsconfig.${mr}.json`), buildTsconfig(mr));
    const r = step(`型検査（moduleResolution: ${mr}、skipLibCheck: true）`, () =>
      run(process.execPath, [tsc, "-p", `tsconfig.${mr}.json`], consumerDir),
    );
    if (!r.ok) failed = true;
  }
  const esm = step("ESM で全入口を import", () =>
    run(process.execPath, ["smoke.mjs"], consumerDir),
  );
  if (!esm.ok) failed = true;
  const cjs = step("CommonJS で全入口を require（require(esm)）", () =>
    run(process.execPath, ["smoke.cjs"], consumerDir),
  );
  if (!cjs.ok) failed = true;
} catch {
  failed = true;
} finally {
  if (!keep) {
    rmSync(packDir, { recursive: true, force: true });
    rmSync(consumerDir, { recursive: true, force: true });
  } else {
    console.log(`一時ディレクトリを残した: ${packDir} / ${consumerDir}`);
  }
}

const total = steps.reduce((s, x) => s + x.ms, 0);
console.log(
  `\n${failed ? "✖ 外から入れた確認に失敗した" : "✔ 外から入れた確認を通った"}（入口 ${EXPECTED_ENTRY_POINTS.length} 個、合計 ${(total / 1000).toFixed(1)} 秒）。`,
);
console.log(
  "⚠ この確認が見ていない範囲: 実行時の振る舞い（DB・実 API）、CommonJS から require したときの型、" +
    "skipLibCheck: false（drizzle-orm の型定義そのものがエラーを出す。packages/postgres/README.md）、" +
    "README の例が自分の依存として要求するもの（#1117 の zod・@mnemora/openai のような、利用者の install 行の不足）。" +
    "依存はロックファイル無しで解決するので、上流の新しい版によって結果が変わりうる（ADR 0346）。",
);
process.exit(failed ? 1 : 0);
