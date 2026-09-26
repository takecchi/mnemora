import { Pool } from "pg";
import { afterAll, describe, expect, it } from "vitest";
import type { Ctx } from "@mnemora/core";
import { createPostgresClient, type PostgresClient } from "../client.js";
import { runMigrations } from "../migrate.js";
import { PostgresMemoryStore } from "../memory-store.js";
import { requireDatabaseUrl } from "./test-db.js";
import { dropTempDatabase } from "./temp-database.js";

/**
 * クローン miku の委譲先が書いた回帰テスト。オーナーではない。
 *
 * Issue #881 / クローン miku の判断（2026-09-26、
 * `docs/decisions/0318-taxonomy-labels.md` 追記）: `MemoryStore.listLabels?` の
 * 「`name` 昇順」を**コードポイント順**（`COLLATE "C"` と同じ、バイト順）と決めた。
 *
 * `PostgresMemoryStore.listLabels` の実装は `ORDER BY name ASC` に DB の**既定の
 * 照合順序（collation）**が使われる。既定が `C`（バイト順）でない DB では、これは
 * ロケール依存の「自然順」になり、コードポイント順とずれる——#881 本文が実測した
 * `en_US.utf8` の `foo, ' Foo ', Foo` がその例である。
 *
 * ## この歯がロケールを作る方法（実測に基づく注記）
 *
 * このホストには OS ロケール `en_US.utf8` が入っていない
 * （`locale -a` で確認済み。在るのは `C`/`C.utf8`/`POSIX` のみ）ため、`initdb` や
 * `CREATE DATABASE ... LC_COLLATE 'en_US.utf8'`（libc プロバイダ）でその挙動を
 * 再現できない。**代わりに ICU ロケールプロバイダ（`LOCALE_PROVIDER icu ICU_LOCALE
 * 'en-US'`）を使う**——ICU はライブラリ内蔵のロケールデータを使うため、OS への
 * ロケール追加インストールが要らない。
 *
 * 【実測】このホストで `psql` から直接測った ` Foo `/`Foo`/`foo` の3値の順序:
 * - このホストの `initdb --locale=C` クラスタの既定 DB（`COLLATE` 指定なし）:
 *   `' Foo ', 'Foo', 'foo'`（＝コードポイント順。修正前の実装でもこの DB だけでは
 *   一致してしまうため、赤が見えない）
 * - ICU `en-US`（`COLLATE` 指定なし）: `' Foo ', 'foo', 'Foo'`（`Foo`/`foo` の順が
 *   コードポイント順と逆——#881 本文の `en_US.utf8` と同じ向きの逆転）
 * - ICU `en-US` に `COLLATE "C"` を明示: `' Foo ', 'Foo', 'foo'`（＝コードポイント順に
 *   戻る）
 *
 * ⚠ **CI の `postgres` ジョブ（`pgvector/pgvector:pg17`）が ICU 対応でビルドされて
 * いるかは確認していない。** `pgvector/pgvector` の Dockerfile は `postgres:17-bookworm`
 * を素の base image として使っており、apt.postgresql.org（PGDG）の公式パッケージは
 * 一般に ICU 付きでビルドされていると見ているが、**その版の postgres バイナリを直接
 * 確認したわけではない。** ICU 非対応の場合に CI を無用に赤くしないよう、
 * `CREATE DATABASE ... LOCALE_PROVIDER icu` が ICU 関連のエラーで失敗したときは
 * skip する（陽性対照は取れていない——ICU 非対応のビルドを手元に用意できていないため、
 * この skip 経路自体は実行されたことがない）。
 */
describe("PostgresMemoryStore.listLabels は name のコードポイント順で返す（Issue #881）", () => {
  const ctx: Ctx = { tenantId: "tenant-1" };
  // 大文字小文字・前後の空白・記号が混在する名前。期待するコードポイント順は
  // ASCII のコード値そのまま: ' '(32) < 'B'(66) < 'F'(70) < '_'(95) < 'f'(102)。
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

  async function seedIcuStore(): Promise<PostgresMemoryStore> {
    await dropTempDatabase(adminPool(), DB_NAME);
    await adminPool().query(
      `CREATE DATABASE ${DB_NAME} TEMPLATE template0 ENCODING 'UTF8' ` +
        `LOCALE_PROVIDER icu ICU_LOCALE 'en-US'`,
    );
    icuClient = createPostgresClient(connectionStringFor(DB_NAME));
    await runMigrations(icuClient.pool);
    const store = new PostgresMemoryStore(icuClient.db);
    for (const name of NAMES) {
      await store.registerLabel(ctx, name);
    }
    return store;
  }

  it("🔴 既定 collation が C ではない DB でも、返る順序はコードポイント順である", async (t) => {
    let store: PostgresMemoryStore;
    try {
      store = await seedIcuStore();
    } catch (err) {
      if (isIcuUnsupportedError(err)) {
        t.skip(
          `この Postgres ビルドは ICU ロケールプロバイダに対応していない: ` +
            `${err instanceof Error ? err.message : String(err)}`,
        );
        return;
      }
      throw err;
    }

    const labels = await store.listLabels(ctx);
    expect(labels.map((l) => l.name)).toEqual(CODEPOINT_ORDER);
  });
});
