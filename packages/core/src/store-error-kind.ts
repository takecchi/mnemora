/**
 * store 例外（`OutboxLeaseConflictError` ほか）の判定に使う内部の道具（ADR 0418）。
 *
 * 🔴 **なぜ `instanceof` ではないか。** 利用者の手元で `@mnemora/core` が2つの版に分かれることがある
 * （adapter は core を `dependencies` の `^` で持つので、利用者が core を範囲外の版に固定すると、
 * adapter 側にもう1つの core が入る）。そのとき adapter が投げる store 例外は、runtime 側のクラスの
 * `instanceof` では false になる。`kind` は値なので、クラスが別でも読める
 * （`@mnemora/local-embedding` の `isLocalEmbeddingProviderError` と同じ理由）。
 *
 * **判定は「`kind` を見て、`kind` が無ければ `name` を見る」。** `kind` がまだ無い古い版の core を
 * 引いた adapter が投げた例外にも効かせるため。`name` は偽装できるが、store は利用者が自分で配線する
 * 信頼された部品なので、実害は無いと判断している（ADR 0418）。
 *
 * ⚠ 公開しない（`index.ts` は各 `interfaces/*.ts` を `export *` するが、このファイルは入っていない）。
 * 公開するのは、各クラスに対応する `isXxxError` である。
 */
export function matchesStoreErrorKind(value: unknown, kind: string, name: string): boolean {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as { kind?: unknown; name?: unknown };
  if (candidate.kind !== undefined) {
    return candidate.kind === kind;
  }
  return candidate.name === name;
}
