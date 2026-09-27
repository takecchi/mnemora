import { afterAll, describe, expect, it } from "vitest";
import type {
  Ctx,
  EventStore,
  EventRetentionSetting,
  MemoryStore,
  TenantSettingsStore,
} from "@mnemora/core";
import { purgeExpiredEventsForTenant } from "@mnemora/core";
import { buildNewMemoryFixture } from "@mnemora/testkit";
import {
  InMemoryEventStore,
  InMemoryMemoryStore,
  InMemoryTenantSettingsStore,
} from "@mnemora/testkit/fixtures";
import { PostgresMemoryStore } from "../memory-store.js";
import { PostgresEventStore } from "../event-store.js";
import { PostgresTenantSettingsStore } from "../tenant-settings-store.js";
import { closeTestClient, getTestClient, resetTestDatabase } from "./test-db.js";

/**
 * `purgeExpiredEventsForTenant` が保持期間を読んでから消すまでの間に `setEventRetention` が期間を変えたときの
 * 今の振る舞いを縛る（Issue #1232。`purgeExpiredEventsForTenant` の doc の 2026-09-27 追記）。振る舞いは変えていない。
 *
 * 読んだ直後を門で止め、止めている間に設定を変えて返らせてから門を外す。掃除は読んだときの日数で消す。
 * Postgres と testkit の fixture で同じ。
 */

interface Kit {
  memoryStore: MemoryStore;
  eventStore: EventStore;
  settings: TenantSettingsStore;
}

const KITS: Array<[string, () => Promise<Kit>]> = [
  [
    "testkit の InMemory",
    async () => {
      const memoryStore = new InMemoryMemoryStore();
      return {
        memoryStore,
        eventStore: new InMemoryEventStore(memoryStore, memoryStore.events),
        settings: new InMemoryTenantSettingsStore(memoryStore.activitySeq),
      };
    },
  ],
  [
    "Postgres",
    async () => {
      await resetTestDatabase();
      const { db } = await getTestClient();
      return {
        memoryStore: new PostgresMemoryStore(db),
        eventStore: new PostgresEventStore(db),
        settings: new PostgresTenantSettingsStore(db),
      };
    },
  ],
];

const ctx: Ctx = { tenantId: "event-retention-change-during-purge" };
const NOW = new Date("2030-01-01T00:00:00.000Z");
const DAY = 86_400_000;

/** `settings.getEventRetention` の次の1回を、読み終えた直後で止める。 */
function holdAfterNextRead(settings: TenantSettingsStore): {
  stopped: Promise<void>;
  resume: () => void;
} {
  const original = settings.getEventRetention.bind(settings);
  let release: () => void = () => {};
  let reached: () => void = () => {};
  const gate = new Promise<void>((resolve) => (release = resolve));
  const stopped = new Promise<void>((resolve) => (reached = resolve));
  settings.getEventRetention = async (c) => {
    const retention = await original(c);
    settings.getEventRetention = original;
    reached();
    await gate;
    return retention;
  };
  return { stopped, resume: () => release() };
}

afterAll(async () => {
  await closeTestClient();
});

const CHANGES: Array<[string, EventRetentionSetting]> = [
  ["無期限にしても", { kind: "unlimited" }],
  ["60日に延ばしても", { kind: "days", days: 60 }],
];

for (const [name, makeKit] of KITS) {
  describe(`${name}: 掃除が保持期間を読んだ後に setEventRetention で変えたとき（今の振る舞い）`, () => {
    it.each(CHANGES)("%s、掃除は読んだときの30日で消す", async (_label, change) => {
      const kit = await makeKit();
      await kit.settings.setEventRetention(ctx, { kind: "days", days: 30 });
      const memory = await kit.memoryStore.createMemory(
        ctx,
        buildNewMemoryFixture({
          tenantId: ctx.tenantId,
          contentHash: "retention",
          content: "本文",
        }),
      );
      const append = (daysAgo: number) =>
        kit.eventStore.append(ctx, {
          tenantId: ctx.tenantId,
          memoryId: memory.id,
          kind: "updated",
          actor: { type: "system" },
          meta: {},
          at: new Date(NOW.getTime() - daysAgo * DAY),
        });
      const fortyDaysAgo = await append(40);
      const hundredDaysAgo = await append(100);

      const hold = holdAfterNextRead(kit.settings);
      const pending = purgeExpiredEventsForTenant(
        ctx,
        { memoryStore: kit.memoryStore, tenantSettingsStore: kit.settings },
        { limit: 100, now: NOW },
      );
      await hold.stopped;
      await kit.settings.setEventRetention(ctx, change);
      expect(await kit.settings.getEventRetention(ctx)).toEqual(change);
      hold.resume();

      expect(await pending).toMatchObject({ kind: "executed", result: { purged: 2 } });
      expect(await kit.eventStore.get(ctx, fortyDaysAgo.id)).toBeNull();
      expect(await kit.eventStore.get(ctx, hundredDaysAgo.id)).toBeNull();
    });
  });
}
