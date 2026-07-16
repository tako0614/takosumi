/**
 * Japanese master dictionary. This file owns the key set: `en.ts` is
 * type-checked against `keyof typeof ja`, so adding/removing a key here forces
 * the English side to follow. Keys are namespaced `area.item`; `{param}`
 * placeholders are interpolated by `t()`.
 *
 * Vocabulary contract (the unified verb set — do not reintroduce 公開/反映):
 *   Noun (surface split): the user-facing noun is サービス on the add-flow
 *   (/new), service detail, store, runs, and workspace surfaces; the home
 *   launcher and the install celebration call the same thing アプリ. Never
 *   mix the two nouns within one panel.
 *   追加 (install) → 変更を確認 (plan) → デプロイ (apply) → デプロイ済み (active)
 */
export const ja = {
  // --- common -------------------------------------------------------------
  "common.loading": "読み込み中...",
  "common.retry": "再試行",
  "common.refresh": "更新",
  "common.create": "作成",
  "common.creating": "作成中...",
  "common.cancel": "キャンセル",
  "common.save": "保存",
  "common.saving": "保存中...",
  "common.delete": "削除",
  "common.none": "なし",
  "common.unknown": "不明",
  "common.details": "詳細",
  "common.fetchFailed": "取得に失敗しました — {message}",
  "common.copy": "コピー",
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
  "nav.services": "サービス",
  "nav.add": "追加",
  "nav.store": "ストア",
  "nav.settings": "設定",
  "nav.graph": "依存関係",
  "nav.resources": "リソース",
  "store.title": "ストア",
  "store.subtitle": "ストアから追加できるサービスを探します。",
  "store.manualEntry":
    "お探しのものがありませんか？ Git URL / 独自の取得元から追加",
  "nav.runs": "アクティビティ",
  "nav.connections": "接続済みアカウント",
  "nav.billing": "お支払い",
  "nav.activity": "操作履歴",
  "nav.primary": "主な操作",
  "nav.notifications": "通知",
  "nav.workspaceSettings": "設定",
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
  "settings.billing.desc": "使用量と operator 提供のショーバック",
  "settings.notifications.title": "通知",
  "settings.notifications.desc": "お知らせと要対応の確認",
  "settings.billingSummary.manage": "管理する",
  "settings.billingSummary.error": "使用量の状態を読み込めませんでした。",
  "settings.manage.entry": "管理ツール",
  "settings.manage.entryDesc":
    "サービスの内部、接続、実行履歴などの詳しい管理画面",
  "settings.manage.title": "管理ツール",
  "settings.manage.subtitle":
    "ホスティングの内部を直接あつかう画面です。ふだんの利用では開く必要はありません。",
  "settings.manage.services": "すべてのサービスと状態の一覧",
  "settings.manage.connections": "クラウドアカウントの接続とカギの管理",
  "settings.manage.runs": "デプロイと変更の実行記録",
  "settings.manage.graph": "サービス間の依存関係の表示",
  "settings.manage.resources": "Resource Shape、TargetPool、SpacePolicy の管理",
  "settings.manage.activity": "だれが何を変更したかの操作履歴",
  "settings.manage.workspace": "メンバー、キー、バックアップ、共有、ポリシー",
  "settings.manage.backups": "復元ポイントの作成と復元",
  "settings.manage.shares": "サービス間で共有する値の管理",

  // --- workspace switcher -------------------------------------------------------
  "workspace.label": "ワークスペース",
  "workspace.loadFailed": "ワークスペースの取得に失敗しました — {message}",
  "workspace.none": "ワークスペースがありません",
  "workspace.select": "ワークスペースを選択してください",
  "workspace.selectMessage":
    "サイドバーのワークスペース選択からワークスペースを選ぶと表示されます。",
  "workspace.loading": "ワークスペースを読み込み中...",
  "workspace.settings": "ワークスペース設定",
  "workspace.switcherAria": "ワークスペースを切り替え（現在: {name}）",
  "workspace.defaultName": "自分のワークスペース",
  "workspace.start.aria": "ワークスペースの開始",
  "workspace.start.kicker": "ワークスペースがありません",
  "workspace.start.title": "ワークスペースを作成して始める",
  "workspace.start.body":
    "サービス、デプロイ履歴、設定はワークスペースにまとめて保存されます。",
  "workspace.start.create": "ワークスペースを作成",
  "workspace.start.creating": "作成中...",
  "workspace.create.nameLabel": "ワークスペース名",
  "workspace.create.namePlaceholder": "新しいワークスペース",
  "workspace.create.nameRequired": "ワークスペース名を入力してください。",
  "workspace.create.idLabel": "ワークスペースID",
  "workspace.create.idPlaceholder": "my-workspace",
  "workspace.create.idHelp":
    "英小文字・数字・ハイフン（2〜39文字）。空欄なら自動生成します。",
  "workspace.create.idInvalid":
    "IDは英小文字・数字・ハイフンで2〜39文字にしてください（先頭のハイフン不可）。",
  "workspace.create.idTaken": "そのIDはすでに使われています。",
  "workspace.create.failed": "ワークスペースを作成できませんでした — {message}",

  // --- auth -----------------------------------------------------------------
  "auth.signIn": "サインイン",
  "legal.langLabel": "言語",
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
  "auth.processing": "サインイン処理中...",
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
  "status.run.ready_to_deploy": "実行待ち",
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
  "install.installingGeneric": "追加中…",
  "install.wait": "そのままお待ちください",
  "install.progressAria": "追加の進行状況",
  "install.step.fetch": "コードを取得",
  "install.step.check": "互換性を確認",
  "install.step.deploy": "デプロイ",
  "install.step.done": "仕上げ",
  "install.doneTitle": "{name} を追加しました",
  "install.doneTitleGeneric": "追加しました",
  "install.doneSub": "デプロイ完了。すぐに使えます。",
  "install.activationPending": "アプリの公開処理を仕上げています…",
  "install.open": "アプリを開く",
  "install.toApps": "アプリ一覧へ",
  "install.gateTitle": "確認が必要です",
  "install.gateSub": "続けるには内容の確認が必要です。",
  "install.gateCta": "内容を確認する",
  "install.errorTitle": "追加できませんでした",
  "install.errorSub": "詳細を確認して、もう一度お試しください。",
  "install.errorCta": "詳細を見る",
  "update.installingGeneric": "更新中…",
  "update.doneTitle": "{name} を更新しました",
  "update.doneTitleGeneric": "更新しました",
  "update.doneSub": "最新の状態になりました。",
  "update.errorTitle": "更新できませんでした",
  "apps.needsAttention": "要対応",
  "apps.openApp": "アプリを開く",
  "apps.reviewChanges": "変更を確認",
  "apps.start.aria": "最初のアプリ",
  "apps.start.kicker": "まだアプリがありません",
  "apps.start.titleEmpty": "最初のアプリを追加しましょう",
  "apps.start.bodyEmpty": "アプリを選ぶか、リンクを貼って追加します。",
  "apps.start.optionStore": "追加する",
  "apps.listIncomplete":
    "一部のアプリを読み込めませんでした。表示されていないアプリがあるかもしれません。",

  // --- Service list (/services) --------------------------------------------
  "services.title": "サービス",
  "services.subtitle": "すべてのサービスと状態。選ぶと詳細へ。",
  "services.empty.title": "まだサービスがありません",
  "services.empty.body": "サービスを追加するとここに表示されます。",
  "services.deleteAria": "削除: {name}",
  "services.listIncomplete":
    "一部のサービスを読み込めませんでした。表示されていないサービスがあるかもしれません。",

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
  "app.deploys.restoreMenu": "その他",
  "app.deploys.restore": "この状態に戻す",
  "app.deploys.restoreDisclosure": "以前の状態に戻す",
  "app.deploys.advancedActions": "必要なときだけ使う操作",
  "app.deploys.advancedActionsBody":
    "復元ポイントやバックアップが必要な場合だけ使います。",
  "app.deploys.backup": "バックアップを作成",
  "app.deploys.backupCreated": "バックアップを作成しました。",
  "app.deploys.backupSupportRef": "バックアップ ID",
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
  "app.bindings.aliasPlaceholder": "対象名（任意）",
  "app.bindings.aliasLabel": "対象名",
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
  "app.config.notReady": "設定値を読み込めませんでした。",
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
  "app.config.resetAria": "設定値 {name} をクリア",
  "app.config.removeAria": "設定値 {name} を削除",
  "app.config.undoResetAria": "設定値 {name} のリセットを取り消す",
  "app.config.defaultBadge": "既定値",
  "app.config.resetPendingHint": "保存すると既定値に戻ります。",
  "app.config.customName": "CUSTOM_ENV",
  "app.config.errorNameRequired": "設定名を入力してください。",
  "app.config.errorNameInvalid": "{name} に空白は使えません。",
  "app.config.errorNameDuplicate": "{name} が重複しています。",
  "app.config.errorNumber": "{name} は数値で入力してください。",
  "app.config.errorJson": "{name} は JSON として入力してください。",
  "app.interfaces.title": "ランタイム Interface（高度な設定）",
  "app.interfaces.subtitle":
    "通常の OpenTofu Output とは分けて、ランタイムの公開面を宣言します。変更は次のデプロイ確認に反映されます。",
  "app.interfaces.editorLabel": "Interface blueprint（JSON）",
  "app.interfaces.editorHint":
    "配列として入力します。各宣言には key、name、spec を明示し、動的な値は spec.inputs で literal、capsule_output、resource_output のいずれかに割り当てます。シークレットは記載しません。",
  "app.interfaces.notReady": "Interface 宣言を読み込めませんでした。",
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
  "run.approving": "承認中...",
  "run.deploy": "デプロイを実行",
  "run.deploying": "実行中...",
  "run.deployBlocked": "実行できません",
  "run.retryPlan": "もう一度変更を確認",
  "run.backToApp": "サービスへ戻る",
  "run.appHandoff.open": "{app} で開く",
  "run.destructiveWarning":
    "この変更には既存リソースの置き換え・削除が含まれます。実行するとデータが失われる場合があります。",
  "run.destructiveConfirm": "破壊的な変更を承知のうえで実行",
  "run.stopGoBack": "やめて戻る",
  "run.cancel": "この実行をキャンセル",
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
  "run.cost.quotaCta": "使用量 / 上限を確認",
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
  "runList.title": "アクティビティ",
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
  "new.title": "サービスを追加",
  "new.discard.title": "入力内容を破棄しますか？",
  "new.discard.body": "このサービスの設定内容は保存されません。",
  "new.discard.confirm": "破棄する",
  "new.discovery.aria": "追加するサービスを探す",
  "new.discovery.title": "追加するサービスを選ぶ",
  "new.discovery.subtitle": "よく使うサービスから選んで追加します。",
  "new.discovery.linkPlaceholder": "リンクまたは Git URL",
  "new.discovery.linkCta": "リンクから追加",
  "new.discovery.manualLead": "お探しのものがありませんか？",
  "new.discovery.manualToggle": "Git URL / インストールリンクから追加",
  "new.advancedImport.title": "リンクから追加",
  "new.advancedImport.subtitle": "インストールリンクを貼り付けて追加します。",
  "new.selection.subtitle":
    "まず内容を確認します。デプロイは承認後に実行されます。",
  "new.flow.selected": "選択中",
  "new.flow.manual": "手動追加",
  "new.flow.back": "選び直す",
  "new.pick.checking": "選択したサービスを確認しています…",
  "new.summary.aria": "追加内容",
  "new.summary.provider": "ホスト先",
  "new.storeInput.title": "サービス設定",
  "new.storeInput.subtitle": "表示名と、公開に必要な最小限の項目です。",
  "new.storeInput.errorRequired": "{label} を入力してください。",
  "new.storeInput.errorUnsafeValue":
    "{label} の値が長すぎるか、使えない文字を含んでいます。",
  "new.storeInput.errorSubdomain":
    "{label} は {baseDomain} の前に付く1段の名前を入力してください。英小文字・数字・ハイフンが使えます。",
  "new.storeInput.errorCustomDomain":
    "{label} は https:// のURLを使ってください。{baseDomain} は1段の名前だけ使えます。独自ドメインはデプロイ前に所有確認が必要です。",
  "new.deeplink.aria": "リンクから追加するサービス",
  "new.deeplink.kicker": "リンクから追加",
  "new.deeplink.title": "{capsule} を追加します",
  "new.deeplink.body":
    "リンクの内容を確認しました。必要なら取得元を開いて変更できます。",
  "new.deeplink.source": "取得元",
  "new.deeplink.version": "バージョン",
  "new.deeplink.folder": "フォルダ",
  "new.git.url": "インストールリンク",
  "new.git.advanced": "取得元の詳細",
  "new.git.ref": "バージョン",
  "new.git.defaultRef": "Git の既定ブランチ",
  "new.git.path": "フォルダ",
  "new.sourceAccess.title": "非公開リンクのアクセス",
  "new.sourceAccess.body":
    "公開されているリンクなら設定は不要です。非公開の場合だけアクセス情報を選びます。",
  "new.sourceAccess.mode": "アクセス方法",
  "new.sourceAccess.public": "公開リンク",
  "new.sourceAccess.existing": "保存済みのアクセスを使う",
  "new.sourceAccess.token": "アクセストークンを保存する",
  "new.sourceAccess.connection": "保存済みのアクセス",
  "new.sourceAccess.selectConnection": "保存済みのアクセスを選択",
  "new.sourceAccess.noConnections":
    "このワークスペースには、検証済みの取得元アクセスがまだありません。",
  "new.sourceAccess.username": "ユーザー名",
  "new.sourceAccess.accessToken": "アクセストークン",
  "new.sourceAccess.tokenPlaceholder": "読み取り専用トークン",
  "new.sourceAccess.saveToken": "アクセス情報を保存",
  "new.sourceAccess.tokenBody":
    "保存後は表示できない形で安全に保管され、このワークスペースの取得元確認にだけ使われます。",
  "new.sourceAccess.errorTokenRequired": "アクセストークンを入力してください。",
  "new.sourceAccess.errorSaveToken":
    "確認する前に、非公開リンクのトークンを保存してください。",
  "new.sourceAccess.errorSelectConnection":
    "検証済みの取得元アクセスを選択してください。",
  "new.sourceAccess.errorConnectionUnavailable":
    "選択した取得元アクセスは現在利用できません。",
  "new.sourceAccess.httpsConnection": "HTTPS 取得元アクセス",
  "new.sourceAccess.sshConnection": "SSH 取得元アクセス",
  "new.sourceAccess.defaultDisplayName": "{name} 取得元アクセス",
  "new.name": "サービス名",
  "new.vars.projectName": "サービスID",
  "new.hostPreview": "公開URL: {host}",
  "new.hostname.mode.label": "URLの種類",
  "new.hostname.mode.hint":
    "通常URLはワークスペースごとに使えます。短いURLはアカウントのURL枠を1つ使います。",
  "new.hostname.mode.scoped": "通常URL",
  "new.hostname.mode.vanity": "短いURL枠を使う",
  "new.advanced.title": "詳細設定",
  "new.advanced.customUrlHint": "既定の公開URLの代わりに使う完全なURLです。",
  "new.advanced.routePatternHint":
    "上級者向け: ルートパターンを直接指定します。",
  "new.advanced.serviceIdHint": "内部名です。URLの既定値になります。",
  "new.env.title": "環境変数",
  "new.env.body":
    "サービスが公開してよい実行時の環境変数を求める場合だけ使います。秘密の値は接続済みアカウントから渡してください。",
  "new.env.name": "環境変数名",
  "new.env.value": "値",
  "new.env.valuePlaceholder": "値",
  "new.env.add": "環境変数を追加",
  "new.env.remove": "削除",
  "new.env.errorNameRequired":
    "環境変数名を入力するか、空の行を削除してください。",
  "new.env.errorUnsafeName":
    "「{name}」には大文字の英字、数字、アンダースコアだけを使ってください。",
  "new.env.errorUnsafeValue":
    "「{name}」の値が長すぎるか、使えない文字を含んでいます。",
  "new.env.errorDuplicate": "環境変数「{name}」が重複しています。",
  "new.vars.inputsTitle": "その他の設定",
  "new.vars.inputsBody":
    "上にない表示用の入力をサービスから求められた場合だけ使います。",
  "new.vars.inputName": "設定名",
  "new.vars.inputValue": "値",
  "new.vars.namePlaceholder": "設定名",
  "new.vars.valuePlaceholder": "値",
  "new.vars.addInput": "入力を追加",
  "new.vars.removeInput": "削除",
  "new.vars.errorNameRequired":
    "変数名を入力するか、空の行を削除してください。",
  "new.vars.errorUnsafeName":
    "「{name}」はリンク/入力値として渡せません。非公開の値は接続済みアカウントから渡してください。",
  "new.vars.errorUnsafeValue":
    "「{name}」の値が長すぎるか、使えない文字を含んでいます。",
  "new.vars.errorProjectNameReserved":
    "この値はサービスIDの欄で指定してください。",
  "new.vars.errorStoreReserved":
    "「{name}」はサービス設定の欄で指定してください。",
  "new.vars.errorDuplicate": "「{name}」が重複しています。",
  "new.deeplink.invalidTitle": "このインストールリンクは利用できません",
  "new.deeplink.invalidBody":
    "安全な HTTPS リンクではないか、ブラウザで開けない情報が含まれています。サービス候補から選ぶか、別のリンクを貼り付けてください。",
  "new.appHandoff.title": "{app} に接続するサービスを追加します",
  "new.appHandoff.body":
    "この画面で追加が完了すると、接続先の情報が自動的にアプリへ戻ります。",
  "new.appHandoff.kicker": "アプリからのリクエスト",
  "new.appHandoff.app": "アプリ",
  "new.appHandoff.return": "戻り先",
  "new.installCta": "サービスを追加",
  "new.installing": "追加中...",
  "new.compat.recheck": "もう一度確認",
  "new.compat.checking": "準備中...",
  "new.progress.title": "サービスを準備しています",
  "new.progress.fetching": "内容を取得しています。このままお待ちください。",
  "new.progress.slow": "少し時間がかかっています。完了すると次に進めます。",
  "new.progress.details": "詳しい進行状況",
  "new.progress.status": "状態: {status}",
  "new.compat.title": "確認結果",
  "new.compat.details": "詳しい確認結果",
  "new.compat.readyBrief": "確認できました。",
  "new.compat.ready": "このまま追加できます",
  "new.compat.patch": "手直しが必要です",
  "new.compat.unsupported": "今は追加できません",
  "new.compat.diagnostic.technicalNote":
    "詳しい確認結果です。対応が必要な場合だけ確認してください。",
  "new.compat.patchHelp":
    "表示された内容を確認してください。サービス側の修正が必要な場合と、接続済みアカウントの設定で進められる場合があります。",
  "new.compat.summary.providerCredentials":
    "{provider} の非公開値を取得元から外す必要があります。",
  "new.compat.summary.reviewRequired":
    "追加する前に確認が必要な項目があります。",
  "new.compat.issue.providerCredentials.message":
    "{provider} の非公開値が取得元の中に書かれています。",
  "new.compat.issue.providerCredentials.detail":
    "API トークンやアカウント ID はコードに置かず、{provider} の接続済みアカウントからデプロイ時だけ渡してください。値を外して接続すると続行できます。",
  "new.compat.issue.providerPreserved.message":
    "取得元にある {provider} の非秘密設定はそのまま維持されます。",
  "new.compat.issue.backendIsolated.message":
    "取得元の backend 設定を維持したまま、Takosumi が Run の state 境界を分離します。",
  "new.compat.issue.lockfile.message":
    "利用する接続先の固定情報が含まれています。非公開値を外したあと、追加時に固定内容を確認します。",
  "new.compat.issue.reviewRequired.message":
    "追加前に確認が必要な項目があります。",
  "new.proceedHint": "先に「サービスを追加」を押してください。",
  "new.existing.title": "このサービスは既に追加されています",
  "new.existing.body":
    "「{name}」は {environment} 環境に追加済みです。新しく作り直さず、既存サービスを開いて確認できます。",
  "new.existing.open": "既存サービスを開く",
  "new.providers.title": "使う接続済みアカウント",
  "new.providers.alias": "対象: {alias}",
  "new.providers.selectConnection": "接続済みアカウントを選択",
  "new.providers.errorConnection":
    "{provider} の利用可能な接続済みアカウントを選択してください。",
  "new.providers.missingTitle": "接続済みアカウントの設定が必要です",
  "new.providers.missingBody": "接続済みアカウントを設定すると続けられます。",
  "new.providers.setupMissing": "必要な接続済みアカウントを設定",
  "new.providers.returnNote": "接続を保存すると、この追加の続きに戻ります。",
  "new.step.technical": "詳しい進行状況",
  "new.step.register": "サービスを準備",
  "new.step.sync": "内容を取得",
  "new.step.create": "サービスを作成",
  "new.step.plan": "変更を確認",
  "new.step.state.done": "完了",
  "new.step.state.failed": "失敗",
  "new.step.state.running": "実行中",
  "new.step.state.pending": "未実行",
  "new.error.workspaceRequired": "ワークスペースを選択してください。",
  "new.error.urlRequired": "インストールリンクを入力してください。",
  "new.error.nameRequired": "名前を入力してください。",
  "new.error.nameInvalid":
    "サービス名は半角英小文字・数字・ハイフンだけで入力してください。",
  "new.error.configMissing": "追加設定がまだ利用できません。",
  "new.error.configLoading": "追加設定を読み込み中です。",
  "new.error.configLoadFailed":
    "追加設定を読み込めませんでした。通信状態を確認して再試行してください。",
  "new.error.syncPending":
    "ソースの取得がまだ完了していません。少し待ってから「再試行」してください。",
  "new.error.sourceRefNotFound":
    "指定されたバージョン「{ref}」が見つかりません。リンク先にこのバージョンがあるか確認してください。",
  "new.error.sourceFetchFailed":
    "サービスの内容を取得できませんでした。リンク、バージョン、フォルダ、または非公開リンクの接続を確認してください。詳細: {message}",
  "new.error.sourceFetchFailedUnknown": "原因を取得できませんでした。",
  "new.error.generic":
    "サービスの追加に失敗しました。内容を確認して、もう一度お試しください。",
  "new.error.genericWithDetails":
    "サービスの追加に失敗しました。詳細: {message}",
  "new.error.requestId":
    "問題が続く場合はこのIDを添えて問い合わせてください: {id}",
  "new.error.invalidHostname":
    "この公開名は長すぎるか、使えない文字を含んでいます。もう少し短い名前にして、もう一度お試しください。",
  "new.error.connectionRequired":
    "このサービスの公開にはクラウドアカウントの接続が必要です。接続を設定してから、もう一度お試しください。",
  "new.error.appHostnameUnavailable":
    "この公開URL名は既に使われています。別の名前にして、もう一度お試しください。",
  "new.hostnameConflict.title": "別の公開URL名にしてください",
  "new.error.managedHostnameSlotLimit":
    "短いURLの空き枠がありません。通常URLを使うか、既存の短いURLを解放してください。",
  "new.hostnameConflict.body":
    "公開URLに使う名前を変えてから、もう一度追加してください。",
  "new.hostnameConflict.suggest": "候補名を使う",
  "new.error.alreadyExistsGeneric":
    "このサービスは既に追加されています。一覧から既存サービスを開いてください。",
  "new.error.nameReserved":
    "このサービス名は予約済みですが、現在の一覧では見つかりません。サービス一覧を更新し、未完了のサービスが表示されたら削除するか、別の名前を使ってください。",
  "new.error.notRunnable":
    "この確認結果ではまだ追加できません。表示された手直し内容を解消してから、もう一度確認してください。",

  // --- workspace settings ---------------------------------------------------------
  "workspaceSettings.title": "設定",
  "workspaceSettings.tabsLabel": "設定セクション",
  "workspaceSettings.subtitle":
    "ワークスペース名、メンバー、接続、使用量を確認します。",
  "workspaceSettings.tab.general": "一般",
  "workspaceSettings.tab.members": "メンバー",
  "workspaceSettings.tab.connections": "接続",
  "workspaceSettings.tab.billing": "お支払い",
  "workspaceSettings.tab.usageQuota": "使用量 / 上限",
  "workspaceSettings.tab.keys": "APIキー",
  "workspaceSettings.tab.backups": "バックアップ",
  "workspaceSettings.tab.shares": "共有値",
  "workspaceSettings.general.displayName": "表示名",
  "workspaceSettings.general.handle": "ハンドル",
  "workspaceSettings.general.type": "種別",
  "workspaceSettings.general.owner": "オーナー",
  "workspaceSettings.general.updated": "更新日時",
  "workspaceSettings.general.advancedDetails": "詳細情報",
  "workspaceSettings.general.saved": "設定を保存しました。",
  "workspaceSettings.general.archive": "ワークスペースをアーカイブ",
  "workspaceSettings.general.archiveConfirm":
    "このワークスペースを通常の一覧から外します。あとから管理用APIで確認できます。",
  "workspaceSettings.general.archivedNamed": "「{name}」をアーカイブしました。",
  "workspaceSettings.general.archivedHint":
    "復元は下のアーカイブ済み一覧から、別のワークスペースへの移動はワークスペース切り替えからできます。",
  "workspaceSettings.general.notFound":
    "このワークスペースは見つかりませんでした。切り替えるか、下のアーカイブ済みから復元してください。",
  "workspaceSettings.general.archivedTitle": "アーカイブ済みのワークスペース",
  "workspaceSettings.general.unarchive": "復元",
  "workspaceSettings.general.archiveLastError":
    "最後のワークスペースはアーカイブできません。",
  "workspaceSettings.general.nameRequired": "表示名を入力してください。",

  // --- members ---------------------------------------------------------------
  "members.role.owner": "オーナー",
  "members.role.admin": "管理者",
  "members.role.member": "メンバー",
  "members.role.viewer": "閲覧のみ",
  "members.status.active": "有効",
  "members.status.invited": "招待中",
  "members.status.suspended": "停止中",
  "members.invite.title": "メンバーを招待",
  "members.invite.subtitle":
    "一度サインイン済みの相手のメールアドレスを入力してください。",
  "members.invite.email": "メールアドレス",
  "members.invite.role": "役割",
  "members.invite.cta": "招待",
  "members.invite.emailRequired": "メールアドレスを入力してください。",
  "members.invite.success": "{email} を招待しました。",
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
  "members.removeConfirm": "このメンバーを削除しますか？（{account}）",
  "members.empty": "このワークスペースにはまだメンバーがいません。",
  "members.viewerNote":
    "メンバーの招待・役割変更・削除はオーナーまたは管理者のみ行えます。",

  // --- connections -------------------------------------------------------------
  "conn.subtitle":
    "自分のカギ（クラウドのトークンやアクセスキー）を保存します。カギを入れれば、制限や承認なしで任意のプロバイダーを動かせます。",
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
  "conn.byok.title": "自分のカギで任意のプロバイダーを接続",
  "conn.byok.body":
    "プロバイダーの取得元 (source) と、そのプロバイダーが使う環境変数（カギ）を入れるだけ。制限や承認なしで、どの OpenTofu / Terraform プロバイダーでも動きます。",
  "conn.byok.noBillingNote":
    "自分のカギを使う接続に Takosumi の課金はありません。課金対象になるのは Takosumi が提供するリソースだけです。",
  "conn.byok.usePreset": "インストール済み Recipe を使う",
  "conn.register": "接続を保存",
  "conn.registering": "保存中...",
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
  "conn.empty.title": "自分のカギで任意のプロバイダーを接続",
  "conn.empty.message":
    "自分のカギ（クラウドのトークンやキー）を入れれば、制限や承認、課金なしで、どのプロバイダーでも動かせます。",
  "conn.test": "アクセス確認",
  "conn.testing": "確認中...",
  "conn.test.notReady":
    "このアカウントはまだ利用できません（状態: {status}）。",
  "conn.remove.confirmTitle": "接続済みアカウントを削除",
  "conn.remove.confirmMessage":
    "本当に {name} を削除しますか？保存されたアクセス値も削除され、取り消せません。",
  "conn.remove.bindingWarning":
    "この接続を使うサービスのデプロイは失敗します。",

  // --- backups -----------------------------------------------------------------
  "backups.subtitle": "復元に使う保存ポイントを管理します。",
  "backups.create": "バックアップを作成",
  "backups.creating": "バックアップを作成しています。",
  "backups.col.createdAt": "作成日時",
  "backups.col.contents": "内容",
  "backups.col.actions": "操作",
  "backups.restorePoint": "復元ポイント",
  "backups.restoreGeneration": "バックアップ時点 {generation}",
  "backups.restore": "復元を準備",
  "backups.restoreUnavailable":
    "復元するには、サービスからバックアップを作成してください。",
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

  // --- Resource Shape ----------------------------------------------------------
  "resources.title": "リソース",
  "resources.subtitle":
    "Resource Shape の望ましい状態、配置先、観測結果を管理します。",
  "resources.define": "リソースを定義",
  "resources.empty": "この Resource Space にはリソースがありません。",
  "resources.column.resource": "リソース",
  "resources.column.phase": "状態",
  "resources.column.target": "配置先",
  "resources.column.managedBy": "管理元",
  "resources.scope.title": "Resource Space",
  "resources.scope.subtitle":
    "Dashboard セッションでは、検証済み Workspace ID が Resource Space の境界になります。",
  "resources.scope.label": "Space ID",
  "resources.scope.required": "Resource Space が必要です。",
  "resources.unavailable.title": "Resource Shape API は無効です",
  "resources.unavailable.message":
    "この operator では、永続 Resource Shape API と runner がまだ有効になっていません。",
  "resources.inventory.title": "リソース一覧",
  "resources.inventory.subtitle": "Space {space} の望ましい状態と観測状態",
  "resources.editor.createTitle": "リソースを定義",
  "resources.editor.editTitle": "望ましい状態を変更",
  "resources.editor.subtitle":
    "サービスと必要な設定を選び、価格とプレビューを確認してからデプロイします。",
  "resources.editor.serviceStep": "サービスを選ぶ",
  "resources.editor.service": "サービス",
  "resources.editor.serviceHint":
    "provider や実装先ではなく、必要なサービスの形を選びます。",
  "resources.editor.service.edgeWorker": "Edge Worker",
  "resources.editor.service.objectBucket": "Object Bucket",
  "resources.editor.service.kvStore": "KV Store",
  "resources.editor.service.sqlDatabase": "SQL Database",
  "resources.editor.service.queue": "Queue",
  "resources.editor.service.vectorIndex": "Vector Index",
  "resources.editor.service.durableWorkflow": "Durable Workflow",
  "resources.editor.service.containerService": "Container",
  "resources.editor.service.statefulActorNamespace": "Stateful Actor Namespace",
  "resources.editor.service.schedule": "Schedule",
  "resources.editor.service.custom": "Operator / カスタム Shape",
  "resources.editor.stable": "Stable",
  "resources.editor.stableHint":
    "10 個の組み込み Resource Shape はすべて同じ Stable Deploy API を使います。AI Gateway と Custom Domains は別の Cloud control lifecycle を維持します。",
  "resources.editor.customHint":
    "Operator 定義の Shape は、詳細設定で kind と Spec JSON を入力します。利用可否は接続先が判定します。",
  "resources.editor.inputsStep": "必要な設定",
  "resources.editor.inputsHint":
    "認証情報や provider 固有の設定は入力しません。",
  "resources.editor.kind": "Shape kind",
  "resources.editor.kindHint":
    "組み込み shape のほか、operator が明示登録した token も指定できます。",
  "resources.editor.kindInvalid": "有効な Shape kind を入力してください。",
  "resources.editor.name": "サービス名",
  "resources.editor.nameRequired": "サービス名を入力してください。",
  "resources.editor.artifactSource": "不変 artifact の参照方法",
  "resources.editor.artifactSource.url": "HTTPS リリース URL",
  "resources.editor.artifactSource.ref": "operator が発行した artifact ref",
  "resources.editor.artifactUrl": "Artifact URL",
  "resources.editor.artifactUrlHint":
    "CI / release が公開した不変の HTTPS URL。Takosumi は bundle をビルドしません。",
  "resources.editor.artifactRef": "Artifact ref",
  "resources.editor.artifactRefHint":
    "接続先が発行した opaque な不変参照です。provider 名や認証情報は含めません。",
  "resources.editor.artifactSha": "Artifact SHA-256",
  "resources.editor.artifactShaHint":
    "取得した artifact と一致する digest を指定します。",
  "resources.editor.artifactUrlRequired": "Artifact URL を入力してください。",
  "resources.editor.artifactUrlHttps":
    "Artifact URL は https:// で始まる必要があります。",
  "resources.editor.artifactRefRequired": "Artifact ref を入力してください。",
  "resources.editor.artifactShaRequired":
    "不変 artifact を検証する SHA-256 を入力してください。",
  "resources.editor.compatibilityDate": "Compatibility date（任意）",
  "resources.editor.compatibilityFlags": "Compatibility flags（任意）",
  "resources.editor.profiles": "必要な profile（任意）",
  "resources.editor.profilesHint":
    "profile token は接続先が公開・検証します。dashboard は固定リストを持ちません。",
  "resources.editor.tokenListHint": "複数指定はカンマまたは空白で区切ります。",
  "resources.editor.bucketInterfaces": "必要な object interface",
  "resources.editor.bucketInterfacesHint":
    "例: s3_api、signed_url。これは runtime Interface オブジェクトではなく、接続先が検証する capability token です。",
  "resources.editor.operatorDefault": "Operator 既定値",
  "resources.editor.capabilityTokenHint":
    "接続先が公開・検証する任意の capability token です。",
  "resources.editor.kvConsistency": "Consistency（任意）",
  "resources.editor.kvConsistency.eventual": "Eventual",
  "resources.editor.kvConsistency.strong": "Strong",
  "resources.editor.sqlEngine": "Engine capability（任意）",
  "resources.editor.sqlMigrationsPath": "Migrations path（任意）",
  "resources.editor.queueMaxRetries": "最大 retry 回数（任意）",
  "resources.editor.queueMaxBatchSize": "最大 batch size（任意）",
  "resources.editor.queueMaxRetriesInvalid":
    "最大 retry 回数は 0 以上の整数で指定してください。",
  "resources.editor.queueMaxBatchSizeInvalid":
    "最大 batch size は 0 以上の整数で指定してください。",
  "resources.editor.vectorDimensions": "Dimensions",
  "resources.editor.vectorMetric": "Similarity metric（任意）",
  "resources.editor.vectorDimensionsInvalid":
    "Dimensions は正の整数で指定してください。",
  "resources.editor.workflowEntrypoint": "Entrypoint",
  "resources.editor.workflowMaxAttempts": "最大 attempt 回数（任意）",
  "resources.editor.workflowBackoff": "初回 backoff 秒数（任意）",
  "resources.editor.workflowEntrypointRequired":
    "Workflow entrypoint を入力してください。",
  "resources.editor.workflowMaxAttemptsInvalid":
    "最大 attempt 回数は正の整数で指定してください。",
  "resources.editor.workflowBackoffInvalid":
    "初回 backoff は 0 以上の整数で指定してください。",
  "resources.editor.containerImage": "OCI image",
  "resources.editor.containerPorts": "Ports（任意）",
  "resources.editor.integerListHint":
    "正の整数をカンマまたは空白で区切ります。",
  "resources.editor.containerPublicHttp": "Public HTTP（任意）",
  "resources.editor.containerPublicHttp.enabled": "有効",
  "resources.editor.containerPublicHttp.disabled": "無効",
  "resources.editor.containerEnvironment": "Environment JSON（任意）",
  "resources.editor.containerEnvironmentHint":
    "値が非 secret 文字列の JSON object です。機密値には Secret または Credential を使います。",
  "resources.editor.containerImageRequired":
    "OCI image 参照を入力してください。",
  "resources.editor.containerPortsInvalid":
    "Port は正の整数をカンマまたは空白で区切って指定してください。",
  "resources.editor.containerEnvironmentInvalid":
    "Environment は値が文字列の JSON object で指定してください。",
  "resources.editor.actorClass": "Runtime class",
  "resources.editor.actorStorageProfile": "Storage profile（任意）",
  "resources.editor.actorMigrationTag": "Migration tag（任意）",
  "resources.editor.actorClassRequired": "Runtime class 名を入力してください。",
  "resources.editor.actorClassInvalid":
    "Runtime class は有効な class identifier で指定してください。",
  "resources.editor.scheduleCron": "Cron expression",
  "resources.editor.scheduleCronHint":
    "portable な 5 field cron expression を指定します。",
  "resources.editor.scheduleTimezone": "Timezone（任意）",
  "resources.editor.scheduleConnection": "Connection name",
  "resources.editor.scheduleTarget": "Target resource",
  "resources.editor.scheduleTargetHint":
    "schedule_trigger projection で呼び出す Resource reference です。",
  "resources.editor.scheduleCronRequired":
    "Cron expression を入力してください。",
  "resources.editor.scheduleCronInvalid":
    "Cron は 5 field で指定してください。",
  "resources.editor.scheduleConnectionInvalid":
    "Connection name は空白を含まない token で指定してください。",
  "resources.editor.scheduleTargetRequired":
    "空白を含まない target Resource reference を入力してください。",
  "resources.editor.project": "Project（任意）",
  "resources.editor.environment": "Environment",
  "resources.editor.targetPool": "TargetPool",
  "resources.editor.policy": "SpacePolicy",
  "resources.editor.spec": "Spec JSON",
  "resources.editor.specHint":
    "選択した Shape の spec だけを JSON object で入力します。認証情報は含めません。",
  "resources.editor.advanced": "詳細・operator 設定",
  "resources.editor.advancedHint":
    "Project、Environment、TargetPool、SpacePolicy、labels は必要な場合だけ指定します。通常のデプロイでは既定値を使えます。",
  "resources.editor.rawOptInHint":
    "connections、lifecycle policy、operator 拡張が必要な場合だけ raw Spec JSON に切り替えます。",
  "resources.editor.useRawSpec": "Raw Spec JSON を使う",
  "resources.editor.rawWarning":
    "これはカスタム Shape と operator 向けの入力です。schema、提供状況、価格は Deploy API が判定します。",
  "resources.editor.rawCannotGuide":
    "Raw Spec JSON に guided form が扱わない設定があります。内容を失わないよう raw mode のままにしました。",
  "resources.editor.labels": "Labels JSON",
  "resources.editor.labelsHint": "値がすべて文字列の JSON object です。",
  "resources.editor.specInvalid": "Spec JSON が不正です — {message}",
  "resources.editor.labelsInvalid": "Labels JSON が不正です — {message}",
  "resources.editor.preview": "プレビュー",
  "resources.editor.previewStep": "価格とプレビュー",
  "resources.editor.previewHint":
    "現在の入力を解決し、接続先が提供する価格、配置結果、実行内容を取得します。ここではまだデプロイしません。",
  "resources.editor.previewRequired":
    "現在の入力内容でもう一度プレビューしてください。",
  "resources.editor.deployStep": "確認してデプロイ",
  "resources.editor.deployHint":
    "プレビュー後に入力が変わっていないことを確認し、同じ plan と quote でデプロイします。",
  "resources.editor.apply": "サービスをデプロイ",
  "resources.editor.applied": "サービスの望ましい状態を適用しました。",
  "resources.editor.importExisting": "既存 native resource を取り込む",
  "resources.editor.nativeId": "Native resource ID",
  "resources.editor.nativeIdHint":
    "provider が発行した既存リソースの識別子です。認証情報は入力しません。",
  "resources.editor.nativeIdRequired":
    "Native resource ID を入力してください。",
  "resources.editor.import": "取り込む",
  "resources.editor.imported": "既存リソースを取り込みました。",
  "resources.confirm.applyTitle": "このサービスをデプロイしますか？",
  "resources.confirm.updateTitle": "望ましい状態を変更しますか？",
  "resources.confirm.applyMessage":
    "{kind}/{name} を Target {target} にデプロイします。確認した価格: {price}。同じ plan と quote だけが実行されます。",
  "resources.confirm.importTitle": "既存リソースを取り込みますか？",
  "resources.confirm.importMessage":
    "Native ID {nativeId} を {kind}/{name} として検証し、Takosumi の管理対象にします。",
  "resources.preview.title": "プレビュー結果",
  "resources.preview.current": "現在の入力",
  "resources.preview.changed": "入力が変更されています",
  "resources.preview.target": "Target",
  "resources.preview.implementation": "Implementation",
  "resources.preview.portability": "Portability",
  "resources.preview.price": "見積価格",
  "resources.preview.noQuoteShort": "価格 quote なし",
  "resources.preview.noQuote":
    "このプレビューには価格 quote がありません。OSS Takosumi は Cloud の価格表を持たないため、operator の billing mode と案内を確認してください。無料とはみなしません。",
  "resources.preview.unratedShort": "未レート",
  "resources.preview.unrated":
    "この quote は未レートです。OSS の disabled / showback 運用では適用できますが、価格や請求を意味しません。",
  "resources.preview.ratedHint":
    "接続先が返した versioned quote の見積合計です。デプロイ時に同じ quote を提示します。",
  "resources.preview.quote": "Quote ID",
  "resources.preview.catalog": "Price catalog",
  "resources.preview.offering": "Offering",
  "resources.preview.region": "リージョン",
  "resources.preview.priceExpires": "見積の有効期限",
  "resources.preview.lineItems": "確定価格の明細",
  "resources.preview.unitPrice": "単価",
  "resources.preview.subtotal": "小計",
  "resources.preview.tax": "税区分",
  "resources.preview.technicalDetails": "配置・native plan の詳細",
  "resources.preview.nativePlan": "Native plan",
  "resources.preview.risks": "注意事項",
  "resources.preview.noRisks": "追加の注意事項はありません。",
  "resources.targetPools.title": "TargetPool",
  "resources.targetPools.subtitle":
    "利用可能な Target と実装 descriptor を優先順に宣言します。",
  "resources.targetPools.add": "TargetPool を追加",
  "resources.targetPools.empty": "TargetPool がありません。",
  "resources.targetPools.column.name": "名前",
  "resources.targetPools.column.targets": "Target 数",
  "resources.targetPools.column.updated": "更新日時",
  "resources.targetPools.edit": "編集",
  "resources.targetPools.editorTitle": "TargetPool 設定",
  "resources.targetPools.name": "TargetPool 名",
  "resources.targetPools.nameRequired": "TargetPool 名を入力してください。",
  "resources.targetPools.spec": "TargetPool spec JSON",
  "resources.targetPools.specInvalid":
    "targets 配列を持つ有効な JSON object を入力してください。",
  "resources.targetPools.saved": "TargetPool を保存しました。",
  "resources.targetPools.deleteTitle": "TargetPool を削除しますか？",
  "resources.targetPools.deleteMessage":
    "TargetPool {name} を削除します。リソースから参照中の場合は拒否されます。",
  "resources.targetPools.deleteAria": "TargetPool {name} を削除",
  "resources.config.noSecrets":
    "ここには非機密 descriptor だけを入力します。認証情報は Provider Connection に保存してください。",
  "resources.policy.title": "SpacePolicy の詳細設定",
  "resources.policy.subtitle": "配置制約、優先度、承認要件を JSON で設定",
  "resources.policy.add": "SpacePolicy を追加",
  "resources.policy.empty": "SpacePolicy がありません。",
  "resources.policy.column.name": "名前",
  "resources.policy.column.updated": "更新日時",
  "resources.policy.edit": "編集",
  "resources.policy.editorTitle": "SpacePolicy 設定",
  "resources.policy.name": "SpacePolicy 名",
  "resources.policy.nameRequired": "SpacePolicy 名を入力してください。",
  "resources.policy.spec": "SpacePolicy spec JSON",
  "resources.policy.specInvalid": "有効な JSON object を入力してください。",
  "resources.policy.saved": "SpacePolicy を保存しました。",
  "resources.policy.deleteTitle": "SpacePolicy を削除しますか？",
  "resources.policy.deleteMessage": "SpacePolicy {name} を削除します。",
  "resources.policy.deleteAria": "SpacePolicy {name} を削除",
  "resources.policy.writeOnlyHint":
    "同名ポリシーの現在値を上書きします。認証情報や秘密値は含めません。",
  "resources.detail.subtitle": "Resource Space {space} の状態と操作履歴",
  "resources.detail.back": "リソース一覧",
  "resources.detail.observe": "観測",
  "resources.detail.refresh": "状態を更新",
  "resources.detail.actionComplete": "操作が完了しました。",
  "resources.detail.loadFailed": "リソースを読み込めませんでした",
  "resources.detail.status": "現在の状態",
  "resources.detail.kind": "Kind",
  "resources.detail.space": "Space",
  "resources.detail.managedBy": "管理元",
  "resources.detail.generation": "観測済み generation",
  "resources.detail.resolution": "ResolutionLock",
  "resources.detail.locked": "固定済み",
  "resources.detail.yes": "はい",
  "resources.detail.no": "いいえ",
  "resources.detail.desired": "望ましい状態",
  "resources.detail.desiredHint":
    "Spec は折りたたんで表示し、変更前には必ず再プレビューします。",
  "resources.detail.change": "変更する",
  "resources.detail.showSpec": "Spec JSON を表示",
  "resources.detail.conditions": "Conditions",
  "resources.detail.conditionsHint": "Reconcile と drift の公開状態",
  "resources.detail.outputs": "Output keys",
  "resources.detail.outputsHint":
    "値はこの一覧では表示せず、公開されているキー名だけを示します。",
  "resources.detail.events": "操作履歴",
  "resources.detail.eventsHint": "非機密な Activity / Run projection",
  "resources.detail.noEvents": "操作履歴はまだありません。",
  "resources.detail.deleteTitle": "リソースを削除しますか？",
  "resources.detail.deleteMessage":
    "{kind}/{name} と native resource の通常削除を実行します。この画面は force delete を行いません。",

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

  // --- billing -------------------------------------------------------------------
  "billing.subtitle":
    "プロバイダーに依存しない使用量とショーバック記録を確認します。",
  "billing.usageQuotaTitle": "ショーバック",
  "billing.usageQuotaSubtitle":
    "この Workspace の記録モードとプロバイダー非依存な使用量を確認します。",
  "billing.mode.disabled": "この Workspace ではショーバックは無効です。",
  "billing.mode.label": "モード",
  "billing.mode.showback": "使用量は記録されますが、請求はありません。",
  "billing.loadError": "使用量設定を読み込めませんでした: {message}",
  "billing.usage.title": "使用量",
  "billing.usage.subtitle":
    "この Workspace のプロバイダー非依存な使用イベントです。",
  "billing.usage.load": "使用量を読み込む",
  "billing.usage.more": "さらに読み込む",
  "billing.usage.openHint": "使用履歴を開くと最近の明細を読み込みます。",
  "billing.usage.moreAvailable": "最近の明細を表示しています。",
  "billing.usage.loading": "使用量を読み込み中です...",
  "billing.usage.error": "使用量を読み込めませんでした: {message}",
  "billing.usage.empty": "使用量はまだありません。",
  "billing.usage.kind": "種別",
  "billing.usage.time": "日時",
  "billing.usage.kind.runnerMinute": "実行時間",
  "billing.usage.kind.operation": "サービス操作",
  "billing.usage.kind.compute": "コンピュート",
  "billing.usage.kind.storage": "ストレージ",
  "billing.usage.quantity": "数量",
  "billing.usage.amount": "見積金額",
  "billing.usage.unrated": "未評価",
} as const;
