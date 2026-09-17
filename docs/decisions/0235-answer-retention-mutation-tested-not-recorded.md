# ADR 0235: Issue #498 完了条件4を内容保持の側だけで満たす — 回答評価側の陽性対照は実 API での記録追加を要するため未達のまま残す

- **状態**: 採用 (2026-09)
- **日付**: 2026-09-18

**⚠ 各主張の出所を分ける**（ADR 0226 / 0227 / 0233 の体裁を踏む）。

- **【実測】** — この ADR の作業者が自分の手で読み・走らせて確かめた。
- **【現物】** — この repo のコード・文書を読んで確かめた。
- **【受】** — 委譲文として受け取り、この ADR の作業者が再導出していない。

---

## 文脈

Issue #498 完了条件4 の逐語【現物】（`gh api repos/takecchi/mnemora/issues/498 --jq '.body'` で直接読んだ）:

> 同じ出典のまま答えの情報を欠落させた場合に、**内容保持または回答評価が失敗する**ことを確認する。

**「または」であり、選言である。** どちらか一方を満たせば逐語は満たされる。

Issue #498 の設計コメント §7（【現物】、`gh api .../issues/498/comments` で直接読んだ）は、当初この条件を
**回答評価（層3）側の制御された陽性対照**として計画していた:

> 同じ `sourceObservationId` を保ったまま、`digest` から答えの語を落とす変異を入れ、
> 1. 層1（`factStatementSurvived`）は `true` のまま ⟹ 出典到達は情報保持を証明していない
> 2. 層3（一次判定）が赤になる ⟹ 復元して緑

同§7 は同時に、この計画が**記録に無い変異後のプロンプトはカセットに当たらない**という機構上の制約を
抱えていることも書いている:「変異させると回答生成プロンプトが変わり、鍵が変わる ⟹ カセットに無い ⟹
例外になる。⟹ 記録の際に、変異後のプロンプトも記録対象へ含める」。

**ADR 0233（PR #514）が実 API での記録・回答生成・一次判定・二次観測（judge）を着地させた**が、
完了条件4 の変異試験そのものは実装しなかった。Issue #498 の最新コメント（2026-09-18、【現物】）が
この照合を既に行っている:

> 完了条件のうち、4番目だけが未達です……ADR 0233 が【実測】として報告している変異は2つとも
> カセット被覆検査です……これらは録り忘れの検出であって、情報欠落による回答評価の失敗の
> 確認ではありません……残っているのは1本だけです：「出典を保ったまま digest から答えの情報を
> 落とすと、回答評価（層3）が赤になる。戻すと緑に戻る」の確認。

**本 ADR は、この残り1本を「内容保持（層2）」の側で満たし、「回答評価（層3）」の側は
未達のまま残す判断を記録する。**

## なぜ回答評価の側をやらないか — カセットの現物分析

### 【実測】この ADR の作業者が `node -e` で直接読んで再導出した数字

実 API は1回も叩いていない。`examples/chat/cassettes/answer.json` を `node -e` で読み、
`llm.entries`（`Record<string(SHA-256), LLMCassetteEntry>`）の `prompt.system` の先頭30文字で
分類した:

```
$ node -e '
const data = JSON.parse(require("fs").readFileSync("examples/chat/cassettes/answer.json","utf8"));
const entries = data.llm.entries;
const keys = Object.keys(entries);
console.log("total entries:", keys.length);
const by = {};
for (const k of keys) {
  const sys = (entries[k].prompt.system || "").slice(0, 30);
  by[sys] = (by[sys]||0)+1;
}
console.log(by);
'
total entries: 67
{
  'あなたは会話・イベント・文書から再利用可能な記憶を抽出するア': 26,
  '以下の会話ログだけを根拠に、簡潔に答えてください。根拠が無け': 24,
  'あなたは回答の採点者です。与えられた質問・正解の根拠・会話の': 17
}
```

**⟹ 67件 = 抽出26 + 回答生成24 + judge17。**

回答生成の24件をさらに、`prompt.messages[0].content` 末尾の `質問: ...` で分類すると:

```
$ node -e '(同ファイルから answerGen 24件を抽出し、"質問: (.*)$" でグルーピング)'
distinct questions: 12
{ 各質問: 2件ずつ（naive 1件 + mnemora 1件） }
```

**⟹ 相異なる質問12件 × {naive, mnemora} の対で、余りは0件。** naive/mnemora は
system prompt が同一文字列（全24件で1種類）だが、`messages[0].content`（会話ログ全文 vs
digest の並び）が経路ごとに異なるため、24件すべてが distinct な鍵を持つ。

**⟹ 変異後の回答生成プロンプト（digest から答えの語を落とした mnemora 側の messages）は
1件も記録されていない。**

### 鍵の機構【現物】

`packages/testkit/src/__fixtures__/cassette.ts` の `llmCassetteKey(prompt)`:

```ts
export function llmCassetteKey(prompt: PromptSpec): string {
  const canonical = JSON.stringify({
    system: prompt.system ?? null,
    messages: prompt.messages.map((m) => ({ role: m.role, content: m.content })),
  });
  return sha256Hex(canonical);
}
```

`{system, messages}` を正準化した JSON の SHA-256 である。⟹ `digest`（= mnemora 側の
`messages[0].content` の一部）を変異させれば、この鍵は必ず変わる。`RecordedLLMProvider`
は記録に無い鍵を引くと例外を投げる（ADR 0051 の中心設計、【現物】未変更）。

**⟹ 変異後のプロンプトを `recorded` で通す唯一の方法は、実 API で記録し直すことである。**

⚠ **この節の数字（67 = 26+24+17、24 = 12×2、余り0、鍵は `llmCassetteKey` の SHA-256）は、
この ADR の作業を委任した側が事前に分類したものとして渡された（初期の依頼文に含まれていた）。
この作業者は上記コマンドで独立に再導出し、一致を確認した。⟹ 出所は【実測】（この作業者が
自分の手で走らせて確かめた）であり、伝聞をそのまま書き写したものではない。**

## 決めたこと

### 決定1: 完了条件4 を「内容保持」の側で満たす。「回答評価」の側は未達として残す

`examples/chat/src/__tests__/provenance-trace.test.ts` に、既存の Issue #496 の
`describe` ブロック（内容は1文字も変えていない）に加えて、新しい `describe` を1つ足した:

> `buildMnemoraPrompt vs resultContainsObservation: 出典到達は内容保持を保証しない
> （Issue #498 完了条件4・内容保持の側）`

この検査は既存の現物2つだけを使う純関数の組み合わせであり、LLM も DB も呼ばない:

- `examples/chat/src/provenance-trace.ts` の `resultContainsObservation`（層1・出典到達。
  `digest` を一切読まない）
- `examples/chat/src/mnemora-path.ts` の `buildMnemoraPrompt(recall: RecallResult): string`
  （純関数。`recall.memories[].digest` を `- ` 付きで並べ、末尾に索引行を足すだけ）

**4段の構成**:

1. 同じ `sourceObservationId`（`"obs-target"`）を保ったまま、`digest` から答えの語
   （「青」）を落とした `RecallResult` を用意する。
2. **層1（`resultContainsObservation`）が `true` のまま**であることを検査する。
3. **`buildMnemoraPrompt()` の出力に答えの語が含まれない**ことを検査する
   ⟹ 内容保持（層2）の失敗を、変異という形で固定する。
4. 復元（digest に答えの語を戻す）すると、`buildMnemoraPrompt()` の出力にも答えが戻り、
   層1も引き続き `true` であることを検査する ⟹ 緑に戻る半分。

**【実測】この検査が実際に噛むことを、意図的に壊して確認した。** 3番目のアサーション
（`.not.toContain(ANSWER_WORD)`）の入力である `DIGEST_INFO_LOST` を、答えを含む文字列
（`"私の好きな色は青です。"`）へ一時的に変えて実行したところ、期待どおり赤くなった:

```
AssertionError: expected '- 私の好きな色は青です。\n(索引:...' not to contain '青'
```

その後 `cp` で元に戻し、緑に戻ることを確認した（`docs/autonomy.md` の変異を戻す作法に
倣い、`git checkout` は使わず `cp` で退避・復元した）。

### 決定2: 回答評価（層3・judge）の側は実装しない。未達として残す

**理由は決定的機構である**（上記「なぜ回答評価の側をやらないか」）。この検査は
`gradeAnswer`/judge を1度も呼ばない。

## 証明する範囲

- ⭕ **示すもの**: 出典到達（層1、`resultContainsObservation`）が `true` のままでも、
  **モデルへ渡る文（`buildMnemoraPrompt()` の出力）からは答えの語が落ちうる。** これは
  Issue #496 の主張（出典到達は情報保持の証明ではない）を、`compare` 表示側の言い換えでは
  なく、**実際にモデルへ渡す文字列を組み立てる関数**に対して固定したものである。
- ⛔ **示さないもの**: **評価器（`gradeAnswer`/judge）がその欠落を捕まえられること。**
  それが Issue #498 設計コメント §7 が意図した陽性対照であり、**実 API での記録の追加を
  要するため未達である**（上記「なぜ回答評価の側をやらないか」）。この検査は judge を
  1度も走らせていない。
- ⛔ **さらに正直に書く**: **3番目の検査（`buildMnemoraPrompt` の出力に落とした語が
  無いこと）は、それ単独ではほぼ同語反復である。** `buildMnemoraPrompt` は `digest` を
  そのまま並べる純関数なので、答えを含まない `digest` を渡せば答えを含まない文字列が
  返るのはほぼ自明である。**意味を持つのは、2番目（層1が `true` のまま）との対比だけ
  である。** 出典には届いているのに、モデルへ渡る文からは答えが消えている——その食い違い
  こそがこの検査の値打ちの全部である。

## 採らなかった案

- **⛔ (a) 実 API で記録し直し、設計コメント §7 どおりの陽性対照（層3が赤になる側）を作る。**
  却下。`docs/conformance.md` §7・ADR 0184 決定4 により、実 API を叩く判断はオーナーの
  ものである。ADR 0233 は既にオーナーから鍵を借りて実測を行い、返却している——**頼み直す
  には、返したときより強い理由が要る。** #498 は v1.0.0 のリリースを止めていない
  （`docs/roadmap.md` の Phase 1 完了項目に #498 は含まれない）。⛔ **費用（この ADR の
  試算では既存記録が chat 67回・数セント未満の見込み）は却下の理由ではない**——理由は
  鍵の使用判断そのものがオーナーの領分だからである。
- **⛔ (b) `deterministic` で回答を作って採点する。** 却下。`docs/autonomy.md` §2.2 決定3
  の逐語「**意味的品質を測るときに `deterministic` stub へ置き換えない**」が明示的に
  禁じている。回答が正しいかどうかは意味的品質そのものである。
- **⛔ (c) `schedule-change-deadline`（ADR 0233 が見つけた自然発生の fail）を条件4 の
  充足として扱う。** 却下。Issue #498 の最新コメントが既に指摘している通り、これは
  **制御された変異ではなく自然に起きた観測**であり、しかも失敗様式が「答えの情報を
  欠落させた」ではなく「撤回済みの値が残り supersede が効いていない」という別物である。
  復元して緑に戻す半分も存在しない。

## 確かめていないこと

- **評価器（`gradeAnswer`/judge）の検出力。** この検査は評価器を1度も走らせていない。
  完了条件4 の「回答評価が失敗する」側は、この PR の後もまだ実測されていない。
- **PR #514 の記録に、変異後の回答生成プロンプトが偶然含まれていないか**を逐一は
  確認していない——上記「なぜ回答評価の側をやらないか」節の分類（67 = 26+24+17、
  回答生成24件が12質問×2経路で余り0）自体が、含まれていないことの直接的な確認になっている。
- **この検査の外の経路**（`answer-bench.ts` が実際に組み立てる `PromptSpec` や、
  実 API 経由の `complete()` 呼び出し）に同種の変異を当てたときの挙動。この検査は
  `buildMnemoraPrompt` という1つの純関数だけを対象にしている。

## 引き受けた負債

**完了条件4 の逐語（選言）は満たすが、設計コメント §7 の意図（回答評価側の陽性対照）は
満たしていない。⟹ Issue #498 は閉じない。** 次に鍵を借りる機会があれば、設計コメント §7
の変異後プロンプトを記録対象に含めて記録し直し、層3（judge）側の陽性対照を追加すべきである。

## これが覆るとしたら

- **オーナーが再び鍵を貸し、変異後の回答生成プロンプトを含めて `record answer` を
  実行したとき。** そのとき初めて、設計コメント §7 どおりの層3側陽性対照を追加できる。
- **`gradeAnswer`/judge の偽陽性・偽陰性率が別途実測されたとき**（ADR 0233「確かめていない
  こと」節、ADR 0223 決定3）。そのとき、この検査が judge を呼ぶ形へ拡張する価値の
  有無を再検討できる。

## 人から受け取った前提（出所付き）

- 本 ADR が採る方針の骨子（内容保持の側だけを満たす・回答評価側は未達として残す・
  鍵は頼み直さない）は、この作業を委譲した側からの委譲文として受け取った。この ADR の
  作業者が独自に導出したものではない。
- カセットの分類（67 = 26+24+17、24 = 12×2 余り0、鍵は `llmCassetteKey` の SHA-256）は、
  委譲文に含まれていた数字を、この ADR の作業者が `node -e` で独立に再導出し、一致を
  確認した——**出所は【実測】である**（上記「なぜ回答評価の側をやらないか」節末尾）。
- Issue #498 の本文・コメント——`gh api repos/takecchi/mnemora/issues/498` /
  `.../comments` で直接読んだ【現物】。
- ADR 0226 / 0227 / 0233 の内容——`docs/decisions/` から直接読んだ【現物】。
- `provenance-trace.ts` / `mnemora-path.ts` / `packages/testkit/src/__fixtures__/cassette.ts`
  の現状——この ADR の作業者が実際に読んで確認した【現物】。
- **DB を要する検査**（`examples/chat` の `*.postgres.test.ts`）は、この作業環境に
  `DATABASE_URL` が無いため実行していない。PR 本文参照。
