import { afterAll, describe, expect, it } from "vitest";
import type { ClaimKey, Ctx, MemoryStore } from "@mnemora/core";
import { buildNewMemoryEventFixture, buildNewMemoryFixture } from "@mnemora/testkit";
import { InMemoryMemoryStore } from "@mnemora/testkit/fixtures";
import { PostgresMemoryStore } from "../memory-store.js";
import { closeTestClient, getTestClient, resetTestDatabase } from "./test-db.js";

/**
 * `findActiveByClaimKey`・`findContestedByClaimKey` の有効期間の重なりは、半開区間
 * `[validFrom, validUntil)` の重なり（interface の doc）。**空の区間（`validFrom === validUntil`）と逆転した区間
 * （`validFrom > validUntil`）は点を1つも含まない**ので、何とも重ならない——問い合わせ側でも、保存済みの行の側でも。
 *
 * 【実測 2026-10-01】直す前は、`a1 < b2 AND a2 < b1` の式が空・逆転した区間にも当てはまり、**どの `recall()` の
 * 時点でも真にならない記憶（`validAt` ゲートを通らない）が、有効な記憶と「重なる」として矛盾（contested）を作った**
 * （3実装とも同じ。Runtime の `claimKey: { detectContested: true }` で、有効な記憶まで `contested` になった）。
 *
 * 各 `it` は先に陽性対照（普通の区間は重なる・端が接するだけなら重ならない・両端 null は重なる）を見て、
 * 探り棒が生きていることを示してから、空・逆転した区間を当てる。
 */

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

afterAll(async () => {
  await closeTestClient();
});

const ctx: Ctx = { tenantId: "claim-key-empty-interval" };
const d = (iso: string) => new Date(iso);
type Interval = [Date | null, Date | null];

const NORMAL: Interval = [d("2020-01-01T00:00:00.000Z"), d("2030-01-01T00:00:00.000Z")];
const EMPTY: Interval = [d("2025-01-01T00:00:00.000Z"), d("2025-01-01T00:00:00.000Z")];
const INVERTED: Interval = [d("2029-01-01T00:00:00.000Z"), d("2021-01-01T00:00:00.000Z")];
const NULL_NULL: Interval = [null, null];

describe.each(KITS)("claim key の重なりは空・逆転した区間を含まない（%s）", (_name, build) => {
  async function seed(
    store: MemoryStore,
    predicate: string,
    stored: Interval,
    status: "active" | "contested",
  ) {
    const claimKey: ClaimKey = { subject: "user", predicate };
    const row = await store.createMemory(
      ctx,
      buildNewMemoryFixture({
        tenantId: ctx.tenantId,
        contentHash: `row-${predicate}`,
        claimKey,
        validFrom: stored[0],
        validUntil: stored[1],
      }),
    );
    if (status === "contested") {
      const partner = await store.createMemory(
        ctx,
        buildNewMemoryFixture({
          tenantId: ctx.tenantId,
          contentHash: `partner-${predicate}`,
          claimKey,
        }),
      );
      await store.markContestedPair!(
        ctx,
        { id: row.id, event: buildNewMemoryEventFixture({ memoryId: row.id, kind: "updated" }) },
        {
          id: partner.id,
          event: buildNewMemoryEventFixture({ memoryId: partner.id, kind: "updated" }),
        },
      );
    }
    return { id: row.id, claimKey };
  }

  async function find(
    store: MemoryStore,
    status: "active" | "contested",
    claimKey: ClaimKey,
    query: Interval,
  ): Promise<string[]> {
    const finder = status === "active" ? store.findActiveByClaimKey : store.findContestedByClaimKey;
    const rows = await finder!.call(store, ctx, {
      subjectId: null,
      claimKey,
      excludeMemoryId: "00000000-0000-4000-8000-000000000000",
      contentHash: "query-hash",
      validFrom: query[0],
      validUntil: query[1],
    });
    return rows.map((r) => r.id);
  }

  describe.each(["active", "contested"] as const)("%s を探す口", (status) => {
    it("陽性対照: 普通の区間は重なれば返り、端が接するだけなら返らず、両端 null は返る", async () => {
      const store = await build();
      const { id, claimKey } = await seed(store, "control", NORMAL, status);
      expect(await find(store, status, claimKey, NORMAL)).toContain(id);
      expect(await find(store, status, claimKey, NULL_NULL)).toContain(id);
      expect(await find(store, status, claimKey, [d("2025-01-01T00:00:00.000Z"), null])).toContain(
        id,
      );
      expect(await find(store, status, claimKey, [NORMAL[1], null])).not.toContain(id);
      expect(await find(store, status, claimKey, [null, NORMAL[0]])).not.toContain(id);
    });

    it.each([
      ["空の区間", EMPTY],
      ["逆転した区間", INVERTED],
    ] as const)("問い合わせ側が%sなら、何も返らない", async (_label, query) => {
      const store = await build();
      const { id, claimKey } = await seed(store, "query-side", NORMAL, status);
      expect(await find(store, status, claimKey, NORMAL)).toContain(id); // 陽性対照
      expect(await find(store, status, claimKey, query)).toEqual([]);
    });

    it.each([
      ["空の区間", EMPTY],
      ["逆転した区間", INVERTED],
    ] as const)("保存済みの行が%sなら、どの問い合わせにも返らない", async (_label, stored) => {
      const store = await build();
      const { id, claimKey } = await seed(store, "row-side", stored, status);
      // 陽性対照: 同じ claim key の普通の行は、同じ問い合わせで返る。
      const control = await seed(store, "row-side", NORMAL, status);
      for (const query of [
        NULL_NULL,
        NORMAL,
        stored,
        [d("2000-01-01T00:00:00.000Z"), null],
      ] as Interval[]) {
        const found = await find(store, status, claimKey, query);
        expect(found).not.toContain(id);
        if (query !== stored) expect(found).toContain(control.id);
      }
    });
  });
});
