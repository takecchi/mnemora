import { afterAll, describe, expect, it } from "vitest";
import type { Ctx, MemoryStore, NewMemory } from "@mnemora/core";
import { buildNewMemoryFixture } from "@mnemora/testkit";
import { InMemoryMemoryStore } from "@mnemora/testkit/fixtures";
import { PostgresMemoryStore } from "../memory-store.js";
import { closeTestClient, getTestClient, resetTestDatabase } from "./test-db.js";

/**
 * `@mnemora/postgres` の2つの食い違いを直した歯（TSDoc と testkit の fixture に揃える）。
 *
 * - `findActiveByClaimKey`: `excludeMemoryId` を入口で小文字にそろえる（`normalizeUuidCase`、#1327 と同じ）。
 *   以前は JS の `!==` で比べていたので、大文字の UUID を渡すと自分自身が返っていた。
 * - `aggregateScope` の `axis: 'taxonomy'`: 1件の Memory は、1つのラベル群に1回だけ数える
 *   （`GroupCount.count` は「この群に入るスコープ内の Memory の件数」）。以前は `unnest(tags)` をそのまま
 *   数えていたので、`tags` に同じ名前が重なる Memory を2件と数えていた。fixture は `Set` で1回に数える。
 *
 * どちらにも、やりすぎを捕まえる歯を付けている（小文字の exclude は今どおり・他の行は除かない、
 * 重複の無い `tags` では件数が変わらない）。
 */

const ctx: Ctx = { tenantId: "claim-key-exclude-and-taxonomy-distinct" };
let seq = 0;

function memory(overrides: Partial<NewMemory> = {}): NewMemory {
  seq += 1;
  return buildNewMemoryFixture({
    tenantId: ctx.tenantId,
    contentHash: `exclude-distinct-${seq}`,
    ...overrides,
  });
}

async function postgresStore(): Promise<PostgresMemoryStore> {
  await resetTestDatabase();
  const { db } = await getTestClient();
  return new PostgresMemoryStore(db);
}

const KITS: Array<[string, () => Promise<MemoryStore>]> = [
  ["testkit の InMemory", async () => new InMemoryMemoryStore()],
  ["Postgres", postgresStore],
];

afterAll(async () => {
  await closeTestClient();
});

describe("PostgresMemoryStore.findActiveByClaimKey: excludeMemoryId は入口で小文字にそろえる", () => {
  const claimKey = { subject: "user", predicate: "address" };

  async function selfAndOther(store: MemoryStore) {
    const self = await store.createMemory(ctx, memory({ subjectId: "u1", claimKey }));
    const other = await store.createMemory(ctx, memory({ subjectId: "u1", claimKey }));
    const find = (excludeMemoryId: string) =>
      store.findActiveByClaimKey!(ctx, {
        subjectId: "u1",
        claimKey,
        excludeMemoryId,
        // 自分とも相手とも違う contentHash にする——同じ contentHash の行はそれだけで返らないので、
        // excludeMemoryId が効いているかを測れなくなる。
        contentHash: "the-new-claim",
        validFrom: null,
        validUntil: null,
      });
    return { self, other, find };
  }

  it("大文字の UUID で渡しても自分自身を返さない", async () => {
    const store = await postgresStore();
    const { self, other, find } = await selfAndOther(store);

    const ids = (await find(self.id.toUpperCase())).map((m) => m.id);

    expect(ids).toEqual([other.id]);
  });

  it("やりすぎない: 小文字の id は今どおり自分だけを除き、相手は返す", async () => {
    const store = await postgresStore();
    const { self, other, find } = await selfAndOther(store);

    expect((await find(self.id)).map((m) => m.id)).toEqual([other.id]);
  });
});

describe("aggregateScope の axis: 'taxonomy': 1件の Memory は1つのラベル群に1回だけ数える", () => {
  for (const [kitName, makeStore] of KITS) {
    it(`${kitName}: tags に同じ名前が重なる Memory も1件と数える`, async () => {
      const store = await makeStore();
      await store.createMemory(ctx, memory({ tags: ["alpha", "alpha"] }));
      await store.createMemory(ctx, memory({ tags: ["alpha", "beta", "beta"] }));
      await store.createMemory(ctx, memory({ tags: [] }));

      const aggregate = await store.aggregateScope(ctx, {
        taxonomyGroupCandidates: ["alpha", "beta", "gamma"],
      });

      expect(taxonomyGroups(aggregate.groups)).toEqual([
        ["alpha", 2],
        ["beta", 1],
        [null, 1],
      ]);
    });

    it(`${kitName}: 同じ名前が離れた位置に重なっても（3回・間に別の名前）1件と数える`, async () => {
      const store = await makeStore();
      await store.createMemory(ctx, memory({ tags: ["alpha", "beta", "alpha"] }));
      await store.createMemory(
        ctx,
        memory({ tags: ["beta", "alpha", "beta", "other", "alpha", "alpha"] }),
      );

      const aggregate = await store.aggregateScope(ctx, {
        taxonomyGroupCandidates: ["alpha", "beta"],
      });

      expect(taxonomyGroups(aggregate.groups)).toEqual([
        ["alpha", 2],
        ["beta", 2],
      ]);
    });

    it(`${kitName}: やりすぎない: 大文字小文字だけ違う名前は別のラベルで、どちらの群にも1回ずつ数える`, async () => {
      const store = await makeStore();
      await store.createMemory(ctx, memory({ tags: ["Alpha", "alpha"] }));
      await store.createMemory(ctx, memory({ tags: ["alpha", "Alpha", "alpha"] }));

      const aggregate = await store.aggregateScope(ctx, {
        taxonomyGroupCandidates: ["Alpha", "alpha"],
      });

      expect(taxonomyGroups(aggregate.groups)).toEqual([
        ["Alpha", 2],
        ["alpha", 2],
      ]);
    });

    it(`${kitName}: やりすぎない: 重複の無い tags では件数は今どおり（labels で絞った内側も同じ）`, async () => {
      const store = await makeStore();
      await store.createMemory(ctx, memory({ tags: ["alpha"] }));
      await store.createMemory(ctx, memory({ tags: ["alpha", "beta"] }));
      await store.createMemory(ctx, memory({ tags: ["beta"] }));
      await store.createMemory(ctx, memory({ tags: ["other"] }));

      const all = await store.aggregateScope(ctx, {
        taxonomyGroupCandidates: ["alpha", "beta"],
      });
      const filtered = await store.aggregateScope(ctx, {
        labels: ["alpha"],
        taxonomyGroupCandidates: ["alpha", "beta"],
      });

      expect({
        all: taxonomyGroups(all.groups),
        filtered: taxonomyGroups(filtered.groups),
      }).toEqual({
        all: [
          ["alpha", 2],
          ["beta", 2],
          [null, 1],
        ],
        filtered: [
          ["alpha", 2],
          ["beta", 1],
        ],
      });
    });
  }
});

function taxonomyGroups(
  groups: Array<{ axis: string; key: string | null; count: number }>,
): Array<[string | null, number]> {
  return groups
    .filter((g) => g.axis === "taxonomy")
    .map((g): [string | null, number] => [g.key, g.count])
    .sort((a, b) => (a[0] === null ? 1 : b[0] === null ? -1 : a[0] < b[0] ? -1 : 1));
}
