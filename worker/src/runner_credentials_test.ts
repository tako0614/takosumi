import { expect, test } from "bun:test";
import { commandContextFromRequest } from "../../runner/entrypoint.ts";

// Runner profile that requires a cloudflare credential ref by env://.
const CLOUDFLARE_PROFILE = {
  id: "cloudflare-default",
  allowedProviders: ["cloudflare/cloudflare"],
  credentialRefs: [
    {
      provider: "cloudflare/cloudflare",
      ref: "env://CLOUDFLARE_API_TOKEN",
      required: true,
    },
  ],
};

const REQUEST = {
  planRun: {
    requiredProviders: ["registry.opentofu.org/cloudflare/cloudflare"],
  },
};

test("shared provider env payload credentials are ignored", () => {
  const prev = Bun.env.CLOUDFLARE_API_TOKEN;
  Bun.env.CLOUDFLARE_API_TOKEN = "ambient-env-token";
  try {
    const context = commandContextFromRequest(
      { ...REQUEST, credentials: { CLOUDFLARE_API_TOKEN: "payload-token" } },
      CLOUDFLARE_PROFILE,
    );
    expect(context.env.CLOUDFLARE_API_TOKEN).toBeUndefined();
  } finally {
    restoreEnv("CLOUDFLARE_API_TOKEN", prev);
  }
});

test("does not fall back to Bun.env by default when the payload omits the credential", () => {
  const prev = Bun.env.CLOUDFLARE_API_TOKEN;
  Bun.env.CLOUDFLARE_API_TOKEN = "ambient-env-token";
  try {
    const context = commandContextFromRequest(REQUEST, CLOUDFLARE_PROFILE);
    expect(context.env.CLOUDFLARE_API_TOKEN).toBeUndefined();
  } finally {
    restoreEnv("CLOUDFLARE_API_TOKEN", prev);
  }
});

test("does not fall back to Bun.env even for a local-dev runner profile", () => {
  const prev = Bun.env.CLOUDFLARE_API_TOKEN;
  Bun.env.CLOUDFLARE_API_TOKEN = "ambient-env-token";
  try {
    const context = commandContextFromRequest(REQUEST, {
      ...CLOUDFLARE_PROFILE,
      devLocalAllowAmbientCredentials: true,
    });
    expect(context.env.CLOUDFLARE_API_TOKEN).toBeUndefined();
  } finally {
    restoreEnv("CLOUDFLARE_API_TOKEN", prev);
  }
});

test("shared provider env names are ignored from the payload", () => {
  const prev = Bun.env.CLOUDFLARE_API_TOKEN;
  delete Bun.env.CLOUDFLARE_API_TOKEN;
  try {
    const context = commandContextFromRequest(
      {
        ...REQUEST,
        credentials: {
          CLOUDFLARE_API_TOKEN: "payload-token",
          // Not a cloudflare env name; must be ignored.
          AWS_SECRET_ACCESS_KEY: "should-not-appear",
          // Invalid env-name shape; must be ignored.
          "lower-case": "nope",
        },
      },
      CLOUDFLARE_PROFILE,
    );
    expect(context.env.CLOUDFLARE_API_TOKEN).toBeUndefined();
    expect(context.env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expect(context.env["lower-case"]).toBeUndefined();
  } finally {
    restoreEnv("CLOUDFLARE_API_TOKEN", prev);
  }
});

// --- §13 per-alias credential split (TF_VAR_<provider>_<alias>_<arg>) ---

test("TF_VAR_ per-alias credentials from the payload are admitted into the tofu env", () => {
  const context = commandContextFromRequest(
    {
      ...REQUEST,
      credentials: {
        CLOUDFLARE_API_TOKEN: "shared-token",
        TF_VAR_cloudflare_main_api_token: "per-alias-compute-token",
        TF_VAR_cloudflare_dns_api_token: "per-alias-dns-token",
      },
    },
    CLOUDFLARE_PROFILE,
  );
  // The shared provider env is ignored; only generated-root TF_VAR credentials
  // are admitted.
  expect(context.env.CLOUDFLARE_API_TOKEN).toBeUndefined();
  expect(context.env.TF_VAR_cloudflare_main_api_token).toEqual(
    "per-alias-compute-token",
  );
  expect(context.env.TF_VAR_cloudflare_dns_api_token).toEqual(
    "per-alias-dns-token",
  );
});

test("TF_VAR_ per-alias credentials are sourced ONLY from the payload, never Bun.env", () => {
  const name = "TF_VAR_cloudflare_main_api_token";
  const prev = Bun.env[name];
  Bun.env[name] = "ambient-tf-var";
  try {
    // No credentials on the payload -> the ambient TF_VAR must NOT leak in.
    const context = commandContextFromRequest(REQUEST, CLOUDFLARE_PROFILE);
    expect(context.env[name]).toBeUndefined();
  } finally {
    restoreEnv(name, prev);
  }
});

test("a non-TF_VAR lowercase payload name is still rejected", () => {
  const context = commandContextFromRequest(
    {
      ...REQUEST,
      credentials: {
        // Not TF_VAR-prefixed and not upper-snake -> ignored.
        tf_var_sneaky: "nope",
        TF_VARsneaky: "nope-too",
      },
    },
    CLOUDFLARE_PROFILE,
  );
  expect(context.env.tf_var_sneaky).toBeUndefined();
  expect(context.env.TF_VARsneaky).toBeUndefined();
});

function restoreEnv(name: string, prev: string | undefined): void {
  if (prev === undefined) delete Bun.env[name];
  else Bun.env[name] = prev;
}
