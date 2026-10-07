import { createHash } from "node:crypto";
import type { EmbeddingSpaceId, PromptSpec } from "@mnemora/core";

/*
 * カセットは擬似 provider の置き換えではなく別の層（ADR 0051）。カセットを使うのは、実キー無しで retrieval を測る経路だけ。
 * 鍵は入力の SHA-256 で、長さを揃えて diff を読みやすくするため。鍵だけでは中身が分からないので、`text` / `prompt` を entry に併記する。
 */

/** カセットの形式版。読み込み時に照合し、違えば読まずに落とす。 */
export const CASSETTE_FORMAT_VERSION = 1;

/** 埋め込みのカセットの1件（入力と、記録したベクトル）。 */
export interface EmbeddingCassetteEntry {
  /** 鍵の元になった入力。デバッグのために必ず併記する。 */
  text: string;
  /** 記録した時点に実 API が返したベクトル。 */
  vector: number[];
}

/** LLM のカセットの1件（入力のプロンプトと、記録した応答）。 */
export interface LLMCassetteEntry {
  /** 鍵の元になった入力。 */
  prompt: PromptSpec;
  /** 記録した時点の応答。`completeStructured` は再生時に呼び出し側の `schema` で検証し直す。 */
  value: unknown;
}

/** カセットの埋め込みの節。 */
export interface EmbeddingCassetteSection {
  /** 記録元の埋め込み空間。再生側が要求する空間と食い違ったら落とす。 */
  space: EmbeddingSpaceId;
  /** 鍵（{@link embeddingCassetteKey}）ごとの記録。 */
  entries: Record<string, EmbeddingCassetteEntry>;
}

/** カセットの LLM の節。 */
export interface LLMCassetteSection {
  /** 記録元のモデル名。空間のような構造を持たないため、名前だけを照合する。 */
  model: string;
  /** 鍵（{@link llmCassetteKey}）ごとの記録。 */
  entries: Record<string, LLMCassetteEntry>;
}

/** 1回の記録セッションのカセット全体（埋め込みと LLM の両方を1つに持つ）。 */
export interface Cassette {
  /** 形式版。{@link CASSETTE_FORMAT_VERSION} と違えば読まずに落とす。 */
  version: number;
  /** 記録した時刻（ISO 8601）。 */
  recordedAt: string;
  /** 埋め込みの記録。 */
  embedding: EmbeddingCassetteSection;
  /** LLM の記録。 */
  llm: LLMCassetteSection;
}

function sha256Hex(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

/** 埋め込みの鍵。入力テキストだけで決まる（モデル・次元は section 側で照合する）。 */
export function embeddingCassetteKey(text: string): string {
  return sha256Hex(text);
}

/** LLM の鍵。`PromptSpec` を正規化した JSON の SHA-256。`schema` を鍵に含めない: 含めるとスキーマの些細な変更で全記録が引けなくなる。代わりに再生時に検証し直す。 */
export function llmCassetteKey(prompt: PromptSpec): string {
  const canonical = JSON.stringify({
    system: prompt.system ?? null,
    messages: prompt.messages.map((m) => ({ role: m.role, content: m.content })),
  });
  return sha256Hex(canonical);
}

/** 読み込んだ JSON がカセットの形をしているかを検査する。zod は使わない（testkit の実行時依存を増やさないため）。 */
export function assertCassette(value: unknown, source: string): asserts value is Cassette {
  // `throw` は呼び出し側に置く: `fail()` の中で投げると、TypeScript が後続の行で narrowing できない。
  const fail = (reason: string): Error =>
    new Error(`カセットとして読めない（${source}）: ${reason}`);

  if (typeof value !== "object" || value === null) {
    throw fail("オブジェクトではない");
  }
  const c = value as Partial<Cassette>;

  if (c.version !== CASSETTE_FORMAT_VERSION) {
    throw fail(
      `形式版が違う（期待 ${CASSETTE_FORMAT_VERSION} / 実際 ${String(c.version)}）。` +
        "記録し直すこと。",
    );
  }
  if (typeof c.recordedAt !== "string") {
    throw fail("recordedAt が文字列でない");
  }
  if (typeof c.embedding !== "object" || c.embedding === null) {
    throw fail("embedding 節が無い");
  }
  if (typeof c.llm !== "object" || c.llm === null) {
    throw fail("llm 節が無い");
  }

  const space = c.embedding.space as Partial<EmbeddingSpaceId> | undefined;
  if (
    typeof space?.provider !== "string" ||
    typeof space.model !== "string" ||
    typeof space.dimensions !== "number"
  ) {
    throw fail("embedding.space が EmbeddingSpaceId の形をしていない");
  }
  if (!Number.isInteger(space.dimensions) || space.dimensions <= 0) {
    throw fail(`embedding.space.dimensions が正の整数でない（${String(space.dimensions)}）`);
  }
  if (typeof c.embedding.entries !== "object" || c.embedding.entries === null) {
    throw fail("embedding.entries が無い");
  }
  if (typeof c.llm.model !== "string") {
    throw fail("llm.model が文字列でない");
  }
  if (typeof c.llm.entries !== "object" || c.llm.entries === null) {
    throw fail("llm.entries が無い");
  }

  // entry 1件ずつの形も見る: 省くと、壊れた entry は再生時に素の `TypeError` になり、カセットが壊れている理由が伝わらない。
  for (const [key, entry] of Object.entries(c.embedding.entries)) {
    const e = entry as Partial<EmbeddingCassetteEntry> | null;
    if (typeof e?.text !== "string" || !Array.isArray(e.vector)) {
      throw fail(`embedding.entries[${key}] が {text, vector} の形をしていない`);
    }
    if (embeddingCassetteKey(e.text) !== key) {
      throw fail(`embedding.entries[${key}] の鍵が text の SHA-256 と一致しない`);
    }
    // JSON は `NaN`/`Infinity` を `null` にするので、壊れたカセットはここで落ちる。
    const bad = e.vector.findIndex((x) => typeof x !== "number" || !Number.isFinite(x));
    if (bad !== -1) {
      throw fail(
        `embedding.entries[${key}].vector の ${bad} 番目が有限の数でない（${String(e.vector[bad])}）`,
      );
    }
  }
  for (const [key, entry] of Object.entries(c.llm.entries)) {
    const e = entry as Partial<LLMCassetteEntry> | null;
    if (typeof e?.prompt !== "object" || e.prompt === null || !("messages" in e.prompt)) {
      throw fail(`llm.entries[${key}] の prompt が PromptSpec の形をしていない`);
    }
    if (
      !Array.isArray((e.prompt as PromptSpec).messages) ||
      llmCassetteKey(e.prompt as PromptSpec) !== key
    ) {
      throw fail(`llm.entries[${key}] の鍵が prompt から導いた値と一致しない`);
    }
    if (!("value" in (e as object))) {
      throw fail(`llm.entries[${key}] に value が無い`);
    }
  }
}
