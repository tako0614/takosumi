import { expect, test } from "bun:test";

import {
  installProfileIdForTemplate,
  officialInstallProfiles,
} from "./install_profile_seed.ts";
import { defaultTemplateRegistry } from "../templates/mod.ts";

test("officialInstallProfiles seeds one profile per catalog template", () => {
  const profiles = officialInstallProfiles({
    now: () => new Date("2026-06-06T00:00:00.000Z"),
  });
  const templates = defaultTemplateRegistry.list();
  expect(profiles.length).toBe(templates.length);
  for (const profile of profiles) {
    expect(profile.trustLevel).toBe("official");
    expect(profile.installType).toBe("opentofu_module");
    expect(profile.templateBinding).toBeDefined();
  }
});

test("each seeded profile id is stable and template-derived", () => {
  for (const template of defaultTemplateRegistry.list()) {
    const expected = installProfileIdForTemplate(
      template.id,
      template.version,
    );
    const profile = officialInstallProfiles().find(
      (p) => p.templateBinding?.templateId === template.id,
    );
    expect(profile?.id).toBe(expected);
  }
});

test("seeded profile output allowlist mirrors the template public outputs", () => {
  const template = defaultTemplateRegistry.list()[0];
  const profile = officialInstallProfiles().find(
    (p) => p.templateBinding?.templateId === template.id,
  );
  for (const [name, spec] of Object.entries(template.outputs.public)) {
    expect(profile?.outputAllowlist[name]?.from).toBe(spec.from);
  }
});
