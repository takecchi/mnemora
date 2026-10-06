// 確かめ直し（Issue #1759、B 群 #1603 / ADR 0493 E1）の歯。
//
// ADR 0493 E1: 「全 Fake の全公開メソッドの冒頭で `assertWellFormedCtx(ctx)` を呼ぶ」。
// 既存の歯（fake-input-checks-round2.test.ts の E1）は 15 口の代表だけを見ていたので、残りのメソッドから
// 呼び出しを外しても赤にならなかった（FakeTenantSettingsStore.setDefaultHalfLifeRecalls・getTaxonomyMode など）。
// ここでは各 Fake の prototype のメソッドを全部列挙し、壊れた ctx（NUL）を渡して MalformedIdentifierError で
// 断ることを見る。ctx を取らない補助のメソッドは EXEMPT に名指しで置く（増えたメソッドが黙って素通りしないよう、
// EXEMPT に無いものは全部この歯が見る）。
import { describe, expect, it } from "vitest";
import { MalformedIdentifierError } from "../identifier.js";
import {
  FakeEventStore,
  FakeLexicalStore,
  FakeMemoryStore,
  FakeOutboxStore,
  FakeRelationStore,
  FakeTenantSettingsStore,
  FakeVectorStore,
} from "./runtime-fakes.js";

const badCtx = { tenantId: "a\u0000b" };

/** ctx を最初の引数に取る公開メソッドではない（内部の補助・テスト用の読み口）。 */
const EXEMPT = new Set([
  "FakeEventStore.events",
  "FakeMemoryStore.assertEventTargetOwn",
  "FakeMemoryStore.assertOwnMemoryRef",
  "FakeMemoryStore.buildOwnedEvent",
  "FakeMemoryStore.createMemoryIdempotent",
  "FakeMemoryStore.createObservationIdempotent",
  "FakeMemoryStore.enqueueJob",
  "FakeMemoryStore.labelKey",
  "FakeMemoryStore.liveOf",
  "FakeMemoryStore.liveRowForTest",
  "FakeMemoryStore.memoryLabelKey",
  "FakeMemoryStore.purgeExpiredEventsSync",
  "FakeMemoryStore.supportsAddOwnSubjectSeq",
  "FakeMemoryStore.upsertProposedLabels",
  "FakeOutboxStore.listJobs",
  "FakeTenantSettingsStore.ensureRow",
  "FakeTenantSettingsStore.eventRetentionDays",
  "FakeTenantSettingsStore.setDefaultHalfLifeRecallsForTest",
  "FakeVectorStore.key",
]);

describe("ADR 0493 E1: 全 Fake の全公開メソッドは壊れた ctx を MalformedIdentifierError で断る", () => {
  const classes = [
    FakeMemoryStore,
    FakeVectorStore,
    FakeLexicalStore,
    FakeEventStore,
    FakeOutboxStore,
    FakeTenantSettingsStore,
    FakeRelationStore,
  ];
  for (const cls of classes) {
    for (const name of Object.getOwnPropertyNames(cls.prototype)) {
      if (name === "constructor" || EXEMPT.has(`${cls.name}.${name}`)) continue;
      it(`${cls.name}.${name}`, async () => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const instance: any = Object.create(cls.prototype);
        let error: unknown;
        try {
          await instance[name](badCtx, {}, {}, {});
        } catch (e) {
          error = e;
        }
        expect(error).toBeInstanceOf(MalformedIdentifierError);
      });
    }
  }
});
