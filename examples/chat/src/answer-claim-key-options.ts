import type { ClaimKeyOptions } from "@mnemora/core";
import type { EnvLike } from "./providers.js";

/**
 * `answer` 経路だけで claimKey の評価を opt-in する薄い口。未設定・空文字なら `undefined` で、挙動は変わらない。
 *
 * `knownPredicates`（手で作る語彙ヒント）は渡さない。ケース向けの語彙を作業者が手で選ぶと、
 * その選択自体がどの主張が訂正対象かを漏らしうるため。
 */
export const ANSWER_CLAIM_KEY_MODES = ["detect", "detect-known-predicates-from-store"] as const;
export type AnswerClaimKeyMode = (typeof ANSWER_CLAIM_KEY_MODES)[number];

export function resolveAnswerClaimKeyOptions(env: EnvLike): ClaimKeyOptions | undefined {
  const raw = env.MNEMORA_ANSWER_CLAIM_KEY;
  if (raw === undefined || raw === "") {
    return undefined;
  }
  if (!(ANSWER_CLAIM_KEY_MODES as readonly string[]).includes(raw)) {
    throw new Error(
      `MNEMORA_ANSWER_CLAIM_KEY には ${ANSWER_CLAIM_KEY_MODES.map((m) => `"${m}"`).join(" / ")} の` +
        `いずれかを指定すること（実際: "${raw}"）。`,
    );
  }
  if (raw === "detect-known-predicates-from-store") {
    return { enabled: true, detectContested: true, knownPredicatesFromStore: true };
  }
  return { enabled: true, detectContested: true };
}

/**
 * `condition === "known-subjects"` のときだけ、ケースの `knownSubjects` を合流させる。
 * 上限（オラクル）測定の経路で、実運用で mnemora が正解を知っている保証は無い。
 * `condition` を `string` に緩めているのは、`RecordCondition` とこの module を結合しないため。
 */
export function applyCaseKnownSubjects(
  claimKeyOptions: ClaimKeyOptions,
  condition: string,
  caseKnownSubjects: string[] | undefined,
): ClaimKeyOptions {
  if (condition !== "known-subjects" || caseKnownSubjects === undefined) {
    return claimKeyOptions;
  }
  return { ...claimKeyOptions, knownSubjects: caseKnownSubjects };
}
