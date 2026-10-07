import { afterAll, describe, expect, it } from "vitest";
import { checkScopeDemo, runScopeDemo } from "../scope.js";
import { createExampleRuntime } from "../runtime-factory.js";
import {
  closeTestClient,
  getTestClient,
  requireDatabaseUrl,
  resetTestDatabase,
} from "./test-db.js";

describe("examples/chat: scope（tenantId/subjectId、本物の Postgres）", () => {
  it("subjectId を指定すると、他 subject の記憶は返らない", async () => {
    await resetTestDatabase();
    await getTestClient();
    const handle = await createExampleRuntime(requireDatabaseUrl(), {});
    try {
      expect(handle.mode).toBe("deterministic");
      const result = await runScopeDemo(
        handle.runtime,
        "example-chat-scope-test",
        "example-chat-scope-test-other",
      );
      const check = checkScopeDemo(result);

      expect(result.aliceOnly.memories.length).toBeGreaterThan(0);

      expect(check.aliceOnlyHasAlice).toBe(true);
      expect(check.aliceOnlyExcludesBob).toBe(true);
    } finally {
      await handle.close();
    }
  });

  it("subjectId を省略すると、テナント内の全 subject（alice・bob 両方）が対象になる", async () => {
    await resetTestDatabase();
    await getTestClient();
    const handle = await createExampleRuntime(requireDatabaseUrl(), {});
    try {
      const result = await runScopeDemo(
        handle.runtime,
        "example-chat-scope-test-wide",
        "example-chat-scope-test-wide-other",
      );
      const check = checkScopeDemo(result);

      expect(check.tenantWideHasAlice).toBe(true);
      expect(check.tenantWideHasBob).toBe(true);
      expect(result.tenantWide.memories.length).toBeGreaterThanOrEqual(
        result.aliceOnly.memories.length,
      );
    } finally {
      await handle.close();
    }
  });

  it("別テナントで recall すると、元のテナントの記憶は1件も返らない", async () => {
    await resetTestDatabase();
    await getTestClient();
    const handle = await createExampleRuntime(requireDatabaseUrl(), {});
    try {
      const result = await runScopeDemo(
        handle.runtime,
        "example-chat-scope-test-tenant",
        "example-chat-scope-test-tenant-other",
      );
      const check = checkScopeDemo(result);

      expect(result.tenantWide.memories.length).toBeGreaterThan(0);

      expect(result.otherTenant.memories.length).toBe(0);
      expect(check.otherTenantIsEmpty).toBe(true);
    } finally {
      await handle.close();
    }
  });
});

afterAll(async () => {
  await closeTestClient();
});
