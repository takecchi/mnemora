import { afterAll, describe, expect, it } from "vitest";
import type { Ctx } from "@mnemora/core";
import { buildNewMemoryFixture } from "@mnemora/testkit";
import { PostgresMemoryStore } from "../memory-store.js";
import { closeTestClient, getTestClient, resetTestDatabase } from "./test-db.js";

/**
 * `supersedeWithNewMemories` の supersede 対象が**別テナントの active な Memory**で、
 * `expectedStatus: "active"` を付けたとき、「対象が無い」例外で失敗し、`conflicted` に積まない。
 *
 * `expectedStatus` 付きは 0 行のあと `SELECT status` で「無い」と「CAS 競合」を見分ける経路を通る。
 * その SELECT から `tenant_id` を外すと、別テナントの行が見えて `conflicted`（他テナントの
 * status が `observedStatus` に載る）になり、他テナントの status が漏れる。
 */

afterAll(async () => {
  await closeTestClient();
});

describe("PostgresMemoryStore.supersedeWithNewMemories — 別テナントの active な行を expectedStatus 付きで渡す", () => {
  it("conflicted に積まず「対象が無い」例外で失敗し、news はロールバックされ、持ち主の行は無傷", async () => {
    await resetTestDatabase();
    const { db } = await getTestClient();
    const store = new PostgresMemoryStore(db);
    const ctxA: Ctx = { tenantId: "tenant-a" };
    const ctxB: Ctx = { tenantId: "tenant-b" };
    const oldA = await store.createMemory(
      ctxA,
      buildNewMemoryFixture({ tenantId: ctxA.tenantId, contentHash: "xt-expected-old-a" }),
    );
    const observation = await store.createObservation(ctxB, {
      tenantId: ctxB.tenantId,
      subjectId: null,
      externalId: null,
      kind: "utterance",
      payload: { text: "fixture" },
      occurredAt: null,
    });
    const newsInput = buildNewMemoryFixture({
      tenantId: ctxB.tenantId,
      sourceObservationId: observation.id,
      extractorVersion: "xt-expected-v1",
      contentHash: "xt-expected-new-b",
    });

    await expect(
      store.supersedeWithNewMemories(
        ctxB,
        [{ input: newsInput, jobKinds: [] }],
        [
          {
            id: oldA.id,
            supersededByIndex: 0,
            expectedStatus: "active",
            event: {
              tenantId: ctxB.tenantId,
              memoryId: oldA.id,
              kind: "superseded",
              actor: { type: "system" },
              digestSnapshot: oldA.digest,
              sizeBeforeBytes: null,
              meta: {},
            },
          },
        ],
      ),
    ).rejects.toThrow(/memory not found for tenant/);

    const unchanged = await store.get(ctxA, oldA.id);
    expect(unchanged?.status).toBe("active");
    expect(unchanged?.supersededById ?? null).toBeNull();
    // news もロールバックされている（同じ冪等キーで作り直すと新規作成になる）。
    const { created } = await store.createMemoryWithOutbox(ctxB, newsInput, []);
    expect(created).toBe(true);
  });
});
