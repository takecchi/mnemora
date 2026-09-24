import type { Ctx, PromptSpec, Runtime } from "@mnemora/core";
import type { AnswerCase, AnswerVerdict } from "./answer-case.js";
import { gradeAnswer } from "./answer-case.js";
import type { CountingEmbeddingProvider, CountingLLMProvider } from "./answer-bench.js";
import { runAnswerCase } from "./answer-bench.js";
import type { AnswerJudgement } from "./answer-judge.js";
import { judgeAnswer } from "./answer-judge.js";

/**
 * Issue #498 完了条件4・「回答評価」側の陽性対照（ADR 0236 が未達のまま残した半分）。
 *
 * ADR 0236（PR #523）は「内容保持」（層2、`buildMnemoraPrompt` の出力から答えの語が
 * 消えること）だけを fake `MemoryStore` を使う純粋な単体試験で満たし、「回答評価」
 * （層3、`gradeAnswer`/judge が実際に赤くなること）は**実 API での記録の追加を要する**
 * として未達のまま残した。
 *
 * このモジュールは、その残り1本のための**変異の定義を1箇所に集約する**。
 * `cli.ts` の `recordAnswer`（記録側。下の {@link recordRetentionMutationPositiveControl}
 * を呼ぶ）と `__tests__/answer-retention-positive-control.postgres.test.ts`（再生側）の
 * **両方がこの同じ関数を呼ぶ**——変異のロジックを2箇所に書き写すと、どちらかを直し忘れた
 * ときに「記録した変異」と「検査している変異」が静かにずれる。
 *
 * ⭐ **`recordAnswer`（`cli.ts`）に直接組み込んである。** 理由: `record answer` は
 * 毎回空の `CassetteRecorder` から全12ケース×2経路を録り直す全置換であり
 * （`answer-bench.ts` の `recordAnswer` docstring）、この変異が `record answer` の
 * 経路の**外**（別スクリプトだけ）にあると、次に誰かが `record answer` を素で走らせて
 * 全置換したとき、この変異分の2エントリだけが新しいカセットから消える
 * （Issue #691 / #693 が近く `answer.json` を全体で録り直す予定——その回でも変異が
 * 自動的に付いてくるようにする必要がある）。⟹ **`recordAnswer` 自身が
 * `runAnswerBench` の直後にこの関数を呼ぶ**ことで、以後どんな `record answer` の
 * 実行でも変異分が自動的に含まれる。
 *
 * ## なぜ `RecallResult`（`recall.memories[].digest`）ではなく `PromptSpec` を変異させるのか
 *
 * `resultContainsObservation`（層1・出典到達）は `Memory.sourceObservationId` を
 * Postgres から読むだけで、`digest` の中身も、ここで組み立てる `PromptSpec` の中身も
 * 一切見ない（`provenance-trace.ts`、ADR 0236 が既に固定した事実）。⟹ **ここで
 * `PromptSpec.messages[0].content` の文字列だけを書き換えても、`sourceObservationId`
 * は Postgres の行としてまったく触れられておらず、同じ出典を指したままである。**
 * 実際の `ingestConversation`/`queryRecall`（本物の Postgres + pgvector、
 * `RecordedEmbeddingProvider`/`RecordedLLMProvider` を通した実行経路）が組み立てた
 * `PromptSpec` をそのまま入力に取るので、「本物の recall が返した digest を、
 * 要約が失敗したふりをして後から書き換える」という筋を、経路を新設せずに再現できる。
 *
 * ⚠ **対象はケース `pref-tea-over-coffee`（`answer-case-set.dev.ts`）1件だけ。**
 * このケースの mnemora 側 `PromptSpec` は `examples/chat/cassettes/answer.json` に
 * 記録済みで、`recall.memories` が返す digest が `RETENTION_MUTATION_TARGET_SUBSTRING`
 * を一意に含むことを記録時点で確認している（記録スクリプトの実行ログ参照）。
 */
export const RETENTION_MUTATION_CASE_ID = "pref-tea-over-coffee";

/**
 * 元の digest 行に一意に含まれる、答えそのものを言い当てている部分文字列。
 * ⚠ **記録時点の実 API の抽出結果に依存する値**——`answer.json` の抽出エントリ
 * （`system` が「あなたは会話・イベント・文書から再利用可能な記憶を抽出する」で
 * 始まるエントリのうち、`pref-tea-over-coffee` の発話に対応するもの）の
 * `value.memories[0].content` と一致する（`node -e` で現物を読んで確認済み）。
 */
export const RETENTION_MUTATION_TARGET_SUBSTRING =
  "打ち合わせのとき、飲み物はコーヒーより紅茶のほうが好き";

/**
 * 置き換え後の文字列。ADR 0236 の単体試験（`provenance-trace.test.ts` の
 * `DIGEST_INFO_LOST`）と同じ「要約に失敗した」という体裁の文言を意図的に揃える
 * ——同じ Issue #498 完了条件4 が想定する欠落の種類（要約による情報欠落）であることを、
 * 読み手が2つの検査の間で対応づけられるようにするため。
 */
export const RETENTION_MUTATION_REPLACEMENT = "[要約失敗。内容は保持していません]";

/**
 * `promptSpec.messages[0].content` の中の {@link RETENTION_MUTATION_TARGET_SUBSTRING}
 * を {@link RETENTION_MUTATION_REPLACEMENT} に置き換えた新しい `PromptSpec` を返す。
 *
 * ⛔ **対象の部分文字列が見つからなければ例外を投げる。**「置き換えたつもりで置き換わって
 * いない」まま記録・検査が進むと、変異が効いていないのに緑になる——`CassetteRecorder`
 * が「1件も記録されていない」で落ちるのと同じ規律（黙って空振りしない）。
 *
 * `messages[0]` 以外は変更しない。`system` も変更しない
 * （両経路で system 文を揃える § 2.2 決定2 を保つ）。
 */
export function applyRetentionMutation(promptSpec: PromptSpec): PromptSpec {
  const message = promptSpec.messages[0];
  if (message === undefined) {
    throw new Error(
      "applyRetentionMutation: promptSpec.messages が空である。変異させる対象が無い。",
    );
  }
  if (!message.content.includes(RETENTION_MUTATION_TARGET_SUBSTRING)) {
    throw new Error(
      "applyRetentionMutation: 変異対象の部分文字列" +
        `${JSON.stringify(RETENTION_MUTATION_TARGET_SUBSTRING)} が見つからない。` +
        "recall の digest が記録時点から変わった可能性がある——記録をやり直す前に原因を確かめること。",
    );
  }
  const mutatedContent = message.content.replace(
    RETENTION_MUTATION_TARGET_SUBSTRING,
    RETENTION_MUTATION_REPLACEMENT,
  );
  return {
    ...promptSpec,
    messages: [{ ...message, content: mutatedContent }, ...promptSpec.messages.slice(1)],
  };
}

/** {@link recordRetentionMutationPositiveControl} の戻り値。 */
export interface RetentionMutationRecordResult {
  caseId: string;
  /** 変異前（元の `PromptSpec` のまま）の一次判定・二次観測。呼び出し側の健全性確認用。 */
  originalVerdict: AnswerVerdict;
  originalJudgement: AnswerJudgement;
  mutatedAnswer: string;
  mutatedVerdict: AnswerVerdict;
  mutatedJudgement: AnswerJudgement;
}

/**
 * `record answer`（`cli.ts` の `recordAnswer`）の一部として呼ぶ、Issue #498 完了条件4・
 * 「回答評価」側の陽性対照の記録手順。
 *
 * 1. `cases` から {@link RETENTION_MUTATION_CASE_ID} のケースを取り出し、`runAnswerCase`
 *    をもう一度走らせて**本物の recall が組み立てた** mnemora 側 `PromptSpec` を得る
 *    （`recordAnswer` が直前に呼ぶ `runAnswerBench` と同じ `cases` 配列に同じケースが
 *    含まれているので、この呼び出しの入力（会話・質問）はそちらと同一——ただし
 *    `tenantPrefix` を変えて独立のテナントで走らせる。`answer-bench.ts` の
 *    `embeddingSpaceSlug` の docstring が説明する tenant 分離の規律に従う）。
 * 2. {@link applyRetentionMutation} で digest から答えの語を落とす。
 * 3. 変異後の `PromptSpec` で `complete()`（回答生成）と judge を1回ずつ呼ぶ。
 *
 * ⚠ **`llmProvider`/`judgeLLMProvider` が `RecordingLLMProvider` を包んでいれば
 * （＝ `record answer` の実行中であれば）、ここでの呼び出しは自動的に
 * `CassetteRecorder` へ記録される。**この関数自体はカセットに触れない——
 * 記録するかどうかは呼び出し側が渡す provider の層で決まる（`recorded`/`deterministic`
 * で渡された場合は、それぞれの層の既定の挙動——再生 or stub エコー——にそのまま従う。
 * この関数は provider の層を検査も強制もしない）。
 *
 * ⛔ **ここで `pass`/`fail` を assert しない。**実 API の応答は決定的ではないため、
 * 「必ず fail になる」と決め打つと `docs/autonomy.md` §2.2 決定5 が禁じる「実測を見て
 * 期待を書き換える」の逆側（実測前に期待を固定しすぎる）を踏みかねない。判定は
 * 呼び出し側（`cli.ts` が画面に出すだけ）と、再生側の歯
 * （`__tests__/answer-retention-positive-control.postgres.test.ts`、
 * こちらは実測した具体的な値を固定している）に委ねる。
 */
export async function recordRetentionMutationPositiveControl(
  runtime: Runtime,
  llmProvider: CountingLLMProvider,
  embeddingProvider: CountingEmbeddingProvider,
  judgeLLMProvider: CountingLLMProvider,
  cases: readonly AnswerCase[],
  tenantPrefix: string,
): Promise<RetentionMutationRecordResult> {
  const answerCase = cases.find((c) => c.id === RETENTION_MUTATION_CASE_ID);
  if (answerCase === undefined) {
    throw new Error(
      `recordRetentionMutationPositiveControl: ケース ${RETENTION_MUTATION_CASE_ID} が ` +
        "渡されたケース集合に見つからない。",
    );
  }

  const original = await runAnswerCase(
    runtime,
    llmProvider,
    embeddingProvider,
    judgeLLMProvider,
    answerCase,
    `${tenantPrefix}-retention-mutation`,
  );

  const mutatedPromptSpec = applyRetentionMutation(original.mnemora.promptSpec);
  const ctx: Ctx = { tenantId: `${tenantPrefix}-retention-mutation-mutated` };
  const mutatedResponse = await llmProvider.complete(ctx, mutatedPromptSpec);
  const mutatedVerdict = gradeAnswer(mutatedResponse.content, answerCase.expected);

  const groundTurnTexts = answerCase.grounds.turnIndex.map((i) => {
    const turn = answerCase.conversation[i];
    if (turn === undefined) {
      throw new Error(
        `recordRetentionMutationPositiveControl: grounds.turnIndex=${i} が conversation の範囲外`,
      );
    }
    return turn.text;
  });
  const mutatedJudgement = await judgeAnswer(judgeLLMProvider, ctx, {
    question: answerCase.question,
    expectedKind: answerCase.expected.kind,
    rationale: answerCase.grounds.rationale,
    groundTurnTexts,
    answer: mutatedResponse.content,
  });

  return {
    caseId: answerCase.id,
    originalVerdict: original.mnemora.verdict,
    // `runAnswerCase` は judge を常に走らせる（`AnswerPathMeasurement.judgement` は
    // judge を走らせなかった run でだけ `undefined` になる——ここでは必ず走っている）ので、
    // 非 null アサーションが安全である。
    originalJudgement: original.mnemora.judgement!,
    mutatedAnswer: mutatedResponse.content,
    mutatedVerdict,
    mutatedJudgement,
  };
}
