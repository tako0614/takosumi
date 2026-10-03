const exactMissingDockerInspectReferences = new WeakMap<Error, string>();

const MISSING_REFERENCE_LINE =
  /^(?:error response from daemon:\s*)?(?:error:\s*)?no such (?:object|container): ([a-z0-9][a-z0-9_.-]{0,127})$/iu;

/** Create a safe command failure without retaining stderr or exposing arguments. */
export function createDockerCommandFailure(
  argv: readonly string[],
  exitCode: number,
  stderr: string,
  options: {
    readonly timedOut?: boolean;
    readonly killed?: boolean;
    readonly signal?: string | null;
  } = {},
): Error {
  const failure = new Error(`${argv[0] ?? "command"} exited ${exitCode}; stderr bytes=${stderr.length}`);
  const reference = argv.at(-1);
  if (
    !options.timedOut &&
    !options.killed &&
    !options.signal &&
    Number.isSafeInteger(exitCode) &&
    exitCode > 0 &&
    argv[0] === "docker" &&
    argv[1] === "inspect" &&
    argv.length === 5 &&
    argv[2] === "--format" &&
    typeof reference === "string" &&
    /^[a-z0-9][a-z0-9_.-]{0,127}$/iu.test(reference)
  ) {
    const match = MISSING_REFERENCE_LINE.exec(stderr.trim());
    if (match?.[1] === reference) {
      exactMissingDockerInspectReferences.set(failure, reference);
    }
  }
  return failure;
}

/** Returns true only for the exact target carried by a verified inspect failure. */
export function isExactDockerInspectNotFound(error: unknown, reference: string): boolean {
  return error instanceof Error &&
    exactMissingDockerInspectReferences.get(error) === reference;
}
