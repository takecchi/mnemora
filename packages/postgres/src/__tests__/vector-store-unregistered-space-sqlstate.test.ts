import { describe, expect, it } from "vitest";
import { isEmbeddingSpaceNotRegisteredError } from "@mnemora/core";
import type { Ctx, EmbeddingSpaceId } from "@mnemora/core";
import type { Db } from "../client.js";
import { embeddingSpaceTableName } from "../embedding-space-table.js";
import { PostgresVectorStore } from "../vector-store.js";

const SPACE: EmbeddingSpaceId = { provider: "test", model: "sqlstate-check", dimensions: 3 };
const ctx: Ctx = { tenantId: "vector-store-unregistered-space-sqlstate" };
const MEMORY_ID = "11111111-1111-4111-8111-111111111111";
const MISSING_TABLE_MESSAGE = `relation "${embeddingSpaceTableName(SPACE)}" does not exist`;

async function deleteFailingWith(failure: Error): Promise<unknown> {
  const db = {
    execute: async () => {
      throw failure;
    },
  } as unknown as Db;
  try {
    await new PostgresVectorStore(db).delete(ctx, SPACE, MEMORY_ID);
  } catch (error) {
    return error;
  }
  throw new Error("resolved, expected a rejection");
}

describe("PostgresVectorStore: 未登録の空間の判定は SQLSTATE 42P01 と空間の表名の両方を要る", () => {
  it("42P01 で、空間の表名を指す例外は EmbeddingSpaceNotRegisteredError になる", async () => {
    const error = await deleteFailingWith(
      Object.assign(new Error(MISSING_TABLE_MESSAGE), { code: "42P01" }),
    );

    expect(isEmbeddingSpaceNotRegisteredError(error)).toBe(true);
  });

  it("文面が空間の表名を指していても、SQLSTATE が 42P01 でなければ包まず、同じ例外がそのまま出る", async () => {
    const failure = Object.assign(new Error(MISSING_TABLE_MESSAGE), { code: "XX000" });

    const error = await deleteFailingWith(failure);

    expect(error).toBe(failure);
  });
});
