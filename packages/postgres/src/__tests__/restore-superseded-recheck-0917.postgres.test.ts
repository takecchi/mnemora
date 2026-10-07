import { afterAll } from "vitest";
import type { Ctx } from "@mnemora/core";
import { describeRestoreSupersededRecheckTeeth } from "../../../testkit/src/__tests__/restore-superseded-recheck-0917-teeth.js";
import { PostgresEventStore } from "../event-store.js";
import { PostgresMemoryStore } from "../memory-store.js";
import { closeTestClient, getTestClient, resetTestDatabase } from "./test-db.js";

afterAll(async () => {
  await closeTestClient();
});

describeRestoreSupersededRecheckTeeth("PostgresMemoryStore", async () => {
  await resetTestDatabase();
  const { db } = await getTestClient();
  const events = new PostgresEventStore(db);
  return {
    store: new PostgresMemoryStore(db),
    listEvents: (ctx: Ctx, memoryId) =>
      events.list(ctx, memoryId === undefined ? {} : { memoryId }),
  };
});
