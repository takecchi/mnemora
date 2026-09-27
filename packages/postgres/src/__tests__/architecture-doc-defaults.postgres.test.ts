import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PgDialect } from "drizzle-orm/pg-core";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { defaultDecayStrategy, heuristicTokenCounter, type Ctx } from "@mnemora/core";
import { capLexicalQueryTotalChars, capLexicalQueryWords } from "../lexical-query-cap.js";
import { PostgresTenantSettingsStore } from "../tenant-settings-store.js";
import { buildTrigramLexicalSearchSelect } from "../trigram-lexical-store.js";
import { closeTestClient, getTestClient, resetTestDatabase } from "./test-db.js";

/**
 * `docs/architecture.md` に書かれた既定値・上限が、実装と一致することを縛る。
 * **doc の値は `docs/architecture.md` を実行時に読んで取り**、**実装の値は振る舞いから取る**
 * （語彙クエリの切り詰めの結果、trigram の store が組み立てる SQL に渡る値、行の無いテナントに
 * `PostgresTenantSettingsStore` が返す値、`tenant_settings` の列の既定、`floorAt`・
 * `heuristicTokenCounter` の結果）。どちらか片方だけを直すと赤くなる。
 *
 * core の純関数（`floorAt`・`heuristicTokenCounter`）もここで見るのは、1つの文書につき歯を1本に
 * まとめるためである（`@mnemora/postgres` は `@mnemora/core` に依存しているので、ここから両方に届く）。
 */

const ARCHITECTURE_DOC = readFileSync(
  fileURLToPath(new URL("../../../../docs/architecture.md", import.meta.url)),
  "utf8",
);

function docMatch(pattern: RegExp): RegExpMatchArray {
  const m = ARCHITECTURE_DOC.match(pattern);
  if (!m) throw new Error(`docs/architecture.md に ${pattern} の記述が見つからない`);
  return m;
}

const docNumber = (name: string) => Number(docMatch(new RegExp("`" + name + "` = (\\d+)"))[1]);

const ctx: Ctx = { tenantId: "architecture-doc-defaults" };

describe("docs/architecture.md の既定値・上限は実装と一致する", () => {
  beforeEach(async () => {
    await resetTestDatabase();
  });

  afterAll(async () => {
    await closeTestClient();
  });

  it("§5.2.1 語彙クエリの上限（異なる語の数・1語の文字数・全体の文字数）", () => {
    const maxWords = docNumber("LEXICAL_QUERY_MAX_DISTINCT_WORDS");
    const maxWordChars = docNumber("LEXICAL_QUERY_MAX_WORD_CHARS");
    const maxTotalChars = docNumber("LEXICAL_QUERY_MAX_TOTAL_CHARS");

    const manyWords = Array.from({ length: maxWords + 10 }, (_, i) => `w${i}`);
    expect(capLexicalQueryWords(manyWords.join(" ")).split(" ")).toEqual(
      manyWords.slice(0, maxWords),
    );
    expect(capLexicalQueryWords("x".repeat(maxWordChars + 10))).toBe("x".repeat(maxWordChars));
    expect(capLexicalQueryWords("x".repeat(maxWordChars))).toBe("x".repeat(maxWordChars));
    expect(capLexicalQueryTotalChars("a".repeat(maxTotalChars + 10))).toBe(
      "a".repeat(maxTotalChars),
    );
    expect(capLexicalQueryTotalChars("a".repeat(maxTotalChars))).toBe("a".repeat(maxTotalChars));
  });

  it("§5.2.1 trigram の日本語側の文字数の上限", () => {
    const documented = docNumber("TRIGRAM_JAPANESE_QUERY_MAX_CHARS");
    const query = new PgDialect().sqlToQuery(
      buildTrigramLexicalSearchSelect("日本語のクエリ", {
        limit: 10,
        filter: { tenantId: ctx.tenantId },
        threshold: 0.3,
      }),
    );
    const m = query.sql.match(/LEFT\(mnemora_trigram_query_nonascii\(\$\d+\), \$(\d+)\)/);
    if (!m) throw new Error(`組み立てた SQL に日本語側の LEFT(...) が見つからない: ${query.sql}`);
    expect(query.params[Number(m[1]) - 1]).toBe(documented);
  });

  it("§5.7 `floorAt` の既定閾値（コード片の注記と契約の箇条の両方）", () => {
    const inSnippet = Number(docMatch(/threshold を省略すると既定値 ([0-9.]+) が使われる/)[1]);
    const inContract = Number(docMatch(/`floorAt` の既定閾値 ([0-9.]+)/)[1]);
    expect(inContract).toBe(inSnippet);

    const params = {
      recordedAt: new Date("2026-06-01T00:00:00.000Z"),
      lastReinforcedAt: null,
      strength: 1,
      halfLifeHours: 24,
    };
    const omitted = defaultDecayStrategy.floorAt(params).getTime();
    expect(omitted).toBe(defaultDecayStrategy.floorAt(params, inSnippet).getTime());
    expect(omitted).not.toBe(defaultDecayStrategy.floorAt(params, inSnippet * 2).getTime());
  });

  it("§5.9 既定の TokenCounter の文字種ごとの係数", () => {
    const m = docMatch(/CJK ([0-9.]+)トークン\/コードポイント・非CJK ([0-9.]+)/);
    const n = 100;
    expect(heuristicTokenCounter.count("あ".repeat(n)).tokens).toBe(Math.ceil(n * Number(m[1])));
    expect(heuristicTokenCounter.count("a".repeat(n)).tokens).toBe(Math.ceil(n * Number(m[2])));
  });

  it("§5.12 行の無いテナントの既定 half-life と taxonomy モード、`tenant_settings` の列の既定", async () => {
    const m = docMatch(
      /`DEFAULT_HALF_LIFE_HOURS`（(\d+)、DB 側の\s*`default_half_life_hours DEFAULT (\d+)`/,
    );
    const taxonomyMode = docMatch(/行が無ければ `DEFAULT_TAXONOMY_MODE`（`'([a-z]+)'`）を返す/)[1];

    const { db, pool } = await getTestClient();
    const store = new PostgresTenantSettingsStore(db);
    expect(await store.getDefaultHalfLifeHours(ctx)).toBe(Number(m[1]));
    expect(await store.getTaxonomyMode(ctx)).toBe(taxonomyMode);

    await pool.query("INSERT INTO tenant_settings (tenant_id) VALUES ($1)", [ctx.tenantId]);
    const row = await pool.query<{ default_half_life_hours: number }>(
      "SELECT default_half_life_hours FROM tenant_settings WHERE tenant_id = $1",
      [ctx.tenantId],
    );
    expect(row.rows[0]?.default_half_life_hours).toBe(Number(m[2]));
  });
});
