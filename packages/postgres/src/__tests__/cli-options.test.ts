import { describe, expect, it } from "vitest";
import {
  formatMigrateCliUsage,
  parseMigrateCliOptions,
  type MigrateCliParseResult,
} from "../bin/cli-options.js";
import type { ExtensionMode } from "../migrate.js";

function expectOk(result: MigrateCliParseResult): asserts result is {
  ok: true;
  options: {
    help: boolean;
    schema?: string;
    extensionSchema?: string;
    extensionMode?: ExtensionMode;
    analyzeMemories?: boolean;
  };
} {
  expect(result.ok).toBe(true);
}

function expectErr(
  result: MigrateCliParseResult,
): asserts result is { ok: false; error: { message: string } } {
  expect(result.ok).toBe(false);
}

describe("parseMigrateCliOptions: 未指定時の既定", () => {
  it("引数も環境変数も無ければ schema / extensionSchema / extensionMode はどれも undefined（今日と同じ振る舞い）", () => {
    const result = parseMigrateCliOptions([], {});
    expectOk(result);
    expect(result.options.help).toBe(false);
    expect(result.options.schema).toBeUndefined();
    expect(result.options.extensionSchema).toBeUndefined();
    expect(result.options.extensionMode).toBeUndefined();
    expect(result.options.analyzeMemories, "既定は false（ANALYZE を実行しない）").toBe(false);
  });
});

describe("parseMigrateCliOptions: --analyze-memories（Issue #234 / ADR 0143）", () => {
  it("--analyze-memories を渡すと true になる", () => {
    const result = parseMigrateCliOptions(["--analyze-memories"], {});
    expectOk(result);
    expect(result.options.analyzeMemories).toBe(true);
  });

  it("--schema と併用できる（互いに独立）", () => {
    const result = parseMigrateCliOptions(["--schema", "s", "--analyze-memories"], {});
    expectOk(result);
    expect(result.options.schema).toBe("s");
    expect(result.options.analyzeMemories).toBe(true);
  });

  it("MNEMORA_ANALYZE_MEMORIES=1 でも true になる", () => {
    const result = parseMigrateCliOptions([], { MNEMORA_ANALYZE_MEMORIES: "1" });
    expectOk(result);
    expect(result.options.analyzeMemories).toBe(true);
  });

  it.each(["", "0", "false", "FALSE", "False"])(
    "MNEMORA_ANALYZE_MEMORIES=%s は偽として扱う",
    (value) => {
      const result = parseMigrateCliOptions([], { MNEMORA_ANALYZE_MEMORIES: value });
      expectOk(result);
      expect(result.options.analyzeMemories).toBe(false);
    },
  );

  it("MNEMORA_ANALYZE_MEMORIES=true や任意の非空文字列は真として扱う", () => {
    const result = parseMigrateCliOptions([], { MNEMORA_ANALYZE_MEMORIES: "yes" });
    expectOk(result);
    expect(result.options.analyzeMemories).toBe(true);
  });

  it("フラグと環境変数のどちらか片方だけでも true になる（OR）", () => {
    const result = parseMigrateCliOptions(["--analyze-memories"], {
      MNEMORA_ANALYZE_MEMORIES: "false",
    });
    expectOk(result);
    expect(result.options.analyzeMemories, "フラグ側が true なら env が false でも true").toBe(
      true,
    );
  });

  it("`--` 単体は受け付けず（入力は変えない）、エラー文に `--` を付けない正しい書き方を1行で示す", () => {
    const result = parseMigrateCliOptions(["--", "--analyze-memories"], {});
    expectErr(result);
    const lines = result.error.message.split("\n");
    expect(lines[0]).toBe("unknown option: --");
    expect(lines).toHaveLength(2);
    expect(lines[1]).toMatch(/`--` を付けずに/);
    expect(lines[1]).toContain("run migrate --analyze-memories");
    expect(lines[1]).not.toContain("migrate -- --");
  });

  it("`--` の後ろに何も無いときも、正しい書き方を示す", () => {
    const result = parseMigrateCliOptions(["--"], {});
    expectErr(result);
    expect(result.error.message.split("\n")[1]).toMatch(/`--` を付けずに/);
  });

  it("`--` の後ろに引数が複数あるとき、例は空白で区切ってそのまま並べ、コマンドの全体（pnpm --filter @mnemora/postgres run migrate）を示す", () => {
    const result = parseMigrateCliOptions(["--", "--schema", "app", "--analyze-memories"], {});
    expectErr(result);
    const lines = result.error.message.split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain(
      "（例: pnpm --filter @mnemora/postgres run migrate --schema app --analyze-memories）",
    );
  });

  it("`--` 単体のときの例は、引数の無いコマンドで終わる（余分な空白を残さない）", () => {
    const result = parseMigrateCliOptions(["--"], {});
    expectErr(result);
    const lines = result.error.message.split("\n");
    expect(lines[0]).toBe("unknown option: --");
    expect(lines[1]).toContain("（例: pnpm --filter @mnemora/postgres run migrate）");
  });

  it("`--` 以外の未知のオプション（= 付きでも）には、`--` の案内を付けない（1行のまま）", () => {
    for (const arg of ["--analyze-memories=true", "--no-such-flag=1", "-x"]) {
      const result = parseMigrateCliOptions([arg], {});
      expectErr(result);
      expect(result.error.message).toBe(`unknown option: ${arg}`);
    }
  });

  it("ほかの未知のオプションのエラー文は変えない（1行のまま）", () => {
    const result = parseMigrateCliOptions(["--no-such-flag"], {});
    expectErr(result);
    expect(result.error.message).toBe("unknown option: --no-such-flag");
  });

  it("--analyze-memories=true のような = 区切りは受け付けず未知のオプションになる（値を取らない真偽フラグのため）", () => {
    const result = parseMigrateCliOptions(["--analyze-memories=true"], {});
    expectErr(result);
    expect(result.error.message).toMatch(/unknown option/i);
  });
});

describe("parseMigrateCliOptions: --extension-mode（ADR 0093）", () => {
  it("--extension-mode verify を空白区切りで指定できる（--schema 無しでも良い）", () => {
    const result = parseMigrateCliOptions(["--extension-mode", "verify"], {});
    expectOk(result);
    expect(result.options.extensionMode).toBe("verify");
    expect(result.options.schema).toBeUndefined();
  });

  it("--extension-mode=create の = 区切りでも指定できる", () => {
    const result = parseMigrateCliOptions(["--extension-mode=create"], {});
    expectOk(result);
    expect(result.options.extensionMode).toBe("create");
  });

  it("MNEMORA_EXTENSION_MODE を読む", () => {
    const result = parseMigrateCliOptions([], { MNEMORA_EXTENSION_MODE: "verify" });
    expectOk(result);
    expect(result.options.extensionMode).toBe("verify");
  });

  it("--extension-mode と MNEMORA_EXTENSION_MODE が両方あれば引数が勝つ", () => {
    const result = parseMigrateCliOptions(["--extension-mode", "verify"], {
      MNEMORA_EXTENSION_MODE: "create",
    });
    expectOk(result);
    expect(result.options.extensionMode).toBe("verify");
  });

  it("create / verify 以外の値はエラーになる", () => {
    const result = parseMigrateCliOptions(["--extension-mode", "skip"], {});
    expectErr(result);
    expect(result.error.message).toMatch(/extension-mode/i);
  });

  it("環境変数経由の不正な値もエラーになる", () => {
    const result = parseMigrateCliOptions([], { MNEMORA_EXTENSION_MODE: "skip" });
    expectErr(result);
    expect(result.error.message).toMatch(/extension-mode/i);
  });

  it.each(["VERIFY", "Create", " verify", "verify "])(
    "create / verify と大文字小文字や空白だけが違う値（%j）も、引数・環境変数のどちらでもエラーになる",
    (value) => {
      expectErr(parseMigrateCliOptions(["--extension-mode", value], {}));
      expectErr(parseMigrateCliOptions([], { MNEMORA_EXTENSION_MODE: value }));
    },
  );

  it("--schema と組み合わせても解決できる（extensionSchema とは独立）", () => {
    const result = parseMigrateCliOptions(["--schema", "s", "--extension-mode", "verify"], {});
    expectOk(result);
    expect(result.options.schema).toBe("s");
    expect(result.options.extensionMode).toBe("verify");
  });

  it("--extension-mode の値が無い（末尾）とエラーになる", () => {
    const result = parseMigrateCliOptions(["--extension-mode"], {});
    expectErr(result);
  });
});

describe("parseMigrateCliOptions: 引数のみ", () => {
  it("--schema <name> の空白区切りで指定できる", () => {
    const result = parseMigrateCliOptions(["--schema", "tenant_a"], {});
    expectOk(result);
    expect(result.options.schema).toBe("tenant_a");
  });

  it("--schema=<name> の = 区切りでも指定できる", () => {
    const result = parseMigrateCliOptions(["--schema=tenant_a"], {});
    expectOk(result);
    expect(result.options.schema).toBe("tenant_a");
  });

  it("--extension-schema は --schema と併用すれば指定できる（空白区切り / = 区切り両方）", () => {
    const spaceForm = parseMigrateCliOptions(["--schema", "s", "--extension-schema", "ext"], {});
    expectOk(spaceForm);
    expect(spaceForm.options.schema).toBe("s");
    expect(spaceForm.options.extensionSchema).toBe("ext");

    const eqForm = parseMigrateCliOptions(["--schema=s", "--extension-schema=ext"], {});
    expectOk(eqForm);
    expect(eqForm.options.schema).toBe("s");
    expect(eqForm.options.extensionSchema).toBe("ext");
  });
});

describe("parseMigrateCliOptions: 環境変数のみ", () => {
  it("MNEMORA_SCHEMA / MNEMORA_EXTENSION_SCHEMA を読む", () => {
    const result = parseMigrateCliOptions([], {
      MNEMORA_SCHEMA: "tenant_env",
      MNEMORA_EXTENSION_SCHEMA: "ext_env",
    });
    expectOk(result);
    expect(result.options.schema).toBe("tenant_env");
    expect(result.options.extensionSchema).toBe("ext_env");
  });
});

describe("parseMigrateCliOptions: 優先順位（引数 > 環境変数）", () => {
  it("--schema と MNEMORA_SCHEMA が両方あれば引数が勝つ", () => {
    const result = parseMigrateCliOptions(["--schema", "from_arg"], {
      MNEMORA_SCHEMA: "from_env",
    });
    expectOk(result);
    expect(result.options.schema).toBe("from_arg");
  });

  it("--extension-schema と MNEMORA_EXTENSION_SCHEMA が両方あれば引数が勝つ", () => {
    const result = parseMigrateCliOptions(["--schema", "s", "--extension-schema", "from_arg"], {
      MNEMORA_SCHEMA: "s",
      MNEMORA_EXTENSION_SCHEMA: "from_env",
    });
    expectOk(result);
    expect(result.options.extensionSchema).toBe("from_arg");
  });

  it("schema は環境変数、extensionSchema は引数、という組み合わせも解決できる", () => {
    const result = parseMigrateCliOptions(["--extension-schema", "ext_arg"], {
      MNEMORA_SCHEMA: "schema_env",
    });
    expectOk(result);
    expect(result.options.schema).toBe("schema_env");
    expect(result.options.extensionSchema).toBe("ext_arg");
  });

  it("--extension-mode が正しければ、不正な MNEMORA_EXTENSION_MODE は見ない", () => {
    const result = parseMigrateCliOptions(["--extension-mode", "verify"], {
      MNEMORA_EXTENSION_MODE: "skip",
    });
    expectOk(result);
    expect(result.options.extensionMode).toBe("verify");
  });

  it("--extension-schema が正しければ、不正な MNEMORA_EXTENSION_SCHEMA は見ない", () => {
    const result = parseMigrateCliOptions(["--schema", "s", "--extension-schema", "ext_arg"], {
      MNEMORA_EXTENSION_SCHEMA: "Bad-Name",
    });
    expectOk(result);
    expect(result.options.extensionSchema).toBe("ext_arg");
  });
});

describe("parseMigrateCliOptions: --extension-schema 単独（schema 側が最終的に無指定）", () => {
  it("引数だけで --extension-schema を指定し --schema も MNEMORA_SCHEMA も無ければエラー", () => {
    const result = parseMigrateCliOptions(["--extension-schema", "ext"], {});
    expectErr(result);
    expect(result.error.message).toMatch(/schema/i);
  });

  it("MNEMORA_EXTENSION_SCHEMA だけを設定し schema 側が無指定でもエラー", () => {
    const result = parseMigrateCliOptions([], { MNEMORA_EXTENSION_SCHEMA: "ext" });
    expectErr(result);
    expect(result.error.message).toMatch(/schema/i);
  });
});

describe("parseMigrateCliOptions: 不正なスキーマ名", () => {
  it("assertSafeSchemaName が落とす名前（大文字を含む）はエラーになる", () => {
    const result = parseMigrateCliOptions(["--schema", "Tenant"], {});
    expectErr(result);
    expect(result.error.message).toMatch(/unsafe/i);
  });

  it("環境変数経由の不正な名前も同じくエラーになる", () => {
    const result = parseMigrateCliOptions([], { MNEMORA_SCHEMA: "tenant-a" });
    expectErr(result);
    expect(result.error.message).toMatch(/unsafe/i);
  });

  it("extensionSchema 側の不正な名前もエラーになる", () => {
    const result = parseMigrateCliOptions(["--schema", "s", "--extension-schema", "1bad"], {});
    expectErr(result);
    expect(result.error.message).toMatch(/unsafe/i);
  });
});

describe("parseMigrateCliOptions: 環境変数の空文字（今の振る舞い。README「専用スキーマを指定する」）", () => {
  // 空文字は「未指定」に倒さない。MNEMORA_ANALYZE_MEMORIES だけは空文字を偽として扱う（上の describe）。
  it("MNEMORA_SCHEMA= は未指定ではなく、不正なスキーマ名としてエラーになる", () => {
    const result = parseMigrateCliOptions([], { MNEMORA_SCHEMA: "" });
    expectErr(result);
    expect(result.error.message).toMatch(/unsafe SQL identifier/);
  });

  it("MNEMORA_EXTENSION_SCHEMA= だけを設定すると、--schema 無しの --extension-schema と同じエラーになる", () => {
    const result = parseMigrateCliOptions([], { MNEMORA_EXTENSION_SCHEMA: "" });
    expectErr(result);
    expect(result.error.message).toMatch(/--schema/);
  });

  it("MNEMORA_SCHEMA を設定して MNEMORA_EXTENSION_SCHEMA= にすると、不正なスキーマ名としてエラーになる", () => {
    const result = parseMigrateCliOptions([], {
      MNEMORA_SCHEMA: "s",
      MNEMORA_EXTENSION_SCHEMA: "",
    });
    expectErr(result);
    expect(result.error.message).toMatch(/unsafe SQL identifier/);
  });

  it("MNEMORA_EXTENSION_MODE= は create / verify 以外の値としてエラーになる", () => {
    const result = parseMigrateCliOptions([], { MNEMORA_EXTENSION_MODE: "" });
    expectErr(result);
    expect(result.error.message).toMatch(/--extension-mode/);
  });

  it("引数が環境変数に勝つのは空文字でも同じ: --schema s があれば MNEMORA_SCHEMA= は見ない", () => {
    const result = parseMigrateCliOptions(["--schema", "s"], { MNEMORA_SCHEMA: "" });
    expectOk(result);
    expect(result.options.schema).toBe("s");
  });
});

describe("parseMigrateCliOptions: 未知の引数・値の欠けた引数", () => {
  it("未知のオプションはエラーになる", () => {
    const result = parseMigrateCliOptions(["--foo"], {});
    expectErr(result);
  });

  it("--schema の値が無い（末尾）とエラーになる", () => {
    const result = parseMigrateCliOptions(["--schema"], {});
    expectErr(result);
  });

  it("--schema の次のトークンが -- で始まる場合も値が無いものとしてエラーになる", () => {
    const result = parseMigrateCliOptions(["--schema", "--extension-schema", "ext"], {});
    expectErr(result);
  });
});

describe("parseMigrateCliOptions: --help", () => {
  it("--help があれば help: true を返し、schema 等は解決しない", () => {
    // 環境変数の値は、不正なスキーマ名（ハイフン入り）にしない。不正だと「早期 return を丸ごと消す」欠陥も
    // `expectOk` が間接的に捕まえてしまい、この歯が赤くなる理由が2つに割れる。
    // 解決に成功してしまう値にして、赤くなる理由を「help 経路が解決した」ただ1つにする。
    const result = parseMigrateCliOptions(["--help"], {
      MNEMORA_SCHEMA: "should_be_ignored",
      MNEMORA_EXTENSION_SCHEMA: "should_be_ignored_ext",
      MNEMORA_EXTENSION_MODE: "verify",
      MNEMORA_ANALYZE_MEMORIES: "1",
    });
    expectOk(result);
    // 「help だけを返す」ことを丸ごと固定する。欄を個別に `toBeUndefined()` で並べるより、
    // 将来 `ParsedMigrateCliOptions` に欄が増えて help 経路で解決されたときも赤くなる。
    // `toStrictEqual` にはしない: `{ help: true, schema: undefined }` はふるまいとして同じで、そこで赤くするのは偽陽性になる。
    expect(
      result.options,
      "🔴 赤の意味: `--help` の経路が環境変数を解決している。help は" +
        "「どんな組み合わせでも他の解釈をせず即座に返す（ヘルプ表示に徹する）」約束であり" +
        "（`../bin/cli-options.ts` の該当行のコメント）、ここで解決すると" +
        "『--help を付けただけなのに設定の不備でエラーになる』という、" +
        "使い方を見たいだけの利用者の手元で余計な失敗が起きうる。",
    ).toEqual({ help: true });
  });

  it("-h も同じ効果を持つ", () => {
    const result = parseMigrateCliOptions(["-h"], {});
    expectOk(result);
    expect(result.options.help).toBe(true);
  });

  it("不正な --schema と --help が同時にあっても help を優先する（表示に徹する）", () => {
    const result = parseMigrateCliOptions(["--schema", "Tenant", "--help"], {});
    expectOk(result);
    expect(result.options.help).toBe(true);
  });

  it("--help の後に値の無い --schema が続いても help を優先する", () => {
    const result = parseMigrateCliOptions(["--help", "--schema"], {});
    expectOk(result);
    expect(result.options.help).toBe(true);
  });

  it("-h の後に値の無い --schema が続いても help を優先する", () => {
    const result = parseMigrateCliOptions(["-h", "--schema"], {});
    expectOk(result);
    expect(result.options.help).toBe(true);
  });

  it("--help の後に未知のオプションが続いても help を優先する", () => {
    const result = parseMigrateCliOptions(["--help", "--foo"], {});
    expectOk(result);
    expect(result.options.help).toBe(true);
  });

  it("未知のオプションの後に --help が続いても help を優先する", () => {
    const result = parseMigrateCliOptions(["--foo", "--help"], {});
    expectOk(result);
    expect(result.options.help).toBe(true);
  });
});

describe("formatMigrateCliUsage", () => {
  it("使い方・引数・環境変数・優先順位に触れている", () => {
    const usage = formatMigrateCliUsage();
    expect(usage).toMatch(/--schema/);
    expect(usage).toMatch(/--extension-schema/);
    expect(usage).toMatch(/--extension-mode/);
    expect(usage).toMatch(/--analyze-memories/);
    expect(usage).toMatch(/MNEMORA_SCHEMA/);
    expect(usage).toMatch(/MNEMORA_EXTENSION_SCHEMA/);
    expect(usage).toMatch(/MNEMORA_EXTENSION_MODE/);
    expect(usage).toMatch(/MNEMORA_ANALYZE_MEMORIES/);
    expect(usage).toMatch(/優先/);
  });
});
