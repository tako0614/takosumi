const NATIVE_SECURITY_CASES = [
  "first_store",
  "cold_restart",
  "unlock_cancel",
  "biometric_change",
  "app_upgrade",
  "legacy_migration",
];

const REMOTE_PUSH_CASES = [
  "foreground",
  "background",
  "terminated",
  "tap",
  "token_rotation",
];

export function validateMobileReleaseEvidence({
  evidence: value,
  product,
  productName,
  bundleId,
  releaseVersion,
}) {
  const results = [];
  const evidence = record(value);
  if (!evidence) {
    fail(
      "evidence.object_required",
      "release evidence must be a JSON object",
      "Replace the evidence file with a takos.mobile-release-evidence.v1 JSON object.",
    );
    return buildResult();
  }

  expect(
    evidence.schema === "takos.mobile-release-evidence.v1",
    "release evidence schema is takos.mobile-release-evidence.v1",
    "evidence.schema_invalid",
    "Set schema to takos.mobile-release-evidence.v1.",
  );
  expect(
    evidence.product === product,
    "release evidence product matches",
    "evidence.product_mismatch",
    "Use the evidence file for this product shell.",
  );
  expect(
    evidence.productName === productName,
    "release evidence productName matches",
    "evidence.product_name_mismatch",
    "Set productName to the product's Tauri productName.",
  );
  expect(
    evidence.bundleId === bundleId,
    "release evidence bundleId matches",
    "evidence.bundle_id_mismatch",
    "Set bundleId to the product's Tauri identifier.",
  );
  expectIsoTimestamp(evidence.generatedAt, "generatedAt");
  if (releaseVersion) {
    expect(
      evidence.releaseVersion === releaseVersion,
      "release evidence releaseVersion matches tauri.conf version",
      "evidence.version_mismatch",
      "Regenerate evidence for the exact Tauri release version.",
    );
  }

  const artifacts = record(evidence.artifacts);
  checkPrivateRefDigest(record(artifacts?.iosArchive), "artifacts.iosArchive");
  checkPrivateRefDigest(record(artifacts?.androidAab), "artifacts.androidAab");

  const signing = record(evidence.signing);
  const iosSigning = record(signing?.ios);
  expectPrivateRef(iosSigning?.teamRef, "signing.ios.teamRef");
  expectPrivateRef(
    iosSigning?.provisioningProfileRef,
    "signing.ios.provisioningProfileRef",
  );
  const androidSigning = record(signing?.android);
  expectPrivateRef(androidSigning?.keystoreRef, "signing.android.keystoreRef");
  expect(
    androidSigning?.playAppSigning === true,
    "signing.android.playAppSigning is true",
    evidenceId("signing.android.playAppSigning", "not_enabled"),
    "Enable Play App Signing and record the public-safe signing reference.",
  );

  checkScenarioEvidence(
    record(evidence.nativeSecurity?.ios),
    "nativeSecurity.ios",
    NATIVE_SECURITY_CASES,
  );
  checkScenarioEvidence(
    record(evidence.nativeSecurity?.android),
    "nativeSecurity.android",
    NATIVE_SECURITY_CASES,
  );

  checkScenarioEvidence(
    record(evidence.mobileOidc?.codeExchange),
    "mobileOidc.codeExchange",
    ["authorization_code_pkce", "refresh_rotation"],
  );
  checkScenarioEvidence(
    record(evidence.mobileOidc?.firstUserProvision),
    "mobileOidc.firstUserProvision",
    ["new_account", "repeat_sign_in"],
  );
  checkScenarioEvidence(
    record(evidence.mobileOidc?.scopedApi),
    "mobileOidc.scopedApi",
    ["auth_me", "allowed_scope", "denied_scope", "wrong_audience_rejected"],
  );

  checkPassedEvidence(
    record(evidence.remotePush?.deliveryBackend),
    "remotePush.deliveryBackend",
  );
  checkScenarioEvidence(
    record(evidence.remotePush?.ios),
    "remotePush.ios",
    REMOTE_PUSH_CASES,
  );
  checkScenarioEvidence(
    record(evidence.remotePush?.android),
    "remotePush.android",
    REMOTE_PUSH_CASES,
  );

  const store = record(evidence.store);
  checkAppStore(record(store?.appStore));
  checkGooglePlay(record(store?.googlePlay));
  checkDeviceSmoke(evidence.deviceSmoke);

  return buildResult();

  function checkScenarioEvidence(entry, label, requiredCases) {
    checkPassedEvidence(entry, label);
    const cases = new Set(Array.isArray(entry?.cases) ? entry.cases : []);
    for (const requiredCase of requiredCases) {
      expect(
        cases.has(requiredCase),
        `${label}.cases includes ${requiredCase}`,
        evidenceId(`${label}.cases.${requiredCase}`, "missing"),
        `Capture the ${requiredCase} scenario on the required release environment and update the evidence file.`,
      );
    }
  }

  function checkPassedEvidence(entry, label) {
    expect(
      entry?.result === "passed",
      `${label}.result is passed`,
      evidenceId(`${label}.result`, "not_passed"),
      `Capture passed ${label} evidence before store submission.`,
    );
    expectIsoTimestamp(entry?.capturedAt, `${label}.capturedAt`);
    expectPrivateRef(entry?.evidenceRef, `${label}.evidenceRef`);
  }

  function checkAppStore(appStore) {
    expectPrivateRef(appStore?.appRef, "store.appStore.appRef");
    expectPrivateRef(
      appStore?.uploadedBuildRef,
      "store.appStore.uploadedBuildRef",
    );
    expect(
      appStore?.listingReviewed === true,
      "store.appStore.listingReviewed is true",
      evidenceId("store.appStore.listingReviewed", "not_reviewed"),
      "Review the App Store listing and record the result.",
    );
    expect(
      appStore?.privacyNutritionReviewed === true,
      "store.appStore.privacyNutritionReviewed is true",
      evidenceId("store.appStore.privacyNutritionReviewed", "not_reviewed"),
      "Review App Store privacy nutrition details and record the result.",
    );
    checkScreenshots(appStore?.screenshots, "store.appStore.screenshots");
  }

  function checkGooglePlay(googlePlay) {
    expect(
      googlePlay?.packageName === bundleId,
      "store.googlePlay.packageName matches bundle id",
      evidenceId("store.googlePlay.packageName", "mismatch"),
      "Set the Google Play package name to the Tauri bundle identifier.",
    );
    expectPrivateRef(
      googlePlay?.uploadedArtifactRef,
      "store.googlePlay.uploadedArtifactRef",
    );
    expect(
      googlePlay?.listingReviewed === true,
      "store.googlePlay.listingReviewed is true",
      evidenceId("store.googlePlay.listingReviewed", "not_reviewed"),
      "Review the Google Play listing and record the result.",
    );
    expect(
      googlePlay?.dataSafetyReviewed === true,
      "store.googlePlay.dataSafetyReviewed is true",
      evidenceId("store.googlePlay.dataSafetyReviewed", "not_reviewed"),
      "Review Google Play data safety details and record the result.",
    );
    checkScreenshots(googlePlay?.screenshots, "store.googlePlay.screenshots");
  }

  function checkScreenshots(screenshots, label) {
    if (!Array.isArray(screenshots) || screenshots.length === 0) {
      fail(
        evidenceId(label, "missing"),
        `${label} must include at least one screenshot evidence entry`,
        "Capture store screenshots and record public-safe references and digests.",
      );
      return;
    }
    ok(`${label} includes ${screenshots.length} screenshot evidence entry`);
    for (const [index, screenshot] of screenshots.entries()) {
      const item = record(screenshot);
      const prefix = `${label}[${index}]`;
      expectText(item?.locale, `${prefix}.locale`);
      expectText(item?.device, `${prefix}.device`);
      checkPrivateRefDigest(item, prefix);
    }
  }

  function checkDeviceSmoke(deviceSmoke) {
    if (!Array.isArray(deviceSmoke) || deviceSmoke.length === 0) {
      fail(
        "evidence.device_smoke_missing",
        "deviceSmoke must include iOS and Android passed smoke evidence",
        "Capture passed physical-device smoke evidence for iOS and Android.",
      );
      return;
    }
    const platforms = new Set();
    for (const [index, entry] of deviceSmoke.entries()) {
      const item = record(entry);
      const prefix = `deviceSmoke[${index}]`;
      const platform = optionalText(item?.platform);
      if (platform === "ios" || platform === "android") {
        platforms.add(platform);
        ok(`${prefix}.platform is ${platform}`);
      } else {
        fail(
          evidenceId(`${prefix}.platform`, "invalid"),
          `${prefix}.platform must be ios or android`,
          "Set each device smoke platform to ios or android.",
        );
      }
      expect(
        item?.result === "passed",
        `${prefix}.result is passed`,
        evidenceId(`${prefix}.result`, "not_passed"),
        "Capture a passed physical-device smoke run.",
      );
      expectText(item?.device, `${prefix}.device`);
      expectText(item?.osVersion, `${prefix}.osVersion`);
      expectIsoTimestamp(item?.capturedAt, `${prefix}.capturedAt`);
      expectPrivateRef(item?.evidenceRef, `${prefix}.evidenceRef`);
    }
    expect(
      platforms.has("ios"),
      "deviceSmoke includes iOS passed smoke evidence",
      "evidence.device_smoke_ios_missing",
      "Capture passed smoke evidence on a physical iOS device.",
    );
    expect(
      platforms.has("android"),
      "deviceSmoke includes Android passed smoke evidence",
      "evidence.device_smoke_android_missing",
      "Capture passed smoke evidence on a physical Android device.",
    );
  }

  function checkPrivateRefDigest(entry, label) {
    expectPrivateRef(entry?.evidenceRef, `${label}.evidenceRef`);
    expectSha256(entry?.sha256, `${label}.sha256`);
  }

  function expectPrivateRef(value, label) {
    const text = optionalText(value);
    if (!text) {
      fail(
        evidenceId(label, "missing"),
        `${label} is required`,
        "Record a public-safe private: evidence reference.",
      );
      return;
    }
    if (!text.startsWith("private:")) {
      fail(
        evidenceId(label, "not_private_ref"),
        `${label} must be a public-safe private: evidence reference`,
        "Replace the value with a public-safe private: reference; do not commit private evidence.",
      );
      return;
    }
    ok(`${label} is a private evidence reference`);
  }

  function expectSha256(value, label) {
    const text = optionalText(value);
    if (!text) {
      fail(
        evidenceId(label, "missing"),
        `${label} is required`,
        "Record the sha256 digest of the release artifact or screenshot.",
      );
      return;
    }
    if (!/^sha256:[a-f0-9]{64}$/i.test(text)) {
      fail(
        evidenceId(label, "invalid"),
        `${label} must be sha256:<64 hex chars>`,
        "Replace the digest with sha256:<64 hex chars>.",
      );
      return;
    }
    if (/^sha256:0{64}$/i.test(text)) {
      fail(
        evidenceId(label, "example_zero_digest"),
        `${label} must not use the example zero digest`,
        "Replace the example digest with the real artifact or screenshot digest.",
      );
      return;
    }
    ok(`${label} is a sha256 digest`);
  }

  function expectIsoTimestamp(value, label) {
    const text = optionalText(value);
    if (!text) {
      fail(
        evidenceId(label, "missing"),
        `${label} is required`,
        "Record the evidence capture time as an exact ISO timestamp.",
      );
      return;
    }
    const timestamp = Date.parse(text);
    if (
      !Number.isFinite(timestamp) ||
      new Date(timestamp).toISOString() !== text
    ) {
      fail(
        evidenceId(label, "invalid"),
        `${label} must be an ISO timestamp`,
        "Use an exact UTC ISO timestamp such as 2026-07-01T00:00:00.000Z.",
      );
      return;
    }
    ok(`${label} is an ISO timestamp`);
  }

  function expectText(value, label) {
    if (optionalText(value)) ok(`${label} is present`);
    else
      fail(
        evidenceId(label, "missing"),
        `${label} is required`,
        `Record ${label} in the release evidence.`,
      );
  }

  function expect(condition, message, id, action) {
    if (condition) ok(message);
    else fail(id, message, action);
  }

  function ok(message) {
    results.push({ kind: "ok", message });
  }

  function fail(id, message, action) {
    results.push({ kind: "fail", id, message, action });
  }

  function buildResult() {
    const issues = results.filter((result) => result.kind === "fail");
    return { valid: issues.length === 0, results, issues };
  }
}

function evidenceId(label, defect) {
  const normalized = label
    .replace(/\[(\d+)\]/g, ".$1")
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase();
  return `evidence.${normalized}_${defect}`;
}

function record(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value;
}

function optionalText(value) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
