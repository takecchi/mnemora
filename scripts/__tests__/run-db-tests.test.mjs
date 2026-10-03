import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { STAGES } from "../root-test-gate.mjs";
import { spawnSyncWithDeadline } from "./spawn-with-deadline.mjs";

/**
 * `scripts/run-db-tests.mjs`（ルートの `test` 門の DB 段）の歯。
 *
 * **この歯が守っているもの**: 「DB テストが通った」と「DB テストを走らせていない」が
 * 同じ緑になっていた欠陥。区別が付くこと、そして**落ちたときに手元で赤くなること**を測る。
 *
 * 擬似の実行器へ差し替えず、**本物の `scripts/run-db-tests.mjs` を子プロセスとして起動する**。
 * 差し替えると「門が本当に DB テストを呼ぶか」を測れなくなり、この歯の意味が無くなる。
 */

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const gate = fileURLToPath(new URL("../run-db-tests.mjs", import.meta.url));

/**
 * 届かない接続先。**この形の DATABASE_URL では DB テストは必ず落ちる**——
 * 「DB テストが落ちた」状態を、本物の `test:db` を実際に走らせて作るために使う。
 * ポート 1 は接続が即座に拒否されるので、待たされない。
 */
const UNREACHABLE_DATABASE_URL = "postgresql://postgres:postgres@127.0.0.1:1/mnemora_gate_probe";

/**
 * 「門が赤くなる」歯が門に名指しして渡す、`packages/postgres` の DB テストのファイル（パッケージからの相対）。
 * 選んだ理由はその歯のコメントにある（ADR 0579）。
 */
const DB_TEST_FILE = "src/__tests__/contested-with-index.test.ts";

/** 親の DATABASE_URL を歯に持ち込まない（手元に DB が在るかで結果が変わってはいけない）。 */
function envWithout(name) {
  const env = { ...process.env };
  delete env[name];
  return env;
}

function runGate(env, args = []) {
  return spawnSyncWithDeadline(process.execPath, [gate, ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    env,
    // DB に繋がらない構成では DB テストがほぼ全件落ち、その出力が spawnSync の既定の
    // maxBuffer（1 MiB）を超えると子が途中で殺され、末尾の「DB テストが落ちました」が
    // 捕まらない（PR #965 の CI で観測。DB テストが増えるほど出力も増える）。
    maxBuffer: 64 * 1024 * 1024,
  });
}

describe("scripts/run-db-tests.mjs（ルートの test 門の DB 段）", () => {
  it("DATABASE_URL が無いとき: 緑のまま通すが、『実行していない』と分かる", () => {
    const result = runGate(envWithout("DATABASE_URL"));
    const output = `${result.stdout}${result.stderr}`;

    expect(result.status).toBe(0);
    expect(output).toContain("DB テストは実行していません");

    // 何を走らせなかったかが名指しで分かること（数え落としを見つけられる形であること）。
    expect(output).toContain("@mnemora/postgres");
    expect(output).toContain("@mnemora/example-chat");

    // 「通った」と読める文言を出さないこと——ここが、潰してはいけない区別そのもの。
    expect(output).not.toContain("通りました");
  });

  it("DATABASE_URL が在って DB テストが落ちるとき: 門が赤くなる", () => {
    // 門に DB テストのファイルを1本だけ名指しして渡し、各パッケージの `vitest run` をそのファイルだけに絞る。
    // 届かない DB へ全ファイルを走らせると DB テストが増えるほど長くなり（CI で 2026-09-27 の朝 83s → 夕方 118s、
    // `testTimeout` は 180s）、歯の主張には要らない——門は最初に落ちたパッケージで止まるので、
    // 「呼びに行った上で落ちた」「門が赤くなる」を見るには1本落ちれば足りる。
    // ⚠ 以前は `--bail=1` で絞っていたが、vitest 5.0.0 は打ち切りの合図を落ちた結果の報告より先に親へ届けることがあり、
    // そのとき落ちたファイルの名前が出力から消えて、この歯が揺れた（#1680・#1684・#1690 の CI。ADR 0579）。
    // 1ファイルの名指しなら打ち切りが無いので、落ちた結果は必ず報告される。
    // **名指しするのは、DB が無いと走らない本物の DB テストであること。** DB が無くても通るファイルを選ぶと、
    // 落ちた理由が DB でなくなり、「届かない DB へ実際に繋ぎに行って落ちた」の印にならない。
    // `contested-with-index.test.ts` は、どの it も `beforeEach` の `resetTestDatabase()` で DB に触り、
    // `EXPLAIN` を本物の Postgres に撃つ（DB 在りで3本とも緑、`DATABASE_URL` 無しでは `requireDatabaseUrl` が断る）。
    // 改名・削除で消えたら、vitest は「No test files found」で落ち、その文言にもファイル名が出る——下の在ることの検査で先に止める。
    expect(existsSync(`${repoRoot}packages/postgres/${DB_TEST_FILE}`)).toBe(true);
    const result = runGate({ ...process.env, DATABASE_URL: UNREACHABLE_DATABASE_URL }, [
      DB_TEST_FILE,
    ]);
    const output = `${result.stdout}${result.stderr}`;

    // 芯。以前のルート門はこの状況でも緑のままだった。
    expect(result.status).not.toBe(0);

    // 「呼びに行った上で落ちた」ことを確かめる。単に exit 1 する門では、この歯は通らない。
    expect(output).toContain("DB テストを実行します");
    expect(output).toContain("DB テストが落ちました");

    // DB テストが本当に走って、届かない接続先へ実際に繋ぎに行って落ちたこと——門が自分の文言だけを出す形では通らない。
    // ⚠ vitest の集計の行（`Test Files … failed`）では見ない。`--bail=1` で打ち切る時機によって、集計の行は
    // `Test Files   (296)` のように落ちた数を出さないことがある（main e4e27fd の CI で観測。ADR 0465）。
    // 代わりに、vitest が名指しした DB テストのファイルを落ちたと報告する行（`FAIL  src/__tests__/….test.ts`）が出力に在ることを見る。
    // 門は `test:db` を `stdio: "inherit"` で起動するので、子が落ちたテストを報告する行・スタックはここに届く。
    // 門が自分で出すのはパッケージ名と `test:db` だけで、ファイルの名前は出さない。
    // ⚠ ファイルの名前だけでは見ない——名指しした引数は pnpm が `$ vitest run src/__tests__/….test.ts` と書き出すので、
    // DB テストが走らなくても名前は出力に在る（ADR 0579）。vitest の `FAIL` の印と組で見る。
    // ⚠ `ECONNREFUSED 127.0.0.1:1` では見ない——門の接続先の告知（「版を取得できませんでした: connect ECONNREFUSED …」）が
    // 同じ文字列を出すので、門が DB テストを起動しなくても通ってしまう（ADR 0465 の変異で確かめた）。
    // vitest は色の指定（CI の FORCE_COLOR など）で文字の間に ANSI の色の符号を挟むので、外してから見る。
    // `FAIL` と名前の間には vitest の project 名（`packages/postgres/vitest.config.ts` の `postgres-db-parallel`）が入る。
    // 色が無いと `|postgres-db-parallel|`、色が有ると（CI の FORCE_COLOR）色の付いた札になり、色の符号を外すと
    // ` postgres-db-parallel ` になる——両方の形を許す（ADR 0579。CI の最初の run で `|…|` だけを許す形が落ちた）。
    const escapedFile = DB_TEST_FILE.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
    // eslint-disable-next-line no-control-regex
    expect(output.replace(/\x1b\[[0-9;]*m/g, "")).toMatch(
      new RegExp(`FAIL\\s+(?:\\|?[\\w-]+\\|?\\s+)?${escapedFile}`),
    );

    // 未実行の告知と取り違えられないこと。
    expect(output).not.toContain("DB テストは実行していません");

    // **接続先の告知が、この門に実際に配線されていること。**
    // 単体の形は scripts/__tests__/db-server-description.test.mjs が測る。ここで見るのは
    // 「門がそれを呼んでいるか」——呼び出しが外れれば、接続先は再び黙って出なくなる。
    // 届かない DATABASE_URL なので、必ず「取れなかった」側の文言になる。
    expect(output).toContain("版を取得できませんでした");
  });
});

describe("scripts/run-db-tests.mjs の MNEMORA_DB_TESTS_SKIP（CI の root-gate-db-stage だけが使う）", () => {
  it("挙げたパッケージは走らせず、名前を挙げて出す（残りは走らせる）", () => {
    // 届かない DB と --bail=1: 走らせたパッケージは最初の1ファイルで落ちる。落ちたのが example-chat
    // であることが、@mnemora/postgres を走らせなかったことの証拠になる（依存の順で postgres が先に走る）。
    const result = runGate(
      {
        ...process.env,
        DATABASE_URL: UNREACHABLE_DATABASE_URL,
        MNEMORA_DB_TESTS_SKIP: "@mnemora/postgres",
      },
      ["--bail=1"],
    );
    const output = `${result.stdout}${result.stderr}`;

    expect(result.status).not.toBe(0);
    expect(output).toContain("この段では実行しないもの:");
    expect(output).toContain("@mnemora/postgres (test:db、MNEMORA_DB_TESTS_SKIP で外した)");
    expect(output).toContain("DB テストが落ちました（@mnemora/example-chat）");
    expect(output).not.toContain("DB テストが落ちました（@mnemora/postgres）");
  });

  it("test:db を持たない名前が混ざっていたら、何も走らせずに赤にする（綴りの誤り・改名の取り残し）", () => {
    const result = runGate({
      ...process.env,
      DATABASE_URL: UNREACHABLE_DATABASE_URL,
      MNEMORA_DB_TESTS_SKIP: "@mnemora/postgress",
    });
    const output = `${result.stdout}${result.stderr}`;

    expect(result.status).toBe(2);
    expect(output).toContain("test:db を持たないパッケージが在ります: @mnemora/postgress");
    expect(output).not.toContain("DB テストを実行します");
  });

  it("全部外したら、何も走らせずに「通りました」を出す代わりに赤にする", () => {
    const result = runGate({
      ...process.env,
      DATABASE_URL: UNREACHABLE_DATABASE_URL,
      MNEMORA_DB_TESTS_SKIP: "@mnemora/postgres,@mnemora/example-chat",
    });
    const output = `${result.stdout}${result.stderr}`;

    expect(result.status).toBe(2);
    expect(output).toContain("全部外しています");
    expect(output).not.toContain("通りました");
  });
});

describe("ルートの test 門の配線", () => {
  /**
   * 上の2つの歯は DB 段そのものを測る。**段が門に繋がっていること**は別の話で、
   * 繋がりが外れれば DB は再び黙って未実行になる——それが元の欠陥そのものである。
   * だからここで配線を釘付けにする。
   *
   * ⚠ **配線の場所が変わった（Issue #453 / ADR 0210）。** 以前はルートの
   * `package.json` の `test` が `&&` で3段を直接連結しており、この歯もそれを
   * `split("&&")` して検査していた。いまは `package.json` の `test` は
   * `node scripts/run-root-test-gate.mjs` を呼ぶだけで、3段の配線は
   * `scripts/run-root-test-gate.mjs` の中に在る（前段の成否に関わらず全部
   * 起動するため、shell の `&&` では表現できない）。⟹ **検査対象をそちらへ移す。**
   */
  it("ルートの test は run-root-test-gate.mjs を呼ぶ", () => {
    const manifest = JSON.parse(
      readFileSync(fileURLToPath(new URL("../../package.json", import.meta.url)), "utf8"),
    );
    expect(manifest.scripts.test).toBe("node scripts/run-root-test-gate.mjs");
  });

  /**
   * ⛔ **ソースを文字列として読んで語の並び順を見る形にしないこと。**
   * `run-root-test-gate.mjs` の冒頭コメントには3段が同じ順で表になって書いてあるので、
   * `indexOf` で順序を測ると**コードを並べ替えても緑のまま**になる。
   * ⟹ 配線の実体（`STAGES`）を import して、そのものを測る。
   */
  it("門は、vitest → pnpm -r --no-bail run test → run-db-tests.mjs の順に3段を起動する", () => {
    const commandLines = STAGES.map((stage) => [stage.command, ...stage.args].join(" "));

    expect(commandLines).toEqual([
      "pnpm exec vitest run",
      "pnpm -r --if-present --no-bail run test",
      "node scripts/run-db-tests.mjs",
    ]);
  });

  it("段2には --no-bail が在る（1パッケージ落ちても残りのパッケージを起動し続ける）", () => {
    const packageStage = STAGES.find((stage) => stage.args.includes("-r"));

    expect(packageStage?.args).toContain("--no-bail");
  });
});
