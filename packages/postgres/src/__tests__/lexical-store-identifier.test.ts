import { writeFileSync } from "node:fs";
import type { Ctx } from "@mnemora/core";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { buildNewMemoryFixture } from "@mnemora/testkit";
import { PostgresMemoryStore } from "../memory-store.js";
import { PostgresLexicalStore } from "../lexical-store.js";
import { closeTestClient, getTestClient, resetTestDatabase } from "./test-db.js";

/**
 * `scripts/lexical-regime-summary.mjs`（CI の Job Summary へ載せる側）が読む機械可読な JSON の形。この型はこのファイルにしか無い
 * （`scripts/` 側は素の `.mjs` で import できないので、二重管理であることを認めて書く）。
 * `scripts/__tests__/ci-yml-postgres-regime-wiring.test.mjs` がこのファイルのソースを文字列として読み、`MNEMORA_LEXICAL_REGIME_JSON` への参照が消えていないことを固定している。
 *
 * `lc_collate` / `lc_ctype` / `default_text_search_config` は、ロケールが `nonAsciiIsIndexed` に効くかどうかをまだ測っていないので、測るだけにして ci.yml では宣言していない。
 * 次にロケールを宣言するなら、この実測値を見てからにする。
 */
interface LexicalRegimeJson {
  schemaVersion: number;
  measuredAt: string;
  serverVersion: string;
  serverEncoding: string;
  nonAsciiIsIndexed: boolean;
  rawTsvector: string;
  rawIdentifierHit: boolean;
  rawJapaneseWordHit: boolean;
  /** 歯が実際に通った分岐。⛔ 固定しない——両方が起こり得る。 */
  regime: "non_ascii_indexed" | "non_ascii_dropped";
  /** 測るだけで、まだ ci.yml では宣言していない。 */
  lcCollate: string;
  /** 測るだけで、まだ ci.yml では宣言していない。 */
  lcCtype: string;
  /** 測るだけで、まだ ci.yml では宣言していない。 */
  defaultTextSearchConfig: string;
}

/**
 * 日本語の文に埋め込まれた `PROJ-1234` のような識別子を、`mnemora_lexical_normalize` を通した索引式・クエリ式でなら引けること。この主張は `server_encoding` に依らない。
 * まずそれを索引式ではなく `PostgresLexicalStore.search`（本体のクエリ経路）で確認する。
 *
 * ⚠ 「素の `to_tsvector` では引けない」という否定は、このファイルの前提ではない。その否定は `server_encoding` で反転する。
 * 最後の2本が、「実装が動くこと」と「正規化が要る理由」を別々の歯に分けて引き受ける。
 *
 * ⚠ 偽陽性の点検: このフィクスチャは意図的に `PROJ-1234`/`PROJ-5678`/`TASK-1234` という似た識別子を複数用意し、識別子を `content` に置かず `tags` にだけ置いた decoy も用意する。
 * `search` が実際に見るのは `content` 列だけなので、decoy が返らないことで、緑になった経路が `content` の語彙一致以外ではないことを別立てで示す。
 */

const TENANT = "lexical-identifier-tenant";

describe("PostgresLexicalStore.search — 日本語の文に埋め込まれた識別子を引ける", () => {
  beforeEach(async () => {
    await resetTestDatabase();
  });

  afterAll(async () => {
    await closeTestClient();
  });

  it("PROJ-1234 で引くと、日本語の文に埋め込まれた PROJ-1234 だけが見つかる（PROJ-5678 / TASK-1234 / tags だけの decoy は誤爆しない）", async () => {
    const { db } = await getTestClient();
    const memoryStore = new PostgresMemoryStore(db);
    const lexicalStore = new PostgresLexicalStore(db);
    const ctx: Ctx = { tenantId: TENANT };

    const target = await memoryStore.createMemory(
      ctx,
      buildNewMemoryFixture({
        tenantId: TENANT,
        contentHash: "hash-target",
        content: "四半期レビューでPROJ-1234の納期が来週まで延びました",
      }),
    );
    const similarNumber = await memoryStore.createMemory(
      ctx,
      buildNewMemoryFixture({
        tenantId: TENANT,
        contentHash: "hash-similar-number",
        content: "サブシステムの担当はPROJ-5678の方です",
      }),
    );
    const similarPrefix = await memoryStore.createMemory(
      ctx,
      buildNewMemoryFixture({
        tenantId: TENANT,
        contentHash: "hash-similar-prefix",
        content: "TASK-1234はまだ着手していません",
      }),
    );
    // decoy: 識別子は tags にだけ置き、content には置かない。search が content 以外の列を見ていたら誤ってこれも返ってしまう。
    const tagsOnlyDecoy = await memoryStore.createMemory(
      ctx,
      buildNewMemoryFixture({
        tenantId: TENANT,
        contentHash: "hash-tags-only-decoy",
        content: "サーバー移行の計画について話し合いました",
        tags: ["PROJ-1234"],
      }),
    );

    const hits = await lexicalStore.search(ctx, "PROJ-1234", {
      limit: 10,
      filter: { tenantId: TENANT },
    });
    const ids = hits.map((hit) => hit.memoryId);

    expect(ids).toContain(target.id);
    expect(ids).not.toContain(similarNumber.id);
    expect(ids).not.toContain(similarPrefix.id);
    expect(ids).not.toContain(tagsOnlyDecoy.id);
    expect(ids).toEqual([target.id]);
  });

  /**
   * クエリ側にも `mnemora_lexical_normalize` を通すと、日本語の残り全体が1語彙になって AND で結ばれ、報告者が書く形の問い（自然文 + 識別子）が1件も引けない。
   * 識別子だけを渡す歯はこれを通すので、自然文の形で引けることと、識別子だけ差し替えた否定側（PROJ-5678 を含む文が返らないこと）で偽陽性でないことを見る。
   */
  it("報告者が実際に投げる形の問い（日本語の自然文 + 識別子）でも引ける", async () => {
    const { db } = await getTestClient();
    const memoryStore = new PostgresMemoryStore(db);
    const lexicalStore = new PostgresLexicalStore(db);
    const ctx: Ctx = { tenantId: TENANT };

    const target = await memoryStore.createMemory(
      ctx,
      buildNewMemoryFixture({
        tenantId: TENANT,
        contentHash: "hash-nl-target",
        content: "四半期レビューでPROJ-1234の納期が来週まで延びました",
      }),
    );
    const other = await memoryStore.createMemory(
      ctx,
      buildNewMemoryFixture({
        tenantId: TENANT,
        contentHash: "hash-nl-other",
        content: "サブシステムの担当はPROJ-5678の方です",
      }),
    );

    const hits = await lexicalStore.search(ctx, "PROJ-1234について前に何か言ってたっけ？", {
      limit: 10,
      filter: { tenantId: TENANT },
    });

    expect(hits.map((hit) => hit.memoryId)).toEqual([target.id]);
    expect(hits.map((hit) => hit.memoryId)).not.toContain(other.id);
  });

  /** `websearch_to_tsquery` を `plainto_tsquery` に落とすと隣接を要求しない AND になり、識別子を2つ含む本文で片方の接頭辞ともう片方の番号の組み合わせが偽陽性で一致する。 */
  it("識別子を2つ含む本文に対して、接頭辞と番号を取り違えた識別子は一致しない（plainto_tsquery に落とすと赤くなる）", async () => {
    const { db } = await getTestClient();
    const memoryStore = new PostgresMemoryStore(db);
    const lexicalStore = new PostgresLexicalStore(db);
    const ctx: Ctx = { tenantId: TENANT };

    await memoryStore.createMemory(
      ctx,
      buildNewMemoryFixture({
        tenantId: TENANT,
        contentHash: "hash-two-identifiers",
        content: "本日の連携: PROJ-1234 and TASK-5678 の両方を確認しました",
      }),
    );

    const hits = await lexicalStore.search(ctx, "PROJ-5678", {
      limit: 10,
      filter: { tenantId: TENANT },
    });
    expect(hits).toEqual([]);

    // 対照: 本文に実在する組み合わせは、同じ経路でちゃんと引ける（この歯が「常に0件」で緑になっているのではないことを示す）。
    const present = await lexicalStore.search(ctx, "TASK-5678", {
      limit: 10,
      filter: { tenantId: TENANT },
    });
    expect(present).toHaveLength(1);
  });

  /**
   * 上の3本が `PostgresLexicalStore.search`（配線ごと）で見ているのに対し、ここでは本番の索引式とクエリ式そのものを SQL で直接当てる。
   * 式を手で写すとずれるので、本文側も `mnemora_lexical_tsvector($1)` を関数として呼ぶ（索引式が変わった後にこの歯だけが古い式を測り続けることを防ぐ）。
   * この歯は環境（`server_encoding`）に依らない。これが赤くなったなら、疑うのは実装のほうである。
   */
  it("本番の索引式とクエリ式なら、日本語の文に埋め込まれた識別子を引ける（server_encoding に依らない）", async () => {
    const { pool } = await getTestClient();
    const content = "四半期レビューでPROJ-1234の納期が来週まで延びました";

    // 誤爆側は、識別子を2つ含む本文で測る。隣接（'proj' <-> '-5678'）を落とすと別々の位置で拾われて偽陽性になる本文であり、単一の識別子しか無い本文ではこの主張は自明に成り立って何も測らない。
    const twoIdentifiers = "本日の連携: PROJ-1234 and TASK-5678 の両方を確認しました";
    const result = await pool.query(
      `SELECT mnemora_lexical_tsvector($1)
                @@ mnemora_lexical_query_or($2) AS "hit",
              mnemora_lexical_tsvector($3)
                @@ mnemora_lexical_query_or($4) AS "falsePositive"`,
      [content, "PROJ-1234", twoIdentifiers, "PROJ-5678"],
    );
    const row = result.rows[0] as { hit: boolean; falsePositive: boolean };

    expect(
      row.hit,
      "本番の索引式・クエリ式が PROJ-1234 を引けなかった。この主張は server_encoding に" +
        "依らないことを実測してある（ADR 0103）——⟹ 疑うのは mnemora_lexical_normalize / " +
        "mnemora_lexical_query_or の実装のほうであって、環境ではない。",
    ).toBe(true);
    expect(
      row.falsePositive,
      "本文のどこにも無い PROJ-5678 が、PROJ-1234 と TASK-5678 を含む本文に一致した。" +
        "誤爆を防いでいるのは正規化ではなく検索側の隣接演算子（'proj' <-> '-5678'）である" +
        "——mnemora_lexical_query_tsqueries が websearch_to_tsquery を使っているかを見ること" +
        "（migrations/0008 と 0009 の doc）。",
    ).toBe(false);
  });

  /**
   * この歯が守っているのは「実装が正しいこと」ではなく、`mnemora_lexical_normalize` が要る理由そのものである。そしてその理由は、どの環境でも同じ形では成り立たない。
   * 素の `to_tsvector('simple', …)` が日本語の文に埋め込まれた識別子を引けるかどうかは、`server_encoding` で反転する
   * （UTF8 では引けない、SQL_ASCII / LATIN1 では引けてしまう。版・ビルド・ロケールではなく `server_encoding` が軸）。
   *
   * だからこの歯は、自分が置いている前提を先に測って名乗る。前提が破れている環境では反対側の結論を主張し、
   * どちらの分岐でも「日本語の語そのものは素の経路で引けない」ことを、regime に依らない錨として最後に置く。
   *
   * ⛔ この歯を「環境依存だから」と消さないこと。消すと、`mnemora_lexical_normalize` が要る理由そのものが repo から消える。
   *
   * 測った regime は、緑のときにも読めるようにする。`MNEMORA_LEXICAL_REGIME_JSON` が設定されていたら、そのパスへ測った値を機械可読な JSON（`LexicalRegimeJson`）として書く。
   * 書くのは `expect` より前で、歯がどちらの側で赤くなっても、測った値そのものは残る。
   *
   * ⛔ 環境変数が無いときは何も書かない。
   * ⛔ この JSON 書き込みは、下の3本の `expect` を1つも弱めない。分岐はどちらにも固定していない・`it.skip` にもしていない。書いているのは実際に測った値である。
   */
  it("素の to_tsvector で識別子を引けるかどうかは server_encoding で反転する（歯が自分の前提を測って名乗る）", async () => {
    const { pool } = await getTestClient();
    const content = "四半期レビューでPROJ-1234の納期が来週まで延びました";

    const probe = await pool.query(
      `SELECT current_setting('server_version')  AS "version",
              current_setting('server_encoding') AS "encoding",
              length(to_tsvector('simple', '日本語')) > 0 AS "nonAsciiIsIndexed",
              to_tsvector('simple', $1)::text AS "rawTsvector",
              to_tsvector('simple', $1) @@ websearch_to_tsquery('simple', $2) AS "rawIdentifierHit",
              to_tsvector('simple', $1) @@ websearch_to_tsquery('simple', $3) AS "rawJapaneseWordHit",
              -- PostgreSQL 16 で lc_collate / lc_ctype は GUC ではなくなり、DB ごとの
              -- 属性になった。GUC として引くと 42704 unrecognized configuration
              -- parameter で落ちる（PR #151 の CI が pg17 で実際に落ちた。2026-09-12）。
              -- そこで pg_database から引く。GUC 経由へ戻さないこと。
              (SELECT datcollate FROM pg_database WHERE datname = current_database()) AS "lcCollate",
              (SELECT datctype   FROM pg_database WHERE datname = current_database()) AS "lcCtype",
              current_setting('default_text_search_config') AS "defaultTextSearchConfig"`,
      [content, "PROJ-1234", "レビュー"],
    );
    const row = probe.rows[0] as {
      version: string;
      encoding: string;
      nonAsciiIsIndexed: boolean;
      rawTsvector: string;
      rawIdentifierHit: boolean;
      rawJapaneseWordHit: boolean;
      lcCollate: string;
      lcCtype: string;
      defaultTextSearchConfig: string;
    };

    // `expect` より前に書く。歯がこの後どちらの分岐で赤くなっても、測った値そのものは CI の成果物として残る。
    const regimeJsonPath = process.env.MNEMORA_LEXICAL_REGIME_JSON;
    if (regimeJsonPath) {
      const regimeJson: LexicalRegimeJson = {
        schemaVersion: 2,
        measuredAt: new Date().toISOString(),
        serverVersion: row.version,
        serverEncoding: row.encoding,
        nonAsciiIsIndexed: row.nonAsciiIsIndexed,
        rawTsvector: row.rawTsvector,
        rawIdentifierHit: row.rawIdentifierHit,
        rawJapaneseWordHit: row.rawJapaneseWordHit,
        regime: row.nonAsciiIsIndexed ? "non_ascii_indexed" : "non_ascii_dropped",
        lcCollate: row.lcCollate,
        lcCtype: row.lcCtype,
        defaultTextSearchConfig: row.defaultTextSearchConfig,
      };
      writeFileSync(regimeJsonPath, `${JSON.stringify(regimeJson, null, 2)}\n`, "utf8");
    }

    const observed =
      `【この環境の実測】server_version=${row.version} / server_encoding=${row.encoding} / ` +
      `非ASCIIが語彙として残るか=${row.nonAsciiIsIndexed} / ` +
      `to_tsvector('simple', 本文)=${row.rawTsvector} / ` +
      `lc_collate=${row.lcCollate} / lc_ctype=${row.lcCtype} / ` +
      `default_text_search_config=${row.defaultTextSearchConfig}`;

    if (row.nonAsciiIsIndexed) {
      expect(
        row.rawIdentifierHit,
        "素の to_tsvector が PROJ-1234 を引けてしまった。" +
          "⚠ ここで疑うのは mnemora_lexical_normalize の実装ではなく、この歯が置いている" +
          "前提のほうである。この分岐は「素の parser が非ASCIIを語の文字として扱い、隣の " +
          "ASCII と癒着した1語にする」regime でだけ成り立つ。前提が破れたなら、正規化が" +
          "要る理由はこの環境では別の形をしている（ADR 0103 / Issue #145 を読むこと）。" +
          `${observed}`,
      ).toBe(false);
    } else {
      expect(
        row.rawIdentifierHit,
        "素の to_tsvector が PROJ-1234 を引けなかった。" +
          "⚠ ここで疑うのは実装ではなく、この歯が置いている前提のほうである。" +
          "この環境は非ASCIIが語彙として一切残らない regime（SQL_ASCII / LATIN1 など）であり、" +
          "日本語が丸ごと落ちた結果 'proj' と '-1234' が隣接して残るため、素の経路でも" +
          "引けるはずだった。引けなかったなら parser の非ASCIIの扱いが実測時と変わっている" +
          `（ADR 0103 / Issue #145 を読むこと）。${observed}`,
      ).toBe(true);
    }

    expect(
      row.rawJapaneseWordHit,
      "素の to_tsvector が日本語の語『レビュー』を引けてしまった。これは上の2つの regime の" +
        "**どちらでも false になる**ことを実測した不変である（UTF8 側では文ごと1語に癒着し、" +
        "SQL_ASCII 側では非ASCIIが丸ごと落ちる——引けない理由が違うだけで、引けないことは同じ）。" +
        "true になったなら、素の parser の日本語の扱いそのものが変わっている" +
        `——Issue #139 の根が動いた可能性がある。${observed}`,
    ).toBe(false);
  });
});

describe("PostgresLexicalStore.search — Unicode正規化・全角半角は一致に効かない（Issue #952、docs/recall.md §3 の表）", () => {
  beforeEach(async () => {
    await resetTestDatabase();
  });

  afterAll(async () => {
    await closeTestClient();
  });

  const UNICODE_TENANT = "lexical-unicode-normalization-tenant";
  const CAFE_NFC = "café";
  const CAFE_NFD = "café";

  it("café（NFC）を書き、café（NFD）で引くと一致しない（表1行目）", async () => {
    const { db } = await getTestClient();
    const memoryStore = new PostgresMemoryStore(db);
    const lexicalStore = new PostgresLexicalStore(db);
    const ctx: Ctx = { tenantId: UNICODE_TENANT };

    await memoryStore.createMemory(
      ctx,
      buildNewMemoryFixture({
        tenantId: UNICODE_TENANT,
        contentHash: "cafe-nfc-write",
        content: CAFE_NFC,
      }),
    );

    const hits = await lexicalStore.search(ctx, CAFE_NFD, {
      limit: 10,
      filter: { tenantId: UNICODE_TENANT },
    });

    expect(hits).toEqual([]);
  });

  it("全角ＡＢＣを書き、半角ABCで引くと一致しない（表2行目）", async () => {
    const { db } = await getTestClient();
    const memoryStore = new PostgresMemoryStore(db);
    const lexicalStore = new PostgresLexicalStore(db);
    const ctx: Ctx = { tenantId: UNICODE_TENANT };

    await memoryStore.createMemory(
      ctx,
      buildNewMemoryFixture({
        tenantId: UNICODE_TENANT,
        contentHash: "zenkaku-abc-write",
        content: "ＡＢＣ",
      }),
    );

    const hits = await lexicalStore.search(ctx, "ABC", {
      limit: 10,
      filter: { tenantId: UNICODE_TENANT },
    });

    expect(hits).toEqual([]);
  });

  it("café（NFD、結合文字）を書き、cafe（無アクセントASCII）で引くと一致する（表3行目）", async () => {
    const { db } = await getTestClient();
    const memoryStore = new PostgresMemoryStore(db);
    const lexicalStore = new PostgresLexicalStore(db);
    const ctx: Ctx = { tenantId: UNICODE_TENANT };

    const memory = await memoryStore.createMemory(
      ctx,
      buildNewMemoryFixture({
        tenantId: UNICODE_TENANT,
        contentHash: "cafe-nfd-write",
        content: CAFE_NFD,
      }),
    );

    const hits = await lexicalStore.search(ctx, "cafe", {
      limit: 10,
      filter: { tenantId: UNICODE_TENANT },
    });

    expect(hits).toHaveLength(1);
    expect(hits[0]?.memoryId).toBe(memory.id);
  });

  it("café（NFC）を書き、cafe（無アクセントASCII）で引くと一致しない（表4行目）", async () => {
    const { db } = await getTestClient();
    const memoryStore = new PostgresMemoryStore(db);
    const lexicalStore = new PostgresLexicalStore(db);
    const ctx: Ctx = { tenantId: UNICODE_TENANT };

    await memoryStore.createMemory(
      ctx,
      buildNewMemoryFixture({
        tenantId: UNICODE_TENANT,
        contentHash: "cafe-nfc-vs-ascii-write",
        content: CAFE_NFC,
      }),
    );

    const hits = await lexicalStore.search(ctx, "cafe", {
      limit: 10,
      filter: { tenantId: UNICODE_TENANT },
    });

    expect(hits).toEqual([]);
  });
});
