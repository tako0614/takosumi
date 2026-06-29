package provider

import (
	"context"
	"testing"

	"github.com/hashicorp/terraform-plugin-framework/attr"
	fwresource "github.com/hashicorp/terraform-plugin-framework/resource"
	"github.com/hashicorp/terraform-plugin-framework/schema/validator"
	"github.com/hashicorp/terraform-plugin-framework/types"
	"github.com/hashicorp/terraform-plugin-framework/types/basetypes"

	"github.com/takosjp/terraform-provider-takosumi/internal/client"
)

func newInterfacesSet(t *testing.T, values ...string) types.Set {
	t.Helper()
	set, diags := types.SetValueFrom(context.Background(), types.StringType, values)
	if diags.HasError() {
		t.Fatalf("building interfaces set: %v", diags)
	}
	return set
}

func newLifecycle(t *testing.T, del string) types.Object {
	t.Helper()
	obj, diags := types.ObjectValue(lifecyclePolicyAttrTypes, map[string]attr.Value{
		"delete": types.StringValue(del),
	})
	if diags.HasError() {
		t.Fatalf("building lifecycle object: %v", diags)
	}
	return obj
}

func TestObjectStoreSchema(t *testing.T) {
	ctx := context.Background()
	r := NewObjectStoreResource()

	var resp fwresource.SchemaResponse
	r.Schema(ctx, fwresource.SchemaRequest{}, &resp)
	if resp.Diagnostics.HasError() {
		t.Fatalf("schema diagnostics: %v", resp.Diagnostics)
	}

	for _, name := range []string{
		"name", "interfaces", "lifecycle_policy", "space",
		"id", "selected_implementation", "target", "locked", "portability", "outputs",
	} {
		if _, ok := resp.Schema.Attributes[name]; !ok {
			t.Errorf("schema missing attribute %q", name)
		}
	}
}

func TestObjectStoreMetadataTypeName(t *testing.T) {
	ctx := context.Background()
	r := NewObjectStoreResource()
	var resp fwresource.MetadataResponse
	r.Metadata(ctx, fwresource.MetadataRequest{ProviderTypeName: "takosumi"}, &resp)
	if resp.TypeName != "takosumi_object_store" {
		t.Fatalf("unexpected type name %q", resp.TypeName)
	}
}

func TestToResource_BuildsEnvelope(t *testing.T) {
	ctx := context.Background()
	m := objectStoreModel{
		Name:            types.StringValue("assets"),
		Interfaces:      newInterfacesSet(t, "s3_api", "signed_url"),
		LifecyclePolicy: newLifecycle(t, "retain"),
		Space:           types.StringNull(),
	}

	res, space, diags := m.toResource(ctx, "prod")
	if diags.HasError() {
		t.Fatalf("toResource diagnostics: %v", diags)
	}
	if space != "prod" {
		t.Fatalf("expected default space prod, got %q", space)
	}
	if res.APIVersion != client.APIVersion || res.Kind != client.KindObjectStore {
		t.Fatalf("unexpected envelope head %#v", res)
	}
	if res.Metadata.ManagedBy != client.ManagedByOpenTofu {
		t.Errorf("expected managedBy=opentofu, got %q", res.Metadata.ManagedBy)
	}
	if res.Metadata.Space != "prod" {
		t.Errorf("expected metadata.space=prod, got %q", res.Metadata.Space)
	}
	if res.Spec["name"] != "assets" {
		t.Errorf("expected spec.name=assets, got %v", res.Spec["name"])
	}
	ifaces, ok := res.Spec["interfaces"].([]string)
	if !ok || len(ifaces) != 2 {
		t.Fatalf("expected 2 interfaces, got %#v", res.Spec["interfaces"])
	}
	lp, ok := res.Spec["lifecyclePolicy"].(map[string]any)
	if !ok || lp["delete"] != "retain" {
		t.Fatalf("expected lifecyclePolicy.delete=retain, got %#v", res.Spec["lifecyclePolicy"])
	}
}

func TestToResource_ResourceSpaceOverridesDefault(t *testing.T) {
	ctx := context.Background()
	m := objectStoreModel{
		Name:            types.StringValue("assets"),
		Interfaces:      newInterfacesSet(t, "s3_api"),
		LifecyclePolicy: types.ObjectNull(lifecyclePolicyAttrTypes),
		Space:           types.StringValue("staging"),
	}
	res, space, diags := m.toResource(ctx, "prod")
	if diags.HasError() {
		t.Fatalf("diagnostics: %v", diags)
	}
	if space != "staging" || res.Metadata.Space != "staging" {
		t.Fatalf("expected resource space override staging, got %q", space)
	}
	if _, ok := res.Spec["lifecyclePolicy"]; ok {
		t.Errorf("expected lifecyclePolicy omitted when unset")
	}
}

func TestToResource_MissingSpaceErrors(t *testing.T) {
	ctx := context.Background()
	m := objectStoreModel{
		Name:            types.StringValue("assets"),
		Interfaces:      newInterfacesSet(t, "s3_api"),
		LifecyclePolicy: types.ObjectNull(lifecyclePolicyAttrTypes),
		Space:           types.StringNull(),
	}
	_, _, diags := m.toResource(ctx, "")
	if !diags.HasError() {
		t.Fatalf("expected an error when no space is resolvable")
	}
}

func TestApplyStatus_MapsResolutionAndOutputs(t *testing.T) {
	ctx := context.Background()
	m := objectStoreModel{Name: types.StringValue("assets")}
	res := &client.Resource{
		Metadata: client.Metadata{Name: "assets", Space: "prod"},
		Status: &client.Status{
			Resolution: client.Resolution{
				SelectedImplementation: "cloudflare_r2",
				Target:                 "cloudflare-main",
				Locked:                 true,
				Portability:            "mostly_portable",
			},
			Outputs: map[string]any{"bucket": "assets-prod", "generation": float64(3)},
		},
	}

	diags := applyStatus(ctx, res, "prod", &m)
	if diags.HasError() {
		t.Fatalf("applyStatus diagnostics: %v", diags)
	}
	if m.SelectedImplementation.ValueString() != "cloudflare_r2" {
		t.Errorf("unexpected selected_implementation %q", m.SelectedImplementation.ValueString())
	}
	if m.Target.ValueString() != "cloudflare-main" {
		t.Errorf("unexpected target %q", m.Target.ValueString())
	}
	if !m.Locked.ValueBool() {
		t.Errorf("expected locked true")
	}
	if m.Portability.ValueString() != "mostly_portable" {
		t.Errorf("unexpected portability %q", m.Portability.ValueString())
	}
	outputs := map[string]string{}
	m.Outputs.ElementsAs(ctx, &outputs, false)
	if outputs["bucket"] != "assets-prod" {
		t.Errorf("unexpected outputs %#v", outputs)
	}
	if outputs["generation"] != "3" {
		t.Errorf("expected numeric output stringified, got %#v", outputs)
	}
	// id synthesized when server returns none.
	if m.ID.ValueString() != "tkrn:prod:ObjectStore:assets" {
		t.Errorf("unexpected synthesized id %q", m.ID.ValueString())
	}
}

func TestApplyStatus_ServerProvidedID(t *testing.T) {
	ctx := context.Background()
	m := objectStoreModel{Name: types.StringValue("assets")}
	res := &client.Resource{ID: "srv-id-123", Status: &client.Status{}}
	if diags := applyStatus(ctx, res, "prod", &m); diags.HasError() {
		t.Fatalf("diagnostics: %v", diags)
	}
	if m.ID.ValueString() != "srv-id-123" {
		t.Fatalf("expected server id to win, got %q", m.ID.ValueString())
	}
}

func TestApplyStatus_NilStatusIsKnown(t *testing.T) {
	ctx := context.Background()
	m := objectStoreModel{Name: types.StringValue("assets")}
	res := &client.Resource{Metadata: client.Metadata{Name: "assets"}}
	if diags := applyStatus(ctx, res, "prod", &m); diags.HasError() {
		t.Fatalf("diagnostics: %v", diags)
	}
	if m.SelectedImplementation.IsNull() || m.SelectedImplementation.IsUnknown() {
		t.Errorf("expected known empty selected_implementation")
	}
	if m.Outputs.IsNull() || m.Outputs.IsUnknown() {
		t.Errorf("expected known empty outputs map")
	}
}

func TestRefreshSpec_RoundTripsServerSpec(t *testing.T) {
	ctx := context.Background()
	m := objectStoreModel{}
	res := &client.Resource{
		Metadata: client.Metadata{Name: "assets", Space: "prod"},
		Spec: map[string]any{
			"name":            "assets",
			"interfaces":      []any{"s3_api", "object_events"},
			"lifecyclePolicy": map[string]any{"delete": "block"},
		},
	}
	if diags := refreshSpec(ctx, res, &m); diags.HasError() {
		t.Fatalf("refreshSpec diagnostics: %v", diags)
	}
	if m.Name.ValueString() != "assets" || m.Space.ValueString() != "prod" {
		t.Errorf("unexpected name/space %q/%q", m.Name.ValueString(), m.Space.ValueString())
	}
	var ifaces []string
	m.Interfaces.ElementsAs(ctx, &ifaces, false)
	if len(ifaces) != 2 {
		t.Errorf("expected 2 interfaces, got %#v", ifaces)
	}
	var lp lifecyclePolicyModel
	m.LifecyclePolicy.As(ctx, &lp, basetypes.ObjectAsOptions{})
	if lp.Delete.ValueString() != "block" {
		t.Errorf("unexpected lifecycle delete %q", lp.Delete.ValueString())
	}
}

func TestRefreshSpec_NoLifecycleBecomesNull(t *testing.T) {
	ctx := context.Background()
	m := objectStoreModel{LifecyclePolicy: newLifecycle(t, "retain")}
	res := &client.Resource{
		Metadata: client.Metadata{Name: "assets", Space: "prod"},
		Spec: map[string]any{
			"name":       "assets",
			"interfaces": []any{"s3_api"},
		},
	}
	if diags := refreshSpec(ctx, res, &m); diags.HasError() {
		t.Fatalf("diagnostics: %v", diags)
	}
	if !m.LifecyclePolicy.IsNull() {
		t.Errorf("expected lifecycle_policy to become null when absent server-side")
	}
}

func TestStringOneOfValidator(t *testing.T) {
	ctx := context.Background()
	v := StringOneOf(lifecycleDeleteActions...)

	t.Run("valid", func(t *testing.T) {
		req := validator.StringRequest{ConfigValue: types.StringValue("snapshot_then_delete")}
		var resp validator.StringResponse
		v.ValidateString(ctx, req, &resp)
		if resp.Diagnostics.HasError() {
			t.Fatalf("unexpected error: %v", resp.Diagnostics)
		}
	})

	t.Run("invalid", func(t *testing.T) {
		req := validator.StringRequest{ConfigValue: types.StringValue("nope")}
		var resp validator.StringResponse
		v.ValidateString(ctx, req, &resp)
		if !resp.Diagnostics.HasError() {
			t.Fatalf("expected error for invalid value")
		}
	})

	t.Run("null skipped", func(t *testing.T) {
		req := validator.StringRequest{ConfigValue: types.StringNull()}
		var resp validator.StringResponse
		v.ValidateString(ctx, req, &resp)
		if resp.Diagnostics.HasError() {
			t.Fatalf("null should be skipped: %v", resp.Diagnostics)
		}
	})
}

func TestSetStringsOneOfValidator(t *testing.T) {
	ctx := context.Background()
	v := SetStringsOneOf(1, objectStoreInterfaces...)

	t.Run("valid", func(t *testing.T) {
		set, _ := types.SetValueFrom(ctx, types.StringType, []string{"s3_api", "signed_url"})
		req := validator.SetRequest{ConfigValue: set}
		var resp validator.SetResponse
		v.ValidateSet(ctx, req, &resp)
		if resp.Diagnostics.HasError() {
			t.Fatalf("unexpected error: %v", resp.Diagnostics)
		}
	})

	t.Run("invalid element", func(t *testing.T) {
		set, _ := types.SetValueFrom(ctx, types.StringType, []string{"s3_api", "ftp"})
		req := validator.SetRequest{ConfigValue: set}
		var resp validator.SetResponse
		v.ValidateSet(ctx, req, &resp)
		if !resp.Diagnostics.HasError() {
			t.Fatalf("expected error for invalid element")
		}
	})

	t.Run("empty set fails min items", func(t *testing.T) {
		set, _ := types.SetValueFrom(ctx, types.StringType, []string{})
		req := validator.SetRequest{ConfigValue: set}
		var resp validator.SetResponse
		v.ValidateSet(ctx, req, &resp)
		if !resp.Diagnostics.HasError() {
			t.Fatalf("expected error for empty set")
		}
	})
}

func TestSetStringsNonEmptyValidator(t *testing.T) {
	ctx := context.Background()
	v := SetStringsNonEmpty(1)

	t.Run("valid custom token", func(t *testing.T) {
		set, _ := types.SetValueFrom(ctx, types.StringType, []string{"provider.deepseek"})
		req := validator.SetRequest{ConfigValue: set}
		var resp validator.SetResponse
		v.ValidateSet(ctx, req, &resp)
		if resp.Diagnostics.HasError() {
			t.Fatalf("unexpected error: %v", resp.Diagnostics)
		}
	})

	t.Run("blank token rejected", func(t *testing.T) {
		set, _ := types.SetValueFrom(ctx, types.StringType, []string{" "})
		req := validator.SetRequest{ConfigValue: set}
		var resp validator.SetResponse
		v.ValidateSet(ctx, req, &resp)
		if !resp.Diagnostics.HasError() {
			t.Fatalf("expected error for blank token")
		}
	})

	t.Run("whitespace token rejected", func(t *testing.T) {
		set, _ := types.SetValueFrom(ctx, types.StringType, []string{"bad token"})
		req := validator.SetRequest{ConfigValue: set}
		var resp validator.SetResponse
		v.ValidateSet(ctx, req, &resp)
		if !resp.Diagnostics.HasError() {
			t.Fatalf("expected error for whitespace token")
		}
	})
}

func TestToStringSlice(t *testing.T) {
	if got := toStringSlice([]any{"a", "b", 3}); len(got) != 2 {
		t.Fatalf("expected non-string dropped, got %#v", got)
	}
	if got := toStringSlice([]string{"a"}); len(got) != 1 {
		t.Fatalf("expected []string passthrough, got %#v", got)
	}
	if got := toStringSlice("nope"); got != nil {
		t.Fatalf("expected nil for unexpected type, got %#v", got)
	}
}
