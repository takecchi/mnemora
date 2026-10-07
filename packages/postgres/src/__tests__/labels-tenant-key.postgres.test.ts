import { afterAll, describe, expect, it } from "vitest";
import type { Ctx, LabelSummary, MemoryStore } from "@mnemora/core";
import { buildNewMemoryFixture } from "@mnemora/testkit";
import { InMemoryMemoryStore } from "@mnemora/testkit/fixtures";
import { PostgresMemoryStore } from "../memory-store.js";
import { closeTestClient, getTestClient, resetTestDatabase } from "./test-db.js";

/** `tenantId` は呼び出し側が渡す不透明な文字列で、`::` を含んでよい。キーの連結で別テナントのラベルと衝突しないこと。 */

const A: Ctx = { tenantId: "a" };
const AB: Ctx = { tenantId: "a::b" };

const KITS: Array<[string, () => Promise<MemoryStore>]> = [
  ["testkit の InMemory", async () => new InMemoryMemoryStore()],
  [
    "Postgres",
    async () => {
      await resetTestDatabase();
      const { db } = await getTestClient();
      return new PostgresMemoryStore(db);
    },
  ],
];

let seq = 0;
async function createWithTags(store: MemoryStore, ctx: Ctx, tags: string[]): Promise<void> {
  seq += 1;
  await store.createMemory(
    ctx,
    buildNewMemoryFixture({
      tenantId: ctx.tenantId,
      contentHash: `labels-tenant-key-${seq}`,
      content: `labels-tenant-key-${seq}`,
      tags,
    }),
  );
}

function brief(labels: LabelSummary[]): Array<[string, string, number]> {
  return labels.map((label) => [label.name, label.status, label.proposedCount]);
}

afterAll(async () => {
  await closeTestClient();
});

describe("ラベルは `::` を含むテナントでも分かれる", () => {
  for (const [kitName, makeStore] of KITS) {
    describe(kitName, () => {
      it("tags から作られた提案ラベルが、別テナントに混ざらず潰れない", async () => {
        const store = await makeStore();
        await createWithTags(store, AB, ["x"]);
        await createWithTags(store, A, ["b::x"]);

        expect(brief(await store.listLabels!(A))).toEqual([["b::x", "proposed", 1]]);
        expect(brief(await store.listLabels!(AB))).toEqual([["x", "proposed", 1]]);
      });

      it("registerLabel が別テナントのラベルを昇格させない", async () => {
        const store = await makeStore();
        await createWithTags(store, AB, ["x"]);
        await store.registerLabel!(A, "b::x");

        expect(brief(await store.listLabels!(A))).toEqual([["b::x", "registered", 0]]);
        expect(brief(await store.listLabels!(AB))).toEqual([["x", "proposed", 1]]);
      });

      it("前方一致で、テナント `a` の一覧に `a::b` のラベルが出ない", async () => {
        const store = await makeStore();
        await createWithTags(store, AB, ["y"]);

        expect(await store.listLabels!(A)).toEqual([]);
      });

      it("registerLabel は NUL（U+0000）を含む名前を拒み、ラベルを作らない", async () => {
        const store = await makeStore();
        await expect(store.registerLabel!(A, "a\u0000b")).rejects.toThrow();
        expect(await store.listLabels!(A)).toEqual([]);
      });
    });
  }
});
