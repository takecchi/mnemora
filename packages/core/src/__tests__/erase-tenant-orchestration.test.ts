import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import { eraseTenant, type EraseTenantMissingStore } from "../erase-tenant.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";

/**
 * `eraseTenant`（PR #1444、ADR 0383）が4つの port を束ねる部分の歯。
 * 各 port の `eraseTenant?` の中身（何を消すか）は testkit の適合テストが見る。ここでは、
 * port を記録だけの偽物に差し替えて、オーケストレータ自身が port に何を渡し、何を返し、
 * どの port を呼ばないかを縛る。
 */

const ctx: Ctx = { tenantId: "tenant-1" };

const PORTS = ["memoryStore", "vectorStore", "outboxStore", "tenantSettingsStore"] as const;
type PortName = (typeof PORTS)[number];

interface Call {
  port: PortName;
  ctx: Ctx;
  opts: { limit: number; dryRun?: boolean | undefined };
}

interface Results {
  memoryStore: { deleted: number; reachedLimit: boolean };
  vectorStore: { deleted: number; reachedLimit: boolean };
  outboxStore: { deleted: number; reachedLimit: boolean };
  tenantSettingsStore: { deleted: number; reachedLimit: boolean };
}

const NOTHING: Results = {
  memoryStore: { deleted: 0, reachedLimit: false },
  vectorStore: { deleted: 0, reachedLimit: false },
  outboxStore: { deleted: 0, reachedLimit: false },
  tenantSettingsStore: { deleted: 0, reachedLimit: false },
};

/** 4 port の `eraseTenant` を、呼ばれ方を記録する偽物に差し替える。 */
function recordingDeps(results: Results = NOTHING, throwing?: { port: PortName; error: unknown }) {
  const stores = createFakeRuntimeStores();
  const calls: Call[] = [];
  const handler =
    (port: PortName) => async (c: Ctx, opts: { limit: number; dryRun?: boolean | undefined }) => {
      calls.push({ port, ctx: c, opts });
      if (throwing?.port === port) {
        throw throwing.error;
      }
      return results[port];
    };
  stores.memoryStore.eraseTenant = async (c, opts) => {
    calls.push({ port: "memoryStore", ctx: c, opts });
    if (throwing?.port === "memoryStore") {
      throw throwing.error;
    }
    return { kind: "executed", ...results.memoryStore };
  };
  stores.vectorStore.eraseTenant = handler("vectorStore");
  stores.outboxStore.eraseTenant = handler("outboxStore");
  stores.tenantSettingsStore.eraseTenant = handler("tenantSettingsStore");
  const deps = {
    memoryStore: stores.memoryStore,
    vectorStore: stores.vectorStore,
    outboxStore: stores.outboxStore,
    tenantSettingsStore: stores.tenantSettingsStore,
  };
  return { stores, deps, calls };
}

describe("eraseTenant: 引数が不正なときは、どの port にも触れずに RangeError で断る", () => {
  for (const limit of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    it(`limit: ${limit}`, async () => {
      const { deps, calls } = recordingDeps();
      await expect(
        eraseTenant(ctx, deps, { confirmTenantId: ctx.tenantId, limit }),
      ).rejects.toBeInstanceOf(RangeError);
      expect(calls).toEqual([]);
    });
  }

  it("confirmTenantId が違うとき", async () => {
    const { deps, calls } = recordingDeps();
    await expect(
      eraseTenant(ctx, deps, { confirmTenantId: "tenant-2", limit: 10 }),
    ).rejects.toBeInstanceOf(RangeError);
    expect(calls).toEqual([]);
  });
});

describe("eraseTenant: store_unsupported は欠けた port だけを名指しし、どの port にも触れない", () => {
  for (const missingPort of PORTS) {
    it(`${missingPort} だけが口を持たないとき`, async () => {
      const { stores, deps, calls } = recordingDeps();
      (stores[missingPort] as { eraseTenant?: unknown }).eraseTenant = undefined;

      const outcome = await eraseTenant(ctx, deps, { confirmTenantId: ctx.tenantId, limit: 10 });

      expect(outcome).toEqual({ kind: "store_unsupported", missing: [missingPort] });
      expect(calls).toEqual([]);
    });
  }

  it("4つとも口を持たないとき、missing は呼び順で4つ全部を名指しする", async () => {
    const { stores, deps, calls } = recordingDeps();
    for (const port of PORTS) {
      (stores[port] as { eraseTenant?: unknown }).eraseTenant = undefined;
    }

    const outcome = await eraseTenant(ctx, deps, { confirmTenantId: ctx.tenantId, limit: 10 });

    const expectedMissing: EraseTenantMissingStore[] = [...PORTS];
    expect(outcome).toEqual({ kind: "store_unsupported", missing: expectedMissing });
    expect(calls).toEqual([]);
  });
});

describe("eraseTenant: 各 port へ ctx・limit・dryRun をそのまま渡す", () => {
  for (const dryRun of [true, false, undefined]) {
    it(`dryRun: ${String(dryRun)}`, async () => {
      const { deps, calls } = recordingDeps();

      await eraseTenant(ctx, deps, {
        confirmTenantId: ctx.tenantId,
        limit: 7,
        ...(dryRun === undefined ? {} : { dryRun }),
      });

      expect(calls.map((c) => c.port)).toEqual([...PORTS]);
      for (const call of calls) {
        expect(call.ctx).toBe(ctx);
        expect(call.opts.limit).toBe(7);
        // dryRun: true は4つの port すべてに届く（1つでも落ちると、プレビューのつもりが消してしまう）。
        expect(call.opts.dryRun === true).toBe(dryRun === true);
      }
    });
  }
});

describe("eraseTenant: 全部を消し切った回の戻り値は、4つの port の結果の写しである", () => {
  it("deleted は port ごとの件数がそのまま入り、reachedLimit は最後の port（設定）のものを返す", async () => {
    const { deps } = recordingDeps({
      memoryStore: { deleted: 1, reachedLimit: false },
      vectorStore: { deleted: 2, reachedLimit: false },
      outboxStore: { deleted: 3, reachedLimit: false },
      tenantSettingsStore: { deleted: 4, reachedLimit: false },
    });

    const outcome = await eraseTenant(ctx, deps, { confirmTenantId: ctx.tenantId, limit: 100 });

    expect(outcome).toEqual({
      kind: "executed",
      dryRun: false,
      deleted: { memoryStore: 1, vectorStore: 2, outboxStore: 3, tenantSettingsStore: 4 },
      reachedLimit: false,
    });
  });

  it("最後の port（設定）が reachedLimit: true を返したら、reachedLimit: true で返る", async () => {
    const { deps } = recordingDeps({
      memoryStore: { deleted: 1, reachedLimit: false },
      vectorStore: { deleted: 2, reachedLimit: false },
      outboxStore: { deleted: 3, reachedLimit: false },
      tenantSettingsStore: { deleted: 4, reachedLimit: true },
    });

    const outcome = await eraseTenant(ctx, deps, {
      confirmTenantId: ctx.tenantId,
      limit: 100,
      dryRun: true,
    });

    expect(outcome).toEqual({
      kind: "executed",
      dryRun: true,
      deleted: { memoryStore: 1, vectorStore: 2, outboxStore: 3, tenantSettingsStore: 4 },
      reachedLimit: true,
    });
  });
});

describe("eraseTenant: port が投げた例外は、同じ例外のまま素通しし、後ろの port を呼ばない", () => {
  PORTS.forEach((throwingPort, index) => {
    it(`${throwingPort} が投げたとき`, async () => {
      const boom = new Error(`boom-${throwingPort}`);
      const { deps, calls } = recordingDeps(NOTHING, { port: throwingPort, error: boom });

      await expect(
        eraseTenant(ctx, deps, { confirmTenantId: ctx.tenantId, limit: 10 }),
      ).rejects.toBe(boom);

      // 投げた port までは呼ばれ、その後ろは呼ばれない（前の port の削除は戻さない）。
      expect(calls.map((c) => c.port)).toEqual(PORTS.slice(0, index + 1));
    });
  });
});
