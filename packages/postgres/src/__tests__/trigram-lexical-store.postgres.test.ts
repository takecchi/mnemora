import type { Ctx } from "@mnemora/core";
import { sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { buildNewMemoryFixture } from "@mnemora/testkit";
import { PostgresMemoryStore } from "../memory-store.js";
import { PostgresLexicalStore } from "../lexical-store.js";
import {
  DEFAULT_TRIGRAM_WORD_SIMILARITY_THRESHOLD,
  PostgresTrigramLexicalStore,
  TRIGRAM_LEXICAL_STORE_UNAVAILABLE_ERROR_PREFIX,
  probeTrigramLexicalSupport,
} from "../trigram-lexical-store.js";
import { closeTestClient, getTestClient, resetTestDatabase } from "./test-db.js";

/**
 * `PostgresTrigramLexicalStore`（Issue #278、ADR 0319）の DB 段の歯。
 *
 * **⚠ この歯は `server_encoding` に依って前提が変わる**
 * （[ADR 0103](../../../docs/decisions/0103-negative-tooth-declares-its-precondition.md)の
 * 規律——否定を主張する歯は、その否定が依存している前提を自分で測って名乗る）。
 * `.github/workflows/ci.yml` の `postgres` ジョブは `UTF8` / `SQL_ASCII`(+`--locale=C`) の
 * 2脚を matrix で走らせる。このファイルは**どちらの脚で走っているかを実行時に測り**、
 * 測った結果に応じて別の主張を検査する——「スキップ」ではなく、**どちらの脚でも必ず
 * 意味のある assertion を通す**（`lexical-store-identifier.test.ts` が
 * `nonAsciiIsIndexed` の分岐で採っているのと同じ形）。
 *
 * 【実測、この PR の作業者が手元で確認】(`initdb --locale=C.UTF-8 --encoding=UTF8` /
 * `initdb --locale=C --encoding=SQL_ASCII`、PostgreSQL 17):
 *
 * | server_encoding | `probeTrigramLexicalSupport` |
 * |---|---|
 * | UTF8 | `{ ok: true }`（`CREATE EXTENSION pg_trgm` が通り、自己一致検査も1になる） |
 * | SQL_ASCII（`--locale=C`） | `{ ok: false, reason: "server_encoding_not_utf8" }` |
 *
 * **⚠ 追加で手元だけ確認したこと（このファイルの歯には含めていない）**: 同一クラスタ内に
 * `ENCODING=UTF8 LOCALE=C` の DB を別途作ると、`server_encoding` は `UTF8` を通過するが
 * 自己一致検査が 0 になり `locale_no_japanese_trigrams` で弾かれる
 * （[ADR 0084](../../../docs/decisions/0084-lexical-recall-channel.md) §3.2 の「`C`
 * ロケールで黙って0件になる」の再現）。CI の2脚には無い regime のため、この
 * postgres.test.ts には歯を足していない——ADR 0319「測定」節に手順を書いてある。
 */

const TENANT = "trigram-lexical-tenant";

describe("PostgresTrigramLexicalStore — opt-in pg_trgm 語彙照合(Issue #278, ADR 0319)", () => {
  beforeEach(async () => {
    await resetTestDatabase();
  });

  afterAll(async () => {
    await closeTestClient();
  });

  it("実測: この実行環境の server_encoding と pg_trgm の使用可否を宣言する（ADR 0103）", async () => {
    const { db } = await getTestClient();
    const encodingRow = (await db.execute(sql`SHOW server_encoding`)).rows[0] as {
      server_encoding: string;
    };
    const probe = await probeTrigramLexicalSupport(db);
    console.log(
      `【実測】server_encoding=${encodingRow.server_encoding} / probeTrigramLexicalSupport=${JSON.stringify(probe)}`,
    );

    // ⚠ この歯は「UTF8 と SQL_ASCII のどちらか」しか知らない。第三の regime が来たら
    // ここで気づけるように、既知の2値のどちらかであることをまず確認する。
    expect(["UTF8", "SQL_ASCII"]).toContain(encodingRow.server_encoding);

    if (encodingRow.server_encoding === "UTF8") {
      expect(probe.ok).toBe(true);
    } else {
      expect(probe.ok).toBe(false);
      if (!probe.ok) {
        expect(probe.reason).toBe("server_encoding_not_utf8");
      }
    }
  });

  it("UTF8 leg: 歯6（lexical-store-reporter-questions.test.ts）が『引けない』と宣言している同じ問いが、opt-in では引ける / SQL_ASCII+C leg: create が投げ、静かな0件を作らない", async () => {
    const { db } = await getTestClient();
    const memoryStore = new PostgresMemoryStore(db);
    const ctx: Ctx = { tenantId: TENANT };
    const probe = await probeTrigramLexicalSupport(db);

    if (probe.ok) {
      const trigramStore = await PostgresTrigramLexicalStore.create(db);

      const target = await memoryStore.createMemory(
        ctx,
        buildNewMemoryFixture({
          tenantId: TENANT,
          contentHash: "hash-tanaka",
          content: "田中さんが来週から新しいプロジェクトに参加します",
        }),
      );
      // 同じ文型・別の人名。誤爆しないことの対照。
      const distractorName = await memoryStore.createMemory(
        ctx,
        buildNewMemoryFixture({
          tenantId: TENANT,
          contentHash: "hash-suzuki",
          content: "鈴木さんが来週から新しいプロジェクトに参加します",
        }),
      );
      // 田中さんを含まない、一般的な日本語の雑音（「について」等の機能語だけを共有する）。
      const noiseGeneric = await memoryStore.createMemory(
        ctx,
        buildNewMemoryFixture({
          tenantId: TENANT,
          contentHash: "hash-noise-generic",
          content: "先月のミーティングについて詳しく説明しました",
        }),
      );

      // これは lexical-store-reporter-questions.test.ts の歯6が
      // `expect(hits).toEqual([])` を主張しているのと**同じクエリ**である。
      // その歯（PostgresLexicalStore 経由）は変えていない——ここで検査しているのは
      // opt-in の PostgresTrigramLexicalStore 経由の別の adapter である。
      const hits = await trigramStore.search(ctx, "田中さんについて何か言ってましたか", {
        limit: 10,
        filter: { tenantId: TENANT },
      });
      const ids = hits.map((h) => h.memoryId);

      expect(ids).toContain(target.id);
      expect(ids).not.toContain(distractorName.id);
      expect(ids).not.toContain(noiseGeneric.id);

      const targetHit = hits.find((h) => h.memoryId === target.id);
      expect(targetHit).toBeDefined();
      expect(targetHit!.coverage).toBeGreaterThan(0);
      expect(targetHit!.coverage).toBeLessThanOrEqual(1);
    } else {
      await expect(PostgresTrigramLexicalStore.create(db)).rejects.toThrow(
        TRIGRAM_LEXICAL_STORE_UNAVAILABLE_ERROR_PREFIX,
      );
      expect(probe.reason).toBe("server_encoding_not_utf8");
    }
  });

  it("UTF8 leg: ASCII 部分の意味論は既存経路（PostgresLexicalStore）と一致する（⛔ 既定を変えない確認） / SQL_ASCII+C leg: 同じ probe 結果を再確認する", async () => {
    const { db } = await getTestClient();
    const memoryStore = new PostgresMemoryStore(db);
    const ctx: Ctx = { tenantId: TENANT };
    const probe = await probeTrigramLexicalSupport(db);

    if (probe.ok) {
      const baseStore = new PostgresLexicalStore(db);
      const trigramStore = await PostgresTrigramLexicalStore.create(db);

      const target = await memoryStore.createMemory(
        ctx,
        buildNewMemoryFixture({
          tenantId: TENANT,
          contentHash: "hash-ascii-target",
          content: "先週のミーティングでPROJ-1234の予算超過が話題になりました",
        }),
      );
      await memoryStore.createMemory(
        ctx,
        buildNewMemoryFixture({
          tenantId: TENANT,
          contentHash: "hash-ascii-distractor",
          content: "サブシステムの担当はPROJ-5678の方です",
        }),
      );

      // Issue #106 の報告者が書いた形そのもの（ADR 0092 の OR + 被覆率の主対象）。
      const query = "PROJ-1234について前に何か言ってたはず";
      const baseHits = await baseStore.search(ctx, query, {
        limit: 10,
        filter: { tenantId: TENANT },
      });
      const trigramHits = await trigramStore.search(ctx, query, {
        limit: 10,
        filter: { tenantId: TENANT },
      });

      // 集合として同じ（誰が一致したか）。
      expect(new Set(trigramHits.map((h) => h.memoryId))).toEqual(
        new Set(baseHits.map((h) => h.memoryId)),
      );
      expect(baseHits.map((h) => h.memoryId)).toContain(target.id);

      // coverage は ASCII 側の意味論を書き換えていないので同じ値になるはず
      // （このクエリは非 ASCII の項が無いため、trigram 側の分母への寄与が0で、
      // ADR 0092 の式とバイトレベルで同じ計算になる）。
      const baseTarget = baseHits.find((h) => h.memoryId === target.id);
      const trigramTarget = trigramHits.find((h) => h.memoryId === target.id);
      expect(baseTarget).toBeDefined();
      expect(trigramTarget).toBeDefined();
      expect(trigramTarget!.coverage).toBeCloseTo(baseTarget!.coverage, 10);
    } else {
      // UTF8 以外では PostgresTrigramLexicalStore.create 自体が使えないため
      // （このファイル冒頭の doc「なぜ全体を弾くか」）、ASCII 部分の比較はそもそも
      // 成立しない。ここでは probe が安定して同じ理由を返すことだけを再確認する。
      expect(probe.reason).toBe("server_encoding_not_utf8");
    }
  });

  it("UTF8 leg: 閾値を上げると機能語ノイズ由来の雑音候補が減る（opts.threshold が実際に効くことの確認） / SQL_ASCII+C leg: 同じ probe 結果を再確認する", async () => {
    const { db } = await getTestClient();
    const memoryStore = new PostgresMemoryStore(db);
    const ctx: Ctx = { tenantId: TENANT };
    const probe = await probeTrigramLexicalSupport(db);

    if (probe.ok) {
      // 閾値0（何でも通す）と、既定値（0.3）を比較する。
      const permissive = await PostgresTrigramLexicalStore.create(db, { threshold: 0 });
      const defaultStore = await PostgresTrigramLexicalStore.create(db, {
        threshold: DEFAULT_TRIGRAM_WORD_SIMILARITY_THRESHOLD,
      });

      await memoryStore.createMemory(
        ctx,
        buildNewMemoryFixture({
          tenantId: TENANT,
          contentHash: "hash-threshold-noise",
          content: "来週の予定について何も聞いていません",
        }),
      );

      const query = "田中さんについて何か言ってましたか";
      const permissiveHits = await permissive.search(ctx, query, {
        limit: 10,
        filter: { tenantId: TENANT },
      });
      const defaultHits = await defaultStore.search(ctx, query, {
        limit: 10,
        filter: { tenantId: TENANT },
      });

      // 閾値0なら「田中さん」を含まない一般的な日本語文もノイズとして拾ってしまう
      // （このファイル冒頭で参照している ADR 0319 の実測どおり）。既定の閾値では拾わない。
      expect(permissiveHits.length).toBeGreaterThan(defaultHits.length);
    } else {
      expect(probe.reason).toBe("server_encoding_not_utf8");
    }
  });
});
