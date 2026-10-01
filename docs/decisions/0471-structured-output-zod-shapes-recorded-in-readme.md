# ADR 0471: 穴探し42巡目 — 構造化出力の、README の表に無い zod の形5つの今の振る舞いを、2つの provider の README と歯に記録する（文書の直し）

- **状態**: 採用 (2026-10)
- **日付**: 2026-10-01

クローン miku の委譲先（マネージャー mgr-3a4ae979）が書いた。42巡目の題（39巡目の材料のうち決めてよい線の内側のものを直す）はクローン miku が決めた。オーナーの判断ではない（[ADR 0220](./0220-issue-comment-author-does-not-distinguish-owner-from-agent.md)）。
**オーナーが覆せる点は「これが覆るとしたら」にまとめてある。**
出所の区別: 【現物】は読んだコード・文書、【実測】は手元で擬似の `client` に当てた結果、【判断】は担い手の判断。

- **文脈**:

  穴探し39巡目（[PR #1576](https://github.com/takecchi/mnemora/pull/1576)。この ADR を書いた時点では未マージ）は、`@mnemora/openai`・`@mnemora/anthropic` の構造化出力の往復を当て、材料を8件残した。
  42巡目では、そのうちクローンが決めてよい線（約束に実装を戻す直し・落ちる入力を減らす直し・文書の直し・前例のある同種の穴）の内側のものを探した。

  | 材料 | コードを直すと | 線 |
  |---|---|---|
  | 1 `z.any()`・`z.unknown()` の扱いが2つの provider で割れる | 断る入力が増えるか、送る形が変わる（実 API が要る） | 外側 |
  | 2 `.nullable().optional()`・`z.null().optional()` で `null` が重なって送られる | 送る形が変わる（実 API が要る） | 外側 |
  | 3 `.catchall(T)` の値が黙って来ない | 断る入力が増える | 外側 |
  | 4 `.nullable().default(v)` に `null` が返ると openai だけ `v` になる | 既存の結果が変わる | 外側 |
  | 5 入力と出力の型が違う `pipe` は、送った形どおりの値で必ず落ちる | 送る形を変えれば落ちる入力は減るが、`z.toJSONSchema` の `io` の切り替えは `default` などの扱いも変える。core の4スキーマには無い | 外側（危うい） |
  | 6 非 object の根の包み方が割れる | 実 API が要る | 外側（README に「未確認」と既に書かれていた） |
  | 7 制約の `description` への降格で、呼び出しの候補がまとめて落ちる | オーナーの領分 | 外側（README と ADR 0072 に既に書かれていた） |
  | 8 スキーマに `__proto__` という欄 | 送る前に安全側で落ちる。歯が立たない | 外側 |

  **【現物】コードの直しで線の内側に入るものは無かった。**ただし、両方の README の「`completeStructured` に渡せる zod の形」の表に、**材料1〜5 が載っていなかった**（6・7 は載っていた）。
  文書の直しは線の内側である。

- **決めたこと**:

  1. **両方の README に小節「上の表に無い形の、今の振る舞い」を足し、材料1〜5 を表にした。**各行は、送る JSON Schema・返った値の扱い・もう一方の provider との違い。
     **「今の振る舞いの記録であって、約束ではない」**と明記し、射程（送る形と返った値の検査まで。実 API が受けるかは確かめていない）を書いた。
  2. **書いた振る舞いが黙って変わらないよう、既存の `structured-output-zod-shapes.test.ts`（openai・anthropic）に「上の表に無い形の、今の振る舞い（記録）」の `describe` を足した**（openai 5本・anthropic 5本）。
     歯の TSDoc にも「記録であって約束ではない。変えると決まったら歯と README を一緒に書き換える」と書いた。今の2つの実装がどちらも通る歯である。
  3. **コードは変えていない。**CHANGELOG は、利用者に見える変更が無いので足していない。

- **測ったこと**（【実測】。擬似の `client` で、送った本文の JSON Schema と、返った値の検査の結果を見た。使い捨ての探り棒は commit していない）:

  | 形 | openai が送る形 | openai の返った値 | anthropic が送る形 | anthropic の返った値 |
  |---|---|---|---|---|
  | `z.any()`・`z.unknown()` | `{}` | どんな値でも通る | 送る前に `schema_unsupported` | — |
  | `.nullable().optional()` | `anyOf: [{type:["string","null"]},{type:"null"}]` | — | `type: ["string","null"]` | — |
  | `z.null().optional()` | `type: ["null","null"]` | — | `type: "null"` | — |
  | `.catchall(z.number())` | `additionalProperties: false`、`properties` は `a` だけ | 余分な欄が来れば `T` で検査して残る | 同じ | 同じ |
  | `.nullable().default("x")` に `{"a":null}` | `type: [...,"null"]` と `default` | `{"a":"x"}` | `default` は `description` に降格 | `{"a":null}` |
  | `z.string().pipe(z.coerce.number())` | `type: "number"` | `{"x":5}` は `ZodError`、`{"x":"5"}` は `{"x":5}` | 同じ | 同じ |

  - 歯: `packages/openai/src/__tests__/structured-output-zod-shapes.test.ts` は 22本、`packages/anthropic/src/__tests__/structured-output-zod-shapes.test.ts` は 33本が緑（隣の `json-schema.test.ts` を含む数）。
  - 変異: openai の `stripNulls` が `null` を消さないようにすると（`return undefined` → `return null`）、`.nullable().default(v)` の歯だけが赤になった（1 failed・4 passed）。`cp` で戻すと 5本とも緑。
    anthropic の側は、実装の変異では確かめていない（送る形は SDK の `zodOutputFormat` と zod が作り、mnemora の実装の変異で動かせる行が少ない）。

- **採らなかった案**:
  - **材料5（`pipe`）を、送る形を入力側（`io: "input"`）にして直す**。落ちる入力は減るが、`io` の切り替えは `default`・`optional` の送り方も変え、core の4スキーマの送る形（カセットの鍵）に触れうる。範囲を測っていないので採らなかった。
  - **README に書かずに歯だけ足す**。README の表は利用者が読む場所で、歯だけでは利用者に届かない。

- **引き受けた負債**:
  - 表の各行は今の振る舞いの記録で、OpenAI・Anthropic の実 API が送った形を受けるかは確かめていない（材料1・2・6 は実 API に当てないと決められない）。
  - anthropic の行は、実装の変異では確かめていない（上の「測ったこと」）。

- **これが覆るとしたら**:
  - 材料1〜5 のどれかの振る舞いを変えると決まったとき（オーナーの判断）。そのときは歯と README の表を一緒に書き換える。
  - zod か SDK の版が上がって送る形が変わったとき。歯が赤くなるので、表を実測で書き直す。
