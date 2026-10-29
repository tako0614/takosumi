# Source polling と archive retirement

Source の観測と退役は、platform Worker の既存 `*/5 * * * *` tick から自律的に動く。
operator の private/production cron 設定をこの作業で変更する必要はない。
従来の polling 用 `0 * * * *` / `5 * * * *` と retirement 用 `15 3 * * *` も利用できる。

既存 `audit_events` の予約内部 scope `__source_maintenance__` に、job ごとの開始 Activity を
1つの条件付き INSERT で記録する。直前の開始から polling は1時間、retirement は24時間以上経過した
場合だけ claim できる。重複 tick と専用 cron は同じ marker を使い、DDL は追加しない。
開始記録は成功を意味しない。claim 後の失敗は job の診断を確認し、次回 interval または明示的な
operator recovery で再開する。片方の job の失敗はもう片方の実行を妨げない。開始 marker の書込み失敗も
`source_maintenance_schedule_failed` に記録し、同じ tick の Run repair など後続処理は継続する。

Worker と Node/Postgres の双方で `TAKOSUMI_SOURCE_RETIREMENT_SWEEP_ENABLED=0` を指定すると
自動 retirement を停止できる。省略時は有効。Source polling はこの flag の対象外。
Node/Postgres は起動60秒後と以後24時間間隔で sweep する。

app-owned Source は所有アプリが destroyed の場合にだけ sweep 対象となる。
legacy ownerless Source は古いという理由だけでは削除せず、operator が明示的に `retiringAt` を
付けたものだけを再開する。例外は `createdByInstallPlanId` のある deterministic Source で、
同じ Workspace の creator plan が discard、非 attempt の failed、または attempt の expiry から
24時間以上経過し、Source 自体も作成から24時間以上経過し、Capsule が存在・参照していない場合だけ
mark なしで回収する。Capsule 作成前の予約 `ownerCapsuleId` も、creator から導いた Source / owner ID と
creator の参照が一致し、全状態の Capsule が不在の場合だけ同じ回収対象になる。
任意の missing owner は引き続き拒否する。failed attempt は expiry までは再開可能として保護する。
非終端 install plan の参照が残る Source は保留する。
destroy Apply の応答では archive を削除せず、sweeper が回収する。

削除前に Source 全体の key prefix に対する foreign reference と custody を検査し、1 page 最大32個を削除する。
1 invocation は最大32 page（1,024個）、または page 間で5秒の予算に達するまで継続する。
page ごとの進捗は Source JSON に保存し、後続 invocation が再開する。既にない object は削除を省略する。
他の Source の prefix にある archive はコピーも削除もしない。terminal Run の履歴は残すが、
安全に mark された Source、または `source.retired` Activity がある削除済み Source の履歴参照は
archive の保持権限として扱わない。いずれも live Capsule / in-flight Run がないことを照合する。
active な別 Source の参照は引き続き削除を妨げる。
途中で失敗しても Source / snapshot 行を保持し、最後に ledger の削除と Activity を原子的に確定する。

production retirement の前に、backup と dry-run の確認、独立レビュー、operator の承認を行う。
Source ごとの snapshot 数、distinct archive 数と総 byte 数を計測し、大きい Source については必要な
再開回数と実行時間を確認する。自動掃除を停止したまま棚卸しできる。
production で ownership split を適用する前に、staging で split と完全な re-plan を実施し、
採用済み revision、provider binding、出力とアプリ動作を検証する。
Source ref を書き換える移行は retirement cursor をリセットして直列化する。

この文書は操作手順を示すもので、production 操作の実行記録や承認ではない。

## Hourly polling 開始時の挙動

これまで production で実質実行されていなかった polling が、この変更で既存5分 tick から開始する。
開始 marker がない最初の tick は即時に claim でき、default では due な active / autoSync Source を
最大5件処理する（従来の default は25）。`TAKOSUMI_SCHEDULED_SOURCE_POLL_BATCH` の正の整数で
operator が調整でき、省略・0・不正値は5件になる。各 Source の lane ごとに dedupe した Run を作るため、
Source 数と Run 数は一致するとは限らない。既存 backlog 全体を初回に処理しない。

最初の claim から1時間は、後続5分 tick と専用 hourly cron は polling を重複実行しない。
その後は最終試行時刻の古い Source から次の batch に進む。legacy ownerless / destroyed アプリ由来の
未移行 Source も polling の候補には残るため、最初の5件に含まれる場合がある。default を上げる前に
開始 Activity、Run の成功・失敗と backlog を確認し、ownership migration の棚卸し・明示 mark を進める。
retirement は別の24時間 marker と最大25 Source の予算で動き、polling batch の変更では停止しない。
