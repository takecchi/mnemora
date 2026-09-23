import { describe, expect, it } from "vitest";
import {
  addedLineNumbers,
  findUnrewrittenAdrReferences,
  parseAdrFilename,
  pickNextFreeNumber,
  planRenumbering,
  renumberedReferenceWarning,
  rewriteReferencesInText,
} from "../adr-renumber-lib.mjs";

/**
 * `scripts/adr-renumber-lib.mjs`（採番を「マージ直前」に確定させる設計の純関数側）
 * の歯（Issue #295、ADR 0179）。
 *
 * このファイルは実際の `docs/decisions/` を1バイトも読まない——合成データだけで
 * 検査する。既存の173本の ADR を動かさないことは、CLI 側
 * （`scripts/adr-renumber.mjs`）が「このブランチが追加したファイルだけ」を
 * 対象にする設計そのもので担保しており、ここでは対象にしない。
 */

describe("parseAdrFilename", () => {
  it("4桁番号 + slug + .md を分解する", () => {
    expect(parseAdrFilename("0146-recall-association-unprompted.md")).toEqual({
      number: "0146",
      slug: "recall-association-unprompted",
    });
  });

  it("ADR ファイルの形でなければ null", () => {
    expect(parseAdrFilename("README.md")).toBeNull();
    expect(parseAdrFilename("notes.txt")).toBeNull();
  });
});

describe("pickNextFreeNumber", () => {
  it("空集合なら 0001", () => {
    expect(pickNextFreeNumber([])).toBe("0001");
  });

  it("最大値 + 1 を返す（欠番を埋めには行かない）", () => {
    expect(pickNextFreeNumber(["0001", "0005", "0173"])).toBe("0174");
  });

  it("最大値+1 も使用済みなら、その次の空きまで進む", () => {
    expect(pickNextFreeNumber(["0173", "0174", "0175"])).toBe("0176");
  });
});

describe("planRenumbering — 衝突なし", () => {
  it("origin/main に無い番号は変更しない", () => {
    const plan = planRenumbering(["0001", "0002"], [{ filename: "0003-new-thing.md" }]);
    expect(plan).toEqual([
      {
        oldFilename: "0003-new-thing.md",
        oldNumber: "0003",
        newNumber: "0003",
        newFilename: "0003-new-thing.md",
        slug: "new-thing",
        renamed: false,
      },
    ]);
  });

  it("空振り防止: 追加ファイルが無ければ空配列", () => {
    expect(planRenumbering(["0001"], [])).toEqual([]);
  });
});

describe("planRenumbering — 衝突あり", () => {
  it("origin/main で既に使われている番号は、次の空き番号へ付け替える", () => {
    const mainNumbers = ["0001", "0002", "0173"];
    const plan = planRenumbering(mainNumbers, [{ filename: "0173-recall-footprint-estimator.md" }]);
    expect(plan).toEqual([
      {
        oldFilename: "0173-recall-footprint-estimator.md",
        oldNumber: "0173",
        newNumber: "0174",
        newFilename: "0174-recall-footprint-estimator.md",
        slug: "recall-footprint-estimator",
        renamed: true,
      },
    ]);
  });

  it("同じブランチが追加した複数の ADR が衝突しても、互いに重複しない番号へ割り当てる", () => {
    const mainNumbers = ["0173"];
    const plan = planRenumbering(mainNumbers, [
      { filename: "0173-a.md" },
      { filename: "0173-b.md" },
    ]);
    expect(plan.map((p) => p.newNumber)).toEqual(["0174", "0175"]);
    expect(plan.map((p) => p.renamed)).toEqual([true, true]);
  });

  it("一部だけ衝突する場合、衝突していないファイルは変更しない", () => {
    const mainNumbers = ["0173"];
    const plan = planRenumbering(mainNumbers, [
      { filename: "0173-conflicts.md" },
      { filename: "0180-no-conflict.md" },
    ]);
    const conflicting = plan.find((p) => p.oldFilename === "0173-conflicts.md");
    const clean = plan.find((p) => p.oldFilename === "0180-no-conflict.md");
    expect(conflicting.renamed).toBe(true);
    expect(conflicting.newNumber).toBe("0174");
    expect(clean.renamed).toBe(false);
    expect(clean.newNumber).toBe("0180");
  });

  it("ADR ファイルの形にマッチしない追加ファイルは例外を投げる", () => {
    expect(() => planRenumbering(["0001"], [{ filename: "not-an-adr.md" }])).toThrow(
      /ADR ファイル名の形/,
    );
  });
});

describe("rewriteReferencesInText — 正しい形だけを拾う", () => {
  const renames = [{ oldNumber: "0146", newNumber: "0150", slug: "recall-association-unprompted" }];

  it("markdown リンク中のファイル名 stem を書き換える", () => {
    const text = "[ADR 0146](./0146-recall-association-unprompted.md) を見ること。";
    const { text: result, changes } = rewriteReferencesInText(text, renames);
    expect(result).toBe("[ADR 0150](./0150-recall-association-unprompted.md) を見ること。");
    expect(changes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "stem", oldNumber: "0146", newNumber: "0150", count: 1 }),
        expect.objectContaining({
          type: "adr-mention",
          oldNumber: "0146",
          newNumber: "0150",
          count: 1,
        }),
      ]),
    );
  });

  it("見出し行（1行目の `# ADR NNNN: ...`）の番号も書き換える", () => {
    const text = "# ADR 0146: 連想枠を実装する\n\n本文。";
    const { text: result } = rewriteReferencesInText(text, renames);
    expect(result).toBe("# ADR 0150: 連想枠を実装する\n\n本文。");
  });

  it("コード内の参照（パス文字列）も書き換える", () => {
    const text = 'const path = "docs/decisions/0146-recall-association-unprompted.md";';
    const { text: result } = rewriteReferencesInText(text, renames);
    expect(result).toBe('const path = "docs/decisions/0150-recall-association-unprompted.md";');
  });

  it("裸の4桁数字は巻き込まない（ADR接頭辞も stem 形も無いもの）", () => {
    const text = "2026年、issue 0146 は関係ない番号として登場する（日付でも起票番号でもない）。";
    const { text: result, changes } = rewriteReferencesInText(text, renames);
    expect(result).toBe(text);
    expect(changes).toEqual([]);
  });

  it("似た別の slug を持つ同じ番号は誤って巻き込まない（stem の右側境界）", () => {
    const text = "0146-recall-association-unprompted-extended.md は別ファイルである。";
    const { text: result, changes } = rewriteReferencesInText(text, renames);
    expect(result).toBe(text);
    expect(changes).toEqual([]);
  });

  it("後ろにもっと長い数字が続く場合は ADR 表記として巻き込まない（右側境界）", () => {
    const text = "ADR 01460 は別の ADR である。";
    const { text: result, changes } = rewriteReferencesInText(text, renames);
    expect(result).toBe(text);
    expect(changes).toEqual([]);
  });

  it("oldNumber === newNumber（衝突していない）なら何もしない", () => {
    const text = "ADR 0173 と docs/decisions/0173-x.md を参照。";
    const { text: result, changes } = rewriteReferencesInText(text, [
      { oldNumber: "0173", newNumber: "0173", slug: "x" },
    ]);
    expect(result).toBe(text);
    expect(changes).toEqual([]);
  });

  it("空振り防止: 何も変わらないケースで changes が空であることを確認できる", () => {
    const { changes } = rewriteReferencesInText("何の関係も無い本文。", renames);
    expect(changes).toEqual([]);
  });
});

describe("addedLineNumbers — origin/main から継承した行を巻き込まないための境界", () => {
  it("新規ファイルの追加（全行が +）は、全行番号を返す", () => {
    const diff = ["@@ -0,0 +1,3 @@", "+line1", "+line2", "+line3"].join("\n");
    expect(addedLineNumbers(diff)).toEqual(new Set([1, 2, 3]));
  });

  it("既存ファイルへの1行挿入は、その行番号だけを返す（前後の既存行は含まない）", () => {
    // 元ファイルは3行、2行目の直後に1行挿入した想定（--unified=0 はコンテキストを持たない）。
    const diff = ["@@ -2,0 +3 @@", "+inserted"].join("\n");
    expect(addedLineNumbers(diff)).toEqual(new Set([3]));
  });

  it("削除だけのハンクは、追加行を含まない", () => {
    const diff = ["@@ -5,2 +4,0 @@", "-removed1", "-removed2"].join("\n");
    expect(addedLineNumbers(diff)).toEqual(new Set());
  });

  it("差分が無い（空文字列）なら空集合 — origin/main と同一のファイルは書き換え対象にならない", () => {
    expect(addedLineNumbers("")).toEqual(new Set());
  });

  it("複数ハンクにまたがる追加行を両方とも拾う", () => {
    const diff = ["@@ -1,0 +2 @@", "+a", "@@ -10,0 +12,2 @@", "+b", "+c"].join("\n");
    expect(addedLineNumbers(diff)).toEqual(new Set([2, 12, 13]));
  });

  it("応用: origin/main 由来の行に同居する衝突番号の言及は、追加行番号に含まれないので書き換え対象から外れる", () => {
    // 1行目は origin/main から継承（変更なし）、2行目だけこのブランチが追加した想定。
    const diff = ["@@ -1,0 +2 @@", "+新しい行に ADR 0146 への言及がある"].join("\n");
    const added = addedLineNumbers(diff);
    expect(added.has(1)).toBe(false); // 継承した1行目は対象外
    expect(added.has(2)).toBe(true); // このブランチが足した2行目だけが対象
  });
});

describe("renumberedReferenceWarning — 付け替えたときだけ PR タイトル・本文の警告を出す（Issue #405、本文への拡張はこの PR）", () => {
  it("付け替えが無い（空配列）なら null——毎回出ると読み飛ばされるため出さない", () => {
    expect(renumberedReferenceWarning([])).toBeNull();
  });

  it("undefined/null を渡しても null（呼び出し側の防御）", () => {
    expect(renumberedReferenceWarning(undefined)).toBeNull();
    expect(renumberedReferenceWarning(null)).toBeNull();
  });

  it("1件付け替えたら、旧番号->新番号と gh pr edit の使い方（タイトルと本文の両方）を含む警告を返す", () => {
    const warning = renumberedReferenceWarning([{ oldNumber: "0192", newNumber: "0193" }]);
    expect(warning).not.toBeNull();
    expect(warning).toContain("ADR 0192 -> ADR 0193");
    expect(warning).toContain("PR タイトル");
    expect(warning).toContain("本文");
    expect(warning).toContain("squash commit");
    expect(warning).toContain("gh pr edit <PR番号> --title");
    expect(warning).toContain("--body");
  });

  it("複数件付け替えたら、両方の旧番号->新番号を列挙する", () => {
    const warning = renumberedReferenceWarning([
      { oldNumber: "0173", newNumber: "0174" },
      { oldNumber: "0173", newNumber: "0175" },
    ]);
    expect(warning).toContain("ADR 0173 -> ADR 0174");
    expect(warning).toContain("ADR 0173 -> ADR 0175");
  });

  it("⛔ gh を呼べという指示は含むが、この関数自身は gh を実行しない（文字列を返すだけ）", () => {
    // 純関数であることの確認——副作用が無いことは型シグネチャからも自明だが、
    // 「文字列を組み立てるだけ」であることをここでも明示する。
    const warning = renumberedReferenceWarning([{ oldNumber: "0001", newNumber: "0002" }]);
    expect(typeof warning).toBe("string");
  });

  it("scripts/check-pr-adr-reference.mjs が CI で本文も検査することを警告文が指す", () => {
    const warning = renumberedReferenceWarning([{ oldNumber: "0199", newNumber: "0200" }]);
    expect(warning).toContain("check-pr-adr-reference.mjs");
  });
});

describe("findUnrewrittenAdrReferences — rewriteReferencesInText が届かない略記の連なりを検出する", () => {
  // 🔴 陽性対照: PR #614 が実際に `main`（74c5295）へ焼いた文字列そのもの。
  // 事後に PR #618（bf6e9e7）が人手で 0271 -> 0272 に直すまで、無関係な
  // ADR 0271（Issue #608 項目①、PR #612）を指したまま残っていた。
  const bakedLine1 = "（ADR 0269 の対象外、ADR 0270 / 0271 も引き継がない）。";
  const bakedLine2 =
    'describe("Runtime の非中核メソッド件数が、生きた文書に焼き込まれていない（ADR 0269 引き受けた負債、ADR 0270 / 0271）", () => {';
  const renames0271to0272 = [
    { oldNumber: "0271", newNumber: "0272", slug: "runtime-method-count-notation-sweep" },
  ];

  it("🔴 陽性対照1: 「ADR 0270 / 0271」の地の文で、0271 が付け替えられずに残った参照として報告される", () => {
    const hits = findUnrewrittenAdrReferences(bakedLine1, renames0271to0272);
    expect(hits).toEqual(expect.arrayContaining([expect.objectContaining({ oldNumber: "0271" })]));
    expect(hits.length).toBeGreaterThan(0);
  });

  it("🔴 陽性対照2: 同じ略記が describe の題に出てきても報告される", () => {
    const hits = findUnrewrittenAdrReferences(bakedLine2, renames0271to0272);
    expect(hits).toEqual(expect.arrayContaining([expect.objectContaining({ oldNumber: "0271" })]));
  });

  it("rewriteReferencesInText を先に通してから当てても、同じ0271が残っている（実際の配線と同じ順序）", () => {
    const { text: rewritten } = rewriteReferencesInText(bakedLine1, renames0271to0272);
    // rewriteReferencesInText 自体は「ADR 」に直接続く1個目（0270）しか見ないので、
    // このケースでは何も変わらない——0270 は renames の対象外だから。
    expect(rewritten).toBe(bakedLine1);
    const hits = findUnrewrittenAdrReferences(rewritten, renames0271to0272);
    expect(hits.map((h) => h.oldNumber)).toContain("0271");
  });

  it("⛔ 巻き込まない1: ADR の連なりの外に在る裸の4桁数字は報告しない", () => {
    const text = "2026年、issue 0271 は関係ない番号として登場する（日付でも起票番号でもない）。";
    expect(findUnrewrittenAdrReferences(text, renames0271to0272)).toEqual([]);
  });

  it("⛔ 巻き込まない2: 既に ADR 0272 の形で付け替え済みのものを二重に報告しない", () => {
    const text = "（ADR 0269 の対象外、ADR 0270 / 0272 も引き継がない）。";
    expect(findUnrewrittenAdrReferences(text, renames0271to0272)).toEqual([]);
  });

  it("⛔ 巻き込まない3: 連なりの中の、付け替え対象でない番号（他人の ADR）は報告しない", () => {
    // renames は 0271 -> 0272 だけを付け替えている。連なりの中の 0270 は
    // 誰も付け替えていない他人の ADR なので、報告に混ざってはいけない。
    const hits = findUnrewrittenAdrReferences(bakedLine1, renames0271to0272);
    expect(hits.map((h) => h.oldNumber)).not.toContain("0270");
    expect(hits.map((h) => h.oldNumber)).not.toContain("0269");
  });

  it("⛔ 巻き込まない4: 連なりが無い単独の「ADR NNNN」は rewriteReferencesInText 自身の射程なので報告しない", () => {
    const text = "ADR 0271 を見ること。";
    expect(findUnrewrittenAdrReferences(text, renames0271to0272)).toEqual([]);
  });

  it("空振り防止: 3連・4連の略記でも、途中に挟まった対象番号を拾う", () => {
    const text = "ADR 0011/0271/0028 と ADR 0011 / 0028 / 0271 の両方。";
    const hits = findUnrewrittenAdrReferences(text, renames0271to0272);
    expect(hits.length).toBe(2);
    expect(hits.every((h) => h.oldNumber === "0271")).toBe(true);
  });

  it("空振り防止: renames が空なら何も報告しない", () => {
    expect(findUnrewrittenAdrReferences(bakedLine1, [])).toEqual([]);
  });

  it("oldNumber === newNumber（衝突していない）の rename は対象にしない", () => {
    const text = "ADR 0270 / 0271 を見ること。";
    const hits = findUnrewrittenAdrReferences(text, [
      { oldNumber: "0271", newNumber: "0271", slug: "x" },
    ]);
    expect(hits).toEqual([]);
  });
});
