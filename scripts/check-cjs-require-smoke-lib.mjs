/**
 * `scripts/check-cjs-require-smoke.mjs`（README が約束する「CommonJS からは Node 22.12 以降の
 * `require(esm)` で読み込める」を、registry に出ずに毎 PR の CI で確かめる道具。ADR 0387）の、
 * fs にもネットワークにも触れない部品。
 *
 * ここを分けている理由は `scripts/check-consumer-install-lib.mjs` と同じ——本体側
 * （`scripts/check-cjs-require-smoke.mjs`）は import された瞬間に pack・展開・symlink・
 * node 実行までやってしまうトップレベルの処理を持つため、歯（テスト）から import すると
 * 実際に tarball を作り始めてしまう。純関数はこちらに置き、歯はこちらだけを import する。
 */

/**
 * 1パッケージの package.json から、実行時に `require`/`import` されうる外部依存の名前を列挙する
 * （`@mnemora/*` は tarball 自身が持ってくるので除く）。`dependencies` に加えて
 * `peerDependencies` も対象——`@mnemora/testkit` の `vitest` のように、宣言だけして
 * `dependencies` には入れない実行時依存があるため（利用者が自分で入れる前提のもの）。
 * `devDependencies`・`optionalDependencies` は対象外——実行時に require されない。
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
 * 複数パッケージぶんの外部実行時依存名を集め、重複を除いて返す（安定した順序のため sort する）。
 *
 * @param {{ dependencies?: Record<string, string>; peerDependencies?: Record<string, string> }[]} pkgs
 * @returns {string[]}
 */
export function collectExternalRuntimeDependencyNames(pkgs) {
  return [...new Set(pkgs.flatMap(externalRuntimeDependencyNames))].sort();
}

/**
 * README の約束（「CommonJS からは Node 22.12 以降の `require(esm)` で読み込める」）が要求する
 * 最低版を、実際に動いている node が満たしているかを見る。満たさない node でこの確認が緑でも、
 * README の約束そのものは確かめたことにならない——満たさないなら実行前に赤で止める
 * （呼び出し側の責務。ここは判定だけを返す）。
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
