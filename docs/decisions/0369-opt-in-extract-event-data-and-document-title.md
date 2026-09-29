# ADR 0369: `event.data`・`document.title` を抽出（LLM）へ渡す口を、opt-in の任意欄として足す

- **状態**: 採用 (2026-09)
- **日付**: 2026-09-29

**⚠ 各主張の出所を分ける。**

- **【現物】** — この repo のコード・文書を書き手が読んで確かめた。
- **【実測】** — この書き手が自分の手で本物の PostgreSQL 17（`packages/postgres` の
  手順で立てた、自分専用のインスタンス）に対して確かめた。

---

## 問い（[Issue #1185](https://github.com/takecchi/mnemora/issues/1185)）

`observe()` の `event.data` と `document.title` は、既定では抽出（LLM）のプロンプトにも、
LLM 呼び出しが失敗したときの全文フォールバックの Memory の本文にも入らない
（`observationPayloadText`、`packages/core/src/extraction.ts`）。これは PR #1346
（[#1346](https://github.com/takecchi/mnemora/pull/1346)）が今の振る舞いとして歯で縛った
——だが「渡すかどうか」自体は Issue #1185 が積み残した未決事項だった。

呼び出し側が `data`・`title` の中身も抽出させたい場合、今までの回避策は「`name`/`content`
に書くか、`utterance`/`document` で渡す」しかなかった。**⟹ 直すかどうかではなく、どう直すかが
問い。**委譲元（クローン miku）が方針をオーナーへ確認済みで、本 ADR はその方針の実装を担う。

## 決めたこと

1. **公開型に任意の欄を2つ足す**: `ObserveEventInput.extractData?: boolean`、
   `ObserveDocumentInput.extractTitle?: boolean`。**既定は両方とも `false`（渡さない、今の
   振る舞いのまま）。**
2. **`true` のときだけ、Observation の `payload` に印を保存する**（event なら
   `extractData: true`、document なら `extractTitle: true`）。`extractObservationPayload`
   （`packages/core/src/runtime.ts`）が、渡された入力の `extractData`/`extractTitle` が
   厳密に `true` のときだけ、そのキーを payload オブジェクトへ足す——**未指定・`false`
   のときは、payload にこのキー自体が増えない**（`payload` は今の振る舞いと1バイトも
   変わらない）。
3. **抽出プロンプトと全文フォールバックの本文は、payload の印を見て次の同じ文字列を使う**
   （`observationPayloadText`、`packages/core/src/extraction.ts`。両方とも同じこの関数を
   通るので、プロンプトと全文フォールバックは常に同じ文字列になる）:
   - **document**: 印があり `title` が空でない文字列のとき `${title}\n\n${content}`。
     **例外——印があり `title` が空でなく、`content` が空文字のときは `title` だけ**
     （区切りの後に何も続かない `${title}\n\n` を避けるため。「N の実測」ではなく素朴な
     書式選択だが、歯で縛った——下記「歯」参照）。
   - **event**: 印があり `data` がキーを1つ以上持つプレーンオブジェクトのとき
     `${name}\n\n${JSON.stringify(data)}`。`data` を渡さない・空オブジェクト `{}`
     （既定値）のときは、印があっても `name` だけ（今の既定と同じ経路にそのまま流れる）。
   - **印が無い・条件に当たらない**（`title`/`data` が空）ときは、既存の分岐
     （`text` → `content` → `name` → `JSON.stringify(payload)`）を1バイトも変えずに通る。
4. **上限は設けない。** 理由: 今も `content`・`name` に上限は無く、抽出プロンプトの大きさは
   本文にほぼ比例するとすでに `buildExtractionPrompt` の doc コメントに実測が書いてある
   （Issue #449・#1163）。`JSON.stringify(data)` を足しても、この比例則の外に出る新しい
   種類の負債にはならない。`@mnemora/postgres` の書き込みも、ADR 0364（migration 0025）の
   tsvector 索引フォールバックにより、大きな本文で例外にならない——**上限が要るとしたら、
   それは `content`/`name` を含む全体の課題であり、この Issue の射程ではない**（別 Issue）。
5. **`extract: 'deferred'` と同時に指定しても例外にしない。** `subjectCandidates`・
   `claimKey`（両方とも `extract: 'deferred'` と同時に渡すと `runtime.observe` が例外を
   投げる、`observation.ts` の `SUBJECT_CANDIDATES_WITH_DEFERRED_EXTRACT_ERROR_PREFIX`/
   `CLAIM_KEY_WITH_DEFERRED_EXTRACT_ERROR_PREFIX`）とは事情が異なる——あちらは「どこにも
   永続化されない」ため deferred 側が構造的に見られないのに対し、`extractData`/
   `extractTitle` は payload に印として**永続化される**ため、`processExtractJob`
   （deferred 側、`getObservation` で読み直す）も `reextract`（同じく `getObservation`
   で読み直す）も、印を見て同じ振る舞いを再現できる。

## 検討した代替案

- **`data`/`title` を常に（既定で）抽出へ渡す**: 却下。PR #1346 の歯・`docs/memory-model.md`
  等がすでに「既定では渡らない」ことを既存の契約として書いており、既定を変えると破壊的変更に
  なる（呼び出し側が「`data` は抽出に写らない」ことを前提に、機密・大きすぎる値をあえて
  `data` に入れている可能性がある）。opt-in にすれば、この前提を壊さずに口だけを足せる。
- **`data`/`title` の一部だけを渡す（例えば特定のキーだけ・文字数の上限つき）**:
  却下（見送り）。「どのキーを」「どこまで」を切り出す基準を Issue 本文も委譲元の指示も
  持っておらず、恣意的な基準を machine の判断で決め打ちにすると、後から要件が変わったときに
  互換性を壊さず調整できなくなる。**全部渡すか渡さないか**の二値にしておけば、将来の
  絞り込みは呼び出し側で `data`/`title` を加工してから渡す形でも実現できる。
- **`title`/`content` を常に `${title}\n\n${content}` にする（`content` が空でも）**:
  却下。`content` が空のとき `${title}\n\n` のように末尾に空行が浮かぶ形になり、LLM への
  入力として不自然（かつ全文フォールバックの Memory の本文としても見苦しい）。`title` だけを
  返す形にした。**`content` が空になるのは `observe()` の入力 schema（`content: z.string()
  .min(1)`）がある限り通常は起こらない**——`reextract` が読み直す既存データ（例えば
  この PR より前に作られた行）等の経路でだけ現れうる、という位置づけである。

## 歯

`packages/postgres/src/__tests__/observe-event-data-document-title-extract-opt-in.postgres.test.ts`
（testkit の `InMemoryMemoryStore` と `@mnemora/postgres` の両方、`describe.each` の KITS 形式
——PR #1346 と同じ形）が、次を縛る:

- **a.** `extractData`/`extractTitle` を渡すと、抽出のプロンプトに合成した文字列が完全一致で入る。
- **b.** 同じ opt-in で、LLM 失敗時の全文フォールバックの本文にも同じ文字列が入る。
- **c.** 指定しないとき、payload・プロンプト・フォールバック本文がバイト単位で今と同じ
  ——カセット鍵（`llmCassetteKey`、`@mnemora/testkit`、ADR 0051）も、`origin/main`
  （`a53b2b7`）で同じ入力から計算した固定値と一致することを縛る。
- **d.** `extract: 'deferred'` と同時に指定しても例外にならず、`tick()` の処理後のプロンプトに
  入る。
- **e.** `reextract` で、保存済み observation の payload から opt-in が再現される。
- **f.** `extractTitle: true` かつ `content` が空文字なら `title` だけを本文にする（`title`
  も空なら、印なしの既定と同じ経路——`JSON.stringify(payload)` フォールバック——を通る。
  Postgres の jsonb はオブジェクトのキー順を保証しないため、この分岐の期待値は `JSON.parse`
  した形で比較している）。
- **g.** `extractData: true` でも `data` を渡さない・空オブジェクトなら `name` だけになる
  （既定と同じ）。

既定を縛る既存の歯
（`observe-event-data-document-title-not-extracted.postgres.test.ts`、PR #1346）は、
「opt-in しなかった既定の呼び出し」だけを対象とする旨へヘッダを整えた
（本 PR で opt-in の口自体は増えたが、その口を使わない呼び出しの振る舞いは変えていない）。

## 【実測】赤→緑

`origin/main`（`a53b2b7`）を別 worktree（`/tmp/mgr-b5dddd42-red`、clone の外）に置き、
このブランチが新しく足したテストファイル1本
（`observe-event-data-document-title-extract-opt-in.postgres.test.ts`）だけを写して確認した。

**型検査（`tsc -p tsconfig.json`）はこの時点で落ちる**——`extractData`/`extractTitle` が
`ObserveEventInput`/`ObserveDocumentInput` にまだ無いため、9箇所が
`TS2353: Object literal may only specify known properties` になる。これ自体が「まだ
実装されていない」ことの型レベルの赤である。

**振る舞いの赤も別途確認した**（`vitest run` は esbuild による単発の transpile であり
`tsc` の型検査を経由しないため、型エラーを迂回して同じテストを実行できる）。同 worktree の
Postgres（同インスタンス内の別 DB `mnemora_test_red`）に `origin/main` の migration
（0025 まで。`extractData`/`extractTitle` はスキーマ変更を伴わないので migration の差分は
無い）を適用し、`DATABASE_URL` をそちらへ向けて走らせたところ:

```
Test Files  1 failed (1)
     Tests  14 failed | 4 passed (18)
```

赤くなった14件は a・b・d・e（opt-in が実際に効くことを主張する歯）と f の前半（`title`
だけになる歯）——`extractData`/`extractTitle` を渡しても main は無視するため、期待した
合成文字列ではなく従来どおり `name`/`content` だけの文字列が返り、期待値と食い違って赤に
なった。**緑のまま残った4件は、意図どおり main でも成立する主張**——c（既定は不変。
main 自身がその既定の実装なので通って当然）・g（`data` 未指定/空なら `name` だけ、これも
既定の実装のまま）・f の後半（`title` も空のときの `JSON.stringify(payload)` フォールバック
——`extractTitle` の値は payload に含まれて一緒にシリアライズされるだけで、main の
`observationPayloadText` 自体はこの印を一切見ないため、どちらの版でも同じ結果になる）。

本ブランチの変更（`packages/core/src/extraction.ts`・`runtime.ts`・`observation.ts`）を
同じ worktree へコピーし、同 DB のまま再度走らせると、18件すべて緑になった
（下の「回帰の確認」参照）。

## 回帰の確認

作業ブランチ自身（clone、`/tmp/mgr-b5dddd42`）の手元 Postgres（同じ17系、`C.UTF-8`）で、

```
pnpm --filter @mnemora/postgres exec vitest run \
  src/__tests__/observe-event-data-document-title-not-extracted.postgres.test.ts \
  src/__tests__/observe-event-data-document-title-extract-opt-in.postgres.test.ts
```

を実行し、`Test Files 2 passed (2)` / `Tests 22 passed (22)` を確認した——既定を縛る
PR #1346 の歯（opt-in しない4件）と、本 ADR が足した opt-in の歯（18件）の両方が同時に緑である。

**デフォルトの `llmCassetteKey` が動いていないことも、この worktree 比較の副産物として
確認できた**——`c` の歯は `origin/main`（型検査を迂回した振る舞い比較）でも緑だったため、
既定経路のプロンプト文字列（延いてはその sha256）は本 PR の前後で変わっていない。

## 公開 API 表面の門（ADR 0178）

`pnpm run api:check` が `@mnemora/core` の snapshot
（`scripts/__snapshots__/public-api/core.d.ts`）に差分を検出した。差分は
`ObserveEventInput`/`ObserveDocumentInput` への `extractData?: boolean`/
`extractTitle?: boolean` の追加と、対応する zod スキーマ（`ObserveInputSchema` の内部表現）
への `extractData`/`extractTitle` の追加のみ——既存の欄・型は1つも削除・必須化・狭小化して
いない。**新しい任意プロパティの追加は非破壊**（ADR 0178 の分類）と判断し、
`node scripts/check-public-api-surface.mjs --write` で snapshot を更新した
（他の6パッケージの snapshot に差分は無い）。

## 引き受ける負債

- **`title`/`content` どちらも空の document・`data` が空の event では、opt-in しても中身が
  増えない。** これは仕様どおり（決めたこと3）だが、呼び出し側が「印を付けたのに効いていない」
  と誤解しうる。ドキュメント（`ObserveEventInput.data`/`ObserveDocumentInput.title` の
  TSDoc）に明記した以上のガードは無い。
- **上限を設けないため、`data`/`title` が非常に大きい場合、既存の `content`/`name` と同じ
  懸念（プロンプトサイズ・`@mnemora/postgres` の tsvector 索引）をそのまま引き継ぐ。**
  ADR 0364 がこの懸念を tsvector 側では実際に塞いでいるが、LLM 側のトークン上限に当たる
  可能性は変わらず存在する（`content`/`name` の既存の負債と同型であり、本 ADR が新しく
  持ち込むものではない）。

## 確かめていないこと

- **実 API（gpt-5.4-mini・claude 等）に、`extractData`/`extractTitle` で合成した本文
  （`${name}\n\n${JSON.stringify(data)}`・`${title}\n\n${content}`）を渡したときの
  抽出結果の質**は測っていない——この ADR は「渡る・渡らない」という配線の契約だけを
  縛り、渡した後 LLM がその情報をどう使うかは範囲外である。
- **`data` に深くネストした・巨大な値を渡したときの、実際のトークン数・実 API のコスト**は
  実測していない（決めたこと4の「上限を設けない」根拠は、既存の `content`/`name` の実測を
  援用したものであり、`JSON.stringify(data)` 特有の膨張率は別途測っていない）。
