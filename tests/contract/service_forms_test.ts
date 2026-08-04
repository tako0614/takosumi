import { expect, test } from "bun:test";
import {
  formRefKey,
  formRefOfInstalled,
  installedFormReferenceKey,
  isFormRef,
  isInstalledFormReference,
  isPortableInterfaceInputSource,
  isSha256Digest,
  PORTABLE_INTERFACE_INPUT_SOURCES,
  TAKOFORM_INSTALL_ENVELOPE_CHECKPOINT_V3_KEYS,
  TAKOFORM_INSTALL_ENVELOPE_PIN_SET_V3_KEYS,
  TAKOFORM_INSTALL_ENVELOPE_SET_FORMAT,
  TAKOFORM_INSTALL_ENVELOPE_SET_V3_KEYS,
  type FormRef,
} from "../../contract/service-forms.ts";

const schemaDigest = `sha256:${"a".repeat(64)}`;
const packageDigest = `sha256:${"b".repeat(64)}`;

const exactRef: FormRef = {
  type: "edge_worker",
  version: "1.0.0",
  schemaDigest,
};

test("FormRef requires an exact immutable three-field identity", () => {
  expect(isFormRef(exactRef)).toBe(true);
  expect(isFormRef({ ...exactRef, version: "latest" })).toBe(false);
  expect(isFormRef({ ...exactRef, type: "EdgeWorker" })).toBe(false);
  expect(isFormRef({ ...exactRef, schemaDigest: "sha256:placeholder" })).toBe(
    false,
  );
  expect(isFormRef({ ...exactRef, packageDigest })).toBe(false);
  expect(isFormRef({ ...exactRef, channel: "stable" })).toBe(false);
  expect(formRefKey(exactRef)).toContain("edge_worker");
});

test("packageDigest remains a sibling of the flat FormRef", () => {
  expect(isSha256Digest(packageDigest)).toBe(true);
  expect(installedFormReferenceKey({ ...exactRef, packageDigest })).toEndWith(
    packageDigest,
  );
  expect(formRefOfInstalled({ ...exactRef, packageDigest })).toEqual(exactRef);
});

test("InstalledFormReference rejects partial, extra, and malformed identities", () => {
  const identity = { ...exactRef, packageDigest };
  expect(isInstalledFormReference(identity)).toBe(true);
  expect(isInstalledFormReference(exactRef)).toBe(false);
  expect(isInstalledFormReference({ ...identity, channel: "stable" })).toBe(
    false,
  );
  expect(
    isInstalledFormReference({ ...identity, packageDigest: "sha256:latest" }),
  ).toBe(false);
  expect(() =>
    installedFormReferenceKey({
      ...identity,
      packageDigest: "sha256:latest",
    }),
  ).toThrow("invalid exact installed form reference");
});

test("portable Interface input sources include the host-owned resource URI marker", () => {
  expect(PORTABLE_INTERFACE_INPUT_SOURCES).toEqual([
    "literal",
    "output",
    "resource_uri",
  ]);
  expect(isPortableInterfaceInputSource("resource_uri")).toBe(true);
  expect(isPortableInterfaceInputSource("host.resource_uri")).toBe(false);
});

test("the install-envelope v3 wire contract names Legacy provenance explicitly", () => {
  expect(TAKOFORM_INSTALL_ENVELOPE_SET_FORMAT).toBe(
    "takosumi.takoform-install-envelope-set@v3",
  );
  expect(TAKOFORM_INSTALL_ENVELOPE_SET_V3_KEYS).toContain(
    "historicalCheckpoint",
  );
  expect(TAKOFORM_INSTALL_ENVELOPE_SET_V3_KEYS).not.toContain("admission");
  expect(TAKOFORM_INSTALL_ENVELOPE_CHECKPOINT_V3_KEYS).toEqual([
    "root",
    "version",
    "tag",
    "commit",
    "tree",
  ]);
  expect(TAKOFORM_INSTALL_ENVELOPE_PIN_SET_V3_KEYS).toEqual([
    "checkpointVersion",
    "publishedTrust",
    "packageIndexPolicy",
    "trustedRoot",
  ]);
});
