#!/usr/bin/env node
// ⚠ 投入先の DB はこの道具が中身を作る。共有の DB を渡さないこと。
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

// ⚠ この3空間とテナントの対応は、fixture を読む歯の `SPACES` と一致させること。
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

// `pg_dump` 17.6 以降の psql 専用メタコマンド（`\restrict` / `\unrestrict`）は、歯が node-pg で流すので落とす。
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
