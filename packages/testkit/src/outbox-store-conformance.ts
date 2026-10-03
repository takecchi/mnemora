import { describe, expect, it } from "vitest";
import {
  isOutboxLeaseConflictError,
  type Ctx,
  type OutboxJobKind,
  type OutboxJobRecord,
  type OutboxLeaseConflictError,
  type OutboxStore,
} from "@mnemora/core";
import { expectStoreError } from "./error-guards.js";
import {
  expectMalformedIdentifierRejection,
  MALFORMED_IDENTIFIER_CASES,
} from "./malformed-identifier-cases.js";

/** `OutboxStoreConformanceOptions.seedJob` に渡る、作ってほしい outbox の行。 */
export interface SeedOutboxJobInput {
  /** ジョブの種別。 */
  kind: OutboxJobKind;
  /** ジョブの中身。suite が渡さないこともあるので、省略時の値は adapter が決めてよい。 */
  payload?: Record<string, unknown>;
  /** claim できるようになる時刻。suite は未来の時刻を渡して「まだ取れない」ことを測る。省略時は、すぐ claim できる時刻にすること。 */
  availableAt?: Date;
}

/** {@link describeOutboxStoreConformance} に渡す設定。 */
export interface OutboxStoreConformanceOptions {
  /** 見出し（`describe` の名前）に出す adapter の名前。 */
  name: string;
  /** 新しい store を返す関数。各 `it` の中で1回ずつ呼ぶので、テストケースごとに独立した状態を持つ store を返すこと。 */
  createStore: () => OutboxStore | Promise<OutboxStore>;
  /**
   * `OutboxStore` 単体には「積む」操作が無い（`enqueue` は `MemoryStore.createObservationWithOutbox`
   * / `createMemoryWithOutbox` が同一トランザクションで行う、docs/architecture.md §3.4）。
   * この適合テストは `claimBatch`/`complete`/`fail` を単体で検査したいため、adapter に
   * 「生の outbox 行を直接作る」フックを要求する。
   */
  seedJob: (ctx: Ctx, input: SeedOutboxJobInput) => Promise<OutboxJobRecord>;
  /**
   * [Issue #1237](https://github.com/takecchi/mnemora/issues/1237)「案1」: `complete`/`fail`
   * が積む `completedAt`/`failedAt` を検査するための、終端後も読める「生の行を読む」フック
   * （`claimBatch` は `completed_at`/`failed_at` が付いた行を対象から外すため使えない）。
   * 同じ理由で、`fail` が残す `lastError`・`claimBatch` が返した `payload` の複製・
   * `purgeCompletedJobs` の結果を読み直す歯も、このフックを使う。
   * 省略した adapter では、これらを検査する歯は `it.skip` になる——測っていないことが
   * 緑ではなく skip として見える。
   */
  peekJob?: ((ctx: Ctx, jobId: string) => Promise<OutboxJobRecord | null>) | undefined;
  /**
   * **本物の並行で `claimBatch` を測れる adapter だけが `true` を渡す**（ADR 0206）。
   *
   * `true` のとき「並行に撃った `claimBatch` が二重 claim しない」歯が走り、**省略/false の
   * ときは `it.skip` になる**——⟹ **測っていないことが、緑ではなく skip として見える。**
   *
   * ⛔ **`true` にしてよいのは、`Promise.all` で撃った `claimBatch` が実際に別のセッション
   * （別コネクション）で重なる adapter だけである。**単一プロセス内で逐次化される実装
   * （例: 本体に `await` を持たない in-memory 実装）が `true` を渡すと、**何も測らずに
   * 緑が出る。**
   *
   * ⚠ **この歯は、複数プロセスが実際にネットワーク越しで撃つ状況までは測らない。**
   * 測るのは単一プロセス内の複数接続までである。
   */
  supportsRealConcurrency?: boolean | undefined;
  /**
   * Issue #1207 / [ADR 0383](../../../docs/decisions/0383-erase-tenant.md): 対象の
   * `OutboxStore` 実装が `eraseTenant`（任意メソッド）を実装しているかどうか。**必須。**
   *
   * `memory-store-conformance.ts` の `supportsArchiveDecayed`/`supportsPurgeMemory` 等と
   * 同じ判断——省略可にしないこと。`true` なら契約の歯（このテナントの outbox 行
   * （完了・失敗・未処理を問わず）を消す、他テナントは無傷のまま残る、
   * `limit`/`reachedLimit`（保守的な近似）・呼び直せば最終的に全部消える、`dryRun` で
   * 1行も変わらない）を実行する。`false` なら `expect(store.eraseTenant).toBeUndefined()`
   * を積極的に assert する——`it.skip` にはしない。
   */
  supportsEraseTenant: boolean;
  /**
   * [ADR 0404](../../../docs/decisions/0404-purge-expired-recalls-and-completed-outbox-jobs.md):
   * 対象の `OutboxStore` 実装が `purgeCompletedJobs`（任意メソッド）を実装しているかどうか。
   *
   * ⚠ **任意（省略可）の3状態フラグである**（`memory-store-conformance.ts` の
   * `supportsPurgeExpiredRecalls` と同じ理由——必須にすると既存の呼び出し側を壊す）。
   * - `true`: 契約の歯（完了した古い行だけを消す・境界・**未処理／claim 中／failed の行は
   *   どれだけ古くても消さない**・テナント越境しない・`limit`/`reachedLimit`・`dryRun`）を実行する。
   *   **各 `it` の冒頭で口の存在を要求する**——実装が無い adapter が `true` を名乗ると赤になる。
   *   ⚠ 終端後の行を読む歯は `peekJob` を要る——**`peekJob` が無い adapter では `it.skip`** になる。
   * - `false`: `expect(store.purgeCompletedJobs).toBeUndefined()` を積極的に assert する。
   * - **省略**: 「⚠ 未検査」の named it を1本だけ登録する（`it.skip` にしない）。
   */
  supportsPurgeCompletedJobs?: boolean | undefined;
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
 * 並行 claim の歯（ADR 0206）の並行数とラウンド数。
 *
 * 🔴 **ラウンド数を減らさないこと。この歯の正しさは、ここにぶら下がっている。**
 *
 * 【実測 2026-09-17、`main` = `6daa09c`】`packages/postgres` の `claimBatch` から
 * `FOR UPDATE SKIP LOCKED` を丸ごと削った状態で、この歯を走らせた:
 *
 * | ラウンド数 | 試行 | 結果 |
 * | --- | --- | --- |
 * | **1** | 6 | 5 回 RED / **1 回 GREEN** ← 🔴 **壊れた実装を見逃した** |
 * | **10** | 4 | 4 回 RED（見逃し無し） |
 *
 * ⟹ **1ラウンドでは、壊れた実装を実際に取りこぼす。**⛔ **「10は多い、3で十分だろう」と
 * 減らさないこと**——見逃しは赤くならないので、**減らしたことが表に出ない。**
 * （変異なしの実装に対しては、10ラウンドで5試行とも緑。**偽陽性は観測していない。**）
 *
 * ⚠ **逆向きは保証していない。**`duplicateRounds === 0` は
 * **「このラウンド数では出なかった」以上を主張しない**——二重 claim が起きないことの
 * 証明ではない。
 */
const CONCURRENT_CLAIM_CONCURRENCY = 8;
const CONCURRENT_CLAIM_ROUNDS = 10;

/**
 * `OutboxStore` の適合テスト（roadmap.md 段階3、ADR 0005 の transactional outbox「運搬役」側）。
 *
 * 検査する契約:
 * - `claimBatch` は未処理（completed/failed 双方が null）かつ `availableAt <= now` の
 *   ジョブだけを返す
 * - `claimBatch` は `kinds` で絞り込める
 * - `claimBatch` は `limit` を超えない
 * - `claimBatch` で claim したジョブは、同じ claim 条件で二重に返らない
 *   （逐次の呼び出しについて。下の complete/fail・リースの項目）
 * - **並行に撃った `claimBatch` が、同じジョブを二重に claim しない**（ADR 0206）
 *   ⚠ **これを検査するのは `supportsRealConcurrency: true` を渡した adapter に対してだけである。**
 *   渡さない adapter では `it.skip` になる——⟹ **測っていないことが緑ではなく skip として
 *   見える。**理由と、boolean のフラグを採らなかった経緯は同フックの doc と ADR 0206。
 *   ⛔ **この歯が守っているのは `FOR UPDATE` の行ロックであって `SKIP LOCKED` ではない**
 *   【実測】——`SKIP LOCKED` だけを外しても赤くならない（ADR 0206 の「測ったこと」）。
 *   ⟹ **この項目が緑でも、`SKIP LOCKED` は検査されていない。**
 *   ⚠ **複数プロセスが実際にネットワーク越しで撃つ状況は、いまも測っていない。**
 *   この歯は単一プロセス内の複数接続までである。詳細は
 *   docs/architecture.md「確かめていないこと」節、ADR 0032「確かめていないこと」節を見ること。
 * - `complete` / `fail` の後、そのジョブは再び `claimBatch` に現れない
 * - `complete` / `fail` の `opts.at`（`completedAt`/`failedAt` の時刻。省略時は壁時計。
 *   Invalid Date は、`jobId` の形・行の有無を見る前に例外（ADR 0594）。時刻の読み戻しは `peekJob` を渡した adapter だけ）、存在しないジョブ id は
 *   例外にしない冪等な終端更新、`claim` 時の `attempts` と一致しなければ `OutboxLeaseConflictError`
 *   （ADR 0142）
 * - テナント分離: 他テナントの未処理ジョブが `claimBatch` に現れない。他テナントの ctx からの
 *   `complete` / `fail` は行に触れず、存在も知らせない
 * - **claim のリース（ADR 0032）**: リース内で claim 済みの行は再 claim されず、
 *   `ORDER BY available_at ASC LIMIT n` の先頭を占め続けて後続の行を詰まらせない
 *   （オーナーの「先頭詰まり」仮説の検査）。リースが切れた行は再び claim される
 *   （`claimed_at IS NULL` だけにする案を却下した理由そのもの——見えない停止にしない）。
 * - `eraseTenant`（`supportsEraseTenant` に応じて）・`purgeCompletedJobs`（`supportsPurgeCompletedJobs` の
 *   3状態に応じて。ADR 0404）、`ctx.tenantId`・`ctx.subjectId` の形式不正な識別子の拒否（ADR 0423）
 */
export function describeOutboxStoreConformance(options: OutboxStoreConformanceOptions): void {
  const {
    name,
    createStore,
    seedJob,
    peekJob,
    supportsRealConcurrency,
    supportsEraseTenant,
    supportsPurgeCompletedJobs,
  } = options;

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
      const claimedJob = firstClaim.find((j) => j.id === job.id)!;

      await store.complete(ctx, job.id, claimedJob.attempts);

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

      // job はまだ claim されていない(seedJob 直後、attempts は生成時の値のまま)ため、
      // その attempts を渡す。
      await store.fail(ctx, job.id, "simulated failure", job.attempts);

      const claimed = await store.claimBatch(ctx, {
        limit: 10,
        now: new Date(),
        claimedBy: "worker-1",
        leaseMs: DEFAULT_LEASE_MS,
      });
      expect(claimed.map((j) => j.id)).not.toContain(job.id);
    });

    /**
     * [Issue #1237](https://github.com/takecchi/mnemora/issues/1237)「案1」: `opts.at` を
     * 渡すと `completedAt`/`failedAt` にその値を使う——runtime が注入した時計をここへ渡す。
     */
    (peekJob ? it : it.skip)(
      "complete は opts.at を渡すと completedAt にその値を使う",
      async () => {
        const store = await createStore();
        const ctx: Ctx = { tenantId: "tenant-1" };
        const job = await seedJob(ctx, { kind: "extract" });
        const at = new Date("2020-01-01T00:00:00.000Z");

        await store.complete(ctx, job.id, job.attempts, { at });

        const after = await peekJob!(ctx, job.id);
        expect(after?.completedAt).toEqual(at);
      },
    );

    (peekJob ? it : it.skip)("fail は opts.at を渡すと failedAt にその値を使う", async () => {
      const store = await createStore();
      const ctx: Ctx = { tenantId: "tenant-1" };
      const job = await seedJob(ctx, { kind: "extract" });
      const at = new Date("2020-01-01T00:00:00.000Z");

      await store.fail(ctx, job.id, "simulated failure", job.attempts, { at });

      const after = await peekJob!(ctx, job.id);
      expect(after?.failedAt).toEqual(at);
    });

    /**
     * `opts.at` が Invalid Date のとき、Postgres は `timestamptz` への変換で拒む（`22007`）。
     * 静かに `completedAt`/`failedAt` へ Invalid Date を書いてはならない。
     */
    for (const how of ["complete", "fail"] as const) {
      it(`${how} は opts.at が Invalid Date なら例外を投げる`, async () => {
        const store = await createStore();
        const ctx: Ctx = { tenantId: "tenant-1" };
        const job = await seedJob(ctx, { kind: "extract" });
        const at = new Date(Number.NaN);

        const call =
          how === "complete"
            ? store.complete(ctx, job.id, job.attempts, { at })
            : store.fail(ctx, job.id, "simulated failure", job.attempts, { at });
        await expect(call).rejects.toThrow();
      });
    }

    /**
     * 検査の順（クローンの決定 2026-10-03 02:41Z。ADR 0594）: `opts.at` の Invalid Date は、`jobId` の形・行の有無を見る**前**に断る。
     * 形の崩れた・存在しない `jobId` は「静かに返る（べき等な no-op）」のが約束だが、`opts.at` が Invalid Date の呼び出しは
     * 呼び手のバグなので、その約束より先に例外にする。上の歯は、実在のジョブでしか断ることを縛らない。
     */
    for (const how of ["complete", "fail"] as const) {
      for (const [label, jobId] of [
        ["形の崩れた jobId", "does-not-exist"],
        ["uuid の形だが存在しない jobId", "11111111-1111-4111-8111-111111111111"],
      ] as const) {
        it(`${how} は ${label} でも、opts.at が Invalid Date なら静かに返さず例外を投げる`, async () => {
          const store = await createStore();
          const ctx: Ctx = { tenantId: "tenant-1" };
          const at = new Date(Number.NaN);

          const call =
            how === "complete"
              ? store.complete(ctx, jobId, 0, { at })
              : store.fail(ctx, jobId, "simulated failure", 0, { at });
          await expect(call).rejects.toThrow();
        });
      }
    }

    /**
     * `opts.at` が `timestamptz` の下限（紀元前4714年11月24日 00:00 UTC）より前なら、`jobId` の形・行の有無を見る前に断る
     * （クローンの判断。ADR 0594 の「残り」。破壊的変更を v1.X.0 で出してよいことは、オーナーの回答による）。`complete`・`fail` は
     * 行の値になる日時を書く口で、Postgres は下限より前を書けない（`22008`）。以前の `@mnemora/postgres` は、形の崩れた `jobId` では
     * 静かに返していた。下限ちょうどは書ける（対照。断りすぎる実装を縛る）。
     */
    const BELOW_FLOOR_AT = new Date(Date.UTC(-4713, 10, 24) - 1);
    const FLOOR_AT = new Date(Date.UTC(-4713, 10, 24));
    for (const how of ["complete", "fail"] as const) {
      for (const [label, jobId] of [
        ["形の崩れた jobId", "does-not-exist"],
        ["uuid の形だが存在しない jobId", "11111111-1111-4111-8111-111111111111"],
        ["実在の jobId", undefined],
      ] as const) {
        it(`${how} は ${label} でも、opts.at が timestamptz の下限より前なら例外を投げ、行に触れない`, async () => {
          const store = await createStore();
          const ctx: Ctx = { tenantId: "tenant-1" };
          const job = jobId === undefined ? await seedJob(ctx, { kind: "extract" }) : undefined;
          const id = job?.id ?? jobId!;
          const attempts = job?.attempts ?? 0;

          const call =
            how === "complete"
              ? store.complete(ctx, id, attempts, { at: BELOW_FLOOR_AT })
              : store.fail(ctx, id, "simulated failure", attempts, { at: BELOW_FLOOR_AT });
          await expect(call).rejects.toThrow();
          if (job !== undefined && peekJob) {
            const after = await peekJob(ctx, job.id);
            expect(after?.completedAt ?? null).toBeNull();
            expect(after?.failedAt ?? null).toBeNull();
          }
        });
      }

      it(`${how} は opts.at が timestamptz の下限ちょうどなら、例外にせず通る（実在の jobId）`, async () => {
        const store = await createStore();
        const ctx: Ctx = { tenantId: "tenant-1" };
        const job = await seedJob(ctx, { kind: "extract" });

        await (how === "complete"
          ? store.complete(ctx, job.id, job.attempts, { at: FLOOR_AT })
          : store.fail(ctx, job.id, "simulated failure", job.attempts, { at: FLOOR_AT }));
      });
    }

    /** 渡した `at` の Date を、store が参照のまま持たない（後から呼び手が書き換えても行は変わらない）。 */
    (peekJob ? it : it.skip)(
      "complete/fail に渡した opts.at を、呼び手が後から書き換えても、completedAt/failedAt は変わらない",
      async () => {
        const store = await createStore();
        const ctx: Ctx = { tenantId: "tenant-1" };
        const completeJob = await seedJob(ctx, { kind: "extract" });
        const failJob = await seedJob(ctx, { kind: "embed" });
        const completeAt = new Date("2020-01-01T00:00:00.000Z");
        const failAt = new Date("2020-02-02T00:00:00.000Z");

        await store.complete(ctx, completeJob.id, completeJob.attempts, { at: completeAt });
        await store.fail(ctx, failJob.id, "simulated failure", failJob.attempts, { at: failAt });
        completeAt.setTime(0);
        failAt.setTime(0);

        const completedAfter = await peekJob!(ctx, completeJob.id);
        const failedAfter = await peekJob!(ctx, failJob.id);
        expect(completedAfter?.completedAt?.toISOString()).toBe("2020-01-01T00:00:00.000Z");
        expect(failedAfter?.failedAt?.toISOString()).toBe("2020-02-02T00:00:00.000Z");
      },
    );

    /**
     * `text` は NUL（U+0000）を保存できない（Postgres は 22021）。`fail` の `error` に NUL が混ざっても
     * 落とさず、目に見える6文字の `\\u0000` に置き換えて `lastError` に残す（`PostgresOutboxStore.fail`）。
     */
    (peekJob ? it : it.skip)(
      "fail は error の NUL を、6文字の \\u0000 に置き換えて lastError に残す",
      async () => {
        const store = await createStore();
        const ctx: Ctx = { tenantId: "tenant-1" };
        const job = await seedJob(ctx, { kind: "extract" });

        await store.fail(ctx, job.id, "bad\u0000output\u0000", job.attempts);

        const after = await peekJob!(ctx, job.id);
        expect(after?.lastError).toBe("bad\\u0000output\\u0000");
      },
    );

    /** ⭐ 非破壊の確認: `opts` を省略すると、今日どおり壁時計になる。 */
    (peekJob ? it : it.skip)(
      "complete/fail は opts を省略すると、completedAt/failedAt は壁時計になる",
      async () => {
        const store = await createStore();
        const ctx: Ctx = { tenantId: "tenant-1" };
        const completeJob = await seedJob(ctx, { kind: "extract" });
        const failJob = await seedJob(ctx, { kind: "embed" });
        const startedAt = Date.now();

        await store.complete(ctx, completeJob.id, completeJob.attempts);
        await store.fail(ctx, failJob.id, "simulated failure", failJob.attempts);

        const completedAfter = await peekJob!(ctx, completeJob.id);
        const failedAfter = await peekJob!(ctx, failJob.id);
        expect(completedAfter?.completedAt?.getTime()).toBeGreaterThanOrEqual(startedAt - 1000);
        expect(completedAfter?.completedAt?.getTime()).toBeLessThanOrEqual(Date.now() + 1000);
        expect(failedAfter?.failedAt?.getTime()).toBeGreaterThanOrEqual(startedAt - 1000);
        expect(failedAfter?.failedAt?.getTime()).toBeLessThanOrEqual(Date.now() + 1000);
      },
    );

    // -------------------------------------------------------------------
    // Issue #1412 A8（Issue #1238 棚卸し、ADR 0373）: 渡した入力・返した値が、
    // store の中の実体と切り離されている。`peekJob` を持つ adapter だけを対象にする
    // ——`claimBatch` で claim した後の行を、claim 以外の経路で読み直す必要があるため
    // （`peekJob` の doc コメントと同じ理由）。
    // -------------------------------------------------------------------

    (peekJob ? it : it.skip)(
      "claimBatch が返した payload を呼び手が書き換えても、store 側の行は変わらない（Issue #1412 A8）",
      async () => {
        const store = await createStore();
        const ctx: Ctx = { tenantId: "tenant-1" };
        const job = await seedJob(ctx, {
          kind: "extract",
          payload: { observationId: "obs-1", tags: ["original-tag"] },
        });

        const claimed = await store.claimBatch(ctx, {
          limit: 10,
          now: new Date(),
          claimedBy: "worker-1",
          leaseMs: DEFAULT_LEASE_MS,
        });
        const claimedJob = claimed.find((j) => j.id === job.id)!;
        (claimedJob.payload as Record<string, unknown>).observationId = "mutated-by-caller";
        (claimedJob.payload.tags as string[]).push("mutated-by-caller");

        const after = await peekJob!(ctx, job.id);
        expect(after?.payload).toEqual({ observationId: "obs-1", tags: ["original-tag"] });
      },
    );

    it("complete は存在しないジョブ id に対して例外を投げない（べき等な終端更新、expectedAttempts の値に関わらず）", async () => {
      const store = await createStore();
      const ctx: Ctx = { tenantId: "tenant-1" };
      await expect(store.complete(ctx, "does-not-exist", 0)).resolves.not.toThrow();
      await expect(store.complete(ctx, "does-not-exist", 999)).resolves.not.toThrow();
    });

    it("fail は存在しないジョブ id に対して例外を投げない（べき等な終端更新、expectedAttempts の値に関わらず）", async () => {
      const store = await createStore();
      const ctx: Ctx = { tenantId: "tenant-1" };
      await expect(store.fail(ctx, "does-not-exist", "boom", 0)).resolves.not.toThrow();
      await expect(store.fail(ctx, "does-not-exist", "boom", 999)).resolves.not.toThrow();
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

    // 別テナントの ctx からの `complete` / `fail` は、その行に触れない・存在も知らせない。
    // 「触れない」は、リースが切れた後に持ち主が再 claim できる（＝終端が付いていない）ことで測る。
    // 「知らせない」は、attempts が一致しない呼び出しでも `OutboxLeaseConflictError` にならず
    // 存在しない id と同じ無言の no-op になることで測る。
    for (const how of ["complete", "fail"] as const) {
      const terminate = (
        store: OutboxStore,
        ctx: Ctx,
        jobId: string,
        attempts: number,
      ): Promise<void> =>
        how === "complete"
          ? store.complete(ctx, jobId, attempts)
          : store.fail(ctx, jobId, "cross-tenant", attempts);

      it(`${how} は別テナントの ctx からは、同じ id と attempts を指定してもそのジョブに終端を付けない`, async () => {
        const store = await createStore();
        const ctxA: Ctx = { tenantId: "tenant-a" };
        const ctxB: Ctx = { tenantId: "tenant-b" };
        const job = await seedJob(ctxA, { kind: "extract" });
        const claimed = await store.claimBatch(ctxA, {
          limit: 10,
          now: new Date(),
          claimedBy: "worker-a",
          leaseMs: DEFAULT_LEASE_MS,
        });
        const claimedJob = claimed.find((j) => j.id === job.id)!;

        await expect(terminate(store, ctxB, job.id, claimedJob.attempts)).resolves.toBeUndefined();

        const reclaimed = await store.claimBatch(ctxA, {
          limit: 10,
          now: new Date(Date.now() + DEFAULT_LEASE_MS + 1),
          claimedBy: "worker-a2",
          leaseMs: DEFAULT_LEASE_MS,
        });
        expect(reclaimed.map((j) => j.id)).toContain(job.id);
      });

      it(`${how} は別テナントの ctx からは、attempts が一致しなくても OutboxLeaseConflictError にならない（存在しない id と同じ扱い）`, async () => {
        const store = await createStore();
        const ctxA: Ctx = { tenantId: "tenant-a" };
        const ctxB: Ctx = { tenantId: "tenant-b" };
        const job = await seedJob(ctxA, { kind: "extract" });
        const claimed = await store.claimBatch(ctxA, {
          limit: 10,
          now: new Date(),
          claimedBy: "worker-a",
          leaseMs: DEFAULT_LEASE_MS,
        });
        const claimedJob = claimed.find((j) => j.id === job.id)!;

        await expect(
          terminate(store, ctxB, job.id, claimedJob.attempts - 1),
        ).resolves.toBeUndefined();
      });
    }

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

    // -------------------------------------------------------------------
    // complete / fail の CAS（ADR 0142, Issue #233）
    // -------------------------------------------------------------------

    it("complete は claim 時の attempts と一致すれば成功する", async () => {
      const store = await createStore();
      const ctx: Ctx = { tenantId: "tenant-1" };
      const job = await seedJob(ctx, { kind: "extract" });

      const claimed = await store.claimBatch(ctx, {
        limit: 10,
        now: new Date(),
        claimedBy: "worker-1",
        leaseMs: DEFAULT_LEASE_MS,
      });
      const claimedJob = claimed.find((j) => j.id === job.id)!;

      await expect(store.complete(ctx, job.id, claimedJob.attempts)).resolves.not.toThrow();
    });

    it("complete は attempts が一致しないと OutboxLeaseConflictError を投げ、行を変更しない", async () => {
      const store = await createStore();
      const ctx: Ctx = { tenantId: "tenant-1" };
      const job = await seedJob(ctx, { kind: "extract" });

      const claimed = await store.claimBatch(ctx, {
        limit: 10,
        now: new Date(),
        claimedBy: "worker-1",
        leaseMs: DEFAULT_LEASE_MS,
      });
      const claimedJob = claimed.find((j) => j.id === job.id)!;
      const wrongAttempts = claimedJob.attempts - 1;

      const error = await store.complete(ctx, job.id, wrongAttempts).catch((err: unknown) => err);
      expectStoreError(error, isOutboxLeaseConflictError, "OutboxLeaseConflictError");
      const conflict = error as OutboxLeaseConflictError;
      expect(conflict.jobId).toBe(job.id);
      expect(conflict.expectedAttempts).toBe(wrongAttempts);
      expect(conflict.observedAttempts).toBe(claimedJob.attempts);

      // 弾かれたので、行は complete されていないまま——claimBatch にはまだ現れないが
      // (リースが有効なので)、少なくとも上の complete によって completedAt が
      // 付いていないことを、再度 claim して確認する(リースを切らして再取得)。
      const reclaimed = await store.claimBatch(ctx, {
        limit: 10,
        now: new Date(Date.now() + DEFAULT_LEASE_MS + 1),
        claimedBy: "worker-2",
        leaseMs: DEFAULT_LEASE_MS,
      });
      expect(reclaimed.map((j) => j.id)).toContain(job.id);
    });

    it("fail は attempts が一致しないと OutboxLeaseConflictError を投げる", async () => {
      const store = await createStore();
      const ctx: Ctx = { tenantId: "tenant-1" };
      const job = await seedJob(ctx, { kind: "extract" });

      const claimed = await store.claimBatch(ctx, {
        limit: 10,
        now: new Date(),
        claimedBy: "worker-1",
        leaseMs: DEFAULT_LEASE_MS,
      });
      const claimedJob = claimed.find((j) => j.id === job.id)!;
      const wrongAttempts = claimedJob.attempts - 1;

      const error = await store
        .fail(ctx, job.id, "boom", wrongAttempts)
        .catch((err: unknown) => err);
      expectStoreError(error, isOutboxLeaseConflictError, "OutboxLeaseConflictError");
      const conflict = error as OutboxLeaseConflictError;
      expect(conflict.jobId).toBe(job.id);
      expect(conflict.expectedAttempts).toBe(wrongAttempts);
      expect(conflict.observedAttempts).toBe(claimedJob.attempts);
    });

    it("⭐ 再現(Issue #233): リース失効後に再claim・completeされたジョブを、遅れたワーカーのfail/completeが上書きできない", async () => {
      const store = await createStore();
      const ctx: Ctx = { tenantId: "tenant-1" };
      const base = new Date();
      const leaseMs = 1000;
      const job = await seedJob(ctx, { kind: "extract", availableAt: base });

      // ワーカーA が claim する(リース取得)。
      const claimA = await store.claimBatch(ctx, {
        limit: 10,
        now: base,
        claimedBy: "worker-A",
        leaseMs,
      });
      const jobAsClaimedByA = claimA.find((j) => j.id === job.id)!;
      expect(jobAsClaimedByA).toBeDefined();

      // リースが切れる(時計を進める)。
      const afterExpiry = new Date(base.getTime() + leaseMs);

      // ワーカーB が同じジョブを再 claim して complete する。
      const claimB = await store.claimBatch(ctx, {
        limit: 10,
        now: afterExpiry,
        claimedBy: "worker-B",
        leaseMs,
      });
      const jobAsClaimedByB = claimB.find((j) => j.id === job.id)!;
      expect(jobAsClaimedByB).toBeDefined();
      expect(jobAsClaimedByB.attempts).toBeGreaterThan(jobAsClaimedByA.attempts);
      await store.complete(ctx, job.id, jobAsClaimedByB.attempts);

      // ワーカーA が遅れて、自分が claim した時点の attempts で fail を呼ぶ
      // ——自分のリースはもう有効ではないので、弾かれるはず。
      const staleCall = store
        .fail(ctx, job.id, "worker-A: stale failure", jobAsClaimedByA.attempts)
        .catch((err: unknown) => err);
      const error = await staleCall;
      expectStoreError(error, isOutboxLeaseConflictError, "OutboxLeaseConflictError");

      // 上の `expectStoreError(error, isOutboxLeaseConflictError, "OutboxLeaseConflictError")` は
      // 「Aのfailが実際に(SQL/状態変更として)実行される前に弾かれた」ことの証拠になる
      // ——本実装はどちらも「CASが一致しない場合、対象行への書き込みを一切行わずに
      // 例外を投げる」形（`attempts = expectedAttempts` を満たす行が無ければ0行更新、
      // または一致しないことを確認してから投げる）にしてあるため、例外が飛んだ時点で
      // Aのfailは行に触れていない。これが本 Issue #233 の核心（遅れたワーカーが新しい
      // ワーカーの結果を「黙って上書きする」ことの直接の否定）である。
      // 追加の確認として、ジョブが(Bのcompleteのまま)終端状態を保っていることを、
      // さらにリースを切らして再claimできない(＝終端のまま)ことでも確かめる。
      const finalCheck = await store.claimBatch(ctx, {
        limit: 10,
        now: new Date(afterExpiry.getTime() + leaseMs + 1),
        claimedBy: "worker-3",
        leaseMs,
      });
      expect(finalCheck.map((j) => j.id)).not.toContain(job.id);
    });

    // 本物の並行で二重 claim を検査する歯（ADR 0206、Issue 205 の1本目）。
    // `supportsRealConcurrency: true` を渡さない adapter では `it.skip` になる——
    // ⟹ 「測っていない」が緑ではなく skip として見える。
    const maybeConcurrentIt = supportsRealConcurrency ? it : it.skip;

    maybeConcurrentIt("並行に撃った claimBatch が、同じジョブを二重に claim しない", async () => {
      const store = await createStore();

      let duplicateRounds = 0;
      const samples: string[][] = [];
      for (let round = 0; round < CONCURRENT_CLAIM_ROUNDS; round++) {
        // ラウンドごとにテナントを変える。claim 可能なジョブをちょうど1本にして
        // `limit: 1` で撃つと、二重 claim が起きたときに「同じ id が複数の呼び出しに
        // 返る」という形で必ず表に出る。
        const ctx: Ctx = { tenantId: `concurrent-claim-${round}` };
        await seedJob(ctx, { kind: "extract" });

        const now = new Date();
        const batches = await Promise.all(
          Array.from({ length: CONCURRENT_CLAIM_CONCURRENCY }, (_, worker) =>
            store.claimBatch(ctx, {
              limit: 1,
              now,
              claimedBy: `concurrent-worker-${worker}`,
              leaseMs: DEFAULT_LEASE_MS,
            }),
          ),
        );

        const claimedIds = batches.flatMap((batch) => batch.map((job) => job.id));
        // ⛔ 「合計が1本である」ことは検査しない。競合下では `SKIP LOCKED` 相当の実装が
        // 「ロック中の行を、この呼び出しでは単に飛ばす」だけで、どれか1本が必ず拾う保証は
        // していない【実測 2026-09-17: ジョブ5本・limit=3・4並行で、合計が5未満になる
        // ラウンドが出た】。拾い残しは次の tick が拾う——設計上の許容範囲であって故障では
        // ない。⟹ ここで検査してよいのは「**二重に返らない**」ことだけである。
        if (new Set(claimedIds).size !== claimedIds.length) {
          duplicateRounds++;
          if (samples.length < 3) {
            samples.push(claimedIds);
          }
        }
      }

      // 失敗時に「何ラウンドで、どの id が重複したか」が出るように、まとめて比較する。
      expect({ duplicateRounds, samples }).toEqual({ duplicateRounds: 0, samples: [] });
    });

    // -------------------------------------------------------------------
    // eraseTenant（Issue #1207 / ADR 0383: テナント消去、任意メソッド）
    // -------------------------------------------------------------------
    if (supportsEraseTenant) {
      it("eraseTenant はテナントの outbox 行を消し、他テナントは無傷のまま残す", async () => {
        const store = await createStore();
        const ctxA: Ctx = { tenantId: "erase-tenant-a" };
        const ctxB: Ctx = { tenantId: "erase-tenant-b" };
        await seedJob(ctxA, { kind: "extract" });
        await seedJob(ctxA, { kind: "embed" });
        await seedJob(ctxB, { kind: "extract" });

        const result = await store.eraseTenant!(ctxA, { limit: 1000 });
        expect(result.deleted).toBeGreaterThan(0);
        expect(result.reachedLimit).toBe(false);

        const claimedA = await store.claimBatch(ctxA, {
          limit: 10,
          now: new Date(),
          claimedBy: "worker-1",
          leaseMs: DEFAULT_LEASE_MS,
        });
        expect(claimedA).toEqual([]);

        const claimedB = await store.claimBatch(ctxB, {
          limit: 10,
          now: new Date(),
          claimedBy: "worker-1",
          leaseMs: DEFAULT_LEASE_MS,
        });
        expect(claimedB.length).toBeGreaterThanOrEqual(1);
      });

      it("eraseTenant は limit に達すると reachedLimit: true を返し、同じ opts で呼び直すと最終的に全部消える", async () => {
        const store = await createStore();
        const ctx: Ctx = { tenantId: "erase-tenant-limit" };
        for (let i = 0; i < 5; i++) {
          await seedJob(ctx, { kind: "extract" });
        }

        const opts = { limit: 2 };
        let result = await store.eraseTenant!(ctx, opts);
        expect(result.reachedLimit).toBe(true);

        let guard = 0;
        while (result.reachedLimit) {
          if (++guard > 20) {
            throw new Error(
              "eraseTenant did not converge after 20 retries — possible infinite loop",
            );
          }
          result = await store.eraseTenant!(ctx, opts);
        }

        const claimed = await store.claimBatch(ctx, {
          limit: 10,
          now: new Date(),
          claimedBy: "worker-1",
          leaseMs: DEFAULT_LEASE_MS,
        });
        expect(claimed).toEqual([]);
      });

      it("eraseTenant は dryRun: true のとき、削除件数を返すが実際には何も消さない", async () => {
        const store = await createStore();
        const ctx: Ctx = { tenantId: "erase-tenant-dry-run" };
        await seedJob(ctx, { kind: "extract" });

        const result = await store.eraseTenant!(ctx, { limit: 1000, dryRun: true });
        expect(result.deleted).toBeGreaterThan(0);

        const claimed = await store.claimBatch(ctx, {
          limit: 10,
          now: new Date(),
          claimedBy: "worker-1",
          leaseMs: DEFAULT_LEASE_MS,
        });
        expect(claimed.length).toBeGreaterThanOrEqual(1);
      });

      it("eraseTenant は dryRun: true のとき、別テナントの行を件数に数えない", async () => {
        const store = await createStore();
        const ctxA: Ctx = { tenantId: "erase-tenant-dry-a" };
        const ctxB: Ctx = { tenantId: "erase-tenant-dry-b" };
        await seedJob(ctxA, { kind: "extract" });
        await seedJob(ctxA, { kind: "embed" });
        await seedJob(ctxB, { kind: "extract" });
        await seedJob(ctxB, { kind: "embed" });
        await seedJob(ctxB, { kind: "extract" });

        const result = await store.eraseTenant!(ctxA, { limit: 1000, dryRun: true });
        expect(result).toEqual({ deleted: 2, reachedLimit: false });
      });

      it("eraseTenant は別テナントの行が先に積まれていても、limit の枠を対象テナントの行に使う", async () => {
        const store = await createStore();
        // 別テナントの tenantId は対象より辞書順で先、件数は多く、挿入も先にする。
        const ctxOther: Ctx = { tenantId: "erase-tenant-crowd-0-other" };
        const ctxTarget: Ctx = { tenantId: "erase-tenant-crowd-1-target" };
        const otherCount = 6;
        const targetCount = 3;
        for (let i = 0; i < otherCount; i++) {
          await seedJob(ctxOther, { kind: "extract" });
        }
        for (let i = 0; i < targetCount; i++) {
          await seedJob(ctxTarget, { kind: "extract" });
        }

        // limit 1 で reachedLimit が false になるまで呼ぶ（上限付き）。
        // 正しい実装の結果は、行を返す順序に依らない。tenant の条件を外した実装を捕まえるかどうかは
        // 行を返す順序に依り、その保証は無い（この配置は、捕まえやすくするためのもの）。
        let totalDeleted = 0;
        let calls = 0;
        const maxCalls = targetCount + 2;
        for (; calls < maxCalls; calls++) {
          const result = await store.eraseTenant!(ctxTarget, { limit: 1 });
          totalDeleted += result.deleted;
          if (!result.reachedLimit) break;
        }
        expect(calls).toBeLessThan(maxCalls);
        expect(totalDeleted).toBe(targetCount);

        const claimedTarget = await store.claimBatch(ctxTarget, {
          limit: 100,
          now: new Date(),
          claimedBy: "worker-1",
          leaseMs: DEFAULT_LEASE_MS,
        });
        expect(claimedTarget).toHaveLength(0);
        const claimedOther = await store.claimBatch(ctxOther, {
          limit: 100,
          now: new Date(),
          claimedBy: "worker-1",
          leaseMs: DEFAULT_LEASE_MS,
        });
        expect(claimedOther).toHaveLength(otherCount);
      });
    } else {
      it("eraseTenant は任意メソッドであり、この adapter は実装していない", async () => {
        const store = await createStore();
        expect(store.eraseTenant).toBeUndefined();
      });
    }

    // -------------------------------------------------------------------
    // purgeCompletedJobs（ADR 0404）。🔴 任意メソッド——`supportsPurgeCompletedJobs` の3状態。
    // -------------------------------------------------------------------

    /**
     * ジョブを1件積み、claim して、終端（`complete` または `fail`）を `at` で付ける。
     * 直前までの行はすべて claim 済みか未来の `availableAt` なので、ここで claim できるのは
     * 積んだばかりの1件だけである。
     */
    async function seedTerminal(
      store: OutboxStore,
      ctx: Ctx,
      how: "complete" | "fail",
      at: Date,
    ): Promise<OutboxJobRecord> {
      const seeded = await seedJob(ctx, { kind: "embed" });
      const claimed = await store.claimBatch(ctx, {
        limit: 100,
        now: new Date(),
        claimedBy: "purge-fixture",
        leaseMs: DEFAULT_LEASE_MS,
      });
      const mine = claimed.find((j) => j.id === seeded.id);
      if (!mine) throw new Error("seedTerminal: 積んだジョブを claim できなかった");
      if (how === "complete") {
        await store.complete(ctx, mine.id, mine.attempts, { at });
      } else {
        await store.fail(ctx, mine.id, "purge-fixture failure", mine.attempts, { at });
      }
      return mine;
    }

    const FAR_FUTURE = new Date("2999-01-01T00:00:00.000Z");

    if (supportsPurgeCompletedJobs === true) {
      (peekJob ? it : it.skip)(
        "purgeCompletedJobs は completedAt < olderThan の完了行だけを消す（境界 completedAt === olderThan は対象外）",
        async () => {
          const store = await createStore();
          expect(typeof store.purgeCompletedJobs).toBe("function");
          const ctx: Ctx = { tenantId: "tenant-1" };
          const cutoff = new Date("2025-06-01T00:00:00.000Z");
          const old = await seedTerminal(
            store,
            ctx,
            "complete",
            new Date("2025-05-31T23:59:59.999Z"),
          );
          const veryOld = await seedTerminal(
            store,
            ctx,
            "complete",
            new Date("2020-01-01T00:00:00.000Z"),
          );
          const boundary = await seedTerminal(store, ctx, "complete", cutoff);
          const fresh = await seedTerminal(
            store,
            ctx,
            "complete",
            new Date("2025-06-01T00:00:00.001Z"),
          );

          const result = await store.purgeCompletedJobs!(ctx, { olderThan: cutoff, limit: 10 });

          expect(result.purged).toBe(2);
          expect(result.reachedLimit).toBe(false);
          expect(result.dryRun).toBe(false);
          expect(result.oldestPurgedAt).toEqual(new Date("2020-01-01T00:00:00.000Z"));
          expect(result.newestPurgedAt).toEqual(new Date("2025-05-31T23:59:59.999Z"));
          expect(await peekJob!(ctx, old.id)).toBeNull();
          expect(await peekJob!(ctx, veryOld.id)).toBeNull();
          expect(await peekJob!(ctx, boundary.id)).not.toBeNull();
          expect(await peekJob!(ctx, fresh.id)).not.toBeNull();
        },
      );

      (peekJob ? it : it.skip)(
        "purgeCompletedJobs は完了していない行を、どれだけ古くても決して消さない（failed・claim 中・未処理）",
        async () => {
          const store = await createStore();
          expect(typeof store.purgeCompletedJobs).toBe("function");
          const ctx: Ctx = { tenantId: "tenant-1" };
          // failed_at が極端に古い行——「failed は完了ではない」（ADR 0404）。
          const failed = await seedTerminal(
            store,
            ctx,
            "fail",
            new Date("2000-01-01T00:00:00.000Z"),
          );
          // claim 済みで、まだ終端が付いていない行。
          const claimedOnly = await seedJob(ctx, { kind: "embed" });
          const claimed = await store.claimBatch(ctx, {
            limit: 100,
            now: new Date(),
            claimedBy: "purge-fixture",
            leaseMs: DEFAULT_LEASE_MS,
          });
          expect(claimed.map((j) => j.id)).toContain(claimedOnly.id);
          // 未処理（未来の availableAt なので claim されない）の行。
          const pending = await seedJob(ctx, {
            kind: "embed",
            availableAt: new Date("2999-01-01T00:00:00.000Z"),
          });
          // 完了した古い行が1件だけ、対照として在る（陽性対照——この行は消える）。
          const done = await seedTerminal(
            store,
            ctx,
            "complete",
            new Date("2000-01-01T00:00:00.000Z"),
          );

          const result = await store.purgeCompletedJobs!(ctx, {
            olderThan: FAR_FUTURE,
            limit: 100,
          });

          expect(result.purged).toBe(1);
          expect(await peekJob!(ctx, done.id)).toBeNull();
          const failedAfter = await peekJob!(ctx, failed.id);
          expect(failedAfter).not.toBeNull();
          expect(failedAfter?.failedAt).toEqual(new Date("2000-01-01T00:00:00.000Z"));
          expect(await peekJob!(ctx, claimedOnly.id)).not.toBeNull();
          expect(await peekJob!(ctx, pending.id)).not.toBeNull();
        },
      );

      (peekJob ? it : it.skip)("purgeCompletedJobs はテナント越境しない", async () => {
        const store = await createStore();
        expect(typeof store.purgeCompletedJobs).toBe("function");
        const ctx1: Ctx = { tenantId: "tenant-1" };
        const ctx2: Ctx = { tenantId: "tenant-2" };
        const longAgo = new Date("2020-01-01T00:00:00.000Z");
        const mine = await seedTerminal(store, ctx1, "complete", longAgo);
        const theirs = await seedTerminal(store, ctx2, "complete", longAgo);

        const result = await store.purgeCompletedJobs!(ctx1, {
          olderThan: new Date("2025-01-01T00:00:00.000Z"),
          limit: 10,
        });

        expect(result.purged).toBe(1);
        expect(await peekJob!(ctx1, mine.id)).toBeNull();
        expect(await peekJob!(ctx2, theirs.id)).not.toBeNull();
      });

      (peekJob ? it : it.skip)(
        "purgeCompletedJobs は limit を超えた対象を reachedLimit: true で知らせ、古い順に消し、超えない呼び出しでは false になる",
        async () => {
          const store = await createStore();
          expect(typeof store.purgeCompletedJobs).toBe("function");
          const ctx: Ctx = { tenantId: "tenant-1" };
          const jobs: OutboxJobRecord[] = [];
          for (let i = 0; i < 5; i++) {
            jobs.push(
              await seedTerminal(store, ctx, "complete", new Date(Date.UTC(2020, 0, 1 + i))),
            );
          }
          const olderThan = new Date("2025-01-01T00:00:00.000Z");

          const first = await store.purgeCompletedJobs!(ctx, { olderThan, limit: 3 });
          expect(first.purged).toBe(3);
          expect(first.reachedLimit).toBe(true);
          expect(await peekJob!(ctx, jobs[0]!.id)).toBeNull();
          expect(await peekJob!(ctx, jobs[2]!.id)).toBeNull();
          expect(await peekJob!(ctx, jobs[3]!.id)).not.toBeNull();
          expect(first.newestPurgedAt).toEqual(new Date(Date.UTC(2020, 0, 3)));

          // 残りちょうど limit 件は reachedLimit: false（purged === limit からの推測に頼らせない）。
          const second = await store.purgeCompletedJobs!(ctx, { olderThan, limit: 2 });
          expect(second.purged).toBe(2);
          expect(second.reachedLimit).toBe(false);
        },
      );

      (peekJob ? it : it.skip)(
        "purgeCompletedJobs は dryRun のとき1行も消さず、消していたら何が起きたかを返す",
        async () => {
          const store = await createStore();
          expect(typeof store.purgeCompletedJobs).toBe("function");
          const ctx: Ctx = { tenantId: "tenant-1" };
          const job = await seedTerminal(
            store,
            ctx,
            "complete",
            new Date("2020-01-01T00:00:00.000Z"),
          );

          const result = await store.purgeCompletedJobs!(ctx, {
            olderThan: new Date("2025-01-01T00:00:00.000Z"),
            limit: 10,
            dryRun: true,
          });

          expect(result.dryRun).toBe(true);
          expect(result.purged).toBe(1);
          expect(result.oldestPurgedAt).toEqual(new Date("2020-01-01T00:00:00.000Z"));
          expect(await peekJob!(ctx, job.id)).not.toBeNull();
        },
      );

      // 別テナントの完了行が古く・先に在る状況で、対象テナントの結果が別テナントの行に
      // 侵されないこと（件数・reachedLimit・古さの端）。
      (peekJob ? it : it.skip)(
        "purgeCompletedJobs は dryRun のとき、別テナントの完了行を件数・時刻の端に数えない",
        async () => {
          const store = await createStore();
          expect(typeof store.purgeCompletedJobs).toBe("function");
          const ctxA: Ctx = { tenantId: "tenant-a" };
          const ctxB: Ctx = { tenantId: "tenant-b" };
          await seedTerminal(store, ctxB, "complete", new Date("2019-01-01T00:00:00.000Z"));
          await seedTerminal(store, ctxB, "complete", new Date("2019-01-02T00:00:00.000Z"));
          await seedTerminal(store, ctxA, "complete", new Date("2020-01-01T00:00:00.000Z"));
          await seedTerminal(store, ctxA, "complete", new Date("2020-01-02T00:00:00.000Z"));

          const result = await store.purgeCompletedJobs!(ctxA, {
            olderThan: new Date("2025-01-01T00:00:00.000Z"),
            limit: 2,
            dryRun: true,
          });

          expect(result.purged).toBe(2);
          expect(result.reachedLimit).toBe(false);
          expect(result.oldestPurgedAt).toEqual(new Date("2020-01-01T00:00:00.000Z"));
          expect(result.newestPurgedAt).toEqual(new Date("2020-01-02T00:00:00.000Z"));
        },
      );

      (peekJob ? it : it.skip)(
        "purgeCompletedJobs は別テナントの完了行のほうが古くても、limit の枠を対象テナントの行に使う",
        async () => {
          const store = await createStore();
          expect(typeof store.purgeCompletedJobs).toBe("function");
          const ctxA: Ctx = { tenantId: "tenant-a" };
          const ctxB: Ctx = { tenantId: "tenant-b" };
          const theirs1 = await seedTerminal(
            store,
            ctxB,
            "complete",
            new Date("2019-01-01T00:00:00.000Z"),
          );
          const theirs2 = await seedTerminal(
            store,
            ctxB,
            "complete",
            new Date("2019-01-02T00:00:00.000Z"),
          );
          const mine1 = await seedTerminal(
            store,
            ctxA,
            "complete",
            new Date("2020-01-01T00:00:00.000Z"),
          );
          const mine2 = await seedTerminal(
            store,
            ctxA,
            "complete",
            new Date("2020-01-02T00:00:00.000Z"),
          );

          const result = await store.purgeCompletedJobs!(ctxA, {
            olderThan: new Date("2025-01-01T00:00:00.000Z"),
            limit: 2,
          });

          expect(result.purged).toBe(2);
          expect(result.reachedLimit).toBe(false);
          expect(await peekJob!(ctxA, mine1.id)).toBeNull();
          expect(await peekJob!(ctxA, mine2.id)).toBeNull();
          expect(await peekJob!(ctxB, theirs1.id)).not.toBeNull();
          expect(await peekJob!(ctxB, theirs2.id)).not.toBeNull();
        },
      );
    } else if (supportsPurgeCompletedJobs === false) {
      it("purgeCompletedJobs は任意メソッドであり、この adapter は実装していない", async () => {
        const store = await createStore();
        expect(store.purgeCompletedJobs).toBeUndefined();
      });
    } else {
      it(`⚠ 未検査: supportsPurgeCompletedJobs が指定されていない — adapter "${name}" に対して purgeCompletedJobs の歯は検査していない`, () => {
        expect(supportsPurgeCompletedJobs).toBeUndefined();
      });
    }

    // 保存の形で区別できない識別子は、入口で断る（ADR 0423）
    for (const [label, value] of MALFORMED_IDENTIFIER_CASES) {
      it(`${label}を含む識別子は、ctx.tenantId でも ctx.subjectId でも断る`, async () => {
        const store = await createStore();
        const calls: Array<[string, () => Promise<unknown>]> = [
          [
            "claimBatch の ctx.tenantId",
            () =>
              store.claimBatch(
                { tenantId: value },
                { kinds: ["embed"], limit: 1, now: new Date(), claimedBy: "wf", leaseMs: 60_000 },
              ),
          ],
          [
            "claimBatch の ctx.subjectId",
            () =>
              store.claimBatch(
                { tenantId: "tenant-wf", subjectId: value },
                { kinds: ["embed"], limit: 1, now: new Date(), claimedBy: "wf", leaseMs: 60_000 },
              ),
          ],
        ];
        for (const [where, call] of calls) {
          await expectMalformedIdentifierRejection(call(), `${label} / ${where}`, value);
        }
      });
    }
  });
}
