/**
 * `scripts/check-consumer-install.mjs`（出荷6パッケージを repo の外に入れて、利用者の立場で
 * 型と入口を確かめる道具。ADR 0346）の、ネットワークを使わない部品。
 *
 * ## 利用者が頼ってよい入口の一覧（{@link EXPECTED_ENTRY_POINTS}）
 *
 * 各パッケージの `exports` から一覧を**導かない**。導くと、`exports` から入口を消したときに
 * 一覧からも消えて、検査が黙って通る。⟹ 一覧はここに独立に持ち、`exports` と**両向きで**突き合わせる
 * （消えた入口も、一覧に無い新しい入口も、どちらも赤にする）。新しい入口を足したら、ここにも足すこと。
 */

/** `import` で引ける入口（`./package.json` は除く）。 */
export const EXPECTED_ENTRY_POINTS = Object.freeze([
  "@mnemora/core",
  "@mnemora/testkit",
  "@mnemora/testkit/fixtures",
  "@mnemora/openai",
  "@mnemora/anthropic",
  "@mnemora/postgres",
  "@mnemora/local-embedding",
]);

/**
 * 1パッケージの package.json の `exports` から、`import` で引ける入口の指定子を列挙する
 * （`./package.json` は除く）。
 *
 * @param {{ name: string; exports?: Record<string, unknown> | string }} pkg
 * @returns {string[]}
 */
export function entryPointsFromExports(pkg) {
  if (pkg.exports === undefined || typeof pkg.exports === "string") {
    return [pkg.name];
  }
  return Object.keys(pkg.exports)
    .filter((key) => key !== "./package.json")
    .map((key) => (key === "." ? pkg.name : `${pkg.name}/${key.replace(/^\.\//, "")}`));
}

/**
 * 期待する入口と、tarball の `exports` から列挙した入口を両向きで突き合わせる。
 *
 * @param {readonly string[]} expected
 * @param {readonly string[]} actual
 * @returns {{ missing: string[]; unexpected: string[] }}
 */
export function compareEntryPoints(expected, actual) {
  const a = new Set(actual);
  const e = new Set(expected);
  return {
    missing: expected.filter((x) => !a.has(x)),
    unexpected: actual.filter((x) => !e.has(x)),
  };
}

/** 型検査に掛ける入口ファイル（すべての入口を namespace で import し、使う）。 */
export function buildSmokeTs(entries) {
  const lines = entries.map((spec, i) => `import * as e${i} from ${JSON.stringify(spec)};`);
  lines.push(`export const namespaces = [${entries.map((_, i) => `e${i}`).join(", ")}];`);
  return `${lines.join("\n")}\n`;
}

/**
 * 実行に掛ける ESM の入口ファイル。各入口を import し、解決先が install 先の `node_modules` の
 * 配下であること（repo へ登っていないこと）と、名前が1つ以上 export されていることを確かめる。
 */
export function buildSmokeMjs(entries) {
  return `const entries = ${JSON.stringify(entries)};
const failures = [];
for (const spec of entries) {
  try {
    const resolved = import.meta.resolve(spec);
    if (!resolved.includes("/node_modules/")) {
      failures.push(\`\${spec}: install 先の node_modules の外へ解決した（\${resolved}）\`);
      continue;
    }
    const mod = await import(spec);
    if (Object.keys(mod).length === 0) failures.push(\`\${spec}: export が1つも無い\`);
  } catch (error) {
    failures.push(\`\${spec}: \${error instanceof Error ? error.message : String(error)}\`);
  }
}
if (failures.length > 0) {
  console.error(failures.join("\\n"));
  process.exit(1);
}
console.log(\`ESM: \${entries.length} 個の入口をすべて import できた\`);
`;
}

/** 型検査の tsconfig（`moduleResolution` ごと）。`skipLibCheck: true` は利用者の既定に合わせる。 */
export function buildTsconfig(moduleResolution) {
  const module = moduleResolution === "node16" ? "Node16" : "ESNext";
  return `${JSON.stringify(
    {
      compilerOptions: {
        target: "ES2022",
        module,
        moduleResolution,
        strict: true,
        noEmit: true,
        skipLibCheck: true,
        types: ["node"],
      },
      files: ["smoke.ts"],
    },
    null,
    2,
  )}\n`;
}
