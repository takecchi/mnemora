import { describe, expect, it } from "vitest";
import {
  VERIFIED_MAJOR_VERSIONS,
  formatServerLines,
  majorVersionOf,
} from "../db-server-description.mjs";

describe("formatServerLines", () => {
  it("取れなかったときに黙らない（理由を出す）", () => {
    const lines = formatServerLines({ ok: false, reason: "connect ECONNREFUSED 127.0.0.1:1" });
    const text = lines.join("\n");

    expect(text).toContain("版を取得できませんでした");
    expect(text).toContain("ECONNREFUSED");
    expect(text).not.toMatch(/接続先: PostgreSQL \d/);
  });

  it("検証済みの版では、版を出すだけで警告は出さない", () => {
    const major = VERIFIED_MAJOR_VERSIONS[0];
    const lines = formatServerLines({
      ok: true,
      serverVersion: `${major}.4 (Debian)`,
      vectorVersion: "0.8.2",
    });
    const text = lines.join("\n");

    expect(text).toContain(`接続先: PostgreSQL ${major}.4 (Debian) / pgvector 0.8.2`);
    expect(text).not.toContain("検証されていない版です");
  });

  it("検証されていない版では、版・警告・次の一手をすべて出す", () => {
    const unverified = 16;
    expect(VERIFIED_MAJOR_VERSIONS).not.toContain(unverified);

    const lines = formatServerLines({
      ok: true,
      serverVersion: `${unverified}.15 (Debian ${unverified}.15-1.pgdg12+2)`,
      vectorVersion: "0.8.6",
    });
    const text = lines.join("\n");

    expect(text).toContain(`接続先: PostgreSQL ${unverified}.15`);
    expect(text).toContain(`PostgreSQL ${unverified} は、この repo で検証されていない版です`);
    expect(text).toContain("origin/main で対照を取る");
  });

  it("pgvector が入っていないことを、版が取れなかったことと混ぜない", () => {
    const text = formatServerLines({
      ok: true,
      serverVersion: `${VERIFIED_MAJOR_VERSIONS[0]}.4`,
      vectorVersion: null,
    }).join("\n");

    expect(text).toContain("pgvector（拡張が入っていません）");
    expect(text).not.toContain("版を取得できませんでした");
  });

  it("メジャー版を読み取れないときは、検証済みだと言い張らない", () => {
    const text = formatServerLines({
      ok: true,
      serverVersion: "（不明な形式）",
      vectorVersion: "0.8.6",
    }).join("\n");

    expect(text).toContain("メジャー版を読み取れませんでした");
    expect(text).not.toContain("検証されていない版です");
  });
});

describe("majorVersionOf", () => {
  it("先頭の数値をメジャー版として読む", () => {
    expect(majorVersionOf("16.15 (Debian 16.15-1.pgdg12+2)")).toBe(16);
    expect(majorVersionOf("17.4")).toBe(17);
    expect(majorVersionOf("18.6 (Homebrew)")).toBe(18);
  });

  it("読み取れない形は推測せず null を返す", () => {
    expect(majorVersionOf("（不明な形式）")).toBeNull();
    expect(majorVersionOf("")).toBeNull();
  });
});
