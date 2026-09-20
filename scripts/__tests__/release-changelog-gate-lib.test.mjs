import { describe, expect, it } from "vitest";
import { decideReleaseChangelogGate, parsePrereleaseFlag } from "../release-changelog-gate-lib.mjs";

/**
 * ⭐ **この歯が測っているもの（消す前に読むこと）**
 *
 * **`npm publish` の前に置いた門の判定が、①止めるべきときに止まり ②当たらない場面で
 * 当たらず ③判定できないときに緑へ倒れないこと。**
 *
 * 🔴 **③がこの門の芯である。**`publish.yml` は逐語で「**確かめていないものを publish の
 * 経路に通さない——ここで落とす**」と書いており、この門も同じ向きに倒す。
 * ⟹ **tag が読めない・`CHANGELOG.md` が読めない・`prerelease` 欄が `true`/`false` の
 * どちらでもない、のいずれも「止める」へ倒れることを、下で名指しして縛る。**
 *
 * ⚠ **`scripts/__tests__/release-changelog-section-lib.test.mjs` の重複ではない。**
 * あちらが測るのは**通知**（終了コードが常に 0 の側）の述語である。
 * こちらが測るのは**門**の判定——とくに**除外の範囲**と**fail-closed の向き**であり、
 * あちらは1バイトも見ていない。
 *
 * 🔴 **この歯が捕まえないもの:**
 * - **`publish.yml` にこの判定が実際に配線されているか**は見ていない
 *   （それは `publish-yml-changelog-gate-wiring.test.mjs` が見る）。
 * - **節の中身が正しいか**は見ていない。門の述語が「存在」だけだからである。
 * - **将来の偽陽性率**は測れない。下の逆測定は**過去4リリースという標本**である。
 */

const CHANGELOG = [
  "# Changelog",
  "",
  "## [1.0.0] - 未リリース",
  "",
  "## [0.5.0] - 2026-09-21",
  "",
  "## [0.4.0] - 2026-09-19",
  "",
].join("\n");

const base = {
  eventName: "release",
  prereleaseRaw: "false",
  changelogText: CHANGELOG,
  changelogSource: "origin/main",
};

describe("🔴 止めるべきときに止まる", () => {
  it("出す版の節が無ければ exit 1 になる", () => {
    const r = decideReleaseChangelogGate({ ...base, tagName: "v0.6.0" });
    expect(r.applies).toBe(true);
    expect(r.ok).toBe(false);
    expect(r.exitCode).toBe(1);
    expect(r.reason).toBe("section-missing");
  });

  it("節が在れば exit 0 になり、何行目かを名乗る", () => {
    const r = decideReleaseChangelogGate({ ...base, tagName: "v0.5.0" });
    expect(r.ok).toBe(true);
    expect(r.exitCode).toBe(0);
    expect(r.reason).toBe("section-present");
    expect(r.lineNumber).toBe(5);
  });

  it("⚠ 版の前方一致で誤って通さない（1.0.0 が 1.0.00 の節に当たらない）", () => {
    const r = decideReleaseChangelogGate({
      ...base,
      tagName: "v1.0.0",
      changelogText: "## [1.0.00] - 2026-01-01\n",
    });
    expect(r.exitCode).toBe(1);
  });

  it("⛔ 落ちたときの出力は、直し方（節を入れて run を再実行）を必ず含む", () => {
    const r = decideReleaseChangelogGate({ ...base, tagName: "v0.6.0" });
    const text = r.lines.join("\n");
    expect(text).toContain("再実行");
    expect(text).toContain("CHANGELOG.md");
  });
});

describe("⛔ 当たらない場面は2つだけである（増やすときはここを読むこと）", () => {
  it("`release` 以外の引き金では当たらない（予行）", () => {
    const r = decideReleaseChangelogGate({
      ...base,
      eventName: "workflow_dispatch",
      tagName: "",
      changelogText: "",
    });
    expect(r.applies).toBe(false);
    expect(r.exitCode).toBe(0);
    expect(r.reason).toBe("not-a-release-event");
  });

  it("`prerelease` の Release では当たらない", () => {
    const r = decideReleaseChangelogGate({
      ...base,
      prereleaseRaw: "true",
      tagName: "v1.0.0-rc.1",
    });
    expect(r.applies).toBe(false);
    expect(r.exitCode).toBe(0);
    expect(r.reason).toBe("prerelease");
  });

  it("⛔ 当たらなかったことを「緑だった」と名乗らない（出力が区別する）", () => {
    const r = decideReleaseChangelogGate({ ...base, eventName: "workflow_dispatch" });
    expect(r.lines.join("\n")).toContain("当てていない");
  });
});

describe("🔴 判定できないときは緑へ倒れない（fail-closed）", () => {
  it("tag 名が空なら exit 1", () => {
    const r = decideReleaseChangelogGate({ ...base, tagName: "" });
    expect(r.exitCode).toBe(1);
    expect(r.reason).toBe("no-version");
  });

  it("CHANGELOG.md の中身が読めていなければ exit 1", () => {
    const r = decideReleaseChangelogGate({ ...base, tagName: "v0.5.0", changelogText: "" });
    expect(r.exitCode).toBe(1);
    expect(r.reason).toBe("no-changelog");
  });

  it("`prerelease` 欄が true/false のどちらでもなければ、除外せず門を当てる", () => {
    const r = decideReleaseChangelogGate({
      ...base,
      prereleaseRaw: "TRUE",
      tagName: "v0.6.0",
    });
    expect(r.applies).toBe(true);
    expect(r.exitCode).toBe(1);
    expect(r.lines.join("\n")).toContain("除外と明示されていない");
  });

  it("parsePrereleaseFlag は true/false だけを認識し、それ以外は recognized=false で prerelease 扱いにしない", () => {
    expect(parsePrereleaseFlag("true")).toEqual({ isPrerelease: true, recognized: true });
    expect(parsePrereleaseFlag("false")).toEqual({ isPrerelease: false, recognized: true });
    for (const raw of ["", "TRUE", "1", "yes", undefined, null]) {
      expect(parsePrereleaseFlag(raw)).toEqual({ isPrerelease: false, recognized: false });
    }
  });
});

describe("⭐ 逆測定 —— 過去のリリースの瞬間に当てていたら、どうなっていたか", () => {
  /**
   * ⚠ **これは将来の偽陽性率の保証ではない。**過去4リリースという**標本**に対して、
   * 門が何と言ったかを固定するだけである（`docs/decisions/` の当該 ADR「測っていないこと」）。
   *
   * 🔴 **測った事実**: `v0.2.0`〜`v0.5.0` は、いずれも**節が `main` に入る前に publish された**。
   * ⟹ **この門は4回とも止め、4回とも正しかった**（節は後から書かれた ＝ その時点では本当に無かった）。
   */
  it("節がまだ無い木に対しては、4回とも止める側になる", () => {
    for (const tagName of ["v0.2.0", "v0.3.0", "v0.4.0", "v0.5.0"]) {
      const r = decideReleaseChangelogGate({
        ...base,
        tagName,
        // 当時の木には、出す版の節がまだ無かった（節は publish の後に書かれた）。
        changelogText: "# Changelog\n\n## [1.0.0] - 未リリース\n",
      });
      expect(r.exitCode, `${tagName} は止まるはず`).toBe(1);
    }
  });
});
