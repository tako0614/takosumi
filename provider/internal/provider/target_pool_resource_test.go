package provider

import (
	"context"
	"testing"

	"github.com/hashicorp/terraform-plugin-framework/attr"
	"github.com/hashicorp/terraform-plugin-framework/types"
)

func TestTargetPoolModelToSpecAcceptsAdminDefinedImplementations(t *testing.T) {
	ctx := context.Background()
	interfaces, diags := types.MapValue(types.StringType, map[string]attr.Value{
		"oci_container": types.StringValue("native"),
		"public_http":   types.StringValue("shim"),
		"custom.mesh":   types.StringValue("native"),
	})
	if diags.HasError() {
		t.Fatalf("interfaces diagnostics: %v", diags)
	}
	implementation, diags := types.ObjectValue(targetPoolImplementationAttrTypes, map[string]attr.Value{
		"shape":                      types.StringValue("ContainerService"),
		"implementation":             types.StringValue("custom_container_runtime"),
		"native_resource_type":       types.StringValue("custom.container_service"),
		"plugin":                     types.StringValue("container-plugin"),
		"provider_source":            types.StringNull(),
		"provider_alias":             types.StringNull(),
		"provider_config_json":       types.StringNull(),
		"module_template":            types.StringNull(),
		"module_input_mappings_json": types.StringNull(),
		"module_outputs_json":        types.StringNull(),
		"options_json":               types.StringValue(`{"runtimeClass":"edge"}`),
		"interfaces":                 interfaces,
	})
	if diags.HasError() {
		t.Fatalf("implementation diagnostics: %v", diags)
	}
	implementations, diags := types.ListValue(
		types.ObjectType{AttrTypes: targetPoolImplementationAttrTypes},
		[]attr.Value{implementation},
	)
	if diags.HasError() {
		t.Fatalf("implementations diagnostics: %v", diags)
	}
	target, diags := types.ObjectValue(targetPoolTargetAttrTypes, map[string]attr.Value{
		"name":           types.StringValue("containers-main"),
		"type":           types.StringValue("kubernetes"),
		"ref":            types.StringValue("cluster-prod"),
		"credential_ref": types.StringValue("conn_k8s_prod"),
		"region":         types.StringValue("jp"),
		"priority":       types.Int64Value(90),
		"implementation": implementations,
	})
	if diags.HasError() {
		t.Fatalf("target diagnostics: %v", diags)
	}
	targets, diags := types.ListValue(
		types.ObjectType{AttrTypes: targetPoolTargetAttrTypes},
		[]attr.Value{target},
	)
	if diags.HasError() {
		t.Fatalf("targets diagnostics: %v", diags)
	}
	classes, diags := types.SetValue(types.StringType, []attr.Value{
		types.StringValue("edge.container"),
	})
	if diags.HasError() {
		t.Fatalf("classes diagnostics: %v", diags)
	}

	model := targetPoolModel{
		Name:    types.StringValue("default"),
		Classes: classes,
		Targets: targets,
	}
	space, spec, gotDiags := model.toSpec(ctx, "prod")
	if gotDiags.HasError() {
		t.Fatalf("toSpec diagnostics: %v", gotDiags)
	}
	if space != "prod" {
		t.Fatalf("expected prod space, got %q", space)
	}
	if len(spec.Targets) != 1 {
		t.Fatalf("expected one target, got %#v", spec.Targets)
	}
	if len(spec.Classes) != 1 || spec.Classes[0] != "edge.container" {
		t.Fatalf("expected placement classes to pass through, got %#v", spec.Classes)
	}
	gotTarget := spec.Targets[0]
	if gotTarget.Type != "kubernetes" || gotTarget.Name != "containers-main" {
		t.Fatalf("unexpected target %#v", gotTarget)
	}
	if gotTarget.Ref != "cluster-prod" || gotTarget.CredentialRef != "conn_k8s_prod" {
		t.Fatalf("expected ref and credential_ref to pass separately, got %#v", gotTarget)
	}
	if len(gotTarget.Implementations) != 1 {
		t.Fatalf("expected one implementation, got %#v", gotTarget.Implementations)
	}
	gotImplementation := gotTarget.Implementations[0]
	if gotImplementation.Implementation != "custom_container_runtime" {
		t.Fatalf("expected custom implementation to pass through, got %#v", gotImplementation)
	}
	if gotImplementation.Interfaces["custom.mesh"] != "native" {
		t.Fatalf("expected custom interface capability, got %#v", gotImplementation.Interfaces)
	}
	if gotImplementation.Plugin != "container-plugin" {
		t.Fatalf("expected plugin to pass through, got %#v", gotImplementation)
	}
	if gotImplementation.Options["runtimeClass"] != "edge" {
		t.Fatalf("expected options_json to pass through, got %#v", gotImplementation.Options)
	}
}

func TestTargetPoolModelToSpecRejectsInvalidCapabilityLevel(t *testing.T) {
	ctx := context.Background()
	interfaces, diags := types.MapValue(types.StringType, map[string]attr.Value{
		"oci_container": types.StringValue("maybe"),
	})
	if diags.HasError() {
		t.Fatalf("interfaces diagnostics: %v", diags)
	}
	implementation, diags := types.ObjectValue(targetPoolImplementationAttrTypes, map[string]attr.Value{
		"shape":                      types.StringValue("ContainerService"),
		"implementation":             types.StringValue("custom_container"),
		"native_resource_type":       types.StringNull(),
		"plugin":                     types.StringNull(),
		"provider_source":            types.StringValue("example/runtime"),
		"provider_alias":             types.StringNull(),
		"provider_config_json":       types.StringNull(),
		"module_template":            types.StringValue("example-runtime"),
		"module_input_mappings_json": types.StringValue(`{}`),
		"module_outputs_json":        types.StringValue(`[]`),
		"options_json":               types.StringNull(),
		"interfaces":                 interfaces,
	})
	if diags.HasError() {
		t.Fatalf("implementation diagnostics: %v", diags)
	}
	implementations, diags := types.ListValue(
		types.ObjectType{AttrTypes: targetPoolImplementationAttrTypes},
		[]attr.Value{implementation},
	)
	if diags.HasError() {
		t.Fatalf("implementations diagnostics: %v", diags)
	}
	target, diags := types.ObjectValue(targetPoolTargetAttrTypes, map[string]attr.Value{
		"name":           types.StringValue("custom-container"),
		"type":           types.StringValue("kubernetes"),
		"ref":            types.StringNull(),
		"credential_ref": types.StringNull(),
		"region":         types.StringNull(),
		"priority":       types.Int64Value(1),
		"implementation": implementations,
	})
	if diags.HasError() {
		t.Fatalf("target diagnostics: %v", diags)
	}
	targets, diags := types.ListValue(
		types.ObjectType{AttrTypes: targetPoolTargetAttrTypes},
		[]attr.Value{target},
	)
	if diags.HasError() {
		t.Fatalf("targets diagnostics: %v", diags)
	}

	model := targetPoolModel{
		Name:    types.StringValue("default"),
		Space:   types.StringValue("prod"),
		Targets: targets,
	}
	_, _, gotDiags := model.toSpec(ctx, "")
	if !gotDiags.HasError() {
		t.Fatalf("expected invalid capability level diagnostics")
	}
}
