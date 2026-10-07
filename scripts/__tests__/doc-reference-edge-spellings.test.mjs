import { describe, expect, it } from "vitest";
import { findBrokenReferences } from "../doc-reference-lib.mjs";

/**
 * 参照の検査が見る綴りの端。repo の外へ出る `../` は「repo の外を指している」と名乗って赤になり、
 * `ADR-0123` の綴りも `ADR 0123` と同じく存在を確かめる。
 */

const ENV = {
  exists: (p) => p === "docs/a.md",
  adrExists: (n) => n === "0001",
  headingNumbers: () => null,
};

describe("findBrokenReferences の綴りの端", () => {
  it("repo の外へ出る ../ のリンクは、repo の外を指していると名乗って赤", () => {
    const broken = findBrokenReferences("docs/b.md", "[x](../../outside.md)", ENV);
    expect(broken).toHaveLength(1);
    expect(broken[0]).toMatchObject({ kind: "link" });
    expect(broken[0].reason).toContain("repo の外を指している");
  });

  it("repo の中に収まる ../ は赤にならない（陽性対照）", () => {
    expect(findBrokenReferences("docs/sub/b.md", "[x](../a.md)", ENV)).toEqual([]);
  });

  it.each(["ADR 9999", "ADR-9999", "ADR9999"])(
    "存在しない番号 %s は赤、在る番号は赤にならない",
    (spelling) => {
      const broken = findBrokenReferences("docs/b.md", `see ${spelling}`, ENV);
      expect(broken).toHaveLength(1);
      expect(broken[0]).toMatchObject({ kind: "adr", ref: spelling });
      expect(findBrokenReferences("docs/b.md", spelling.replace("9999", "0001"), ENV)).toEqual([]);
    },
  );
});
