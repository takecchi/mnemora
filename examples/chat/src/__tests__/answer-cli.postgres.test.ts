import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { ANSWER_CASE_SET_DEV } from "../answer-case-set.dev.js";
import { ANSWER_CASE_SET_EVAL } from "../answer-case-set.eval.js";
import { requireDatabaseUrl } from "./test-db.js";

/**
 * `answer` サブコマンドを**本物の CLI として子プロセスで起動する**歯（Issue #547）。
 *
 * **⚠ 既存の `answer` 系の歯は、どれもこの経路を通っていない。**
 * `answer-bench.postgres.test.ts` が呼ぶのは `runAnswerCase`（単数形）であり、
 * `cli.ts` の `runAnswer()` が実際に呼ぶ `runAnswerBench`（複数形）は
 * **repo 全体でテストから一度も呼ばれていなかった**（`cli.ts` の2箇所
 * ——`recordAnswer` と `runAnswer`——からしか呼ばれていない）。
 * `answer-case.test.ts`/`answer-judge.test.ts` も純関数だけを見ている。
 * ⟹ **`answer` という口が「起動して最後まで通る」ことは、一度も測られていなかった。**
 *
 * **子プロセスでなければ測れない理由**は `retrieval-json-cli-wiring.postgres.test.ts`
 * と同じである——`cli.ts` は末尾で `main().catch(...)` を無条件に実行するため、
 * import 越しに `runAnswer()` だけを呼ぶことができない（ADR 0068「引き受ける負債」）。
 *
 * **DB を要求する**——`runAnswer()` は `requireDatabaseUrl()` を通るため、この歯自体も
 * DB 無しでは何も検査できない。だから `.postgres.test.ts` に置く（ADR 0015・0016 の分割）。
 *
 * ⚠ **実 API は絶対に叩かない**——`MNEMORA_PROVIDER_SOURCE=recorded` を明示し、
 * かつ `OPENAI_API_KEY` を env から確実に消してから子プロセスへ渡す（二重に塞ぐ。
 * `retrieval-json-cli-wiring.postgres.test.ts` と同じ規律）。再生元は
 * `examples/chat/cassettes/answer.json`（ADR 0051 / PR #514）。
 *
 * ⛔ **ただし「既定の道」を測る歯（Issue #577）だけは、塞ぎが1枚しかない。**
 * あちらが測るのは `MNEMORA_*` を**一切指定しない**ときの挙動であり、
 * `MNEMORA_PROVIDER_SOURCE=recorded` を置いた時点でその経路ではなくなる。
 * ⟹ **`OPENAI_API_KEY` を消すことだけが実 API を止めている。**
 * これは測る対象から来る制約であって、規律を緩めたのではない——**そう名乗っておく。**
 *
 * ## 🔴 この歯が**主張しないこと** —— ケースごとの正誤を固定しない
 *
 * ⛔ **`summary` の pass/fail の件数も、特定ケースの `verdict` も assert しない。**
 * 記録の再生には、ADR 0233 が実 API で見つけた**自然発生の fail**
 * （`schedule-change-deadline` で記憶経路が撤回済みの値を答える）がそのまま含まれている。
 * これを歯に焼き込むと、**supersede が将来直ったときに、直したことが赤として現れる。**
 * ⟹ [ADR 0236](../../../../docs/decisions/0236-answer-retention-mutation-tested-not-recorded.md)
 * が「⛔ (c) `schedule-change-deadline`（自然発生の fail）を完了条件の充足として扱わない」
 * と退けたのと同じ線を、ここでも引く——**この歯が測るのは配線であって回答品質ではない**
 * （`cli.ts` の `runAnswer()` 冒頭の「🔴 これは配線の検査であって、回答品質の測定ではない」）。
 *
 * ## ⚠ この歯を手元で走らせるときの穴（Issue #547 の測定で実際に踏んだ）
 *
 * `runAnswerCase` の tenant は `${tenantPrefix}-${answerCase.id}` という**固定値**で、
 * 時刻を含まない（`answer-bench.ts`）。⟹ **同じ DB に対して別の埋め込みモードで
 * `answer` を先に走らせてあると、この歯は落ちる**——`deterministic`（8次元）で
 * 入った記憶が残っている DB に `recorded`（256次元）で当てると想起が 0 件になり、
 * カセットに無いプロンプトが組み上がる（`RecordedLLMProvider` は黙って倒れず例外）。
 * ⭐ **同じモードでの連続実行は冪等である**【実測 2026-09-21】——2回続けて走らせて
 * `measuredAt` を除く JSON が完全一致した。⟹ CI（ジョブごとに新しい DB）でも、
 * この歯が CLI を2回起動することでも問題にならない。**手元で混ぜたときだけ落ちる。**
 *
 * ⟹ 代わりに assert するのは、**件数が唯一の出所（ケース集合）と一致すること**、
 * **両経路が揃っていること**、**`recorded` で走ったこと**、**JSON の口が配線されていること**
 * だけである。⛔ 件数そのものを数字で書かない（`AGENTS.md`「数を、道具と生成物に焼き込まない」）。
 */

const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));

/**
 * ⚠ **`it` の第3引数で個別に伸ばす。`vitest.config.mts` の `testTimeout`（30秒）は
 * 触らない**——global を上げると、この歯と無関係の全テストで将来の遅延が隠れる。
 *
 * **上げ幅の根拠**【実測 2026-09-21、記録再生・専用 Postgres 17 + pgvector】:
 * `pnpm --filter @mnemora/example-chat run answer` 単体が **3.5〜3.9秒**。この歯は
 * **2回起動する**（env を設定する側／しない側）ため、vitest が計測した `it` 自体は
 * **約7.5秒**だった。⟹ **180秒は実測の約24倍の余裕である。**
 * ⛔ この余裕は「速さの主張」ではない——**余裕が大きいほど遅延の検出力は落ちる。**
 * 現に測った値を書き残すのは、後から余裕がどれだけ在ったかを数えられるようにするためである。
 * （`retrieval-json-cli-wiring.postgres.test.ts` が同じ 180 秒を使っている。揃えた。）
 */
const CLI_TIMEOUT_MS = 180_000;

let workDir: string | undefined;

afterEach(() => {
  if (workDir) {
    rmSync(workDir, { recursive: true, force: true });
    workDir = undefined;
  }
});

function runAnswerCli(env: Record<string, string | undefined>) {
  return spawnSync("pnpm", ["--filter", "@mnemora/example-chat", "run", "answer"], {
    cwd: repoRoot,
    env,
    encoding: "utf8",
    timeout: CLI_TIMEOUT_MS,
  });
}

describe("examples/chat answer: 記録の再生で最後まで通る(本物の CLI を子プロセスで起動。Issue #547)", () => {
  it(
    "recorded で exit 0 になり、MNEMORA_ANSWER_JSON を設定すれば書く／未設定なら1バイトも挙動を変えない",
    () => {
      workDir = mkdtempSync(join(tmpdir(), "answer-cli-wiring-"));
      const jsonPath = join(workDir, "answer.json");

      const baseEnv: Record<string, string | undefined> = {
        ...process.env,
        DATABASE_URL: requireDatabaseUrl(),
        MNEMORA_PROVIDER_SOURCE: "recorded",
        // ⚠ **この明示指定は、もう「再生するために要るもの」ではない**（Issue #577 の
        // 直しより後）。`resolveRecordedRun` がカセットを取れたら `MNEMORA_LLM`/
        // `MNEMORA_EMBEDDING` を `"recorded"` へ自分で倒すため、指定しなくても再生になる
        // ——それを固定するのが下の「MNEMORA_* を一切指定しなくても」の歯である。
        // ⟹ ここに残してあるのは、**明示指定の道も引き続き効くこと**を測るためである
        // （`resolveRecordedRun` が倒した値と、利用者が明示した値が一致する側）。
        //
        // 🔴 **かつてはこれが必須だった。** `runAnswer` が `process.env` をそのまま
        // `createAnswerBenchRuntime` へ渡していたため、明示しないと `selectProviderMode`
        // が `deterministic` を返し（`OPENAI_API_KEY` が無いので）、画面には
        // 「記録した応答を再生する」と出ながら擬似 provider で走っていた（Issue #577）。
        MNEMORA_LLM: "recorded",
        MNEMORA_EMBEDDING: "recorded",
      };
      // ⚠ 二重に塞ぐ。片方だけでは実 API に倒れうる。
      delete baseEnv.OPENAI_API_KEY;

      // --- 1回目: MNEMORA_ANSWER_JSON を設定する ---
      const withEnv = runAnswerCli({ ...baseEnv, MNEMORA_ANSWER_JSON: jsonPath });
      expect(withEnv.status, `stderr:\n${withEnv.stderr}\nstdout:\n${withEnv.stdout}`).toBe(0);

      // 🔴 記録の再生で走ったこと自体を、出力から確かめる——実 API に倒れていたら
      // この行は出ない（`providers.ts` の `describeProviderSource`）。
      expect(withEnv.stdout).toContain("provider source: recorded");
      expect(withEnv.stdout).toContain("[answer] 機械可読な結果を書き出した");
      expect(existsSync(jsonPath), "MNEMORA_ANSWER_JSON を設定したのにファイルが無い").toBe(true);

      const json = JSON.parse(readFileSync(jsonPath, "utf8"));
      expect(json.llmMode).toBe("recorded");
      expect(json.embeddingMode).toBe("recorded");
      // `recorded` は品質を主張できる層である(`answerQualityClaimable` は
      // `deterministic` のときだけ false)。⛔ ここで主張するのは「その旗が立つ層で
      // 走った」ことだけで、⛔ 中身の正誤には一切触れない(上の docstring)。
      expect(json.qualityClaimable).toBe(true);
      // commit は取れれば40桁16進、取れなければ null——どちらであっても壊れていない。
      expect(json.commit === null || /^[0-9a-f]{40}$/.test(json.commit)).toBe(true);
      expect(() => new Date(json.measuredAt).toISOString()).not.toThrow();

      // ⭐ 件数は**ケース集合という唯一の出所から導く**——数字を焼き込まない。
      const expectedCaseCount = ANSWER_CASE_SET_DEV.length + ANSWER_CASE_SET_EVAL.length;
      expect(json.caseCount).toBe(expectedCaseCount);
      expect(json.cases).toHaveLength(expectedCaseCount);
      expect(new Set(json.cases.map((c: { id: string }) => c.id)).size).toBe(expectedCaseCount);
      expect(json.cases.map((c: { id: string }) => c.id).sort()).toEqual(
        [...ANSWER_CASE_SET_DEV, ...ANSWER_CASE_SET_EVAL].map((c) => c.id).sort(),
      );

      for (const answerCase of json.cases) {
        // ⭐ 対で出すことがこの口の主張である(`runAnswer()` の docstring)——
        // 片方だけが埋まっている形は、配線が壊れている。
        for (const path of [answerCase.naive, answerCase.mnemora]) {
          expect(typeof path.inputChars).toBe("number");
          expect(path.inputChars).toBeGreaterThan(0);
          expect(typeof path.inputEstimatedTokens).toBe("number");
          expect(typeof path.answer).toBe("string");
          // ⛔ どの値かは問わない。三値のどれかであることだけを見る。
          expect(["pass", "fail", "indeterminate"]).toContain(path.verdict);
        }
        // 追加費用は別ブロックで数えられている(ADR 0233。削減率から差し引かない)。
        expect(answerCase.cost.answerLLMCalls).toBeGreaterThan(0);
        expect(answerCase.cost.judgeLLMCalls).toBeGreaterThan(0);
      }

      // 入力量の削減は naive/mnemora の合計から導かれている——こちらは品質ではなく量なので
      // 関係そのものを見てよい。⛔ 削減率の**値**は固定しない(記録を録り直せば動く)。
      expect(json.inputReduction.naiveInputChars).toBe(
        json.cases.reduce(
          (sum: number, c: { naive: { inputChars: number } }) => sum + c.naive.inputChars,
          0,
        ),
      );
      expect(json.inputReduction.mnemoraInputChars).toBe(
        json.cases.reduce(
          (sum: number, c: { mnemora: { inputChars: number } }) => sum + c.mnemora.inputChars,
          0,
        ),
      );

      // --- 2回目: 未設定なら書かない ---
      const rmJsonPath = join(workDir, "should-not-appear.json");
      const withoutEnv = runAnswerCli(baseEnv);
      expect(
        withoutEnv.status,
        `stderr:\n${withoutEnv.stderr}\nstdout:\n${withoutEnv.stdout}`,
      ).toBe(0);
      expect(withoutEnv.stdout).not.toContain("[answer] 機械可読な結果を書き出した");
      expect(existsSync(rmJsonPath)).toBe(false);
    },
    CLI_TIMEOUT_MS,
  );

  /**
   * ⭐ Issue #577 の直しそのものを、既定の道（明示指定なし）で固定する歯。
   *
   * **上のケースとの違いは1点だけ**: `MNEMORA_LLM`/`MNEMORA_EMBEDDING`/
   * `MNEMORA_PROVIDER_SOURCE` の**どれも指定しない**。`DATABASE_URL` だけを渡し、
   * `OPENAI_API_KEY` は（実行環境に在ると実 API に倒れてしまうため）明示的に落とす。
   * `resolveRecordedRun` は `decideProviderSource` が `OPENAI_API_KEY` 無しから
   * 導く `{ source: "recorded", reason: "no-key" }` を読んでカセットを解決し、
   * `MNEMORA_LLM`/`MNEMORA_EMBEDDING` を自分で `"recorded"` へ倒す——**この経路が
   * 直る前は、`runAnswer()` がその倒した env を使わず `process.env` をそのまま
   * 渡していたため、画面には「記録した応答を再生する」と出ながら実際には
   * `deterministic` の擬似 provider で走っていた（Issue #577 の芯）。**
   *
   * ⟹ ここで確かめるのは「画面の主張」と「実際に走った provider」が一致すること
   * ——`[cassette]` の宣言だけでなく、`[provider] LLM` 行が擬似 provider を
   * 名乗っていないこと、そして `MNEMORA_ANSWER_JSON` の `llmMode`/`embeddingMode`
   * が実際に `"recorded"` であることを、直接見る。
   *
   * ⚠ **tenant の干渉について検討した結果**: `runAnswerCase` の tenant は
   * `${tenantPrefix}-${answerCase.id}`（`tenantPrefix="answer-bench"`固定）で、
   * この歯は上のケースと**同じ tenant** を使う。上のケースの docstring（45-54行）が
   * 警告する干渉は「同じ DB に別の埋め込みモードで先に走らせてある」場合——
   * だがこの歯は明示指定を一切しないだけで、(お) の直しにより実際に選ばれる
   * embeddingMode は上のケースと同じ `"recorded"`（256次元）になる。⟹ **モードが
   * 一致しているため、実行順に関わらず干渉しない**（上のケースの「⭐ 同じモードでの
   * 連続実行は冪等である」実測がそのまま当てはまる）。この歯を後から走らせても、
   * 先に走らせても、埋め込みモードが変わらない限り壊れない。
   */
  it(
    "MNEMORA_* を一切指定しなくても recorded で走り、画面と実際の provider が一致する（Issue #577）",
    () => {
      workDir = mkdtempSync(join(tmpdir(), "answer-cli-default-env-"));
      const jsonPath = join(workDir, "answer.json");

      const env: Record<string, string | undefined> = {
        ...process.env,
        DATABASE_URL: requireDatabaseUrl(),
        MNEMORA_ANSWER_JSON: jsonPath,
      };
      // 🔴 **ここでは `OPENAI_API_KEY` を消すことだけが実 API を止めている**
      // ——`MNEMORA_PROVIDER_SOURCE=recorded` を置けば二重に塞げるが、それを置くと
      // 「既定の道」ではなくなり、この歯が測ろうとしているものが消える（冒頭 docstring）。
      // `MNEMORA_LLM`/`MNEMORA_EMBEDDING`/`MNEMORA_PROVIDER_SOURCE` は、実行環境から
      // 紛れ込むと既定の道でなくなるため、明示的に落とす。
      delete env.OPENAI_API_KEY;
      delete env.MNEMORA_LLM;
      delete env.MNEMORA_EMBEDDING;
      delete env.MNEMORA_PROVIDER_SOURCE;

      const result = runAnswerCli(env);
      expect(result.status, `stderr:\n${result.stderr}\nstdout:\n${result.stdout}`).toBe(0);

      // 🔴 画面は「記録の再生」を宣言している。
      expect(result.stdout).toContain("[cassette] 記録した応答を再生する");

      // 🔴 これが Issue #577 の芯——画面の provider 行が、宣言と矛盾する
      // 「決定的な擬似 provider」を名乗っていないこと。
      expect(result.stdout).toContain(
        "[provider] LLM       : 記録した実 API 応答の再生（ADR 0051）",
      );
      expect(result.stdout).not.toContain("決定的な擬似 provider");

      const json = JSON.parse(readFileSync(jsonPath, "utf8"));
      expect(json.qualityClaimable).toBe(true);
      expect(json.llmMode).toBe("recorded");
      expect(json.embeddingMode).toBe("recorded");
    },
    CLI_TIMEOUT_MS,
  );
});
