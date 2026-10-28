# Source polling と archive retirement

Source の観測と退役は、platform Worker の既存 `*/5 * * * *` tick から自律的に動く。
operator の private/production cron 設定をこの作業で変更する必要はない。
従来の polling 用 `0 * * * *` / `5 * * * *` と retirement 用 `15 3 * * *` も利用できる。

既存 `audit_events` の予約内部 scope `__source_maintenance__` に、job ごとの開始 Activity を
1つの条件付き INSERT で記録する。直前の開始から polling は1時間、retirement は24時間以上経過した
場合だけ claim できる。重複 tick と専用 cron は同じ marker を使い、DDL は追加しない。
開始記録は成功を意味しない。claim 後の失敗は job の診断を確認し、次回 interval または明示的な
operator recovery で再開する。片方の job の失敗はもう片方の実行を妨げない。

Worker と Node/Postgres の双方で `TAKOSUMI_SOURCE_RETIREMENT_SWEEP_ENABLED=0` を指定すると
自動 retirement を停止できる。省略時は有効。Source polling はこの flag の対象外。
Node/Postgres は起動60秒後と以後24時間間隔で sweep する。

app-owned Source は所有アプリが destroyed の場合にだけ sweep 対象となる。
legacy ownerless Source は古いという理由だけでは削除せず、operator が明示的に `retiringAt` を
付けたものだけを再開する。非終端 install plan の参照が残る Source は保留する。
destroy Apply の応答では archive を削除せず、sweeper が回収する。

削除前に Source 全体の key prefix に対する foreign reference と custody を検査し、1回最大32個を削除する。
進捗は Source JSON に保存し、後続 invocation が再開する。既にない object は削除を省略する。
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
