/* eslint-disable @typescript-eslint/no-explicit-any -- 3 実装の store を同じ形で突き合わせる試験 */
// やりすぎ側の対照: 小文字にそろえるのは「操作の対象の id（記憶・observation・recall・ジョブ）」だけである。
// tenantId は別物で、`tenant_id` は text 列（大文字小文字を区別する）。fixture の `get` が tenantId の比べにまで
// 大文字小文字の畳みを入れると、`Tenant-X` の記憶が `tenant-x` から見える（テナントの越境）。
import { afterAll, describe, expect, it } from "vitest";
import { InMemoryMemoryStore } from "@mnemora/testkit/fixtures";
import { buildNewMemoryFixture } from "@mnemora/testkit";
import { createFakeRuntimeStores } from "../../../core/src/__tests__/runtime-fakes.js";
import { PostgresMemoryStore } from "../memory-store.js";
import { closeTestClient, getTestClient, resetTestDatabase } from "./test-db.js";

const owner = { tenantId: "Tenant-Case-X" };
const other = { tenantId: "tenant-case-x" };

afterAll(async () => {
  await closeTestClient();
});

const backends: Array<[string, () => Promise<any>]> = [
  [
    "postgres",
    async () => {
      await resetTestDatabase();
      const { db } = await getTestClient();
      return new PostgresMemoryStore(db);
    },
  ],
  ["testkit の fixture", async () => new InMemoryMemoryStore()],
  ["core の Fake", async () => createFakeRuntimeStores().memoryStore],
];

describe.each(backends)(
  "tenantId は大文字小文字を区別する（id の小文字化に巻き込まない）: %s",
  (_n, build) => {
    it("綴りだけ違うテナントからは、get・getMany・updateStatus で見えない", async () => {
      const store = await build();
      const m = await store.createMemory(
        owner,
        buildNewMemoryFixture({ tenantId: owner.tenantId, contentHash: "case-1" }),
      );
      expect(await store.get(owner, m.id)).not.toBeNull();
      expect(await store.get(other, m.id)).toBeNull();
      expect(await store.getMany(other, [m.id])).toEqual([]);
      await expect(store.updateStatus(other, m.id, "forgotten")).rejects.toThrow(/not found/);
      expect((await store.get(owner, m.id))!.status).toBe("active");
    });
  },
);
