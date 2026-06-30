package provider

import (
	"context"
	"testing"

	"github.com/hashicorp/terraform-plugin-framework/types"
)

func TestServiceShapeToResourceCarriesTargetPoolName(t *testing.T) {
	model := serviceShapeModel{
		Name:       types.StringValue("assets"),
		TargetPool: types.StringValue("storage"),
	}

	resource, space, diags := model.toResource(
		context.Background(),
		"prod",
		"ObjectBucket",
		specObjectBucket,
	)
	if diags.HasError() {
		t.Fatalf("toResource diagnostics: %v", diags)
	}
	if space != "prod" {
		t.Fatalf("expected prod space, got %q", space)
	}
	if resource.TargetPoolName != "storage" {
		t.Fatalf("expected targetPoolName to be carried, got %#v", resource)
	}
}
