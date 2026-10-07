const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;

/**
 * ⛔ 先頭の `v` を剥がすだけにしない。`vfoo` が `foo` として `package.json` に書き込まれ、
 * `pnpm pack` が文句を言わずに `mnemora-core-foo.tgz` を作る。semver として妥当であることまで見る。
 *
 * @param {string | undefined | null} tagName Release の tag（`v0.1.2` を想定）
 * @returns {{ ok: true, version: string } | { ok: false, reason: string }}
 */
export function versionFromTag(tagName) {
  if (typeof tagName !== "string" || tagName.length === 0) {
    return { ok: false, reason: "tag が空です。" };
  }
  if (!tagName.startsWith("v")) {
    return {
      ok: false,
      reason: `tag は "v" で始まる必要があります（例: v0.1.2）。受け取ったもの: ${JSON.stringify(tagName)}`,
    };
  }
  const version = tagName.slice(1);
  if (!SEMVER.test(version)) {
    return {
      ok: false,
      reason: `tag から取り出した版が semver ではありません: ${JSON.stringify(version)}（tag: ${JSON.stringify(tagName)}）`,
    };
  }
  return { ok: true, version };
}

/**
 * ⛔ GitHub の pre-release チェックと semver の prerelease 部は別物。
 * どちらか一方でも prerelease なら `next` にする（`latest` を汚すと取り消せない）。
 *
 * @param {{ version: string, githubPrerelease: boolean }} input
 * @returns {{ npmTag: "latest" | "next", warnings: string[] }}
 */
export function distTagFor({ version, githubPrerelease }) {
  const warnings = [];
  const semverPrerelease = version.includes("-");

  if (semverPrerelease && !githubPrerelease) {
    warnings.push(
      `版 ${version} は semver の prerelease ですが、Release は pre-release として作られていません。` +
        `latest を汚さないため next へ入れます。`,
    );
  }
  if (!semverPrerelease && githubPrerelease) {
    warnings.push(
      `Release は pre-release ですが、版 ${version} は semver の prerelease ではありません。next へ入れます。`,
    );
  }

  return { npmTag: semverPrerelease || githubPrerelease ? "next" : "latest", warnings };
}
