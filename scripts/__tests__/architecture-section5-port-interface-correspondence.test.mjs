import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * 正本は `packages/core/src/` を自前でパースせず、公開 API snapshot（`scripts/__snapshots__/public-api/core.d.ts`）を読む。
 * snapshot の鮮度は CI の `pnpm run api:check` が保証するので、自前の TypeScript パーサを持たずに済む。
 *
 * コード片はインデント幅ではなく括弧の対応で切り出す。docs は2スペース、snapshot は4スペースで書式が違い、
 * インデント幅に依存すると書式が変わるたびに壊れる。
 *
 * 縛らないこと:
 * - 予告（実体が無いと文書自身が明記しているもの）。実装されても罰しない。
 * - 随伴する型（`EmbeddingSpaceId` など）。
 * - メンバーの型（`ScoringStrategy` を除く）。名前の集合だけを比べ、署名は `architecture-section5-port-signature-correspondence.test.mjs` が見る。
 * - 対象一覧 `TARGET_INTERFACE_NAMES` への追加。写しか予告かの分類は機械的に再導出できないので、手で足す。
 */

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

const architecturePath = join(repoRoot, "docs/architecture.md");
const snapshotPath = join(repoRoot, "scripts/__snapshots__/public-api/core.d.ts");

const architectureText = readFileSync(architecturePath, "utf8");
const snapshotText = readFileSync(snapshotPath, "utf8");

// 件数ではなく一覧を持つ。写しか予告かの分類（ADR 0269 決定1・ADR 0273）は人が決めたもので、機械的には再導出できない。
const TARGET_INTERFACE_NAMES = [
  "Ctx",
  "MemoryStore",
  "VectorStore",
  "LexicalStore",
  "LLMProvider",
  "EmbeddingProvider",
  "Scheduler",
  "DecayStrategy",
  "EventStore",
  "TokenCounter",
  "Clock",
  "OutboxStore",
  "TenantSettingsStore",
  "RelationStore",
];

const SCORING_STRATEGY_TARGET_NAME = "ScoringStrategy";

// 予告は入れない。入れると、実体が無いという理由だけで常に赤くなる（ADR 0269）。
const PLACEHOLDER_NAMES_NOT_TARGETED = ["Sensor", "SpeechPolicy"];

function section5Span(text) {
  const heading = "## 5. 主要 interface";
  const startIdx = text.indexOf(heading);
  if (startIdx === -1) {
    throw new Error(
      `docs/architecture.md に "${heading}" が見つからない——見出しの文言か節番号が変わった可能性がある`,
    );
  }
  const rest = text.slice(startIdx + heading.length);
  const nextHeadingRel = rest.search(/\n## /);
  if (nextHeadingRel === -1) {
    throw new Error("§5 の終わり（次の `## ` 見出し）が見つからない");
  }
  return text.slice(startIdx, startIdx + heading.length + nextHeadingRel);
}

function findDeclarationOpenBraceIndex(text, name) {
  const re = new RegExp(`(?:export\\s+)?(?:interface|type)\\s+${name}\\b[^{;]*\\{`);
  const m = re.exec(text);
  if (!m) return -1;
  return m.index + m[0].length - 1;
}

function extractBalancedBlock(text, openBraceIdx) {
  let depth = 0;
  for (let i = openBraceIdx; i < text.length; i++) {
    const ch = text[i];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return text.slice(openBraceIdx + 1, i);
    }
  }
  throw new Error(
    `位置 ${openBraceIdx} の '{' に対応する '}' が見つからない——ブロックが閉じていない可能性がある`,
  );
}

/** JSDoc を除いてから識別子を読む。`OutboxStore.complete` の直前の `{@link …}` を含む複数行コメントで、除かないと抽出が壊れる。 */
function stripBlockComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, "");
}

/** @returns {string[]} */
function extractMemberNames(innerTextRaw) {
  const innerText = stripBlockComments(innerTextRaw);
  let depth = 0;
  let current = "";
  const statements = [];
  for (const ch of innerText) {
    if (ch === "{" || ch === "(" || ch === "[") depth++;
    if (ch === "}" || ch === ")" || ch === "]") depth--;
    if (ch === ";" && depth === 0) {
      statements.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  if (current.trim().length > 0) statements.push(current);

  const nameRe = /^\s*(?:readonly\s+)?([A-Za-z_$][A-Za-z0-9_$]*)\??\s*[:(<]/;
  const names = [];
  for (const stmt of statements) {
    const m = nameRe.exec(stmt);
    if (m) names.push(m[1]);
  }
  return names;
}

function extractInterfaceMemberNames(text, name, sourceLabel) {
  const openBraceIdx = findDeclarationOpenBraceIndex(text, name);
  if (openBraceIdx === -1) {
    throw new Error(`${sourceLabel} に \`${name}\` の宣言（interface/type + '{'）が見つからない`);
  }
  const block = extractBalancedBlock(text, openBraceIdx);
  return [...extractMemberNames(block)].sort();
}

function extractTypeAliasStatement(text, name, sourceLabel) {
  const re = new RegExp(`(?:export\\s+)?type\\s+${name}\\s*=\\s*[^;]+;`);
  const m = re.exec(text);
  if (!m) {
    throw new Error(`${sourceLabel} に \`type ${name} = ...;\` の宣言が見つからない`);
  }
  return m[0];
}

function normalizeTypeAliasStatement(stmt) {
  return stmt
    .replace(/^export\s+/, "")
    .trim()
    .replace(/\s+/g, " ");
}

describe("docs/architecture.md §5 の port interface が、公開 API snapshot（実体の写し）と対応している（Issue #604、ADR 0269、ADR 0273、ADR 0278）", () => {
  it("この歯が読んでいる2つの入力（docs/architecture.md・公開 API snapshot）が、実在して空でない", () => {
    expect(
      architectureText.length,
      "docs/architecture.md が1000文字未満——静かに空回りしている可能性がある",
    ).toBeGreaterThanOrEqual(1000);
    expect(
      snapshotText.length,
      "scripts/__snapshots__/public-api/core.d.ts が1000文字未満——静かに空回りしている可能性がある",
    ).toBeGreaterThanOrEqual(1000);
  });

  it("陽性対照: extractMemberNames は、合成した最小のインターフェース本文からメンバー名を正しく取り出す（JSDoc コメント・ネストしたオブジェクト型を含む）", () => {
    const synthetic = `
      foo(a: number): void;
      /**
       * 複数行の JSDoc コメント。{@link SomeType} のような中括弧を含む参照も混ぜる。
       */
      bar?: string;
      baz(x: { nested: string; deeper: { z: number } }): Promise<{ y: number }>;
      readonly qux: number;
    `;
    expect(extractMemberNames(synthetic)).toEqual(["foo", "bar", "baz", "qux"]);
  });

  it("やりすぎ側: 対象一覧に、実体の無い2個（Sensor/SpeechPolicy）が含まれていない", () => {
    for (const placeholder of PLACEHOLDER_NAMES_NOT_TARGETED) {
      expect(
        TARGET_INTERFACE_NAMES,
        `${placeholder} が対象一覧に含まれている——ADR 0273「3つに割る」2番により、実体の無い予告は対象にしないこと`,
      ).not.toContain(placeholder);
      expect(placeholder).not.toBe(SCORING_STRATEGY_TARGET_NAME);
    }
  });

  it("やりすぎ側: 実体の無い2個（Sensor/SpeechPolicy）は、公開 API snapshot に1件も現れない（対象にしなくても正しい理由）", () => {
    for (const placeholder of PLACEHOLDER_NAMES_NOT_TARGETED) {
      const idx = findDeclarationOpenBraceIndex(snapshotText, placeholder);
      expect(
        idx,
        `${placeholder} が公開 API snapshot に見つかった——実体ができたということであり、` +
          `ADR 0273「3つに割る」2番の前提（実体が無い予告）が崩れている。§5.3/§5.13 の扱いを` +
          `人が見直す必要がある（本歯はこれを検出しない設計なので、この it が唯一の警報である）`,
      ).toBe(-1);
    }
  });

  it("対象一覧のすべての宣言が、docs/architecture.md §5 と snapshot の両方でちょうど1回ずつ見つかる（空回り防止）", () => {
    const docSpan = section5Span(architectureText);
    for (const name of TARGET_INTERFACE_NAMES) {
      expect(
        () => extractInterfaceMemberNames(docSpan, name, "docs/architecture.md §5"),
        `docs/architecture.md §5 に \`${name}\` の宣言が見つからない`,
      ).not.toThrow();
      expect(
        () => extractInterfaceMemberNames(snapshotText, name, "公開 API snapshot"),
        `公開 API snapshot に \`${name}\` の宣言が見つからない`,
      ).not.toThrow();
    }
    expect(() =>
      extractTypeAliasStatement(docSpan, SCORING_STRATEGY_TARGET_NAME, "docs/architecture.md §5"),
    ).not.toThrow();
    expect(() =>
      extractTypeAliasStatement(snapshotText, SCORING_STRATEGY_TARGET_NAME, "公開 API snapshot"),
    ).not.toThrow();
  });

  it("本体: 対象の interface（ScoringStrategy を除く）は、メンバー名の集合が docs/architecture.md §5 と実体（公開 API snapshot）で一致する", () => {
    const docSpan = section5Span(architectureText);

    /** @type {string[]} */
    const problems = [];

    for (const name of TARGET_INTERFACE_NAMES) {
      const docMembers = extractInterfaceMemberNames(docSpan, name, "docs/architecture.md §5");
      const implMembers = extractInterfaceMemberNames(snapshotText, name, "公開 API snapshot");

      const missingInDoc = implMembers.filter((m) => !docMembers.includes(m));
      const extraInDoc = docMembers.filter((m) => !implMembers.includes(m));

      if (missingInDoc.length > 0 || extraInDoc.length > 0) {
        const lines = [`  ${name}:`];
        for (const m of missingInDoc) {
          lines.push(`    実装にあるが docs/architecture.md 側に無い: ${m}`);
        }
        for (const m of extraInDoc) {
          lines.push(`    docs/architecture.md 側にあるが実装に無い: ${m}`);
        }
        problems.push(lines.join("\n"));
      }
    }

    if (problems.length > 0) {
      const message = [
        "docs/architecture.md §5 の port interface が、実体（公開 API snapshot）とずれている:",
        "",
        ...problems,
        "",
        "⟹ どうすればよいか:",
        "  ⭐ ADR 0273 の決定（§5 は写した側、実体が正本）に従い、実装ではなく",
        "     docs/architecture.md の該当インターフェースのコード片を実体へ合わせること。",
        "  1. `pnpm run build` を打ち、`packages/core/dist` を最新にする",
        "     （dist が古いままだと、この歯は「新しい実装 vs 古い snapshot」を比べてしまう）。",
        "  2. `node scripts/check-public-api-surface.mjs` を打ち、snapshot 自体が",
        "     dist と一致していることを確認する（不一致なら先に snapshot を直す別の問題）。",
        "  3. 上に列挙されたメンバー名を、docs/architecture.md の対応するコード片へ反映する。",
        "  ⛔ この歯を満たすために、実装（packages/）を変えないこと",
        "     （AGENTS.md・ADR 0273「3つに割る」1番: 実体が正本、実装側を疑わない）。",
        "  ⛔ 件数を文書に書き戻さないこと（AGENTS.md「⚠ 数を、道具と生成物に焼き込まない」）。",
      ].join("\n");
      expect.fail(message);
    }

    expect(problems.length).toBe(0);
  });

  it("本体: ScoringStrategy（関数型のエイリアス）は、docs/architecture.md §5 と実体（公開 API snapshot）で宣言そのものが一致する（メンバー集合ではなく型シグネチャの逐語比較）", () => {
    const docSpan = section5Span(architectureText);
    const docStmt = extractTypeAliasStatement(
      docSpan,
      SCORING_STRATEGY_TARGET_NAME,
      "docs/architecture.md §5",
    );
    const implStmt = extractTypeAliasStatement(
      snapshotText,
      SCORING_STRATEGY_TARGET_NAME,
      "公開 API snapshot",
    );

    const docNormalized = normalizeTypeAliasStatement(docStmt);
    const implNormalized = normalizeTypeAliasStatement(implStmt);

    if (docNormalized !== implNormalized) {
      const message = [
        "ScoringStrategy の型宣言が、docs/architecture.md §5 と実体でずれている:",
        "",
        `  docs/architecture.md: ${docNormalized}`,
        `  実装（公開 API snapshot）: ${implNormalized}`,
        "",
        "⟹ どうすればよいか:",
        "  docs/architecture.md 側の `type ScoringStrategy = ...;` を、実体",
        "  （packages/core/src/strategies/scoring.ts）の宣言へ合わせること。",
        "  ⛔ 実装（packages/）を変えないこと（ADR 0273「3つに割る」1番）。",
      ].join("\n");
      expect.fail(message);
    }

    expect(docNormalized).toBe(implNormalized);
  });
});
