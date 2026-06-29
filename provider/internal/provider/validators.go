package provider

import (
	"context"
	"fmt"
	"strings"
	"unicode"

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

// stringTokenValidator validates an extensible capability token. It is used for
// fields where the Takosumi endpoint, not the provider binary, owns the final
// allow-list.
type stringTokenValidator struct{}

// StringToken returns a validator.String enforcing a non-empty token without
// whitespace when the optional value is configured.
func StringToken() validator.String {
	return stringTokenValidator{}
}

func (v stringTokenValidator) Description(_ context.Context) string {
	return "value must be a non-empty token without whitespace"
}

func (v stringTokenValidator) MarkdownDescription(ctx context.Context) string {
	return v.Description(ctx)
}

func (v stringTokenValidator) ValidateString(_ context.Context, req validator.StringRequest, resp *validator.StringResponse) {
	if req.ConfigValue.IsNull() || req.ConfigValue.IsUnknown() {
		return
	}
	val := req.ConfigValue.ValueString()
	if strings.TrimSpace(val) == "" {
		resp.Diagnostics.AddAttributeError(req.Path, "Invalid value", "value must not be blank")
		return
	}
	if strings.ContainsFunc(val, unicode.IsSpace) {
		resp.Diagnostics.AddAttributeError(req.Path, "Invalid value", fmt.Sprintf("%q contains whitespace", val))
	}
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

// setStringsNonEmptyValidator validates that every element of a set is a
// non-empty capability token and that the set has at least minItems elements.
// It deliberately does not enforce a fixed allow-list: extensible surfaces such
// as AIEndpoint profiles are accepted or rejected by the Takosumi endpoint's
// capabilities, TargetPool, policy, and resolver.
type setStringsNonEmptyValidator struct {
	minItems int
}

// SetStringsNonEmpty returns a validator.Set enforcing a minimum size and
// non-empty token strings without whitespace.
func SetStringsNonEmpty(minItems int) validator.Set {
	return setStringsNonEmptyValidator{minItems: minItems}
}

func (v setStringsNonEmptyValidator) Description(_ context.Context) string {
	return "each value must be a non-empty token without whitespace"
}

func (v setStringsNonEmptyValidator) MarkdownDescription(ctx context.Context) string {
	return v.Description(ctx)
}

func (v setStringsNonEmptyValidator) ValidateSet(ctx context.Context, req validator.SetRequest, resp *validator.SetResponse) {
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
		if strings.TrimSpace(val) == "" {
			resp.Diagnostics.AddAttributeError(req.Path, "Invalid value", "value must not be blank")
			continue
		}
		if strings.ContainsFunc(val, unicode.IsSpace) {
			resp.Diagnostics.AddAttributeError(req.Path, "Invalid value", fmt.Sprintf("%q contains whitespace", val))
		}
	}
}
