/**
 * LLM が返した本文（`content`）が空白だけなら投げる（Issue #1065）。
 *
 * 抽出・consolidate・reflect の3スキーマは、どれも `content: z.string().min(1)` で `""` を拒む
 * ——`""` はスキーマ不一致として provider が投げ、LLM の失敗の経路（抽出は全文フォールバック、
 * consolidate / reflect は `llm_failed`）へ落ちる。LLM が返した空白だけの文字列を「無い」と同じに
 * 扱う前例（digest の `resolveDigest`、claim key の `deriveClaimKeys`）に揃え、空白だけの本文も
 * `""` と同じ経路へ落とすために、`completeStructured` を囲む `try` の内側で呼ぶ。
 *
 * 判定は `trim()` で空になるかだけで、中身のある本文の前後の空白は削らない（書かれる本文は変えない）。
 * `index.ts` からは出さない内部の関数である。
 */
export function assertLLMContentNotBlank(content: string, where: string): void {
  if (content.trim().length === 0) {
    throw new Error(`LLM が空白だけの content を返した（${where}）`);
  }
}
