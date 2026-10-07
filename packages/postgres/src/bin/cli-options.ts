import type { ExtensionMode } from "../migrate.js";
import { assertSafeSchemaName } from "../schema-namespace.js";

/**
 * `mnemora-postgres-migrate` のコマンドライン引数・環境変数を解釈する純関数。DB 接続（`Pool`）を経由せず
 * 分岐を検査できるよう、`bin/migrate.ts` から切り出してある。
 *
 * 優先順位は コマンドライン引数 > 環境変数 > 未指定。どれも未指定なら `undefined` のままで、`runMigrations(pool)`
 * （options 省略）と同じ振る舞いになる。
 *
 * `--extension-schema` だけを指定した場合（`--schema` も `MNEMORA_SCHEMA` も無い）はエラーにして終了コード 1 で止める。
 * `extensionSchema` は `schema` を指定したときだけ効くので、黙って無視すると、拡張の置き場所を専用スキーマにした
 * つもりで `public` のままになる事故になる。
 *
 * スキーマ名の検査は `assertSafeSchemaName` を呼ぶ（正規表現を書き写さない）。
 */

/** `parseMigrateCliOptions` が返す、解釈済みのオプション。 */
export interface ParsedMigrateCliOptions {
  /** `--help` / `-h` が指定されていた場合 `true`。true のときは他の値を見なくてよい。 */
  help: boolean;
  /** 適用先スキーマ。`--schema` > `MNEMORA_SCHEMA` > 未指定（`undefined`）の優先順位で解決する。 */
  schema?: string;
  /**
   * 拡張の置き場所。`--extension-schema` > `MNEMORA_EXTENSION_SCHEMA` > 未指定の優先順位。
   * `schema` が未指定のまま値を持つことは無い（エラーとして弾く）。
   */
  extensionSchema?: string;
  /**
   * 拡張の用意のしかた（ADR 0093）。`--extension-mode` > `MNEMORA_EXTENSION_MODE` > 未指定の優先順位。
   * `undefined` は `runMigrations` の既定に任せる（CLI 側で既定値を決め打ちしない。唯一の置き場所は `../migrate.ts`）。
   */
  extensionMode?: ExtensionMode;
  /**
   * マイグレーション適用後に `runAnalyzeMemories` を呼ぶか（ADR 0143）。`--analyze-memories` の指定、または
   * `MNEMORA_ANALYZE_MEMORIES` が空文字・`"0"`・`"false"`（大文字小文字を区別しない）以外のとき `true`。
   * `help: true` の経路を除き、常に `boolean` に解決される（optional なのは `{ help: true }` のみを返す経路と型を揃えるため）。
   */
  analyzeMemories?: boolean;
}

/** 解釈に失敗したことを表す。`message` はそのまま `console.error` に渡せる説明文。 */
export interface MigrateCliParseError {
  message: string;
}

export type MigrateCliParseResult =
  { ok: true; options: ParsedMigrateCliOptions } | { ok: false; error: MigrateCliParseError };

const SCHEMA_FLAG = "--schema";
const EXTENSION_SCHEMA_FLAG = "--extension-schema";
const EXTENSION_MODE_FLAG = "--extension-mode";
const ANALYZE_MEMORIES_FLAG = "--analyze-memories";
const EXTENSION_MODES: readonly ExtensionMode[] = ["create", "verify"];

/**
 * `MNEMORA_ANALYZE_MEMORIES` の値が truthy かを判定する。値を取らない真偽フラグなので、環境変数側は値の中身で
 * 意味を持たせる。空文字・`"0"`・`"false"`（大文字小文字を区別しない、前後の空白は無視）を偽とし、それ以外は真とする。
 * `MNEMORA_SCHEMA` 等の「値がそのまま識別子になる」変数とは扱いが異なる。
 */
function isTruthyEnvFlag(value: string | undefined): boolean {
  if (value === undefined) {
    return false;
  }
  const normalized = value.trim().toLowerCase();
  return normalized !== "" && normalized !== "0" && normalized !== "false";
}

/**
 * `argv`（`process.argv.slice(2)`）と `env`（`process.env`）から、CLI が必要とするオプションを解決する。
 *
 * 受け付ける形:
 * - `--schema <name>` / `--schema=<name>`
 * - `--extension-schema <name>` / `--extension-schema=<name>`
 * - `--extension-mode <create|verify>` / `--extension-mode=<create|verify>`（ADR 0093）
 * - `--analyze-memories`（値を取らない真偽フラグ。ADR 0143）
 * - `--help` / `-h`
 *
 * 弾く形（`ok: false` を返す）:
 * - 未知のオプション（例: `--foo`）。`--analyze-memories=true` も完全一致しないので未知のオプションになる。
 * - 値が無い `--schema`（末尾で値が無い、または次のトークンが `--` で始まる）
 * - `assertSafeSchemaName` が落とす名前
 * - `--schema`（`MNEMORA_SCHEMA` も含め）を伴わない `--extension-schema`（`MNEMORA_EXTENSION_SCHEMA` も含め）
 * - `--extension-mode`（`MNEMORA_EXTENSION_MODE` も含め）に `"create"` / `"verify"` 以外の値
 *
 * `--extension-mode` と `--analyze-memories` は `--schema` の有無に関わらず指定できる。
 * `extensionMode: "verify"` は `migrations/*.sql` 本文の `CREATE EXTENSION` にも効くので、`schema` 未指定でも意味を持つ。
 *
 * `--help`/`-h` は argv のどこにあっても、他の一切の解決・判定より先に勝つ。値の無い `--schema` や未知のオプションが
 * 同じ argv に混じっていても `ok: false` にならず `{ help: true }` を返す。
 */
export function parseMigrateCliOptions(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
): MigrateCliParseResult {
  // `--help`/`-h` は、他のどの解釈よりも前に argv 全体を走査して判定する。ループの中で見つけて `continue` する形にすると、
  // `--help` より後ろの壊れた引数がループの途中で先に `ok: false` を返し、help に到達しないことがある。
  if (argv.some((arg) => arg === "--help" || arg === "-h")) {
    return { ok: true, options: { help: true } };
  }

  let schemaArg: string | undefined;
  let extensionSchemaArg: string | undefined;
  let extensionModeArg: string | undefined;
  let analyzeMemoriesArg = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;

    if (arg === ANALYZE_MEMORIES_FLAG) {
      analyzeMemoriesArg = true;
      continue;
    }

    const eqIndex = arg.startsWith("--") ? arg.indexOf("=") : -1;
    const flag = eqIndex === -1 ? arg : arg.slice(0, eqIndex);

    if (arg === "--") {
      // pnpm は `pnpm run migrate -- --analyze-memories` の `--` をそのまま渡してくる。受け付ける入力は変えず
      // （`--` は未知のオプションのまま）、エラー文に `--` を付けない正しい書き方を足す。
      const rest = argv.filter((a) => a !== "--").join(" ");
      const example = `pnpm --filter @mnemora/postgres run migrate${rest.length > 0 ? ` ${rest}` : ""}`;
      return {
        ok: false,
        error: {
          message: `unknown option: --\n\`--\` を付けずに、オプションをそのまま渡すこと（例: ${example}）。`,
        },
      };
    }

    if (flag !== SCHEMA_FLAG && flag !== EXTENSION_SCHEMA_FLAG && flag !== EXTENSION_MODE_FLAG) {
      return { ok: false, error: { message: `unknown option: ${arg}` } };
    }

    let value: string;
    if (eqIndex !== -1) {
      value = arg.slice(eqIndex + 1);
    } else {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) {
        return { ok: false, error: { message: `option ${flag} requires a value` } };
      }
      value = next;
      i += 1;
    }

    if (flag === SCHEMA_FLAG) {
      schemaArg = value;
    } else if (flag === EXTENSION_SCHEMA_FLAG) {
      extensionSchemaArg = value;
    } else {
      extensionModeArg = value;
    }
  }

  const schema = schemaArg ?? env.MNEMORA_SCHEMA;
  const extensionSchema = extensionSchemaArg ?? env.MNEMORA_EXTENSION_SCHEMA;
  const extensionModeRaw = extensionModeArg ?? env.MNEMORA_EXTENSION_MODE;

  if (schema === undefined && extensionSchema !== undefined) {
    return {
      ok: false,
      error: {
        message:
          "--extension-schema (MNEMORA_EXTENSION_SCHEMA) を指定するには --schema " +
          "(MNEMORA_SCHEMA) も必要です。extensionSchema は schema を指定したときだけ効くため、" +
          "schema 無しの指定はエラーにしています。",
      },
    };
  }

  if (
    extensionModeRaw !== undefined &&
    !EXTENSION_MODES.includes(extensionModeRaw as ExtensionMode)
  ) {
    return {
      ok: false,
      error: {
        message:
          `--extension-mode (MNEMORA_EXTENSION_MODE) には ${EXTENSION_MODES.join(" / ")} ` +
          `のいずれかを指定してください（渡された値: ${extensionModeRaw}）。`,
      },
    };
  }
  const extensionMode = extensionModeRaw as ExtensionMode | undefined;
  const analyzeMemories = analyzeMemoriesArg || isTruthyEnvFlag(env.MNEMORA_ANALYZE_MEMORIES);

  try {
    if (schema !== undefined) {
      assertSafeSchemaName(schema);
    }
    if (extensionSchema !== undefined) {
      assertSafeSchemaName(extensionSchema);
    }
  } catch (err) {
    return { ok: false, error: { message: (err as Error).message } };
  }

  return {
    ok: true,
    options: { help: false, schema, extensionSchema, extensionMode, analyzeMemories },
  };
}

/** `--help` / `-h` のときに表示する使い方。README と内容が重複するが、README を読めない状況でも `--help` が使えるよう意図して持たせてある。 */
export function formatMigrateCliUsage(): string {
  return `使い方: mnemora-postgres-migrate [--schema <name>] [--extension-schema <name>] [--extension-mode <create|verify>] [--analyze-memories]

保留中の migrations/*.sql をファイル名の昇順で適用する。DATABASE_URL は必須（環境変数）。

オプション:
  --schema <name>            mnemora のテーブル・索引・マイグレーション台帳を置く
                              専用スキーマ。--schema=<name> の = 区切りでも指定できる。
                              省略時は接続の search_path 任せ（今日どおりの振る舞い）。
  --extension-schema <name>  vector / btree_gin / pgcrypto を置くスキーマ。
                              --schema を指定したときだけ効く（--schema 無しで
                              これだけ指定するとエラーになる）。省略時は "public"。
  --extension-mode <create|verify>
                              vector / btree_gin / pgcrypto の用意のしかた（ADR 0093）。
                              create（既定）: CREATE EXTENSION IF NOT EXISTS を発行する
                              （今日どおり）。verify: 何も発行せず、pg_extension を読んで
                              既に在ることだけを確認する。無ければ足りない拡張名と
                              実行すべき SQL を示して失敗する
                              （CREATE EXTENSION 権限を持たないロール向け）。
  --analyze-memories          マイグレーション適用後に ANALYZE memories; を実行する
                              （Issue #234 / ADR 0143）。新規インストールでは
                              0005_analyze_memories.sql 自身の ANALYZE はテーブルが
                              空の時点で走るため効果が無い——初回データ投入後、または
                              統計を更新したい任意のタイミングでこのフラグを付けて
                              再実行すること。何度呼んでも安全（冪等）。
  -h, --help                  このヘルプを表示して終了する（終了コード 0）。

環境変数:
  MNEMORA_SCHEMA              --schema の環境変数版。
  MNEMORA_EXTENSION_SCHEMA     --extension-schema の環境変数版。
  MNEMORA_EXTENSION_MODE       --extension-mode の環境変数版。
  MNEMORA_ANALYZE_MEMORIES     --analyze-memories の環境変数版。空文字・"0"・"false"
                                （大文字小文字を区別しない）以外の値は true として扱う。

優先順位: コマンドライン引数 > 環境変数 > 未指定。
どれも指定しなければ、今日と1バイトも変わらない振る舞いになる。
`;
}
