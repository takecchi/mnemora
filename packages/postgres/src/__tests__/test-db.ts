import { Client, type Pool } from "pg";
import type { EmbeddingSpaceId } from "@mnemora/core";
import { createPostgresClient, type PostgresClient } from "../client.js";
import { runMigrations } from "../migrate.js";
import { registerEmbeddingSpace } from "../vector-space.js";
import { embeddingSpaceTableName } from "../embedding-space-table.js";

/**
 * `packages/postgres` のテストは本物の Postgres + pgvector に接続して実行する
 * （擬似物での置き換えを認めない、roadmap.md 段階2の完了条件）。
 *
 * 接続先は `DATABASE_URL` で与える。CI は GitHub Actions の service container
 * （`pgvector/pgvector:pg17`）を、ローカルは手元の実サーバーを指す。
 */
export function requireDatabaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      "DATABASE_URL が設定されていません。packages/postgres のテストは本物の Postgres + " +
        "pgvector が必要（擬似物では代替しない）。ローカルでは export DATABASE_URL=... を " +
        "設定してから `pnpm --filter @mnemora/postgres run test:db` を実行すること。",
    );
  }
  return url;
}

/** テストで使う既定の埋め込み空間（次元は小さく、テストの実行速度を優先する）。 */
export const TEST_EMBEDDING_SPACE: EmbeddingSpaceId = {
  provider: "test",
  model: "fixture-model",
  dimensions: 3,
};

let sharedClient: PostgresClient | undefined;
let ready: Promise<void> | undefined;

/**
 * プロセス内で1つの接続プールを使い回す（各テストファイルが個別に接続を張ると
 * CI のサービスコンテナに対して接続過多になりやすいため）。マイグレーションと
 * テスト用埋め込み空間の登録は初回だけ行う。
 */
export async function getTestClient(): Promise<PostgresClient> {
  if (!sharedClient) {
    sharedClient = createPostgresClient(requireDatabaseUrl());
  }
  if (!ready) {
    ready = (async () => {
      await runMigrations(sharedClient!.pool);
      await registerEmbeddingSpace(sharedClient!.pool, TEST_EMBEDDING_SPACE);
    })();
  }
  await ready;
  return sharedClient;
}

const DOMAIN_TABLES = [
  "recall_usages",
  "recalls",
  "memory_events",
  "outbox",
  embeddingSpaceTableName(TEST_EMBEDDING_SPACE),
  "memories",
  "observations",
  "tenant_settings",
  // ADR 0165（Issue #305）: 活動カウンタ。忘れるとテスト間で activity_seq が汚染される
  // （`getActivitySeq`/`createRecall(advanceActivityClock: true)` の歯が偽陽性/偽陰性になる）。
  "tenant_activity",
  // Issue #201 / ADR 0308: taxonomy の語彙。`memory_labels` は `memories`/`labels` の
  // どちらへの FK も持つため `CASCADE` で連れて消えるはずだが、`labels` 自体は他の
  // どのテーブルからも参照されていないため明示的に挙げないと残り、テスト間で
  // `proposedCount`/`status` が汚染される（実際に踏んだ——`listLabels` の歯が
  // 前のテストの行を拾って偽陽性で赤くなった）。
  "memory_labels",
  "labels",
];

/**
 * 各テストの前にドメインテーブルを空にする。in-memory 実装が「テストケースごとに
 * 独立した新しいインスタンスを返す」のと同じ独立性を、共有 DB 接続でも再現するため
 * （`MemoryStoreConformanceOptions.createStore` が各 `it()` の先頭で呼ばれる設計と対応する）。
 */
export async function resetTestDatabase(): Promise<void> {
  const { pool } = await getTestClient();
  await pool.query(`TRUNCATE TABLE ${DOMAIN_TABLES.join(", ")} RESTART IDENTITY CASCADE`);
}

export async function closeTestClient(): Promise<void> {
  if (sharedClient) {
    await sharedClient.pool.end();
    sharedClient = undefined;
    ready = undefined;
  }
}

/**
 * 決定的な擬似乱数（テストのベクトル生成用）。
 *
 * **`Math.random()` を使わない理由**: HNSW 索引が選ばれるか・ANN が何を返すかは
 * データ分布に依存する。入力が実行のたびに変わると、**落ちたときに再現できない**
 * ——実際に「一度だけ観測したが再現しない」flake の報告が出て、原因を追えなかった。
 * 種を固定すれば、落ちたときに必ず同じ入力で再現できる。
 *
 * mulberry32。テスト用途に十分な質があり、実装が短く依存を増やさない。
 */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** `captureClientQuery` が返す値。`explainCaptured` に渡して EXPLAIN する。 */
export interface CapturedQuery {
  text: string;
  params: unknown[];
  /**
   * 捕まえたクエリと**同じ接続の、同じトランザクション内**で、そのクエリより前に
   * 発行された `SET LOCAL ...` 文（発行順）。`PostgresVectorStore.search()` が
   * `db.transaction()` 内で ADR 0284 の `SET LOCAL`（`hnsw.iterative_scan` を
   * 対象にした1文）を発行してから SELECT する形を EXPLAIN でも再現するために持つ
   * （`explainCaptured` 参照）。`BEGIN` を観測するたびにリセットするため、
   * 前のトランザクション（プールの使い回しで同じ `Client` に残ったもの）の
   * `SET LOCAL` は混ざらない。
   */
  precedingSetLocalStatements: string[];
}

/**
 * `matcher` に一致する SQL のテキスト/パラメータを、実際に発行された生の pg クエリから
 * 捕まえる（`vector-search-hnsw.test.ts` 等が「`EXPLAIN` に掛けたいクエリそのものを
 * 実装から捕捉する」ために使う手法を1箇所にまとめたもの）。
 *
 * ⚠ **`pool.query` ではなく `Client.prototype.query` をパッチする**（ADR 0284）。
 * `db.transaction()` を使うコード（`PostgresVectorStore.search()` が ADR 0284 以降
 * そう）は `pool.connect()` が返す生の `pg.Client` の上で `BEGIN`・本体のクエリ・
 * `COMMIT` を発行し、`pool.query()` を経由しない。`pool.query()` 自身も内部では
 * 同じ `client.query()` を呼ぶだけの薄いラッパー（`pg-pool` の実装）なので、
 * `Client.prototype.query` を1箇所パッチすれば、`pool.query()` 経由・
 * `db.transaction()` 経由のどちらの発行元でも同じ場所で拾える。
 * 【実測】旧実装（`pool.query` をパッチする版）は `db.transaction()` に変わった
 * `search()` を「一致するクエリが観測されなかった」で捕まえ損ねた
 * （`vector-search-hnsw.test.ts` 等が実際にこの形で落ちた）。
 *
 * ⚠ **`SET LOCAL` も同じ場所で観測して `precedingSetLocalStatements` に積む**
 * （後述 ADR）。`EXPLAIN` は独立したクエリなので、これを持ち帰らないと
 * `explainCaptured` は `SET LOCAL` の効いていないセッション既定値（`hnsw.iterative_scan
 * = off`）でプランを読むことになり、本番（`relaxed_order`）とは違う文脈を見てしまう。
 */
export async function captureClientQuery(
  matcher: (text: string) => boolean,
  fn: () => Promise<unknown>,
): Promise<CapturedQuery> {
  let capturedText: string | undefined;
  let capturedParams: unknown[] | undefined;
  let precedingSetLocalStatements: string[] = [];
  // 接続（`Client` インスタンス）ごとに、直近の `BEGIN` 以降に見た `SET LOCAL` を積む。
  const setLocalHistoryByClient = new WeakMap<Client, string[]>();
  const originalQuery = Client.prototype.query;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (Client.prototype as any).query = function (this: Client, ...args: unknown[]) {
    const [config, params] = args as [string | { text: string }, unknown[] | undefined];
    const text = typeof config === "string" ? config : config.text;
    if (/^\s*begin\b/i.test(text)) {
      // 新しいトランザクションの開始——このクライアントの SET LOCAL 履歴をリセットする
      // （プールが同じ Client を使い回すと、前のトランザクションの SET LOCAL が
      // 残っていることがあるが、それは既に COMMIT/ROLLBACK で失効している）。
      setLocalHistoryByClient.set(this, []);
    } else if (/^\s*set\s+local\s/i.test(text)) {
      const history = setLocalHistoryByClient.get(this) ?? [];
      history.push(text);
      setLocalHistoryByClient.set(this, history);
    }
    if (matcher(text)) {
      capturedText = text;
      capturedParams = params;
      precedingSetLocalStatements = setLocalHistoryByClient.get(this) ?? [];
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (originalQuery as any).apply(this, args);
  };
  try {
    await fn();
  } finally {
    Client.prototype.query = originalQuery;
  }
  if (capturedText === undefined) {
    throw new Error("captureClientQuery: matcher に一致するクエリが観測されなかった");
  }
  return {
    text: capturedText,
    params: capturedParams ?? [],
    precedingSetLocalStatements,
  };
}

/**
 * `captureClientQuery` が捕まえたクエリを、**捕まえたのと同じ transaction の文脈**で
 * `EXPLAIN` する（Issue #671 / ADR 0284 追記）。
 *
 * ## 何のためか
 *
 * `PostgresVectorStore.search()` は ADR 0284 以降、`db.transaction()` の中で
 * ADR 0284 の `SET LOCAL`（`hnsw.iterative_scan` を対象にした1文）を発行してから
 * SELECT する。ところが `captureClientQuery` で捕まえた SELECT を、素の
 * `pool.query("EXPLAIN ...")` に渡すだけでは、その `EXPLAIN` は**別の・SET LOCAL の
 * 効いていないトランザクション**（実質 `hnsw.iterative_scan` がセッション既定値の
 * ままの状態）で実行される。
 * ⟹ 4つの歯（`vector-search-hnsw.test.ts` / `vector-search-subject.test.ts` /
 * `recall.postgres.test.ts` / `memories-statistics.postgres.test.ts`）が実際に
 * 見ていたのは本番のプランではなく、本番では起こらない設定でのプランだった。
 *
 * ## どう直すか
 *
 * 専用の接続を1本 `pool.connect()` で取り、`BEGIN` → `captured.precedingSetLocalStatements`
 * を発行順に再生 → `EXPLAIN (FORMAT TEXT) captured.text` → `ROLLBACK` の順に発行する。
 * `SET LOCAL` の値をこの関数にハードコードしない——`captureClientQuery` が実際に観測した
 * 文をそのまま再生するので、`vector-store.ts` の実装が `SET LOCAL` をやめる／値を変える
 * ように直っても、この歯は自動的に追従する（歯自身が `relaxed_order` を書いていた場合、
 * 実装側の変更を見逃してしまう——それを避けるための設計）。
 *
 * `ROLLBACK` で終える（`COMMIT` しない）——`EXPLAIN`（`ANALYZE` オプション無し）は
 * 何も書き込まないため、コミットする理由が無い。
 */
export async function explainCaptured(pool: Pool, captured: CapturedQuery): Promise<string> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const statement of captured.precedingSetLocalStatements) {
      await client.query(statement);
    }
    const explainResult = await client.query(
      `EXPLAIN (FORMAT TEXT) ${captured.text}`,
      captured.params,
    );
    return explainResult.rows.map((row: { "QUERY PLAN": string }) => row["QUERY PLAN"]).join("\n");
  } finally {
    await client.query("ROLLBACK");
    client.release();
  }
}
