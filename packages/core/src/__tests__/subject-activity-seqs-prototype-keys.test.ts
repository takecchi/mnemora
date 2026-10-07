import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import {
  readSubjectActivitySeq,
  readSubjectActivitySeqs,
} from "../interfaces/tenant-settings-store.js";
import type { TenantSettingsStore } from "../interfaces/tenant-settings-store.js";
import { intersectAttributes } from "../strategies/consolidate.js";

// 壊れ方: プレーンな `{}` に `result[id] ?? 0` で読むと、`result["constructor"]` は `Object` 関数を返し `?? 0` が効かない。
// `5 + ({}["valueOf"] ?? 0)` は文字列の連結になる。`__proto__` は代入が黙って捨てられ、読むと `Object.prototype` が返る。
const ctx: Ctx = { tenantId: "tenant-1" };
const PROTOTYPE_KEYS = ["constructor", "toString", "valueOf", "hasOwnProperty", "__proto__"];

/** 行が無い（キーを省略する）store。素直に `{}` を返す。 */
function emptyStore(): TenantSettingsStore {
  return {
    getSubjectActivitySeqs: async () => ({}),
  } as unknown as TenantSettingsStore;
}

describe("readSubjectActivitySeqs / readSubjectActivitySeq: Object.prototype のキー名の subjectId", () => {
  it("陽性対照: plain は 0（行なし）、行があればその値", async () => {
    const store = {
      getSubjectActivitySeqs: async () => ({ withRow: 7 }),
    } as unknown as TenantSettingsStore;
    const seqs = await readSubjectActivitySeqs(store, ctx, ["plain", "withRow"]);
    expect(seqs["plain"]).toBe(0);
    expect(seqs["withRow"]).toBe(7);
    expect(await readSubjectActivitySeq(emptyStore(), ctx, "plain")).toBe(0);
  });

  it.each(PROTOTYPE_KEYS)(
    "⭐ '%s' は行が無ければ 0 を返す（関数や prototype を返さない）",
    async (key) => {
      const seqs = await readSubjectActivitySeqs(emptyStore(), ctx, [key]);
      expect(seqs[key]).toBe(0);
      expect(Object.hasOwn(seqs, key)).toBe(true);
      expect(await readSubjectActivitySeq(emptyStore(), ctx, key)).toBe(0);
      expect(5 + (await readSubjectActivitySeq(emptyStore(), ctx, key))).toBe(5);
    },
  );

  it.each(PROTOTYPE_KEYS)(
    "⭐ '%s' は getSubjectActivitySeqs を持たない store でも 0",
    async (key) => {
      const seqs = await readSubjectActivitySeqs({} as unknown as TenantSettingsStore, ctx, [key]);
      expect(seqs[key]).toBe(0);
      expect(Object.hasOwn(seqs, key)).toBe(true);
    },
  );

  it.each(PROTOTYPE_KEYS)("⭐ '%s' の行がある store の値はそのまま読める", async (key) => {
    const result = Object.create(null) as Record<string, number>;
    result[key] = 4;
    const store = { getSubjectActivitySeqs: async () => result } as unknown as TenantSettingsStore;
    expect(await readSubjectActivitySeq(store, ctx, key)).toBe(4);
  });

  it("store が返した結果の prototype 側の値は、subject の行として読まない", async () => {
    class WithInherited {}
    (WithInherited.prototype as unknown as Record<string, number>)["inherited"] = 9;
    const store = {
      getSubjectActivitySeqs: async () => new WithInherited(),
    } as unknown as TenantSettingsStore;
    expect(await readSubjectActivitySeq(store, ctx, "inherited")).toBe(0);
  });

  it("store が返した有限でない値（NaN・文字列）は 0 へ倒す", async () => {
    const store = {
      getSubjectActivitySeqs: async () => ({ a: Number.NaN, b: "3", c: Infinity }),
    } as unknown as TenantSettingsStore;
    const seqs = await readSubjectActivitySeqs(store, ctx, ["a", "b", "c"]);
    expect([seqs["a"], seqs["b"], seqs["c"]]).toEqual([0, 0, 0]);
  });
});

describe("intersectAttributes: Object.prototype のキー名の attributes のキー（横展開、ADR 0472）", () => {
  const raw = JSON.parse('{"__proto__":"x","constructor":"y","k":"z"}') as Record<string, string>;

  it("⭐ 全件が持つ '__proto__'・'constructor' のキーを積集合に残す", () => {
    const result = intersectAttributes([{ attributes: raw }, { attributes: raw }]);
    expect(Object.keys(result).sort()).toEqual(["__proto__", "constructor", "k"]);
    expect(Object.entries(result)).toEqual(Object.entries(raw));
  });

  it("⭐ 片方が持たないキーは落とす（'constructor' を継承された関数と取り違えない）", () => {
    const result = intersectAttributes([
      { attributes: { constructor: "y", k: "z" } },
      { attributes: { k: "z" } },
    ]);
    expect(Object.keys(result)).toEqual(["k"]);
  });
});
