/**
 * store 例外（`OutboxLeaseConflictError` ほか）の判定に使う内部の道具（ADR 0418）。
 *
 * **`instanceof` を使わない理由**: 利用者の手元で `@mnemora/core` が2つの版に分かれることがあり
 * （adapter は core を `^` で持つので、利用者が core を範囲外の版に固定すると adapter 側にもう1つの
 * core が入る）、そのとき adapter が投げる例外は runtime 側のクラスの `instanceof` では false に
 * なる。`kind` は値なので、クラスが別でも読める。
 *
 * 判定は「`kind` を見て、`kind` が無ければ `name` を見る」。`kind` がまだ無い古い版の core を引いた
 * adapter の例外にも効かせるため。`name` は偽装できるが、store は利用者が配線する信頼された部品なので
 * 実害は無いと判断している。
 *
 * 公開しない（このファイルは `index.ts` の `export *` に入っていない）。公開するのは各クラスに
 * 対応する `isXxxError`。
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
