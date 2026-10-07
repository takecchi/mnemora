import { describe, expect, it } from "vitest";
import {
  classifyPublishOutcome,
  detectDryRunMarker,
  evaluatePublishRunCoverage,
  findPublishStepName,
  parsePublishGroups,
  parseSpecName,
} from "../publish-run-coverage-lib.mjs";

const TIMESTAMP = "2026-09-17T01:14:00.3481028Z ";

function githubGroup(spec, resultLine) {
  return (
    `${TIMESTAMP}##[group]npm publish ${spec}\n` +
    `${TIMESTAMP}${resultLine}\n` +
    `${TIMESTAMP}##[endgroup]\n`
  );
}

describe("parsePublishGroups", () => {
  it("##[group]npm publish <spec> / ##[endgroup] を1本として切り出す（実物の形）", () => {
    const log = githubGroup(
      "@mnemora/core@0.1.1",
      "✔ @mnemora/core@0.1.1 は既に registry に在る（飛ばした）",
    );
    const groups = parsePublishGroups(log);
    expect(groups).toHaveLength(1);
    expect(groups[0].spec).toBe("@mnemora/core@0.1.1");
    expect(groups[0].body).toContain("既に registry に在る（飛ばした）");
  });

  it("::group:: / ::endgroup:: の生の表記も受ける（変換前の形。念のため）", () => {
    const log =
      "::group::npm publish @mnemora/core@0.1.1\n" +
      "✔ @mnemora/core@0.1.1 を publish した\n" +
      "::endgroup::\n";
    const groups = parsePublishGroups(log);
    expect(groups).toHaveLength(1);
    expect(groups[0].spec).toBe("@mnemora/core@0.1.1");
  });

  it("複数本を順番どおりに切り出す", () => {
    const log =
      githubGroup("@mnemora/core@0.1.1", "✔ @mnemora/core@0.1.1 を publish した") +
      githubGroup(
        "@mnemora/testkit@0.1.1",
        "✔ @mnemora/testkit@0.1.1 は既に registry に在る（飛ばした）",
      );
    const groups = parsePublishGroups(log);
    expect(groups.map((g) => g.spec)).toEqual(["@mnemora/core@0.1.1", "@mnemora/testkit@0.1.1"]);
  });

  it("失敗して ::endgroup:: の echo に届かない場合も、その本を1本として拾う", () => {
    const log =
      `${TIMESTAMP}##[group]npm publish @mnemora/core@0.1.1\n` +
      `${TIMESTAMP}npm error 403 Forbidden\n` +
      `${TIMESTAMP}✗ @mnemora/core@0.1.1 の publish が失敗した（exit 1）\n`;
    const groups = parsePublishGroups(log);
    expect(groups).toHaveLength(1);
    expect(groups[0].spec).toBe("@mnemora/core@0.1.1");
    expect(groups[0].body).toContain("の publish が失敗した");
  });

  it("『これから打つ script』のプレビュー行（未展開の ::group::npm publish ${spec}）を group と誤認しない", () => {
    const previewLine = `${TIMESTAMP}\x1b[36;1m  echo "::group::npm publish \${spec}"\x1b[0m\n`;
    const realGroup = githubGroup(
      "@mnemora/anthropic@0.1.1",
      "✔ @mnemora/anthropic@0.1.1 を publish した",
    );
    const log = previewLine + realGroup;
    const groups = parsePublishGroups(log);
    expect(groups).toHaveLength(1);
    expect(groups[0].spec).toBe("@mnemora/anthropic@0.1.1");
  });

  it("group が1つも無ければ空配列", () => {
    expect(parsePublishGroups("何も無いログ\n")).toEqual([]);
  });
});

describe("parseSpecName", () => {
  it("scoped パッケージは最後の @ をバージョンの区切りとして扱う", () => {
    expect(parseSpecName("@mnemora/core@0.1.1")).toEqual({
      name: "@mnemora/core",
      version: "0.1.1",
    });
  });

  it("@ を含まない spec は name のみ、version は null", () => {
    expect(parseSpecName("not-a-valid-spec")).toEqual({ name: "not-a-valid-spec", version: null });
  });
});

describe("classifyPublishOutcome", () => {
  it('"を publish した" は published', () => {
    expect(classifyPublishOutcome("✔ @mnemora/core@0.1.1 を publish した")).toBe("published");
  });

  it('"既に registry に在る（飛ばした）" は skipped', () => {
    expect(classifyPublishOutcome("✔ @mnemora/core@0.1.1 は既に registry に在る（飛ばした）")).toBe(
      "skipped",
    );
  });

  it('"の publish が失敗した" は failed', () => {
    expect(classifyPublishOutcome("✗ @mnemora/core@0.1.1 の publish が失敗した（exit 1）")).toBe(
      "failed",
    );
  });

  it("既知の3文言のどれにも一致しなければ unknown", () => {
    expect(classifyPublishOutcome("npm error something unexpected")).toBe("unknown");
  });
});

describe("detectDryRunMarker", () => {
  it("予行の固定文言が在れば true", () => {
    expect(detectDryRunMarker("予行（--dry-run）です。registry へは何も上がりません。")).toBe(true);
  });

  it("無ければ false", () => {
    expect(detectDryRunMarker("本番の publish ログ")).toBe(false);
  });

  it("『これから打つ script』のプレビュー行に固定文言が含まれていても true にしない（本番 run の実測で見つかったバグ）", () => {
    const previewLine = `${TIMESTAMP}\x1b[36;1m  echo "予行（--dry-run）です。registry へは何も上がりません。"\x1b[0m\n`;
    expect(detectDryRunMarker(previewLine)).toBe(false);
  });

  it("実行結果として出た生の行（ANSI無し・引用符無し）は true にする", () => {
    const realLine = `${TIMESTAMP}予行（--dry-run）です。registry へは何も上がりません。\n`;
    expect(detectDryRunMarker(realLine)).toBe(true);
  });
});

describe("evaluatePublishRunCoverage", () => {
  const targets = [
    { name: "@mnemora/core" },
    { name: "@mnemora/testkit" },
    { name: "@mnemora/openai" },
  ];

  it("全本 published なら pass（数・名前は targets から読む——リテラルを書かない）", () => {
    const log = targets
      .map((t) => githubGroup(`${t.name}@0.1.1`, `✔ ${t.name}@0.1.1 を publish した`))
      .join("");
    const result = evaluatePublishRunCoverage(log, targets);
    expect(result.verdict).toBe("pass");
    expect(result.publishedCount).toBe(targets.length);
    expect(result.totalTargets).toBe(targets.length);
    expect(result.perTarget.every((p) => p.outcome === "published")).toBe(true);
  });

  it("一部が skipped なら fail で、名指しできる（run 35169553262 の形）", () => {
    const log =
      githubGroup(
        "@mnemora/core@0.1.1",
        "✔ @mnemora/core@0.1.1 は既に registry に在る（飛ばした）",
      ) +
      githubGroup(
        "@mnemora/testkit@0.1.1",
        "✔ @mnemora/testkit@0.1.1 は既に registry に在る（飛ばした）",
      ) +
      githubGroup("@mnemora/openai@0.1.1", "✔ @mnemora/openai@0.1.1 を publish した");
    const result = evaluatePublishRunCoverage(log, targets);
    expect(result.verdict).toBe("fail");
    expect(result.publishedCount).toBe(1);
    expect(result.perTarget.find((p) => p.name === "@mnemora/core").outcome).toBe("skipped");
    expect(result.perTarget.find((p) => p.name === "@mnemora/testkit").outcome).toBe("skipped");
    expect(result.perTarget.find((p) => p.name === "@mnemora/openai").outcome).toBe("published");
  });

  it("failed が1本でもあれば fail で名指しできる", () => {
    const log =
      githubGroup("@mnemora/core@0.1.1", "✔ @mnemora/core@0.1.1 を publish した") +
      `${TIMESTAMP}##[group]npm publish @mnemora/testkit@0.1.1\n` +
      `${TIMESTAMP}✗ @mnemora/testkit@0.1.1 の publish が失敗した（exit 1）\n`;
    const result = evaluatePublishRunCoverage(log, targets);
    expect(result.verdict).toBe("fail");
    expect(result.perTarget.find((p) => p.name === "@mnemora/testkit").outcome).toBe("failed");
    expect(result.perTarget.find((p) => p.name === "@mnemora/openai").outcome).toBe("missing");
  });

  it("PUBLISH_TARGETS に無い名前がログに出たら fail（unexpectedNames に名指し）", () => {
    const log =
      targets
        .map((t) => githubGroup(`${t.name}@0.1.1`, `✔ ${t.name}@0.1.1 を publish した`))
        .join("") + githubGroup("@mnemora/rogue@0.1.1", "✔ @mnemora/rogue@0.1.1 を publish した");
    const result = evaluatePublishRunCoverage(log, targets);
    expect(result.verdict).toBe("fail");
    expect(result.unexpectedNames).toEqual(["@mnemora/rogue"]);
  });

  it("group が1つも無ければ indeterminate（publish 段が見つからない）", () => {
    const result = evaluatePublishRunCoverage("何も無いログ", targets);
    expect(result.verdict).toBe("indeterminate");
    expect(result.isDryRun).toBeNull();
  });

  it("本文が既知の3文言に一致しない対象が在れば indeterminate（fail にも pass にも倒さない）", () => {
    const log =
      githubGroup("@mnemora/core@0.1.1", "npm error 何か知らない出力") +
      githubGroup("@mnemora/testkit@0.1.1", "✔ @mnemora/testkit@0.1.1 を publish した") +
      githubGroup("@mnemora/openai@0.1.1", "✔ @mnemora/openai@0.1.1 を publish した");
    const result = evaluatePublishRunCoverage(log, targets);
    expect(result.verdict).toBe("indeterminate");
    expect(result.reason).toContain("@mnemora/core");
  });

  it("予行の固定文言が在れば isDryRun=true になり、fail の理由に予行の注記が付く", () => {
    const log =
      "予行（--dry-run）です。registry へは何も上がりません。\n" +
      githubGroup(
        "@mnemora/core@0.1.1",
        "✔ @mnemora/core@0.1.1 は既に registry に在る（飛ばした）",
      ) +
      githubGroup("@mnemora/testkit@0.1.1", "✔ @mnemora/testkit@0.1.1 を publish した") +
      githubGroup("@mnemora/openai@0.1.1", "✔ @mnemora/openai@0.1.1 を publish した");
    const result = evaluatePublishRunCoverage(log, targets);
    expect(result.isDryRun).toBe(true);
    expect(result.verdict).toBe("fail");
    expect(result.reason).toContain("予行なので");
  });

  it("予行の固定文言が無ければ isDryRun=false（本番）", () => {
    const log = targets
      .map((t) => githubGroup(`${t.name}@0.1.1`, `✔ ${t.name}@0.1.1 を publish した`))
      .join("");
    const result = evaluatePublishRunCoverage(log, targets);
    expect(result.isDryRun).toBe(false);
  });
});

describe("findPublishStepName", () => {
  it("直近の `- name:` を、::group::npm publish を出す行から逆算する", () => {
    const yaml = [
      "jobs:",
      "  publish:",
      "    steps:",
      "      - name: Checkout",
      "        run: echo hi",
      "      - name: npm publish（依存の向きの順に、tarball を上げる）",
      "        run: |",
      '          echo "::group::npm publish ${spec}"',
      "          echo done",
    ].join("\n");
    expect(findPublishStepName(yaml)).toBe("npm publish（依存の向きの順に、tarball を上げる）");
  });

  it("引用符付きの name も剥がして返す", () => {
    const yaml = [
      '      - name: "npm publish step"',
      "        run: |",
      '          echo "::group::npm publish ${spec}"',
    ].join("\n");
    expect(findPublishStepName(yaml)).toBe("npm publish step");
  });

  it("::group::npm publish が無ければ null", () => {
    const yaml = ["      - name: Checkout", "        run: echo hi"].join("\n");
    expect(findPublishStepName(yaml)).toBeNull();
  });

  it("実物の .github/workflows/publish.yml から実際の step 名を逆算できる", async () => {
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const workflowPath = fileURLToPath(
      new URL("../../.github/workflows/publish.yml", import.meta.url),
    );
    const text = readFileSync(workflowPath, "utf8");
    const stepName = findPublishStepName(text);
    expect(stepName).toBe("npm publish（依存の向きの順に、tarball を上げる）");
  });
});
