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
 * Postgres の `timestamptz` の既定テキスト出力（例: `"2026-05-11 00:47:17.621+09"`）を `Date` に変換する。
 *
 * 生 SQL 実行（`db.execute(sql\`...\`)`）の `timestamptz` は、`drizzle-orm/node-postgres` が型パーサを
 * 恒等関数に上書きしているため文字列で返る。この関数がその文字列を `Date` へ変換する唯一の境界である。
 *
 * `new Date()` に渡せる ISO 8601 形式へ置換するだけでは足りない。既定の出力には `new Date()` が読めない形がある。
 * - 秒を含む時差（`"1850-01-01 09:18:59+09:18:59"`。地方平均時の時代）
 * - 紀元前の接尾辞（`"0001-06-01 00:00:00+00 BC"`。紀元前1年は天文年の0年）
 * - 5桁以上の年（`"10000-01-01 00:00:00+00"`）
 *
 * 年は `Date.UTC` ではなく `setUTCFullYear` で入れる（`Date.UTC` は0〜99年を1900年代として読む）。
 * 小数秒はミリ秒より下を切り捨てる。
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
    // 時差は各欄から直接引く。ローカル時刻をいったん UTC として組むと、`Date` の範囲の端（±275760年）で途中の値だけが NaN になる。
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

/**
 * `Date` を、SQL のパラメータとして送る `timestamptz` の文字列（UTC）にする。`parsePgTimestamp` の逆向き。
 * 書き込みの値も WHERE の条件も、`Date` を `pg` に直接渡さず必ずこの関数を通す。
 *
 * - `pg` は `Date` を**プロセスのローカル時刻**の文字列にし、時差を**分に切り捨てて**送る。TZ が地方平均時の
 *   時代に秒を含む時差を持つ地域だと、その時代の日時が秒単位でずれて保存される。
 * - `pg.defaults.parseInputDatesAsUTC` は使わない。プロセス全体の `pg` の既定が変わり、利用者の他の接続にも効くため。
 * - `toISOString()` は使わない。5桁以上の年と紀元前が `+010000-...` / `-000001-...` になり、Postgres が読めないため。
 *
 * Invalid Date は Postgres が拒む文字列になる（DB のエラーになる）。
 */
export function toPgTimestamp(date: Date): string;
export function toPgTimestamp(date: Date | null | undefined): string | null;
export function toPgTimestamp(date: Date | null | undefined): string | null {
  if (date === null || date === undefined) {
    return null;
  }
  const astronomicalYear = date.getUTCFullYear();
  const bc = astronomicalYear < 1;
  const year = bc ? 1 - astronomicalYear : astronomicalYear;
  const pad = (n: number, width = 2): string => String(n).padStart(width, "0");
  return (
    `${pad(year, 4)}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}` +
    `T${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}` +
    `.${pad(date.getUTCMilliseconds(), 3)}+00:00${bc ? " BC" : ""}`
  );
}

/** PostgreSQL の timestamptz の下限（4714-11-24 BC 00:00:00 UTC）。これより前の日時は `22008 timestamp out of range` になる。 */
export const PG_TIMESTAMPTZ_MIN_MS = Date.UTC(-4713, 10, 24);

/**
 * `date` が `timestamptz` の下限より前か。Invalid Date（`NaN`）は「前」ではない（`22007` のまま DB が断る）。
 * cutoff が下限より前の purge が、問い合わせずに「0件」で返す判定に使う（ADR 0547）。
 */
export function isBeforePgTimestamptzMin(date: Date): boolean {
  return date.getTime() < PG_TIMESTAMPTZ_MIN_MS;
}

/**
 * **読みの口の条件**の日時を、`timestamptz` の下限へ寄せてから `toPgTimestamp` にする（ADR 0547）。
 * 列の値はすべて下限以後なので、`>=`・`>` の条件は全件を、`<=`・`<` の条件は0件に近い結果を返す
 * （日時の意味どおりの答え）。Invalid Date は寄せず `22007` になる。
 *
 * **行に書く値には使わない**（寄せると別の日時が保存される）。書く口は `toPgTimestamp` のまま、下限より前なら `22008`。
 */
export function toPgTimestampClamped(date: Date): string;
export function toPgTimestampClamped(date: Date | null | undefined): string | null;
export function toPgTimestampClamped(date: Date | null | undefined): string | null {
  if (date === null || date === undefined) {
    return null;
  }
  return toPgTimestamp(isBeforePgTimestamptzMin(date) ? new Date(PG_TIMESTAMPTZ_MIN_MS) : date);
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * core の id 型は単なる `string` で UUID 形式を強制しないが、テーブルの主キーは `uuid` 型なので、任意の文字列を
 * 渡すと Postgres が `invalid input syntax for type uuid` を投げる。「存在しない」と「壊れた入力」を区別せずに
 * 済ませたい箇所（`getObservation` が null を返す契約、`OutboxStore.complete`/`fail` がべき等に成功する契約）では、
 * この形式チェックで**クエリを投げる前に**判定し、DB 由来のエラーを呼び出し側に漏らさない。
 */
export function isUuidLike(value: string): boolean {
  return UUID_PATTERN.test(value);
}

/**
 * store の入口で、uuid の形の id を小文字にそろえる（形の合わない id はそのまま返す）。
 *
 * DB は uuid を大文字小文字を区別せずに比べ、小文字で返す。渡された id を JS で比べる箇所（`Map` を引く・`===`）や
 * 記録に写す箇所（`memory_events.meta`）は、大文字の UUID だけで DB の値と食い違うため、入口でそろえる。
 * store の中の正規化であり、呼び出し側から渡されるイベントの `meta` の中身は、store が解釈しないのでそろえない。
 */
export function normalizeUuidCase<T extends string>(id: T): T {
  return (isUuidLike(id) ? id.toLowerCase() : id) as T;
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
  claim_key_subject: string | null;
  claim_key_predicate: string | null;
  strength: number;
  half_life_hours: number;
  decay_floor_at: string;
  decay_base_seq: string | number | null;
  decay_floor_seq: string | number | null;
  half_life_recalls: number | null;
  embedding_status: string;
  purged_at: string | null;
  created_at: string;
  updated_at: string;
  attributes: Record<string, string>;
}

/**
 * Postgres の `bigint` 列（node-postgres が精度損失を避けるため文字列で返しうる）を `number` に変換する。
 * `null` はそのまま通す（この軸に床が無い）。`Number.MAX_SAFE_INTEGER` を超える運用は想定しない。
 */
export function parsePgBigint(value: string | number | null): number | null {
  if (value === null) {
    return null;
  }
  return typeof value === "number" ? value : Number(value);
}

/**
 * `memories.claim_key_subject`/`claim_key_predicate` を `Memory.claimKey` へ組み立てる。
 *
 * 契約上は両方 NULL か両方非 NULL だが、DB に CHECK 制約は無い。**片方だけ非 NULL の行に出会っても例外にしない**
 * （鍵なしとして扱い、読み出しを止めない）。
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

/** `labels` テーブルの1行。 */
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

/** `recalls` 行（`MemoryStore.getRecall` が読む側）。 */
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
