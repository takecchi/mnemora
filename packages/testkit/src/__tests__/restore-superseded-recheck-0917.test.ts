import type { Ctx } from "@mnemora/core";
import { InMemoryMemoryStore } from "../fixtures.js";
import { describeRestoreSupersededRecheckTeeth } from "./restore-superseded-recheck-0917-teeth.js";

describeRestoreSupersededRecheckTeeth("InMemoryMemoryStore", async () => {
  const store = new InMemoryMemoryStore();
  return {
    store,
    listEvents: async (ctx: Ctx, memoryId) =>
      store.events.filter(
        (e) => e.tenantId === ctx.tenantId && (memoryId === undefined || e.memoryId === memoryId),
      ),
  };
});
