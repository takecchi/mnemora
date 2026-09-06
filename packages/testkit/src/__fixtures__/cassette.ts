import { createHash } from "node:crypto";
import type { EmbeddingSpaceId, PromptSpec } from "@mnemora/core";

/**
 * 記録した実 API の入出力（カセット）の型と、その鍵の導出（ADR 0050）。
 *
 * **これは擬似 provider の置き換えではなく、二層のうちの上の層である。**
 * 配線・契約・適合テストは従来どおり `DeterministicLLMProvider` /
 * `DeterministicEmbeddingProvider`（意味を持たない stub）で走る。カセットを使うのは
 * 北極星の物差しを測る経路（`examples/chat` の `retrieval`）だけである。
 * 理由と、採らなかった案は [ADR 0050](../../../../docs/decisions/0050-recorded-provider-cassette.md)。
 *
 * **鍵は入力そのものの SHA-256 にする。**入力文字列をそのまま JSON のキーにしないのは、
 * 長さが揃わず diff が読みにくくなるためであり、意味は無い。**引ける形を優先して
 * `text` / `prompt` を entry 側に併記する**——鍵だけを見て中身が分からない記録は、
 * 後から人が確かめられない（北極星の問い3の、記録への適用）。
 */

/** カセットの形式版。読み込み時に照合し、違えば読まずに落とす。 */
export const CASSETTE_FORMAT_VERSION = 1;

export interface EmbeddingCassetteEntry {
  /** 鍵の元になった入力。**デバッグのために必ず併記する**（上記の理由）。 */
  text: string;
  vector: number[];
}

export interface LLMCassetteEntry {
  /** 鍵の元になった入力。**デバッグのために必ず併記する**。 */
  prompt: PromptSpec;
  /**
   * 記録した時点の応答。`completeStructured` は再生時にこの値を
   * **呼び出し側の `schema` で必ず検証し直す**（`RecordedLLMProvider` 参照）。
   */
  value: unknown;
}

export interface EmbeddingCassetteSection {
  /**
   * 記録元の埋め込み空間。再生側が要求する空間と食い違ったら落とす
   * （ADR 0050「負債」: モデル版の凍結を、黙って進ませない）。
   */
  space: EmbeddingSpaceId;
  entries: Record<string, EmbeddingCassetteEntry>;
}

export interface LLMCassetteSection {
  /** 記録元のモデル名。空間のような構造を持たないため、名前だけを照合する。 */
  model: string;
  entries: Record<string, LLMCassetteEntry>;
}

export interface Cassette {
  version: number;
  /** 記録した時刻（ISO 8601）。**いつの API の姿かを、記録自身に持たせる。** */
  recordedAt: string;
  embedding: EmbeddingCassetteSection;
  llm: LLMCassetteSection;
}

function sha256Hex(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

/** 埋め込みの鍵。入力テキストだけで決まる（モデル・次元は section 側で照合する）。 */
export function embeddingCassetteKey(text: string): string {
  return sha256Hex(text);
}

/**
 * LLM の鍵。`PromptSpec` を正規化した JSON の SHA-256。
 *
 * **`schema` を鍵に含めない。**スキーマは「何を返してほしいか」であって「何を訊いたか」
 * ではなく、鍵に混ぜるとスキーマの些細な変更で全記録が引けなくなる。代わりに
 * 再生時に `schema` で検証し直すことで、記録とスキーマのずれは**落ちる形**で現れる。
 */
export function llmCassetteKey(prompt: PromptSpec): string {
  const canonical = JSON.stringify({
    system: prompt.system ?? null,
    messages: prompt.messages.map((m) => ({ role: m.role, content: m.content })),
  });
  return sha256Hex(canonical);
}

/**
 * 読み込んだ JSON がカセットの形をしているかを検査する。
 *
 * **zod を使わない**——`packages/testkit` の実行時依存を増やさないため
 * （core の「zod だけ」という制約は testkit には掛かっていないが、
 * テスト用パッケージが依存を増やす理由が無い）。検査する項目は、
 * 「食い違ったまま再生が進むと嘘の結果が出る」ものに限る。
 */
export function assertCassette(value: unknown, source: string): asserts value is Cassette {
  // `throw` を呼び出し側に置く（`fail()` の中で投げる形にすると、TypeScript が
  // その後の行で narrowing できず `possibly undefined` になる）。
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
  if (typeof c.embedding.entries !== "object" || c.embedding.entries === null) {
    throw fail("embedding.entries が無い");
  }
  if (typeof c.llm.model !== "string") {
    throw fail("llm.model が文字列でない");
  }
  if (typeof c.llm.entries !== "object" || c.llm.entries === null) {
    throw fail("llm.entries が無い");
  }

  // **entry 1件ずつの形も見る。**ここを省くと、壊れた entry は再生時に
  // `RecordedEmbeddingProvider` の中で素の `TypeError` になり、「カセットが壊れている」と
  // いう本当の理由が伝わらない。**読んだ時点で、読んだファイルの名前と一緒に落とす。**
  for (const [key, entry] of Object.entries(c.embedding.entries)) {
    const e = entry as Partial<EmbeddingCassetteEntry> | null;
    if (typeof e?.text !== "string" || !Array.isArray(e.vector)) {
      throw fail(`embedding.entries[${key}] が {text, vector} の形をしていない`);
    }
  }
  for (const [key, entry] of Object.entries(c.llm.entries)) {
    const e = entry as Partial<LLMCassetteEntry> | null;
    if (typeof e?.prompt !== "object" || e.prompt === null || !("messages" in e.prompt)) {
      throw fail(`llm.entries[${key}] の prompt が PromptSpec の形をしていない`);
    }
    if (!("value" in (e as object))) {
      throw fail(`llm.entries[${key}] に value が無い`);
    }
  }
}
