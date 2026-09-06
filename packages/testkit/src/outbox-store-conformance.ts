import { describe, expect, it } from "vitest";
import type { Ctx, OutboxJobKind, OutboxJobRecord, OutboxStore } from "@mnemora/core";

export interface SeedOutboxJobInput {
  kind: OutboxJobKind;
  payload?: Record<string, unknown>;
  availableAt?: Date;
}

export interface OutboxStoreConformanceOptions {
  name: string;
  createStore: () => OutboxStore | Promise<OutboxStore>;
  /**
   * `OutboxStore` 単体には「積む」操作が無い（`enqueue` は `MemoryStore.createObservationWithOutbox`
   * / `createMemoryWithOutbox` が同一トランザクションで行う、docs/architecture.md §3.4）。
   * この適合テストは `claimBatch`/`complete`/`fail` を単体で検査したいため、adapter に
   * 「生の outbox 行を直接作る」フックを要求する。
   */
  seedJob: (ctx: Ctx, input: SeedOutboxJobInput) => Promise<OutboxJobRecord>;
}

/**
 * この適合テスト自身が要求する claim のリース長。**契約検査のための固定値であり、
 * `runtime.tick`/`ClaimOutboxJobsOptions` の運用上の既定値ではない**（そちらは
 * ADR 0032 の通り既定値を持たない・呼び出し側が決める）。ここではリースの境界を
 * 明示的に検査する2本（先頭詰まり・リース失効後の再 claim）以外のテストで、
 * リース絡みの挙動が結果に影響しないよう十分に長い値を使う。
 */
const DEFAULT_LEASE_MS = 60_000;

/**
 * `OutboxStore` の適合テスト（roadmap.md 段階3、ADR 0005 の transactional outbox「運搬役」側）。
 *
 * 検査する契約:
 * - `claimBatch` は未処理（completed/failed 双方が null）かつ `availableAt <= now` の
 *   ジョブだけを返す
 * - `claimBatch` は `kinds` で絞り込める
 * - `claimBatch` は `limit` を超えない
 * - `claimBatch` で claim したジョブは、同じ claim 条件で二重に返らない（同時実行の安全）
 * - `complete` / `fail` の後、そのジョブは再び `claimBatch` に現れない
 * - テナント分離: 他テナントの未処理ジョブが `claimBatch` に現れない
 * - **claim のリース（ADR 0032）**: リース内で claim 済みの行は再 claim されず、
 *   `ORDER BY available_at ASC LIMIT n` の先頭を占め続けて後続の行を詰まらせない
 *   （オーナーの「先頭詰まり」仮説の検査）。リースが切れた行は再び claim される
 *   （`claimed_at IS NULL` だけにする案を却下した理由そのもの——見えない停止にしない）。
 */
export function describeOutboxStoreConformance(options: OutboxStoreConformanceOptions): void {
  const { name, createStore, seedJob } = options;

  describe(`OutboxStore conformance (${name})`, () => {
    it("claimBatch は available_at <= now の未処理ジョブを返す", async () => {
      const store = await createStore();
      const ctx: Ctx = { tenantId: "tenant-1" };
      await seedJob(ctx, { kind: "extract", payload: { observationId: "obs-1" } });

      const claimed = await store.claimBatch(ctx, {
        limit: 10,
        now: new Date(),
        claimedBy: "worker-1",
        leaseMs: DEFAULT_LEASE_MS,
      });
      expect(claimed).toHaveLength(1);
      expect(claimed[0]?.kind).toBe("extract");
    });

    it("claimBatch は availableAt が未来のジョブを返さない", async () => {
      const store = await createStore();
      const ctx: Ctx = { tenantId: "tenant-1" };
      const future = new Date(Date.now() + 1000 * 60 * 60);
      await seedJob(ctx, { kind: "extract", availableAt: future });

      const claimed = await store.claimBatch(ctx, {
        limit: 10,
        now: new Date(),
        claimedBy: "worker-1",
        leaseMs: DEFAULT_LEASE_MS,
      });
      expect(claimed).toEqual([]);
    });

    it("claimBatch は kinds で絞り込める", async () => {
      const store = await createStore();
      const ctx: Ctx = { tenantId: "tenant-1" };
      await seedJob(ctx, { kind: "extract" });
      await seedJob(ctx, { kind: "embed" });

      const claimed = await store.claimBatch(ctx, {
        kinds: ["embed"],
        limit: 10,
        now: new Date(),
        claimedBy: "worker-1",
        leaseMs: DEFAULT_LEASE_MS,
      });
      expect(claimed.every((job) => job.kind === "embed")).toBe(true);
      expect(claimed.length).toBeGreaterThanOrEqual(1);
    });

    it("claimBatch は limit を超えない件数を返す", async () => {
      const store = await createStore();
      const ctx: Ctx = { tenantId: "tenant-1" };
      await seedJob(ctx, { kind: "extract" });
      await seedJob(ctx, { kind: "extract" });
      await seedJob(ctx, { kind: "extract" });

      const claimed = await store.claimBatch(ctx, {
        limit: 2,
        now: new Date(),
        claimedBy: "worker-1",
        leaseMs: DEFAULT_LEASE_MS,
      });
      expect(claimed.length).toBeLessThanOrEqual(2);
    });

    it("complete したジョブは再び claimBatch に現れない", async () => {
      const store = await createStore();
      const ctx: Ctx = { tenantId: "tenant-1" };
      const job = await seedJob(ctx, { kind: "extract" });

      const firstClaim = await store.claimBatch(ctx, {
        limit: 10,
        now: new Date(),
        claimedBy: "worker-1",
        leaseMs: DEFAULT_LEASE_MS,
      });
      expect(firstClaim.map((j) => j.id)).toContain(job.id);

      await store.complete(ctx, job.id);

      const secondClaim = await store.claimBatch(ctx, {
        limit: 10,
        now: new Date(),
        claimedBy: "worker-1",
        leaseMs: DEFAULT_LEASE_MS,
      });
      expect(secondClaim.map((j) => j.id)).not.toContain(job.id);
    });

    it("fail したジョブは再び claimBatch に現れない（Phase 1 は自動リトライしない）", async () => {
      const store = await createStore();
      const ctx: Ctx = { tenantId: "tenant-1" };
      const job = await seedJob(ctx, { kind: "extract" });

      await store.fail(ctx, job.id, "simulated failure");

      const claimed = await store.claimBatch(ctx, {
        limit: 10,
        now: new Date(),
        claimedBy: "worker-1",
        leaseMs: DEFAULT_LEASE_MS,
      });
      expect(claimed.map((j) => j.id)).not.toContain(job.id);
    });

    it("complete は存在しないジョブ id に対して例外を投げない（べき等な終端更新）", async () => {
      const store = await createStore();
      const ctx: Ctx = { tenantId: "tenant-1" };
      await expect(store.complete(ctx, "does-not-exist")).resolves.not.toThrow();
    });

    it("fail は存在しないジョブ id に対して例外を投げない（べき等な終端更新）", async () => {
      const store = await createStore();
      const ctx: Ctx = { tenantId: "tenant-1" };
      await expect(store.fail(ctx, "does-not-exist", "boom")).resolves.not.toThrow();
    });

    it("クロステナントの claimBatch は他テナントの未処理ジョブを返さない", async () => {
      const store = await createStore();
      const ctxA: Ctx = { tenantId: "tenant-a" };
      const ctxB: Ctx = { tenantId: "tenant-b" };
      await seedJob(ctxA, { kind: "extract" });

      const claimedB = await store.claimBatch(ctxB, {
        limit: 10,
        now: new Date(),
        claimedBy: "worker-1",
        leaseMs: DEFAULT_LEASE_MS,
      });
      expect(claimedB).toEqual([]);
    });

    // -------------------------------------------------------------------
    // claim のリース（ADR 0032）
    // -------------------------------------------------------------------

    it("リース内で claim 済みの行は再 claim されず、後続の未処理行に到達できる（先頭詰まりの検査、オーナーの仮説）", async () => {
      const store = await createStore();
      const ctx: Ctx = { tenantId: "tenant-1" };
      const base = new Date("2026-01-01T00:00:00.000Z");
      // stuck が available_at で先頭に来るよう、later より前の時刻にする。
      const stuck = await seedJob(ctx, { kind: "extract", availableAt: base });
      const later = await seedJob(ctx, {
        kind: "extract",
        availableAt: new Date(base.getTime() + 1000),
      });

      // stuck を claim する(ワーカーが処理中、というシナリオ。complete/fail はまだ呼ばない)。
      const firstClaim = await store.claimBatch(ctx, {
        limit: 1,
        now: new Date(base.getTime() + 2000),
        claimedBy: "worker-1",
        leaseMs: 60_000,
      });
      expect(firstClaim.map((j) => j.id)).toEqual([stuck.id]);

      // 次の tick。リース(60秒)はまだ生きている(3秒しか経っていない)。
      // オーナーの仮説どおり先頭詰まりが起きるなら、limit=1 の枠は毎回 stuck に
      // 占有され続け、later には永久に到達できない。
      const secondClaim = await store.claimBatch(ctx, {
        limit: 1,
        now: new Date(base.getTime() + 3000),
        claimedBy: "worker-1",
        leaseMs: 60_000,
      });
      expect(secondClaim.map((j) => j.id)).toEqual([later.id]);
    });

    it("リースが切れた claim 済みの行は再び claim される（見えない停止にしない。claimed_at IS NULL 単独案を却下した理由そのもの）", async () => {
      const store = await createStore();
      const ctx: Ctx = { tenantId: "tenant-1" };
      const base = new Date("2026-01-01T00:00:00.000Z");
      const job = await seedJob(ctx, { kind: "extract", availableAt: base });
      const leaseMs = 1000;

      const firstClaim = await store.claimBatch(ctx, {
        limit: 10,
        now: base,
        claimedBy: "worker-1",
        leaseMs,
      });
      expect(firstClaim.map((j) => j.id)).toEqual([job.id]);

      // リースが切れる前 — まだ完了していないワーカーの行を横取りしない。
      const beforeExpiry = await store.claimBatch(ctx, {
        limit: 10,
        now: new Date(base.getTime() + leaseMs - 1),
        claimedBy: "worker-2",
        leaseMs,
      });
      expect(beforeExpiry.map((j) => j.id)).not.toContain(job.id);

      // リースがちょうど切れた瞬間 — 再び claim できる(止まったワーカーからの回収)。
      const afterExpiry = await store.claimBatch(ctx, {
        limit: 10,
        now: new Date(base.getTime() + leaseMs),
        claimedBy: "worker-2",
        leaseMs,
      });
      expect(afterExpiry.map((j) => j.id)).toContain(job.id);
    });
  });
}
