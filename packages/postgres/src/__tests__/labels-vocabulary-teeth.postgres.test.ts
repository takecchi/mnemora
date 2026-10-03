import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import type { Ctx } from "@mnemora/core";
import {
  buildNewMemoryEventFixture,
  buildNewMemoryFixture,
  buildNewObservationFixture,
} from "@mnemora/testkit";
import type { Db } from "../client.js";
import { PostgresMemoryStore } from "../memory-store.js";
import { closeTestClient, getTestClient, resetTestDatabase } from "./test-db.js";

/**
 * `labels`（語彙）の行ロックまわりの約束のうち、並行の歯（`label-lock-order-cross-memory`・
 * `label-upsert-lock-order`）が見ない所を、単体で決定的に縛る（ADR 0511）。
 *
 * - 語彙を先に作らない: 候補ごとの upsert の前に語彙の既存行を `FOR UPDATE` で取るだけで、行を作らない。
 *   書かれなかった候補（`createMemoriesWithOutboxAndEvents` の SAVEPOINT で落ちた候補・冪等衝突の候補、
 *   `supersedeWithNewMemories` の冪等衝突の候補）の語彙は、`listLabels` に増えない。
 * - 件数が 0 になってもラベルを消さない: `purgeMemory` は `proposed_count` を減らすだけで、`labels` の行は残す
 *   （ADR 0375「`labels`（語彙の行）は残す」）。
 * - `upsertProposedLabels` はコードポイント順に処理する: 補助面の文字と BMP 上位の文字で、UTF-16 のコード単位順と
 *   コードポイント順が食い違う。発行した SQL の名前の並びを見る（時刻・並行性に依らず決定的）。
 */

const dialect = new PgDialect();

afterAll(async () => {
  await closeTestClient();
});

beforeEach(async () => {
  await resetTestDatabase();
});

async function labelRows(store: PostgresMemoryStore, ctx: Ctx) {
  return (await store.listLabels(ctx)).map((l) => [l.name, l.status, l.proposedCount]);
}

async function seedObservationAndExisting(store: PostgresMemoryStore, ctx: Ctx) {
  const observation = await store.createObservation(
    ctx,
    buildNewObservationFixture({ tenantId: ctx.tenantId }),
  );
  const existing = await store.createMemory(
    ctx,
    buildNewMemoryFixture({
      tenantId: ctx.tenantId,
      contentHash: "dup",
      content: "dup",
      sourceObservationId: observation.id,
      extractorVersion: "v1",
      tags: [],
    }),
  );
  return { observation, existing };
}

describe("語彙を先に作らない: 書かれなかった候補の語彙は listLabels に増えない", () => {
  it("createMemoriesWithOutboxAndEvents: SAVEPOINT で落ちた候補・冪等衝突の候補の語彙は作られない", async () => {
    const { db } = await getTestClient();
    const store = new PostgresMemoryStore(db);
    const ctx: Ctx = { tenantId: "labels-teeth-create-many" };
    const { observation } = await seedObservationAndExisting(store, ctx);
    const build = (overrides: Parameters<typeof buildNewMemoryFixture>[0]) =>
      buildNewMemoryFixture({
        tenantId: ctx.tenantId,
        sourceObservationId: observation.id,
        extractorVersion: "v1",
        ...overrides,
      });

    const result = await store.createMemoriesWithOutboxAndEvents(
      ctx,
      [
        { input: build({ contentHash: "good", content: "good", tags: ["kept"] }), jobKinds: [] },
        // 本文の NUL は DB が拒む（SAVEPOINT で巻き戻して dropped に積まれる）。
        {
          input: build({ contentHash: "bad", content: "a\u0000b", tags: ["dropped-label"] }),
          jobKinds: [],
        },
        // 冪等の鍵（観測・版・contentHash）が既存の行と同じ: 書かれない。
        {
          input: build({ contentHash: "dup", content: "dup", tags: ["conflict-label"] }),
          jobKinds: [],
        },
      ],
      (memory) => buildNewMemoryEventFixture({ tenantId: ctx.tenantId, memoryId: memory.id }),
    );

    expect(result.written.map((w) => [w.index, w.created])).toEqual([
      [0, true],
      [2, false],
    ]);
    expect(result.dropped.map((d) => d.index)).toEqual([1]);
    expect(await labelRows(store, ctx)).toEqual([["kept", "proposed", 1]]);
  });

  it("supersedeWithNewMemories: 冪等衝突で書かれなかった候補の語彙は作られない", async () => {
    const { db } = await getTestClient();
    const store = new PostgresMemoryStore(db);
    const ctx: Ctx = { tenantId: "labels-teeth-supersede" };
    const { observation } = await seedObservationAndExisting(store, ctx);
    const old = await store.createMemory(
      ctx,
      buildNewMemoryFixture({ tenantId: ctx.tenantId, contentHash: "old", content: "old" }),
    );
    const build = (overrides: Parameters<typeof buildNewMemoryFixture>[0]) =>
      buildNewMemoryFixture({
        tenantId: ctx.tenantId,
        sourceObservationId: observation.id,
        extractorVersion: "v1",
        ...overrides,
      });

    const result = await store.supersedeWithNewMemories(
      ctx,
      [
        { input: build({ contentHash: "good", content: "good", tags: ["kept"] }), jobKinds: [] },
        {
          input: build({ contentHash: "dup", content: "dup", tags: ["conflict-label"] }),
          jobKinds: [],
        },
      ],
      [
        {
          id: old.id,
          supersededByIndex: 0,
          event: buildNewMemoryEventFixture({
            tenantId: ctx.tenantId,
            memoryId: old.id,
            kind: "superseded",
          }),
        },
      ],
    );

    expect(result.created.map((c) => c.created)).toEqual([true, false]);
    expect(await labelRows(store, ctx)).toEqual([["kept", "proposed", 1]]);
  });
});

describe("件数が 0 になってもラベルを消さない", () => {
  it("purgeMemory: proposedCount が 0 になったラベルの行は、count 0 の proposed のまま残る", async () => {
    const { db } = await getTestClient();
    const store = new PostgresMemoryStore(db);
    const ctx: Ctx = { tenantId: "labels-teeth-purge-keeps-label" };
    const memory = await store.createMemory(
      ctx,
      buildNewMemoryFixture({
        tenantId: ctx.tenantId,
        contentHash: "to-purge",
        content: "to-purge",
        tags: ["only-here", "shared"],
      }),
    );
    await store.createMemory(
      ctx,
      buildNewMemoryFixture({
        tenantId: ctx.tenantId,
        contentHash: "other",
        content: "other",
        tags: ["shared"],
      }),
    );
    expect(await labelRows(store, ctx)).toEqual([
      ["only-here", "proposed", 1],
      ["shared", "proposed", 2],
    ]);

    await store.updateStatus(ctx, memory.id, "forgotten");
    await store.purgeMemory(
      ctx,
      memory.id,
      { content: "[p]", digest: "[p]" },
      buildNewMemoryEventFixture({ tenantId: ctx.tenantId, memoryId: memory.id, kind: "purged" }),
    );

    expect(await labelRows(store, ctx)).toEqual([
      ["only-here", "proposed", 0],
      ["shared", "proposed", 1],
    ]);
  });
});

/** 実際に発行された `INSERT INTO labels` の名前を、発行された順に集める。 */
function spyOnLabelInserts(db: Db, log: string[]): Db {
  const record = (query: unknown): void => {
    const built = dialect.sqlToQuery(query as SQL);
    if (built.sql.includes("INSERT INTO labels")) {
      log.push(built.params[1] as string);
    }
  };
  const wrap = <T extends object>(target: T): T =>
    new Proxy(target, {
      get(t, prop) {
        const value = Reflect.get(t, prop, t) as unknown;
        if (prop === "execute") {
          return (query: unknown) => {
            record(query);
            return (value as (q: unknown) => unknown).call(t, query);
          };
        }
        if (prop === "transaction") {
          return (callback: (tx: object) => unknown, config?: unknown) =>
            (value as (cb: unknown, c?: unknown) => unknown).call(
              t,
              (tx: object) => callback(wrap(tx)),
              config,
            );
        }
        return typeof value === "function"
          ? (value as (...a: unknown[]) => unknown).bind(t)
          : value;
      },
    });
  return wrap(db);
}

describe("upsertProposedLabels はコードポイント順に処理する", () => {
  // コードポイント順: tag-a (U+0061) < tag-～ (U+FF5E) < tag-😀 (U+1F600)。
  // UTF-16 のコード単位順だと tag-😀（高位サロゲート D83D）が tag-～（FF5E）より前に来る。
  const ASCII = "tag-a";
  const BMP_HIGH = "tag-\u{FF5E}";
  const ASTRAL = "tag-\u{1F600}";
  const EXPECTED = [ASCII, BMP_HIGH, ASTRAL];

  const inputOrders: Array<[string, string[]]> = [
    ["コードポイント順", [ASCII, BMP_HIGH, ASTRAL]],
    ["UTF-16 順", [ASCII, ASTRAL, BMP_HIGH]],
    ["逆順", [ASTRAL, BMP_HIGH, ASCII]],
  ];

  it.each(inputOrders)(
    "tags の並びが %s でも、labels への INSERT はコードポイント順（Memory.tags の並びは変えない）",
    async (_label, tags) => {
      const { db } = await getTestClient();
      const log: string[] = [];
      const store = new PostgresMemoryStore(spyOnLabelInserts(db, log));
      const ctx: Ctx = { tenantId: "labels-teeth-code-point-order" };
      const memory = await store.createMemory(
        ctx,
        buildNewMemoryFixture({
          tenantId: ctx.tenantId,
          contentHash: "code-point-order",
          content: "code-point-order",
          tags,
        }),
      );
      expect(log).toEqual(EXPECTED);
      expect(memory.tags).toEqual(tags);
    },
  );

  it("名前の並びが期待どおりの文字を含む（\\u{...} の取り違えを防ぐ）", () => {
    expect([...ASTRAL].map((c) => c.codePointAt(0))).toEqual([0x74, 0x61, 0x67, 0x2d, 0x1f600]);
    expect([...BMP_HIGH].at(-1)!.codePointAt(0)).toBe(0xff5e);
    // UTF-16 のコード単位順では、この2つの並びは逆になる（これが並びの歯の前提）。
    expect([ASTRAL, BMP_HIGH].sort()).toEqual([ASTRAL, BMP_HIGH]);
  });
});
