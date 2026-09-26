#!/usr/bin/env node
// 公開済みの版で作った DB の fixture（プレーンテキストの SQL ダンプ）を作り直す道具。
//
// 何を作るか:
//   `--from` に渡した作業木（例: `git worktree add ../mnemora-v1.0.1 v1.0.1` して
//   `pnpm install --frozen-lockfile` と core/testkit/postgres の build を済ませたもの）の
//   **その版のコード**（`@mnemora/postgres` の adapter と `@mnemora/core` の runtime）を通して、
//   空の DB にデータを入れ、`pg_dump` でプレーンテキストの SQL にして `--out` へ書く。
//   できた fixture は `packages/postgres/src/__tests__/upgrade-from-released.postgres.test.ts`
//   が復元し、今の main の migration を当てる（ADR 0344）。
//
// 何を入れるか（すべて合成データ。外部 API は使わない）:
//   - 埋め込みは `@mnemora/testkit` の `DeterministicEmbeddingProvider`（文字コードから作る
//     決定的な擬似ベクトル）。本文に "ZERO" を含む記憶はゼロベクトル、"FAIL" を含む記憶は
//     埋め込みが例外を投げる（tick の失敗経路を通して embedding_status='failed' にする）。
//   - LLM は `DeterministicLLMProvider`。
//   - 3つの埋め込み空間（うち1つは名前が 63 バイトを超え、テーブル名・索引名が切り詰められる）
//     × 4テナント。
//   - 記憶の状態: active / superseded / contested（対）/ archived / forgotten / purged、
//     contested の片側を forget した孤児（Issue #825 の形）、後継が forgotten の superseded。
//   - embedding_status: ready / pending（embed ジョブ未処理）/ failed / skipped。
//   - outbox: 完了・未処理・dead（failed_at）。recalls と recall_usages を1件ずつ。
//   - 利用者が同じスキーマに置いた `memory_embeddings_` で始まるビュー2本（うち1本は
//     `embedding vector` 列を持つ。Issue #1038 で `0022` が止まった形）。
//
// 使い方:
//   node scripts/generate-upgrade-fixture.mjs \
//     --from ../mnemora-v1.0.1 --tag v1.0.1 \
//     --database-url postgresql://user@127.0.0.1:PORT/empty_db \
//     --out packages/postgres/src/__tests__/__fixtures__/upgrade-from-v1.0.1.sql
//
//   `--database-url` の DB は空で、拡張 `vector` / `btree_gin` / `pgcrypto` を作ってあること
//   （CI の postgres ジョブと同じ3本）。`pg_dump` は PATH から引く（`PG_DUMP` で上書き可）。
//   ⚠ 投入先の DB はこの道具が中身を作る。共有の DB を渡さないこと。
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    from: { type: "string" },
    tag: { type: "string" },
    "database-url": { type: "string" },
    out: { type: "string" },
  },
});
for (const key of ["from", "tag", "database-url", "out"]) {
  if (!values[key]) {
    console.error(`--${key} が要る（使い方はこのファイルの冒頭）`);
    process.exit(2);
  }
}

const fromRoot = path.resolve(values.from);
const requireFrom = createRequire(path.join(fromRoot, "packages/postgres/package.json"));
const pg = await import(requireFrom.resolve("@mnemora/postgres"));
const core = await import(requireFrom.resolve("@mnemora/core"));
const testkit = await import(requireFrom.resolve("@mnemora/testkit"));

const gitSha = spawnSync("git", ["-C", fromRoot, "rev-parse", "HEAD"], { encoding: "utf8" });
const fromSha = gitSha.status === 0 ? gitSha.stdout.trim() : "（git rev-parse に失敗）";

// ⚠ この3空間とテナントの対応は、fixture を読む歯（upgrade-from-released.postgres.test.ts）
// の `SPACES` と一致していること。
const SPACES = {
  small: { provider: "test", model: "fixture-model", dimensions: 3 },
  wide: { provider: "testkit", model: "deterministic", dimensions: 8 },
  long: {
    provider: "some-very-long-provider-name",
    model: "an-extremely-long-embedding-model-name-v2-large",
    dimensions: 4,
  },
};
const TENANTS = [
  ["tenant-a", "small", 24],
  ["tenant-b", "wide", 18],
  ["tenant-c", "long", 12],
  ["tenant-a2", "wide", 10],
];

class ZeroOrFailEmbedding extends testkit.DeterministicEmbeddingProvider {
  async embed(ctx, texts) {
    if (texts.some((t) => t.includes("FAIL"))) {
      throw new Error("fixture: embedding provider failure");
    }
    const vectors = await super.embed(ctx, texts);
    return vectors.map((v, i) => (texts[i].includes("ZERO") ? v.map(() => 0) : v));
  }
}

const client = pg.createPostgresClient(values["database-url"]);
const { db, pool } = client;
await pg.runMigrations(pool);
for (const space of Object.values(SPACES)) {
  await pg.registerEmbeddingSpace(pool, space);
}
const memoryStore = new pg.PostgresMemoryStore(db);

for (const [tenantId, spaceKey, n] of TENANTS) {
  const rt = core.createRuntime({
    memoryStore,
    outboxStore: new pg.PostgresOutboxStore(db),
    vectorStore: new pg.PostgresVectorStore(db),
    lexicalStore: new pg.PostgresLexicalStore(db),
    eventStore: new pg.PostgresEventStore(db),
    tenantSettingsStore: new pg.PostgresTenantSettingsStore(db),
    llmProvider: new testkit.DeterministicLLMProvider(),
    embeddingProvider: new ZeroOrFailEmbedding(SPACES[spaceKey]),
    hashContent: pg.sha256Hex,
  });
  const ctx = { tenantId };
  const ids = [];
  for (let i = 0; i < n; i++) {
    const zero = i % 7 === 3 ? " ZERO" : "";
    const text = `${tenantId} の記憶 ${i} 東京 会議 プロジェクト${i % 5}${zero}`;
    const r = await rt.observe(ctx, {
      kind: "utterance",
      text,
      speaker: "user",
      externalId: `${tenantId}-ext-${i}`,
    });
    ids.push(...r.memoryIds);
  }
  await rt.observe(ctx, {
    kind: "utterance",
    text: `${tenantId} FAIL 埋め込み失敗 東京`,
    speaker: "user",
  });
  await rt.tick(ctx, { kinds: ["embed"], leaseMs: 60_000, limit: 1000 });
  for (let i = 0; i < 3; i++) {
    const r = await rt.observe(ctx, {
      kind: "utterance",
      text: `${tenantId} 未埋め込み ${i}`,
      speaker: "user",
    });
    ids.push(...r.memoryIds);
  }
  await memoryStore.setEmbeddingStatus(ctx, ids[ids.length - 1], "skipped");
  await memoryStore.updateStatus(ctx, ids[4], "superseded", {
    supersededById: ids[5],
    expectedStatus: "active",
  });
  await rt.markContested(ctx, ids[6], ids[8], { reason: "fixture" });
  await memoryStore.updateStatus(ctx, ids[9], "archived", { expectedStatus: "active" });
  await rt.forget(ctx, { memoryIds: [ids[10], ids[11]] }, { reason: "fixture" });
  await rt.purge(ctx, { memoryId: ids[11] }, { reason: "fixture" });
  if (tenantId === "tenant-b") {
    await rt.forget(ctx, { memoryId: ids[8] }, { reason: "fixture: orphaned contested" });
  }
  if (tenantId === "tenant-c") {
    await rt.forget(ctx, { memoryId: ids[5] }, { reason: "fixture: successor forgotten" });
  }
  const rec = await rt.recall(ctx, { text: "東京 会議", limit: 5 });
  if (rec.memories.length > 0) {
    await rt.observe(ctx, {
      kind: "memory_usage",
      recallId: rec.recallId,
      usedMemoryIds: [rec.memories[0].memoryId],
    });
  }
}
// 利用者が同じスキーマに置いたビュー（mnemora は作らない）。`0022` がこれに `CREATE INDEX`
// を発行して止まった回帰（Issue #1038、PR #1043）を、この fixture でも踏めるようにする。
await pool.query(
  `CREATE VIEW memory_embeddings_all_spaces AS
     SELECT tenant_id, memory_id, embedding::text AS embedding_text FROM ${pg.embeddingSpaceTableName(SPACES.small)}
     UNION ALL
     SELECT tenant_id, memory_id, embedding::text FROM ${pg.embeddingSpaceTableName(SPACES.wide)}`,
);
await pool.query(
  `CREATE VIEW memory_embeddings_small_view AS SELECT * FROM ${pg.embeddingSpaceTableName(SPACES.small)}`,
);
await pg.closePostgresClient(client);

const dump = spawnSync(
  process.env.PG_DUMP ?? "pg_dump",
  ["--no-owner", "--no-privileges", "--inserts", "--format=plain", values["database-url"]],
  { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
);
if (dump.status !== 0) {
  console.error(dump.stderr);
  process.exit(1);
}

// `pg_dump` 17.6 以降は psql 専用のメタコマンド（`\restrict <乱数の鍵>` / `\unrestrict`）を
// 出す。歯は node-pg で SQL として流すので落とす（鍵は実行ごとに変わり、差分の雑音にもなる）。
const body = dump.stdout
  .split("\n")
  .filter((line) => !line.startsWith("\\"))
  .join("\n");

const header = [
  `-- 公開済みの版 ${values.tag} で作った DB の fixture（ADR 0344）。`,
  `-- ⛔ 手で編集しない。作り直すときは scripts/generate-upgrade-fixture.mjs を走らせる。`,
  `--`,
  `-- 作ったコード: ${values.tag}（${fromSha}）の @mnemora/postgres / @mnemora/core / @mnemora/testkit。`,
  `-- 埋め込み: @mnemora/testkit の DeterministicEmbeddingProvider（外部 API は使っていない）。`,
  `-- 中身: すべて合成データ（秘密・個人情報を含まない）。何を入れたかは`,
  `--       scripts/generate-upgrade-fixture.mjs の冒頭を見ること。`,
  `--`,
  "",
].join("\n");

writeFileSync(values.out, header + body);
console.log(`wrote ${values.out}（${values.tag} = ${fromSha}）`);
