import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  EXPECTED_ENTRY_POINTS,
  buildSmokeCjs,
  buildSmokeMjs,
  buildSmokeTs,
  buildTsconfig,
  collectEntryValueNames,
  collectValueNamesForEntries,
  compareEntryPoints,
  entryPointsFromExports,
  planConsumerProjects,
} from "../check-consumer-install-lib.mjs";
import { PUBLISH_TARGETS } from "../publish-targets.mjs";

/** 作業ツリーの package.json を読む（tarball ではない）。入口を足した・消した PR で、一覧の更新漏れに CI で気づくため。 */

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

describe("entryPointsFromExports", () => {
  it("`.` はパッケージ名、`./x` は `名前/x` になり、`./package.json` は除く", () => {
    expect(
      entryPointsFromExports({
        name: "@a/b",
        exports: { ".": {}, "./fixtures": {}, "./package.json": "./package.json" },
      }),
    ).toEqual(["@a/b", "@a/b/fixtures"]);
  });

  it("exports が無い・文字列のときはパッケージ名だけ", () => {
    expect(entryPointsFromExports({ name: "@a/b" })).toEqual(["@a/b"]);
    expect(entryPointsFromExports({ name: "@a/b", exports: "./index.js" })).toEqual(["@a/b"]);
  });
});

describe("compareEntryPoints", () => {
  it("消えた入口と、一覧に無い入口の両方を返す", () => {
    expect(compareEntryPoints(["a", "a/f"], ["a", "a/g"])).toEqual({
      missing: ["a/f"],
      unexpected: ["a/g"],
    });
    expect(compareEntryPoints(["a"], ["a"])).toEqual({ missing: [], unexpected: [] });
  });
});

describe("EXPECTED_ENTRY_POINTS と作業ツリーの exports", () => {
  it("PUBLISH_TARGETS の各 package.json の exports から列挙した入口と、両向きで一致する", () => {
    const actual = PUBLISH_TARGETS.flatMap((t) =>
      entryPointsFromExports(JSON.parse(readFileSync(`${repoRoot}${t.dir}/package.json`, "utf8"))),
    );
    expect(compareEntryPoints(EXPECTED_ENTRY_POINTS, actual)).toEqual({
      missing: [],
      unexpected: [],
    });
  });
});

describe("生成するファイル", () => {
  it("smoke.ts はすべての入口を import し、使う", () => {
    const src = buildSmokeTs(["@a/b", "@a/b/f"]);
    expect(src).toContain('import * as e0 from "@a/b";');
    expect(src).toContain('import * as e1 from "@a/b/f";');
    expect(src).toContain("export const namespaces = [e0, e1];");
  });

  it("smoke.mjs は解決先が node_modules の配下であることと、export の有無を見る", () => {
    const src = buildSmokeMjs(["@a/b"], { "@a/b": ["x"] });
    expect(src).toContain('["@a/b"]');
    expect(src).toContain('"/node_modules/"');
    expect(src).toContain("Object.keys(mod).length === 0");
  });

  it("smoke.cjs は require で読み、解決先が node_modules の配下であることと、export の有無を見る", () => {
    const src = buildSmokeCjs(["@a/b"], { "@a/b": ["x"] });
    expect(src).toContain('["@a/b"]');
    expect(src).toContain("require.resolve(spec)");
    expect(src).toContain("require(spec)");
    expect(src).not.toContain("import(");
    expect(src).toContain('"/node_modules/"');
    expect(src).toContain("Object.keys(mod).length === 0");
  });

  it("tsconfig は node16 と bundler で module を変え、どちらも strict・skipLibCheck: true", () => {
    const n = JSON.parse(buildTsconfig("node16")).compilerOptions;
    const b = JSON.parse(buildTsconfig("bundler")).compilerOptions;
    expect([n.module, n.moduleResolution, b.module, b.moduleResolution]).toEqual([
      "Node16",
      "node16",
      "ESNext",
      "bundler",
    ]);
    expect([n.strict, n.skipLibCheck, b.strict, b.skipLibCheck]).toEqual([true, true, true, true]);
  });
});

describe("snapshot から引く値の名前（collectEntryValueNames）", () => {
  const snapshot = [
    "// ===== dist/index.d.ts =====",
    'export * from "./a.js";',
    'export { fromB, type TypeFromB } from "./b.js";',
    'export type { OnlyType } from "./b.js";',
    'import { fromC } from "./c.cjs";',
    "export { fromC };",
    "// ===== dist/a.d.ts =====",
    "export declare const A_CONST: string;",
    "export declare function aFn(): void;",
    "export declare class AClass {}",
    "export declare enum AEnum { X = 0 }",
    "export declare const enum AConstEnum { X = 0 }",
    "export interface AInterface {}",
    "export type AType = string;",
    "declare const internal: number;",
    "// ===== dist/b.d.ts =====",
    "export declare const fromB: number;",
    "export interface TypeFromB {}",
    "export interface OnlyType {}",
    "export declare const notReExported: number;",
    "// ===== dist/c.d.cts =====",
    "export declare const fromC: string;",
    "",
  ].join("\n");

  it("値だけを、入口から見える名前に限って引く（型・const enum・再 export されない宣言は除く）", () => {
    expect(collectEntryValueNames(snapshot, "dist/index.d.ts")).toEqual(
      ["A_CONST", "AClass", "AEnum", "aFn", "fromB", "fromC"].sort(),
    );
  });

  it("値が1つも引けなければ例外（抜き出しが壊れたまま緑にしない）", () => {
    expect(() =>
      collectEntryValueNames(
        "// ===== dist/index.d.ts =====\nexport interface I {}\n",
        "dist/index.d.ts",
      ),
    ).toThrow(/値の名前が1つも引けなかった/);
  });

  it("扱えない形（namespace）は黙って読み飛ばさず例外", () => {
    expect(() =>
      collectEntryValueNames(
        "// ===== dist/index.d.ts =====\nexport declare namespace N { const x: number; }\n",
        "dist/index.d.ts",
      ),
    ).toThrow(/namespace/);
  });

  it("実際の snapshot: 全入口で空でなく、testkit の . と ./fixtures の対応が正しい", () => {
    const names = collectValueNamesForEntries(EXPECTED_ENTRY_POINTS, repoRoot);
    for (const spec of EXPECTED_ENTRY_POINTS) expect(names[spec].length).toBeGreaterThan(0);
    expect(names["@mnemora/testkit/fixtures"]).toContain("InMemoryMemoryStore");
    expect(names["@mnemora/testkit"]).not.toContain("InMemoryMemoryStore");
    expect(names["@mnemora/testkit"]).toContain("CassetteRecorder");
    expect(names["@mnemora/postgres"]).toContain("DEFAULT_MIGRATIONS_DIR");
    expect(names["@mnemora/core"]).not.toContain("MemoryStore");
  });

  it("実際の snapshot: `export *` で再 export された名前（core の heuristicTokenCounter など）を含む", () => {
    const names = collectValueNamesForEntries(EXPECTED_ENTRY_POINTS, repoRoot);
    expect(names["@mnemora/core"]).toEqual(
      expect.arrayContaining([
        "heuristicTokenCounter",
        "DEFAULT_RECALL_LIMIT",
        "CtxSchema",
        "AttributesSchema",
      ]),
    );
    expect(names["@mnemora/testkit"]).toEqual(
      expect.arrayContaining(["describeMemoryStoreConformance", "DeterministicEmbeddingProvider"]),
    );
    expect(names["@mnemora/testkit/fixtures"]).toEqual(
      expect.arrayContaining(["InMemoryMemoryStore", "InMemoryVectorStore"]),
    );
    expect(names["@mnemora/postgres"]).toEqual(
      expect.arrayContaining(["PostgresMemoryStore", "createPostgresClient"]),
    );
  });
});

describe("生成した smoke が、値の名前の欠けを実行時に検出する", () => {
  function runSmoke(kind, exportedNames, valueNames) {
    const dir = mkdtempSync(join(tmpdir(), "mnemora-smoke-test-"));
    try {
      const pkgDir = join(dir, "node_modules", "@a", "b");
      mkdirSync(pkgDir, { recursive: true });
      writeFileSync(
        join(pkgDir, "package.json"),
        JSON.stringify({
          name: "@a/b",
          version: "0.0.0",
          exports: { ".": { import: "./index.mjs", require: "./index.cjs" } },
        }),
      );
      writeFileSync(
        join(pkgDir, "index.mjs"),
        `${exportedNames.map((n) => `export const ${n} = 1;`).join("\n")}\nexport const __present = 1;\n`,
      );
      writeFileSync(
        join(pkgDir, "index.cjs"),
        `${exportedNames.map((n) => `exports.${n} = 1;`).join("\n")}\nexports.__present = 1;\n`,
      );
      const file = kind === "mjs" ? "smoke.mjs" : "smoke.cjs";
      const build = kind === "mjs" ? buildSmokeMjs : buildSmokeCjs;
      writeFileSync(join(dir, file), build(["@a/b"], valueNames));
      const r = spawnSync(process.execPath, [file], { cwd: dir, encoding: "utf8" });
      return { status: r.status, out: `${r.stdout}${r.stderr}` };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  for (const kind of ["mjs", "cjs"]) {
    it(`(${kind}) 名前が揃った mod で緑`, () => {
      const r = runSmoke(kind, ["foo", "bar"], { "@a/b": ["foo", "bar"] });
      expect(r.status).toBe(0);
    });

    it(`(${kind}) 名前が1つ欠けた mod で赤（欠けた名前を名指しする）`, () => {
      const r = runSmoke(kind, ["foo"], { "@a/b": ["foo", "bar"] });
      expect(r.status).toBe(1);
      expect(r.out).toContain("（1 個）: bar");
    });

    it(`(${kind}) 名前の一覧が空・入口の分が無いときは赤`, () => {
      expect(runSmoke(kind, ["foo"], { "@a/b": [] }).status).toBe(1);
      expect(runSmoke(kind, ["foo"], {}).status).toBe(1);
    });
  }
});

describe("planConsumerProjects（パッケージごとに別のプロジェクトへ入れる）", () => {
  const manifests = [
    { name: "@m/core", tarball: "/p/core.tgz", dependencies: { zod: "^4" } },
    {
      name: "@m/testkit",
      tarball: "/p/testkit.tgz",
      dependencies: { "@m/core": "^1" },
    },
    {
      name: "@m/openai",
      tarball: "/p/openai.tgz",
      dependencies: { "@m/core": "^1", openai: "7", zod: "^4" },
    },
  ];
  const entries = ["@m/core", "@m/testkit", "@m/testkit/fixtures", "@m/openai"];
  const plan = planConsumerProjects(manifests, entries);
  const byName = (name) => plan.find((p) => p.name === name);

  it("パッケージの数だけプロジェクトを作る", () => {
    expect(plan.map((p) => p.name)).toEqual(["@m/core", "@m/testkit", "@m/openai"]);
  });

  it("兄弟に頼らない core のプロジェクトへは core の tarball だけを入れる（testkit の peer の zod が混ざらない）", () => {
    expect(byName("@m/core").installTarballs).toEqual(["/p/core.tgz"]);
  });

  it("兄弟の出荷パッケージは dependencies で頼るものだけを、自分の tarball と一緒に入れる", () => {
    expect(byName("@m/testkit").installTarballs).toEqual(["/p/testkit.tgz", "/p/core.tgz"]);
    expect(byName("@m/openai").installTarballs).toEqual(["/p/openai.tgz", "/p/core.tgz"]);
    expect(byName("@m/openai").installTarballs).not.toContain("/p/testkit.tgz");
  });

  it("入口は自分のパッケージのものだけを、副入口も含めて割り当てる", () => {
    expect(byName("@m/testkit").entries).toEqual(["@m/testkit", "@m/testkit/fixtures"]);
    expect(byName("@m/core").entries).toEqual(["@m/core"]);
  });

  it("実際の EXPECTED_ENTRY_POINTS は、すべてちょうど1つのプロジェクトに割り当てられる", () => {
    const real = PUBLISH_TARGETS.map((t) => ({
      ...JSON.parse(readFileSync(`${repoRoot}${t.dir}/package.json`, "utf8")),
      tarball: `/p/${t.name}.tgz`,
    }));
    const realPlan = planConsumerProjects(real, EXPECTED_ENTRY_POINTS);
    expect(realPlan.flatMap((p) => p.entries).sort()).toEqual([...EXPECTED_ENTRY_POINTS].sort());
  });

  // 再確かめ（2026-10-07 マージ分、#1904）。上の歯は、peerDependencies を持つ manifest・名前が前方一致する
  // 兄弟・dependencies の無い manifest を渡さないので、次の3つの変異は素通りした。
  it("peerDependencies に挙げた兄弟の tarball は入れない（ADR 0694 決定2・3。頼る tarball は dependencies のものだけ）", () => {
    const withPeer = planConsumerProjects(
      [
        { name: "@m/core", tarball: "/p/core.tgz", dependencies: { zod: "^4" } },
        {
          name: "@m/peer-user",
          tarball: "/p/peer-user.tgz",
          dependencies: { zod: "^4" },
          peerDependencies: { "@m/core": "^1" },
        },
      ],
      ["@m/core", "@m/peer-user"],
    );
    expect(withPeer.find((p) => p.name === "@m/peer-user").installTarballs).toEqual([
      "/p/peer-user.tgz",
    ]);
  });

  it("名前が前方一致するだけの兄弟の入口は、割り当てない（@m/core に @m/core-extra を混ぜない）", () => {
    const prefixed = planConsumerProjects(
      [
        { name: "@m/core", tarball: "/p/core.tgz", dependencies: {} },
        { name: "@m/core-extra", tarball: "/p/core-extra.tgz", dependencies: {} },
      ],
      ["@m/core", "@m/core/sub", "@m/core-extra"],
    );
    expect(prefixed.find((p) => p.name === "@m/core").entries).toEqual(["@m/core", "@m/core/sub"]);
    expect(prefixed.find((p) => p.name === "@m/core-extra").entries).toEqual(["@m/core-extra"]);
  });

  it("dependencies の無い manifest でも、自分の tarball だけを入れて投げない", () => {
    const noDeps = planConsumerProjects([{ name: "@m/solo", tarball: "/p/solo.tgz" }], ["@m/solo"]);
    expect(noDeps).toEqual([
      { name: "@m/solo", installTarballs: ["/p/solo.tgz"], entries: ["@m/solo"] },
    ]);
  });
});
