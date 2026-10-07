import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * どちらかが崩れると ADR 0303 決定3（案Cを入れない）の根拠が崩れる。赤くなったら ADR を読み直すこと。
 */

const root = fileURLToPath(new URL("../../", import.meta.url));
const read = (rel) => readFileSync(`${root}${rel}`, "utf8");

const memoryStore = read("packages/postgres/src/memory-store.ts");
const runtime = read("packages/core/src/runtime.ts");

describe("🔴 ADR 0303「superseded / contested の decay_floor_at の持ち主」決定3の前提（Issue #567）", () => {
  it("ADR が在り、この歯を名指ししている（ADR だけ消えて歯が残る、を防ぐ）", () => {
    expect(memoryStore).toBeTruthy(); // 読み込みが失敗していないことの前提確認
    const adr = read("docs/decisions/0303-superseded-contested-decay-floor-owner.md");
    expect(adr).toContain("scripts/__tests__/decay-floor-owner-premises.test.mjs");
  });

  it("(a) aggregateScope の scoped CTE は status で絞らない（archived 化しても段5の走査行数は減らない）", () => {
    // 実装本体だけを拾うため、直後に改行を挟んで SELECT が続く形まで含めて探す（doc コメントの省略形 `(...)` は同じ行で閉じる）。
    const anchor = "WITH scoped AS (\n        SELECT";
    const start = memoryStore.indexOf(anchor);
    expect(start, "scoped CTE の実装本体が見つからない").toBeGreaterThanOrEqual(0);

    const closeParenIndex = memoryStore.indexOf(")", start + anchor.length);
    expect(closeParenIndex, "scoped CTE の閉じ括弧が見つからない").toBeGreaterThanOrEqual(0);
    const cte = memoryStore.slice(start, closeParenIndex);

    expect(cte).toContain("FROM memories");
    expect(cte).not.toMatch(/status\s*(=|IN)/);
    const whereStart = cte.indexOf("WHERE");
    expect(whereStart, "scoped CTE の WHERE 句が見つからない").toBeGreaterThanOrEqual(0);
    const where = cte.slice(whereStart);
    expect(where).toContain("tenant_id"); // 陽性対照: WHERE 句の切り出しが空振りでない
    expect(where).not.toMatch(/\bstatus\b/);
  });

  it("(b) restoreArchived は updateStatusWithEvent に supersededById を渡さずに active へ戻す", () => {
    const start = runtime.indexOf("async function restoreArchived(");
    expect(start, "restoreArchived が見つからない").toBeGreaterThanOrEqual(0);

    const nextFunctionIndex = runtime.indexOf("\n  async function ", start + 1);
    expect(nextFunctionIndex, "restoreArchived の終わりが見つからない").toBeGreaterThan(start);
    const body = runtime.slice(start, nextFunctionIndex);

    expect(body).toContain("updateStatusWithEvent");
    expect(body).toContain('"active"');
    expect(body).toContain('{ expectedStatus: "archived" }');
    expect(body).not.toMatch(/supersededById/);
  });
});
