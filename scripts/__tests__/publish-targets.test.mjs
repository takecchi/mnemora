import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { PUBLISH_TARGETS } from "../publish-targets.mjs";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

function readManifest(dir) {
  return JSON.parse(readFileSync(`${repoRoot}${dir}/package.json`, "utf8"));
}

describe("PUBLISH_TARGETS（ADR 0066）", () => {
  it("7パッケージである", () => {
    expect(PUBLISH_TARGETS).toHaveLength(7);
  });

  it("各 dir の package.json の name が、リストの name と一致する", () => {
    for (const target of PUBLISH_TARGETS) {
      expect(readManifest(target.dir).name, `${target.dir} の name`).toBe(target.name);
    }
  });

  // 正解の並びは書き写さない（写しが腐る）。依存の向き（package.json）から導く。
  it("各パッケージの @mnemora/* 依存が、自分より前に publish される順に並んでいる", () => {
    const positionOf = new Map(PUBLISH_TARGETS.map((t, i) => [t.name, i]));

    for (const [index, target] of PUBLISH_TARGETS.entries()) {
      const manifest = readManifest(target.dir);
      // devDependencies は tarball に載らないので順序を縛らない。
      const runtimeDeps = { ...manifest.dependencies, ...manifest.peerDependencies };
      for (const depName of Object.keys(runtimeDeps)) {
        if (!depName.startsWith("@mnemora/")) continue;
        const depIndex = positionOf.get(depName);
        expect(
          depIndex,
          `${target.name} が依存する ${depName} が publish 対象に無い`,
        ).toBeDefined();
        expect(
          depIndex,
          `${target.name}（${index}番目）より後に ${depName}（${depIndex}番目）を publish すると、` +
            `使う側が install で E404 を見る`,
        ).toBeLessThan(index);
      }
    }
  });

  it("check-publish-pack.test.mjs が直書きしている6つと、集合として一致する", () => {
    const source = readFileSync(
      fileURLToPath(new URL("./check-publish-pack.test.mjs", import.meta.url)),
      "utf8",
    );
    const listed = [
      // `[a-z]+` ではハイフン入りの `local-embedding` を拾えない。
      ...source.matchAll(/\{ name: "(@mnemora\/[a-z-]+)", dir: "(packages\/[a-z-]+)" \}/g),
    ];
    expect(
      listed.length,
      "歯の側の直書きリストが読み取れなかった（正規表現が名前の形に追いついているか）",
    ).toBe(PUBLISH_TARGETS.length);
    expect(new Set(listed.map((m) => m[1]))).toEqual(new Set(PUBLISH_TARGETS.map((t) => t.name)));
    expect(new Set(listed.map((m) => m[2]))).toEqual(new Set(PUBLISH_TARGETS.map((t) => t.dir)));
  });
});

describe(".github/workflows/publish.yml（ADR 0066）", () => {
  // YAML は構造解析せず文字列で見る（歯のためだけに実行時依存を足さない）。
  const workflowPath = new URL("../../.github/workflows/publish.yml", import.meta.url);

  /** @type {string} */
  let workflow;
  try {
    workflow = readFileSync(workflowPath, "utf8");
  } catch {
    workflow = "";
  }

  it("publish.yml が在る（改名すると npm 側の信頼発行元設定と食い違って 403 になる）", () => {
    expect(workflow, ".github/workflows/publish.yml が読めなかった").not.toBe("");
  });

  it("id-token: write を持つ（無いと OIDC の token を発行できず 401 になる）", () => {
    expect(workflow).toContain("id-token: write");
  });

  it("npm CLI を上げる段が在る（Trusted Publishing は npm >= 11.5.1）", () => {
    expect(workflow).toContain("npm install -g npm@latest");
  });

  it("引き金は release の published である", () => {
    expect(workflow).toMatch(/release:\s*\n\s*types:\s*\[published\]/);
  });

  it("push: tags を引き金に持たない（Release と二重に走らせない）", () => {
    expect(workflow).not.toMatch(/^\s*push:/m);
  });

  it("版と dist-tag を決める段が apply-release-version.mjs を呼んでいる（配線）", () => {
    expect(workflow).toContain("node scripts/apply-release-version.mjs");
  });

  it("その段へ tag と pre-release の別が env で渡っている", () => {
    expect(workflow).toContain("RELEASE_TAG: ${{ github.event.release.tag_name }}");
    expect(workflow).toContain("GITHUB_PRERELEASE: ${{ github.event.release.prerelease }}");
  });

  it("決まった dist-tag が npm publish の --tag へ渡っている", () => {
    expect(workflow).toContain("--tag");
    expect(workflow).toContain("NPM_TAG:");
  });

  it("NPM_TAG が空なら publish の前に落ちる", () => {
    expect(workflow).toContain('if [ -z "${NPM_TAG}" ]; then');
  });

  it("既に上がっている版を飛ばす分岐を持つ（同じ版での再実行が硬く落ちない）", () => {
    expect(workflow).toContain("cannot publish over the previously published");
  });

  it("梱包は pnpm・アップロードは npm である（決定2 の配線そのもの）", () => {
    expect(workflow).toContain("scripts/pack-publish-targets.mjs");
    expect(workflow).toMatch(/npm publish "\$\{tarball\}"/);
    expect(workflow).not.toContain("pnpm publish");
  });
});
