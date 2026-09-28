import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import ts from "typescript";
import { afterAll, describe, expect, it } from "vitest";
import { createRuntime, type Ctx, type RuntimeDeps } from "@mnemora/core";
import {
  buildNewMemoryFixture,
  DeterministicEmbeddingProvider,
  DeterministicLLMProvider,
} from "@mnemora/testkit";
import * as postgres from "../index.js";
import { closeTestClient, getTestClient, requireDatabaseUrl } from "./test-db.js";

/**
 * `packages/postgres/README.md` が約束していて、どのテストも縛っていなかった振る舞いを縛る。
 * 今の振る舞いの固定であり、望ましい姿の主張ではない。
 *
 * - 「動く最小の例」を、LLM・埋め込みだけ `@mnemora/testkit` の決定的な provider に差し替えて、
 *   本物の Postgres に対して observe → tick → recall まで走らせる（README の2026-09-27 追記が手で1回やったこと）。
 *   store は README の片から名前を読んで組み立てる——片の store を差し替えたらこのテストが追う。
 * - `error` リスナーが無い pool は、待機中の接続を切られるとプロセスごと落ちる（付けた場合は
 *   `pool-idle-connection-loss.test.ts` が縛っている。ここは付けない側）。
 * - 拡張を作る段の advisory lock のキー（`EXTENSION_LOCK_KEY`）が README に書いてある
 *   （既定の2本は `scripts/__tests__/readme-postgres-objects.test.mjs` が縛っている）。
 * - 「例外の見分け方」の表の、名前の無い `Error` と DB が拒んだ例外の顔。
 * - 「ほかに export しているもの」の表の名前が、どれも入口から export されている。
 */

const PACKAGE_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const README = readFileSync(path.join(PACKAGE_ROOT, "README.md"), "utf8");
const execFileAsync = promisify(execFile);

/** README の `## <heading>` 節の本文（次の `## ` まで）。 */
function readmeSection(heading: string): string {
  const start = README.indexOf(`\n## ${heading}`);
  if (start === -1) throw new Error(`README に「## ${heading}」の節が見つからない`);
  const end = README.indexOf("\n## ", start + 1);
  return README.slice(start, end === -1 ? undefined : end);
}

describe("README「動く最小の例」: provider を testkit に差し替えて observe → tick → recall が通る", () => {
  afterAll(async () => {
    await closeTestClient();
  });

  it("片が組み立てる store をそのまま使い、observe した記憶が tick の後の recall で返る", async () => {
    const section = readmeSection("動く最小の例");
    const code = section.slice(
      section.indexOf("```ts\n"),
      section.indexOf("\n```", section.indexOf("```ts\n") + 1),
    );
    const stores = [...code.matchAll(/^\s+(\w+): new (Postgres\w+)\(client\.db\),$/gm)].map(
      (m) => ({ key: m[1]!, className: m[2]! }),
    );
    expect(stores.map((s) => s.key).sort(), "片が createRuntime に渡す store の欄").toEqual([
      "eventStore",
      "memoryStore",
      "outboxStore",
      "tenantSettingsStore",
      "vectorStore",
    ]);
    expect(code, "片は埋め込み空間を先に登録している").toContain(
      "await registerEmbeddingSpace(client.pool, embeddingProvider.space);",
    );

    await getTestClient(); // マイグレーション済みにする（片の前提「先に mnemora-postgres-migrate」）
    const client = postgres.createPostgresClient(requireDatabaseUrl());
    try {
      const embeddingProvider = new DeterministicEmbeddingProvider();
      await postgres.registerEmbeddingSpace(client.pool, embeddingProvider.space);
      const classes = postgres as unknown as Record<string, new (db: postgres.Db) => unknown>;
      const storeDeps = Object.fromEntries(
        stores.map(({ key, className }) => [key, new classes[className]!(client.db)]),
      ) as Pick<
        RuntimeDeps,
        "memoryStore" | "vectorStore" | "eventStore" | "outboxStore" | "tenantSettingsStore"
      >;
      const runtime = createRuntime({
        ...storeDeps,
        llmProvider: new DeterministicLLMProvider(),
        embeddingProvider,
        hashContent: (content) => createHash("sha256").update(content).digest("hex"),
      });

      const ctx: Ctx = { tenantId: `readme-minimal-example-${Date.now()}` };
      const observed = await runtime.observe(ctx, {
        kind: "utterance",
        text: "明日、京都へ出張する",
        speaker: "user",
      });
      expect(observed.extraction).toBe("ok");
      expect(observed.memoryIds).toHaveLength(1);

      const ticked = await runtime.tick(ctx, { leaseMs: 30_000 });
      expect(ticked.failed).toBe(0);
      expect(ticked.processed, "埋め込みのジョブが処理される").toBeGreaterThan(0);

      const recalled = await runtime.recall(ctx, { text: "明日、京都へ出張する" });
      expect(recalled.memories.map((m) => m.memoryId)).toContain(observed.memoryIds[0]);
    } finally {
      await postgres.closePostgresClient(client);
    }
  });
});

describe("README「⚠ 接続の `error` リスナーは、利用者が付ける」: 付けないとプロセスが落ちる", () => {
  const TSX_BIN = path.join(PACKAGE_ROOT, "node_modules", ".bin", "tsx");
  const CHILD = path.join("src", "__tests__", "__fixtures__", "pool-idle-loss-child.ts");

  async function runChild(args: string[]): Promise<{ exitCode: number; output: string }> {
    const env = { PATH: process.env.PATH ?? "", DATABASE_URL: requireDatabaseUrl() };
    try {
      const { stdout, stderr } = await execFileAsync(TSX_BIN, [CHILD, ...args], {
        cwd: PACKAGE_ROOT,
        env,
      });
      return { exitCode: 0, output: stdout + stderr };
    } catch (err) {
      const failure = err as NodeJS.ErrnoException & { stdout?: string; stderr?: string };
      return {
        exitCode: typeof failure.code === "number" ? failure.code : 1,
        output: (failure.stdout ?? "") + (failure.stderr ?? ""),
      };
    }
  }

  it("リスナーが無ければ、待機中の接続を切られた時点で Unhandled 'error' event で落ち、次の問い合わせに届かない", async () => {
    const { exitCode, output } = await runChild([]);
    expect(exitCode).not.toBe(0);
    expect(output).toContain("Unhandled 'error' event");
    expect(output).not.toContain("next query:");
  });

  it("陽性対照: 同じ子プロセスでリスナーを付ければ落ちず、次の問い合わせが通る", async () => {
    const { exitCode, output } = await runChild(["listen"]);
    expect(exitCode, output).toBe(0);
    expect(output).toContain("listener: terminating connection due to administrator command");
    expect(output).toContain("next query: 1");
  });
});

describe("README「advisory lock のキー」: 拡張を作る段のキー", () => {
  it("EXTENSION_LOCK_KEY の値が、拡張を作る段の箇条に書いてある", () => {
    const section = readmeSection("この package が作るオブジェクト");
    const bullet = section.split("\n- ").find((b) => b.startsWith("拡張を作る段"));
    expect(bullet, "「拡張を作る段」の箇条").toBeDefined();
    expect(bullet).toContain(`\`${postgres.EXTENSION_LOCK_KEY}\`（\`EXTENSION_LOCK_KEY\`）`);
  });
});

describe("README「例外の見分け方」の表の顔", () => {
  afterAll(async () => {
    await closeTestClient();
  });

  async function rejection(
    fn: () => Promise<unknown>,
  ): Promise<Error & { code?: unknown; cause?: { code?: unknown } }> {
    try {
      await fn();
    } catch (err) {
      return err as Error & { code?: unknown; cause?: { code?: unknown } };
    }
    throw new Error("例外にならなかった");
  }

  it("名前の無い Error: 見つからない id・形の崩れた id・別テナントの id は、どれも素の Error（cause を持たない）", async () => {
    const { db } = await getTestClient();
    const store = new postgres.PostgresMemoryStore(db);
    const ctx: Ctx = { tenantId: `readme-error-faces-${Date.now()}` };
    const memory = await store.createMemory(ctx, buildNewMemoryFixture({}));
    const cases = [
      () => store.updateStatus(ctx, "00000000-0000-0000-0000-000000000000" as never, "archived"),
      () => store.updateStatus(ctx, "not-a-uuid" as never, "archived"),
      () => store.updateStatus({ tenantId: `${ctx.tenantId}-other` }, memory.id, "archived"),
    ];
    for (const fn of cases) {
      const err = await rejection(fn);
      expect(err.constructor).toBe(Error);
      expect(err.name).toBe("Error");
      expect(err.cause).toBeUndefined();
      // 文面は約束しない（README）ので、ここでは見ない。
    }
  });

  it('DB が拒んだ例外: name は "Error"、SQLSTATE は err.cause.code に在り、err.code には無い', async () => {
    const { db } = await getTestClient();
    const store = new postgres.PostgresMemoryStore(db);
    const ctx: Ctx = { tenantId: `readme-db-faces-${Date.now()}` };
    const base = buildNewMemoryFixture({});
    const cases: [string, () => Promise<unknown>][] = [
      ["23514", () => store.createMemory(ctx, { ...base, status: "bogus" as never })],
      ["23514", () => store.createMemory(ctx, { ...base, strength: 99 })],
      ["2201W", () => store.listActiveClaimPredicates!(ctx, { subjectId: null, limit: -1 })],
      ["22P02", () => store.listActiveClaimPredicates!(ctx, { subjectId: null, limit: 1.5 })],
      ["22007", () => store.createMemory(ctx, { ...base, occurredAt: new Date("x") })],
    ];
    for (const [sqlstate, fn] of cases) {
      const err = await rejection(fn);
      expect(err.name, sqlstate).toBe("Error");
      expect(err.cause?.code, sqlstate).toBe(sqlstate);
      expect(err.code, sqlstate).toBeUndefined();
    }
  });
});

describe("README「ほかに export しているもの」の表", () => {
  it("表に挙げた名前は、どれも入口（src/index.ts）から export されている", () => {
    const section = readmeSection("ほかに export しているもの");
    const table = section
      .split("\n")
      .filter((l) => l.startsWith("| ") && !l.startsWith("| 用途") && !l.startsWith("|---"));
    // 名前ではない語: `sha256Hex`（`contentHash` の実装）の `contentHash` は Memory の欄の名前。
    const NOT_EXPORT_NAMES = new Set(["contentHash"]);
    const names = new Set<string>();
    for (const row of table) {
      const cell = row.split("|")[2] ?? "";
      for (const m of cell.matchAll(/`([A-Za-z_*][A-Za-z0-9_*]*)`/g)) {
        if (!NOT_EXPORT_NAMES.has(m[1]!)) names.add(m[1]!);
      }
    }
    expect(names.size, "表から名前を拾えている").toBeGreaterThan(40);

    const entry = path.join(PACKAGE_ROOT, "src", "index.ts");
    const program = ts.createProgram([entry], {
      module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
      target: ts.ScriptTarget.ES2022,
      noEmit: true,
    });
    const checker = program.getTypeChecker();
    const moduleSymbol = checker.getSymbolAtLocation(program.getSourceFile(entry)!)!;
    const exported = checker.getExportsOfModule(moduleSymbol).map((s) => s.getName());

    const missing = [...names].filter((name) => {
      if (!name.includes("*")) return !exported.includes(name);
      const re = new RegExp(`^${name.replace(/\*/g, "\\w+")}$`);
      return !exported.some((e) => re.test(e));
    });
    expect(missing).toEqual([]);
  });
});
