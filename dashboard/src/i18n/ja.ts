/**
 * Japanese master dictionary. This file owns the key set: `en.ts` is
 * type-checked against `keyof typeof ja`, so adding/removing a key here forces
 * the English side to follow. Keys are namespaced `area.item`; `{param}`
 * placeholders are interpolated by `t()`.
 *
 * Vocabulary contract (TASK-0115; do not reintroduce サービス / ワークロード /
 * デプロイ / 公開 / 反映 — 「公開リポジトリ」は普通の日本語なのでよい):
 *   Noun: Git で定義され、ストアに並び、インストールされる単位はアプリ
 *   (Capsule)。起動できる Interface は画面、クラウド上の実体はリソース、
 *   資格情報は接続、Workspace はスペース。
 *   Verb: インストール (意図) → 内容を確認 (plan) → 許可してインストール
 *   (apply) → インストール済み。以後は 更新 / 設定を変更 / アンインストール。
 *   すべての面 (ナビ・ホーム・ストア・アプリ・接続・アカウント・通知) が
 *   この語彙を使う。スペースは、2つ以上あるときか、作る・招待する場面に
 *   だけ出す。API の handle (自動生成の `workspace-…`) は名前の代わりに
 *   出さない。
 */
export const ja = {
  "installStore.title": "アプリをインストール",
  "installStore.browseTitle": "アプリを探す",
  "installStore.manual": "Gitリポジトリからインストール",
  "installStore.back": "選び直す",
  "installStore.provenance": "取得元と版",
  "installStore.startHint": "まだクラウドには何も作りません。押すとGitの版を読み、このアプリが作るもの・必要な接続・設定を確認します。途中でやめることもできます。",
  "installStore.sourceRefStable": "最新の安定版",
  "installStore.sourceRefStableHint": "空欄のときは、リリース済みの最新の安定版を使います。",
  "installStore.sheetTitle": "インストール内容",
  "installStore.sheetHint": "このアプリがあなたのクラウドに作るものと、必要な接続・設定です。「許可してインストール」を押すまで、クラウドには何も作りません。",
  "installStore.plannedTitle": "このアプリが作るもの（予定）",
  "installStore.plannedHint": "接続と設定がそろったら「内容を確認」で、正確な一覧と料金の目安を表示します。",
  "installStore.plannedEmpty": "事前に数えられるリソースはありません。正確な内容は「内容を確認」で表示します。",
  "installStore.plannedNotAllowed": "ポリシーで許可されていません",
  "installStore.nameHint": "ワークスペースの中でこのアプリを見分ける名前です。半角小文字・数字・ハイフンで入力します。",
  "installStore.connectionReady": "接続済み",
  "installStore.connectionMissing": "未接続",
  "installStore.connectionNotAllowed": "この接続は、このアプリのポリシーでは使えません。別の接続を選ぶか、別のアカウントで接続してください。",
  "installStore.addConnection": "別のアカウントで接続",
  "installStore.connectionTechnical": "技術情報",
  "installStore.reviewChanges": "内容を確認",
  "installStore.discard": "やめる",
  "installStore.discardUnavailable": "途中のインストールを片付けられませんでした。アプリ一覧で状態を確認してください。",
  "installStore.allowInstall": "許可してインストール",
  "installStore.costTitle": "料金の目安",
  "installStore.costRatedZero": "見積もり額は {amount} です。",
  "installStore.costNotApplicable": "このワークスペースでは Takosumi は料金を計算していません。作られるリソースには、各クラウドの料金がかかります。",
  "run.cost.unavailable": "料金の目安を取得できませんでした。料金は不明として扱ってください。",
  "installStore.moduleTitle": "モジュールを選択",
  "installStore.moduleHint":
    "このリポジトリの版で見つかったモジュールから、インストールするものを選びます。末尾は必要なプロバイダーです。",
  "installStore.moduleOption": "{path} — {providers}",
  "installStore.moduleNoProviders": "プロバイダー不要",
  "installStore.moduleChoose": "モジュールディレクトリ",
  "installStore.moduleConfirm": "このモジュールで続ける",
  "installStore.moduleUnavailable":
    "このリポジトリ版のモジュールを安全に特定できませんでした。",
  "installStore.moduleMissing":
    "このリポジトリの版には、インストールできるモジュールがありません。",
  "installStore.moduleRequirements": "プロバイダーの詳細",
  "installStore.sourceSummary": "構成と接続",
  "installStore.selectedModule": "構成",
  "installStore.sourceScope": "リポジトリ内の範囲",
  "installStore.detectedProviders": "このモジュールのプロバイダー",
  "installStore.noProviderPackages": "このモジュールからプロバイダーパッケージは検出されませんでした。",
  "installStore.requiredConnections": "必要な接続",
  "installStore.noRequiredConnections": "このモジュールにプロバイダー接続は必要ありません。",
  "installStore.connectionNotSelected": "未選択",
  "installStore.moduleRequirement":
    "{source}・モジュール {module}{alias} {version}",
  "installStore.stepReview": "確認",
  "installStore.name": "アプリ名",
  "installStore.sourceDetails": "取得元と版",
  "installStore.sourceUrl": "Git URL",
  "installStore.sourceRef": "版（tag・branch・commit。省略可）",
  "installStore.sourcePath": "リポジトリのサブディレクトリ（省略可）",
  "installStore.modulePath": "モジュールのフォルダ（省略可）",
  "installStore.sourceAuth": "Git接続",
  "installStore.publicSource": "公開リポジトリ",
  "installStore.selectValue": "選択してください",
  "installStore.yes": "はい",
  "installStore.no": "いいえ",
  "installStore.viewApps": "アプリ一覧",
  "installStore.installedNeedsAttention": "インストール済みですが、対応が必要です。管理画面で状態を確認してください。",
  "installStore.refreshLaunch": "起動URLを再確認",
  "installStore.selectWorkspace": "ワークスペースを選択すると、このアプリの状態を確認できます。",
  "installStore.noLogs": "ログはまだありません。",
  "installStore.closePanel": "閉じる",
  "installStore.needsAttentionTitle": "対応が必要です",
  "installStore.uninstall": "アンインストール",
  "installStore.manageConnections": "接続を管理",
  "installStore.manageApp": "アプリを管理",
  "installStore.cloudConnection": "クラウド接続",
  "installStore.cloudConnected": "接続済み。インストールできます。",
  "installStore.closeConnections": "設定に戻る",
  "installStore.advancedSettings": "詳細設定",
  "installStore.appDescription": "必要な設定を選んで、このワークスペースにインストールします。",
  "installStore.noLaunchUrl": "このアプリには起動URLがありません。アプリの管理画面から状態を確認できます。",
  "installStore.uninstalling": "アンインストールを予約しました",
  "installStore.uninstalled": "アンインストール済み",
  "installStore.logs": "進捗とログ",
  "installStore.retryInstall": "インストールを再試行",
  "installStore.applyUnconfirmed": "実行結果を確認できませんでした。再実行せず、実行履歴で状態を確認してください。",
  "installStore.preparing": "インストールの準備をしています",
  "installStore.preparingFetching":
    "リポジトリを取得しています。初回は1分ほどかかることがあります。",
  "installStore.preparingWorkspace": "選択中のワークスペースを確認しています。",
  "installStore.preparingConnections": "利用できる接続を確認しています。",
  "installStore.preparingSource": "リポジトリの内容を取得しています。",
  "installStore.preparingCompatibility":
    "この環境でインストールできるか確認しています。",
  "installStore.preparingConfig": "アプリの設定項目を準備しています。",
  "installStore.preparingPlan": "確認用の変更内容を準備しています。",
  "installStore.preparingTimeout":
    "準備に時間がかかりすぎました。クラウドには何も作っていませんが、リポジトリの登録結果を確認できませんでした。登録状況を確認してから再試行してください。",
  "installStore.sourceRegistrationUnconfirmed":
    "クラウドには何も作っていません。リポジトリの登録結果を確認できませんでした。「インストール」をもう一度押すと同じ試行を確認します（リポジトリが重複して登録されることはありません）。",
  "installStore.sourceBaselineUnavailable":
    "クラウドには何も作っていません。一時的にリポジトリの一覧を確認できなかったため、登録を開始しませんでした。少し待ってから「インストール」をもう一度押してください。",
  "installStore.sourceAutoSyncFailed":
    "ソースの自動更新を有効にできませんでした。再試行すると、このアプリの自動更新を有効にします。",
  "installStore.providerHint":
    "選択したプロバイダー / モジュールに必要なホスト / アカウントだけを選びます。",
  "installStore.chooseConnection": "ホスト / アカウントを選択",
  "installStore.destination": "ホスト / アカウント",
  "installStore.destinationSummary": "ホスト / アカウント: {destination}",
  "installStore.providerModule": "プロバイダー / モジュール",
  "installStore.connect": "接続する",
  "installStore.continue": "続ける",
  "installStore.setupTitle": "設定",
  "installStore.sourceBuildTitle": "リポジトリのビルド手順",
  "installStore.sourceBuildHint":
    "変更の確認を始める前に、認証情報を使わないコマンドと生成されるパスを確認してください。",
  "installStore.sourceBuildCommand": "コマンド {index}",
  "installStore.sourceBuildWorkingDirectory": "作業ディレクトリ",
  "installStore.sourceBuildSourceRoot": "リポジトリのルート",
  "installStore.sourceBuildOutputs": "生成されるパス",
  "installStore.setupUnavailableTitle": "アプリの設定を表示できません",
  "installStore.secretSetupUnavailableTitle": "シークレットを設定できません",
  "installStore.optionalFeatures": "オプション機能",
  "installStore.sourceBuildArguments": "コマンドの引数",
  "installStore.setupInvalid": "アプリの設定定義が無効です。",
  "installStore.setupRequired": "{label}を入力してください。",
  "installStore.secretUnavailable":
    "このシークレットは接続として設定してください。",
  "installStore.reviewing": "変更内容を確認しています",
  "installStore.reviewingHint": "インストールする前に変更内容を確認しています。",
  "installStore.reviewTitle": "このアプリがあなたのクラウドに作るもの",
  "installStore.reviewHint": "内容を確かめたら「許可してインストール」で適用します。それまでクラウドには何も作りません。",
  "installStore.reviewReady": "確認できます",
  "installStore.changes": "変更数",
  "installStore.createCount": "作成",
  "installStore.updateCount": "変更",
  "installStore.deleteCount": "削除",
  "installStore.approve": "この変更を承認",
  "installStore.confirmTitle": "確認が必要な変更があります",
  "installStore.confirmHint":
    "削除または明示承認が必要な変更を含みます。内容を確認してください。",
  "installStore.confirm": "変更内容を確認しました",
  "installStore.install": "インストール",
  "installStore.runDetails": "技術的な詳細",
  "installStore.installing": "インストール中",
  "installStore.installingHint": "バックグラウンドでインストールを続けます。後から進捗を確認できます。",
  "installStore.planBlocked": "この内容はインストールできません",
  "installStore.planBlockedHint":
    "ポリシーまたは変更内容の詳細を確認してください。",
  "installStore.readinessFailed":
    "アプリの起動準備を確認できませんでした。技術的な詳細を確認してください。",
  "installStore.activationFailed":
    "アプリの起動準備に失敗しました。技術的な詳細を確認してください。",
  "installStore.finalizing": "アプリを準備しています",
  "installStore.finalizingHint":
    "アプリを開くためのリンクが使えるようになるまで待っています。",
  "installStore.launchNotReady":
    "アプリは適用されましたが、起動リンクをまだ確認できません。再確認するか、アプリの管理画面を開いてください。",
  "installStore.runFailed": "インストールを完了できませんでした",
  "installStore.restartWithLatestSource": "最新のソースでやり直す",
  "installStore.restartConfirmTitle": "最新のソースで最初からやり直しますか？",
  "installStore.restartConfirmMessage":
    "未適用のアプリを破棄し、同じ名前でリポジトリを取得し直します。失敗した変更の確認は履歴に残ります。",
  "installStore.restartUnavailable":
    "未適用のアプリを安全に破棄できなかったため、最初からやり直せませんでした。技術的な詳細を確認してください。",
  "installStore.doneTitle": "インストール完了",
  "installStore.open": "開く",
  "installStore.chooseAnother": "別のアプリを探す",
  "installStore.invalidSource": "有効なhttpsのGit URLを入力してください。",
  "installStore.invalidName":
    "アプリ名は半角小文字・数字・ハイフンで入力してください。",
  "installStore.planMissing": "変更の確認を開始できたか確認できませんでした。",
  "installStore.listingUnavailable":
    "このアプリをストアから取得できませんでした。",
  // --- common -------------------------------------------------------------
  "common.loading": "読み込み中…",
  "common.retry": "再試行",
  "common.refresh": "更新",
  "common.creating": "作成中…",
  "common.cancel": "キャンセル",
  "common.save": "保存",
  "common.saving": "保存中…",
  "common.delete": "削除",
  "common.none": "なし",
  "common.unknown": "不明",
  "common.dismiss": "閉じる",
  "common.details": "詳細",
  "common.fetchFailed": "取得に失敗しました — {message}",
  "common.fetchFailedGeneric":
    "読み込めませんでした。時間をおいてもう一度お試しください。",
  "common.ok": "OK",
  "common.justNow": "たった今",
  "common.minutesAgo": "{n}分前",
  "common.hoursAgo": "{n}時間前",
  "common.daysAgo": "{n}日前",
  "common.empty": "データがありません",
  "common.loadMore": "さらに読み込む",

  // --- nav / shell ----------------------------------------------------------
  "nav.home": "ホーム",
  "nav.store": "ストア",
  "nav.runs": "履歴",
  "nav.connections": "接続",
  "nav.primary": "主なメニュー",
  "nav.notifications": "通知",
  "nav.account": "アカウント",
  "nav.docs": "ドキュメント",
  "nav.backToTakos": "Takos に戻る",
  "nav.deployContext": "アプリの管理",
  "shell.skipToContent": "本文へスキップ",
  "shell.userMenu": "ユーザーメニュー",
  "shell.signOut": "サインアウト",
  "shell.language": "言語",
  "shell.theme": "表示",
  "shell.notificationsAria": "通知（要対応 {n} 件）",
  "theme.system": "自動",
  "theme.light": "ライト",
  "theme.dark": "ダーク",

  // --- spaces (Workspaces; スペース in the UI) -------------------------------
  "workspace.selectMessage": "この作業をどのスペースで行うか選びます。",
  "workspace.defaultName": "個人",
  "workspace.start.aria": "スペースを始める",
  "workspace.start.kicker": "はじめに",
  "workspace.start.title": "アプリを置くスペースを作成",
  "workspace.start.body": "アプリ、接続、履歴、利用量をひとつのスペースにまとめます。最初は自分だけのものです。",
  "workspace.start.create": "スペースを作成",
  "workspace.start.creating": "作成中…",
  "space.label": "スペース",
  "space.switcherAria": "スペースを切り替え（現在: {name}）",
  "space.loading": "読み込み中…",
  "space.loadFailed": "スペースを読み込めませんでした — {message}",
  "space.settings": "スペースの設定",
  "space.unnamed": "名前のないスペース",
  "space.createdOn": "{date} に作成",
  "space.scopeNote": "スペース「{name}」",
  "space.noneTitle": "まだスペースがありません",
  "space.noneMessage": "ホームから始めると、ここも使えるようになります。",
  "space.noneCta": "ホームへ",
  "space.create.environment": "環境を分ける",
  "space.create.environmentBody": "本番と試験のように、アプリと接続を分けて持ちます。",
  "space.create.team": "チームで使う",
  "space.create.teamBody": "メンバーを招待して、アプリと接続を一緒に使います。",
  "space.create.environmentNameLabel": "環境の名前",
  "space.create.teamNameLabel": "チームの名前",
  "space.create.environmentPlaceholder": "例: 試験用、個人の実験",
  "space.create.teamPlaceholder": "例: デザインチーム、Client A",
  "space.create.environmentHelp": "作成すると、新しいスペースに切り替わります。最初は自分だけのものです。",
  "space.create.teamHelp": "作成したあと、メンバーを招待する画面に進みます。",
  "space.create.submit": "作成",
  "space.create.failed": "スペースを作成できませんでした — {message}",
  "space.create.done": "スペース「{name}」を作成し、切り替えました。",
  "space.thisSpace": "このスペース",
  "space.name": "名前",
  "space.nameHint": "メンバーと切り替えに表示される名前です。",
  "space.nameRequired": "名前を入力してください。",
  "space.saved": "名前を保存しました。",
  "space.notFound": "このスペースは見つかりませんでした。切り替えるか、下のアーカイブ済みから復元してください。",
  "space.createdLabel": "作成:",
  "space.new.title": "スペースを追加",
  "space.new.body": "目的を選ぶと、そのためのスペースを作ります。",
  "space.archive.title": "このスペースをアーカイブ",
  "space.archive.body":
    "切り替えに出なくなります。アプリ・接続・履歴・利用量は止まらず、消えません。下の「アーカイブ済み」から戻せます。",
  "space.archive.lastSpace": "最後のスペースはアーカイブできません。",
  "space.archive.cta": "アーカイブ",
  "space.archive.confirmTitle": "「{name}」をアーカイブ",
  "space.archive.confirmMessage":
    "切り替えに出なくなるだけです。このスペースのアプリはそのまま動き続け、接続・履歴・利用量も消えません。いつでも復元できます。",
  "space.archive.done": "「{name}」をアーカイブしました。アプリはそのまま動いています。",
  "space.archived.title": "アーカイブ済みのスペース",
  "space.archived.body": "復元すると、切り替えに戻ります。",
  "space.archived.restore": "復元",

  // --- auth -----------------------------------------------------------------
  "auth.signIn": "サインイン",
  "legal.policiesNav": "運営者のポリシー",
  "auth.signInSub": "サインインすると、自分のアプリと設定を開けます。",
  "auth.singleSignOn": "シングルサインオン",
  "auth.continueWith": "{provider} で続ける",
  "auth.providerChecking": "利用可否を確認中です",
  "auth.providerUnavailable": "現在利用できません",
  "auth.providerRetryNeeded": "確認できませんでした",
  "auth.noProvidersTitle": "現在サインインできません",
  "auth.noProvidersMessage":
    "現在利用できるサインイン方法がありません。しばらくしてから再試行してください。続く場合はサポートに連絡してください。",
  "auth.noProvidersMessageWithInstall":
    "追加内容はこの画面に保持されています。サインインが利用可能になってから再試行してください。",
  "auth.providersLoadFailedTitle": "サインイン方法を確認できませんでした",
  "auth.providersLoadFailedMessage": "通信状態を確認して再試行してください。",
  "auth.providersLoadFailedMessageWithInstall":
    "通信状態を確認して再試行してください。追加内容はこの画面に保持されています。",
  "auth.retryProviderCheck": "もう一度確認",
  "auth.sessionMaintenanceTitle": "ダッシュボードは一時的に利用できません",
  "auth.sessionMaintenanceBody":
    "メンテナンス中です。しばらくしてからもう一度お試しください。",
  "auth.installContextAria": "サインイン後に続けるアプリ",
  "auth.installContextKicker": "インストールするアプリ",
  "auth.installSignInTitle": "サインインして続ける",
  "auth.installSignInSub":
    "サインイン後、{name} のインストール画面に戻ります。サインインしただけではインストールされません。",
  "auth.installContextTitle": "サインイン後に続行します",
  "auth.installContextRef": "バージョン {ref}",
  "auth.installContextDefaultRef": "既定のバージョン",
  "auth.installContextRootPath": "フォルダはインストール時に調べます",
  "auth.termsPrefix": "続行することで",
  "auth.termsOfService": "利用規約",
  "auth.and": "と",
  "auth.privacyPolicy": "プライバシーポリシー",
  "auth.termsSuffix": "に同意したものとみなします。",
  "auth.startFailed":
    "サインインを開始できませんでした。もう一度お試しください。",
  "auth.startInsecureContext":
    "この接続ではサインインを開始できません。HTTPS（または localhost）でダッシュボードを開いてください。",
  "auth.processing": "サインイン処理中…",
  "auth.failed": "サインインに失敗しました",
  "auth.backToSignIn": "サインインへ戻る",
  "auth.retryableCallbackFailure":
    "このブラウザタブからサインインを完了できませんでした。もう一度サインインしてください。",
  "auth.retryableCallbackFailureWithDetail":
    "サインインを完了できませんでした。もう一度お試しください。詳細: {message}",

  // --- 404 --------------------------------------------------------------
  "notFound.title": "ページが見つかりません",
  "notFound.message": "URL をご確認ください。移動した可能性があります。",
  "notFound.goHome": "ホームへ",

  // --- errors / error boundary ------------------------------------------
  "error.generic":
    "問題が発生しました。しばらくしてからもう一度お試しください。",
  "error.planReconcileTimeout":
    "変更内容の準備を待つのを停止しました。サーバー側では処理が続いている可能性があります。もう一度始める前にデプロイ履歴を確認してください。",
  "errorBoundary.title": "問題が発生しました",
  "errorBoundary.body":
    "予期しないエラーで画面を表示できませんでした。ページを再読み込みしてください。",
  "errorBoundary.routeTitle":
    "この画面を表示できませんでした",
  "errorBoundary.routeBody":
    "予期しないエラーが起きました。ほかの画面は引き続き使えます。もう一度試すか、ページを再読み込みしてください。",
  "errorBoundary.tryAgain": "もう一度表示",
  "errorBoundary.reload": "再読み込み",

  // --- status labels ----------------------------------------------------
  "status.capsule.pending": "準備中",
  "status.capsule.needsAttention": "確認が必要",
  // `active` = 直近の apply が成功し state generation が前進した状態。readiness
  // 検証ではない（health probe は別）ので「稼働中」とは言わず実態どおりにする。
  "status.capsule.active": "デプロイ済み",
  "status.capsule.stale": "更新があります",
  "status.capsule.error": "エラー",
  "status.capsule.disabled": "無効",
  "status.capsule.uninstalled": "削除予定",
  "status.capsule.destroyed": "削除済み",
  "status.run.queued": "待機中",
  "status.run.running": "実行中",
  "status.run.waiting_approval": "承認待ち",
  "status.run.succeeded": "成功",
  "status.run.failed": "失敗",
  "status.run.cancelled": "キャンセル",
  "status.run.expired": "期限切れ",
  "status.run.ready_to_deploy": "デプロイ待ち",
  "status.policy.pass": "問題なし",
  "status.policy.warn": "警告あり",
  "status.policy.deny": "拒否",
  "status.stateVersion.current": "現在",
  "status.connection.pending": "未確認",
  "status.connection.verified": "確認済み",
  "status.connection.revoked": "無効化済み",
  "status.connection.expired": "期限切れ",
  "status.connection.error": "エラー",
  "status.providerConnection.ready": "利用できます",
  "status.providerConnection.needs_setup": "未確認",
  "status.providerConnection.expired": "期限切れ",
  "status.providerConnection.blocked": "利用停止",

  // --- run operation nouns (shared by run view / feeds) -------------------
  "op.plan": "変更の確認",
  "op.apply": "デプロイ",
  "op.destroy_plan": "削除の確認",
  "op.destroy_apply": "削除",
  "op.drift_check": "ズレの確認",
  "op.source_sync": "内容の取得",
  "op.compatibility_check": "追加前の確認",
  "op.artifact": "成果物の準備",
  "op.backup": "バックアップ",
  "op.restore": "復元",
  "op.state_recovery": "状態の復旧",
  // Internal plan-operation nouns recorded on Activity metadata
  // (create/update/destroy) — mapped so feeds never fall back to 操作.
  "op.create": "追加",
  "op.update": "変更",
  "op.generic": "操作",

  // --- Service list (home) --------------------------------------------------
  "apps.title": "アプリ",
  "apps.add": "サービスを追加",
  "apps.addShort": "追加",
  "apps.sectionYours": "あなたのアプリ",
  "apps.manage": "管理",
  "apps.manageAria": "管理: {name}",
  "apps.openApp": "アプリを開く",
  "apps.reviewChanges": "変更を確認",
  "apps.start.aria": "最初のアプリ",
  "apps.start.kicker": "まだアプリがありません",
  "apps.start.titleEmpty": "最初のアプリを追加しましょう",
  "apps.start.bodyEmpty": "アプリを選ぶか、リンクを貼って追加します。",
  "apps.start.optionStore": "追加する",
  "apps.noLaunchable.kicker": "画面のあるアプリはまだありません",
  "apps.noLaunchable.title": "{count} 件のサービスがあります",
  "apps.noLaunchable.body":
    "準備中か、開く画面を持たないサービスです。一覧から状態を確認できます。",
  "apps.noLaunchable.cta": "サービス一覧を開く",
  "apps.listIncomplete":
    "一部のアプリを読み込めませんでした。表示されていないアプリがあるかもしれません。",

  // --- Workload list (/workloads) -------------------------------------------
  "workloads.title": "ワークロード",
  "workloads.subtitle": "デプロイ済みのワークロードと状態。選ぶと詳細へ。",
  "workloads.empty.title": "まだワークロードがありません",
  "workloads.empty.body": "サービスを追加するとここに表示されます。",
  "workloads.deleteAria": "ワークロードを削除: {name}",
  "workloads.listIncomplete":
    "一部のワークロードを読み込めませんでした。表示されていないワークロードがあるかもしれません。",

  // --- Service detail ------------------------------------------------------
  "app.capsuleSub": "サービス",
  "app.tab.overview": "概要",
  "app.tab.deploys": "更新",
  "app.tab.settings": "設定",
  "app.notFound": "サービスが見つかりません",
  "app.backToList": "一覧へ",
  "app.loadFailedTitle": "サービスを読み込めませんでした",
  "app.refreshFailed":
    "最新の状態を取得できませんでした。表示は最後に取得した内容です。",
  "app.notFoundMessage": "削除されたか、リンクが違う可能性があります。",
  "app.surfaces.title": "公開リンク",
  "app.surfaces.details": "URLとアクセス情報",
  "app.surfaces.subtitle":
    "このサービスが宣言し、あなたに利用が許可された画面を表示します。",
  "app.surfaces.deletedSubtitle":
    "このサービスは削除済みです。実行画面のリンクは利用できません。",
  "app.surfaces.activationPending":
    "公開処理が完了すると、このアドレスを開けます。",
  "app.surfaces.activationFailed":
    "公開処理に失敗しました。最近の更新から詳細を確認できます。",
  "app.surfaces.empty": "デプロイと利用許可の設定が完了すると表示されます。",
  "app.surfaces.loadError":
    "公開リンクを読み込めませんでした。時間をおいて開き直してください。",
  "app.surfaces.none": "このサービスには利用可能な公開リンクがありません。",
  "app.surfaces.defaultName": "画面 {n}",
  "app.surfaces.openAria": "{name} を新しいタブで開く",
  "app.surfaces.open": "アプリを開く",
  "app.deps.title": "連携しているサービス",
  "app.deps.dependsOn": "このサービスが使うサービス",
  "app.deps.usedBy": "このサービスを使っているサービス",
  "app.source.title": "取得元",
  "app.source.name": "名前",
  "app.source.url": "取得元 URL",
  "app.source.refPath": "バージョン / フォルダ",
  "app.source.loading": "取得元情報を読み込み中です。",
  "app.source.unavailable": "取得元の情報は利用できません。",
  "app.source.supportBody": "取得元と参照情報です。通常は変更しません。",
  "app.deploys.title": "更新履歴",
  "app.deploys.reviewTitle": "サービスを更新",
  "app.deploys.reviewSubtitle":
    "変更がある場合は内容を確認してからデプロイできます。",
  "app.deploys.sourceVersionTitle": "取得元のバージョン",
  "app.deploys.sourceVersionSubtitle":
    "変更を確認する前に、Git のブランチ、タグ、またはコミットを指定してください。",
  "app.deploys.sourceVersionCurrent": "追跡するバージョン",
  "app.deploys.sourceVersionChange": "バージョンを変更",
  "app.deploys.sourceVersionInput": "ブランチ・タグ・コミット",
  "app.deploys.sourceVersionHint":
    "このワークロードで使うブランチ名、タグ名、またはコミットを入力し、適用前に内容を確認してください。",
  "app.deploys.sourceVersionApply": "このバージョンを確認",
  "app.deploys.sourceVersionUnavailable":
    "現在の適用済みバージョンを取得できません。",
  "app.deploys.empty": "まだデプロイ履歴はありません。",
  "app.deploys.generationBadge": "第{n}版",
  "app.deploys.restore": "この状態に戻す",
  "app.deploys.restoreDisclosure": "以前の状態に戻す",
  "app.deploys.advancedActions": "必要なときだけ使う操作",
  "app.deploys.advancedActionsBody":
    "ワークスペースの管理情報の一部を書き出します。このデータの取り込み・復元には対応していません。",
  "app.deploys.backup": "管理情報の一部を書き出す",
  "app.deploys.backupCreated":
    "管理情報の一部を書き出しました。このデータの取り込み・復元には対応していません。",
  "app.deploys.backupSupportRef": "書き出し ID",
  "app.deploys.inventoryTitle": "デプロイ済みリソース",
  "app.deploys.inventoryRecordedNote":
    "現在の適用状態に記録された内容です。ライブ稼働状態ではありません。",
  "app.deploys.inventoryRecoveryUnknownTitle": "復旧した状態のリソース",
  "app.deploys.inventoryRecoveryUnknownNote":
    "状態データだけを採用しました。元のデプロイは失敗したままで、リソースやプロバイダー操作の成功は確認されていません。",
  "app.deploys.inventoryLoadError":
    "記録済みリソース一覧を読み込めませんでした。",
  "app.deploys.inventoryLegacyUnavailable":
    "この古い適用状態にはリソース一覧の記録がありません。",
  "app.deploys.inventoryGeneration": "バージョン番号",
  "app.deploys.inventoryRecordedAt": "記録日時",
  "app.deploys.inventoryStateVersion": "状態バージョン",
  "app.deploys.inventoryApplyRun": "デプロイ",
  "app.deploys.inventoryPlanRun": "変更の確認",
  "app.deploys.inventoryEmpty": "デプロイ済みリソースは記録されていません。",
  "app.recentActivity.title": "最近の更新",
  "app.recentActivity.open": "詳細",
  "app.recentActivity.releaseActivation": "サービス公開",
  "app.bindings.title": "接続済みアカウント",
  "app.bindings.subtitle":
    "このサービスが公開時に使う外部サービスのアクセスです。通常は変更不要です。",
  "app.bindings.none": "接続済みアカウントは紐づいていません。",
  "app.bindings.editAdvanced": "接続済みアカウントの割り当てを変更",
  "app.bindings.add": "接続済みアカウントを追加",
  "app.bindings.providerPlaceholder": "接続先",
  "app.bindings.providerLabel": "接続先",
  "app.bindings.moduleLocalNamePlaceholder": "モジュール内の provider 名",
  "app.bindings.moduleLocalNameLabel": "モジュール内の provider 名",
  "app.bindings.childAliasPlaceholder": "子モジュール alias（任意）",
  "app.bindings.childAliasLabel": "子モジュールの provider alias",
  "app.bindings.rootAliasPlaceholder": "root alias（任意）",
  "app.bindings.rootAliasLabel": "root の provider alias",
  "app.bindings.selectConnection": "接続済みアカウントを選択",
  "app.bindings.technicalTarget": "接続先の詳細",
  "app.bindings.remove": "削除",
  "app.bindings.errorProvider": "{index} 行目の接続先を入力してください。",
  "app.bindings.errorConnection":
    "{provider} の利用可能な接続済みアカウントを選択してください。",
  "app.config.title": "設定値",
  "app.config.internalNames": "設定の参照名",
  "app.config.subtitle":
    "変更を確認してから適用します。この画面では適用しません。",
  "app.config.publicUrl": "公開URL",
  "app.config.subdomain": "公開サブドメイン",
  "app.config.updatedAt": "最終更新",
  "app.config.empty": "編集できる設定値はありません。",
  "app.config.notReady":
    "設定値をまだ読み込めていません。ページを再読み込みしてください。",
  "app.config.advanced": "その他の設定値",
  "app.config.addVariable": "設定値を追加",
  "app.config.name": "名前",
  "app.config.value": "値",
  "app.config.enabled": "有効にする",
  "app.config.secretHint":
    "保存済みです。変更する場合だけ新しい値を入力します。",
  "app.config.reset": "リセット",
  "app.config.remove": "削除",
  "app.config.undoReset": "元に戻す",
  "app.config.resetAria": "{name} をリセット",
  "app.config.removeAria": "設定値 {name} を削除",
  "app.config.undoResetAria": "{name} のリセットを元に戻す",
  "app.config.defaultBadge": "既定値",
  "app.config.resetPendingHint": "確認対象の変更では既定値に戻ります。",
  "app.config.customName": "CUSTOM_ENV",
  "app.config.errorNameRequired": "設定名を入力してください。",
  "app.config.errorNameInvalid": "{name} に空白は使えません。",
  "app.config.errorNameDuplicate": "{name} が重複しています。",
  "app.config.errorNumber": "{name} は数値で入力してください。",
  "app.config.errorJson": "{name} は JSON として入力してください。",
  "app.interfaces.title": "アプリが公開する連携面（上級者向け）",
  "app.interfaces.subtitle":
    "他のサービスやアプリから利用できる公開面を宣言します。変更は次のデプロイ確認に反映されます。",
  "app.interfaces.editorLabel": "Interface blueprint（JSON）",
  "app.interfaces.editorHint":
    "配列として入力します。各宣言には key、name、spec を明示し、動的な値は spec.inputs で literal、capsule_output、resource_output のいずれかに割り当てます。シークレットは記載しません。",
  "app.interfaces.notReady":
    "連携面の設定をまだ読み込めていません。ページを再読み込みしてください。",
  "app.interfaces.errorJson": "正しい JSON を入力してください。",
  "app.interfaces.errorArray":
    "Interface blueprint の JSON は配列で入力してください。すべて削除する場合は [] を使います。",
  "app.settings.openCta": "設定を開く",
  "app.settings.supportDetails": "参照情報",
  "app.settings.leaveConfirm.title": "編集内容を破棄しますか？",
  "app.settings.leaveConfirm.body":
    "保存していない設定の変更があります。移動すると失われます。",
  "app.settings.leaveConfirm.confirm": "破棄して移動",
  "app.usage.title": "見積費用（累計）",
  "app.usage.body":
    "このサービスの評価済み費用です。未評価の使用量は別に表示します。",
  "app.usage.subCent": "$0.01 未満",
  "app.usage.unrated": "未評価",
  "app.usage.unratedCount": "未評価の使用量記録: {n} 件",
  "app.updateNow": "更新する",
  "app.autoUpdate.title": "自動更新",
  "app.autoUpdate.body":
    "新しいバージョンが見つかったら自動で更新します。作り直しや削除を含む変更は自動では行わず、確認をお願いします。",
  "app.autoUpdate.enable": "自動更新をオンにする",
  "app.autoUpdate.disable": "自動更新をオフにする",
  "app.danger.destroyTitle": "サービスを削除",
  "app.danger.destroyBody":
    "{name} を削除するには、まず削除の確認で内容を確かめ、そのうえで実行します。実行するとリソースは取り除かれ、元に戻せません。",
  "app.danger.destroyConfirmTitle": "このサービスを削除しますか？",
  "app.danger.destroyConfirmMessage":
    "{name} を削除します。まだデプロイされていない場合はこの場で完全に削除され、元に戻せません。",
  "app.danger.destroyCta": "削除の確認を開く",
  "app.uninstall.title": "削除を予約",
  "app.uninstall.body":
    "{name} とそのデータは猶予期間のあいだ残り、それまではいつでも取り消せます。期限が来ると、このサーバーが対応していればデータを書き出してから削除します。",
  "app.uninstall.cta": "削除を予約する",
  "app.uninstall.confirmTitle": "このサービスの削除を予約しますか？",
  "app.uninstall.confirmMessage":
    "{name} は猶予期間が終わるまで動き続け、データも残ります。期限が来るとデータの書き出しを試みてから完全に削除します。それまでは取り消せます。",
  "app.uninstall.dependencyWarning":
    "{name} は次のサービスから使われています（{services}）。削除すると、これらのサービスに影響する可能性があります。",
  "app.uninstall.dependencyCheckLoading": "削除前に連携サービスを確認しています…",
  "app.uninstall.dependencyCheckFailed":
    "連携サービスを確認できませんでした。削除前に依存関係を確認してください。",
  "app.uninstall.immediateTitle": "今すぐ完全に削除",
  "app.uninstall.banner":
    "{name} は {date} に削除されます。それまではデータが残り、取り消せます。",
  "app.uninstall.bannerDue":
    "{name} の猶予期間が終わりました。まもなく削除します。",
  "app.uninstall.bannerDestroying": "{name} を削除しています。",
  "app.uninstall.bannerBlocked":
    "{name} の自動削除を止めました。安全に削除できることを確かめられなかったためです。取り消すか、設定から今すぐ削除してください。",
  "app.uninstall.exportExported": "削除の前にデータを書き出しました。",
  "app.uninstall.exportExportedLedgerOnly":
    "削除の前にサービスの設定と state を書き出しました。このアプリは自身のデータの書き出しを宣言していません。",
  "app.uninstall.bannerFailed":
    "{name} の削除が完了しませんでした。設定から今すぐ削除してやり直してください。",
  "app.uninstall.exportFailed":
    "削除前のデータの書き出しに失敗しました。削除はそのまま進みます。",
  "app.uninstall.exportSkipped":
    "このサーバーではデータを書き出せないため、書き出しは行っていません。",
  "app.uninstall.cancel": "削除を取り消す",
  "app.uninstall.deleteNow": "今すぐ削除",
  "app.setupIncomplete.body":
    "追加が完了していません。変更の確認からやり直すか、設定から削除してやり直せます。",
  "app.setupIncomplete.review": "更新タブへ",
  "app.setupIncomplete.initialReviewBody": "最初の変更の確認が承認を待っています。その確認を開いて続行してください。更新の確認を新しく作っても再開しません。",
  "app.setupIncomplete.openInitialReview": "初回導入の確認を開く",
  "app.setupIncomplete.loadingInitialReview": "初回導入の確認を探しています…",
  "app.setupIncomplete.initialReviewUnavailable": "取得できる記録から最初の変更の確認を特定できません。元の追加リンクがあれば開き直し、なければ運営者に問い合わせてください。更新の確認で代わりにしないでください。",
  "installStore.recoveryUnverified": "インストールの状況を確認できません",
  "installStore.recoveryUnverifiedHint": "元のインストールがまだ進行中の可能性があります。もう一度インストールする前に状況を再取得するか、履歴を確認してください。",
  "installStore.recoveryContinue": "インストールの準備を続けられます",
  "installStore.recoveryContinueHint": "続けると、確認用の変更内容を準備するだけです。まだ適用はしません。",
  "installStore.recoveryReview": "最初の変更を確認できます",
  "installStore.recoveryReviewHint": "最初の変更の確認を開いて内容を確かめてください。適用は別の操作で行います。",
  "installStore.recoveryFailed": "インストールの準備は停止しました",
  "installStore.recoveryFailedHint": "この記録から開ける変更の確認はありません。途中の準備が取り消されたとは限りません。もう一度インストールする前にアプリ一覧を確認するか、運営者に相談してください。",
  "installStore.recoveryFailedRun": "インストールの準備は停止しました。変更の確認を開けます",
  "installStore.recoveryFailedRunHint": "記録された変更の確認を開いて状況を確かめ、再試行する場合は明示的に選んでください。自動で再試行や適用はしません。",

  // --- run view --------------------------------------------------------------
  "run.title.plan": "変更の確認",
  "run.title.apply": "デプロイ",
  "run.title.destroy": "削除",
  "run.title.other": "実行",
  "run.notFoundTitle": "この実行は見つかりませんでした",
  "run.notFoundMessage":
    "この実行は削除されたか、URL が正しくない可能性があります。",
  "run.loadFailedTitle": "実行を読み込めませんでした",
  "run.refreshFailed":
    "最新の状態を取得できませんでした。最後に取得した内容を表示しています。",
  "run.summary.planning": "変更内容を確認しています…",
  "run.summary.queued": "実行を待っています…",
  "run.summary.waitingApproval":
    "この変更の実行には承認が必要です。内容を確認して承認してください。",
  "run.summary.ready": "「{name}」をデプロイする準備ができました。",
  "run.summary.readyGeneric": "このサービスをデプロイする準備ができました。",
  "run.summary.readyChanges": "作成 {create} / 変更 {update} / 削除 {delete}",
  "run.summary.destroyReady":
    "「{name}」を削除する準備ができました。実行すると元に戻せません。",
  "run.summary.destroyReadyGeneric":
    "このサービスを削除する準備ができました。実行すると元に戻せません。",
  "run.summary.applied":
    "デプロイを開始しました。反映までしばらくお待ちください。",
  "run.summary.stateRecoverySucceeded":
    "状態データを復旧しました。デプロイの成功を示すものではありません。",
  "run.summary.stateRecoverySucceededHint":
    "元のデプロイは失敗したままです。リソースとプロバイダー操作の結果は不明で、サービスは利用可能と確認されていません。",
  "run.summary.alreadyApplied":
    "この変更のデプロイは実行済みです。結果はアクティビティから確認できます。",
  "run.summary.applying": "デプロイを実行しています…",
  "run.summary.finishing": "デプロイを仕上げています…",
  "run.summary.checkingDeploy": "デプロイの準備を確認しています…",
  "run.summary.activationPending": "サービスの公開処理を仕上げています…",
  "run.summary.activationFailed":
    "インフラのデプロイ後のサービス公開に失敗しました。",
  "run.summary.readinessUnavailable": "サービスの準備状況を確認できません。",
  "run.summary.readinessUnavailableHint":
    "準備状況を再確認します。確認に成功するまで適用完了とは表示しません。",
  "run.summary.applySucceeded": "デプロイが完了しました。",
  "run.summary.removing": "削除しています…",
  "run.summary.removed": "削除が完了しました。",
  "run.summary.failed": "{operation}に失敗しました。",
  "run.summary.failedHint": "下の診断とログで原因を確認できます。",
  "controlError.stateGenerationMismatch":
    "別の変更が先に実行されました。もう一度変更を確認してからデプロイしてください。",
  "controlError.dependencySnapshotStale":
    "連携しているサービスが先に更新されました。もう一度変更を確認してください。",
  "controlError.dependencyUnavailable":
    "連携しているサービスの値をいま取得できません。時間をおいてもう一度お試しください。",
  "controlError.sourceChanged":
    "取得元の内容が変わりました。もう一度変更を確認してください。",
  "controlError.sourceRevisionMismatch":
    "取得元の識別情報または指定したバージョンが変わりました。現在のサービスを確認し直してください。",
  "controlError.invalidSourceRevision":
    "変更を確認する前に、Git のブランチ、タグ、またはコミットを指定してください。",
  "controlError.compatibilityStale":
    "確認結果が古くなりました。もう一度確認してください。",
  "controlError.runnerUnavailable":
    "実行環境をいま利用できません。時間をおいてもう一度お試しください。",
  "controlError.sourceSyncPending":
    "リポジトリの内容をまだ取得しています。少し待ってからもう一度お試しください。",
  "controlError.planFailed":
    "変更内容を準備できませんでした。デプロイ履歴で状況を確認してから、もう一度お試しください。",
  "controlError.slotLimitReached":
    "利用できる枠の上限に達しました。不要なサービスを削除するか、運営者にお問い合わせください。",
  "controlError.capsuleNotFound":
    "対象のサービスが見つかりません。削除された可能性があります。",
  "controlError.configNotFound":
    "このサービスの設定が見つかりません。追加し直してください。",
  "controlError.shareRevoked": "この共有は無効になっています。",
  "runError.sourceSyncFailed":
    "サービスの内容を取得できませんでした。リンクとバージョンを確認して、もう一度お試しください。",
  "runError.sourceRefNotFound":
    "指定されたバージョンが見つかりませんでした。バージョンを確認して、もう一度お試しください。",
  "runError.stateGenerationMismatch":
    "別の変更が先に実行されました。もう一度変更を確認してからデプロイしてください。",
  "runError.planFailed":
    "変更内容の確認に失敗しました。詳細を確認して、もう一度お試しください。",
  "runError.applyFailed":
    "デプロイに失敗しました。詳細を確認して、もう一度お試しください。",
  "runError.runFailed": "実行に失敗しました。もう一度お試しください。",
  "runError.backupFailed":
    "復元ポイントの作成に失敗しました。もう一度お試しください。",
  "run.summary.connectionVerificationRequired":
    "接続済みアカウントの確認が必要です。",
  "run.summary.connectionVerificationHint":
    "この実行を作成した後に接続状態が変わった可能性があります。もう一度変更を確認してからデプロイしてください。",
  "run.summary.connectionSetupRequired": "接続済みアカウントの設定が必要です。",
  "run.summary.connectionSetupHint":
    "必要なアカウント接続を選ぶか、接続の設定を済ませてから、もう一度デプロイしてください。",
  "run.summary.connectionChanged": "接続済みアカウントを確認し直してください。",
  "run.summary.connectionChangedHint":
    "この実行を確認した後に接続済みアカウントが変わっています。現在の変更を確認し直してからデプロイしてください。",
  "run.summary.credentialServiceIssue": "アクセス準備を完了できませんでした。",
  "run.summary.credentialServiceHint":
    "接続済みアカウントへのアクセス準備に失敗しました。もう一度試し、続く場合はサポートに連絡してください。",
  "run.summary.blocked": "ポリシーにより実行が止まっています。",
  "run.summary.blockedHint":
    "ポリシー設定を確認するか、修正後にもう一度変更を確認してください。",
  "run.summary.driftDone": "ズレの確認が完了しました。",
  "run.summary.cancelled": "この操作は取り消されました。",
  "run.summary.expired": "この変更の確認は期限切れです。",
  "run.summary.expiredHint": "もう一度変更を確認してからデプロイしてください。",
  "run.summary.compatDone": "追加前の確認が完了しました。",
  "run.summary.compatRunning": "内容を確認しています…",
  "run.summary.syncDone": "内容の取得が完了しました。",
  "run.summary.syncRunning": "内容を取得しています…",
  "run.summary.fallback": "実行の状態: {status}",
  "run.approve": "この変更を承認",
  "run.approving": "承認中…",
  "run.deploy": "デプロイを実行",
  "run.deploying": "実行中…",
  "run.deployBlocked": "実行できません",
  "run.retryPlan": "もう一度変更を確認",
  "run.restartLatestSource": "最新のソースで最初からやり直す",
  "run.restartLatestSourceConfirm.title": "最新のソースでやり直しますか？",
  "run.restartLatestSourceConfirm.message":
    "「{name}」はまだデプロイされていません。未完了のサービスを破棄し、固定されていた古いソース指定を外して最新の内容を取得し直します。失敗した変更確認の履歴は残ります。",
  "run.restartLatestSourceUnavailable":
    "このサービスはここから安全に作り直せません。状態を再読み込みしてからもう一度お試しください。",
  "run.backToApp": "サービスへ戻る",
  "run.appHandoff.open": "{app} で開く",
  "run.destructiveWarning":
    "この変更には既存リソースの置き換え・削除が含まれます。実行するとデータが失われる場合があります。",
  "run.destructiveConfirm": "破壊的な変更を承知のうえで実行",
  "run.stopGoBack": "やめて戻る",
  "run.cancel": "この実行をキャンセル",
  "run.approveConfirm.restoreTitle": "バックアップから復元しますか？",
  "run.approveConfirm.restoreMessage":
    "{name} を選んだバックアップの内容に戻します。現在の状態は置き換わり、元に戻せません。",
  "run.approveConfirm.restoreMessageGeneric":
    "選んだバックアップの内容に戻します。現在の状態は置き換わり、元に戻せません。",
  "run.approveConfirm.destroyTitle": "この削除を実行しますか？",
  "run.approveConfirm.destroyMessage":
    "{name} のリソースを削除します。元に戻せません。",
  "run.approveConfirm.destroyMessageGeneric":
    "対象のリソースを削除します。元に戻せません。",
  "run.cancelConfirm.title": "実行をキャンセルしますか？",
  "run.cancelConfirm.message": "「{name}」の{operation}を途中で終了します。",
  "run.cancelConfirm.messageGeneric": "この{operation}を途中で終了します。",
  "run.cancelConfirm.cta": "実行をキャンセル",
  "run.cancelConfirm.keep": "実行を続ける",
  "run.cost.required": "見積費用: 約 {n}",
  "run.cost.unrated": "使用量は計測済みですが、価格ポリシーが未設定です。",
  "run.cost.capacityBlocked":
    "このワークスペースではこの操作を実行できません。",
  "run.cost.billingCta": "お支払いを開く",
  "run.cost.operatorHelp":
    "オーナーがワークスペースの使用量・上限を見直すと、この操作を実行できます。",
  "run.cost.quotaCta": "使用量を確認",
  "run.changes.title": "変更される内容",
  "run.changes.titleDone": "変更された内容",
  "run.changes.noRecord": "変更内容の記録はありません",
  "run.changes.create": "作成",
  "run.changes.update": "変更",
  "run.changes.delete": "削除",
  "run.resources.kicker": "確認",
  "run.resources.title": "変更予定",
  "run.resources.count": "{n} 件",
  "run.resources.more": "ほか {n} 件の変更があります。",
  "run.resources.actionCreate": "作成",
  "run.resources.actionUpdate": "変更",
  "run.resources.actionDelete": "削除",
  "run.resources.actionReplace": "置換",
  "run.resources.identifiers": "参照 ID",
  "run.resources.address": "アドレス",
  "run.resources.type": "種別",
  "run.resources.scope": "対象範囲",
  "run.details.title": "参照情報",
  "run.details.runId": "実行 ID",
  "run.details.type": "種別",
  "run.details.policy": "安全確認",
  "run.details.capsule": "サービス",
  "run.details.sourceSnapshot": "取得元のバージョン",
  "run.details.dependencySnapshot": "連携入力の固定情報",
  "run.details.baseGeneration": "元の状態",
  "run.details.planDigest": "変更内容の検証 ID",
  "run.details.created": "作成",
  "run.details.started": "開始",
  "run.details.finished": "終了",
  "run.details.error": "エラー",
  "run.details.debug": "識別情報",
  "run.inputs.title": "連携サービスからの値",
  "run.inputs.empty": "連携サービスから受け取った値はありません。",
  "run.connections.setupCta": "接続を設定する",
  "run.connections.title": "接続済みアカウント",
  "run.connections.reviewTitle": "接続済みアカウントの確認が必要です",
  "run.connections.reviewBody":
    "続行する前に確認が必要な接続済みアカウントがあります。非公開の値は表示しません。",
  "run.connections.provider": "接続先",
  "run.connections.connection": "アクセス",
  "run.connections.status": "状態",
  "run.connections.statusResolved": "利用できます",
  "run.connections.statusMissing": "アクセスが必要",
  "run.connections.statusBlocked": "ポリシーで停止",
  "run.connections.empty": "接続済みアカウントの確認情報はありません。",
  "run.diagnostics.title": "診断",
  "run.diag.severity.error": "エラー",
  "run.diag.severity.warning": "警告",
  "run.diag.severity.info": "情報",
  "run.diagnostics.failed":
    "完了できませんでした。原因を確認する場合だけ詳細を開いてください。",
  "run.diagnostics.connectionVerificationRequired":
    "接続済みアカウントへのアクセス準備中に停止しました。接続が利用可能になっている場合は、もう一度変更を確認してからデプロイしてください。",
  "run.diagnostics.connectionVerificationShort":
    "接続済みアカウントを利用できませんでした。",
  "run.diagnostics.connectionVerificationDetail":
    "現在の接続状態で確認し直すため、もう一度変更を確認してください。",
  "run.diagnostics.connectionSetupRequired":
    "この実行には接続済みアカウントの設定が必要です。",
  "run.diagnostics.connectionSetupShort":
    "このデプロイに必要なアカウント接続が設定されていません。",
  "run.diagnostics.connectionSetupDetail":
    "接続画面で必要なアカウントを選んでから、もう一度デプロイしてください。",
  "run.diagnostics.connectionChanged":
    "確認したあとに接続済みアカウントが変更されています。",
  "run.diagnostics.connectionChangedShort":
    "確認済みのアカウント接続が現在の状態と一致しません。",
  "run.diagnostics.connectionChangedDetail":
    "現在の接続状態で使うため、もう一度変更を確認してください。",
  "run.diagnostics.credentialServiceIssue":
    "この実行用の一時アクセスを準備できませんでした。",
  "run.diagnostics.credentialServiceShort":
    "一時アクセスを準備できませんでした。",
  "run.diagnostics.credentialServiceDetail":
    "もう一度試してください。続く場合はサポートに連絡してください。",
  "run.audit.title": "活動記録",
  "run.audit.empty": "活動記録はありません。",
  "run.audit.detail": "記録の詳細",

  // --- add flow (/new) -------------------------------------------------------
  "new.git.defaultRef": "Git の既定ブランチ",
  "new.compat.ready": "このまま追加できます",
  "new.compat.patch": "手直しが必要です",
  "new.compat.unsupported": "今は追加できません",
  "new.compat.summary.checkFailed":
    "追加できるかの確認を完了できませんでした。サービスの問題とは限りません。もう一度お試しください。",
  "new.compat.summary.providerCredentials":
    "{provider} の非公開値を取得元から外す必要があります。",
  "new.compat.summary.installUxInvalid":
    "このバージョンの初期設定宣言は配布元による修正が必要です。",
  "new.compat.summary.reviewRequired":
    "追加する前に確認が必要な項目があります。",
  "new.compat.issue.providerCredentials.message":
    "{provider} の非公開値が取得元の中に書かれています。",
  "new.compat.issue.providerCredentials.detail":
    "API トークンやアカウント ID はコードに置かず、{provider} の接続済みアカウントからデプロイ時だけ渡してください。値を外して接続すると続行できます。",
  "new.compat.issue.installUxInvalid.message":
    "アプリの初期設定宣言が選択したバージョンと一致していません。",
  "new.compat.issue.installUxInvalid.detail":
    "別のバージョンを選ぶか、配布元へ .well-known/takosumi.json の修正を依頼してください。Takosumi が設定項目を推測して置き換えることはありません。",
  "new.compat.issue.providerPreserved.message":
    "取得元にある {provider} の非秘密設定はそのまま維持されます。",
  "new.compat.issue.backendIsolated.message":
    "リポジトリ側の保存先の設定はそのまま残し、Takosumi がこのサービスのデプロイ記録を別に管理します。",
  "new.compat.issue.lockfile.message":
    "利用する接続先の固定情報が含まれています。非公開値を外したあと、追加時に固定内容を確認します。",
  "new.compat.issue.reviewRequired.message":
    "追加前に確認が必要な項目があります。",
  "new.error.sourceRefNotFound":
    "指定されたバージョン「{ref}」が見つかりません。リンク先にこのバージョンがあるか確認してください。",
  "new.error.sourceFetchFailed":
    "サービスの内容を取得できませんでした。リンク、バージョン、フォルダ、または非公開リンクの接続を確認してください。詳細: {message}",
  "new.error.sourceFetchFailedUnknown": "原因を取得できませんでした。",
  "new.error.generic":
    "サービスの追加に失敗しました。内容を確認して、もう一度お試しください。",
  "new.error.genericWithDetails":
    "サービスの追加に失敗しました。詳細: {message}",
  "new.error.connectionRequired":
    "このサービスの公開にはクラウドアカウントの接続が必要です。接続を設定してから、もう一度お試しください。",
  "new.error.alreadyExistsGeneric":
    "このサービスは既に追加されています。一覧から既存サービスを開いてください。",

  // --- members ---------------------------------------------------------------
  "members.role.owner": "オーナー",
  "members.role.admin": "管理者",
  "members.role.member": "メンバー",
  "members.role.viewer": "閲覧のみ",
  "members.title": "メンバー",
  "members.subtitle": "このスペースを一緒に使う人です。",
  "members.listLabel": "メンバー一覧",
  "members.roleHelp.owner": "すべてを管理できます。メンバーの役割の変更と削除もできます。",
  "members.roleHelp.admin": "アプリのインストール・更新・アンインストール、接続の管理、メンバーの招待ができます。",
  "members.roleHelp.member": "アプリを開いて使えます。インストールや設定の変更はできません。",
  "members.roleHelp.viewer": "アプリと状態を見られます。アプリには「閲覧のみ」として伝わります。",
  "members.unnamed": "メンバー（{id}）",
  "members.loadFailedTitle": "メンバーを読み込めませんでした",
  "members.invite.open": "メンバーを招待",
  "members.removeTitle": "「{name}」をこのスペースから外す",
  "members.status.active": "有効",
  "members.status.invited": "招待中",
  "members.status.suspended": "停止中",
  "members.invite.subtitle":
    "一度 Takosumi にサインインしたことがある人のメールアドレスを入力します。招待するとすぐに使えます（メールは送られません）。",
  "members.invite.email": "メールアドレス",
  "members.invite.role": "役割",
  "members.invite.cta": "招待",
  "members.invite.notFound":
    "そのメールアドレスの Takosumi アカウントが見つかりません。相手に一度サインインしてもらってください。",
  "members.invite.emailRequired": "メールアドレスを入力してください。",
  "members.invite.success": "{email} を招待しました。すぐに使えます。",
  "members.you": "あなた",
  "members.changeRole": "役割を変更",
  "members.roleSelectLabel": "{name} の役割",
  "members.roleChangeConfirmTitle": "役割の変更",
  "members.roleChangeConfirmMessage":
    "{name} の役割を「{role}」に変更しますか？",
  "members.lastOwnerDemote":
    "最後のオーナーは降格できません。先に別のオーナーを指名してください。",
  "members.lastOwnerRemove": "最後のオーナーは外せません。先に別のオーナーを指名してください。",
  "members.remove": "外す",
  "members.removeSelf": "このスペースから抜ける",
  "members.removeSelfConfirm": "このスペースから抜けます。以後このスペースのアプリと接続を使えなくなり、自分では戻れません。",
  "members.removeConfirm":
    "「{name}」はこのスペースのアプリと接続を使えなくなります。インストール済みのアプリはそのまま動きます。もう一度招待すれば戻せます。",
  "members.empty": "まだメンバーがいません。",
  "members.viewerNote": "メンバーの招待・役割の変更・削除は、オーナーと管理者が行えます。",

  // --- connections -------------------------------------------------------------
  "conn.subtitle": "アプリがあなたのクラウドにリソースを作るときに使う接続です。接続ごとに、それを使っているアプリを表示します。",
  "conn.title": "接続",
  "conn.footnote": "アプリが使う接続を切り替えるときは、そのアプリを開いて設定から選びます。",
  "conn.operatorProvided": "運営者が用意した接続",
  "conn.apps.label": "使っているアプリ",
  "conn.apps.loading": "確認中…",
  "conn.apps.none": "まだどのアプリも使っていません",
  "conn.apps.unknown": "使っているアプリを確認できませんでした",
  "conn.oauth.accountSettingsHint": "空欄でも接続できます。特定のアカウントだけを使うときに入力します。",
  "conn.add.displayNameHint": "同じクラウドに複数つなぐときの見分けに使います。",
  "conn.byok.unavailable": "ここでは、一覧にないクラウドをつなげません。運営者に確認してください。",
  "conn.genericEnv.providerHint":
    "アプリのインストール画面に表示されるクラウドの名前（例: cloudflare/cloudflare）です。",
  "conn.genericEnv.removeRow": "この行を消す",
  "conn.remove.cta": "削除",
  "conn.remove.confirm": "削除する",
  "conn.remove.affectsApps":
    "次のアプリがこの接続を使っています: {apps}。これらのアプリは、次に更新・設定変更・アンインストールするとき、別の接続を選ぶ必要があります。",
  "conn.remove.noApps": "この接続を使っているアプリはありません。",
  "conn.remove.appsUnknown":
    "使っているアプリを確認できませんでした。使っているアプリがあれば、次に更新・設定変更・アンインストールするとき、別の接続を選ぶ必要があります。",
  "conn.remove.keepsResources": "保存したキーは削除され、元に戻せません。アプリが作ったリソースは削除されません。",
  "conn.expiresAt": "期限: {date}",
  "conn.oauth.manual": "キーを入力して接続する",
  "conn.oauth.connected": "接続を保存しました。",
  "conn.oauth.connect": "{provider} に接続",
  "conn.oauth.waiting": "開いた接続先の画面でアクセスを許可してください。アプリの設定はこの画面に残っています。",
  "conn.oauth.retryHint": "接続が完了しませんでした。認可の画面が開けるか確認してもう一度試すか、下のキー入力を使ってください。",
  "conn.oauth.failed": "接続に失敗しました。もう一度お試しください。",
  "conn.oauth.error.missingCode":
    "認証の応答が不完全でした。もう一度お試しください。",
  "conn.oauth.error.forbidden": "このスペースに接続を追加する権限がありません。オーナーか管理者に依頼してください。",
  "conn.oauth.error.oauthFailed":
    "プロバイダーとの認証に失敗しました。時間をおいてもう一度お試しください。",
  "conn.oauth.errorCode": "エラーコード: {code}",
  "conn.return.title": "「{name}」のインストールに戻る",
  "conn.return.subtitle": "接続を保存したら、インストールの続きに戻れます。",
  "conn.return.cta": "インストールに戻る",
  "conn.saved.message": "{name} を保存しました。",
  "conn.saved.needsTest": "{name} を保存しました。インストールに戻る前に、接続を確認してください。",
  "conn.saved.testCta": "接続を確認",
  "conn.saved.returnCta": "インストールに戻る",
  "conn.add.provider": "つなぐクラウド",
  "conn.add.genericEnvOption": "一覧にないクラウドをつなぐ",
  "conn.add.title": "クラウドをつなぐ",
  "conn.add.open": "接続を追加",
  "conn.add.close": "閉じる",
  "conn.add.displayName": "接続の名前（任意）",
  "conn.add.displayNamePlaceholder": "例: 本番用",
  "conn.guided.openProvider": "{provider} のアクセス設定を開く",
  "conn.byok.title": "キーを入力してクラウドをつなぐ",
  "conn.byok.body":
    "このクラウドには案内付きの接続方法がありません。クラウドの管理画面で作ったキーを、そのクラウドが求める名前で入力します。",
  "conn.byok.noBillingNote":
    "Takosumi の料金があるときは、インストール内容の確認で表示されます。クラウドの料金は、そのクラウドから請求されます。",
  "conn.byok.usePreset": "一覧から選ぶ",
  "conn.register": "接続を保存",
  "conn.registering": "保存中…",
  "conn.genericEnv.providerName": "つなぐクラウド",
  "conn.genericEnv.providerPlaceholder": "cloudflare/cloudflare",
  "conn.genericEnv.envName": "キーの名前",
  "conn.genericEnv.envNamePlaceholder": "例: CLOUDFLARE_API_TOKEN",
  "conn.genericEnv.value": "キーの値",
  "conn.genericEnv.valuePlaceholder": "値を貼り付け",
  "conn.genericEnv.addRow": "キーを追加",
  "conn.genericEnv.providerRequired": "つなぐクラウドの名前を入力してください。",
  "conn.genericEnv.nameRequired": "値を入れた行には、キーの名前が必要です。",
  "conn.genericEnv.invalidName":
    "「{name}」はキーの名前に使えません。CLOUDFLARE_API_TOKEN のような大文字の名前にしてください。",
  "conn.genericEnv.reservedName":
    "「{name}」は Takosumi が使う名前です。そのクラウド用の名前にしてください。",
  "conn.genericEnv.duplicateName": "「{name}」はすでに追加されています。",
  "conn.genericEnv.oneRequired": "キーを 1 つ以上入力してください。",
  "conn.error.invalidProvider": "このクラウドには、ここから接続できません。",
  "conn.error.fieldRequired": "{field} は必須です。",
  "conn.empty.title": "まだクラウドをつないでいません",
  "conn.empty.message": "アプリはここでつないだクラウドにリソースを作ります。ストアでアプリを選ぶと、必要な接続も案内されます。",
  "conn.test": "接続を確認",
  "conn.testing": "確認中…",
  "conn.test.notReady": "この接続はまだ使えません（状態: {status}）。",
  "conn.remove.confirmTitle": "「{name}」を削除",

  // --- notifications -------------------------------------------------------------
  "notif.markAllRead": "すべて既読にする",
  "notif.title": "通知",
  "notif.subtitle": "インストール・更新・失敗など、最近の出来事を新しい順に表示します。",
  "notif.empty.title": "まだ通知はありません",
  "notif.empty.message": "アプリをインストールしたり更新したりすると、ここに出来事が並びます。",
  "notif.empty.cta": "ストアでアプリを探す",
  "notif.attention": "要対応の出来事が {n} 件あります。",
  "notif.badge.attention": "要対応",
  "notif.event.installCreated": "「{name}」のインストールを始めました",
  "notif.event.installCreatedEnv": "環境: {env}",
  "notif.event.planReady": "{operation}の準備ができました",
  "notif.event.planReadyNamed": "「{name}」の{operation}の準備ができました",
  "notif.event.planReadyDetail": "内容を確認して承認できます",
  "notif.event.planBlockedDetail": "ポリシーにより承認が止まっています",
  "notif.event.approved": "{operation}を承認しました",
  "notif.event.approvedNamed": "「{name}」の{operation}を承認しました",
  "notif.event.applied": "アプリの変更を適用しました",
  "notif.event.appliedNamed": "「{name}」の変更を適用しました",
  "notif.event.appliedDetail": "値 {n} 件を更新",
  "notif.event.destroyed": "アプリをアンインストールしました",
  "notif.event.destroyedNamed": "「{name}」をアンインストールしました",
  "notif.event.failed": "{operation}に失敗しました",
  "notif.event.failedNamed": "「{name}」の{operation}に失敗しました",
  "notif.event.drift": "アプリのクラウド上の状態が記録とずれています",
  "notif.event.driftNamed": "「{name}」のクラウド上の状態が記録とずれています",
  "notif.event.driftDetail": "実際の状態が設定とずれている可能性があります",
  "notif.event.stale": "連携先のアプリが更新されたため、このアプリに更新があります",
  "notif.event.staleNamed": "連携先のアプリが更新されたため、「{name}」に更新があります",
  "notif.event.staleDetail": "更新元: {producer}",
  "notif.event.staleSource": "このアプリの新しい版があります",
  "notif.event.staleSourceNamed": "「{name}」の新しい版があります",
  "notif.event.connCreated": "接続「{provider}」を追加しました",
  "notif.event.connCreatedGeneric": "接続を追加しました",
  "notif.event.connRevoked": "接続「{provider}」が無効になりました",
  "notif.event.connRevokedGeneric": "接続が無効になりました",
  "notif.event.backupCreated": "管理情報を書き出しました",
  "notif.event.depCreated": "アプリ同士を連携しました",
  "notif.event.depDeleted": "アプリ同士の連携を解除しました",
  "notif.event.shareRequested": "スペース間の値の共有を依頼されました",
  "notif.event.shareApproved": "スペース間の値の共有を承認しました",
  "notif.event.shareRevoked": "スペース間の値の共有を取り消しました",
  "notif.event.groupCreated": "まとめての更新を開始しました",
  "notif.event.autoUpdateOn": "自動更新をオンにしました",
  "notif.event.autoUpdateOff": "自動更新をオフにしました",
  "notif.event.autoUpdateFailed": "自動更新を完了できませんでした",
  "notif.event.autoUpdateFailedNamed":
    "「{name}」の自動更新を完了できませんでした",
  "notif.event.autoUpdateFailedDetail": "アプリのページで更新内容を確認してください",
  "notif.event.uninstallScheduled": "アプリのアンインストールを予約しました",
  "notif.event.uninstallScheduledNamed": "「{name}」のアンインストールを予約しました",
  "notif.event.uninstallCancelled": "アンインストールの予約を取り消しました",
  "notif.event.uninstallCancelledNamed": "「{name}」のアンインストールの予約を取り消しました",
  "notif.event.uninstallBlocked": "予約したアンインストールが止まりました",
  "notif.event.uninstallBlockedNamed": "「{name}」の予約したアンインストールが止まりました",
  "notif.event.uninstallBlockedDetail": "アプリのページで、取り消すか今すぐアンインストールしてください",
  "notif.event.interfaceDeadLettered": "アプリの画面を用意できませんでした",
  "notif.event.interfaceDeadLetteredNamed": "「{name}」の画面を用意できませんでした",
  "notif.event.interfaceDeadLetteredDetail": "アプリのページから、もう一度試してください",
  "notif.event.interfaceRetryRequested": "アプリの画面の準備をもう一度試しています",
  "notif.event.interfaceRetryRequestedNamed": "「{name}」の画面の準備をもう一度試しています",
  "notif.event.recorded": "記録された操作",
  "notif.otherWorkspace": "別のスペース「{name}」",

  // --- activity -------------------------------------------------------------------
  "activity.actorYou": "あなた",
  "activity.actorSystem": "Takosumi（自動）",

  // --- run group ---------------------------------------------------------------
  "runGroup.title": "ワークスペース更新",
  "runGroup.subtitle": "複数サービスの変更をまとめて確認・承認できます。",
  "runGroup.approveAll": "まとめて承認",
  "runGroup.approveAllConfirm.title": "まとめて承認しますか？",
  "runGroup.approveAllConfirm.message":
    "{n} 件のサービスの変更をまとめて実行します。",
  "runGroup.approveAllConfirm.messageDanger":
    "{n} 件のサービスの変更をまとめて実行します。削除を含む破壊的な変更があり、元に戻せません。",
  "runGroup.members": "この更新に含まれるサービス",
  "runGroup.membersEmpty": "この更新に含まれるサービスはありません。",
  "runGroup.openService": "サービスを開く",
  "runGroup.openServiceAria": "サービス「{name}」を開く",
  "runGroup.openRun": "変更内容を開く",
  "runGroup.openRunAria": "「{name}」の変更内容を開く",
  "runGroup.groupId": "更新 ID",
  "runGroup.progressStatus": "{total} 件中 {done} 件が完了",
  "runGroup.refreshFailed":
    "最新の状態を取得できませんでした。最後に取得した内容を表示しています。",

  // --- account ---------------------------------------------------------------------
  "account.title": "アカウント",
  "account.sectionsLabel": "アカウントの項目",
  "account.section.me": "自分",
  "account.section.members": "メンバー",
  "account.section.billing": "料金と利用量",
  "account.section.space": "スペース",
  "account.section.cli": "CLI・APIから使う",
  "account.profile.title": "サインイン中のアカウント",
  "account.profile.displayName": "名前",
  "account.profile.email": "メール",
  "account.profile.notSet": "未設定",
  "account.profile.provider": "サインイン方法",
  "account.profile.nameHint":
    "名前とメールは、サインインに使ったアカウントのものです。名前は同じスペースのメンバーに、メールはそのスペースのオーナーと管理者にだけ表示されます。",
  "account.language.title": "言語",
  "account.theme.title": "表示",
  "account.preferences.title": "表示と言語",
  "account.preferences.body": "このブラウザでの見た目と言語です。",
  "account.installTarget.title": "ストアのインストールリンク",
  "account.installTarget.body":
    "ストアの「インストール」ボタンを、この端末ではこのダッシュボードで開くようブラウザに登録します。",
  "account.installTarget.register": "この端末を登録",
  "account.installTarget.registered": "この端末は登録済み",
  "account.installTarget.done": "登録しました。ブラウザの確認に応じてください。",
  "account.installTarget.unsupported":
    "このブラウザは登録に対応していません。ストアでこのダッシュボードの URL を入力してください。",
  "account.morePages.title": "運営者のページ",
  "account.signOut.title": "サインアウト",
  "account.signOut.body": "このブラウザからサインアウトします。ほかの端末のサインインはそのままです。",
  "account.signOut.cta": "このブラウザからサインアウト",
  "account.signOut.confirm": "サインアウトしますか？",
  "account.apiKeys.title": "CLI・APIから使う",
  "account.apiKeys.subtitle":
    "Takosumi CLI や自動化から、あなたとして操作するためのキーです。CLI では --token にキーを渡します。",
  "account.apiKeys.apiHelp":
    "API を直接呼ぶときは、同じキーを Authorization: Bearer ヘッダーに入れて /api/v1 に送ります。",
  "account.apiKeys.secretOnce": "キーの値は、作成した直後に一度だけ表示されます。",
  "account.apiKeys.name": "キーの名前",
  "account.apiKeys.namePlaceholder": "例: 開発用 CLI",
  "account.apiKeys.expiresLabel": "有効期間",
  "account.apiKeys.expiresDays": "{days}日",
  "account.apiKeys.scopes": "権限",
  "account.apiKeys.scopesHint":
    "このキーに必要な権限だけを選択してください。管理権限は運用者のみが発行でき、この画面からは作成できません。",
  "account.apiKeys.scopeCatalog.loading": "利用できる権限を読み込んでいます…",
  "account.apiKeys.scopeCatalog.loadFailed":
    "利用できる権限を読み込めませんでした。読み込みが完了するまでキーは作成できません。",
  "account.apiKeys.scopeCatalog.retry": "権限を再読み込み",
  "account.apiKeys.scopeCatalog.empty": "この環境では、この画面から付与できる権限がありません。",
  "account.apiKeys.scopeCatalog.workspaceRequired":
    "この権限のキーを作るには、先にスペースを作成してください。",
  "account.apiKeys.restrictWorkspace": "今のスペースでだけ使えるようにする",
  "account.apiKeys.create": "キーを作成",
  "account.apiKeys.createSubmit": "作成",
  "account.apiKeys.listLabel": "あなたのキー",
  "account.apiKeys.created": "API キーを作成しました",
  "account.apiKeys.createdHint":
    "この値は再表示できません。今すぐ安全な場所へ保存してください。",
  "account.apiKeys.copy": "コピー",
  "account.apiKeys.copied": "コピーしました",
  "account.apiKeys.copyFailed":
    "コピーできませんでした。表示されている値を手動で保存してください。",
  "account.apiKeys.error": "API キーの操作を完了できませんでした: {message}",
  "account.apiKeys.empty": "まだキーはありません。",
  "account.apiKeys.workspaceBound": "このスペースだけ",
  "account.apiKeys.lastUsed": "最後に使用:",
  "account.apiKeys.neverUsed": "未使用",
  "account.apiKeys.status.active": "有効",
  "account.apiKeys.status.revoked": "無効",
  "account.apiKeys.status.expired": "期限切れ",
  "account.apiKeys.expires": "{date} まで",
  "account.apiKeys.noExpiry": "期限なし",
  "account.apiKeys.revoke": "無効にする",
  "account.apiKeys.revokeConfirm": "無効にする",
  "account.apiKeys.revokeConsequence": "このキーを使っている CLI や自動化は、すぐに使えなくなります。",

  // --- billing -------------------------------------------------------------------
  "billing.mode.disabled": "このスペースでは、Takosumi は料金を請求しません。",
  "billing.mode.showback": "Takosumi はこのスペースの利用量を記録しますが、請求はしません。",
  "billing.loadError": "料金を読み込めませんでした: {message}",
  "billing.title": "料金",
  "billing.ownersOnly": "料金と利用量は、このスペースのオーナーと管理者が確認できます。",
  "billing.cloudCosts": "アプリが作るクラウドのリソースは、それぞれのクラウドから請求されます。",
  "billing.usage.quantityLine": "量 {quantity}",
  "billing.usage.amountUnknown": "金額不明",
  "billing.usage.removedApp": "削除済みのアプリ",
  "billing.usage.title": "利用量",
  "billing.usage.subtitle": "このスペースで記録された利用量です。新しい順に並びます。",
  "billing.usage.more": "さらに読み込む",
  "billing.usage.error": "利用量を読み込めませんでした: {message}",
  "billing.usage.empty": "まだ利用量はありません。",
  "billing.usage.kind.runner_minute": "実行時間",
  "billing.usage.kind.operation": "アプリの操作",
  "billing.usage.kind.compute": "コンピュート",
  "billing.usage.kind.storage": "ストレージ",
  "billing.commercial.description":
    "プリペイドクレジットはTakosumiの使用量に充当され、有効期限はありません。",
  "billing.commercial.loadError":
    "プリペイドクレジットと支払い情報を読み込めませんでした: {message}",
  "billing.commercial.actionError":
    "支払い操作を完了できませんでした: {message}",
  "billing.commercial.unavailable":
    "支払い設定を一時的に利用できません。既存の使用量記録には影響しません。",
  "billing.commercial.checkout.success":
    "支払いが完了しました。決済事業者による確定後、プリペイドクレジットが追加されます。",
  "billing.commercial.checkout.cancelled":
    "支払い設定をキャンセルしました。変更はありません。",
  "billing.commercial.manage": "支払い方法を管理",
  "billing.commercial.status.unknown": "不明",
  "billing.commercial.account.status.active": "Takosumi 利用可能",
  "billing.commercial.account.status.trialing": "Takosumi 利用可能",
  "billing.commercial.account.status.pastDue": "支払い確認が必要",
  "billing.commercial.account.status.disabled": "Takosumi 利用停止中",
  "billing.commercial.account.blocked.paymentDisputed":
    "支払いに異議申し立てがあるため、新しいTakosumiの利用を停止しています。表示中のプリペイドクレジットは失効しません。支払い設定で異議申し立てを解決してください。",
  "billing.commercial.account.blocked.paymentPastDue":
    "支払いを確認できないため、新しいTakosumiの利用を停止しています。表示中のプリペイドクレジットは失効しません。支払い方法を確認してください。",
  "billing.commercial.account.blocked.disabled":
    "課金アカウントが無効なため、新しいTakosumiの利用を停止しています。表示中のプリペイドクレジットは失効しません。支払い設定を確認してください。",
  "billing.commercial.account.blocked.suspended":
    "課金アカウントの確認が必要なため、新しいTakosumiの利用を停止しています。表示中のプリペイドクレジットは失効しません。支払い設定を確認してください。",
  "billing.commercial.lowCredit.autoRecharge":
    "利用可能クレジットが少なくなっています。保存済みのしきい値で自動チャージされます。",
  "billing.commercial.lowCredit.manual":
    "利用可能クレジットが少なくなっています。利用を続けるにはプリペイドクレジットを追加してください。",
  "billing.commercial.customerType.label": "利用区分",
  "billing.commercial.customerType.individual": "個人",
  "billing.commercial.customerType.business": "法人",
  "billing.commercial.country.label": "請求先の国",
  "billing.commercial.country.select": "国を選択",
  "billing.commercial.profile.title": "請求先情報",
  "billing.commercial.profile.hint":
    "支払い設定後は、利用区分と請求先の国を変更できません。",
  "billing.commercial.balance.available": "利用可能クレジット",
  "billing.commercial.balance.reserved": "確保済みクレジット",
  "billing.commercial.balance.noExpiry":
    "使用量に応じて利用可能クレジットから差し引き・プリペイドクレジットに有効期限なし",
  "billing.commercial.paymentMethod.ready": "支払い方法を保存済み",
  "billing.commercial.paymentMethod.missing": "支払い方法が未登録",
  "billing.commercial.credits.title": "プリペイドクレジットを追加",
  "billing.commercial.credits.subtitle":
    "追加するプリペイドクレジット額を選びます。Checkoutで支払い方法を安全に保存しますが、自動チャージは下で有効にするまで行いません。",
  "billing.commercial.credits.choose": "追加するプリペイドクレジット額を選択",
  "billing.commercial.credits.taxNote": "適用される税金は、決済時に決済事業者が計算します。",
  "billing.commercial.credits.add": "プリペイドクレジットを追加",
  "billing.commercial.autoRecharge.title": "自動チャージ",
  "billing.commercial.autoRecharge.subtitle":
    "利用可能クレジットがしきい値を下回ったときにプリペイドクレジットを追加します。月上限は強制的な安全上限です。",
  "billing.commercial.autoRecharge.enable": "自動チャージを有効にする",
  "billing.commercial.autoRecharge.requiresCard":
    "最初に一度プリペイドクレジットを追加して、支払い方法を保存してください。",
  "billing.commercial.autoRecharge.on": "オン",
  "billing.commercial.autoRecharge.off": "オフ",
  "billing.commercial.autoRecharge.onSummary":
    "利用可能クレジットが {threshold} 未満になると {amount} 分のプリペイドクレジットを追加（1か月 {limit} まで）",
  "billing.commercial.autoRecharge.threshold":
    "利用可能クレジットがこの額を下回ったら",
  "billing.commercial.autoRecharge.amount": "プリペイドクレジット額",
  "billing.commercial.autoRecharge.monthlyLimit": "1か月の上限",
  "billing.commercial.autoRecharge.save": "自動チャージ設定を保存",
  "billing.commercial.payment.title": "クレジット支払い履歴",
  "billing.commercial.payment.subtitle":
    "プリペイドクレジットの追加と自動チャージの最近の支払いです。",
  "billing.commercial.payment.empty": "クレジット支払いはまだありません。",
  "billing.commercial.payment.date": "日付",
  "billing.commercial.payment.status": "状態",
  "billing.commercial.payment.amount": "金額",
  "billing.commercial.payment.action": "領収書",
  "billing.commercial.payment.open": "開く",
  "billing.commercial.payment.count": "{count}件",
  "billing.commercial.payment.status.paid": "支払い済み",
  "billing.commercial.payment.status.failed": "失敗",
  "billing.commercial.payment.status.partiallyRefunded": "一部返金済み",
  "billing.commercial.payment.status.refunded": "返金済み",
  "billing.commercial.payment.status.disputed": "異議申し立て中",
  "billing.commercial.transaction.title": "利用明細",
  "billing.commercial.transaction.subtitle": "このスペースの課金済み・取り消し済みの利用明細です。",
  "billing.commercial.transaction.empty": "利用明細はまだありません。",
  "billing.commercial.transaction.error":
    "利用明細を読み込めませんでした: {message}",
  "billing.commercial.transaction.more": "さらに読み込む",
  "billing.commercial.transaction.time": "日時",
  "billing.commercial.transaction.status": "状態",
  "billing.commercial.transaction.resource": "リソース",
  "billing.commercial.transaction.operation": "操作 / メーター",
  "billing.commercial.transaction.quantity": "数量",
  "billing.commercial.transaction.amount": "金額",
  "billing.commercial.transaction.status.charged": "課金済み",
  "billing.commercial.transaction.status.reversed": "取り消し済み",
} as const;
