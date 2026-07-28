export interface GeneratedAssetWiring {
  readonly canonicalCheck: string;
  readonly generatedAssetCheck: string;
  readonly generatedAssetWrite: string;
}

export const DEFAULT_GENERATED_ASSET_WIRING: GeneratedAssetWiring = {
  canonicalCheck: "check",
  generatedAssetCheck: "generated-assets:check",
  generatedAssetWrite: "generated-assets:write",
};

const ASSET_SCRIPT_SUFFIX = ":assets";
const CHECK_SCRIPT_SUFFIX = ":check";
const BUN_RUN_SCRIPT = /\bbun\s+run\s+([A-Za-z0-9:_-]+)/g;

export function validateGeneratedAssetScriptWiring(
  scripts: Readonly<Record<string, string>>,
  wiring: GeneratedAssetWiring = DEFAULT_GENERATED_ASSET_WIRING,
): readonly string[] {
  const errors: string[] = [];
  const assetScripts = Object.keys(scripts)
    .filter((name) => name.endsWith(ASSET_SCRIPT_SUFFIX))
    .sort();

  for (const required of [
    wiring.canonicalCheck,
    wiring.generatedAssetCheck,
    wiring.generatedAssetWrite,
  ]) {
    if (typeof scripts[required] !== "string") {
      errors.push(`package script '${required}' is required`);
    }
  }
  if (errors.length > 0) return errors;

  const canonicalReachable = reachableScripts(scripts, wiring.canonicalCheck);
  const generatedCheckReachable = reachableScripts(
    scripts,
    wiring.generatedAssetCheck,
  );
  const generatedWriteReachable = reachableScripts(
    scripts,
    wiring.generatedAssetWrite,
  );

  if (!canonicalReachable.has(wiring.generatedAssetCheck)) {
    errors.push(
      `'${wiring.canonicalCheck}' must invoke '${wiring.generatedAssetCheck}'`,
    );
  }

  for (const assetScript of assetScripts) {
    const checkScript =
      assetScript.slice(0, -ASSET_SCRIPT_SUFFIX.length) + CHECK_SCRIPT_SUFFIX;
    if (typeof scripts[checkScript] !== "string") {
      errors.push(
        `generated asset writer '${assetScript}' requires check-only script '${checkScript}'`,
      );
      continue;
    }
    if (!generatedCheckReachable.has(checkScript)) {
      errors.push(
        `'${wiring.generatedAssetCheck}' must invoke '${checkScript}'`,
      );
    }
    if (!generatedWriteReachable.has(assetScript)) {
      errors.push(
        `'${wiring.generatedAssetWrite}' must invoke '${assetScript}'`,
      );
    }
  }

  for (const script of canonicalReachable) {
    if (script.endsWith(ASSET_SCRIPT_SUFFIX)) {
      errors.push(
        `'${wiring.canonicalCheck}' reaches generated asset writer '${script}'; checks must be read-only`,
      );
    }
  }

  return errors;
}

function reachableScripts(
  scripts: Readonly<Record<string, string>>,
  start: string,
): ReadonlySet<string> {
  const reachable = new Set<string>();
  const pending = [start];

  while (pending.length > 0) {
    const script = pending.pop();
    if (!script || reachable.has(script)) continue;
    reachable.add(script);
    for (const dependency of scriptDependencies(scripts[script] ?? "")) {
      if (typeof scripts[dependency] === "string") pending.push(dependency);
    }
  }

  return reachable;
}

function scriptDependencies(command: string): readonly string[] {
  return Array.from(
    command.matchAll(BUN_RUN_SCRIPT),
    (match) => match[1],
  ).filter((name): name is string => Boolean(name));
}
