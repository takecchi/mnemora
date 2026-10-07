/**
 * LLM が返した本文（`content`）が空白だけなら投げる。
 *
 * 抽出・consolidate・reflect のスキーマは `content: z.string().min(1)` で `""` を拒み、
 * LLM の失敗の経路へ落ちる。空白だけの本文も同じ経路へ落とすため、`completeStructured` を囲む
 * `try` の内側で呼ぶ。判定は `trim()` で空になるかだけで、中身のある本文の前後の空白は削らない。
 * `index.ts` からは出さない内部の関数である。
 */
export function assertLLMContentNotBlank(content: string, where: string): void {
  if (content.trim().length === 0) {
    throw new Error(`LLM が空白だけの content を返した（${where}）`);
  }
}
