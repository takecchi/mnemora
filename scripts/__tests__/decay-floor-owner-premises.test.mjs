import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * ⭐ **この歯が測っているもの（消す前に読むこと）**
 *
 * [ADR 0303](../../docs/decisions/0303-superseded-contested-decay-floor-owner.md)
 * 「superseded / contested の decay_floor_at の持ち主」（Issue #567）の**決定3**
 * （回収の経路〔案C: 掃引を広げる／`archived` へ逃がす〕は v1.x で入れない）が、
 * 理屈ではなく現物に当てて確認した根拠を、2つの前提として縛る。
 *
 * (a) `aggregateScope`（`packages/postgres/src/memory-store.ts`）の `scoped` CTE は
 *     `status` で絞らない——テナントの全状態の行を無条件にスキャンする。
 *     ⟹ `superseded`/`contested` を `archived` へ倒しても、この CTE が読む行数
 *     （＝段5が Seq Scan に倒れる実害に効く行数）は1行も減らない。
 * (b) `restoreArchived`（`packages/core/src/runtime.ts`）は `updateStatusWithEvent` に
 *     `supersededById` を渡さずに `status='active'` へ戻す。`updateStatusWithEvent` の
 *     `SET superseded_by_id = COALESCE(...)` は、渡されなければ既存の値をそのまま残す。
 *     ⟹ 掃引を `superseded` へ広げて `archived` にできるようにすると、`restoreArchived`
 *     で戻した行が「`active` なのに `superseded_by_id` を持つ」という、lifecycle 表の
 *     どの状態にも無い壊れた行になりうる。
 *
 * 🔴 **なぜ要るか**: どちらかが崩れたら、ADR 0303 決定3の「案Cを入れない」根拠が崩れる。
 * ⟹ **この歯が赤くなったら、ADR 0303 を読み直すこと（歯を消さないこと）。**
 *
 * 🔴 **この歯が捕まえないもの:**
 * - **段5が Seq Scan に倒れる実際の閾値**（ADR 0114/PR #670 からの【受】の数字。
 *   この歯は「スキャンする行数が減らない」という構造だけを縛り、性能の数字は縛らない）。
 * - **postgres 以外の adapter。**この前提は postgres 実装の SQL 文字列に対するものであり、
 *   in-memory 実装は対象にしない（ADR 0303 の現物調査自体が postgres の SQL を読んでいる）。
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
    // ⚠ ファイル中には `WITH scoped AS (...)` という**省略形の言及**（doc コメント）も
    // 現れる。実装本体を一意に拾うため、直後に改行を挟んで SELECT が続く形まで含めて探す
    // （省略形は `(...)` のまま同じ行で閉じており、これには一致しない）。
    const anchor = "WITH scoped AS (\n        SELECT";
    const start = memoryStore.indexOf(anchor);
    expect(start, "scoped CTE の実装本体が見つからない").toBeGreaterThanOrEqual(0);

    const closeParenIndex = memoryStore.indexOf(")", start + anchor.length);
    expect(closeParenIndex, "scoped CTE の閉じ括弧が見つからない").toBeGreaterThanOrEqual(0);
    const cte = memoryStore.slice(start, closeParenIndex);

    // 陽性対照: memories 本体からの SELECT であることは前提として確認する
    // ——空振り（別の何かを切り出してしまった）ではないことを保証する。
    expect(cte).toContain("FROM memories");
    // 主張本体: status 述語が無い。
    expect(cte).not.toMatch(/status\s*(=|IN)/);
  });

  it("(b) restoreArchived は updateStatusWithEvent に supersededById を渡さずに active へ戻す", () => {
    const start = runtime.indexOf("async function restoreArchived(");
    expect(start, "restoreArchived が見つからない").toBeGreaterThanOrEqual(0);

    // 次の同階層の関数定義（`  async function `、2スペース+async function）までを本体とみなす。
    const nextFunctionIndex = runtime.indexOf("\n  async function ", start + 1);
    expect(nextFunctionIndex, "restoreArchived の終わりが見つからない").toBeGreaterThan(start);
    const body = runtime.slice(start, nextFunctionIndex);

    // 陽性対照: 対象の呼び出し（archived → active、CAS 付き）がこの範囲に実在すること。
    expect(body).toContain("updateStatusWithEvent");
    expect(body).toContain('"active"');
    expect(body).toContain('{ expectedStatus: "archived" }');
    // 主張本体: supersededById という語がこの関数本体のどこにも現れない
    // ——updateStatusWithEvent の呼び出しに opts として渡していないことの近似的な検査。
    expect(body).not.toMatch(/supersededById/);
  });
});
