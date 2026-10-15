/** Constructor provenance, private to owner code. An HTTP object or a
 * structural boolean method cannot claim that two stores share one database. */
const controls = new WeakMap<object, object>();
const principals = new WeakMap<object, object>();

export function registerIdentityControlStorage(store: object, database: object): void {
  const previous = controls.get(store);
  if (previous && previous !== database) throw new TypeError("Control storage identity cannot change");
  controls.set(store, database);
}

export function registerIdentityPrincipalStorage(store: object, database: object): void {
  const previous = principals.get(store);
  if (previous && previous !== database) throw new TypeError("Principal storage identity cannot change");
  principals.set(store, database);
}

export function identityReconciliationSharesPrincipalDatabase(control: object, bindings: object): boolean {
  const database = controls.get(control);
  return database !== undefined && principals.get(bindings) === database;
}
