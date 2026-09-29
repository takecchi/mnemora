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
 * `purgeExpiredEventsForTenant` が保持期間を読んでから消すまでの間に `setEventRetention` で期間を変えたとき、
 * **変えた後の期間を守る**ことを縛る（Issue #1232 の修正）。以前はここで「読んだときの30日で消す」——
 * つまり `setEventRetention` の呼び出しが返った後にもかかわらず古い期間で監査ログを消してしまう——
 * 今の（バグの）振る舞いを縛っていた。`MemoryStore.purgeExpiredEventsByRetention?`
 * （`packages/core/src/interfaces/memory-store.ts`）が「保持期間を読むことと削除することを1つの
 * 原子的な操作にする」ことで、この race を閉じた。
 *
 * 読んだ直後を門で止め、止めている間に設定を変えて返らせてから門を外す。門が止めているのは
 * `purgeExpiredEventsForTenant` 冒頭の `tenantSettingsStore.getEventRetention` 呼び出し（unset/unlimited を
 * 判定するためだけの読み）——`memoryStore.purgeExpiredEventsByRetention` 自身の内部の読み（Postgres なら
 * `tenant_settings` 行への `SELECT ... FOR SHARE`）はこの門の**外**にあり、`setEventRetention` が commit
 * した**後**に実行される。だから、外側の読みが古い値（30日）で止まっていても、実際に何日で消すかは
 * 内側の読みが見る最新の値になる——これが Issue #1232 を閉じる仕組みそのものである。
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
        // `eventRetentionDays` を共有することで、`setEventRetention`（書く側）と
        // `memoryStore.purgeExpiredEventsByRetention`（読む側）が同じ値を見る
        // （`InMemoryTenantSettingsStore` クラス doc の2026-09-29追記参照）。
        settings: new InMemoryTenantSettingsStore(
          memoryStore.activitySeq,
          undefined,
          memoryStore.eventRetentionDays,
        ),
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

/**
 * ラベル・`setEventRetention` に渡す変更後の値・変更後に期待する `purgeExpiredEventsForTenant` の
 * outcome・40日前/100日前の各イベントが消えるかどうか、の組。
 *
 * - 無期限にした場合: `memoryStore.purgeExpiredEventsByRetention` 自身の内側の読みが `unlimited` を見るので、
 *   `purgeExpiredEventsForTenant` は `{ kind: "unlimited" }` を返し、1件も消えない（40日前・100日前とも残る）。
 * - 60日に延ばした場合: 内側の読みが `{ kind: "days", days: 60 }` を見るので、cutoff は「60日前」になる。
 *   40日前のイベントは cutoff より新しい（残る）。100日前のイベントは cutoff より古い（消える）。
 */
const CHANGES: Array<
  [
    string,
    EventRetentionSetting,
    { kind: "unlimited" } | { kind: "executed"; purged: number },
    { fortyDaysAgoDeleted: boolean; hundredDaysAgoDeleted: boolean },
  ]
> = [
  [
    "無期限にしても",
    { kind: "unlimited" },
    { kind: "unlimited" },
    { fortyDaysAgoDeleted: false, hundredDaysAgoDeleted: false },
  ],
  [
    "60日に延ばしても",
    { kind: "days", days: 60 },
    { kind: "executed", purged: 1 },
    { fortyDaysAgoDeleted: false, hundredDaysAgoDeleted: true },
  ],
];

for (const [name, makeKit] of KITS) {
  describe(`${name}: 掃除が保持期間を読んだ後に setEventRetention で変えたとき（Issue #1232 の修正後の振る舞い）`, () => {
    it.each(CHANGES)(
      "%s、掃除は変えた後の期間を守る",
      async (_label, change, expectedOutcome, expected) => {
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

        if (expectedOutcome.kind === "unlimited") {
          expect(await pending).toEqual({ kind: "unlimited" });
        } else {
          expect(await pending).toMatchObject({
            kind: "executed",
            result: { purged: expectedOutcome.purged },
          });
        }

        const fortyDaysAgoRow = await kit.eventStore.get(ctx, fortyDaysAgo.id);
        const hundredDaysAgoRow = await kit.eventStore.get(ctx, hundredDaysAgo.id);
        if (expected.fortyDaysAgoDeleted) {
          expect(fortyDaysAgoRow).toBeNull();
        } else {
          expect(fortyDaysAgoRow).not.toBeNull();
        }
        if (expected.hundredDaysAgoDeleted) {
          expect(hundredDaysAgoRow).toBeNull();
        } else {
          expect(hundredDaysAgoRow).not.toBeNull();
        }
      },
    );
  });
}
