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
		"provider.deepseek",
	})
	if diags.HasError() {
		t.Fatalf("profiles diagnostics: %v", diags)
	}
	providerPreferences, diags := types.SetValueFrom(ctx, types.StringType, []string{
		"provider.deepseek",
		"provider.gemini",
	})
	if diags.HasError() {
		t.Fatalf("providerPreferences diagnostics: %v", diags)
	}
	preferredRegions, diags := types.SetValueFrom(ctx, types.StringType, []string{
		"jp",
		"us",
	})
	if diags.HasError() {
		t.Fatalf("preferredRegions diagnostics: %v", diags)
	}
	routingPolicy, diags := types.ObjectValue(aiEndpointRoutingPolicyAttrTypes, map[string]attr.Value{
		"strategy":          types.StringValue("lowest_latency"),
		"allow_fallback":    types.BoolValue(true),
		"preferred_regions": preferredRegions,
	})
	if diags.HasError() {
		t.Fatalf("routingPolicy diagnostics: %v", diags)
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
		Name:                types.StringValue("ai"),
		Interfaces:          interfaces,
		Profiles:            profiles,
		ProviderPreferences: providerPreferences,
		RoutingPolicy:       routingPolicy,
		ModelPolicy:         modelPolicy,
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
	gotProfiles, ok := res.Spec["profiles"].([]string)
	if !ok {
		t.Fatalf("expected profiles []string, got %#v", res.Spec["profiles"])
	}
	if len(gotProfiles) != 2 || gotProfiles[1] != "provider.deepseek" {
		t.Fatalf("expected custom AI profile to pass through, got %#v", gotProfiles)
	}
	gotPreferences, ok := res.Spec["providerPreferences"].([]string)
	if !ok {
		t.Fatalf("expected providerPreferences []string, got %#v", res.Spec["providerPreferences"])
	}
	if len(gotPreferences) != 2 || gotPreferences[1] != "provider.gemini" {
		t.Fatalf("expected AI provider preferences to pass through, got %#v", gotPreferences)
	}
	gotRouting, ok := res.Spec["routingPolicy"].(map[string]any)
	if !ok {
		t.Fatalf("expected routingPolicy map, got %#v", res.Spec["routingPolicy"])
	}
	if gotRouting["strategy"] != "lowest_latency" || gotRouting["allowFallback"] != true {
		t.Fatalf("unexpected routingPolicy %#v", gotRouting)
	}
	gotRegions, ok := gotRouting["preferredRegions"].([]string)
	if !ok || len(gotRegions) != 2 || gotRegions[0] != "jp" {
		t.Fatalf("expected preferredRegions []string, got %#v", gotRouting["preferredRegions"])
	}
}
