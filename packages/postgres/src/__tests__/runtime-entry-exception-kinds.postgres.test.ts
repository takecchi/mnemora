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
 * doc に書く）」）。振る舞いは変えていない。
 *
 * 種類は口ごとに違い、揃えていない。揃える（`RangeError`・`TypeError` に寄せる、名前付きの class を足す、
 * `tick` に `leaseMs` の検査を足す、など）と、catch している利用者を壊しうるので、どれかが変わればここが赤くなる。
 * 揃えるかどうかは #1184 で決めていない。
 *
 * `tick` だけは Runtime が検査せず、`leaseMs` を `OutboxStore.claimBatch` へそのまま渡すので、顔が store で違う。
 * その実測を `TickOptions.leaseMs` の TSDoc に書いてあり、TSDoc の記述とここで測った顔を突き合わせる。
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

const FIXTURE_CLAIM_MESSAGE_PREFIX = "claimBatch: now - leaseMs must be a valid Date";

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

for (const [kind, name, makeRuntime] of KITS) {
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

    it("tick の leaseMs を省略すると、Runtime は検査せず store の顔で落ち、ジョブは claim されない", async () => {
      const runtime = await makeRuntime();
      await runtime.observe(ctx, {
        kind: "utterance",
        text: "x",
        speaker: "u",
        extract: "deferred",
      });

      const err = await caught(runtime.tick(ctx, {} as never));
      expectNotBuiltinTyped(err);
      expect(err.name).toBe("Error");
      if (kind === "postgres") {
        expect(err.cause?.code).toBe("22007");
      } else {
        expect(err.constructor).toBe(Error);
        expect(err.cause).toBeUndefined();
        expect(err.message.startsWith(FIXTURE_CLAIM_MESSAGE_PREFIX)).toBe(true);
      }

      // 落ちた tick が claim していれば、同じ時刻の正しい tick はリース中の行を取れず 0 件になる。
      const after = await runtime.tick(ctx, { kinds: ["extract"], leaseMs: 60_000 });
      expect(after.processed + after.failed).toBe(1);
    });

    it("tick の第2引数ごと省略すると TypeError", async () => {
      const runtime = await makeRuntime();
      const err = await caught((runtime.tick as (c: Ctx) => Promise<unknown>)(ctx));
      expect(err.constructor).toBe(TypeError);
    });
  });
}

describe("TickOptions.leaseMs の TSDoc は、上で測った tick の顔を書いている", () => {
  const doc = leaseMsDoc();

  it("省略したとき Runtime が検査しないこと・store ごとの顔・claim しないこと", () => {
    expect(doc).toMatch(/`leaseMs` を省略/);
    expect(doc).toMatch(/Runtime は検査せず/);
    expect(doc).toContain("`22007`");
    expect(doc).toContain("`err.cause.code`");
    expect(doc).toContain(FIXTURE_CLAIM_MESSAGE_PREFIX);
    expect(doc).toMatch(/`RangeError`・`TypeError` ではない/);
    expect(doc).toMatch(/ジョブは claim されない/);
    expect(doc).toMatch(/`tick\(ctx\)`[^。]*`TypeError`/);
    expect(doc).toContain("runtime-entry-exception-kinds.postgres.test.ts");
  });
});
