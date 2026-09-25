import { describe, expect, it } from "vitest";
import type { MemoryStore } from "@mnemora/core";
import { InMemoryMemoryStore } from "../__fixtures__/in-memory-memory-store.js";
import { InMemoryOutboxStore } from "../__fixtures__/in-memory-outbox-store.js";
import { describeMemoryStoreConformance } from "../memory-store-conformance.js";
import type { MemoryStoreConformanceOptions } from "../memory-store-conformance.js";

/**
 * [Issue #818](https://github.com/takecchi/mnemora/issues/818): 棚卸し（v1.0.0..main）で
 * `supportsTaxonomyMode` と同じ形の計上漏れが2件見つかった——
 * `MemoryStoreConformanceOptions.supportsLabels`（ba6e5dd / PR #717 / ADR 0318）と
 * `supportsFindActiveByClaimKey`（7987de4 / PR #745 / ADR 0324）。どちらも v1.0.0 の
 * 時点では存在せず、「省略可にしない」判断で必須として足されたため、v1.0.0 の利用者の
 * `describeMemoryStoreConformance(...)` 呼び出しがコンパイルできなくなっていた。
 *
 * この歯は、`tenant-settings-store-conformance.supports-taxonomy-mode-optional.test.ts` と
 * 同じ形で、2フィールドをまとめて固定する:
 *
 * 1. **型**: 下の `omitted` の呼び出しは `supportsLabels`/`supportsFindActiveByClaimKey` を
 *    どちらも渡さない——`pnpm --filter @mnemora/testkit run typecheck` がこの2つを
 *    必須へ戻すと赤くなる。
 * 2. **挙動**: 省略時、`listLabels`/`registerLabel`/`findActiveByClaimKey` を exercise する
 *    `it()` が実行されないこと——`InMemoryMemoryStore` をラップし呼び出し回数を数える
 *    Proxy で検証する。陽性対照（`control`、両方とも `true`）が、同じ探り棒で
 *    実際に呼ばれることを先に示す（AGENTS.md「『出なかった』を、事象が無いことの
 *    証明にしない——先に陽性対照を示す」）。
 */

interface LabelClaimKeyCounts {
  listLabels: number;
  registerLabel: number;
  findActiveByClaimKey: number;
}

/**
 * `describeMemoryStoreConformance` の他の必須フィールド（`listEventsForMemory`/
 * `prepareRecallId`/`claimEmbedJobs`/`listPurgedEvents`）は `supportsLabels`/
 * `supportsFindActiveByClaimKey` と無関係だが、型上は省略できない
 * （このファイルが検査したい2フィールドの他は変えていない）。
 * `packages/testkit/src/__tests__/in-memory-fixtures.conformance.test.ts` の
 * `InMemoryMemoryStore` 配線と同じ形をここでも組む——ここでは重複を避けるため、
 * `control`/`omitted` の2呼び出しで共有できる部分をこの関数へ集約する。
 */
function memoryStoreHarness(): {
  createStore: () => MemoryStore;
  listEventsForMemory: MemoryStoreConformanceOptions["listEventsForMemory"];
  prepareRecallId: MemoryStoreConformanceOptions["prepareRecallId"];
  claimEmbedJobs: MemoryStoreConformanceOptions["claimEmbedJobs"];
  listPurgedEvents: MemoryStoreConformanceOptions["listPurgedEvents"];
  counts: () => LabelClaimKeyCounts;
} {
  let latest: InMemoryMemoryStore | undefined;
  const counts: LabelClaimKeyCounts = { listLabels: 0, registerLabel: 0, findActiveByClaimKey: 0 };
  const countedMethods = new Set<keyof LabelClaimKeyCounts>([
    "listLabels",
    "registerLabel",
    "findActiveByClaimKey",
  ]);

  const createStore = (): MemoryStore => {
    const inner = new InMemoryMemoryStore();
    latest = inner;
    return new Proxy(inner, {
      get(target, prop, receiver) {
        if (typeof prop === "string" && countedMethods.has(prop as keyof LabelClaimKeyCounts)) {
          const original = Reflect.get(target, prop, receiver) as
            ((...args: unknown[]) => unknown) | undefined;
          if (!original) {
            return original;
          }
          return (...args: unknown[]) => {
            counts[prop as keyof LabelClaimKeyCounts] += 1;
            return original.apply(target, args);
          };
        }
        const value = Reflect.get(target, prop, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as unknown as MemoryStore;
  };

  return {
    createStore,
    listEventsForMemory: (ctx, memoryId) => {
      if (!latest) {
        throw new Error("listEventsForMemory より先に createStore() を呼ぶ必要がある");
      }
      return latest.events.filter(
        (event) => event.tenantId === ctx.tenantId && event.memoryId === memoryId,
      );
    },
    prepareRecallId: async (ctx) => {
      if (!latest) {
        throw new Error("prepareRecallId より先に createStore() を呼ぶ必要がある");
      }
      return latest.createRecall(ctx, {
        tenantId: ctx.tenantId,
        subjectId: null,
        query: { text: "fixture" },
        budget: null,
        omitted: [],
        usage: {
          chars: 0,
          estimatedTokens: 0,
          counter: "heuristic",
          byTier: { full: 0, digest: 0, index: 0 },
          indexChars: 0,
        },
        indexBand: { groups: [], totalInScope: 0, countKind: "exact" },
        explain: { stages: [] },
        returnedMemories: [],
      });
    },
    claimEmbedJobs: (ctx, now) => {
      if (!latest) {
        throw new Error("claimEmbedJobs より先に createStore() を呼ぶ必要がある");
      }
      return new InMemoryOutboxStore(latest.outboxJobs).claimBatch(ctx, {
        kinds: ["embed"],
        limit: 100,
        now,
        claimedBy: "conformance-requeue",
        leaseMs: 60_000,
      });
    },
    listPurgedEvents: (ctx) => {
      if (!latest) {
        throw new Error("listPurgedEvents より先に createStore() を呼ぶ必要がある");
      }
      return latest.events.filter(
        (event) => event.tenantId === ctx.tenantId && event.kind === "events_purged",
      );
    },
    counts: () => ({ ...counts }),
  };
}

// --- 陽性対照: supportsLabels/supportsFindActiveByClaimKey: true では実際に呼ばれる ---
const control = memoryStoreHarness();
describeMemoryStoreConformance({
  name: "labels/findActiveByClaimKey probe (control, both true)",
  createStore: control.createStore,
  listEventsForMemory: control.listEventsForMemory,
  prepareRecallId: control.prepareRecallId,
  claimEmbedJobs: control.claimEmbedJobs,
  supportsSupersedeWithNewMemories: true,
  supportsPurgeExpiredEvents: true,
  listPurgedEvents: control.listPurgedEvents,
  supportsArchiveDecayed: true,
  supportsPurgeMemory: true,
  supportsMarkContestedPair: true,
  supportsResolveContestedPair: true,
  supportsRestoreSupersededBy: true,
  supportsPreviewRestoreSupersededBy: true,
  supportsOnlyMemoryIdsFilter: true,
  supportsLabels: true,
  supportsFindActiveByClaimKey: true,
  supportsListActiveClaimPredicates: true,
});

// --- 本題: v1.0.0 の呼び出し形そのもの。supportsLabels/supportsFindActiveByClaimKey を渡さない ---
const omitted = memoryStoreHarness();
describeMemoryStoreConformance({
  name: "labels/findActiveByClaimKey probe (v1.0.0 call shape, both omitted)",
  createStore: omitted.createStore,
  listEventsForMemory: omitted.listEventsForMemory,
  prepareRecallId: omitted.prepareRecallId,
  claimEmbedJobs: omitted.claimEmbedJobs,
  supportsSupersedeWithNewMemories: true,
  supportsPurgeExpiredEvents: true,
  listPurgedEvents: omitted.listPurgedEvents,
  supportsArchiveDecayed: true,
  supportsPurgeMemory: true,
  supportsMarkContestedPair: true,
  supportsResolveContestedPair: true,
  supportsRestoreSupersededBy: true,
  supportsPreviewRestoreSupersededBy: true,
  supportsOnlyMemoryIdsFilter: true,
  supportsListActiveClaimPredicates: true,
  // ⭐ supportsLabels / supportsFindActiveByClaimKey は意図的に渡さない — v1.0.0 の
  // 呼び出し形そのもの（Issue #818）。
});

describe("supportsLabels/supportsFindActiveByClaimKey を省略した呼び出し（v1.0.0 の呼び出し形）は型検査を通り、該当する適合項目を実行しない", () => {
  it("陽性対照: 両方とも true では listLabels/registerLabel/findActiveByClaimKey が実際に呼ばれている", () => {
    const { listLabels, registerLabel, findActiveByClaimKey } = control.counts();
    expect(listLabels).toBeGreaterThan(0);
    expect(registerLabel).toBeGreaterThan(0);
    expect(findActiveByClaimKey).toBeGreaterThan(0);
  });

  it("両方を省略すると、listLabels/registerLabel/findActiveByClaimKey は一度も呼ばれない", () => {
    const { listLabels, registerLabel, findActiveByClaimKey } = omitted.counts();
    expect(listLabels).toBe(0);
    expect(registerLabel).toBe(0);
    expect(findActiveByClaimKey).toBe(0);
  });
});
