# ADR 0324: 主張キー（(B) 第2段）の検出実装 — 列と索引だけで衝突を見つけ、`contested` までで止める（Issue #372）

- **状態**: 採用 (2026-09)

### 出所の凡例（ADR 0185/0315/0320 以降の作法）

| 記号 | 意味 |
|---|---|
| 【実測】 | この作業者が、この器で実際に本物の Postgres + pgvector・（測ったなら）`OPENAI_API_KEY` を叩いて得た |
| 【現物】 | この作業者が、リポジトリの現物（コード・文書）を読んで確かめた |
| 【受】 | 人・他のエージェントから受け取った前提。自分で検証していない |

---

## 文脈

**この ADR が決めるのは Issue #372（(B) 第2段: 同じ主張キー・重なる有効期間・違う内容を、
列と索引で見つけて `contested` にする。`superseded` へは進めない）の実装詳細である。**
[ADR 0185](./0185-contradiction-detection-path.md) 決定2・決定4 が (B) を採る方向と
検出を `contested` で止める方針を決め、[ADR 0320](./0320-claim-key-field-implementation.md)
が主張キーの列・索引（`claim_key_subject`/`claim_key_predicate`、`idx_memories_claim_key`）を
実装した。**この ADR で初めて、その鍵の衝突を実際に検出するコードが入る。**

判定規則（Issue #372 本文、逐語）:

> 同じ `tenant_id`・同じ `subject_id`・**同じ主張キー**・**有効期間が重なる**・
> 内容（`content_hash`）が違う・両方 `status = 'active'` ⟹ **矛盾**

⛔ **LLM を一度も呼ばない**（`docs/north-star.md` 問い5）。判定は列の等値比較・範囲比較・
索引アクセスだけで完結する。

---

## 決定

### 決定1: 検出は opt-in の追加の口 `ClaimKeyOptions.detectContested` に載せる。`enabled: true` が前提

`packages/core/src/claim-key.ts` の `ClaimKeyOptions` へ `detectContested?: boolean`
（既定 `undefined` = `false`）を足した。**#371 の `claimKey.enabled`/`knownPredicates` と
同じ流儀の任意の追加**——`ObserveXxxInput.claimKey` という既存の入り口を再利用し、
新しい公開 union 型は作らない。

`detectContested: true` は `enabled: true` と組み合わせたときだけ意味を持つ。`enabled` が
`false`/省略のまま `detectContested: true` だけを渡しても、鍵が一度も埋まらないため検出は
必ず空振りする——これはエラーにしない（`knownPredicates` を `enabled: false` と組み合わせても
無視されるのと同じ「渡されたが効かない」規約）。

**採らなかった案**: 独立した新しい `ObserveXxxInput` フィールド（例: `contestedDetection?:
boolean`）にする。**採らない理由**: 検出は主張キーが無いと成立しない一段の処理であり、
`claimKey` オプションの外に出すと「`detectContested: true` だが `claimKey` を渡していない」
という無意味な組み合わせを型で許してしまう。ネストすることで、その組み合わせが
「意味を持たない」ことが構造からも読み取れる。

### 決定2: 書き込み時（新しい Memory が `active` になる時点）の延長として走らせる。`tick()`/`observe()` からの自動背景処理にはしない

`runtime.ts` の `createMemoriesFromCandidates` が `createMemoryWithOutbox` で Memory を
実際に作成した直後（`created === true` のときだけ、冪等な再送では走らない）、
`detectClaimKeyContested` を呼ぶ。**新しい非同期ジョブ種別・新しい `outbox` エントリは
作らない**——`observe()` の呼び出し1回の中で同期的に完結する（`markContested`/
`resolveContested` と同じ「明示的操作の延長」という位置づけ。ADR 0185 が採らなかった
「案2: `tick()`/`observe()` から自動で走らせる」を、この ADR も同じ理由（北極星 問い2
「これを無効にしたとき、Memory Framework として成立するか」）で採らない）。

### 決定3: 検出クエリは新しい任意メソッド `MemoryStore.findActiveByClaimKey?` に切り出す

`markContestedPair?`/`resolveContestedPair?`/`restoreSupersededBy?` と同じ判断——
`@mnemora/core` は npm に公開済みであり、必須メソッドを足すと第三者 adapter を壊す
破壊的変更になる。**フォールバック経路は無い**——この口を実装しない adapter に対しては、
検出は「対応していない」として静かに何もしない（`markContestedPair?` が無い adapter で
`Runtime.markContested` が `{supported:false}` を返すのと同じ設計。ここでは
`ContestedDetectionOutcome` 自体を作らず、その Memory についての検出結果を単に
配列へ積まない）。

契約の要点（全文は `packages/core/src/interfaces/memory-store.ts` の doc コメント）:

- `(tenant_id, subject_id, claim_key_subject, claim_key_predicate)` の等値比較——
  ADR 0320 決定7 が用意した `idx_memories_claim_key` がそのまま使える。
- `status = 'active'` の行だけを返す（ADR 0320 決定8 が「`status` の絞り込みは
  呼び出し側に委ねる」と決めた、その呼び出し側がこの口である）。
- `excludeMemoryId` に一致する行・`contentHash` が一致する行は返さない。
- 有効期間が重ならない行は返さない（決定4参照）。
- **`subjectId` は `IS NOT DISTINCT FROM`（NULL 同士も一致）で比較する。**

### 決定4: 有効期間の重なりは半開区間 `[validFrom, validUntil)` の標準判定を NULL=∞ で書く

`validFrom`/`validUntil` は既に列として在る（ADR 0145/ADR 0164、Issue #202/#280）。
新しい列は1つも足していない——issue 本文が期待した「既存の列だけで効かせる」をそのまま
実装した。

重なりの判定は、区間 A=[a1,b1)・B=[a2,b2) に対する標準的な式 `a1 < b2 AND a2 < b1` を、
`NULL` を「開いている端」として読み替えて書く: `validFrom` が `NULL` なら `-∞`、
`validUntil` が `NULL` なら `+∞`。

```sql
(a1 IS NULL OR b2 IS NULL OR a1 < b2) AND (a2 IS NULL OR b1 IS NULL OR a2 < b1)
```

`packages/postgres/src/memory-store.ts` の `aggregateScope` が使う `validAt`
ゲート（1点が有効期間の中に入っているか）と同じ NULL の読み方を、
「1点」ではなく「区間の重なり」に拡張しただけである——新しい規約を持ち込んでいない。

【実測】この条件を postgres 実装・in-memory 実装の両方に書き、適合テスト
（`packages/testkit/src/memory-store-conformance.ts` の `findActiveByClaimKey` 節、
「有効期間が重ならなければ返さない」「有効期間が重なれば返す（片方が無期限＝null でも
重なる）」）で、本物の Postgres に対して実際に確認した。

### 決定5: 一致件数で3方向に分岐する。呼べるのは0/1/2+の3つだけ

`detectClaimKeyContested`（`packages/core/src/runtime.ts`）:

| 一致件数 | 何をするか |
|---|---|
| **0件** | 何もしない（`{ kind: "no_conflict" }`） |
| **ちょうど1件** | `Runtime.markContested(ctx, memory.id, other.id, { reason: <構造化 JSON> })` を呼ぶ |
| **2件以上** | `markContested` を**一切呼ばない**。根拠を `memory_events` へ1件、構造として残すだけ（決定6） |

**「ちょうど1件」だけを対にする理由**: `markContested`/`markContestedPair`（ADR 0134）は
**一対一**の `contestedWithId` しか表現できない（`docs/memory-model.md` §5「一対一の関係で
表現できないケースは Phase 2 の `memory_relations` を必要とし…」）。同じ鍵に3件以上が
並んだとき、どの2件を対にするかを機械的に選ぶ根拠が無い——「最初に見つかった2件」を
勝手に対にすると、残りの1件（以上）が「対の外」という理由の無い特別扱いを受ける。
これは北極星 問い3（説明できるか）に対して「なぜこの2件だけが対になったか」を
説明できない選択であり、採らない。

### 決定6: 3件以上のケースは `markContested` を呼ばず、`memory_events` へ根拠だけを残す（#207 が無いと1対1で表せない負債）

[Issue #207](https://github.com/takecchi/mnemora/issues/207)（`memory_relations`、多対多の
`contradicts`）が無いと、同じ鍵に3件以上が並んだ状態を1対1の `contestedWithId` では
表現できない（ADR 0185 決定5 が同じ理由で依存の向きを検討している）。**#207 は本 PR の
範囲外**（マネージャーの判断——別 issue として扱う）。

**この ADR が採る形**: 状態は一切動かさず（`markContested` を呼ばない・`status` を
変えない）、`deps.eventStore.append` で `memory_events` へ1件だけ追記する:

```ts
{
  kind: "updated",             // MemoryEventKind という公開 union には値を足さない
  meta: {
    reason: "claim_key_conflict_unresolved",   // "contested" と紛れないよう別のタグ
    note: JSON.stringify({
      kind: "claim_key_conflict_unresolved",
      claimKey, subjectId,
      triggering: { id, contentHash, validFrom, validUntil },
      matches: [{ id, contentHash, validFrom, validUntil }, ...],
      matchCount,
    }),
  },
}
```

**`meta.reason` を新しいタグにする理由**: `"contested"`（ADR 0134 決定6が定めた固定値）を
再利用すると、`memory_events` から「実際に対になった」件数と「3件以上で保留になった」
件数を区別できなくなる——問い3（説明できるか）が要求する監査ログの精度を落とす。

**`MemoryEventKind`（公開 union 型）には値を足さない**（マネージャーの明示的な制約）。
`meta` はもともと自由形式の `Record<string, unknown>` であり、`kind: "updated"` +
`meta.reason` の固定タグという形は `consolidate`/`reflect`/`contested`/`contested_resolved`
と同じ、既に確立された規約に沿っている。

**これにより「同じ鍵に3件以上が並んだ」件数を、`memory_events` から
`meta.reason = 'claim_key_conflict_unresolved'` で数えられる**——issue 本文が求めた
「件数を数えられるようにする」をこの形で満たす。

### 決定7: 既存 `markContested` の CAS が `ineligible`/`conflict` を返す場合の扱い —— そのまま運ぶだけで、追加の救済はしない

「ちょうど1件」の場合に呼ぶ `markContested` は、自分自身の契約として次を持つ
（ADR 0134 決定4）: 両側とも `status === 'active'` でなければ CAS が `ineligible` を返し、
**この場合 `markContestedPair` は一切呼ばれず、`memory_events` にも何も書かれない**
（`packages/core/src/runtime.ts` の `markContested` 実装、`firstSide.kind !== "eligible"
|| secondSide.kind !== "eligible"` の早期 return を参照——この分岐には
`deps.eventStore.append` の呼び出しが無い）。

**この ADR はこの挙動を変えない。** `detectClaimKeyContested` は `markContested` の戻り値
（`MarkContestedResult`）をそのまま `ContestedDetectionOutcome.result.markContested` に
運ぶだけで、`ineligible`/`conflict` になったときに追加の再試行・追加の evidence イベントを
書く救済を行わない。

**理由**:

1. **`markContested` 自身が「開く前に落とす」「上限の無い再試行ループを作らない」という
   規律を持っている**（ADR 0134 決定4・決定5）。この ADR の検出コードがその上に
   独自の再試行やフォールバックを重ねると、2つの異なる安全弁の設計が1つの呼び出し経路に
   混在することになる。
2. **実害は限定的である。** 「ちょうど1件」の相手が TOCTOU で既に `active` でなくなって
   いる（例: 別の書き込みが割り込んで、その相手が既に別件で `contested`/`superseded`/
   `archived` になっていた）状況は、この検出コード自身の `findActiveByClaimKey` 呼び出しと
   `markContested` 内部の再読の間の短い窓でしか起きない——ADR 0134 負債2 が既に
   「`Runtime` を経由した `contested` ペアの一対一は、TOCTOU 以外では破れない」と記録して
   いる同じ種類の窓である。
3. **黙って消えるわけではない。** `ObserveResult.contestedDetection` に
   `result.kind: "contested"` かつ `result.markContested.outcome.kind: "ineligible" |
   "conflict"` という形で結果が残る——呼び出し側はこれを見て「検出は見つけたが、書き込みは
   成立しなかった」ことを知ることができる。ただし `memory_events` には残らない（上記の
   通り、`markContested` 自身がその場合にイベントを書かないため）。

**引き受ける負債として記録する**（「引き受けた負債」節、負債1）。

### 決定8: `superseded` へ進む経路は一切作らない

`detectClaimKeyContested`・`findActiveByClaimKey?` のどちらのコードにも、`resolveContested`
の呼び出しや `status: 'superseded'`/`supersededById` への言及が無い——**構造的に届かない**
（ADR 0185 決定4・北極星 問い4「AI の推論と、ユーザーが言った事実を区別する」。`claimKey` は
LLM が作る鍵＝推論であり、推論から導いた「矛盾」でユーザーが言った事実を消してはならない）。
`resolveContested` は今日どおり明示呼び出しのみのまま、この PR は1行も変更していない。

### 決定9: `ObserveResult.contestedDetection?`（純追加の任意フィールド）で結果を返す

`rejectedSubjectIds`/`claimKeyFailure` と同じ「渡していない／渡したが0件」を区別する規約
（`detectContested` を渡さなかった呼び出しではこの欄自体が無い。渡した場合は常に配列、
0件なら `[]`）。`ContestedDetectionOutcome[]` の各要素は `memoryId`・`claimKey`・
`matchCount`・`result`（`no_conflict`/`contested`/`unresolved_conflict` の判別共用体）を持つ。

**公開 API への影響はすべて任意の純追加**（`docs/decisions/0178-public-api-surface-gate.md`
の基準）: `ClaimKeyOptions` に optional 欄1つ、`ObserveResult` に optional 欄1つ、
新しい型 `ContestedDetectionOutcome` を1つ追加（既存の公開 union 型には触れていない）。
`MemoryStore` にも任意メソッド1つの追加のみ。

---

## 採らなかった案

### 案A: 検出を `tick()`/`observe()` から自動で駆動する背景処理にする

**採らない理由**: ADR 0185 採らなかった案2 と同じ——北極星 問い2「これを無効にしたとき、
Memory Framework として成立するか」に対し、「これが無いと訂正が効かない」を増やさない。
書き込みの延長として opt-in で走る形のほうが、既存の `markContested`/`resolveContested`
（明示的操作）と設計の対称性が保てる。issue 本文もこの形を明示的に指定している。

### 案B: 3件以上のケースでも、最初に見つかった1件と対にして `markContested` を呼ぶ

**採らない理由**: 決定5参照。「なぜこの2件だけが対になったか」を説明できない
（問い3に反する）。さらに、対にならなかった残りの1件（以上）が `active` のまま何の
記録も残らず、issue 本文が求めた「件数を数えられるようにする」を満たせない。

### 案C: `MemoryEventKind` に新しい値（例: `"claim_key_conflict"`）を足す

**採らない理由**: マネージャーの明示的な制約（公開の union 型に値を足さない）。
ADR 0122/ADR 0230 は同種の追加を「既存の網羅的 `switch` が無いことを確認した上での
安全な追加」として行った前例があるが、本 PR ではその判断をオーナー確認なしに広げず、
既存の `kind: "updated"` + `meta.reason` の固定タグという確立済みの形に寄せた。
**これは技術的な難易度の問題ではなく、この PR に与えられた裁量の範囲の問題である。**

### 案D: 検出クエリを `MemoryStore` の新しい口にせず、`Runtime` 側で `getMany`/独自のフィルタを組み合わせて実現する

**採らない理由**: `idx_memories_claim_key`（ADR 0320）は `(tenant_id, subject_id,
claim_key_subject, claim_key_predicate)` の部分索引であり、これを活かすには
adapter 側（SQL）でクエリを組む必要がある。`Runtime` 側でテナント全体を読んで JS で
フィルタすると、索引が意味を持たなくなる——北極星 問い5「列と索引で解けるものを、
モデルに問わない」の裏側にある「索引で解けるものは、索引で解く」という前提を破る。

### 案E: `subjectId` の比較を `=`（recall の `RecallScope.subjectId` と同じ規約）にし、`null` 同士は一致させない

**検討したが採らなかった。** `docs/memory-model.md` の「`NULLS NOT DISTINCT` が要る理由」
——Postgres の一意制約が NULL 同士を「異なる値」として扱ったことで実際にバグを生んだ
実測——と同じ配慮を、この検出クエリの述語側でも取った。issue 本文の「同じ subject_id」を
文字どおり読むと、`subjectId` を持たない Memory 同士（両方 `null`、例: テナント全体に
関する主張で個別の主体を紐づけていない場合）も「同じ主題」として扱うのが自然である。
`RecallScope.subjectId` の既定が厳密一致なのは、そちらが「絞り込み」（明示的に指定した
主題だけを見る）の文脈だからであり、この検出は「同じかどうか」を機械的に問うだけで、
緩める/締めるという選択の余地を持たない——文脈が異なるため、同じ規約を採る必要はないと
判断した。

---

## 引き受けた負債

### 負債1: 「ちょうど1件」の相手が TOCTOU で ineligible/conflict になったとき、`memory_events` に痕跡が残らない

決定7参照。`markContested` 自身の契約（ineligible のときは書き込み・イベントとも
一切行わない）を継承した結果、検出が「見つけた」ことと「実際に書けたかどうか」の
差が `ObserveResult.contestedDetection`（呼び出し側がその場で受け取る戻り値）には残るが、
**後から監査ログだけを見て「検出は動いたが書き込めなかった」ケースを追うことはできない。**

**なぜここで塞がないか**: (a) 実害が起きる窓は非常に短い（`findActiveByClaimKey` の
呼び出しと `markContested` 内部の再読の間）。(b) 塞ぐには `markContested` 自身の契約
（ADR 0134 決定4・決定5）を変える必要があり、この PR の主張（「衝突を検出する」）に
別の主張（「`markContested` の失敗時の監査ログを厚くする」）を混ぜることになる。
必要になったら、ADR 0134 を引き取る形で別 issue にする。

### 負債2: 3件以上のケースの evidence イベントは、対象の Memory 1件（今回作られたもの）にしか積まない

「同じ鍵に3件以上」の状況が起きたとき、`memory_events` へのイベントは**今回新しく
作られた Memory** の `memoryId` にだけ積む——既存の2件（以上）には積まない。理由は
「新しく `active` になった Memory の書き込みの延長」という決定2の設計上、既存の
Memory 側には新しい書き込みトランザクションを開く理由が無いためだが、**既存の各
Memory から「自分がどの `claim_key_conflict_unresolved` イベントに関係しているか」を
逆引きする経路は無い**（`memory_events.memory_id` で引く限り、今回作られた側からしか
見つからない）。

これは #207（`memory_relations`）が入ったときに自然に解消される負債として記録する
——多対多の関係テーブルがあれば、関係する全 Memory から同じ関係行を引ける。

### 負債3: `reextract`/`consolidate`/`reflect` が作る Memory は検出の対象にならない

決定2で述べた通り、検出は `runExtraction`（`observe()` の sync 抽出経路）にだけ配線した。
`reextract` は claim key opt-in の口をそもそも持たない（ADR 0320 決定4/6、#736 の設計を
そのまま引き継いだ）ため、`reextract` が作る Memory は `claimKey` が常に `null` であり、
検出の対象になりようがない。`consolidate`/`reflect` も同様——どちらも `claimKeyOptions` を
受け取らない経路であり、この PR で変更していない。

**これは新しい制約ではなく、#371（ADR 0320）が既に持っていた制約をそのまま継承した
だけである。** 将来、これらの経路にも claim key を持たせる決定が下されたときは、
この ADR の検出ロジック（`detectClaimKeyContested`）自体は経路に依存しないため、
呼び出し箇所を追加するだけで再利用できる見込みである。

### 負債4: 有効期間条件の効き目は、real-fixture 実測でも直接には測れていない

Issue #372 本文が「⛔ この効き目は測っていない」と明記している——「同じ鍵・重なる期間・
違う内容」が実際にどれだけの頻度で当たるかは、実運用データが無いと分からない。
本 ADR の実測（下記「測ったこと」）は、既存フィクスチャ（`probe-set.ts`/
`correction-scenario.ts`）に対して claim key を実際に付け、検出ロジックを流した結果を
記録しているが、**これらのフィクスチャには意図的に作られた「有効期間が重ならない対」が
ほぼ無い**（負債5参照）——効き目そのものは合成した対でしか確認していない。

### 負債5: 「3件以上」のケースは real-fixture では一度も観測されなかった

ADR 0320 負債2が既に「同じ鍵に3件以上並ぶケースを実測していない（既存フィクスチャに
3回以上言及される実データが無い）」と記録している。本 ADR の実測でも同じ制約が
そのまま残る——3件以上の分岐（決定5・決定6）は、単体テスト・適合テストでは実際に
発火することを確認したが、real-fixture の実データでは一度も発火しなかった。

---

## 北極星の問いに当てた結果

### 問1: 毎回渡す量を減らす方向に働くか

**検出単体では増える。** ADR 0134/ADR 0185 が問1に出した答えと同じ形——`contested` に
なった Memory は段3 の mandatory companion retrieval で対向を必ず連れてくる。
**削減が実際に起きるのは、`resolveContested`（別の明示呼び出し）が `contested` の片方を
`superseded` に確定させたときである。** 本 PR はその前提（検出が `contested` を書く経路）
を追加するだけである。

### 問2: これを無効にしたとき、Memory Framework として成立するか

**成立する。** `detectContested` を渡さない・`false` の呼び出しは、`findActiveByClaimKey`
を一度も呼ばない（`packages/core/src/__tests__/runtime.test.ts`「既定
（detectContested を渡さない）では、findActiveByClaimKey は一度も呼ばれず、1件も
contested にならない」で実測）。`tick()`/`observe()` から自動で駆動しない
（明示的な opt-in のときだけ、`observe()` 呼び出しの延長として動く）。

### 問3: この記憶が選ばれた理由を、後から説明できるか

**できる。** 「同じ鍵・重なる有効期間・違う内容」は1行で書ける規則であり、
`markContested` 呼び出し時の `meta.note` に、鍵・両側の `id`/`contentHash`/有効期間を
構造化 JSON として載せる（決定6の evidence イベントも同様の構造を持つ）。「なぜこの2件が
一緒に出てきたか」は監査ログと recall の trace（`retrievedVia: 'mandatory_companion'`）の
両方から辿れる。

### 問4: AI の推論と、ユーザーが言った事実を、区別しているか

**区別している。** 決定8参照——`superseded` へ進む経路を構造的に持たない。誤検出の被害は
「余分に1件、対向として出る」に限定される（ADR 0185 決定4がこの案を採れる条件として
明示した限定そのもの）。

### 問5: これは、LLM を呼ばずに済ませられないか

**済ませられる。** `detectClaimKeyContested`・`findActiveByClaimKey?` のどちらも
LLM を1箇所も呼ばない——列の等値比較・範囲比較・索引アクセスだけで判定する。
鍵の生成自体（#371、ADR 0320）は LLM を呼ぶが、それは既に本 PR の前提として
決着済みである。

---

## 測ったこと

### 1. 型・単体テスト・変異試験【実測】

- `packages/core`: `pnpm --filter @mnemora/core run typecheck` 緑。
  `pnpm --filter @mnemora/core exec vitest run`（全81ファイル、1365 passed / 85 expected
  fail、1450件）緑。新規の検出の歯9件（`runtime.test.ts`「observe: claimKey 検出」）を含む:
  既定 off・`detectContested: false`・1件一致で両側 contested・meta.note の構造・
  content_hash 同一で無衝突・有効期間不重複で無衝突・subject_id 不一致で無衝突・
  2件以上で unresolved・`findActiveByClaimKey` 無し adapter での静かな no-op。
- `packages/testkit`: `pnpm --filter @mnemora/testkit run typecheck` 緑。
  in-memory 適合テスト 350 passed / 1 skipped（351）。`findActiveByClaimKey` の契約の歯
  11件を追加（一致・exclude・subjectId null 一致・subjectId 不一致・predicate 不一致・
  content_hash 同一・status ゲート・有効期間不重複・有効期間重複（無期限含む）・
  クロステナント・任意メソッド未実装時の assert）。
- `packages/postgres`: `pnpm --filter @mnemora/postgres run typecheck` 緑。

### 2. Postgres 実測【実測】

`initdb`（PostgreSQL 17、pgvector・btree_gin・pgcrypto、専用ポート）で専用インスタンスを
立て、`AGENTS.md`「手元で Postgres を立てる」手順どおりマイグレーション（0001〜0021、
新しいマイグレーションは本 PR では追加していない——`findActiveByClaimKey` は既存の列・
既存の索引だけで実装できた）を適用し、`conformance.postgres.test.ts` を実行した:
**352 tests passed（0 failed）**。`findActiveByClaimKey` の契約の歯12件を含む
（下記の変異試験で歯を1本追加したため351→352）。`test:db` フルスイートも実行し、
本 PR に関係する範囲（`MemoryStore`/`EventStore`/`Runtime` 系）はすべて緑だった——
唯一失敗したのは無関係な `trigram-lexical-store.postgres.test.ts`（Issue #278、
ADR 0319）の4件で、原因はこの作業環境の `initdb --encoding=UTF8 --locale=C` という
組み合わせが同ファイルの doc コメントが自ら「CI の2脚（UTF8/SQL_ASCII）には無い
regime」と名指ししている条件に一致したため（`server_encoding` は UTF8 を通るが
自己一致検査が0になり `locale_no_japanese_trigrams` になる）——本 PR の変更とは
無関係。作業終了後、インスタンスは停止・データディレクトリごと削除した。

### 3. 変異試験【実測】（`docs/autonomy.md` §2、`cp` での退避・復元。`git checkout` は使っていない）

`packages/postgres/src/memory-store.ts`（本物の Postgres に対して）:

1. `subject_id IS NOT DISTINCT FROM` → `subject_id =` に変異 ⟹ 「subjectId が null
   同士でも一致として扱う」の歯が実際に赤くなった。復元後、緑に戻ることを確認した。
2. `content_hash <> ${query.contentHash}` → `content_hash = content_hash`（恒真）に変異
   ⟹ 「content_hash が同じ行は返さない」の歯が実際に赤くなった。復元後、緑に戻る
   ことを確認した。
3. `status = 'active'` → `status IN ('active', 'archived')` に変異 ⟹ 「status が active
   でない行は返さない」の歯が実際に赤くなった。復元後、緑に戻ることを確認した。
4. 有効期間の重なり判定の2つ目の `AND` 節（`valid_from IS NULL OR ... OR valid_from <
   validUntil`）を丸ごと削る変異 ⟹ **既存の歯1本では検出できなかった**（下記参照）。
   ⟹ **この変異試験自体が、歯の穴を見つけた**——「有効期間が重ならなければ返さない
   （去年の住所と今の住所）」という1本だけでは、重なり判定を構成する2つの AND 節の
   うち片方だけが働いても green のままになる配置だった（target が「今」・other が
   「去年」という時系列では、1つ目の節（`target.validFrom < other.validUntil`）が
   単独で false になり、2つ目の節が仕事をする機会が無かった）。**逆向きの時系列
   （target が「過去」・other が「現在」）を置く歯を追加し**、この変異が実際に
   その新しい歯を赤くすることを確認した上で、復元後に両方の歯が緑に戻ることを確認した。

`packages/core/src/runtime.ts`（in-memory、`docs/autonomy.md` §2 の cp 退避・復元）:

5. 検出の opt-in ゲート（`if (detectContested === true)`）を `if (true)` に変異 ⟹
   「既定（detectContested を渡さない）では、findActiveByClaimKey は一度も呼ばれず、
   1件も contested にならない」の歯が実際に赤くなった。復元後、緑に戻ることを確認した。
6. 「ちょうど1件」の分岐条件（`matches.length === 1`）を `matches.length >= 1` に変異
   ⟹ 「相手の active が2件以上（3件目以降）のときは markContested を呼ばず…」の歯が
   実際に赤くなった（2件以上でも先頭の1件とだけ対になろうとしたため）。復元後、
   `runtime.test.ts` の全111件が緑に戻ることを確認した。

**⟹ 変異試験そのものが、当初の歯の抜け（4番）を見つけ、直す機会になった**——
これは `docs/autonomy.md` §2 が変異試験に期待している効果そのものである。

### 4. real-fixture 実測【実測、2026-09-25、この作業者が自分の手で `gpt-4o-mini` に対して実行】

**入力**: すべて既存フィクスチャ由来（合成していない）。ADR 0320 と同じ7話題
（`examples/chat/src/probe-set.ts` の `PROBES`）の `fact`/`distractor` を、
`examples/chat/cassettes/retrieval.json` に記録済みの**実際の抽出結果**へ差し替えて
使った（1文字も生成していない、既存カセットからそのままコピー。ADR 0320 が「1回目の
実行は方法論の誤りで失敗した」と記録した教訓——複数主張を含む生発話を渡すと
claim key の対応付けが壊れる——をそのまま踏襲し、単一主張の抽出後 content だけを
渡した）。加えて `examples/chat/src/correction-scenario.ts` の実訂正ペア（2発話）。
計16件。

**方式**: 本番コード（`packages/core/dist/runtime.js` の `Runtime.observe`（claim key
派生＋検出の両方を含む本番の経路そのもの）、`packages/openai/dist/llm-provider.js` の
`OpenAILLMProvider`）をそのまま使った。抽出ステップは固定応答のスタブに差し替えた
（抽出そのものの安定性は ADR 0320 が既に測定済みであり、本 ADR の実測対象は
「鍵が付いた後、検出が実際にどう振る舞うか」であるため、n=5 回とも同一の抽出結果に
そろえて変数を1つ減らした——ADR 0301「抽出結果を固定し鍵の呼び出しだけ n 回」と
同じ考え方）。claim key 派生の呼び出しは毎回実 API。**検出自体（`findActiveByClaimKey`・
`markContested` の CAS・evidence イベント）は本番の in-memory 実装をそのまま経由し、
LLM を一度も呼んでいない。**

**語彙ヒント**（`knownPredicates`）: 7話題から作業者が作った7件
（`favorite_color`/`pet_ownership`/`exercise_habit`/`food_intolerance`/
`sibling_residence`/`programming_language_preference`/`business_trip`）。

**有効期間**: `travel-fact`（来月の京都出張）に基準日+30日〜+31日、`travel-distractor`
（先月の大阪出張）に基準日-30日〜-29日を明示的に設定し、重ならないようにした
（他14件は `validFrom`/`validUntil` とも省略——常に重なる）。**この設定自体は
作業者が仕込んだものであり、実データからの推測ではない**——ADR 0320 負債3「有効期間の
重なり判定は実測していない」を埋めるための意図的な操作である。

**結果**（n=5、`runtime.observe()` を通じた実行）:

| 指標 | 値 |
|---|---|
| 真の訂正対（`correction-scenario.ts`、同じ subject・同じ predicate・違う値）の検出 | **5/5（100%）** ——毎回 `contested` になった |
| 有効期間が重ならないペア（`travel`、同じ subject・同じ predicate だが期間が重ならない） | **5/5（100%）で `contested` にならなかった**——claim key 自体は5/5とも完全一致していたにもかかわらず、有効期間条件が正しく除外した |
| 3件以上で保留になった件数 | **0/5**（同じ鍵が3件以上並ぶ状況が real-fixture に無いため。ADR 0320 負債2と同じ制約） |
| 誤検出（無関係な話題間、`color`/`pet`/`exercise`/`diet`/`family`/`language` の fact対distractor、6話題×5回=30組） | **9/30（30%）** ——**すべて claim key の `subject` が実際には別人の発話（例:「妻」「姉」「同僚」）を `"user"` に誤帰属したことが原因**（`predicate` の一致は語彙ヒントで安定していたが、`subject` の弁別が topic によって大きく揺れた: `family` 4/5・`language` 3/5・`diet` 2/5・`color`/`pet`/`exercise`/`travel` 0/5） |
| 検出そのものの追加 API 呼び出し | **0回**（`findActiveByClaimKey`/`markContested` は LLM を呼ばない。呼び出し回数はすべて claim key 派生の分） |
| 呼び出し回数・費用 | 80回（16件 × n=5、claim key 派生のみ）、prompt tokens 30,825、completion tokens 1,218、**概算 $0.00535**（`examples/chat/src/usage-meter.ts` の `PRICING_USD_PER_MILLION_TOKENS["gpt-4o-mini"]` と同じ単価） |

**観測1: 検出ロジック自体は規則どおりに動いた。** 上の数字はすべて「鍵が一致した
ペアを検出が正しく処理したか」であり、`findActiveByClaimKey`/`markContested` が
規則（同じ鍵・重なる有効期間・違う内容・両方 active）から外れた動きをしたケースは
一度も無かった——**誤検出の原因は検出コードではなく、上流（#371/ADR 0320）の
claim key 派生の `subject` 弁別の不安定性である。**

**観測2: 有効期間条件は、real-fixture で初めて「効いた」ことが確認できた。**
ADR 0320 負債3は「有効期間の重なり判定を実測していない」と明記していた——本 ADR は
それを埋めた。`travel` の対は claim key が5/5とも完全一致する（`subject:"user",
predicate:"business_trip"`）にもかかわらず、有効期間条件が無ければ5/5とも誤って
`contested` になっていたはずである。**issue #372 本文が「これが無いと『去年の住所』と
『今の住所』が矛盾になる」と警告した効果が、実データで実際に確認できた。**

**観測3: 誤検出（30%）は、決定4（`contested` で止める）の限定が現実に効く場面である。**
`family`/`language`/`diet` で実際に誤って `contested` になった9組はすべて、
`docs/memory-model.md` §5 機構2 のとおり両方を隣接させて提示する状態になっただけであり、
**片方が黙って消えたケースは1件も無い**（この PR は `superseded` へ一切進まないため、
構造的に消えようがない）。⚠ **ただし30%という頻度は無視できない**——`markContested`
自体は成功しており、この Memory は今後 `resolveContested` が明示的に呼ばれるまで
`contested` のまま残り、recall のたびに対向を強制的に道連れにする（ADR 0134/0185 が
問1に出した答えのとおり、この分だけ渡す量が増える）。

**⚠ この実測は n=6話題・1モデル・1言語・16件という小さい範囲のものであり、本番規模の
保証ではない**（ADR 0320 負債1と同じ限定）。特に「30%」という誤検出率は、この7話題の
語彙選択（家族関係・同僚関係を扱う話題が相対的に多い）に強く依存しており、一般化は
できない。

再現手順は ADR 0315 と同じ形式（使い捨てスクリプト、リポジトリにはコミットしていない）
——`packages/openai` ディレクトリで `@mnemora/core`/`@mnemora/testkit`（in-memory
fixtures）/`@mnemora/openai` の dist を直接 import し、`Runtime.observe()` を
`claimKey: { enabled: true, detectContested: true, knownPredicates }` 付きで16件
呼ぶ、を n=5 回繰り返す。

### 負債6: 🔴 real-fixture 実測で、誤検出（30%）のほぼ全量が claim key の `subject` 誤帰属だと分かった

**実測（上記4節）**: 無関係な話題間の fact/distractor 30組中9組（30%）が誤って
`contested` になった。**原因はすべて claim key 派生の `subject` が第三者の発話
（「妻」「姉」「同僚」等）を `"user"` に誤帰属したことであり、検出コード（本 ADR の
範囲）自体の欠陥ではない**——検出は渡された鍵に対して規則どおりに動いている。

**この ADR はこれを塞がない**——`subject` 弁別の精度は #371（ADR 0320）の claim key
派生ロジックの領分であり、本 ADR（検出）の変更では直せない。**ただし、この頻度
（30%）は既定を on にするかどうかの判断材料として重い**——決定4（`contested` で
止める）が誤検出の被害を「余分に1件出る」に限定しているとはいえ、3割という頻度は
「余分に1件」が頻繁に起きることを意味し、recall のたびに無関係な対向が道連れに
なる回数が無視できない可能性がある。

**なぜここで塞がないか**: (a) 直すには claim key 派生プロンプト（`claim-key.ts` の
`CLAIM_KEY_PROMPT_SYSTEM`）に「本文の主語が発話者以外なら、その人物を subject にする」
という指示を足す必要があり、これは #371/ADR 0320 の変更であって #372（検出）の変更
ではない。(b) 直す前に、この頻度が7話題という小さい範囲に固有のものか、より広い
範囲でも同じ傾向を示すのかを確かめる必要がある——本 ADR の実測はその追加実験を
行っていない。

**⟹ Issue #371（またはその後継）に、この実測結果を持ち帰ることを推奨する**
（この ADR はそれを issue 化する権限を持たないが、記録として残す）。

## 確かめていないこと

- ⚠ **本番規模での効き目**（負債4）——「同じ鍵・重なる期間・違う内容」が実運用でどれだけ
  当たるかは実データが無いと分からない。**有効期間条件については本 ADR の実測4節が
  小さい範囲で効き目を確認した**（travel の対、5/5で正しく除外）が、n=1対・合成した
  有効期間であり、本番規模の保証ではない。
- ⛔ **3件以上のケースの real-fixture での発火**（負債5）——既存フィクスチャに3回以上
  言及される実データが無い。本 ADR の実測でも0/5のまま。
- ⛔ **`reextract`/`consolidate`/`reflect` 経路との組み合わせ**（負債3）。
- ⛔ **TOCTOU で `markContested` が ineligible/conflict になったときの監査ログの薄さが
  実運用でどれだけ問題になるか**（負債1）。
- ⛔ **claim key の `subject` 誤帰属（負債6）が、7話題という範囲を超えても同じ頻度
  （30%）で起きるか**——測っていない。

## これが覆るとしたら

- **[#207](https://github.com/takecchi/mnemora/issues/207)（`memory_relations`）が実装
  されたとき**——決定5・決定6・負債2が解消され、3件以上のケースも多対多の関係として
  `contested` 相当の状態に載せられる可能性がある。
- **既定を on にする決定が下されたとき**（ADR 0185 決定7、オーナー専権）——`claimKey.
  enabled`/`detectContested` の既定値を変える必要がある。この PR はどちらを推奨するかを
  決めない（マネージャーの判断）。負債6の実測（誤検出30%）は、その判断の材料として
  残す。
- **`reextract`/`consolidate`/`reflect` にも claim key を持たせる決定が下されたとき**
  （負債3）——`detectClaimKeyContested` 自体は経路に依存しないため、呼び出し箇所を
  追加するだけで再利用できる見込み。
- **claim key 派生の `subject` 弁別精度が改善されたとき**（負債6、#371/ADR 0320 側の
  変更）——本 ADR の誤検出30%という数字は、その改善の効果を測る「改善前」の基準値
  として使える。

## 追記（2026-09-26）—— `supportsFindActiveByClaimKey` を任意へ戻す（Issue #818）

> **⚠ この追記は、自動化された担い手（クローン miku のセッションから切り出された担い手）
> のものである。**
> **⛔ オーナー本人の判定ではない**
> （[ADR 0220](./0220-issue-comment-author-does-not-distinguish-owner-from-agent.md)）。
> ⚠ GitHub の actor は層を判別しないので、この追記を含む PR も `takecchi` の名前で載る。
> **名前で読まないこと。**

**この ADR の PR（7987de4、#745）は `MemoryStore.findActiveByClaimKey?`
（interface 上は任意メソッド）と対になる、`packages/testkit` の
`MemoryStoreConformanceOptions.supportsFindActiveByClaimKey` を**必須**の `boolean`
フィールドとして足した——既存の8本の `supports*` フラグ
（`supportsArchiveDecayed`/`supportsPurgeMemory` 等）と同じ「省略可にしない」判断を
踏襲したもので、この ADR 本文にその破壊性の記載は無かった。**

**壊れたこと・判断・引き受けた負債は
[ADR 0318](./0318-taxonomy-labels.md) の同日付の追記（`supportsTaxonomyMode`/
`supportsLabels` の追記）と同一——ここでは複製しない。**要点だけ書く: v1.0.0 の
時点では `supportsFindActiveByClaimKey` は存在せず、v1.0.0 の利用者の
`describeMemoryStoreConformance(...)` 呼び出しはこのフィールドを持っていない。
`7987de4` 以降の `@mnemora/testkit` に対してその呼び出しはコンパイルできなくなって
いた（[Issue #818](https://github.com/takecchi/mnemora/issues/818)）。

**判断（クローン miku の判断——オーナーの判断ではない）**: `?: boolean` へ戻し、
省略時はこの ADR が定義した契約の歯（`findActiveByClaimKey!` を呼ぶ一連の `it()`）を
実行しない。`packages/postgres`/`packages/testkit` 同梱の2実装を配線する呼び出しは
引き続き明示で `true` を渡しており、「配線したのに検査していない」を検出する効果は
そちらに対しては変わらず働く。

詳細な歯・変異試験・スナップショット差分は、この追記を運んだ PR
（[Issue #818](https://github.com/takecchi/mnemora/issues/818) を close する PR）の本文を
見ること——ここには複製しない。

## 追記（2026-09-27）—— 逐次に届く経路では、決定6の「3件以上の件数を数えられる」が成り立たない（Issue #933）

> **この追記は、クローン miku の委譲先の担い手が書いた。オーナー本人の判定ではない**
> （[ADR 0220](./0220-issue-comment-author-does-not-distinguish-owner-from-agent.md)）。
> 採用済みの本文は書き換えていない。

**【実測】** 同じ claim key の違う主張を、毎回 `detectContested: true` を渡して1件ずつ
`observe()` した（`packages/core` の Fake と本物の Postgres 17 の両方で同じ結果）。

| 回 | 一致件数 | 結果 | `claim_key_conflict_unresolved` の累計 |
|---|---|---|---|
| 1件目 | 0 | `no_conflict`、`active` | 0 |
| 2件目 | 1 | 1件目と対になり、両方 `contested` | 0 |
| 3件目 | 0 | `no_conflict`、`active` のまま、痕跡なし | 0 |
| 4件目 | 1 | 3件目と新しい対になる | 0 |

決定3の `findActiveByClaimKey?` は `status = 'active'` の行だけを返す（契約どおりで、
3実装とも正しい）。決定5の「ちょうど1件」で対にした2件は `contested` になって
`active` から外れるため、同じ鍵の主張が1件ずつ届く経路では、一致件数は0か1にしか
ならず、決定5の「2件以上」の分岐と決定6の evidence イベントには到達しない。
⟹ 決定6の「同じ鍵に3件以上が並んだ件数を、`memory_events` から
`meta.reason = 'claim_key_conflict_unresolved'` で数えられる」は、この経路では成り立たない。
3件目以降は、`active` のまま `contestedWithId` も evidence も持たずに残る。
本文の「測ったこと」と負債5が扱った「2件以上」の単体テストは、1件目・2件目を
`detectContested` を使わずに作ることで、この分岐に到達させていた。

**直していない。** 直すには、同じ鍵の `contested` の行を一致として数える口
（`findActiveByClaimKey?` の意味を広げるか、新しい任意メソッドを足すか）が要る。
前者は公開済みの契約を型の変更なしに変え、後者は `memory-store-conformance.ts` に
要件を足す。どちらも「同じ鍵の `contested` の行を同じ矛盾の集合に数える」判断を含み、
多者の `contested` の持ち方（[Issue #207](https://github.com/takecchi/mnemora/issues/207)、
[ADR 0327](./0327-relation-graph-contested-write-path-design.md) の未決）に依存する。
案と帰結、オーナーへの問いの下書きは
[Issue #933](https://github.com/takecchi/mnemora/issues/933) のコメントにある。
