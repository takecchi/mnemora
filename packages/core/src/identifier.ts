import type { Ctx } from "./ctx.js";
import { matchesStoreErrorKind } from "./store-error-kind.js";

/**
 * 識別子の文字の扱い（[ADR 0423](../../../docs/decisions/0423-identifier-well-formed-and-error-message-without-params.md)）。
 *
 * 識別子（`tenantId`・`subjectId`・`externalId`）は正規化せず、完全一致で比べる（{@link Ctx}）。
 * 孤立サロゲート（`\uD800` 単体など。対をなすサロゲートは断らない）と NUL（U+0000）を含む値は、
 * **入口で明示の例外で断る**。書き換えて通すことはしない。本文（`text`・`content` など）は対象外。
 */

/** 断った理由。 */
export type MalformedIdentifierReason = "lone_surrogate" | "nul";

/**
 * 識別子に、孤立サロゲートか NUL が含まれていたときに投げる例外（ADR 0423）。
 *
 * **message に入力値は入れない**（欄の名前・理由・位置だけ）。判別は `instanceof` ではなく
 * {@link isMalformedIdentifierError} で行う（ADR 0418）。
 */
export class MalformedIdentifierError extends Error {
  /** 判別子。クラスが2つの版に分かれても読める値（ADR 0418）。 */
  readonly kind = "malformed_identifier" as const;
  constructor(
    /** 断った欄の名前（例: `ctx.tenantId`、`input.externalId`）。 */
    readonly field: string,
    /** 断った理由。 */
    readonly reason: MalformedIdentifierReason,
    /** 問題の文字の位置（UTF-16 のコードユニット単位。0 始まり）。 */
    readonly index: number,
  ) {
    super(
      `${field} contains ${reason === "nul" ? "a NUL character (U+0000)" : "a lone UTF-16 surrogate"} ` +
        `at index ${index}; identifiers must be well-formed and are compared without normalization`,
    );
    this.name = "MalformedIdentifierError";
  }
}

/**
 * 受け取ったものが {@link MalformedIdentifierError} かを、**`instanceof` を使わずに**判定する（ADR 0418）。
 * `kind` を見て、`kind` が無ければ `name` を見る。
 */
export function isMalformedIdentifierError(value: unknown): value is MalformedIdentifierError {
  return matchesStoreErrorKind(value, "malformed_identifier", "MalformedIdentifierError");
}

/**
 * 識別子に含まれる最初の問題（孤立サロゲートか NUL）を返す。無ければ `null`。
 * 対をなすサロゲートは問題にしない。
 */
export function findMalformedIdentifierPart(
  value: string,
): { reason: MalformedIdentifierReason; index: number } | null {
  for (let i = 0; i < value.length; i++) {
    const unit = value.charCodeAt(i);
    if (unit === 0) {
      return { reason: "nul", index: i };
    }
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = i + 1 < value.length ? value.charCodeAt(i + 1) : 0;
      if (next >= 0xdc00 && next <= 0xdfff) {
        i++;
        continue;
      }
      return { reason: "lone_surrogate", index: i };
    }
    if (unit >= 0xdc00 && unit <= 0xdfff) {
      return { reason: "lone_surrogate", index: i };
    }
  }
  return null;
}

/**
 * 識別子が well-formed であることを確かめ、そうでなければ {@link MalformedIdentifierError} を投げる。
 * 文字列でない値（`undefined`・`null` を含む）は検査しない——省略できる欄をそのまま渡せるようにするため。
 * `field` は例外に載る欄の名前。**値は例外に載せない。**
 */
export function assertWellFormedIdentifier(value: unknown, field: string): void {
  if (typeof value !== "string") {
    return;
  }
  const found = findMalformedIdentifierPart(value);
  if (found !== null) {
    throw new MalformedIdentifierError(field, found.reason, found.index);
  }
}

/** {@link Ctx} の `tenantId` と `subjectId` に {@link assertWellFormedIdentifier} を掛ける。 */
export function assertWellFormedCtx(ctx: Ctx, field = "ctx"): void {
  if (typeof ctx !== "object" || ctx === null) {
    return;
  }
  assertWellFormedIdentifier(ctx.tenantId, `${field}.tenantId`);
  assertWellFormedIdentifier(ctx.subjectId, `${field}.subjectId`);
}

/**
 * `VectorFilter`・`LexicalFilter` のように、`tenantId`・`subjectId` で絞る検索条件に
 * {@link assertWellFormedIdentifier} を掛ける。`field` は例外に載る欄の名前（例: `opts.filter`）。
 */
export function assertWellFormedFilter(
  filter: { tenantId?: unknown; subjectId?: unknown } | null | undefined,
  field = "filter",
): void {
  if (typeof filter !== "object" || filter === null) {
    return;
  }
  assertWellFormedIdentifier(filter.tenantId, `${field}.tenantId`);
  assertWellFormedIdentifier(filter.subjectId, `${field}.subjectId`);
}
