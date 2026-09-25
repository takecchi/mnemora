import type { ClaimKeyOptions } from "@mnemora/core";
import type { EnvLike } from "./providers.js";

/**
 * Issue #691 続き（claimKey/detectContested の評価用 opt-in）。
 *
 * `packages/core` の claimKey（ADR 0320、Issue #371）・検出（ADR 0324、Issue #372）は
 * どちらも既定 off であり、この repo は `packages/core` 自体の既定を変えない
 * （マネージャー指示・北極星 問い2）。**この module が足すのは、`examples/chat` の
 * `answer` 経路だけで opt-in する薄い口である**——`MNEMORA_ANSWER_CLAIM_KEY=detect` を
 * 明示したときだけ `{ enabled: true, detectContested: true }` を返す。
 *
 * **未設定・空文字なら `undefined`**——`ingestConversation`（`mnemora-path.ts`）は
 * `claimKey` が `undefined` の呼び出しでは `runtime.observe()` へ `claimKey` キー自体を
 * 渡さない。⟹ **この env を設定しない限り、`answer`/`answer-bench` 経路の挙動は
 * 1バイトも変わらない。**
 *
 * **未知の値は例外**（`providers.ts` の `parseModeOverride` と同じ作法——黙って既定へ
 * 倒れない）。
 *
 * ⛔ **`knownPredicates` は渡さない。** ADR 0315/0320/0324 の実測はいずれも
 * `knownPredicates` 有りのほうが安定する（鍵の一致率が上がる）ことを示しているが、
 * `examples/chat` の `answer` ケース（`answer-case-set.dev.ts`/`.eval.ts`）向けの
 * 語彙一覧を作業者が手で作ると、その語彙選択自体が「どの主張が訂正対象か」を暗に
 * 漏らしうる（例: `meeting_day`/`moved_city` のような predicate 名は、ケースの
 * `expected.accept` が何かを読んだ結果になりかねない）。**この関数はまず
 * `knownPredicates` を渡さない版を主とする**——語彙ヒント無しでの claim key の
 * 安定性・検出の当たりをそのまま観測する。
 */
export const ANSWER_CLAIM_KEY_MODES = ["detect"] as const;
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
  // ANSWER_CLAIM_KEY_MODES が1値（"detect"）しか持たないため、ここに到達した時点で
  // raw === "detect" が確定している。将来値を増やしたときは、ここで分岐すること。
  return { enabled: true, detectContested: true };
}
