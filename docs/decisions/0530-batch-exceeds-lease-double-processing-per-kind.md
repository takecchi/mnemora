# ADR 0530: 穴探し — 1回の `tick` の2件目の処理中にリースが切れたとき、別の `tick` が再 claim して二重に処理した結末を、種類ごとに3者で実測する（TSDoc どおりで一致。`consolidate` の結末だけ TSDoc に書いていなかったので書いた）

- **状態**: 採用 (2026-10)
- **日付**: 2026-10-02

クローン miku の委譲先（担い手。マネージャー mgr-2c9f30d0 の指示による）が書いた。直す線（約束に実装を戻す・文書を今の振る舞いに直す）の中だけを直した。**実装は変えていない。変えたのは `TickOptions.leaseMs` の TSDoc に1段落足したことだけ**（下の「TSDoc と合わなかった点」）。
出所の区別: 【現物】は読んだコード・文書、【実測】は手元で走らせた結果（Node.js v22、PostgreSQL 17 + pgvector を自分専用のポート `54871` で）、【判断】は担い手の判定、【未確認】は確かめていないこと。

- **文脈**: `TickOptions.leaseMs` の TSDoc（`runtime.ts`。2026-09-30 の追記）は「今の振る舞い」として、(1) リースはバッチの claim 時点から数える・後ろのジョブは切れうる、(2) 別の `tick` が再 claim すると provider の呼び出しと書き込みが二重に走り、遅れた側の `complete` は `leaseConflicts` に載る、(3) 種類ごとの結末（`embed` は冪等、`extract` は再配達の確認、`reflect` は2件になりうる）、を書いている。Issue #1200 の追記は「リースを超えても誰も取り直さなければ、完了は通り、何も出ない」。既にある歯は `tick-batch-lease-expiry.test.ts`（Fake だけ・2件・embed）と、ADR 0529 の歯（リースの期限切れ全般）。この ADR は、答えが TSDoc にある3つの問いが、Fake・InMemory・Postgres で本当かを測る。

## 測り方【実測】

実時間は待たない。`RuntimeDeps.clock` を「壁時計＋オフセット」にし、次の順で決定的に進める。
1. 同じ種類のジョブを2本積み、`tick` A（`leaseMs: 1000`、`limit: 2`、`kinds: [その種類]`、`claimedBy: "A"`）を撃つ。
2. A の**2件目**が provider（`embed` なら埋め込み、ほかは LLM）の呼び出しの前の**門**（Promise）に着いたところで、時計を +1200ms 進める（バッチの claim から 1200ms。1件あたりの処理は `leaseMs` より短くても、後ろのジョブのリースは先に切れる）。
3. (a) 同じ門の中で別の `tick` B（`claimedBy: "B"`、同じ `kinds`）を撃つ（B が2件目を再 claim して最後まで処理する）／(b) 誰も撃たない。
4. A の門を開け、A を終わらせる。
consolidate・reflect は、グループ1（種1＋近傍2）とグループ2（種2＋近傍2。別のベクトル）を作り、2件目のジョブがグループ2を扱うようにした。決定的で、同じ操作を4回繰り返しても結果は同じだった（歯は、Fake を5回・InMemory と Postgres を8回走らせて、すべて緑）。

## 結果（3者一致。すべて決定的）

### 問い1: 処理中にリースが切れたとき、別の `tick` が同じ行を再 claim して二重に処理するか — する【実測】

Fake・InMemory・Postgres で、4種類とも同じ。B は A の2件目を再 claim し（`attempts: 2`）、最後まで処理する。provider の呼び出しは3回（A の1件目・A の2件目・B の2件目）。Fake だけで縛っていた形（`tick-batch-lease-expiry.test.ts`）が、InMemory と実 Postgres でも成り立つ。

### 問い2: 元の `tick` の完了の書き込みはどう扱われるか【実測】

- **別の `tick` が再 claim したとき**: A の2件目の `complete` は `leaseConflicts`（`[種類, "complete"]`）に載り、A の `processed` は1（弾かれた分は数えない）。行は B の完了のまま（`attempts` は 1 と 2。A が上書きしない）。B は `processed: 1`・`leaseConflicts` なし。
- **誰も取り直さなかったとき（Issue #1200）**: A は2件とも `processed: 2`・`leaseConflicts` は空・`attempts` は両方 1・provider の呼び出しは2回。何も出ない。TSDoc のとおり。
- 遅れた側の provider が落ちた場合（`embed` で確認済み。ADR 0529）は、`leaseConflicts` の種類が `fail` になる。

### 問い3: 二重に走ったときの結末は約束と合うか — 合う。種類で違う【実測】

| 種類 | 二重に走ったあとの状態 | TSDoc の約束 |
|---|---|---|
| `embed` | 記憶は1つのまま `ready`、ベクトルは上書き（呼び出しは2件目だけ2回） | 冪等（合う） |
| `extract`（同じ候補） | 観測1件につき記憶1件（冪等の鍵で同じ行に当たる） | 再配達の確認／冪等の鍵（合う） |
| `extract`（A と B が違う候補を返す） | 二重に処理された観測だけ、**両方の候補が `active` で残る**（A の `A fact` と B の `B fact`） | 事前の確認は、先に走った側がまだ書いていなければ効かない（ADR 0347 の 2026-09-28 追記。合う） |
| `extract`（A の LLM が B の完了後に落ちる） | B の候補と、A の全文フォールバックの記憶が両方 `active` | 同上（合う）。遅れた側の `complete` が `leaseConflicts`（`complete`。LLM の失敗は全文フォールバックで `complete` する） |
| `reflect` | **内省の記憶が2件できる**（二重に処理されたグループの分。材料の記憶は `superseded` にしないので `active` のまま） | 「再配達で2件になりうる」（合う。ADR 0091 決定11） |
| `consolidate` | **統合先は1件のまま**。遅れた A は LLM を呼んだ（呼び出しは二重）が、書く前に元の記憶の status を読み直し、B が先に `superseded` にしたのを見て何も書かない（イベントは B の `created`＋`superseded` だけ） | **TSDoc に書いていなかった**（下） |

## TSDoc と合わなかった点（どちらに合わせたか）

- **食い違いは無かった**。`embed`・`extract`・`reflect` の結末は約束と一致した。
- **`consolidate` の結末が TSDoc に書かれていなかった**（約束と実装の食い違いではなく、書き漏らし）。実装の側が安全（二重に統合先を作らない。ADR 0420）なので、**TSDoc を今の振る舞いに合わせて直した**（`TickOptions.leaseMs` に1段落。四種類の結末と、遅れた側が `leaseConflicts` に載ることをまとめた）。実装は変えていない。
- 【判断】`reflect` が2件になるのは約束どおりの今の振る舞いで、直さない（ADR 0091 決定11。材料の記憶を `superseded` にしない設計の帰結）。

## 決定したこと

1. 実装・公開 API・既定値は変えていない。`TickOptions.leaseMs` の TSDoc を今の振る舞いに合わせて直した（文書だけ。型は変わらない）。CHANGELOG・`docs/migration-v1.md` には足していない（挙動が変わらず、公開の型の面〔`.d.ts` の宣言〕も変わらない文書の訂正のため。`[1.2.0]` には触れていない）。
2. **一致している今の振る舞いを歯で縛った**（conformance suite には足さない）:
   - `packages/core/src/__tests__/fake-tick-batch-exceeds-lease-parity.test.ts`（Fake。加えて TSDoc の段落が在ることを縛る歯）
   - `packages/postgres/src/__tests__/tick-batch-exceeds-lease-parity.postgres.test.ts`（InMemory と実 Postgres。DB はファイル冒頭で作り直し、tenant はこのファイル専用の名前を使う）
   - 2つは同じ操作列と同じ `EXPECTED`（12 項目）を持つ。

## 変異試験【実測】

歯が噛むことを、実装を1つずつ曲げて確かめた。戻した後は `git status` に歯の2ファイルと TSDoc の変更以外が無い。
- 赤になった: Fake の `claimBatch` がリース切れの行を再取得しない／Fake の `complete` の `attempts` の CAS を外す／InMemory の `claimBatch` がリース切れの行を再取得しない／Runtime の `consolidate` の「書く前の status の読み直し」を外す（遅れた側が書いてしまう）。
- **緑のまま（歯が届かない）**: Runtime の `reflect` の「材料が `superseded` になっていたら打ち切る」読み直しを外す変異。この ADR の操作列は、`reflect` の材料を途中で `superseded` にしないので、この枝は通らない。ADR 0420 の歯の面で、ここでは測っていない。

## 検討した代替案

1. **`reflect` が2件になるのを防ぐ**（種を `leaseMs` の間ロックする、種ごとの冪等の鍵を持つ、など）。採らなかった。ADR 0091 決定11 の帰結で、設計の変更になる（オーナーの領分）。
2. **実時間の `sleep` でリースを切らせる。** 採らなかった。時計のオフセットと門で決める（ADR 0529 と同じ）。
3. **歯を足さず、結果だけ書く。** 採らなかった。

## オーナーの領分の材料（直していない）

- **`limit` の既定（50）と `leaseMs` の関係**: バッチの合計処理時間が `leaseMs` を超えると、後ろのジョブのリースが先に切れて二重に走る。`limit` の既定の変更は既定値の変更。`tick` はジョブの所要時間を知らないので、検査も置けない。
- **リースを延ばす口を `OutboxStore` に足すか**: ジョブごとにリースを延ばせれば、バッチ内の二重は無くせる。公開 API を足す変更。
- **`reflect` の二重を許すか**（上の代替案1）。

## これが覆るとしたら

- `OutboxStore` にリースを延ばす口が足されたとき（この歯の「別の `tick` が再 claim する」操作列が成り立たなくなる。歯を意図して書き換える）。
- `reflect` が材料の記憶を `superseded` にする設計に変わったとき（`reflect doubled` の項目が変わる）。

## 測っていないこと

- 複数のプロセス・複数の接続プールからの並行、大文字の id、実 API。
- 遅れた側が `consolidate` の統合先を**書いている最中**（書く前の読み直しの後）に B が先に書くような、さらに細かい競合（Postgres の 1 トランザクションの CAS の側。ADR 0420 が縛る面）。
- `reflect` の材料が処理の途中で `superseded` になる場合（上の変異試験の緑の枝）。
