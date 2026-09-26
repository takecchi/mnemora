# ADR 0305: `EmbeddingProvider` の契約に「上限超過は例外」を明記する — Issue #449 の経路は塞がず、契約と歯で名乗らせる

- **状態**: 採用 (2026-09)
- **日付**: 2026-09-25

**⚠ 各主張の出所を分ける。**「【実測】」はこの作業でこの器から実行して取ったもの。
「【受領】」はマネージャーから前提として渡され、この作業では別途裏を取っていないもの
（ADR 0090 と同じ記法）。

---

## 0. 前提 — この ADR が閉じる問い、閉じない問い

[Issue #449](https://github.com/takecchi/mnemora/issues/449) は3段つながりの経路を報告した:

1. `packages/core/src/observation.ts` の `ObserveDocumentInputSchema.content` に
   `.max()` が無い。
2. `packages/core/src/extraction.ts` の LLM 抽出が失敗すると、
   `fallbackWholeObservationCandidate` が Observation の全文を1件の候補にする。
3. `packages/core/src/runtime.ts` の `processEmbedJob` がその全文を
   `embed(ctx, [memory.content])` へそのまま渡す。

Issue 本文はこれを「提案ではなく経路の報告」として立て、**取り扱い（`v1.0.0` を止めるか
含む）をオーナーの判断に委ねていた。** オーナーは Issue 上で既に判定を返している
（逐語）:

> ⭕ **`v1.0.0` を止めない。既知の弱さとして出す**
> 🔴 「穴が無い」のではない。安全を担っているのは ADR 0090 の【受領】1行である
> ——「OpenAI は上限超過をサーバが拒否する」。**この repo の誰も、実 API に当てて
> 確かめていない。**
> ⛔ close しない。

**⟹ この ADR は「穴を塞ぐ」ADR ではない。**採るのは、Issue 本文が挙げた4つの方向の
うち**方向3**（「`EmbeddingProvider` の契約として上限超過は例外、と全 adapter に要求し、
適合テストで測る」）を、**既定の挙動を1つも変えずに**実装する形である。方向1
（`content` に `.max()`）と方向2（fallback 側で切る）は明示的に採らない——理由は
決定6 で後述する。

---

## 1. 現物の確認（Issue 本文の再検算）

**main = `f3b3516`（2026-09-25、このブランチが切られた時点）で、Issue 本文の3段は
そのまま成立している**【実測】:

- `packages/core/src/observation.ts:271` 付近: `content: z.string().min(1)`。`.max()` 無し。
- `packages/core/src/extraction.ts`: LLM 抽出が例外を投げた `catch` で
  `candidates: [fallbackWholeObservationCandidate(observation)]` を返す。
- `packages/core/src/runtime.ts` の `processEmbedJob`（`:2889` 付近）: 例外を握りつぶさず、
  `setEmbeddingStatus(ctx, memory.id, "failed")` を書いてから再送出する。

**⟹ 「embed が例外を投げれば」の側（`processEmbedJob` の catch → `failed` → 再送出）は
既に実装されている。危ないのは adapter が黙って切り詰めてベクトルを返す場合だけ**
——ここが Issue #449 のコメント欄（openai 側の棚卸し）が指した箇所と一致する。

**`packages/core/src/interfaces/embedding-provider.ts` の契約に、入力上限の記述は
無かった**【実測】。`packages/testkit/src/embedding-provider-conformance.ts` も
上限超過を測っていなかった（`grep -n "too_long\|input_too_long\|maxInput"` で0件）。
`packages/openai/src/embedding-provider.ts` は入力長の検査を1つも持たない（`texts.length
=== 0` の早期 return のみ）。`packages/local-embedding` は ADR 0090 が
`kind: "input_too_long"` を推論前に投げる形を既に入れている。

---

## 2. 【受領】実測の追加 — OpenAI は実際にサーバが拒否する（このモデル・この回数では）

ADR 0090 §7 は「OpenAI の8191トークンと、上限超過時の振る舞い（サーバが拒否するのか）を
実 API で確かめていない」と明記していた。Issue #449 のコメント欄も同じ欠落を指している。

**マネージャーが実 API に1回だけ当てて、これを埋めた**【受領・実測 2026-09-25、実 API 1回】:

```
model: text-embedding-3-small
input: " hello".repeat(10000)
→ HTTP 400
  {"error":{"message":"Invalid 'input[0]': maximum input length is 8192 tokens.",
            "type":"invalid_request_error","param":null,"code":null}}
```

⟹ **ADR 0090 の【受領】「OpenAI はサーバが拒否する」は、このモデル・この1回では
裏が取れた。** ⚠ **この作業者自身は実 API を叩いていない**（指示により禁止されている）。
この節の実測は、マネージャーが実行し、この作業者が結果を受け取っただけである
——ADR 0090 冒頭の記法に倣うなら【実測・委】に近いが、実行者がこの ADR の直接の
依頼者であるため、Issue #449 の言い回しに合わせて【受領・実測】と表記する。

**限界を隠さない**:

- **モデル1つ・1回の実測である。** `text-embedding-3-large` やページ間で挙動が違う
  可能性・将来 OpenAI がサーバ側の挙動を変える可能性は、この1回では検算できない。
- **`dimensions` パラメータ付きの呼び出し**（`OpenAIEmbeddingProvider` が実際に送る形）
  ではなく、素の `input` 超過での実測である。挙動が変わる理由は無さそうだが、
  **確かめていない。**
- ⟹ **この実測は「歯」にはならない**（歯にするには CI から繰り返し実 API を叩く必要が
  あり、それは ADR 0019 §5c が塞いだ課金の穴を再び開ける）。**契約の根拠として ADR に
  記録するところまでに留める。**

---

## 3. 決定

### 決定1: `EmbeddingProvider` の契約に「上限超過は例外」を明記する（型は不変）

`packages/core/src/interfaces/embedding-provider.ts` の interface doc に追記した:

> `texts` の要素が実装の入力上限（トークン数）を超えたら、`embed` は例外を投げる。
> 黙って切り詰めて、正常な顔をしたベクトルを返してはならない。

**型シグネチャは1文字も変えていない**（`embed(ctx: Ctx, texts: string[]):
Promise<number[][]>` のまま）。`docs/autonomy.md` §3 の「公開 API の破壊的変更」の対象外
——doc コメントの追記は型を動かさない。`scripts/check-public-api-surface.mjs` で確認した
（下記 §6）。

上限の値・境界（`>` か `>=` か）・例外の型は実装ごとに決めてよい。この契約が要求するのは
「黙って切って返さないこと」だけである——ADR 0090 決定1〜3 が `local-embedding` 側で
既に選んだ具体案（`kind: "input_too_long"`、境界は `>`、検査は推論前）を、他の adapter に
強制するものではない。

### 決定2: `testkit` の適合 suite に、**任意の** `overLimitText` を足す

`EmbeddingProviderConformanceOptions.overLimitText?: string` を追加した。渡すと
「`embed(ctx, [overLimitText])` が reject すること」を測る歯が1本増える。省略時は
`deterministic` の `false` と同じ形——**`it.skip` として名前だけ残る**（消えない）。

**任意にした理由**: `deterministic` とは違い、`overLimitText` は「上限そのものを持たない
実装」（決定的な表引きの replay pipeline・testkit 自身の擬似実装）が実在する。必須にすると、
上限の概念を持たない実装に「上限を宣言せよ」と要求することになり、ADR 0289 が確立した
「型の変更を伴わない任意欄の追加は非破壊」という前例の対象外になる（3.2 で却下した必須
interface 案と同じ理由）。

**snapshot への影響**: `scripts/__snapshots__/public-api/testkit.d.ts` だけが動いた
（`EmbeddingProviderConformanceOptions` に1行追加）。他5パッケージの snapshot は
バイト単位で無変化だった（`node scripts/check-public-api-surface.mjs` で確認、§6）。

**陽性対照を先に用意した**（AGENTS.md「⚠『出なかった』を、事象が無いことの証明にしない」）:
`packages/testkit/src/__tests__/embedding-provider-conformance-over-limit.test.ts` に、
この歯専用の最小 provider（`RejectsOverLimitEmbeddingProvider`、文字数で上限を模した
擬似実装）を用意し、`overLimitText` を渡して**歯が実際に緑になる**ことを示した。さらに
その provider の reject を無効化する変異（`if (false && tooLong !== undefined)`）を入れて
**歯が赤くなること**、戻すと緑に戻ることを確認した（§7 の変異試験）。

### 決定3: 各 adapter の呼び出しへの適用は「測れる場所だけ」——vacuous な緑を作らない

6箇所の既存呼び出し（testkit 自身の2箇所・local-embedding の replay/live・openai の
replay/live）のうち、**どこにも `overLimitText` を渡さなかった。**

理由は一律ではない:

- **testkit 自身の2実装**（`DeterministicEmbeddingProvider` / `RecordedEmbeddingProvider`）:
  上限の概念を持たない（前者は文字コードの機械的変換、後者は記録の再生）。渡す意味が無い。
- **local-embedding / openai の replay 系**（記録済みベクトルの表引き）: `overLimitText` を
  渡すと、記録に無い入力として「別の理由」で reject する——歯自体は緑になるが、
  **上限検査そのものを測ったことにはならない**（vacuous な緑）。ADR 0090 の「C1 は緑のまま
  であるべき変異」の逆側の失敗——ここでは「本来は意味を測るべき歯が、無関係な理由で
  たまたま緑になる」ことを避けた。
- **local-embedding の live 呼び出し**（本物のモデル、opt-in）: ここは本物のトークナイザに
  当たるので測る価値はある。**しかし採らなかった。** ADR 0090 §1.2 が実測しているとおり、
  「字数」はトークン数の代わりにならず（単純な繰り返し文字列は BPE で圧縮され、
  `"あ".repeat(100)` が15トークンにしかならない）、この作業者はモデルを実行せずに
  「確実に上限を超える」文字列を用意する自信を持てなかった。誤った文字列を書くと、
  将来モデルの重みを落として初めてこの歯が赤くなる（かつ、赤くなった理由が
  「実装のバグ」ではなく「テストの文字列が短すぎた」になる）——**この経路は既に
  `input-token-limit.test.ts`（fake extractor、単体）と `live.local-embedding.test.ts` の
  歯1〜3（本物のトークナイザで二分探索した8192/8193境界、opt-in）が厚く測っている**ため、
  無理に重複させなかった。
- **openai の live 呼び出し**（実 API、二重 opt-in）: §2 の実測した文字列
  （`" hello".repeat(10000)`）をそのまま使える候補が既にあるが、**採らなかった**。
  理由は測定の質ではなく、`docs/conformance.md`§3「無条件7本」（Issue #142 が名指しした
  定数）の数え方——`overLimitText` を渡すとこの呼び出しの「無条件で走る本数」が7→8に
  動き、Issue #142 の記述と食い違う。**この歯を足す価値そのものは否定しない**——
  足すなら `docs/conformance.md` の数え方も一緒に直すこと、とコード中のコメントに
  残した（`live.openai.test.ts` 参照）。

⟹ **これは「手を抜いた」のではなく「測れないところで緑を主張しない」という、この repo の
規律（AGENTS.md「⚠ 名乗れないものを道具に名乗らせない」）をそのまま適用した結果である。**

### 決定4: 核となる歯を `packages/core` に足す — 3段がつながった先の振る舞いを固定する

`packages/core/src/__tests__/runtime.test.ts` に、Issue #449 の3段をそのまま辿る歯を
1本足した:

1. `throwingLlm()` で LLM 抽出を失敗させる。
2. `observe({ kind: 'document', content: <500字> })` で全文フォールバックを起こす。
3. `embeddingProvider` に、**契約どおり reject する**擬似 provider
   （100字を超えたら reject）を注入する。
4. `tick({ kinds: ['embed'] })` を呼ぶ。

固定した3点: (a) `Memory.content` は全文のまま変わらない、(b) `embeddingStatus` は
`'failed'`、(c) `tick()` の `TickResult.failed` が1を数える。

**この歯は既定の挙動を1つも変えていない**——`observe`/`extraction`/`processEmbedJob` の
どれもこの歯のために変更していない。固定しているのは「provider が契約どおりに reject
したとき、その先の3段が正しく振る舞うこと」だけである（§7 に赤→緑の記録）。

### 決定5: `packages/openai` に、契約への適合を測る歯を1本足す（実装は変えない）

`packages/openai/src/__tests__/embedding-provider.test.ts` に、実 API の HTTP 400
（§2 の実測をそのまま使う）を投げる偽 client を注入し、`OpenAIEmbeddingProvider.embed()`
が**それを握りつぶさず・切り詰めて再送もせず、そのまま reject すること**を測る歯を
1本足した。`embed()` 自体の実装は変更していない（`try/catch` が無いことを、無いままで
固定した）。

**この歯が測っていないこと**: `OpenAIEmbeddingProvider` が自前で上限を検査すること
——それは元々していない。この歯が固定しているのは「サーバが拒否したら、その拒否を
そのまま外へ通すこと」だけである。**§2 で確認したとおり、安全を担っているのは
依然としてサーバ側の挙動であり、この repo のコードではない。**

### 決定6: 採らなかった方向（Issue #449 が挙げた案1・案2）

- **案1（`content` に `.max()`）**: 採らない。上限の値はモデルごとに違う
  （`local` は8192トークン、`openai` は8191トークン）。`core` が特定のモデルの数字を
  持つのは層が違う（ADR 0090 決定「3.6」が同じ理由で既に却下している）。加えて、
  正常な利用者が長い document を渡す用途そのものを壊す——`.max()` を足すと、
  上限に収まっている長文を渡す既存の利用者が壊れる、既定の挙動を変える変更になる。
- **案2（fallback 側で切る）**: 採らない。Issue 本文自身が「切るなら、切ったことを
  名乗らせること。黙って切ると、この Issue が指摘している問題そのものになる」と
  釘を刺している。全文フォールバックを黙って切り詰めると、**「抽出はできなかったが
  全文は保持している」という既存の保証**（`runtime.test.ts`「LLM 呼び出し自体が失敗しても
  observe() 全体は失敗せず、全文を保持した Memory が1件残る」）が壊れる。これも
  既定の挙動を変える変更であり、この ADR の前提（「既定の挙動は1つも変えない」）に反する。

---

## 4. 検討した選択肢

### 4.1 `overLimitText` を必須にする

**却下。** 上限の概念を持たない実装（表引きの replay・testkit の擬似実装）が実在する
（決定2）。必須にすると、それらの呼び出しに「意味の無い値」を渡させることになり、
`deterministic` が区別している「決定的でない」と「宣言し忘れた」の区別を、
ここでも壊れた形で持ち込むことになる（`false` を選べない）。

### 4.2 `EmbeddingProvider` に `maxInputTokens` / `countTokens` を必須で足す

**却下（この ADR の範囲では提起に留める）。** ADR 0090 決定4・負債1が
`LocalEmbeddingPipeline` について既に同じ構造の案を検討し、「公開 API の破壊的変更であり
`docs/autonomy.md` §3 に従ってオーナーの判断を待つ」と決めている。`EmbeddingProvider`
本体（`packages/core`）に同じ形を足すのはさらに広い破壊——**全 adapter**
（`openai`・`local-embedding`・testkit の2実装・外部実装者）が影響を受ける。この ADR は
「既定の挙動を1つも変えない」を前提に置いているため、ここでは実装しない。
**オーナーへの提起として記録する**（§6 負債1）。

### 4.3 `packages/openai` に自前の上限検査を足す（`local-embedding` と揃える）

**却下（この ADR の範囲では）。** 検討はした——`local-embedding` 同様、トークナイザを
持たない `openai` パッケージが正確なトークン数を数えるには、OpenAI の
`tiktoken`相当のライブラリを新規依存として足す必要がある。これは:

- **既定の挙動を変える**（現状「送ってサーバに聞く」だった経路が「事前に拒否する」
  経路になる。サーバの上限値が将来変わったとき、自前の検査が古いままだと
  **サーバより厳しく**なり、以前は通っていた入力を拒否するようになる可能性がある）。
- **新規依存を増やす判断**であり、この Issue の「契約を明記し、歯で測る」という
  スコープを超える。
  ⟹ **オーナーへの提起として記録する**（§6 負債2）。採るなら別 PR。

---

## 5. §7 赤→緑の記録（実際に走らせた変異試験）

**復元はすべて `cp` ＋ `cmp`（バイト比較）で確認した。`git checkout` は使っていない。**

| #   | 対象                                                                                                                      | 変異                                                                                                                   | 期待 | 結果                                                                                                  |
| --- | ------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ---- | ----------------------------------------------------------------------------------------------------- |
| M1  | `packages/testkit/src/__tests__/embedding-provider-conformance-over-limit.test.ts` の `RejectsOverLimitEmbeddingProvider` | reject 条件を `if (false && tooLong !== undefined)` へ無効化                                                           | 赤   | ✅ 赤（`embedding-provider-conformance.ts:267` の `overLimitText` 歯1本）                             |
| M2  | `packages/core/src/runtime.ts` の `processEmbedJob`                                                                       | `catch` で `setEmbeddingStatus(..., "failed")` の代わりに `"ready"` を書き、再送出をやめる（黙って成功したことにする） | 赤   | ✅ 赤（Issue #449 の歯: `{processed:1,failed:0}` を期待した `{processed:0,failed:1}` に対して不一致） |
| M3  | `packages/openai/src/embedding-provider.ts` の `embed()`                                                                  | `client.embeddings.create` を `try/catch` で包み、失敗時にダミーの成功レスポンスへ倒す（サーバの拒否を握りつぶす）     | 赤   | ✅ 赤（「握りつぶさず reject する」歯: `rejects.toBe(serverError)` が resolve に対して不一致）        |

**各変異は `cp` で退避 → 変異を書き込み → 対象の歯だけを `vitest run <file> -t <name>` で
実行して赤を確認 → `cp` で復元 → `cmp` でバイト同一性を確認 → 同じ歯をもう一度実行して
緑に戻ることを確認、という手順で行った。** 3件とも実際に復元後の緑を確認している。

---

## 6. 公開 API スナップショットの確認

`pnpm --filter @mnemora/core --filter @mnemora/testkit --filter @mnemora/openai
--filter @mnemora/postgres --filter @mnemora/anthropic --filter @mnemora/local-embedding
run build` の後、`node scripts/check-public-api-surface.mjs` を実行した。

**差分は `@mnemora/testkit` の1箇所だけ**（`EmbeddingProviderConformanceOptions` に
`overLimitText?: string;` が1行増えた）。他5パッケージ（`core` を含む）は**バイト単位で
無変化**——`embedding-provider.ts` の doc コメント追記は型シグネチャを動かさないことを、
推測ではなくこの歯で確認した。

`node scripts/check-public-api-surface.mjs --write` で snapshot を更新し、
`git diff scripts/__snapshots__/public-api/testkit.d.ts` が上記1行の追加だけであることを
確認した。**`docs/migration-v1.md` の数え方（型の削除・必須化・シグネチャ変更）に
当てても、これは該当しない**（任意フィールドの純追加。ADR 0258 §9 / ADR 0289 と同じ形）
——⟹ `docs/migration-v1.md` への追記は行っていない。

---

## 7. 結果（この決定が招くもの）

**良い面**

- `EmbeddingProvider` の契約に、上限超過の扱いが明文化された（doc コメントのみ、型は不変）。
- 適合 suite が「上限超過を測ったか・測っていないか」を、`deterministic` と同じ形の
  named `it.skip` で名乗れるようになった。
- `packages/core` に、3段がつながった先（契約どおりの provider を使った場合の
  `content`/`embeddingStatus`/`TickResult`）を固定する歯が1本増えた。
- `packages/openai` に、「サーバの拒否を握りつぶさない」ことを固定する歯が1本増えた。

**引き受けた負債**

1. 🔴 **`EmbeddingProvider` に、上限を宣言させる構造的な強制（必須 interface）は無い。**
   契約は doc コメントであり、型では強制していない。新しい adapter 実装者が
   ドキュメントを読まずに黙って切り詰める実装を書いても、型検査は通る。
   ⟹ 4.2 で検討し、`docs/autonomy.md` §3 に従って提起に留めた。**オーナーの判断を待つ。**
2. **`packages/openai` は、今日もサーバの拒否に全面的に依存している。** 自前の検査は
   持たない。4.3 で検討し、この ADR の範囲では実装しないと決めた。**オーナーの判断を
   待つ。**
3. **`overLimitText` は6箇所のうち1箇所（この ADR のために新設した陽性対照）にしか
   渡していない。** 既存5箇所（testkit×2・local-embedding×2・openai×2 のうち5つ）は
   決定3の理由でどれも渡さなかった。**「6 adapter 呼び出しが契約に適合する」ことを
   主張する歯は、まだ無い。**
4. **openai の live 呼び出しに `overLimitText` を足す価値がある候補**
   （`" hello".repeat(10000)`、§2 で実測済み）**を、コメントで残しただけで実装していない。**
   足すなら `docs/conformance.md`§3 の数え方も一緒に直すこと。
5. **この ADR の §2 の実測は、モデル1つ・1回である。** OpenAI がサーバ側の挙動を
   将来変えても、この repo にそれを検出する歯は無い（4.3 を却下した理由でもある——
   検出する歯を持たない依存を増やしている）。
6. **local-embedding の live 呼び出しにも `overLimitText` を足していない。** 既存の
   `input-token-limit.test.ts` / `live.local-embedding.test.ts` 歯1〜3 が同じ範囲を
   別の場所で測っているため実害は薄いと判断したが、**「conformance suite の
   `overLimitText` が全 adapter を横断して同じ形で測る」という本来の目的からは外れる。**

---

## 8. これが覆るとしたら

- **オーナーが 4.2（`maxInputTokens`/`countTokens` を必須にする）を承認したとき。**
  負債1が消え、決定1は「型で強制する」形に置き換わる。
- **オーナーが 4.3（`openai` に自前の上限検査を足す）を承認したとき。** 負債2が消える。
  ただしそのときは「サーバの上限値より自前の検査が古くなる」リスクへの手当てが要る。
- **`docs/conformance.md`§3「無条件7本」の数え方を直す判断がされたとき。**
  openai live 呼び出しに `overLimitText` を足す道が開く（負債4）。
- **OpenAI が実際にサーバ側の拒否をやめた、あるいは挙動を変えたとき。** §2 の実測が
  古くなる。**この ADR にはそれを検出する歯が無い**（負債5）——本文を書き換えず、
  訂正はこの ADR への追記で行うこと（`docs/decisions/README.md` の規律）。

---

## 9. 確かめていないこと

- **【受領・実測】は実 API 1回・モデル1つ（`text-embedding-3-small`）に限る。**
  他モデル・他回では確かめていない。
- **`dimensions` パラメータ付きの呼び出しでも同じ拒否が起きるか**は確かめていない
  （§2 の実測は素の `input` 超過）。
- **6箇所の既存 conformance 呼び出しのうち5箇所が、実際に契約（上限超過は例外）に
  適合しているか**は、この ADR の歯では測っていない（負債3）。適合していない可能性が
  最も高いのは `openai`（自前の検査を持たない、決定5参照）。
- **`packages/core/src/strategies/consolidate.ts` 側の上限**（ADR 0090 §1.5 が既に
  「反復で content が縮む保証はコードに無い」と記録している経路）は、この ADR でも
  再検証していない。
- **この経路が実運用でどれくらいの頻度で踏まれるか**は、Issue #449 と同じく測っていない。

---

## 追記（2026-09-26、[Issue #860](https://github.com/takecchi/mnemora/issues/860)）: `OpenAIEmbeddingProvider.embed()` は応答の件数・次元を突き合わせない

クローン miku の委譲先が書いた。オーナーではない（[ADR 0220](./0220-issue-comment-author-does-not-distinguish-owner-from-agent.md)）。
**上の本文（決定・検討した選択肢・引き受けた負債・確かめていないこと）は書き換えていない。**当時の記録として残す。
コード（`packages/*/src`）の挙動は変えていない——この追記は記録だけである。

Issue #860 は、`OpenAIEmbeddingProvider.embed()`（`packages/openai/src/embedding-provider.ts`）
が `response.data` を `index` で並べ替えて返すだけで、**件数が `texts.length` と一致するかを
確かめていない**ことを指摘した。`@mnemora/local-embedding` の `LocalEmbeddingProvider.embed()`
は件数の一致（および次元の一致）を確かめて、食い違えば例外を投げる——同じ
`EmbeddingProvider` の2実装で、この契約の守り方が食い違っている。

本 ADR の決定1（「上限超過は例外」の契約明記）と同じ形の負債である——**「上限超過を
サーバの拒否に依存する」（負債2）と「件数の一致をサーバの応答に依存する」は同じ性質の
未検査であり、どちらも `@mnemora/openai` が専用の検査を持たないことに由来する。**
`packages/core` の本番経路（`runtime.ts:3289`・`recall-runtime.ts:709`）はどちらも
常に1件ずつ渡しており、戻り値が空のときの防御（`!vector`）もあるため、件数がずれて
memory とベクトルの対応が1つずれる、という実害はこの2経路では再現できない。問題が
表に出るのは、利用者が provider を直接呼んで複数件を渡した場合と、将来コアがバッチで
渡すようになった場合である。

**クローン miku の判断（2026-09-26）**: 実装は変えず、「`embed` は入力と同じ件数・同じ
順序でベクトルを返すことが `EmbeddingProvider` の契約だが、守り方は実装ごとに違う。
`@mnemora/openai` はこれを検査せず OpenAI のサーバに依存しており、応答が食い違ったとき
の結果は未定義」を今の契約として `packages/core/src/interfaces/embedding-provider.ts`・
`packages/openai/src/embedding-provider.ts`・`docs/architecture.md` §5.5・
`packages/openai/README.md`・`packages/testkit/src/embedding-provider-conformance.ts`
（この suite が測る範囲の注記）に明記するに留めた（Issue #860 が挙げた方向2）。

**採らなかった案**:
1. **`@mnemora/local-embedding` と同じく、件数（および次元）の不一致で例外を投げる。**
   却下——`OpenAIEmbeddingProvider.embed()` が**新しく throw する**ようになる、公開
   パッケージの振る舞いの変更であり、委譲された範囲（新しい throw を足さない）を超える。
2. **件数の一致を `EmbeddingProvider` の契約として明文化し、`packages/testkit` の
   適合テストに、下層が食い違った件数を返す偽 client を注入する歯を足す。** 却下
   ——conformance の要件の変更になる。既存の「embed(ctx, [a,b,c]) はちょうど3件返す」
   等の歯は「正常に機能する provider」の検査であり、これを「壊れた下層からも防御する」
   要求へ広げるのは、この追記の範囲（記述のみ）を超える。

反映先: `packages/core/src/interfaces/embedding-provider.ts`、
`packages/openai/src/embedding-provider.ts`、`docs/architecture.md` §5.5、
`packages/openai/README.md`、`packages/testkit/src/embedding-provider-conformance.ts`。
