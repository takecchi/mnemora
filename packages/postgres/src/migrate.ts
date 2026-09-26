import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { Pool, PoolClient } from "pg";
import { DEFAULT_MIGRATIONS_DIR } from "./migrations-dir.cjs";
import {
  AdvisoryLockTimeoutError,
  AdvisoryLockUnavailableError,
  DEFAULT_LOCK_TIMEOUT_MS,
  acquireAdvisoryLock,
  acquireAdvisoryLockOnClient,
  deriveAdvisoryLockKey,
  releaseAdvisoryLock,
  releaseAdvisoryLockOnClient,
} from "./advisory-lock.js";
import {
  DEFAULT_EXTENSION_SCHEMA,
  type SchemaNamespaceOptions,
  assertSafeSchemaName,
  qualifiedLiteral,
  qualify,
  searchPathFor,
} from "./schema-namespace.js";

/**
 * `packages/postgres` の唯一のマイグレーション実行口（ADR 0001・docs/memory-model.md §10「規約」）。
 *
 * ベクトル索引を含むスキーマ全体の DDL は `migrations/*.sql` に手書きで置き、
 * `drizzle-kit push` には一切頼らない。適用順は `readdirSync` のファイル名の
 * 昇順（`0001_`, `0002_`, ... という接頭辞で決める）で固定する。
 *
 * 埋め込み空間ごとのテーブル（`memory_embeddings_<space>`）はここでは作らない。
 * `docs/memory-model.md` §10 が「埋め込み空間を登録する操作の一部としてテーブルを作る」と
 * 書いている通り、空間ごとのテーブルは `registerEmbeddingSpace`（`./vector-space.ts`）が
 * 個別に、しかし同じ「手書きの DDL・drizzle-kit を使わない」という規約の下で作る。
 */

/**
 * `migrations/*.sql` の既定のディレクトリ。
 *
 * **解決は `./migrations-dir.cts`（CommonJS）へ追い出してある**——ここで
 * `import.meta.url` を使うと、CommonJS へ変換するテストランナーから
 * `@mnemora/postgres` を読み込めなくなるため（Issue #110）。理由と、採らなかった案は
 * `./migrations-dir.cts` の doc に書いてある。ここから再 export しているので、
 * **使う側の import の書き方は1文字も変わらない。**
 */
export { DEFAULT_MIGRATIONS_DIR };

interface AppliedMigration {
  name: string;
}

/**
 * `runMigrations` がプロセス間排他に使う advisory lock のキー（段階2・ADR 0017）。
 *
 * `pg_advisory_lock` のキー空間は**データベース全体で共有**される——アプリケーションが
 * 別の用途で同じ整数をキーに使えば干渉する（衝突しても検出できず、無関係な処理同士が
 * 互いをブロックする）。衝突の確率を実用上無視できる水準まで下げるため、固定文字列
 * `"mnemora:runMigrations:advisory-lock"` の SHA-256 先頭8バイトを符号付き64bit整数として
 * 解釈した値を、**実行時に変わらない定数**としてハードコードしてある
 * （`node -e 'const c=require("crypto");console.log(c.createHash("sha256").update("mnemora:runMigrations:advisory-lock").digest().readBigInt64BE(0).toString())'`
 * で再計算できる。値そのものに意味は無く、衝突回避のためだけに存在する）。
 *
 * 値を変えると、**新旧のプロセスが違うキーで別々にロックを取り、排他が効かなくなる**
 * ため、ローリングデプロイ中の互換性が壊れる。変える理由が生まれたら ADR を書くこと。
 */
export const MIGRATION_LOCK_KEY = 7190158676462701299n;

/**
 * 拡張（`REQUIRED_EXTENSIONS`）を作る段だけを直列化する、**schema に依らない共有の**
 * advisory lock キー（Issue #757）。
 *
 * ## 直している壊れ方
 *
 * `pg_extension` の一意制約 `pg_extension_name_index` は **`extname` 単独**に張られている
 * ——拡張は `search_path`/`schema` に関わらず**データベース全体に1つ**しか置けない
 * （ADR 0057 の測定表）。一方 {@link migrationLockKeyFor} は ADR 0057 決定6により
 * `schema` ごとに**別の**キーを返す。そのため、schema の違う `runMigrations` を
 * 同じ（まっさらな）DB へ同時に流すと、互いの schema ロックは異なるので待ち合わず、
 * `CREATE EXTENSION IF NOT EXISTS` 同士が `pg_extension_name_index` で衝突して
 * どちらかが決定的に落ちる（Issue #757 の実測: 未指定+指定s1・指定s1+指定s2 とも
 * 25/25 失敗）。
 *
 * ## このキーが守る範囲
 *
 * **「拡張を作る段」だけ**をこのキーで直列化する。schema ごとの排他
 * （{@link migrationLockKeyFor} が返すキー）はそのまま残す——このキーはそれに
 * *追加で*取る、2本目のロックである。取得順は常に「schema ごとのロック
 * （既にこの関数の外側、`runMigrations` の冒頭で取得済み）→ この共有拡張ロック」
 * で固定してある。**逆順で取る経路は無い**（デッドロックを避けるため、意図的に
 * 一方向にしてある）。
 *
 * ⚠ **新しい接続は借りない。** schema ロックを保持している `lockClient` の**同じ
 * セッション**上で、`pg_advisory_lock`/`pg_advisory_unlock` をもう1回撃つだけ
 * （{@link acquireAdvisoryLockOnClient} / {@link releaseAdvisoryLockOnClient}）。
 * 同一セッションが異なるキーの advisory lock を複数同時に保持することは
 * PostgreSQL の仕様上問題ない。**新しい接続を pool から借りる実装を最初に試したが、
 * `runMigrations` が同時に必要とする接続数が2本から3本に増え、`max: 2` で書かれた
 * 既存の並行テスト（`migrate-concurrency.test.ts` 等）が接続を使い切ってデッドロック
 * （3本目の `pool.connect()` が誰にも解決されないまま待ち続ける）することを実測して
 * 差し戻した。**この実装なら `runMigrations` が同時に使う接続数は今日と同じ2本のまま
 * （schema ロック用の `lockClient` 1本 + 個々のクエリ・マイグレーションのトランザクション
 * 用にその都度借りる1本）。
 *
 * `extensionMode: "create"`（既定）のときだけ使う。`"verify"` は `CREATE EXTENSION` を
 * 一切発行しないので、このキーも一切参照しない。
 *
 * ## 定常状態への影響
 *
 * `schema` を指定した経路は、既存の `CREATE EXTENSION ... WITH SCHEMA` ループの前後
 * だけこのロックを持つ（ループはオートコミットの単発クエリの並びなので、ループの前後で
 * 取得・解放すれば足りる）。`schema` 未指定の経路は、拡張が `migrations/0001_init.sql`
 * の本文（トランザクション内）で作られるため、**未適用のファイルのうち
 * `CREATE_EXTENSION_LINE_PATTERN` に一致する行を含むものを適用する間だけ**、
 * トランザクション開始前から `COMMIT` の直後まで持つ。2回目以降の呼び出しでは
 * 該当ファイルが既に適用済みでループに入らないため、**このロックは一切取得されない**
 * ——`runMigrations` が定常状態で発行する SQL は今日と1文字も変わらない
 * （新しい ADR の「決定2との関係」参照）。
 *
 * `MIGRATION_LOCK_KEY` / `REGISTER_EMBEDDING_SPACE_LOCK_KEY` と衝突しない値を選んである
 * （固定文字列 `"mnemora:runMigrations:extension-lock"` の SHA-256 先頭8バイトを
 * 符号付き64bit整数として解釈した値——導出手順は両定数と同一。
 * `node -e 'const c=require("crypto");console.log(c.createHash("sha256").update("mnemora:runMigrations:extension-lock").digest().readBigInt64BE(0).toString())'`
 * で再計算できる）。値そのものに意味は無く、衝突回避のためだけに存在する。
 *
 * `MIGRATION_LOCK_KEY` と同じ理由で、値を変えるとローリングデプロイ中の互換性が壊れる
 * ——変える理由が生まれたら ADR を書くこと。**テスト用の上書き口（`options.lockKey`）は
 * 持たない**——`options.lockKey` は schema ごとのロックだけに効く（doc は
 * {@link RunMigrationsOptions.lockKey} 参照）。この共有ロックは常にこの定数を使う。
 */
export const EXTENSION_LOCK_KEY = -1670586062650017388n;

/**
 * `REQUIRED_EXTENSIONS` を要求する DDL は `migrations/0001_init.sql` にも
 * `CREATE EXTENSION IF NOT EXISTS ...` として存在する（二重管理）。
 *
 * ⚠ **この二重管理は意図的に許してある。** `0001_init.sql` は「まっさらな DB へ
 * 素の `search_path`（`public` 任せ）で流す」経路の一部としてすでに拡張を要求しており、
 * ここでの `REQUIRED_EXTENSIONS` は「専用スキーマを指定したときだけ、拡張を
 * `extensionSchema` へ事前に用意する」という**別の経路**のために存在する——どちらか
 * 一方だけに統合すると、統合しなかった側の経路が壊れる。ずれたら検出できるよう、
 * `schema-namespace.test.ts` に `migrations/*.sql` の `CREATE EXTENSION` 行の集合と
 * この配列の集合が一致することを検査する歯を置いてある。
 */
export const REQUIRED_EXTENSIONS = ["vector", "btree_gin", "pgcrypto"] as const;

/**
 * `migrations/*.sql` 本文の中の「`CREATE EXTENSION IF NOT EXISTS <name>;` だけの行」に
 * 一致する正規表現のパターン文字列（フラグは付けない。使う側で毎回 `new RegExp(...)` する）。
 *
 * `schema-namespace.test.ts`「`REQUIRED_EXTENSIONS` と `migrations/*.sql` の突き合わせ」の歯と、
 * 下の {@link matchCreateExtensionLines} / {@link stripCreateExtensionStatements}
 * （`extensionMode: "verify"` 用、ADR 0093）が、この1つの抽出規則を共有する。
 * 正規表現を書き写すと片方だけ直して他方を直し忘れるということが起き得るため
 * （`schema-namespace.ts` の `assertSafeSchemaName` の doc と同じ理由）。
 *
 * `g` フラグ付きの `RegExp` インスタンスは呼ぶたびに `new RegExp(...)` で作り直すこと
 * ——`lastIndex` を共有すると呼び出し順序に結果が依存する壊れ方をする。
 */
const CREATE_EXTENSION_LINE_PATTERN =
  "^[ \\t]*CREATE EXTENSION IF NOT EXISTS[ \\t]+(\\S+?);[ \\t]*\\r?\\n?";

/**
 * `migrations/*.sql` 本文から `CREATE EXTENSION IF NOT EXISTS <name>;` 単体行をすべて抽出する。
 * 一致条件は「行頭（前後の空白は許す）から始まり `;` で終わるその行そのもの」。
 * 現状の `migrations/*.sql`（`0001_init.sql` の3行のみ）の書き方に厳密に合わせてある
 * ——複数の `CREATE EXTENSION` を1行にまとめる、コメントと同居させる、といった書き方は
 * 対象外（そのような行は今のところ存在しない。増えたらこの関数もそのぶん拡張すること）。
 */
export function matchCreateExtensionLines(
  sql: string,
): Array<{ readonly line: string; readonly name: string }> {
  const re = new RegExp(CREATE_EXTENSION_LINE_PATTERN, "gim");
  return Array.from(sql.matchAll(re), (m) => ({ line: m[0], name: m[1]! }));
}

/**
 * `extensionMode: "verify"`（ADR 0093）専用。`sql` から `CREATE EXTENSION` の行を取り除いた
 * 本文を返す。
 *
 * **`migrations/*.sql` のファイル自体は書き換えない。** 出荷済みマイグレーションの本文を
 * 編集することは ADR 0057「採らなかった案」・ADR 0001 の規約（手書き SQL を正本にする）に
 * 触れる——`_mnemora_migrations` 台帳はファイル名だけで適用済みを判定するため、内容を
 * 書き換えても既適用の DB では再実行されず、実行済み内容と正本がずれるだけになる。
 * ここでは**実行時にだけ**、この関数を通した後の文字列を流す。ファイルは1バイトも変わらない。
 */
export function stripCreateExtensionStatements(sql: string): {
  readonly sql: string;
  readonly removed: readonly string[];
} {
  const removed = matchCreateExtensionLines(sql).map((m) => m.name);
  const stripped = sql.replace(new RegExp(CREATE_EXTENSION_LINE_PATTERN, "gim"), "");
  return { sql: stripped, removed };
}

/**
 * 拡張（`REQUIRED_EXTENSIONS`）の用意のしかた（ADR 0093）。
 *
 * - `"create"`（既定）: 今日どおり `CREATE EXTENSION IF NOT EXISTS` を発行する。
 *   `extensionMode` を一切指定しない呼び出しと1バイトも変わらない。
 * - `"verify"`: `CREATE EXTENSION` を一切発行しない。代わりに `pg_extension` を読み、
 *   `REQUIRED_EXTENSIONS` がすべて既に存在することだけを確認する。1つでも無ければ
 *   {@link MissingExtensionsError} を投げる（黙って先へ進み、後段で意味の分からない
 *   エラーになることを避ける——`CREATE EXTENSION` 権限を持たないロールで接続する
 *   導入者のための口。動機は ADR 0093）。
 */
export type ExtensionMode = "create" | "verify";

/**
 * `extensionMode: "verify"` で、`REQUIRED_EXTENSIONS` のいずれかが `pg_extension` に
 * 見当たらなかったことを表す。
 *
 * **「検査していない」（`extensionMode` 省略 = `"create"`）・「検査したが無かった」
 * （このエラー）・「在った」（例外を投げずに完了する）の3状態を呼び出し側が区別できること**
 * が ADR 0093 の要求。メッセージには足りない拡張の名前と、呼び出し側の DBA がそのまま
 * 実行できる `CREATE EXTENSION` 文を具体的に書く。
 */
export class MissingExtensionsError extends Error {
  /** `pg_extension` に見当たらなかった拡張名（`REQUIRED_EXTENSIONS` の部分集合）。 */
  readonly missing: readonly string[];

  constructor(missing: readonly string[], extensionSchema: string | undefined) {
    const withSchema = extensionSchema !== undefined ? ` WITH SCHEMA "${extensionSchema}"` : "";
    const suggestions = missing
      .map((ext) => `  CREATE EXTENSION IF NOT EXISTS ${ext}${withSchema};`)
      .join("\n");
    super(
      `runMigrations: extensionMode: "verify" — 必要な拡張が見当たりません: ` +
        `${missing.join(", ")}。\n` +
        `CREATE EXTENSION 権限を持つロールで、以下を実行してください:\n${suggestions}`,
    );
    this.name = "MissingExtensionsError";
    this.missing = missing;
  }
}

/**
 * `REQUIRED_EXTENSIONS` のうち `pg_extension` に実在するものの集合を返す。
 *
 * 拡張は**スキーマではなくデータベースに属する**（ADR 0057 の測定表）ため、`schema` /
 * `extensionSchema` の値に関わらず DB 全体を対象に1回だけ確認すれば足りる。
 * `REQUIRED_EXTENSIONS` はモジュール内で固定された定数配列（利用者からの入力を含まない）
 * なので、リテラルとして埋め込んでも injection の懸念は無い。
 */
async function fetchInstalledExtensions(pool: Pool): Promise<Set<string>> {
  const literals = REQUIRED_EXTENSIONS.map((ext) => `'${ext}'`).join(", ");
  const { rows } = await pool.query<{ extname: string }>(
    `SELECT extname FROM pg_extension WHERE extname = ANY(ARRAY[${literals}])`,
  );
  return new Set(rows.map((row) => row.extname));
}

/**
 * `extensionMode: "verify"` の中心処理。足りない拡張が無ければ何もせず正常に戻る
 * （呼び出し側からは「例外を投げずに完了した」＝「在った」として観測できる）。
 * 1つでも足りなければ {@link MissingExtensionsError} を投げる。
 */
async function verifyRequiredExtensions(
  pool: Pool,
  extensionSchema: string | undefined,
): Promise<void> {
  const installed = await fetchInstalledExtensions(pool);
  const missing = REQUIRED_EXTENSIONS.filter((ext) => !installed.has(ext));
  if (missing.length > 0) {
    throw new MissingExtensionsError(missing, extensionSchema);
  }
}

export interface RunMigrationsOptions extends SchemaNamespaceOptions {
  /**
   * advisory lock を待つ上限（ミリ秒）。既定は {@link DEFAULT_LOCK_TIMEOUT_MS}。
   * schema ごとのロックと、{@link EXTENSION_LOCK_KEY}（Issue #757）の共有拡張ロックの
   * **両方に同じ値を使う**（1つの `runMigrations` 呼び出しが待ってよい上限は1つ、という
   * 単純な線を優先した。2本のロックそれぞれに別の上限を持たせる需要はまだ無い）。
   */
  lockTimeoutMs?: number;
  /**
   * advisory lock のキー。テスト以外で既定の {@link MIGRATION_LOCK_KEY} を変える理由は無い。
   *
   * ⚠ **schema ごとのロック（`migrationLockKeyFor` が返すもの）だけに効く。**
   * {@link EXTENSION_LOCK_KEY}（Issue #757、拡張を作る段の共有ロック）は常に固定の
   * 定数を使い、この上書きの対象ではない——共有ロックはその性質上「schema を跨いで
   * 全員が同じキーを見ること」自体が目的であり、呼び出しごとに差し替えられては
   * 直列化そのものが崩れる。テストで共有ロックの挙動を検査したい場合は、
   * `EXTENSION_LOCK_KEY` を直接使って別セッションから握る（`migrate-extension-lock-race.test.ts`
   * のような形）。
   */
  lockKey?: bigint;
  /**
   * 拡張（`REQUIRED_EXTENSIONS`）の用意のしかた。既定は `"create"`
   * （今日どおり。**指定しなければ発行される SQL は1バイトも変わらない**）。
   * `"verify"` の詳細は {@link ExtensionMode} の doc（ADR 0093）参照。
   */
  extensionMode?: ExtensionMode;
}

/**
 * `schema` から `runMigrations` の advisory lock キーを導く（feat/dedicated-schema）。
 *
 * `pg_advisory_lock` のキー空間は DB 全体で共有される。2つの mnemora が同じ DB の
 * 別スキーマに同居すると、片方の migrate がもう片方を黙ってブロックしてしまう
 * （エラーにならないので気付けない）——これを塞ぐため、`schema` ごとに別のキーを使う。
 *
 * - `schema === undefined` または `schema === "public"` → **既存の {@link MIGRATION_LOCK_KEY}
 *   をそのまま返す。** 理由:
 *   (a) ローリングデプロイ中、旧バージョンのプロセスは常に旧キー（`MIGRATION_LOCK_KEY`）を
 *   使う。既定経路のキーを変えると新旧が別々のロックを取り、**排他が効かなくなる**。
 *   (b) `schema` 未指定は実行時に `current_schema()`（＝接続の `search_path` 先頭）へ
 *   落ちるので、この関数は静的には実際の対象スキーマを特定できない。
 *   **ロックを取りすぎる方向の誤り（無関係な処理を待たせる）は無害だが、
 *   取らなすぎる方向（排他が効かない）は壊す。** ⟹ 保守的な側へ倒し、`undefined` と
 *   `"public"` は同じキーへ寄せる。
 * - それ以外 → `deriveAdvisoryLockKey` で `schema` ごとに別のキーを導出する。
 */
export function migrationLockKeyFor(schema?: string): bigint {
  if (schema === undefined || schema === "public") {
    return MIGRATION_LOCK_KEY;
  }
  return deriveAdvisoryLockKey(`mnemora:runMigrations:advisory-lock:${schema}`);
}

export interface RunMigrationsResult {
  applied: string[];
  /**
   * 排他の観測値。`waitedMs` は「ロックが空くまで実際に待った時間」（ミリ秒）。
   * 他プロセスが同時にマイグレーションを行っていなければ 0 に近い値になる。
   */
  lock: { waitedMs: number };
  /**
   * `extensionMode: "verify"`（ADR 0093）のときだけ載る、拡張検査の観測値。
   *
   * - `extensionMode` 省略（既定 `"create"`）→ `extensionCheck` は `undefined`
   *   （＝「検査していない」）。
   * - `extensionMode: "verify"` で1つでも足りなければ、この値は載らず
   *   {@link MissingExtensionsError} を投げて終わる（＝「検査したが無かった」）。
   * - `extensionMode: "verify"` で全て揃っていれば、`verified` に確認できた拡張名が載る
   *   （＝「在った」）。
   *
   * この3値を同じ顔（`undefined` や空配列に潰す）にしないこと。
   */
  extensionCheck?: { verified: readonly string[] };
}

/**
 * advisory lock の取得が「待ち時間切れで失敗した」ことを表す。
 *
 * **「待った → 取れた」「待った → 時間切れ」「ロック機構自体が使えなかった」の3つを
 * 呼び出し側が区別できること**が段階2の要求（オーナーが引いた線1）。このエラーは
 * 2番目の状態専用——`MigrationLockUnavailableError`（3番目の状態）と混同しないこと。
 *
 * 機構そのもの（`AdvisoryLockTimeoutError`）は `./advisory-lock.ts` へ切り出した
 * （段階2・ADR 0018、`registerEmbeddingSpace` と共有するため）。ここではメッセージに
 * `runMigrations:` を埋め込んだサブクラスとして残す——既存の `instanceof
 * MigrationLockTimeoutError` 検査とメッセージ文言を壊さないため。
 */
export class MigrationLockTimeoutError extends AdvisoryLockTimeoutError {
  constructor(waitedMs: number, cause: unknown) {
    super(
      `runMigrations: advisory lock を ${waitedMs}ms 待ったが取得できなかった（タイムアウト）。` +
        `他プロセスが migrate を握ったまま応答していない可能性がある。`,
      cause,
    );
    this.name = "MigrationLockTimeoutError";
  }
}

/**
 * advisory lock を取得する**操作自体**が失敗したことを表す（権限不足・接続不可など）。
 *
 * `pg_advisory_lock` を実行する権限が無いロールで接続した場合や、ロック取得中に
 * 接続が切れた場合など、「待ったが空かなかった」（`MigrationLockTimeoutError`）とは
 * 異なる原因で失敗したときにこちらを投げる。**この区別が無いと、権限設定の誤りを
 * 「混んでいるだけ」と誤診してリトライし続けてしまう。**
 *
 * `AdvisoryLockUnavailableError`（`./advisory-lock.ts`）のサブクラス。理由は
 * `MigrationLockTimeoutError` と同じ。
 */
export class MigrationLockUnavailableError extends AdvisoryLockUnavailableError {
  constructor(cause: unknown) {
    super(
      `runMigrations: advisory lock を取得する操作自体が失敗した` +
        `（権限不足・接続不可などで、待ち時間切れとは別の原因）。`,
      cause,
    );
    this.name = "MigrationLockUnavailableError";
  }
}

/**
 * `pool.connect()` で借り切った checked-out client に付ける、何もしない `error`
 * リスナー（下記の per-file トランザクションクライアント参照）。
 *
 * 🔴 **モジュールで1つだけの、同じ関数参照を使い回すこと。** `pg-pool` は接続を pool へ
 * 返却してもソケットは切らずに次の `pool.connect()` で使い回すため、`on`/
 * `removeListener` に別々の関数（`() => {}` を毎回新しく作る等）を使うと外せず、
 * ファイルを1本処理するたびに同じ物理コネクションへリスナーが積み上がって
 * `MaxListenersExceededWarning`（既定上限10）に達する。**`client.release()` する
 * 直前に、必ずこの定数で `removeListener` すること。**
 */
const NOOP_CLIENT_ERROR_HANDLER = (): void => {};

const MIGRATION_LOCK_ERRORS = {
  timeout: (waitedMs: number, cause: unknown) => new MigrationLockTimeoutError(waitedMs, cause),
  unavailable: (cause: unknown) => new MigrationLockUnavailableError(cause),
};

/** `./advisory-lock.ts` の共通実装を、`runMigrations` 用のエラークラスで包んだだけの薄い口。 */
async function acquireMigrationLock(
  pool: Pool,
  lockKey: bigint,
  lockTimeoutMs: number,
): Promise<{ client: PoolClient; waitedMs: number }> {
  return acquireAdvisoryLock(pool, lockKey, lockTimeoutMs, MIGRATION_LOCK_ERRORS);
}

/** `./advisory-lock.ts` の共通実装をそのまま呼ぶだけの薄い口（対称性のため関数名だけ残す）。 */
async function releaseMigrationLock(client: PoolClient, lockKey: bigint): Promise<void> {
  return releaseAdvisoryLock(client, lockKey);
}

/**
 * {@link EXTENSION_LOCK_KEY} を取得する（Issue #757）。エラーの語彙は schema ロックと
 * 共有する——`MigrationLockTimeoutError` / `MigrationLockUnavailableError` をそのまま使う。
 * 呼び出し側から見て「`runMigrations` の advisory lock が時間切れ／取得不能だった」という
 * 観測できる事実は同じであり、どちらのロック（schema ごと／共有の拡張ロック）で
 * 起きたかを型で分ける新しいエラークラスは作らない（この2本のロックは常に
 * `lockTimeoutMs` を共用するため、呼び出し側の対処——待って再試行する／権限を見直す——も
 * 変わらない）。
 */
async function acquireExtensionLock(lockClient: PoolClient): Promise<void> {
  await acquireAdvisoryLockOnClient(lockClient, EXTENSION_LOCK_KEY, MIGRATION_LOCK_ERRORS);
}

/** `acquireExtensionLock` で取得したロックを、`lockClient` を解放せずに手放す。 */
async function releaseExtensionLock(lockClient: PoolClient): Promise<void> {
  await releaseAdvisoryLockOnClient(lockClient, EXTENSION_LOCK_KEY);
}

/**
 * 旧名の台帳 `_mnemo_migrations` を新名 `_mnemora_migrations` へ引き継ぐ。
 *
 * `mnemo` → `mnemora` の改名より前に作られた DB では、適用済みの記録が旧名のテーブルに
 * 入っている。引き継がずに新名の台帳を作ると**空の台帳を読むことになり、
 * `migrations/*.sql` を最初からやり直そうとして落ちる**（`0001_init.sql` の
 * `CREATE TABLE observations` は `IF NOT EXISTS` を付けていない）。
 *
 * 分岐は3つで、いずれも冪等（何度走らせても同じ状態に落ち着く）:
 * - 旧名が在り、新名が無い → RENAME する（引き継ぎが起きるのはこの一度だけ）
 * - 旧名が無い → 何もしない（まっさらな DB・引き継ぎ済みの DB）
 * - 新旧どちらも在る → 何もしない。**新名の台帳を上書きしない**し、旧名のほうも
 *   勝手には消さない——中身の突き合わせは人間の判断に属する
 *
 * **`ensureMigrationsTable` より前に呼ぶこと。**逆順にすると、先に空の
 * `_mnemora_migrations` が出来て「新旧どちらも在る」に落ち、引き継ぎが起きない。
 *
 * `schema` が未指定なら `qualify`/`qualifiedLiteral` はどちらも識別子を素通しするため、
 * 発行される SQL は今日と1バイトも変わらない。**`ALTER TABLE ... RENAME TO` の新しい
 * 名前は修飾しない**（PostgreSQL は `RENAME TO` に修飾名を受け付けない——RENAME は
 * 常に同じスキーマ内での改名であり、`RENAME TO "<schema>"."_mnemora_migrations"` は
 * 構文エラーになる）。
 */
async function handOverLegacyMigrationsTable(pool: Pool, schema?: string): Promise<void> {
  const legacyTable = qualify(schema, "_mnemo_migrations");
  const legacyLiteral = qualifiedLiteral(schema, "_mnemo_migrations");
  const newLiteral = qualifiedLiteral(schema, "_mnemora_migrations");
  await pool.query(`
    DO $handover$
    BEGIN
      IF to_regclass('${legacyLiteral}') IS NOT NULL
         AND to_regclass('${newLiteral}') IS NULL THEN
        ALTER TABLE ${legacyTable} RENAME TO _mnemora_migrations;
      END IF;
    END
    $handover$;
  `);
}

async function ensureMigrationsTable(pool: Pool, schema?: string): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${qualify(schema, "_mnemora_migrations")} (
      name         text        PRIMARY KEY,
      applied_at   timestamptz NOT NULL DEFAULT now()
    );
  `);
}

/**
 * `migrationsDir` にある `*.sql` を適用順（ファイル名の昇順）で列挙する。
 *
 * **export する理由（マネージャー指摘）**: `packages/postgres/src/__tests__/
 * migrate-concurrency.test.ts` / `migrate-ledger-handover.test.ts` は「適用された
 * マイグレーション名」を検査するが、期待値を `["0001_init.sql"]` のようにハードコード
 * すると、`migrations/` に2本目・3本目が増えるたびにテストの期待値を書き換える
 * 羽目になる——それは「マイグレーションが1本のときしか通らない歯」であり、
 * 実際に本 PR（`0002_outbox_claim_lease_index.sql` の追加）で6本が転んだ。
 * この関数を唯一の真実の源にして、テスト側は `listMigrationFiles(DEFAULT_MIGRATIONS_DIR)`
 * から期待値を導出する。
 */
export function listMigrationFiles(migrationsDir: string): string[] {
  return readdirSync(migrationsDir)
    .filter((name) => name.endsWith(".sql"))
    .sort();
}

/**
 * 未適用の `migrations/*.sql` を名前の昇順で適用する。適用済みは `_mnemora_migrations` に
 * 記録し、二重適用しない（何度呼んでも安全 = 冪等なマイグレーション実行）。
 *
 * 台帳を読む**前に**、旧名 `_mnemo_migrations` からの引き継ぎを一度通す
 * （`handOverLegacyMigrationsTable`）。
 *
 * `migrationsDir` はテスト用の差し替え口（不正なマイグレーションがロールバックされ、
 * `_mnemora_migrations` に記録されないことを検査するため）。省略時は本番の
 * `migrations/` ディレクトリを使う。
 *
 * ## 排他（段階2・ADR 0017）
 *
 * **`handOverLegacyMigrationsTable` の前から、最後のマイグレーションの COMMIT まで**を
 * advisory lock（`MIGRATION_LOCK_KEY`）で包む。段階1の実測で、まっさらな DB へ複数
 * プロセスが同時に `runMigrations` を呼ぶと**決定的に**（試行した全件で）どこかが
 * 落ちることを確認している——衝突点は1箇所ではなく、`ensureMigrationsTable` の
 * `CREATE TABLE IF NOT EXISTS`／`0001_init.sql` 冒頭の `CREATE EXTENSION IF NOT EXISTS`／
 * 同ファイルの無印 `CREATE TABLE` の3層に積み重なっていた（詳細は ADR 0017）。
 * 個々の DDL に `IF NOT EXISTS` を積み増す方向は採らない——症状が別の層へ移るだけで、
 * 「並行に呼んでよい」という保証にはならないため、入り口を1つのロックで塞ぐ。
 *
 * **呼び出し側は何も変える必要が無い。**`runMigrations(pool)` は今まで通り安全な既定値
 * （`lockTimeoutMs` 未指定 = {@link DEFAULT_LOCK_TIMEOUT_MS}）で動く。テストなど、
 * 待ち時間を短くしたい場合だけ `options.lockTimeoutMs` を渡す。
 *
 * 起こりうる3つの状態を呼び出し側が区別できるようにしてある（オーナーが引いた線1）:
 * - 待って取れた → 通常どおり完了し、戻り値の `lock.waitedMs` に待った時間が載る
 * - 待ったが時間切れ → {@link MigrationLockTimeoutError} を投げる（黙って続行しない）
 * - ロック取得の操作自体が失敗（権限不足・接続不可等） →
 *   {@link MigrationLockUnavailableError} を投げる（時間切れと取り違えない）
 *
 * ## 拡張を作る段の共有ロック（Issue #757）
 *
 * 上の schema ごとのロックとは**別に**、`CREATE EXTENSION` を発行する段だけを
 * {@link EXTENSION_LOCK_KEY}（schema に依らない固定の共有キー）で直列化する。
 * 拡張は `search_path`/`schema` に関わらず**データベース全体に1つ**しか置けない
 * （`pg_extension_name_index` は `extname` 単独）ため、schema ごとのロックだけでは
 * 「schema の違う `runMigrations` 同士」が互いを待たず、`CREATE EXTENSION IF NOT EXISTS`
 * が衝突して決定的に落ちる（Issue #757 の実測）。**取得順は常に「schema ごとのロック →
 * この共有ロック」に固定してある**（逆順で取る経路は無い——デッドロックを避けるため）。
 * `extensionMode: "verify"` では一切参照しない（`CREATE EXTENSION` を発行しないため）。
 * 詳細と、`schema` 未指定の経路にだけ生じる小さな逸脱（決定2との関係）は
 * {@link EXTENSION_LOCK_KEY} の doc と ADR 0331 参照。
 *
 * ## `options.schema`（feat/dedicated-schema）
 *
 * **`schema` 未指定なら、このブロックの分岐は一切実行されない**——今日と同じ SQL が
 * 同じ順番で発行される（発行する DDL・DML はこの意味で1文字も変わらない。ただし
 * *初回*適用時だけ、上の共有ロックの `pg_advisory_lock`/`pg_advisory_unlock` が
 * schema ロックを保持している同じ接続（`lockClient`）に対して増える——新しい接続は
 * 増えない。ADR 0331「決定2との関係」）。`schema` を指定すると:
 *
 * 1. `assertSafeSchemaName` で `schema`（と、指定されていれば `extensionSchema`）を検証する。
 *    **これはロック取得より前に行う**（`registerEmbeddingSpace` がバリデーションを
 *    ロック取得より前に置く順序と揃える——不正な入力のためにロックを取って
 *    他プロセスを待たせる意味が無いため）。
 * 2. ロック取得後、`CREATE SCHEMA IF NOT EXISTS "<schema>"` と、`REQUIRED_EXTENSIONS`
 *    各拡張の `CREATE EXTENSION IF NOT EXISTS <ext> WITH SCHEMA "<extensionSchema>"` を
 *    実行する（`extensionSchema` 省略時は {@link DEFAULT_EXTENSION_SCHEMA}）。
 * 3. 台帳の引き継ぎ・存在検査・作成・SELECT/INSERT はすべて `qualify` 経由でスキーマ修飾する。
 * 4. 各マイグレーションのトランザクション内、`BEGIN` の直後に
 *    `SET LOCAL search_path TO <schema>[,<extensionSchema>]` を発行する。**`SET LOCAL`**
 *    なので `COMMIT`/`ROLLBACK` でトランザクションスコープを抜け、**pool のコネクションに
 *    session 状態が漏れない**（このコネクションが後で別の呼び出しに再利用されても、
 *    そちらの `search_path` に影響しない）。
 *
 * ## `options.extensionMode`（ADR 0093）
 *
 * **`extensionMode` 未指定（既定 `"create"`）なら、この段落は一切関係ない**——今日と
 * 同じ SQL が同じ順番で発行される。`extensionMode: "verify"` を指定すると:
 *
 * 1. ロック取得より前に `pg_extension` を読み、`REQUIRED_EXTENSIONS` が全て存在するかを
 *    確認する。1つでも無ければ {@link MissingExtensionsError} を投げ、ロックの取得も
 *    マイグレーションの適用も一切行わない。
 * 2. `schema` を指定していても、上の「2.」の `CREATE EXTENSION ... WITH SCHEMA` は
 *    発行しない（1. で存在を確認済みのため）。
 * 3. `migrations/*.sql` 本文に含まれる `CREATE EXTENSION IF NOT EXISTS ...;` 行
 *    （経路2、今のところ `0001_init.sql` の3行）は、送信前に取り除く
 *    （{@link stripCreateExtensionStatements}）。**ファイルそのものは変えない**——実行時に
 *    流す文字列だけを変える。
 *
 * つまり `extensionMode: "verify"` は、経路1・経路2のどちらからも `CREATE EXTENSION` を
 * 一切発行させない。`CREATE EXTENSION` の実行権限を持たないロールで接続する導入者
 * （動機の実例: virchamate、ADR 0093）のための口。
 */
export async function runMigrations(
  pool: Pool,
  migrationsDir: string = DEFAULT_MIGRATIONS_DIR,
  options: RunMigrationsOptions = {},
): Promise<RunMigrationsResult> {
  const { schema } = options;
  if (schema !== undefined) {
    assertSafeSchemaName(schema);
  }
  const extensionSchema =
    schema === undefined ? undefined : (options.extensionSchema ?? DEFAULT_EXTENSION_SCHEMA);
  if (extensionSchema !== undefined) {
    assertSafeSchemaName(extensionSchema);
  }
  const extensionMode: ExtensionMode = options.extensionMode ?? "create";

  // `extensionMode: "verify"` はロック取得より前に決着させる（`assertSafeSchemaName` と
  // 同じ理由——不正/不足のためにロックを取って他プロセスを待たせる意味が無い。
  // ADR 0093: 経路1（この関数の CREATE SCHEMA の隣の CREATE EXTENSION ループ）と
  // 経路2（`migrations/0001_init.sql` 本文の CREATE EXTENSION）の**両方**を、ここ1箇所の
  // 確認で代替する——拡張はスキーマではなくデータベースに属する（ADR 0057 の測定表）ため、
  // `schema` の有無に関わらず DB 全体を対象に1回確認すれば足りる。
  let extensionCheck: RunMigrationsResult["extensionCheck"];
  if (extensionMode === "verify") {
    await verifyRequiredExtensions(pool, extensionSchema);
    extensionCheck = { verified: REQUIRED_EXTENSIONS };
  }

  const lockTimeoutMs = options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
  const lockKey = options.lockKey ?? migrationLockKeyFor(schema);

  const { client: lockClient, waitedMs } = await acquireMigrationLock(pool, lockKey, lockTimeoutMs);
  try {
    if (schema !== undefined) {
      await pool.query(`CREATE SCHEMA IF NOT EXISTS "${schema}"`);
      // `extensionMode: "verify"` では上ですでに存在を確認済みなので、ここで
      // `CREATE EXTENSION` を発行しない（それがこのモードの目的そのもの——
      // `CREATE EXTENSION` 権限を持たないロールでも呼べるようにする、ADR 0093）。
      if (extensionMode === "create") {
        // Issue #757: 拡張は schema ではなく DB 全体に1つしか置けない
        // （`pg_extension_name_index` は `extname` 単独）。schema ごとのロック
        // （このブロックの外側、`lockKey` で既に取得済み）は schema が違えば
        // 互いを待たないため、この CREATE EXTENSION ループだけを
        // {@link EXTENSION_LOCK_KEY} の共有ロックで追加に直列化する。
        // オートコミットの単発クエリの並びなので、ループの前後だけ保持すれば足りる。
        await acquireExtensionLock(lockClient);
        try {
          for (const ext of REQUIRED_EXTENSIONS) {
            await pool.query(
              `CREATE EXTENSION IF NOT EXISTS ${ext} WITH SCHEMA "${extensionSchema}"`,
            );
          }
        } finally {
          await releaseExtensionLock(lockClient);
        }
      }
    }

    await handOverLegacyMigrationsTable(pool, schema);
    await ensureMigrationsTable(pool, schema);

    const { rows } = await pool.query<AppliedMigration>(
      `SELECT name FROM ${qualify(schema, "_mnemora_migrations")}`,
    );
    const alreadyApplied = new Set(rows.map((row) => row.name));

    const applied: string[] = [];
    for (const file of listMigrationFiles(migrationsDir)) {
      if (alreadyApplied.has(file)) {
        continue;
      }
      const fileSql = readFileSync(join(migrationsDir, file), "utf8");
      // 経路2（`migrations/*.sql` 本文の CREATE EXTENSION、今のところ 0001_init.sql の3行）。
      // `extensionMode: "verify"` では、この本文を送る前にその行だけを取り除く——
      // ファイル自体は変えず、実行時にだけ流す文字列を変える（`stripCreateExtensionStatements`
      // の doc 参照）。上のプリフライトで既に存在を確認済みなので、取り除いても
      // マイグレーションの結果（テーブル・索引等）は変わらない。
      const sql =
        extensionMode === "verify" ? stripCreateExtensionStatements(fileSql).sql : fileSql;

      // Issue #757: `schema` 未指定の経路は、拡張が *この* ファイル本文の
      // トランザクション内（今のところ 0001_init.sql）で作られる。schema ごとの
      // ロックは schema 未指定の呼び出し同士では同じキー（`MIGRATION_LOCK_KEY`）に
      // 寄るため互いを待つが、schema を指定した別の呼び出し（別キー）とは待ち合わない
      // ——そちらとの直列化を、このファイルを適用する間だけ共有の {@link EXTENSION_LOCK_KEY}
      // で追加に取る。`extensionMode: "create"` かつ、このファイルが実際に
      // `CREATE EXTENSION` 行を含む（既存の抽出規則 {@link matchCreateExtensionLines} を
      // 再利用）ときだけ——**未適用のファイルにこの行を含むものが無ければ
      // （2回目以降の定常状態）、このロックは一切取得されない。**
      const needsSharedExtensionLock =
        schema === undefined &&
        extensionMode === "create" &&
        matchCreateExtensionLines(fileSql).length > 0;
      if (needsSharedExtensionLock) {
        await acquireExtensionLock(lockClient);
      }
      try {
        const client = await pool.connect();
        // pg の仕様: `pool.connect()` で借り切ったクライアント（checked-out client）は、
        // 呼び出し側が自分で `error` リスナーを付けない限り、接続断
        // （DB の再起動・フェイルオーバー・運用者による切断・OOM kill 等、外部要因による
        // ものを含む）が Node の `EventEmitter` の既定動作でそのまま投げられ、
        // プロセス全体が uncaught exception で落ちる——直後の `try` が `await
        // client.query(...)` の reject として同じ失敗を捕まえ、下の `catch` が
        // 約束どおり `Error('migration <file> failed: ...')` に包んで投げるので、
        // ここでは何もせず黙って拾うだけで足りる（`migrate-connection-loss.test.ts` が
        // 実測。空リスナーが無い状態だと、この歯はプロセスのクラッシュ、または
        // 後述の ROLLBACK 上書きにより、元の失敗が観測できない形で赤くなる）。
        // ⚠ `client.release()` する直前に必ず `removeListener` すること
        // （{@link NOOP_CLIENT_ERROR_HANDLER} のコメント参照——外し忘れるとリスナーが積み上がる）。
        client.on("error", NOOP_CLIENT_ERROR_HANDLER);
        try {
          await client.query("BEGIN");
          if (schema !== undefined) {
            await client.query(
              `SET LOCAL search_path TO ${searchPathFor(schema, extensionSchema!)}`,
            );
          }
          await client.query(sql);
          await client.query(
            `INSERT INTO ${qualify(schema, "_mnemora_migrations")} (name) VALUES ($1)`,
            [file],
          );
          await client.query("COMMIT");
          applied.push(file);
        } catch (err) {
          // 接続が既に失われている等で ROLLBACK 自体が失敗しても、元の失敗（`err`）を
          // 上書きしない——下の throw は常に `err` を基にする（ROLLBACK 失敗時の
          // 二次エラーは意図的に握り潰す。ROLLBACK が本当に必要な場面
          // ——コネクションが生きている通常の DDL エラー——では今日どおり実行される）。
          await client.query("ROLLBACK").catch(() => {});
          throw new Error(`migration ${file} failed: ${(err as Error).message}`, { cause: err });
        } finally {
          client.removeListener("error", NOOP_CLIENT_ERROR_HANDLER);
          client.release();
        }
      } finally {
        if (needsSharedExtensionLock) {
          await releaseExtensionLock(lockClient);
        }
      }
    }
    return { applied, lock: { waitedMs }, extensionCheck };
  } finally {
    await releaseMigrationLock(lockClient, lockKey);
  }
}

export interface AnalyzeMemoriesOptions {
  /**
   * `memories` テーブルを置くスキーマ。`RunMigrationsOptions.schema` と同じ意味・同じ検証
   * （{@link assertSafeSchemaName}）。省略時は接続の `search_path` 任せ（今日どおり、
   * 識別子を一切修飾しない）。
   */
  schema?: string;
}

export interface AnalyzeMemoriesResult {
  /** 実際に `ANALYZE` を発行した対象（`schema` を指定した場合はスキーマ修飾済み）。 */
  table: string;
}

/**
 * `memories` に対して `ANALYZE memories;`
 * （`packages/postgres/migrations/0005_analyze_memories.sql` と同じ1文）を、
 * マイグレーションのライフサイクルから独立に、いつでも呼べる形で実行する
 * （Issue #234 / ADR 0143）。
 *
 * ## なぜ `runMigrations` の中身にしないか（構造的な理由であり、設計の好みではない）
 *
 * `0005_analyze_memories.sql` は既に `ANALYZE memories;` を持つが、**新規インストールでは
 * 効果が無い**——マイグレーションは、アプリケーションが最初の行を書き込む**前**に
 * 適用されるため、`0005` が走る時点で `memories` はまだ空であり、`ANALYZE` はサンプルする
 * 行を持たない（ADR 0062 (d)(ii) が実測済み: 「新規インストール順」で段1の ANN クエリは
 * **37.4 / 33.2 / 32.9 ms**——本修正が何も無い場合と統計的に同じ遅さ）。
 *
 * **⟹ `runMigrations` 自身が最後に `ANALYZE` を打つ形にしても、この構造的な事実は
 * 変わらない。** 移行が実行されるタイミングそのものが「データがまだ無い」タイミングだから
 * である。これは実測ではなく、`migrate.ts` の実行順（マイグレーション→アプリケーション
 * 起動→データ投入）と `0005` 自身が既に記録している実測から導ける論理である。
 * ⟹ 本関数は意図的に `runMigrations` からも CLI の既定経路からも独立させ、**データを
 * 投入した後に、運用側（デプロイの手順書・cron・オペレータ操作）が明示的に呼ぶ**設計に
 * した。CLI からは `mnemora-postgres-migrate --analyze-memories`
 * （`./bin/migrate.ts` / `./bin/cli-options.ts`）で呼べる。**何度呼んでも安全**
 * （`ANALYZE` は冪等——空テーブルに対しても成功し、行が増えるたびに再実行すれば
 * 統計は最新化される）。
 *
 * ## 副作用について（この環境では測っていない。PostgreSQL の公式文書から引いた）
 *
 * **この作業環境には Postgres も docker も無く、実測はできない**（Issue #247 /
 * alteroid #965 / alteroid #1015 の族）。PostgreSQL の公式文書によれば、単体の
 * `ANALYZE`（`VACUUM` を伴わない）は対象テーブルに `SHARE UPDATE EXCLUSIVE` ロックを
 * 取る——このロックは通常の `SELECT`/`INSERT`/`UPDATE`/`DELETE` と競合しない（競合するのは
 * 他の `VACUUM`/`ANALYZE`・一部の DDL のみ）。また `ANALYZE` はテーブル全体を舐めず、
 * `default_statistics_target` に基づく固定サイズのサンプル行だけを読む。
 * ⟹ 素の `CREATE INDEX`（`ACCESS EXCLUSIVE` を取り書き込みを止める——ADR 0062 (c)）とは
 * 性質が異なり、書き込みを止めない設計だと**文書からは読める**。
 * **ただし「文書から読める」は「この環境で測った」ではない**——大きなテーブルで
 * サンプリング自体にどれだけ壁時計時間がかかるか、統計情報以外の副作用
 * （プランキャッシュの無効化等）が実運用でどう効くかは未計測。本 ADR の
 * 「確かめていないこと」に明記する。
 */
export async function runAnalyzeMemories(
  pool: Pool,
  options: AnalyzeMemoriesOptions = {},
): Promise<AnalyzeMemoriesResult> {
  const { schema } = options;
  if (schema !== undefined) {
    assertSafeSchemaName(schema);
  }
  const table = qualify(schema, "memories");
  await pool.query(`ANALYZE ${table}`);
  return { table };
}
