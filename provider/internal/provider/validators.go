package provider

import (
	"context"
	"fmt"
	"strings"

	"github.com/hashicorp/terraform-plugin-framework/schema/validator"
	"github.com/hashicorp/terraform-plugin-framework/types"
)

// stringOneOfValidator validates that a configured string is one of a fixed
// allow-list. It is a tiny in-tree validator so the provider keeps its
// dependency surface to terraform-plugin-framework alone.
type stringOneOfValidator struct {
	allowed []string
}

// StringOneOf returns a validator.String enforcing membership in allowed.
func StringOneOf(allowed ...string) validator.String {
	return stringOneOfValidator{allowed: allowed}
}

func (v stringOneOfValidator) Description(_ context.Context) string {
	return fmt.Sprintf("value must be one of: %s", strings.Join(v.allowed, ", "))
}

func (v stringOneOfValidator) MarkdownDescription(ctx context.Context) string {
	return v.Description(ctx)
}

func (v stringOneOfValidator) ValidateString(_ context.Context, req validator.StringRequest, resp *validator.StringResponse) {
	if req.ConfigValue.IsNull() || req.ConfigValue.IsUnknown() {
		return
	}
	val := req.ConfigValue.ValueString()
	for _, a := range v.allowed {
		if val == a {
			return
		}
	}
	resp.Diagnostics.AddAttributeError(
		req.Path,
		"Invalid value",
		fmt.Sprintf("%q is not a valid value; must be one of: %s", val, strings.Join(v.allowed, ", ")),
	)
}

// setStringsOneOfValidator validates that every element of a set of strings is
// in a fixed allow-list and that the set has at least minItems elements.
type setStringsOneOfValidator struct {
	allowed  []string
	minItems int
}

// SetStringsOneOf returns a validator.Set enforcing a minimum size and that
// every element is in allowed.
func SetStringsOneOf(minItems int, allowed ...string) validator.Set {
	return setStringsOneOfValidator{allowed: allowed, minItems: minItems}
}

func (v setStringsOneOfValidator) Description(_ context.Context) string {
	return fmt.Sprintf("each value must be one of: %s", strings.Join(v.allowed, ", "))
}

func (v setStringsOneOfValidator) MarkdownDescription(ctx context.Context) string {
	return v.Description(ctx)
}

func (v setStringsOneOfValidator) ValidateSet(ctx context.Context, req validator.SetRequest, resp *validator.SetResponse) {
	if req.ConfigValue.IsNull() || req.ConfigValue.IsUnknown() {
		return
	}

	var elems []types.String
	resp.Diagnostics.Append(req.ConfigValue.ElementsAs(ctx, &elems, false)...)
	if resp.Diagnostics.HasError() {
		return
	}

	if len(elems) < v.minItems {
		resp.Diagnostics.AddAttributeError(
			req.Path,
			"Too few values",
			fmt.Sprintf("at least %d value(s) required, got %d", v.minItems, len(elems)),
		)
	}

	for _, e := range elems {
		if e.IsNull() || e.IsUnknown() {
			continue
		}
		val := e.ValueString()
		ok := false
		for _, a := range v.allowed {
			if val == a {
				ok = true
				break
			}
		}
		if !ok {
			resp.Diagnostics.AddAttributeError(
				req.Path,
				"Invalid value",
				fmt.Sprintf("%q is not a valid value; must be one of: %s", val, strings.Join(v.allowed, ", ")),
			)
		}
	}
}
