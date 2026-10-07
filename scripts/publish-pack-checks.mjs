/**
 * `check-publish-pack.mjs` は import された瞬間に本物の `pnpm pack` を走らせる。判定関数だけをここへ分けて、
 * 歯が `pnpm pack` を走らせずに合成フィクスチャで各関数の噛み方を測れるようにしている。
 * 副作用(`console.log` / `process.exit` / 子プロセス起動)を持たせたくなったら、`check-publish-pack.mjs` 側に置く。
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

export function findWorkspaceProtocolViolations(manifest) {
  const violations = [];
  for (const field of ["dependencies", "peerDependencies", "optionalDependencies"]) {
    const deps = manifest[field];
    if (!deps) continue;
    for (const [depName, range] of Object.entries(deps)) {
      if (typeof range === "string" && range.startsWith("workspace:")) {
        violations.push(`${field}.${depName} = "${range}"`);
      }
    }
  }
  return violations;
}

const EXACT_SEMVER_RE = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/;

/**
 * `dependencies`(実行時依存)だけを見る。`devDependencies` は公開 tarball に入らず下流の dedupe を壊さないので、
 * `save-exact=true` はそのまま効かせ続ける。公開した `dependencies` が完全固定だと、下流が同じパッケージの
 * 新しい版を持っていても dedupe できず、型が構造的に非互換になりうる(zod は `_zod.version.minor` を型に埋める)。
 * `exemptDependencyNames` は `EXACT_PINNED_DEPENDENCY_EXEMPTIONS` に負債として名指しで残す。消せば検査が始まる。
 */
export function findExactPinnedDependencyViolations(manifest, exemptDependencyNames = []) {
  const violations = [];
  const deps = manifest.dependencies;
  if (!deps) return violations;
  const exempt = new Set(exemptDependencyNames);
  for (const [depName, range] of Object.entries(deps)) {
    if (exempt.has(depName)) continue;
    if (typeof range === "string" && EXACT_SEMVER_RE.test(range)) {
      violations.push(
        `dependencies.${depName} = "${range}"（完全固定。範囲指定（例: "^${range}"）にすること）`,
      );
    }
  }
  return violations;
}

/**
 * ⚠ これは「問題ない」の一覧ではなく「未確認のまま残した負債」の一覧。Issue #166 が実測で報告したのは zod のみで、
 * 他の依存が同じ下流2本化を起こすかは確認していない(`docs/autonomy.md` §2「ついでに直さない」)。
 * `@mnemora/bullmq` の `bullmq` だけは例外で、積極的に固定を選んだ理由が在る(ADR 0325)。
 *
 * 唯一の定義。`check-publish-pack.mjs` とテストの両方がここから import する。2箇所に写しを置いて
 * ずれた前例がある(`PUBLISH_TARGETS`、ADR 0066)。
 */
export const EXACT_PINNED_DEPENDENCY_EXEMPTIONS = {
  "@mnemora/openai": ["openai"],
  "@mnemora/anthropic": ["@anthropic-ai/sdk"],
  "@mnemora/postgres": ["@types/pg", "drizzle-orm", "pg"],
  "@mnemora/local-embedding": ["@huggingface/transformers"],
  // `bullmq` は固定を意図して残す(ADR 0325)。BullMQ 6.x の Job Scheduler API(`queue.upsertJobScheduler`)は
  // 5.x 以前には無く、範囲指定に緩めると、確かめていない次のメジャー版が `pnpm install` で黙って入りうる。
  "@mnemora/bullmq": ["bullmq"],
};

/**
 * git 上の `version` が `0.0.0` のままでよい publish 対象の名前の集合。publish 時には
 * `scripts/apply-release-version.mjs` が tag の版へ書き換える(ADR 0070)。git 上の `version` は
 * オーナーの持ち場で、道具の都合で手で版を振らない(ADR 0325)。
 * 載っている間は、`findVersionViolations` の対象から外し、`findVersionSkewViolations` の対象数からも外す。
 * 名前を消せば、他の対象と同じ検査を受ける。
 */
export const NEVER_PUBLISHED_TARGETS = new Set([]);

/**
 * `exports` を見る理由: Node と TypeScript は `exports` が在れば `main` / `types` を見ない。
 * `exports` の指す先だけが欠けた tarball は旧版の門を素通りし、使う側で `ERR_PACKAGE_PATH_NOT_EXPORTED` 等で落ちた(ADR 0066)。
 * 値が `null`(意図的に塞いだ subpath)は指し先が無いのが正しいので飛ばす。
 */
export function findMissingEntryPoints(manifest, packageDir) {
  const missing = [];
  const check = (label, relPath) => {
    if (!relPath) return;
    const absPath = resolve(packageDir, relPath);
    try {
      statSync(absPath);
    } catch {
      missing.push(`${label} -> ${relPath}`);
    }
  };
  check("main", manifest.main);
  check("types", manifest.types);
  if (manifest.bin) {
    if (typeof manifest.bin === "string") {
      check("bin", manifest.bin);
    } else {
      for (const [binName, binPath] of Object.entries(manifest.bin)) {
        check(`bin.${binName}`, binPath);
      }
    }
  }
  const walkExports = (label, node) => {
    if (node === null || node === undefined) return;
    if (typeof node === "string") {
      check(label, node);
      return;
    }
    if (Array.isArray(node)) {
      // exports の配列形は最初に解決できたものが使われるので、全件の実在は要求しない。
      const anyResolves = node.some((candidate) => {
        if (typeof candidate !== "string") return false;
        try {
          statSync(resolve(packageDir, candidate));
          return true;
        } catch {
          return false;
        }
      });
      if (!anyResolves) {
        missing.push(`${label} -> ${JSON.stringify(node)} のどれも実在しない`);
      }
      return;
    }
    for (const [key, value] of Object.entries(node)) {
      walkExports(`${label}${key.startsWith(".") ? key : `[${key}]`}`, value);
    }
  };
  if (manifest.exports !== undefined) {
    walkExports("exports", manifest.exports);
  }
  return missing;
}

/**
 * 作業ツリーではなく tarball 側を見る。`files` の絞り込み等で、作業ツリーに在る README が tarball に入らないことがある。
 * README が無くても publish は失敗せず、この歯が無いと気づかれない。
 */
export function findMissingReadme(packageDir) {
  try {
    statSync(join(packageDir, "README.md"));
    return [];
  } catch {
    return ["README.md が tarball に入っていません"];
  }
}

/**
 * `private: true` のままなら publish は止まるので、事故にはならない。守っているのは、`private` の状態と
 * 「publish してよい」という明示的な決定の一致(ADR 0060、0066)。
 */
export function findPrivateViolations(manifest) {
  if (manifest.private === undefined || manifest.private === false) return [];
  return [`private が立っています: ${JSON.stringify(manifest.private)}`];
}

export function findFiles(dir, predicate, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      findFiles(full, predicate, out);
    } else if (predicate(full)) {
      out.push(full);
    }
  }
  return out;
}

/**
 * 「`UNLICENSED` でないこと」ではなく `MIT` との等値を見る。前者は `Apache-2.0` のような隣の値も通す弱い歯になる(ADR 0061)。
 * 作業ツリーの `package.json` ではなく、tarball を展開して読んだ `manifest` を受け取る。
 */
export function findLicenseViolations(manifest, packageDir) {
  const violations = [];
  if (manifest.license !== "MIT") {
    violations.push(`license が "MIT" ではありません: ${JSON.stringify(manifest.license)}`);
  }
  try {
    statSync(join(packageDir, "LICENSE"));
  } catch {
    violations.push("LICENSE ファイルが tarball に入っていません");
  }
  return violations;
}

/**
 * ⚠ 版が正しい値かは決めていない(ADR 0070)。版の権威は Release の tag で、`apply-release-version.mjs` が publish 直前に書き込む。
 * 見るのは、初期値の `0.0.0` や未設定のまま出ないことだけ。`0.0.1` や prerelease は弾かない。
 */
export function findVersionViolations(manifest) {
  if (manifest.version === "0.0.0" || !manifest.version) {
    return [`version が未設定か 0.0.0 のままです: ${manifest.version}`];
  }
  return [];
}

/**
 * 単一パッケージ側とは別関数にしている。呼び出し側が全対象のループを回し終えたあとに、`versions` と `targetCount` を渡して1回だけ呼ぶため。
 * ⚠ `versions.length === targetCount` を条件にしているのは意図的(歯で固定する)。version 違反で落ちた回は揃い検査をしない。
 * 欠けた1件は別に報告済みで、不正確な文言で重ねて報告しないため。
 */
export function findVersionSkewViolations(versions, targetCount) {
  const distinctVersions = new Set(versions.map((v) => v.version));
  if (versions.length === targetCount && distinctVersions.size > 1) {
    return [
      `version が publish 対象で揃っていません: ${versions.map((v) => `${v.name}@${v.version}`).join(", ")}`,
    ];
  }
  return [];
}

/**
 * 「`restricted` でないこと」ではなく `public` との等値を見る(`findLicenseViolations` と同じ理由)。
 * `publishConfig` 自体が無い場合も違反: 「明示していない」を「public にすると決めていない」として扱う。
 */
export function findPublishAccessViolations(manifest) {
  if (manifest.publishConfig?.access !== "public") {
    return [
      `publishConfig.access が "public" ではありません: ${JSON.stringify(manifest.publishConfig)}`,
    ];
  }
  return [];
}

/**
 * ビルドは今は `.map` を出さないので、現物からは検出されない。壊した入力に対して検出することは、合成フィクスチャで別途測る必要がある。
 */
export function findOrphanedSourceMaps(packageDir) {
  const mapFiles = findFiles(packageDir, (path) => path.endsWith(".map"));
  const orphans = [];
  for (const mapFile of mapFiles) {
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(mapFile, "utf8"));
    } catch (error) {
      orphans.push(`${relative(packageDir, mapFile)}: JSON として読めない (${error.message})`);
      continue;
    }
    const sources = Array.isArray(parsed.sources) ? parsed.sources : [];
    for (const source of sources) {
      const resolved = resolve(dirname(mapFile), source);
      try {
        statSync(resolved);
      } catch {
        orphans.push(
          `${relative(packageDir, mapFile)}: sources に "${source}" とあるが tarball 内に無い`,
        );
      }
    }
  }
  return orphans;
}
