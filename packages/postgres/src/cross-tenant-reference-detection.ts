import type { Pool } from "pg";
import { assertSafeSchemaName, qualify } from "./schema-namespace.js";

export const CROSS_TENANT_REFERENCE_KINDS = [
  "recall_usages",
  "memories.source_observation_id",
  "memories.contested_with_id",
  "memories.superseded_by_id",
] as const;

export type CrossTenantReferenceKind = (typeof CROSS_TENANT_REFERENCE_KINDS)[number];

/** `memories` の参照欄（3種）の食い違い1行。 */
export interface MemoryReferenceMismatch {
  /** 参照を持つ記憶の id。 */
  id: string;
  /** その記憶の `tenant_id`。 */
  tenantId: string;
  /** 参照先（observation か memory）の id。 */
  targetId: string;
  /** 参照先の `tenant_id`。 */
  targetTenantId: string;
}

/** `recall_usages` の食い違い1行。recall と memory の両方が食い違っても、1行である。 */
export interface RecallUsageMismatch {
  /** `recall_usages` の行の `tenant_id`。 */
  tenantId: string;
  recallId: string;
  memoryId: string;
  /** 指す recall の `tenant_id`。 */
  recallTenantId: string;
  /** 指す memory の `tenant_id`。 */
  memoryTenantId: string;
}

export type CrossTenantReferenceFinding =
  | {
      kind: "recall_usages";
      /** 食い違う行の数（`sampleLimit` に左右されない）。 */
      count: number;
      /** 先頭から `sampleLimit` 件（行の並びは主キー順）。 */
      samples: RecallUsageMismatch[];
    }
  | {
      kind: Exclude<CrossTenantReferenceKind, "recall_usages">;
      count: number;
      samples: MemoryReferenceMismatch[];
    };

export interface FindCrossTenantReferencesOptions {
  /** 専用スキーマの名前（`runMigrations` に渡したものと同じ）。省略なら接続の `search_path` 任せ。 */
  schema?: string;
  /** 種類ごとに返すサンプル行の最大数。0 以上 1000 以下の整数。既定 20。0 なら件数だけ。 */
  sampleLimit?: number;
}

export interface FindCrossTenantReferencesResult {
  /** 4種の `count` の合計。0 なら、この4種について、この時点のスナップショットに食い違う行は無かった。 */
  total: number;
  /** 常に {@link CROSS_TENANT_REFERENCE_KINDS} の順で、4種すべてを含む（0件の種類も `count: 0` で載る）。 */
  findings: CrossTenantReferenceFinding[];
}

const DEFAULT_SAMPLE_LIMIT = 20;
const MAX_SAMPLE_LIMIT = 1000;

interface Detection {
  /** `FROM` から `WHERE` までの文。 */
  from: (t: Tables) => string;
  /** サンプルの SELECT の列と `ORDER BY`。 */
  columns: string;
  orderBy: string;
}

interface Tables {
  memories: string;
  observations: string;
  recalls: string;
  recallUsages: string;
}

function memoryRefDetection(column: "superseded_by_id" | "contested_with_id"): Detection {
  return {
    from: (t) =>
      `FROM ${t.memories} m JOIN ${t.memories} t ON t.id = m.${column} WHERE m.tenant_id <> t.tenant_id`,
    columns: `m.id::text AS id, m.tenant_id AS "tenantId", m.${column}::text AS "targetId", t.tenant_id AS "targetTenantId"`,
    orderBy: "m.id",
  };
}

const DETECTIONS: Record<CrossTenantReferenceKind, Detection> = {
  recall_usages: {
    from: (t) =>
      `FROM ${t.recallUsages} u JOIN ${t.recalls} r ON r.id = u.recall_id JOIN ${t.memories} m ON m.id = u.memory_id WHERE u.tenant_id <> r.tenant_id OR u.tenant_id <> m.tenant_id`,
    columns: `u.tenant_id AS "tenantId", u.recall_id::text AS "recallId", u.memory_id::text AS "memoryId", r.tenant_id AS "recallTenantId", m.tenant_id AS "memoryTenantId"`,
    orderBy: "u.tenant_id, u.recall_id, u.memory_id",
  },
  "memories.source_observation_id": {
    from: (t) =>
      `FROM ${t.memories} m JOIN ${t.observations} t ON t.id = m.source_observation_id WHERE m.tenant_id <> t.tenant_id`,
    columns: `m.id::text AS id, m.tenant_id AS "tenantId", m.source_observation_id::text AS "targetId", t.tenant_id AS "targetTenantId"`,
    orderBy: "m.id",
  },
  "memories.contested_with_id": memoryRefDetection("contested_with_id"),
  "memories.superseded_by_id": memoryRefDetection("superseded_by_id"),
};

/**
 * 参照先が別のテナントの行を指している既存行を、検出だけする
 * （[ADR 0636](../../../docs/decisions/0636-cross-tenant-reference-detection-is-read-only.md)）。
 * 対象は ADR 0439 が書き込み口に入口検査を入れた4種（{@link CROSS_TENANT_REFERENCE_KINDS}）で、種類ごとに
 * 食い違う行を数え、先頭の `sampleLimit` 件を返す。外部キーが `(id)` だけでテナントを含まないので、
 * 検査の無かった時代の書き込みが食い違う行を残しうる。参照が NULL の行は対象外。
 * `memory_events`・`memory_embeddings_<space>`・`memory_relations` は対象外（各 ADR の SQL を手で流す）。
 *
 * - 何も書かない。食い違い行の削除・付け替えは利用者のデータの書き換えで、オーナーの判断になる。
 *   食い違いが見つかっても投げない。
 * - 0件は「食い違いが無い」の証明ではなく、「この4種について、呼び出し時点のスナップショットに無かった」である。
 * - `BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY` の中で種類ごとに `count(*)` とサンプルの SELECT を発行し、
 *   `ROLLBACK` する。取るロックは `ACCESS SHARE` だけで、書き込みを止めない。
 * - 費用は対象の表の `JOIN` 1回ぶん。大きな表での所要時間は測っていない。`statement_timeout` は設定しない。
 *
 * @throws RangeError `sampleLimit` が 0 以上 1000 以下の整数でないとき。
 */
export async function findCrossTenantReferences(
  pool: Pool,
  options: FindCrossTenantReferencesOptions = {},
): Promise<FindCrossTenantReferencesResult> {
  const { schema, sampleLimit = DEFAULT_SAMPLE_LIMIT } = options;
  if (schema !== undefined) {
    assertSafeSchemaName(schema);
  }
  if (!Number.isInteger(sampleLimit) || sampleLimit < 0 || sampleLimit > MAX_SAMPLE_LIMIT) {
    throw new RangeError(
      `findCrossTenantReferences: sampleLimit must be an integer between 0 and ${MAX_SAMPLE_LIMIT} (got ${String(sampleLimit)})`,
    );
  }
  const tables: Tables = {
    memories: qualify(schema, "memories"),
    observations: qualify(schema, "observations"),
    recalls: qualify(schema, "recalls"),
    recallUsages: qualify(schema, "recall_usages"),
  };

  const client = await pool.connect();
  let broken: Error | undefined;
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const findings: CrossTenantReferenceFinding[] = [];
    for (const kind of CROSS_TENANT_REFERENCE_KINDS) {
      const d = DETECTIONS[kind];
      const counted = await client.query<{ n: string }>(`SELECT count(*) AS n ${d.from(tables)}`);
      const count = Number(counted.rows[0]!.n);
      let samples: unknown[] = [];
      if (sampleLimit > 0 && count > 0) {
        const rows = await client.query(
          `SELECT ${d.columns} ${d.from(tables)} ORDER BY ${d.orderBy} LIMIT $1`,
          [sampleLimit],
        );
        samples = rows.rows;
      }
      findings.push({ kind, count, samples } as CrossTenantReferenceFinding);
    }
    return { total: findings.reduce((sum, f) => sum + f.count, 0), findings };
  } finally {
    try {
      await client.query("ROLLBACK");
    } catch (error) {
      // ROLLBACK まで失敗した接続は、状態が分からないので pool へ戻さず捨てる。
      broken = error instanceof Error ? error : new Error(String(error));
    }
    client.release(broken);
  }
}
