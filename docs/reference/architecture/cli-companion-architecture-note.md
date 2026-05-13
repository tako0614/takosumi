# CLI Surface Architecture

> このページでわかること: CLI の設計方針と kernel との連携モデル。

本ページは `takosumi` CLI の v1 surface をアーキテクチャ成果物として固定する。
[`/reference/cli`](/reference/cli) はどんなコマンドと flag が存在するかを記録
し、本ページはなぜその surface になっているか、CLI が越えてはならない境界はど
こかを記録する。

## 権限境界 (Authority boundary)

CLI は kernel 側の semantic な決定に関する authority を持たない。authority は
kernel 側にあり、Space ごとに scope される。すべての `takosumi` 呼び出しは
courier に過ぎない。

- Space は CLI flag や manifest field では選択しない。current public deploy は
  bearer token を 1 つの kernel-configured な public deploy scope
  (`TAKOSUMI_DEPLOY_SPACE_ID`、default `takosumi-deploy`) に bind する。internal
  control-plane route は actor / API / operator context を使って richer な Space
  routing を行う。
- CLI は Manifest file を YAML または JSON として load し、結果として得られる
  JSON manifest envelope を kernel に submit する。current public deploy は
  Shape / Provider / Template reference を validate / resolve し、reference DAG
  を build した上で、kernel-owned な deploy route 経由で dry-run / apply /
  destroy を実行する。richer な `ResolutionSnapshot` → `DesiredSnapshot` →
  `OperationPlan` → WAL pipeline は internal architecture model であり、CLI が
  これを偽装してはいけない。
- `connector:<id>` 形式の connector id は operator がインストールするもので、
  kernel の指示の下で runtime-agent が解決する。CLI はこれを解釈しない。
- CLI は Object の lifecycle (`managed` / `generated` / `external` / `operator`
  / `imported`) を分類したり、access mode (5 つの enum のいずれか)
  を割り当てたり、19 個の closed Risk code のいずれかを主張したりしない。これ
  らの判断は kernel response で返ってくるので、そのまま surface する。
- 番号付き approval invalidation trigger 6 件は kernel 側の関心事である。CLI は
  これらを描画してよいが、書き換えてはならない。

悪意ある / バグありの CLI は authority を拡大できず、ただ目立つように失敗する
だけである。

## Local vs remote モード

`takosumi` は remote kernel または in-process kernel のいずれかに対して動作す
る。

- **Remote モード** は `--remote`、`TAKOSUMI_REMOTE_URL`、または config file か
  ら remote URL が解決されたときに選ばれる。CLI は Manifest や DataAsset bytes
  を kernel HTTP server に post し、永続化された deploy record、idempotency
  replay、artifact state はそちらが所有する。process 越しに public deploy state
  を維持できるのはこのモードのみである。
- **Local モード** は remote URL が解決されないときに選ばれる。CLI は同梱の
  shape / provider registry を使う in-process kernel を立ち上げ、apply / plan /
  destroy を実行し、exit 時に state を捨てる。

local モードは dev 用途のみ。作者が kernel を立てずに Manifest を反復で書ける
ようにすることと、test fixture が apply pipeline を in-process で走らせられる
ようにすることが目的である。`ResolutionSnapshot` や `DesiredSnapshot` を永続化
せず、`OperationPlan` を journal せず、multi-actor 認証も提供しない。永続化さ
れた Space state なしでは contract が成り立たないエンドポイント (`status`、
`artifact …`) は劣化動作ではなく exit code 2 で local モードを拒否する。

`takosumi server` は橋渡しである。ローカルで起動すると同じバイナリが full kernel
host となり、その後は同じ CLI コマンドが remote モードで
`http://localhost:<port>` に対して動作する。

## コマンド surface の原則

verb set は小さく、リソースではなく lifecycle で選ばれている。

`server`、`deploy`、`plan`、`destroy`、`status`、`migrate`、`init`、`artifact`、
`runtime-agent`、`completions`、`version`。

アーキテクチャ規則:

- すべての authoring verb (`deploy`、`plan`、`destroy`) は単一の positional
  として Manifest path を取る。Manifest は kernel が推論する単位である。リソー
  ス単位の subcommand を許すと CLI が部分的な DesiredSnapshot を組み立てられて
  しまうため、禁止する。
- top-level の `apply` や `update` は存在しない。`apply` は `deploy` と綴る。
  CLI は常に全体の Manifest を kernel に submit する。current public apply は
  永続化された public deploy record の fingerprint が一致したときに以前のリ
  ソース出力を再利用する。richer な DesiredSnapshot diff は kernel-internal な
  アーキテクチャ作業として残る。`--dry-run` は `mode: "plan"` で同じ
  `POST /v1/deployments` route を選ぶ。だからこそ `plan` は別の pipeline では
  なく thin alias となっている。plan output には kernel が生成する OperationPlan
  の preview digest と WAL idempotency tuple の preview が含まれ る。CLI はその
  payload を描画するだけで、計算はしない。
- `destroy --force` は self-host された resource handle が宣言名と同一で apply
  record が存在しないという狭いケースをカバーする。kernel 側の authority を
  bypass するものではなく、state が無いときに handle 推論を許可するだけである。
- `artifact` と `runtime-agent` はそれぞれ distinct な kernel surface (DataAsset
  store、runtime-agent RPC) を扱うためグルーピングされ、bearer scope
  も別である。
- `init`、`completions`、`version` は純粋にローカルなユーティリティで、ネット
  ワーク呼び出しも Space context も持たない。

## Config の cascade

CLI は remote URL と bearer token を 1 つの固定された precedence で解決する。

1. 明示的なコマンド flag (`--remote`、`--token`)
2. 専用 env (`TAKOSUMI_REMOTE_URL`、`TAKOSUMI_DEPLOY_TOKEN`、
   `TAKOSUMI_AGENT_TOKEN`)
3. config file `~/.takosumi/config.yml`
4. ビルトイン default (URL / token には無し。port は `8788` / `8789`)

env を最初の永続層に置いているのは、shell / CI / supervisor との統合の自然な点
だからである。ファイルがあるのは、シングルホスト operator が shell rc に env を
export しなくて済むようにするためである。

config file の YAML schema は closed (`remote_url`、`token`) である。Space や
profile や routing 決定を表現する場所ではない。これらは kernel 側に属する。
schema を closed に保つことで、ファイルが kernel の operator profile から drift
する第二の真実の場にならないようにする。

## 出力フォーマット

CLI はコマンドごとに安定した出力を出す。主用途が機械処理であるコマンド
(`plan`、`--table` なしの `artifact list`、`artifact kinds`) は default で JSON
を出力する。主用途が operator へのフィードバックであるコマンド (`deploy`、
`destroy`、`status`、`server`) は簡潔なテキストを出力する。

global な `--json` flag は current v1 CLI surface には含まれていない。追加する
には reference とすべてのコマンドテストを変更し、stdout / stderr を決定的に保
つ必要がある。

ストリーミング出力 (live plan progression、interleaved log frame) は v1 には含
まれない。stream された plan は invocation 間でキャッシュや比較ができず CI で の
idempotency 推論を壊すこと、また stream framing は HTTP JSON envelope から drift
する 3 つ目の contract surface を導入してしまうことが理由である。

エラーは upstream kernel が返したときは canonical envelope
`{ code, message, requestId, details? }` として描画される。ローカル CLI の前
提条件失敗はコマンド固有 JSON surface ができるまでは簡潔テキストで描画されう
る。

## Exit code regime

exit code は小さな予約集合である。

- `0` — コマンド成功。
- `1` — コマンド固有の失敗 (kernel ≥ 400、plan / apply 失敗、partial destroy、
  migration 失敗、connector の verify 失敗)。
- `2` — 使い方や前提条件のエラー (不正な flag、必須 env の欠如、remote 専用
  コマンドで remote URL が無いなど)。

70 番台以上は `sysexits.h`
(`EX_OSERR = 71`、`EX_IOERR = 74`、`EX_TEMPFAIL =
75`)
との整合のために予約する。`2` が従来の "usage error" の意味を保ち、将来 の
host-class exit がユーザーが日常的に扱う小さな集合と衝突しないよう、64–69
帯は避ける。

## Warning policy アーキテクチャ

3 つの規則がこれを支える。

- Warning は stderr に出し、stdout には出さない。JSON を出すコマンドや pipeline
  が warning 状態にかかわらず byte 単位で同じであるよう保つため。
- CI ノイズ制御は明示的でコマンドスコープに留まる。コマンドの意味論や出力
  payload を変えない。

## セキュリティ境界

bearer token は CLI 側にしか存在しない。kernel はトークンを echo back せず、 CLI
は kernel に代わって永続化しない。

- トークンは flag、env、または operator が既に所有する config file から読まれ
  る。CLI はトークンをディスク・ログファイル・config file に書き込まない。
- トークンは単一コマンドの実行中だけプロセスメモリに保持される。Manifest、
  emitted artifact、DataAsset、あるいは任意の構造化出力に埋め込んではいけない。
- `runtime-agent serve` は `--token` も `TAKOSUMI_AGENT_TOKEN` も与えられない
  ときに限り、新しく生成したトークンを stdout に **一度だけ** 出力する。これは
  operator がトークンを取得できる唯一の機会だからである。以降の呼び出しは保存
  済みの値を再表示しない。

これにより CLI host の compromise surface を「operator のシェルに既に存在する
もの」に留め、kernel が後で保存する content-addressed artifact に secret が
入らないようにする。

## Manifest 準備の責務

Manifest を kernel に適用可能な状態に変換する作業は 2 つの側で分担され、境界は
固定されている。

- **CLI 側** は local source の content-addressed 準備を行う。`artifact push` が
  bytes を hash し、upload して `{ hash, kind, size, uploadedAt }` envelope
  を返す。operator はその hash を Manifest に埋め込む。raw local bytes を見るの
  は CLI だけであり、path 文字列を kernel に送ることはない。
- **Kernel 側** は namespace resolution を行う。Shape id、provider id、 template
  id、connector id、DataAsset reference は Space-scoped registry に対
  して解決される。CLI cache に対してではない。kernel が unresolved reference を
  返したときに CLI が fallback を発明してはいけない。

DataAsset kind は kernel registry から発見される open string である。CLI は
ローカルに list を拡張したりキャッシュしたりしない。`artifact kinds` は CLI が
現在 register されている kind を kernel に問い合わせるために存在する。

## 関連

- Reference: [CLI](/reference/cli)、
  [DataAsset Kinds](/reference/artifact-kinds)、
  [Environment Variables](/reference/env-vars)、[Manifest](/manifest)
- Architecture:
  [Operation Plan and Write-ahead Journal Model](/reference/architecture/operation-plan-write-ahead-journal-model)
