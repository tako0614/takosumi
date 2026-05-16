export interface Pkg {
  readonly name: string;
  readonly role: string;
  readonly plane: "contract" | "control" | "data" | "client";
}

export const PACKAGES: readonly Pkg[] = [
  {
    name: "@takos/takosumi-contract",
    role: "Shape / Provider / Template の型契約",
    plane: "contract",
  },
  {
    name: "@takos/takosumi-kernel",
    role: "HTTP server + apply pipeline + state DB + worker daemon",
    plane: "control",
  },
  {
    name: "@takos/takosumi-plugins",
    role: "shape catalog + provider plugins + factories",
    plane: "control",
  },
  {
    name: "@takos/takosumi-runtime-agent",
    role: "cloud SDK / OS executor (data plane)",
    plane: "data",
  },
  {
    name: "@takos/takosumi-cli",
    role: "takosumi deploy / takosumi server 等の CLI",
    plane: "client",
  },
  {
    name: "@takos/takosumi",
    role: "umbrella: 上記 5 つを再公開",
    plane: "client",
  },
];
