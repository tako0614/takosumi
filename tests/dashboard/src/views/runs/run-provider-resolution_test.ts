import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { en } from "../../../../../dashboard/src/i18n/en.ts";
import { ja } from "../../../../../dashboard/src/i18n/ja.ts";

const here = dirname(fileURLToPath(import.meta.url));
const runViewSource = readFileSync(
  resolve(here, "../../../../../dashboard/src/views/runs/RunView.tsx"),
  "utf8",
);
const controlApiSource = readFileSync(
  resolve(here, "../../../../../dashboard/src/lib/control-api.ts"),
  "utf8",
);

describe("Run review ProviderConnection evidence", () => {
  test("keeps public provider resolution fields on the dashboard Run shape", () => {
    expect(controlApiSource).toContain(
      "ProviderResolution as ContractProviderResolution",
    );
    expect(controlApiSource).toContain(
      "readonly providerResolutions?: readonly ProviderResolution[]",
    );
    expect(controlApiSource).toContain(
      "readonly runEnvironmentEvidenceDigest?: string",
    );
    expect(controlApiSource).toContain("readonly redactionProfileId?: string");
  });

  test("keeps ProviderConnection evidence available but folded behind review details", () => {
    expect(runViewSource).toContain("ProviderResolutionTable");
    expect(runViewSource).toContain("providerResolutionRows(run.latest");
    expect(runViewSource).toContain("providerRowsNeedingAttention");
    expect(runViewSource).toContain("providerResolutionNeedsAttention");
    expect(runViewSource).toContain('t("run.connections.reviewTitle")');
    expect(runViewSource).toContain(
      "<Show when={providerRowsNeedingAttention().length > 0}>",
    );
    expect(runViewSource).toContain("rows={providerRowsNeedingAttention()}");
    expect(runViewSource).toContain("listProviderConnections");
    expect(runViewSource).toContain("providerConnectionsForRun");
    expect(en["run.details.title"]).toBe("Reference info");
    expect(ja["run.details.title"]).toBe("参照情報");
    expect(en["run.connections.reviewTitle"]).toBe(
      "Connected account review needed",
    );
    expect(ja["run.connections.reviewTitle"]).toBe(
      "接続済みアカウントの確認が必要です",
    );
    expect(en).not.toHaveProperty("run.connections.ownership");
    expect(ja).not.toHaveProperty("run.connections.ownership");
    expect(runViewSource).not.toContain('t("run.connections.ownership")');
    expect(runViewSource).not.toContain("conn.ownership.takosProvided");
  });

  test("shows public plan resources as the reviewable resource list", () => {
    expect(controlApiSource).toContain(
      "readonly planResources?: readonly RunPlanResource[]",
    );
    expect(runViewSource).toContain("PlanResourceReview");
    expect(runViewSource).toContain("PLAN_RESOURCE_REVIEW_LIMIT");
    expect(runViewSource).toContain("run.latest?.planResources ?? []");
    expect(runViewSource).toContain("planResourceDisplayLabel");
    expect(runViewSource).toContain("planResourceActionLabel");
    expect(runViewSource).toContain('t("run.resources.title")');
    expect(runViewSource).toContain('t("run.resources.identifiers")');
    expect(runViewSource).toContain(
      "<PlanResourceReview resources={planResources()} />",
    );
    // The per-resource change list is surfaced by default (right after the
    // change-count strip), NOT buried inside the folded "Reference info"
    // expert details. It must appear before that expert-details summary.
    expect(runViewSource.indexOf("<PlanResourceReview")).toBeLessThan(
      runViewSource.indexOf('summary>{t("run.details.title")}</summary>'),
    );
    expect(en["run.resources.title"]).toBe("Planned changes");
    expect(ja["run.resources.title"]).toBe("変更予定");
    expect(en["run.resources.kicker"]).toBe("Review");
    expect(ja["run.resources.kicker"]).toBe("確認");
    expect(en["run.resources.identifiers"]).toBe("Reference IDs");
    expect(ja["run.resources.identifiers"]).toBe("参照 ID");
    expect(runViewSource).not.toContain("change.before");
    expect(runViewSource).not.toContain("change.after");
  });

  test("keeps run identifiers and raw audit detail nested under support details", () => {
    expect(runViewSource).toContain("supportDetailItems");
    expect(runViewSource).toContain("debugDetailItems");
    expect(runViewSource).toContain('t("run.details.debug")');
    expect(runViewSource).toContain('t("run.audit.detail")');
    expect(runViewSource.indexOf("debugDetailItems")).toBeGreaterThan(
      runViewSource.indexOf("supportDetailItems"),
    );
    expect(
      runViewSource.indexOf('label: t("run.details.runId")'),
    ).toBeGreaterThan(runViewSource.indexOf("debugDetailItems"));
    expect(
      runViewSource.indexOf('<summary>{t("run.audit.detail")}</summary>'),
    ).toBeLessThan(
      runViewSource.indexOf('<pre class="wa-pre">{value()}</pre>'),
    );
    expect(en["run.details.debug"]).toBe("Identifiers");
    expect(ja["run.details.debug"]).toBe("識別情報");
    expect(en["run.audit.detail"]).toBe("Record detail");
    expect(ja["run.audit.detail"]).toBe("記録の詳細");
  });

  test("does not render an empty diagnostics card on normal run reviews", () => {
    expect(runViewSource).toContain("const diagnosticRows = createMemo");
    expect(runViewSource).toContain("const showDiagnosticsPanel = createMemo");
    expect(runViewSource).toContain("<Show when={showDiagnosticsPanel()}>");
    expect(runViewSource).toContain('t("run.diagnostics.failed")');
    expect(runViewSource).not.toContain(
      'fallback={\\n                          <ul class="wa-diags">',
    );
    expect(runViewSource).not.toContain(
      '<p class="muted">{t("run.diagnostics.empty")}</p>',
    );
    expect(en["run.diagnostics.failed"]).toContain("Open details");
    expect(ja["run.diagnostics.failed"]).toContain("詳細");
  });

  test("does not infer host extension behavior from error-code prefixes", () => {
    expect(runViewSource).not.toContain("isBillingActionRequiredRun");
    expect(runViewSource).not.toContain('startsWith("billing_")');
    expect(runViewSource).not.toContain("billingActionRequired");
    expect(runViewSource).toContain("cost().blocked");
    expect(runViewSource).toContain('"billing.commercial.v1"');
  });

  test("shows unrated showback without presenting it as a free zero estimate", () => {
    expect(controlApiSource).toContain(
      'readonly ratingStatus: "not_applicable" | "rated" | "unrated"',
    );
    expect(runViewSource).toContain('cost.ratingStatus === "unrated"');
    expect(runViewSource).toContain('t("run.cost.unrated")');
    expect(en["run.cost.unrated"]).toContain("no price policy");
    expect(ja["run.cost.unrated"]).toContain("価格ポリシー");
  });

  test("classifies short managed-hostname quota failures as a URL action", () => {
    expect(runViewSource).toContain("function isManagedHostnameSlotLimitRun");
    expect(runViewSource).toContain(
      'run.errorCode === "managed_public_hostname_slot_limit_reached"',
    );
    expect(runViewSource).toContain(
      'diagnostic.code === "managed_public_hostname_slot_limit_reached"',
    );
    expect(runViewSource).not.toContain("isManagedHostnameSlotLimitText");
    expect(runViewSource).toContain('t("run.summary.hostnameSlotLimit")');
    expect(runViewSource).toContain(
      't("run.diagnostics.hostnameSlotLimitShort")',
    );
    expect(en["run.summary.hostnameSlotLimit"]).toContain("short URL");
    expect(ja["run.summary.hostnameSlotLimit"]).toContain("短いURL");
  });

  test("classifies stale connected-account verification failures as a re-review action", () => {
    expect(runViewSource).toContain("function accessIssueForRun");
    expect(runViewSource).toContain("diagnostic.code");
    expect(runViewSource).toContain('"provider_connection_not_ready"');
    expect(runViewSource).not.toContain("accessIssueFromText");
    expect(runViewSource).not.toContain("credential_mint_failed");
    expect(runViewSource).not.toContain("pending (not verified)");
    expect(runViewSource).toContain(
      't("run.summary.connectionVerificationRequired")',
    );
    expect(runViewSource).toContain(
      't("run.summary.connectionVerificationHint")',
    );
    expect(runViewSource).toContain(
      't("run.diagnostics.connectionVerificationRequired")',
    );
    expect(runViewSource).toContain(
      't("run.diagnostics.connectionVerificationShort")',
    );
    expect(runViewSource).toContain(
      't("run.diagnostics.connectionVerificationDetail")',
    );
    expect(runViewSource).toContain("connectionVerificationRequired())");
    expect(en["run.summary.connectionVerificationRequired"]).toContain(
      "Connected account",
    );
    expect(ja["run.summary.connectionVerificationRequired"]).toContain(
      "接続済みアカウント",
    );
    expect(en["run.diagnostics.connectionVerificationDetail"]).toContain(
      "Review the changes again",
    );
    expect(ja["run.diagnostics.connectionVerificationDetail"]).toContain(
      "もう一度変更を確認",
    );
  });

  test("classifies the other credential access failures without raw provider errors", () => {
    expect(runViewSource).toContain('"provider_connection_setup_required"');
    expect(runViewSource).toContain('"provider_connection_changed"');
    expect(runViewSource).toContain('"credential_service_unavailable"');
    expect(runViewSource).not.toContain("resolved_bindings_changed");
    expect(runViewSource).not.toContain("connection vault is not configured");
    expect(runViewSource).toContain('t("run.summary.connectionSetupRequired")');
    expect(runViewSource).toContain('t("run.summary.connectionChanged")');
    expect(runViewSource).toContain('t("run.summary.credentialServiceIssue")');
    expect(runViewSource).toContain(
      't("run.diagnostics.connectionSetupRequired")',
    );
    expect(runViewSource).toContain('t("run.diagnostics.connectionChanged")');
    expect(runViewSource).toContain(
      't("run.diagnostics.credentialServiceIssue")',
    );
    expect(en["run.summary.connectionSetupRequired"]).toContain(
      "Connected account setup",
    );
    expect(ja["run.summary.connectionSetupRequired"]).toContain(
      "接続済みアカウント",
    );
    expect(en["run.summary.credentialServiceIssue"]).toContain(
      "Access preparation",
    );
    expect(ja["run.summary.credentialServiceIssue"]).toContain("アクセス準備");
  });

  test("redacts secret-shaped values before rendering run diagnostics", () => {
    expect(runViewSource).toContain("function diagnosticDisplayText");
    expect(runViewSource).toContain(
      'import { redactString } from "takosumi-contract/redaction"',
    );
    expect(runViewSource).toContain("const redacted = redactString(value)");
    expect(runViewSource).toContain(
      "diagnosticDisplayText(props.diagnostic.message)",
    );
    expect(runViewSource).toContain(
      "diagnosticDisplayText(props.diagnostic.detail)",
    );
    expect(runViewSource).not.toContain(
      '<span class="wa-diag-msg">{props.diagnostic.message}</span>',
    );
    expect(runViewSource).not.toContain(
      '<pre class="wa-pre">{props.diagnostic.detail}</pre>',
    );
  });

  test("keeps the copy explicit that private values are not displayed", () => {
    expect(en["run.connections.reviewBody"].toLowerCase()).toContain(
      "private values are not shown",
    );
    expect(en["run.connections.reviewBody"]).not.toContain(
      "will use these provider connections",
    );
    expect(ja["run.connections.reviewBody"]).toContain(
      "非公開の値は表示しません",
    );
  });

  test("gates commercial recovery behind the generic capability surface", () => {
    expect(runViewSource).toContain("hasPlatformExtensionCapability");
    expect(runViewSource).toContain('"billing.commercial.v1"');
    expect(runViewSource).toContain('href="/billing"');
    expect(runViewSource).toContain('"run.cost.billingCta"');
    expect(runViewSource).toContain('"run.cost.operatorHelp"');
    expect(en["run.cost.billingCta"]).toContain("billing");
    expect(en["run.cost.operatorHelp"]).toContain("workspace");
    expect(ja["run.cost.billingCta"]).toContain("お支払い");
    expect(ja["run.cost.operatorHelp"]).toContain("ワークスペース");
  });

  test("keeps launch URLs Interface-owned instead of inferring them from run state or outputs", () => {
    expect(runViewSource).not.toContain("listDeployments");
    expect(runViewSource).toContain("listActivity");
    expect(runViewSource).not.toContain("launchUrlFromDeployment");
    expect(runViewSource).toContain("listAuthorizedUiSurfaces");
    expect(runViewSource).not.toContain("refreshSession");
    expect(runViewSource).toContain("capsuleId: id");
    expect(runViewSource).toContain("completedRunLaunchUrl");
    expect(runViewSource).toContain(
      "Runtime launch surfaces are Interface-owned",
    );
    expect(runViewSource).not.toContain("publicUrlFromOutputs");
    expect(runViewSource).toContain("completedRunUiSurfaces.error");
    expect(runViewSource).toContain('t("apps.openApp")');
    expect(runViewSource).toContain('target="_blank"');
    expect(runViewSource).toContain('rel="noreferrer noopener"');
    expect(runViewSource.indexOf('t("apps.openApp")')).toBeLessThan(
      runViewSource.indexOf(
        't("run.backToApp")',
        runViewSource.indexOf('t("apps.openApp")'),
      ),
    );
  });

  test("waits for release activation before presenting a successful apply as ready", () => {
    expect(runViewSource).toContain("stateVersionReadinessAfterApply");
    expect(runViewSource).toContain("completedRunStateVersion");
    expect(runViewSource).toContain("completedRunReadiness");
    expect(runViewSource).toContain('readiness === "activation_pending"');
    expect(runViewSource).toContain(
      'if (readiness === "activation_failed") return { phase: "error" };',
    );
    expect(runViewSource).toContain(
      'if (readiness === "ready") return { phase: "done" };',
    );
    expect(runViewSource).toContain(
      'if (readiness === "ready" || readiness === "activation_failed") return;',
    );
    expect(runViewSource).toContain("refetchStateVersions()");
    expect(runViewSource).toContain("refetchActivity()");
    expect(runViewSource).toContain('t("run.summary.activationPending")');
    expect(runViewSource).toContain('t("run.summary.activationFailed")');
    expect(runViewSource).toContain('t("install.activationPending")');
    expect(en["run.summary.activationPending"]).toContain("activation");
    expect(ja["run.summary.activationPending"]).toContain("公開処理");
    expect(en["run.summary.activationFailed"]).toContain("failed");
    expect(ja["run.summary.activationFailed"]).toContain("失敗");
  });
});
