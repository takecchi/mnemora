import type { ProbeUtterance } from "./probe-set.js";
import type { IdentifierHaystackKind } from "./identifier-probe-set.js";
import type { ArmProbeSetSpec } from "./identifier-arm.js";
import { IDENTIFIER_PROBE_SET_SPEC } from "./identifier-arm.js";
import { JAPANESE_NAME_PROBE_SET_SPEC } from "./japanese-name-probe-set.js";
import { NUMERAL_TOKEN_PROBE_SET_SPEC } from "./numeral-token-probe-set.js";

/**
 * Issue #109 後半（#106/#109 の「これが覆るとしたら」第1項——標本が数十件になり、
 * その母数で偽陽性率に上限を置けると実測できたとき）のための、
 * **OpenAI 実埋め込み・`recorded` provider の arm を通す6群**の宣言。
 *
 * ⛔ **`identifier-probe-set.ts`/`japanese-name-probe-set.ts`/`numeral-token-probe-set.ts`
 * には1文字も触れていない。**ここは既存の `ArmProbeSetSpec`/`buildConversation` を
 * import して使うだけである（ADR 0094 §3 の規律——既存 probe 集合には触らず、
 * 別ファイルで新しい組み合わせを作る）。
 *
 * **なぜ `japanese`（`./probe-set.js` の既存7 probe）を含めないか**: この群は既に
 * `retrieval-baseline.json` の arm B/C が `(openai, text-embedding-3-small, 256)` で
 * 測っている（`examples/chat/cassettes/retrieval.json`）。同じ空間・同じ probe を
 * 二重に録ると、どちらが正本か分からなくなる。⟹ **ここで足すのは、まだ OpenAI 空間で
 * 測ったことが無い4集合（識別子×2haystack・日本語固有名詞×2haystack）と、
 * 数詞・記号索引×2haystack の計6群だけ**である。
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
  /** どのファミリーに属するか。CLI 側で JSON 出力先を分けるために使う。 */
  family: "identifier" | "numeral";
  probeSet: ArmProbeSetSpec;
  haystackKind: IdentifierHaystackKind;
  /** `armLabel` を組む素材。実際の `(provider, model, dimensions)` は呼び出し側が
   *  実測空間から埋める（ADR 0094 §1「数字には必ず3つを添える」）。 */
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

export function identifierArmGroups(): readonly OpenAiArmGroupDescriptor[] {
  return OPENAI_ARM_GROUPS.filter((g) => g.family === "identifier");
}

export function numeralArmGroups(): readonly OpenAiArmGroupDescriptor[] {
  return OPENAI_ARM_GROUPS.filter((g) => g.family === "numeral");
}

/**
 * 1群の会話（`buildConversation`）を実際に組み立て、utterance 全文を返す。
 * haystack サイズは各 probe 集合の既定（`buildConversation` 第1引数省略）に揃える
 * ——CI で実際に走る `identifier-probes`/`numeral-token-probes` サブコマンドと
 * 同じ既定値を使うことが、この測定の忠実さの前提である。
 */
export function buildGroupConversation(group: OpenAiArmGroupDescriptor): ProbeUtterance[] {
  return group.probeSet.buildConversation(undefined, group.haystackKind);
}

/**
 * 与えた群集合が要求する**全テキストの和集合**（重複除去済み）を返す。
 * これを1回のバッチ embed 呼び出しに渡す（マネージャー指示「1巡=1回のバッチ呼び出し」）。
 *
 * query は `buildConversation` の戻り値に現れない（`recall()` 時に別途埋め込まれる
 * 入力であり、ingest される memory ではない）ため、ここで明示的に足す。
 */
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
