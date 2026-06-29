package provider

import (
	"context"
	"testing"

	"github.com/hashicorp/terraform-plugin-framework/attr"
	"github.com/hashicorp/terraform-plugin-framework/types"
)

func TestTargetPoolModelToSpecAcceptsAdminDefinedAIProviders(t *testing.T) {
	ctx := context.Background()
	interfaces, diags := types.MapValue(types.StringType, map[string]attr.Value{
		"openai_chat_completions":      types.StringValue("native"),
		"openai_embeddings":            types.StringValue("shim"),
		"vendor.deepseek.responses.v1": types.StringValue("native"),
	})
	if diags.HasError() {
		t.Fatalf("interfaces diagnostics: %v", diags)
	}
	implementation, diags := types.ObjectValue(targetPoolImplementationAttrTypes, map[string]attr.Value{
		"shape":                types.StringValue("AIEndpoint"),
		"implementation":       types.StringValue("deepseek_openai_gateway"),
		"native_resource_type": types.StringValue("ai.deepseek_endpoint"),
		"plugin":               types.StringValue("deepseek-plugin"),
		"options_json":         types.StringValue(`{"basePath":"/v1"}`),
		"interfaces":           interfaces,
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
		"name":           types.StringValue("deepseek-main"),
		"type":           types.StringValue("ai_provider"),
		"ref":            types.StringValue("https://api.deepseek.example/v1"),
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

	model := targetPoolModel{
		Name:    types.StringValue("default"),
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
	gotTarget := spec.Targets[0]
	if gotTarget.Type != "ai_provider" || gotTarget.Name != "deepseek-main" {
		t.Fatalf("unexpected target %#v", gotTarget)
	}
	if len(gotTarget.Implementations) != 1 {
		t.Fatalf("expected one implementation, got %#v", gotTarget.Implementations)
	}
	gotImplementation := gotTarget.Implementations[0]
	if gotImplementation.Implementation != "deepseek_openai_gateway" {
		t.Fatalf("expected custom implementation to pass through, got %#v", gotImplementation)
	}
	if gotImplementation.Interfaces["vendor.deepseek.responses.v1"] != "native" {
		t.Fatalf("expected custom AI interface capability, got %#v", gotImplementation.Interfaces)
	}
	if gotImplementation.Plugin != "deepseek-plugin" {
		t.Fatalf("expected plugin to pass through, got %#v", gotImplementation)
	}
	if gotImplementation.Options["basePath"] != "/v1" {
		t.Fatalf("expected options_json to pass through, got %#v", gotImplementation.Options)
	}
}

func TestTargetPoolModelToSpecRejectsInvalidCapabilityLevel(t *testing.T) {
	ctx := context.Background()
	interfaces, diags := types.MapValue(types.StringType, map[string]attr.Value{
		"openai_chat_completions": types.StringValue("maybe"),
	})
	if diags.HasError() {
		t.Fatalf("interfaces diagnostics: %v", diags)
	}
	implementation, diags := types.ObjectValue(targetPoolImplementationAttrTypes, map[string]attr.Value{
		"shape":                types.StringValue("AIEndpoint"),
		"implementation":       types.StringValue("custom_ai"),
		"native_resource_type": types.StringNull(),
		"plugin":               types.StringNull(),
		"options_json":         types.StringNull(),
		"interfaces":           interfaces,
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
		"name":           types.StringValue("custom-ai"),
		"type":           types.StringValue("ai_provider"),
		"ref":            types.StringNull(),
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
