import type {
  ClaimKey,
  DigestSource,
  EmbeddingStatus,
  EventActor,
  IndexBand,
  LabelSummary,
  Memory,
  MemoryEvent,
  MemoryEventKind,
  MemoryStatus,
  Observation,
  Omission,
  OutboxJobKind,
  OutboxJobRecord,
  Provenance,
  RecallBudget,
  RecallRecord,
  RecallRecordReturnedMemories,
  RecallUsage,
  StageTrace,
} from "@mnemora/core";

/**
 * DB の行（`pg` ドライバが返す生の行。列名は snake_case）を core の型へ変換する。
 *
 * `packages/postgres` のクエリは `sql` タグ付きテンプレート（drizzle-orm）で書いており、
 * `SELECT *` の結果はドライバがそのまま snake_case のプロパティ名で返す。ここで
 * camelCase の core 型へ変換する境界を1箇所に集める。
 *
 * **`timestamptz` は文字列で返る。** `drizzle-orm/node-postgres` は
 * `TIMESTAMPTZ`/`TIMESTAMP`/`DATE`/`INTERVAL` 等の型パーサをあえて恒等関数に上書きしている
 * （drizzle 独自の decode を後段の schema 経由でしか適用しないための仕様。生 SQL 実行
 * （`db.execute(sql\`...\`)`）ではこの decode を経由しないため、文字列のまま返る）。
 * このファイルの `parsePgTimestamp` がその文字列を `Date` へ変換する境界を1箇所に集める。
 */

/**
 * Postgres の `timestamptz` の既定テキスト出力（例:
 * `"2026-05-11 00:47:17.621+09"`、`"2026-01-01 00:00:00.123456+05:30"`）を `Date` に変換する。
 * `new Date()` にそのまま渡せる ISO 8601 形式（`T` 区切り・コロン付きタイムゾーン）へ
 * 正規化してから変換する。
 *
 * Issue #1039: 既定の出力には、`new Date()` が読めない形もある。
 * - 秒を含む時差（`"1850-01-01 09:18:59+09:18:59"`）——サーバの `TimeZone` が
 *   地方平均時（LMT）の時代を持つ地域のとき、その時代の時刻
 * - 紀元前の接尾辞（`"0001-06-01 00:00:00+00 BC"`。紀元前1年は天文年の0年）
 * - 5桁以上の年（`"10000-01-01 00:00:00+00"`）
 *
 * これらを含め、時差つきの形は各欄から UTC の時刻を組み立てる。年は `Date.UTC` ではなく
 * `setUTCFullYear` で入れる（`Date.UTC` は0〜99年を1900年代として読む）。小数秒は
 * `new Date()` と同じく、ミリ秒より下を切り捨てる。
 */
export function parsePgTimestamp(value: string): Date;
export function parsePgTimestamp(value: string | null): Date | null;
export function parsePgTimestamp(value: string | null): Date | null {
  if (value === null) {
    return null;
  }
  const parts = value.match(
    /^(\d{4,})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?([+-])(\d{2})(?::?(\d{2}))?(?::?(\d{2}))?( BC)?$/,
  );
  if (parts) {
    const [, y, mo, d, h, mi, s, frac, sign, oh, om, os, bc] = parts;
    const year = bc === undefined ? Number(y) : 1 - Number(y);
    // 時差は各欄から直接引く（ローカル時刻をいったん UTC として組むと、`Date` の表せる
    // 範囲の端（±275760年）で途中の値だけが範囲を超えて NaN になる）。
    const k = sign === "-" ? -1 : 1;
    const utc = new Date(0);
    utc.setUTCFullYear(year, Number(mo) - 1, Number(d));
    utc.setUTCHours(
      Number(h) - k * Number(oh),
      Number(mi) - k * Number(om ?? "0"),
      Number(s) - k * Number(os ?? "0"),
      Number((frac ?? "").padEnd(3, "0").slice(0, 3)),
    );
    return utc;
  }
  let normalized = value.replace(" ", "T");
  const tz = normalized.match(/([+-]\d{2})(:?(\d{2}))?$/);
  if (tz) {
    const sign = tz[1];
    const minutes = tz[3] ?? "00";
    normalized = normalized.slice(0, normalized.length - tz[0].length) + `${sign}:${minutes}`;
  }
  return new Date(normalized);
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * core の id 型（`ObservationId` / `MemoryId` 等）は単なる `string` であり、UUID 形式を
 * 強制しない。しかし `packages/postgres` の各テーブルの主キーは `uuid` 型のため、
 * 呼び出し側が任意の文字列（例: 存在確認のための `"does-not-exist"`）を渡すと、
 * Postgres がクエリ実行時点で `invalid input syntax for type uuid` を投げてしまう
 * ——「存在しない」と「壊れた入力」を区別せずに済ませたい箇所（`getObservation` が
 * null を返す契約、`OutboxStore.complete`/`fail` がべき等に成功する契約）では、
 * この形式チェックで**クエリを投げる前に**判定し、DB 由来のエラーメッセージを
 * 呼び出し側に漏らさない（roadmap.md 段階3 で実 DB 検査により判明した不整合の修正）。
 */
export function isUuidLike(value: string): boolean {
  return UUID_PATTERN.test(value);
}

export interface MemoryRow {
  id: string;
  tenant_id: string;
  subject_id: string | null;
  source_observation_id: string | null;
  extractor_version: string | null;
  content: string;
  content_hash: string;
  digest: string;
  digest_source: string;
  provenance: Provenance;
  status: string;
  superseded_by_id: string | null;
  contested_with_id: string | null;
  tags: string[];
  occurred_at: string | null;
  recorded_at: string;
  last_reinforced_at: string | null;
  valid_from: string | null;
  valid_until: string | null;
  // Issue #371（ADR 0185/ADR 0315）: `Memory.claimKey` の doc コメント参照。
  // 2列とも NULL＝鍵なし。`rowToMemory` がこの2列を1つの `ClaimKey` オブジェクトへ
  // 組み立てる（`packages/postgres/migrations/0021_memories_claim_key.sql` の
  // 「NULL の意味」参照）。
  claim_key_subject: string | null;
  claim_key_predicate: string | null;
  strength: number;
  half_life_hours: number;
  decay_floor_at: string;
  // ADR 0165（Issue #305）: 活動時計の3つ組。`bigint` 列は node-postgres が精度損失を
  // 避けるため文字列で返す——`parsePgBigint` で変換する（`parsePgTimestamp` と同じ形の
  // 境界）。すべて NULL 許容（「この軸には床が無い」を意味する）。
  decay_base_seq: string | number | null;
  decay_floor_seq: string | number | null;
  half_life_recalls: number | null;
  embedding_status: string;
  purged_at: string | null;
  created_at: string;
  updated_at: string;
  // Issue #152/#153（ADR 0312）: `jsonb NOT NULL DEFAULT '{}'`。`pg` は jsonb を
  // パース済みオブジェクトとして返す（`provenance` 列と同じ扱い——`row.provenance` も
  // 追加の変換なしに使っている）。
  attributes: Record<string, string>;
}

/**
 * Postgres の `bigint` 列（node-postgres が精度損失を避けるため文字列で返しうる。
 * `parsePgTimestamp` の doc コメント参照——生 SQL 実行では drizzle の decode を経由しない）
 * を `number` に変換する。`null` はそのまま通す（ADR 0165 決めたこと4「NULL はこの軸に
 * 床が無いことを意味する」）。
 *
 * `Number.MAX_SAFE_INTEGER` を超える運用は想定していない（活動時計は「recall() の回数」を
 * 数えるカウンタであり、そこまで到達する前に他の限界に当たる）。
 */
export function parsePgBigint(value: string | number | null): number | null {
  if (value === null) {
    return null;
  }
  return typeof value === "number" ? value : Number(value);
}

/**
 * `memories.claim_key_subject`/`claim_key_predicate`（2列）を、`Memory.claimKey`
 * （`{subject, predicate}` の組、または鍵なしの `null`）へ組み立てる。
 *
 * Issue #371: 契約上は両方 NULL か両方非 NULL のどちらかのはず（`0021_memories_claim_key.sql`
 * の「NULL の意味」参照）だが、DB 側で CHECK 制約は強制していない。**片方だけ非 NULL の
 * 行に出会っても例外にしない**——読み出し側（この関数）は「主語または述語のどちらかが
 * 欠けているなら鍵なしとして扱う」という寛容な側へ倒す（`docs/autonomy.md` の「壊れている
 * ものを直す」規律に反しない範囲で、読み出しを止めない）。
 */
function rowToClaimKey(
  row: Pick<MemoryRow, "claim_key_subject" | "claim_key_predicate">,
): ClaimKey | null {
  if (row.claim_key_subject === null || row.claim_key_predicate === null) {
    return null;
  }
  return { subject: row.claim_key_subject, predicate: row.claim_key_predicate };
}

export function rowToMemory(row: MemoryRow): Memory {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    subjectId: row.subject_id,
    sourceObservationId: row.source_observation_id,
    extractorVersion: row.extractor_version,
    content: row.content,
    contentHash: row.content_hash,
    digest: row.digest,
    digestSource: row.digest_source as DigestSource,
    provenance: row.provenance,
    status: row.status as MemoryStatus,
    supersededById: row.superseded_by_id,
    contestedWithId: row.contested_with_id,
    tags: row.tags,
    occurredAt: parsePgTimestamp(row.occurred_at),
    recordedAt: parsePgTimestamp(row.recorded_at),
    lastReinforcedAt: parsePgTimestamp(row.last_reinforced_at),
    validFrom: parsePgTimestamp(row.valid_from),
    validUntil: parsePgTimestamp(row.valid_until),
    claimKey: rowToClaimKey(row),
    strength: row.strength,
    halfLifeHours: row.half_life_hours,
    decayFloorAt: parsePgTimestamp(row.decay_floor_at),
    decayBaseSeq: parsePgBigint(row.decay_base_seq),
    decayFloorSeq: parsePgBigint(row.decay_floor_seq),
    halfLifeRecalls: row.half_life_recalls,
    embeddingStatus: row.embedding_status as EmbeddingStatus,
    purgedAt: parsePgTimestamp(row.purged_at),
    createdAt: parsePgTimestamp(row.created_at),
    updatedAt: parsePgTimestamp(row.updated_at),
    attributes: row.attributes,
  };
}

/**
 * Issue #201 / ADR 0318: `labels` テーブルの1行（`migrations/0020_taxonomy_labels.sql`）。
 */
export interface LabelRow {
  id: string;
  tenant_id: string;
  name: string;
  status: string;
  proposed_count: number;
  registered_at: string | null;
  created_at: string;
}

export function rowToLabel(row: LabelRow): LabelSummary {
  return {
    name: row.name,
    status: row.status as LabelSummary["status"],
    proposedCount: row.proposed_count,
    registeredAt: parsePgTimestamp(row.registered_at),
  };
}

export interface ObservationRow {
  id: string;
  tenant_id: string;
  subject_id: string | null;
  external_id: string | null;
  kind: string;
  payload: unknown;
  occurred_at: string | null;
  recorded_at: string;
  valid_from: string | null;
  valid_until: string | null;
  // Issue #152（ADR 0312）: `MemoryRow.attributes` の doc コメント参照。
  attributes: Record<string, string>;
}

export function rowToObservation(row: ObservationRow): Observation {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    subjectId: row.subject_id,
    externalId: row.external_id,
    kind: row.kind,
    payload: row.payload,
    occurredAt: parsePgTimestamp(row.occurred_at),
    recordedAt: parsePgTimestamp(row.recorded_at),
    validFrom: parsePgTimestamp(row.valid_from),
    validUntil: parsePgTimestamp(row.valid_until),
    attributes: row.attributes,
  };
}

export interface MemoryEventRow {
  id: string;
  tenant_id: string;
  memory_id: string | null;
  kind: string;
  at: string;
  actor: EventActor;
  digest_snapshot: string | null;
  size_before_bytes: number | null;
  meta: Record<string, unknown>;
}

export function rowToMemoryEvent(row: MemoryEventRow): MemoryEvent {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    memoryId: row.memory_id,
    kind: row.kind as MemoryEventKind,
    at: parsePgTimestamp(row.at),
    actor: row.actor,
    digestSnapshot: row.digest_snapshot,
    sizeBeforeBytes: row.size_before_bytes,
    meta: row.meta,
  };
}

export interface OutboxJobRow {
  id: string;
  tenant_id: string;
  kind: string;
  payload: Record<string, unknown>;
  available_at: string;
  claimed_at: string | null;
  claimed_by: string | null;
  attempts: number;
  completed_at: string | null;
  failed_at: string | null;
  last_error: string | null;
  created_at: string;
}

export function rowToOutboxJob(row: OutboxJobRow): OutboxJobRecord {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    kind: row.kind as OutboxJobKind,
    payload: row.payload,
    availableAt: parsePgTimestamp(row.available_at),
    claimedAt: parsePgTimestamp(row.claimed_at),
    claimedBy: row.claimed_by,
    attempts: row.attempts,
    completedAt: parsePgTimestamp(row.completed_at),
    failedAt: parsePgTimestamp(row.failed_at),
    lastError: row.last_error,
    createdAt: parsePgTimestamp(row.created_at),
  };
}

/**
 * Issue #298 / [ADR 0155](../../../docs/decisions/0155-recall-score-breakdown-persisted.md):
 * `recalls` 行（`MemoryStore.getRecall` が読む側）。`createRecall` の書き込みが埋める
 * 列と1対1に対応する（`packages/postgres/src/memory-store.ts` の `createRecall`/`getRecall`
 * 参照）。
 */
export interface RecallRow {
  id: string;
  tenant_id: string;
  subject_id: string | null;
  query: unknown;
  budget: RecallBudget | null;
  omitted: Omission[];
  usage: RecallUsage;
  index_band: IndexBand;
  explain: { stages: StageTrace[] };
  returned_memories: RecallRecordReturnedMemories;
  created_at: string;
}

export function rowToRecallRecord(row: RecallRow): RecallRecord {
  return {
    recallId: row.id,
    tenantId: row.tenant_id,
    subjectId: row.subject_id,
    query: row.query,
    budget: row.budget,
    omitted: row.omitted,
    usage: row.usage,
    indexBand: row.index_band,
    explain: row.explain,
    returnedMemories: row.returned_memories,
    createdAt: parsePgTimestamp(row.created_at),
  };
}
