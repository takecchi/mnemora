import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  anchorExistsInTarget,
  classifyAdrDecisionCitation,
  findAdrAnchorCitations,
  findAdrDecisionReferences,
  findAdrDecisionSectionNumbers,
  findAdrLandingClaim,
  findAdrLineNumberCitations,
  lineNumberAt,
  normalizeForAdrDecisionReferences,
} from "../adr-citation-lib.mjs";

/**
 * 壊れた参照のフィクスチャは実行時に組み立てる。連続した形でソースに書くと、
 * 本物の歯がこのファイルを走査して、フィクスチャを壊れた参照として検出する。
 *
 * @param {string} adrNumber
 * @param {string} decisionNumber
 */
function cite(adrNumber, decisionNumber) {
  return "ADR" + " " + adrNumber + " " + "決定" + decisionNumber;
}

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));

function toRepoRelative(absolutePath) {
  return path.relative(REPO_ROOT, absolutePath).split(path.sep).join("/");
}

function collectMarkdownFiles(dir, acc = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === ".git") {
      continue;
    }
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      collectMarkdownFiles(full, acc);
    } else if (entry.name.endsWith(".md")) {
      acc.push(full);
    }
  }
  return acc;
}

function isLivingDoc(repoRelativeFile) {
  if (repoRelativeFile.startsWith("docs/decisions/")) {
    return false;
  }
  return (
    repoRelativeFile.startsWith("docs/") ||
    repoRelativeFile === "AGENTS.md" ||
    repoRelativeFile === "README.md"
  );
}

function collectLivingDocFiles() {
  const files = collectMarkdownFiles(path.join(REPO_ROOT, "docs"));
  for (const name of ["AGENTS.md", "README.md"]) {
    const p = path.join(REPO_ROOT, name);
    if (statSync(p, { throwIfNoEntry: false })) {
      files.push(p);
    }
  }
  return files.map(toRepoRelative).filter(isLivingDoc);
}

function buildAdrFileIndex() {
  const decisionsDir = path.join(REPO_ROOT, "docs/decisions");
  const map = new Map();
  for (const name of readdirSync(decisionsDir)) {
    if (!name.endsWith(".md")) {
      continue;
    }
    const m = name.match(/^(\d{4})-/);
    if (m) {
      map.set(m[1], path.join(decisionsDir, name));
    }
  }
  return map;
}

describe("findAdrLineNumberCitations（fixture）", () => {
  it("combined 形: docs/decisions/ 接頭辞あり", () => {
    const text = "詳細は `docs/decisions/0147-recall-footprint-estimator.md:118-121` を見ること。";
    const hits = findAdrLineNumberCitations(text);
    expect(hits).toEqual([
      {
        index: text.indexOf("`"),
        line: 1,
        raw: "`docs/decisions/0147-recall-footprint-estimator.md:118-121`",
        adrNumber: "0147",
        kind: "combined",
      },
    ]);
  });

  it("combined 形: 接頭辞なし・単一行番号", () => {
    const text = "`0082-tick-names-unsupported-job-kinds.md:216` に書いてある。";
    const hits = findAdrLineNumberCitations(text);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ adrNumber: "0082", kind: "combined" });
  });

  it("combined 形: ファイル名がリテラルな連続ピリオドへ省略された形（実地で見つかった一族）", () => {
    const text = "解消は `docs/decisions/0070-....md:139-142` を見ること。";
    const hits = findAdrLineNumberCitations(text);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ adrNumber: "0070", kind: "combined" });
  });

  it("combined 形: バッククォートの中に改行を1つ挟んで行番号が続く形", () => {
    const text = "残っている（`docs/decisions/0066-....md:11,\n241-267`）。解消は……";
    const hits = findAdrLineNumberCitations(text);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({
      adrNumber: "0066",
      kind: "combined",
      raw: "`docs/decisions/0066-....md:11,\n241-267`",
    });
  });

  it("adr-comma-line 形: 全角読点 + 範囲 + 行", () => {
    const text = "ADR 0067、124-130行。【読んで確かめた】";
    const hits = findAdrLineNumberCitations(text);
    expect(hits).toEqual([
      { index: 0, line: 1, raw: "ADR 0067、124-130行", adrNumber: "0067", kind: "adr-comma-line" },
    ]);
  });

  it("adr-comma-line 形: 単一行番号", () => {
    const text = "ADR 0066、391行に明記。";
    const hits = findAdrLineNumberCitations(text);
    expect(hits).toEqual([
      { index: 0, line: 1, raw: "ADR 0066、391行", adrNumber: "0066", kind: "adr-comma-line" },
    ]);
  });

  it("adr-paren-colon 形", () => {
    const text = "ADR 0030（`:29-37`）が既にこれを名指ししていた";
    const hits = findAdrLineNumberCitations(text);
    expect(hits).toEqual([
      {
        index: 0,
        line: 1,
        raw: "ADR 0030（`:29-37`）",
        adrNumber: "0030",
        kind: "adr-paren-colon",
      },
    ]);
  });

  it("md-link-colon 形: リンクへ直接バッククォートコロンが続く（0字接続）", () => {
    const text = "[ADR 0078](./0078-strength-value-range.md)`:251-253` は逐語で";
    const hits = findAdrLineNumberCitations(text);
    expect(hits).toEqual([
      {
        index: 0,
        line: 1,
        raw: "[ADR 0078](./0078-strength-value-range.md)`:251-253`",
        adrNumber: "0078",
        kind: "md-link-colon",
      },
    ]);
  });

  it("md-link-colon 形: リンクと接続詞「の」を挟む形", () => {
    const text =
      "[ADR 0172](./decisions/0172-association-passes-decay-and-validity-gates.md) の `:249` が";
    const hits = findAdrLineNumberCitations(text);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ adrNumber: "0172", kind: "md-link-colon" });
  });

  it("omitted-reference 形: 直前に登場した ADR ファイルを指す省略形（`同 `:NN``）", () => {
    const text =
      "`0082-tick-names-unsupported-job-kinds.md:216`: 「本体を実装する人は」\n" +
      "同 `:82`: 「作業の途中で」";
    const hits = findAdrLineNumberCitations(text);
    expect(hits.map((h) => h.kind)).toEqual(["combined", "omitted-reference"]);
    expect(hits[1]).toMatchObject({ adrNumber: "0082", raw: "同 `:82`" });
  });

  it("omitted-reference 形: 直前が markdown link 付きの ADR 引用でも解決できる", () => {
    const text =
      "加えて [ADR 0078](./0078-strength-value-range.md)`:251-253` は逐語で\n" +
      "「蓋だけを、先に付けた。」\n" +
      "と書いており、同 `:326-331` の「これが覆るとしたら」は";
    const hits = findAdrLineNumberCitations(text);
    const omitted = hits.find((h) => h.kind === "omitted-reference");
    expect(omitted).toMatchObject({ adrNumber: "0078", raw: "同 `:326-331`" });
  });

  it("omitted-reference 形: 直前の対象が ADR ではなくソースファイルなら数えない（`同ファイル`）", () => {
    const text =
      "`packages/local-embedding/src/local-embedding-provider.ts` の型を公開しない" +
      "（同ファイル `:51-53`）。";
    const hits = findAdrLineNumberCitations(text);
    expect(hits).toEqual([]);
  });

  it("複数の書き方が同じテキストに混在しても全部拾う", () => {
    const text = [
      "`docs/decisions/0070-version-comes-from-the-release-tag.md:66-78`",
      "ADR 0067、124-130行",
      "ADR 0030（`:29-37`）",
      "[ADR 0078](./0078-strength-value-range.md)`:251-253`",
    ].join("\n");
    const hits = findAdrLineNumberCitations(text);
    expect(hits.map((h) => h.kind)).toEqual([
      "combined",
      "adr-comma-line",
      "adr-paren-colon",
      "md-link-colon",
    ]);
  });

  describe("偽陽性の罠（「行」は row の意味でも大量に使われる）", () => {
    const traps = [
      [
        "「1行も変えない」は行番号ではない",
        "⛔ 実装は1行も変えない。本 ADR は測定と訂正の記録だけである。",
      ],
      [
        "「100,000行」は投入した件数であって行番号ではない",
        "100,000行を投入し、以降 ANALYZE を一切走らせない",
      ],
      [
        "ADR の直後でも「210行」は件数であって行番号ではない",
        "ADR 0108 が実測した通り、いまは 210行すべてで score.lexicalMatch の欄そのものが存在せず",
      ],
      [
        "「§11 行5」は他文書の節番号であって ADR の行番号ではない（行が数字の前に来る）",
        "docs/memory-model.md §11 行5・本節末尾「破棄系」の節が要求する",
      ],
      [
        "「ADR 64本」はADRの本数であって行番号ではない（4桁でない）",
        "docs/decisions/ 配下の ADR 64本（0001〜0064、READMEの一覧表の件数と一致）",
      ],
      [
        "ADR の直後の「1行目」は構造の説明であって特定行の引用ではない（実地の反例、間隔は拾いたい例より短い）",
        "ADR 0067 は `#` の見出しを1行目にしか持たず、節はすべて `- **見出し語**:` の箇条書きである。",
      ],
    ];
    it.each(traps)("%s", (_label, text) => {
      expect(findAdrLineNumberCitations(text)).toEqual([]);
    });
  });
});

describe("lineNumberAt（fixture）", () => {
  it("改行の数から1始まりの行番号を出す", () => {
    const text = "a\nb\nc";
    expect(lineNumberAt(text, 0)).toBe(1);
    expect(lineNumberAt(text, 2)).toBe(2);
    expect(lineNumberAt(text, 4)).toBe(3);
  });
});

describe("findAdrAnchorCitations + anchorExistsInTarget（fixture）", () => {
  it("0字接続: `ADR NNNN「...」`", () => {
    const text = "ADR 0067「⭐ (B) の一般化 — この ADR の芯」を読むこと。";
    const hits = findAdrAnchorCitations(text);
    expect(hits).toEqual([
      {
        index: 0,
        line: 1,
        raw: "ADR 0067「⭐ (B) の一般化 — この ADR の芯」",
        adrNumber: "0067",
        quote: "⭐ (B) の一般化 — この ADR の芯",
      },
    ]);
  });

  it("markdown link + 「...」も拾う（0字接続）", () => {
    const text =
      "[ADR 0202](./0202-postgres-shared-db-object-names.md)「引き受けた負債」を解消する";
    const hits = findAdrAnchorCitations(text);
    expect(hits).toEqual([
      {
        index: 0,
        line: 1,
        raw: "[ADR 0202](./0202-postgres-shared-db-object-names.md)「引き受けた負債」",
        adrNumber: "0202",
        quote: "引き受けた負債",
      },
    ]);
  });

  it("句点をまたぐ「...」は拾わない（無関係な段落の鉤括弧への誤爆を防ぐ）", () => {
    const text = "ADR 0067 は分岐ごと覆る」。**⟹ オーナーが「後者でいいです」と述べた。";
    const hits = findAdrAnchorCitations(text);
    expect(hits).toEqual([]);
  });

  it("改行をまたぐ「...」は拾わない", () => {
    const text = "ADR 0165 を読むこと。\n\n「これは無関係な引用」である。";
    expect(findAdrAnchorCitations(text)).toEqual([]);
  });

  it("⚠ 既知の限界: 30字以内・句点なしなら無関係な「...」も拾ってしまう（意図的な線引き、報告に明記）", () => {
    const text = "ADR 0999 とは別の段落に「離れた引用」がある。";
    const hits = findAdrAnchorCitations(text);
    expect(hits).toHaveLength(1);
    expect(hits[0].quote).toBe("離れた引用");
  });

  describe("anchorExistsInTarget", () => {
    it("そのまま存在すれば true", () => {
      expect(anchorExistsInTarget("引き受けた負債", "- **引き受けた負債**:\n  ...")).toBe(true);
    });

    it("存在しなければ false", () => {
      expect(anchorExistsInTarget("存在しない架空の見出し", "- **決定**:\n  ...")).toBe(false);
    });

    it("末尾の素の数字を取り除くと一致する場合を拾う（見出しが番号無しで、引用側だけが項番を足す形）", () => {
      expect(
        anchorExistsInTarget("引き受けた負債3", "- **引き受けた負債・覆えていない範囲**:\n"),
      ).toBe(true);
    });

    it("数字が引用の一部として本当に存在する場合もそのまま拾う", () => {
      expect(anchorExistsInTarget("採らなかった案4", "（採らなかった案4）。次の一手は……")).toBe(
        true,
      );
    });

    it("太字 `**` の境界がずれていても中身が一致すれば拾う（記法だけの差）", () => {
      expect(
        anchorExistsInTarget(
          "**オーナーの承認待ちである 【伝】**",
          "後者を採ったのはクローンの判断であり、**オーナーの承認待ちである 【伝】。**",
        ),
      ).toBe(true);
    });

    it("インラインコードのバッククォートの有無がずれていても中身が一致すれば拾う（記法だけの差）", () => {
      expect(
        anchorExistsInTarget(
          "similarity は −1 まで負になりうる",
          "`similarity` は **−1 まで負になりうる**（ADR 0033",
        ),
      ).toBe(true);
    });

    it("引用先が markdown リンク `[表示](url)` を含んでいても、表示文字で一致すれば拾う（target 側）", () => {
      expect(
        anchorExistsInTarget(
          "🔴 線は引けない — ADR 0178 が反例",
          "#### 🔴 線は引けない — [ADR 0178](./docs/decisions/0178-public-api-surface-gate.md) が反例",
        ),
      ).toBe(true);
    });

    it("引用側が markdown リンクを含んでいても、表示文字で一致すれば拾う（anchor 側）", () => {
      expect(
        anchorExistsInTarget(
          "🔴 線は引けない — [ADR 0178](./docs/decisions/0178-public-api-surface-gate.md) が反例",
          "#### 🔴 線は引けない — ADR 0178 が反例",
        ),
      ).toBe(true);
    });

    it("リンクを外しても表示文字が違えば false のまま（url の中身では一致させない）", () => {
      expect(
        anchorExistsInTarget(
          "線は引けない — ADR 0179 が反例",
          "#### 🔴 線は引けない — [ADR 0178](./docs/decisions/0179-foo.md) が反例",
        ),
      ).toBe(false);
    });

    it("記法を揃えても中身が違えば false のまま（ニックネーム/言い換えは実在しないと判定する）", () => {
      expect(
        anchorExistsInTarget("無いには種類がある", "# ADR 0008: 「無い」を分類して返す\n"),
      ).toBe(false);
    });
  });
});

/** 再現率の歯。既知の引用18件を静的なリテラルで持つ。実物の docs を読むと、docs の書き換えで腐る。 */
describe("再現率: 既知の18件（静的 fixture、doc の改変で腐らない）", () => {
  const KNOWN_OLD_STYLE_CITATIONS = [
    {
      raw: "`docs/decisions/0070-version-comes-from-the-release-tag.md:66-78`",
      kind: "combined",
      adrNumber: "0070",
    },
    {
      raw: "`docs/decisions/0060-publish-with-pnpm-four-packages-at-0-1-0.md:54-66`",
      kind: "combined",
      adrNumber: "0060",
    },
    { raw: "ADR 0067、124-130行", kind: "adr-comma-line", adrNumber: "0067" },
    {
      raw: "`docs/decisions/0067-dry-run-fail-open-and-does-not-verify-trusted-publisher.md:118-134`",
      kind: "combined",
      adrNumber: "0067",
    },
    { raw: "ADR 0067、82-114行", kind: "adr-comma-line", adrNumber: "0067" },
    { raw: "`docs/decisions/0060-....md:140`", kind: "combined", adrNumber: "0060" },
    { raw: "`docs/decisions/0070-....md:139-142`", kind: "combined", adrNumber: "0070" },
    {
      raw: "`docs/decisions/0066-....md:11,\n241-267`",
      kind: "combined",
      adrNumber: "0066",
    },
    { raw: "`docs/decisions/0070-....md:113-116`", kind: "combined", adrNumber: "0070" },
    { raw: "`docs/decisions/0070-....md:122-131`", kind: "combined", adrNumber: "0070" },
    { raw: "`docs/decisions/0067-....md:100-103`", kind: "combined", adrNumber: "0067" },
    { raw: "`docs/decisions/0070-....md:118-121`", kind: "combined", adrNumber: "0070" },
    { raw: "ADR 0066、391行", kind: "adr-comma-line", adrNumber: "0066" },
    { raw: "`docs/decisions/0066-....md:131`", kind: "combined", adrNumber: "0066" },
    { raw: "`docs/decisions/0070-....md:138`", kind: "combined", adrNumber: "0070" },
    { raw: "`docs/decisions/0070-....md:174-175`", kind: "combined", adrNumber: "0070" },
    {
      raw: "[ADR 0172](./decisions/0172-association-passes-decay-and-validity-gates.md) の `:249`",
      kind: "md-link-colon",
      adrNumber: "0172",
    },
    {
      raw: "[ADR 0172](./decisions/0172-association-passes-decay-and-validity-gates.md) の `:249`",
      kind: "md-link-colon",
      adrNumber: "0172",
    },
  ];

  const FIXTURE_TEXT = KNOWN_OLD_STYLE_CITATIONS.map(
    (c, i) => `${i}. 文脈: ${c.raw} を見ること。`,
  ).join("\n");

  it("18件ちょうど見つかる（取りこぼしも過検出も無い）", () => {
    const hits = findAdrLineNumberCitations(FIXTURE_TEXT);
    expect(hits).toHaveLength(18);
  });

  it.each(KNOWN_OLD_STYLE_CITATIONS.map((c, i) => [i, c]))(
    "%i件目 ($kind, ADR $adrNumber) を拾う",
    (i, expected) => {
      const hits = findAdrLineNumberCitations(FIXTURE_TEXT);
      const found = hits.find((h) => h.raw === expected.raw && h.kind === expected.kind);
      expect(found).toBeDefined();
      expect(found.adrNumber).toBe(expected.adrNumber);
    },
  );
});

describe("🔴 本物の歯1: 生きた文書に ADR への行番号引用が無いこと（実物）", () => {
  it("生きた文書のどこにも、ADR を行番号で指す引用が無い", () => {
    const violations = [];
    for (const file of collectLivingDocFiles()) {
      const text = readFileSync(path.join(REPO_ROOT, file), "utf8");
      for (const citation of findAdrLineNumberCitations(text)) {
        violations.push({ file, ...citation });
      }
    }
    expect(violations).toEqual([]);
  });

  it("⭐ 走査の母集合の確認（Issue #1812 G7）: 生きた文書の集め方が空・狭すぎず、ADR 本体を含まない", () => {
    const files = collectLivingDocFiles();
    expect(files).toContain("AGENTS.md");
    expect(files).toContain("README.md");
    expect(files).toContain("docs/roadmap.md");
    expect(files).toContain("docs/release-v1.md");
    expect(files.filter((file) => file.startsWith("docs/decisions/"))).toEqual([]);
  });

  it("⭐ mutation guard: 検出器は生きていて、ADR 本体（docs/decisions/）の中の行番号引用は実際に見つける", () => {
    const text = readFileSync(
      path.join(REPO_ROOT, "docs/decisions/0087-runtime-forget-shape.md"),
      "utf8",
    );
    const hits = findAdrLineNumberCitations(text);
    expect(hits.some((h) => h.kind === "adr-paren-colon" && h.adrNumber === "0030")).toBe(true);
  });
});

/** repo 全体には掛けず、移行対象の3ファイルに絞る。ADR 本体のアンカーは書き換わらないので腐らない。 */
describe("🔴 移行の検算: この PR が入れたアンカーが、引用先の ADR に実在すること", () => {
  // 「見つかったアンカーは全部実在する」は歯にしない。あだ名や逐語の引用（「…」）が混ざり、3ファイルでも14件が実在しない。
  // 代わりに、移行で入れたものだけを名指しで検算する（ADR の本文は書き換えない（ADR 0064）ので、この一覧は腐らない）。
  const INTRODUCED_ANCHORS = [
    ["0070", "⭐ 測ったこと1 — `workspace:^` は書き込んだ版で解決される（この設計の要）"],
    ["0070", "⭐ 測ったこと3 — Trusted Publishing (OIDC) と provenance が実際に通った"],
    ["0070", "npm 上の `0.1.0` がどの commit とも一致しない"],
    ["0070", "npm error 403 Forbidden - PUT https://registry.npmjs.org/@mnemora%2fcore"],
    ["0070", "不一致なら npm は 404 を返す"],
    ["0070", "attestation 2件"],
    ["0070", '`npm publish --tag ""` の挙動をこの器で確かめていない'],
    ["0060", "2. `npm pack` は `workspace:*` を置換しない。`pnpm pack` は置換する。"],
    ["0066", "⭐ 測ったこと10 — npm 上の `0.1.0` は、この ADR が入る commit と一致しない"],
    ["0066", "⚠ npm は保存時に設定を検証しない"],
    ["0066", "Node 22 同梱の npm 10.x では OIDC の交換を実装しておらず"],
    ["0067", "⭐ (B) の一般化 — この ADR の芯"],
    ["0067", "(B) 🔴 予行は、信頼発行元の設定を検算していない"],
    ["0067", "同じ `OIDC permission denied` が返る可能性を、この作業者は排除できていない"],
    ["0172", "段3.5 の候補は段2の閾値分割を通らない"],
  ];

  const adrFileIndex = buildAdrFileIndex();

  it.each(INTRODUCED_ANCHORS)("ADR %s「%s」が引用先に実在する", (adrNumber, anchor) => {
    const targetPath = adrFileIndex.get(adrNumber);
    expect(targetPath).toBeDefined();
    const targetText = readFileSync(targetPath, "utf8");
    expect(anchorExistsInTarget(anchor, targetText)).toBe(true);
  });

  it("⭐ mutation guard: 実在しない架空の引用は、実物の ADR 本文に対して false になる", () => {
    const targetText = readFileSync(
      path.join(
        REPO_ROOT,
        "docs/decisions/0067-dry-run-fail-open-and-does-not-verify-trusted-publisher.md",
      ),
      "utf8",
    );
    expect(
      anchorExistsInTarget("この文字列はどの ADR にも実在しない架空のアンカー_QA9Z", targetText),
    ).toBe(false);
  });
});

describe("normalizeForAdrDecisionReferences（fixture）", () => {
  it("markdown リンク記法を表示文字へ外す", () => {
    const text = "[" + "ADR 0067" + "](./0067-x.md) 決定" + "3";
    const { normalized } = normalizeForAdrDecisionReferences(text);
    expect(normalized).toBe(cite("0067", "3"));
  });

  it("太字・インラインコード・打ち消し線・バックスラッシュを除去する", () => {
    const text = "**ADR** `0067` ~決定~\\3";
    const { normalized } = normalizeForAdrDecisionReferences(text);
    expect(normalized).toBe(cite("0067", "3"));
  });

  it("表の `|` を空白として扱う", () => {
    const text = "|ADR 0067|決定3|";
    const { normalized } = normalizeForAdrDecisionReferences(text);
    expect(normalized).toContain(cite("0067", "3"));
  });

  it("改行を含む全空白を1個の半角空白へ潰す（0234 と 決定9 が行をまたぐ実例がある）", () => {
    const text = "ADR\n  0234\n決定9";
    const { normalized } = normalizeForAdrDecisionReferences(text);
    expect(normalized).toBe(cite("0234", "9"));
  });

  it("indexMap は正規化後の各文字が元テキストのどこから来たかを保つ", () => {
    const text = "先頭\nADR 0067 決定3";
    const { normalized, indexMap } = normalizeForAdrDecisionReferences(text);
    const at = normalized.indexOf("ADR");
    expect(text.slice(indexMap[at], indexMap[at] + 3)).toBe("ADR");
  });
});

describe("findAdrDecisionReferences（fixture）", () => {
  it("素の形を1件見つける", () => {
    const text = "詳細は" + cite("0100", "3") + "を見ること。";
    const hits = findAdrDecisionReferences(text);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ adrNumber: "0100", decisionNumber: "3" });
  });

  it("行番号（line）は正規化前の元テキストの行を指す", () => {
    const text = "1行目\n2行目\n" + cite("0100", "3") + " が3行目に在る";
    const hits = findAdrDecisionReferences(text);
    expect(hits).toHaveLength(1);
    expect(hits[0].line).toBe(3);
  });

  it("[表示文字](url) のリンク記法をまたいでも見つける", () => {
    const text = "[" + "ADR 0100" + "](./0100-x.md) 決定3 を見ること。";
    const hits = findAdrDecisionReferences(text);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ adrNumber: "0100", decisionNumber: "3" });
  });

  it("改行をまたぐ形も見つける（🔴 実測: 素の grep では拾えない実例）", () => {
    const text = "ADR\n0100\n決定\n3";
    const hits = findAdrDecisionReferences(text);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ adrNumber: "0100", decisionNumber: "3" });
  });

  it("複数の参照が混在してもすべて見つける", () => {
    const text = [cite("0100", "1"), "本文", cite("0200", "9")].join("\n");
    const hits = findAdrDecisionReferences(text);
    expect(hits.map((h) => `${h.adrNumber}/${h.decisionNumber}`)).toEqual(["0100/1", "0200/9"]);
  });

  it("「決定」を含まない ADR への素の言及は拾わない", () => {
    const text = "ADR 0100 を読むこと。";
    expect(findAdrDecisionReferences(text)).toEqual([]);
  });
});

describe("findAdrDecisionSectionNumbers（fixture）", () => {
  it("見出し型コンテナ（## 決定）+ ### 決定N. 見出し", () => {
    const text = ["## 決定", "", "### 決定1. 最初の決定", "本文", "", "### 決定2. 次の決定"].join(
      "\n",
    );
    expect(findAdrDecisionSectionNumbers(text)).toEqual(new Set(["1", "2"]));
  });

  it("見出し型コンテナ（## 決めたこと）+ 番号だけの見出し（### N.）", () => {
    const text = ["## 決めたこと", "", "### 1. 最初", "", "### 2. 次"].join("\n");
    expect(findAdrDecisionSectionNumbers(text)).toEqual(new Set(["1", "2"]));
  });

  it("見出し型コンテナ + 箇条書きの `N. `", () => {
    const text = ["## 決定", "", "1. 最初の決定", "", "2. 次の決定"].join("\n");
    expect(findAdrDecisionSectionNumbers(text)).toEqual(new Set(["1", "2"]));
  });

  it("見出し型コンテナ + 表の `| N |`", () => {
    const text = ["## 決定", "", "| N | 内容 |", "|---|---|", "| 1 | 最初 |", "| 2 | 次 |"].join(
      "\n",
    );
    expect(findAdrDecisionSectionNumbers(text)).toEqual(new Set(["1", "2"]));
  });

  it("🔴 罠②の回帰: 字下げした見出し（`- **決定**:` の直下に字下げした `## 決定N:`）も拾う", () => {
    // 見出し検出を `^#{2,4}` に戻すと、字下げした見出しを1つも拾えなくなる。
    const text = [
      "- **決定**:",
      "",
      "  ## 決定1: 最初の決定",
      "",
      "  本文がここに続く",
      "",
      "  ## 決定2: 次の決定",
    ].join("\n");
    expect(findAdrDecisionSectionNumbers(text)).toEqual(new Set(["1", "2"]));
  });

  it("太字箇条書きラベル型コンテナ（`- **決定**:`）+ 太字段落 `**N. …**`（0060 等、古い ADR の形）", () => {
    const text = [
      "- **決定**:",
      "",
      "  **1. 最初の決定。**",
      "",
      "  補足の本文。",
      "",
      "  **2. 次の決定。**",
      "",
      "- **採らなかった案**:",
      "",
      "  | 案 | 理由 |",
      "  |---|---|",
      "  | 3. これは決定ではない | 却下 |",
    ].join("\n");
    expect(findAdrDecisionSectionNumbers(text)).toEqual(new Set(["1", "2"]));
  });

  it("コンテナが閉じたあとの番号付きリストは数えない（無関係な章との混同防止）", () => {
    const text = [
      "## 決定",
      "",
      "### 決定1. 唯一の決定",
      "",
      "## 採らなかった案",
      "",
      "1. これは決定ではない",
      "2. これも決定ではない",
    ].join("\n");
    expect(findAdrDecisionSectionNumbers(text)).toEqual(new Set(["1"]));
  });

  it("直接見出し型（`決定N.`）は、コンテナの外でも拾う", () => {
    const text = ["## 文脈", "", "### 決定9. 唐突に出てくる決定", "本文"].join("\n");
    expect(findAdrDecisionSectionNumbers(text)).toEqual(new Set(["9"]));
  });

  it("決定セクションが無ければ空集合", () => {
    const text = ["## 文脈", "", "### 1. これは決定ではない", "", "## 引き受けた負債"].join("\n");
    expect(findAdrDecisionSectionNumbers(text)).toEqual(new Set());
  });
});

describe("findAdrLandingClaim（fixture）", () => {
  it("h1 が「ADR S 決定N の射程を…へ広げる」と名乗っていれば検出する", () => {
    const h1 =
      "# ADR 0250: 機械には「検出」までを担わせる — " +
      cite("0223", "2") +
      " の射程を `AGENTS.md` へ広げる（Issue #505）";
    expect(findAdrLandingClaim(h1)).toEqual({ sourceAdrNumber: "0223", decisionNumber: "2" });
  });

  it("名乗っていなければ null", () => {
    const h1 = "# ADR 0234: 「焼き込んだ数字は腐る」の道具・生成物版を `AGENTS.md` へ置く";
    expect(findAdrLandingClaim(h1)).toBeNull();
  });

  it("本文中に同じ文言があっても、h1（1行目）以外は見ない", () => {
    const text = ["# ADR 0999: 無関係な見出し", "本文に" + cite("0223", "2") + " の射程を"].join(
      "\n",
    );
    expect(findAdrLandingClaim(text)).toBeNull();
  });
});

describe("classifyAdrDecisionCitation（fixture）", () => {
  it("X が存在しなければ規則A（死んだポインタ）", () => {
    expect(
      classifyAdrDecisionCitation("9", { targetSectionNumbers: null, targetLandingClaim: null }),
    ).toEqual({ ruleA: true, ruleB: false });
  });

  it("X の決定セクションに N が無ければ規則A", () => {
    expect(
      classifyAdrDecisionCitation("9", {
        targetSectionNumbers: new Set(["1", "2", "3", "4"]),
        targetLandingClaim: null,
      }),
    ).toEqual({ ruleA: true, ruleB: false });
  });

  it("X が自前の決定Nを持ち、着地先でもなければどちらの規則も違反しない", () => {
    expect(
      classifyAdrDecisionCitation("1", {
        targetSectionNumbers: new Set(["1", "2"]),
        targetLandingClaim: null,
      }),
    ).toEqual({ ruleA: false, ruleB: false });
  });

  it("X が同じ番号Nの着地先なら規則B（曖昧な略記）", () => {
    expect(
      classifyAdrDecisionCitation("2", {
        targetSectionNumbers: new Set(["1", "2"]),
        targetLandingClaim: { sourceAdrNumber: "0223", decisionNumber: "2" },
      }),
    ).toEqual({ ruleA: false, ruleB: true });
  });

  it("🔴 過剰実装への歯止め: X が『別の番号』の着地先でも、番号が違えば規則Bは立たない", () => {
    expect(
      classifyAdrDecisionCitation("1", {
        targetSectionNumbers: new Set(["1", "2"]),
        targetLandingClaim: { sourceAdrNumber: "0223", decisionNumber: "2" },
      }),
    ).toEqual({ ruleA: false, ruleB: false });
  });
});

/** `docs/decisions/` は採用状態を問わず一律で門の外にする。状態で切り替えると、草案が採用された瞬間に同じ参照が門の外へ消え、射程が揺れる。 */
describe("🔴 本物の歯3: 「ADR X 決定N」の壊れた参照が、生きたコード・生きた文書に無いこと（実物）", () => {
  /** 基準値ファイル（`examples/chat/*-baseline.json`）も除外しない。ADR を名指す参照は、人が書き足した `_readme` / `provenance` の欄にある。 */
  const GATED_SOURCE_EXTENSIONS = new Set([
    ".md",
    ".mjs",
    ".cjs",
    ".js",
    ".ts",
    ".tsx",
    ".mts",
    ".cts",
    ".yml",
    ".yaml",
    ".json",
    ".sql",
  ]);
  const EXCLUDED_DIR_NAMES = new Set([
    "node_modules",
    ".git",
    "dist",
    "build",
    ".turbo",
    "coverage",
    ".tmp",
  ]);

  function collectAllSourceFiles(dir, acc = []) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (EXCLUDED_DIR_NAMES.has(entry.name)) {
        continue;
      }
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        collectAllSourceFiles(full, acc);
      } else if (GATED_SOURCE_EXTENSIONS.has(path.extname(entry.name))) {
        acc.push(full);
      }
    }
    return acc;
  }

  const adrFileIndexAll = buildAdrFileIndex();
  const adrTextCache = new Map();
  /** @param {string} adrNumber @returns {string | null} */
  function getAdrText(adrNumber) {
    if (!adrFileIndexAll.has(adrNumber)) {
      return null;
    }
    if (!adrTextCache.has(adrNumber)) {
      adrTextCache.set(adrNumber, readFileSync(adrFileIndexAll.get(adrNumber), "utf8"));
    }
    return adrTextCache.get(adrNumber);
  }

  /** 対応表は持たず、両側を実行時に repo から読んで突き合わせる。 */
  function classifyCitation(adrNumber, decisionNumber) {
    const targetText = getAdrText(adrNumber);
    return classifyAdrDecisionCitation(decisionNumber, {
      targetSectionNumbers: targetText === null ? null : findAdrDecisionSectionNumbers(targetText),
      targetLandingClaim: targetText === null ? null : findAdrLandingClaim(targetText),
    });
  }

  /** @param {string} rootDir */
  function collectDecisionCitationViolations(rootDir) {
    const gated = [];
    const ungated = [];
    for (const full of collectAllSourceFiles(rootDir)) {
      const file = path.relative(rootDir, full).split(path.sep).join("/");
      const isAdrBody = file.startsWith("docs/decisions/");
      const text = readFileSync(full, "utf8");
      for (const ref of findAdrDecisionReferences(text)) {
        const { ruleA, ruleB } = classifyCitation(ref.adrNumber, ref.decisionNumber);
        if (!ruleA && !ruleB) {
          continue;
        }
        const entry = { file, line: ref.line, raw: ref.raw, ruleA, ruleB };
        (isAdrBody ? ungated : gated).push(entry);
      }
    }
    return { gated, ungated };
  }

  const { gated: gatedViolations, ungated: ungatedViolations } =
    collectDecisionCitationViolations(REPO_ROOT);

  it("生きたコード・生きた文書に、規則A（死んだポインタ）・規則B（曖昧な着地略記）の違反が無い", () => {
    expect(gatedViolations).toEqual([]);
  });

  it.each([".json", ".sql", ".mts", ".cts"])(
    "⭐ 陽性対照（Issue #652）: %s のファイルに置いた死んだポインタを、門が違反として拾う",
    (extension) => {
      expect(findAdrDecisionSectionNumbers(getAdrText("0201")).has("99")).toBe(false);

      // 連結で組み立てる（素で書くと、このファイル自身が門の対象で赤くなる）。
      const deadRef = "ADR 0201 決定" + "99";
      const dir = mkdtempSync(path.join(tmpdir(), "adr-citation-ext-"));
      try {
        const fileName = `dead-pointer${extension}`;
        writeFileSync(path.join(dir, fileName), `-- ${deadRef} を参照する\n`);
        const { gated } = collectDecisionCitationViolations(dir);
        expect(gated).toEqual([
          { file: fileName, line: 1, raw: deadRef, ruleA: true, ruleB: false },
        ]);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  /** repo 直下の `.tmp/` は歩かない。`no-unhandled-errors.test.mjs` が並行に fixture を作っては消すので、読む前に消えて ENOENT で落ちる。 */
  it("`.tmp/` の下のファイルは門の対象にしない（並行に走る歯の一時ファイルを読みにいかない）", () => {
    const deadRef = "ADR 0201 決定" + "99";
    const dir = mkdtempSync(path.join(tmpdir(), "adr-citation-tmp-"));
    try {
      mkdirSync(path.join(dir, ".tmp", "scratch"), { recursive: true });
      writeFileSync(path.join(dir, ".tmp", "scratch", "fixture.mjs"), `// ${deadRef}\n`);
      writeFileSync(path.join(dir, "outside.mjs"), `// ${deadRef}\n`);
      const { gated } = collectDecisionCitationViolations(dir);
      expect(gated).toEqual([
        { file: "outside.mjs", line: 1, raw: deadRef, ruleA: true, ruleB: false },
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it(`⛔ 門ではない一覧: docs/decisions/ 配下の ADR 本文にも同型の参照が ${ungatedViolations.length} 件見つかっている（この件数では赤くしない）`, () => {
    // ADR 本文の違反は直せないので赤にせず、件数と内訳を出力へ残すだけにする。
    if (ungatedViolations.length > 0) {
      console.log(
        "docs/decisions/ 配下で見つかった「ADR X 決定N」の壊れた参照（門の対象外・訂正は追記で対応済み/対応中）:",
        JSON.stringify(ungatedViolations, null, 2),
      );
    }
    expect(Array.isArray(ungatedViolations)).toBe(true);
  });

  it("⭐ mutation guard（規則A）: 実物の ADR 本文に残る、決定セクション不在の参照を正しく拾う", () => {
    // canary は採用済みの `0254` にする。提案中の ADR は本文を直せるので、直された瞬間に何も見つけないまま緑になる。
    const text = readFileSync(
      path.join(REPO_ROOT, "docs/decisions/0254-no-gate-without-a-false-positive-ceiling.md"),
      "utf8",
    );
    const refs = findAdrDecisionReferences(text).filter(
      (r) => r.adrNumber === "0234" && r.decisionNumber === "9",
    );
    expect(refs.length).toBeGreaterThan(0);
    const numbers = findAdrDecisionSectionNumbers(getAdrText("0234"));
    expect(numbers.has("9")).toBe(false);
  });

  it("⭐ mutation guard（規則B）: 実物の ADR 本文に残る、曖昧な着地略記を正しく拾う", () => {
    const text = readFileSync(
      path.join(REPO_ROOT, "docs/decisions/0254-no-gate-without-a-false-positive-ceiling.md"),
      "utf8",
    );
    const refs = findAdrDecisionReferences(text).filter(
      (r) => r.adrNumber === "0250" && r.decisionNumber === "2",
    );
    expect(refs.length).toBeGreaterThan(0);
    const claim = findAdrLandingClaim(getAdrText("0250"));
    expect(claim).toEqual({ sourceAdrNumber: "0223", decisionNumber: "2" });
  });
});
