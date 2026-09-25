import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { EmbeddingSpaceId } from "@mnemora/core";
import type { Cassette, EmbeddingCassetteEntry } from "@mnemora/testkit";
import { CASSETTE_FORMAT_VERSION, assertCassette } from "@mnemora/testkit";

/**
 * Issue #109 後半——識別子/日本語固有名詞/数詞・記号索引の6群を OpenAI 実埋め込みで
 * 測るための、**埋め込み専用カセット**（ADR 0051 の `Cassette` 形式を再利用するが、
 * `llm` 節は使わない——この6群は常に `DeterministicLLMProvider` を使い、
 * `RecordedLLMProvider` を通る経路が無いため）。
 *
 * ⛔ **`examples/chat/src/cassette-io.ts` には1文字も触れていない。**あちらの
 * `CassetteTarget`（`retrieval`/`compare`/`answer`/`answer-time-weighting`）は
 * 「LLM も embedding も両方 `openai` で録る」前提（`CassetteRecorder.toCassette()` が
 * 両節とも非空を要求する）であり、この6群（embedding だけを実 API で録る）とは
 * 前提が違う。別ファイルにすることで、既存の `record`/`verify` サブコマンドの
 * 挙動を1バイトも変えない。
 *
 * `llm.entries` は空オブジェクトのままにする——`assertCassette`（`@mnemora/testkit`）は
 * `llm.entries` を要求するが、**空であることは許す**（`llm.model` が文字列であることと
 * `entries` がオブジェクトであることしか検査しない）。`llmMode` が常に `"deterministic"`
 * である限り、`createProviders` の `buildLLM()` はこの節を一度も読まない。
 */
const here = dirname(fileURLToPath(import.meta.url));

export const IDENTIFIER_OPENAI_CASSETTE_PATH = join(
  here,
  "..",
  "cassettes",
  "identifier-probes.openai.json",
);

export const NUMERAL_TOKEN_OPENAI_CASSETTE_PATH = join(
  here,
  "..",
  "cassettes",
  "numeral-token-probes.openai.json",
);

/** `llm` 節に埋める、常に使われないことを自ら名乗るダミーモデル名。 */
export const UNUSED_LLM_MODEL_MARKER =
  "unused（embedding-only cassette, Issue #109 openai arm。llmMode は常に deterministic）";

export function buildEmbeddingOnlyCassette(
  space: EmbeddingSpaceId,
  entries: Record<string, EmbeddingCassetteEntry>,
  recordedAt: string,
): Cassette {
  return {
    version: CASSETTE_FORMAT_VERSION,
    recordedAt,
    embedding: { space, entries },
    llm: { model: UNUSED_LLM_MODEL_MARKER, entries: {} },
  };
}

export function loadOpenAiArmCassette(path: string): Cassette {
  if (!existsSync(path)) {
    throw new Error(
      `openai arm cassette が無い: ${path}\n` +
        "`OPENAI_API_KEY`/`DATABASE_URL` を設定して " +
        "`tsx examples/chat/src/scripts/openai-embedding-fp-ceiling.ts` を先に実行すること。",
    );
  }
  const raw: unknown = JSON.parse(readFileSync(path, "utf-8"));
  assertCassette(raw, path);
  return raw;
}

export function saveOpenAiArmCassette(cassette: Cassette, path: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(cassette, null, 2)}\n`, "utf-8");
}
