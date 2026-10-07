import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { measureNewMemoriesEmbedding, runConsolidationCost } from "../consolidation-cost.js";
import { lookupLatestEmbedFailureKind } from "../embed-failure-kind.js";
import { warmupLocalEmbedding } from "../local-embedding-warmup.js";
import { localEmbeddingCacheDirEnv } from "../providers.js";
import { createExampleRuntime } from "../runtime-factory.js";
import {
  closeTestClient,
  getTestClient,
  requireDatabaseUrl,
  resetTestDatabase,
} from "./test-db.js";

describe("consolidation-cost: round の進行(deterministic embedding、配線の検査)", () => {
  it("haystackSize=6・groupSize=3で、round が進むごとに activeCount が減り、候補が2件未満で打ち切る", async () => {
    await resetTestDatabase();
    await getTestClient();
    const handle = await createExampleRuntime(requireDatabaseUrl(), {
      MNEMORA_LLM: "deterministic",
      MNEMORA_EMBEDDING: "deterministic",
    });
    try {
      const json = await runConsolidationCost({
        runtime: handle.runtime,
        memoryStore: handle.memoryStore,
        embeddingProvider: handle.embeddingProvider,
        pool: handle.pool,
        llmMode: handle.llmMode,
        embeddingMode: handle.embeddingMode,
        tenantId: `consolidation-cost-test-${Date.now()}`,
        groupSize: 3,
        budgetLadder: [32, 128],
        recallLimit: 50,
        measuredAt: new Date(),
        commit: null,
        haystackSize: 6,
      });

      expect(json.schemaVersion).toBe(1);
      expect(json.probeCount).toBe(7);
      expect(json.haystackSize).toBe(6);
      expect(json.groupSize).toBe(3);
      expect(json.budgetLadder).toEqual([32, 128]);

      expect(json.rounds[0]?.round).toBe(0);
      expect(json.rounds[0]?.consolidation).toBeNull();
      expect(json.rounds[0]?.store.activeCount).toBe(20);
      expect(json.rounds[0]?.store.supersededCount).toBe(0);

      expect(json.rounds[1]?.round).toBe(1);
      expect(json.rounds[1]?.consolidation?.groups).toBe(2);
      expect(json.rounds[1]?.consolidation?.newMemoryCount).toBe(2);
      expect(json.rounds[1]?.consolidation?.outcomes.consolidated).toBe(2);
      expect(json.rounds[1]?.store.activeCount).toBe(16);
      expect(json.rounds[1]?.store.supersededCount).toBe(6);

      expect(json.rounds[2]?.round).toBe(2);
      expect(json.rounds[2]?.consolidation?.groups).toBe(1);
      expect(json.rounds[2]?.consolidation?.newMemoryCount).toBe(1);
      expect(json.rounds[2]?.store.activeCount).toBe(15);
      expect(json.rounds[2]?.store.supersededCount).toBe(8);

      expect(json.rounds).toHaveLength(3);
      expect(json.stoppedAfterRound).toBe(2);
      expect(json.stopReason).toBe("insufficient_candidates");

      const allContentChars = json.rounds.map((r) => r.store.allContentChars);
      for (let i = 1; i < allContentChars.length; i += 1) {
        expect(allContentChars[i]!).toBeGreaterThan(allContentChars[i - 1]!);
      }

      for (const round of json.rounds) {
        if (round.consolidation) {
          expect(round.consolidation.embeddingStatus.failed).toBe(0);
          expect(round.consolidation.embeddingFailureKinds).toEqual([]);
        }
      }
    } finally {
      await handle.close();
    }
  });
});

describe("consolidation-cost: 埋め込みの入力上限(ADR 0090)への着地", () => {
  it("巨大な utterance を observe すると embeddingStatus が failed になり、kind が input_too_long と分かる", async () => {
    await resetTestDatabase();
    await getTestClient();
    const handle = await createExampleRuntime(requireDatabaseUrl(), {
      MNEMORA_LLM: "deterministic",
      MNEMORA_EMBEDDING: "local",
      ...localEmbeddingCacheDirEnv(),
    });
    try {
      const warmup = await warmupLocalEmbedding(handle.embeddingProvider);
      expect(warmup.ok, warmup.detail).toBe(true);
      const ctx = { tenantId: `consolidation-cost-toolong-${Date.now()}` };
      // 8192 トークンの壁（ADR 0090）を越えるため、46字を巡回させる。1文字の繰り返しは BPE に圧縮されて壁を越えない。
      // 多様な語彙の長文は tokenizer.encode() が重すぎる（ADR 0139）。
      const KANA_CYCLE =
        "あいうえおかきくけこさしすせそたちつてとなにぬねのはひふへほまみむめもやゆよらりるれろわをん";
      const hugeText = Array.from(
        { length: 12_000 },
        (_, i) => KANA_CYCLE[i % KANA_CYCLE.length],
      ).join("");
      const observed = await handle.runtime.observe(ctx, {
        kind: "utterance",
        text: hugeText,
        externalId: "huge-one",
      });
      expect(observed.memoryIds).toHaveLength(1);
      const memoryId = observed.memoryIds[0]!;

      await handle.runtime.tick(ctx, { kinds: ["embed"], leaseMs: 30 * 60 * 1000 });

      const memory = await handle.memoryStore.get(ctx, memoryId);
      expect(memory?.embeddingStatus).toBe("failed");

      const kind = await lookupLatestEmbedFailureKind(handle.pool, ctx.tenantId, memoryId);
      expect(kind).toBe("input_too_long");

      const measured = await measureNewMemoriesEmbedding(handle.memoryStore, handle.pool, ctx, [
        memoryId,
      ]);
      expect(measured.embeddingStatus).toEqual({ ok: 0, pending: 0, failed: 1 });
      expect(measured.embeddingFailureKinds).toEqual(["input_too_long"]);
    } finally {
      await handle.close();
    }
    // 既定の30秒へは寄せず、CI のばらつきへの余裕を残す（ADR 0139）。
  }, 60_000);
});

const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));

let workDir: string | undefined;

afterEach(() => {
  if (workDir) {
    rmSync(workDir, { recursive: true, force: true });
    workDir = undefined;
  }
});

afterAll(async () => {
  await closeTestClient();
});

describe("consolidation-cost: MNEMORA_CONSOLIDATION_JSON の配線(本物の CLI を子プロセスで起動)", () => {
  it("サブコマンドが実際に走り、JSON を書く", () => {
    workDir = mkdtempSync(join(tmpdir(), "consolidation-cost-wiring-"));
    const jsonPath = join(workDir, "consolidation-cost.json");

    const env: Record<string, string | undefined> = {
      ...process.env,
      DATABASE_URL: requireDatabaseUrl(),
      MNEMORA_CONSOLIDATION_JSON: jsonPath,
    };
    delete env.OPENAI_API_KEY;

    const result = spawnSync(
      "pnpm",
      ["--filter", "@mnemora/example-chat", "run", "consolidation-cost"],
      {
        cwd: repoRoot,
        env,
        encoding: "utf8",
        timeout: 120_000,
      },
    );

    expect(result.status, `stderr:\n${result.stderr}\nstdout:\n${result.stdout}`).toBe(0);
    expect(existsSync(jsonPath)).toBe(true);
    expect(result.stdout).toContain("[consolidation-cost] 機械可読な結果を書き出した");

    const json = JSON.parse(readFileSync(jsonPath, "utf8"));
    expect(json.schemaVersion).toBe(1);
    expect(json.status).toBe("measured");
    expect(json.llmMode).toBe("deterministic");
    expect(json.embeddingMode).toBe("local");
    expect(json.embeddingSpace.provider).toBe("local");
    expect(json.probeCount).toBe(7);
    expect(json.haystackSize).toBe(60);
    expect(json.groupSize).toBe(5);
    expect(Array.isArray(json.rounds)).toBe(true);
    expect(json.rounds.length).toBeGreaterThan(1);
    expect(json.rounds[0].consolidation).toBeNull();
    expect(json.commit === null || /^[0-9a-f]{40}$/.test(json.commit)).toBe(true);
  }, 120_000);
});
