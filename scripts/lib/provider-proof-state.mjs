export function assertProviderStateIdentity({
  state,
  resourceAddress,
  providerAddress,
  expectedValues = {},
  label,
}) {
  const resource = state.values?.root_module?.resources?.find(
    (entry) => entry.address === resourceAddress,
  );
  if (resource?.provider_name !== providerAddress) {
    throw new Error(`${label} did not retain provider FQN ${providerAddress}`);
  }
  for (const [name, expected] of Object.entries(expectedValues)) {
    if (resource.values?.[name] !== expected) {
      throw new Error(`${label} did not retain expected ${name}`);
    }
  }
}
