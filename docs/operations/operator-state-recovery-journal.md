# SOURCE recovery の private retry journal

`scripts/lib/operator-state-recovery-journal.ts` は、将来の private one-shot
operator host が `OperatorRecoveryJournal` として渡せる source-only の Node/POSIX
保存層です。現時点で host、CLI、route、認可入口はありません。これを開くだけでは
state recovery は実行されません。

host は事前に作成した絶対パスの owner-matched `0700` 物理ディレクトリと、
実際の source checkout の完全な一覧を `openOperatorStateRecoveryJournal` に渡します。
最初の intent より前に、host が root と必要な新規 ancestor の directory entry を
durably provision し、各 entry に必要な親 directory の `fsync` 等を完了します。
この adapter は root を作成せず、親 chain も同期しません。root 内の file と
directory を `fsync` しても、未同期の親にある root 名が power loss 後に残るとは
証明できません。実 filesystem と device での同期・power-loss 挙動の qualification も
future host の責務です。portable fault test は root entry の power-loss survival を
検証しません。再起動時に root が欠落または別 inode なら、host は空の root を
作り直して `read(undefined)` とみなさず、private inventory へ停止します。
factory は再起動を越える永続 root anchor を持たず、開けたことだけでは既存 journal
custody を証明できません。host 側の永続 root identity 確認は activation の必須条件です。
実 filesystem/device の file と directory `fsync` が未資格または非対応なら
この journal を使用しません。
ディレクトリは checkout とその `.git` ancestor の外に置き、共有ホストや共有
filesystem には置きません。journal は `close()` まで directory FD を保持し、
各操作で path と FD の inode、owner、mode を再検証します。record は `0600`、
single-link の 64 KiB 以下の正準 UTF-8 JSON で、失敗した Apply ID から
domain-separated SHA-256 で作ったファイル名を使います。ID を path に直接使いません。
intent は固定 actor、ID、timestamp、digest だけ、staged はその intent と opaque
artifact handle だけを保存します。state bytes、credentials、provider success の主張は
保存しません。

intent と staged は独立した no-replace slot です。完全な temp file の `fsync`、
hard-link による no-replace publication、directory `fsync`、temp の unlink、再度の
directory `fsync`、正準 readback の順に完了したときだけ書き込み成功を返します。
同じ slot の exact retry のみ受け入れ、異なる actor、scope、time、handle を拒否します。
staged の書き込みには完全一致する durable intent が必要です。link 後の
acknowledgement を失った場合、final の二つの link が唯一の正規 temp と同じ inode、
body、属性であると検証できるときだけ directory sync と unlink を再実行します。
final のない intent temp は未解決として拒否し、新しい recovery Run ID を発行させません。
final のない staged temp は authority として採用せず、同じ intent と artifact 座標で
stage を再試行します。曖昧な link、変更された path、壊れた body、同期失敗は
generic refusal になり、手動の private inventory が必要です。

この耐久性は、[Node `FileHandle.sync()`](https://nodejs.org/docs/latest-v22.x/api/fs.html#filehandlesync)
と [Linux `fsync(2)`](https://man7.org/linux/man-pages/man2/fsync.2.html) が説明する
local filesystem と device の同期保証に依存します。同一 UID の敵対者による瞬間的な
path swap、rollback、native `openat` 相当の完全な防御は提供しません。operator が
directory とその親 path を排他的に管理することが前提です。

再試行前には、既存 intent、stage artifact の exact readback、failed Apply、Core
lineage と現在の authority を独立に確認します。operator 認証と選択 state の custody、
R2 の actual drill、Core commit の可否は別の gate です。過去の source attempt の
replay、import Destroy、operator data の直接編集をこの journal は許可しません。
