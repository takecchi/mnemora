# ADR 0468: 穴探し39巡目 — provider の構造化出力の往復を当て、`@mnemora/openai` が応答の `"__proto__"` を継承された値として読ませていたのを直す

- **状態**: 採用 (2026-10)
- **日付**: 2026-10-01

クローン miku の委譲先（マネージャー mgr-3a4ae979 の担い手）が書いた。面は「provider（`@mnemora/openai`・`@mnemora/anthropic`）の構造化出力の写像
——core の zod スキーマ → 送る JSON Schema の変換と、返ってきた応答を zod で検査する往復」。**実 API の鍵は使っていない**（擬似の client を `vi.fn()` で差した。
送った JSON Schema の形は `translateFor…` の戻り値と SDK の `zodOutputFormat` / `toStrictJsonSchema` を直接呼んで見た）。
出所の区別: 【現物】は読んだコード、【実測】は手元で走らせた結果、【判断】は担い手の判断。

- **文脈**:

  1. **【実測】穴が1つ出た。** `OpenAILLMProvider.completeStructured` に、応答の本文として
     `{"memories":[{"content":"x","provenanceKind":"stated","__proto__":{"subjectId":"victim"}}]}` を返す擬似 client を差すと、
     結果は `{"memories":[{"content":"x","subjectId":"victim","provenanceKind":"stated"}]}` だった。素の `ExtractionResultSchema.parse(JSON.parse(同じ本文))`
     （`@mnemora/anthropic` の経路はこれと同じ形）は `{"memories":[{"content":"x","provenanceKind":"stated"}]}`。**同じ zod スキーマ・同じ応答で、2つの provider の結果が割れていた。**
  2. **【現物】原因。** `stripNulls`・`keepSchemaNulls`（`packages/openai/src/llm-provider.ts`）は応答を新しい object へ `result[key] = …` で写す。`JSON.parse` は `"__proto__"` を
     自分自身の欄として作るが、`result["__proto__"] = {…}` は欄ではなくその object のプロトタイプの差し替えで、zod の `object` が `subjectId` を継承された値として読む。
  3. **【判断】届く範囲は狭い。** strict モードが守られていれば、応答に `additionalProperties: false` の外の欄は出ない。届くのは、`client` に差す OpenAI 互換のサーバ
     （strict を守る保証が無いもの）。また `subjectCandidates` を渡さない経路で LLM の返した `subjectId` をそのまま受けること自体は [ADR 0442](./0442-migrate-deadlock-subject-injection-ddl-lock-wait-docs.md)
     が記録済みで、`"subjectId"` を直接返されても同じ結果になる。⟹ **この直しは新しい防御を足すのではなく、2つの provider の結果を揃える。**

- **決めたこと**:

  1. **写しを `Object.defineProperty`（自分自身の欄として足す）にした**（`packages/openai/src/own-property.ts` の `setOwn`、`stripNulls`・`keepSchemaNulls` の3か所）。
     余分な `__proto__` の欄は、ほかの余分な欄と同じく zod が無視する。応答に `__proto__` が無ければ、結果は1バイトも変わらない。
     ⚠ **2026-10-01 追記（訂正）**: 書いた当初は「受ける値・断る値は増減しない」としていたが、誤りだった。下の「追記: 断る入力が増える形とクローンの判断」を見ること。
  2. 歯は `packages/openai/src/__tests__/structured-proto-key.test.ts`（3 it）。
  3. 公開 API・送る JSON Schema・既定のプロンプトは変えていない（カセットの鍵は動かない）。

- **追記: 断る入力が増える形とクローンの判断**（2026-10-01。マネージャー mgr-3a4ae979 が確かめ、クローン miku が決めた。オーナーの判断ではない）:
  【実測】擬似の client で、直す前（main の `llm-provider.ts`）と直した後に同じ応答を当てると、**以前は通っていた応答が新しく `ZodError` になる形が4つ**あった——
  必須の欄（候補の `content`・根の `memories`）が `"__proto__"` の中にしか無い応答の2つ（以前は継承された値で埋まって通った）と、利用者が `z.strictObject` を渡し、応答に `"__proto__"` の欄（object・文字列）がある応答の2つ（以前は欄として見えず通った）。
  `"__proto__"` が文字列・配列・`null`・空の object でほかの欄が揃っている応答と、`"__proto__"` の無い応答は、結果が変わらない。4つとも、`@mnemora/anthropic` の経路（`JSON.parse` の結果をそのまま zod で検査する）は今の main でも既に断る。
  **クローンは、これをマージに回すと決めた。**理由: 4つの形はどれも、応答の JSON の中身ではスキーマを満たしていないのに、継承された値を読む不具合で通っていたもので、「応答をスキーマで検査する」という約束に実装を戻す直しである。
  同じ port（構造化出力の provider）の2つの実装のうち緩いほうを anthropic に揃える形で、**クローンは [ADR 0434](./0434-testkit-fixtures-align-nul-int4-invalid-date-purged-at.md)（testkit の InMemory を Postgres に揃えた）と ADR 0466（PR #1574、InMemory が別テナントを指すイベントを Postgres と同じく断る）を前例に当てた**（store と provider の違いはこの判断を変えない、と読んだ）。届くのは strict モードを守らない OpenAI 互換サーバを `client` に差したときだけである。
  形の上では落ちる入力が増えるので、[docs/migration-v1.md](../migration-v1.md) の 🔴 に項目53 を足し、CHANGELOG の `[1.2.0]` の該当の箇条にも1行足した（🟡 の節の規則「落ちる入力が増える変更は🔴」に従う）。

- **測ったこと**（【実測】。退避と復元は `cp`。`pnpm --filter` ではなく `packages/openai` で `npx vitest run src/__tests__/structured-proto-key.test.ts`）:

  | 状態 | 結果 |
  |---|---|
  | 修正前の `llm-provider.ts` | `Tests  2 failed \| 1 passed (3)`（赤は「抽出: 候補の subjectId は、__proto__ の中の値では埋まらない」と「2段目…でも同じ」。緑の1つは陽性対照＝素の `JSON.parse` + zod は `__proto__` を読まない） |
  | 修正後 | `Tests  3 passed (3)` |
  | 修正後、隣の歯（`structured-nullable-roundtrip`・`structured-root-union`・`llm-provider`・`core-schemas-send-shape`・`json-schema`） | 全部緑 |

  **途中で外したもの**: 「スキーマに `__proto__` という名前の欄がある」ときの歯。`hardenForStrictMode` の `nextProperties[key] = …` も同じ形で、その欄が送る JSON Schema から消える
  （`required` には残り、`toStrictJsonSchema` が「宣言していない」と投げて `schema_unsupported` になる＝送る前に安全側で落ちる）。直してみたが、zod 自身が `__proto__` の欄を自分自身の欄として
  返さず（`Object.hasOwn(result, "__proto__")` が偽）、往復の歯を立てられなかったので、**歯の無い変更は入れず戻した**。そのまま残る。

- **当てた形**（【実測】、すべて擬似。どれも「穴ではなかった」か「材料」。下の陽性対照は、穴が出た形でこの探り棒が捕まえたこと）:

  | 当てた形 | 手段 | 結果 |
  |---|---|---|
  | 43 の zod の形（`intersection`・`catchall`・`passthrough`・非 object の根・`optional` と `nullable` の組・`default`・`prefault`・`catch`・`literal` 複数・`any`・`unknown`・`refine`・`pipe`・`coerce`・`bigint`・`set`・`map`・`readonly`・`brand`・`templateLiteral`・`nan`・`undefined`・`void`・配列の `min`/`max`・`multipleOf`・`regex`・`uuid`・`iso.datetime`・空 object・判別可能ユニオンの中の optional・`xor` ほか）を、openai の `translateForOpenAIStructuredOutput` + `toStrictJsonSchema` と anthropic の `zodOutputFormat` に通す | 戻り値の JSON Schema を目で比べた | 下の材料1〜5。ほかは差が無いか、既存の ADR 0072・0360 が書いている降格 |
  | 17 の形 × 応答2通り（任意の欄を値で埋める／`null` で埋める。応答は送った JSON Schema から自動で作った）を、openai の `completeStructured`（擬似 client）に通す | `{ok, 結果}` を比べた | 落ちたのは1件だけで、**自動で作る側の深さ制限の取りこぼし**（再帰の末端に `null` が入った）。実装の穴ではない。結果の相違は材料4 |
  | `z.record`（`enum`・`literal` の鍵、`partialRecord`、`pipe` の先）を2実装に通す | 同上 | 全部、openai は `toStrictJsonSchema` が、anthropic は `assertNoRecord` が断る（揃っている。偽陽性を探したが出なかった） |
  | `.describe()` と降格した制約の同居、共有スキーマの `.describe()`、`.meta({ id })` の共有、根の `describe` | 同上 | anthropic は `description` に `"name of x\n\n{minLength: 1}"` の形で足す。共有は `$defs`＋`$ref`。openai は欄にそのまま残す。害は見つからなかった |
  | 余分な `"__proto__"` の欄を含む応答 | 擬似 client | **穴（上）**。陽性対照: 修正前のコードで赤、素の `JSON.parse` + zod との比較 |

  **探した場所**: `packages/openai/src/{json-schema,structured-root,llm-provider}.ts`、`packages/anthropic/src/{json-schema,llm-provider}.ts`、core の `ExtractionResultSchema`・`ClaimKeyBatchResultSchema`・
  `ConsolidationLLMResultSchema`・`ReflectionLLMResultSchema`、両 README の構造化出力の節、`docs/decisions/0072`・`0360`、既存の歯（`json-schema`・`core-schemas-send-shape`・`structured-output-zod-shapes`・
  `structured-nullable-roundtrip`・`structured-root-union`）。**網羅は主張しない**（`grep` と手で読んだ範囲）。

- **材料**（オーナーの領分、または実 API が要るので、直していない）:

  1. **`z.any()`・`z.unknown()` の扱いが2実装で割れる。** openai は型の無い `{}`（optional なら `anyOf: [{}, {type:"null"}]`）を送り、`toStrictJsonSchema` を通る。anthropic は SDK が
     `JSON schema must have a type defined if anyOf/oneOf/allOf are not used` で投げ、`schema_unsupported` になる。**OpenAI の実 API が `{}` を受けるかは確かめていない**
     （README の実測表に無い。【判断】型の無い欄は断られるのではないかと疑っているが根拠は記憶で、確認していない）。断る入力を増やす直しになるので材料。
  2. **`null` の足しが重なる。** `.nullable().optional()`（core の `subjectId`）は `anyOf: […, {type:"null"}, {type:"null"}]`、`z.null().optional()` は `type: ["null","null"]` で送られる。
     JSON Schema の `type` の配列は重複を許さない。前者は README が「core の4つのスキーマは実 API で確かめた」と書いた範囲に入る（受けられている）と読むが、後者は確かめていない。
     送る形を変える直しで実 API の確認が要る。
  3. **`z.object({…}).catchall(T)` の `T` の値が、2実装とも黙って落ちる**（`additionalProperties: false` に強制される）。`passthrough` は意図どおり（既存の歯）だが、`catchall` は値が
     例外なしで空になる点が、ADR 0360 追記の `z.record` と同じ形。断る入力を増やすので材料。
  4. **1段目が通ると、`null` が意味を持つ欄の値が変わる。** `z.string().nullable().default("x")` に応答 `{"a": null}` を返すと、結果は `{"a":"x"}`（`stripNulls` が `null` を消し、`default` が働く）。
     `parseStructuredValue` の「1段目で通る入力の結果は変えない」の帰結。直すと既存の結果が変わる。
  5. **`z.string().pipe(z.coerce.number())` のように入力と出力の型が違う `pipe` は、出力側の型（`number`）で送るが、検査は入力側（`string`）で行う**ので、モデルが送った形に従うと必ず `ZodError`。
     `z.toJSONSchema` の既定（`io: "output"`）に依る。core の4スキーマには無い。
  6. **非 object の根**（配列・文字列・判別可能ユニオン）: openai は `result` の欄に包んで送る。anthropic は包まずにそのまま送る（`ReflectionLLMResultSchema` の根は `anyOf`）。
     Anthropic の実 API が受けるかは、README のとおり確かめていない。
  7. **制約の降格で落ちる入力**（既知。ADR 0072 決定3b・両 README）: anthropic は `min`/`max`/`minLength`/`enum` を `description` に降格するので、モデルが `confidence: 1.5` や
     `subjectId: ""` を返すと、`req.schema.parse` が `ZodError` を投げ、**その呼び出しの候補すべてが落ちる**（候補ごとの救済は無い）。今回は再測定していない。候補単位で捨てる・直す案は
     「落とす入力を増やす」＋保存の仕方に触れるのでオーナーの領分。
  8. **スキーマに `__proto__` という名前の欄**: 上の「途中で外したもの」。

- **採らなかった案**:
  - **`stripNulls` の結果の object を `Object.create(null)` にする。** zod が `Object.prototype` のメソッドを前提にすることがあり、副作用の範囲を測っていない。`defineProperty` は欄の足し方だけを変える。
  - **応答から `__proto__` の欄を明示的に捨てる。** 同じ結果になるが、スキーマが `__proto__` の欄を持つ場合に区別できない。

- **引き受けた負債**: 上の材料1〜8。とくに1・2・6は実 API に当てないと決められない。

- **これが覆るとしたら**: zod が `__proto__` を継承ではなく自分自身の欄として読むようになったとき。または、`@mnemora/openai` が応答を別の経路（SDK の `parse` 等）で検査するようになったとき。
