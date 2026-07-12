import { expect, test } from "bun:test";
import {
  commandContextFromRequest,
  redactRunnerOutput,
} from "../../../runner/entrypoint.ts";

// Runner profile that requires a cloudflare credential ref by env://.
const CLOUDFLARE_PROFILE = {
  id: "opentofu-default",
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

test("generic-env provider payload credentials are admitted", () => {
  const prev = Bun.env.CLOUDFLARE_API_TOKEN;
  Bun.env.CLOUDFLARE_API_TOKEN = "ambient-env-token";
  try {
    const context = commandContextFromRequest(
      { ...REQUEST, credentials: { CLOUDFLARE_API_TOKEN: "payload-token" } },
      CLOUDFLARE_PROFILE,
    );
    expect(context.env.CLOUDFLARE_API_TOKEN).toBe("payload-token");
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

test("generic-env provider payload admits upper-snake env and rejects invalid names", () => {
  const prev = Bun.env.CLOUDFLARE_API_TOKEN;
  delete Bun.env.CLOUDFLARE_API_TOKEN;
  try {
    const context = commandContextFromRequest(
      {
        ...REQUEST,
        credentials: {
          CLOUDFLARE_API_TOKEN: "payload-token",
          // Another declared provider env supplied by the control plane payload.
          AWS_SECRET_ACCESS_KEY: "payload-aws-secret",
          // Invalid env-name shape; must be ignored.
          "lower-case": "nope",
        },
      },
      CLOUDFLARE_PROFILE,
    );
    expect(context.env.CLOUDFLARE_API_TOKEN).toBe("payload-token");
    expect(context.env.AWS_SECRET_ACCESS_KEY).toBe("payload-aws-secret");
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
  expect(context.env.CLOUDFLARE_API_TOKEN).toEqual("shared-token");
  expect(context.env.TF_VAR_cloudflare_main_api_token).toEqual(
    "per-alias-compute-token",
  );
  expect(context.env.TF_VAR_cloudflare_dns_api_token).toEqual(
    "per-alias-dns-token",
  );
});

test("payload credential values are exact-redaction values even when printed bare", () => {
  const runScopedToken = "opaque-run-scoped-token-1234567890";
  const gatewayRunKey = "run-key.2000000000.deadbeefcafebabefeedface";
  const context = commandContextFromRequest(
    {
      ...REQUEST,
      credentials: {
        TF_VAR_cloudflare_main_api_token: runScopedToken,
        TF_VAR_cloudflare_gateway_api_token: gatewayRunKey,
      },
    },
    CLOUDFLARE_PROFILE,
  );

  expect(context.redactionValues).toContain(runScopedToken);
  expect(context.redactionValues).toContain(gatewayRunKey);
  const redacted = redactRunnerOutput(
    `provider echoed ${runScopedToken} and ${gatewayRunKey} as bare values`,
    context.redactionValues,
  );
  expect(redacted).not.toContain(runScopedToken);
  expect(redacted).not.toContain(gatewayRunKey);
  expect(redacted).toContain("[redacted]");
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
