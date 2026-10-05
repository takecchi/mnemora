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
];
