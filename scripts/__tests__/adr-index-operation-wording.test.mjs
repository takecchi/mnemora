import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const read = (relativePath) => readFileSync(`${repoRoot}${relativePath}`, "utf8");

function sliceBetween(text, startMarker, endMarker) {
  const start = text.indexOf(startMarker);
  expect(start, `${startMarker} が見つからない`).toBeGreaterThanOrEqual(0);
  const end = text.indexOf(endMarker, start + startMarker.length);
  expect(end, `${endMarker} が見つからない`).toBeGreaterThan(start);
  return text.slice(start, end);
}

function withoutQuotedReadings(text) {
  return text.replace(/「作成者は[^」]*」/g, "");
}

const OLD_NORM =
  /作成者(?:は|が|自身は)[^。\n]{0,30}(?:触らない|直さない|直してはいけない|実行しない)/;
const OLD_NORM_MERGER = /マージする側が[^。\n]{0,20}(?:再生成|生成して)/;

/** 文面の全体は縛らない。縛るのは約束の核だけにして、ちょっとした言い換えでは落ちないようにする。 */
const places = [
  {
    name: "docs/decisions/README.md 「一覧」節の冒頭",
    text: () =>
      sliceBetween(
        read("docs/decisions/README.md"),
        "\n## 一覧\n",
        "<!-- ADR-INDEX:GENERATED:START -->",
      ),
  },
  {
    name: "docs/autonomy.md §4.0",
    text: () => sliceBetween(read("docs/autonomy.md"), "\n### 4.0 ", "\n### 4.1 "),
  },
  {
    name: "scripts/generate-adr-index.mjs の冒頭コメント",
    text: () => sliceBetween(read("scripts/generate-adr-index.mjs"), "/**", "*/"),
  },
];

describe.each(places)("ADR 索引の運用の案内 — $name", ({ text }) => {
  it("元の規範（作成者は触らない・自分で直さない・マージする側が直前に再生成する）を規範として書いていない", () => {
    const body = withoutQuotedReadings(text());
    expect(body).not.toMatch(OLD_NORM);
    expect(body).not.toMatch(OLD_NORM_MERGER);
  });

  it("ADR を足す PR の側で直す、と書き、2026-09-30 の追記を指している", () => {
    const body = text();
    expect(body).toContain("PR の側で");
    expect(body).toContain("2026-09-30");
    expect(body).toContain("追記");
  });
});

describe("ADR 0137・0192 の末尾の追記", () => {
  it.each([
    ["0137-adr-index-generated-from-source.md"],
    ["0192-adr-index-freshness-enforced-in-pull-request-ci.md"],
  ])("%s に、実際の運用を書いた 2026-09-30 の追記が在る", (file) => {
    expect(readdirSync(`${repoRoot}docs/decisions`)).toContain(file);
    const adr = read(`docs/decisions/${file}`);
    expect(adr).toContain("追記（2026-09-30）");
    expect(adr).toContain("実際の運用");
    expect(adr).toContain("generate-adr-index.mjs");
  });
});
