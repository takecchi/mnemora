import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { blankOutWorkflowComments } from "../workflow-comment-blank-lib.mjs";

/**
 * ⭐ **この歯が測っているもの(消す前に読むこと)**
 *
 * **`.github/workflows/ci.yml` の中で、「local-embedding のモデル重みを
 * キャッシュする `actions/cache` 段の `path:`」と「その成果を使う段が読む
 * `MNEMORA_LOCAL_EMBEDDING_CACHE_DIR` の値」が、ジョブごとに完全に一致していること**
 * (Issue #162 の F)。
 *
 * 🔑 **なぜ要るか**: Issue #162 の変異試験(F)は、`actions/cache` の `path:` と
 * `MNEMORA_LOCAL_EMBEDDING_CACHE_DIR` の片方だけを書き換える変異を当てても、
 * **リポジトリのどこも赤くならなかった**ことを見つけた。2つの値が同じ場所を
 * 指していることは、CI の実行結果(キャッシュを実際に当てられるかどうか)でしか
 * 見えず、静的な検査は1つも無かった。この歯はその欠けていた検査を足す。
 *
 * ⭐ **Issue #164 との関係**: 2026-09-12 の run 34699094705 で、`identifier-probes`/
 * `consolidation-cost`(cache 段あり)は緑だったが、`root-gate-db-stage`
 * (cache 段が無い。`run-db-tests.mjs` → `examples/chat` の `test:db` →
 * `consolidation-cost.postgres.test.ts` の `warmupLocalEmbedding` が重みを取りに
 * 行く)は 429 で落ちた。**同じ重みを取りに行くジョブは実は4本ある**
 * (`identifier-probes` / `consolidation-cost` / `root-gate-db-stage` /
 * `example-chat`——`example-chat` も同じ `vitest run` で同じテストファイルを
 * 実行するため、同 run のログで実測確認済み)。この PR は #164 の対策として
 * `root-gate-db-stage` と `example-chat` にも cache 段を足すが、**配線が
 * 正しく対になっているかを機械が測っていなければ、次に足す誰かがまた
 * 片方だけ書き換えて #162 の F を再現しうる。**⟹ この歯を先に書く。
 *
 * ## 何を測っているか
 *
 * `ci.yml` の各ジョブについて:
 * - そのジョブの中にある「local-embedding の重みをキャッシュする `actions/cache` 段」
 *   (見分け方は下参照)の `with.path` の集合と、
 * - そのジョブの中で(job-level `env:` でも step-level `env:` でも)設定される
 *   `MNEMORA_LOCAL_EMBEDDING_CACHE_DIR` の値の集合が、
 * **完全に一致すること**(両向き。片方にだけある値があれば赤くなる)。
 *
 * 🔑 **「local-embedding の重みをキャッシュする段」は `key:` が `local-embedding` で
 * 始まることで見分ける。** ⛔ `path:` では見分けない——`path:` を見分けに使うと、
 * 「`path:` を書き換える」という変異そのものが検出対象を identify する手段を
 * 壊してしまい、歯が空回りする(変異を当てた瞬間にその段が「対象外」になって
 * 何も比較しなくなる)。
 *
 * ⚠ **対の個数はハードコードしていない。** ジョブごとに path 集合と env 集合を
 * 動的に集めて比較しているので、健全な対が今後3組・4組(この PR で2組→4組に
 * 増える)に増えても、書き換えずに緑のままである。ただし**空回り(vacuous pass)を
 * 防ぐ下限**として、「対を持つジョブが最低2つ在ること」だけは
 * `toBeGreaterThanOrEqual(2)` で固定している(⛔ `toBe` にしない——3組・4組に
 * 増えても赤くならないようにするため)。
 *
 * ⚠ **2つの cache 段が同じ `key` を共有していることは、この歯が壊してはいけない
 * 前提である**(Issue #162 が名指しで禁じている)。`identifier-probes` /
 * `consolidation-cost` は同じモデルを使うため意図的に同じ `key` を共有しており、
 * この歯は「key が一意であること」を要求しない。逆向きに、
 * 「同じ `path:` を指す local-embedding cache 段は同じ `key:` を持つこと」は
 * 補助的な `it` として足している(共有を固定する向きであり、壊す向きではない)。
 *
 * 🔴 **`blankOutWorkflowComments` を必ず通してから照合している。** これを通さずに
 * `ci.yml` の生テキストへ `toContain`/正規表現を当てると、地の文のコメントが
 * `MNEMORA_LOCAL_EMBEDDING_CACHE_DIR` や `path:`/`key:` を**引用しているだけ**でも
 * 一致してしまう——PR #161 が直した変異D/H と同じ形の欠陥である
 * (`scripts/workflow-comment-blank-lib.mjs` の docstring)。`unhandled` は
 * `expect(unhandled).toEqual([])` で必ず見ている
 * (`ci-yml-postgres-regime-wiring.test.mjs` / `ci-yml-postgres-regime-coverage-wiring
 * .test.mjs` と同じ配線)。
 *
 * ⚠ **コメント潰しは `ci.yml` 全体に対して一度だけ行っている(ジョブ単位に
 * 切り出していない)。** 実際に `blankOutWorkflowComments(全文)` を走らせて
 * `unhandled` が空であることを確認済み(このジョブ群にはヒアドキュメントも
 * `''` の連続も無い)。ジョブ単位に切ってから通すのはヒアドキュメント等で
 * `unhandled` が出た場合の対処であり、今回は不要だった——もし将来
 * `unhandled` が出るようになったら、まずジョブ単位に切り出すことを検討すること
 * (ヒアドキュメントを含むジョブだけを迂回すればよい可能性がある)。
 *
 * ⚠ **YAML は構造として解析していない(文字列で見ている)。** 既存の wiring 歯と
 * 同じ判断で、依存を足していない(js-yaml 等。依存追加はオーナー専権。
 * `docs/autonomy.md`)。**だからこの歯は書き方の変更に弱い。** 壊れたときは
 * 「配線が変わった」か「書き方が変わった」かを見て、**配線が変わっていないなら
 * 取り出し方のほうを直すこと(歯を消さないこと)。**
 *
 * ## 確かめていないこと
 *
 * - ⚠ **段の順序(cache 段が使用段より前に在ること)は測っていない。** この歯は
 *   「同じジョブの中に対になった path/env が存在するか」だけを見ており、
 *   cache 段が使用段より後ろにあっても(キャッシュが効かないだけで)緑のままである。
 * - ⚠ **キャッシュが実際に当たるか(GitHub Actions 側でヒットするか)は測っていない。**
 *   これは静的な配線検査であり、実行時の cache hit/miss は CI の実行結果でしか
 *   分からない。
 * - ⚠ **`${{ github.workspace }}` などの GitHub Actions の式を実際には展開していない。**
 *   両辺が同じ**文字列**であることだけを見ている(この PR の対では両辺とも
 *   `${{ github.workspace }}/.cache/local-embedding` という同一のリテラルなので、
 *   文字列一致で十分)。式の書き方が変わって、同じ場所を指すが文字列としては
 *   異なる式になった場合は、この歯は(誤って)赤くなる——安全側の誤検知である。
 */

const workflowPath = fileURLToPath(new URL("../../.github/workflows/ci.yml", import.meta.url));
const rawWorkflow = readFileSync(workflowPath, "utf8");
const { text: workflow, unhandled: workflowUnhandled } = blankOutWorkflowComments(rawWorkflow);

/**
 * `jobs:` の下にある、すべてのジョブ id を上から順に返す
 * (既存の wiring 歯の `extractJob` が1つのジョブ id を決め打ちで受け取るのに対し、
 * この歯はジョブの集合そのものを動的に知る必要がある——対を持つジョブが
 * 何本あるかをハードコードしないため)。
 *
 * @param {string} yaml
 * @returns {string[]}
 */
function listJobIds(yaml) {
  const lines = yaml.split("\n");
  const jobsAt = lines.findIndex((line) => line === "jobs:");
  if (jobsAt === -1) {
    throw new Error("ci.yml に `jobs:` が無い(トップレベルの構造が変わった)。");
  }
  const ids = [];
  for (let i = jobsAt + 1; i < lines.length; i += 1) {
    const matched = /^ {2}([A-Za-z0-9_-]+):$/.exec(lines[i]);
    if (matched) {
      ids.push(matched[1]);
    }
  }
  return ids;
}

/**
 * `jobs:` の下の1ジョブ(`  <id>:` から、次の同じ深さの `  <id>:` まで)を切り出す
 * (既存の wiring 歯群と同じ形)。
 *
 * @param {string} yaml
 * @param {string} jobId
 */
function extractJob(yaml, jobId) {
  const lines = yaml.split("\n");
  const start = lines.findIndex((line) => line === `  ${jobId}:`);
  if (start === -1) {
    throw new Error(`ci.yml に \`  ${jobId}:\` のジョブが無い(見つからなくなった)。`);
  }
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^ {2}\S/.test(lines[i])) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join("\n");
}

/**
 * ジョブブロックを `steps:` のリストの要素(段)ごとの生テキストへ切り分ける。
 * 各要素は `      - name: ...` の行(6スペース)から、次の同じ形の行の直前まで。
 * `identifier-probes-wiring.test.mjs` の `parseSteps` と違い、この歯は
 * `uses`/`with.path`/`with.key` も見る必要があるため、段の中身を name/env/run に
 * 絞らず、生テキストのまま返す(呼び出し側が正規表現で必要な値だけ拾う)。
 *
 * @param {string} jobBlock
 * @returns {string[]}
 */
function splitSteps(jobBlock) {
  const lines = jobBlock.split("\n");
  const stepsAt = lines.findIndex((line) => line === "    steps:");
  if (stepsAt === -1) {
    throw new Error("ジョブブロックに `    steps:` が無い。");
  }
  /** @type {string[]} */
  const chunks = [];
  /** @type {string[]} */
  let current = [];
  for (let i = stepsAt + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (/^ {6}- name: /.test(line)) {
      if (current.length > 0) {
        chunks.push(current.join("\n"));
      }
      current = [line];
      continue;
    }
    if (current.length > 0) {
      current.push(line);
    }
  }
  if (current.length > 0) {
    chunks.push(current.join("\n"));
  }
  return chunks;
}

/**
 * ジョブブロックの中から、「local-embedding のモデル重みをキャッシュする
 * `actions/cache` 段」を見つけて `{ path, key }` の配列で返す。
 *
 * 🔑 見分け方: `uses: actions/cache@v<N>` を持ち、かつ `with.key` が
 * `local-embedding` で始まる段。⛔ `path:` では見分けない(docstring 参照)。
 *
 * @param {string} jobBlock
 * @returns {{ path: string, key: string }[]}
 */
function localEmbeddingCacheSteps(jobBlock) {
  const steps = splitSteps(jobBlock);
  /** @type {{ path: string, key: string }[]} */
  const result = [];
  for (const step of steps) {
    if (!/^\s*uses: actions\/cache@v\d+\s*$/m.test(step)) {
      continue;
    }
    const keyMatched = /^\s*key:\s*(.+)$/m.exec(step);
    if (!keyMatched) {
      continue;
    }
    const key = keyMatched[1].trim();
    if (!key.startsWith("local-embedding")) {
      // 🔑 このリポジトリの他の `actions/cache` 段(あれば)を巻き込まない。
      continue;
    }
    const pathMatched = /^\s*path:\s*(.+)$/m.exec(step);
    if (!pathMatched) {
      throw new Error(`key: ${key} を持つ actions/cache 段に with.path が無い(段の形が変わった)。`);
    }
    result.push({ path: pathMatched[1].trim(), key });
  }
  return result;
}

/**
 * ジョブブロックの中で設定される `MNEMORA_LOCAL_EMBEDDING_CACHE_DIR` の値をすべて拾う。
 * job-level `env:`(変数は6スペース)・step-level `env:`(変数は10スペース)の
 * どちらでも拾えるよう、インデントの深さを固定しない
 * (行頭からキーまでが空白だけであることのみ要求する)。
 *
 * @param {string} jobBlock
 * @returns {string[]}
 */
function cacheDirEnvValues(jobBlock) {
  return [...jobBlock.matchAll(/^[ \t]*MNEMORA_LOCAL_EMBEDDING_CACHE_DIR:\s*(.+)$/gm)].map(
    (matched) => matched[1].trim(),
  );
}

const jobIds = listJobIds(workflow);

describe("ci.yml の local-embedding cache 配線(Issue #162 F / #164)", () => {
  it("🔴 コメント潰しが「扱えない」形に当たっていない(無視できないAPIにする)", () => {
    expect(workflowUnhandled).toEqual([]);
  });

  it("ジョブが1本以上見つかる(listJobIds の土台が崩れていない)", () => {
    expect(jobIds.length).toBeGreaterThan(0);
  });

  it("⭐ 各ジョブで、local-embedding cache 段の path 集合と MNEMORA_LOCAL_EMBEDDING_CACHE_DIR の値集合が一致する(両向き)", () => {
    for (const jobId of jobIds) {
      const jobBlock = extractJob(workflow, jobId);
      const cachePaths = localEmbeddingCacheSteps(jobBlock).map((step) => step.path);
      const envDirs = cacheDirEnvValues(jobBlock);
      const cachePathSet = [...new Set(cachePaths)].sort();
      const envDirSet = [...new Set(envDirs)].sort();
      expect(
        cachePathSet,
        `${jobId}: cache 段の path 集合(${JSON.stringify(cachePathSet)})と ` +
          `MNEMORA_LOCAL_EMBEDDING_CACHE_DIR の値集合(${JSON.stringify(envDirSet)})が食い違っている`,
      ).toEqual(envDirSet);
    }
  });

  it("⚠ 対を持つジョブが最低2つ在る(空回り防止の下限。対の本数そのものはハードコードしない)", () => {
    // ⛔ `toBe` にしない: 健全な対がこの PR で2組→4組に増えるが、それで
    // 赤くなってはいけない。逆に0組・1組では「本当に測れているか」が
    // 疑わしいので、下限だけを `toBeGreaterThanOrEqual` で固定する。
    const jobsWithCacheStep = jobIds.filter((jobId) => {
      const jobBlock = extractJob(workflow, jobId);
      return localEmbeddingCacheSteps(jobBlock).length > 0;
    });
    expect(jobsWithCacheStep.length).toBeGreaterThanOrEqual(2);
  });

  it("同じ path を指す local-embedding cache 段は、同じ key を持つ(意図的なキー共有を固定する。一意性は要求しない)", () => {
    /** @type {Map<string, Set<string>>} */
    const keysByPath = new Map();
    for (const jobId of jobIds) {
      const jobBlock = extractJob(workflow, jobId);
      for (const { path, key } of localEmbeddingCacheSteps(jobBlock)) {
        if (!keysByPath.has(path)) {
          keysByPath.set(path, new Set());
        }
        keysByPath.get(path)?.add(key);
      }
    }
    for (const [path, keys] of keysByPath) {
      expect(
        [...keys],
        `path: ${path} に対して複数の key が使われている(${[...keys]})`,
      ).toHaveLength(1);
    }
  });
});
