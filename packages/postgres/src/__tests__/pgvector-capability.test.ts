import { describe, expect, it } from "vitest";
import {
  PGVECTOR_CAPABILITY_QUERY,
  PGVECTOR_REQUIRED_VERSION,
  PgvectorVersionUnsupportedError,
  assertPgvectorCapabilityRow,
  assertPgvectorCapabilityViaQuery,
  type PgvectorCapabilityRow,
} from "../pgvector-capability.js";

/**
 * `assertPgvectorCapabilityRow`（Issue #1301 / ADR 0367）を **DB 無しで**検査する歯。
 *
 * ## なぜ版の文字列（`extversion`）ではなく、この形の行で表すか
 *
 * `../pgvector-capability.ts` のファイル doc コメントが実測とともに説明しているとおり、
 * 判定は `pg_settings`（`vartype`/`enumvals`）だけを見る——`extversion` はエラーメッセージに
 * 添えるだけで、合否には一切関与しない。この歯はその境界線自体も固定する
 * （「`vartype`/`enumvals` が同じでも `extversion` が変われば判定が変わる」ことが
 * 無いことを、`extversion` だけを変えた行のペアで示す）。
 *
 * 本物の PostgreSQL 17.11 + pgvector 0.8.0 に対する実測（ADR 0367 決定2）で得られた
 * 実際の行の形を、下の `PGVECTOR_0_8_0_ROW` に固定してある。
 */

/** 実測（PostgreSQL 17.11 + pgvector 0.8.0、自分専用の `initdb` インスタンス）どおりの行。 */
const PGVECTOR_0_8_0_ROW: PgvectorCapabilityRow = {
  extversion: "0.8.0",
  vartype: "enum",
  enumvals: ["off", "relaxed_order", "strict_order"],
};

describe("PGVECTOR_CAPABILITY_QUERY: SQL 文そのものの形", () => {
  it("vector を使う副問い合わせと、pg_extension・pg_settings への LEFT JOIN を含む1文である", () => {
    expect(PGVECTOR_CAPABILITY_QUERY).toContain("::vector");
    expect(PGVECTOR_CAPABILITY_QUERY).toContain("pg_extension");
    expect(PGVECTOR_CAPABILITY_QUERY).toContain("pg_settings");
    expect(PGVECTOR_CAPABILITY_QUERY).toContain("hnsw.iterative_scan");
    // 能力検査は SET を一切発行しない——`hnsw-ef-search-window-ceiling.test.ts` 検査2
    // （ADR 0284、「SET している箇所は vector-store.ts の search() 1箇所だけ」）を
    // 壊さないことの直接の裏付け。
    expect(PGVECTOR_CAPABILITY_QUERY).not.toMatch(/\bSET\b/i);
  });
});

describe("assertPgvectorCapabilityRow: 判定は pg_settings の行だけで決まる（版の文字列は見ない）", () => {
  it("実測どおりの 0.8.0 の行（vartype: enum, enumvals に relaxed_order を含む）は通る", () => {
    expect(() => assertPgvectorCapabilityRow(PGVECTOR_0_8_0_ROW)).not.toThrow();
  });

  it("行が無い（undefined）— 0.8 未満で `pg_settings` に該当行が現れない代表形 — は落ちる", () => {
    expect(() => assertPgvectorCapabilityRow(undefined)).toThrow(PgvectorVersionUnsupportedError);
  });

  it("vartype/enumvals が null（LEFT JOIN が一致しなかった形）は落ちる", () => {
    expect(() =>
      assertPgvectorCapabilityRow({ extversion: "0.7.4", vartype: null, enumvals: null }),
    ).toThrow(PgvectorVersionUnsupportedError);
  });

  it("vartype が enum 以外（万一 pgvector 側で型が変わった場合の防御）は落ちる", () => {
    expect(() =>
      assertPgvectorCapabilityRow({
        extversion: "0.8.0",
        vartype: "string",
        enumvals: ["off", "relaxed_order"],
      }),
    ).toThrow(PgvectorVersionUnsupportedError);
  });

  it("enumvals に relaxed_order が無い（列挙はあるが値が足りない、万一の防御）は落ちる", () => {
    expect(() =>
      assertPgvectorCapabilityRow({
        extversion: "0.8.0",
        vartype: "enum",
        enumvals: ["off", "strict_order"],
      }),
    ).toThrow(PgvectorVersionUnsupportedError);
  });

  it("extversion だけを変えても、vartype/enumvals が対応していれば判定は変わらない（版の文字列を見ていないことの直接証明）", () => {
    // 実際の pgvector にはこの extversion は存在しないが、「判定が extversion を
    // 一切参照しない」ことを示すための合成値である——`extversion` は "0.7.4"
    // （本来なら対応していないはずの古い版）のままでも、`vartype`/`enumvals`
    // だけで通ることを見る。
    expect(() =>
      assertPgvectorCapabilityRow({
        extversion: "0.7.4",
        vartype: "enum",
        enumvals: ["off", "relaxed_order", "strict_order"],
      }),
    ).not.toThrow();
  });

  it("PgvectorVersionUnsupportedError の形: installed/required/missingCapability/name/instanceof Error", () => {
    let caught: unknown;
    try {
      assertPgvectorCapabilityRow({ extversion: "0.7.4", vartype: null, enumvals: null });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(caught).toBeInstanceOf(PgvectorVersionUnsupportedError);
    const err = caught as PgvectorVersionUnsupportedError;
    expect(err.name).toBe("PgvectorVersionUnsupportedError");
    expect(err.installed).toBe("0.7.4");
    expect(err.required).toBe(PGVECTOR_REQUIRED_VERSION);
    expect(err.missingCapability).toBe("hnsw.iterative_scan");
    expect(err.message).toContain("0.7.4");
    expect(err.message).toContain(PGVECTOR_REQUIRED_VERSION);
    expect(err.message).toContain("ALTER EXTENSION vector UPDATE");
  });

  it("拡張自体が無い（extversion が undefined）ときは installed が undefined になり、文言も『見当たりません』に振れる", () => {
    let caught: unknown;
    try {
      assertPgvectorCapabilityRow(undefined);
    } catch (err) {
      caught = err;
    }
    const err = caught as PgvectorVersionUnsupportedError;
    expect(err.installed).toBeUndefined();
    expect(err.message).toContain("見当たりません");
  });
});

describe("assertPgvectorCapabilityViaQuery: migrate.ts が使う pool/client 形の薄いラッパー", () => {
  it("queryable.query が PGVECTOR_CAPABILITY_QUERY を1回発行し、通る行なら何もしない", async () => {
    const calls: string[] = [];
    const queryable = {
      query: async (text: string) => {
        calls.push(text);
        return { rows: [PGVECTOR_0_8_0_ROW] };
      },
    };

    await expect(assertPgvectorCapabilityViaQuery(queryable)).resolves.toBeUndefined();
    expect(calls).toEqual([PGVECTOR_CAPABILITY_QUERY]);
  });

  it("行が対応していなければ PgvectorVersionUnsupportedError を投げる", async () => {
    const queryable = { query: async () => ({ rows: [] }) };
    await expect(assertPgvectorCapabilityViaQuery(queryable)).rejects.toBeInstanceOf(
      PgvectorVersionUnsupportedError,
    );
  });
});
