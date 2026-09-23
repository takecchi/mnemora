# ADR 0274: required status check の文脈名は凍結する — 腐っていても改名せず、名指しで訂正を積む

- **状態**: 提案 (2026-09-23)
- **日付**: 2026-09-23

**⚠ 出所を分ける**（ADR 0088 / 0264 の体裁を踏む）:

- **【実測】** — この書き手が自分の手で `gh` を走らせて確かめた。
- **【現物】** — この repo のコード・文書を読んで確かめた。

⛔ **番号は仮**。[ADR 0179](./0179-adr-number-assigned-at-merge.md) の規律により
ADR の番号はマージ直前に確定する。この番号（0273）は本 PR 作成時点で
`docs/decisions/` の最大連番 + 1 を取ったものであり、**マージ時に他の ADR PR と
衝突していたら付け替える**（採番の確定はマージする側の作業）。

---

## 問い

`.github/workflows/ci.yml` の `example-chat` ジョブは、`name:` に
`examples/chat (本物の Postgres + pgvector、擬似 provider)` を名乗っている。

**この名乗りは不正確である。**`AGENTS.md` は provider の4層（`deterministic` /
`recorded` / `openai` / `local`）を表にして区別しており、**`example-chat` ジョブの
`compare` ステップは `recorded`（記録した実 API 応答の再生）で走る**と明記している
（`AGENTS.md`「⚠『実 API を叩かない』は『擬似物で走る』と同じではない」節、
[ADR 0088](./0088-retrieval-quality-measured-in-ci.md)）。「擬似 provider」と
名乗るのは、`AGENTS.md` 自身が禁じている読み違いそのものである。

**素直に直すなら `name:` の文言を書き換えればよいはずだが、それができない。**
このジョブ名は GitHub の branch protection の required status check の
*文脈名*として登録されている——書き換えると、この文字列を探している
required check が「見つからない」まま止まる。

## 【実測】required check の文脈名そのものであること

```
gh api repos/takecchi/mnemora/branches/main/protection/required_status_checks
```

の `contexts`（6件）に、次が逐語で含まれる:

```
"examples/chat (本物の Postgres + pgvector、擬似 provider)"
```

GitHub の branch protection は、check-run の `name` と required context の
文字列を**完全一致**で突き合わせる——`ci.yml` 側で `name:` を変えると、
同じ workflow 実行が生成する check-run の名前も変わり、旧文字列を待っている
required check は「実行されていない」まま PR をブロックし続ける。**これを
解くには branch protection の required checks 一覧そのものを更新する必要があり、
それはこの repo の運用上オーナー領分の変更である**（本 PR はその変更を含まない）。

## 【現物】ジョブの中身はさらに一様ではない（層が混在している）

`name:` を「recorded」に変えたとしても、それはそれでジョブ全体を代表できない
——このジョブのステップは層が混在している（`.github/workflows/ci.yml`
`example-chat` ジョブの各ステップの env・コメントを読んで確認、実行はしていない):

| ステップ | 層 | 根拠 |
|---|---|---|
| `Run examples/chat の observe→recall 往復・量の比較テストを本物の DB に対して実行`（`test:db`） | `deterministic` | `OPENAI_API_KEY` 未設定、`MNEMORA_LLM`/`MNEMORA_EMBEDDING` の override 無し。`selectProviderMode`（`examples/chat/src/providers.ts`）は鍵が無ければ `"deterministic"` を返す |
| `correction サブコマンド…` | `deterministic` | ステップ直上のコメントが明記（「`recorded` にしない理由: `examples/chat/cassettes/` に correction 用の記録が無い」） |
| `北極星の物差し…を compare で実測しログに残す`（`compare`） | **`recorded`** | ステップ直上のコメントが明記。`examples/chat/cassettes/compare.json` が存在するため、`resolveCassetteForRun` 経由の `decideProviderSource` が「no-key」理由で `recorded` を選ぶ |

⟹ **「ジョブ名は1つの層を名乗れない」——単一の文言に押し込める性質のものではない。**

## ⚠ 既存のコメントの一部はすでに訂正済みだった（が、他の箇所は未訂正のまま残っていた）

`compare` ステップ直上のコメントには、着手前から次の訂正が入っていた（【現物】）:

> このコメントは以前「擬似 provider で走る」と書いていたが、それは誤りだった——
> 実測（ADR 0133）で判明し、このコメントは実際の挙動に合わせて訂正した。

**だが同じジョブの中に、まだ訂正されていない同種の記述が2箇所残っていた**（本 PR 前）:

1. ジョブ冒頭のコメント（`roadmap.md` 段階7の完了条件を説明する段落）:
   「LLM/Embedding は @mnemora/testkit の決定的な擬似 provider（OPENAI_API_KEY を
   設定しない）で置き換える」——`compare` の例外を書いていなかった。
2. job-level `env`（`MNEMORA_LOCAL_EMBEDDING_CACHE_DIR`）のコメント:
   「`compare` は `deterministic` provider で走るため読まれない」
   「このジョブの `compare` は OPENAI_API_KEY 無しの擬似 provider」——**`compare`
   ステップ自身のコメントが訂正した後もなお、この2箇所は「`deterministic`」
   「擬似 provider」と書き続けていた。**

⟹ **1箇所を訂正しても、名乗りが複数箇所に散っていると訂正が伝播しない。**
これは `name:` の凍結とは独立した、同じ根の問題（同じ事実についての複数の
名乗りが同期しなくなる)である。本 PR はこの2箇所も実際の挙動に合わせて書き換えた
（`compare` ステップのコメントに合わせ、下記「決めたこと」参照)。

---

## 決めたこと

### 決定1. `name:` の文字列そのものは変えない

required status check の文脈名を壊す変更は、この PR の範囲では行わない。
**branch protection の required checks 一覧の変更はオーナー領分**とし、
この ADR はその変更を提案も実行もしない。

### 決定2. ジョブ名の直上にコメントを積み、訂正と理由を名指しする

`ci.yml` の `example-chat:` キーの直下（`name:` の直前）に、次を書いた:

- required check の文脈名であること（実測コマンド付き）と、変えられない理由
- ステップごとに層が混在していること（`deterministic` / `recorded` の内訳)
- この ADR への参照

**コメントであれば文脈名は動かない。**「直せる側」を直す、という選択である。

### 決定3. `AGENTS.md` にも同じ訂正を積む

provider の4層表のすぐ前（`example-chat`/`retrieval-quality` が `recorded` で
走ると明記している段落の直後）に、**required check の文脈名が腐っていること・
直せない理由・訂正の在り処**を追記した。`AGENTS.md` を読む担い手が、
ジョブ名の「擬似 provider」を鵜呑みにしないための導線である。

### 決定4. ジョブ内の他の2箇所の stale なコメントも、実際の挙動に合わせて訂正する

「決めたこと」冒頭で触れた2箇所（冒頭コメント・job-level env コメント）も、
`compare` は `recorded` である、という現在の事実に合わせて書き換えた。
**採用済み ADR 本文の書き換え規律とは別物である**——`ci.yml` はコード（設定）
であり ADR ではないため、コメントを実態に合わせて修正することは「訂正の追記」
ではなく通常のバグ修正として扱った。

---

## 検討して採らなかった案

| 案 | 落とした理由 |
|---|---|
| `name:` を「recorded」または「混在」に書き換え、同時に branch protection の required checks も更新する | ⛔ branch protection の設定変更はオーナー領分。本 PR の作業者には GitHub リポジトリ設定を変更する権限判断が無く、勝手に行わない |
| ジョブを分割し、`deterministic` で走る部分と `recorded` で走る部分を別ジョブにする | ⭐ 筋は通るが、この PR の目的（名乗りの訂正）を大きく超える設計変更になる。既存の required check 構成（6件）にも影響する。別 issue で検討する価値はあるが、ここでは決めない |
| 何もしない（`compare` ステップのコメントだけが訂正されていれば十分と判断する) | ⛔ 実際に2箇所が未訂正のまま残っていた（上記「現物」参照）。同じ事実の名乗りが複数箇所にある repo では、1箇所の訂正は他箇所へ伝播しない——今回のジョブ名もその一例であり、「直したつもり」を防ぐには名指しして残すほうが安全 |

---

## 引き受けた負債

1. **ジョブ名そのものは依然として不正確なまま残る。**⛔ この ADR は「直せない」
   ことを受け入れており、根本的な解消（branch protection 更新 + ジョブ名変更、
   または decision 2 の分割案）はオーナー判断に委ねている。
2. **同種の「複数箇所に散った名乗り」が、このジョブ以外にも残っている可能性を
   全数調査していない。**⛔ `ci.yml` 全体・`AGENTS.md` 全体を横断して
   「擬似 provider」「deterministic」等の記述を洗い出す作業は、本 PR の
   スコープ外として行っていない（下記「確かめていないこと」参照）。

## これが覆るとしたら

- **オーナーが branch protection の required checks を更新し、`name:` を
  実態に合わせて書き換える判断を下したとき。**⟹ 本 ADR が名指しした
  ジョブ名直上のコメント・`AGENTS.md` の追記は、その時点で古い記録として
  役目を終える（削除するか、経緯として残すかはその時点で判断する）。

## 確かめたこと

- **【実測】** `gh api repos/takecchi/mnemora/branches/main/protection/required_status_checks`
  の `contexts`（6件）に `"examples/chat (本物の Postgres + pgvector、擬似 provider)"`
  が逐語で含まれること
- **【現物】** `example-chat` ジョブの `test:db` / `correction` ステップに
  `OPENAI_API_KEY` も `MNEMORA_LLM`/`MNEMORA_EMBEDDING` の override も無いこと
  （`deterministic` を選ぶ `selectProviderMode` の分岐に落ちる)
- **【現物】** `compare` ステップ直上のコメントが「`recorded`」を選ぶ理由
  （`compare.json` カセットの存在）を明記していること、同コメントが
  「以前『擬似 provider で走る』と書いていたが誤りだった」という訂正を
  既に含んでいたこと
- **【現物】** 同じジョブ内の冒頭コメントと job-level env コメントの2箇所が、
  本 PR 着手前の時点でなお「`deterministic`」「擬似 provider」と書いていたこと
  （`compare` ステップのコメントが訂正された後も同期していなかった）
- **【現物】** `.github/workflows/ci.yml` を `js-yaml` で実際にパースし、
  本 PR の変更後も `jobs['example-chat'].name` が変更前と完全に同じ文字列
  （`"examples/chat (本物の Postgres + pgvector、擬似 provider)"`）であること

## 確かめていないこと

- **`ci.yml`・`AGENTS.md` 以外の場所（`examples/chat/README.md`・他の ADR・
  issue コメント等）に、同じ「`example-chat` は擬似 provider で走る」という
  古い名乗りが残っているかは横断的に洗い出していない。**⛔ 探した場所は
  `ci.yml` の `example-chat` ジョブ本文と `AGENTS.md` の provider 層の節に限る。
- **branch protection の required checks を GitHub 側で実際に変更した場合に
  何が起きるか（既存 PR の check 待ちがどう表示されるか等）は実際に試していない。**
  【現物】の突き合わせ（完全一致で待つ）からの推論であり、GitHub の挙動を
  自分の手で再現してはいない。
- **このジョブ以外の required check（他5件）の `name:` が、同様に自分自身の
  中身と食い違っていないかは調べていない。**本 ADR は `example-chat` 1件に
  限定した調査である。
