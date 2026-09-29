import { z } from "zod";
import { isAbort, runAbortable } from "./abort.js";
import type { Ctx } from "./ctx.js";
// ⚠ `type` 専用の import にすること（値の import にしない）。`extraction.ts` は
// （`ExtractionContextSchema` 経由で）`observation.ts` を実行時に import しており、
// `memory.ts`/`observation.ts` はこのファイル（`claim-key.ts`）を実行時に import する
// （`ClaimKeySchema`/`ClaimKeyOptionsSchema`）。値の import にすると
// `claim-key.ts → extraction.ts → observation.ts → claim-key.ts` の実行時循環 import が
// できてしまう——`import type` は TypeScript の出力から完全に消えるため、この経路は
// 型だけの参照に留める（`describeClaimKeyFailure` は下で自前に複製する）。
import type { ExtractionFailure } from "./extraction.js";
import type { LLMProvider, PromptSpec } from "./interfaces/llm-provider.js";

/**
 * Issue #371（(B) 第1段、ADR 0185 決定2・ADR 0315）: 「この記憶は何についての主張か」を
 * 表す構造化された鍵。
 *
 * 🔴 **この鍵は LLM が作る ⟹ 推論である**（`docs/north-star.md` 問い4）。
 * `Memory.provenance`（ユーザーが言った事実か・AI の推論かを区別する既存の欄）とは
 * **別の軸**であり、`claimKey` が埋まっていること自体は、その Memory が
 * `provenanceKind: 'stated'`/`'inferred'` のどちらであるかに一切影響しない——
 * `stated` な Memory にも `claimKey` は付く（「ユーザーが『好きな食べ物はラーメン』と
 * 言った」という事実そのものは stated でも、「これは “好きな食べ物” という属性についての
 * 主張だ」という分類は LLM の推論である）。
 *
 * ⛔ **この型は検出（#372）を一切行わない。** 同じ鍵を持つ2件の Memory を見つけて
 * `contested` を立てる処理は、この issue の範囲外である（ADR 0185 決定4・本ファイルの
 * どこにも `contested`/`status` への言及が無いことがその実装上の証拠）。
 */
export const ClaimKeySchema = z.object({
  /** 主張の主語（例: `"user"`）。ADR 0315 §2 の実験に倣い、正規化済み文字列を想定する。 */
  subject: z.string().min(1),
  /** 主張の述語（属性名）。正規化済みの英語 snake_case を想定する（ADR 0315 決定3）。 */
  predicate: z.string().min(1),
});
/** 1件の Memory が何についての主張かを表す鍵（主語と述語）。形は {@link ClaimKeySchema}（上の doc）。 */
export type ClaimKey = z.infer<typeof ClaimKeySchema>;

/**
 * ADR 0315 決定3 の正規化規則: **NFKC 正規化 → 前後の空白除去 → 小文字化 →
 * 内部の連続空白を単一の `_` に畳む。**
 *
 * べき等（2回適用しても結果が変わらない）——`normalizeClaimKeyPart(normalizeClaimKeyPart(x))
 * === normalizeClaimKeyPart(x)` が常に成り立つ。これは、正規化済みの既知 predicate 一覧
 * （`knownPredicates`）をそのまま再度この関数に通しても壊れないことを保証するために
 * 意図的に選んだ性質であり、`__tests__/claim-key.test.ts` の歯で固定してある。
 *
 * ⚠ **これは統計的な言い換え統合（「好きな食べ物」/「好きな食物」を同じ鍵にする）を
 * 行わない。** その統合は LLM 自身が行う（ADR 0315 §3.2 の実測: バッチ内で常に100%
 * 統合された）。この関数が吸収するのは、同じ意味の文字列の**表記ゆれ**（全角/半角、
 * 大文字/小文字、空白の数や位置）だけである。
 */
export function normalizeClaimKeyPart(value: string): string {
  return value.normalize("NFKC").trim().toLowerCase().replace(/\s+/g, "_");
}

/** `subject`/`predicate` の両方に {@link normalizeClaimKeyPart} を適用する。 */
export function normalizeClaimKey(key: ClaimKey): ClaimKey {
  return {
    subject: normalizeClaimKeyPart(key.subject),
    predicate: normalizeClaimKeyPart(key.predicate),
  };
}

/**
 * 抽出プロンプト本文（`extraction.ts` の `EXTRACTION_PROMPT_SYSTEM_BASE`）とは
 * **完全に独立した別の system 文面**（ADR 0315 決定1・決定2）。この文字列を変えても
 * `extraction.ts` 側のカセット鍵（`llmCassetteKey`）は1バイトも動かない——両者は
 * 別の `PromptSpec` であり、抽出候補群を得た*後*にだけ呼ばれる別の構造化呼び出しに使う。
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

/**
 * ADR 0271 の `buildSubjectCandidateInstruction`（`extraction.ts`）と同型の語彙ヒント。
 * 独立した呼び出しであるため、抽出プロンプト本体の指示と混線しない
 * （ADR 0315 決定2 の表「語彙ヒントの使い回し」参照）。
 */
function buildKnownPredicateInstruction(knownPredicates: readonly string[]): string {
  return (
    ` 既知の predicate 候補一覧: ${knownPredicates.join(", ")}。` +
    "この一覧に当てはまる場合は必ずそのまま使い、どれにも当てはまらない場合だけ新しい predicate を作ってください。"
  );
}

/**
 * Issue #372 負債6（ADR 0324、Issue #691続き）: real-fixture 実測で、誤検出（30%）の
 * ほぼ全量が claim key の `subject` 誤帰属（三人称の発話の主語を `"user"` に誤って
 * 割り当てる）だと分かったことへの対処。`buildKnownPredicateInstruction` と同型の
 * 語彙ヒント——**候補から選ばせるだけ**であり、正規化強化・埋め込み類似度のような
 * 別の仕組みは持ち込まない（採らなかった案は ADR 0334 決定1参照）。
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
 * `knownPredicates`/`knownSubjects` を省略・空配列にすると、対応する語彙ヒントの文言は
 * 足されない（`buildExtractionPrompt` の `subjectCandidates` と同じ「空配列＝渡していない」
 * 規約）。**両方省略すれば `CLAIM_KEY_PROMPT_SYSTEM` と1バイトも違わない**——ADR 0334の
 * 「off のプロンプトは変えない」制約はこの関数のこの性質で保たれる。
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
   * `contents` と**同じ長さ・同じ順序**。要素ごとに鍵が取れなかった場合（LLM 呼び出し
   * そのものの失敗、または返った件数が入力と一致しなかった場合）は、対応する全要素が
   * `null` になる——**部分的な対応付けを推測ででっち上げない**（`AGENTS.md`「機械には
   * 検出まで」と同じ規律。長さが合わない時点で、どの鍵がどの候補に対応するかを機械的に
   * 決める方法が無い）。
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
 * `extraction.ts` の `describeExtractionFailure` と**意図的に同じロジックの複製**
 * （上の import コメント参照——循環 import を避けるため、共有関数にせずここに複製する）。
 * 挙動が食い違ったら片方のバグである。`__tests__/claim-key.test.ts` が
 * `extraction.ts` 側と同じ入力での出力一致を歯にしている（2026-09-28、Issue #1264 で置いた。それまでは
 * 1つの入力の `kind` だけを見ていた）。
 */
function describeClaimKeyFailure(error: unknown): ExtractionFailure {
  const rawKind = (error as { kind?: unknown } | null | undefined)?.kind;
  const kind = typeof rawKind === "string" && rawKind.length > 0 ? rawKind : null;
  const message = error instanceof Error ? error.message : String(error);
  return { kind, message };
}

/**
 * ADR 0315 決定2 の (ii) separate: 既存の抽出（`extraction.ts` の `extractCandidates`）が
 * 終わった**後**に、候補群の `content` をまとめて1回（バッチ）で問う別の構造化呼び出し。
 *
 * ⛔ **既定では呼ばれない。** この関数は `runtime.ts` の opt-in 経路（`ClaimKeyOptions.
 * enabled: true`）からしか呼ばれず、`extraction.ts`/`buildExtractionPrompt` を一切変更・
 * 経由しない——既存の抽出呼び出しのプロンプト・カセット鍵は無関係のまま残る。
 *
 * `contents.length === 0`（候補が0件）なら**呼び出しを一切行わない**（ADR 0315 決定2
 * 「候補が0件なら+0回にできる」）。
 *
 * ⚠ **2026-09-29 追記（[Issue #1200](https://github.com/takecchi/mnemora/issues/1200)、
 * [ADR 0359](../../../docs/decisions/0359-abort-signal-for-provider-calls.md)）: `signal` を
 * 渡し、それが abort されたことによる例外は `DeriveClaimKeysResult.failure` へ丸めず、
 * そのまま投げ直す。** `extractCandidates` と同じ理由——中断と「LLM 呼び出しが本当に
 * 失敗した」を同じ顔にしない。
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
      // ⚠ `ClaimKeySchema` の `min(1)` は空白だけの値（例: `" "`、全角スペース）を
      // 素通りする——`normalizeClaimKeyPart` の trim でそれらは空文字列に潰れる。
      // 正規化後に `subject`/`predicate` のどちらかが空文字列になった要素は、鍵が
      // 取れなかったものとして `null` にする（`DeriveClaimKeysResult.claimKeys` の
      // doc コメント「部分的な対応付けを推測ででっち上げない」と同じ規律の延長）。
      // `{ subject: "", predicate: "" }` のまま返すと、無関係な複数の Memory が
      // 同じ「空の鍵」で誤って一致し、`detectClaimKeyContested` が的外れに
      // `contested` を立ててしまう（実測、`__tests__/claim-key.test.ts`）。
      claimKeys: result.claims.map((claim) => {
        const normalized = normalizeClaimKey(claim);
        return normalized.subject === "" || normalized.predicate === "" ? null : normalized;
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
 * Issue #691 続き（`docs/decisions/0327-*.md`）: `ClaimKeyOptions.knownPredicatesFromStore`
 * を `true`（オブジェクト形を渡さない場合）にしたときに使う既定の上限。
 *
 * **根拠**（ADR 0329 決定2の逐語）: ADR 0315/0320/0324 の語彙ヒント実験はいずれも
 * 作業者が手で作った 5〜8 件の predicate で語彙ヒントの効果（安定性 74.1%→89.4%、
 * 検出の predicate 弁別も含めて100%一致）を確認している——**この定数は、その実験規模の
 * 2倍強を置くことで、実験で効果が確認された範囲を十分に覆いつつ、主題を持つ1人の
 * 会話が現実的に蓄積する claim key predicate の語彙が数十件規模に増えても
 * `deriveClaimKeys` の system プロンプトへ際限なく積み上がらないよう上限を切る、という
 * 判断である。**「実測でこの値が最適」という測定結果ではない——単体テスト
 * （`__tests__/runtime.test.ts` の「既定の上限」歯）で値を固定し、変えるときはその歯を
 * 直すことで変更が見える形にする（`AGENTS.md`「数を、道具と生成物に焼き込まない」——
 * この定数はどこか別の場所の写しではなく、ここが唯一の出所であるため対象外だが、
 * 値そのものの妥当性は歯で縛る）。
 */
export const DEFAULT_KNOWN_PREDICATES_FROM_STORE_LIMIT = 20;

/**
 * `runtime.observe`（Observe*Input）の opt-in 口（Issue #371、Issue #372、Issue #691続き）。
 *
 * - **渡さない（省略）**: 既定の挙動。`deriveClaimKeys` は一度も呼ばれず、抽出プロンプト・
 *   カセット鍵・呼び出し回数は1バイトも変わらない。**検出（`detectContested`）も
 *   もちろん動かない**——鍵が無ければ引くものが無い。
 * - **`{ enabled: true }`**: 抽出後、候補群に対して `deriveClaimKeys` を1回（バッチ）
 *   呼ぶ。`knownPredicates` を省略・空配列にすると語彙ヒント無しで呼ぶ。
 * - **`{ enabled: false }`**: 明示的に無効。省略と同じ挙動だが、呼び出し側が
 *   「このテナント/フローでは意図的に無効にしている」ことをコードで表せる。
 * - **`{ enabled: true, detectContested: true }`**（Issue #372、(B) 第2段。Issue #933
 *   案2・ADR 0378 で `status = 'contested'` の一致も数えるよう広がった）:
 *   鍵が付いた Memory を作った直後、**列と索引だけで**（LLM を一度も呼ばずに）
 *   同じ tenant・同じ subjectId・同じ claim key・有効期間が重なる・`contentHash` が違う
 *   他の `active`/`contested` Memory を探し、ちょうど1件、かつその1件が `active` なら
 *   `Runtime.markContested` を呼ぶ（`superseded` へは進めない）。その1件が既に
 *   `contested` だった場合・一致が2件以上の場合は `markContested` を呼ばず、状態を
 *   動かさずに evidence だけを積む（2026-09-30 の直し、ADR 0378 追記）。
 *   **`enabled: false`（または省略）と組み合わせても何も起きない**——鍵が無いので
 *   検出のしようがない（`runtime.ts` の `detectClaimKeyContested` 参照）。
 * - **`{ enabled: true, knownPredicatesFromStore: true }`**（Issue #691続き、ADR 0326
 *   「採らなかった案B」の実装、ADR 0329）: `deriveClaimKeys` を呼ぶ**前**に、
 *   `MemoryStore.listActiveClaimPredicates?`（任意メソッド）で「同じ tenant・同じ
 *   `subjectId`・`active`」な既存 Memory の predicate 一覧を新しい順に集め、呼び出し側の
 *   `knownPredicates`（渡していれば）の**後ろ**へ重複無く連結してから渡す
 *   （`runtime.ts` の `runExtraction` 参照。「利用者の分を先に」——利用者が明示的に
 *   選んだ語彙のほうを優先する）。**`enabled: false`/省略、または store がこの口を
 *   実装していない adapter では、静かに効かない**——`detectContested` と同じ「渡された
 *   が効かない」規約（`findActiveByClaimKey?` 系のフォールバック無し方針）。
 *   `{ limit: number }` で件数の上限を指定できる。省略すると
 *   {@link DEFAULT_KNOWN_PREDICATES_FROM_STORE_LIMIT} を使う。
 * - **`knownSubjects`**（Issue #372負債6、ADR 0334）: `knownPredicates` と同型の語彙
 *   ヒントを `subject` 側にも用意する。**呼び出し側が明示的に `claimKeyOptions.
 *   knownSubjects` を渡したときだけ効く**——`subjectCandidates`（Issue #608 項目②(b)、
 *   `runtime.observe` の同名引数）を渡していても、`knownSubjects` を省略すれば
 *   `deriveClaimKeys` の system プロンプトは1バイトも変わらない（`subjectCandidates`
 *   だけを渡す既存の呼び出し側の挙動・カセット鍵を動かさないため——ADR 0334 追記
 *   〔2026-09-26〕。`subjectCandidates` と同じ語彙をヒントに使いたい呼び出し側は、
 *   同じ配列を明示的に `knownSubjects` へも渡すこと）。**store から動的に集める版
 *   （predicate 側の `knownPredicatesFromStore` に対応するもの）は意図的に実装して
 *   いない**——ADR 0334 決定3が実測で示した「store が自己蓄積した曖昧な値
 *   （例: 'sibling'）を汎用語彙としてヒントに使うと、無関係な話題の主張にまでその値が
 *   誤って使い回される」という汚染を理由に見送った（採らなかった案、ADR 0334
 *   「採らなかった案」参照）。
 */
export interface ClaimKeyOptions {
  /** `true` なら抽出の後に `deriveClaimKeys` を呼んで鍵を付ける。`false` は省略と同じ（上の doc の一覧）。 */
  enabled: boolean;
  /**
   * {@link buildKnownPredicateInstruction} 参照。ADR 0271 の `subjectCandidates`
   * （`SubjectCandidatesInput = string[]`）と同型——**`readonly` を付けない**——
   * `ClaimKeyOptionsSchema` の `z.infer` と型を完全一致させるため
   * （`__tests__/schema-type-equals-parity.test.ts` の歯）。
   */
  knownPredicates?: string[];
  /**
   * Issue #372（(B) 第2段）: 鍵の衝突検出を opt-in で有効にする。**既定 `false`（省略と
   * 同じ）。** `enabled: true` と組み合わせたときだけ意味を持つ——`enabled` が
   * `false`/省略のままこれだけ `true` にしても、鍵が一度も埋まらないので検出は
   * 常に空振りする（`runtime.ts` の doc コメント参照。これはエラーにしない——
   * `knownPredicates` を `enabled: false` と組み合わせても無視されるのと同じ「渡された
   * が効かない」規約）。
   *
   * ⚠ **【2026-09-29 修正、ADR 0377】以前は、同じ発話の中の、時期だけが違う2文も
   * contested になっていた**（Issue #835）。例: 1回の `observe()` から「去年は札幌で
   * 働いていた。」「今年は福岡で働いている。」の2件が抽出されると、`deriveClaimKeys` は
   * 2件に同じ鍵（`user/work_location`）を付ける。「去年」「今年」は `validFrom`/
   * `validUntil` に入らないので有効期間が重なるとみなされ、`knownPredicatesFromStore`
   * の語彙ヒントより前の、既定の claim key のプロンプトの性質でこの対が生まれていた
   * （ADR 0326 (d)、ADR 0329 の負債1の追記）。【実測 2026-09-28、修正前】記録の再生
   * （`answer.claim-key.known-predicates-{1,2,3}.json`）でも、実 API（gpt-4o-mini、
   * n=3）でも、6回とも contested が成立していた。
   *
   * **今は、この対は contested にならない。** `Runtime.detectClaimKeyContested`
   * （`runtime.ts`）が、同じ observation（＝同じ発話）から抽出された兄弟どうしを、
   * 一致件数を数える前に除くようになった（ADR 0347・PR #1318 が抽出の書き込みを
   * 「全件書く→全件について検出」の2ループへ分けた副作用として、兄弟が互いの検出時点で
   * 既に `active` になっていたことが原因。詳細・実測は
   * [ADR 0377](../../../docs/decisions/0377-claim-key-contested-detection-excludes-same-observation-siblings.md)）。
   * ⚠ **この直しは損失も伴う**——1つの発話の中の言い直し（「金曜じゃなくて水曜」のような、
   * 抽出で2件に分かれてしまう言い直し）も、同じ理由で今後は互いに contested にならない
   * （ADR 0377「失うもの」）。**別の observation（別ターン）どうしの対（訂正の典型形）は
   * 今までどおり contested になる**——`negation-moved-city`・`schedule-change-deadline`
   * 等（ADR 0329 の測定ケース）を見ること。
   */
  detectContested?: boolean;
  /**
   * Issue #691続き（ADR 0329）: `MemoryStore.listActiveClaimPredicates?` から集めた
   * predicate 一覧を、`knownPredicates` の語彙ヒントへ動的に足す。**既定 `false`
   * （省略と同じ）。** `true` を渡すと {@link DEFAULT_KNOWN_PREDICATES_FROM_STORE_LIMIT}
   * 件まで、`{ limit: number }` を渡すとその件数まで集める。`enabled: false`/省略、
   * または store がこの口を実装していない adapter では静かに効かない（上のクラス doc
   * コメント参照）。
   *
   * ⚠ **誤検出が増える**（今の振る舞い、ADR 0329 の負債1、Issue #835）。語彙が少なく、その中に
   * 話題の近い曖昧な predicate があると、無関係な発話にもその predicate がそのまま使われる。
   * 例: 「新しい趣味を始めようと思っている」の後の「旅行の計画を立てている」「相談したいことが
   * ある」が、同じ `user/new_hobby_intent` などに寄せられる。`detectContested: true` と組むと、
   * その対は訂正ではないのに contested になり、Issue #832（ADR 0335）以降は回答プロンプトの
   * `[矛盾候補:]` まで届く。語彙ヒントの文言を変えて塞ぐ試みは、どれも訂正の取りこぼしか
   * 別の誤検出を招いた（ADR 0329 の負債1の追記「否定的結果」、Issue #835）。**この誤検出
   * （語彙の吸い寄せ、別 observation どうし）は塞いでいない**——語彙ヒントに下限を置く案
   * （issue #835 のコメント）も、訂正を助けている場面と誤検出の場面を語彙の数で分けられず
   * 見送った（ADR 0377「効かないもの」）。
   * 【実測 2026-09-28、修正前】`{ enabled: true, detectContested: true, knownPredicatesFromStore: true }`、
   * 訂正4件と誤検出2件（`unknown-favorite-number`・`other-period-city-this-year`）:
   *
   * | 回し方 | 訂正の contested | 誤検出の contested |
   * |---|---|---|
   * | 記録の再生（`answer.claim-key.known-predicates-{1,2,3}.json`） | 4/4 ×3 | 2/2 ×3 |
   * | 実 API（gpt-4o-mini、n=3） | 4/4 ×3 | 2/2 ×3 |
   *
   * 再生の3回目と実 API の2回は、同じ会話の filler どうしの対も余分に contested になった。
   * 上の表の誤検出2件のうち、**`other-period-city-this-year`（時期だけが違う2文、同じ
   * observation）は 2026-09-29 に直った**（`detectContested` の doc、ADR 0377）——
   * `knownPredicatesFromStore` を経由しない既定の claim key プロンプトの性質で起きていた
   * ため、この欄（`knownPredicatesFromStore`）自体の変更ではない。**`unknown-favorite-number`
   * （語彙の吸い寄せ、別 observation）は直っていない**——上の段落のとおり残っている。
   * 【実測 2026-09-29、修正後】記録の再生（同じ種カセット、seed 1〜3）で、訂正4/4 ×3・
   * 誤検出は `unknown-favorite-number` の1/2 ×3 のみ（`other-period-city-this-year` は
   * 0/2 ×3）——ADR 0377 の「陽性対照」節に実測の詳細がある。
   */
  knownPredicatesFromStore?: boolean | { limit?: number };
  /**
   * Issue #372負債6（ADR 0324「real-fixture 実測で、誤検出（30%）のほぼ全量が claim key
   * の `subject` 誤帰属だと分かった」、ADR 0334）: `knownPredicates` と同型の語彙ヒントを
   * `subject` 側にも用意する。呼び出し側が明示的に渡す一覧——**`knownPredicates` と同じ
   * `readonly` を付けない規約**（`ClaimKeyOptionsSchema` の `z.infer` と型を完全一致させる
   * ため）。**省略・空配列＝渡していないと同じで、`subjectCandidates` への暗黙の転用は
   * 行わない**（ADR 0334 追記〔2026-09-26〕——`subjectCandidates` と同じ語彙をヒントに
   * 使いたい呼び出し側は、同じ配列をここへも明示的に渡すこと）。
   */
  knownSubjects?: string[];
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
