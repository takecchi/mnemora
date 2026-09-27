/**
 * LLM が返した tags から、空文字・空白だけの要素を捨てる（`index.ts` からは出さない内部の関数）。
 *
 * tags は「話題・内容の要約」を LLM が推論した値（ADR 0318 の3本の役割分担の表）であり、
 * 空白だけの要素は要約になっていない。LLM 由来の空白だけの文字列を「与えられなかった」として
 * 扱うのは、digest（`resolveDigest`、空白だけならフォールバック）と claim key
 * （`deriveClaimKeys`、空白だけなら `null`）と同じ扱いである。空白でない要素は、前後の空白・
 * 並び・重複も含めてそのまま残す（捨てる以外のことはしない）。
 *
 * 抽出（`buildNewMemoryFromCandidate`）・統合（`buildConsolidatedMemory`）・内省
 * （`buildReflectedMemory`）の3経路が、LLM の tags を Memory に書く前にこれを通す。
 * 歯は `__tests__/llm-blank-tags.test.ts` と `packages/postgres` の `llm-blank-tags.postgres.test.ts`。
 */
export function dropBlankTags(tags: readonly string[]): string[] {
  return tags.filter((tag) => tag.trim() !== "");
}
