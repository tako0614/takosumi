/**
 * Materialize permission digest helpers.
 *
 * The materialize endpoint requires `confirm.permissionDigest` to byte-match a
 * digest the server recomputes from the request. To eliminate any drift, the
 * canonical-JSON encoder, the sha256 hex helper, and the materialize-digest
 * builder all live in the accounts contract — the server verifies the request
 * against the same `takosumiAccountsInstallationMaterializeDigest`. This module
 * just re-exports them for the account-plane view code.
 */
export {
  canonicalJson,
  sha256HexText,
  takosumiAccountsInstallationMaterializeDigest as materializeInstallationDigest,
} from "@takosjp/takosumi-accounts-contract";
