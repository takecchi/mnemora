import { describe, expect, it, vi } from "vitest";
import type * as PgModule from "pg";
import { createPostgresClient, closePostgresClient, type PostgresClient } from "../client.js";

/**
 * `createPostgresClient` の TSDoc「`schema` を指定したときは、`schema` と `extensionSchema` を、接続オプションへ入れる前に
 * `assertSafeSchemaName` で検査する。通らなければ `Pool` を作らずに `Error` を投げる」の後半（`Pool` を作らない）を縛る。
 * 投げることは `schema-name-guard-bundled-callers.test.ts` が見ている。ここは `Pool` を作った回数だけを見る。
 *
 * ⚠ `vi.mock("pg")` で数えるので、直列の群（`isolate: true`）に置く（vitest.config.mts の `SERIAL_TEST_FILES`）。
 * 並列の群（`isolate: false`）では、同じ worker で先に走ったファイルが `client.ts` を読み込み済みだと
 * モックが当たらず、数が 0 のままになる（否定の歯は空振りで緑、陽性対照だけが赤）。
 */

// `createPostgresClient` が `Pool` を作った回数。本物の `Pool` をそのまま使い、作った数だけを数える。
const poolConstructions = vi.hoisted(() => ({ count: 0 }));
vi.mock("pg", async (importOriginal) => {
  const actual = await importOriginal<typeof PgModule>();
  class CountingPool extends actual.Pool {
    constructor(...args: ConstructorParameters<typeof actual.Pool>) {
      super(...args);
      poolConstructions.count += 1;
    }
  }
  return { ...actual, Pool: CountingPool, default: { ...actual, Pool: CountingPool } };
});

const BAD_EXTENSION_SCHEMA = "Bad x";

async function createOrThrow(config: Parameters<typeof createPostgresClient>[1]): Promise<unknown> {
  let client: PostgresClient | undefined;
  try {
    client = createPostgresClient("postgres://user@127.0.0.1:1/none", config);
    return undefined;
  } catch (e) {
    return e;
  } finally {
    if (client) await closePostgresClient(client);
  }
}

describe("createPostgresClient: 安全でない schema・extensionSchema では、Pool を作らずに断る", () => {
  it("安全でない schema は、Pool を作らずに断る", async () => {
    poolConstructions.count = 0;
    const thrown = await createOrThrow({ schema: "Bad x" });
    expect(thrown).toBeInstanceOf(Error);
    expect(poolConstructions.count).toBe(0);
  });

  it("schema が安全でも、安全でない extensionSchema は、Pool を作らずに断る", async () => {
    poolConstructions.count = 0;
    const thrown = await createOrThrow({
      schema: "some_schema",
      extensionSchema: BAD_EXTENSION_SCHEMA,
    });
    expect(thrown).toBeInstanceOf(Error);
    expect(poolConstructions.count).toBe(0);
  });

  it("陽性対照: 安全な schema・extensionSchema なら Pool を1つ作る", async () => {
    poolConstructions.count = 0;
    const thrown = await createOrThrow({ schema: "some_schema", extensionSchema: "ext_schema" });
    expect(thrown).toBeUndefined();
    expect(poolConstructions.count).toBe(1);
  });
});
