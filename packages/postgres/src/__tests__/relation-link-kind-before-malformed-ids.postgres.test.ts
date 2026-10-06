// Issue #1734（2026-09-30 マージ分の確かめ直し）の歯。PR #1517 の変異試験で、
// 「Postgres の `link` が、kind の検査を端の uuid の形の検査の後ろに置く」変異がすり抜けた。担当はクローン（miku）の
// 判断で進めている作業であり、オーナーの判断ではない。
//
// `RelationStore.link` の TSDoc: 範囲外の kind は、両端の検査・DB への書き込みより前に
// `unknown relation kind` で断る。`relation-link-kind-before-endpoints.postgres.test.ts` は、uuid の形をした
// 存在しない id でしか試さない。uuid の形でない id（`memory not found for tenant` で断られる側）と範囲外の
// kind を**同時に**渡す入力が無く、検査の順が入れ替わっても、どちらも例外になるので気づけなかった
// （違うのは例外の message だけ）。
import { afterAll, describe, expect, it } from "vitest";
import type { Ctx, MemoryId, MemoryStore, RelationKind, RelationStore } from "@mnemora/core";
import { InMemoryMemoryStore, InMemoryRelationStore } from "@mnemora/testkit/fixtures";
import { PostgresMemoryStore } from "../memory-store.js";
import { PostgresRelationStore } from "../relation-store.js";
import { closeTestClient, getTestClient, resetTestDatabase } from "./test-db.js";

const ctx: Ctx = { tenantId: "relation-link-kind-before-malformed-ids" };
const malformed = "not-a-uuid" as MemoryId;
const ghost = "00000000-0000-4000-8000-000000000001" as MemoryId;

interface Kit {
  memoryStore: MemoryStore;
  relationStore: RelationStore;
}

const kits: Array<[string, () => Promise<Kit>]> = [
  [
    "postgres",
    async () => {
      await resetTestDatabase();
      const { db } = await getTestClient();
      return {
        memoryStore: new PostgresMemoryStore(db),
        relationStore: new PostgresRelationStore(db),
      };
    },
  ],
  [
    "testkit の fixture",
    async () => {
      const memoryStore = new InMemoryMemoryStore();
      return { memoryStore, relationStore: new InMemoryRelationStore(memoryStore) };
    },
  ],
];

afterAll(async () => {
  await closeTestClient();
});

describe.each(kits)(
  "link: 範囲外の kind は、uuid の形でない端の検査より前に断る: %s",
  (_name, build) => {
    it.each([
      ["from が uuid の形でない", malformed, ghost],
      ["to が uuid の形でない", ghost, malformed],
      ["両端とも uuid の形でない", malformed, malformed],
    ])("%s: 範囲外の kind は unknown relation kind", async (_label, fromId, toId) => {
      const kit = await build();
      await expect(
        kit.relationStore.link(ctx, "bogus" as unknown as RelationKind, fromId, toId),
      ).rejects.toThrow(/unknown relation kind/);
    });

    it.each([
      ["from が uuid の形でない", malformed, ghost],
      ["to が uuid の形でない", ghost, malformed],
    ])(
      "陽性対照（%s）: 正しい kind なら、端の記憶が無いことで断る",
      async (_label, fromId, toId) => {
        const kit = await build();
        await expect(kit.relationStore.link(ctx, "contradicts", fromId, toId)).rejects.toThrow(
          /memory not found for tenant/,
        );
      },
    );
  },
);
