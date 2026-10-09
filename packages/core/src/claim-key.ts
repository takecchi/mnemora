import { z } from "zod";
import { isAbort, runAbortable } from "./abort.js";
import type { Ctx } from "./ctx.js";
// `type` 専用の import にすること（値の import にしない）。`extraction.ts` は `observation.ts` を実行時に import し、
// `memory.ts`/`observation.ts` はこのファイルを実行時に import するので、値の import にすると
// `claim-key.ts → extraction.ts → observation.ts → claim-key.ts` の実行時循環ができる
// （`describeClaimKeyFailure` を下で自前に複製しているのもこのため）。
import type { ExtractionFailure } from "./extraction.js";
import { containsNul } from "./llm-aux-fields.js";
import type { LLMProvider, PromptSpec } from "./interfaces/llm-provider.js";

/**
 * 「この記憶は何についての主張か」を表す構造化された鍵（ADR 0185・ADR 0315）。
 *
 * **この鍵は LLM が作る ⟹ 推論である**（`docs/north-star.md` 問い4）。`Memory.provenance` とは**別の軸**で、
 * `claimKey` が埋まっていること自体は、その Memory が `provenanceKind: 'stated'`/`'inferred'` のどちらかに
 * 影響しない（`stated` な Memory にも `claimKey` は付く。「これは “好きな食べ物” という属性についての主張だ」という
 * 分類は LLM の推論であるため）。
 *
 * **この型は検出を一切行わない。**同じ鍵を持つ2件の Memory を見つけて `contested` を立てる処理は範囲外（ADR 0185）。
 */
export const ClaimKeySchema = z.object({
  /** 主張の主語（例: `"user"`）。正規化済み文字列を想定する。 */
  subject: z.string().min(1),
  /** 主張の述語（属性名）。正規化済みの英語 snake_case を想定する（ADR 0315）。 */
  predicate: z.string().min(1),
});
/** 1件の Memory が何についての主張かを表す鍵（主語と述語）。形は {@link ClaimKeySchema}。 */
export type ClaimKey = z.infer<typeof ClaimKeySchema>;

/**
 * ADR 0315 の正規化規則: **NFKC 正規化 → 前後の空白除去 → 小文字化 → 内部の連続空白を単一の `_` に畳む。**
 *
 * べき等（`normalizeClaimKeyPart(normalizeClaimKeyPart(x)) === normalizeClaimKeyPart(x)`）が、ほとんどの入力で
 * 成り立つ。正規化済みの既知 predicate 一覧（`knownPredicates`）をそのまま再度通しても壊れないようにするための性質。
 *
 * ⚠ **例外（ADR 0474）: 「大文字 + 結合文字」の入力の一部では、1回目と2回目の結果が変わる。**小文字化が NFKC の
 * あとに走るので、小文字化で結合文字が付いたままの分解形になり、2回目の NFKC が合成形に替える
 * （`Α` + U+0342 は 1回目が `α` + U+0342、2回目が `ᾶ`。ラテン文字の `H` + U+0331・`J` + U+030C・`T` + U+0308 なども。
 * 組の一覧と数は ADR 0474）。**直していない**: 直すと、すでに保存された鍵（分解形）と新しく作る鍵（合成形）が
 * 食い違い、contested の検出がその主張を同じとは見なさなくなるため。
 *
 * ⚠ **統計的な言い換え統合（「好きな食べ物」/「好きな食物」を同じ鍵にする）は行わない。**それは LLM 自身が行う
 * （ADR 0315）。この関数が吸収するのは、同じ意味の文字列の**表記ゆれ**（全角/半角、大文字/小文字、空白の数や位置）だけ。
 */
export function normalizeClaimKeyPart(value: string): string {
  return value.normalize("NFKC").trim().toLowerCase().replace(/\s+/g, "_");
}

/**
 * 正規化のあとの `subject`・`predicate` の長さの上限（**コードポイント**の数。ADR 0433）。
 * これを超えた要素を含む鍵は、`deriveClaimKeys` が `null` にする。
 *
 * Postgres の `idx_memories_claim_key`（btree）は1行 2704 バイトを超えると INSERT が落ちる。UTF-8 で1コードポイントは
 * 最大4バイトなので、256 字 × 4 バイト × 2（subject と predicate）= 2048 バイト、残り 656 バイトを
 * `tenant_id`・`subject_id`・行の見出しに残す。数え方は `Array.from`（UTF-16 の単位ではなくコードポイント）。
 */
const MAX_CLAIM_KEY_PART_CODE_POINTS = 256;

function exceedsClaimKeyPartLimit(value: string): boolean {
  // UTF-16 の単位数はコードポイント数以上なので、これ以下なら数えるまでもなく上限内。
  if (value.length <= MAX_CLAIM_KEY_PART_CODE_POINTS) {
    return false;
  }
  return Array.from(value).length > MAX_CLAIM_KEY_PART_CODE_POINTS;
}

/** `subject`/`predicate` の両方に {@link normalizeClaimKeyPart} を適用する。 */
export function normalizeClaimKey(key: ClaimKey): ClaimKey {
  return {
    subject: normalizeClaimKeyPart(key.subject),
    predicate: normalizeClaimKeyPart(key.predicate),
  };
}

/**
 * 抽出プロンプト本文（`extraction.ts` の `EXTRACTION_PROMPT_SYSTEM_BASE`）とは**完全に独立した別の system 文面**
 * （ADR 0315）。この文字列を変えても `extraction.ts` 側のカセット鍵（`llmCassetteKey`）は動かない。
 */
const CLAIM_KEY_PROMPT_SYSTEM =
  "あなたは、複数の記憶候補それぞれが「何についての主張か」を判定するアシスタントです。" +
  "入力は記憶候補の配列であり、各要素の content がその記憶の本文です。" +
  "各記憶候補について、その記憶が何についての主張かを表す claim key（subject と predicate の組）を" +
  "1つずつ、入力と同じ順序・同じ件数で返してください。" +
  "subject は主張の主語（例: 'user'）、predicate は属性名を表す正規化済みの英語 snake_case 文字列" +
  "（例: 'favorite_food'）です。同じ主題・属性について複数回言及されている記憶には、" +
  "値や表現が違っていても同じ subject と predicate を返してください（言い換えを統合すること）。" +
  "無関係な主題の記憶には異なる predicate を割り当ててください。";

/** `buildSubjectCandidateInstruction`（`extraction.ts`）と同型の語彙ヒント。独立した呼び出しなので、抽出プロンプト本体の指示と混線しない（ADR 0315）。 */
function buildKnownPredicateInstruction(knownPredicates: readonly string[]): string {
  return (
    ` 既知の predicate 候補一覧: ${knownPredicates.join(", ")}。` +
    "この一覧に当てはまる場合は必ずそのまま使い、どれにも当てはまらない場合だけ新しい predicate を作ってください。"
  );
}

/**
 * `buildKnownPredicateInstruction` と同型の語彙ヒント。誤検出のほぼ全量が claim key の `subject` 誤帰属
 * （三人称の発話の主語を `"user"` に誤って割り当てる）だったことへの対処で、**候補から選ばせるだけ**にする
 * （正規化強化・埋め込み類似度のような別の仕組みは持ち込まない。ADR 0334）。
 */
function buildKnownSubjectInstruction(knownSubjects: readonly string[]): string {
  return (
    ` 既知の subject 候補一覧: ${knownSubjects.join(", ")}。` +
    "この一覧に当てはまる場合は必ずそのまま使い、どれにも当てはまらない場合だけ新しい subject を作ってください。" +
    "発話の主語が本人（発話者）以外の第三者（家族・同僚など）である場合は、'user' ではなく" +
    "その第三者を指す subject を使ってください。"
  );
}

/**
 * `deriveClaimKeys` が投げる別の構造化呼び出しのプロンプトを組み立てる。
 *
 * `knownPredicates`/`knownSubjects` を省略・空配列にすると、対応する語彙ヒントの文言は足されない
 * （`buildExtractionPrompt` の `subjectCandidates` と同じ「空配列＝渡していない」規約）。**両方省略すれば
 * `CLAIM_KEY_PROMPT_SYSTEM` と1バイトも違わない**（ADR 0334 の「off のプロンプトは変えない」制約）。
 */
export function buildClaimKeyPrompt(
  contents: readonly string[],
  knownPredicates?: readonly string[],
  knownSubjects?: readonly string[],
): PromptSpec {
  const hasKnownPredicates = knownPredicates !== undefined && knownPredicates.length > 0;
  const hasKnownSubjects = knownSubjects !== undefined && knownSubjects.length > 0;
  let system = CLAIM_KEY_PROMPT_SYSTEM;
  if (hasKnownPredicates) {
    system += buildKnownPredicateInstruction(knownPredicates);
  }
  if (hasKnownSubjects) {
    system += buildKnownSubjectInstruction(knownSubjects);
  }
  return {
    system,
    messages: [
      {
        role: "user",
        content: JSON.stringify({ memories: contents.map((content) => ({ content })) }),
      },
    ],
  };
}

/** `deriveClaimKeys` が LLM に返させる値の zod スキーマ（`claims` は入力の Memory と同じ順の鍵の配列）。 */
export const ClaimKeyBatchResultSchema = z.object({
  claims: z.array(ClaimKeySchema),
});
/** {@link ClaimKeyBatchResultSchema} の型。 */
export type ClaimKeyBatchResult = z.infer<typeof ClaimKeyBatchResultSchema>;

/** `deriveClaimKeys` の戻り値。 */
export interface DeriveClaimKeysResult {
  /**
   * `contents` と**同じ長さ・同じ順序**。要素ごとに鍵が取れなかった場合（LLM 呼び出しそのものの失敗、または返った件数が
   * 入力と一致しなかった場合）は、対応する全要素が `null` になる。**部分的な対応付けを推測ででっち上げない**
   * （長さが合わない時点で、どの鍵がどの候補に対応するかを機械的に決める方法が無い）。
   *
   * 要素単位でも `null` になる: 正規化のあとで `subject`・`predicate` のどちらかが空文字列になったとき、長さが上限
   * （コードポイントの数。`MAX_CLAIM_KEY_PART_CODE_POINTS`、ADR 0433）を超えたとき、NUL（U+0000）を含むとき（ADR 0443）。
   * 長さの上限は Postgres の索引の1行の上限を超えて INSERT が落ちるのを防ぎ、NUL は text 列に入らず INSERT が落ちるのを
   * 防ぐ。いずれも印（`failure`）は付かない。
   */
  claimKeys: (ClaimKey | null)[];
  /**
   * 呼び出しが失敗した理由。**成功経路（0件を含む）は必ず `null`。**
   * `extraction.ts` の `ExtractCandidatesResult.failure` と同じ形。
   */
  failure: ExtractionFailure | null;
}

const EMPTY_RESULT: DeriveClaimKeysResult = { claimKeys: [], failure: null };

/**
 * `extraction.ts` の `describeExtractionFailure` と**意図的に同じロジックの複製**（上の import のコメント参照。循環 import を
 * 避けるため共有関数にしない）。挙動が食い違ったら片方のバグである。
 */
function describeClaimKeyFailure(error: unknown): ExtractionFailure {
  const rawKind = (error as { kind?: unknown } | null | undefined)?.kind;
  const kind = typeof rawKind === "string" && rawKind.length > 0 ? rawKind : null;
  const message = error instanceof Error ? error.message : String(error);
  return { kind, message };
}

/**
 * 既存の抽出（`extractCandidates`）が終わった**後**に、候補群の `content` をまとめて1回（バッチ）で問う別の構造化呼び出し
 * （ADR 0315）。
 *
 * **既定では呼ばれない。**`runtime.ts` の opt-in 経路（`ClaimKeyOptions.enabled: true`）からしか呼ばれず、
 * `extraction.ts`/`buildExtractionPrompt` を一切変更・経由しない。`contents.length === 0` なら**呼び出しを一切行わない**。
 *
 * **`signal` を渡し、それが abort されたことによる例外は `DeriveClaimKeysResult.failure` へ丸めず、そのまま投げ直す**
 * （[ADR 0359](../../../docs/decisions/0359-abort-signal-for-provider-calls.md)）。中断と「LLM 呼び出しが本当に失敗した」を
 * 同じ顔にしない（`extractCandidates` と同じ）。
 */
export async function deriveClaimKeys(
  llmProvider: LLMProvider,
  ctx: Ctx,
  contents: readonly string[],
  knownPredicates?: readonly string[],
  knownSubjects?: readonly string[],
  signal?: AbortSignal,
): Promise<DeriveClaimKeysResult> {
  if (contents.length === 0) {
    return EMPTY_RESULT;
  }
  try {
    const result = await runAbortable(signal, (raced) =>
      llmProvider.completeStructured(
        ctx,
        {
          prompt: buildClaimKeyPrompt(contents, knownPredicates, knownSubjects),
          schema: ClaimKeyBatchResultSchema,
        },
        { signal: raced },
      ),
    );
    if (result.claims.length !== contents.length) {
      return {
        claimKeys: contents.map(() => null),
        failure: {
          kind: "claim_key_length_mismatch",
          message:
            `deriveClaimKeys: expected ${contents.length} claim keys, ` +
            `got ${result.claims.length}`,
        },
      };
    }
    return {
      // `ClaimKeySchema` の `min(1)` は空白だけの値（`" "`、全角スペース）を素通りし、`normalizeClaimKeyPart` の trim で空文字列に潰れる。
      // 正規化後に `subject`/`predicate` のどちらかが空文字列になった要素は、鍵が取れなかったものとして `null` にする
      // （`{ subject: "", predicate: "" }` のまま返すと、無関係な複数の Memory が同じ「空の鍵」で誤って一致し、
      // `detectClaimKeyContested` が的外れに `contested` を立てる）。
      //
      // 長さが上限（{@link MAX_CLAIM_KEY_PART_CODE_POINTS}、ADR 0433）を超えた要素も同じ形で `null` にする。索引の1行の
      // 上限を超える値は INSERT を落とし、observation だけが残って memory が 0 件になるため。印（`failure`）は付けない。
      claimKeys: result.claims.map((claim) => {
        const normalized = normalizeClaimKey(claim);
        return normalized.subject === "" ||
          normalized.predicate === "" ||
          exceedsClaimKeyPartLimit(normalized.subject) ||
          exceedsClaimKeyPartLimit(normalized.predicate) ||
          // NUL を含む要素も同じ形で `null` にする（text 列に入らず INSERT が落ちる。ADR 0443）。
          containsNul(normalized.subject) ||
          containsNul(normalized.predicate)
          ? null
          : normalized;
      }),
      failure: null,
    };
  } catch (error) {
    if (isAbort(signal)) {
      throw error;
    }
    return {
      claimKeys: contents.map(() => null),
      failure: describeClaimKeyFailure(error),
    };
  }
}

/**
 * `ClaimKeyOptions.knownPredicatesFromStore` を `true`（オブジェクト形を渡さない場合）にしたときに使う既定の上限
 * （ADR 0329）。
 *
 * **「実測でこの値が最適」という測定結果ではない。**語彙ヒント実験の規模を上回り、かつ主題を持つ1人の会話が現実的に
 * 蓄積する predicate が増えても `deriveClaimKeys` の system プロンプトへ際限なく積み上がらないよう上限を切った判断。
 * 単体テストで値を固定してあり、変えるときはその歯を直すことで変更が見える形にする。
 */
export const DEFAULT_KNOWN_PREDICATES_FROM_STORE_LIMIT = 20;

/**
 * `runtime.observe`（Observe*Input）の opt-in 口。
 *
 * - **渡さない（省略）**: 既定の挙動。`deriveClaimKeys` は一度も呼ばれず、抽出プロンプト・カセット鍵・呼び出し回数は
 *   変わらない。**検出（`detectContested`）ももちろん動かない**（鍵が無ければ引くものが無い）。
 * - **`{ enabled: true }`**: 抽出後、候補群に対して `deriveClaimKeys` を1回（バッチ）呼ぶ。`knownPredicates` を省略・
 *   空配列にすると語彙ヒント無しで呼ぶ。
 * - **`{ enabled: false }`**: 明示的に無効。省略と同じ挙動だが、意図的に無効にしていることをコードで表せる。
 * - **`{ enabled: true, detectContested: true }`**（ADR 0378 で `status = 'contested'` の一致も数えるよう広がった）:
 *   鍵が付いた Memory を作った直後、**列と索引だけで**（LLM を一度も呼ばずに）同じ tenant・同じ subjectId・同じ
 *   claim key・有効期間が重なる・`contentHash` が違う他の `active`/`contested` Memory を探し、ちょうど1件、かつその1件が
 *   `active` なら `Runtime.markContested` を呼ぶ（`superseded` へは進めない）。その1件が既に `contested` だった場合・
 *   一致が2件以上の場合は `markContested` を呼ばず、状態を動かさずに evidence だけを積む。
 *   **`enabled: false`（または省略）と組み合わせても何も起きない**（`runtime.ts` の `detectClaimKeyContested` 参照）。
 * - **`{ enabled: true, knownPredicatesFromStore: true }`**（ADR 0329）: `deriveClaimKeys` を呼ぶ**前**に、
 *   `MemoryStore.listActiveClaimPredicates?`（任意メソッド）で「同じ tenant・同じ `subjectId`・`active`」な既存 Memory の
 *   predicate 一覧を新しい順に集め、呼び出し側の `knownPredicates`（渡していれば）の**後ろ**へ重複無く連結してから渡す
 *   （利用者が明示的に選んだ語彙を優先する）。**`enabled: false`/省略、または store がこの口を実装していない adapter では、
 *   静かに効かない**（`detectContested` と同じ「渡されたが効かない」規約）。`{ limit: number }` で件数の上限を指定でき、
 *   省略すると {@link DEFAULT_KNOWN_PREDICATES_FROM_STORE_LIMIT} を使う。
 * - **`knownSubjects`**（ADR 0334）: `knownPredicates` と同型の語彙ヒントを `subject` 側にも用意する。**呼び出し側が
 *   明示的に `knownSubjects` を渡したときだけ効く**。`subjectCandidates` を渡していても、`knownSubjects` を省略すれば
 *   `deriveClaimKeys` の system プロンプトは変わらない（`subjectCandidates` だけを渡す既存の呼び出し側の挙動・カセット鍵を
 *   動かさないため）。同じ語彙をヒントに使いたい呼び出し側は、同じ配列を `knownSubjects` へも明示的に渡すこと。
 *   **store から動的に集める版は意図的に実装していない**: store が自己蓄積した曖昧な値（例: 'sibling'）を汎用語彙として
 *   ヒントに使うと、無関係な話題の主張にまでその値が誤って使い回される（ADR 0334 決定3）。
 */
export interface ClaimKeyOptions {
  /** `true` なら抽出の後に `deriveClaimKeys` を呼んで鍵を付ける。`false` は省略と同じ（上の doc の一覧）。 */
  enabled: boolean;
  /**
   * {@link buildKnownPredicateInstruction} 参照。`subjectCandidates`（`SubjectCandidatesInput = string[]`）と同型で、
   * **`readonly` を付けない**（`ClaimKeyOptionsSchema` の `z.infer` と型を完全一致させるため。
   * `__tests__/schema-type-equals-parity.test.ts` が検査する）。
   */
  knownPredicates?: string[] | undefined;
  /**
   * 鍵の衝突検出を opt-in で有効にする。**既定 `false`（省略と同じ）。**`enabled: true` と組み合わせたときだけ意味を持つ
   * （`enabled` が `false`/省略のままこれだけ `true` にしても、鍵が一度も埋まらないので検出は常に空振りする。
   * エラーにはしない。`knownPredicates` を `enabled: false` と組み合わせても無視されるのと同じ規約）。
   *
   * ⚠ **同じ発話の中の兄弟は contested にならない**（ADR 0377）。1回の `observe()` から「去年は札幌で働いていた。」
   * 「今年は福岡で働いている。」の2件が抽出され同じ鍵が付いても、`Runtime.detectClaimKeyContested` は同じ observation から
   * 抽出された兄弟を、一致件数を数える前に除く。
   * ⚠ **この除外は損失も伴う**: 1つの発話の中の言い直し（「金曜じゃなくて水曜」のような、抽出で2件に分かれてしまう言い直し）も
   * 互いに contested にならない（ADR 0377「失うもの」）。**別の observation（別ターン）どうしの対（訂正の典型形）は
   * contested になる。**
   *
   * ⚠ **同じ向きは、訂正ではない正しい 2 主張にも働く**（ADR 0491）。別々の observation に分かれた、**相対的な期間だけが違う**
   * 正しい 2 主張（ある日の「去年は札幌で働いていた」と、別の日の「今年は福岡で働いている」）も contested になる。
   * 「去年」「今年」のような相対的な期間はどちらの抽出でも `validFrom`/`validUntil` に入らず（どちらも null）、有効期間の
   * 重なり判定（ADR 0324）が「重なる」と答えるため。直し方（抽出で相対時期を `validFrom`/`validUntil` に入れる、既定の
   * claim key のプロンプトに「期間が違う主張は別の predicate にする」を足す）は、どちらも既定の経路の文言を変え（誤った
   * 期間が本物の訂正を弾きうる／「言い換えを統合する」指示と衝突して訂正を取りこぼしうる）、**オーナーの判断待ち**である。
   * 今の振る舞いは `__tests__/claim-key-relative-period-across-observations.test.ts` が縛っている。呼び出し側は、
   * `observe()` に期間（`validFrom`/`validUntil`）を明示すれば、重ならない対は contested にならない。
   *
   * ⚠ **`knownPredicatesFromStore: true` と組むと、別々の発話どうしが語彙ヒントに吸い寄せられて
   * 同じ predicate になり、訂正ではない対も contested になる**。
   * その対にも `RecalledMemory.contestedWith` が付き、`examples/chat` の回答プロンプトでは訂正と
   * 同じ「訂正の可能性」の印で届く。測定値と条件は ADR 0335 の追記（2026-10-07、Issue #835）を見ること。
   */
  detectContested?: boolean | undefined;
  /**
   * `MemoryStore.listActiveClaimPredicates?` から集めた predicate 一覧を、`knownPredicates` の語彙ヒントへ動的に足す
   * （ADR 0329）。**既定 `false`（省略と同じ）。**`true` を渡すと {@link DEFAULT_KNOWN_PREDICATES_FROM_STORE_LIMIT} 件まで、
   * `{ limit: number }` を渡すとその件数まで集める。`enabled: false`/省略、または store がこの口を実装していない adapter では
   * 静かに効かない（上のクラス doc 参照）。
   *
   * ⚠ **誤検出が増える**（ADR 0329）。語彙が少なく、その中に話題の近い曖昧な predicate があると、無関係な発話にもその
   * predicate がそのまま使われる（例: 「新しい趣味を始めようと思っている」の後の「旅行の計画を立てている」が同じ
   * `user/new_hobby_intent` に寄せられる）。`detectContested: true` と組むと、その対は訂正ではないのに contested になり、
   * 回答プロンプトの `[矛盾候補:]` まで届く。**この誤検出（語彙の吸い寄せ、別 observation どうし）は塞いでいない**。
   * 語彙ヒントの文言を変えて塞ぐ試みは、どれも訂正の取りこぼしか別の誤検出を招き、語彙ヒントに下限を置く案も、訂正を
   * 助けている場面と誤検出の場面を語彙の数で分けられず見送った（ADR 0377「効かないもの」）。
   * 今の振る舞いは `__tests__/claim-key-known-predicates-cross-observation-contested.test.ts` が縛っている。
   *
   * ⚠ **既知の限界**: 語彙ヒントに吸い寄せられて、無関係な発話どうしが同じ predicate になり、
   * contested になることがある。その対にも `RecalledMemory.contestedWith` が付き、訂正と区別されずに
   * 「訂正の可能性」の印が付く。詳しくは ADR 0335 の追記（2026-10-07、Issue #835）を見ること。
   */
  knownPredicatesFromStore?: boolean | { limit?: number | undefined } | undefined;
  /**
   * `knownPredicates` と同型の語彙ヒントを `subject` 側にも用意する（ADR 0334）。呼び出し側が明示的に渡す一覧で、
   * `knownPredicates` と同じく **`readonly` を付けない**（`ClaimKeyOptionsSchema` の `z.infer` と型を完全一致させるため）。
   * **省略・空配列＝渡していないと同じで、`subjectCandidates` への暗黙の転用は行わない**（同じ語彙をヒントに使いたい
   * 呼び出し側は、同じ配列をここへも明示的に渡すこと）。
   */
  knownSubjects?: string[] | undefined;
}

/** `ClaimKeyOptions` の zod スキーマ。値を実行時に検査するときに使う（型 `ClaimKeyOptions` と揃えてある）。 */
export const ClaimKeyOptionsSchema = z.object({
  enabled: z.boolean(),
  knownPredicates: z.array(z.string().min(1)).optional(),
  detectContested: z.boolean().optional(),
  knownPredicatesFromStore: z
    .union([z.boolean(), z.object({ limit: z.number().int().positive().optional() })])
    .optional(),
  knownSubjects: z.array(z.string().min(1)).optional(),
}) satisfies z.ZodType<ClaimKeyOptions>;
