import { z } from "zod";
import { StoredAttributesSchema } from "./attributes.js";
import type { Attributes } from "./attributes.js";
import { ClaimKeySchema, type ClaimKey } from "./claim-key.js";
import type { MemoryId, ObservationId } from "./ids.js";
import { ProvenanceSchema, type Provenance } from "./provenance.js";

/**
 * Memory の状態。
 * - `active`: 通常の状態。recall の既定の対象。
 * - `superseded`: 別の Memory に置き換えられた（`supersededById`）。
 * - `contested`: 矛盾する相手と組になっている（`contestedWithId`）。
 * - `archived`: 減衰して退避された（`archiveDecayed`）。戻す口がある。
 * - `forgotten`: 利用者が `forget` した。本文は残り、`purge` で物理的に消える。
 */
export type MemoryStatus = "active" | "superseded" | "contested" | "archived" | "forgotten";

/** `MemoryStatus` の zod スキーマ。値を実行時に検査するときに使う（型 `MemoryStatus` と揃えてある）。 */
export const MemoryStatusSchema = z.enum([
  "active",
  "superseded",
  "contested",
  "archived",
  "forgotten",
]) satisfies z.ZodType<MemoryStatus>;

/**
 * `Memory.strength` の上限（ADR 0078）。
 *
 * `strength` は `total = similarity × decay × tagMatch × freshness × strength`（docs/recall.md §7）に掛かる
 * 係数で、**1 は「素通り」を意味する唯一の値**。上限が無いと、値を1つ大きく書いた Memory がそのテナントの
 * 想起を支配する（[ADR 0036](../../../docs/decisions/0036-clamp-freshness-at-one.md) が `freshness` で塞いだのと同じ穴）。
 * 呼び出し側が上限の存在と値を読めるよう、`MAX_FRESHNESS`（`strategies/scoring.ts`）と同じく export する。
 */
export const MAX_STRENGTH = 1;

/**
 * `Memory.strength` の値域は **`(0, MAX_STRENGTH]`**（ADR 0078）。
 *
 * 0 を含めないのは、`strength = 0` が「二度と引かれない」という意味になり、それは `status: 'forgotten'` が
 * 既に表しているため（同じことを言う道が2つ在ると、読む側が両方見る必要が出る）。
 *
 * **`NaN` と `Infinity` を弾いているのは、この比較の向きである。**`NaN` との比較は全部 false になるので
 * `NaN > 0` が false で落ち、`Infinity <= 1` も false で落ちる。**`value <= 0 || value > MAX_STRENGTH` のように
 * 否定で書き直してはならない**（`NaN` が「範囲外ではない」と判定されて素通りする）。
 * `Number.isFinite(value) &&` を先頭に置かないのも意図的で、置いても適合スイートは赤くならず（冗長なため）、
 * 歯の当たらない防御は後から比較の向きを変える人に「`isFinite` が見ているから大丈夫」と読ませる（ADR 0078）。
 */
export function isStrengthInRange(value: number): boolean {
  return value > 0 && value <= MAX_STRENGTH;
}

/**
 * `"skipped"` は同梱の本番コードからは書かれない（`extraction.ts` が書くのは `"pending"` だけで、`runtime.ts` が
 * そこから遷移させるのは `"ready"`/`"failed"` の2値だけ）。ただし `MemoryStore.setEmbeddingStatus(ctx, id, status)` の
 * `status` は呼び出し側が直接値を渡せる公開パラメータで、型の外側に構造的な壁は無く、値を落とす理由にならない
 * （ADR 0117・0144 が扱った「構造的に到達不能な union 値」とは別。全遷移の意味を今日決める根拠が無いことは
 * ADR 0053「採らなかった案」が明記している）。
 */
export type EmbeddingStatus = "pending" | "ready" | "failed" | "skipped";

/** `EmbeddingStatus` の zod スキーマ。値を実行時に検査するときに使う（型 `EmbeddingStatus` と揃えてある）。 */
export const EmbeddingStatusSchema = z.enum([
  "pending",
  "ready",
  "failed",
  "skipped",
]) satisfies z.ZodType<EmbeddingStatus>;

/** `digest` をどう作ったか。`"llm"` は LLM が返した要旨、`"fallback"` は LLM の要旨が無い・空だったので本文の先頭を切り出したもの。 */
export type DigestSource = "llm" | "fallback";

/** `DigestSource` の zod スキーマ。値を実行時に検査するときに使う（型 `DigestSource` と揃えてある）。 */
export const DigestSourceSchema = z.enum(["llm", "fallback"]) satisfies z.ZodType<DigestSource>;

/**
 * 解釈済みの記憶単位（docs/memory-model.md §1・§10）。
 *
 * `contentHash` は content の SHA-256 の hex 文字列とする規約。**core はこの値を計算しない**
 * （docs/architecture.md §3.6 の「core は zod 以外の実行時依存を持たない」を守るため、Node の `crypto` に
 * 依存させない）。呼び出し側・adapter が `crypto.createHash('sha256').update(content).digest('hex')`
 * （またはそれと同値の実装）で計算し、`NewMemory.contentHash` に渡すこと。
 *
 * 後から足した欄（`validFrom`/`validUntil`・`claimKey`・活動時計の3つ組・`purgedAt`・`attributes`）が省略可能なのは、
 * `Memory` が公開型で、必須にすると自前でリテラルを組み立てている既存の呼び出し元・adapter・fixture すべてに
 * 新しい必須プロパティを強制する破壊的変更になるため。
 */
export interface Memory {
  /** Memory の id。 */
  id: MemoryId;
  /** Memory が属するテナント。 */
  tenantId: string;
  /** テナントの中の主題。主題の無い Memory は `null`（または省略）。 */
  subjectId?: string | null;

  /**
   * 元になった Observation の id。
   *
   * ⚠ **テナントの一致は検査しない。**`MemoryStore.createMemory` にほかのテナントの Observation の id を渡しても、
   * `@mnemora/postgres`（`observations(id)` への外部キーは `tenant_id` を見ない）・`@mnemora/testkit` の
   * `InMemoryMemoryStore` のどちらも受け付け、呼んだテナントの行にほかのテナントを指す参照が残る。
   * **ほかのテナントの行は変わらず、その本文も読めない**（読みの口はすべて `ctx.tenantId` で絞る）。
   * `Runtime` は同じ `ctx` で作った Observation の id しか渡さないので、この形になるのは `MemoryStore` を
   * 直接呼んだときだけ。`docs/memory-model.md` §5 を参照。
   */
  sourceObservationId?: ObservationId | null;
  /** この Memory を作った抽出器の版。抽出の冪等キー（観測・抽出器の版・`contentHash`）の一部。 */
  extractorVersion?: string | null;

  /** 本文。purge されると tombstone（`PURGE_TOMBSTONE_CONTENT`）で上書きされる。 */
  content: string;
  /** `content` の SHA-256 の hex 文字列（上の doc: core は計算しない。`RuntimeDeps.hashContent` で作る）。 */
  contentHash: string;
  /** 要旨（recall が返す・目次帯に載せる短い文）。作り方は `digestSource`。 */
  digest: string;
  /** `digest` をどう作ったか（{@link DigestSource}）。 */
  digestSource: DigestSource;

  /** どこから来たか（{@link Provenance}）。 */
  provenance: Provenance;

  /** 状態（{@link MemoryStatus}）。 */
  status: MemoryStatus;
  /**
   * 置き換えた側の id。同じテナントの行を指す前提の欄だが、`MemoryStore` はそれを検査しない
   * （Postgres の FK は `memories(id)` への単純参照で `tenant_id` を見ない）。実害は無い——`MemoryStore` の
   * 全ての読み取り口が `tenant_id = ctx.tenantId` で絞るため、他テナントを指しても本文は読めない
   * （`packages/core/src/interfaces/memory-store.ts` の `isContestedWithoutCompanion` の doc）。
   */
  supersededById?: MemoryId | null;
  /** `supersededById` と同じ注意が当たる（テナント一致は検査しない）。 */
  contestedWithId?: MemoryId | null;

  /**
   * 要素の長さの上限は約束しない——`Ctx`（`ctx.ts`）の doc 参照。
   *
   * 要素は文字列の完全一致で比べる（`labels`・`RecallQuery.labels`・`tagMatch` とも）。大文字小文字・
   * 全角半角・Unicode の正規化形・前後の空白は同じものとして扱わない（`docs/memory-model.md` §8）。
   */
  tags: string[];

  /** 出来事が起きた時刻（Observation の `occurredAt` など）。分からなければ `null`。期間の絞り込みと `freshness` の起点に使う（無ければ `recordedAt`）。 */
  occurredAt?: Date | null;
  /** 記録した時刻。減衰の起点（強化されていなければ）。 */
  recordedAt: Date;
  /** 最後に強化（`reinforce`）された時刻。無ければ `null` で、減衰の起点は `recordedAt` になる。 */
  lastReinforcedAt?: Date | null;

  /**
   * その事実が**真であり続けた期間**の始点（`docs/memory-model.md` §3、
   * [ADR 0145](../../../docs/decisions/0145-valid-from-until-storage.md)）。不明・無期限なら `null`。
   *
   * **`occurredAt` と混同しないこと。**`occurredAt` はその出来事・事実が*いつのものか*（1点、鮮度スコアに使う）で、
   * `validFrom`/`validUntil` はその事実が*いつからいつまで真か*（区間）。「いまも真か」を分けるのは
   * `validFrom`/`validUntil` のほうで、`occurredAt` が同じでも `validUntil` が過去なら「もう真ではない」を表せる。
   *
   * **`recall()` はこの区間で絞り込む**（[ADR 0164](../../../docs/decisions/0164-valid-from-until-recall.md)、`validAt` ゲート）。
   * `RecallQuery.validAt`（省略時は `now`）の時点で真でない記憶（`validFrom > validAt` または
   * `validUntil <= validAt`）は段1（ANN・語彙の SQL の `WHERE`）で落ち、`omitted` の
   * `filtered(not_yet_valid)`/`filtered(expired)` として名指しされる。`RecallQuery.includeOutsideValidity: true` で
   * ゲートを外せる。**スコアの計算には使わない。**
   */
  validFrom?: Date | null;
  /** `validFrom` の doc 参照。対になる終点。 */
  validUntil?: Date | null;

  /**
   * 「この記憶は何についての主張か」を表す構造化された鍵（ADR 0185・ADR 0315、`claim-key.ts` の doc 参照）。
   *
   * **この鍵は LLM が作る ⟹ 推論である**（`docs/north-star.md` 問い4）。`provenance`（ユーザーが言った事実か
   * AI の推論かを区別する欄）とは**別の軸**で、この欄が非 `null` であること自体は `provenance.kind` に影響しない。
   * 「事実」と「主張の分類」を混ぜないための、意図的に別の欄である。
   *
   * `subject`/`predicate` は `normalizeClaimKeyPart`（claim-key.ts）で正規化済みの値を想定する。読み出し側は
   * 「既に正規化されている」ことを前提にしてよい（書き込み側が正規化してから渡す契約）。
   *
   * **この欄が埋まっていることは、検出が実行されたことを意味しない。**鍵を持たせるだけで、同じ鍵を持つ2件を
   * 見つけて `contested` を立てる処理はこの欄の責務ではない（ADR 0185）。
   *
   * `undefined`（未指定）と `null`（明示的に鍵なし）は同じ意味で、読み出し側はどちらも「鍵が無い」として扱うこと。
   *
   * **[ADR 0630](../../../docs/decisions/0630-store-rejects-new-memory-that-fails-memory-schema-on-read-back.md) から、
   * 書き込みの口は、主語か述語の片方だけのオブジェクト・空文字の `subject`・`predicate`（型を破る入力。
   * 例: `{ subject: "user" }`・`{ subject: "", predicate: "p" }`）を入口で拒む**（`MemoryStore.createMemory`・
   * `createMemoryWithOutbox`・`supersedeWithNewMemories`。何も書かない。冪等の既存の行が在っても拒む）。
   * 鍵を持たせたいなら、2欄とも空でない文字列で渡すこと（{@link ClaimKeySchema} は2欄とも `min(1)`）。
   * 持たせないなら `null` か省略。
   *
   * ⚠ この拒否は**書き込みの口だけ**の話で、それより前に書かれた行（片側だけの列を持つ行など）は読み側に残りうる。
   * 読み出しの口はそれを**鍵なし**として扱い続ける（`findActiveByClaimKey` に一致せず、`listActiveClaimPredicates` にも数えられない）。
   */
  claimKey?: ClaimKey | null;

  /**
   * 強さ。値域は `(0, MAX_STRENGTH]`（ADR 0078）。
   *
   * ⚠ **`@mnemora/postgres` はこの値を float4（`real` 列）の精度に丸めて保存する。**`@mnemora/testkit` の
   * fixture も、書いた値と読み戻す値を Postgres と同じ float4 の表記に揃える（PR #1517）ので、
   * 強化（`reinforce`）の後に store が保存済みの `strength`・`halfLifeHours` で計算し直す `decayFloorAt` も
   * 実装どうしで一致する（【実測】半減期 720〜約1000万時間・`strength` 0.3〜1 で、Postgres と fixture の差は
   * 0ms）。段2の減衰係数（`scoring.ts`）も、どちらも丸めた値で計算される。列の型を変える案・書く前に丸める案は
   * 採っていない。`docs/memory-model.md` §7 を参照。
   */
  strength: number;
  /**
   * 半減期（時間）。値域は `(0, ∞)` の有限の正の実数（ADR 0125）。
   *
   * ⚠ **`@mnemora/postgres` はこの値を float4（`real` 列）の精度に丸めて保存する。**`strength` の doc の
   * とおり、fixture も同じ表記に揃えるので、強化後の `decayFloorAt` は実装どうしで一致する。
   *
   * Postgres の列は `real`（float4）なので、float4 に収まる範囲（`Math.fround(x)` が有限かつ 0 でない値。上限は約
   * `3.4028235e38`、下限は約 `1.4e-45`）の外は、`@mnemora/postgres` も testkit の fixture も、メッセージに
   * `does not fit in a Postgres "real" (float4) column` を含む `Error` で拒む（DB の生の例外にはしない）。
   */
  halfLifeHours: number;
  /** 壁時計で、強さが忘却の閾値を下回る時刻（書き込み時・強化時に計算して保存する）。recall の忘却ゲート（既定で有効。`RecallQuery.includeFullyDecayed` で外せる）は、この時刻が「今」以前の Memory を除く。 */
  decayFloorAt: Date;

  /**
   * 活動時計（[ADR 0165](../../../docs/decisions/0165-decay-activity-clock.md)）の3つ組。壁時計の
   * `recordedAt`/`lastReinforcedAt` → `decayFloorAt` → `halfLifeHours` と**1対1に対応する**。
   * `decayBaseSeq` は起点（書き込み時点の `tenant_activity.activity_seq`）、`decayFloorSeq` は床（書き込み時に
   * 一度だけ計算する）、`halfLifeRecalls` は Memory 単位の半減期（単位: そのテナントで `recall()` が起きた回数）。
   *
   * **すべて省略可能。**`undefined` も `null` も「この軸には床が無い＝活動時計では沈まない」を意味する。
   * `decay_clock` が `'wall'` のまま一度も切り替えていないテナントでは、この3つは一度も書かれない。
   * **後から切り替えても、`'wall'` の間に作られた記憶の3つ組は `null` のままで、活動時計では沈まない**（契約）。
   */
  decayBaseSeq?: number | null;
  /** `decayBaseSeq` の doc 参照。活動時計の床。 */
  decayFloorSeq?: number | null;
  /** `decayBaseSeq` の doc 参照。活動時計での Memory 単位の半減期。値域・拒否される範囲は `halfLifeHours` と同じ（float4 に収まらない値は同じ文面の `Error` で拒む）。 */
  halfLifeRecalls?: number | null;

  /** 埋め込みの状態（{@link EmbeddingStatus}）。 */
  embeddingStatus: EmbeddingStatus;

  /**
   * 非 `null` なら `content`/`digest` は物理削除のトゥームストーンで上書き済み
   * （[ADR 0124](../../../docs/decisions/0124-purge-physical-delete.md)、docs/memory-model.md §9・§11 行10）。
   * `status` はこの操作で動かないため（`purged` は `memories.status` の値ではない）、「purge されたか」は
   * 常にこの列で判定する。
   */
  purgedAt?: Date | null;

  /**
   * 呼び手が申告した任意属性（公開範囲・区分など。ADR 0312）。
   *
   * `tags` は 100% LLM の推論、`attributes` は 100% 呼び手の申告で、抽出器はこの欄を一度も読み書きしない
   * （`attributes.ts` の doc 参照）。
   *
   * **作成経路ごとの引き継ぎ方（ADR 0312）**:
   * - 抽出（`buildNewMemoryFromCandidate`）: 観測（`Observation.attributes`）をそのまま継承する
   *   （フォールバック経路も含む）。限定の出所から出た記憶は限定のまま。
   * - 統合（`buildConsolidatedMemory`）・反芻（`buildReflectedMemory`）: 元の Memory **全件**に同じキー・同じ値で
   *   入っている分だけを残す（積集合）。呼び手が申告していない値を、推論の産物に持ち込まないため。
   *
   * **型としては省略可能だが、上記いずれの経路も runtime は常に `{}` 以上の値を書く**（`Observation.attributes` と
   * 同じ runtime 保証、ADR 0289）。`undefined` は、型を自前で組み立てている呼び出し元・fixture だけが持ちうる。
   */
  attributes?: Attributes;

  /** 行を作った時刻。 */
  createdAt: Date;
  /** 行を最後に書き換えた時刻。 */
  updatedAt: Date;
}

/**
 * `createMemory` への入力。`id` / `createdAt` / `updatedAt` は store が採番する。
 *
 * `contentHash` と `decayFloorAt` は呼び出し側（runtime/adapter）が計算して渡す。
 * `decayFloorAt` は `defaultDecayStrategy.floorAt(...)` を書き込み時に一度だけ呼んで得た値を渡すこと
 * （docs/memory-model.md §7・ADR 0010）。
 */
export type NewMemory = Omit<
  Memory,
  "id" | "createdAt" | "updatedAt" | "status" | "supersededById" | "contestedWithId"
> &
  Partial<Pick<Memory, "status" | "supersededById" | "contestedWithId">>;

/** `Memory` の zod スキーマ。値を実行時に検査するときに使う（型 `Memory` と揃えてある）。 */
export const MemorySchema = z.object({
  id: z.string().min(1),
  tenantId: z.string().min(1),
  subjectId: z.string().min(1).nullable().optional(),

  sourceObservationId: z.string().min(1).nullable().optional(),
  extractorVersion: z.string().min(1).nullable().optional(),

  content: z.string(),
  contentHash: z.string().min(1),
  digest: z.string().min(1),
  digestSource: DigestSourceSchema,

  provenance: ProvenanceSchema,

  status: MemoryStatusSchema,
  supersededById: z.string().min(1).nullable().optional(),
  contestedWithId: z.string().min(1).nullable().optional(),

  tags: z.array(z.string()),

  occurredAt: z.date().nullable().optional(),
  recordedAt: z.date(),
  lastReinforcedAt: z.date().nullable().optional(),

  validFrom: z.date().nullable().optional(),
  validUntil: z.date().nullable().optional(),

  claimKey: ClaimKeySchema.nullable().optional(),

  // この schema は書き込み経路では走らない（`.parse()` している箇所は無く、型の導出元として使われている）。
  // 実際に値域を強制するのは store の層（`packages/postgres` の CHECK 制約と、in-memory 実装の検査）。
  // ここを締めるのは公開された型の契約としてで、防波堤ではない。以下の `halfLifeHours`・活動時計の3つ組も同じ。
  strength: z.number().gt(0).max(MAX_STRENGTH),
  // `z.number().positive()` は `0`・負・`NaN`・`±Infinity` をすべて拒む（zod は NaN を `invalid_type` として扱う）。
  halfLifeHours: z.number().positive(),
  decayFloorAt: z.date(),

  decayBaseSeq: z.number().nullable().optional(),
  decayFloorSeq: z.number().nullable().optional(),
  halfLifeRecalls: z.number().nullable().optional(),

  embeddingStatus: EmbeddingStatusSchema,

  purgedAt: z.date().nullable().optional(),

  // 格納側は検査をしない schema を使う（`AttributesSchema` は `ObserveXxxInput`/`RecallQuery` 側専用）。
  attributes: StoredAttributesSchema.optional(),

  createdAt: z.date(),
  updatedAt: z.date(),
}) satisfies z.ZodType<Memory>;

/** `NewMemory` の zod スキーマ。値を実行時に検査するときに使う（型 `NewMemory` と揃えてある）。 */
export const NewMemorySchema = MemorySchema.omit({
  id: true,
  createdAt: true,
  updatedAt: true,
  status: true,
  supersededById: true,
  contestedWithId: true,
}).extend({
  status: MemoryStatusSchema.optional(),
  supersededById: z.string().min(1).nullable().optional(),
  contestedWithId: z.string().min(1).nullable().optional(),
}) satisfies z.ZodType<NewMemory>;
