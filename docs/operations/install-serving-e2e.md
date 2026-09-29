# install → serving E2E を 1 コマンドで回す

`bun run e2e:install-serving` は、既知のアプリ (Yurucommu の Git module) を
対象環境へ install し、**managed runtime が HTTP で期待どおり応答すること**を確認し、
その Capsule を destroy するところまでを 1 回の実行で行います。Takosumi が持つ
canonical な Source → Install plan → Plan → Apply → Output → Destroy の Run 経路を
そのまま使うため、install の正本はこのコマンドのためだけに二重実装されません。

## 何を守るためのコマンドか

- 「plan/apply が緑になった」ではなく「managed worker が実際に応答した」までを 1 つの
  判定にします。HTTP 応答は本文まで検査し、`/healthz`、`/readyz`、
  `/.well-known/social-server`、`/nodeinfo/2.0` が Yurucommu の内容を返すことを要求
  します。status 200 だけでは合格にしません。
- 失敗時に**局面**と**具体理由**を 1 行で出します。局面は product smoke 自身の step
  順から導出するので、`plan`、`apply`、`output`、`serving`、`destroy` のどこで止まったか
  が分かります。理由は対象 Run の `status`、`errorCode`、そして redaction 済みの Run
  diagnostic です。
- source / install plan / compatibility / Plan は product 側で 1 つの coordinator 呼び出し
  として進むため、その途中で失敗すると smoke は step の進捗を記録できません。そこで
  harness は、この run が作った Capsule を app name で特定し、その Capsule に属する
  最新の failed Run から局面 (`plan` など) と `errorCode` を読みます。step の穴だけを
  読むと、実際に失敗した Run ではなく「最初に記録されなかった step」の局面を名乗って
  しまうためです。
- 成功時は destroy まで含めて検証します。destroy 後の公開 URL は 404 を要求します。
- 失敗時にその Capsule が残っていれば `cleanup: capsule ... still exists` と出します。
  harness 自身は destroy を二重に持たず、Run が所有中の mutation に触りません。

## 実行する

```bash
cd ../takosumi
bun run e2e:install-serving -- --workspace <ws_...|@handle> --token-file <path>
```

必要な入力は 2 つだけです。

| 入力 | 意味 |
| --- | --- |
| `--workspace` | 対象 Workspace の id か `@handle`。`TAKOSUMI_INSTALL_E2E_WORKSPACE` でも指定できます |
| `--token-file` | Takosumi Account の PAT (または session) token ファイル。絶対 path、mode 0600。`TAKOSUMI_INSTALL_E2E_TOKEN_FILE` でも指定できます |

それ以外は既定値で固定されています: origin は `https://app-staging.takosumi.com`、
profile は Yurucommu、environment label は `integration`、Source path は
`deploy/takoform`、module path はその subtree からの相対で `.`、
ProviderConnection は Workspace 内の
`registry.terraform.io/tako0614/takoform` 接続です。前身の broker 接続と現行の
renewable 接続が併存する Workspace では renewable 側 (`broker-renewable`) を選び、
それでも候補が割れるときだけ `--connection-id` を明示します。

module path は repository root からではなく、Source path が固定した
SourceSnapshot の subtree から数えます。両方に同じ `deploy/takoform` を渡すと
compatibility check が `repository_install_ux_module_missing` (400) で止まります。

CI で一時的な token を使う場合は、短命で workspace に限定した PAT を作り、その path を
`--token-file` に渡します。token の値は harness からも smoke からも出力しません。

## 見るもの

実行結果は phase 行と最終行です。

```text
[connection] passed
[source] passed
[install-plan] passed
[plan] passed 1.2s
[apply] failed
  run apply_01814d6ba6264540 status=failed errorCode=apply_failed
  diagnostic: apply_failed: renewed credential does not match the pinned binding
  capsule cap_01814d6ba6264540 status=error remains; destroy did not complete
FAIL phase=apply run=apply_01814d6ba6264540 reason=... evidence=<dir>
cleanup: capsule cap_01814d6ba6264540 status=error still exists
```

成功時は `PASS` 行と、応答を検査した URL check の一覧、`destroy` の完了が出ます。
`--json` を付けると最終行が 1 つの JSON オブジェクトになります。終了コードは成功 0、
install/serving の失敗 1、引数エラー 2 です。

証拠は `--evidence-dir` (既定は `$TMPDIR/takosumi-install-serving-e2e/<stamp>`) に
mode 0700 で残ります: `smoke-invocation.json` (token は伏字)、`smoke-result.json`、
`smoke-stdout.log`、`smoke-stderr.log`、`summary.json`。

## 失敗したときの読み方

- `phase=connection`: token の権限、Workspace、ProviderConnection の選択を確認します。
  ここは Run を 1 つも作らない preflight です。
- `phase=source`: `--source-ref` と module path、Source に対する Git 到達性を確認します。
  module path が snapshot subtree からの相対かどうかもここで分かります。
- `phase=plan` / `phase=apply`: Run の `errorCode` と diagnostic を読みます。credential の
  交換や renewal、provider 側の一時的な衝突がここに出ます。
- `phase=serving`: Run は終わっているのに HTTP 検査が通っていません。公開 URL の
  伝播と応答本文、Workers for Platforms 側の routing を確認します。
- `phase=destroy`: 片付けが終わっていません。Capsule と、失敗した apply run の id が
  出ているので、状態を勝手に作り直さずに readback してから前進修復します。

Run を再実行して緑にすることはしません。失敗は失敗として残し、原因側で直します。

## 対象外

- production 環境。ここで使う既定 origin は staging です。
- container を使うアプリ。
- native actor lifecycle (専用 hostname と証明書を含む)。
- provider の Plan/Apply 実装そのもの。install 経路の外側にある変更は、それぞれの
  所有 repo の手順と検証に従います。
