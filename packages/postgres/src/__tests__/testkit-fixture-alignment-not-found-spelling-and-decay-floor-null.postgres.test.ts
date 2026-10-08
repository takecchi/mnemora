import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Ctx, Memory, MemoryId, NewMemory, NewMemoryEvent } from "@mnemora/core";
import { buildNewMemoryFixture } from "@mnemora/testkit";
import { InMemoryMemoryStore } from "@mnemora/testkit/fixtures";
import { PostgresMemoryStore } from "../memory-store.js";
import { closeTestClient, getTestClient, resetTestDatabase } from "./test-db.js";

/**
 * `@mnemora/testkit/fixtures` の `InMemoryMemoryStore` を `@mnemora/postgres` に揃えた2点を、**同じ入力を2実装へ流して**縛る。
 *
 * 1. 「memory not found for tenant: <id>」の `<id>` の綴り。Postgres は、操作の対象が無いときは
 *    渡された綴りのまま、参照先（`supersededById`・`contestedWithId`・使用の記録の `memoryIds`）が無いときは小文字で載せる。
 * 2. `decayFloorAt` が `null`・`undefined`・キーなしの新しい記憶は、書く前に断る（Postgres は `23502`）。冪等の既存の行が
 *    在っても断る。
 *
 * 例外のクラスと文面の頭（store の名前）は2実装で違うので、比べるのは `<id>` の綴りと、断ったかどうかだけ。
 */
const ctx: Ctx = { tenantId: "fixture-align-spelling-floor" };
const U = "AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE" as MemoryId;

afterAll(async () => {
  await closeTestClient();
});
beforeEach(async () => {
  await resetTestDatabase();
});

async function build(
  impl: "postgres" | "fixture",
): Promise<PostgresMemoryStore | InMemoryMemoryStore> {
  if (impl === "postgres") {
    const { db } = await getTestClient();
    return new PostgresMemoryStore(db);
  }
  return new InMemoryMemoryStore();
}

/** 断った例外の message の「not found for tenant: 」より後ろ。断らなかったら null。 */
async function notFoundId(run: () => Promise<unknown>): Promise<string | null> {
  try {
    await run();
    return null;
  } catch (e) {
    const m = /memory not found for tenant: (\S+)/.exec((e as Error).message);
    return m ? m[1]! : `other: ${(e as Error).message.slice(0, 80)}`;
  }
}

const ev = (id: MemoryId, kind: string): NewMemoryEvent =>
  ({ memoryId: id, kind, actor: { type: "system" }, meta: {} }) as unknown as NewMemoryEvent;
const fixture = (hash: string): NewMemory =>
  buildNewMemoryFixture({ tenantId: ctx.tenantId, contentHash: hash, content: hash });

type Mouth = [
  string,
  (s: PostgresMemoryStore | InMemoryMemoryStore, x: Memory) => Promise<unknown>,
];

// 全部大文字の U だけだと、「<id> を常に大文字にする」と「渡された綴りのまま」を見分けられない（Issue #1925）。
const MIXED = "AaAaAaAa-bBbB-4cCc-8DdD-eEeEeEeEeEeE" as MemoryId;

type TargetMouth = [
  string,
  (s: PostgresMemoryStore | InMemoryMemoryStore, id: MemoryId) => Promise<unknown>,
];

/** 操作の対象が無い口（Postgres は渡された綴りのまま載せる）。 */
const TARGET_MOUTHS: TargetMouth[] = [
  ["updateStatus", (s, id) => s.updateStatus(ctx, id, "forgotten")],
  [
    "updateStatusWithEvent",
    (s, id) => s.updateStatusWithEvent(ctx, id, "forgotten", {}, ev(id, "forgotten")),
  ],
  ["setEmbeddingStatus", (s, id) => s.setEmbeddingStatus(ctx, id, "ready")],
  ["reinforce", (s, id) => s.reinforce(ctx, id, new Date())],
  [
    "supersedeWithNewMemories（置き換える側）",
    (s, id) =>
      s.supersedeWithNewMemories!(
        ctx,
        [{ input: fixture("n"), jobKinds: [] }],
        [{ id, supersededByIndex: 0, event: ev(id, "superseded") }],
      ),
  ],
];

/** 参照先が無い口（Postgres は小文字で載せる）。 */
const REF_MOUTHS: Mouth[] = [
  [
    "createMemory の supersededById",
    (s) => s.createMemory(ctx, { ...fixture("s"), supersededById: U }),
  ],
  [
    "createMemory の contestedWithId",
    (s) => s.createMemory(ctx, { ...fixture("c"), contestedWithId: U }),
  ],
  [
    "updateStatus の supersededById",
    (s, x) => s.updateStatus(ctx, x.id, "superseded", { supersededById: U }),
  ],
  [
    "updateStatusWithEvent の supersededById",
    (s, x) =>
      s.updateStatusWithEvent(
        ctx,
        x.id,
        "superseded",
        { supersededById: U },
        ev(x.id, "superseded"),
      ),
  ],
];

describe("memory not found の id の綴りは、fixture も Postgres と同じ", () => {
  it.each(TARGET_MOUTHS.flatMap(([n, call]) => [U, MIXED].map((id) => [n, id, call] as const)))(
    "操作の対象が無い %s（%s）: 渡された綴りのまま",
    async (_n, id, call) => {
      for (const impl of ["postgres", "fixture"] as const) {
        await resetTestDatabase();
        const store = await build(impl);
        await store.createMemory(ctx, fixture("x"));
        expect(await notFoundId(() => call(store, id)), impl).toBe(id);
      }
    },
  );

  it.each(REF_MOUTHS)("参照先が無い %s: 小文字", async (_n, call) => {
    for (const impl of ["postgres", "fixture"] as const) {
      await resetTestDatabase();
      const store = await build(impl);
      const x = await store.createMemory(ctx, fixture("x"));
      expect(await notFoundId(() => call(store, x)), impl).toBe(U.toLowerCase());
    }
  });

  it("使用の記録の memoryIds が無い: 小文字", async () => {
    for (const impl of ["postgres", "fixture"] as const) {
      await resetTestDatabase();
      const store = await build(impl);
      const recallId = await store.createRecall(ctx, {
        tenantId: ctx.tenantId,
        subjectId: null,
        query: { text: "q" },
        budget: null,
        omitted: [],
        usage: { chars: 0, estimatedTokens: 0, counter: "heuristic", memories: 0 },
        indexBand: { groups: [], totalInScope: 0, countKind: "exact" },
        explain: { stages: [] },
        returnedMemories: [],
        createdAt: new Date(),
      } as never);
      expect(await notFoundId(() => store.recordUsage(ctx, recallId, [U])), impl).toBe(
        U.toLowerCase(),
      );
    }
  });
});

describe("decayFloorAt が無い新しい記憶は、fixture も Postgres と同じく書く前に断る", () => {
  const variants: Array<[string, (m: NewMemory) => NewMemory]> = [
    ["null", (m) => ({ ...m, decayFloorAt: null }) as unknown as NewMemory],
    ["undefined", (m) => ({ ...m, decayFloorAt: undefined }) as unknown as NewMemory],
    [
      "キーなし",
      (m) => {
        const { decayFloorAt: _omit, ...rest } = m;
        return rest as NewMemory;
      },
    ],
  ];

  it.each(variants)(
    "createMemory・createMemoryWithOutbox・supersedeWithNewMemories: %s",
    async (_n, broken) => {
      for (const impl of ["postgres", "fixture"] as const) {
        await resetTestDatabase();
        const store = await build(impl);
        const target = await store.createMemory(ctx, fixture("target"));
        await expect(store.createMemory(ctx, broken(fixture("a"))), impl).rejects.toThrow();
        await expect(
          store.createMemoryWithOutbox(ctx, broken(fixture("b")), []),
          impl,
        ).rejects.toThrow();
        await expect(
          store.supersedeWithNewMemories!(
            ctx,
            [{ input: broken(fixture("c")), jobKinds: [] }],
            [{ id: target.id, supersededByIndex: 0, event: ev(target.id, "superseded") }],
          ),
          impl,
        ).rejects.toThrow();
        expect((await store.get(ctx, target.id))?.status, impl).toBe("active");
      }
    },
  );

  it("冪等の既存の行が在っても断る（null）", async () => {
    for (const impl of ["postgres", "fixture"] as const) {
      await resetTestDatabase();
      const store = await build(impl);
      await store.createMemory(ctx, fixture("same"));
      await expect(
        store.createMemory(ctx, { ...fixture("same"), decayFloorAt: null } as unknown as NewMemory),
        impl,
      ).rejects.toThrow();
    }
  });

  it("陽性対照: decayFloorAt が Date なら、どちらも書ける", async () => {
    for (const impl of ["postgres", "fixture"] as const) {
      await resetTestDatabase();
      const store = await build(impl);
      const m = await store.createMemory(ctx, fixture("ok"));
      expect(m.decayFloorAt, impl).toBeInstanceOf(Date);
    }
  });
});
