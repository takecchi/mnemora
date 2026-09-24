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
 * ## ⚠ かつて在った穴と、それが塞がれた経緯（Issue #547 → #583）
 *
 * **かつて `runAnswerCase` の tenant は `${tenantPrefix}-${answerCase.id}` で、
 * 埋め込み空間を含んでいなかった。** ⟹ **同じ DB に別の埋め込みモードで `answer` を
 * 先に走らせてあると、この歯は落ちた**——ただし**落ちる向きは片方だけだった**
 * 【実測 2026-09-21、Issue #583】: `deterministic`（8次元）が **その tenant で最初に
 * 抽出を走らせた**ときだけ、後から来る `recorded`（256次元）が落ちる。
 * 真因は次元の混在ではなく、`observations` の `ON CONFLICT (tenant_id, external_id)
 * DO NOTHING` による**抽出の冪等スキップ**である——2回目は抽出が走らないため、
 * 後から来た空間のベクトルが0行のまま recall が走り、カセットに無いプロンプトが
 * 組み上がる（`RecordedLLMProvider` は黙って倒れず例外）。
 *
 * ⭐ **[ADR 0261](../../../../docs/decisions/0261-answer-bench-tenant-keyed-by-embedding-space.md)
 * が tenant に埋め込み空間のスラグを挟んだので、この穴は塞がった。**
 * ⟹ **この describe の `it` は、どの順で走らせても干渉しない**【実測 2026-09-21——
 * `deterministic` の歯を `vitest -t` で先に走らせた後に3本すべてを走らせて 3 passed】。
 * ⭐ **同じモードでの連続実行が冪等であること**【実測 2026-09-21】——2回続けて走らせて
 * `measuredAt` を除く JSON が完全一致した——は、いまも成り立つ。
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
      expect(withEnv.stdout).toContain("provider source の予定: recorded");
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

      const originalCasesById = new Map(
        [...ANSWER_CASE_SET_DEV, ...ANSWER_CASE_SET_EVAL].map((c) => [c.id, c]),
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
          // 層2（回答に必要な情報の保持、Issue #693 / 親 #498）。形だけをここで見る
          // ——値そのものは下の専用ブロックで固定する。
          expect(typeof path.contentPreservation.applicable).toBe("boolean");
          expect(typeof path.contentPreservation.preserved).toBe("boolean");
          expect(Array.isArray(path.contentPreservation.matchedAcceptTerms)).toBe(true);
        }
        // 追加費用は別ブロックで数えられている(ADR 0233。削減率から差し引かない)。
        expect(answerCase.cost.answerLLMCalls).toBeGreaterThan(0);
        expect(answerCase.cost.judgeLLMCalls).toBeGreaterThan(0);
      }

      // ⭐ Issue #693 完了条件2 の実データ側（固定条件の回帰検査。CI が毎回 recorded
      // カセットを再生するこの歯の中で走る）: closed-value の全ケースについて、
      // mnemora 経路の digest に `expected.accept` が実際に残っていること（層2）を
      // 固定する。カセットは 2026-09-17 に gpt-4o-mini/text-embedding-3-small で
      // 記録されたものであり（`examples/chat/cassettes/answer.json` の
      // `recordedAt`/`llm.model`）、この歯は録り直しを要求しない
      // ——既存の記録済み digest 文字列を決定的に読むだけである。
      // 🔴 **これは回答が正しいことを主張しない。** `schedule-change-deadline`
      // （`answer-case-set.eval.ts`、ADR 0233 が見つけた自然発生の fail）は、
      // digest に `25日`（accept）が実際に残っている（層2 preserved=true）まま、
      // 実際の回答は撤回済みの `20日`（reject）を答える（層3 fail）——層2 と層3 が
      // 独立であることを、この歯と `verdict` の食い違いが実データで示す。
      for (const answerCase of json.cases) {
        const original = originalCasesById.get(answerCase.id);
        expect(original, `${answerCase.id}: ケース集合に見つからない`).toBeDefined();
        if (original === undefined || original.expected.kind !== "closed-value") {
          continue;
        }
        expect(
          answerCase.mnemora.contentPreservation.applicable,
          `${answerCase.id}: closed-value なので applicable=true のはず`,
        ).toBe(true);
        expect(
          answerCase.mnemora.contentPreservation.preserved,
          `${answerCase.id}: mnemora の digest に expected.accept が残っているはず` +
            `（残っていなければ、記録済みカセットの digest が変わった——録り直しを検討すること）`,
        ).toBe(true);
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
   * ⚠ **tenant の干渉について**: この歯は上のケースと同じ `"recorded"`（256次元）で
   * 走るので、**同じ tenant** を使う（tenant には埋め込み空間のスラグが入る。ADR 0261）。
   * ⟹ **モードが一致しているため、実行順に関わらず干渉しない**（冒頭 docstring の
   * 「⭐ 同じモードでの連続実行は冪等である」実測がそのまま当てはまる）。
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

      // 🔴 画面が名乗るのは「読めた」までである（Issue #589）。
      expect(result.stdout).toContain("[cassette] カセットを読んだ");
      // ⛔ 「再生する」という予告は、もう画面に出ない——provider を組む前に
      // 「この実行は再生になる」と断定していた行を落とした（Issue #589）。
      expect(result.stdout).not.toContain("記録した応答を再生する");
      // ⭐ 代わりに、構築後の実測がそれを名乗る（この直後の [provider] 行）。

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

  /**
   * 🔴 **陽性対照の CLI 側（Issue #577 の続き）——明示指定が勝つことを固定する。**
   *
   * 上の2本は「カセットを取れたら再生になる」を測る。**この歯はその逆側**——
   * **利用者が `MNEMORA_LLM`/`MNEMORA_EMBEDDING` を明示したら、そちらが勝つ**
   * ことを測る。⟹ `deterministic` を明示した実行では、⛔⛔⛔ バナーが
   * **依然として出る**。
   *
   * ⚠ **これが無いと、既定の道でバナーが出ないこと（上の歯）は
   * 「バナーを廃止した」でも同じ結果になる。** 表示層そのものの生存は
   * `answer-format.test.ts`（DB 不要）が別に固定しているが、**CLI を通した
   * 実行でも出ること**はここでしか測れない。
   *
   * 🔴 **この歯は ADR 0260 の決定 (お) を限定する。** `resolveRecordedRun` が
   * 無条件に `"recorded"` を焼き込む形だと、利用者の明示が黙って上書きされ、
   * **ADR 0068 の「明示した source と、実際に使われる provider が食い違う経路を
   * 作らない」に反する**——#577 と同じ形の欠陥を、向きを変えて作ることになる。
   * ⟹ **明示が在るときは倒さない。**
   *
   * ⭐ **この歯の位置は、もう順序に依存しない。** この歯だけが `deterministic`
   * （擬似 embedding）で走るが、tenant に埋め込み空間のスラグが入る（ADR 0261）ので
   * **上の2本とは別 tenant になる。** ⟹ どの順で走らせても干渉しない
   * 【実測 2026-09-21——この歯を `vitest -t` で先に走らせた後に3本すべてを走らせて
   * 3 passed】。⛔ **かつては順序に依存していた**（冒頭 docstring）。
   *
   * ⛔ **回答の中身は一切 assert しない。** `qualityClaimable === false` の実行
   * であり、この歯が測るのは「どのモードで走ったか」と「画面が何を名乗ったか」
   * だけである。
   */
  it(
    "⭐ MNEMORA_LLM/MNEMORA_EMBEDDING に deterministic を明示したら、明示が勝ち ⛔⛔⛔ バナーが出続ける（Issue #577 / ADR 0068）",
    () => {
      workDir = mkdtempSync(join(tmpdir(), "answer-cli-explicit-deterministic-"));
      const jsonPath = join(workDir, "answer.json");

      const env: Record<string, string | undefined> = {
        ...process.env,
        DATABASE_URL: requireDatabaseUrl(),
        MNEMORA_ANSWER_JSON: jsonPath,
        MNEMORA_LLM: "deterministic",
        MNEMORA_EMBEDDING: "deterministic",
      };
      // 実 API に倒れないように落とす。⚠ `MNEMORA_PROVIDER_SOURCE` は落とす——
      // 実行環境から紛れ込むと、この歯が測りたい「明示指定だけを置いた形」で
      // なくなる。
      delete env.OPENAI_API_KEY;
      delete env.MNEMORA_PROVIDER_SOURCE;

      const result = runAnswerCli(env);
      expect(result.status, `stderr:\n${result.stderr}\nstdout:\n${result.stdout}`).toBe(0);

      // 🔴 バナーは生きている。既定の道から消えたのは、条件が偽になったからである。
      expect(result.stdout).toContain("回答品質は測っていない");

      // 🔴 明示が勝っている——画面の provider 行が擬似 provider を名乗る。
      expect(result.stdout).toContain(
        "[provider] LLM       : @mnemora/testkit の決定的な擬似 provider",
      );

      // ⭐ (か) がここで鳴る——カセットは読まれたが、この実行では使われていない。
      // **食い違いが沈黙しないことそのものを固定する。**
      expect(result.stdout).toContain("読み込んだカセットは、この実行では使っていない");

      // 🔴 **Issue #589 の芯。** この実行はカセットを読むが**再生しない**。
      // ⟹ 画面が「再生する」と名乗ってはならない——かつてはここで
      // 「[cassette] 記録した応答を再生する」と出しながら擬似 provider で
      // 走っており、2行下の [provider] 行と矛盾していた。
      expect(result.stdout).not.toContain("記録した応答を再生する");
      // ⭐ 「読めた」という実測された事実のほうは、出てよい（実際に読んでいる）。
      expect(result.stdout).toContain("[cassette] カセットを読んだ");

      const json = JSON.parse(readFileSync(jsonPath, "utf8"));
      expect(json.qualityClaimable).toBe(false);
      expect(json.llmMode).toBe("deterministic");
      expect(json.embeddingMode).toBe("deterministic");
    },
    CLI_TIMEOUT_MS,
  );
});
