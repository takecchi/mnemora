# ADR 0378: claim key の自動 contested 検出は、3件目以降も一致に数える —— `findContestedByClaimKey?`（PR1）と、多者間 `contested` を表へ束ねる書き込み経路の全体設計（PR2、Issue #933・#207・ADR 0327 の続き）

- **状態**: 採用 (2026-09-30)
- **日付**: 2026-09-30

> **⚠ これはオーナー側のクローンが決定した設計であり、本 PR（PR1）の実装者はその実装を
> 委譲された側である。**決定1〜7はマネージャー経由でオーナー側のクローンから渡された
> 確定済みの設計であり、本 ADR の書き手（PR1 の担い手）が新たに選んだものではない
> （ADR 0220 と同じ、伝聞の1段）。**PR1 の実装範囲の選択・歯の形・ドキュメントの書き方は
> 担い手の判断である。**

**⚠ 日付について**: マネージャー指示は本 ADR・追記の日付を「2026-09-29」に揃えるよう
求めていたが、実際にこの ADR を書いた時点の日付は 2026-09-30 だった（作業開始後に
日付が繰り上がった）。**この repo の「実測」の規律（当時の日付をそのまま書く）を優先し、
2026-09-30 のまま書いている。**マネージャーへの報告にこの食い違いを明記する。

---

## 出所の凡例

- **【伝】** — マネージャー経由でオーナー側のクローンから渡された、確定済みの前提。
  この ADR の書き手は検証していない。
- **【現物】** — この repo のコード・文書を、この ADR の書き手が自分で読んで確かめた。
- **【実測】** — この手元の器で実際にコマンドを走らせて得た。

---

## 文脈

[Issue #933](https://github.com/takecchi/mnemora/issues/933): claim key の自動 contested
検出（[ADR 0324](./0324-claim-key-contested-detection.md)）は、同じ claim key の主張が
1件ずつ時間を置いて届くという最も自然な運用シーケンスで、3件目以降の主張が対向として
一度も検出されず、`memory_events` にも痕跡が残らない。原因は
`MemoryStore.findActiveByClaimKey?` が `status = 'active'` の行しか見ないため——
1件目・2件目が対になって `contested` になった時点で、その2件は「一致」の候補から
構造的に消える。

これは [Issue #207](https://github.com/takecchi/mnemora/issues/207)（`memory_relations`、
多対多の関係グラフ）・[ADR 0327](./0327-relation-graph-contested-write-path-design.md)
（関係グラフ本体の設計、状態: 提案）が答えようとしている「多者間の `contested` をどう扱うか」
という、より大きな未決の一部でもある——ADR 0327 §9-6 はこの判断を3点、オーナー確認待ちの
まま残していた。

**本 ADR は、その3点を含む全体設計を決定として記録し（【伝】）、そのうち PR1 で実際に
実装する範囲（Issue #933 の直し方そのもの）を明記する。** PR2 の範囲（`RelationStore`・
migration・`markContestedGroup`/`resolveContestedGroup`・recall 段3の拡張・穴Aの解消）は、
**設計は決定済みだが本 PR では実装しない**——次段の担い手が実装する。

---

## 全体設計（決定1〜7。【伝】——オーナー側のクローンが決定した）

### 決定1: 既存の単数列 `contestedWithId` からの移行の形は (ii)

ADR 0327 §3 が挙げた3案のうち **(ii) 別口新設**を採る。2者間の `contested` は今まで通り
`Memory.status`/`Memory.contestedWithId`（1対1の列）のまま——`markContested`/
`resolveContested`（ADR 0134/ADR 0150）の契約は一切変えない。3者以上のときだけ、
新しい `memory_relations` 表（ADR 0292 決定1-a、`kind: 'contradicts'`）を使う。

**backfill は不要**——2者間の既存データは今日のまま列に残り続け、表は多者間ケースの
新規発生分だけを持つ（ADR 0327 §3.1「(ii) 別口新設」の評価どおり）。

### 決定2: 3件以上は完全グラフ

`memory_relations` へ多者間グループを書くとき、**N件のグループ全員の間に `contradicts`
エッジを張る**（双方向、`N×(N-1)` 行。ADR 0327 §5「比較する3案」の (a) pairwise 完全グラフ）。
星形（(b)）・衝突集合／ハイパーエッジ（(c)）は採らない——完全グラフは「誰と誰が争って
いるか」を表の読み出しだけで機械的に確認できる（北極星 問い3、説明可能性）のに対し、
星形は「新しく検出された1件」を特別扱いする理由が無く（ADR 0324 決定5が既に「なぜこの
2件だけが対になったか」を説明できない選択として却下した論法の再帰）、衝突集合は新しい
テーブル・新しい読み出し経路を要求する。

行数の増加（N が大きいとき `N×(N-1)` は無視できない）は、real-fixture で N≥3 が一度も
観測されていない（ADR 0324 負債5、ADR 0327 §11）ため、今のところ実害としては顕在化して
いない——**この判断は「real-fixture で N≥3 が実際に観測され、行数増加が問題になったら
見直す」という条件付きである**（ADR 0327 §10「これが覆るとしたら」を継承する）。

### 決定3: N者の解消は2者の意味を広げる

`resolveContested`（ADR 0150）が2者間に持つ意味を、N者へそのまま広げる。今日の
`ContestedResolution`（`packages/core/src/runtime.ts`）:

```ts
export type ContestedResolution =
  { kind: "supersede"; winnerId: MemoryId } | { kind: "both_active" };
```

の2種類の決着を、N者版（仮称 `resolveContestedGroup`）でもそのまま使う:

- **`{ kind: "supersede", winnerId }`** — 勝者1件を選ぶ。勝者は `active` のまま、
  残り N-1 件は全員 `superseded`（`supersededById: winnerId`）になる。
- **`{ kind: "both_active" }`**（N者では「全員 active」の意味に広がる） — 誰も
  間違っていなかった（対向ではなかったと分かった）。グループ全員が `active` に戻る。

**新しい決着の種類は増やさない**——2者版と同じ2値のまま、対象が2件から N件に広がるだけ。
「N件のうち、どれとどれが本当に対だったか」を機械的に細分する経路は用意しない（ADR 0324
決定5・ADR 0327 §4-c と同じ理由——機械的に選ぶ根拠が無い）。

### 決定4: 穴A — 対に3件目が来たら表へ移す。3件から2件に戻っても表のまま

ADR 0327 が示した「多者間ケースをどう検出し、いつ表へ書くか」の具体的な遷移:

1. 2者の対（A・B、列 `contestedWithId` で表現）に、3件目 C が claim key の衝突として
   検出されたら、**A・B の `contestedWithId` を `null` に戻し、3件（A・B・C）全員を
   `memory_relations` へ完全グラフとして移す**。この「列を空にする」「表へ書く」
   「3件全員を `contested` のまま保つ」は**1トランザクション**で行う——A・B の CAS
   （`markContested` と同じ「開く前に落とす」規律）も同じトランザクションに含む。
2. いったん表に移ったグループから、解消（決定3）でメンバーが減り2件になっても、
   **表のまま残す**——2件に戻ったからといって自動的に列（`contestedWithId`）へ戻す
   処理は行わない。理由: 「表から列へ戻す」変換は「いつ戻すか」の追加判断
   （TOCTOU・同時に別の3件目が来る可能性）を要求し、決定1（(ii) 別口新設）が意図的に
   避けた「2つの情報源の同期」問題を穴Aの解消時に持ち込んでしまう。表のまま残すことの
   コストは、2件だけの関係が表引きになる（列より1段遠い）ことだけであり、実害は小さい
   と判断する（【伝】）。

### 決定5: 穴B — `RelationStore` 未配線の store は、状態を動かさず evidence だけ積む（PR1 の範囲）

`RelationStore` が配線されていない store（0292 決定1-c の「任意配線」がそのまま許容する
状態）では、決定1〜4 の書き込み経路は実行できない。この場合の振る舞い:

**一致（`active` + `contested`）が2件以上になったら、`markContested` を呼ばず、状態を
一切動かさずに `memory_events` へ `claim_key_conflict_unresolved` の evidence だけを
積む**——ADR 0324 決定6 が定めた経路そのもの。**本 PR（PR1）が実装するのはこの部分と、
その前提となる「3件目以降も一致に数える」（決定7）だけである。**

### 決定6: recall 段3の対向必須同伴取得に上限を1つ置く

ADR 0327 §4-d が指摘した「多者間の契約 companion（段3の必須取得）が `maxCount` を超えて
切り捨てられる場合の扱い」——**上限を1つ置く**。値は、既存の fanout 上限
（`DEFAULT_RECALL_ASSOCIATION.maxCount`、`packages/core/src/recall.ts:2238`)【現物】)
と揃え、**10** とする。

```ts
export const DEFAULT_RECALL_ASSOCIATION: RecallAssociationQuery = {
  maxCount: 10,
};
```

`examples/chat/src/mnemora-path.ts` の `DEFAULT_MNEMORA_PATH_ASSOCIATION` も独立に同じ
値 `{ maxCount: 10 }` を持つ（ADR 0168、`DEFAULT_RECALL_ASSOCIATION` の doc コメントが
「どちらかを直したら他方も直すか検討すること」と既に注記している）——同じ理由で、多者間
`contested` の対向同伴取得も同じ値に揃える。

**理由**:

1. **上限なしは、北極星 問い1（毎回渡す量を減らす）を、N が大きいときに破る。**多者間の
   `contested` グループが大きいほど、段3が「必ず連れてくる」対向の件数が際限なく増える
   ——1件の争われている記憶を出すために、争っている相手を無制限に道連れにする設計は、
   「その分だけ想起が良くなる」と言えない限り採れない（`docs/autonomy.md` §1.2 の3問、
   ADR 0292 §7 決定2-a・2-b と同じ判断軸）。
2. **実データでは3件以上が0件（ADR 0324 負債5・ADR 0327 §11）** なので、この上限に
   実際に当たる場面は今のところ無く、**上限を置くことで失うものは小さい**——上限に
   当たるほど巨大な多者間グループが実際に現れたときに初めて、値を見直す材料が生まれる
   （ADR 0327 §10「これが覆るとしたら」と同じ条件付き判断）。
3. **切り捨てが発生したら、recall の `explain` に「切った件数」を出す**（ADR 0327 §4-d
   が指摘した「契約 companion（0292 §3 決定2-c、必ず出す）」と「fanout 上限（切り捨てを
   許す）」の衝突への答え）——**必ず出す不変条件は N ≤ 上限の範囲でのみ保たれ、
   上限を超えた分は `Omission`（`over_limit`、`stage: "relation"` または新しい
   `stage: "contested_group"`。具体的な形は PR2 で確定する）として明示的に切り捨てる**。
   0292 決定3-b の `stage_skipped` とは異なる形（`stage_skipped` は「明示的に要求したが
   `RelationStore` が無い」用、こちらは「`RelationStore` はあるが件数が多すぎて切った」用）
   になる見込み。

### 決定7: #933 の直し方は案2（本 PR、PR1 の範囲）

任意メソッド `findContestedByClaimKey?` を `MemoryStore` に足す（`findActiveByClaimKey?`
の契約は変えない）。詳細は下の「PR1: 実装した内容」を見ること。

---

## PR1: 実装した内容（本 PR の範囲）

**実装したのは決定5と決定7だけである。** `RelationStore`・migration の表・
`markContestedGroup`/`resolveContestedGroup`・recall 段3の拡張・穴Aの解消は
**PR2 に残す**（下の「PR2 に残したこと」）。PR1 の時点では `RelationStore` がまだ
存在しないため、「active と contested を合わせて一致が2件以上 → `markContested` を
呼ばず、状態を動かさず evidence（`claim_key_conflict_unresolved`）を積む」が、
**opt-in の全経路の振る舞いになる**（`RelationStore` が無い、というより、まだこの
repo のどこにも `RelationStore` という interface 自体が無い——決定5の「配線されて
いない場合」は PR1 の時点で唯一の場合分けである）。

### 決定7-a: `MemoryStore.findContestedByClaimKey?` の契約

`packages/core/src/interfaces/memory-store.ts` に、`findActiveByClaimKey?` と**同じ
絞り込み**を `status = 'active'` の代わりに `status = 'contested'` へ適用する読み取り
専用の任意メソッドを足した:

```ts
findContestedByClaimKey?(
  ctx: Ctx,
  query: {
    subjectId: string | null;
    claimKey: ClaimKey;
    excludeMemoryId: MemoryId;
    contentHash: string;
    validFrom: Date | null;
    validUntil: Date | null;
  },
): Promise<Memory[]>;
```

- 🔴 **任意メソッドである。**必須にすると `MemoryStore` を実装する第三者の adapter を
  壊す破壊的変更になる（`findActiveByClaimKey?`/`markContestedPair?` と同じ理由）。
- **フォールバック経路は無い。**この口を実装していない adapter に対しては、`Runtime`
  側の検出は今まで通り `findActiveByClaimKey?` の一致（`active` のみ）だけで判定する
  ——**後方互換**。振る舞いは1バイトも変わらない。
- 契約（`subjectId` の NULL 同値扱い・`excludeMemoryId`/`contentHash` の除外・有効期間の
  重なり・順序不定・LLM を呼ばない）は `findActiveByClaimKey?` と完全に同一で、
  `status` のリテラルだけが異なる。

### 決定7-b: `Runtime.detectClaimKeyContested` の変更

`packages/core/src/runtime.ts`。`findActiveByClaimKey`（既存）の一致に加えて、
`findContestedByClaimKey`（新規、実装されていれば）の一致を集める:

```ts
const rawActiveMatches = await findActiveByClaimKey.call(deps.memoryStore, ctx, query);
const findContestedByClaimKey = deps.memoryStore.findContestedByClaimKey;
const rawContestedMatches =
  findContestedByClaimKey === undefined
    ? []
    : await findContestedByClaimKey.call(deps.memoryStore, ctx, query);
const rawMatches = [...rawActiveMatches, ...rawContestedMatches];
```

その後、**[ADR 0377](./0377-claim-key-contested-detection-excludes-same-observation-siblings.md)
の除外（検出中の Memory と同じ `sourceObservationId` を持つ一致を、件数を数える前に
除く）を、この合わせた一致（`active` + `contested`）に対しても同じ形でかける**——
ADR 0377 が active の一致だけに適用していた除外を、Issue #933 の直しによって集合が
広がった後も、同じ規律のまま維持する。この除外を怠ると、ADR 0377 が塞いだはずの
「同じ observation の兄弟を誤って一致に数える」症状が、`findContestedByClaimKey` の
一致経由で再発しうる。

除外後の件数で、今まで通り0/1/2+の3分岐（ADR 0324 決定5）を行う——**分岐そのものは
変えていない。変わるのは「何を一致として数えるか」だけである**（ADR 0377 が「機序」節で
述べた構図と同じ形の変更）。

### 決定7-c: evidence の `matches` に `status` を足す

`claim_key_conflict_unresolved` の evidence（`meta.note`）の `matches` 配列の各要素に、
その一致の `status`（`'active'` | `'contested'`）を足した:

```ts
const describeSide = (m: Memory) => ({
  id: m.id,
  status: m.status,
  contentHash: m.contentHash,
  validFrom: m.validFrom ?? null,
  validUntil: m.validUntil ?? null,
});
```

**判断した点（担い手の判断）**: マネージャー指示は「evidence の `matches` に contested
側の一致も入ること、どれが contested 由来か分かる形にするかは ADR に理由を書いて決めて
よい」としていた。**`status` フィールドを足す形を採った**——理由は北極星 問い3
（説明できるか）。`matches` の各要素がどちらの口（`findActiveByClaimKey?`/
`findContestedByClaimKey?`）から来たかを、監査ログ（`memory_events`）だけから読み取れる
ようにする。別案（`matches` を `activeMatches`/`contestedMatches` の2配列に分ける）も
検討したが、**採らなかった**——`ContestedDetectionOutcome.result.matchMemoryIds`
（`unresolved_conflict` の型）は既に単一の `MemoryId[]` であり、evidence の `matches`
もこれと対称な単一配列の形を保つほうが、既存の読み手（`meta.note` を JSON.parse して
読むコード）が壊れない。`status` を足すのは配列の要素に欄を1つ足すだけで、配列の形
そのものは変えない。

### 実装先

- `packages/core/src/__tests__/runtime-fakes.ts`（`FakeMemoryStore`、core の単体テスト用）
- `packages/testkit/src/__fixtures__/in-memory-memory-store.ts`（`InMemoryMemoryStore`）
- `packages/postgres/src/memory-store.ts`（`PostgresMemoryStore`）

**Postgres 側に新しい migration・新しい索引は不要**——`idx_memories_claim_key`
（`(tenant_id, subject_id, claim_key_subject, claim_key_predicate) WHERE claim_key_subject
IS NOT NULL`、`migrations/0021_memories_claim_key.sql`）は、`status` を索引の条件に
含めない汎用索引として設計されていた（同 migration の doc コメント「`status` を索引に
含めない理由」）——`findContestedByClaimKey` は同じ索引を `status = 'contested'` の
フィルタと組み合わせて使う。【実測】`packages/postgres/src/__tests__/
claim-key-index.postgres.test.ts` に `findContestedByClaimKey` の EXPLAIN を追加し、
`idx_memories_claim_key` が `subject_id` まで Index/Recheck Cond に使われることを
（`active`/`contested` 両方の分布を持つ seed で）確認した。**0件の `contested` 行しか
無いと、プランナが `idx_memories_contested`（`(tenant_id, status) WHERE status =
'contested'`、0004）を選ぶことがある**——本番相当の分布（`contested` 行も一定数ある）
で確認する必要があり、この歯の seed もそのように直した。

### 適合テスト

`packages/testkit/src/memory-store-conformance.ts` に、`findActiveByClaimKey?` の歯
（11本）と対になる `findContestedByClaimKey?` の歯（11本。`active`/`contested` が
入れ替わる形）を足した。`status = 'contested'` へは `updateStatus` で直接遷移できない
（`ContestedWithoutCompanionError`、ADR 0134）ため、各歯は `markContestedPair` で
使い捨ての `partner` と対にして `contested` な行を作る。

新しい任意フラグ `MemoryStoreConformanceOptions.supportsFindContestedByClaimKey?:
boolean` を足した——`supportsFindActiveByClaimKey?` と同じ3状態
（`true`/`false`/省略、省略時は「未検査」の named it を1本登録）。**これは破壊的
変更として数える**（`docs/migration-v1.md` の数え方の規律2「conformance スイートの
判定を厳しくする変更」——`packages/testkit`・`@mnemora/postgres` が
`supportsFindContestedByClaimKey: true` を渡すようになったので、渡していない自前実装は
「未検査」のままだが、`true` を渡して実装していない場合は新しく落ちる）。

---

## PR2 に残したこと（決定済み・未実装）

1. **`RelationStore` interface と `memory_relations` migration**（ADR 0292 決定1-a〜1-c、
   ADR 0327 §9 の1）。
2. **`markContestedGroup`/`resolveContestedGroup`**（決定2・決定3、ADR 0327 §4-b・§4-c）
   ——N件を受け取り、全員を `contested`/`active`/`superseded` へ遷移させ、
   `memory_relations` へ完全グラフを書く新しい `Runtime` 操作。
3. **穴Aの解消**（決定4）——既存の対に3件目が来たら、列を空にして表へ移す1トランザクション。
4. **recall 段3の分岐拡張**（決定6、ADR 0327 §4-d）——`contestedWithId` が無い
   `contested` Memory に対して `RelationStore.listRelated` を呼び、上限10件（決定6）
   まで対向を連れてくる。切り捨て時の `explain`/`Omission` の具体的な形。
5. **`ContestedDetectionOutcome.result` への新しい variant**（ADR 0327 §4-e、仮称
   `contested_group`）——`RelationStore` が配線されていて、実際に決定2の書き込みを
   行った場合の結果を表す。**PR1 では `unresolved_conflict` のまま**（`RelationStore`
   が無いので、決定5の経路しか到達しない）。
6. **`RelationStore.link` を N×(N-1) 回呼ぶ場合のトランザクション境界**（ADR 0327 §11
   「確かめていないこと」）。

---

## 北極星の問いに当てた結果（PR1 の範囲）

### 問1: 毎回渡す量を減らす方向に働くか

**PR1 単体では変わらない。**検出が呼ばれる回数・recall が渡す量のどちらも、PR1 では
増減しない——`findContestedByClaimKey?` は検出（書き込みの延長）の中でだけ呼ばれ、
recall 側には一切触れていない（決定6・PR2 の範囲）。

### 問2: これを無効にしたとき、Memory Framework として成立するか

**成立する。**`detectContested` を渡さない・`false` の呼び出しは、
`findActiveByClaimKey`・`findContestedByClaimKey` のどちらも一度も呼ばれない
（`packages/core/src/__tests__/claim-key-find-contested-by-claim-key-opt-in.test.ts`
で実測）。`findContestedByClaimKey?` を実装していない adapter でも、今まで通りの
振る舞い（後方互換）のまま動く。

### 問3: この記憶が選ばれた理由を、後から説明できるか

**できる。**evidence の `matches` に `status` を足したことで、`unresolved_conflict`
に分岐した一致のどれが「まだ `active` だった」相手で、どれが「既に `contested` に
なっていた」相手かを、`memory_events` から読み取れる（決定7-c）。

### 問4: AI の推論と、ユーザーが言った事実を、区別しているか

**区別している。**PR1 は `superseded` への言及を一切増やしていない——2件以上の分岐は
今まで通り `markContested` すら呼ばない。

### 問5: これは、LLM を呼ばずに済ませられないか

**済ませられる。**`findContestedByClaimKey?` も列の等値比較・範囲比較・索引アクセス
だけで完結する（LLM を1箇所も呼ばない）。

---

## 引き受けた負債

- **決定4（穴A）・決定6（recall 段3拡張）は未実装のまま残る。**PR1 だけでは、3件目以降が
  「evidence が積まれる」ところまでしか直らない——3件以上のグループが実際に `contested`
  として recall に載る（対向を必ず連れてくる）ようにはならない。ADR 0324 決定6 が既に
  引き受けていた負債（3件以上は `markContested` を呼ばない）が、PR1 の後も形を変えて
  残り続ける。
- **決定2（完全グラフ）の行数増加は、real-fixture で一度も検証されていない**（ADR 0324
  負債5・ADR 0327 §11 の継承）。
- **PR1 の `findContestedByClaimKey?` の一致が、`markContested` の「ちょうど1件」分岐
  （決定5・ADR 0324 決定7）に紛れ込む edge case を作る**——ADR 0377 の兄弟除外の結果、
  合わせた一致がちょうど1件になり、かつその1件が既に `contested`（別のペアの相手）
  だった場合、`markContested` を呼ぶが CAS が `ineligible` を返す（相手が `active` で
  ない）。これは ADR 0324 決定7 が既に引き受けている「TOCTOU で相手が active でなくなる」
  負債と同じ形として扱う——追加の救済はしない。

---

## これが覆るとしたら

- ADR 0327 §10 の条件（決定1が (i)/(iii) に変わったとき、`RelationStore` が必須になった
  とき、real-fixture で N≥3 が観測されたとき）がそのまま本 ADR にも及ぶ。
- 決定6 の上限値（10）は、`DEFAULT_RECALL_ASSOCIATION.maxCount` と意図的に揃えている
  ——後者が変わったら、前者も見直すか検討すること（`DEFAULT_RECALL_ASSOCIATION` の
  doc コメントと同じ注記）。

## 確かめていないこと

- 実 API（gpt-4o-mini 等）での確認——本 PR の歯は core の Fake・testkit の InMemory・
  本物の Postgres（deterministic embedding）だけで取った。
- PR2 の範囲（`RelationStore`・`markContestedGroup` 等）は設計のみで、実装はしていない
  ——実装したときに、この設計どおりに素直に実装できるかどうかは確かめていない。
- 決定6 の上限（10）に実際に当たる規模のデータでの実測——real-fixture で N≥3 が
  観測されていないため、実測できる対象が無い。

---

Refs #933 #207
