// takos-secret-scan: synthetic — lexical canaries only, never generated key material.
interface CredentialSpanFixture {
  readonly name: string;
  readonly input: string;
  readonly sensitive: readonly string[];
  readonly suffix: string;
}

const canary = "CREDENTIAL_SPAN_CANARY";
const suffix = "\nsafe: visible";
const block = (name: string, input: string): CredentialSpanFixture => ({
  name,
  input: input + suffix,
  sensitive: [canary],
  suffix,
});

// The age fixture exercises the bounded lexical shape, not checksum validation.
const syntheticAgeIdentity = `AGE-SECRET-KEY-1${"Q".repeat(58)}`;

export const credentialSpanFixtures: readonly CredentialSpanFixture[] = [
  ...["|", ">-", "|+2", ">2-", "| # block comment", ">- # block comment",
    "&value | # anchor", "!!str >-", "!<tag:yaml.org,2002:str> |2-"].map(
    (header) => block(`YAML ${header}`, `password: ${header}\n  ${canary}`),
  ),
  block("YAML maximum explicit indentation", `password: |9+\n         ${canary}`),
  block("YAML nested mapping", `nested:\n  password: >-\n    ${canary}`),
  block("YAML double-quoted key", `"password": |\n  ${canary}`),
  block("YAML single-quoted key", `'password': |\n  ${canary}`),
  block("YAML nested single-quoted key", `nested:\n  'password': >-\n    ${canary}`),
  {
    name: "YAML nested CR-only",
    input: `nested:\r  password: |\r    ${canary}\rsafe: visible`,
    sensitive: [canary],
    suffix: "\rsafe: visible",
  },
  {
    name: "YAML sequence mapping",
    input: `items:\n  - password: |2-\n      ${canary}\n    safe: visible`,
    sensitive: [canary],
    suffix: "\n    safe: visible",
  },
  {
    name: "YAML compact nested sequence",
    input: `items:\n  - - password: |\n        ${canary}\n      safe: visible`,
    sensitive: [canary],
    suffix: "\n      safe: visible",
  },
  {
    name: "YAML CRLF and empty lines",
    input: `password: |+ # comment\r\n\r\n  ${canary}\r\n  \r\nsafe: visible`,
    sensitive: [canary],
    suffix: "\r\nsafe: visible",
  },
  block("shell odd terminal backslash", `PASSWORD=first-${canary}\\\n  second-${canary}`),
  block("shell three terminal backslashes", `PASSWORD=first-${canary}${"\\".repeat(3)}\n  second-${canary}`),
  block("shell auth assignment", `auth=first-${canary}\\\nsecond-${canary}`),
  block("shell authorization assignment", `Authorization=first-${canary}\\\nsecond-${canary}`),
  {
    name: "shell CRLF logical continuation",
    input: `PASSWORD=first-${canary}\\\r\n  second-${canary}\r\nsafe: visible`,
    sensitive: [canary],
    suffix: "\r\nsafe: visible",
  },
  {
    name: "shell CR-only diagnostic continuation",
    input: `PASSWORD=first-${canary}\\\rsecond-${canary}\rsafe: visible`,
    sensitive: [canary],
    suffix: "\rsafe: visible",
  },
  block("shell mixed physical line breaks", `PASSWORD=first-${canary}\\\rsecond-${canary}\\\nthird-${canary}\\\r\nlast-${canary}`),
  block("PGP private block", `-----BEGIN PGP PRIVATE KEY BLOCK-----\n${canary}\n-----END PGP PRIVATE KEY BLOCK-----`),
  block("inline PGP private block", `message: -----BEGIN PGP PRIVATE KEY BLOCK-----\n${canary}\n-----END PGP PRIVATE KEY BLOCK-----`),
  block("JSON PGP private block", JSON.stringify({ message: `-----BEGIN PGP PRIVATE KEY BLOCK-----\n${canary}\n-----END PGP PRIVATE KEY BLOCK-----` })),
  block("SSH2 encrypted private block", `---- BEGIN SSH2 ENCRYPTED PRIVATE KEY ----\n${canary}\n---- END SSH2 ENCRYPTED PRIVATE KEY ----`),
  block("inline SSH2 encrypted private block", `message: ---- BEGIN SSH2 ENCRYPTED PRIVATE KEY ----\n${canary}\n---- END SSH2 ENCRYPTED PRIVATE KEY ----`),
  block("JSON SSH2 encrypted private block", JSON.stringify({ message: `---- BEGIN SSH2 ENCRYPTED PRIVATE KEY ----\n${canary}\n---- END SSH2 ENCRYPTED PRIVATE KEY ----` })),
  ...[2, 3].flatMap((version) => {
    const input = [
      `PuTTY-User-Key-File-${version}: ssh-ed25519`,
      "Encryption: none",
      `Comment: ${canary}`,
      "Public-Lines: 1",
      "U1lOVEhFVElDX1BVQkxJQw==",
      "Private-Lines: 1",
      "U1lOVEhFVElDX1BSSVZBVEU=",
      `Private-MAC: ${"a".repeat(version === 2 ? 40 : 64)}`,
    ].join("\n");
    return [
      block(`PuTTY version ${version}`, input),
      {
        name: `PuTTY version ${version} CR-only`,
        input: input.replaceAll("\n", "\r") + "\rsafe: visible",
        sensitive: [canary],
        suffix: "\rsafe: visible",
      },
    ];
  }),
  {
    name: "age X25519 lexical identity",
    input: `identity: ${syntheticAgeIdentity}${suffix}`,
    sensitive: [syntheticAgeIdentity],
    suffix,
  },
];

export const credentialProseFixtures = [
  "The phrase 'password': | is only a syntax example.",
  "The ---- BEGIN SSH2 ENCRYPTED PRIVATE KEY ---- marker introduces a private block.",
  "The -----BEGIN PGP PRIVATE KEY BLOCK----- marker introduces a private block.",
  "PuTTY-User-Key-File-3: is a format marker described by the manual.",
  "-----BEGIN PGP PUBLIC KEY BLOCK-----\nPUBLIC_CANARY\n-----END PGP PUBLIC KEY BLOCK-----",
  "---- BEGIN SSH2 PUBLIC KEY ----\nPUBLIC_CANARY\n---- END SSH2 PUBLIC KEY ----",
  `age1${"q".repeat(58)}`,
  "AGE-SECRET-KEY-1SHORT",
  `AGE-SECRET-KEY-1${"Q".repeat(57)}B`,
  `${syntheticAgeIdentity}Q`,
];
