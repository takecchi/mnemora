import { afterAll, describe, expect, it } from "vitest";
import { isMalformedIdentifierError, type Ctx, type TenantSettingsStore } from "@mnemora/core";
import { InMemoryTenantSettingsStore } from "@mnemora/testkit/fixtures";
import { PostgresTenantSettingsStore } from "../tenant-settings-store.js";
import { closeTestClient, getTestClient, resetTestDatabase } from "./test-db.js";

/**
 * ADR 0437 決定2（PR #1545）の確かめ直し（Issue #1734）で足した歯。`getSubjectActivitySeqs` の `subjectIds` の
 * 各要素は、形が壊れていれば `subjectIds[<添字>]` という欄の名前つきで断る（`MalformedIdentifierError` の
 * `field`。値は載せない）。適合テストは「断ること」と例外の kind だけを見ていたので、欄の名前を別の綴りに
 * 変えても緑のままだった。Postgres と testkit の InMemory の両方を見る。
 */

const ctx: Ctx = { tenantId: "tenant-settings-subject-ids-field-name" };

const KITS: Array<[string, () => Promise<TenantSettingsStore>]> = [
  ["testkit の InMemory", async () => new InMemoryTenantSettingsStore()],
  [
    "Postgres",
    async () => {
      await resetTestDatabase();
      const { db } = await getTestClient();
      return new PostgresTenantSettingsStore(db);
    },
  ],
];

afterAll(async () => {
  await closeTestClient();
});

describe.each(KITS)("getSubjectActivitySeqs：subjectIds の欄の名前（%s）", (_name, make) => {
  it.each([
    [0, ["bad\u0000", "alice"]],
    [1, ["alice", "bad\u0000"]],
    [2, ["alice", "bob", "bad\ud800"]],
  ])(
    "subjectIds[%i] が壊れていれば、欄の名前は subjectIds[%i] になる",
    async (index, subjectIds) => {
      const store = await make();

      const reason = await store.getSubjectActivitySeqs!(ctx, subjectIds).then(
        () => undefined,
        (error: unknown) => error,
      );

      expect(isMalformedIdentifierError(reason)).toBe(true);
      expect((reason as { field?: unknown }).field).toBe(`subjectIds[${index}]`);
      expect((reason as Error).message).toContain(`subjectIds[${index}] contains`);
    },
  );
});
