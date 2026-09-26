import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Ctx } from "@mnemora/core";
import { buildNewMemoryFixture } from "@mnemora/testkit";
import { createPostgresClient, type PostgresClient } from "../client.js";
import { PostgresMemoryStore } from "../memory-store.js";
import {
  closeTestClient,
  getTestClient,
  requireDatabaseUrl,
  resetTestDatabase,
} from "./test-db.js";

// 書き込み側（node-postgres は `Date` をプロセスのローカル時刻で文字列にし、時差の秒を
// 切り捨てる）のずれを、この歯から切り離す。ここで見るのは読み取り側（`parsePgTimestamp`）
// だけである。書き込み側は Issue #1040 に分けた。
const ORIGINAL_TZ = process.env.TZ;
process.env.TZ = "UTC";

/**
 * Issue #1039: `timestamptz` の文字列を `Date` にする `parsePgTimestamp`（`mapping.ts`）は、
 * `+09` / `+09:00` の形の時差しか読めなかった。Postgres の既定の出力には次の形もあり、
 * `new Date()` が Invalid Date になって `get()` がそのまま返していた。
 *
 * - 秒を含む時差（`+09:18:59`）——サーバの `TimeZone` が地方平均時（LMT）の時代を持つ
 *   地域のとき、その時代の時刻（Asia/Tokyo では 1888 年より前）
 * - 紀元前の接尾辞（`0001-06-01 00:00:00+00 BC`）
 * - 5桁以上の年（`10000-01-01 00:00:00+00`）
 *
 * `occurredAt` / `validFrom` / `validUntil` は呼び出し側の申告をそのまま受け入れる
 * （ADR 0037 決定3）。受け入れて保存した値は、同じ値として読めなければならない。
 */
const SERVER_TIME_ZONES = ["UTC", "Asia/Tokyo", "America/New_York"] as const;

const DATES = [
  "2026-02-01T00:00:00.123Z",
  "1850-01-01T00:00:00.000Z",
  "1600-06-15T12:34:56.789Z",
  "0000-06-01T00:00:00.000Z",
  "-000100-03-01T00:00:00.000Z",
  "+010000-01-01T00:00:00.000Z",
  "+275760-09-13T00:00:00.000Z",
] as const;

describe("timestamptz の往復: 保存した日時は、サーバの TimeZone によらず同じ日時として読める（Issue #1039、本物の Postgres）", () => {
  const clients = new Map<string, PostgresClient>();

  beforeAll(async () => {
    await getTestClient();
    await resetTestDatabase();
    for (const tz of SERVER_TIME_ZONES) {
      clients.set(tz, createPostgresClient(requireDatabaseUrl(), { options: `-c TimeZone=${tz}` }));
    }
  });

  afterAll(async () => {
    for (const client of clients.values()) {
      await client.pool.end();
    }
    await closeTestClient();
    if (ORIGINAL_TZ === undefined) {
      delete process.env.TZ;
    } else {
      process.env.TZ = ORIGINAL_TZ;
    }
  });

  for (const tz of SERVER_TIME_ZONES) {
    for (const iso of DATES) {
      it(`TimeZone=${tz}: ${iso}`, async () => {
        const client = clients.get(tz)!;
        const store = new PostgresMemoryStore(client.db);
        const ctx: Ctx = { tenantId: `timestamp-roundtrip-${tz}` };
        const at = new Date(iso);
        const created = await store.createMemory(
          ctx,
          buildNewMemoryFixture({
            tenantId: ctx.tenantId,
            occurredAt: at,
            validFrom: at,
            validUntil: at,
          }),
        );
        const got = await store.get(ctx, created.id);
        expect(got?.occurredAt?.toISOString()).toBe(iso);
        expect(got?.validFrom?.toISOString()).toBe(iso);
        expect(got?.validUntil?.toISOString()).toBe(iso);
      });
    }
  }
});
