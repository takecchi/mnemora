import type { ClaimKey, NewMemory, NewObservation } from "@mnemora/core";

/**
 * ADR 0543: 孤立サロゲート（対をなさない UTF-16 のサロゲートコードユニット）を U+FFFD に置き換える。
 *
 * `@mnemora/postgres` は `text` 列（と `text[]`・`text` の引数）に入る文字列を node-postgres が UTF-8 へ変換するときに、
 * 孤立サロゲートを 1 単位ずつ U+FFFD に置き換える（ADR 0423 の文脈。以前の fixture は置き換えず、そのまま保持していた）。
 * fixture は、書き込みでも読み取りの引数でも、その置き換えを同じ規則で行う。対をなすサロゲート（絵文字など）・普通の文字列・
 * U+FFFD そのものは変えない。
 *
 * **対象は Postgres で `text` 列に入る欄だけである。** 識別子（`tenantId`・`subjectId`・`externalId`）は ADR 0423 が入口で
 * 断る（置き換えない）。`jsonb` 列（`payload`・`attributes`・`provenance`）は Postgres が断る（置き換えない）ので、
 * ここでは触らない。
 *
 * 入力のオブジェクトは書き換えない（新しい値を返す）。`undefined`・`null` はそのまま返す。
 *
 * `String.prototype.toWellFormed` と同じ結果だが、`core` の `runtime.ts` にある同じ正規表現と揃えて、
 * ランタイムの版に依らない書き方にしている。
 */
export function replaceLoneSurrogates(value: string): string;
export function replaceLoneSurrogates(value: string | null): string | null;
export function replaceLoneSurrogates(value: string | undefined): string | undefined;
export function replaceLoneSurrogates(value: string | null | undefined): string | null | undefined;
export function replaceLoneSurrogates(value: string | null | undefined): string | null | undefined {
  if (typeof value !== "string") {
    return value;
  }
  return value.replace(LONE_SURROGATE, "�");
}

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/** `NewMemory` の `text` 列に入る欄（`content`・`digest`・`contentHash`・`tags`・`extractorVersion`・`claimKey`）を置き換えた写し。 */
export function replaceLoneSurrogatesInNewMemory(input: NewMemory): NewMemory {
  const claimKey = replaceLoneSurrogatesInClaimKey(input.claimKey);
  return {
    ...input,
    content: replaceLoneSurrogates(input.content),
    digest: replaceLoneSurrogates(input.digest),
    contentHash: replaceLoneSurrogates(input.contentHash),
    tags: Array.isArray(input.tags)
      ? input.tags.map((tag) => replaceLoneSurrogates(tag))
      : input.tags,
    extractorVersion: replaceLoneSurrogates(input.extractorVersion),
    ...(claimKey === input.claimKey ? {} : { claimKey }),
  };
}

/** `ClaimKey` の `subject`・`predicate` を置き換えた写し（片方だけの鍵・`null`・`undefined` もそのまま扱う）。 */
export function replaceLoneSurrogatesInClaimKey<T extends ClaimKey | null | undefined>(
  claimKey: T,
): T {
  if (claimKey === null || claimKey === undefined) {
    return claimKey;
  }
  return {
    ...claimKey,
    subject: replaceLoneSurrogates(claimKey.subject),
    predicate: replaceLoneSurrogates(claimKey.predicate),
  } as T;
}

/** `NewObservation` の `text` 列に入る欄のうち識別子でないもの（`kind`）を置き換えた写し。 */
export function replaceLoneSurrogatesInNewObservation(input: NewObservation): NewObservation {
  return { ...input, kind: replaceLoneSurrogates(input.kind) };
}
