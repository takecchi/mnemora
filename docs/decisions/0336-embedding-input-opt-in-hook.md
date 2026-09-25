# ADR 0336: `RuntimeDeps.embeddingInput` — 上限超過で `failed` になった Memory を、既定を変えずに回復できる opt-in フック（Issue #753、#449 の残り）

- **状態**: 提案 (2026-09-26)
- **日付**: 2026-09-26

> **⚠ この ADR を書いているのは、マネージャー（クローン miku のセッション）から
> 切り出された作業者である。⛔ オーナー本人の決定ではない。**投稿者欄・commit の
> 著者欄が誰であっても、それだけでは人間かクローンかを区別しない
> （[ADR 0220](./0220-issue-comment-author-does-not-distinguish-owner-from-agent.md)）。
> **ここに書く判断はすべて「この作業者の判断（オーナーではない）」であり、
> オーナーの確認・承認を得たものではない。**

**⚠ 各主張の出所を分ける。**「【実測】」はこの作業でこの器から実行して取ったもの。
「【受領】」は依頼元から前提として渡され、この作業では別途裏を取っていないもの
（ADR 0090/0305 と同じ記法）。

---

## 0. 前提 — Issue #753 が挙げた2点のうち、この ADR が扱うのは1点目だけ

[Issue #753](https://github.com/takecchi/mnemora/issues/753) は #449 を閉じたときの残りを
2点挙げている【受領】:

1. **回復手段が無い。** `reembed()`（ADR 0079）で積み直しても同じ `content` を送るので、
   また `failed` に戻る。上限を超える Memory は意味検索から永久に外れる。
2. **`packages/openai` 側に上限の知識が無い。** 拒否はサーバに全面的に依存しており、
   実測は一度きり（CI のテストではない）。

**この ADR が扱うのは 1 だけである。** 2 は ADR 0305 §4.3 が既に検討し、「新規依存
（OpenAI のトークナイザ相当）を増やす判断であり、この Issue のスコープを超える。
オーナーへの提起として記録する」と決めている——**この ADR で新しく検討し直さない。**
依頼元（マネージャーの指示）もこの切り分けを前提にしている。

---

## 1. 現物の確認

**main = `c682b3e`（このブランチを切った時点）で【実測】:**

- `packages/core/src/runtime.ts` の `processEmbedJob` は
  `deps.embeddingProvider.embed(ctx, [memory.content])` を送り、例外なら
  `setEmbeddingStatus(ctx, memory.id, "failed")` を書いてから再送出する。
- `reembed()`（`packages/core/src/runtime.ts`、ADR 0079）は
  `deps.memoryStore.requeueEmbedJobs(ctx, opts)` を呼ぶだけ——failed を pending に戻し、
  embed ジョブを積み直す。**`Memory.content` には一切触れない。**
- ⟹ 上限超過で `failed` になった Memory は、`reembed()` → `tick()` を何度繰り返しても
  同じ `content` を再送し、また同じ理由で `failed` に戻る。**回復の口が無い。**
  （`packages/core/src/__tests__/runtime.test.ts` に、この既定挙動を固定する歯を
  1本追加した——§3「決定」参照。）

---

## 2. 検討した選択肢

Issue #753 の記述（「1について: 分割して複数ベクトルにする／先頭を切って明示の印を残す／
observe の段で拒否する、のどれか」）と、依頼元から追加で示された案を合わせて5つを比較した。

### 案 a: 既定で切り詰める（`processEmbedJob` が自分で先頭を切ってから送る）

**却下。** 既定の挙動を変える——ADR 0305 決定6が既に同じ理由（「切るなら、切ったことを
名乗らせること。黙って切ると、Issue #449 が指摘した問題そのものになる」）で却下している
案2の焼き直しであり、この ADR で再度採る理由は無い。「全文フォールバックが全文を保持する」
という既存の保証（`runtime.test.ts` の該当歯）を壊す。

### 案 b: 分割して複数ベクトルにする

**却下。** `VectorStore` の契約は「1 Memory 1 ベクトル」を前提にしている
（`upsert(ctx, space, memoryId, vector)` — `memoryId` に対して1本）。複数ベクトルに
分割するには、`memory_embeddings_<space>` 側に「どの分割か」を表す列か、`memories` 側に
分割の関係を表す列が要る——**migration を要する変更**であり、AGENTS.md ⛔「既存の
migration に触らない。新しい migration が要ると分かったら、実装を止めてマネージャーへ
報告」に該当する。この ADR の範囲では実装しない。

### 案 c: `observe()` の段で拒否する

**却下。** ADR 0305 決定6 案1（`.max()` を足す）と同種の理由で退けた形——`observe()` の
時点で長さを理由に拒否すると、**以前は通っていた入力**（LLM 抽出が成功する限り、全文が
そのまま embed に渡ることは無かった入力を含む）が新たに拒否されるようになる。
既定の挙動を変える。加えて、`observe()` は `embeddingProvider` の上限値を知らない
（core はモデル固有の数字を持たない、ADR 0305 決定6・ADR 0090 決定「3.6」）ため、
どの長さで拒否するかの基準をどこから得るかという問題も残る。

### 案 d: 今回採った案 — `RuntimeDeps` に任意の `embeddingInput` フックを足す

**採用。** 詳細は §3「決定」。既定の挙動を1ビットも変えず、呼び出し側が opt-in で
回復の口を得られる。

### 案 e: `reembed()` の引数に「送る入力を上書きする値」を足す（例:
`reembed(ctx, { statuses: ['failed'], overrideInput: (memory) => string })`）

**却下（案dのほうが狭い変更で済むため）。** 検討はした——`reembed()` の呼び出し単位で
入力を差し替えられるほうが、`createRuntime` 全体に効く案dより局所的に見える。しかし
実際に流れを辿ると、`reembed()` 自体は `requeueEmbedJobs`（`MemoryStore`、outbox の
payload を書き換えない素通し）を呼ぶだけで、実際に `embed()` へ送る文字列を決めるのは
**後続の `tick()` が呼ぶ `processEmbedJob`** である。`reembed()` の引数として渡した
上書き関数を、`tick()` の呼び出しまで持ち越す経路が無い——`OutboxJobRecord.payload` は
`{ memoryId }` だけを持つ契約（`processEmbedJob` の doc コメント参照、ADR 0157 決定2
「新しい payload 形を発明しない」）であり、関数値を payload に載せることはできない
（JSON でシリアライズできない）。持ち越すとすれば `MemoryStore` か outbox の契約変更に
なり、**案dより広い変更**になる。案dは `createRuntime` の呼び出し1箇所で完結し、
`reembed()`/`tick()` のどちらのシグネチャも変えない——同じ効果をより狭い変更で得られる
ため、案dを採った。

---

## 3. 決定

### 決定1: `RuntimeDeps` に任意の `embeddingInput?: (memory: Memory) => string` を足す

`packages/core/src/runtime.ts` の `RuntimeDeps` interface に足した:

```ts
embeddingInput?: (memory: Memory) => string;
```

**省略時は `memory.content` をそのまま `embed()` へ送る**——この欄の有無は既定の挙動を
1ビットも変えない（北極星の問い2、`docs/north-star.md`）。指定すると `processEmbedJob`
は `embed(ctx, [embeddingInput(memory)])` を呼ぶ。**`Memory.content` 自体はどちらの
場合も変えない**——DB に書き戻る content は常に元のまま。

`processEmbedJob` 内部は、新しいヘルパー `resolveEmbeddingInput(memory)` を経由して
`embed()` へ送る文字列を決める。このヘルパーは既存の `try` ブロックの中で呼ばれるので、
**フックが例外を投げた場合も、今までどおり `embeddingStatus` を `'failed'` にしてから
再送出する**——このフックのために新しい throw の経路を既定側に作らない。

### 決定2: `Memory` に「切ったこと」を示す列は足さない

**core はモデルの入力上限・トークン数を持たない**（ADR 0305 決定6 / ADR 0090 決定
「3.6」と同じ理由——層が違う。core が特定モデルの数字を知ってはならない）。同じ理由で、
「このフックが何を・どれだけ切ったか」の印も core は残さない——残すには `Memory` に
列を足す必要があり、それは migration を要する変更であって、このフック（純粋な関数の
注入）の範囲を超える。AGENTS.md ⛔「既存の migration に触らない。新しい migration が
要ると分かったら、実装を止めてマネージャーへ報告」の対象になるため、この ADR では
足さない。**印が要る呼び出し側は、自前の仕組み（別テーブル・ログ等）で残すこと**——
`RuntimeDeps.embeddingInput` の doc コメントにその旨を明記した。

### 決定3: `packages/core` に赤→緑の歯を2本足す（対になる歯）

`packages/core/src/__tests__/runtime.test.ts` に
`describe("runtime.tick — processEmbedJob の embeddingInput opt-in フック（Issue #753）")`
を足した:

1. **フックを注入した runtime で `reembed()` → `tick()` すると `ready` になる。
   `content` は全文のまま。**（フックが実際に効くことの陽性対照。既存の failed 行に、
   後から opt-in フックを足した別の `createRuntime` 呼び出しで対応する——実運用の
   「運用側が opt-in フックを足した runtime に切り替える」操作をそのまま模している。）
2. **フックを渡さない runtime では、`reembed()` → `tick()` を繰り返しても同じ `content`
   を再送してまた `failed` になる。**（既定の挙動が1ビットも変わっていないことの固定。）

実装前に1本目を実行し、**赤**（型検査は `RuntimeDeps` に無い `embeddingInput` を弾き、
`tsc --noEmit` が `TS2353` で落ちる。型検査を経ない `vitest run` 単体では、フックが
黙って無視されて `healingTick.processed` が `0`・`healedStatus` が `'failed'` のままで
アサーションが落ちる）ことを確認した。実装後は2本とも緑。

### 決定4: 変異試験 — `resolveEmbeddingInput` がフックを無視する変異

`packages/core/src/runtime.ts` の `resolveEmbeddingInput` を
`return deps.embeddingInput ? deps.embeddingInput(memory) : memory.content;` から
`return memory.content;`（フックを無視する）へ変異させた。**結果**:

- 決定3の1本目（フックを使った回復）は**赤**（`healingTick` が `{processed:0,failed:1}`
  になり、期待の `{processed:1,failed:0}` と不一致）。
- 決定3の2本目（既定不変の固定）は**緑のまま**——この歯は元々フックを使わないため、
  この変異では動かない。**狙った歯だけが赤くなり、既定不変を固定する歯は影響されない**
  ことを確認した。

**復元は `cp` で行った**（`git checkout` は使っていない）。復元後、`cmp` でバイト同一性を
確認し、同じ2本の歯が緑に戻ることも確認した。

### 決定5: `packages/postgres` に、本物の Postgres を使った配線の確認を1本足す

`packages/postgres/src/__tests__/ingest-roundtrip.postgres.test.ts` の既存
`describe("observe → recall 前段の往復…")` の並びに、
`describe("embeddingInput opt-in フック（Issue #753、本物の Postgres）")` を1本足した。
`PostgresMemoryStore`/`PostgresVectorStore`/`PostgresOutboxStore` 等に対して、
決定3の1本目と同じ筋（上限超過で `failed` → 別の `createRuntime`（フック付き）で
`reembed()` → `tick()` → `ready`、`memories.content` は全文のまま、
`memory_embeddings_<space>` に実際に1行入る）を実 DB でなぞる。**この歯は配線の確認に
留め、境界条件（フックが例外を投げた場合の扱い等）は決定3の歯に任せる。**

手元の Postgres 17 + pgvector（`initdb` の自分専用インスタンス、`AGENTS.md` の手順）で
【実測】:
- `pnpm --filter @mnemora/postgres exec vitest run
  src/__tests__/ingest-roundtrip.postgres.test.ts` — 4件（既存3件＋新規1件）とも緑。
- 決定4と同じ変異（`resolveEmbeddingInput` がフックを無視する）を適用すると、この
  postgres の歯も赤くなる（`healingTick` が `{processed:0,failed:1}`）ことを確認した。
  `cp`/`cmp` で復元し、緑に戻ることも確認した。
- `pnpm --filter @mnemora/postgres run test:db`（`packages/postgres` の全 DB テスト）も
  実行した——結果は本 ADR の依頼元への報告に記載する（この ADR には数を焼き込まない、
  AGENTS.md「⚠ 数を、道具と生成物に焼き込まない」）。

### 決定6: 公開 API スナップショット

`pnpm --filter @mnemora/core --filter @mnemora/testkit --filter @mnemora/openai
--filter @mnemora/postgres --filter @mnemora/anthropic --filter @mnemora/local-embedding
run build` の後、`node scripts/check-public-api-surface.mjs` を実行した。

**差分は `@mnemora/core` の1箇所だけ**——`RuntimeDeps` に
`embeddingInput?: (memory: Memory) => string;` が1行増えた。他5パッケージは
**バイト単位で無変化**。`node scripts/check-public-api-surface.mjs --write` で snapshot
を更新し、`git diff scripts/__snapshots__/public-api/core.d.ts` が上記1行の追加だけで
あることを確認した。**任意フィールドの純追加**であり、`docs/migration-v1.md` の
数え方（型の削除・必須化・シグネチャ変更）には該当しない（ADR 0305 決定2・ADR 0289 と
同じ形）——⟹ `docs/migration-v1.md` への追記は行っていない。

---

## 4. これが覆るとしたら

- **オーナーが案b（分割して複数ベクトル）または案c（observe の段で拒否）を承認したとき。**
  どちらも既定の挙動を変える・または migration を要するため、この ADR の外で改めて
  判断されることになる。この ADR の `embeddingInput` フックとは併存しうる
  （フックは「送る文字列を差し替える」という一般的な口であり、上記2案が採用された後も
  無効になるわけではない）。
- **`Memory` に「切ったこと」の印を残す列を足す migration が承認されたとき。**
  決定2の負債が消え、`embeddingInput` の戻り値と実際に保存された印を突き合わせる
  歯を追加できるようになる。
- **Issue #753 の2点目（`packages/openai` 側でトークンを数える）が別途採用されたとき。**
  この ADR の範囲外のまま——ADR 0305 §4.3 の提起がまだ有効である。

---

## 5. 確かめていないこと

- **この Memory が実運用でどれくらいの頻度で `failed` になるか**は、Issue #449/#753 と
  同じく測っていない。
- **`embeddingInput` フックが投げた例外の中身**（`processEmbedJob` の `catch` を通る際、
  元の provider の例外と区別できるか）は、この ADR の歯では検査していない——
  `catch` は例外の種類を判定せず一律に `failed` へ倒すため、フック由来か provider 由来か
  を呼び出し側が区別する経路は無い。区別が要るかどうかもこの ADR では判断していない。
- **`consolidate()`/`reflect()` など、`processEmbedJob` 以外の経路で `embed()` を呼ぶ
  箇所**（あれば）にこのフックが効くかどうかは確認していない——`grep -n
  "embeddingProvider.embed("  packages/core/src/runtime.ts` で当たった呼び出しは
  `processEmbedJob` の1箇所のみだったが、将来別の呼び出しが増えたときにこのフックへ
  揃えるかどうかは、この ADR では決めていない。
- **`packages/openai`/`packages/local-embedding` の adapter 実装者が、このフックを
  使わずに独自の回復手段を実装する余地**は塞いでいない——このフックは `core` 層の
  1つの選択肢であり、adapter 側で別の回復策を採ることを禁じるものではない。
