import process from "node:process";

export function joinPath(first: string, ...rest: readonly string[]): string {
  let output = first.replace(/\/+$/, "");
  for (const segment of rest) {
    const normalized = segment.replace(/^\/+|\/+$/g, "");
    if (!normalized) continue;
    output = output ? `${output}/${normalized}` : normalized;
  }
  return output || ".";
}

export function parentPath(path: string): string {
  const normalized = path.replace(/\/+$/g, "");
  const index = normalized.lastIndexOf("/");
  return index <= 0 ? "." : normalized.slice(0, index);
}

export function absolutePath(path: string): string {
  if (!path.startsWith("/")) return joinPath(process.cwd(), path);
  return path.replace(/\/+$/g, "") || "/";
}
