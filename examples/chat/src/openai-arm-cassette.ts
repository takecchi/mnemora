import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { EmbeddingSpaceId } from "@mnemora/core";
import type { Cassette, EmbeddingCassetteEntry } from "@mnemora/testkit";
import { CASSETTE_FORMAT_VERSION, assertCassette } from "@mnemora/testkit";

/**
 * 6群を OpenAI 実埋め込みで測るための、埋め込み専用カセット。`cassette-io.ts` の `CassetteTarget` は LLM も embedding も
 * 両方 `openai` で録る前提で、embedding だけを録るこの6群とは前提が違うので別ファイルにする。
 * `llm.entries` は空のままにする（`assertCassette` は空を許し、`llmMode` が常に `"deterministic"` である限り読まれない）。
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

/** `llm` 節に埋める、使われないことを自ら名乗るダミーモデル名。 */
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
        "`pnpm --filter @mnemora/example-chat exec tsx src/scripts/openai-embedding-fp-ceiling.ts` を先に実行すること。",
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
