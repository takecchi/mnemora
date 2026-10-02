import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import type { Ctx, Runtime } from "@mnemora/core";
import { createRuntime } from "@mnemora/core";
import {
  InMemoryEventStore,
  InMemoryMemoryStore,
  InMemoryOutboxStore,
  InMemoryTenantSettingsStore,
  InMemoryVectorStore,
} from "@mnemora/testkit/fixtures";
import { PostgresMemoryStore } from "../memory-store.js";
import { PostgresVectorStore } from "../vector-store.js";
import { PostgresEventStore } from "../event-store.js";
import { PostgresOutboxStore } from "../outbox-store.js";
import { PostgresTenantSettingsStore } from "../tenant-settings-store.js";
import {
  closeTestClient,
  getTestClient,
  resetTestDatabase,
  TEST_EMBEDDING_SPACE,
} from "./test-db.js";

/**
 * Runtime の入口が不正な入力に投げる例外の種類を、今のまま縛る（Issue #1184 の案1「今のまま（口ごとの種類を
 * doc に書く）」）。ADR 0496 で `findCorrectionCandidates`・`resolveContested(Group)`・`tick` の型の外の入力を断る例外を足した（下）。
 *
 * 種類は口ごとに違い、揃えていない。揃える（`RangeError`・`TypeError` に寄せる、名前付きの class を足す、など）と、catch している利用者を壊しうるので、
 * どれかが変わればここが赤くなる。揃えるかどうかは #1184 で決めていない。
 *
 * `tick` は、ADR 0496 で入口の検査を足した（`leaseMs` の省略・非有限は `RangeError`、`opts` が object でなければ `TypeError`）。
 * 以前は Runtime が検査せず、`leaseMs` を `OutboxStore.claimBatch` へそのまま渡していたので、顔が store で違った
 * （Postgres は drizzle が包んだ `Error`、fixture は名前の無い `Error`）。いまは store の種類によらず同じ顔になる。
 * その記述を `TickOptions.leaseMs` の TSDoc に書いてあり、TSDoc の記述とここで測った顔を突き合わせる。
 *
 * `registerEmbeddingSpace` のテーブルの衝突（`name` だけの `Error`）は
 * `embedding-space-table-conflict.postgres.test.ts` が縛っている。
 */

const RUNTIME_SOURCE = readFileSync(
  fileURLToPath(new URL("../../../core/src/runtime.ts", import.meta.url)),
  "utf8",
);

/** `export interface TickOptions { … }` の中で、`leaseMs:` の直前の TSDoc を返す。 */
function leaseMsDoc(): string {
  const start = RUNTIME_SOURCE.indexOf("export interface TickOptions {");
  const end = RUNTIME_SOURCE.indexOf("\n}\n", start);
  const block = RUNTIME_SOURCE.slice(start, end);
  const at = block.indexOf("\n  leaseMs: number;");
  if (start < 0 || at < 0) throw new Error("TickOptions.leaseMs が見つからない");
  return block.slice(block.lastIndexOf("/**", at), at);
}

const shared = {
  llmProvider: {
    complete: async () => ({ content: "unused" }),
    completeStructured: async () => {
      throw new Error("not used");
    },
  },
  embeddingProvider: {
    space: TEST_EMBEDDING_SPACE,
    embed: async (_ctx: Ctx, texts: string[]) => texts.map(() => [1, 0, 0]),
  },
  hashContent: (content: string) => createHash("sha256").update(content).digest("hex"),
  // outbox の `available_at` は Postgres では DB の now() で決まるので、積んだジョブが claim できるよう先の時刻にする。
  clock: { now: () => new Date("2100-01-01T00:00:00.000Z") },
};

const KITS: Array<["fixture" | "postgres", string, () => Promise<Runtime>]> = [
  [
    "fixture",
    "testkit の InMemory",
    async () => {
      const memoryStore = new InMemoryMemoryStore();
      return createRuntime({
        ...shared,
        memoryStore,
        eventStore: new InMemoryEventStore(memoryStore, memoryStore.events),
        tenantSettingsStore: new InMemoryTenantSettingsStore(memoryStore.activitySeq),
        vectorStore: new InMemoryVectorStore(memoryStore),
        outboxStore: new InMemoryOutboxStore(memoryStore.outboxJobs),
      });
    },
  ],
  [
    "postgres",
    "Postgres",
    async () => {
      await resetTestDatabase();
      const { db } = await getTestClient();
      return createRuntime({
        ...shared,
        memoryStore: new PostgresMemoryStore(db),
        eventStore: new PostgresEventStore(db),
        tenantSettingsStore: new PostgresTenantSettingsStore(db),
        vectorStore: new PostgresVectorStore(db),
        outboxStore: new PostgresOutboxStore(db),
      });
    },
  ],
];

const ctx: Ctx = { tenantId: "runtime-entry-exception-kinds" };

afterAll(async () => {
  await closeTestClient();
});

async function caught(p: Promise<unknown>): Promise<Error & { cause?: { code?: unknown } }> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(Error);
    return e as Error & { cause?: { code?: unknown } };
  }
  throw new Error("例外にならなかった");
}

/** 組み込みの型付きの例外（`RangeError`・`TypeError`）ではないこと。 */
function expectNotBuiltinTyped(err: Error): void {
  expect(err).not.toBeInstanceOf(RangeError);
  expect(err).not.toBeInstanceOf(TypeError);
}

for (const [, name, makeRuntime] of KITS) {
  describe(`${name}: Runtime の入口の例外の種類（今の振る舞い。#1184 で揃えていない）`, () => {
    it("recall の入力スキーマに合わない limit は ZodError", async () => {
      const runtime = await makeRuntime();
      const err = await caught(runtime.recall(ctx, { text: "x", limit: -1 }));
      expect(err.name).toBe("ZodError");
      expectNotBuiltinTyped(err);
    });

    it("observe の型の外の kind は ZodError", async () => {
      const runtime = await makeRuntime();
      const err = await caught(runtime.observe(ctx, { kind: "bogus", text: "x" } as never));
      expect(err.name).toBe("ZodError");
      expectNotBuiltinTyped(err);
    });

    it("findCorrectionCandidates の正の整数でない limit は RangeError", async () => {
      const runtime = await makeRuntime();
      const err = await caught(runtime.findCorrectionCandidates(ctx, { text: "x", limit: 0 }));
      expect(err.constructor).toBe(RangeError);
      expect(err.message).toBe(
        "Runtime.findCorrectionCandidates: limit must be a positive integer",
      );
    });

    it("findCorrectionCandidates の text が文字列でない・excludeMemoryIds が配列でないは TypeError（ADR 0496）", async () => {
      const runtime = await makeRuntime();
      const e1 = await caught(runtime.findCorrectionCandidates(ctx, {} as never));
      expect(e1.constructor).toBe(TypeError);
      expect(e1.message).toBe("Runtime.findCorrectionCandidates: text must be a string");
      const e2 = await caught(
        runtime.findCorrectionCandidates(ctx, { text: "x", excludeMemoryIds: "abc" } as never),
      );
      expect(e2.constructor).toBe(TypeError);
      expect(e2.message).toBe(
        "Runtime.findCorrectionCandidates: excludeMemoryIds must be an array",
      );
    });

    it("resolveContested の未知の resolution.kind は RangeError（ADR 0496）", async () => {
      const runtime = await makeRuntime();
      const a = "00000000-0000-4000-8000-000000000001";
      const b = "00000000-0000-4000-8000-000000000002";
      const err = await caught(
        runtime.resolveContested(ctx, a as never, b as never, { kind: "weird" } as never),
      );
      expect(err.constructor).toBe(RangeError);
      expect(err.message).toBe(
        'Runtime.resolveContested: resolution.kind must be "supersede" or "both_active"',
      );
    });

    it("markContested の同じ id の組は RangeError", async () => {
      const runtime = await makeRuntime();
      const id = "00000000-0000-4000-8000-000000000001";
      const err = await caught(runtime.markContested(ctx, id as never, id as never));
      expect(err.constructor).toBe(RangeError);
      expect(err.message).toBe("Runtime.markContested: firstId and secondId must differ");
    });

    it("reextract の見つからない id は素の Error（型付き例外ではない）", async () => {
      const runtime = await makeRuntime();
      const id = "00000000-0000-4000-8000-000000000002";
      const err = await caught(runtime.reextract(ctx, id as never));
      expect(err.constructor).toBe(Error);
      expect(err.message).toBe(`runtime.reextract: observation not found: ${id}`);
    });

    it("tick の leaseMs を省略すると、Runtime が検査して RangeError。store の種類によらず同じ顔で、ジョブは claim されない（ADR 0496）", async () => {
      const runtime = await makeRuntime();
      await runtime.observe(ctx, {
        kind: "utterance",
        text: "x",
        speaker: "u",
        extract: "deferred",
      });

      const err = await caught(runtime.tick(ctx, {} as never));
      expect(err.constructor).toBe(RangeError);
      expect(err.message).toBe("Runtime.tick: opts.leaseMs must be a finite number");
      expect(err.cause).toBeUndefined();

      // 落ちた tick が claim していれば、同じ時刻の正しい tick はリース中の行を取れず 0 件になる。
      const after = await runtime.tick(ctx, { kinds: ["extract"], leaseMs: 60_000 });
      expect(after.processed + after.failed).toBe(1);
    });

    it("tick の第2引数ごと省略すると TypeError（Runtime が名指しする。素の「Cannot read properties」ではない）", async () => {
      const runtime = await makeRuntime();
      const err = await caught((runtime.tick as (c: Ctx) => Promise<unknown>)(ctx));
      expect(err.constructor).toBe(TypeError);
      expect(err.message).toBe("Runtime.tick: opts must be an object");
    });
  });
}

describe("TickOptions.leaseMs の TSDoc は、上で測った tick の顔を書いている", () => {
  const doc = leaseMsDoc();

  it("Runtime が入口で検査すること・例外の種類・claim しないこと", () => {
    expect(doc).toMatch(/Runtime が入口で検査する/);
    expect(doc).toContain("`opts` が object でない");
    expect(doc).toMatch(/`TypeError`/);
    expect(doc).toMatch(/有限の数でない/);
    expect(doc).toMatch(/`RangeError`/);
    expect(doc).toContain("Runtime.tick: opts.leaseMs must be a finite number");
    expect(doc).toMatch(/ジョブは claim されない/);
    expect(doc).toContain("runtime-entry-exception-kinds.postgres.test.ts");
  });
});
