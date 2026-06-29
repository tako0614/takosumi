package provider

import (
	"encoding/json"
	"fmt"

	"github.com/hashicorp/terraform-plugin-framework/types"

	"github.com/takosjp/terraform-provider-takosumi/internal/client"
)

func resourceIDForKind(res *client.Resource, space, kind, name string) string {
	if res.ID != "" {
		return res.ID
	}
	if res.Metadata.ID != "" {
		return res.Metadata.ID
	}
	return fmt.Sprintf("tkrn:%s:%s:%s", space, kind, name)
}

func effectiveSpace(value types.String, fallback string) string {
	if value.IsNull() || value.IsUnknown() || value.ValueString() == "" {
		return fallback
	}
	return value.ValueString()
}

func outputsToStringMap(outputs map[string]any) map[string]string {
	if len(outputs) == 0 {
		return map[string]string{}
	}
	out := make(map[string]string, len(outputs))
	for key, value := range outputs {
		switch v := value.(type) {
		case string:
			out[key] = v
		case nil:
			out[key] = ""
		default:
			if raw, err := json.Marshal(v); err == nil {
				out[key] = string(raw)
			} else {
				out[key] = fmt.Sprint(v)
			}
		}
	}
	return out
}

func toStringSlice(raw any) []string {
	switch v := raw.(type) {
	case []string:
		return v
	case []any:
		out := make([]string, 0, len(v))
		for _, e := range v {
			if s, ok := e.(string); ok {
				out = append(out, s)
			}
		}
		return out
	default:
		return nil
	}
}
