/**
 * Japanese master dictionary. This file owns the key set: `en.ts` is
 * type-checked against `keyof typeof ja`, so adding/removing a key here forces
 * the English side to follow. Keys are namespaced `area.item`; `{param}`
 * placeholders are interpolated by `t()`.
 *
 * Vocabulary contract (the unified verb set — do not reintroduce 公開/反映):
 *   Noun (surface split): ストアの商品はサービス、デプロイされた Capsule は
 *   ワークロード、実体はリソース、利用可能な接続口は Interface、ホームで
 *   起動するものはアプリ。同じパネル内でこれらを混同しない。
 *   追加 (install) → 変更を確認 (plan) → デプロイ (apply) → デプロイ済み (active)
 */
export const ja = {
  "installStore.title": "サービスを追加",
  "installStore.subtitle":
    "見つけて、追加する。それだけです。必要な設定は追加後にこの画面で案内します。",
  "installStore.browseTitle": "サービスを探す",
  "installStore.browseHint":
    "ストアから選ぶか、公開Gitリポジトリを指定します。",
  "installStore.manual": "Gitリポジトリから追加",
  "installStore.back": "選び直す",
  "installStore.entryLoadTitle": "追加候補を確認",
  "installStore.entryLoadHint":
    "明示したGitリポジトリから候補文書を読み込みます。この操作で読み取り用のSourceとRunが作成されます。",
  "installStore.entryLoad": "候補を読み込む",
  "installStore.entryHint": "追加するサービスを1つ選んでください。",
  "installStore.select": "これを選ぶ",
  "installStore.configureHint":
    "名前を確認したら追加できます。リポジトリ解析はその後に行います。",
  "installStore.name": "サービス名",
  "installStore.sourceDetails": "取得元の詳細",
  "installStore.sourceUrl": "Git URL",
  "installStore.sourceRef": "ref（省略可）",
  "installStore.sourcePath": "module path",
  "installStore.sourceAuth": "Git接続",
  "installStore.publicSource": "公開リポジトリ",
  "installStore.add": "追加",
  "installStore.preparing": "追加の準備をしています",
  "installStore.preparingHint":
    "リポジトリを確認し、必要な接続と変更内容をまとめています。",
  "installStore.compatibilityFailed":
    "このサービスは現在の環境に追加できません。",
  "installStore.providerTitle": "接続が必要です",
  "installStore.destinationTitle": "実行先を選択",
  "installStore.destinationHint":
    "利用できる実行先が複数あります。このサービスで使う実行先を選んでください。",
  "installStore.providerHint": "このサービスに必要な接続だけを選びます。",
  "installStore.chooseConnection": "接続を選択",
  "installStore.destination": "実行先",
  "installStore.connect": "新しい接続を追加",
  "installStore.continue": "続ける",
  "installStore.setupTitle": "サービスを設定",
  "installStore.setupHint": "このサービスが必要とする項目だけを入力します。",
  "installStore.sourceBuildTitle": "リポジトリのビルド手順",
  "installStore.sourceBuildHint":
    "Planを開始する前に、認証情報を使わないコマンドと生成されるパスを確認してください。",
  "installStore.sourceBuildCommand": "コマンド {index}",
  "installStore.sourceBuildWorkingDirectory": "作業ディレクトリ",
  "installStore.sourceBuildSourceRoot": "Source root",
  "installStore.sourceBuildOutputs": "生成されるパス",
  "installStore.setupInvalid": "サービスの設定定義が無効です。",
  "installStore.setupRequired": "{label}を入力してください。",
  "installStore.secretUnavailable":
    "このシークレットは接続として設定してください。",
  "installStore.secretHint":
    "シークレットはこのフォームから変数として送信しません。",
  "installStore.reviewing": "変更内容を確認しています",
  "installStore.reviewingHint": "安全に適用できるかPlanを確認しています。",
  "installStore.reviewTitle": "インストール前の確認",
  "installStore.reviewHint": "Takosumiが行う変更です。",
  "installStore.changes": "変更数",
  "installStore.createCount": "作成",
  "installStore.updateCount": "変更",
  "installStore.deleteCount": "削除",
  "installStore.approve": "Planを承認",
  "installStore.confirmTitle": "確認が必要な変更があります",
  "installStore.confirmHint":
    "削除または明示承認が必要な変更を含みます。内容を確認してください。",
  "installStore.confirm": "変更内容を確認しました",
  "installStore.install": "インストール",
  "installStore.runDetails": "技術的な詳細",
  "installStore.installing": "インストールしています",
  "installStore.installingHint": "この画面を開いたままお待ちください。",
  "installStore.planBlocked": "このPlanは適用できません",
  "installStore.planBlockedHint":
    "ポリシーまたはPlanの詳細を確認してください。",
  "installStore.readinessFailed":
    "サービスの公開状態を確認できませんでした。技術的な詳細を確認してください。",
  "installStore.activationFailed":
    "サービスの公開処理に失敗しました。技術的な詳細を確認してください。",
  "installStore.runFailed": "インストールを完了できませんでした",
  "installStore.runFailedHint":
    "技術的な詳細を確認して、もう一度お試しください。",
  "installStore.doneTitle": "追加できました",
  "installStore.doneHint": "サービスを開いて使い始められます。",
  "installStore.open": "サービスを開く",
  "installStore.chooseAnother": "別のサービスを追加",
  "installStore.invalidSource": "有効なhttpsのGit URLを入力してください。",
  "installStore.invalidName":
    "サービス名は半角小文字・数字・ハイフンで入力してください。",
  "installStore.planMissing": "Planの開始結果を確認できませんでした。",
  "installStore.listingUnavailable":
    "このサービスをStoreから取得できませんでした。",
  // --- common -------------------------------------------------------------
  "common.loading": "読み込み中…",
  "common.retry": "再試行",
  "common.refresh": "更新",
  "common.create": "作成",
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
  "common.showingRecent": "直近 {n} 件を表示しています",

  // --- nav / shell ----------------------------------------------------------
  "nav.home": "ホーム",
  "nav.workloads": "ワークロード",
  "nav.store": "ストア",
  "nav.settings": "設定",
  "nav.graph": "依存関係",
  "nav.runs": "デプロイ履歴",
  "nav.connections": "接続済みアカウント",
  "nav.billing": "使用量",
  "nav.activity": "操作履歴",
  "nav.primary": "主な操作",
  "nav.notifications": "通知",
  "nav.workspaceSettings": "ワークスペース設定",
  "nav.account": "アカウント",
  "nav.docs": "ドキュメント",
  "nav.backToTakos": "Takos に戻る",
  "nav.deployContext": "サービス運用",
  "shell.skipToContent": "本文へスキップ",
  "shell.userMenu": "ユーザーメニュー",
  "shell.signOut": "サインアウト",
  "shell.language": "言語",
  "shell.theme": "表示",
  "shell.notificationsAria": "通知（要対応 {n} 件）",
  "theme.system": "自動",
  "theme.light": "ライト",
  "theme.dark": "ダーク",

  // --- settings hub -----------------------------------------------------------
  "settings.title": "設定",
  "settings.subtitle":
    "アカウント、使用量、通知、詳しい管理画面はここからです。",
  "settings.section.general": "全般",
  "settings.section.advanced": "詳しい管理",
  "settings.account.title": "アカウント",
  "settings.account.desc": "プロフィールとサインイン情報",
  "settings.billing.title": "使用量",
  "settings.billing.desc": "利用状況と、運営者が示す費用の内訳",
  "settings.notifications.title": "通知",
  "settings.notifications.desc": "お知らせと要対応の確認",
  "settings.manage.entry": "管理ツール",
  "settings.manage.entryDesc":
    "サービスの内部、接続、実行履歴などの詳しい管理画面",
  "settings.manage.title": "管理ツール",
  "settings.manage.subtitle":
    "ホスティングの内部を直接あつかう画面です。ふだんの利用では開く必要はありません。",
  "settings.manage.workloads": "デプロイ済みワークロードと状態の一覧",
  "settings.manage.connections": "クラウドアカウントの接続とカギの管理",
  "settings.manage.runs": "デプロイと変更の実行記録",
  "settings.manage.graph": "サービス間の依存関係の表示",
  "settings.manage.activity": "だれが何を変更したかの操作履歴",
  "settings.manage.workspace":
    "アクセスと共有、キー、バックアップ、ポリシー",
  "settings.manage.backups": "復元ポイントの作成と復元",
  "settings.manage.shares": "サービス間で共有する値の管理",

  // --- workspace switcher -------------------------------------------------------
  "workspace.label": "自分のワークスペース",
  "workspace.none": "ワークスペースがまだありません",
  "workspace.select": "この画面で使うワークスペースを選択",
  "workspace.selectMessage":
    "この作業を保存するワークスペースを選びます。",
  "workspace.loading": "ワークスペースを読み込み中…",
  "workspace.loadFailed": "ワークスペースを読み込めませんでした — {message}",
  "workspace.settings": "ワークスペース設定",
  "workspace.switcherAria":
    "自分のワークスペースを切り替え（現在: {name}）",
  "workspace.defaultName": "個人",
  "workspace.start.aria": "自分のワークスペースを始める",
  "workspace.start.kicker": "自分のワークスペース",
  "workspace.start.title": "用途ごとのワークスペースを作成",
  "workspace.start.body":
    "サービス、接続済みアカウント、履歴、使用量、設定を自分のワークスペースにまとめます。",
  "workspace.start.create": "新しいワークスペース",
  "workspace.start.creating": "作成中…",
  "workspace.create.nameLabel": "用途または名前",
  "workspace.create.namePlaceholder": "個人、仕事、実験、Client A",
  "workspace.create.nameRequired": "用途または名前を入力してください。",
  "workspace.create.purposeHelp":
    "初期状態は自分専用です。共有は詳しい設定から後で行えます。",
  "workspace.create.failed": "ワークスペースを作成できませんでした — {message}",

  // --- auth -----------------------------------------------------------------
  "auth.signIn": "サインイン",
  "legal.policiesNav": "operator のポリシー",
  "auth.signInSub": "設定済みの ID プロバイダーでサインインします。",
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
  "auth.installContextAria": "サインイン後に続行するサービス",
  "auth.installContextKicker": "追加を続行",
  "auth.installContextTitle": "サインイン後に続行します",
  "auth.installContextRef": "バージョン {ref}",
  "auth.installContextDefaultRef": "既定のバージョン",
  "auth.installContextRootPath": "メインフォルダ",
  "auth.termsPrefix": "続行することで",
  "auth.termsOfService": "利用規約",
  "auth.and": "と",
  "auth.privacyPolicy": "プライバシーポリシー",
  "auth.termsSuffix": "に同意したものとみなします。",
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
  "errorBoundary.title": "問題が発生しました",
  "errorBoundary.body":
    "予期しないエラーで画面を表示できませんでした。ページを再読み込みしてください。",
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
  "apps.needsAttention": "要対応",
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
  "app.tab.danger": "削除",
  "app.notFound": "サービスが見つかりません",
  "app.backToList": "一覧へ",
  "app.loadFailedTitle": "サービスを読み込めませんでした",
  "app.refreshFailed":
    "最新の状態を取得できませんでした。表示は最後に取得した内容です。",
  "app.notFoundMessage": "削除されたか、リンクが違う可能性があります。",
  "app.surfaces.title": "公開リンク",
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
  "app.surfaces.open": "公開リンクを開く",
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
  "app.deploys.empty": "まだデプロイ履歴はありません。",
  "app.deploys.restore": "この状態に戻す",
  "app.deploys.restoreDisclosure": "以前の状態に戻す",
  "app.deploys.advancedActions": "必要なときだけ使う操作",
  "app.deploys.advancedActionsBody":
    "復元ポイントやバックアップが必要な場合だけ使います。",
  "app.deploys.backup": "バックアップを作成",
  "app.deploys.backupCreated": "バックアップを作成しました。",
  "app.deploys.backupSupportRef": "バックアップ ID",
  "app.deploys.inventoryTitle": "デプロイ済みリソース",
  "app.deploys.inventoryRecordedNote":
    "現在の適用状態に記録された内容です。ライブ稼働状態ではありません。",
  "app.deploys.inventoryLoadError":
    "記録済みリソース一覧を読み込めませんでした。",
  "app.deploys.inventoryLegacyUnavailable":
    "この古い適用状態にはリソース一覧の記録がありません。",
  "app.deploys.inventoryGeneration": "状態世代",
  "app.deploys.inventoryRecordedAt": "記録日時",
  "app.deploys.inventoryStateVersion": "状態バージョン",
  "app.deploys.inventoryApplyRun": "Apply 実行",
  "app.deploys.inventoryPlanRun": "Plan 実行",
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
  "app.config.subtitle":
    "公開名、URL、初期ログイン、サービスが使う値を変更できます。保存後、次のデプロイ確認に反映されます。",
  "app.config.publicUrl": "公開URL",
  "app.config.subdomain": "公開サブドメイン",
  "app.config.oidc": "自動ログイン",
  "app.config.oidcOn": "有効",
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
  "app.config.resetPendingHint": "保存すると既定値に戻ります。",
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
  "app.config.savedNeedsDeploy":
    "保存しました。変更を反映するにはデプロイしてください。",
  "app.config.deployChanges": "変更をデプロイ",
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
  "app.setupIncomplete.body":
    "追加が完了していません。変更の確認からやり直すか、削除してやり直せます。",
  "app.setupIncomplete.review": "更新タブへ",
  "app.setupIncomplete.delete": "削除オプション",

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
  "run.summary.alreadyApplied":
    "この変更のデプロイは実行済みです。結果はアクティビティから確認できます。",
  "run.summary.applying": "デプロイを実行しています…",
  "run.summary.finishing": "デプロイを仕上げています…",
  "run.summary.checkingDeploy": "デプロイの準備を確認しています…",
  "run.summary.activationPending": "サービスの公開処理を仕上げています…",
  "run.summary.activationFailed":
    "インフラのデプロイ後のサービス公開に失敗しました。",
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
  "controlError.compatibilityStale":
    "確認結果が古くなりました。もう一度確認してください。",
  "controlError.runnerUnavailable":
    "実行環境をいま利用できません。時間をおいてもう一度お試しください。",
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
  "run.summary.hostnameSlotLimit": "短いURLの空き枠がありません。",
  "run.summary.hostnameSlotLimitHint":
    "通常URLを使うか、既存の短いURLを解放してからもう一度実行してください。",
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
  "run.diagnostics.hostnameSlotLimitShort": "短いURLの空き枠がありません。",
  "run.diagnostics.hostnameSlotLimitDetail":
    "通常URLを使うか、既存の短いURLを解放してからもう一度実行してください。",
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

  // --- run history --------------------------------------------------------------
  "runList.title": "デプロイ履歴",
  "runList.subtitle": "最近の確認・承認・デプロイを新しい順に表示します。",
  "runList.open": "詳細",
  "runList.review": "確認する",
  "runList.openAria": "詳細を開く: {title}",
  "runList.reviewAria": "確認する: {title}",
  "runList.empty.title": "まだ更新履歴はありません",
  "runList.empty.message":
    "サービスを追加して変更を確認すると、ここに履歴が並びます。",
  "runList.applied": "デプロイ",
  "runList.destroyed": "削除",
  "runList.failed": "{operation}に失敗しました",
  "runList.namesUnavailable":
    "サービス名を取得できませんでした。名前なしで表示しています。",

  // --- add flow (/new) -------------------------------------------------------
  "new.git.defaultRef": "Git の既定ブランチ",
  "new.compat.ready": "このまま追加できます",
  "new.compat.patch": "手直しが必要です",
  "new.compat.unsupported": "今は追加できません",
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
    "別のバージョンを選ぶか、配布元へ .well-known/takosumi.json の修正を依頼してください。Takosumi が生のモジュール変数へ置き換えることはありません。",
  "new.compat.issue.providerPreserved.message":
    "取得元にある {provider} の非秘密設定はそのまま維持されます。",
  "new.compat.issue.backendIsolated.message":
    "取得元の backend 設定を維持したまま、Takosumi が Run の state 境界を分離します。",
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
  "new.error.invalidHostname":
    "この公開名は長すぎるか、使えない文字を含んでいます。もう少し短い名前にして、もう一度お試しください。",
  "new.error.connectionRequired":
    "このサービスの公開にはクラウドアカウントの接続が必要です。接続を設定してから、もう一度お試しください。",
  "new.error.appHostnameUnavailable":
    "この公開URL名は既に使われています。別の名前にして、もう一度お試しください。",
  "new.error.managedHostnameSlotLimit":
    "短いURLの空き枠がありません。通常URLを使うか、既存の短いURLを解放してください。",
  "new.error.alreadyExistsGeneric":
    "このサービスは既に追加されています。一覧から既存サービスを開いてください。",
  "workspaceSettings.title": "設定",
  "workspaceSettings.tabsLabel": "設定セクション",
  "workspaceSettings.subtitle":
    "ワークスペース名、接続、使用量、必要に応じたアクセス設定を確認します。",
  "workspaceSettings.tab.general": "一般",
  "workspaceSettings.tab.members": "アクセスと共有",
  "workspaceSettings.tab.connections": "接続",
  "workspaceSettings.tab.billing": "使用量",
  "workspaceSettings.tab.usageQuota": "使用量",
  "workspaceSettings.tab.backups": "バックアップ",
  "workspaceSettings.tab.shares": "共有値",
  "workspaceSettings.general.displayName": "表示名",
  "workspaceSettings.general.handle": "ハンドル",
  "workspaceSettings.general.type": "種別",
  "workspaceSettings.general.owner": "オーナー",
  "workspaceSettings.general.updated": "更新日時",
  "workspaceSettings.general.advancedDetails": "詳細情報",
  "workspaceSettings.general.saved": "設定を保存しました。",
  "workspaceSettings.general.archive": "ワークスペースを非表示",
  "workspaceSettings.general.archiveConfirm":
    "ワークスペースを通常の切り替え一覧から非表示にするだけです。実行中のサービス、履歴、使用量、保存データは停止・削除されません。下の「アーカイブ済み」からいつでも元に戻せます。",
  "workspaceSettings.general.archivedNamed":
    "「{name}」を通常の切り替え一覧から非表示にしました。",
  "workspaceSettings.general.archivedHint":
    "表示が変わるだけで、サービスと使用量はこれまでどおりです。復元は下のアーカイブ済み一覧から、別のワークスペースへの移動はワークスペース切り替えからできます。",
  "workspaceSettings.general.notFound":
    "このワークスペースは見つかりませんでした。切り替えるか、下のアーカイブ済みから復元してください。",
  "workspaceSettings.general.archivedTitle": "アーカイブ済みのワークスペース",
  "workspaceSettings.general.unarchive": "復元",
  "workspaceSettings.general.archiveLastError":
    "最後のワークスペースは非表示にできません。",
  "workspaceSettings.general.nameRequired": "表示名を入力してください。",

  // --- members ---------------------------------------------------------------
  "members.role.owner": "オーナー",
  "members.role.admin": "管理者",
  "members.role.member": "メンバー",
  "members.role.viewer": "閲覧のみ",
  "members.status.active": "有効",
  "members.status.invited": "招待中",
  "members.status.suspended": "停止中",
  "members.invite.title": "アクセスを共有",
  "members.invite.subtitle":
    "一度サインイン済みの相手のメールアドレスを入力してください。追加するとすぐに利用できます（メールは送られません）。",
  "members.invite.email": "メールアドレス",
  "members.invite.role": "役割",
  "members.invite.cta": "追加",
  "members.invite.notFound":
    "そのメールアドレスの Takosumi アカウントが見つかりません。相手に一度サインインしてもらってください。",
  "members.invite.emailRequired": "メールアドレスを入力してください。",
  "members.invite.success": "{email} を追加しました。すぐに利用できます。",
  "members.col.member": "メンバー",
  "members.col.roles": "役割",
  "members.col.status": "状態",
  "members.col.actions": "操作",
  "members.you": "あなた",
  "members.changeRole": "役割を変更",
  "members.roleSelectLabel": "{name} の役割",
  "members.roleChangeConfirmTitle": "役割の変更",
  "members.roleChangeConfirmMessage":
    "{name} の役割を「{role}」に変更しますか？",
  "members.lastOwnerDemote":
    "最後のオーナーは降格できません。先に別のオーナーを指名してください。",
  "members.lastOwnerRemove":
    "最後のオーナーは削除できません。先に別のオーナーを指名してください。",
  "members.remove": "削除",
  "members.removeSelf": "自分を削除",
  "members.removeSelfConfirm":
    "自分をこのワークスペースから削除します。以後このワークスペースにアクセスできなくなり、自分では戻せません。",
  "members.removeConfirm": "このメンバーを削除しますか？（{account}）",
  "members.empty": "このワークスペースにはまだメンバーがいません。",
  "members.viewerNote":
    "メンバーの招待・役割変更・削除はオーナーまたは管理者のみ行えます。",

  // --- connections -------------------------------------------------------------
  "conn.subtitle":
    "自分の認証情報で外部プロバイダーを接続します。利用可否は operator の provider policy、runner capability、Run approval に従います。",
  "conn.providerConnections.title": "接続済みアカウント",
  "conn.expiresAt": "期限: {date}",
  "conn.oauth.connected": "プロバイダー接続を保存しました。",
  "conn.oauth.failed": "接続に失敗しました。もう一度お試しください。",
  "conn.oauth.error.missingCode":
    "認証の応答が不完全でした。もう一度お試しください。",
  "conn.oauth.error.forbidden":
    "このワークスペースに接続する権限がありません。",
  "conn.oauth.error.oauthFailed":
    "プロバイダーとの認証に失敗しました。時間をおいてもう一度お試しください。",
  "conn.oauth.errorCode": "エラーコード: {code}",
  "conn.return.title": "{name} の追加に戻る",
  "conn.return.subtitle":
    "接続済みアカウントを保存してから、サービス追加の続きに戻ります。",
  "conn.return.cta": "サービス追加に戻る",
  "conn.saved.message": "{name} を保存しました。",
  "conn.saved.needsTest":
    "{name} を保存しました。サービス追加に戻る前に、接続確認を完了してください。",
  "conn.saved.testCta": "接続を確認",
  "conn.saved.returnCta": "追加に戻る",
  "conn.add.provider": "接続先",
  "conn.add.genericEnvOption": "その他の接続（詳細）",
  "conn.add.title": "アカウントを接続",
  "conn.add.open": "アカウントを接続",
  "conn.add.close": "閉じる",
  "conn.add.optionalSettings": "この接続に名前をつける",
  "conn.add.displayName": "接続名",
  "conn.add.displayNamePlaceholder": "任意の名前",
  "conn.guided.openProvider": "{provider} のアクセス設定を開く",
  "conn.guided.instructions": "手順を表示",
  "conn.byok.title": "自分のカギで外部プロバイダーを接続",
  "conn.byok.body":
    "プロバイダーの取得元 (source) と必要な環境変数を入力します。この接続にも provider policy、runner capability、Run approval が適用されます。",
  "conn.byok.noBillingNote":
    "Takosumi の料金がある場合は preview に表示されます。外部プロバイダーの料金は、そのプロバイダーから別途請求されます。",
  "conn.byok.usePreset": "インストール済み Recipe を使う",
  "conn.register": "接続を保存",
  "conn.registering": "保存中…",
  "conn.genericEnv.providerName": "プロバイダーの取得元",
  "conn.genericEnv.providerPlaceholder": "examplecorp/example",
  "conn.genericEnv.envName": "env 名",
  "conn.genericEnv.envNamePlaceholder": "EXAMPLE_API_TOKEN",
  "conn.genericEnv.value": "値",
  "conn.genericEnv.valuePlaceholder": "値を貼り付け",
  "conn.genericEnv.addRow": "値を追加",
  "conn.genericEnv.providerRequired":
    "プロバイダーの取得元を入力してください。",
  "conn.genericEnv.nameRequired": "値のある行には環境変数名が必要です。",
  "conn.genericEnv.invalidName":
    "「{name}」は使えません。EXAMPLE_API_TOKEN のような大文字の env 名を使ってください。",
  "conn.genericEnv.reservedName":
    "「{name}」は実行環境が使う予約名です。プロバイダー固有の env 名を使ってください。",
  "conn.genericEnv.duplicateName": "「{name}」はすでに追加されています。",
  "conn.genericEnv.oneRequired": "環境変数を 1 つ以上入力してください。",
  "conn.error.invalidProvider": "接続先が不正です。",
  "conn.error.fieldRequired": "{field} は必須です。",
  "conn.empty.title": "自分のカギで外部プロバイダーを接続",
  "conn.empty.message":
    "自分の認証情報を接続し、インストール済みの policy、runner、approval、billing の範囲で外部プロバイダーを利用します。",
  "conn.test": "アクセス確認",
  "conn.testing": "確認中…",
  "conn.test.notReady":
    "このアカウントはまだ利用できません（状態: {status}）。",
  "conn.remove.confirmTitle": "接続済みアカウントを削除",
  "conn.remove.confirmMessage":
    "本当に {name} を削除しますか？保存されたアクセス値も削除され、取り消せません。",
  "conn.remove.bindingWarning":
    "この接続を使うサービスのデプロイは失敗します。",

  // --- backups -----------------------------------------------------------------
  "backups.subtitle":
    "部分的な control export を作成・確認します。import / restore には対応していません。",
  "backups.create": "バックアップを作成",
  "backups.creating": "バックアップを作成しています。",
  "backups.col.createdAt": "作成日時",
  "backups.col.contents": "内容",
  "backups.controlExport": "部分的な control export",
  "backups.empty.title": "まだバックアップがありません",
  "backups.empty.message":
    "このワークスペースの最初のバックアップを作成できます。",

  // --- shared values -------------------------------------------------------------
  "shares.subtitle": "別のワークスペースから使える公開値を管理します。",
  "shares.create.title": "共有を作成",
  "shares.create.toWorkspace": "共有先ワークスペース",
  "shares.create.producer": "共有元サービス",
  "shares.create.workspacesError": "ワークスペース一覧を読み込めませんでした。",
  "shares.create.workspacesEmpty":
    "共有先にできる他のワークスペースがありません。",
  "shares.create.capsulesError": "サービス一覧を読み込めませんでした。",
  "shares.create.capsulesEmpty": "共有元にできるサービスがありません。",
  "shares.create.selectPlaceholder": "選択してください",
  "shares.create.outputs": "共有する値",
  "shares.create.addOutput": "共有する値を追加",
  "shares.create.removeOutput": "削除",
  "shares.create.outputName": "値の名前",
  "shares.create.outputAlias": "表示名",
  "shares.create.sensitiveValue": "機微な値",
  "shares.create.sensitiveReason": "機微な値を共有する理由",
  "shares.create.sensitivePlaceholder": "共有が必要な理由",
  "shares.create.cta": "共有を作成",
  "shares.error.outputsRequired":
    "共有する値の名前を 1 つ以上入力してください。",
  "shares.error.reasonRequired": "機微な値を共有する理由を入力してください。",
  "shares.error.toWorkspaceRequired":
    "共有先ワークスペースを選択してください。",
  "shares.error.producerRequired": "共有元サービスを選択してください。",
  "shares.col.direction": "方向",
  "shares.col.capsule": "サービス",
  "shares.col.outputs": "共有する値",
  "shares.col.status": "状態",
  "shares.approve": "承認",
  "shares.revoke": "取り消し",
  "shares.revokeConfirmTitle": "共有の取り消し",
  "shares.revokeConfirmMessage":
    "{target} への共有を取り消しますか？共有先のワークスペースはこの値を使えなくなります。",
  "shares.status.active": "有効",
  "shares.status.pending": "承認待ち",
  "shares.status.revoked": "取り消し済み",
  "shares.list.title": "共有一覧",
  "shares.empty": "共有はまだありません。",

  // --- notifications -------------------------------------------------------------
  "notif.markAllRead": "すべて既読にする",
  "notif.title": "通知",
  "notif.subtitle":
    "追加・デプロイ・承認・失敗など、最近の出来事を新しい順に表示します。",
  "notif.empty.title": "まだ通知はありません",
  "notif.empty.message":
    "サービスを追加したりデプロイしたりすると、ここに出来事が並びます。",
  "notif.attention": "要対応の出来事が {n} 件あります。",
  "notif.badge.attention": "要対応",
  "notif.supportSummary": "参照情報",
  "notif.viewRaw": "履歴を開く →",
  "notif.event.installCreated": "サービス「{name}」を追加しました",
  "notif.event.installCreatedEnv": "環境: {env}",
  "notif.event.planReady": "{operation}の準備ができました",
  "notif.event.planReadyNamed": "「{name}」の{operation}の準備ができました",
  "notif.event.planReadyDetail": "内容を確認して承認できます",
  "notif.event.planBlockedDetail": "ポリシーにより承認が止まっています",
  "notif.event.approved": "{operation}を承認しました",
  "notif.event.approvedNamed": "「{name}」の{operation}を承認しました",
  "notif.event.applied": "サービスの変更をデプロイしました",
  "notif.event.appliedNamed": "「{name}」の変更をデプロイしました",
  "notif.event.appliedDetail": "公開値 {n} 件を更新",
  "notif.event.destroyed": "サービスを削除しました",
  "notif.event.destroyedNamed": "「{name}」を削除しました",
  "notif.event.failed": "{operation}に失敗しました",
  "notif.event.failedNamed": "「{name}」の{operation}に失敗しました",
  "notif.event.drift": "サービスの実状態が保存済みの記録とズレています",
  "notif.event.driftNamed": "「{name}」の実状態が保存済みの記録とズレています",
  "notif.event.driftDetail": "実際の状態が設定とずれている可能性があります",
  "notif.event.stale": "依存先が更新されたため、このサービスに更新があります",
  "notif.event.staleNamed":
    "依存先が更新されたため、「{name}」に更新があります",
  "notif.event.staleDetail": "更新元: {producer}",
  "notif.event.connCreated": "接続済みアカウント「{provider}」を追加しました",
  "notif.event.connCreatedGeneric": "接続済みアカウントを追加しました",
  "notif.event.connRevoked":
    "接続済みアカウント「{provider}」が無効になりました",
  "notif.event.connRevokedGeneric": "接続済みアカウントが無効になりました",
  "notif.event.backupCreated": "バックアップを作成しました",
  "notif.event.depCreated": "サービス間の連携を追加しました",
  "notif.event.depDeleted": "サービス間の連携を解除しました",
  "notif.event.shareRequested": "値の共有リクエストが届きました",
  "notif.event.shareApproved": "値の共有を承認しました",
  "notif.event.shareRevoked": "値の共有を取り消しました",
  "notif.event.groupCreated": "まとめての更新を開始しました",
  "notif.event.autoUpdateOn": "自動更新をオンにしました",
  "notif.event.autoUpdateOff": "自動更新をオフにしました",
  "notif.event.autoUpdateFailed": "自動更新を完了できませんでした",
  "notif.event.autoUpdateFailedNamed":
    "「{name}」の自動更新を完了できませんでした",
  "notif.event.autoUpdateFailedDetail":
    "サービス画面から更新内容を確認してください",
  "notif.event.recorded": "記録された操作",
  "notif.otherWorkspace": "別のワークスペース @{handle}",

  // --- activity -------------------------------------------------------------------
  "activity.title": "操作履歴",
  "activity.subtitle": "サービスやアカウントの出来事を新しい順に記録します。",
  "activity.details": "参照情報",
  "activity.detailsBody": "イベントを確認するときに使う参照情報です。",
  "activity.debug": "参照 ID",
  "activity.recorded": "記録された操作",
  "activity.actorLine": "実行者: {actor}",
  "activity.empty.title": "まだ記録はありません",
  "activity.empty.message":
    "このワークスペースで操作が行われると、ここに記録されます。",

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

  // --- graph ---------------------------------------------------------------------
  "graph.title": "依存関係",
  "graph.subtitle":
    "どのサービスが他のサービスの値を使っているかを表示します。",
  "graph.layer": "グループ {n}",
  "graph.cycle": "確認が必要",
  "graph.dependsOn": "{names} を利用",
  "graph.empty.title": "サービスがありません",
  "graph.empty.message": "このワークスペースにはまだサービスがありません。",
  "graph.noEdges.title": "依存関係はまだありません",
  "graph.noEdges.message":
    "サービスが他のサービスの値を使うようになると、ここにつながりが表示されます。",

  // --- account ---------------------------------------------------------------------
  "account.title": "アカウント",
  "account.subtitle": "サインイン情報と言語・表示の設定です。",
  "account.profile.title": "サインイン情報",
  "account.profile.subject": "サインイン参照 ID",
  "account.profile.displayName": "表示名",
  "account.profile.email": "メール",
  "account.profile.notSet": "未設定",
  "account.profile.provider": "サインイン方法",
  "account.profile.expires": "セッション期限",
  "account.session.userAgent": "ブラウザ",
  "account.session.details": "セッション詳細",
  "account.session.debug": "参照 ID",
  "account.session.signOut": "このブラウザからサインアウト",
  "account.session.signOutConfirm": "このブラウザからサインアウトしますか？",
  "account.session.otherNote":
    "ここでサインアウトできるのは、このブラウザのセッションのみです。",
  "account.language.title": "言語",
  "account.theme.title": "表示",
  "account.preferences.title": "表示設定",
  "account.preferences.body": "言語と見た目を変更できます。",
  "account.installTarget.title": "ストアからのインストール先",
  "account.installTarget.body":
    "ストアの「追加」ボタンを、この端末ではこの Takosumi で開くようブラウザに登録します。登録後は、別のストアからでもここに着地します。",
  "account.installTarget.register": "この端末を登録",
  "account.installTarget.registered": "この端末で登録済み",
  "account.installTarget.done":
    "登録しました。ブラウザの確認ダイアログに応じてください。",
  "account.installTarget.unsupported":
    "このブラウザはこの機能に未対応です。ストア側でインスタンス URL を入力してください。",
  "account.apiKeys.title": "Cloud API キー",
  "account.apiKeys.subtitle":
    "CLIや外部ツールからTakosumi Cloudを操作するためのキーを発行・失効できます。",
  "account.apiKeys.secretOnce": "秘密値は作成時のみ表示",
  "account.apiKeys.name": "キーの名前",
  "account.apiKeys.namePlaceholder": "例: 開発用 CLI",
  "account.apiKeys.expiresLabel": "有効期間",
  "account.apiKeys.expiresDays": "{days}日",
  "account.apiKeys.scopes": "権限",
  "account.apiKeys.scope.read": "読み取り",
  "account.apiKeys.scope.write": "変更",
  "account.apiKeys.scope.admin": "管理",
  "account.apiKeys.scopesHint":
    "このキーに必要な権限だけを選択してください。管理権限は運用者のみが発行でき、この画面からは作成できません。",
  "account.apiKeys.restrictWorkspace":
    "現在のワークスペースだけで使用できるようにする",
  "account.apiKeys.create": "API キーを作成",
  "account.apiKeys.created": "API キーを作成しました",
  "account.apiKeys.createdHint":
    "この値は再表示できません。今すぐ安全な場所へ保存してください。",
  "account.apiKeys.copy": "コピー",
  "account.apiKeys.copied": "コピーしました",
  "account.apiKeys.copyFailed":
    "コピーできませんでした。表示されている値を手動で保存してください。",
  "account.apiKeys.error": "API キーの操作を完了できませんでした: {message}",
  "account.apiKeys.empty": "API キーはまだありません。",
  "account.apiKeys.key": "キー",
  "account.apiKeys.access": "アクセス範囲",
  "account.apiKeys.workspaceBound": "このワークスペースのみ",
  "account.apiKeys.lastUsed": "最終使用",
  "account.apiKeys.neverUsed": "未使用",
  "account.apiKeys.status": "状態",
  "account.apiKeys.status.active": "有効",
  "account.apiKeys.status.revoked": "失効済み",
  "account.apiKeys.status.expired": "期限切れ",
  "account.apiKeys.expires": "{date} まで",
  "account.apiKeys.noExpiry": "期限なし",
  "account.apiKeys.action": "操作",
  "account.apiKeys.revoke": "失効",
  "account.apiKeys.revokeConfirm": "失効する",

  // --- billing -------------------------------------------------------------------
  "billing.usageQuotaTitle": "利用状況",
  "billing.usageQuotaSubtitle":
    "この ワークスペース の記録モードとプロバイダー非依存な使用量を確認します。",
  "billing.mode.disabled": "この ワークスペース ではショーバックは無効です。",
  "billing.mode.label": "モード",
  "billing.mode.showback": "使用量は記録されますが、請求はありません。",
  "billing.loadError": "使用量設定を読み込めませんでした: {message}",
  "billing.usage.title": "使用量",
  "billing.usage.subtitle":
    "このワークスペースに記録された使用量です。金額確定済みの行には対応する米ドル換算額を表示します。",
  "billing.usage.more": "さらに読み込む",
  "billing.usage.error": "使用量を読み込めませんでした: {message}",
  "billing.usage.empty": "使用量はまだありません。",
  "billing.usage.kind": "種別",
  "billing.usage.time": "日時",
  "billing.usage.kind.runner_minute": "実行時間",
  "billing.usage.kind.operation": "サービス操作",
  "billing.usage.kind.compute": "コンピュート",
  "billing.usage.kind.storage": "ストレージ",
  "billing.usage.quantity": "数量",
  "billing.usage.amount": "確定金額",
  "billing.usage.unrated": "未評価",
  "billing.commercial.pageTitle": "プリペイドクレジットと使用量",
  "billing.commercial.pageSubtitle":
    "利用可能クレジットの確認、プリペイドクレジットの追加、自動チャージの管理を行います。",
  "billing.commercial.description":
    "プリペイドクレジットはTakosumi Cloudの使用量に充当され、有効期限はありません。",
  "billing.commercial.loadError":
    "プリペイドクレジットと支払い情報を読み込めませんでした: {message}",
  "billing.commercial.actionError":
    "支払い操作を完了できませんでした: {message}",
  "billing.commercial.unavailable":
    "支払い設定を一時的に利用できません。既存の使用量記録には影響しません。",
  "billing.commercial.checkout.success":
    "支払いが完了しました。決済サービスによる確定後、プリペイドクレジットが反映されます。",
  "billing.commercial.checkout.cancelled":
    "支払い設定をキャンセルしました。変更はありません。",
  "billing.commercial.manage": "支払い方法を管理",
  "billing.commercial.status.unknown": "不明",
  "billing.commercial.account.status.active": "クラウド利用可能",
  "billing.commercial.account.status.trialing": "クラウド利用可能",
  "billing.commercial.account.status.pastDue": "支払い確認が必要",
  "billing.commercial.account.status.disabled": "クラウド利用停止中",
  "billing.commercial.account.blocked.paymentDisputed":
    "支払いに異議申し立てがあるため、新しいTakosumi Cloudの利用を停止しています。表示中のプリペイドクレジットは失効しません。支払い設定で異議申し立てを解決してください。",
  "billing.commercial.account.blocked.paymentPastDue":
    "支払いを確認できないため、新しいTakosumi Cloudの利用を停止しています。表示中のプリペイドクレジットは失効しません。支払い方法を確認してください。",
  "billing.commercial.account.blocked.disabled":
    "課金アカウントが無効なため、新しいTakosumi Cloudの利用を停止しています。表示中のプリペイドクレジットは失効しません。支払い設定を確認してください。",
  "billing.commercial.account.blocked.suspended":
    "課金アカウントの確認が必要なため、新しいTakosumi Cloudの利用を停止しています。表示中のプリペイドクレジットは失効しません。支払い設定を確認してください。",
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
  "billing.commercial.credits.taxNote":
    "適用される税金は決済時に決済サービスが計算します。",
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
  "billing.commercial.transaction.subtitle":
    "このワークスペースの課金済み・取り消し済みの利用明細です。",
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
