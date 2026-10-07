import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import type { MemoryId, NewMemoryEvent } from "@mnemora/core";

/** 有効期間をマイクロ秒精度まで指定して `memories` へ直接行を入れたいので、生の SQL で入れる。 */

export interface RawValidity {
  /** ISO 8601（マイクロ秒まで書ける）。null は無限。 */
  validFrom: string | null;
  validUntil: string | null;
}

export async function insertRawMemory(
  pool: Pool,
  tenantId: string,
  contentHash: string,
  validity: RawValidity,
  status: "active" | "contested" | "superseded" = "active",
): Promise<MemoryId> {
  const id = randomUUID();
  await pool.query(
    `INSERT INTO memories (id, tenant_id, content, content_hash, digest, digest_source,
        provenance_kind, provenance, status, tags, recorded_at, strength, half_life_hours,
        decay_floor_at, embedding_status, created_at, updated_at, valid_from, valid_until,
        claim_key_subject, claim_key_predicate)
     VALUES ($1, $2, 'c', $3, 'd', 'llm', 'imported', '{"kind":"imported"}'::jsonb,
        $6, '{}'::text[], now(), 1, 720, now() + interval '30 days', 'ready', now(), now(),
        $4::timestamptz, $5::timestamptz, 'user', 'address')`,
    [id, tenantId, contentHash, validity.validFrom, validity.validUntil, status],
  );
  return id as MemoryId;
}

export function newEvent(tenantId: string, memoryId: MemoryId, tag: string): NewMemoryEvent {
  return {
    tenantId,
    memoryId,
    kind: "updated",
    actor: { type: "system" },
    digestSnapshot: `digest-${tag}`,
    meta: { tag },
  };
}

const T0 = Date.UTC(2020, 0, 1);
const DAY = 86_400_000;
const iso = (ms: number): string => new Date(ms).toISOString();

export type Shape = "chain" | "star" | "complete";

export function validityFor(shape: Shape, i: number): RawValidity {
  if (shape === "complete") return { validFrom: null, validUntil: null };
  if (shape === "chain") {
    return { validFrom: iso(T0 + 10 * i * DAY), validUntil: iso(T0 + (10 * i + 15) * DAY) };
  }
  if (i === 0) return { validFrom: null, validUntil: null };
  return { validFrom: iso(T0 + 10 * i * DAY), validUntil: iso(T0 + (10 * i + 5) * DAY) };
}

/** 決定的な疑似乱数（mulberry32）。 */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * 端が null（無限）・境目ちょうど・1マイクロ秒のずれ・空に近い区間が混ざる乱数の有効期間。
 * 端点は 0..20 の整数マイクロ秒の格子に置くので、境目が一致する組が頻繁に出る。
 */
export function randomValidity(next: () => number): RawValidity {
  const base = T0;
  const at = (k: number): string => {
    const secs = Math.floor(k / 1_000_000);
    const micros = k % 1_000_000;
    return `${new Date(base + secs * 1000).toISOString().replace(".000Z", "")}.${String(micros).padStart(6, "0")}Z`;
  };
  const grid = (): number => Math.floor(next() * 21) * 500_000 + Math.floor(next() * 2);
  const from = next() < 0.2 ? null : grid();
  const until = next() < 0.2 ? null : grid();
  return {
    validFrom: from === null ? null : at(from),
    validUntil: until === null ? null : at(until),
  };
}

/** ISO（マイクロ秒まで）を BigInt のマイクロ秒へ。 */
export function toMicros(s: string): bigint {
  const m = /^(.*?)(?:\.(\d{1,6}))?Z$/.exec(s)!;
  const ms = BigInt(Date.parse(`${m[1]}Z`));
  return ms * 1000n + BigInt((m[2] ?? "").padEnd(6, "0"));
}

/** 半開区間の重なり（`findActiveByClaimKey` と同じ式）。JS 側の参照実装。 */
export function overlaps(a: RawValidity, b: RawValidity): boolean {
  const aFrom = a.validFrom === null ? null : toMicros(a.validFrom);
  const aUntil = a.validUntil === null ? null : toMicros(a.validUntil);
  const bFrom = b.validFrom === null ? null : toMicros(b.validFrom);
  const bUntil = b.validUntil === null ? null : toMicros(b.validUntil);
  return (
    (aFrom === null || bUntil === null || aFrom < bUntil) &&
    (bFrom === null || aUntil === null || bFrom < aUntil)
  );
}
