import { expect, test } from "bun:test";
import {
  formRefKey,
  installedFormReferenceKey,
  isFormRef,
  isSha256Digest,
  type FormRef,
} from "../../contract/service-forms.ts";

const schemaDigest = `sha256:${"a".repeat(64)}`;
const packageDigest = `sha256:${"b".repeat(64)}`;

const exactRef: FormRef = {
  apiVersion: "forms.takoform.com/v1alpha1",
  kind: "EdgeWorker",
  definitionVersion: "1.0.0",
  schemaDigest,
};

test("FormRef requires an exact immutable four-field identity", () => {
  expect(isFormRef(exactRef)).toBe(true);
  expect(isFormRef({ ...exactRef, definitionVersion: "latest" })).toBe(false);
  expect(isFormRef({ ...exactRef, schemaDigest: "sha256:placeholder" })).toBe(
    false,
  );
  expect(isFormRef({ ...exactRef, packageDigest })).toBe(false);
  expect(isFormRef({ ...exactRef, channel: "stable" })).toBe(false);
  expect(formRefKey(exactRef)).toContain("EdgeWorker");
});

test("packageDigest remains a sibling of FormRef", () => {
  expect(isSha256Digest(packageDigest)).toBe(true);
  expect(
    installedFormReferenceKey({ formRef: exactRef, packageDigest }),
  ).toEndWith(packageDigest);
});
