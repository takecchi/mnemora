# ADR 0279: required status check の「正本＋突き合わせ」を足す — 宣言は `.github/required-status-checks.json`、判定は三値、CI には繋がない

- **状態**: 提案 (2026-09-23)
- **日付**: 2026-09-23

**⚠ 各主張の出所を分ける**（ADR 0222 / 0253 / 0274 の体裁を踏む）。

- **【現物】** — この repo・姉妹 repo（[alteroid](https://github.com/takecchi/alteroid)、
  読み取り専用で参照した）のコード・文書を読んで確かめた。
- **【実測】** — この作業でコマンドを打って得た。
- **【受】** — 報告として受け取り、この作業では再導出していない。

---

## 🔴 判断したのはクローンであって、オーナー本人ではない

この ADR とそれに基づく実装は、クローンの委譲を受けた担い手が自分で判断して書いた。
**オーナー本人がこの設計を承認したわけではない。** クローンの署名は repo 上では
オーナーと同じアカウント（`takecchi`）になり、投稿者名だけでは区別が付かない
（[ADR 0220](./0220-issue-comment-author-does-not-distinguish-owner-from-agent.md)）。
この決定を担い手が自分で下してよい根拠は [ADR 0156](./0156-delegate-5-grade-judgment-and-breaking-changes.md)
と `docs/autonomy.md` §3（「§5 級の判断は、クローンが北極星に照らして自分で決めてよい」）
である。方向そのものの変更が要るなら、オーナー本人に問い直すこと。

---

## きっかけ — PR #617 / ADR 0274

[ADR 0274](./0274-required-check-context-name-is-frozen-annotate-dont-rename.md)（PR #617）は、
required status check の文脈名 `examples/chat (本物の Postgres + pgvector、擬似
provider)` が**中身と食い違って腐っていた**のを直した。ジョブの実態
（`compare` ステップは `recorded` で走る）が変わっても、branch protection に登録された
文脈名の文字列は誰も見ておらず、誰にも気づかれずに腐っていた。

**腐りが誰にも気づかれなかったのは、担い手の不注意ではなく「層が1枚無かった」からである。**
この repo には、branch protection が required にしている文脈名の集合を「今どうなっているか」
を、いつもの `pnpm run …` の1コマンドで見返す道具が無かった——ADR 0215 の
`ci-green-check.mjs` は required contexts を*読む*が、それは「CI が緑か」の判定に
使うためであり、「読んだ値が repo 側の期待と一致しているか」は問うていない。

⭐ **姉妹 repo の [alteroid](https://github.com/takecchi/alteroid) は、この層を持っている**
（【現物】読み取り専用の clone で確認。1バイトも変更していない）:

- `.github/required-status-checks.json` —— protection の写し。`note` / `observedAt` /
  `observedBy` / `contexts` を持ち、「これは宣言であって設定ではない —— これを書き換えても
  protection は変わらない」と自分で名乗っている。
- `pnpm check:required-status-checks` → `scripts/check-required-status-checks.mjs`
  （+ `-core.mjs`）—— `gh api` で protection を引いて正本と突き合わせる。

⟹ **同じ形を mnemora にも入れる。** ただし alteroid のファイルを機械的にコピーせず、
mnemora の既存の書き方・道具の作法（`-lib.mjs` サフィックス、`match`/`mismatch`/
`undetermined` の3値語彙、`console.log`/`console.error` の使い分け等）に合わせて
書き直した——設計（宣言＋突き合わせという形そのもの）は写したが、コードは写していない。

---

## 🔴 ⚠ この歯が捕まえないもの —— ADR 0274 が直した腐りは、この層では捕まらない

⛔ **本 ADR を「PR #617 の腐りの再発を防いだ」と読まないこと。射程が違う。**

**この歯が守る範囲は、#617 で腐ったものより狭い。**「正本＋突き合わせ」は、**文脈名が
*設定と repo の間で* ズレる**ことは捕まえるが、**名前が *中身との間で* ズレる**ことは
捕まえない。

**【実測 2026-09-23】**ADR 0274 が直した時点でも、required 6本の文脈名は
`gh api repos/takecchi/mnemora/branches/main/protection/required_status_checks` の
`contexts` と**逐語で 6/6 一致していた**（`${{ matrix.serverEncoding }}` を展開した
うえで突き合わせた）。⟹ 🔴 **この歯が在っても、あのとき緑だった。**腐っていたのは
文字列の一致ではなく、`examples/chat (本物の Postgres + pgvector、擬似 provider)` と
いう**名前が名乗っている中身**のほうである（`compare` ステップは `recorded` で走る）。

⭐ **名前と中身のズレを実際に塞いでいるのは、別の形である** ——
`.github/workflows/ci.yml` の `packages/postgres` ジョブは「**宣言した encoding と
実測した `server_encoding` が食い違えば非0**」という**自己検証を job 自身が持っている**
【現物】。⟹ **この形を持つ job は腐らず、持たない job（`example-chat`）の文脈名が
腐った。**差はそこで説明がつく。

⟹ 🔴 **層としては別物であり、両方要る。本 ADR が足したのは前者だけである。**
**後者（required の各 job が、自分の名乗りを自分で検証する形）は、この ADR では
足していない。**⛔ 足すかどうかは決めていない。

---

## 決めたこと

### 決定1. `.github/required-status-checks.json` を正本（宣言）として置く

**キー名・ファイル名は alteroid と同じにした**（変える理由が無かった——
`.github/` 配下に置く必然性、`required-status-checks.json` という名前の分かりやすさは
どちらの repo でも同じであり、変えると alteroid の設計を読みに行った担い手が
無駄に読み替える必要が生じる）。**`note` に「これは宣言であって設定ではない」を
明記し、`observedAt`（ISO8601 UTC）を持つ**——いつ時点の写しかが分からないと、
正本そのものが腐る。

**【実測 2026-09-23T02:37:33Z】** `gh api
repos/takecchi/mnemora/branches/main/protection/required_status_checks -q
'.contexts[]'` を自分の手で引き直し、その値をそのまま宣言に入れた（依頼文に
渡された6件と一致することを確認したが、**依頼文の値をそのまま転記せず、
自分で引き直した値を使った**——渡された値には時刻が無く、時刻無しで転記すると
「いつの写しか分からない正本」という、この ADR 自身が指摘する不備を最初から
抱え込むことになるため）。

### 決定2. 判定ロジックは `scripts/check-required-status-checks-lib.mjs` に置く純関数、CLI は `scripts/check-required-status-checks.mjs`

**ファイル名は `-core.mjs` ではなく `-lib.mjs` にした**（alteroid とは変えた）。
**理由**: mnemora の既存の「CLI と純粋ロジックを分ける」ペアは、確認した範囲では
すべて `-lib.mjs` サフィックスである（`ci-green-check-lib.mjs` /
`check-local-embedding-fingerprint-lib.mjs` / `compare-summary-lib.mjs` /
`check-pr-adr-reference-lib.mjs` 等）。**alteroid の `-core.mjs` という命名は
alteroid 側の作法**（`check-web-css-comment-classnames-core.mjs` 等、複数の前例が
在ることを alteroid のコード上のコメントで確認した）であり、mnemora に来た時点で
mnemora の作法に合わせるべきだと判断した。

### 決定3. 三値で答える。終了コードは `check-local-embedding-fingerprint.mjs`（ADR 0253）と同じ形に揃える

**一致＝ `match`（exit 0）/ 不一致＝ `mismatch`（exit 1、赤）/ protection を
読めない＝ `undetermined`（exit 2、保留）。** さらに CLI 自身のバグ・不明な引数は
exit 3（`ci-green-check.mjs` / `check-local-embedding-fingerprint.mjs` と同じ実行時
エラーの扱い）。

**先例を確認したうえで揃えた**（依頼どおり、先に読んでから決めた）:

- `scripts/check-local-embedding-fingerprint.mjs` と ADR 0253 —— 判定表を持つ門の
  形、「保留に倒してよいのはこの repo が直せない外部要因だけ」という線引きの考え方。
- ADR 0222（`compare-summary-lib.mjs`）—— `verdict` を lib が返し、CLI が
  0/1/2 へ写す分担。「判定してよいのは、両方の集合が揃っているときだけ」という
  考え方（この ADR の決定4 が引き継ぐ）。
- `ci-green-check-lib.mjs`（ADR 0215）—— `status: "pending" | "red" | "green"` の
  語彙と、「下限が引けなかったときは緑にせず pending で止める。引けなかったから
  従来どおりに倒さない」という規律。

⚠ **`undetermined` を `match` に丸めないこと。** 読めなかった回を「一致した」の顔で
握りつぶすと、ADR 0274 が直した腐り（required check の文脈名が中身と食い違ったまま
誰にも気づかれない）を、この道具自身の中に作り直すことになる。`AGENTS.md`
「⚠ 機械には『検出』まで」節・ADR 0223 決定2（下記「関連する既存の規律」）と同じ向き。

### 決定4. 空の宣言は、比較へ進む前に `mismatch`（赤）として弾く

**依頼が名指しした穴**: 「宣言の各要素が protection に在るか」だけを見る実装は、
宣言が空だと*真空で真*になる。この lib はもともと**両方向の集合一致**
（`missing`＝宣言に在って protection に無い、`extra`＝protection に在って宣言に
無い）を見る設計にしたので、`live`（protection 側）が非空であれば `extra` が
拾い、素通りしない。

🔴 **だが `live` も同時に空（branch protection 側に required が1つも無い）だと、
両方向とも空集合どうしの比較になり、素の集合演算では `match` が出てしまう。**
この repo は常に required check を持つことを前提にした門であり、**宣言が空である
こと自体が「宣言ファイルが壊れている」ことを意味する**——protection 側の状態を
見るまでもない。

**⟹ 採った案: 空の宣言を「壊れている」として明示的に赤にする。**
`compareRequiredStatusChecks(declared, live)` は `declared.length === 0` を
最初のガードとして持ち、`live` の値を見る前に `verdict: "mismatch"` を返す
（`live` が読めた・読めない・空、どのケースでも同じ）。**「明示的に弾く」と
「壊れているとして赤にする」の2択のうち、後者を採った**——弾く（例外を投げて
exit 3 にする）よりも、他の不一致と同じ語彙（`mismatch`/exit 1）で扱うほうが、
呼び出し側（CI や人間）が同じ手順で対処できるため。

**単体試験で固定した**（`scripts/__tests__/check-required-status-checks-lib.test.mjs`
「【4】宣言の contexts が空のとき、素通りしない」）——宣言が空 + protection も空、
宣言が空 + protection が非空、宣言が空 + protection が読めない、の3組すべてで
`mismatch` になることを確認済み。

### 決定5. CI には繋がない —— 本 PR 自身の CI で実測した結果、`GITHUB_TOKEN` は branch protection を読めなかった

**依頼の指示どおり、机上で決めず、この PR 自身の CI で実測した。**

**【実測】** 本 PR（[#623](https://github.com/takecchi/mnemora/pull/623)）に、
一時的に非 required の観測ジョブ（`required-status-checks-observe`）を追加し、
`env: GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}` の下で
`node scripts/check-required-status-checks.mjs` を実行させた。結果:

```
##[group]GITHUB_TOKEN Permissions
Contents: read
Metadata: read
##[endgroup]
...
保留（undetermined）: branch protection を読めなかった。
  gh の出力: gh api repos/takecchi/mnemora/branches/main/protection が失敗した:
    gh: Resource not accessible by integration (HTTP 403)
##[error]Process completed with exit code 2.
```

（sha `3a3126b`、run `35811799941`、job `107024796093`。ログは
`gh api repos/takecchi/mnemora/actions/jobs/107024796093/logs --allow-escape-sequences`
で取得し、自分の目で確認した。）

**この repo の既定 workflow permissions は `"read"`**（【実測】`gh api
repos/takecchi/mnemora/actions/permissions/workflow` → `{"default_workflow_permissions":
"read","can_approve_pull_request_reviews":false}`）。だが `GITHUB_TOKEN` が
実際に持てるのは `contents: read` / `metadata: read` までで、**branch protection の
読み出しに要る administration 相当の権限は、`permissions:` に指定できる欄にすら
存在しない**——これは姉妹 repo alteroid の同種の道具の doc が「GitHub Actions の
`permissions:` に指定できるスコープに `administration` は無い（実測 2026-09-11、
公式 workflow syntax から取得した全16個は administration を含まない）」と書いている
のと**同じ形の帰結**であり、本 PR は mnemora 自身の CI で**この repo に対して**
それを再現・確認した。

⟹ **これ自体が答えである**（依頼「読めなかった（保留＝exit 2）⟹ それ自体が答えである」）。
**ADR 0223 決定3**（下記「関連する既存の規律」）——「門にしないなら、代わりに置いた
もの（観測口・警告・人手監査）を同じ場所に明記せよ」に従い、代わりに置いたのは
次の2つである:

1. **手元のコマンド**: `pnpm check:required-status-checks`（自分の `gh` 認証で
   実行する。administration 相当の権限を持つトークン——`takecchi` 個人のログインなど
   ——であれば読める。本 ADR の「決めたこと」を書くために自分で何度も実行し、
   実際に読めている——下の「確かめたこと」参照）。
2. **`AGENTS.md` への手順の明記**: `example-chat` ジョブ名の凍結を説明する段落の
   直後に、このコマンドの存在・CI に繋がっていない理由（今回の実測）・実行手順を
   追記した。

**⛔ 一時的に追加した観測ジョブは、この PR のこのコミットで削除した**（実測した後、
恒久的に置く理由が無い——常に `undetermined` を返すジョブを CI に残しても、
それ自体は何の新しい情報も生まない。`continue-on-error: true` で赤くはならない
設計にしていたが、「常に何も言わないジョブ」を required 外とはいえ残すこと自体が
ノイズである、と判断した）。

#### ⚠ 将来 CI に繋ぐときの条件（⛔ いまは繋いでいないので、いまは効かない）

🔴 **繋ぐなら、`mismatch`（exit 1）を `continue-on-error` で潰さないこと。**
⟹ **落としてよいのは `undetermined`（exit 2）だけである。**

**理由は決定3 と同じものが、別の層で効くからである** ——「読めないことを『一致』に
倒すと、何も守らない歯が緑を出し続ける」は、**スクリプトの終了コードの側だけでなく、
ワークフローの配線の側でも成り立つ。**`continue-on-error: true` を無条件に置くと、
三値にした意味が配線で消える。
⭐ **先例の形（赤は落とす・保留だけ落とさない）を、配線でも守ること。**

⚠ **`main`（push）では、どちらも落としてよい**——`main` を赤くしない方針は維持する。
**赤にするのは `pull_request` の側である。**

🔴 **これを決めたのはクローンであって、オーナー本人ではない**（冒頭の断り書きと同じ）。

### 決定6. 新しい歯を required contexts に入れない

`.github/required-status-checks.json` の `contexts` は、実測した現状の6件のみを
持つ。本 PR が追加した検査（`check:required-status-checks` 自体、および
`scripts/__tests__/check-required-status-checks-lib.test.mjs`）は、通常の
`typecheck / lint / test / build` required check の中で（既存の `test` 段の一部として）
実行されるだけであり、**独立した required context としては一切登録していない**
——required を増やす判断は branch protection の変更そのものであり、オーナー領分
だからである（`docs/autonomy.md` §3「してはいけないこと」）。

#### ⚠ いま何が守っていて、何が守っていないか

**【実測 2026-09-23】required contexts は6本であり、本 ADR が足した歯はそこに入っていない。**
そして**恒久的に生えた新しいジョブ名も無い**——決定5 で足した観測ジョブは、実測した
あと同じ PR の中で削除した（`git diff origin/main...HEAD -- .github/workflows/` が空で
あることで確かめられる）。

⚠ **ただし、その観測ジョブは一度だけ走っており、その名前は GitHub の check-run の
履歴に残っている**（commit `3a3126b`、名前は
`required status checks の宣言と branch protection を突き合わせる（観測。非 required。ADR 0277）`
——⚠ **番号も古い**）。**branch protection の UI は、最近の check-run に現れた名前を
required の候補として出す。**⟹ **repo のファイルからは消えていても、UI からは
しばらく required に *追加できる* 状態である。**

⟹ **これを望まないなら、そう決めておく必要がある**（決定として書くか、
`.github/required-status-checks.json` に「入れない」と明記するか）。
⛔ **本 ADR はそこまで決めていない。**⟹ 🔴 **決めるのはオーナーの領分である**
——required を増やすことは branch protection の変更そのものだからである
（`docs/autonomy.md` §3「してはいけないこと」）。

⛔ **この歯を required に入れても、決定5 の実測（`GITHUB_TOKEN` は protection を
読めない）は変わらない。**⟹ 入れれば `undetermined`（exit 2）を返し続ける門になる。

---

## 検討して採らなかった案

| 案 | 落とした理由 |
|---|---|
| `.github/required-status-checks.json` の値が古くなったら、branch protection の側を自動で書き換える | ⛔⛔ 依頼で明示的に禁止（`required_status_checks` の設定そのものを変えない）。加えて、`docs/autonomy.md` §3 の「してはいけないこと」の趣旨（branch protection 設定変更はオーナー領分）にも反する |
| ずれを検出したら、宣言ファイルの側を自動で protection の値に上書きする | ⛔ 採らない。ずれの原因（宣言が古いのか、protection が意図せず変わったのか）を機械は判定できない。宣言を自動で書き換えると、「protection が誤って変わった」ケースでも宣言側が黙って追随し、誤りが記録として残らなくなる（ADR 0223 決定2「機械が判定できなかったときは、従来どおりに倒さず赤／保留で止める。確定と書き込みは人に残す」と同じ理由。下記「関連する既存の規律」） |
| 三値語彙を alteroid と同じ `match`/`drift`/`unreadable` にする | ⭐ 一部採った（`match`/`mismatch` は ADR 0253 の `check-local-embedding-fingerprint.mjs` の語彙に、`undetermined` も同ファイルの語彙にそれぞれ揃えた）。alteroid の `drift`/`unreadable` は不採用——mnemora には既に `check-local-embedding-fingerprint.mjs`（match/mismatch/undetermined、exit 0/1/2/3）という強い先例があり、依頼文自身がこの先例を名指ししていたため、そちらへ揃えた |
| required の観測ジョブを CI に恒久的に残す（`undetermined` のまま） | ⛔ 採らない。決定5参照——実測の結果、恒久的に置く価値が無いと判断した |
| 空の宣言を「明示的に弾く」（例外を投げて exit 3、または CLI が起動時に検査ファイルの妥当性を別途検証してから比較に入る） | ⭐ 一部検討したが不採用。決定4参照——赤（mismatch/exit 1）として扱うほうが、既存の「ずれている」ケースと同じ対処導線（宣言を直すか、protection を確認するか）に乗るため |

---

## 引き受けた負債

1. **`pnpm check:required-status-checks` は CI に繋がっていない。**⟹ 実際に
   drift が起きても、誰かが手で実行しない限り気づかれない。ADR 0274 が直した
   腐りと**同じ形の腐りが、この道具自身についても起こりうる**——「宣言と
   protection がずれていないか」を確認する層を作ったが、その層自体を定期的に
   動かす仕組みは作っていない。
2. **`observedAt` は腐る。** 突き合わせが赤くなったとき、「設定が変わった」のか
   「正本が古い」のかは、この道具には分からない——人間が判断する（下記「関連する
   既存の規律」参照）。この ADR も、宣言ファイル自身も、`observedAt` が実際に
   古くなっていく速度・頻度は測っていない。
3. **`.github/required-status-checks.json` を実際に更新する運用**（誰が・いつ
   `pnpm check:required-status-checks` を実行し、ずれていたらどちらを直すか）は、
   `AGENTS.md` に手順を書いただけであり、実際に定着するかは確かめていない。
4. **branch protection の administration 権限を持つトークンで実行した場合の
   動作**（決定5で「読めれば一致する」と書いた部分）は、この PR の作業では
   自分の `gh` 認証（オーナーと同じ `takecchi` アカウント、`repo` スコープ持ち）
   でのみ確認しており、それ以外の administration 権限トークンでの動作は
   確認していない。

---

## これが覆るとしたら

- **GitHub Actions が `permissions:` に administration 相当のスコープを追加すれば**、
  決定5を見直し、CI への観測ジョブの追加を再検討できる。
- **この repo の運用で、専用の administration 権限を持つトークンを secret として
  安全に配布できるようになれば**（例: 別の GitHub App のインストールトークン）、
  CI から読める可能性がある——ただしそれ自体が新しい権限配布の判断であり、
  オーナーの決定が要る。
- **オーナーが required contexts の運用そのもの（この宣言＋突き合わせという形）を
  見直すと判断したとき。**

---

## 関連する既存の規律（写さず、引くだけ）

- **`docs/autonomy.md` §3「してはいけないこと」** —— branch protection の設定変更は
  オーナー領分。本 ADR の決定6・「検討して採らなかった案」の1行目はこれに従う。
- **[ADR 0220](./0220-issue-comment-author-does-not-distinguish-owner-from-agent.md)** ——
  投稿者名だけではオーナー本人と担い手を区別できない。本 ADR 冒頭の名乗りはこれに従う。
- **[ADR 0223](./0223-cross-cutting-disciplines-extracted-from-the-adr-corpus.md) 決定2**
  ——「機械に載せてよいのは『実体から機械的に数え直せるもの』だけ。意味の判定と、
  副作用のある手は機械に打たせない。判定できないときは、通さずに止める」。
  本 ADR の決定3・決定5（CI に繋がず、ずれの確定と書き込みは人間に残す）はこれに従う。
- **[ADR 0223](./0223-cross-cutting-disciplines-extracted-from-the-adr-corpus.md) 決定3**
  ——「偽陽性率に上限を置けない検査は、門にしない。ただし『置かない』で終わらせず、
  代わりに何を置いたかを書く」。本 ADR の決定5（CI に繋がない代わりに手元コマンド
  ＋ `AGENTS.md` への明記を置いた）はこれに従う。

---

## 確かめたこと

- **【実測 2026-09-23T02:37:33Z】** `gh api
  repos/takecchi/mnemora/branches/main/protection/required_status_checks -q
  '.contexts[]'` を自分の手で引き、6件が依頼文に書かれた値と一致することを確認した
  （逐語の突き合わせも行った）。
- **【実測】** 単体試験19件がすべて通ること（`scripts/__tests__/check-required-status-checks-lib.test.mjs`、
  `npx vitest run scripts/__tests__/check-required-status-checks-lib.test.mjs`）。
- **【実測】変異試験（依頼が求める4本）**:
  1. いまの6件の宣言のまま `node scripts/check-required-status-checks.mjs` を
     実行 → `一致（match）`、exit 0。
  2. 宣言の1件を1文字だけ書き換える（`build` → `buld`）→
     `不一致（mismatch）`、`宣言に在って protection に無い` /
     `protection に在って宣言に無い` の両方が出力される、exit 1。
  3. 書き換えを `cp` で元に戻す → 再び `一致（match）`、exit 0（`git status --porcelain`
     で差分が無いことも確認済み）。
  4. 宣言の `contexts` を `[]` にする → `不一致（mismatch）`（真空で `match` に
     化けない）、exit 1。元に戻すと再び exit 0。
- **【実測】** `pnpm run build` / `pnpm run typecheck` / `pnpm run lint` /
  `pnpm run format:check` / `pnpm run test`（DB 段は `DATABASE_URL` 未設定のため
  未実行——ADR 0015 の既定どおり）/ `node scripts/check-publish-pack.mjs`
  （6つの門）をすべて手元で実行し、緑であることを確認した。
- **【実測】** 本 PR 自身の CI（一時的な観測ジョブ）で、`GITHUB_TOKEN` が
  branch protection を読めないこと（`HTTP 403 Resource not accessible by
  integration`）を確認した（決定5）。
- **【実測】** `.github/workflows/ci.yml` を実際に `js-yaml` で構文解析し（作業用の
  一時的な確認であり、mnemora 自身は `js-yaml` を依存に足していない——
  `scripts/workflow-comment-blank-lib.mjs` の「依存を足していない」という既存の
  判断に合わせ、本 PR の `.mjs` も YAML パーサを依存に加えていない）、観測ジョブの
  追加・削除の両方で構文が壊れていないことを確認した。

## 確かめていないこと

- ⛔ **他の GitHub App のインストールトークン・PAT（fine-grained 含む）で
  administration 権限を持つものが、CI の secret として配布された場合に実際に
  読めるかは確認していない。** 自分の `gh` 認証（`repo` スコープ）で読めることは
  確認したが、それ以外の権限体系は試していない。
- ⛔ **`.github/required-status-checks.json` の運用（誰が定期的に
  `pnpm check:required-status-checks` を実行するか）が実際に定着するかは、
  この PR の作業では確認しようがない**（未来の運用の話であるため）。
- ⛔ **本 ADR が挙げた required 6件以外に、branch protection が持つ他の設定
  （`enforce_admins` / `required_pull_request_reviews` 等）についてのずれは、
  この道具の対象外であり、確認していない。** `required_status_checks.contexts`
  （と `checks`）だけを対象にしている。
- ⛔ **`.github/required-status-checks.json` の `contexts` が、将来 required check
  の本数が変わったとき（例えば7本目が required に足されたとき）にどう運用される
  べきか**（宣言の更新を PR に含めることを強制する仕組みが無い）は、この PR では
  設計していない。

---

## 追記（2026-09-23）: ADR 0278 と並べて読む —— 逆の結論に見えるが、矛盾していない

🔴 **この節から上は、当時の決定・実測の記録のまま書き換えていない。**以下は、本 ADR が
着地した後に、両方を並べて読み直して分かったことである。**決定1〜決定6 は何も変えない。**

⚠ **判断したのはクローンの委譲で走っている担い手であって、オーナー本人ではない**
（本 ADR 冒頭の節と同じ断り）。

### なぜこの節が要るか

**[ADR 0278](./0278-architecture-section5-port-interface-correspondence-tooth.md)
（PR #624）と本 ADR（PR #623）は、同じ日に、別々の担い手が、互いを知らずに書いた。**

- 【実測】PR #624 のマージは `2026-09-23T03:40:01Z`、PR #623 のマージは `03:54:21Z`（14分差）。
- 【実測】相互の言及は **0 件**である
  （`grep -cE "0279|required-status-checks"` を ADR 0278 に、
  `grep -cE "0278|architecture.*§5"` を本 ADR に当てて、いずれも 0。PR 本文も同じ）。

⟹ **そして2本は、「手で保つ一覧が腐る」という同じ問題に、一見すると逆の答えを出している。**

| | ADR 0278 | 本 ADR（0279） |
|---|---|---|
| 見かけの結論 | **リテラルで持つ**（対象一覧を歯の中に literal な配列で） | **正本を置いて突き合わせる** |

⟹ 🔴 **次にこの2本を並べて読む人は、ここで必ず戸惑う。**だから繋いでおく。

### 実は、2本は同じ骨格である

**どちらも「手で保つリテラルな参照」＋「実行時に取れる側との突き合わせ」という同じ形である。**
違うのは、その境界をどこに引いたかだけである。

| | ADR 0278 | 本 ADR（0279） |
|---|---|---|
| **手で保つのは何か** | 対象の**分類**だけ（`TARGET_INTERFACE_NAMES` 等の名前の一覧。決定4） | **宣言そのもの**（`.github/required-status-checks.json` の `contexts`。決定1） |
| **実行時に突き合わせるのは何か** | 各対象の**メンバー名の集合**を、`docs/architecture.md` と公開 API スナップショットの**両方から動的に抽出**して比較（決定2・決定3） | 宣言の `contexts` と、`gh api .../protection` で取った実測値（決定1・決定3） |

⟹ ⭐ **ADR 0278 は「全部リテラル」ではない。**リテラルなのは**どこを見るか**であって、
**何が正しいか**は機械生成物（`scripts/__snapshots__/public-api/core.d.ts`）から取っている。
⟹ **本 ADR が「宣言は設定ではない」と書いたのと、同じ線の引き方である。**

### 🔴 分岐点は1つだけ —— **実行時に取れる側が、CI から機械的に到達可能か**

| | 実行時に取れる側 | CI から到達できるか | ⟹ 門にできるか |
|---|---|---|---|
| **ADR 0278** | 公開 API スナップショット（`pnpm run build` が作る生成物） | ⭕ **できる**。鮮度は CI の build 段が保証する | ⭕ **門にした**。`pnpm run test` 経由で required check `typecheck / lint / test / build` に入っている |
| **本 ADR（0279）** | branch protection（`gh api .../protection`） | ⛔ **できない**。決定5 の実測どおり、CI の `GITHUB_TOKEN` は `Resource not accessible by integration (HTTP 403)` を返す | ⛔ **門にしない**（決定5）。手元コマンド＋`AGENTS.md` の手順に留めた |

⟹ ⭕ **矛盾ではない。**「リテラルで持つ範囲」と「実行時に突き合わせる範囲」の境界が、
**対象ごとの実情に応じて別の場所に引かれている**だけである。

### ⚠ 「ADR 0278 が落とした案」と「本 ADR が採った案」は、同じものではない

ADR 0278 は「採らなかった案」3番で、**対象一覧を `docs/architecture.md` §5 から動的に導出する**
案を落としている。その理由は「偽陽性を生むから」ではなく、逐語でこうである:

> 「§5 のどの節が写しでどの節が予告か」は一次資料の逐語を読んで人が判断した**意味の分類**で
> あり、…`AGENTS.md`「機械には『検出』まで」の線を越えて**意味の判定**を機械に持たせることになる。

⟹ 🔴 **本 ADR の突き合わせ相手（protection の `contexts`）は、既に機械可読な値であり、
意味の判定を1つも含まない。**⟹ **ADR 0278 が拒んだのは「機械に意味を判定させること」であって、
「正本を置いて突き合わせること」ではない。**⟹ **2本は同じ線（`AGENTS.md`「機械には『検出』まで」）の
同じ側に立っている。**

### ⛔ そして、弱点まで同じ形である —— **どちらも偽陰性に倒れる**

⚠ **「本 ADR のほうは、ずれたら赤くなるから安全」とは読まないこと。**両方の ADR が、自分の
「引き受けた負債」の1番目に、**同じ形の腐り**を自分で書いている:

- **ADR 0278**: 新しい「写し」節が増えても、**その名前を一覧に手で足すまで、歯はその節を検査しない。**
- **本 ADR（0279）**: 決定5 で CI に繋がなかったので、**実際に drift が起きても、誰かが手で
  `pnpm check:required-status-checks` を実行しない限り気づかれない。**

⟹ 🔴 **どちらも「手で保つ側が腐ったとき、赤くならずに静かに検査が痩せる」**——
**偽陽性ではなく偽陰性に倒れる。**⟹ **2本を並べて読む人が持ち帰るべき注意は、ここである。**

⟹ ⭐ **本 ADR「これが覆るとしたら」の条件（administration 権限を持つトークンが CI から使える
ようになる）が満たされた日には、上の表の「CI から到達できるか」が ⭕ に変わる。**⟹ そのとき
本 ADR は ADR 0278 と**完全に同じ形**になり、決定5 を見直す根拠になる。

### ⚠ 上の引用の帰属について（2026-09-23 追記）

🔴 **すぐ上でこの追記が ADR 0278 から引いた一文（`AGENTS.md`「機械には『検出』まで」の線を越えて
意味の判定を機械に持たせることになる）の帰属は、`AGENTS.md` ではなく
[ADR 0223](./0223-cross-cutting-disciplines-extracted-from-the-adr-corpus.md) 決定2 である。**
【実測】`grep -c "意味の判定" AGENTS.md` → **0**。
詳細は [ADR 0278](./0278-architecture-section5-port-interface-correspondence-tooth.md)
「🔴 追記2（2026-09-23、着地後）」②。

⚠ **この追記を書いた担い手（＝上の追記の書き手）は、ADR 0278 の帰属を検算せずに引き写した。**
⟹ ⛔ **引用としては ADR 0278 の逐語であり正確だが、帰属の誤りをこの文書へ伝播させた。**
⭐ 本 ADR `:324-325` が同じ規律を ADR 0223 決定2 から逐語で引いているのが、正しい形である。
