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
 * `strength` は `total = similarity × decay × tagMatch × freshness × strength`
 * （docs/recall.md §7）に掛かる係数であり、**1 は「素通り」を意味する唯一の値**である。
 * 上限が無いと、値を1つ大きく書いた Memory がそのテナントの想起を支配する——
 * [ADR 0036](../../../docs/decisions/0036-clamp-freshness-at-one.md) が `freshness` で
 * 塞いだのと同じ穴である。
 *
 * `MAX_FRESHNESS`（`strategies/scoring.ts`）と同じ理由で export する:
 * 呼び出し側が**上限の存在と値を読める**形にしておく。
 */
export const MAX_STRENGTH = 1;

/**
 * `Memory.strength` の値域は **`(0, MAX_STRENGTH]`**（ADR 0078）。
 *
 * **0 を含めないのは、`strength = 0` が `total` を恒久的に 0 にする＝「二度と引かれない」
 * という意味になり、それは `status: 'forgotten'` が既に表しているからである。**
 * 同じことを言う道が2つ在ると、どちらで表されているかを読む側が両方見る必要が出る。
 *
 * 🔴 **`NaN` と `Infinity` を弾いているのは、この比較の「向き」である。**
 * `NaN` との比較は全部 false になるので `NaN > 0` が false になって落ちる。
 * `Infinity` は `Infinity <= 1` が false で落ちる。
 * **⚠ だから `value <= 0 || value > MAX_STRENGTH` のように否定で書き直してはならない**
 * ——その形にすると `NaN` は「範囲外ではない」と判定されて素通りする。
 *
 * ⚠ **最初は `Number.isFinite(value) &&` を先頭に置いていたが、変異試験で外した。**
 * それを落としても適合スイートは赤くならなかった——上のとおり冗長だからである。
 * **歯の当たらない防御を「守っている」の顔で残すと、後から比較の向きを変える人が
 * 「`isFinite` が見ているから大丈夫」と読む。**それがいちばん危ない。
 * 経緯は ADR 0078 の「変異試験で分かったこと」に書いてある。
 */
export function isStrengthInRange(value: number): boolean {
  return value > 0 && value <= MAX_STRENGTH;
}

/**
 * `"skipped"` は本番コードのどこからも書かれない（`extraction.ts` が書くのは
 * `"pending"` だけで、`runtime.ts` がそこから遷移させるのは `"ready"`/`"failed"` の
 * 2値だけ）。**ただしこれは Issue #206 / ADR 0117・0144 が扱った「構造的に到達不能な
 * union 値」とは別の性質である**——`MemoryStore.setEmbeddingStatus(ctx, id, status)` の
 * `status` は呼び出し側が直接値を渡せる公開パラメータであり、型の外側に「これは通らない」
 * という構造的な壁は無い。「今日それを呼ぶ本番コードが無いだけ」であり、値を落とす理由には
 * ならない（ADR 0053「採らなかった案」の「遷移表を全面的に固定する」が、この値も含め
 * 全遷移の意味を今日決める根拠が無いと明記している。Issue #168 の棚卸し項目13-3）。
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
 * `contentHash` について（D16）: content の SHA-256 の hex 文字列とする規約。
 * **core はこの値を計算しない**（Node の `crypto` に依存させないため、
 * docs/architecture.md §3.6 の「core は zod 以外の実行時依存を持たない」を守る）。
 * 呼び出し側・adapter が `crypto.createHash('sha256').update(content).digest('hex')`
 * （またはそれと同値の実装）で計算し、`NewMemory.contentHash` に渡すこと。
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
   * ⚠ **テナントの一致は検査しない**（[Issue #1051](https://github.com/takecchi/mnemora/issues/1051)）。
   * `MemoryStore.createMemory` にほかのテナントの Observation の id を渡しても、
   * `@mnemora/postgres`（`observations(id)` への外部キーは `tenant_id` を見ない）・
   * `@mnemora/testkit` の `InMemoryMemoryStore` のどちらも受け付け、呼んだテナントの行に
   * ほかのテナントを指す参照が残る。**ほかのテナントの行は変わらず、その本文も読めない**
   * （読みの口はすべて `ctx.tenantId` で絞る）。`Runtime` は同じ `ctx` で作った Observation の
   * id しか渡さないので、この形になるのは `MemoryStore` を直接呼んだときだけである。
   * `docs/memory-model.md` §5 の 2026-09-27 追記を参照。
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
   * 置き換えた側の id。同じテナントの行を指す前提で設計された欄だが、`MemoryStore` は
   * それを検査しない（Postgres の FK は `memories(id)` への単純参照で `tenant_id` を
   * 見ない）。実害は無い——`MemoryStore` の全ての読み取り口が `tenant_id = ctx.tenantId`
   * で絞るため、他テナントを指しても本文は読めない（`isContestedWithoutCompanion`
   * の doc コメント、`packages/core/src/interfaces/memory-store.ts`、Issue #854）。
   */
  supersededById?: MemoryId | null;
  /** `supersededById` と同じ注意が当たる（テナント一致は検査しない、Issue #854）。 */
  contestedWithId?: MemoryId | null;

  /**
   * 要素の長さの上限は約束しない——`Ctx`（`ctx.ts`）の doc コメント参照（Issue #1074）。
   *
   * 要素は文字列の完全一致で比べる（`labels`・`RecallQuery.labels`・`tagMatch` とも）。大文字小文字・
   * 全角半角・Unicode の正規化形・前後の空白は同じものとして扱わない（Issue #953、
   * `docs/memory-model.md` §8 の 2026-09-27 追記）。
   */
  tags: string[];

  /** 出来事が起きた時刻（Observation の `occurredAt` など）。分からなければ `null`。期間の絞り込みと `freshness` の起点に使う（無ければ `recordedAt`）。 */
  occurredAt?: Date | null;
  /** 記録した時刻。減衰の起点（強化されていなければ）。 */
  recordedAt: Date;
  /** 最後に強化（`reinforce`）された時刻。無ければ `null` で、減衰の起点は `recordedAt` になる。 */
  lastReinforcedAt?: Date | null;

  /**
   * Issue #202（`docs/memory-model.md` §3「三つ（四つ）の時計」の4本目・5本目、
   * [ADR 0145](../../../docs/decisions/0145-valid-from-until-storage.md)）:
   * その事実が**真であり続けた期間**の始点。可（不明・無期限なら NULL）。
   *
   * 🔴 **`occurredAt` と混同しないこと。** `occurredAt` はその出来事・事実が
   * *いつのものか*（1点、鮮度スコアに使う）であり、`validFrom`/`validUntil` は
   * その事実が*いつからいつまで真か*（区間）である。「去年の住所」と「今の住所」は
   * どちらも `occurredAt`（引っ越した/住み始めた時刻）を持ちうるが、**「いまも真か」を
   * 分けるのは `validFrom`/`validUntil` のほうである**——`occurredAt` が同じでも、
   * `validUntil` が過去なら「もう真ではない」を表せる。
   *
   * DB 列自体は `packages/postgres/migrations/0001_init.sql` に Phase 1 から存在するが
   * （`purgedAt` の doc コメントと同じ経緯）、`Memory`/`MemoryRow` にこのフィールドが無く
   * 一度も読み書きされていなかった。ADR 0145 が `packages/postgres` の読み書きを
   * 初めて配線する。
   *
   * **`recall()` はこの区間で絞り込む**（[ADR 0164](../../../docs/decisions/0164-valid-from-until-recall.md)、
   * `validAt` ゲート）。`RecallQuery.validAt`（省略時は `now`）の時点で真でない記憶——
   * `validFrom > validAt` または `validUntil <= validAt`——は段1（ANN・語彙の SQL の `WHERE`）で
   * 落ち、`omitted` の `filtered(not_yet_valid)`/`filtered(expired)` として名指しされる。
   * `RecallQuery.includeOutsideValidity: true` でゲートを外せる。**スコアの計算には使わない。**
   * （ADR 0145 の時点では recall はこの値を使っておらず、それを射程外としていた。ADR 0164 が
   * その射程外を実装した。）
   *
   * **省略可能な既存フィールドとして足した**（`purgedAt` と同じ理由——`Memory` は
   * `@mnemora/core` の公開型。必須にすると、この型を自分でリテラルとして組み立てている
   * 既存の呼び出し元・adapter・テストのフィクスチャすべてに新しい必須プロパティを
   * 強制する破壊的変更になる。省略可能なら、値を持たない既存の組み立て方はそのまま
   * 型を満たす）。
   */
  validFrom?: Date | null;
  /** `validFrom` の doc コメント参照。対になる終点。 */
  validUntil?: Date | null;

  /**
   * Issue #371（(B) 第1段、ADR 0185 決定2・ADR 0315、`claim-key.ts` の doc コメント参照）:
   * 「この記憶は何についての主張か」を表す構造化された鍵。
   *
   * 🔴 **この鍵は LLM が作る ⟹ 推論である**（`docs/north-star.md` 問い4）。
   * `provenance`（ユーザーが言った事実か・AI の推論かを区別する既存の欄）とは**別の軸**
   * であり、この欄が非 `null` であること自体は `provenance.kind` に一切影響しない。
   * ⟹ **「事実」と「主張の分類」を混ぜないための、意図的に別の名前・別の欄である。**
   *
   * `subject`/`predicate` は `normalizeClaimKeyPart`（claim-key.ts）で正規化済みの値を
   * 想定する——読み出し側は「既に正規化されている」ことを前提にしてよい（書き込み側
   * ——`runtime.ts` の opt-in 経路——が正規化してから渡す契約）。
   *
   * ⛔ **この欄が埋まっていることは、検出（#372）が実行されたことを意味しない。**
   * この issue（#371）は鍵を持たせるだけで、同じ鍵を持つ2件を見つけて `contested` を
   * 立てる処理は一切実装しない（ADR 0185 決定4）。
   *
   * **省略可能な新規フィールドとして足した**（`decayBaseSeq` 等と同じ理由——`Memory` は
   * `@mnemora/core` の公開型。必須にすると、この型を自分でリテラルとして組み立てている
   * 既存の呼び出し元・adapter・テストのフィクスチャすべてに新しい必須プロパティを
   * 強制する破壊的変更になる）。`undefined`（未指定）と `null`（明示的に鍵なし）は
   * 同じ意味で扱ってよい——読み出し側はどちらも「鍵が無い」として扱うこと。
   *
   * ⚠ **主語か述語の片方だけのオブジェクト（型を破る入力）を、書き込みの口は拒まない**
   * （[Issue #1109](https://github.com/takecchi/mnemora/issues/1109)）。TypeScript を通さない
   * 呼び出しやキャストで `{ subject: "user" }` のような値を `MemoryStore.createMemory`・
   * `createMemoryWithOutbox` に渡すと、adapter によって持ち方が違う:
   * - `@mnemora/postgres`: 片方の列だけを入れた行を書き、読み出しでは**鍵なし（`null`）**として返す
   *   （`mapping.ts` の `rowToClaimKey`）。
   * - `@mnemora/testkit` の fixture: 片方だけのオブジェクトを**そのまま**持って返す。
   *
   * どちらでも、その Memory は `findActiveByClaimKey` に一致せず、`listActiveClaimPredicates` にも
   * 数えられない（PR #1106 で fixture を Postgres に揃えた）。**片方だけの `claimKey` は鍵なしとして
   * 扱われうる。**鍵を持たせたいなら、2欄とも埋めて渡すこと。
   *
   * ⚠ 2026-09-28 追記: **空文字の `subject`・`predicate`（`{ subject: "", predicate: "p" }` など）も、書き込みの口は
   * 拒まない。**`@mnemora/postgres` も testkit の fixture も、そのまま書いて、そのまま読み戻す（片方だけのときと違い、
   * Postgres も鍵なしにはしない）。返った Memory は `MemorySchema`（{@link ClaimKeySchema} は2欄とも `min(1)`）を通らない。
   */
  claimKey?: ClaimKey | null;

  /**
   * 強さ。値域は `(0, MAX_STRENGTH]`（ADR 0078）。
   *
   * ⚠ **`@mnemora/postgres` はこの値を float4（`real` 列）の精度に丸めて保存する**
   * （[Issue #1094](https://github.com/takecchi/mnemora/issues/1094)）。`@mnemora/testkit` の fixture は float64 のまま持つ。
   * `decayFloorAt` は、作成時は呼び出し側が渡した値（float64 で計算したもの）をどちらもそのまま
   * 保存するが、**強化（`reinforce`）の後は store が保存済みの `strength`・`halfLifeHours` で計算し直す**ので、
   * 強化後の `decayFloorAt` は実装によってずれうる。ずれは `halfLifeHours × log2(strength / 閾値)` の
   * 丸め誤差に比例し、半減期が長いほど大きく、向きも一定しない
   * （【実測】強化後の床の Postgres − testkit: 720 時間 0ms、123456.789 時間 +15.6秒、
   * 約100万時間 −約6分、約1000万時間 −約32分。`strength: 0.3`・720 時間は 0ms）。
   * 段2の減衰係数（`scoring.ts`）も、Postgres では丸めた値で計算される。
   * 列の型を変える案・書く前に丸める案は採らず、今の振る舞いを記録した（クローン miku の判断）。
   * `docs/memory-model.md` §7 の 2026-09-27 追記を参照。
   */
  strength: number;
  /**
   * 半減期（時間）。値域は `(0, ∞)` の有限の正の実数（ADR 0125）。
   *
   * ⚠ **`@mnemora/postgres` はこの値を float4（`real` 列）の精度に丸めて保存する**
   * （[Issue #1094](https://github.com/takecchi/mnemora/issues/1094)）。`@mnemora/testkit` の fixture は float64 のまま持つ。
   * `decayFloorAt` は、作成時は呼び出し側が渡した値（float64 で計算したもの）をどちらもそのまま
   * 保存するが、**強化（`reinforce`）の後は store が保存済みの `halfLifeHours`・`strength` で計算し直す**ので、
   * 強化後の `decayFloorAt` は実装によってずれうる。ずれは `halfLifeHours × log2(strength / 閾値)` の
   * 丸め誤差に比例し、半減期が長いほど大きく、向きも一定しない
   * （【実測】強化後の床の Postgres − testkit: 720 時間 0ms、123456.789 時間 +15.6秒、
   * 約100万時間 −約6分、約1000万時間 −約32分。`strength: 0.3`・720 時間は 0ms）。
   * 段2の減衰係数（`scoring.ts`）も、Postgres では丸めた値で計算される。
   * 列の型を変える案・書く前に丸める案は採らず、今の振る舞いを記録した（クローン miku の判断）。
   * `docs/memory-model.md` §7 の 2026-09-27 追記を参照。
   */
  halfLifeHours: number;
  /** 壁時計で、強さが忘却の閾値を下回る時刻（書き込み時・強化時に計算して保存する）。recall の忘却ゲート（既定で有効。`RecallQuery.includeFullyDecayed` で外せる）は、この時刻が「今」以前の Memory を除く。 */
  decayFloorAt: Date;

  /**
   * 活動時計（[ADR 0165](../../../docs/decisions/0165-decay-activity-clock.md)）の3つ組。
   * 壁時計の `recordedAt`/`lastReinforcedAt` → `decayFloorAt` → `halfLifeHours` と
   * **1対1に対応する**——`decayBaseSeq` は起点（書き込み時点の `tenant_activity.activity_seq`）、
   * `decayFloorSeq` は床（書き込み時に一度だけ計算する）、`halfLifeRecalls` は
   * Memory 単位の半減期（単位: そのテナントで `recall()` が起きた回数）。
   *
   * **すべて省略可能。**`undefined` も `null` も**「この軸には床が無い＝活動時計では
   * 沈まない」**を意味する（ADR 0165 決めたこと4）。`decay_clock` が `'wall'` のまま
   * 一度も `'activity'`/`'either'` に切り替えていないテナントでは、この3つは
   * 一度も書かれない。**後から切り替えても、`'wall'` の間に作られた記憶の3つ組は `null` のままで、
   * 活動時計では沈まない**（契約。ADR 0165 の 2026-09-28 追記2、Issue #1014）。
   *
   * **省略可能な新規フィールドとして足した**（`purgedAt`/`validFrom` と同じ理由——
   * `Memory` は `@mnemora/core` の公開型。必須にすると、この型を自分でリテラルとして
   * 組み立てている既存の呼び出し元・adapter・テストのフィクスチャ（40本以上）すべてに
   * 新しい必須プロパティを強制する破壊的変更になる）。
   */
  decayBaseSeq?: number | null;
  /** `decayBaseSeq` の doc コメント参照。活動時計の床。 */
  decayFloorSeq?: number | null;
  /** `decayBaseSeq` の doc コメント参照。活動時計での Memory 単位の半減期。 */
  halfLifeRecalls?: number | null;

  /** 埋め込みの状態（{@link EmbeddingStatus}）。 */
  embeddingStatus: EmbeddingStatus;

  /**
   * Issue #198（[ADR 0124](../../../docs/decisions/0124-purge-physical-delete.md)）:
   * 非 `null` なら `content`/`digest` は物理削除のトゥームストーンで上書き済み
   * （docs/memory-model.md §9・§11 行10）。`status` はこの操作で動かないため
   * （`purged` は `memories.status` の値ではない）、「purge されたか」は常にこの列で判定する。
   *
   * DB 列自体は `packages/postgres/migrations/0001_init.sql` に Phase 1 から存在するが、
   * `Memory`/`MemoryRow` にこのフィールドが無く一度も読み書きされていなかった
   * （`purge()` の書き手そのものが無かったため）。本 ADR がここに初めて配線する。
   *
   * **省略可能な既存フィールドとして足した**（`Memory` は `@mnemora/core` の公開型。
   * `purgedAt` を必須にすると、この型を自分でリテラルとして組み立てている既存の
   * 呼び出し元・adapter・テストのフィクスチャすべてに新しい必須プロパティを強制する
   * 破壊的変更になる。省略可能なら、値を持たない既存の組み立て方はそのまま型を満たす）。
   */
  purgedAt?: Date | null;

  /**
   * Issue #152（ADR 0312）: 呼び手が申告した任意属性（公開範囲・区分など）。
   *
   * **`tags`（上）と役割が違う**: `tags` は 100% LLM の推論、`attributes` は 100% 呼び手の
   * 申告——北極星の問い4（AI の推論とユーザーが言った事実を区別する）に沿って、抽出器は
   * この欄を一度も読み書きしない。`attributes.ts` の doc コメント参照。
   *
   * **作成経路ごとの引き継ぎ方（ADR 0312 決定4、詳細は同 ADR の表）**:
   * - 抽出（`buildNewMemoryFromCandidate`）: 観測（`Observation.attributes`）をそのまま
   *   継承する（フォールバック経路も含む）——「限定の出所から出た記憶は限定のまま」。
   * - 統合（`buildConsolidatedMemory`）・反芻（`buildReflectedMemory`）: 元の Memory
   *   **全件**に同じキー・同じ値で入っている分だけを残す（積集合）。1件でも欠けている・
   *   値が違うキーは落ちる——呼び手が申告していない値を、統合・反芻という推論の産物に
   *   持ち込まないため。
   *
   * **型としては省略可能だが、上記いずれの経路も runtime は常に `{}` 以上の値を書く**
   * （`Observation.attributes` の doc コメントと同じ runtime 保証、ADR 0289 の作法）。
   * `undefined` はこの型を自前で組み立てている既存の呼び出し元・テストのフィクスチャ
   * だけが持ちうる（省略可能にした理由は `purgedAt`/`validFrom` と同じ——`Memory` は
   * `@mnemora/core` の公開型であり、必須にすると既存の呼び出し元すべてに新しい必須
   * プロパティを強制する破壊的変更になる）。
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
 * `decayFloorAt` は `defaultDecayStrategy.floorAt(...)` を書き込み時に一度だけ呼んで
 * 得た値を渡すこと（docs/memory-model.md §7・ADR 0010）。
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

  // Issue #202（ADR 0145）: `Memory.validFrom`/`validUntil` の doc コメント参照。
  validFrom: z.date().nullable().optional(),
  validUntil: z.date().nullable().optional(),

  // Issue #371（ADR 0185/ADR 0315）: `Memory.claimKey` の doc コメント参照。
  claimKey: ClaimKeySchema.nullable().optional(),

  // ADR 0078: 値域は `(0, MAX_STRENGTH]`。
  // ⚠ **この schema は書き込み経路では走らない**——`MemorySchema` / `NewMemorySchema` を
  // `.parse()` している箇所はリポジトリに0件であり、型の導出元として使われている。
  // 実際に値域を強制するのは store の層（`packages/postgres` の CHECK 制約と、
  // in-memory 実装の検査）である。ここを締めるのは**公開された型の契約**としてであって、
  // これが防波堤なのではない。
  strength: z.number().gt(0).max(MAX_STRENGTH),
  // ADR 0125: 値域は `(0, ∞)`（有限の正の実数、`isHalfLifeHoursInRange` と同じ域）。
  // `z.number().positive()` は実測（zod v4、`safeParse`）で `0`・負・`NaN`・`±Infinity` を
  // 既にすべて拒んでいる——zod は NaN を `invalid_type`（"expected number, received nan"）
  // として扱うため、`.positive()` だけで境界を正しく塞げている。
  // ⚠ ただし ADR 0078 の実測3と同じ理由で、**この schema は書き込み経路では走らない**
  // （`MemorySchema` / `NewMemorySchema` を `.parse()` している箇所は0件）。
  // 実際に値域を強制するのは store の層（`packages/postgres` の CHECK 制約と、
  // in-memory 実装の `isHalfLifeHoursInRange` 検査）である。
  halfLifeHours: z.number().positive(),
  decayFloorAt: z.date(),

  // ADR 0165: 活動時計の3つ組。3つとも省略可能——`Memory.decayBaseSeq` の doc コメント参照。
  // ⚠ この schema は書き込み経路では走らない（上の halfLifeHours の doc コメントと同じ注記）。
  decayBaseSeq: z.number().nullable().optional(),
  decayFloorSeq: z.number().nullable().optional(),
  halfLifeRecalls: z.number().nullable().optional(),

  embeddingStatus: EmbeddingStatusSchema,

  // Issue #198（ADR 0124）: `Memory.purgedAt` の doc コメント参照。
  purgedAt: z.date().nullable().optional(),

  // Issue #152（ADR 0312）: `Memory.attributes` の doc コメント参照。格納側は検査をしない
  // schema を使う（`AttributesSchema` は `ObserveXxxInput`/`RecallQuery` 側専用）。
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
