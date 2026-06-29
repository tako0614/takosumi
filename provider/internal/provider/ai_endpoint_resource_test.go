package provider

import (
	"context"
	"testing"

	"github.com/hashicorp/terraform-plugin-framework/attr"
	"github.com/hashicorp/terraform-plugin-framework/types"

	"github.com/takosjp/terraform-provider-takosumi/internal/client"
)

func TestAIEndpointModelToResource(t *testing.T) {
	ctx := context.Background()
	interfaces, diags := types.SetValueFrom(ctx, types.StringType, []string{
		"openai_chat_completions",
		"openai_embeddings",
	})
	if diags.HasError() {
		t.Fatalf("interfaces diagnostics: %v", diags)
	}
	profiles, diags := types.SetValueFrom(ctx, types.StringType, []string{
		"openai_compatible",
	})
	if diags.HasError() {
		t.Fatalf("profiles diagnostics: %v", diags)
	}
	allowedModels, diags := types.SetValueFrom(ctx, types.StringType, []string{
		"fast/chat",
		"embed/text",
	})
	if diags.HasError() {
		t.Fatalf("allowedModels diagnostics: %v", diags)
	}
	modelPolicy, diags := types.ObjectValue(aiEndpointModelPolicyAttrTypes, map[string]attr.Value{
		"default_model":  types.StringValue("fast/chat"),
		"allowed_models": allowedModels,
	})
	if diags.HasError() {
		t.Fatalf("modelPolicy diagnostics: %v", diags)
	}

	model := aiEndpointModel{
		Name:        types.StringValue("ai"),
		Interfaces:  interfaces,
		Profiles:    profiles,
		ModelPolicy: modelPolicy,
	}
	res, space, gotDiags := model.toResource(ctx, "prod")
	if gotDiags.HasError() {
		t.Fatalf("toResource diagnostics: %v", gotDiags)
	}
	if space != "prod" {
		t.Fatalf("expected prod space, got %q", space)
	}
	if res.Kind != client.KindAIEndpoint {
		t.Fatalf("expected AIEndpoint kind, got %q", res.Kind)
	}
	if res.Spec["name"] != "ai" {
		t.Fatalf("expected name ai, got %#v", res.Spec["name"])
	}
	policy, ok := res.Spec["modelPolicy"].(map[string]any)
	if !ok {
		t.Fatalf("expected modelPolicy map, got %#v", res.Spec["modelPolicy"])
	}
	if policy["defaultModel"] != "fast/chat" {
		t.Fatalf("unexpected defaultModel %#v", policy["defaultModel"])
	}
}
