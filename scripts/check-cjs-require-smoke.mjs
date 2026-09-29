#!/usr/bin/env node
/**
 * README（`packages/core`・`packages/postgres` ほかの「前提」）が約束する
 * 「CommonJS からは Node 22.12 以降の `require(esm)` で読み込める」を、毎 PR の CI で確かめる（ADR 0387）。
 *
 * `scripts/check-consumer-install.mjs`（ADR 0346）の6段目と同じ約束を検査するが、あちらの
 * 1〜5段（pack → 入口の突き合わせ → npm registry から取った install → `tsc` 型検査 ×2 → ESM 実行）は
 * 引き継がない。ADR 0346 が測った「既定の CI に入れない理由」——npm registry から約550MB を
 * 取り直すこと・ロックファイル無しで依存の範囲を解決するので上流の新しい版で PR と無関係に赤に
 * なりうること——は、どちらも「registry から新しく取りに行く」ことが原因である。この段は
 * registry に一切出ない設計にすることで、その理由を外した。
 *
 * ## 何をするか
 *
 * 1. `scripts/pack-publish-targets.mjs`（`pack:check` と同じ道具、ADR 0066）で
 *    `PUBLISH_TARGETS` 全対象の tarball を作る。
 * 2. 各 tarball を、OS の一時ディレクトリ（repo の外）に作った空プロジェクトの
 *    `node_modules/<パッケージ名>` へ**自分で展開する**（`npm install` を使わない）。
 * 3. 各パッケージの実行時依存（`dependencies` と `peerDependencies`。`@mnemora/*` は除く——
 *    それは手順2の tarball 自身）を、**この作業ツリーが `pnpm install --frozen-lockfile`
 *    で既に解決済みの実体へ symlink する**（`createRequire` で対象パッケージ自身の視点から
 *    解決し、見つかった実体の package.json の `name` を確かめて symlink 先を決める）。
 *    registry には出ない——このジョブの手前の `pnpm install --frozen-lockfile` が
 *    ロックファイルどおりに解決済みのものを、そのまま再利用するだけである。
 * 4. `./check-consumer-install-lib.mjs` の `buildSmokeCjs(EXPECTED_ENTRY_POINTS)` で
 *    全入口を `require` する `smoke.cjs` を作り、node で実行する。
 *
 * ## 見ないこと（`scripts/check-consumer-install.mjs` が見続ける）
 *
 * - 型（`tsc` の `node16`/`bundler` 型検査）・ESM 経路（`import`）。
 * - 入口の一覧（`EXPECTED_ENTRY_POINTS`）と tarball の `exports` が揃っているかの突き合わせ
 *   ——これは registry 不要なので、既に `scripts/__tests__/check-consumer-install-lib.test.mjs`
 *   が既定の CI（`pnpm run test`）で見ている。
 * - 依存の宣言漏れ（`--install-strategy=nested` が防ぐ形）。このスクリプトは各パッケージの
 *   実行時依存を「この作業ツリーで今どう解決されているか」からそのまま symlink するので、
 *   たとえ `package.json` に書き忘れていても、モノレポ内の別の場所でその依存が解決できれば
 *   見逃す。
 * - 依存の版が npm registry の最新とずれていないか（そもそも registry を見ない）。
 * - README が利用者に要求する追加の依存（#1117 の `zod`・`@mnemora/openai`）。
 *
 * 純関数の部分（依存名の抽出・node 版の判定）は `./check-cjs-require-smoke-lib.mjs` に分けてあり、
 * `scripts/__tests__/check-cjs-require-smoke.test.mjs` が fs にもネットワークにも触れずに検査する。
 *
 * 使い方: `pnpm run check:cjs-require-smoke`（`--keep` で一時ディレクトリを残す）
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
import { EXPECTED_ENTRY_POINTS, buildSmokeCjs } from "./check-consumer-install-lib.mjs";
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
 * `resolvedFile`（`require.resolve` が返したファイル）から上に辿り、`package.json` の `name` が
 * `depName` と一致する最初のディレクトリ（＝そのパッケージの実体のルート）を返す。
 *
 * pnpm はスコープ付き・peer 依存でサフィックスが付いたディレクトリ名（例:
 * `.pnpm/openai@7.10.0_zod@4.5.4/node_modules/openai`）で実体を持つため、ディレクトリ名では
 * 判定できない——`package.json` の中身（`name`）で判定する。
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
  writeFileSync(join(consumerDir, "smoke.cjs"), buildSmokeCjs(EXPECTED_ENTRY_POINTS));
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
