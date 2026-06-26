/**
 * ObjectAddress: canonical `<namespace>:<encoded-name>` segment grammar used by
 * the deploy-control reference helpers (resources, runtime, provider adapters).
 *
 * Relocated from the retired `takosumi-v1.ts` reference umbrella; this is the
 * single home for the ObjectAddress primitive and its validators.
 */

export type ObjectAddress = string;

const OBJECT_ADDRESS_NAMESPACE_PATTERN = /^[a-z][a-z0-9.-]*$/;
const OBJECT_ADDRESS_ENCODED_NAME_PATTERN =
  /^(?:[A-Za-z0-9_.!~*'()-]|%[0-9A-Fa-f]{2})+$/;

export function encodeObjectAddressName(name: string): string {
  if (name.length === 0) {
    throw new TypeError("ObjectAddress name must not be empty");
  }
  return encodeURIComponent(name);
}

export function objectAddressSegment(
  namespace: string,
  name: string,
): string {
  if (!OBJECT_ADDRESS_NAMESPACE_PATTERN.test(namespace)) {
    throw new TypeError(`Invalid ObjectAddress namespace: ${namespace}`);
  }
  return `${namespace}:${encodeObjectAddressName(name)}`;
}

export function joinObjectAddressSegments(
  ...segments: readonly string[]
): ObjectAddress {
  const address = segments.join("/");
  assertObjectAddress(address);
  return address;
}

export function objectAddress(namespace: string, name: string): ObjectAddress {
  return joinObjectAddressSegments(objectAddressSegment(namespace, name));
}

export function isObjectAddress(value: unknown): value is ObjectAddress {
  if (typeof value !== "string") return false;
  return validateObjectAddress(value) === undefined;
}

export function assertObjectAddress(
  value: string,
): asserts value is ObjectAddress {
  const error = validateObjectAddress(value);
  if (error) throw new TypeError(error);
}

function validateObjectAddress(value: string): string | undefined {
  if (value.length === 0) return "ObjectAddress must not be empty";
  for (const segment of value.split("/")) {
    const index = segment.indexOf(":");
    if (index <= 0 || index === segment.length - 1) {
      return `Invalid ObjectAddress segment: ${segment}`;
    }
    const namespace = segment.slice(0, index);
    const encodedName = segment.slice(index + 1);
    if (!OBJECT_ADDRESS_NAMESPACE_PATTERN.test(namespace)) {
      return `Invalid ObjectAddress namespace: ${namespace}`;
    }
    if (
      !OBJECT_ADDRESS_ENCODED_NAME_PATTERN.test(encodedName) ||
      encodedName.includes("/")
    ) {
      return `Invalid ObjectAddress encoded name: ${encodedName}`;
    }
    try {
      decodeURIComponent(encodedName);
    } catch {
      return `Invalid ObjectAddress percent encoding: ${encodedName}`;
    }
  }
  return undefined;
}
