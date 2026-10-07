import { createHash } from "node:crypto";

/**
 * `content` の SHA-256（hex）。core は実行時依存を zod のみに保つため `node:crypto` を持てず、
 * この計算は adapter 側に置いて `RuntimeDeps.hashContent` へ注入する。
 */
export function sha256Hex(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}
