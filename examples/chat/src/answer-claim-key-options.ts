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
 * ⛔ **`knownPredicates`（利用者が手で作る語彙ヒント）は渡さない。** ADR 0315/0320/0324
 * の実測はいずれも `knownPredicates` 有りのほうが安定する（鍵の一致率が上がる）ことを
 * 示しているが、`examples/chat` の `answer` ケース（`answer-case-set.dev.ts`/`.eval.ts`）
 * 向けの語彙一覧を作業者が手で作ると、その語彙選択自体が「どの主張が訂正対象か」を暗に
 * 漏らしうる（例: `meeting_day`/`moved_city` のような predicate 名は、ケースの
 * `expected.accept` が何かを読んだ結果になりかねない）。**"detect" 版は
 * `knownPredicates` を渡さない**——語彙ヒント無しでの claim key の安定性・検出の
 * 当たりをそのまま観測する。
 *
 * `"detect-known-predicates-from-store"`（Issue #691続き、ADR 0328。ADR 0326
 * 「採らなかった案B」の実測）は、上の懸念（作業者が手で語彙を選ぶと正解が漏れる）を
 * 別の形で解く——**手で選んだ語彙は一切使わず**、`ClaimKeyOptions.
 * knownPredicatesFromStore: true` で `MemoryStore.listActiveClaimPredicates?` から
 * **その場で実際に store にある** predicate だけを集めて渡す。作業者の主観が
 * 入り込む余地が無い（語彙選択そのものが store の実データから決まる）。
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
  // ANSWER_CLAIM_KEY_MODES の残りは "detect" だけであることが、上のガードと
  // 分岐で確定している。
  return { enabled: true, detectContested: true };
}
