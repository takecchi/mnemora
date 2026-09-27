// `MemoryStore`/`OutboxStore` の interface の TSDoc が例外の種類まで約束する (口, クラス) の13組について、
// 公開の fixture（`InMemoryMemoryStore`/`InMemoryOutboxStore`）が約束のクラスを投げ、約束の欄
// （`method`・`memoryId`・`expectedStatus`・`observedStatus`・`observedPurgedAt`・`jobId`・
// `expectedAttempts`・`observedAttempts`）に正しい値を詰めることを縛る。適合テスト（conformance suite）の
// 多くはクラスまでしか見ておらず、`resolveOrphanedContested` は適合テストに歯が無い。
// ここは `packages/testkit` 内だけで完結する歯で、`*-conformance.ts`（外部の adapter も走らせる公開面）には
// 足さない（#809）。Postgres と並べて同じ欄を比べる歯は
// `packages/postgres/src/__tests__/store-boundary-diff.postgres.test.ts` の `TYPED_THROWS`。

import { describe, expect, it } from "vitest";
import type { Ctx, MemoryId, NewMemoryEvent } from "@mnemora/core";
import {
  ContestedWithoutCompanionError,
  MemoryPurgeConflictError,
  MemoryStatusConflictError,
  OutboxLeaseConflictError,
} from "@mnemora/core";
import { InMemoryMemoryStore } from "../__fixtures__/in-memory-memory-store.js";
import { InMemoryOutboxStore } from "../__fixtures__/in-memory-outbox-store.js";
import { buildNewMemoryFixture } from "../test-data.js";

const ctx: Ctx = { tenantId: "tenant-1" };

function event(memoryId: MemoryId, kind: NewMemoryEvent["kind"] = "updated"): NewMemoryEvent {
  return { tenantId: ctx.tenantId, memoryId, kind, actor: { type: "system" }, meta: {} };
}

/** 投げたものを返す（投げなければ落とす）。 */
async function caught(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
  } catch (error) {
    return error;
  }
  throw new Error("投げなかった");
}

async function setup() {
  const store = new InMemoryMemoryStore();
  const a = await store.createMemory(ctx, buildNewMemoryFixture({ contentHash: "a" }));
  const b = await store.createMemory(ctx, buildNewMemoryFixture({ contentHash: "b" }));
  return { store, a, b };
}

const contestedNew = (contentHash: string) =>
  buildNewMemoryFixture({ contentHash, status: "contested" });

describe("ContestedWithoutCompanionError: method と memoryId", () => {
  it("updateStatus は method='updateStatus'、memoryId に対象の id", async () => {
    const { store, a } = await setup();
    const error = await caught(() => store.updateStatus(ctx, a.id, "contested"));
    expect(error).toBeInstanceOf(ContestedWithoutCompanionError);
    expect(error).toMatchObject({ method: "updateStatus", memoryId: a.id });
  });

  it("updateStatusWithEvent は method='updateStatusWithEvent'、memoryId に対象の id", async () => {
    const { store, a } = await setup();
    const error = await caught(() =>
      store.updateStatusWithEvent(ctx, a.id, "contested", {}, event(a.id)),
    );
    expect(error).toBeInstanceOf(ContestedWithoutCompanionError);
    expect(error).toMatchObject({ method: "updateStatusWithEvent", memoryId: a.id });
  });

  it("createMemory は method='createMemory'、memoryId は null（作成時）", async () => {
    const { store } = await setup();
    const error = await caught(() => store.createMemory(ctx, contestedNew("c")));
    expect(error).toBeInstanceOf(ContestedWithoutCompanionError);
    expect(error).toMatchObject({ method: "createMemory", memoryId: null });
  });

  it("createMemoryWithOutbox は method='createMemoryWithOutbox'、memoryId は null", async () => {
    const { store } = await setup();
    const error = await caught(() =>
      store.createMemoryWithOutbox(ctx, contestedNew("c"), ["embed"]),
    );
    expect(error).toBeInstanceOf(ContestedWithoutCompanionError);
    expect(error).toMatchObject({ method: "createMemoryWithOutbox", memoryId: null });
  });

  it("supersedeWithNewMemories は method='supersedeWithNewMemories'、memoryId は null", async () => {
    const { store, a } = await setup();
    const error = await caught(() =>
      store.supersedeWithNewMemories(
        ctx,
        [{ input: contestedNew("c"), jobKinds: ["embed"] }],
        [
          {
            id: a.id,
            supersededByIndex: 0,
            expectedStatus: "active",
            event: event(a.id, "superseded"),
          },
        ],
      ),
    );
    expect(error).toBeInstanceOf(ContestedWithoutCompanionError);
    expect(error).toMatchObject({ method: "supersedeWithNewMemories", memoryId: null });
  });
});

describe("MemoryStatusConflictError: memoryId・expectedStatus・observedStatus", () => {
  it("updateStatus（expectedStatus の食い違い）", async () => {
    const { store, a } = await setup();
    const error = await caught(() =>
      store.updateStatus(ctx, a.id, "archived", { expectedStatus: "superseded" }),
    );
    expect(error).toBeInstanceOf(MemoryStatusConflictError);
    expect(error).toMatchObject({
      memoryId: a.id,
      expectedStatus: "superseded",
      observedStatus: "active",
    });
  });

  it("updateStatusWithEvent（expectedStatus の食い違い）", async () => {
    const { store, a } = await setup();
    const error = await caught(() =>
      store.updateStatusWithEvent(
        ctx,
        a.id,
        "archived",
        { expectedStatus: "superseded" },
        event(a.id, "archived"),
      ),
    );
    expect(error).toBeInstanceOf(MemoryStatusConflictError);
    expect(error).toMatchObject({
      memoryId: a.id,
      expectedStatus: "superseded",
      observedStatus: "active",
    });
  });

  it("markContestedPair（既に contested）は expectedStatus='active'", async () => {
    const { store, a, b } = await setup();
    const pair = () =>
      store.markContestedPair(
        ctx,
        { id: a.id, event: event(a.id) },
        { id: b.id, event: event(b.id) },
      );
    await pair();
    const error = await caught(pair);
    expect(error).toBeInstanceOf(MemoryStatusConflictError);
    expect(error).toMatchObject({
      memoryId: a.id,
      expectedStatus: "active",
      observedStatus: "contested",
    });
  });

  it("resolveContestedPair（contested でない）は expectedStatus='contested'", async () => {
    const { store, a, b } = await setup();
    const error = await caught(() =>
      store.resolveContestedPair(
        ctx,
        { id: a.id, status: "active", event: event(a.id) },
        { id: b.id, status: "active", event: event(b.id) },
      ),
    );
    expect(error).toBeInstanceOf(MemoryStatusConflictError);
    expect(error).toMatchObject({
      memoryId: a.id,
      expectedStatus: "contested",
      observedStatus: "active",
    });
  });

  it("resolveOrphanedContested（生存側が contested でない）は expectedStatus='contested'", async () => {
    const { store, a, b } = await setup();
    const error = await caught(() =>
      store.resolveOrphanedContested(ctx, { id: a.id, contestedWithId: b.id, event: event(a.id) }),
    );
    expect(error).toBeInstanceOf(MemoryStatusConflictError);
    expect(error).toMatchObject({
      memoryId: a.id,
      expectedStatus: "contested",
      observedStatus: "active",
    });
  });

  it("resolveOrphanedContested（contestedWithId の食い違い）は observedStatus も 'contested'", async () => {
    const { store, a, b } = await setup();
    await store.markContestedPair(
      ctx,
      { id: a.id, event: event(a.id) },
      { id: b.id, event: event(b.id) },
    );
    await store.updateStatusWithEvent(ctx, b.id, "forgotten", {}, event(b.id, "forgotten"));
    const error = await caught(() =>
      store.resolveOrphanedContested(ctx, {
        id: a.id,
        contestedWithId: "00000000-0000-4000-8000-000000000000",
        event: event(a.id),
      }),
    );
    expect(error).toBeInstanceOf(MemoryStatusConflictError);
    expect(error).toMatchObject({
      memoryId: a.id,
      expectedStatus: "contested",
      observedStatus: "contested",
    });
  });
});

describe("MemoryPurgeConflictError: memoryId・observedStatus・observedPurgedAt", () => {
  const purge = (store: InMemoryMemoryStore, id: MemoryId) =>
    store.purgeMemory(ctx, id, { content: "[purged]", digest: "[purged]" }, event(id, "purged"));

  it("forgotten でない行は observedPurgedAt=null", async () => {
    const { store, a } = await setup();
    const error = await caught(() => purge(store, a.id));
    expect(error).toBeInstanceOf(MemoryPurgeConflictError);
    expect(error).toMatchObject({
      memoryId: a.id,
      observedStatus: "active",
      observedPurgedAt: null,
    });
  });

  it("purge 済みの行は observedStatus='forgotten'、observedPurgedAt に purge した時刻", async () => {
    const { store, a } = await setup();
    await store.updateStatus(ctx, a.id, "forgotten");
    await purge(store, a.id);
    const purgedAt = (await store.get(ctx, a.id))?.purgedAt;
    expect(purgedAt).toBeInstanceOf(Date);
    const error = await caught(() => purge(store, a.id));
    expect(error).toBeInstanceOf(MemoryPurgeConflictError);
    expect(error).toMatchObject({
      memoryId: a.id,
      observedStatus: "forgotten",
      observedPurgedAt: purgedAt,
    });
  });
});

describe("OutboxLeaseConflictError: jobId・expectedAttempts・observedAttempts", () => {
  /** embed のジョブを1本作る（`attempts` は 0）。`claim` なら取って `attempts` を 1 にする。 */
  async function job(claim: boolean) {
    const store = new InMemoryMemoryStore();
    const outbox = new InMemoryOutboxStore(store.outboxJobs);
    const { jobs } = await store.createMemoryWithOutbox(
      ctx,
      buildNewMemoryFixture({ contentHash: "lease" }),
      ["embed"],
    );
    if (claim) {
      await outbox.claimBatch(ctx, {
        limit: 10,
        now: new Date(Date.now() + 60_000),
        claimedBy: "w",
        leaseMs: 60_000,
      });
    }
    return { outbox, jobId: jobs[0]!.id };
  }

  it("complete（claim 済み、attempts 違い）", async () => {
    const { outbox, jobId } = await job(true);
    const error = await caught(() => outbox.complete(ctx, jobId, 2));
    expect(error).toBeInstanceOf(OutboxLeaseConflictError);
    expect(error).toMatchObject({ jobId, expectedAttempts: 2, observedAttempts: 1 });
  });

  it("fail（claim 済み、attempts 違い）", async () => {
    const { outbox, jobId } = await job(true);
    const error = await caught(() => outbox.fail(ctx, jobId, "e", 2));
    expect(error).toBeInstanceOf(OutboxLeaseConflictError);
    expect(error).toMatchObject({ jobId, expectedAttempts: 2, observedAttempts: 1 });
  });

  // Issue #1292（未決）: 終端済みの行に違う expectedAttempts を渡したとき、`complete` のメソッドの doc の要約と
  // `outbox-store.ts` 冒頭の契約（attempts が違えば投げる）が食い違って読める。ここは今の振る舞い
  // （冒頭の契約どおりに投げる）を縛るだけで、どちらを正とするかは #1292 で決める。
  it("complete（fail で終端済み、attempts 違い）も投げる（#1292 の今の振る舞い）", async () => {
    const { outbox, jobId } = await job(false);
    await outbox.fail(ctx, jobId, "e", 0);
    const error = await caught(() => outbox.complete(ctx, jobId, 1));
    expect(error).toBeInstanceOf(OutboxLeaseConflictError);
    expect(error).toMatchObject({ jobId, expectedAttempts: 1, observedAttempts: 0 });
  });

  it("fail（complete で終端済み、attempts 違い）も投げる（#1292 の今の振る舞い）", async () => {
    const { outbox, jobId } = await job(false);
    await outbox.complete(ctx, jobId, 0);
    const error = await caught(() => outbox.fail(ctx, jobId, "e", 1));
    expect(error).toBeInstanceOf(OutboxLeaseConflictError);
    expect(error).toMatchObject({ jobId, expectedAttempts: 1, observedAttempts: 0 });
  });
});
