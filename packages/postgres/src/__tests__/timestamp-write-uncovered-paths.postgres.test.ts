import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Ctx, NewMemoryEvent } from "@mnemora/core";
import {
  buildNewMemoryEventFixture,
  buildNewMemoryFixture,
  buildNewObservationFixture,
} from "@mnemora/testkit";
import { PostgresMemoryStore } from "../memory-store.js";
import {
  PostgresTrigramLexicalStore,
  probeTrigramLexicalSupport,
} from "../trigram-lexical-store.js";
import { closeTestClient, getTestClient, resetTestDatabase } from "./test-db.js";

/**
 * SQL に `Date` を渡す口は、すべて `toPgTimestamp`（UTC の文字列）を通す。
 * `conformance.postgres.test.ts` の末尾の検査は適合テストが通る口を見るが、適合テストの入力が
 * 通らない口（`occurredAt` を持つ observation・`reinforceMany` の `unnest` の配列・`markContestedGroup` の
 * JSON のイベント・`resolveOrphanedContested`・trigram の期間／validAt の絞り）は残る。ここで足す。
 *
 * 見るもの: ① 発行された全クエリの束縛値（配列の中も）に `Date` のインスタンスが無いこと。
 * ② JSON の中へ入れる口は、`JSON.stringify(Date)` が出す `+010000-…`（Postgres が読めない形）に
 * ならないこと——5桁の年の `at` で書けること。
 */

const rawDateSites = new Set<string>();
const originalClientQuery = Client.prototype.query;

function containsDate(value: unknown): boolean {
  return value instanceof Date || (Array.isArray(value) && value.some(containsDate));
}

beforeAll(() => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (Client.prototype as any).query = function (this: Client, ...args: unknown[]) {
    const [config, params] = args as [
      string | { text: string; values?: unknown[] },
      unknown[] | undefined,
    ];
    const values = params ?? (typeof config === "string" ? undefined : config.values);
    if (Array.isArray(values) && values.some(containsDate)) {
      const text = typeof config === "string" ? config : config.text;
      rawDateSites.add(text.replace(/\s+/g, " ").trim().slice(0, 100));
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (originalClientQuery as any).apply(this, args);
  };
});

afterAll(async () => {
  Client.prototype.query = originalClientQuery;
  await closeTestClient();
});

beforeEach(async () => {
  await resetTestDatabase();
  rawDateSites.clear();
});

afterEach(() => {
  expect([...rawDateSites]).toEqual([]);
});

const OLD = new Date("1850-01-01T00:00:00.123Z");
const FAR = new Date("+010000-01-01T00:00:00.000Z");
const tenant = () => `ts-uncovered-${randomUUID()}`;

describe("適合テストの入力が通らない口でも、素の Date を pg へ渡さない（Issue #1040）", () => {
  it("createObservation / createObservationWithOutbox: occurredAt・recordedAt・validFrom・validUntil", async () => {
    const { db } = await getTestClient();
    const store = new PostgresMemoryStore(db);
    const ctx: Ctx = { tenantId: tenant() };
    const dates = { occurredAt: OLD, recordedAt: OLD, validFrom: OLD, validUntil: FAR };
    const a = await store.createObservation(
      ctx,
      buildNewObservationFixture({ tenantId: ctx.tenantId, externalId: "obs-a", ...dates }),
    );
    expect(a.occurredAt?.getTime()).toBe(OLD.getTime());
    expect(a.validUntil?.getTime()).toBe(FAR.getTime());
    const b = await store.createObservationWithOutbox(
      ctx,
      buildNewObservationFixture({ tenantId: ctx.tenantId, externalId: "obs-b", ...dates }),
      ["extract"],
      { now: OLD },
    );
    expect(b.observation.occurredAt?.getTime()).toBe(OLD.getTime());
    expect(b.observation.validUntil?.getTime()).toBe(FAR.getTime());
  });

  it("reinforceMany: 強化の下限（decayFloorAt）を配列で渡す口", async () => {
    const { db } = await getTestClient();
    const store = new PostgresMemoryStore(db);
    const ctx: Ctx = { tenantId: tenant() };
    const m = await store.createMemory(
      ctx,
      buildNewMemoryFixture({
        tenantId: ctx.tenantId,
        contentHash: "reinforce-many",
        recordedAt: OLD,
      }),
    );
    const at = new Date(OLD.getTime() + 30 * 24 * 3600 * 1000);
    const [after] = await store.reinforceMany(ctx, [m.id], at);
    expect(after?.lastReinforcedAt?.getTime()).toBe(at.getTime());
  });

  it("markContestedGroup: JSON で渡すイベントの at が、5桁の年でも書ける", async () => {
    const { db } = await getTestClient();
    const store = new PostgresMemoryStore(db);
    const ctx: Ctx = { tenantId: tenant() };
    const members = await Promise.all(
      ["a", "b", "c"].map((h) =>
        store.createMemory(ctx, buildNewMemoryFixture({ tenantId: ctx.tenantId, contentHash: h })),
      ),
    );
    const event = (memoryId: string): NewMemoryEvent =>
      buildNewMemoryEventFixture({
        tenantId: ctx.tenantId,
        memoryId,
        kind: "updated",
        at: FAR,
        meta: { reason: "contested" },
      });
    const result = await store.markContestedGroup!(
      ctx,
      members.map((m) => ({ id: m.id, event: event(m.id) })),
    );
    expect(result.events.map((e) => e.at.getTime())).toEqual([
      FAR.getTime(),
      FAR.getTime(),
      FAR.getTime(),
    ]);
  });

  it("resolveOrphanedContested: イベントの at が、古い日時でも素の Date で渡らない", async () => {
    const { db } = await getTestClient();
    const store = new PostgresMemoryStore(db);
    const ctx: Ctx = { tenantId: tenant() };
    const [a, b] = await Promise.all(
      ["x", "y"].map((h) =>
        store.createMemory(ctx, buildNewMemoryFixture({ tenantId: ctx.tenantId, contentHash: h })),
      ),
    );
    const ev = (memoryId: string): NewMemoryEvent =>
      buildNewMemoryEventFixture({ tenantId: ctx.tenantId, memoryId, kind: "updated", at: OLD });
    await store.markContestedPair(
      ctx,
      { id: a!.id, event: ev(a!.id) },
      { id: b!.id, event: ev(b!.id) },
    );
    await store.resolveOrphanedContested!(ctx, {
      id: a!.id,
      contestedWithId: b!.id,
      event: ev(a!.id),
    });
  });

  it("PostgresTrigramLexicalStore.search: occurredAfter / occurredBefore / validAt を素の Date で渡さない", async () => {
    const { db } = await getTestClient();
    const probe = await probeTrigramLexicalSupport(db);
    if (!probe.ok) return;
    const store = await PostgresTrigramLexicalStore.create(db);
    const ctx: Ctx = { tenantId: tenant() };
    await store.search(ctx, "期間 絞り込み period probe", {
      limit: 5,
      filter: { tenantId: ctx.tenantId, occurredAfter: OLD, occurredBefore: FAR, validAt: OLD },
    });
  });
});
