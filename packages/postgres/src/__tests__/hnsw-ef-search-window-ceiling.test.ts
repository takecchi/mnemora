import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_OVER_FETCH_FACTOR, DEFAULT_RECALL_LIMIT } from "@mnemora/core";

/** 定数の比較とソース走査だけで判定し、DB を必要としない。いま緑で、前提が黙って変わったら赤になる向きの歯。 */

describe("検査1: kPrime は pgvector の hnsw.ef_search 既定値を超えない（ADR 0111）", () => {
  /** pgvector の `hnsw.ef_search` の既定値。pgvector 自身がこの値を変えたら、この定数は確認した既定値として更新し、測定を引き直す。 */
  const PGVECTOR_HNSW_EF_SEARCH_DEFAULT = 40;

  it("DEFAULT_RECALL_LIMIT * DEFAULT_OVER_FETCH_FACTOR(=kPrime) <= 40", () => {
    const kPrime = Math.max(1, Math.round(DEFAULT_RECALL_LIMIT * DEFAULT_OVER_FETCH_FACTOR));

    expect(
      kPrime,
      `kPrime(=${kPrime}) が pgvector の hnsw.ef_search 既定値(${PGVECTOR_HNSW_EF_SEARCH_DEFAULT}) を超えた。\n` +
        "ADR 0011 分岐A・ADR 0111 段B2 が実測した通り、プランナが HNSW を選ぶ領域では、" +
        "索引スキャンは hnsw.ef_search 件までしか下流に行を渡さない" +
        "（ADR 0111 の実測: LIMIT 40 を要求しても org-b で14行/org-a で11行しか返らず、" +
        "EXPLAIN に `Rows Removed by Filter: 52` が出た）。\n" +
        "⟹ 窓を広げたつもりでも、HNSW 経路では ef_search が天井であり、広げたぶんは黙って効かない。\n" +
        "⟹ kPrime を広げるなら、hnsw.ef_search も同じ変更の中で上げ、ADR 0111 の測定を引き直すこと。",
    ).toBeLessThanOrEqual(PGVECTOR_HNSW_EF_SEARCH_DEFAULT);
  });
});

describe("検査2: 本番経路は hnsw.ef_search / hnsw.iterative_scan を SET していない（ADR 0111）", () => {
  const SRC_DIR = join(__dirname, "..");
  // このファイル自身は除外する——自分の doc コメント・アサーションのメッセージ文字列に
  // 「CREATE INDEX」「USING hnsw」「hnsw.ef_search」等の文字列が含まれており、
  // 除外しないと自分自身を誤検出してしまう（陽性が「自分の説明文」になる）。
  const SELF_FILE = relative(SRC_DIR, __filename);

  function walk(dir: string): string[] {
    const out: string[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        out.push(...walk(full));
      } else if (entry.isFile() && entry.name.endsWith(".ts")) {
        out.push(full);
      }
    }
    return out;
  }

  function readAllSourceFiles(): { file: string; source: string }[] {
    return walk(SRC_DIR)
      .map((full) => relative(SRC_DIR, full))
      .filter((file) => file !== SELF_FILE)
      .map((file) => ({
        file,
        source: readFileSync(join(SRC_DIR, file), "utf-8"),
      }));
  }

  const SET_EF_SEARCH = /SET\s+(?:LOCAL\s+)?hnsw\.ef_search\s*=\s*(\d+)/g;

  const SET_ITERATIVE_SCAN = /SET\s+(?:LOCAL\s+)?hnsw\.iterative_scan\s*=\s*([a-z_]+)/g;

  it("`SET ... hnsw.ef_search` の出現は __tests__/count-over-window.test.ts の1箇所だけであり、値は既定値と同じ40である", () => {
    const files = readAllSourceFiles();
    const occurrences: { file: string; value: string }[] = [];

    for (const { file, source } of files) {
      for (const match of source.matchAll(SET_EF_SEARCH)) {
        const value = match[1];
        if (value !== undefined) {
          occurrences.push({ file, value });
        }
      }
    }

    // 陰性対照が空回りしないことの確認: この検査自体が何も見ていない、を防ぐ。
    expect(
      occurrences.length,
      "packages/postgres/src のどこにも `SET ... hnsw.ef_search` が見つからなかった。" +
        "count-over-window.test.ts (ADR 0011 の歯) が消えたか書き換わった可能性がある。",
    ).toBeGreaterThan(0);

    expect(
      occurrences,
      "本番経路 (vector-store.ts / recall-runtime.ts 等) が hnsw.ef_search を SET し始めた、" +
        "または count-over-window.test.ts 以外の場所で SET している。" +
        "ADR 0111 の測定は `hnsw.ef_search = 40 (source=default)` を前提にしている——" +
        "ef_search を触るなら、同じ変更の中で ADR 0111 の測定を引き直すこと。",
    ).toEqual([{ file: "__tests__/count-over-window.test.ts", value: "40" }]);
  });

  it("`hnsw.iterative_scan` を SET している箇所は vector-store.ts の search() 1箇所だけであり、値は relaxed_order である（ADR 0284）", () => {
    const files = readAllSourceFiles();
    const occurrences: { file: string; value: string }[] = [];

    for (const { file, source } of files) {
      for (const match of source.matchAll(SET_ITERATIVE_SCAN)) {
        const value = match[1];
        if (value !== undefined) {
          occurrences.push({ file, value });
        }
      }
    }

    expect(
      occurrences,
      "hnsw.iterative_scan を SET している箇所が想定と違う。" +
        "ADR 0284 の決定により、本番経路では vector-store.ts の search() だけが " +
        "`SET LOCAL hnsw.iterative_scan = relaxed_order` を1トランザクション内で発行する " +
        "——それ以外の場所で SET しているか、値が relaxed_order 以外なら、" +
        "ADR 0284 の射程を超えている。触るなら、同じ変更の中で ADR 0284 の測定を引き直すこと。",
    ).toEqual([{ file: "vector-store.ts", value: "relaxed_order" }]);
  });

  it("`CREATE INDEX ... USING hnsw` に m / ef_construction の指定が無い", () => {
    const files = readAllSourceFiles();
    const CREATE_HNSW_INDEX_STATEMENT = /CREATE\s+INDEX[\s\S]*?USING\s+hnsw[\s\S]*?;/g;

    const statements: { file: string; statement: string }[] = [];
    for (const { file, source } of files) {
      for (const match of source.matchAll(CREATE_HNSW_INDEX_STATEMENT)) {
        statements.push({ file, statement: match[0] });
      }
    }

    // 陰性対照が空回りしないことの確認: このリポジトリには HNSW 索引を作る箇所が
    // 常に最低1つ (vector-space.ts の registerEmbeddingSpace) あるはずである。
    expect(
      statements.length,
      "packages/postgres/src に `CREATE INDEX ... USING hnsw` が1つも見つからなかった。" +
        "vector-space.ts の registerEmbeddingSpace が変わった可能性がある。",
    ).toBeGreaterThan(0);

    const offenders = statements.filter(
      ({ statement }) => /\bWITH\s*\(/i.test(statement) || /ef_construction/i.test(statement),
    );

    expect(
      offenders,
      "CREATE INDEX ... USING hnsw に m / ef_construction の明示指定が見つかった。" +
        "ADR 0111 の測定は「m=16 / ef_construction=64 は pgvector 既定値」を前提にしている" +
        "（明示していないため既定値になっている、という状態そのものが前提）——" +
        "指定するなら、同じ変更の中で ADR 0111 の測定を引き直すこと。",
    ).toEqual([]);
  });
});
