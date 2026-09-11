# Workspace の管理停止: 実装設計

2026-09-08。管理移管に必要な local quiescence の内部実装方針です。
**内部実装中であり、停止・移管 API の提供を示しません。** 現行の挙動は
[Core Spec](./core-spec.md)が正本です。管理移管は資源の削除、供給契約の終了、
アプリ利用者の移行とは別の操作です。

## 所有する状態

既存 Workspace 行に private な `management_state` と `management_epoch` を
追加します。public Workspace JSON、新しい operation ledger、共有 Host lease、
全管理者共通の registry は作りません。

```text
active → draining → frozen → released
          └─ 明示的な中止 → active
```

- 既存行と新規行は `active`、管理 epoch は 1 から始めます。
- `active → draining` と、中止による `draining → active` で管理 epoch を進めます。
  停止前の admission、承認、queue、coordinator が後から通常実行に戻ることを防ぎます。
- `frozen` と `released` への前進は状態・epoch の CAS で行います。
- `released` は終端です。再ログイン、credential refresh、scheduler では復帰しません。
  release を外部から開始する API はこの最初の実装に含めません。

Capsule の `executionAuthorityEpoch` は変更しません。それは OIDC activation と
runtime grant に束縛されており、管理を止めるための流用はアプリの日常権限を
失効させます。管理 epoch をそれらの digest やログインに混ぜません。

`putWorkspace`、personal bootstrap、通常の metadata 更新は private column を
上書きしません。SQL の insert default と、update 対象の明示的な分離が必要です。
特に D1 の汎用 upsert に default を含めて停止状態を初期化しないようにします。

## 新規実行と収束を分ける

| 操作 | draining 中の扱い |
| --- | --- |
| 新規 Plan、Apply、Restore、承認、SourceSync、auto-update、configuration、rebind、initial authority | 拒否。既存 idempotency 結果の読み取りは許すが、欠けた後続処理を生成しない |
| 一度も実行 claim されていない queue・承認待ち | 実行しない。各種別の既存 terminal 表現で停止を永続化してから blocker を解消する |
| 実行歴のある queued retry | 未開始 queue と区別する。再 dispatch せず、結果照合・復旧が済むまで blocker とする |
| 停止前から running | 同じ Run と正しい lease に限り heartbeat、結果、state commit、既存 finalizer を許す |
| stale-running | heartbeat 失効だけで旧 executor の終了としない。通常の実行 takeover は止め、既存結果と finalizer の回収に限定する |
| SourceSync の成功 | Snapshot と結果を保存し、stale 表示は更新できる。後続 auto-update の新規 Plan は生成しない |
| Git install/revision coordinator | 新規 create・通常 claim は止める。既存 lease の結果確定と canonical evidence による ACK 照合だけ許す |
| Interface materialization、billing、runtime-secret retirement | 既存の同じ durable work item を収束させる。新しい一般的な bypass 権限を作らない |
| 管理対象の設定変更 | Source、Connection、Recipe、Binding、InstallConfig、runtime profile、手動 Interface 変更などは止める |
| 管理者・アプリ利用者のログイン | 継続する。管理停止を認証全体の停止にしない |

停止前に取得した coordinator lease も、新しい Source/Capsule/Plan を作る権限には
なりません。各 durable mutation が同じ Workspace fence を確認します。

既存 credential の通常 refresh と、接続主体・対象・scope を変える replacement は
別です。最初の実装では、同一性を確認できない再承認を recovery として許しません。
設定変更が必要なら release 前に明示的に停止を中止し、通常の変更後に再停止します。
汎用 `allowDuringDrain` flag は作りません。

## 一つの永続化境界

deploy-control store が管理状態を所有します。内部操作は開始、観測、凍結への
CAS に限定し、HTTP route ごとの事前確認を authority にしません。

- Postgres は Workspace 行を最初に lock し、同じ transaction で admission と
  Run、入力、dependency 等の書き込みを行います。凍結判定と blocker を増やす操作も
  同じ lock 順序を使います。別 statement の事前 SELECT だけでは競合を防げません。
- D1 は既存の atomic batch guard を使います。状態・epoch 条件に負けたら batch
  全体を abort し、Run だけ、入力だけといった部分行を残しません。単一 mutation
  では同じ SQL statement に条件を含めます。schema maintenance fence は流用しません。
- Memory は判定と変更を同期的な critical section で実行します。別 domain の Git
  store も同じ管理状態を composition から参照し、async getter と書き込みに分けません。

Git coordinator の store は `core/domains/install-plans/` にあります。独立した
generation/lease の CAS だけでは不十分であり、同じ Workspace fence と束縛します。
Workspace が見つからない admission も拒否します。

Git の blocker 条件は install-plans domain が所有し、PostgreSQL/SQLite の条件式を
観測 query と管理停止 command で共用できる形に分離します。Memory は同じ Map の
同期判定を提供し、async observer はその結果を返すだけにします。composition は
Git と control store が同じ admission validator を参照することを確認できます。
この内部 seam だけでは凍結を許可しません。Run・Interface を含む全条件の確認と
Workspace の更新を同じ atomic boundary に収める private command を実装中です。
HTTP route や管理移管機能はまだ提供しません。

## Workspace の設定・メンバー変更

2026-09-10 の内部候補は、設定・showback 設定・メンバーの追加／役割変更／停止を
準備前の管理 epoch に束縛します。設定は既存 Workspace の全体を比較して置換し、
並行する別の設定変更を古い JSON で上書きしません。公開 Accounts の設定変更は
operator 操作用と入口を分け、保存時にも同じ namespace owner または exact な
active owner/admin member を確認します。途中で権限を失った要求は保存できません。
公開の Workspace/member mutation は Workspace 認可や本文・roster の非同期準備より
前に epoch を一度取得します。取得時の拒否は認可が済むまで表に出さず、保存まで同じ
tuple を渡します。認可中に停止・再開されても、service が新しい epoch を取り直して
古い要求を保存することはありません。

メンバー変更では、Workspace・actor・対象 member（または不在）を同じ保存境界で
確認します。owner の付与／変更は owner に限定し、namespace owner は active owner
のまま保ちます。別の active owner の存在は保存時にも確認し、通常の member reader が
拒否する壊れた identity・roles・timestamp を残存 owner と数えません。新しく保存する
member と比較対象も同じ canonical decoder を通します。
公開の役割変更・停止など owner に限る操作は、その必要権限を内部 command に渡し、
service が読み直した現在の actor にも要求します。認可後に owner から admin へ
降格された要求を、汎用 member 操作の admin 権限で続行しません。caller が渡した
roles を現在の権限として採用するものではなく、保存時の exact actor 比較も維持します。

PostgreSQL は Workspace 行を先に lock し、関係する member 行だけを確認します。
全 Workspace を止める table lock は使いません。D1 は一つの条件付き UPDATE または
INSERT/SELECT/upsert、Memory は await のない比較・書き込みを使います。
raw put は低水準の作成・fixture 操作であり、通常の設定／メンバー変更に使いません。

member 一覧は読み取りだけです。ログイン時の namespace-owner 修復は専用の
active/epoch guarded write とし、停止中は実行しません。owner member が欠けていても
Workspace の ownerUserId による読み取りを維持し、first-page の personal bootstrap は
その Workspace を表示できます。membership の新規作成や、page の total/cursor の
書き換えで表示を補いません。停止前の修復処理が新しい epoch を取り直すこともありません。
owner row が欠けるか古い状態の場合、メンバー操作の認可だけは実際の ownerUserId を
私的な役割表示に反映し、active な管理 epoch に限って Core の修復へ進めます。
公開の member 一覧には永続化済みの行だけを返し、仮の member ID は作りません。

公開停止・中止・移管 API の完成を示すものではありません。複数 Workspace にまたがる
「最後の active Workspace を archive しない」という画面操作の競合は、この単一
Workspace の authority/CAS とは別の残件です。

## Connection の登録

2026-09-10 の内部候補は、汎用 provider と Git source credential の登録を、
既存 Connection 行と暗号化済み secret blob の一つの create-only command にまとめます。
暗号化前に得た Workspace の active/epoch を保存時にも確認し、暗号化の途中に停止した
場合はどちらも保存しません。既存 Connection ID、blob の owner reference または blob ID
が占有されている場合も置換せず、片方だけの保存を認めません。過去の orphan blob も
占有と扱います。DB の後段 insert が失敗した場合は一括処理全体を rollback します。

秘密データのある登録は明示的な partition と対応する blob を同時に要求します。
run-issued など秘密データを持たない登録も、Workspace scope なら同じ管理 epoch に
束縛します。operator scope は Workspace ID と管理 tuple を持てません。この区別を
曖昧な scope や汎用 bypass flag で迂回しません。新規 row は pending から始まります。
公開 Connection schema、暗号文の配置、DDL、provider の扱いは変更しません。

公開 Accounts の汎用 Connection POST は、本文から Workspace ID を確定した直後、
Workspace 認可と残りの非同期準備より前に epoch を取得し、Vault まで内部引数で渡します。
管理停止の拒否は既存の認可・入力検証後に返し、認可中の停止・再開を新しい epoch の
取り直しで通しません。公開 request schema に管理 tuple は追加しません。
公開 Accounts の OAuth も、開始時に同じ境界で取得した tuple を subject・Workspace と
一緒に HMAC 署名した state へ入れ、callback の現在の認可後も同じ tuple を登録と
登録直後の明示的な再検証へ渡します。登録後に停止・再開しても、旧 callback の検証で
新しい epoch を取り直しません。登録済みの行は残り、再検証の未完了を pending と返します。
署名が正しくても tuple のない旧 state は公開 callback で拒否します。state は署名で
改変を防ぐもので暗号化ではありません。内部 bearer OAuth も、認証と Workspace scope の
確認後、helper の非同期準備前に tuple を取得し、callback の登録へ引き継ぎます。
Workspace callback は tuple のない旧 state を拒否し、unknown な保存障害を管理停止の
拒否に置き換えません。Workspace を持たない operator flow は別のままです。
同一 epoch 内の actor 権限変更も保存時に照合します。公開 Accounts は認証済み subject、
OAuth は署名検証済み state の subject を登録と直後の再検証へ渡し、本文や provider 側の
principalSubject を actor に使いません。Vault は暗号化・provider 検証の前に Workspace と
actor member の snapshot を取得します。保存 command は active owner/admin の既存規則と
その exact snapshot を最終 transaction/batch 内で確認し、途中の停止・降格では登録しません。
namespace owner は派生 member 行を必要としませんが、Workspace と owner の照合は省きません。

内部引数の actor は必須で、別の bearer/operator authority の呼出しだけが明示的な `null`
を渡します。省略を内部権限と解釈しません。snapshot は private command にだけ存在し、
Connection・Run の公開 JSON、資格情報、schema/version には追加しません。

## Connection の再検証・削除

明示的な再検証は、Vault 入口で得た管理 tuple、Connection の exact snapshot、実際に
開いた blob の snapshot を一つの保存 command へ渡します。暗号化解除や provider 検証の
await より前に snapshot を保ち、保存直前の読み直しを「検証済みの資格情報」にしません。
検証の成功・失敗・明示的な期限切れ結果のいずれも同じ管理境界で保存します。
資格情報のない接続の `null` は確認済みの不在であり、blob 比較を省く指定ではありません。
公開 Connection の identity や設定はこの command で置換できません。

削除は exact Connection と管理 tuple を照合し、その時点で同じ owner reference に
付属する現在の blob と Connection を一括削除します。blob の rotation は削除対象から
外す理由になりません。Connection がない場合は観測だけで終了し、opaque な orphan blob
を Connection 管理者の権限で削除しません。後段の削除に失敗した場合も両方を残します。

PostgreSQL は Workspace → actor member → Connection → blob の順に必要な行を lock し、最終 mutation
にも exact row/material の条件を含めます。D1 は同じ条件を batch 内で確認します。
Connection の JSON だけでなく物理列も照合し、不整合な owner/status を旧 JSON の権限で
更新・削除しません。operator scope は Workspace tuple を持たず、release 所有の接続を
runtime API から変更することも認めません。

公開 Accounts の明示的 test/revoke も、Connection の所属 Workspace を解決した直後、
認可より前に original tuple を取得し、内部引数で Vault まで渡します。管理停止の拒否は
認可後に返し、他の Workspace に属する Connection は従来どおり非開示の 404 とします。
認可中の停止・再開を、現在の epoch の取り直しで通しません。同一 epoch 内の actor も
登録と同じ snapshot で束縛します。再検証の成功・失敗・明示的な期限切れ結果、削除の
いずれも、最終保存前の停止・降格で Connection/blob を変更せず conflict になります。
無関係な Workspace/member metadata の更新でも保守的に conflict になる場合があります。

この actor の修正は Memory/PostgreSQL/D1 の共通 store、実 Accounts HTTP route、
独立 workerd D1 で確認しています。HTTP と workerd は登録・再検証・削除それぞれの
最終 batch 直前に member を停止し、同じ active epoch のまま書込みが拒否されることを
確認します。ローカル候補の検証であり、live D1 へのデプロイ・移管完了を示しません。

期限切れの観測は、新規設定や資格情報の発行とは分けた単調な状態更新です。既存 Run の
mint は停止中でも期限切れ資格情報を開かず拒否し、観測した exact Connection 行だけを
`pending/verified → expired` に CAS します。他の設定や blob は変更しません。並行更新で
CAS に負けても、新しい資格情報を読み直してその mint を再開せず、元の要求を拒否します。
PostgreSQL の保存制約は追加 migration 114 で既存の operational status 型へ揃えます。
上記の明示的な再検証とは別の経路であり、この単調な期限切れ処理を汎用 mutation の
例外にしません。

既存 Run の mint、release 所有の operator reconciliation、runtime-input の opaque
blob writer を登録 command へ混ぜません。Connection/Vault 全体の管理停止対応完了を
意味するものではありません。

## frozen の成立条件

現在の Capsule、最新 Run、現在 epoch、ページ先頭だけを調べて完了としません。
Workspace に属する未解決の効果と処理全体を、同じ store 境界で確認します。
表示用 blocker 一覧は bounded にできますが、凍結の判定は全対象の `EXISTS` 等で行います。

次のどれかが残れば `frozen` へ進めません。

- 実行中 Run、実行歴のある queue、provider dispatch 後の失敗・結果不明、未解決 Restore。
- 未解決の Git coordinator lease や、side effect の ACK 照合。
- pending、leased、dead-letter の Interface materialization intent。
- terminal Run に残る billing capture、runtime-secret retirement の pending marker。

Run 内の finalizer marker は auditEvents の配列順で判定します。過去の completed が
存在しても、その後に pending があれば未処理です。deferred や無関係な event は完了に
しません。runtime-secret retirement の一覧と dispatch claim も Memory/PostgreSQL/D1
でこの同じ規則を使い、古い completed だけで再び pending になった処理を隠しません。

後続 Run の成功や lease の期限切れだけで、古い executor の効果を確定したと
みなしません。state commit と完了処理は既存の atomic commit/outbox に収束させます。
別の「移管用成功 Run」を作らず、空の Capsule や偽の ApplyRun を importer にしません。

terminal Apply の billing／runtime-secret finalizer は、外部処理前に読んだ Run 全体を
保存時にも照合します。同じ terminal status だけでは、別の処理の completed marker を
古い応答が消せるためです。遅れた completed／deferred の保存が競合したら保存済みの
結果を返し、未処理 marker が残る場合だけ既存の idempotent な後処理を再開します。
この照合は lease のない terminal 行に限り、通常の heartbeat・実行 progress の条件を
変えません。元の private management authority は保存済みの値を維持します。

## 実装順序と受け入れ条件

### 凍結 command が確認する安全性の範囲

2026-09-11 の内部設計判断です。既存の公開 Run/API の意味は変更しません。
凍結は「以後の効果を起こせる未解決処理がない」ことを確定する操作であり、保存済み
全データの完全性検査や、blueprint の再検証とは分けます。内部候補の実装と検証を
進めている段階であり、以下を live 環境で提供済みとは扱いません。

`freezeWorkspaceManagementIfQuiescent` は、観測済みの `draining` と exact epoch を
受け取ります。全 blocker がなければ同じ epoch の `frozen` に更新し、同じ epoch で
既に frozen なら読み取りだけの `existing` を返します。epoch が違う場合や active からの
直接凍結は `conflict`、未処理の仕事があれば `blocked` です。SQL の失敗や欠けた ledger を
「仕事なし」として扱いません。管理を再開する処理や公開の停止操作は追加しません。

Postgres は Workspace 行を先に lock した同じ transaction 内、D1 は全条件を含む
一つの条件付き UPDATE、Memory は await のない全 ledger の観測と更新で実行します。
Memory の Git store は同じ concrete control store を admission validator とする一組を
内部の owning composition から明示的に接続します。組が未接続なら凍結は失敗し、別の
組への差し替えも拒否します。通常の service bootstrap には接続しません。未公開の停止
機能のために既存 store wrapper や、停止とは無関係な起動時の検証を変更しないためです。
DB 版は Run・Interface・Git が同じ DB にある
構成を前提とします。異なる DB や任意の custom store まで横断して凍結を証明する
ものではなく、そのような構成に公開の停止入口を接続してはいけません。

D1 は SQL の長さだけでなく式の深さにも制限があります。上位の AND を balanced tree
にするだけでは、Restore の成功結果から StateVersion・復元元 intent・replacement
intent をたどる式が workerd D1 の深さ制限に達しました。修正では同じ statement 内の
materialized CTE に JSON の正規化と深い判定を分け、一つの条件付き UPDATE に
全 blocker の不存在確認を残します。空の判定群を成功扱いにせず、事前の JavaScript
判定や複数回の書き込みには分けません。
対象 Workspace の行を列挙することと、参照先の ID を検証することも分けます。後者は
元の全体の table を参照し、別 Workspace に同じ deterministic ID の行がある不整合を
「参照先なし」と扱いません。不正な JSON を安全に評価するための代替値も、元の JSON
が正しいという証拠にはしません。SQLite の代替 adapter の成功だけではこの制限を
検出できないため、同じ凍結処理を呼ぶ workerd D1 回帰を受け入れ条件に含めます。
共用の Git blocker 式は Git table の列を無修飾で参照するため、その外側の row scope に
同名列を持つ expected CTE を JOIN しません。対象 ID は scalar subquery で参照します。

- Run は Workspace の全行・全 epoch を対象にし、既知の種別・status と物理列／JSON の
  identity・時刻・heartbeat の一致を要求します。未知または壊れた安全性の情報は blocker
  です。期限にかかわらず lease が残る行、queued/running/waiting_approval は停止済みと
  しません。`runIsInFlight` は別用途で waiting_approval を settled とするため流用しません。
  過去の succeeded Plan でも、non-drift の承認待ちで approval と適用先 Apply がなければ
  既存の RunQueryService と同じく未解決です。RunGroup は管理停止の authority にはしません。
- failed Apply は、対応する失敗 event が明示的に `providerDispatched: false` を示し、
  全 audit history に provider/lifecycle dispatch の肯定的証拠がなく、finalizer も収束済みの
  場合だけ解決済みとできます。state/output/execution evidence がある失敗は未 dispatch
  の表示と矛盾するため blocker です。証拠のない旧行は不明です。開始歴・heartbeat・効果の
  証拠のある cancelled/expired Apply も blocker のままにします。
  旧 queued/DLQ writer は destroy でも `apply.failed` を保存していたため、この既知の
  event も上記の全条件を満たす場合だけ認めます。新規 destroy は `destroy.failed` に揃えます。
- Restore は dispatch 前後の失敗を区別できる永続的な証拠がないため、failed/expired を
  blocker とします。cancelled は未開始を示せる場合だけ解決済みとし、succeeded は対応する
  StateVersion と作成 Run・Workspace・Capsule・環境・復元元の一致、必要な service-data
  receipt と Interface replacement intent を確認します。新しい放棄操作は定義しません。
  復元元の intent は既存 runtime と同じ deterministic ID の順序で解決し、任意の
  stateVersion 一致行への検索で代替しません。
- Interface は completed、両 lease 列の消去、error/dead-letter の不在、正しい作成元と
  deterministic ID、同じ Workspace/Capsule の成功 Run、認められた receipt の形と
  digest/完了時刻の一致、cursor の整合を要求します。pending/dead-letter や不明な
  terminal evidence は blocker です。
  intent が指す StateVersion も同じ Workspace/Capsule/generation と作成 Run に一致する
  必要があります。Restore の復元元も作成 Run の欠落を「宣言なし」とは解釈しません。

Interface の completed 行は既存 claim/retry 経路から新規処理に戻れません。このため凍結
判定では上記の完了証拠を検証し、SQL 内で blueprint schema と暗号学的 digest 検証を
再実装しません。宣言自体の破損は別の完全性の問題として残り、凍結をデータ検証済みの
証明にはしません。新しい汎用 decoder framework や移管用台帳を追加しない方針です。

### 既存の admission と収束の実装状況

現在は最初の内部縦断を実装・検証中です。Workspace の private state/epoch、
Plan/Apply/SourceSync の永続化時の admission、Run の新規 lease claim を対象とします。
Run エンジンでは停止中の queue 再配送を拒否し、停止前に取得した同じ lease の
Apply が結果と既存 finalizer を確定するケースを確認しています。
SourceSync は準備前の管理 epoch を新規作成と stale-running の置換に束縛します。
同じ immutable identity の再送は既存の結果を返し、進行した Run を queued に戻しません。
停止前からの同期結果・Snapshot・stale 表示は保存できます。後続 auto-update は
Capsule の所属 Workspace を確認する atomic claim と新規 Plan admission で止めます。
Git coordinator の新規 create と通常 claim も同じ Workspace fence に接続します。
scope が一致する再送は停止中も既存の進行状態を返し、同じ generation/lease の
結果確定は継続できます。期限切れ lease の取り直しは ACK 回収と区別できないため
許可しません。Accounts では admission 拒否を値を含まない 409 の応答にします。
queued Plan/Apply observer の新しい Interface marker は、実際に保存された
Interface の Workspace を同じ CAS 内で確認します。停止中は marker を増やさず、
既存の terminal observation と materialization intent の収束は継続します。
成功した marker CAS 後の Binding/projection 更新は、開始済み観測の収束です。
Source の作成・設定変更は、準備時の管理 epoch と、変更前の Source 全体を使う
create-only / CAS に分離します。同じ候補が既に保存されている場合は読み取りだけの
再送とし、古い設定からの変更で同期カーソルを上書きしません。同期成功時のカーソルは
Run・Snapshot と同じ commit で、現在の Source の URL・既定 ref・path が一致する
場合だけ更新します。最新の設定を保ち、Source が消えていても再作成しません。
初期 InstallConfig・Capsule・ProviderBinding の一括作成にも同じ Workspace fence を
使います。完全に一致する既存の単位は停止中も読み取れます。サービスが停止を観測済みの
再送では、既定 Project の新規作成や Activity の補完を行いません。
設定変更の successor InstallConfig 作成、Capsule の設定切替、後続 Plan 作成は、
非同期の準備開始前に取得した同じ管理 epoch を保持します。既存 successor の存在は、
停止後に設定・ProviderBinding・実行 epoch を切り替える権限にはなりません。
設定切替では Postgres の Workspace 先行 lock、D1 の batch 先頭の guard、
Memory の非同期処理後の同期判定で、pointer・Binding・intent 更新をまとめて拒否します。
完了済みの設定切替・Plan の読み取りだけは継続できます。停止を観測した設定切替の
再送では lifecycle holder の新規取得や Activity の補完を行いません。
この経路はローカルの実 API と Memory/Postgres/D1 adapter で検証していますが、
実環境の D1 での確認や Workspace 全体の移管完了を示すものではありません。
Project の明示的な作成と既定 Project の補完は、同じ保存境界で Workspace の管理状態・
epoch と Workspace 内の slug 一意性を確認します。競合した既定 Project 作成は保存済みの
行を採用し、後から来た候補の設定や時刻で上書きしません。初期 Capsule の準備時に取得した
管理 epoch は、その途中の Project 補完にも引き継ぎます。
停止中の空の Project 一覧は空のまま返し、ログイン時の Workspace 復旧も新しい Project を
作らず継続できます。この復旧で無視できるのは、同じ Workspace が実際に停止している場合の
Project admission 拒否だけです。他の保存・hook エラーは隠しません。Project の更新 API は
なく、この段階で新しい metadata 更新操作や別の Project 管理状態は作りません。
Capsule 単独作成の公開 POST は既に 405 です。旧内部 `createCapsule` とその入力型も
撤去し、in-process の操作からも初期設定・Capsule・ProviderBinding を一括作成する
既存経路だけを使います。旧データの参照保護テストは明示的な履歴 fixture とし、
その再現のために通常の作成経路を残しません。
汎用 Git install の内部設定準備も単独保存の分岐を持たず、既存行の観測か、
一括作成に渡す未保存の候補生成だけを行います。
Connection の登録・明示的な再検証・削除は上記の管理 epoch と actor snapshot を照合します。
既存 Run の mint 等の別 authority、凍結判定、停止中止時の旧 queue/coordinator 全体の処置は
この局所的な対処だけで対応済みとはしません。
Git install/revision の新規 POST は、Workspace・actor・idempotency key hash の
一致する既存結果を read-only に検索してから、新規準備前の管理 epoch を取得し、
そのまま coordinator の新規保存へ渡します。停止中の同一要求は既存結果を返し、
不一致要求は conflict として扱います。古い準備からの新規受理は拒否します。
初期 Capsule サービスも、呼び出し側が渡した管理 authority を取り直さず、
既定 Project と初期設定・Capsule・ProviderBinding の atomic 作成へ渡せます。
停止または epoch 不一致を観測した再送は、既存 Project と結果を読むだけです。
保存済み Git coordinator も最初の authority を private JSON に保持し、次回の
claim と Source/SourceSync・初期 Capsule・最終 Plan の作成へ渡します。
Source の既存 queued row を再送する場合も、同じ管理 epoch を確認します。
この接続は内部候補に実装したもので、公開の停止・中止・移管 API ではありません。
この段階の候補を Workspace 全体の停止機能として有効化してはいけません。
queue repair の事前確認と、外部 queue への送信は atomic ではありません。停止と
競合した遅延配送は、永続 store の新規 lease claim で拒否します。SourceSyncRun の
新規作成は準備前に取得した authority を必須とし、既存 `run_json` の private field
に保存します。consumer と queue は ID だけを渡し、store が保存済みの元の epoch を
同じ claim の条件に使います。中止後 active N+2 に戻っても旧 N の queued row は
実行できず、呼び出し側が current N+2 を指定しても保存値を置き換えません。
public Run/API/schema は増やさず、get/list/replay/transition/commit の戻り値から
private field を除外します。更新・heartbeat・terminal commit は保存済みの値を
維持し、入力 payload に紛れた値を新しい authority として扱いません。
authority がない旧 row は観測できますが、新規 claim や current epoch の後付けは
許可しません。すでに実行中の正しい lease は結果を確定できます。D1 の旧 SourceSync
作成処理が二重 JSON 化した row も読み取りで扱い、旧 row の書き換えや権限補完は
行いません。これらは内部候補の修正であり、公開の停止・移管機能ではありません。
権限のない旧 queued row をどう終了・再作成するかは、切替時に明示的に扱う残件です。
読めることや claim を拒否できることだけで、既存の待機処理が自動復旧すると扱いません。
Interface marker の fence だけをもって、観測後の全効果の収束や完全な凍結が成立した
とは扱いません。

1. **Storage と Run/Source の内部縦断。** 両 schema lineage を追加型で拡張し、
   Memory/Postgres/D1 で管理停止と Plan/Apply admission の競合を検証します。
   作成、queue、claim、runner、commit、finalizer の間で停止しても、未開始の
   実行は始まらず、running の正しい lease は結果を確定できることを確認します。
   upsert・再起動で private state が維持され、public projection に出ないことも条件です。
2. **全 admission と coordinator。** install/revision/configuration、周辺設定、
   queue repair、SourceSync 後続を同じ fence に接続します。停止中の GET や同じ
   idempotency key の観測から、後続処理が作成されないことを確認します。
3. **凍結判定。** 上記 blocker を一つずつ残して凍結が拒否され、既存の収束後に
   だけ成功することを確認します。古い lease と epoch の replay も拒否します。

**全 admission と凍結判定が揃うまで live composition に停止の入口を接続しません。**
最初の内部縦断だけで Workspace 全体の安全な凍結や管理移管を提供済みとしません。

### 一度も claim されていない Git coordinator の終了

凍結 command は blocker を観測するだけで、未完了処理を成功や削除に変えません。
Git install/revision store に、未開始の一行だけを既存の `failed` へ終了させる private
command を実装しています。新しい公開 phase、停止 API、reconcile lease は追加しません。

現在の create は generation 0 から始まり、最初の claim は lease の取得と同時に
generation を 1 へ進めます。completion は generation を戻しません。そのため正常な
保存経路の generation 0 と両 lease 列の不在を、claim が一度も成立していない証拠に
使います。Source や InstallConfig 等の ID は事前準備で存在し得るため、その有無だけを
実行歴とはしません。実行歴のある処理を lease の期限切れだけで終了するものではありません。

終了は、exact な `draining` epoch D と、同じ Workspace の保存済み original active
epoch（1 以上 D 未満の安全な整数）の双方に束縛します。停止中止・再停止を経ても
古い未開始の処理は収束できますが、現在の epoch を取り直して再実行する権限は与えません。
初期 phase は preflight のない `syncing_source` または
install の preflight を持つ `creating_capsule` に限定し、同じ canonical な作成・更新時刻と
diagnostic・後続 Run の証拠の不在を確認します。後段の phase と generation 0 が混在する
行を未開始と推測しません。generation、保存 JSON と物理列の identity が一致し、両 lease
列が空の場合だけ変更します。JSON の `0.0` 等を整数 `0` に正規化して blocker を消すことも
しません。Postgres は Workspace 先行
lock と行の CAS、D1 は Workspace 条件と行の snapshot を含む一つの UPDATE、Memory は
同じ同期的な validator と Map の更新を使います。確認後の await と無条件保存には分けません。

変更するのは phase、既存形の固定 diagnostic、updatedAt と completedAt だけです。
公開の既存 request と private な元の authority はそのまま残し、同じ scope の再送から
処理を作り直しません。既に terminal の行は変更せず conflict と現在の行を返します。
Memory の通常 completion も、保存済みの空でない lease token と入力の一致を要求します。
両方の token が未指定であることを一致と扱い、終了済みの行を復活させることはありません。
generation が進んだ行、片方でも lease が残る行、来歴のない旧行、不正・不明な行は
この command の対象外です。HTTP/queue caller に接続した全自動の停止操作や、残る
Run の cancellation、管理停止の中止・移管を完成済みとするものではありません。

### 停止中の Plan / Apply の取消し

内部候補の `settleRunDuringDrain` は、Plan / Apply では既存 RunEngine の取消し処理を共用します。
新しい ledger、公開 Run status、HTTP route、任意の停止中書込み flag は追加しません。
未開始の queued Plan / Apply と、未承認・未適用の承認待ち Plan を対象にし、旧
`succeeded` 表現の承認待ちも既存 projection と同じ条件で扱います。

既存 `transitionRun` の収束専用条件で、現在の exact な draining epoch D、保存した
original active epoch、読み取った Run 全体、物理 identity/status/heartbeat と lease の
不在を一度の保存で確認します。取消しは現在の D が認める収束であり、original epoch は
D 未満であれば有効です。停止中止・再停止を経た古い未開始 Run を D-1 の条件だけで
永久に残さず、現在の epoch を取り直して通常実行する権限も与えません。

変更は既存の cancelled status、取消し event の一回の追記、更新・終了時刻だけです。
元の admission と履歴・実行結果は維持します。競合では上書きせず既存 Run を返し、
成功した Plan の入力削除と terminal observer は従来の取消し経路を使います。
取消し前の必須・存在する任意の時刻は、既存の凍結判定と同じ非負の安全な整数として
検証します。不正な更新・終了時刻を取消しの時刻で置換し、壊れた停止証拠を正常化
しません。Postgres の JSONB は数値 `1.0` と `1` を等しいとみなすため、読み取った
JavaScript 値の比較だけでなく保存 JSON の整数表現と物理列も最終 UPDATE で確認します。
旧承認待ちに任意の終了時刻がないことは、不正な時刻が保存されていることと区別します。
現在の Workspace lock を先に取得する Postgres、一つの条件付き UPDATE にまとめる D1、
同期的に判定・保存する Memory で同じ条件を適用します。

これは内部の一行の収束処理です。実行済みの結果不明処理、停止・中止・移管の公開操作は
別の残件です。Git command も同じく original epoch を D 未満として扱い、
中止・再停止の後も元の admission を保持したまま未開始の処理だけを収束させます。

### 停止中の未開始 SourceSync の終了

SourceSync の公開 status に `cancelled` はありません。内部の `settleRunDuringDrain`
は Source lifecycle に委譲し、未開始の queued Run だけを既存の `failed` と固定理由
`workspace_management_draining` で終了させます。公開の Plan / Apply cancellation
route は変更せず、SourceSync の取消し API としては提供しません。

開始・heartbeat・終了・解決済み commit・archive digest/size・phase timings・失敗理由が
一つでも既にある Run は対象外です。作成・更新時刻と新しい終了時刻は canonical ISO
文字列とし、作成から更新、終了への時間順序を確認します。不正な時刻や結果を新しい
終了 payload で正常化しません。変更するのは status、固定の error/errorCode、更新・
終了時刻だけで、heartbeat を新しく付けません。
`snapshotId` と `archiveRef` は同期の作成時に割り当てる identity であり、実行結果の
存在とは区別してそのまま保持します。ID があるだけで開始済みと判断しません。

Plan / Apply と同じ `expectDrainSettlement` により、現在の exact な draining epoch、
保存済みの元の active epoch、Run 全体、lease 不在を一度の保存で照合します。
永続 adapter は物理列の Source ID、Workspace、Run 種別・status、作成時刻、Capsule と
heartbeat の不在も確認します。旧二重 JSON 行を読み取り時に復元できることは、
その行を収束対象として正常化する許可ではありません。停止中止・再停止後の古い Run
も元の authority を保持し、現在の epoch を新しい実行権限として取り直しません。

この処理は runner、credential mint、Source cursor、SourceSnapshot、auto-update に
触れません。開始済み SourceSync の結果確定は既存の lease-fenced commit が引き続き
所有します。ここまでの実装だけで公開の管理停止・移管が完成したとは扱いません。

### 停止中の未開始 Restore の取消し

内部の `settleRunDuringDrain` は、未開始の queued または waiting_approval の Restore
を、既存の `cancelled` と終了時刻だけで収束させます。同じ `expectDrainSettlement`
で管理状態、元の authority、Run 全体、物理列と lease 不在を一度の保存で確認します。
作成・終了時刻は canonical ISO で順序を確認し、開始・heartbeat・終了・復元結果・
実行 receipt・失敗理由が既にある Run は対象にしません。

`backupId`、`restoreStateGeneration`、`restoredFromStateVersionId`、`planDigest` は
作成時に選ぶ復元元の identity です。実行結果の `restoredStateVersionId` や
`restoredServiceData` と区別して保持します。StateVersion、Output、Capsule、Interface
の変更、runner の呼出し、Activity の追加は行いません。

既存の Restore observer は started/failed で Interface を Unknown にし、succeeded
で照合します。未開始の取消しにはどの phase も当てはまらず、observer は呼びません。
新しい cancelled phase を追加したり、failed として通知したりしません。公開の
Plan / Apply cancellation route も拡張しません。開始済みの失敗・結果不明 Restore
は引き続き blocker であり、この操作で放棄・削除できるものではありません。

### 手動 control export の開始・結果確定

内部候補の手動 Backup は、元の管理 epoch を保持した `beginBackupRun` で
running Run を作成してから、artifact の生成・保存を始めます。Memory は同期の
判定と作成、Postgres は Workspace を先に lock する transaction、D1 は batch
先頭の管理状態・epoch guard と create-only insert を使います。Run ID が既に
存在する場合は開始を拒否し、既存の export を再実行・上書きしません。

Accounts と内部 backup POST は、Workspace が判明した時点で認可処理の前に
epoch を取得し、停止・再開を挟んでも取得し直しません。取得時のエラーは認証・
Workspace 権限の確認後にだけ返します。サービスを直接呼ぶ場合も、非同期の
Workspace 取得や export 準備より前に取得します。開始済みの export の完了・
失敗記録は停止中も継続します。公開 Run/API schema や DB schema は増やしません。

手動 export の結果は `commitBackupRun` が一括確定します。保存済みの original
authority と exact な running Run を確認し、成功時の BackupRecord の新規保存と
terminal Run への更新を同じ transaction / batch / Memory critical section に
入れます。失敗時は record を作りません。停止中の完了は許しますが、占有された
record、書き換わった Run、authority のない旧 Run を上書き・補完しません。
同一の terminal Run と record の再読取りだけを replay とし、成功から失敗への
書き換えは拒否します。保存の応答が失われた場合も、失敗を推測して別の terminal
結果を書きません。確定後の Activity 保存失敗は export の成功記録を取り消しません。

control export は自分の Backup Run を必ず作ります。製品内の呼出し元が使っていなかった
`CreateBackupRequest.createdByRunId` の特例は削除し、この入力は明示的に拒否します。
任意の Run ID は開始済み処理の証拠にはなりません。保存済み BackupRecord の
`createdByRunId` は実際に生成した Backup Run を示す従来の意味のまま残し、履歴を
書き換えません。これで control export の開始・確定は同じ経路に揃いますが、
他の raw Run writer の撤去・限定は残件です。
この局所修正だけで全 blocker が単調に収束する、凍結・移管できる、完全な
Workspace backup / restore を提供できる、とは扱いません。

### 互換性チェックの開始・結果確定

互換性チェックの新規開始も既存 Run store の `beginCompatibilityCheckRun` に
集約します。Source の所属 Workspace が分かった直後、Snapshot・policy 等の
非同期準備より前に管理 authority を取得し、最終保存時の active/epoch と照合します。
新しい running Run と original tuple は一括で作り、拒否時に analysis や report の
保存を始めません。公開 request/Run schema、DB schema、仕様 version は増やしません。

内部呼出しは新規の取得か、すでに取得した authority の転送かを明示します。
Git coordinator、configuration、re-adoption、Plan からは最初の tuple を渡し、
保存値のない旧処理は `null` として渡します。引数の欠落を現在 epoch の取得に
置き換えません。Accounts と内部 API は認可の非同期処理前に取得し、取得エラーは
認証・Workspace scope の確認後に返します。

exact な terminal Run/report の組は停止中も読み取りだけで返します。開始済みの
deterministic running Run は、保存済み original tuple と同じ authority を持つ場合
だけ同じ ID で再開できます。新規候補の時刻で既存 Run の開始時刻を上書きしません。
別の identity、terminal 行、authority のない旧 running 行を採用・補完しません。
元の tuple を持っていても停止後に欠けた child Run を新しく作ることはできません。

結果は `commitCompatibilityCheckRun` が一括確定します。保存済み original authority を
持つ exact な running Run と report ID の未使用を確認し、report の新規保存と
terminal Run の CAS を同じ保存処理に入れます。完了時には現在の active/epoch を
取得し直さず、停止前に受理した処理の結果確定を許します。report の source・snapshot・
Capsule と Run の一致を確認し、開始時の identity や他の Run field を変更しません。

report の比較は既存の保存 column と optional field の既定値に揃えます。Memory と
Postgres/D1 の JavaScript 表現の違いを、別の結果や上書きの理由にしません。
時刻も含む exact な terminal Run/report だけを store の read-only replay とします。
同時解析の一方が先に確定した場合、異なる候補は conflict となり、deterministic な
呼出し側は実際に保存された exact identity の terminal 組だけを返せます。後着候補の
report や時刻で勝者を書き換えません。

running Run と report が片方だけ確定した旧 evidence は再解析・補完せず、明示的な
処置まで拒否します。独立した二つの getter は同時確定の前後で一時的に不完全な組を
観測する場合もあります。その呼出しでは変更せず、次の読取りで完了済み組を確認します。
commit の応答が失われても失敗と推測して別の terminal を書きません。deterministic な
完了済み evidence で解決できない場合は元の保存エラーを維持します。

この一括確定は、同時に走る解析そのものを一つにする lease protocol ではありません。
残る raw writer の限定、全 blocker の収束と frozen の atomic 判定、旧 partial evidence
の処置は別の残件です。これらを満たすまで公開の停止・移管 API を有効化しません。
局所テストの成功は live D1 や管理移管の実証ではありません。

### Plan・Apply・Restore の永続 authority

内部候補では、SourceSync と同じ保存境界を Plan・Apply・Restore にも使います。
新規の `preparePlanRun`、`beginApplyRun`、`beginRestoreRun` は、準備前に取得した
active Workspace tuple を必須とし、管理状態の確認と同じ原子的な保存で既存 Run JSON
の private metadata に保持します。Restore は backup・Capsule・StateVersion の
取得より前に tuple を確保します。公開 Run schema、queue payload、DDL は増やしません。

- 新しい lease は、Run に保存した original tuple が現在の active Workspace と一致
  する場合だけ取得できます。呼び出し側が再開後の epoch を渡しても置換・補完しません。
- 停止中は `startedAt` のある queued retry を未開始の queue と区別し、結果照合・
  復旧まで blocker とします。同じ active epoch 内で、runner が既存の契約で安全性を
  保証する再試行や結果の再取得は妨げません。stale-running takeover も従来の lease・
  heartbeat 条件に従います。停止中と中止後の旧 epoch は上記 tuple の照合で拒否します。
- 全 Run の raw writer、状態遷移、Apply/Plan と Restore の atomic terminal commit は
  既存 private metadata を維持します。caller payload からの後付け・置換は認めず、
  public get/list/transition result からは常に除外します。
- tuple のない旧 row は観測できますが、新しい lease は取得できません。既存の正しい
  lease による heartbeat・結果確定・finalizer は停止中も継続できます。停止中の exact
  existing admission は読み取りだけで、新しい行や不足する準備を作りません。

Plan/Restore の承認 mutation も、同じ store の条件付き更新で保存済み original tuple と
現在の active Workspace を照合します。新しい lease を取らない承認にも、この内部条件を
明示します。停止前の承認待ちを再開後の epoch で承認し直さず、tuple のない旧 row にも
権限を補いません。承認済み Plan、queued/running/succeeded の Restore の再読取りは
変更しません。承認待ちのまま更新を拒否した場合は成功として返さず、新しい activity や
queue を作りません。既存 lease の heartbeat・結果確定にこの承認条件は適用しません。

旧 queued row の終了・再作成方針、および Workspace 全体の frozen 判定は別の残件です。
claim・承認の拒否だけを移管の完成とはしません。

### 自動更新の後続作成

停止前から実行中の SourceSync と Plan は、再開後も同じ lease で結果を確定できます。
その完了を、新しい epoch で後続を作る承認として扱いません。内部の
`getRunManagementAuthority` は Run ID・Workspace・Run 種別が一致する保存行から
original tuple だけを返します。SQL の物理 identity と JSON の identity を照合し、
現在の管理状態から補完しません。tuple のない旧行や不正な行は後続作成に使えません。
public getter・queue payload・Run schema は従来のままです。

- SourceSync は結果・Snapshot・stale 表示を保存した後、元の tuple を auto-update の
  試行 marker と新規 Plan の両方へ渡します。marker は新規 admission として同じ
  atomic UPDATE/transaction で active/epoch を照合します。完全一致の保存済み marker
  の再読取りは、停止中も新しい変更を伴いません。
- Plan の automatic Apply も、親 Plan に保存した tuple を準備前から保持し、Apply の
  admission へ渡します。再開後の現在値を取り直して旧 Plan から新規 Apply を作りません。
  手動で明示する Apply は既存の現在の管理状態での admission を維持します。
- authority が欠けるか変わった場合は自動後続だけを拒否し、成功済み SourceSync/Plan の
  結果を取り消しません。既存の一試行 marker と Activity の扱いを維持します。

Memory/PostgreSQL/D1 parity、実 controller の drain/resume 後の完了、および独立した
workerd D1 の marker UPDATE 直前の競合で確認しています。再開状態は fixture であり、
公開停止・中止・移管 API の実装や live migration を示しません。

### 設定変更・再採用の永続 authority

設定変更と再採用は、作成済み successor の応答が失われても、元の管理 epoch を
引き継ぎます。途中で停止・中止を経て active N+2 になったことは、N の準備から
設定切替や不足する Plan を作る承認にはなりません。

- deploy-control store が、既存 InstallConfig JSON の private metadata に
  `workspaceManagementAuthority` を保持します。対象は再採用 receipt を持つ
  successor だけです。通常の設定、共有 template、初期設定を作成時の epoch に
  固定しません。新規 successor は準備前の authority を必須とし、サービス側でも
  引数省略時に現在値を取得して補いません。
- metadata は全 InstallConfig 読取りから除外します。公開 contract、receipt、
  derived seal、Plan/OIDC の設定 digest に管理 epoch を混ぜません。SQL の
  rebind CAS は metadata を含む保存行を比較し、digest は除外後の設定を使います。
- 汎用 put でも、既存 metadata を同じ保存処理で維持します。入力からの差替え・
  後付けや Workspace の変更は認めません。receipt が消された行も、保存済み
  private key がある限り元の authority に拘束されます。
- rebind は保存済み authority を使い、呼び出し側の値は一致確認にだけ使います。
  設定変更の Plan が不足する場合も、同じ保存値を設定切替と Plan 作成へ渡します。
  完了済み Plan・設定切替の観測は継続します。metadata がない旧 successor は
  完了済み結果を観測できますが、未完の処理は現在値で承認し直しません。
- 新しい successor は、永続化する JSON に揃えてから seal を計算します。
  未指定の optional field が保存時に消えて初回の読み戻しを拒否する問題を防ぎます。
  過去の行を再 seal せず、共通 digest 関数や公開済み値の解釈も変更しません。

実 Accounts API、Memory/Postgres/D1 store parity、独立した workerd D1 で
再試行と保存処理を検証します。これらは内部候補の実装であり、公開の管理停止・
中止・移管 API や production の移管完了を示しません。

### Git coordinator の永続 authority

2026-09-10 の呼び出し側確認では、POST の新規受理だけでなく、永続化した
coordinator の次回 reconcile と、claim 後の Source / SourceSync / Capsule / Plan
作成まで同じ epoch を保ちます。以下を内部候補に実装しています。

- 準備前に取得した `WorkspaceManagementAuthority` 全体を、既存 `record_json` に
  保存する `StoredGitInstallPlan` の private field として保持します。public
  projection から除外し、coordinator の immutable scope に含めます。追加の
  HTTP field、schema column、operation ledger は作りません。
  新規 store create でも保存する authority は必須です。任意の expected 引数は
  保存する値と同値の場合だけ使え、省略しても保存値による検査を外せません。
  optional field は旧 JSON の読取りのためであり、新規の未承認 row を作るためでは
  ありません。immutable 比較は JSON の key 順序ではなく tuple の各値で行います。
- 次の通常 claim は保存済みの authority を使います。停止前 N、draining N+1、
  中止後 active N+2 をまたいだ row に、現在の authority を取り直して与えません。
  authority のない旧 row は観測・既存 lease の結果確定だけを許し、新規 claim
  や後続作成は拒否します。自動 backfill で旧準備を承認し直しません。
- claim の検査だけでも不十分です。claim 後に停止・中止が起きるため、
  Source 作成と SourceSync 開始にも private な引数で元の authority を渡し、
  既存の atomic store に束縛します。初期 Capsule と Plan も同様です。
  既存の queued SourceSync を見つけても、古い authority で再 enqueue しません。
- 同じ既存 lease / generation の結果確定と、canonical evidence による ACK
  照合は別です。停止を理由に結果記録を捨てたり、結果照合を新しい実行権限として
  使ったりしません。新しい準備として再開する操作と旧 coordinator の処置は、
  停止中止の実装時に詰める課題として残します。

store parity では private projection、authority の差替え拒否、保存値を使う
新規 admission、旧 JSON の観測・既存 lease 完了を検証します。旧 JSON の
fixture は PostgreSQL/D1 にだけ投入し、Memory store に本番の seed 入口を
追加しません。中止後 active N+2 は fixture の状態であり、中止 API の実装を
示しません。Source の実 store と Git HTTP の検証を組み合わせます。
この Git 接続の完成だけで、他の設定 admission や凍結判定まで完成とはしません。
Git HTTP の after-claim 回帰は SourceSync 転送で確認しています。Source 作成、
初期 Capsule、最終 Plan への転送は実装をレビューし、callee 側の guard も検証して
いますが、各 caller の引数削除を HTTP fixture で直接検出する検証は残っています。

## 運用上の限界

schema は protected data として扱い、適用済み migration を変更せず、後続の
追加型 migration にします。失敗は forward repair し、live migration は別の
operator 操作です。移行手順は[既存 runbook](../operations/online-db-migrations.md)を使います。

追加 column だけでは古い runtime が停止を守るようにはなりません。停止入口を
有効にする構成では、旧コードや古い warmed worker を同時の管理 writer として
残せません。これは対応版の協調動作であり、権限を持つ外部 writer の排除ではありません。

`frozen` は旧 Takosumi の協調的な静止を示すだけです。供給元の旧 credential の
失効、新管理先の再承認、移管先での fresh Plan、他 writer の不在は別途確認します。
稼働資源の供給契約やアプリの日常ログインを、この停止だけで取り消しません。
