import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Ctx } from "@mnemora/core";
import { buildNewMemoryFixture } from "@mnemora/testkit";
import { createPostgresClient, type PostgresClient } from "../client.js";
import { PostgresEventStore } from "../event-store.js";
import { PostgresMemoryStore } from "../memory-store.js";
import {
  closeTestClient,
  getTestClient,
  requireDatabaseUrl,
  resetTestDatabase,
} from "./test-db.js";

/**
 * Issue #1040: node-postgres（`pg`）は `Date` のパラメータを**プロセスのローカル時刻**の
 * 文字列にし、時差を分に切り捨てて送る。プロセスの TZ が Asia/Tokyo のとき1850年の日時は
 * 59秒後へ、America/New_York では2秒前へずれて保存されていた。
 *
 * `occurredAt` / `validFrom` / `validUntil` は呼び出し側の申告をそのまま受け入れる
 * （ADR 0037 決定3）。受け入れた値は、プロセスの TZ にもサーバの `TimeZone` にも
 * よらず、同じ瞬間として保存されなければならない。
 *
 * 保存された値は `extract(epoch ...)` のミリ秒で見る——読み取り側（`parsePgTimestamp`、
 * Issue #1039）を経由しないため。WHERE の条件に渡す `Date` も同じずれ方をするので、
 * `EventStore.list` の `since` / `until` を、保存した瞬間ちょうどに置いて見る。
 */
const PROCESS_TIME_ZONES = ["UTC", "Asia/Tokyo", "America/New_York"] as const;
const SERVER_TIME_ZONES = ["UTC", "Asia/Tokyo"] as const;

const DATES = [
  "2026-02-01T00:00:00.123Z",
  "1850-01-01T00:00:00.000Z",
  "1600-06-15T12:34:56.789Z",
  "0000-06-01T00:00:00.000Z",
  "-000100-03-01T00:00:00.000Z",
  "+010000-01-01T00:00:00.000Z",
  "+275760-09-13T00:00:00.000Z",
] as const;

const MEMORY_COLUMNS = [
  "occurred_at",
  "recorded_at",
  "last_reinforced_at",
  "valid_from",
  "valid_until",
  "decay_floor_at",
] as const;

const ORIGINAL_TZ = process.env.TZ;

describe("timestamptz の書き込み: プロセスの TZ によらず、渡した瞬間がそのまま保存される（Issue #1040、本物の Postgres）", () => {
  const clients = new Map<string, PostgresClient>();

  beforeAll(async () => {
    await getTestClient();
    await resetTestDatabase();
    for (const tz of SERVER_TIME_ZONES) {
      clients.set(tz, createPostgresClient(requireDatabaseUrl(), { options: `-c TimeZone=${tz}` }));
    }
  });

  afterAll(async () => {
    if (ORIGINAL_TZ === undefined) {
      delete process.env.TZ;
    } else {
      process.env.TZ = ORIGINAL_TZ;
    }
    for (const client of clients.values()) {
      await client.pool.end();
    }
    await closeTestClient();
  });

  for (const processTz of PROCESS_TIME_ZONES) {
    for (const serverTz of SERVER_TIME_ZONES) {
      for (const iso of DATES) {
        it(`process TZ=${processTz} / server TimeZone=${serverTz}: ${iso}`, async () => {
          process.env.TZ = processTz;
          // プロセスの TZ が実際に効いていることを先に確かめる（効いていなければ、
          // この歯は何も見ていない）。
          const lmtOffset = new Date("1850-01-01T00:00:00.000Z").getTimezoneOffset();
          expect(lmtOffset === 0).toBe(processTz === "UTC");

          const client = clients.get(serverTz)!;
          const store = new PostgresMemoryStore(client.db);
          const events = new PostgresEventStore(client.db);
          const ctx: Ctx = { tenantId: `ts-write-${processTz}-${serverTz}` };
          const at = new Date(iso);
          const expectedMs = String(at.getTime());

          const created = await store.createMemory(
            ctx,
            buildNewMemoryFixture({
              tenantId: ctx.tenantId,
              occurredAt: at,
              recordedAt: at,
              lastReinforcedAt: at,
              validFrom: at,
              validUntil: at,
              decayFloorAt: at,
            }),
          );
          const stored = await client.db.execute(sql`
            SELECT
              (extract(epoch FROM occurred_at) * 1000)::bigint::text AS occurred_at,
              (extract(epoch FROM recorded_at) * 1000)::bigint::text AS recorded_at,
              (extract(epoch FROM last_reinforced_at) * 1000)::bigint::text AS last_reinforced_at,
              (extract(epoch FROM valid_from) * 1000)::bigint::text AS valid_from,
              (extract(epoch FROM valid_until) * 1000)::bigint::text AS valid_until,
              (extract(epoch FROM decay_floor_at) * 1000)::bigint::text AS decay_floor_at
            FROM memories WHERE id = ${created.id}
          `);
          const row = stored.rows[0] as Record<string, string>;
          for (const column of MEMORY_COLUMNS) {
            expect({ column, ms: row[column] }).toEqual({ column, ms: expectedMs });
          }

          const event = await events.append(ctx, {
            tenantId: ctx.tenantId,
            memoryId: created.id,
            kind: "created",
            at,
            actor: { type: "system" },
            meta: {},
          });
          const storedEvent = await client.db.execute(sql`
            SELECT (extract(epoch FROM at) * 1000)::bigint::text AS at
            FROM memory_events WHERE id = ${event.id}
          `);
          expect((storedEvent.rows[0] as { at: string }).at).toBe(expectedMs);

          const listed = await events.list(ctx, {
            memoryId: created.id,
            kind: "created",
            since: at,
            until: at,
          });
          expect(listed.map((e) => e.id)).toEqual([event.id]);
        });
      }
    }
  }
});
