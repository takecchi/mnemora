/**
 * 本体側(`scripts/check-cjs-require-smoke.mjs`)は import された瞬間に pack・展開・node 実行までやる。
 * 歯から import すると実際に tarball を作り始めるので、純関数はこちらに置く。
 */

/**
 * `peerDependencies` も対象。`@mnemora/testkit` の `vitest` のように、宣言だけして `dependencies` には入れない
 * 実行時依存がある。`devDependencies`・`optionalDependencies` は実行時に require されないので対象外。
 *
 * @param {{ dependencies?: Record<string, string>; peerDependencies?: Record<string, string> }} pkg
 * @returns {string[]}
 */
export function externalRuntimeDependencyNames(pkg) {
  return [
    ...Object.keys(pkg.dependencies ?? {}),
    ...Object.keys(pkg.peerDependencies ?? {}),
  ].filter((name) => !name.startsWith("@mnemora/"));
}

/**
 * @param {{ dependencies?: Record<string, string>; peerDependencies?: Record<string, string> }[]} pkgs
 * @returns {string[]}
 */
export function collectExternalRuntimeDependencyNames(pkgs) {
  return [...new Set(pkgs.flatMap(externalRuntimeDependencyNames))].sort();
}

/**
 * 満たさない node でこの確認が緑でも、README の約束を確かめたことにならない。
 * 満たさないなら実行前に赤で止める(呼び出し側の責務。ここは判定だけを返す)。
 *
 * @param {string} versionString `process.version`（例: `"v22.12.0"`）
 * @returns {boolean}
 */
export function meetsRequireEsmNodeVersion(versionString) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(versionString);
  if (!match) return false;
  const [major, minor] = match.slice(1).map(Number);
  return major > 22 || (major === 22 && minor >= 12);
}
