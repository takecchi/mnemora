// クローン miku の委譲先が書いた回帰テスト。オーナーではない。
//
// Issue #881 / クローン miku の判断（2026-09-26、
// `docs/decisions/0318-taxonomy-labels.md` 追記）: `MemoryStore.listLabels?` の
// 「`name` 昇順」を**コードポイント順**（Postgres の `COLLATE "C"` と同じ、バイト順）
// と決めた。
//
// `InMemoryMemoryStore.listLabels` は `results.sort((a, b) => a.name.localeCompare(b.name))`
// ——Node の既定ロケールでの自然順——を使っており、大文字小文字・前後の空白が混在する
// 名前ではコードポイント順とずれる。#881 本文の実測（Node v22 既定ロケール、
// `LANG=C.UTF-8`）: `' Foo '`, `'Foo'`, `'foo'` の3件は `localeCompare` で
// `' Foo ', 'foo', 'Foo'` になる——コードポイント順（`' Foo ', 'Foo', 'foo'`）とは
// `Foo`/`foo` の順が逆。

import { describe, expect, it } from "vitest";
import type { Ctx } from "@mnemora/core";
import { buildNewMemoryFixture } from "../test-data.js";
import { InMemoryMemoryStore } from "../__fixtures__/in-memory-memory-store.js";

describe("InMemoryMemoryStore.listLabels は name のコードポイント順で返す（Issue #881）", () => {
  it("🔴 大文字小文字・空白・記号が混在する名前でも、コードポイント順で返る", async () => {
    const store = new InMemoryMemoryStore();
    const ctx: Ctx = { tenantId: "tenant-1" };

    // 大文字小文字・前後の空白・記号が混在する名前。期待するコードポイント順は
    // ASCII のコード値そのまま: ' '(32) < 'B'(66) < 'F'(70) < '_'(95) < 'f'(102)。
    await store.createMemory(
      ctx,
      buildNewMemoryFixture({
        tenantId: "tenant-1",
        tags: [" Foo ", "Foo", "foo", "_a", "B"],
      }),
    );

    const labels = await store.listLabels(ctx);
    expect(labels.map((l) => l.name)).toEqual([" Foo ", "B", "Foo", "_a", "foo"]);
  });

  it("🔴 サロゲートペア（U+10000 以上）を含む名前でも、コードポイント順で返る", async () => {
    // クローン miku の判断（2026-09-26、追記2）: 契約に「コードポイント順」と書いた
    // 以上、BMP 外の文字（サロゲートペア）でもそれを満たす。
    //
    // "！"（U+FF01、BMP 内、コード単位1つ）と "😀"（U+1F600、BMP 外、サロゲートペア
    // "😀"）の2件。コードポイント値は "！"=0xFF01=65281 < "😀"=0x1F600=128512
    // なので、コードポイント順では "！" が先。
    //
    // ところが JS の `<`（UTF-16 コード単位の比較）で見ると、"😀" の先頭コード単位
    // （上位サロゲート 0xD83D=55357）は "！" の唯一のコード単位（0xFF01=65281）より
    // 小さいため、単純な `<` 比較では "😀" が先に来てしまう——コードポイント順とは逆。
    const store = new InMemoryMemoryStore();
    const ctx: Ctx = { tenantId: "tenant-1" };

    await store.createMemory(
      ctx,
      buildNewMemoryFixture({
        tenantId: "tenant-1",
        tags: ["😀", "！"],
      }),
    );

    const labels = await store.listLabels(ctx);
    expect(labels.map((l) => l.name)).toEqual(["！", "😀"]);
  });
});
