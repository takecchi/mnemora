# ADR 0492: 穴探し — recall の不変条件 fuzz に、これまで一度も振っていない欄（`timeWeighting`・`digestBandLimit`・`relationMaxCount`・クエリの `tags`・`occurredAt`）を足す（草稿・作業中）

- **状態**: 草稿 (2026-10。作業中。実測の結果で書き換える)
- **日付**: 2026-10-02

クローン miku の委譲先（担い手。マネージャー mgr-0d3098f9 の指示による）が書いた。直す線（約束に実装を戻す・落ちる入力を減らす・文書の直し・前例のある同種の穴は直す。オーナーの領分の6つ〔前例の無い新しい断り・既定値の変更・公開 API を足す・suite に約束を足す・遡ってのデータの書き換え・適用済みの migration の編集〕は材料に回す）は依頼主が決めた。オーナーの判断ではない（[ADR 0220](./0220-issue-comment-author-does-not-distinguish-owner-from-agent.md)）。
出所の区別: 【現物】は読んだコード・文書、【実測】は手元で走らせた結果、【判断】は担い手の判定、【未確認】は確かめていないこと。

## 草稿の要点（器の入れ替えで文脈が失われても引き継げるように、先に書く）

- **今ある fuzz**【現物】:
  - `packages/core/src/__tests__/recall-invariant-fuzz.test.ts` + `recall-invariant-fuzz-harness.ts`: core の Fake、40 シード × 60 操作、不変条件 I1〜I12、決定性（I9）あり。
  - `packages/postgres/src/__tests__/recall-invariant-fuzz.postgres.test.ts`: 同じ harness を実 Postgres で（default 40 + wide 10 シード）、さらに Fake・testkit InMemory との**差分検査**（同じ操作列の recall の結果を突き合わせる。各 40 シード）と陽性対照。
  - `recall-filter-combination-parity.postgres.test.ts`: filter（tags・attributes・labels・subject・期間・validAt・provenance・channels）の乱択の組み合わせ。
  - `write-diff-fuzz.test.ts`・`fake-store-postgres-parity.test.ts` ほか、書き込み系の parity。
- **振っていない欄**: recall の `timeWeighting`・`digestBandLimit`・`relationMaxCount`・`tags`・`attributes`・`labels`/`taxonomyGroups`・`validAt`・`includeFullyDecayed`・`activityCounting` ほか。create の `occurredAt`・`validFrom/Until`・`attributes`。
- **足す欄と理由**【判断】: `timeWeighting`・`digestBandLimit`・`relationMaxCount`・クエリの `tags`（重複を含む。ADR 0474）・create の `occurredAt`。(1) ADR 0481 が実 Postgres のテストが渡していなかった欄として挙げたもの（`digestBandLimit`・`timeWeighting`・`relationMaxCount`）は固定の 17 形で当てただけで、操作列（forget・purge・contested・連想）との組み合わせは未踏。(2) 3 実装（Fake・InMemory・Postgres）の差分検査に載り、`digestBandLimit` の SQL の `LIMIT`・`relationMaxCount` の探索・鮮度の式の食い違いを乱択で拾える。(3) 既存の不変条件 I1〜I12 を変えずに効く欄（ランキング・帯の大きさ・同伴の数であって、スコープを絞らない。I11 の「この検査器の recall は scope を絞らない」前提を壊さない）。
- **足さない欄**: スコープを絞る欄（`validAt`・`labels`・`attributes`・`excludeProvenanceKinds` ほか）は I11 の前提を壊すので別の不変条件が要る。`taxonomyGroups` は 47 巡目（labels）の面。`activityCounting` は活動時計のテナントでしか効かない（harness は壁時計）。
- **形**: 既存の harness に新しい profile `"fields"` を足す。欄の乱数は別の流れから引き、default／wide のシード→操作列の対応は変えない（既存の固定シードの再現性を保つ）。反復は小さく（Fake 20 シード、Postgres 10 シード + 差分 10 シード × 2）、足した分の実行時間を前後で測って書く。
- **線**: 割れ（3 実装の食い違いなど）が見つかったら、約束に実装を戻すのは内側（直す前の赤を先に見せる）。オーナーの領分の 6 つは材料。再現する seed は ADR に書き、固定の歯にもする。

## 実測の結果

（作業中。追記する。）
