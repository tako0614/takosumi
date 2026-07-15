package provider

import (
	"strings"

	"github.com/hashicorp/terraform-plugin-framework/diag"
	"github.com/hashicorp/terraform-plugin-framework/path"
	"github.com/hashicorp/terraform-plugin-framework/types"
)

// artifactSourceValues is the shared typed-provider projection of the immutable
// artifact contract used by EdgeWorker and DurableWorkflow.
type artifactSourceValues struct {
	Path   types.String
	URL    types.String
	Ref    types.String
	SHA256 types.String
}

func (v artifactSourceValues) toSpec(owner string) (map[string]any, diag.Diagnostics) {
	var diags diag.Diagnostics
	artifactPath := knownTrimmedString(v.Path)
	artifactURL := knownTrimmedString(v.URL)
	artifactRef := knownTrimmedString(v.Ref)
	artifactSHA256 := knownTrimmedString(v.SHA256)

	selected := 0
	for _, value := range []string{artifactPath, artifactURL, artifactRef} {
		if value != "" {
			selected++
		}
	}
	if selected != 1 {
		diags.AddAttributeError(
			path.Root("artifact_path"),
			"Invalid "+owner+" artifact source",
			"Set exactly one of artifact_path, artifact_url, or artifact_ref.",
		)
		return nil, diags
	}
	if artifactURL != "" && !strings.HasPrefix(artifactURL, "https://") {
		diags.AddAttributeError(
			path.Root("artifact_url"),
			"Invalid "+owner+" artifact URL",
			"artifact_url must be an https URL.",
		)
		return nil, diags
	}
	if (artifactURL != "" || artifactRef != "") && artifactSHA256 == "" {
		diags.AddAttributeError(
			path.Root("artifact_sha256"),
			"Missing "+owner+" artifact digest",
			"artifact_sha256 is required when artifact_url or artifact_ref is set.",
		)
		return nil, diags
	}
	if (artifactURL != "" || artifactRef != "") && !artifactSHA256Pattern.MatchString(artifactSHA256) {
		diags.AddAttributeError(
			path.Root("artifact_sha256"),
			"Invalid "+owner+" artifact digest",
			"artifact_sha256 must be a 64-character SHA-256 hex digest, optionally prefixed with sha256:.",
		)
		return nil, diags
	}

	source := map[string]any{}
	if artifactPath != "" {
		source["artifactPath"] = artifactPath
	}
	if artifactURL != "" {
		source["artifactUrl"] = artifactURL
		source["artifactSha256"] = artifactSHA256
	}
	if artifactRef != "" {
		source["artifactRef"] = artifactRef
		source["artifactSha256"] = artifactSHA256
	}
	return source, diags
}

func artifactSourceValuesFromSpec(raw any) artifactSourceValues {
	source, ok := raw.(map[string]any)
	if !ok {
		return nullArtifactSourceValues()
	}
	return artifactSourceValues{
		Path:   optionalStringFromAny(source["artifactPath"]),
		URL:    optionalStringFromAny(source["artifactUrl"]),
		Ref:    optionalStringFromAny(source["artifactRef"]),
		SHA256: optionalStringFromAny(source["artifactSha256"]),
	}
}

func nullArtifactSourceValues() artifactSourceValues {
	return artifactSourceValues{
		Path: types.StringNull(), URL: types.StringNull(),
		Ref: types.StringNull(), SHA256: types.StringNull(),
	}
}

func knownTrimmedString(value types.String) string {
	if value.IsNull() || value.IsUnknown() {
		return ""
	}
	return strings.TrimSpace(value.ValueString())
}

func optionalStringFromAny(value any) types.String {
	if text, ok := value.(string); ok && text != "" {
		return types.StringValue(text)
	}
	return types.StringNull()
}
