import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * ⭐ **この歯が測っているもの（消す前に読むこと）**
 *
 * **`docs/architecture.md` §5 が再掲している port interface のコード片（`MemoryStore` 等）が、
 * `packages/core` の実体からずれたら赤くなる**（Issue #604、ADR 0269、ADR 0273、ADR 0278）。
 *
 * ## 経緯 —— なぜ「件数」ではなく「実体との対応」を検査するか
 *
 * ADR 0269 が `docs/architecture.md` §5 の17個の named interface/type を実体と突き合わせ、
 * 4件の drift（`MemoryStore` 10口・`VectorStore` 1口・`TenantSettingsStore` 7口・
 * `ScoringStrategy` の型名1件）を見つけた。ADR 0273 が「§5 は写した側であり、実体
 * （`packages/core/src/`）が正本である」と決め、PR #622 がその drift を直した——だが
 * **歯（テスト）は1本も置かれず**、直した直後から同じ形の drift がまた静かに積み上がる
 * 余地が残っていた。本歯はその歯を置く。
 *
 * ## 3つに割る（ADR 0273「3つに割る」をそのまま引き継ぐ。⛔ 混同しないこと）
 *
 * ADR 0273 は §5 の対象を3種に分けている。**この歯は1種目だけを縛る。**
 *
 * 1. **写し（実体が在るもの）** ⟹ 本歯の対象。`TARGET_INTERFACE_NAMES` /
 *    `SCORING_STRATEGY_TARGET_NAME` に持つ名前だけを実体と突き合わせる。
 * 2. **予告（`RelationStore`・`Sensor`・`SpeechPolicy`。実体が無いと文書自身が明記している）**
 *    ⟹ ⛔ **本歯の対象にしない。**素朴に「§5 が名前を挙げているものを全部実体と比べる」歯を
 *    作ると、この3つが「実体が無い」という理由だけで常に赤くなる——ADR 0269 が「採らなかった
 *    案1」で指摘した偽陽性そのものである。⟹ この3つは `TARGET_INTERFACE_NAMES` に**入れない**。
 *    入っていないことを、下の「やりすぎ側」の it で機械的に確認する。
 * 3. **`ScoringStrategy`（関数型のエイリアス）** ⟹ 型シグネチャの逐語比較。`MemoryStore` 等の
 *    「メンバー名の集合」比較とは別ロジック（下記）。
 *
 * ## 正本の取り方 —— `packages/core/src/` を直接パースせず、公開 API snapshot を使う
 *
 * 正本の取り方には2つの道があった:
 *
 * - (a) `packages/core/src/interfaces/*.ts` を自前の TypeScript パーサで読む。
 * - (b) `scripts/__snapshots__/public-api/core.d.ts`（ADR 0178 の公開 API snapshot）を読む。
 *
 * **本歯は (b) を採る。** 理由:
 *
 * - `scripts/__snapshots__/public-api/core.d.ts` は `packages/core` の**ビルド後の公開型
 *   シグネチャそのもの**であり（`scripts/check-public-api-surface.mjs`）、その鮮度は
 *   `.github/workflows/ci.yml` の `build` ジョブ（required check）の `pnpm run api:check` が
 *   **毎 PR で強制している**（`scripts/__tests__/ci-yml-api-check-wiring.test.mjs` が
 *   その配線自体を別に縛っている）。⟹ **既に「腐らないことが保証された実装の写し」が
 *   repo に在り、それを使えば本歯が自前の TypeScript パーサを持つ必要が無い。**
 * - 【実測、本歯の作業時点】`scripts/__snapshots__/public-api/core.d.ts` に
 *   `RelationStore`/`Sensor`/`SpeechPolicy` は**1件も現れない**
 *   （`grep -c "RelationStore\|Sensor\|SpeechPolicy"` が0件）——実体を持たないこの3つは
 *   ビルドしても `.d.ts` に出てこないので、**category 2 が snapshot に混じる心配はそもそも無い**。
 * - 【実測】14個の対象名（`Ctx`/`MemoryStore`/`VectorStore`/`LexicalStore`/`LLMProvider`/
 *   `EmbeddingProvider`/`Scheduler`/`DecayStrategy`/`EventStore`/`TokenCounter`/`Clock`/
 *   `OutboxStore`/`TenantSettingsStore`/`ScoringStrategy`）は、いずれも snapshot に
 *   ちょうど1回だけ出現する（`grep -cE`で確認済み）。
 *
 * ⚠ **確かめていないこと**: snapshot の鮮度は CI（`build` ジョブ）にしか保証されていない。
 * **手元で `packages/core` を編集した直後、`pnpm run build` を打たずに本歯だけを走らせると、
 * snapshot は古いままなので、本歯は「新しい実装 vs 古い snapshot」を比べて誤検出しうる。**
 * これは `AGENTS.md`「古い `dist/` のまま `check-public-api-surface.mjs --write` を打つ」の
 * 穴と同型であり、本歯固有の対処は無い——`pnpm run build && node
 * scripts/check-public-api-surface.mjs`（snapshot 自体を鮮度チェック）を先に通すこと。
 *
 * ## 抽出方法 —— インデント幅ではなく、括弧の対応で本文を切り出す
 *
 * `docs/architecture.md` のコード片は2スペース、snapshot は4スペースとインデント幅が違う
 * （前者は手書き、後者は `tsc` の出力）。**インデント幅に依存する抽出は両者で書式が変わる
 * たびに壊れる**——だから本歯は「開始位置から `{`/`(`/`[` の対応を辿って、深さ0で終わる
 * `;` ごとに1メンバーとして切り出す」という、書式に依存しない方式を採る
 * （ADR 0269 決定3が自分のスクリプトで採ったのと同じ考え方、「開始行から括弧の対応を辿って
 * 終端を求める」の延長）。切り出した各メンバー文からは、先頭の JSDoc ブロックコメント
 * （`/** ... *\/`）を取り除いてから識別子を読む——`OutboxStore.complete` の直前にある
 * `{@link OutboxLeaseConflictError}` を含む複数行コメントで、実際にこれを削って
 * 初めて正しく抽出できることを手元で確認した。
 *
 * ## この歯が縛らないこと（⛔ 消さないこと）
 *
 * - 🔴 **`RelationStore`/`Sensor`/`SpeechPolicy`（category 2）は縛らない。** 実装されても
 *   されなくても、この歯はこの3つについて何も言わない。実装されたときに §5.3/§5.13 を
 *   「予告」から「写し」へ書き直すかどうかは人の判断であり、この歯は関与しない
 *   ——実装を罰する歯にしないため（依頼の指示どおり）。
 * - 🔴 **随伴する型は対象外。** `VectorStore` の節にある `EmbeddingSpaceId`/`VectorEntry`、
 *   `MemoryStore` の節にある `MemoryStatus`、`OutboxStore` の節にある
 *   `ClaimOutboxJobsOptions`/`OutboxLeaseConflictError` 等は、ADR 0269 決定3の17項目にも
 *   含まれておらず、本歯の対象名一覧にも無い。⟹ **これらのフィールド・引数がずれても、
 *   この歯は緑のままである。**
 * - 🔴 **メンバーの「型」までは比較しない（`ScoringStrategy` を除く）。** `MemoryStore` 等は
 *   メンバー**名**の集合だけを見る——`reinforce` の引数の型が変わっても、名前
 *   `reinforce` が両側に在れば緑である。PR #622 が直した `reinforce` の引数差
 *   （3引数→4引数）のような drift は、名前が変わらない限りこの歯では捕まえられない。
 * - 🔴 **§5 の中に新しい named interface が丸ごと1つ増えても、この歯の対象一覧
 *   （`TARGET_INTERFACE_NAMES`）に手で足すまで検査されない。** ADR 0244 の `Runtime` の歯が
 *   `runtime.ts` という単一のファイルから毎回動的にメソッド一覧を数え直せるのに対し、本歯は
 *   「§5 のどの節が『写し』でどの節が『予告』か」という**意味の分類**（ADR 0273 決定）を
 *   機械的には再導出できない——分類そのものは人（ADR 0269/0273）が決めたものであり、
 *   本歯はその分類結果を一覧として持つ（件数としては持たない。下記参照）。
 * - 🔴 **名前がどこに書かれているかは見ない。** §5 の中のどこかに対応するコード片が
 *   在ればよく、節番号が変わっても（§5.2.1 の例のように）追随できるが、逆に
 *   コード片が本来あるべき節から迷子になっていても検出できない。
 *
 * ## ⚠ 偽陽性の条件（AGENTS.md「偽陽性率に上限を置けない検査は門にしない」への回答）
 *
 * - **`docs/architecture.md` の書式（コードフェンス内のインデント・改行位置）が変わっても、
 *   本歯は偽陽性を出さない**——上記の通り抽出は括弧の対応に基づき、インデント幅に依存しない。
 * - ⚠ **ただし、メンバー文の途中に本歯が想定しない構文（ブロックコメント以外のコメント形式・
 *   デコレータ・見たことのない TypeScript 構文）が入ると、名前抽出に失敗しうる。** その場合は
 *   「メンバーが両側にあるのに名前が一致しない」という形の**偽陽性**になりうる——これは
 *   「陽性対照: extractMemberNames は…」の it が壊れを検出する対象ではない（あちらは合成した
 *   最小構文だけを見る）。**実物のメンバー文で抽出漏れが起きたら、その節を手動で確認すること。**
 *   本歯の設計時点でこの形の偽陽性は実際に1回踏んでいる（`OutboxStore.complete` の直前の
 *   JSDoc）——コメント除去を足して解消したが、**未知のコメント形式・構文が新たに増えたら
 *   同じ形の偽陽性が再発しうる**、という限界は消えていない。
 * - **snapshot が古いまま走らせると誤検出しうる**（上記「確かめていないこと」参照）——
 *   これは偽陽性であり本歯の対処範囲外（`pnpm run build` を先に通すことが前提）。
 *
 * ## `Runtime` の歯（ADR 0244）との違い
 *
 * ADR 0244 の歯は「メソッド名がプローズのどこかに `` `name` `` の形で出現するか」という
 * ゆるい検査だった（README/vision/architecture の3つの生きた文書が対象）。本歯は
 * `docs/architecture.md` 1文書だけが対象だが、**§5 はメソッド名を `` `name` `` で言及する
 * だけでなく、`interface X { ... }` という*コード片そのもの*を再掲している**——だから本歯は
 * ゆるい文字列包含ではなく、コード片を構造的に切り出してメンバー集合として比較する
 * （`Runtime` の歯より厳密だが、対象は1文書に限られる）。ADR 0244 の道具
 * （`runtime-method-doc-correspondence.test.mjs`）をそのまま拡張しなかった理由も
 * これである——あちらの「行頭Nスペースのメソッド宣言」抽出は、§5 のような複数行にまたがる
 * シグネチャ・ネストしたオブジェクト型リテラルを持つコード片には使えない。
 */

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

const architecturePath = join(repoRoot, "docs/architecture.md");
const snapshotPath = join(repoRoot, "scripts/__snapshots__/public-api/core.d.ts");

const architectureText = readFileSync(architecturePath, "utf8");
const snapshotText = readFileSync(snapshotPath, "utf8");

// ⭐ 「一覧」を持つ（件数ではない）。ADR 0269 決定1・ADR 0273「3つに割る」が既に人手で
// 分類した結果の写しであり、本歯はこの分類を機械的に再導出しない
// （AGENTS.md「対象の一覧をその場で導出するか、一覧そのものを持つ（件数ではなく）」）。
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
];

const SCORING_STRATEGY_TARGET_NAME = "ScoringStrategy";

// 🔴 category 2（実体が無いと文書自身が明記している。ADR 0269 決定3・ADR 0273「3つに割る」2番）
// ⟹ 本歯の対象に「入れない」ことそのものを、下の it で機械的に確認する。
const PLACEHOLDER_NAMES_NOT_TARGETED = ["RelationStore", "Sensor", "SpeechPolicy"];

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

/**
 * `interface NAME { ... }` / `type NAME = { ... }` の宣言を探し、開き `{` の index を返す。
 * 見つからなければ `-1`。
 */
function findDeclarationOpenBraceIndex(text, name) {
  const re = new RegExp(`(?:export\\s+)?(?:interface|type)\\s+${name}\\b[^{;]*\\{`);
  const m = re.exec(text);
  if (!m) return -1;
  return m.index + m[0].length - 1;
}

/** `{` から対応する `}` までの中身（両端の括弧を含まない）を、括弧の対応を辿って切り出す。 */
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

/** JSDoc 形式のブロックコメント（`/** ... *\/`）を取り除く。 */
function stripBlockComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, "");
}

/**
 * インターフェース本文（`{`/`}` の中身）から、トップレベルのメンバー宣言の名前を
 * 括弧の対応を辿って機械的に抽出する。⭐ インデント幅に依存しない
 * （`docs/architecture.md` は2スペース、snapshot は4スペースで書式が違うため）。
 *
 * @returns {string[]}
 */
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

/** `text` の中から `name` の interface/type 本文を見つけ、メンバー名の集合（ソート済み）を返す。 */
function extractInterfaceMemberNames(text, name, sourceLabel) {
  const openBraceIdx = findDeclarationOpenBraceIndex(text, name);
  if (openBraceIdx === -1) {
    throw new Error(`${sourceLabel} に \`${name}\` の宣言（interface/type + '{'）が見つからない`);
  }
  const block = extractBalancedBlock(text, openBraceIdx);
  return [...extractMemberNames(block)].sort();
}

/** `type NAME = ...;` の右辺（関数型など）を1文として取り出す。`ScoringStrategy` 専用。 */
function extractTypeAliasStatement(text, name, sourceLabel) {
  const re = new RegExp(`(?:export\\s+)?type\\s+${name}\\s*=\\s*[^;]+;`);
  const m = re.exec(text);
  if (!m) {
    throw new Error(`${sourceLabel} に \`type ${name} = ...;\` の宣言が見つからない`);
  }
  return m[0];
}

/** `export ` の有無・前後の空白だけを正規化する（構文上のスタイル差を無視するため）。 */
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

  it("やりすぎ側: 対象一覧に、実体の無い3個（RelationStore/Sensor/SpeechPolicy）が含まれていない", () => {
    for (const placeholder of PLACEHOLDER_NAMES_NOT_TARGETED) {
      expect(
        TARGET_INTERFACE_NAMES,
        `${placeholder} が対象一覧に含まれている——ADR 0273「3つに割る」2番により、実体の無い予告は対象にしないこと`,
      ).not.toContain(placeholder);
      expect(placeholder).not.toBe(SCORING_STRATEGY_TARGET_NAME);
    }
  });

  it("やりすぎ側: 実体の無い3個（RelationStore/Sensor/SpeechPolicy）は、公開 API snapshot に1件も現れない（対象にしなくても正しい理由）", () => {
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

  it("対象14個すべての宣言が、docs/architecture.md §5 と snapshot の両方でちょうど1回ずつ見つかる（空回り防止）", () => {
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

  it("本体: 14個の interface/type（ScoringStrategy を除く）は、メンバー名の集合が docs/architecture.md §5 と実体（公開 API snapshot）で一致する", () => {
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
