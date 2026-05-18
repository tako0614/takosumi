#!/usr/bin/env bash
# Regenerate installer-mock/fixtures/*.json from each bundled app's
# .takosumi.yml (AppSpec v1).
#
# The mock looks up these fixtures by git URL at request time, so the
# install wizard sees real changes[] / app id / commit instead of
# sha256-derived fake values. Re-run this when an app's .takosumi.yml
# changes, OR when the bundled-apps set changes.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SUBSTRATE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
ECOSYSTEM="$SUBSTRATE_DIR/../../.."
FIXTURE_DIR="$SUBSTRATE_DIR/installer-mock/fixtures"

# Map: git URL (basename) -> local checkout path
declare -A REPOS=(
	["yurucommu"]="$ECOSYSTEM/yurucommu"
	["takos-docs"]="$ECOSYSTEM/takos-apps/takos-docs"
	["takos-slide"]="$ECOSYSTEM/takos-apps/takos-slide"
	["takos-excel"]="$ECOSYSTEM/takos-apps/takos-excel"
	["takos-computer"]="$ECOSYSTEM/takos-apps/takos-computer"
)

mkdir -p "$FIXTURE_DIR"

for name in "${!REPOS[@]}"; do
	repo="${REPOS[$name]}"
	app_spec="$repo/.takosumi.yml"
	if [[ ! -f "$app_spec" ]]; then
		echo "skip $name: $app_spec not found"
		continue
	fi
	commit=$(git -C "$repo" rev-parse HEAD 2>/dev/null || echo "0000000000000000000000000000000000000000")
	digest=$(sha256sum "$app_spec" | head -c 64)
	python3 -c "
import json, sys, yaml
with open(sys.argv[1]) as fp:
    spec = yaml.safe_load(fp)
metadata = spec.get('metadata') or {}
app_id = metadata.get('id', 'unknown')
components = spec.get('components') or {}
changes = []
for cname, c in components.items():
    if not isinstance(c, dict): continue
    changes.append({
        'op': 'create',
        'component': cname,
        'kind': c.get('kind', ''),
    })
out = {
    'appId': app_id,
    'source': {
        'kind': 'git',
        'url': 'https://github.com/tako0614/' + sys.argv[3] + '.git',
        'ref': 'main',
        'commit': '$commit',
    },
    'manifestDigest': 'sha256:$digest',
    'changes': changes,
    'estimatedCost': {'currency': 'JPY', 'monthly': 0},
    'expected': {
        'commit': '$commit',
        'manifestDigest': 'sha256:$digest',
    },
    'metadata': {
        'fixture': True,
        'generatedAt': '$(date -u +%FT%TZ)',
        'fromAppSpec': sys.argv[1],
    },
}
out_path = sys.argv[2]
with open(out_path, 'w') as fp:
    json.dump(out, fp, indent=2, sort_keys=True)
print(f'wrote {out_path} ({len(changes)} changes)')
" "$app_spec" "$FIXTURE_DIR/$name.json" "$name"
done

echo "done."
