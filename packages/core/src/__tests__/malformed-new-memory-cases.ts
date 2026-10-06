import type { NewMemory } from "../memory.js";

/**
 * ADR 0630: 書いたら読み戻したときに `MemorySchema` を通らなくなる `NewMemory` の形（拒む側）と、
 * その境界のすぐ内側の形（通す側）。core の単体テスト・Fake の歯・`@mnemora/postgres` の歯が共有する。
 *
 * ⚠ `packages/testkit/src/memory-store-conformance.ts` は、同じ形を自前で持つ（core のテストの
 * ファイルは testkit から import できない）。形を足すときは両方に足すこと。
 *
 * `over(obs)` は、`NewMemory` へ重ねる欄を返す。`obs` は実在する Observation の id（`stated`・`inferred` は、
 * 列の `sourceObservationId` が非 `null` でなければならない——それは既存の検査で、ここの対象ではない）。
 */
export type NewMemoryCase = {
  label: string;
  /** 例外の message に、この欄の名前が含まれること。 */
  field: RegExp;
  over: (obs: string) => Partial<NewMemory>;
};

const inferred = (obs: string, over: Record<string, unknown>) =>
  ({
    sourceObservationId: obs,
    provenance: {
      kind: "inferred",
      model: "m",
      promptVersion: "p",
      basis: { memoryIds: [], observationIds: [] },
      confidence: 0.5,
      ...over,
    } as never,
  }) satisfies Partial<NewMemory>;

const stated = (obs: string, over: Record<string, unknown>) =>
  ({
    sourceObservationId: obs,
    provenance: {
      kind: "stated",
      sourceObservationId: obs,
      at: "2026-01-01T00:00:00Z",
      ...over,
    } as never,
  }) satisfies Partial<NewMemory>;

export const MALFORMED_NEW_MEMORY_CASES: ReadonlyArray<NewMemoryCase> = [
  { label: "digest が空文字", field: /digest/, over: () => ({ digest: "" }) },
  { label: "contentHash が空文字", field: /contentHash/, over: () => ({ contentHash: "" }) },
  {
    label: "extractorVersion が空文字",
    field: /extractorVersion/,
    over: () => ({ extractorVersion: "" }),
  },
  {
    label: "claimKey.subject が空文字",
    field: /claimKey\.subject/,
    over: () => ({ claimKey: { subject: "", predicate: "p" } }),
  },
  {
    label: "claimKey.predicate が空文字",
    field: /claimKey\.predicate/,
    over: () => ({ claimKey: { subject: "s", predicate: "" } }),
  },
  {
    label: "claimKey が subject だけ",
    field: /claimKey\.predicate/,
    over: () => ({ claimKey: { subject: "s" } as never }),
  },
  {
    label: "claimKey が predicate だけ",
    field: /claimKey\.subject/,
    over: () => ({ claimKey: { predicate: "p" } as never }),
  },
  {
    label: "attributes の値が数",
    field: /attributes/,
    over: () => ({ attributes: { a: 1 } as never }),
  },
  {
    label: "attributes の値が入れ子のオブジェクト",
    field: /attributes/,
    over: () => ({ attributes: { a: { b: "c" } } as never }),
  },
  {
    label: "attributes の値が null",
    field: /attributes/,
    over: () => ({ attributes: { a: null } as never }),
  },
  {
    label: "provenance: stated で sourceObservationId・at が無い",
    field: /provenance\.sourceObservationId/,
    over: (obs) => ({ sourceObservationId: obs, provenance: { kind: "stated" } as never }),
  },
  {
    label: "provenance: stated で at が空文字",
    field: /provenance\.at/,
    over: (obs) => stated(obs, { at: "" }),
  },
  {
    label: "provenance: stated で speaker が空文字",
    field: /provenance\.speaker/,
    over: (obs) => stated(obs, { speaker: "" }),
  },
  {
    label: "provenance: inferred で confidence が 2",
    field: /provenance\.confidence/,
    over: (obs) => inferred(obs, { confidence: 2 }),
  },
  {
    label: "provenance: inferred で confidence が負",
    field: /provenance\.confidence/,
    over: (obs) => inferred(obs, { confidence: -0.01 }),
  },
  {
    label: "provenance: inferred で model が無い",
    field: /provenance\.model/,
    over: (obs) => inferred(obs, { model: undefined }),
  },
  {
    label: "provenance: inferred で basis.memoryIds に空文字",
    field: /provenance\.basis/,
    over: (obs) => inferred(obs, { basis: { memoryIds: [""], observationIds: [] } }),
  },
  {
    label: "provenance: consolidated で sources が空",
    field: /provenance\.sources/,
    over: () => ({ provenance: { kind: "consolidated", sources: [] } }),
  },
  {
    label: "provenance: reflected で sources に空文字",
    field: /provenance\.sources/,
    over: () => ({ provenance: { kind: "reflected", sources: [""] } }),
  },
  {
    label: "provenance: imported で batchId が空文字",
    field: /provenance\.batchId/,
    over: () => ({ provenance: { kind: "imported", batchId: "" } }),
  },
  {
    label: "provenance: imported で batchId が無い",
    field: /provenance\.batchId/,
    over: () => ({ provenance: { kind: "imported" } as never }),
  },
  // 変異試験（2026-10-06）で、欄の検査は残ったまま「その形だけ見逃す」変異が生き残った形。
  {
    label: "provenance: stated で sourceObservationId が空文字",
    field: /provenance\.sourceObservationId/,
    over: (obs) => stated(obs, { sourceObservationId: "" }),
  },
  {
    label: "provenance: stated で at が無い",
    field: /provenance\.at/,
    over: (obs) => stated(obs, { at: undefined }),
  },
  {
    label: "provenance: inferred で confidence が NaN",
    field: /provenance\.confidence/,
    over: (obs) => inferred(obs, { confidence: Number.NaN }),
  },
  {
    label: "provenance: inferred で confidence が無い",
    field: /provenance\.confidence/,
    over: (obs) => inferred(obs, { confidence: undefined }),
  },
  {
    label: "provenance: inferred で model が空文字",
    field: /provenance\.model/,
    over: (obs) => inferred(obs, { model: "" }),
  },
  {
    label: "provenance: inferred で promptVersion が無い",
    field: /provenance\.promptVersion/,
    over: (obs) => inferred(obs, { promptVersion: undefined }),
  },
  {
    label: "provenance: inferred で basis.observationIds に空文字",
    field: /provenance\.basis/,
    over: (obs) => inferred(obs, { basis: { memoryIds: [], observationIds: [""] } }),
  },
  {
    label: "provenance: inferred で basis が無い",
    field: /provenance\.basis/,
    over: (obs) => inferred(obs, { basis: undefined }),
  },
  {
    label: "provenance: consolidated で sources に空文字",
    field: /provenance\.sources/,
    over: () => ({ provenance: { kind: "consolidated", sources: ["m1", ""] } }),
  },
  {
    label: "provenance: consolidated で sources が無い",
    field: /provenance\.sources/,
    over: () => ({ provenance: { kind: "consolidated" } as never }),
  },
  {
    label: "provenance: reflected で sources が配列でない",
    field: /provenance\.sources/,
    over: () => ({ provenance: { kind: "reflected", sources: "m1" } as never }),
  },
  {
    label: "provenance: inferred で confidence が文字列",
    field: /provenance\.confidence/,
    over: (obs) => inferred(obs, { confidence: "0.5" }),
  },
  {
    label: "provenance: inferred で promptVersion が空文字",
    field: /provenance\.promptVersion/,
    over: (obs) => inferred(obs, { promptVersion: "" }),
  },
  {
    label: "provenance: inferred で basis.memoryIds が無い",
    field: /provenance\.basis/,
    over: (obs) => inferred(obs, { basis: { observationIds: [] } }),
  },
  {
    label: "provenance: inferred で basis.observationIds が無い",
    field: /provenance\.basis/,
    over: (obs) => inferred(obs, { basis: { memoryIds: [] } }),
  },
  {
    label: "attributes が文字列",
    field: /attributes/,
    over: () => ({ attributes: "a" as never }),
  },
  {
    label: "attributes が配列",
    field: /attributes/,
    over: () => ({ attributes: ["a"] as never }),
  },
  {
    label: "attributes の値が真偽値",
    field: /attributes/,
    over: () => ({ attributes: { a: true } as never }),
  },
];

/** 境界のすぐ内側（通し続ける形）。 */
export const WELL_FORMED_NEW_MEMORY_CASES: ReadonlyArray<{
  label: string;
  over: (obs: string) => Partial<NewMemory>;
}> = [
  { label: "extractorVersion が空でない", over: () => ({ extractorVersion: "v1" }) },
  { label: "extractorVersion が null", over: () => ({ extractorVersion: null }) },
  { label: "claimKey が無い（null）", over: () => ({ claimKey: null }) },
  { label: "claimKey が無い（undefined）", over: () => ({ claimKey: undefined }) },
  { label: "claimKey が1文字ずつ", over: () => ({ claimKey: { subject: "s", predicate: "p" } }) },
  { label: "attributes が空のオブジェクト", over: () => ({ attributes: {} }) },
  { label: "attributes が省略", over: () => ({ attributes: undefined }) },
  // `null` の `attributes` は「無い」として扱われ、`{}` で書かれる（ADR 0630 決定2）。
  { label: "attributes が null", over: () => ({ attributes: null as never }) },
  { label: "extractorVersion が省略", over: () => ({ extractorVersion: undefined }) },
  { label: "attributes の値が空文字", over: () => ({ attributes: { a: "" } }) },
  { label: "attributes が文字列だけ", over: () => ({ attributes: { a: "b", c: "d" } }) },
  { label: "digest が1文字", over: () => ({ digest: "d" }) },
  { label: "content が空文字（検査しない欄）", over: () => ({ content: "" }) },
  {
    label: "provenance: inferred で confidence が 0",
    over: (obs) => inferred(obs, { confidence: 0 }),
  },
  {
    label: "provenance: inferred で confidence が 1",
    over: (obs) => inferred(obs, { confidence: 1 }),
  },
  { label: "provenance: stated（speaker 無し）", over: (obs) => stated(obs, {}) },
  { label: "provenance: stated（speaker 有り）", over: (obs) => stated(obs, { speaker: "u" }) },
  {
    label: "provenance: consolidated で sources が1件",
    over: () => ({ provenance: { kind: "consolidated", sources: ["m1"] } }),
  },
  {
    label: "provenance: reflected で sources が無い",
    over: () => ({ provenance: { kind: "reflected" } }),
  },
  {
    label: "provenance: reflected で sources が空配列",
    over: () => ({ provenance: { kind: "reflected", sources: [] } }),
  },
  {
    label: "provenance: imported で batchId が1文字",
    over: () => ({ provenance: { kind: "imported", batchId: "b" } }),
  },
  // ADR 0630 の「拒みすぎない」側（独立確認の指摘）: 今は通る形。`MemorySchema` が拒まない形は、入口も拒まない。
  {
    label: "claimKey が空白だけ（subject が半角空白・predicate がタブ）",
    over: () => ({ claimKey: { subject: " ", predicate: "\t" } }),
  },
  // 孤立サロゲートは保存時に U+FFFD へ置き換わる（ADR 0543）。ここは「拒まない」ことと、読み戻しが通ることだけ。
  {
    label: "claimKey に孤立サロゲートを含む",
    over: () => ({ claimKey: { subject: "a\uD800b", predicate: "p\uDC00q" } }),
  },
  // `MemorySchema.attributes` は `z.record(z.string(), z.string())`（キーの文字種を見ない）。入力側の `AttributesSchema` の
  // キーの決まり（`/^[A-Za-z0-9_.:-]+$/`・1〜64文字）の外でも、書き込みの口は拒まない。
  { label: "attributes のキーが空文字", over: () => ({ attributes: { "": "v" } }) },
  { label: "attributes のキーに空白を含む", over: () => ({ attributes: { "a b": "v" } }) },
  { label: "attributes のキーに記号を含む", over: () => ({ attributes: { "a/b": "v" } }) },
  { label: "attributes のキーが非 ASCII", over: () => ({ attributes: { キー: "v" } }) },
  // `MemorySchema.provenance` は余分なキーを拒まない（zod の既定。strict ではない）。
  { label: "provenance: stated に余分なキー", over: (obs) => stated(obs, { extra: "x" }) },
  { label: "provenance: inferred に余分なキー", over: (obs) => inferred(obs, { extra: "x" }) },
  {
    label: "provenance: imported に余分なキー",
    over: () => ({ provenance: { kind: "imported", batchId: "b", extra: "x" } as never }),
  },
];
