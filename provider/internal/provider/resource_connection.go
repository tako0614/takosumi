package provider

import (
	"context"
	"sort"

	"github.com/hashicorp/terraform-plugin-framework/attr"
	"github.com/hashicorp/terraform-plugin-framework/diag"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema"
	"github.com/hashicorp/terraform-plugin-framework/schema/validator"
	"github.com/hashicorp/terraform-plugin-framework/types"
)

var resourceConnectionAttrTypes = map[string]attr.Type{
	"name":        types.StringType,
	"resource":    types.StringType,
	"permissions": types.SetType{ElemType: types.StringType},
	"projection":  types.StringType,
}

type resourceConnectionModel struct {
	Name        types.String `tfsdk:"name"`
	Resource    types.String `tfsdk:"resource"`
	Permissions types.Set    `tfsdk:"permissions"`
	Projection  types.String `tfsdk:"projection"`
}

func resourceConnectionAttribute() schema.ListNestedAttribute {
	return resourceConnectionAttributeWithRequired(false)
}

func requiredResourceConnectionAttribute() schema.ListNestedAttribute {
	return resourceConnectionAttributeWithRequired(true)
}

func resourceConnectionAttributeWithRequired(required bool) schema.ListNestedAttribute {
	return schema.ListNestedAttribute{
		Optional:    !required,
		Required:    required,
		Description: "Non-secret Resource Shape connection metadata. The selected adapter materializes concrete grants and projections.",
		NestedObject: schema.NestedAttributeObject{
			Attributes: map[string]schema.Attribute{
				"name": schema.StringAttribute{
					Required:    true,
					Description: "Connection name as seen by the consumer runtime, for example ASSETS or DATABASE.",
					Validators:  []validator.String{StringToken()},
				},
				"resource": schema.StringAttribute{
					Required:    true,
					Description: "Target resource reference, for example ObjectBucket/assets or Queue/jobs.",
					Validators:  []validator.String{StringToken()},
				},
				"permissions": schema.SetAttribute{
					Required:    true,
					ElementType: types.StringType,
					Description: "Open grant-permission tokens requested by the consumer. The selected Target implementation must advertise support.",
					Validators: []validator.Set{
						SetStringsToken(1),
					},
				},
				"projection": schema.StringAttribute{
					Required:    true,
					Description: "Open projection capability token. The selected Target implementation must advertise support.",
					Validators:  []validator.String{StringToken()},
				},
			},
		},
	}
}

func resourceConnectionsToSpec(ctx context.Context, value types.List, diags *diag.Diagnostics) map[string]any {
	if value.IsNull() || value.IsUnknown() {
		return nil
	}
	var items []resourceConnectionModel
	diags.Append(value.ElementsAs(ctx, &items, false)...)
	if diags.HasError() {
		return nil
	}
	out := map[string]any{}
	for _, item := range items {
		if item.Name.IsNull() || item.Name.IsUnknown() {
			continue
		}
		name := item.Name.ValueString()
		if name == "" {
			continue
		}
		permissions := []string{}
		if !item.Permissions.IsNull() && !item.Permissions.IsUnknown() {
			diags.Append(item.Permissions.ElementsAs(ctx, &permissions, false)...)
			if diags.HasError() {
				return nil
			}
		}
		sort.Strings(permissions)
		out[name] = map[string]any{
			"resource":    item.Resource.ValueString(),
			"permissions": permissions,
			"projection":  item.Projection.ValueString(),
		}
	}
	if len(out) == 0 {
		return nil
	}
	return out
}

func resourceConnectionsFromSpec(ctx context.Context, raw any) (types.List, diag.Diagnostics) {
	var diags diag.Diagnostics
	if raw == nil {
		return types.ListNull(types.ObjectType{AttrTypes: resourceConnectionAttrTypes}), diags
	}
	rawMap, ok := raw.(map[string]any)
	if !ok {
		return types.ListNull(types.ObjectType{AttrTypes: resourceConnectionAttrTypes}), diags
	}
	values := make([]attr.Value, 0, len(rawMap))
	names := make([]string, 0, len(rawMap))
	for name := range rawMap {
		names = append(names, name)
	}
	sort.Strings(names)
	for _, name := range names {
		item := rawMap[name]
		spec, ok := item.(map[string]any)
		if !ok {
			continue
		}
		permissions := toStringSlice(spec["permissions"])
		sort.Strings(permissions)
		permissionValues := []attr.Value{}
		for _, permission := range permissions {
			permissionValues = append(permissionValues, types.StringValue(permission))
		}
		permissionSet, d := types.SetValue(types.StringType, permissionValues)
		diags.Append(d...)
		if diags.HasError() {
			return types.ListNull(types.ObjectType{AttrTypes: resourceConnectionAttrTypes}), diags
		}
		value, d := types.ObjectValue(resourceConnectionAttrTypes, map[string]attr.Value{
			"name":        types.StringValue(name),
			"resource":    types.StringValue(stringFromAny(spec["resource"])),
			"permissions": permissionSet,
			"projection":  types.StringValue(stringFromAny(spec["projection"])),
		})
		diags.Append(d...)
		if diags.HasError() {
			return types.ListNull(types.ObjectType{AttrTypes: resourceConnectionAttrTypes}), diags
		}
		values = append(values, value)
	}
	if len(values) == 0 {
		return types.ListNull(types.ObjectType{AttrTypes: resourceConnectionAttrTypes}), diags
	}
	value, d := types.ListValue(types.ObjectType{AttrTypes: resourceConnectionAttrTypes}, values)
	diags.Append(d...)
	return value, diags
}

func stringFromAny(value any) string {
	if s, ok := value.(string); ok {
		return s
	}
	return ""
}
