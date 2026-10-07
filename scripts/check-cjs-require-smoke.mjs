#!/usr/bin/env node
/**
 * ⛔ `scripts/check-consumer-install.mjs` の1〜5段は引き継がない。registry から新しく取りに行かない設計にして、
 * 「既定の CI に入れない理由」（約550MB の取り直し・上流の新しい版で PR と無関係に赤になる）を外した。
 * 実行時依存は `npm install` を使わず、この作業ツリーが `pnpm install --frozen-lockfile` で解決済みの実体へ symlink する。
 * ⚠ 見ないこと（check-consumer-install.mjs が見続ける）: 型・ESM 経路・依存の版のずれ、
 * 依存の宣言漏れ（モノレポ内の別の場所で解決できれば見逃す）。
 */
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  EXPECTED_ENTRY_POINTS,
  buildSmokeCjs,
  collectValueNamesForEntries,
} from "./check-consumer-install-lib.mjs";
import {
  externalRuntimeDependencyNames,
  meetsRequireEsmNodeVersion,
} from "./check-cjs-require-smoke-lib.mjs";
import { PUBLISH_TARGETS } from "./publish-targets.mjs";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const keep = process.argv.includes("--keep");

if (!meetsRequireEsmNodeVersion(process.version)) {
  console.error(
    `この node（${process.version}）は Node 22.12 未満である。README の約束（「CommonJS からは ` +
      `Node 22.12 以降の require(esm) で読み込める」）は 22.12 未満では成り立たない——このまま ` +
      "実行しても確かめたことにならないので、ここで止める。",
  );
  process.exit(1);
}

/**
 * ディレクトリ名では判定できない（pnpm はスコープ・peer 依存でサフィックスが付いた名前で実体を持つ）。
 * `package.json` の `name` で判定する。
 *
 * @param {string} resolvedFile
 * @param {string} depName
 * @returns {string}
 */
function packageRootFromResolvedFile(resolvedFile, depName) {
  let dir = dirname(resolvedFile);
  while (true) {
    const pkgJsonPath = join(dir, "package.json");
    if (existsSync(pkgJsonPath)) {
      const pkg = JSON.parse(readFileSync(pkgJsonPath, "utf8"));
      if (pkg.name === depName) return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) {
      throw new Error(
        `${depName} の package.json（name が一致するもの）が ${resolvedFile} の上に見つからない`,
      );
    }
    dir = parent;
  }
}

const steps = [];
function step(name, fn) {
  const started = Date.now();
  const result = fn();
  steps.push({ name, ms: Date.now() - started, ok: result.ok });
  const mark = result.ok ? "✔" : "✖";
  console.log(`${mark} ${name}（${((Date.now() - started) / 1000).toFixed(1)} 秒）`);
  if (!result.ok) console.error(result.reason);
  return result;
}

const packDir = mkdtempSync(join(tmpdir(), "mnemora-cjs-smoke-pack-"));
const consumerDir = mkdtempSync(join(tmpdir(), "mnemora-cjs-smoke-consumer-"));
let failed = false;
try {
  const tarballByName = new Map();
  const pack = step("pack（scripts/pack-publish-targets.mjs）", () => {
    const r = spawnSync(
      process.execPath,
      [join(REPO_ROOT, "scripts/pack-publish-targets.mjs"), packDir],
      { cwd: REPO_ROOT, encoding: "utf8" },
    );
    const out = `${r.stdout ?? ""}${r.stderr ?? ""}`.trim();
    if (r.status !== 0) return { ok: false, reason: out.slice(-4000) };
    const order = readFileSync(join(packDir, "publish-order.txt"), "utf8")
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
    if (order.length !== PUBLISH_TARGETS.length) {
      return {
        ok: false,
        reason: `publish-order.txt の件数（${order.length}）が PUBLISH_TARGETS（${PUBLISH_TARGETS.length}）と合わない。`,
      };
    }
    order.forEach((tgz, i) => tarballByName.set(PUBLISH_TARGETS[i].name, tgz));
    return { ok: true };
  });
  if (!pack.ok) throw new Error("pack");

  const extract = step(
    "tarball を consumer の node_modules へ自分で展開する（npm install を使わない）",
    () => {
      mkdirSync(join(consumerDir, "node_modules"), { recursive: true });
      for (const target of PUBLISH_TARGETS) {
        const tgz = tarballByName.get(target.name);
        const destDir = join(consumerDir, "node_modules", target.name);
        mkdirSync(destDir, { recursive: true });
        const r = spawnSync("tar", ["-xzf", tgz, "-C", destDir, "--strip-components=1"], {
          encoding: "utf8",
        });
        if (r.status !== 0) return { ok: false, reason: `${target.name}: ${r.stderr ?? r.stdout}` };
      }
      return { ok: true };
    },
  );
  if (!extract.ok) throw new Error("extract");

  const link = step(
    "外部の実行時依存を、この作業ツリーが既に解決済みの実体へ symlink する（registry に出ない）",
    () => {
      const sourcePkgs = PUBLISH_TARGETS.map((t) =>
        JSON.parse(readFileSync(join(REPO_ROOT, t.dir, "package.json"), "utf8")),
      );
      const linked = new Map(); // name -> root（同じ名前が別の実体を指したら矛盾として落とす）
      for (let i = 0; i < PUBLISH_TARGETS.length; i++) {
        const target = PUBLISH_TARGETS[i];
        const names = externalRuntimeDependencyNames(sourcePkgs[i]);
        const req = createRequire(join(REPO_ROOT, target.dir, "package.json"));
        for (const name of names) {
          let resolvedFile;
          try {
            resolvedFile = req.resolve(name);
          } catch (error) {
            return {
              ok: false,
              reason: `${target.name} の依存 ${name} を作業ツリーから解決できなかった: ${error.message}`,
            };
          }
          let root;
          try {
            root = packageRootFromResolvedFile(resolvedFile, name);
          } catch (error) {
            return { ok: false, reason: error.message };
          }
          const already = linked.get(name);
          if (already !== undefined && already !== root) {
            return {
              ok: false,
              reason: `${name} が2つの実体に解決した（${already} と ${root}）。モノレポ内で版が割れている可能性がある。`,
            };
          }
          linked.set(name, root);
        }
      }
      for (const [name, root] of linked) {
        const dest = join(consumerDir, "node_modules", name);
        mkdirSync(dirname(dest), { recursive: true });
        symlinkSync(root, dest, "dir");
      }
      return { ok: true };
    },
  );
  if (!link.ok) throw new Error("link");

  writeFileSync(
    join(consumerDir, "package.json"),
    `${JSON.stringify({ name: "mnemora-cjs-require-smoke", private: true, version: "0.0.0" }, null, 2)}\n`,
  );
  const valueNames = collectValueNamesForEntries(EXPECTED_ENTRY_POINTS, REPO_ROOT);
  writeFileSync(join(consumerDir, "smoke.cjs"), buildSmokeCjs(EXPECTED_ENTRY_POINTS, valueNames));
  const cjs = step("CommonJS で全入口を require（require(esm)、README の約束そのもの）", () => {
    const r = spawnSync(process.execPath, ["smoke.cjs"], { cwd: consumerDir, encoding: "utf8" });
    const out = `${r.stdout ?? ""}${r.stderr ?? ""}`.trim();
    return r.status === 0 ? { ok: true } : { ok: false, reason: out.slice(-4000) };
  });
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
  `\n${failed ? "✖ CommonJS require(esm) の確認に失敗した" : "✔ CommonJS require(esm) の確認を通った"}（入口 ${EXPECTED_ENTRY_POINTS.length} 個、合計 ${(total / 1000).toFixed(1)} 秒）。`,
);
console.log(
  "⚠ この確認が見ていない範囲: 型・ESM 経路・依存の宣言漏れ・依存の版が registry の最新とずれていないか・" +
    "README の例が自分の依存として要求するもの。これらは `pnpm run check:consumer-install`（ADR 0346。" +
    "リリース前に人が打つ）が見る。",
);
process.exit(failed ? 1 : 0);
