import { Pool } from "pg";
import { afterAll, describe, expect, it } from "vitest";
import type { Ctx } from "@mnemora/core";
import { createPostgresClient, type PostgresClient } from "../client.js";
import { runMigrations } from "../migrate.js";
import { PostgresMemoryStore } from "../memory-store.js";
import { requireDatabaseUrl } from "./test-db.js";
import { dropTempDatabase } from "./temp-database.js";

/**
 * DB の既定の照合順序が `C`（バイト順）でないと、`ORDER BY name ASC` はロケール依存の「自然順」になり、コードポイント順とずれる。
 * 既定が `C` の DB では修正前の実装でも一致してしまい赤が見えないので、ICU ロケールプロバイダ（`LOCALE_PROVIDER icu ICU_LOCALE 'en-US'`）の DB を作って確かめる。
 * ICU はライブラリ内蔵のロケールデータを使うので、OS にロケールを追加インストールしなくてよい。
 * この Postgres ビルドが ICU 非対応で `CREATE DATABASE ... LOCALE_PROVIDER icu` が失敗したときは、理由を出して skip する。
 */
describe("PostgresMemoryStore.listLabels は name のコードポイント順で返す（Issue #881）", () => {
  const ctx: Ctx = { tenantId: "tenant-1" };
  // 期待するコードポイント順は ASCII のコード値そのまま: ' '(32) < 'B'(66) < 'F'(70) < '_'(95) < 'f'(102)。
  const NAMES = [" Foo ", "Foo", "foo", "_a", "B"];
  const CODEPOINT_ORDER = [" Foo ", "B", "Foo", "_a", "foo"];
  const DB_NAME = "mnemora_labels_icu_en_us";

  let admin: Pool | undefined;
  let icuClient: PostgresClient | undefined;

  function adminPool(): Pool {
    admin ??= new Pool({ connectionString: requireDatabaseUrl(), max: 1 });
    return admin;
  }

  function connectionStringFor(database: string): string {
    const url = new URL(requireDatabaseUrl());
    url.pathname = `/${database}`;
    return url.toString();
  }

  afterAll(async () => {
    if (icuClient) {
      await icuClient.pool.end();
    }
    if (admin) {
      await dropTempDatabase(admin, DB_NAME);
      await admin.end();
    }
  });

  function isIcuUnsupportedError(err: unknown): boolean {
    const message = err instanceof Error ? err.message : String(err);
    return /icu/i.test(message);
  }

  async function seedIcuStore(names: readonly string[]): Promise<PostgresMemoryStore> {
    // 前のテストが張ったままの pool があれば、DROP DATABASE の前に閉じる（接続が残っていると drain 待ちでタイムアウトする）。
    if (icuClient) {
      await icuClient.pool.end();
      icuClient = undefined;
    }
    await dropTempDatabase(adminPool(), DB_NAME);
    await adminPool().query(
      `CREATE DATABASE ${DB_NAME} TEMPLATE template0 ENCODING 'UTF8' ` +
        `LOCALE_PROVIDER icu ICU_LOCALE 'en-US'`,
    );
    icuClient = createPostgresClient(connectionStringFor(DB_NAME));
    await runMigrations(icuClient.pool);
    const store = new PostgresMemoryStore(icuClient.db);
    for (const name of names) {
      await store.registerLabel(ctx, name);
    }
    return store;
  }

  /** ICU の一時 DB を作れない環境では、その旨を報告して skip する。呼び出し側の `it` は `undefined` が返ったら即座に return すること。 */
  async function seedIcuStoreOrSkip(
    names: readonly string[],
    t: { skip: (note?: string) => void },
  ): Promise<PostgresMemoryStore | undefined> {
    try {
      return await seedIcuStore(names);
    } catch (err) {
      if (isIcuUnsupportedError(err)) {
        t.skip(
          `この Postgres ビルドは ICU ロケールプロバイダに対応していない: ` +
            `${err instanceof Error ? err.message : String(err)}`,
        );
        return undefined;
      }
      throw err;
    }
  }

  it("🔴 既定 collation が C ではない DB でも、返る順序はコードポイント順である", async (t) => {
    const store = await seedIcuStoreOrSkip(NAMES, t);
    if (!store) return;

    const labels = await store.listLabels(ctx);
    expect(labels.map((l) => l.name)).toEqual(CODEPOINT_ORDER);
  });

  it("既定 collation が C ではない DB でも、サロゲートペア（U+10000 以上）を含む名前はコードポイント順で返る", async (t) => {
    // `COLLATE "C"` は UTF-8 のバイト列を比較しており、UTF-8 のバイト順はコードポイント順と単調に対応するので、Postgres 側は修正前から緑のはずである。
    // 実際に緑であることを確かめる。"！"（U+FF01）と "😀"（U+1F600）。コードポイント順では "！" < "😀"。
    const store = await seedIcuStoreOrSkip(["😀", "！"], t);
    if (!store) return;

    const labels = await store.listLabels(ctx);
    expect(labels.map((l) => l.name)).toEqual(["！", "😀"]);
  });
});
