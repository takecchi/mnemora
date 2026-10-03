import { afterAll, describe, expect, it } from "vitest";
import type { EmbeddingSpaceId } from "@mnemora/core";
import { registerEmbeddingSpace } from "../vector-space.js";
import { closeTestClient, getTestClient } from "./test-db.js";

/**
 * ADR 0596（ADR 0571 の C3・C4）: `registerEmbeddingSpace` の TSDoc は、「`schema`・`extensionSchema` が
 * `assertSafeSchemaName` を通らなければ（`extensionSchema` は `schema` を指定したときだけ検査する）、通常の `Error`」と約束している。
 * これは SQL に識別子を埋め込む前の安全門で、どのテストも縛っていなかった。
 *
 * 見るのは「`assertSafeSchemaName` の message で投げる」こと。門が無いと、`"bad;name"` は二重引用符で囲まれて SQL に入り、
 * 「スキーマが無い」という DB の別の例外になる（message が違う）ので、この it が落ちる。
 */

const SPACE: EmbeddingSpaceId = {
  provider: "unsafe-schema-teeth",
  model: "fixture-model",
  dimensions: 3,
};
const BAD = "bad;name";

afterAll(async () => {
  await closeTestClient();
});

async function thrownOf(run: () => Promise<unknown>): Promise<unknown> {
  let thrown: unknown;
  await run().catch((e: unknown) => {
    thrown = e;
  });
  return thrown;
}

describe("registerEmbeddingSpace: schema・extensionSchema が安全でなければ通常の Error（ADR 0571 の C3・C4）", () => {
  it("C3: 安全でない schema は、assertSafeSchemaName の Error で断る", async () => {
    const { pool } = await getTestClient();
    const thrown = await thrownOf(() => registerEmbeddingSpace(pool, SPACE, { schema: BAD }));
    expect(thrown).toBeInstanceOf(Error);
    expect(thrown).not.toBeInstanceOf(RangeError);
    expect(thrown).not.toBeInstanceOf(TypeError);
    expect((thrown as Error).message).toMatch(/^unsafe SQL identifier: bad;name /);
  });

  it("C4: schema が安全でも、安全でない extensionSchema は、assertSafeSchemaName の Error で断る", async () => {
    const { pool } = await getTestClient();
    const thrown = await thrownOf(() =>
      registerEmbeddingSpace(pool, SPACE, { schema: "public", extensionSchema: BAD }),
    );
    expect(thrown).toBeInstanceOf(Error);
    expect(thrown).not.toBeInstanceOf(RangeError);
    expect(thrown).not.toBeInstanceOf(TypeError);
    expect((thrown as Error).message).toMatch(/^unsafe SQL identifier: bad;name /);
  });

  it("C4 の陽性対照: schema を指定しないときは extensionSchema を検査しない（TSDoc の括弧書き）", async () => {
    const { pool } = await getTestClient();
    const thrown = await thrownOf(() =>
      registerEmbeddingSpace(pool, SPACE, { extensionSchema: BAD }),
    );
    expect(thrown).toBeUndefined();
  });
});
