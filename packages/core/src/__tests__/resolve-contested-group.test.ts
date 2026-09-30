import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import type { LLMProvider } from "../interfaces/llm-provider.js";
import { defaultDecayStrategy } from "../strategies/decay.js";
import type { NewMemory } from "../memory.js";
import { createRuntime } from "../runtime.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";

/**
 * `runtime.resolveContestedGroup`（Issue #207/#933 PR2、ADR 0327 §4-c、ADR 0378 決定3、
 * ADR 0381）の歯。`resolve-contested.test.ts`（2者版。このリポジトリには専用の歯として
 * `resolve-contested.test.ts`/`resolve-contested-loser-invariant.test.ts` がある）と
 * 対称に書いてある。
 *
 * fix2（2026-09-30 の直し、ADR 0381）の主目的: **`memberIds` が、`memory_relations` で
 * つながった「今も contested な」群の一部だけだったら、CAS で弾いて何も書かない。**
 * この Runtime 層の読み側の確認は `deps.relationStore` が配線されているときだけ働く
 * （`Runtime.resolveContestedGroup` の doc コメント手順6参照）——配線されていなければ
 * store 側の CAS（`MemoryStore.resolveContestedGroup`）だけに任せる。
 */

const ctx: Ctx = { tenantId: "tenant-rcg" };
const NOW = new Date("2026-06-01T00:00:00.000Z");

function newMemory(overrides: Partial<NewMemory> = {}): NewMemory {
  const recordedAt = overrides.recordedAt ?? NOW;
  const strength = overrides.strength ?? 1;
  const halfLifeHours = overrides.halfLifeHours ?? 24 * 365 * 10;
  return {
    tenantId: "tenant-rcg",
    subjectId: null,
    sourceObservationId: null,
    extractorVersion: null,
    content: "本文",
    contentHash: `hash-${Math.random()}`,
    digest: "digest",
    digestSource: "llm",
    provenance: { kind: "imported", batchId: "fixture" },
    tags: [],
    occurredAt: null,
    recordedAt,
    lastReinforcedAt: null,
    strength,
    halfLifeHours,
    decayFloorAt: defaultDecayStrategy.floorAt({
      recordedAt,
      lastReinforcedAt: null,
      strength,
      halfLifeHours,
    }),
    embeddingStatus: "pending",
    ...overrides,
  };
}

const notUsedLlm: LLMProvider = {
  complete: async () => {
    throw new Error("not used");
  },
  completeStructured: async () => {
    throw new Error("not used");
  },
};

function buildRuntime(opts: { withRelationStore?: boolean } = {}) {
  const stores = createFakeRuntimeStores();
  const runtime = createRuntime({
    memoryStore: stores.memoryStore,
    outboxStore: stores.outboxStore,
    vectorStore: stores.vectorStore,
    eventStore: stores.eventStore,
    tenantSettingsStore: stores.tenantSettingsStore,
    llmProvider: notUsedLlm,
    embeddingProvider: stores.embeddingProvider,
    hashContent: (content: string) => `sha256(${content})`,
    clock: { now: () => NOW },
    relationStore: opts.withRelationStore === false ? undefined : stores.relationStore,
  });
  return { runtime, stores };
}

async function createContestedTrio(stores: ReturnType<typeof createFakeRuntimeStores>) {
  const a = await stores.memoryStore.createMemory(ctx, newMemory({ digest: "A" }));
  const b = await stores.memoryStore.createMemory(ctx, newMemory({ digest: "B" }));
  const c = await stores.memoryStore.createMemory(ctx, newMemory({ digest: "C" }));
  return { a, b, c };
}

describe("runtime.resolveContestedGroup — 基本の成功", () => {
  it("both_active: 全員 status: 'active' になり、群の memory_relations が全て消える", async () => {
    const { runtime, stores } = buildRuntime();
    const { a, b, c } = await createContestedTrio(stores);
    await runtime.markContestedGroup!(ctx, [a.id, b.id, c.id]);

    const result = await runtime.resolveContestedGroup!(ctx, [a.id, b.id, c.id], {
      kind: "both_active",
    });

    expect(result.outcome.kind).toBe("resolved");
    for (const id of [a.id, b.id, c.id]) {
      const stored = await stores.memoryStore.get(ctx, id);
      expect(stored?.status).toBe("active");
    }
    expect(await stores.relationStore.listRelated(ctx, a.id, "contradicts")).toEqual([]);
  });

  it("supersede: winnerId だけ active、他は superseded + supersededById", async () => {
    const { runtime, stores } = buildRuntime();
    const { a, b, c } = await createContestedTrio(stores);
    await runtime.markContestedGroup!(ctx, [a.id, b.id, c.id]);

    const result = await runtime.resolveContestedGroup!(ctx, [a.id, b.id, c.id], {
      kind: "supersede",
      winnerId: a.id,
    });

    expect(result.outcome.kind).toBe("resolved");
    const storedA = await stores.memoryStore.get(ctx, a.id);
    const storedB = await stores.memoryStore.get(ctx, b.id);
    const storedC = await stores.memoryStore.get(ctx, c.id);
    expect(storedA?.status).toBe("active");
    expect(storedB?.status).toBe("superseded");
    expect(storedB?.supersededById).toBe(a.id);
    expect(storedC?.status).toBe("superseded");
    expect(storedC?.supersededById).toBe(a.id);
  });

  it("resolution.winnerId が memberIds に無ければ書き込み前に RangeError", async () => {
    const { runtime, stores } = buildRuntime();
    const { a, b, c } = await createContestedTrio(stores);
    await runtime.markContestedGroup!(ctx, [a.id, b.id, c.id]);

    await expect(
      runtime.resolveContestedGroup!(ctx, [a.id, b.id, c.id], {
        kind: "supersede",
        winnerId: "does-not-exist",
      }),
    ).rejects.toThrow(RangeError);
  });
});

describe("runtime.resolveContestedGroup — fix2: 群の一部だけを渡すと弾く（relationStore 配線あり）", () => {
  it("4件の群のうち3件だけを渡すと ineligible になり、missingMembers に欠けた1件が入り、何も書かない", async () => {
    const { runtime, stores } = buildRuntime({ withRelationStore: true });
    const a = await stores.memoryStore.createMemory(ctx, newMemory({ digest: "A" }));
    const b = await stores.memoryStore.createMemory(ctx, newMemory({ digest: "B" }));
    const c = await stores.memoryStore.createMemory(ctx, newMemory({ digest: "C" }));
    const d = await stores.memoryStore.createMemory(ctx, newMemory({ digest: "D" }));
    await runtime.markContestedGroup!(ctx, [a.id, b.id, c.id, d.id]);

    const result = await runtime.resolveContestedGroup!(ctx, [a.id, b.id, c.id], {
      kind: "both_active",
    });

    expect(result.outcome.kind).toBe("ineligible");
    if (result.outcome.kind === "ineligible") {
      expect(result.outcome.missingMembers).toEqual([d.id]);
    }
    for (const id of [a.id, b.id, c.id, d.id]) {
      const stored = await stores.memoryStore.get(ctx, id);
      expect(stored?.status).toBe("contested");
    }
  });

  it("forget 等で群を離れた（もう contested ではない）メンバーは missingMembers に数えない", async () => {
    // decision10: forget/supersede/purge/archive で群を離れたメンバーの関係の行は残す。
    // fix2 は「行の有無」ではなく「status === 'contested'」で今の群を判定する——離れた
    // メンバーを missingMembers に含めると、二度と解消できなくなってしまう。
    // ⚠ `resolveContestedGroup` 自身が「3件未満は RangeError」を要求するため
    // （`markContestedGroup` と同じ最小人数の制約、呼び出し前の programmer error）、
    // 4件の群を作り、1件を forget で離脱させてから、残った3件（ちょうど最小人数）を
    // 解消する形にする。
    const { runtime, stores } = buildRuntime({ withRelationStore: true });
    const a = await stores.memoryStore.createMemory(ctx, newMemory({ digest: "A" }));
    const b = await stores.memoryStore.createMemory(ctx, newMemory({ digest: "B" }));
    const c = await stores.memoryStore.createMemory(ctx, newMemory({ digest: "C" }));
    const d = await stores.memoryStore.createMemory(ctx, newMemory({ digest: "D" }));
    await runtime.markContestedGroup!(ctx, [a.id, b.id, c.id, d.id]);
    // d を forget で群から離脱させる（関係の行は残る——decision10）。
    await runtime.forget(ctx, { memoryIds: [d.id] });
    const storedD = await stores.memoryStore.get(ctx, d.id);
    expect(storedD?.status).toBe("forgotten");
    // 関係の行自体はまだ残っている。
    expect(
      (await stores.relationStore.listRelated(ctx, a.id, "contradicts")).map((r) => r.memoryId),
    ).toContain(d.id);

    const result = await runtime.resolveContestedGroup!(ctx, [a.id, b.id, c.id], {
      kind: "both_active",
    });

    expect(result.outcome.kind).toBe("resolved");
    for (const id of [a.id, b.id, c.id]) {
      const stored = await stores.memoryStore.get(ctx, id);
      expect(stored?.status).toBe("active");
    }
  });
});

describe("runtime.resolveContestedGroup — relationStore が配線されていなければ、この読み側の確認は行わない", () => {
  it("4件の群のうち3件だけを渡しても、Runtime 層は missingMembers を検査しない（store 側の CAS だけに任せる）が、store 側の CAS が拒み ineligible になる（2026-09-30 のさらなる直し、ADR 0381 §7）", async () => {
    const { runtime, stores } = buildRuntime({ withRelationStore: false });
    const a = await stores.memoryStore.createMemory(ctx, newMemory({ digest: "A" }));
    const b = await stores.memoryStore.createMemory(ctx, newMemory({ digest: "B" }));
    const c = await stores.memoryStore.createMemory(ctx, newMemory({ digest: "C" }));
    const d = await stores.memoryStore.createMemory(ctx, newMemory({ digest: "D" }));
    await runtime.markContestedGroup!(ctx, [a.id, b.id, c.id, d.id]);

    const result = await runtime.resolveContestedGroup!(ctx, [a.id, b.id, c.id], {
      kind: "both_active",
    });

    // Runtime 層は sides をすべて "eligible" と判定する（relationStore が無いので
    // missingMembers を検査しない）が、store 側（FakeMemoryStore.resolveContestedGroup）の
    // CAS が同じ理由で拒む——ContestedGroupMembershipMismatchError を投げる。Runtime は
    // この専用のエラーを、relationStore の配線の有無に関わらず ineligible に写す
    // （MemoryStatusConflictError の conflict とは別の分岐——ADR 0381 §7 解消）。
    expect(result.outcome.kind).toBe("ineligible");
    if (result.outcome.kind === "ineligible") {
      expect(result.outcome.missingMembers).toEqual([d.id]);
    }
    for (const id of [a.id, b.id, c.id, d.id]) {
      const stored = await stores.memoryStore.get(ctx, id);
      expect(stored?.status).toBe("contested");
    }
  });
});

describe("runtime.resolveContestedGroup — memberIds の検査（呼び手のバグ）", () => {
  it("2件以下は書き込み前に RangeError", async () => {
    const { runtime, stores } = buildRuntime();
    const a = await stores.memoryStore.createMemory(ctx, newMemory({ digest: "A" }));
    const b = await stores.memoryStore.createMemory(ctx, newMemory({ digest: "B" }));

    await expect(
      runtime.resolveContestedGroup!(ctx, [a.id, b.id], { kind: "both_active" }),
    ).rejects.toThrow(RangeError);
  });
});

describe("runtime.resolveContestedGroup — MemoryStore.resolveContestedGroup が無い adapter", () => {
  it("resolveContestedGroup が無ければ supported: false・not_attempted", async () => {
    const { runtime, stores } = buildRuntime();
    const { a, b, c } = await createContestedTrio(stores);
    await runtime.markContestedGroup!(ctx, [a.id, b.id, c.id]);
    Object.defineProperty(stores.memoryStore, "resolveContestedGroup", {
      value: undefined,
      configurable: true,
    });

    const result = await runtime.resolveContestedGroup!(ctx, [a.id, b.id, c.id], {
      kind: "both_active",
    });

    expect(result).toEqual({ supported: false, outcome: { kind: "not_attempted" } });
  });
});

/**
 * Issue #1449 項目6: 群版の winnerId の大文字小文字の救済（2者版 `resolveContested` と同じ規則）。
 * Fake の `get` は大文字小文字を区別する——`@mnemora/postgres` のように区別しない store は
 * `get` だけを小文字にそろえる差し替えで表す（救済が使うのは `get` だけで、書き込み側には
 * 元の memberIds の綴りを渡すため）。Postgres の本物の歯は
 * `packages/postgres/src/__tests__/uppercase-uuid-contested-runtime.postgres.test.ts`。
 */
describe("runtime.resolveContestedGroup — winnerId の大文字小文字の救済（Issue #1449 項目6）", () => {
  function buildCaseInsensitiveGetRuntime(
    override?: (id: string, real: (id: string) => Promise<unknown>) => Promise<unknown>,
  ) {
    const stores = createFakeRuntimeStores();
    const calls: string[] = [];
    const memoryStore = Object.create(stores.memoryStore) as typeof stores.memoryStore;
    memoryStore.get = (async (c: Ctx, id: string) => {
      calls.push(id);
      const real = (i: string) => stores.memoryStore.get(c, i.toLowerCase());
      return override ? override(id, real) : real(id);
    }) as typeof stores.memoryStore.get;
    const runtime = createRuntime({
      memoryStore,
      outboxStore: stores.outboxStore,
      vectorStore: stores.vectorStore,
      eventStore: stores.eventStore,
      tenantSettingsStore: stores.tenantSettingsStore,
      llmProvider: notUsedLlm,
      embeddingProvider: stores.embeddingProvider,
      hashContent: (content: string) => `sha256(${content})`,
      clock: { now: () => NOW },
      relationStore: stores.relationStore,
    });
    return { runtime, stores, calls };
  }

  it("大文字の winnerId が、store が同じ記憶と言えば通り、敗者の supersededById は memberIds の綴り（列の値）になる", async () => {
    const { runtime, stores } = buildCaseInsensitiveGetRuntime();
    const { a, b, c } = await createContestedTrio(stores);
    await runtime.markContestedGroup!(ctx, [a.id, b.id, c.id]);

    const result = await runtime.resolveContestedGroup!(ctx, [a.id, b.id, c.id], {
      kind: "supersede",
      winnerId: a.id.toUpperCase(),
    });

    expect(result.outcome.kind).toBe("resolved");
    const [sa, sb, sc] = await Promise.all(
      [a.id, b.id, c.id].map((id) => stores.memoryStore.get(ctx, id)),
    );
    expect([sa?.status, sb?.status, sc?.status]).toEqual(["active", "superseded", "superseded"]);
    expect([sb?.supersededById, sc?.supersededById]).toEqual([a.id, a.id]);
  });

  it("store の get が別の記憶を返すなら RangeError（何も書かない）", async () => {
    // winnerId（大文字の綴り）として引いたときだけ、別の記憶 b を返す。
    let bId = "";
    const { runtime, stores } = buildCaseInsensitiveGetRuntime((id, real) =>
      id === id.toUpperCase() && id !== id.toLowerCase() ? real(bId) : real(id),
    );
    const { a, b, c } = await createContestedTrio(stores);
    bId = b.id;
    await runtime.markContestedGroup!(ctx, [a.id, b.id, c.id]);

    await expect(
      runtime.resolveContestedGroup!(ctx, [a.id, b.id, c.id], {
        kind: "supersede",
        winnerId: a.id.toUpperCase(),
      }),
    ).rejects.toThrow(RangeError);
    for (const id of [a.id, b.id, c.id]) {
      expect((await stores.memoryStore.get(ctx, id))?.status).toBe("contested");
    }
  });

  it("どの member とも（大文字小文字を無視しても）違う winnerId は、store を読まずに RangeError", async () => {
    const { runtime, stores, calls } = buildCaseInsensitiveGetRuntime();
    const { a, b, c } = await createContestedTrio(stores);
    await runtime.markContestedGroup!(ctx, [a.id, b.id, c.id]);
    calls.length = 0;

    await expect(
      runtime.resolveContestedGroup!(ctx, [a.id, b.id, c.id], {
        kind: "supersede",
        winnerId: "someone-else",
      }),
    ).rejects.toThrow(RangeError);
    expect(calls).toEqual([]);
  });

  it("大文字小文字だけ違う候補が2件以上あれば救済しない（RangeError、store は読まない）", async () => {
    const { runtime, calls } = buildCaseInsensitiveGetRuntime();

    await expect(
      runtime.resolveContestedGroup!(ctx, ["mem-x", "MEM-X", "mem-y"], {
        kind: "supersede",
        winnerId: "Mem-X",
      }),
    ).rejects.toThrow(RangeError);
    expect(calls).toEqual([]);
  });
});
