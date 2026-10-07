import { expect } from "vitest";
import type { Ctx } from "../ctx.js";
import type { MemoryEvent } from "../event.js";
import { ExtractionResultSchema } from "../extraction.js";
import type { LLMProvider, StructuredRequest } from "../interfaces/llm-provider.js";
import type { Runtime } from "../runtime.js";

/** 群（`markContestedGroup`）の監査イベントが群の大きさ N に対して線形にしか増えないことを縛る歯の共通部品。core の Fake・testkit の InMemory・Postgres が同じ走らせ方（同じ claimKey・有効期間 null の発話を N 件、`detectContested` 付きで observe する）を使えるよう、ここに1つだけ置く。 */

export const GROWTH_CTX: Ctx = { tenantId: "contested-group-event-growth" };

const CLAIM_KEY = { subject: "user", predicate: "address" };

/** 抽出には発話をそのまま1件返し、claim key の導出にはいつも同じ鍵を返す偽の LLM。 */
export function growthLlm(): LLMProvider {
  let next = 0;
  return {
    complete: async () => {
      throw new Error("not used");
    },
    completeStructured: async <T>(_ctx: Ctx, req: StructuredRequest<T>): Promise<T> => {
      if ((req.schema as unknown) === ExtractionResultSchema) {
        return req.schema.parse({
          memories: [{ content: `住所は場所${next++}`, provenanceKind: "stated" }],
        });
      }
      return req.schema.parse({ claims: [CLAIM_KEY] });
    },
  };
}

export interface GrowthMeasurement {
  /** `updated` かつ `meta.reason === "contested"` のイベントの件数。 */
  contestedEvents: number;
  /** それらの `meta.note`（JSON 文字列）の長さの最大。 */
  maxNoteLength: number;
  /** それらの `meta` 全体の JSON のバイト数の合計。 */
  totalMetaBytes: number;
  /** `note` を JSON として読んだもののうち、最後に積まれたもの。 */
  lastNote: Record<string, unknown> | null;
}

/** N 件を observe し、群の監査イベントの大きさを測る。N は 3 以上。 */
export async function measureContestedGroupGrowth(
  runtime: Runtime,
  readEvents: () => Promise<readonly MemoryEvent[]>,
  n: number,
  ctx: Ctx = GROWTH_CTX,
): Promise<GrowthMeasurement> {
  for (let i = 0; i < n; i++) {
    await runtime.observe(ctx, {
      kind: "utterance",
      text: `住所は場所${i}`,
      claimKey: { enabled: true, detectContested: true },
    });
  }
  const events = (await readEvents()).filter(
    (e) =>
      e.tenantId === ctx.tenantId &&
      e.kind === "updated" &&
      (e.meta as Record<string, unknown> | null | undefined)?.reason === "contested",
  );
  let maxNoteLength = 0;
  let totalMetaBytes = 0;
  let lastNote: Record<string, unknown> | null = null;
  for (const e of events) {
    const meta = e.meta as Record<string, unknown>;
    const note = typeof meta.note === "string" ? meta.note : "";
    maxNoteLength = Math.max(maxNoteLength, note.length);
    totalMetaBytes += Buffer.byteLength(JSON.stringify(meta));
    if (note !== "") lastNote = JSON.parse(note) as Record<string, unknown>;
  }
  return { contestedEvents: events.length, maxNoteLength, totalMetaBytes, lastNote };
}

export function expectLinearGrowth(m: Record<10 | 20 | 40, GrowthMeasurement>): void {
  for (const n of [10, 20, 40] as const) {
    // N+2 は、1・2件目が2者の対として積む2件（`markContested`）と、3件目で対が群へ吸収されて
    // `contestedWithId` が外れる2件のうち、2者版の2件を数えるぶん。
    expect(m[n].contestedEvents).toBeLessThanOrEqual(n + 2);
  }
  // note の長さは N に依らない上限に収まる（先頭 K 件で頭打ちになる）。
  expect(m[40].maxNoteLength - m[20].maxNoteLength).toBeLessThan(40);
  expect(m[40].maxNoteLength).toBeLessThanOrEqual(m[10].maxNoteLength * 1.25);
  for (const n of [10, 20, 40] as const) {
    expect(m[n].totalMetaBytes).toBeLessThanOrEqual((n + 2) * PER_EVENT_META_BYTES_CEILING);
  }
}

/** イベント1件の meta のバイト数の上限。実測は N に依らず約1.5KB（先頭 K 件の note）。 */
const PER_EVENT_META_BYTES_CEILING = 2500;
