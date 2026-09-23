# ADR 0271: 抽出候補ごとに `subjectId` を持てるようにし、候補の値が observation の値より優先する（Issue #608 項目①）

- **状態**: 提案 (2026-09-23)
- **日付**: 2026-09-23

**⚠ この ADR を書いたのは、自動化された担い手（マネージャーから Issue #608 の項目①だけを
切り出されたセッション）である。**依頼元は「オーナー本人と対話していない」——
[ADR 0220](./0220-issue-comment-author-does-not-distinguish-owner-from-agent.md) が指す区別に
従えば、これは**担い手が北極星・Issue 本文・repo 規約を読んで自分で決めた設計判断**であり、
**オーナー本人がこの文面を承認したものではない。**

**⚠ 各主張の出所を分ける**（ADR 0261/0263 の体裁を踏む）:

- **【現物】** — この repo のコード・文書を読んで確かめた。
- **【実測】** — 実際に走らせて得た。
- **【推論】** — 読解・設計判断から導いたが、実測ではない。

---

## 問い —— [Issue #608](https://github.com/takecchi/mnemora/issues/608) 項目①

virchamate 側が観測している形（Issue 本文から逐語）:

```
Aさん「この前映画観に行ってきたけど面白かったよ」
Bさん「僕はあんまり合わなかったかも」
→ Aさんは面白いと思った        主題 = Aさん
→ Bさんは面白いとは思わなかった  主題 = Bさん
→ 映画をやっている              主題 = 映画
```

```
Aさん「明日台風来るらしいよ」
→ 明日台風が来る                主題 = なし
```

**主題は「誰と会話したか」では決まらない。抽出の結果でしか決まらない。**しかし
【現物】`ExtractedMemoryCandidateSchema`（`packages/core/src/extraction.ts`）は
`content` / `digest` / `tags` / `provenanceKind` / `confidence` のみで `subjectId` を持たず、
`buildNewMemoryFromCandidate` は候補に関係なく `params.observation.subjectId ?? null` を返す。
`buildNewMemoriesForCandidates`（`packages/core/src/runtime.ts`）は**同じ observation を
全候補へ渡す**ため、**1回の `observe()` から複数の Memory が出ても、`subjectId` は全件同じ値**
になる。

**この ADR の射程は Issue #608 の①だけである。**②（抽出器に主題を決めさせる口）・③
（`subjectId: null` の記憶を「主題なしを明示的に引く」形で recall する口）・④（会話/セッションの
器）には触れない——②③④はそれぞれ別の設計判断（recall 側の `RecallScope.subjectId` の型・
抽出プロンプトの変更・新しい器の要否）を要し、この PR に混ぜると「この PR が何を主張しているか」
が読めなくなる（`AGENTS.md`「⚠ 『ついでに直す』をしない」）。

---

## 決めたこと

### 決定1. `ExtractedMemoryCandidateSchema` に `subjectId?: string | null` を足す

```ts
subjectId: z.string().min(1).nullable().optional(),
```

**型は `Memory.subjectId` / `Observation.subjectId` と同じ `string | null | undefined`**
（`memory.ts:77`・`observation.ts:15` と同じ規約。**新しい型の発明ではない**）。

### 決定2. `buildNewMemoryFromCandidate` は「候補が `subjectId` を持てば優先する」

```ts
subjectId:
  params.candidate.subjectId !== undefined
    ? params.candidate.subjectId
    : (params.observation.subjectId ?? null),
```

### 決定3. `undefined`（省略）＝未指定、`null`（明示）＝主題なし、と線を引く

**候補が `subjectId` キーを持たない（省略・`undefined`）**なら、**従来どおり**
`observation.subjectId` へ落ちる——**既存の呼び出し側・既存の LLM 応答は1バイトも
挙動が変わらない。**

**候補が明示的に `subjectId: null` を返す**なら、**observation 側が値を持っていても**
それを上書きし、Memory は「主題なし」になる。

**採る理由**: Issue 本文の例2「明日台風が来る 主題 = なし」を読むと、**LLM が「この記憶には
主題が無い」と判断した結果を、呼び出し側の observation の主題（例: 会話相手）で上書きされては
困る**、という要求に読める。`null` を「未指定」と区別できないと、**「主題を持たない記憶」を
抽出結果として書く手段が無くなる**——これは Issue が最初から問題にしている欠落そのものである。

**検討して採らなかった案**: **`null` も `undefined` と同じ「未指定」として扱い、常に
observation の値へフォールバックする案。**

- 却下した理由: この案では「主題を持たない記憶」を候補側から言い切る手段が無くなる。
  observation が `subjectId` を持つ会話（Issue 本文の例のように、話者ごとに `subjectId` を
  渡している場合）では、**候補側がいくら「主題なし」と言っても、常に observation の値に
  上書きされてしまう**——③（「主題なしを明示的に引く」recall 口）の前提を、①の時点で
  塞ぐことになる。
- ⚠ **ただし、この2択のどちらが「LLM が実際に返しやすい形」かは実測していない**——
  現時点では抽出プロンプト（`buildExtractionPrompt`）が主題について何も言っていないため
  （②が担当する範囲）、LLM が `subjectId` を返すことはまず無く、**この区別が実地で
  踏まれるのは②が入ってから**になる。②を実装する側は、プロンプトが「主題が無いなら
  明示的に `null` を返せ」と指示する形にする必要がある——**指示しなければ、LLM は単に
  キーを省略するはずで、`undefined` 経路（＝未指定）にしかならない。**

---

## 🔴 前提を実測で確かめた

### 前提1. カセット（ADR 0051）の照合鍵は、この変更で動かない

【現物】`packages/testkit/src/__fixtures__/cassette.ts` の `llmCassetteKey`:

```ts
/**
 * **`schema` を鍵に含めない。**スキーマは「何を返してほしいか」であって「何を訊いたか」
 * ではなく、鍵に混ぜるとスキーマの些細な変更で全記録が引けなくなる。代わりに
 * 再生時に `schema` で検証し直すことで、記録とスキーマのずれは**落ちる形**で現れる。
 */
export function llmCassetteKey(prompt: PromptSpec): string {
  const canonical = JSON.stringify({
    system: prompt.system ?? null,
    messages: prompt.messages.map((m) => ({ role: m.role, content: m.content })),
  });
  return sha256Hex(canonical);
}
```

**鍵は `PromptSpec`（`system` + `messages`）だけで決まり、`schema` は鍵に入らない。**
この PR は `buildExtractionPrompt`（プロンプト文面）を1バイトも変えていない
——プロンプトへ主題を書かせる変更は②の範囲であり、この PR には無い。⟹ **鍵は動かない。**

**【実測 2026-09-23】** `pnpm --filter @mnemora/core run build` 後、新しい
`ExtractionResultSchema`（`subjectId` を足した後の版）を使って
`examples/chat/cassettes/*.json` の全 LLM entry を検算した:

| ファイル | entry 数 | `ExtractionResultSchema` で再パース成功 | 鍵の再計算が一致 |
|---|---|---|---|
| `retrieval.json` | 74 | **74/74** | **74/74** |
| `compare.json` | 13 | **13/13** | **13/13** |
| `answer.json` | 67 | 26/67（残り41件は抽出以外の schema 用の entry。想定どおり） | **67/67** |

**鍵の再計算**は、記録済みの鍵文字列を無視し、`entry.prompt` だけから
`llmCassetteKey` 相当のロジックで独自に SHA-256 を計算し直し、記録済みの鍵と一致するかを
見たもの（**全 154 entry で一致**）——これは「鍵がスキーマに依存しない」ことの直接証拠である。
`answer.json` の41件が `ExtractionResultSchema` でパースできないのは、それらが抽出以外の
構造化出力（回答生成等）の記録だからで、**この変更とは無関係**（抽出用の 26 件は全件成功）。

⟹ **カセットは1本も録り直す必要が無い。** `RecordedLLMProvider.completeStructured` は
再生時に呼び出し側の（＝この変更後の）`schema` で再検証するが（`recorded-llm-provider.ts:73`）、
`subjectId` が **optional** なので、`subjectId` キーを持たない旧い記録もそのまま
パースを通る。

### 前提2. OpenAI 向けの実リクエストの JSON Schema 自体は変わる（ただしカセットには影響しない）

【現物】`docs/architecture.md` §3.8:「OpenAI 側が strict モードのために行っている
『全キーを required にして省略可能を nullable へ倒し、返りで null を省略へ戻す』」
——`packages/openai/src/json-schema.ts` の `translateForOpenAIStructuredOutput` は
zod の optional フィールドも JSON Schema の `required` に含め、型を nullable にする。
⟹ **実 API へ送る JSON Schema には `subjectId` が新しく載る。** これは前提1が守っている
「カセットの照合鍵にスキーマは入らない」という設計のおかげで、**実キーを使った録り直しを
要求しない。** ⚠ **実 API を新たに叩いて確認してはいない**（鍵が無いため）——上の表の
「74/74・13/13」は**再生（replay）経路の検算**であり、**新しい request を実際に送って
応答を得た検算ではない。**

### 前提3. `docs/migration-v1.md` の破壊的変更の数え方に当てても、この変更は破壊的ではない

【現物】`docs/migration-v1.md`「ここで『破壊的』と呼んでいるもの」:

> `scripts/publish-targets.mjs` の `PUBLISH_TARGETS` 6パッケージの公開契約について、
> 既存の利用者のコードが型検査または実行時に壊れる変更

**この基準に当てる**:

- `ExtractedMemoryCandidateSchema.subjectId` は **optional**（`z....optional()`）——
  既存の LLM 応答・既存のテストダブルが `subjectId` を返さなくても、パースは通る
  （前提1で実測済み）。
- `ExtractedMemoryCandidate`（TypeScript 型）に**任意**プロパティが増えるだけで、
  既存のコードが `ExtractedMemoryCandidate` のリテラルを組み立てている場合でも
  **必須プロパティの不足によるコンパイルエラーは起きない**——同じ移行ガイドが
  **9**・**10**（`FilteredOmission.scopeRelation` / `OverLimitOmission.stage`）を
  破壊的と数えているのは、そちらが**必須**フィールドだったからである。**この変更は
  対称ではない**（必須ではなく任意）。
- `buildNewMemoryFromCandidate` の**戻り値の型**（`NewMemory`）は変わらない
  （`subjectId` 欄は元から `string | null | undefined` の型を持っていた）。**戻り値の
  意味的な挙動**は変わる（候補が明示的に値を持てば、それが優先されるようになる）が、
  これは**「候補が新しい欄を使ったときだけ」起きる新しい経路**であり、**候補がこれまで
  どおり `subjectId` を返さない限り、既存の呼び出し側から見た挙動は1バイトも変わらない**
  （extraction.test.ts の回帰の歯で固定）。

⟹ **この変更は `docs/migration-v1.md` の基準で破壊的ではない。** `CHANGELOG.md` の
`[1.0.0]`（未リリース）節の `### Added` に足し、`docs/migration-v1.md` の番号付き一覧
（破壊的変更専用）には足さない。

⚠ **踏まえていない角**: `ExtractedMemoryCandidate` を**自分で網羅的に組み立てている**
外部コード（例: 独自の `LLMProvider` 実装のテストダブルで、`ExtractedMemoryCandidate` の
形を厳密に検査しているもの）が、**もし** `Object.keys` の完全一致や `zod` の `.strict()`
相当の検査を自前で持っていたら、**新しい任意キーの出現そのものを「想定外」として
落とす**可能性はある。⛔ **この可能性は実測していない**——`@mnemora/*` の中には
そのような検査は無いことを grep で確認した（`describeMemoryStoreConformance` 等の
適合テストは `ExtractedMemoryCandidate` を検査対象にしていない）が、**mnemora の外の
利用者コードまでは見えない。**

---

## 歯（変異試験を含む）

`packages/core/src/__tests__/extraction.test.ts`（`buildNewMemoryFromCandidate` の単体）:

1. 候補が `subjectId` を持てば、observation の値より優先される
2. 候補の `subjectId` が明示的に `null` なら、observation の値があっても「主題なし」にする
3. 候補が `subjectId` を持たない（未指定）なら、従来どおり observation の値へ落ちる（回帰）
4. 候補が `subjectId` を持たず、observation にも無ければ `null` になる（既存の振る舞い、回帰）

`packages/core/src/__tests__/runtime.test.ts`（`runtime.observe` → `buildNewMemoriesForCandidates`
の配線、Issue の核心）:

5. 同じ observation から出た4件の候補（`user:a` / `user:b` / 明示的 `null` / 省略）が、
   それぞれ違う `subjectId` を持つ Memory になる

**赤（実装前、逐語）**:

```
❯ src/__tests__/extraction.test.ts (29 tests | 2 failed) 29ms
  ❯ buildNewMemoryFromCandidate (9)
    ❯ candidate.subjectId（Issue #608 項目①） (4)
      × 候補が subjectId を持てば、observation の値より優先される 9ms
      × 候補の subjectId が明示的に null なら、observation の値があっても『主題なし』にする 2ms
AssertionError: expected 'user-observation' to be 'user-candidate'
AssertionError: expected 'user-observation' to be null

❯ src/__tests__/runtime.test.ts (80 tests | 1 failed | 79 skipped)
  ❯ observe: 抽出候補ごとに subjectId を持てる（Issue #608 項目①） (1)
    × 同じ observation から出た複数候補が、候補ごとに違う subjectId を持つ 21ms
AssertionError: expected [ 'user:conversation-default', …(3) ] to deeply equal [ 'user:a', 'user:b', null, …(1) ]
```

**緑（実装後）**: `pnpm --filter @mnemora/core exec vitest run` → **65 test files / 927 tests
全て成功**（新規5本を含む）。

**変異試験**（`docs/autonomy.md`「⛔ 変異を戻すのに `git checkout` を使わない」に従い、
`cp` で退避してから戻した）: `buildNewMemoryFromCandidate` の `subjectId` を
`params.observation.subjectId ?? null`（旧実装）へ一時的に戻したところ:

```
Test Files  2 failed | 63 passed (65)
     Tests  3 failed | 924 passed (927)
```

**赤くなったのは、狙った3本（extraction.test.ts の2本 + runtime.test.ts の1本）だけ**——
上の「候補が subjectId を持たない（未指定）なら従来どおり」の回帰の歯・他924本は
すべて緑のまま。`cp` で復元後、927本すべてが緑に戻ることも確認した。

---

## 引き受けた負債

1. **決定3の線引き（`null`＝主題なし、`undefined`＝未指定）は、②（抽出器に主題を決めさせる口）
   が実装されるまで実地で踏まれない。** 現時点の抽出プロンプトは主題について何も言わないため、
   LLM が `subjectId: null` を明示的に返すことはまず無い。②を実装する側は、この線引きを
   プロンプトの指示に反映する必要がある。
2. **前提2（OpenAI へ送る実際の JSON Schema が変わること）を、実 API で検算していない。**
   鍵を持っていないため、`response_format` に `subjectId` が実際に載ることは
   `translateForOpenAIStructuredOutput` のコードを読んで確認したのみで、実際に
   OpenAI へ送って構造化出力が壊れないかは確かめていない。⚠ **`packages/openai` の
   既存テストスイート（`llm-provider.test.ts` 等）はモックを使っており、この PR で
   全て緑のままだった**——ただしこれは「スキーマの翻訳ロジック自体は変わっていない
   （変わるのは翻訳される*入力*スキーマの形だけ）」ことの傍証であって、実 API での
   確認ではない。
3. **③（`subjectId: null` の Memory を recall 側で明示的に引く口）は、この PR に含まれない。**
   ①だけでは、`recall()` 側の等値フィルタ（`recall-runtime.ts` の
   `scope.subjectId !== undefined && memory.subjectId !== scope.subjectId`）は変わらないため、
   `subjectId: null` の Memory は依然として「subject で絞る想起」から見えない。この PR は
   「そういう Memory を書けるようにする」ところまでで止まる。

## これが覆るとしたら

- **②（抽出プロンプトが主題を出させる）を実装する際、`null` と `undefined` の使い分けが
  LLM にとって表現しにくい・誤りやすいと分かったとき。** そのときは決定3を再検討すること
  ——本 ADR の「検討して採らなかった案」を読み直すこと。
- **mnemora の外の利用者が、`ExtractedMemoryCandidate` を厳密に（`.strict()` 相当で）
  自前検証しているという実例が見つかったとき。** そのときは前提3の「踏まえていない角」が
  実害になる——`docs/migration-v1.md` への追記が要る。
- **OpenAI の structured output が、`subjectId` の追加で `response_format` の生成に
  失敗する・拒否されると実 API で判明したとき。** 前提2の負債が実害になる。

---

## ⚠ 訂正（2026-09-23）: `AGENTS.md`「⚠ 『ついでに直す』をしない」の帰属

⛔ **本節より上は1バイトも書き換えていない。**⛔ **決定は1つも動かさない。**壊れているのは帰属だけである。

本文 `:49` は `AGENTS.md`「⚠ 『ついでに直す』をしない」と引いているが、**この文字列は
`AGENTS.md` に存在しない**（【実測】`grep -c "ついでに直" AGENTS.md` → **0**）。

🔴 **原典は [`docs/autonomy.md:136`](../autonomy.md) である**（逐語「**⚠ 「ついでに直す」をしない。**」）。
⟹ **引用の中身は正しい。指し先の文書名だけが違っていた。**

⚠ これはクローンの委譲で走っている担い手の検算であって、オーナー本人の決定ではない
（[ADR 0220](./0220-issue-comment-author-does-not-distinguish-owner-from-agent.md)）。Issue #636。
