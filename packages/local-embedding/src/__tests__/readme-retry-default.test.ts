import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DEFAULT_LOCAL_EMBEDDING_RETRY_ATTEMPTS } from "../local-embedding-provider.js";

/**
 * README が書くリトライ回数の既定が、定数と食い違わない。TSDoc は定数を指すので、定数を変えても
 * 食い違わない。数字を直書きした README だけが取り残される。
 */

const README = readFileSync(fileURLToPath(new URL("../../README.md", import.meta.url)), "utf8");

describe("README のリトライ回数の既定", () => {
  it("本文の「既定 N回」と、例の「既定は N」が、定数と一致する", () => {
    const inProse = README.match(/既定 \*\*(\d+)回\*\*まで試して/);
    const inExample = README.match(/attempts: \d+, \/\/ 既定は(\d+)/);
    expect(inProse).not.toBeNull();
    expect(inExample).not.toBeNull();
    expect(Number(inProse![1])).toBe(DEFAULT_LOCAL_EMBEDDING_RETRY_ATTEMPTS);
    expect(Number(inExample![1])).toBe(DEFAULT_LOCAL_EMBEDDING_RETRY_ATTEMPTS);
  });
});
