// Issue #826（クローン miku の委譲先が書いた。オーナーではない）: `InMemoryOutboxStore.complete`/
// `fail` は `attempts` の一致しか見ておらず、相手側の終端列（`completedAt`/`failedAt`）を
// 見ていなかった。そのため、同じ `attempts` のまま逐次に complete → fail（または
// fail → complete）を呼ぶと、両方の終端列が付いた——ADR 0142 の「確かめていないこと」が
// 「本来ありえないはずの矛盾した終端状態」と呼んでいる状態そのものである
// （docs/decisions/0142-outbox-complete-fail-compare-and-swap.md 145-147 行）。
//
// 直し方（Issue #826 案2）: 先に付いた終端を勝たせる。相手側の終端列が既に付いていれば、
// 後から来た complete/fail は行を変えない（`completedAt`/`failedAt`/`lastError` のどれも
// 書かない）。例外も投げない——interface の契約（`packages/core/src/interfaces/
// outbox-store.ts` 61-62 行）が明記する「同じ worker が同じ claim に対して complete/fail
// を再度呼ぶことは冪等」を、種類が混ざった場合にも一貫させただけであり、`attempts`
// 不一致の CAS 衝突（`OutboxLeaseConflictError`）や行が無い場合の no-op はこれまで通り。
//
// `*-conformance.ts` は外部の store 実装者も走らせる公開面であり、ここに it を足すのは
// 契約の追加になる（`in-memory-fixtures-negative-limit.test.ts` の前例と同じ理由で、
// `packages/testkit` 内だけで完結する回帰テストにしてある）。`PostgresOutboxStore`
// 側の対応する回帰は `packages/postgres/src/__tests__/
// outbox-complete-fail-terminal-exclusive.postgres.test.ts`。

import { describe, expect, it } from "vitest";
import type { Ctx, OutboxJobRecord } from "@mnemora/core";
import { OutboxLeaseConflictError } from "@mnemora/core";
import { InMemoryOutboxStore } from "../__fixtures__/in-memory-outbox-store.js";

const ctx: Ctx = { tenantId: "tenant-1" };

function makeJob(overrides: Partial<OutboxJobRecord> = {}): OutboxJobRecord {
  return {
    id: "job-1",
    tenantId: ctx.tenantId,
    kind: "extract",
    payload: {},
    availableAt: new Date("2026-01-01T00:00:00.000Z"),
    attempts: 1,
    claimedAt: new Date("2026-01-01T00:00:00.000Z"),
    claimedBy: "worker-1",
    completedAt: null,
    failedAt: null,
    lastError: null,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    ...overrides,
  };
}

describe("InMemoryOutboxStore.complete/fail — 相手側の終端が既に付いていたら、後から来た呼び出しは行を変えない（Issue #826）", () => {
  it("逐次: complete → fail（同じ attempts）— completed のまま、failedAt/lastError は null", async () => {
    const job = makeJob();
    const store = new InMemoryOutboxStore([job]);

    await store.complete(ctx, job.id, job.attempts);
    await expect(
      store.fail(ctx, job.id, "should-not-be-recorded", job.attempts),
    ).resolves.not.toThrow();

    expect(job.completedAt).not.toBeNull();
    expect(job.failedAt).toBeNull();
    expect(job.lastError).toBeNull();
  });

  it("逐次: fail → complete（同じ attempts）— failed のまま、completedAt は null", async () => {
    const job = makeJob();
    const store = new InMemoryOutboxStore([job]);

    await store.fail(ctx, job.id, "boom", job.attempts);
    await expect(store.complete(ctx, job.id, job.attempts)).resolves.not.toThrow();

    expect(job.failedAt).not.toBeNull();
    expect(job.lastError).toBe("boom");
    expect(job.completedAt).toBeNull();
  });

  it("同種の再呼び出し（complete → complete）は変わらず成功する（冪等、既存契約）", async () => {
    const job = makeJob();
    const store = new InMemoryOutboxStore([job]);

    await store.complete(ctx, job.id, job.attempts);
    const firstCompletedAt = job.completedAt;
    await expect(store.complete(ctx, job.id, job.attempts)).resolves.not.toThrow();

    expect(job.completedAt).not.toBeNull();
    expect(job.failedAt).toBeNull();
    // 冪等呼び出しでも completedAt は最新の呼び出し時刻に更新される(既存の挙動、本 issue の対象外)。
    void firstCompletedAt;
  });

  it("同種の再呼び出し（fail → fail）は変わらず成功し、lastError は後勝ち（既存契約）", async () => {
    const job = makeJob();
    const store = new InMemoryOutboxStore([job]);

    await store.fail(ctx, job.id, "first-error", job.attempts);
    await expect(store.fail(ctx, job.id, "second-error", job.attempts)).resolves.not.toThrow();

    expect(job.failedAt).not.toBeNull();
    expect(job.completedAt).toBeNull();
    expect(job.lastError).toBe("second-error");
  });

  it("attempts が不一致なら、相手側の終端の有無に関わらず OutboxLeaseConflictError を投げる（既存契約）", async () => {
    const job = makeJob({ attempts: 2 });
    const store = new InMemoryOutboxStore([job]);

    await expect(store.complete(ctx, job.id, 1)).rejects.toBeInstanceOf(OutboxLeaseConflictError);
    expect(job.completedAt).toBeNull();

    await expect(store.fail(ctx, job.id, "boom", 1)).rejects.toBeInstanceOf(
      OutboxLeaseConflictError,
    );
    expect(job.failedAt).toBeNull();
  });

  it("行が無いジョブ id は no-op のまま（既存契約）", async () => {
    const store = new InMemoryOutboxStore([]);
    await expect(store.complete(ctx, "does-not-exist", 0)).resolves.not.toThrow();
    await expect(store.fail(ctx, "does-not-exist", "boom", 0)).resolves.not.toThrow();
  });
});
