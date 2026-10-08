import { afterAll, describe, expect, it } from "vitest";
import type { Ctx, MemoryId, MemoryStore, NewMemoryEvent } from "@mnemora/core";
import { buildNewMemoryFixture } from "@mnemora/testkit";
import { InMemoryMemoryStore } from "@mnemora/testkit/fixtures";
import { PostgresMemoryStore } from "../memory-store.js";
import { closeTestClient, getTestClient, resetTestDatabase } from "./test-db.js";

/**
 * purge されていない forgotten の行に、`supersedeWithNewMemories` を `expectedStatus: "forgotten"` で当てると通る。
 * 2実装（testkit の InMemory と Postgres）に同じ入力を流す。
 *
 * 出所: `packages/core/src/interfaces/memory-store.ts` の `expectedStatus` の TSDoc（`expectedStatus` の CAS は status が
 * 一致するときだけ更新する。ADR 0499・0549 で弾くのは purge 済みの行だけ）。`supersede[].expectedStatus` も同じ。
 *
 * - 対象は `superseded` に入り、`conflicted` は空。読み直すと `status: "superseded"` で、`supersededById` は新しい記憶の id。
 * - 対照: purge 済みの行は同じ入力で `conflicted` に入る（`cas-purged-row.postgres.test.ts`）。
 *
 * 既存の `cas-purged-row.postgres.test.ts` は purge 済みの弾きと `updateStatus` 側の通りだけを縛り、
 * この口の「purge されていない forgotten が通る」側は縛っていなかった（Issue #1939）。
 */

const A: Ctx = { tenantId: "supersede-non-purged-forgotten-a" };
let counter = 0;

afterAll(async () => {
  await closeTestClient();
});

function newMemory(overrides: Parameters<typeof buildNewMemoryFixture>[0] = {}) {
  counter += 1;
  return buildNewMemoryFixture({
    tenantId: A.tenantId,
    content: `本文 ${counter}`,
    digest: `要旨 ${counter}`,
    contentHash: `supersede-non-purged-forgotten-${counter}`,
    ...overrides,
  });
}

function ev(memoryId: MemoryId): NewMemoryEvent {
  return {
    tenantId: A.tenantId,
    memoryId,
    kind: "updated",
    actor: { type: "system" },
    meta: { probe: true },
  };
}

interface Kit {
  store: MemoryStore;
}

async function postgresKit(): Promise<Kit> {
  await resetTestDatabase();
  const { db } = await getTestClient();
  return { store: new PostgresMemoryStore(db) };
}

async function inMemoryKit(): Promise<Kit> {
  return { store: new InMemoryMemoryStore() };
}

const KITS: Array<[string, () => Promise<Kit>]> = [
  ["testkit の InMemory", inMemoryKit],
  ["Postgres", postgresKit],
];

for (const [kitName, makeKit] of KITS) {
  describe(`${kitName}: supersedeWithNewMemories の expectedStatus 'forgotten' は purge されていない行に通る`, () => {
    it("purge されていない forgotten の対象は superseded に入り、conflicted は空。読み直すと superseded で supersededById は新しい記憶", async () => {
      const { store } = await makeKit();
      const target = await store.createMemory(A, newMemory({ status: "forgotten" }));
      expect(target.status).toBe("forgotten");
      expect(target.purgedAt ?? null).toBeNull();

      const result = await store.supersedeWithNewMemories!(
        A,
        [{ input: newMemory(), jobKinds: [] }],
        [
          {
            id: target.id,
            supersededByIndex: 0,
            expectedStatus: "forgotten",
            event: ev(target.id),
          },
        ],
      );

      expect(result.conflicted).toEqual([]);
      expect(result.superseded).toHaveLength(1);
      expect(result.created).toHaveLength(1);
      const newId = result.created[0]!.memory.id;
      const after = await store.get(A, target.id);
      expect(after?.status).toBe("superseded");
      expect(after?.supersededById).toBe(newId);
    });

    it("abortIfAllConflicted: true でも、purge されていない forgotten の対象は衝突として数えない（SourceMemoryStatusChangedError にならず、superseded に入る）", async () => {
      const { store } = await makeKit();
      const target = await store.createMemory(A, newMemory({ status: "forgotten" }));

      const result = await store.supersedeWithNewMemories!(
        A,
        [{ input: newMemory(), jobKinds: [] }],
        [
          {
            id: target.id,
            supersededByIndex: 0,
            expectedStatus: "forgotten",
            event: ev(target.id),
          },
        ],
        { abortIfAllConflicted: true },
      );

      expect(result.conflicted).toEqual([]);
      expect(result.superseded).toHaveLength(1);
      expect((await store.get(A, target.id))?.status).toBe("superseded");
    });

    it("対照: 同じ入力でも、expectedStatus が行の status と違えば conflicted に入る（一致するときだけ更新する）", async () => {
      const { store } = await makeKit();
      const target = await store.createMemory(A, newMemory({ status: "forgotten" }));

      const result = await store.supersedeWithNewMemories!(
        A,
        [{ input: newMemory(), jobKinds: [] }],
        [{ id: target.id, supersededByIndex: 0, expectedStatus: "active", event: ev(target.id) }],
      );

      expect(result.conflicted).toEqual([{ id: target.id, observedStatus: "forgotten" }]);
      expect(result.superseded).toHaveLength(0);
      const after = await store.get(A, target.id);
      expect(after?.status).toBe("forgotten");
      expect(after?.supersededById ?? null).toBeNull();
    });
  });
}
