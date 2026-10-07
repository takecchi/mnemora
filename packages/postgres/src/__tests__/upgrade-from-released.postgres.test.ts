import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createRuntime, type Ctx, type EmbeddingSpaceId, type Runtime } from "@mnemora/core";
import { DeterministicEmbeddingProvider, DeterministicLLMProvider } from "@mnemora/testkit";
import { closePostgresClient, createPostgresClient, type PostgresClient } from "../client.js";
import { sha256Hex } from "../content-hash.js";
import { embeddingSpaceTableName } from "../embedding-space-table.js";
import { PostgresEventStore } from "../event-store.js";
import { PostgresLexicalStore } from "../lexical-store.js";
import { PostgresMemoryStore } from "../memory-store.js";
import { DEFAULT_MIGRATIONS_DIR, listMigrationFiles, runMigrations } from "../migrate.js";
import { PostgresOutboxStore } from "../outbox-store.js";
import { PostgresTenantSettingsStore } from "../tenant-settings-store.js";
import { registerEmbeddingSpace } from "../vector-space.js";
import { PostgresVectorStore } from "../vector-store.js";
import { requireDatabaseUrl } from "./test-db.js";

/**
 * 公開済みの版で作った DB を、今の main の migration で上げる経路の歯。
 *
 * `__fixtures__/upgrade-from-<tag>.sql` は、その版のコードで（Postgres adapter と runtime を
 * 通して）データを入れた DB のプレーンテキストの `pg_dump` である。作り方と中身は
 * `scripts/generate-upgrade-fixture.mjs` の冒頭。**fixture ごとに**、別の DB へ復元し、
 * `runMigrations` を2回当て、今のコードで代表的な読み書きを回す。
 *
 * 新しい DB で緑でも、公開済みの版のデータが入った DB で migration が失敗しない・既存の行の
 * 意味が変わらない、とは言えない。
 *
 * ⚠ 期待値（どの migration が未適用か・行の中身）は fixture 自身から引く。ここに migration の
 * ファイル名や件数を焼かない（AGENTS.md「数を、道具と生成物に焼き込まない」）。
 */

const FIXTURES_DIR = fileURLToPath(new URL("./__fixtures__/", import.meta.url));
const FIXTURES = readdirSync(FIXTURES_DIR)
  .filter((f) => /^upgrade-from-.+\.sql$/.test(f))
  .sort();

// ⚠ `scripts/generate-upgrade-fixture.mjs` の `SPACES` / `TENANTS` と一致していること。
const SPACES: Record<string, EmbeddingSpaceId> = {
  small: { provider: "test", model: "fixture-model", dimensions: 3 },
  wide: { provider: "testkit", model: "deterministic", dimensions: 8 },
  long: {
    provider: "some-very-long-provider-name",
    model: "an-extremely-long-embedding-model-name-v2-large",
    dimensions: 4,
  },
};
const TENANT_SPACE: Record<string, string> = {
  "tenant-a": "small",
  "tenant-b": "wide",
  "tenant-c": "long",
  "tenant-a2": "wide",
};

class ZeroAwareEmbedding extends DeterministicEmbeddingProvider {
  override async embed(ctx: Ctx, texts: string[]): Promise<number[][]> {
    const vectors = await super.embed(ctx, texts);
    return vectors.map((v, i) => (texts[i]!.includes("ZERO") ? v.map(() => 0) : v));
  }
}

function databaseUrlFor(name: string): string {
  const url = new URL(requireDatabaseUrl());
  url.pathname = `/${name}`;
  return url.toString();
}

async function withAdmin<T>(fn: (c: Client) => Promise<T>): Promise<T> {
  const admin = new Client({ connectionString: requireDatabaseUrl() });
  await admin.connect();
  try {
    return await fn(admin);
  } finally {
    await admin.end();
  }
}

for (const fixture of FIXTURES) {
  const tag = fixture.replace(/^upgrade-from-/, "").replace(/\.sql$/, "");
  const dbName = `mnemora_upgrade_from_${tag.replace(/[^a-z0-9]/gi, "_").toLowerCase()}`;

  describe(`公開済みの ${tag} で作った DB を今の migration で上げる（${fixture}）`, () => {
    let client: PostgresClient;
    let rowsBefore: unknown[];
    let rowsAfter: unknown[];
    // labels の backfill（migration `labels`/`memory_labels` を足す版）の直後の凍結値。
    let hadLabelsTableBefore: boolean;
    let backfillAfter:
      | {
          tags: { id: string; tenant_id: string; tags: string[] }[];
          labels: { tenant_id: string; name: string; status: string; proposed_count: number }[];
          links: { memory_id: string; tenant_id: string; name: string }[];
        }
      | undefined;
    let pendingBefore: string[];
    const applied: string[][] = [];

    const q = async <T>(text: string, params?: unknown[]): Promise<T[]> =>
      (await client.pool.query(text, params)).rows as T[];
    const runtimeFor = (tenantId: string): Runtime =>
      createRuntime({
        memoryStore: new PostgresMemoryStore(client.db),
        outboxStore: new PostgresOutboxStore(client.db),
        vectorStore: new PostgresVectorStore(client.db),
        lexicalStore: new PostgresLexicalStore(client.db),
        eventStore: new PostgresEventStore(client.db),
        tenantSettingsStore: new PostgresTenantSettingsStore(client.db),
        llmProvider: new DeterministicLLMProvider(),
        embeddingProvider: new ZeroAwareEmbedding(SPACES[TENANT_SPACE[tenantId]!]!),
        hashContent: sha256Hex,
      });
    const snapshotRows = () =>
      q(
        `SELECT id, tenant_id, status, embedding_status, superseded_by_id, contested_with_id,
                purged_at, content, tags FROM memories ORDER BY id`,
      );

    beforeAll(async () => {
      await withAdmin(async (admin) => {
        await admin.query(`DROP DATABASE IF EXISTS ${dbName}`);
        await admin.query(`CREATE DATABASE ${dbName}`);
      });
      // 復元は専用の接続で流す（ダンプは search_path を空にするため、プールに混ぜない）。
      const restore = new Client({ connectionString: databaseUrlFor(dbName) });
      await restore.connect();
      try {
        await restore.query(readFileSync(`${FIXTURES_DIR}${fixture}`, "utf8"));
      } finally {
        await restore.end();
      }
      client = createPostgresClient(databaseUrlFor(dbName));

      const ledger = await q<{ name: string }>("SELECT name FROM _mnemora_migrations");
      const done = new Set(ledger.map((r) => r.name));
      pendingBefore = listMigrationFiles(DEFAULT_MIGRATIONS_DIR).filter((f) => !done.has(f));
      // fixture 自身が、`SPACES` の全空間のデータを持つこと（migration の前に確かめる）。空の空間があると、
      // 下の it() のうちその空間の行を読むもの（zero-norm 索引・ゼロベクトル・purge など）が、
      // 行の無い表に対して黙って空振りしうる。
      for (const [name, space] of Object.entries(SPACES)) {
        const rows = await q<{ n: number }>(
          `SELECT count(*)::int AS n FROM "${embeddingSpaceTableName(space)}"`,
        );
        expect(rows[0]!.n, `fixture の埋め込み空間 ${name} に行が無い`).toBeGreaterThan(0);
      }
      // v1.0.0〜v1.0.2 の purge は `tags` を消さなかった。
      // fixture の purge 済みの行に、その残り方（purged_at があり、tags が残る）を再現する。
      // `attributes`・claim key の列は v1.0.x の DB には無い（migration 0019・0021 が足す）ので、
      // migration の前には書けない。
      await q("UPDATE memories SET tags = ARRAY['legacy-residue'] WHERE purged_at IS NOT NULL");
      rowsBefore = await snapshotRows();
      hadLabelsTableBefore =
        (await q<{ t: string | null }>("SELECT to_regclass('labels')::text AS t"))[0]!.t !== null;

      applied.push((await runMigrations(client.pool)).applied);
      applied.push((await runMigrations(client.pool)).applied);
      // アプリの起動時と同じく、空間を登録し直す（既存の空間に対しては何も作らないはず）。
      for (const space of Object.values(SPACES)) {
        await registerEmbeddingSpace(client.pool, space);
      }
      // 「migration の前後で行が変わらない」の"後"の値も、ここ（beforeAll。
      // 他の it() がまだ1本も割り込めない場所）で一緒に凍結する。下の it() の中で
      // snapshotRows() を読み直すと、tick/observe・forget→purge・resolveOrphanedContested
      // の it()（同じ describe で同じ DB を書き換える）がそれより先に走ったかどうかに
      // 結果が左右される——vitest の実行順は既定では宣言順だが、`--sequence.shuffle` では
      // 変わる。
      rowsAfter = await snapshotRows();
      backfillAfter = {
        tags: await q("SELECT id, tenant_id, tags FROM memories ORDER BY id"),
        labels: await q(
          "SELECT tenant_id, name, status, proposed_count::int AS proposed_count FROM labels ORDER BY tenant_id, name",
        ),
        links: await q(
          `SELECT ml.memory_id, ml.tenant_id, l.name FROM memory_labels ml JOIN labels l ON l.id = ml.label_id
           ORDER BY ml.memory_id, l.name`,
        ),
      };
    });

    afterAll(async () => {
      if (client) await closePostgresClient(client);
      await withAdmin((admin) => admin.query(`DROP DATABASE IF EXISTS ${dbName}`));
    });

    it("1回目は台帳に無い migration だけを当て、2回目は何も当てない", () => {
      expect(applied[0]).toEqual(pendingBefore);
      expect(applied[1]).toEqual([]);
    });

    // `labels`・`memory_labels` を足す migration より前の版の DB では、`memories.tags` から、
    // (tenant, tag) ごとの `proposed_count`（その tag を持つ行数）と、記憶と tag の紐付けが作られる。
    // 期待値は fixture 自身の `tags` から引く（fixture は読むだけで書き換えない）。
    it("labels の backfill: memories.tags から (tenant, tag) ごとの proposed_count と memory_labels の紐付けが作られる", () => {
      if (hadLabelsTableBefore) return; // この版は labels の migration を適用済み（backfill は走らない）。
      const { tags, labels, links } = backfillAfter!;
      const expectedCounts = new Map<string, number>();
      const expectedLinks = new Set<string>();
      for (const row of tags) {
        for (const tag of row.tags) {
          const key = JSON.stringify([row.tenant_id, tag]);
          expectedCounts.set(key, (expectedCounts.get(key) ?? 0) + 1);
          expectedLinks.add(JSON.stringify([row.id, row.tenant_id, tag]));
        }
      }
      // 陽性対照: fixture に tags を持つ行が在る（無ければこの歯は空振りする）。
      expect(expectedCounts.size).toBeGreaterThan(0);
      expect(
        new Map(labels.map((l) => [JSON.stringify([l.tenant_id, l.name]), l.proposed_count])),
      ).toEqual(expectedCounts);
      expect(labels.every((l) => l.status === "proposed")).toBe(true);
      expect(new Set(links.map((l) => JSON.stringify([l.memory_id, l.tenant_id, l.name])))).toEqual(
        expectedLinks,
      );
    });

    it("idx_memories_lexical は 0025（Issue #1222・ADR 0364）の式に作り直されている", async () => {
      const rows = await q<{ indexdef: string }>(
        "SELECT indexdef FROM pg_indexes WHERE indexname = 'idx_memories_lexical'",
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]!.indexdef).toContain("mnemora_lexical_tsvector(content)");
      expect(rows[0]!.indexdef).not.toContain("mnemora_lexical_normalize(content)");
    });

    // ここで DB を読み直さない。rowsBefore と rowsAfter はどちらも beforeAll の
    // 中で凍結済み——この it() 自身がいつ実行されるか（他の it() がどれだけ DB を
    // 書き換えた後か）に結果が依存しないようにするため。
    it("migration の前後で既存の記憶の行（状態・埋め込みの状態・関係・本文）が変わらない", () => {
      expect(rowsAfter).toEqual(rowsBefore);
    });

    // migration は遡って消さない（tags は migration の前後で変わらない、上の it）。
    // 消えるのは、今のコードで purge をかけ直したとき。
    it("v1.0.x が残した purge 済みの行の tags・memory_labels は、purge をかけ直すと消える（labels の件数は実数に揃う）", async () => {
      const purged = await q<{ id: string; tenant_id: string }>(
        "SELECT id, tenant_id FROM memories WHERE purged_at IS NOT NULL ORDER BY id",
      );
      expect(purged.length).toBeGreaterThan(0);
      for (const row of purged) {
        const before = await q<{ tags: string[] }>("SELECT tags FROM memories WHERE id = $1", [
          row.id,
        ]);
        expect(before[0]!.tags).toEqual(["legacy-residue"]);
      }
      for (const row of purged) {
        const ctx: Ctx = { tenantId: row.tenant_id };
        const result = await runtimeFor(row.tenant_id).purge(ctx, { memoryId: row.id });
        expect(result.outcomes[0]!.kind).toBe("already_purged");
      }
      for (const row of purged) {
        const after = await q<{ tags: string[]; links: number }>(
          `SELECT tags, (SELECT count(*)::int FROM memory_labels WHERE memory_id = memories.id) AS links
           FROM memories WHERE id = $1`,
          [row.id],
        );
        expect(after[0]).toEqual({ tags: [], links: 0 });
      }
      // proposed_count は、残っている紐付けの本数と一致する（負にならない）。
      const labels = await q<{ name: string; proposed_count: number; links: number }>(
        `SELECT l.name, l.proposed_count::int AS proposed_count,
                (SELECT count(*)::int FROM memory_labels ml WHERE ml.label_id = l.id) AS links
         FROM labels l WHERE l.status = 'proposed'`,
      );
      for (const label of labels) {
        expect(label.proposed_count, label.name).toBe(label.links);
      }
    });

    it("zero-norm 部分索引は空間ごとにちょうど1本（migration と registerEmbeddingSpace で重複しない）", async () => {
      for (const space of Object.values(SPACES)) {
        const rows = await q<{ n: number }>(
          `SELECT count(*)::int AS n FROM pg_indexes
           WHERE tablename = $1 AND indexname LIKE 'idx_memory_embeddings_zero_norm_%'`,
          [embeddingSpaceTableName(space)],
        );
        expect(rows[0]!.n).toBe(1);
      }
    });

    it("その版が書いた recall 記録を、今のコードで読める", async () => {
      const recalls = await q<{ id: string; tenant_id: string }>(
        "SELECT id, tenant_id FROM recalls",
      );
      expect(recalls.length).toBeGreaterThan(0);
      for (const r of recalls) {
        const record = await runtimeFor(r.tenant_id).getRecall({ tenantId: r.tenant_id }, r.id);
        expect(record?.returnedMemories.memories.length).toBeGreaterThan(0);
      }
    });

    it("残っていた embed ジョブを tick が消化し、新しい記憶を observe → tick → recall で引ける", async () => {
      const ctx: Ctx = { tenantId: "tenant-a" };
      const rt = runtimeFor(ctx.tenantId);
      const tick1 = await rt.tick(ctx, { kinds: ["embed"], leaseMs: 60_000, limit: 1000 });
      expect(tick1.failed).toBe(0);
      const pending = await q<{ n: number }>(
        `SELECT count(*)::int AS n FROM memories
         WHERE tenant_id = $1 AND status = 'active' AND embedding_status = 'pending'`,
        [ctx.tenantId],
      );
      expect(pending[0]!.n).toBe(0);

      const observed = await rt.observe(ctx, {
        kind: "utterance",
        text: "更新後に入れた記憶 大阪 出張",
        speaker: "user",
      });
      await rt.tick(ctx, { kinds: ["embed"], leaseMs: 60_000, limit: 1000 });
      const result = await rt.recall(ctx, { text: "更新後に入れた記憶 大阪 出張", limit: 50 });
      expect(result.memories.map((m) => m.memoryId)).toEqual(
        expect.arrayContaining(observed.memoryIds),
      );
    });

    it("その版が書いたゼロベクトルの行を VectorStore.search が返す（ADR 0343）", async () => {
      const ctx: Ctx = { tenantId: "tenant-b" };
      const space = SPACES[TENANT_SPACE[ctx.tenantId]!]!;
      const table = embeddingSpaceTableName(space);
      const zeroIds = (
        await q<{ memory_id: string }>(
          `SELECT e.memory_id FROM "${table}" e JOIN memories m ON m.id = e.memory_id
           WHERE e.tenant_id = $1 AND vector_norm(e.embedding) = 0 AND m.status = 'active'`,
          [ctx.tenantId],
        )
      ).map((r) => r.memory_id);
      expect(zeroIds.length).toBeGreaterThan(0);
      const hits = await new PostgresVectorStore(client.db).search(
        ctx,
        space,
        new Array<number>(space.dimensions).fill(1),
        { limit: 1000, filter: { tenantId: ctx.tenantId, status: ["active"] } },
      );
      expect(hits.map((h) => h.memoryId)).toEqual(expect.arrayContaining(zeroIds));
    });

    it("その版が書いた記憶を forget → purge できる", async () => {
      const ctx: Ctx = { tenantId: "tenant-c" };
      const rt = runtimeFor(ctx.tenantId);
      const [victim] = await q<{ id: string }>(
        `SELECT id FROM memories WHERE tenant_id = $1 AND status = 'active'
         AND embedding_status = 'ready' ORDER BY recorded_at, id LIMIT 1`,
        [ctx.tenantId],
      );
      const forgot = await rt.forget(ctx, { memoryId: victim!.id });
      expect(forgot.outcomes[0]!.kind).toBe("forgotten");
      const purged = await rt.purge(ctx, { memoryId: victim!.id });
      expect(purged.outcomes[0]!.kind).toBe("purged");
    });

    it("その版の forget が残した孤児の contested を resolveOrphanedContested で解消できる（Issue #825）", async () => {
      const ctx: Ctx = { tenantId: "tenant-b" };
      const orphans = await q<{ id: string }>(
        `SELECT a.id FROM memories a JOIN memories b ON b.id = a.contested_with_id
         WHERE a.tenant_id = $1 AND a.status = 'contested' AND b.status = 'forgotten'`,
        [ctx.tenantId],
      );
      expect(orphans.length).toBeGreaterThan(0);
      const result = await runtimeFor(ctx.tenantId).resolveOrphanedContested!(ctx, orphans[0]!.id);
      expect(result.outcome.kind).toBe("resolved");
    });
  });
}

describe("upgrade fixture の在り処", () => {
  it("少なくとも1本の fixture が在る（ディレクトリの取り違えで歯が空振りしない）", () => {
    expect(FIXTURES.length).toBeGreaterThan(0);
  });

  // 列挙は `upgrade-from-*.sql` を拾うだけなので、足し忘れた版は黙って空振りする。
  // ⚠ ここに書くのは「直接上げる経路を必ず見る」と決めた版だけ（版を出すたびには足さない）。
  it.each(["v1.0.0"])("%s で作った DB の fixture が在る", (tag) => {
    expect(FIXTURES).toContain(`upgrade-from-${tag}.sql`);
  });
});
