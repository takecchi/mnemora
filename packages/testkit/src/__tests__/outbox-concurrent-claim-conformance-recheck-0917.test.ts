import { beforeAll, describe, expect, it } from "vitest";
import type { RunnerTask } from "vitest";
import type { ClaimOutboxJobsOptions, Ctx, OutboxJobRecord, OutboxStore } from "@mnemora/core";
import { InMemoryOutboxStore } from "../__fixtures__/in-memory-outbox-store.js";
import { describeOutboxStoreConformance } from "../outbox-store-conformance.js";
import { inMemoryOutboxStoreConformanceOptions } from "./in-memory-conformance-options.js";

/**
 * Issue #1812（09/17 マージ分の確かめ直し）まとまり G5: PR #450（ADR 0206）の
 * 「並行に撃った claimBatch が、同じジョブを二重に claim しない」歯の、testkit の側の歯。
 *
 * in-memory 実装は本体に `await` を持たず逐次化されるので、`supportsRealConcurrency` を
 * 渡さない（ADR 0206）。⟹ 並行の `it` は in-memory では `it.skip` で、`outbox-store-conformance.ts`
 * の並行の歯そのものは、いまの in-memory の試験では**一度も走っていない**。
 * この試験は、**yield 点を持つ（＝本当に重なる）偽の store** に `supportsRealConcurrency: true`
 * を渡して並行の歯を走らせ、次を縛る。
 *   - 約束どおりに動く store では緑（二重 claim しない）。合計が1本でなくても（取りこぼしても）緑
 *     ——ADR 0206「合計は検査しない」。
 *   - 二重 claim する store では赤。⟹ 判定が効いていること。
 *   - 並行数8・ラウンド数10を下回ると、二重 claim を見逃す store が出る（ADR 0206「減らさないこと」）。
 *   - フラグが省略/false なら `it.skip`、true なら走る（ADR 0206）。
 *   - in-memory の設定は `supportsRealConcurrency` を渡さない（ADR 0206、in-memory-fixtures.conformance.test.ts の注記）。
 *
 * ⚠ 二重 claim する store に対しては「並行の `it` が落ちること」を期待する。vitest の `fails`
 * を、実行の直前に該当の task へ立てる（`outbox-store-conformance.ts` は触らない）。
 * `fails` は「何かで落ちれば緑」なので、落ちた理由までは見ていない（理由は `stale` の store
 * 以外の歯が緑であること＝その store が逐次では正しく動くことで間接に支えている）。
 */

const CONCURRENT_IT_NAME = "並行に撃った claimBatch が、同じジョブを二重に claim しない";

type Mode =
  "serialized" | "backoff-all" | "racy" | "racy-only-10th-tenant" | "racy-only-8-concurrent";

const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/** `InMemoryOutboxStore` を包み、`claimBatch` に本当の yield 点（await をまたぐ隙間）を作る。 */
class YieldingOutboxStore implements OutboxStore {
  private chain: Promise<unknown> = Promise.resolve();
  private readonly inFlight = new Map<string, number>();
  private readonly peak = new Map<string, number>();
  private readonly tenantsSeen: string[] = [];
  private readonly collided = new Set<string>();

  constructor(
    private readonly inner: InMemoryOutboxStore,
    private readonly jobs: OutboxJobRecord[],
    private readonly mode: Mode,
  ) {}

  async claimBatch(ctx: Ctx, opts: ClaimOutboxJobsOptions): Promise<OutboxJobRecord[]> {
    const tenant = ctx.tenantId;
    if (!this.tenantsSeen.includes(tenant)) this.tenantsSeen.push(tenant);
    const now = (this.inFlight.get(tenant) ?? 0) + 1;
    this.inFlight.set(tenant, now);
    this.peak.set(tenant, Math.max(this.peak.get(tenant) ?? 0, now));
    try {
      switch (this.mode) {
        case "serialized": {
          // 正しい実装: 呼び出しを直列に並べる（行ロックの代わり）。await をまたぐが二重 claim しない。
          const run = this.chain.then(async () => {
            await tick();
            return this.inner.claimBatch(ctx, opts);
          });
          this.chain = run.catch(() => undefined);
          return await run;
        }
        case "backoff-all": {
          // 正しい実装（SKIP LOCKED 相当の極端な形）: 重なったら全員が引く。合計が0になりうる。
          if (now > 1) this.collided.add(tenant);
          await tick();
          if (this.collided.has(tenant)) return [];
          return this.inner.claimBatch(ctx, opts);
        }
        default: {
          // 壊れた実装: 呼ばれた時点の状態で claim 対象を決め、yield してから書く（check-then-act）。
          const stale = new InMemoryOutboxStore(this.jobs.map((job) => structuredClone(job)));
          const claimed = await stale.claimBatch(ctx, opts);
          await tick();
          const broken =
            this.mode === "racy" ||
            (this.mode === "racy-only-10th-tenant" && this.tenantsSeen.indexOf(tenant) >= 9) ||
            (this.mode === "racy-only-8-concurrent" && (this.peak.get(tenant) ?? 0) >= 8);
          if (!broken) return this.inner.claimBatch(ctx, opts);
          for (const c of claimed) {
            const real = this.jobs.find((job) => job.id === c.id)!;
            real.claimedAt = c.claimedAt ?? null;
            real.claimedBy = c.claimedBy ?? null;
            real.attempts = c.attempts;
          }
          return claimed;
        }
      }
    } finally {
      this.inFlight.set(tenant, (this.inFlight.get(tenant) ?? 1) - 1);
    }
  }

  complete: OutboxStore["complete"] = (...args) => this.inner.complete(...args);
  fail: OutboxStore["fail"] = (...args) => this.inner.fail(...args);
  eraseTenant: NonNullable<OutboxStore["eraseTenant"]> = (...args) =>
    this.inner.eraseTenant!(...args);
  purgeCompletedJobs: NonNullable<OutboxStore["purgeCompletedJobs"]> = (...args) =>
    this.inner.purgeCompletedJobs!(...args);
}

function yieldingOptions(name: string, mode: Mode, supportsRealConcurrency: boolean | undefined) {
  const base = inMemoryOutboxStoreConformanceOptions();
  return {
    ...base,
    name,
    createStore: async () => {
      const inner = (await base.createStore()) as InMemoryOutboxStore;
      const jobs = (inner as unknown as { jobs: OutboxJobRecord[] }).jobs;
      return new YieldingOutboxStore(inner, jobs, mode);
    },
    ...(supportsRealConcurrency === undefined ? {} : { supportsRealConcurrency }),
  };
}

const SERIALIZED = "recheck-0917 serialized (flag true)";
const BACKOFF = "recheck-0917 backoff-all (flag true)";
const OMITTED = "recheck-0917 serialized (flag omitted)";
const FALSE_FLAG = "recheck-0917 serialized (flag false)";
const RACY = "recheck-0917 racy (flag true)";
const RACY_10TH = "recheck-0917 racy only in the 10th round (flag true)";
const RACY_8 = "recheck-0917 racy only at 8 concurrent (flag true)";

describeOutboxStoreConformance(yieldingOptions(SERIALIZED, "serialized", true));
describeOutboxStoreConformance(yieldingOptions(BACKOFF, "backoff-all", true));
describeOutboxStoreConformance(yieldingOptions(OMITTED, "serialized", undefined));
describeOutboxStoreConformance(yieldingOptions(FALSE_FLAG, "serialized", false));
describeOutboxStoreConformance(yieldingOptions(RACY, "racy", true));
describeOutboxStoreConformance(yieldingOptions(RACY_10TH, "racy-only-10th-tenant", true));
describeOutboxStoreConformance(yieldingOptions(RACY_8, "racy-only-8-concurrent", true));

/** task の木から、名前に `needle` を含む describe の下の、並行の `it` を探す。 */
function concurrentItUnder(root: RunnerTask, needle: string): RunnerTask {
  const found: RunnerTask[] = [];
  const walk = (task: RunnerTask, inside: boolean) => {
    const here = inside || (task.type === "suite" && task.name.includes(needle));
    if (task.type === "test" && here && task.name === CONCURRENT_IT_NAME) found.push(task);
    if ("tasks" in task) for (const child of task.tasks) walk(child, here);
  };
  walk(root, false);
  expect(found, `${needle}: 並行の it はちょうど1本登録される`).toHaveLength(1);
  return found[0]!;
}

/** task の木から、名前に `needle` を含む describe の下の、並行でない普通の `it` を1本探す。 */
function ordinaryItUnder(root: RunnerTask, needle: string): RunnerTask {
  const found: RunnerTask[] = [];
  const walk = (task: RunnerTask, inside: boolean) => {
    const here = inside || (task.type === "suite" && task.name.includes(needle));
    if (task.type === "test" && here && task.name !== CONCURRENT_IT_NAME) found.push(task);
    if ("tasks" in task) for (const child of task.tasks) walk(child, here);
  };
  walk(root, false);
  expect(found.length, `${needle}: suite が実際に登録されている`).toBeGreaterThan(10);
  return found[0]!;
}

// vitest は 1 つ目の引数に分割代入を要求する（suite は 2 つ目）。使わない分は空の分割代入で受ける。
// eslint-disable-next-line no-empty-pattern
beforeAll(({}, suite) => {
  // 二重 claim する store では、並行の歯が「落ちること」が期待。
  for (const name of [RACY, RACY_10TH, RACY_8]) {
    (concurrentItUnder(suite.file, name) as { fails?: boolean }).fails = true;
  }
});

describe("ADR 0206: 並行 claim の歯の、testkit の側の歯（Issue #1812 G5）", () => {
  it("フラグを省略/false にすると並行の it は skip、true なら走る（ADR 0206）", ({ task }) => {
    // 同じ suite の普通の it が run でないとき（`-t` で絞られているとき）は、全部 skip になるので比べない。
    // ⚠ 並行の it 自身を control にしてはいけない——「常に skip」の変異で control も skip になり、比べずに緑になる。
    if (ordinaryItUnder(task.file, SERIALIZED).mode !== "run") return;
    expect(concurrentItUnder(task.file, SERIALIZED).mode).toBe("run");
    expect(concurrentItUnder(task.file, BACKOFF).mode).toBe("run");
    expect(concurrentItUnder(task.file, OMITTED).mode).toBe("skip");
    expect(concurrentItUnder(task.file, FALSE_FLAG).mode).toBe("skip");
  });

  it("in-memory の設定は supportsRealConcurrency を渡さない（逐次化されるので、渡すと何も測らず緑になる。ADR 0206）", () => {
    expect(inMemoryOutboxStoreConformanceOptions().supportsRealConcurrency).toBeFalsy();
  });

  it("claimBatch が返すジョブは、渡した claimedBy を名乗る", async () => {
    const options = inMemoryOutboxStoreConformanceOptions();
    const store = await options.createStore();
    const ctx: Ctx = { tenantId: "recheck-0917-claimed-by" };
    await options.seedJob(ctx, { kind: "extract" });
    const claimed = await store.claimBatch(ctx, {
      limit: 1,
      now: new Date(),
      claimedBy: "worker-named",
      leaseMs: 60_000,
    });
    expect(claimed.map((job) => job.claimedBy)).toEqual(["worker-named"]);
  });
});
