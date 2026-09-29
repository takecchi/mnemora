# ADR 0368: `consolidate`/`reflect` の統合先・内省の記憶は、材料の有効期間の積を引き継ぐ（Issue #1188 残り）

- **状態**: 採用 (2026-09)
- **日付**: 2026-09-29

> **⚠ この判定は、自動化された担い手（マネージャーのセッションから委譲された、
> クローン miku の委譲先）のものである。**
> **⛔ オーナー本人の決定ではない。**
> **理由**: [ADR 0220](./0220-issue-comment-author-does-not-distinguish-owner-from-agent.md)の
> 同種の注記と同じ——repo 上の署名だけではオーナー本人と区別が付かない。
> **この決定を担い手が自分で下してよい根拠は
> [ADR 0156](./0156-delegate-5-grade-judgment-and-breaking-changes.md)** である。
> 決めたのはマネージャーのクローン miku（依頼主）であり、この ADR はその決定を
> 委譲先が書き下したもの。方向そのものの変更が要るなら、オーナー本人・マネージャーへ
> 問い直すこと。

**⚠ 各主張の出所を分ける**（ADR 0253・0358・0361・0366 の体裁を踏む）。

- **【現物】** — この repo のコードを書き手が読んで確かめた。
- **【実測】** — この書き手が自分の手で走らせて確かめた（`packages/core` は Fake、
  `packages/postgres` は自分専用の PostgreSQL 17 + pgvector）。
- **推測** — 出所を明示していない考察・見立て。

---

## 文脈

[Issue #1188](https://github.com/takecchi/mnemora/issues/1188) が指した2つの穴のうち、
1つ目（「有効期間の外にある記憶を統合元・材料にしてしまう」）は [PR #1383](https://github.com/takecchi/mnemora/pull/1383)
（`consolidate`、[ADR 0089](./0089-runtime-consolidate-shape.md) の 2026-09-29 追記）と
[PR #1388](https://github.com/takecchi/mnemora/pull/1388)（`reflect`、
[ADR 0091](./0091-runtime-reflect-shape.md) の 2026-09-29 追記）で先に直った。

**この ADR は、その後に issue コメントで開き直された「残っているもの」2番を埋める**:

> 2. **将来の `validUntil` の引き継ぎ。**いまは有効で、将来の `validUntil` を持つ記憶を
>    統合すると、統合先はその期限を持たない。期限が来た後も、統合先は `recall()` に
>    出続ける。引き継ぎ方（区間の積・和・最新のどれか）は、ADR 0164「射程外にしたもの」1
>    が別の判断として残したままである。区間の積を付けると、期限の無い側の中身まで期限と
>    ともに落ちる。

【現物】`strategies/consolidate.ts` の `buildConsolidatedMemory`・`strategies/reflect.ts` の
`buildReflectedMemory` は、この PR 以前、`NewMemory` の `validFrom`/`validUntil` を一切
設定していなかった（返り値のオブジェクトに欄そのものが無く、`undefined` のまま store へ渡る
——store 側は `null` として保存する）。統合先・内省の記憶は常に両方 `null`（「いつでも真」）
だった。

**これは [ADR 0164](./0164-valid-from-until-recall.md)「射程外にしたもの」1 が意図的に
残した挙動である**——同 ADR は「複数の元 Memory が異なる区間を持つとき、どう引き継ぐか
（最新を採る／区間の積を採る／和を採る）は別の判断であり、null のままが最も安全（何も
落ちない）」と書いていた。**しかしその「安全」は、期限切れ・未到来の記憶が統合元・材料に
入りうるという前提の下で評価されていた。** その前提は PR #1383/#1388 で崩れた——いまは
`consolidate()`/`reflect()` に渡す時点で期間の内側にある記憶しか統合元・材料にならない。
それでも統合先・内省の記憶が「いつでも真」のままだと、**別の害**が残る: 材料のうち1つが
統合・反芻の**後**に期限切れになっても、その材料の主張を含む統合先・内省の記憶は、
期限の無い `active` な記憶として永久に `recall()` に出続ける。

---

## 決定1: 統合先・内省の記憶は、材料の有効期間の**積**を持つ

`validFrom` は材料（`eligible`）の `validFrom` の**最大値**、`validUntil` は材料の
`validUntil` の**最小値**。`null` は「その端に制限が無い」——両方 `null` の材料は積の
どちらの端も動かさない。**材料が全件、両方 `null` なら、結果も両方 `null`**（ADR 0164
以前からの振る舞いを変えない）。

**なぜ積か（和・最新ではなく）**: 統合・内省した本文は、材料**すべて**の主張を含む——
だから統合先・内省の記憶が「まだ真」と言えるのは、材料**全員**がまだ真である間だけである。
どれか1つの元の記憶の期限が切れた時点で、統合先・内省の記憶の本文の一部（その元の記憶に
由来する主張）はもう真ではなくなる。和・最新を採らなかった理由は「採らなかった案」を見ること。

**実装**: `packages/core/src/strategies/consolidate.ts` に `intersectValidity` を、
`intersectAttributes`（ADR 0312 決定4、同じ形の積の純関数）の隣に足した。`buildConsolidatedMemory`
（同ファイル）と `buildReflectedMemory`（`reflect.ts`）の両方が、この関数を呼んで
`validFrom`/`validUntil` を組み立てる——`intersectAttributes` を2経路が共有しているのと
同じ理由（「複数の既存 Memory から新しい Memory を組み立てる」という同じ形の操作であり、
同じ判定を2箇所で複製しない）。

**公開 API への影響**: `intersectAttributes`・`buildConsolidatedMemory`（`BuildConsolidatedMemoryParams`
を含む）・`buildReflectedMemory`（`BuildReflectedMemoryParams` を含む）は、いずれも
`packages/core/src/index.ts` の `export * from "./strategies/consolidate.js"`/`"./strategies/reflect.js"`
経由で `@mnemora/core` の公開 API に出ている（`pnpm run api:check` の snapshot、
`scripts/__snapshots__/public-api/core.d.ts` に既に載っている）。**この PR はどちらの
シグネチャも変えていない**——`BuildConsolidatedMemoryParams`/`BuildReflectedMemoryParams` の
欄・`buildConsolidatedMemory`/`buildReflectedMemory` の引数と返り値の型（`NewMemory`。
`validFrom`/`validUntil` は ADR 0145 以来、省略可能な欄として既に公開されている）は1バイトも
変わらない。**公開 API の差分は `intersectValidity` という新しい関数の追加だけ**であり、
既存の公開の型の削除・必須化・狭小化は無い（`api:check` の差分は追加のみであることを
【実測】確認した）。破壊的変更かどうかの判断は CHANGELOG の `[1.1.0]` 節の本項目を見ること
——ここには複製しない。

**空の積（`validFrom >= validUntil` になる組み合わせ）は起こらない。** `eligible` は
呼び出し側（`runtime.ts` の consolidate 手順2・reflect 手順2）が
`classifyValidity(m, validAt)`（`validity.ts`、PR #1383/#1388 が切り出した述語）を通して
選んだものだけであり、この述語を通る記憶は `max(validFrom) <= validAt < min(validUntil)`
を満たす（逆転した区間・期限切れ・未到来は弾かれる）。⟹ `intersectValidity` が返す区間の
`validFrom` と `validUntil` が両方非 `null` なら、必ず `validFrom < validUntil` になる。

---

## 決定2: 窓（受け入れる）—— 材料を選ぶ時刻と記録する時刻の間に期限が来ることがある

`consolidate()`/`reflect()` は、材料を選ぶ時刻（`classifyValidity` に渡す `validAt`、
`runtime.ts` の `clock.now()`）と、新しい記憶を作る時刻（`recordedAt` にする `now`、同じく
`clock.now()`）を**別の呼び出し**として持つ（consolidate: 6283行目と6421行目、reflect:
6689行目と6833行目 ※行番号は 2026-09-29 時点の `runtime.ts`）。この2回の呼び出しの間に、
LLM 呼び出し（`completeStructured`）が挟まる。

もし LLM 呼び出しの最中に `min(validUntil)`（材料の積の右端）を過ぎると、新しい統合先・
内省の記憶は**作った時点で既に期限切れの `active` な記憶**として書かれる——書き込み自体は
失敗しない。`recall()` の期間のゲート（ADR 0164 決定1）は `validUntil <= validAt` で弾くので、
この記憶は直後の `recall()` には出てこない。

**この窓を「正しい状態」として受け入れる。** 埋めない理由:

- LLM 呼び出しの所要時間は制御できない（provider・ネットワーク・モデルの負荷に依存する）。
  `validAt` を書き込み時点まで遅延評価する、あるいは `now` を `validAt` に揃える、といった
  対処は、この関数（`intersectValidity`・`buildConsolidatedMemory`・`buildReflectedMemory`）
  の外——`runtime.ts` の手順そのものの再設計になり、この Issue の射程を超える。
- 窓が開いても、結果は「期限切れの記憶が recall に出ない」という**正しい**性質を保ったまま
  である。積を持たない旧実装（期限の無い統合先）よりも、この窓の結果のほうが安全側に倒れて
  いる——最悪でも「作った直後から見えない記憶」であり、「間違って見え続ける記憶」ではない。

**陽性対照（`AGENTS.md`「『出なかった』を、事象が無いことの証明にしない」の適用）**:
この窓は、時計を固定した既存のテスト（`consolidate-validity-gate.test.ts`・
`reflect-validity-gate.test.ts`・このファイルの上の runtime テスト）では**再現しない**
——材料を選ぶ時刻と記録する時刻が同じ固定値になるため。窓を実際に確かめるには、時計を
LLM 呼び出しの間に進める歯が要る。`packages/core/src/__tests__/consolidate-reflect-validity-intersection.test.ts`
の「窓」describe が、`completeStructured` の中で時計を進める `Clock` 実装を使ってこれを行い、
「記憶は作られる（`validUntil <= recordedAt`）」「`recall()` には出ない」の両方を縛る
（consolidate・reflect 両方に歯がある——コストが軽く、両方に同じ穴がある形なので）。

---

## 決定3: 代償（受け入れる。`consolidate` 側だけ）

期限の無い記憶 F と、将来の期限を持つ記憶 E を一緒に `consolidate()` すると、統合先は
E の期限を引き継ぎ、F は（他の統合元と同じく）`superseded` になる——**期限後は F 由来の
内容も `recall()` に出なくなる**（F 自身の行は superseded として残り、消えはしない。
`Runtime.consolidate` は行を物理削除しない）。

これは ADR 0164「射程外にしたもの」1 が積を退けた理由そのもの（「期限の無い側の中身まで
期限とともに落ちる」）であり、**この ADR はその代償を引き受けると決めた。** 理由:

- **何もしない場合の害のほうが大きい。** 「期限切れの主張が、期限の無い記憶として永久に
  `recall()` に戻り続ける」は、利用者から見て**静かに間違い続ける**——`recall()` はゲートを
  正しく適用しているつもりなのに、統合先という別の記憶が同じ主張を無期限に運び続ける。
  一方この代償は、F が単独で保持していた「期限の無い」という性質を失うだけであり、F の
  **内容自体**は、E と一緒に統合された時点で「E の期限内でだけ真」という統合先の主張の
  一部になっている——F だけを取り出して見れば、F は superseded のまま元の内容を保持して
  いる（行は消えない）ので、監査・復元の経路は保たれる。
- **`consolidate()` を呼ぶ側は、この代償を `dryRun` で事前に見られる。** `sources` は
  今までどおり、どの記憶が統合元になるか（`eligible`）を返す——期限の異なる記憶を
  一緒に統合するかどうかは、呼び手が `dryRun: true` で見てから選べる。

**`reflect()` にはこの代償が無い。** `reflect()` は材料を `superseded` にしない
（`buildReflectedMemory` の doc コメント、決定4 の「内省は『足す』操作」）——材料 E・F は
どちらも `active` のまま残る。内省の記憶（新しい行）だけが積の期限を持ち、材料自身の
`recall()` での見え方は変わらない。

---

## 採らなかった案

### 和（`validFrom` の最小値、`validUntil` の最大値）

**却下**。統合先の本文は材料すべての主張を含むので、和を採ると「1つの材料の期限が切れても、
別の材料の期限まで統合先は `active` のまま残る」——本文の一部が既に偽になっていても、
`recall()` のゲートを通り抜けてしまう。決定1が並べた「なぜ積か」の裏返しであり、この Issue
が塞ごうとしている穴（期限切れの主張が期限の無い記憶として戻る）を、形を変えて残す。

### 最新（最後に作られた材料の区間をそのまま使う）

**却下**。「最新」の基準（`recordedAt`・`occurredAt`・入力順のどれを最新とするか）が
恣意的であり、選ばれなかった側の材料の期限を無視することになる——積のように「材料全員が
まだ真である間だけ真」という単純な不変条件を持たない。

### 期限の違う記憶どうしを統合するかを呼び手が選べるようにする案（今後の論点）

`ConsolidateTarget`/`ReflectTarget` に opt-in の欄を足し、「材料の有効期間が食い違う
（片方だけ期限を持つ、期限の重なりが狭い、など）ときは統合しない」を選べるようにする案は
検討したが、この PR の射程には含めない——**「食い違う」をどう定義するか**（期限の重なりの
広さに閾値を置くか、片方だけ無期限のケースを特別扱いするか）自体が新しい設計判断であり、
Issue #1188 が求めていた「積を持たせる」以上のスコープになる。将来、決定3の代償が実際の
運用で問題になった場合に、別の Issue として検討すること。

---

## 引き受けた負債

1. **決定3の代償**（期限の無い記憶が、期限のある記憶と一緒に統合されると、期限とともに
   `recall()` から落ちる）は、上に書いたとおり引き受けた。`consolidate()` の呼び手が
   `dryRun` で事前に見られる以上の安全弁は用意していない。
2. **決定2の窓**は塞いでいない。`validAt` と `recordedAt` を同じ `clock.now()` 呼び出しに
   揃える（例: 手順2で読んだ `validAt` を手順6の `now` としても使い回す）案は検討したが、
   それは「統合先の `recordedAt`（減衰の起点）が、実際に書き込んだ時刻ではなく材料を選んだ
   時刻になる」という別の意味論の変更を伴うため、この PR では採らなかった。
3. **和・呼び手が選べる案は実装していない**（「採らなかった案」参照）。将来これが覆る条件は
   下の「これが覆るとしたら」を見ること。

## これが覆るとしたら何が起きたときか

- 決定3の代償（期限の無い記憶が消える）が、実際の運用で「統合したら知らないうちに記憶が
  recall から消えた」という形で問題になった場合 ⟹ 「採らなかった案」の opt-in の欄を
  検討する。
- 決定2の窓が、実運用で無視できない頻度・実害（例: LLM 呼び出しが数十秒かかる構成で、
  短い `validUntil` を持つ記憶を頻繁に統合する運用）を持つと分かった場合 ⟹ `validAt` と
  `recordedAt` を揃える設計を、`recordedAt`（減衰の起点）の意味論を含めて見直す。

---

## 歯（実際に噛むことを示す）

- **純関数**（`packages/core/src/__tests__/consolidate.test.ts`・`reflect.test.ts` の
  `buildConsolidatedMemory`/`buildReflectedMemory` describe 内、「validFrom/validUntil は
  eligible 全件の区間の積」）: 両端とも違う値・片端だけ・全 `null`（やりすぎの歯）・材料1件、
  の4ケース。
- **runtime**（`packages/core/src/__tests__/consolidate-reflect-validity-intersection.test.ts`）:
  `{ memoryIds }` で統合先・内省の記憶が積を持つこと（consolidate/reflect 各1本）。
- **窓**（同ファイル、「窓（ADR 0368 決定2）」describe）: 時計を LLM 呼び出しの間に進めて
  窓を意図的に起こし、「記憶は作られる（`validUntil <= recordedAt`）」「`recall()` には
  出ない」の両方を縛る（consolidate・reflect 両方）。
- **Postgres**（`packages/postgres/src/__tests__/consolidate-reflect-carryover.postgres.test.ts`
  の「validFrom/validUntil は eligible の区間の積として Postgres を往復する」）: `Date`
  （timestamptz）として本物の PostgreSQL 17 + pgvector を実際に往復することを確かめた
  【実測 2026-09-29】。

---

## 測ったこと・確かめていないこと（`docs/autonomy.md` §5）

### 測ったこと

- `intersectValidity` の純関数としての値（両端・片端・全 `null`・材料1件）を、
  `packages/core` の vitest で確かめた。
- `runtime.consolidate({ memoryIds })`・`runtime.reflect({ memoryIds })` が、実際に積を
  持つ統合先・内省の記憶を書き込むことを、Fake store で確かめた。
- 決定2の窓（材料選定時刻と記録時刻の間に期限が来る）を、時計を LLM 呼び出しの間に進める
  歯で実際に再現し、時計を固定した他の歯では再現しないことを確かめた。
- `validFrom`/`validUntil` の積が、自分専用の PostgreSQL 17 + pgvector を実際に往復する
  （書いた `Date` と読み戻した `Date` が一致する）ことを確かめた【実測 2026-09-29】。

### 確かめていないこと

- 決定3の代償（期限の無い記憶が消える）が、実運用（大量の記憶・長期間の運用）でどの程度の
  頻度で起きるかは測っていない——このリポジトリの歯は単発のケースだけを確かめている。
- 決定2の窓の実際の発生頻度（LLM 呼び出しの典型的な所要時間と、典型的な `validUntil` の
  近さの分布）は測っていない。
