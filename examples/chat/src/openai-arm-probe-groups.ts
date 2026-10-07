import type { ProbeUtterance } from "./probe-set.js";
import type { IdentifierHaystackKind } from "./identifier-probe-set.js";
import type { ArmProbeSetSpec } from "./identifier-arm.js";
import { IDENTIFIER_PROBE_SET_SPEC } from "./identifier-arm.js";
import { JAPANESE_NAME_PROBE_SET_SPEC } from "./japanese-name-probe-set.js";
import { NUMERAL_TOKEN_PROBE_SET_SPEC } from "./numeral-token-probe-set.js";

/**
 * OpenAI 実埋め込み・`recorded` provider の arm を通す6群の宣言。`japanese`（`./probe-set.js` の既存7 probe）を含めないのは、
 * 既に `retrieval-baseline.json` の arm B/C が同じ空間で測っており、二重に録るとどちらが正本か分からなくなるため。
 */
export type OpenAiArmGroupKey =
  | "identifiersSparse"
  | "identifiersDense"
  | "japaneseNamesSparse"
  | "japaneseNamesDense"
  | "numeralSparse"
  | "numeralDense";

export interface OpenAiArmGroupDescriptor {
  key: OpenAiArmGroupKey;
  family: "identifier" | "numeral";
  probeSet: ArmProbeSetSpec;
  haystackKind: IdentifierHaystackKind;
  labelSlug: string;
}

export const OPENAI_ARM_GROUPS: readonly OpenAiArmGroupDescriptor[] = [
  {
    key: "identifiersSparse",
    family: "identifier",
    probeSet: IDENTIFIER_PROBE_SET_SPEC,
    haystackKind: "sparse",
    labelSlug: "identifiers-sparse",
  },
  {
    key: "identifiersDense",
    family: "identifier",
    probeSet: IDENTIFIER_PROBE_SET_SPEC,
    haystackKind: "dense",
    labelSlug: "identifiers-dense",
  },
  {
    key: "japaneseNamesSparse",
    family: "identifier",
    probeSet: JAPANESE_NAME_PROBE_SET_SPEC,
    haystackKind: "sparse",
    labelSlug: "japanese-names-sparse",
  },
  {
    key: "japaneseNamesDense",
    family: "identifier",
    probeSet: JAPANESE_NAME_PROBE_SET_SPEC,
    haystackKind: "dense",
    labelSlug: "japanese-names-dense",
  },
  {
    key: "numeralSparse",
    family: "numeral",
    probeSet: NUMERAL_TOKEN_PROBE_SET_SPEC,
    haystackKind: "sparse",
    labelSlug: "sparse",
  },
  {
    key: "numeralDense",
    family: "numeral",
    probeSet: NUMERAL_TOKEN_PROBE_SET_SPEC,
    haystackKind: "dense",
    labelSlug: "dense",
  },
];

/**
 * `armLabel` の唯一の出所。`cli.ts` と `openai-embedding-fp-ceiling.ts` のどちらもこの関数で label を組み、
 * 別々の文字列テンプレートを持たない（2箇所に持つと label だけ相違が出続けた）。
 */
export function buildArmLabel(
  group: OpenAiArmGroupDescriptor,
  params: { llmMode: string; embeddingMode: string; model: string; dimensions: number },
): string {
  const prefix = group.family === "identifier" ? "identifier-probes" : "numeral-token-probes";
  return (
    `${prefix}/${group.labelSlug}(llm=${params.llmMode}, ` +
    `embedding=${params.embeddingMode}/${params.model}/${params.dimensions}次元, ` +
    `haystack=${group.haystackKind})`
  );
}

export function identifierArmGroups(): readonly OpenAiArmGroupDescriptor[] {
  return OPENAI_ARM_GROUPS.filter((g) => g.family === "identifier");
}

export function numeralArmGroups(): readonly OpenAiArmGroupDescriptor[] {
  return OPENAI_ARM_GROUPS.filter((g) => g.family === "numeral");
}

/** haystack サイズは各 probe 集合の既定に揃える（CI で走るサブコマンドと同じ既定値を使うことが、この測定の忠実さの前提）。 */
export function buildGroupConversation(group: OpenAiArmGroupDescriptor): ProbeUtterance[] {
  return group.probeSet.buildConversation(undefined, group.haystackKind);
}

/** query は `buildConversation` の戻り値に現れない（`recall()` 時に別途埋め込まれる）ので、ここで明示的に足す。 */
export function collectAllTexts(groups: readonly OpenAiArmGroupDescriptor[]): string[] {
  const set = new Set<string>();
  for (const group of groups) {
    for (const utterance of buildGroupConversation(group)) {
      set.add(utterance.text);
    }
    for (const probe of group.probeSet.probes) {
      set.add(probe.query);
    }
  }
  return [...set];
}
