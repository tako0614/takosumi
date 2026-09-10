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
| 一度も実行 claim されていない queue・承認待ち | 実行しない。既存 cancellation 表現で停止を永続化してから blocker を解消する |
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

後続 Run の成功や lease の期限切れだけで、古い executor の効果を確定したと
みなしません。state commit と完了処理は既存の atomic commit/outbox に収束させます。
別の「移管用成功 Run」を作らず、空の Capsule や偽の ApplyRun を importer にしません。

## 実装順序と受け入れ条件

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
