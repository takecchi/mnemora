/* eslint-disable @typescript-eslint/no-explicit-any -- 3 実装の store を同じ形で突き合わせる試験 */
// やりすぎ側の対照: 小文字にそろえるのは「操作の対象の id（記憶・observation・recall・ジョブ）」だけである。
// tenantId は別物で、`tenant_id` は text 列（大文字小文字を区別する）。fixture の `get` が tenantId の比べにまで
// 大文字小文字の畳みを入れると、`Tenant-X` の記憶が `tenant-x` から見える（テナントの越境）。
import { afterAll, describe, expect, it } from "vitest";
import { InMemoryMemoryStore } from "@mnemora/testkit/fixtures";
import { buildNewMemoryFixture } from "@mnemora/testkit";
import { createFakeRuntimeStores } from "../../../core/src/__tests__/runtime-fakes.js";
import { PostgresMemoryStore } from "../memory-store.js";
import { PostgresRelationStore } from "../relation-store.js";
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

// `Ctx` の doc: 識別子は正規化せず、完全一致で比べる。`memory_relations` を読み書きする4つの口は、それぞれ自分の SQL で
// `tenant_id` を比べるので、口ごとに綴り違いのテナントから呼ぶ（Postgres の実装を縛る。適合テストには足していない）。
describe("PostgresRelationStore も tenantId の大文字小文字を区別する", () => {
  async function linkedPair() {
    await resetTestDatabase();
    const { db } = await getTestClient();
    const memories = new PostgresMemoryStore(db);
    const relations = new PostgresRelationStore(db);
    const [a, b] = await Promise.all(
      ["case-rel-a", "case-rel-b"].map(
        async (contentHash) =>
          (
            await memories.createMemory(
              owner,
              buildNewMemoryFixture({ tenantId: owner.tenantId, contentHash }),
            )
          ).id,
      ),
    );
    await relations.link(owner, "contradicts", a!, b!);
    return { relations, a: a!, b: b! };
  }

  it("link: 綴りだけ違うテナントの記憶を端に取ると、memory not found で断る", async () => {
    const { relations, a, b } = await linkedPair();
    await expect(relations.link(other, "contradicts", b, a)).rejects.toThrow(
      /memory not found for tenant/,
    );
    expect(await relations.listRelated(owner, b)).toEqual([]);
  });

  it("listRelated・listRelatedMany: 綴りだけ違うテナントからは関係が見えない（kind の有無とも）", async () => {
    const { relations, a, b } = await linkedPair();
    expect(await relations.listRelated(other, a)).toEqual([]);
    expect(await relations.listRelated(other, a, "contradicts")).toEqual([]);
    expect(await relations.listRelatedMany(other, [a])).toEqual([[]]);
    expect(await relations.listRelatedMany(other, [a], "contradicts")).toEqual([[]]);
    // 陽性対照: 同じ綴りなら見える。
    expect((await relations.listRelated(owner, a)).map((r) => r.memoryId)).toEqual([b]);
    expect((await relations.listRelatedMany(owner, [a]))[0]!.map((r) => r.memoryId)).toEqual([b]);
  });

  it("unlink: 綴りだけ違うテナントからは、同じ組を指定しても行を消さない", async () => {
    const { relations, a, b } = await linkedPair();
    await relations.unlink(other, "contradicts", a, b);
    expect((await relations.listRelated(owner, a)).map((r) => r.memoryId)).toEqual([b]);
  });
});
