import { describe, expect, it } from "vitest";
import { isMalformedIdentifierError } from "@mnemora/core";
import type { Ctx } from "@mnemora/core";
import { InMemoryTenantSettingsStore } from "../__fixtures__/in-memory-tenant-settings-store.js";

// 同梱の store は、`ctx` を取る全メソッドの入口で `tenantId`・`subjectId` の孤立サロゲート・NUL を断る（`Ctx` の doc）。
// 他の引数は正しい形にしておき、`ctx` だけが理由で断られることを見る。書き込みの口は、断ったときに行を作らないことも見る
// （行を作ると、共有の保持期間の Map にそのテナントが立つ）。

const TENANT = "in-memory-tenant-settings-malformed-ctx";

const MALFORMED_CTX: ReadonlyArray<readonly [label: string, ctx: Ctx]> = [
  ["tenantId に孤立した上位サロゲート", { tenantId: `${TENANT}\uD800` }],
  ["tenantId に NUL", { tenantId: `${TENANT}\u0000` }],
  ["subjectId に孤立した下位サロゲート", { tenantId: TENANT, subjectId: "s-\uDC00" }],
  ["subjectId に NUL", { tenantId: TENANT, subjectId: "s-\u0000" }],
];

function setup() {
  const activitySeq = new Map<string, number>([[TENANT, 3]]);
  const subjectActivitySeq = new Map([[TENANT, new Map([["s", 2]])]]);
  const eventRetentionDays = new Map<string, number | null>();
  const store = new InMemoryTenantSettingsStore(
    activitySeq,
    subjectActivitySeq,
    eventRetentionDays,
  );
  return { store, eventRetentionDays };
}

const ENTRIES: ReadonlyArray<
  readonly [name: string, call: (store: InMemoryTenantSettingsStore, bad: Ctx) => Promise<unknown>]
> = [
  ["getDefaultHalfLifeHours", (s, bad) => s.getDefaultHalfLifeHours(bad)],
  ["getEventRetention", (s, bad) => s.getEventRetention(bad)],
  ["setEventRetention", (s, bad) => s.setEventRetention(bad, { kind: "days", days: 30 })],
  ["getDecayClock", (s, bad) => s.getDecayClock(bad)],
  ["setDecayClock", (s, bad) => s.setDecayClock(bad, "activity")],
  ["getDefaultHalfLifeRecalls", (s, bad) => s.getDefaultHalfLifeRecalls(bad)],
  ["setDefaultHalfLifeRecalls", (s, bad) => s.setDefaultHalfLifeRecalls(bad, 100)],
  ["getActivitySeq", (s, bad) => s.getActivitySeq(bad)],
  ["hasSubjectActivityCounters", (s, bad) => s.hasSubjectActivityCounters(bad)],
  ["getSubjectActivitySeqs", (s, bad) => s.getSubjectActivitySeqs(bad, ["s"])],
  ["getTaxonomyMode", (s, bad) => s.getTaxonomyMode(bad)],
  ["setTaxonomyMode", (s, bad) => s.setTaxonomyMode(bad, "strict")],
  ["eraseTenant", (s, bad) => s.eraseTenant(bad, { limit: 10 })],
];

describe("InMemoryTenantSettingsStore は ctx を取る全メソッドの入口で壊れた ctx を断る", () => {
  for (const [name, call] of ENTRIES) {
    it.each(MALFORMED_CTX)(
      `${name}: %s は malformed_identifier で断り、何も書かない`,
      async (_label, bad) => {
        const { store, eventRetentionDays } = setup();
        const error = await call(store, bad).then(
          () => undefined,
          (e: unknown) => e,
        );
        expect(isMalformedIdentifierError(error)).toBe(true);
        expect([...eventRetentionDays.keys()]).toEqual([]);
      },
    );

    it(`${name}: 対をなすサロゲート（絵文字）を含む ctx は断らない`, async () => {
      const { store } = setup();
      // 断れば、ここで例外が上がって赤になる。
      await call(store, { tenantId: `${TENANT}-😀`, subjectId: "s-😀" });
    });
  }
});
