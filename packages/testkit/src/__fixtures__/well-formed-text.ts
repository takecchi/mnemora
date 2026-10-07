import type { ClaimKey, NewMemory, NewObservation } from "@mnemora/core";

/**
 * 孤立サロゲートを U+FFFD に置き換える。`@mnemora/postgres` が `text` 列に入る文字列で行う置き換えと同じ規則で、
 * 書き込みでも読み取りの引数でも行う。対象は `text` 列に入る欄だけで、識別子（入口で断る）と `jsonb` 列（Postgres が断る）は触らない。
 * 入力は書き換えず、新しい値を返す。`undefined`・`null` はそのまま返す。
 * `String.prototype.toWellFormed` を使わない: ランタイムの版に依らないよう、core の `runtime.ts` と同じ正規表現にしている。
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

export function replaceLoneSurrogatesInNewObservation(input: NewObservation): NewObservation {
  return { ...input, kind: replaceLoneSurrogates(input.kind) };
}
