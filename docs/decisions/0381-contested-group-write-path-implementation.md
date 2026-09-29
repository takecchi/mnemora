# ADR 0381: 多者間 `contested`（`memory_relations`）の書き込み経路の実装 —— Issue #207/#933 PR2 段階B の直しと設計判断

- **状態**: 提案 (2026-09-30)
- **日付**: 2026-09-30

> **⚠ この ADR は、マネージャー（クローン miku）から切り出された担い手が書いた。**
> 設計判断の一部（段階Aで確定した11個の決定）はマネージャー経由で渡された確定済みの
> 前提であり、この ADR の書き手が新たに選んだものではない（ADR 0220 と同じ、伝聞の
> 1段）。**段階Bで新たに必要になった直し（fix1・fix2）と、実装の中で下した詳細判断は、
> この担い手が決めた**——どちらであるかは各節に明記する。

---

## 出所の凡例

- **【伝】** — マネージャー経由で渡された、確定済みの前提。この ADR の書き手は検証していない。
- **【現物】** — この repo のコード・文書を、この ADR の書き手が自分で読んで確かめた。
- **【実測】** — この手元の器で実際にコマンドを走らせて得た。
- **【判】** — この ADR の書き手（担い手）が、この PR の範囲内で下した設計判断。

---

## 0. この ADR が答える範囲

[ADR 0327](./0327-relation-graph-contested-write-path-design.md)（関係グラフ本体の書き込み
経路の設計、状態: 提案）・[ADR 0378](./0378-claim-key-contested-detection-covers-contested-matches.md)
（claim key 検出が3件目以降も一致に数える設計、状態: 採用）が決めた設計を、Issue #207/#933
PR2 として実装した。段階Aで `RelationStore`・`MemoryStore.markContestedGroup?`/
`resolveContestedGroup?`・migration 0026 の型と実装を作り、段階Bで次を行った:

1. 段階Aの2つの穴を直す（fix1・fix2、§1・§2）。
2. `Runtime.markContestedGroup?`/`Runtime.resolveContestedGroup?`（読み側の適格性の分類、
   `Runtime.markContested`/`resolveContested` と対称の層）を実装した（§3）。
3. `detectClaimKeyContested` の `contested_group` 分岐（穴Aの吸収・合併を含むメンバーの
   組み立て）を実装した（§4）。
4. **recall 段3（`contradiction_resolution`、必須の同伴取得）への group 対応は、この PR では
   実装しなかった。**理由と、この ADR が見つけた設計上の未決着点を§5に記録する。

**本 ADR が答えないこと**: `memory_relations` テーブルの形自体（ADR 0292 決定1）、
多者間 `contested` を書く口の契約自体（ADR 0327・段階A、`MemoryStore.markContestedGroup?`
の interface JSDoc）——これらは既に決着している。

---

## 1. fix1 — 重なりの判定を1か所に寄せる（Postgres, SQL 側へ統一）【判】

### 1.1 直した内容

段階Aの `PostgresMemoryStore.markContestedGroup` は、重なる組を JS の二重ループで判定して
から `tx.execute` を組ごとに呼んでいた——`findActiveByClaimKey`/`findContestedByClaimKey`
が使う半開区間の SQL 式と同じ式を JS 側にもう1つ持つ、二重管理だった。

直した後は、単一の `INSERT ... SELECT`（自己結合）に置き換えた:

```sql
INSERT INTO memory_relations (id, tenant_id, from_memory_id, to_memory_id, kind)
SELECT gen_random_uuid(), $tenantId, a.id, b.id, 'contradicts'
FROM memories a
JOIN memories b
  ON b.tenant_id = a.tenant_id
 AND b.id <> a.id
 AND b.id = ANY($ids::uuid[])
WHERE a.tenant_id = $tenantId
  AND a.id = ANY($ids::uuid[])
  AND (a.valid_from IS NULL OR b.valid_until IS NULL OR a.valid_from < b.valid_until)
  AND (b.valid_from IS NULL OR a.valid_until IS NULL OR b.valid_from < a.valid_until)
ON CONFLICT (tenant_id, from_memory_id, to_memory_id, kind) DO NOTHING
```

`WHERE` 節の左右対称性（`a`/`b` を入れ替えても同じ式になる）を利用し、`a`×`b` の自己結合
から両方向の行が自然に出る——逆方向専用の2本目の `INSERT` を足す必要が無い。JS 側の
`overlaps()` ヘルパーと二重ループは削除した。**Fake（`packages/core`）・InMemory
（`packages/testkit`）は JS のままでよい**（マネージャー指示どおり——これらは SQL を
持たないため、重なりの式を1か所に寄せる先が無い）。

### 1.2 境目の適合テスト（マイクロ秒精度）

`packages/testkit/src/memory-store-conformance.ts` に、`validUntil` と次の `validFrom` が
**ちょうど一致する**（重ならない、半開区間の境目）組には行を張らない適合テストを足した
——Postgres・InMemory の両方で同じ結果になることを縛る。

**JS の `Date` はミリ秒までしか精度を持たない。**アプリの書き込み経路（`createMemory` 等）は
すべて `toPgTimestamp(date: Date)` を通るため、実際に書かれる値は常にミリ秒精度に丸まる
——Postgres の `timestamptz`（マイクロ秒精度）との差は、公開 API のどの経路からも実際には
現れない。この差を**到達できないが Postgres 自身は正しく処理する**ことを示すため、
`packages/postgres/src/__tests__/mark-contested-group-microsecond-boundary.postgres.test.ts`
を新設した——`pool.query` で生の SQL を打ち、`valid_until` が `valid_from` よりちょうど
1マイクロ秒だけ後ろにずれた組（JS の `Date` では同じ値に潰れて区別できない差）が、
Postgres では正しく「1マイクロ秒だけ重なる」と判定され、関係の行が張られることを実測した
（陽性対照）。陰性対照として、境目がマイクロ秒まで完全に一致する組には行が張られないことも
同じテストで確認した。

**この差を fixture（InMemory・Fake）側で再現するテストは書いていない**——JS の `Date` の
精度そのものの限界であり、Postgres 側だけの歯として置く（「Postgres が正、fixture は
ミリ秒までしか追えない」という限界の記録）。

---

## 2. fix2 — resolve で群の一部だけを渡したら、store の CAS で弾く【判】

### 2.1 直した内容

`MemoryStore.resolveContestedGroup?` の CAS に、「渡された `members` が、`memory_relations`
でつながった『今も `contested` な』群の全員と一致すること」を追加した。一部だけを渡した
解消（部分解消）を拒み、何も書かない。

- **Postgres**: `WITH RECURSIVE` で `memory_relations`（`kind: 'contradicts'`）を辿って
  到達する id を求め、そのうち `memories.status = 'contested'` のものを、渡された id 集合と
  突き合わせる。欠けがあれば `MemoryStatusConflictError(missingId, "contested", "contested")`
  を投げ、何も書かない——**`expectedStatus === observedStatus === 'contested'`** という、
  通常の CAS 違反（`expectedStatus !== observedStatus`）とは意味が異なる特別な使い方である
  （「この id 自身の状態は問題ないが、群の全員としてこの呼び出しに含まれていなかった」ことを
  表す）。
- **InMemory・Fake**: 同じ判定を BFS（`this.relations`/`this.backing.relations` を手で辿る）
  で行う——SQL の `WITH RECURSIVE` に相当するグラフ探索を JS で書いた。

### 2.2 「群の全員」から抜けたメンバーの扱い【判】

決定10（forget・supersede・purge・archive で群を離れたメンバーの `memory_relations` 行は
残す）と矛盾しない形にするため、「群の全員」は**行の有無ではなく `status === 'contested'`
で判定する**——到達集合のうち、まだ `contested` なものだけを「今の群」として数える。
forget 等で離脱したメンバー（関係の行は残るが `status` はもう `contested` ではない）は、
到達集合に入っても「欠けたメンバー」として数えない。この判断を採らなければ、一度でも
メンバーが forget されると、その群は二度と `resolveContestedGroup` で解消できなくなって
しまう（行が永遠に残る設計〔決定10〕である以上、この扱いを選ばないと機能そのものが壊れる）。

### 2.3 Runtime 側の確認【判】

`RuntimeDeps` に新しい任意の依存 `relationStore?: RelationStore` を足した
（`RuntimeDeps.lexicalStore?` と同じ「省略可能・省略しても mnemora は成立する」設計）。
`Runtime.resolveContestedGroup?` は、`deps.relationStore` が配線されていれば、store を呼ぶ
**前**に同じ確認を読み側でも行う——`memberIds` から `kind: 'contradicts'` を辿って到達する
`status === 'contested'` な id が `memberIds` の外にあれば、書き込みを一切試みず
`{ kind: "ineligible", sides, missingMembers }` を返す。**`relationStore` が配線されて
いなければ、この読み側の確認は行わず store 側の CAS だけに任せる**——store が
`MemoryStatusConflictError` を投げれば `{ kind: "conflict", ... }` に落ちる（動作としては
安全だが、`ineligible`/`conflict` のどちらに分類されるかが `relationStore` の有無で変わる。
§7「引き受けた負債」に記録する）。

適合テスト（`packages/testkit/src/memory-store-conformance.ts`）に、群の一部だけを渡す歯を
足した——4件の群を作り、3件だけを解消しようとして `MemoryStatusConflictError` になり、
4件とも `status: 'contested'` のまま変わらないことを、Postgres・InMemory の両方で確認した。
`packages/core/src/__tests__/resolve-contested-group.test.ts`（Fake、Runtime 層）にも
同じ形の歯と、`relationStore` の有無で挙動が変わることを示す歯を足した（§7参照）。

---

## 3. `Runtime.markContestedGroup?`/`Runtime.resolveContestedGroup?`【判】

`Runtime.markContested`/`resolveContested`（ADR 0134/ADR 0150）と対称に、読み側の適格性を
`getMany` で分類してから store の口を呼ぶ薄い層を追加した。

- **任意メソッドである**（`?`）。`@mnemora/core` は v1.0.0 として npm に公開済みであり、
  `Runtime` interface を自前で実装している利用者にとって、v1.0.0 の後に必須メソッドが
  増えることは破壊的変更になる——`resolveOrphanedContested?`（ADR 0150 追記、Issue #825）が
  確立した前例をそのまま踏襲した。`createRuntime()` の戻り値には必ず実装されている。
- **引数は `memberIds: readonly MemoryId[]` だけを取る**（`event`/`status`/`supersededById`
  は Runtime 自身が組み立てて `MemoryStore.markContestedGroup?`/`resolveContestedGroup?`
  へ渡す）——`markContested(ctx, firstId, secondId, opts?)`/`resolveContested(ctx, firstId,
  secondId, resolution, opts?)` と同じ「Runtime 層は id だけを受け取り、書き込みに必要な
  形は自分で組み立てる」分担にした。段階Aで確定した `MemoryStore` の口自体（`members[].event`
  を呼び出し側が組み立てて渡す形）とは非対称に見えるが、これは`markContestedPair`/
  `markContestedGroup?` という store 側の口と、それを呼ぶ `Runtime.markContested`/
  `markContestedGroup?` という2つの別の層の話であり、段階Aが決めた store 側の契約には
  一切触れていない。
- `resolveContestedGroup?` の `resolution.kind === "supersede"` で `winnerId` が大文字小文字
  だけ違う場合の救済（`resolveContested`（2者版）にある機能）は、群では実装しなかった
  ——2者なら「もう片方」の1択だが、3件以上では「どれとも大文字小文字だけ違う」場合に
  候補を一意に絞れないケースがずっと起きやすく、この PR の範囲を超える判断が要る
  （§7「引き受けた負債」）。

---

## 4. `detectClaimKeyContested` の `contested_group` 分岐【判】

### 4.1 `ClaimKeyOptions.formContestedGroups?: boolean`（既定 `false`）を新設した【判】

`detectContested: true` の「一致が2件以上、または一致がちょうど1件だがその1件が既に
`contested`」の分岐（ADR 0378 決定5が「evidence-only、状態を動かさない」と決めた分岐）で、
`formContestedGroups: true` を渡し、かつ `deps.memoryStore.markContestedGroup` が
配線されていれば、evidence だけに留めず実際に `Runtime.markContestedGroup` を呼んで群として
書き込む。

**既定を `false` にしたのは意図的な判断である。**Issue #933 PR1（ADR 0378）が確立した
「evidence-only」の挙動を期待する既存の歯（`claim-key-single-contested-match.test.ts` 等、
PR1の歯）は、`packages/core/src/__tests__/runtime-fakes.ts` の `FakeMemoryStore` が
段階Aから `markContestedGroup`/`resolveContestedGroup` を常に実装しているため、もし
この新しい書き込みが既定で有効だったら、PR1の歯を1文字も変更していないのに Stage B の
コード変更だけで結果が変わって落ちる——**「PR1 の歯を書き換えない」という制約と、
「detectClaimKeyContested の contested_group 分岐を実装する」という Stage B の要求を
両立させる唯一の道が、この opt-in だった。** 既定 `false` を選んだことで、PR1 のテスト
ファイルは1文字も変更せずに全て緑のまま通る（実測、§8）。命名・配置
（`ClaimKeyOptions` の新フィールド）は `autoQueueConsolidateReflectOnExtract`・
`knownPredicatesFromStore` と同じ「既定は今までどおり、opt-in だけが新しい」規約に揃えた。

### 4.2 メンバーの組み立て（穴A・合併）【判】

3件以上に広がった `matches`（`findActiveByClaimKey`/`findContestedByClaimKey` の合わせた
結果）から、群のメンバー集合を次の順で広げる:

1. **種** — 検出中の `memory` 自身と、`matches` の全員。
2. **穴A（既存の2者間の対の吸収）** — `matches` のうち `status === 'contested'` かつ
   `contestedWithId !== null` なものは、その相手（`contestedWithId` が指す id）も群に
   加える。**相方自身は claim key の一致条件（有効期間の重なり等）を満たさないことが
   ある**ため、`matches` に現れないことがある——`contestedWithId` は Memory 自身が既に
   持つフィールドなので、追加の store 呼び出し無しにこの欠けを埋められる。
3. **合併（複数の既存群の統合）** — `deps.relationStore` が配線されていれば、ここまでの
   メンバーのうち `status === 'contested'` かつ `contestedWithId === null`（＝既存の3件
   以上の群のメンバー）な id から `kind: 'contradicts'` を辿って到達できる id を候補に
   加える（BFS）。**候補は `getMany` で読み直し、`status === 'contested'` のものだけを
   実際に群へ加える**——fix2（§2.2）と同じ「行の有無ではなく `status` で今の群を判定する」
   規律。resolve 済みの群は関係の行を削除している（`resolveContestedGroup?` 契約）ので、
   ここで見つかるのは今も現存する群だけである。`matches` が2つの既存群それぞれの
   メンバーを1件ずつ含んでいた場合、両方の群の全メンバーがここで合流し、1つの群になる。

広げた結果が3件未満（`markContestedGroup` の最小人数を満たさない——例: `relationStore` が
配線されておらず、既存群の残りのメンバーを辿れない場合）のときは呼ばない。呼んで
`outcome.kind !== "contested_group"`（`ineligible`/`conflict`。TOCTOU 等）になった場合も
含め、どちらも今まで通りの evidence-only の `memory_events` 追記 + `unresolved_conflict`
へフォールバックする——状態が動かなかった呼び出しで、根拠だけは必ず残す（ADR 0378 決定5の
踏襲）。

`ContestedDetectionOutcome.result` に新しい判別子 `{ kind: "contested_group"; memberIds:
MemoryId[]; markContestedGroup: MarkContestedGroupResult }` を足した。

---

## 5. recall 段3（`contradiction_resolution`）への group 対応 —— この PR では実装しなかった

### 5.1 コーディネータからの依頼と、見つけた食い違い【判】

コーディネータの依頼は「recall 段3: 上限10（`DEFAULT_RECALL_ASSOCIATION.maxCount`）、
`validFrom` の新しい順→id の順で切り、切った件数を `explain` に、`"relation"` という
`stage` 値を `Omission.over_limit`/`stage_skipped` に追加する」というものだった。

この PR の調査で、[ADR 0292](./0292-relation-graph-table-depth-omitted-design.md)
決定2・決定3（状態: **提案**、2026-09-25）が、**既にほぼ同じ形を設計済みだった**ことが
分かった:

- `RecallQuery.relations?: RecallRelationQuery { maxCount: number }`——**既定 off、
  `RecallAssociationQuery`（連想枠、§9.5）と同じ形の、独立した opt-in の探索チャンネル**
  （決定2-b）。`maxCount` は**この chunk 専用の必須フィールド**であり、
  `DEFAULT_RECALL_ASSOCIATION.maxCount` を流用する設計にはなっていない。
- `over_limit` に `stage: "relation"`、`stage_skipped` に `stage: "relation"`
  （決定3-a・3-b）——ここはコーディネータの依頼と一致する。
- 1段より先（未探索の深さ）は `Omission` を増やさず `explain.stages[].detail.
  relationDepthCapped: true` という型無し診断キーに置く（決定3-c）。

**しかし ADR 0292 が設計したのは、既存の「必須の同伴取得」（段3、`contradiction_resolution`、
`docs/memory-model.md` §5 機構3「対向は必ず隣接させる」の実装）とは別の、呼び出し側が
`query.relations` を明示的に渡したときだけ動く探索チャンネル（連想枠 §9.5 に近い位置づけ）
である。**一方、コーディネータの依頼文言「recall 段3」は、歴史的に
`stage: "contradiction_resolution"`（`docs/recall.md` §2 段3）を指す——**この既存の段3
（無条件・必須）自体を、N者間の群にも対応させる**、という別の実装対象を指している
可能性がある。

この2つは実装の姿が大きく異なる:

- (a) ADR 0292 が設計した「独立した opt-in の探索チャンネル」——`RecallQuery.relations?` を
  渡した呼び出しだけが影響を受け、既定の recall は1バイトも変わらない。
- (b) 既存の段3（`contradiction_resolution`、無条件）自体を、`contestedWithId`（2者）だけ
  でなく `RelationStore`（N者の群）も見るように拡張する——**`docs/memory-model.md` §5
  機構3「対向は必ず隣接させる」を、N者の群にどう一般化するか**（「隣接」は2件の並びの話
  であり、3件以上の群を「隣接」させる意味自体が新しい設計判断を要る）という、
  ADR 0292 が明示的に範囲外とした問いに触れる。

### 5.2 この PR での判断: 実装を見送り、判断をマネージャー/オーナーへ返す【判】

**この食い違いを、この担い手の判断だけで一方に決めて実装することはしなかった。**理由:

1. **(b) を選ぶ場合、`docs/memory-model.md` §5 機構3・ADR 0043〜0046（単位組み立て・
   shortfall・対不変条件）という、この repo が最も厳密に守ってきた recall の不変条件群に
   新しい一般化（N者の「隣接」の定義）を持ち込むことになる。**この判断を、明示的な
   確認無しにこの担い手だけで下すのは、影響範囲に対して分不相応だと判断した。
2. **(a) を選ぶ場合は ADR 0292 の決定をそのまま実装すればよいが、ADR 0292 自体がまだ
   「状態: 提案」であり「採用」されていない。**この PR の中で提案中の別 ADR を無断で
   採用に格上げする形で実装を進めるのは、ADR の意思決定の順序を飛ばすことになる。
3. コーディネータの依頼文言（`DEFAULT_RECALL_ASSOCIATION.maxCount` を流用、「段3」という
   呼び方）は (b) 寄りに読めるが、`maxCount` を新しい必須フィールドにする設計（ADR 0292
   決定2-b）と食い違う——**言葉だけでは一意に決まらない。**

このため、recall 段3への group 対応は**この PR には含めず**、上の食い違いをマネージャーへの
報告に明記し、(a)/(b) のどちらを実装すべきかの判断を仰ぐ。`docs/recall.md`・
`docs/architecture.md` の recall 関連の節も、この理由でこの PR では変更していない
（変更したのは `RuntimeDeps.relationStore?`・`Runtime.markContestedGroup?`/
`resolveContestedGroup?` の追加箇所だけ）。

---

## 6. 採らなかった案

- **`resolveContestedGroup?` の `winnerId` の大文字小文字救済を2者版と同じ形で実装する**:
  見送った（§3）。複数候補が同時にヒットする場合の振る舞いを新しく決める必要があり、
  この PR の範囲（fix1・fix2・Runtime層・検出層）を超えると判断した。
- **`formContestedGroups` の既定を `true` にする**: 見送った（§4.1）。「PR1 の歯を
  書き換えない」という制約と両立しない。
- **recall 段3への group 対応を、ADR 0292 の設計のどちらかに賭けて実装する**: 見送った
  （§5）。影響範囲（recall の不変条件）と ADR の意思決定順序の両方の理由で、確認を待つ
  ほうが安全だと判断した。

---

## 7. 引き受けた負債

1. **`resolveContestedGroup?` の部分解消チェック（fix2）は、`relationStore` の配線有無で
   `ineligible`/`conflict` のどちらに分類されるかが変わる。**動作としては両方とも
   「何も書かれない」で安全だが、呼び出し側が結果を見て分岐する場合、`relationStore` の
   配線状況に依存した分岐が必要になる。ドキュメント（interface JSDoc）には明記したが、
   型で強制してはいない。
2. **recall 段3への group 対応が未実装のままである**（§5）。今日の実装では、3件以上の
   `contested` 群が `recall()` に出ても、`contradiction_resolution`（段3）はその群の
   メンバーを同伴として引き寄せない——`contestedWithId` が `null` の群メンバーは、
   `fetchMandatoryCompanions` の対象にならない（`recall-runtime.ts` の実装は本 PR で
   一切変更していない）。呼び出し側が個別に `recall()` の結果を見て、`status === 'contested'`
   かつ `contestedWithId === null` の Memory を見つけたら、`RelationStore.listRelated`
   を自分で呼んで群の他のメンバーを補う、という回避策は可能だが、`docs/memory-model.md`
   §5 機構3が要求する「必ず隣接」は今日満たされていない。
3. **`resolveContestedGroup?` の `winnerId` の大文字小文字救済が無い**（§6）。

---

## 8. 確かめたこと・確かめていないこと

**確かめたこと（実測）**:
- fix1: Postgres で、`validUntil`/`validFrom` がちょうど1マイクロ秒だけ違う組が正しく
  重なると判定され、ちょうど一致する組（重ならない）には行が張られないこと
  （`mark-contested-group-microsecond-boundary.postgres.test.ts`）。
- fix2: Postgres・InMemory の両方で、群の一部だけを渡す `resolveContestedGroup` が
  `MemoryStatusConflictError` になり、何も書かれないこと（`memory-store-conformance.ts`）。
- Runtime 層: `Runtime.markContestedGroup?`/`resolveContestedGroup?` の ineligible 分類・
  CAS・TOCTOU・`relationStore` 有無での挙動差（`mark-contested-group.test.ts`・
  `resolve-contested-group.test.ts`）。
- 検出層: `formContestedGroups` の既定 `false` が PR1 の挙動を変えないこと
  （PR1 の全6ファイルを再実行し、1文字も変更せず緑のまま通ることを確認）。穴Aの吸収・
  合併（2つの既存群の統合）・relationStore 無しでのフォールバックが期待通り動くこと
  （`claim-key-contested-group-detection.test.ts`）。

**確かめていないこと**:
- recall 段3への group 対応の実装そのもの（§5、意図的に未実装）。
- `@mnemora/openai`/`@mnemora/anthropic`/`@mnemora/bullmq` など、`packages/core`/
  `packages/postgres`/`packages/testkit` 以外のパッケージへの影響（この PR はこれらを
  変更していないため、影響は無いはずだが、実際に動かしては確認していない）。
- 大規模な `memory_relations` グラフ（数百〜数千件規模）での `markContestedGroup`/
  `resolveContestedGroup`/`detectClaimKeyContested` の合併ロジックの性能。
