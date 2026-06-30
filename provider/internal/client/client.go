// Package client is a thin HTTP client for the Takosumi Resource Shape API.
//
// It is deliberately transport-only: it speaks the Takosumi Resource object
// envelope (apiVersion/kind/metadata/spec/status) over JSON and maps error
// envelopes to typed errors. It never talks to AWS / Cloudflare / Kubernetes
// or any southbound API, never selects a backend, and never manages
// credentials. Backend selection happens server-side in the Takosumi Resolver;
// this client only carries a thin handle (id + outputs + resolution status).
package client

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
)

// API constants for the frozen wire contract.
const (
	// APIVersion is the Resource object apiVersion this provider speaks.
	APIVersion = "takosumi.dev/v1alpha1"

	// KindEdgeWorker is the resource shape kind for HTTP services.
	KindEdgeWorker = "EdgeWorker"

	KindObjectBucket     = "ObjectBucket"
	KindKVStore          = "KVStore"
	KindQueue            = "Queue"
	KindSQLDatabase      = "SQLDatabase"
	KindContainerService = "ContainerService"

	// ManagedByOpenTofu is stamped into metadata.managedBy on every write.
	ManagedByOpenTofu = "opentofu"

	defaultUserAgent = "terraform-provider-takosumi"
)

// ErrNotFound is returned when a resource read targets a resource that the
// server reports as gone (HTTP 404). Callers map this to "remove from state".
var ErrNotFound = errors.New("takosumi: resource not found")

// Discovery is the parsed body of GET /.well-known/takosumi.
//
// Features is intentionally a map so the provider stays capability-driven
// (it inspects named capabilities) rather than edition-driven (it never
// branches on an "edition" string).
type Discovery struct {
	APIVersions []string        `json:"api_versions"`
	Edition     string          `json:"edition,omitempty"`
	Features    map[string]bool `json:"features"`
	Endpoints   Endpoints       `json:"endpoints"`
}

// Endpoints carries advertised service URLs from discovery.
type Endpoints struct {
	API          string `json:"api,omitempty"`
	Capabilities string `json:"capabilities,omitempty"`
	OIDCIssuer   string `json:"oidc_issuer,omitempty"`
}

// HasFeature reports whether a named server capability is advertised.
func (d Discovery) HasFeature(name string) bool {
	return d.Features[name]
}

// SupportsResourceShapes reports whether the endpoint exposes the Resource
// Shape API. The provider refuses to configure when this is false.
func (d Discovery) SupportsResourceShapes() bool {
	return d.Features["resource_shapes"]
}

// Metadata is the Resource object metadata block.
type Metadata struct {
	Name        string `json:"name"`
	Space       string `json:"space,omitempty"`
	Project     string `json:"project,omitempty"`
	Environment string `json:"environment,omitempty"`
	ManagedBy   string `json:"managedBy,omitempty"`
	// ID may be returned by the server inside metadata; the provider also
	// accepts a top-level Resource.ID. Either, if present, wins over the
	// synthesized tkrn id.
	ID string `json:"id,omitempty"`
}

// Resolution is the resolver's chosen implementation/target for a resource.
type Resolution struct {
	SelectedImplementation string `json:"selectedImplementation,omitempty"`
	Target                 string `json:"target,omitempty"`
	Locked                 bool   `json:"locked,omitempty"`
	Portability            string `json:"portability,omitempty"`
}

// Condition is a Kubernetes-style status condition.
type Condition struct {
	Type    string `json:"type"`
	Status  string `json:"status"`
	Reason  string `json:"reason,omitempty"`
	Message string `json:"message,omitempty"`
}

// Status is the observed state returned by the server on PUT/GET/preview.
type Status struct {
	Phase              string         `json:"phase,omitempty"`
	ObservedGeneration int64          `json:"observedGeneration,omitempty"`
	Resolution         Resolution     `json:"resolution"`
	Outputs            map[string]any `json:"outputs,omitempty"`
	Conditions         []Condition    `json:"conditions,omitempty"`
}

// Resource is the Takosumi Resource object envelope. Spec is kept generic so
// the same transport carries every resource shape; the provider's resource
// layer owns the per-shape spec contents.
type Resource struct {
	APIVersion     string         `json:"apiVersion"`
	Kind           string         `json:"kind"`
	Metadata       Metadata       `json:"metadata"`
	Spec           map[string]any `json:"spec,omitempty"`
	TargetPoolName string         `json:"targetPoolName,omitempty"`
	Status         *Status        `json:"status,omitempty"`
	// ID is an optional top-level server identifier.
	ID string `json:"id,omitempty"`
}

// NativeResourceRef is a Takosumi Resource Shape native resource handle.
type NativeResourceRef struct {
	Type string `json:"type"`
	ID   string `json:"id"`
}

// TargetPoolSpec is the operator/admin configuration that ranks Targets for a
// Space. Implementation entries are extensible capability evidence; concrete AI
// provider names live here, not in the provider binary.
type TargetPoolSpec struct {
	Targets []TargetPoolEntry `json:"targets"`
}

type TargetPoolEntry struct {
	Name            string                     `json:"name"`
	Type            string                     `json:"type"`
	Ref             string                     `json:"ref,omitempty"`
	Region          string                     `json:"region,omitempty"`
	Priority        int64                      `json:"priority"`
	Implementations []TargetPoolImplementation `json:"implementations,omitempty"`
}

type TargetPoolImplementation struct {
	Shape              string            `json:"shape"`
	Implementation     string            `json:"implementation"`
	Interfaces         map[string]string `json:"interfaces"`
	NativeResourceType string            `json:"nativeResourceType,omitempty"`
	Plugin             string            `json:"plugin,omitempty"`
	Options            map[string]any    `json:"options,omitempty"`
}

type TargetPoolRecord struct {
	ID        string         `json:"id"`
	SpaceID   string         `json:"spaceId"`
	Name      string         `json:"name"`
	Spec      TargetPoolSpec `json:"spec"`
	CreatedAt string         `json:"createdAt,omitempty"`
	UpdatedAt string         `json:"updatedAt,omitempty"`
}

// PreviewResourceResult is the response body of POST /v1/resources/preview.
type PreviewResourceResult struct {
	Resource               Resource            `json:"resource"`
	SelectedImplementation string              `json:"selectedImplementation"`
	SelectedTarget         string              `json:"selectedTarget"`
	Portability            string              `json:"portability"`
	NativeResourcePlan     []NativeResourceRef `json:"nativeResourcePlan"`
	RiskNotes              []string            `json:"riskNotes"`
	Summary                string              `json:"summary"`
}

// ProductCapabilities is the parsed body of GET /v1/capabilities.
type ProductCapabilities struct {
	APIVersion string          `json:"apiVersion"`
	Resources  map[string]bool `json:"resources"`
	Adapters   map[string]bool `json:"adapters"`
	Compat     map[string]bool `json:"compat"`
	Identity   map[string]bool `json:"identity"`
	Commercial map[string]bool `json:"commercial"`
}

// SupportsResource reports whether a resource shape is advertised.
func (p ProductCapabilities) SupportsResource(kind string) bool {
	return p.Resources[kind]
}

// APIError is the typed form of the Takosumi error envelope for non-2xx
// responses. The wire envelope is nested: the top-level "error" field is an
// object, e.g.
//
//	{ "error": { "code": "<code>", "message": "<msg>", "requestId": "<id>", "details": <any> } }
type APIError struct {
	// StatusCode is the HTTP status; it is not part of the wire body.
	StatusCode int
	Code       string
	Message    string
	RequestID  string
	// Details is the optional, free-form details payload, kept raw.
	Details json.RawMessage
}

// errorEnvelope decodes the nested wire shape of an error response.
type errorEnvelope struct {
	Error struct {
		Code      string          `json:"code"`
		Message   string          `json:"message"`
		RequestID string          `json:"requestId"`
		Details   json.RawMessage `json:"details,omitempty"`
	} `json:"error"`
}

func (e *APIError) Error() string {
	var b strings.Builder
	b.WriteString("takosumi api error")
	if e.StatusCode != 0 {
		fmt.Fprintf(&b, " (http %d)", e.StatusCode)
	}
	if e.Code != "" {
		fmt.Fprintf(&b, " [%s]", e.Code)
	}
	if e.Message != "" {
		b.WriteString(": ")
		b.WriteString(e.Message)
	}
	if e.RequestID != "" {
		fmt.Fprintf(&b, " (requestId=%s)", e.RequestID)
	}
	return b.String()
}

// statusCode reports the HTTP status carried by err, if it is an *APIError.
func statusCode(err error) (int, bool) {
	var ae *APIError
	if errors.As(err, &ae) {
		return ae.StatusCode, true
	}
	return 0, false
}

// Client is a thin Takosumi Resource Shape API HTTP client.
type Client struct {
	endpoint   string // normalized origin, no trailing slash
	token      string
	httpClient *http.Client
	userAgent  string

	// Discovery is populated by Discover and cached for capability checks.
	Discovery    Discovery
	Capabilities ProductCapabilities
}

// New constructs a Client. If httpClient is nil, http.DefaultClient is used.
func New(endpoint, token string, httpClient *http.Client) *Client {
	if httpClient == nil {
		httpClient = http.DefaultClient
	}
	return &Client{
		endpoint:   strings.TrimRight(endpoint, "/"),
		token:      token,
		httpClient: httpClient,
		userAgent:  defaultUserAgent,
	}
}

// Endpoint returns the normalized endpoint origin.
func (c *Client) Endpoint() string { return c.endpoint }

// Discover performs GET {endpoint}/.well-known/takosumi and caches the result.
func (c *Client) Discover(ctx context.Context) (Discovery, error) {
	var disco Discovery
	if err := c.doJSON(ctx, http.MethodGet, c.endpoint+"/.well-known/takosumi", nil, &disco); err != nil {
		return Discovery{}, err
	}
	c.Discovery = disco
	return disco, nil
}

// GetCapabilities performs GET {endpoint}/v1/capabilities and caches the result.
func (c *Client) GetCapabilities(ctx context.Context) (ProductCapabilities, error) {
	fullURL := c.endpoint + "/v1/capabilities"
	if c.Discovery.Endpoints.Capabilities != "" {
		fullURL = c.Discovery.Endpoints.Capabilities
	}
	var caps ProductCapabilities
	if err := c.doJSON(ctx, http.MethodGet, fullURL, nil, &caps); err != nil {
		return ProductCapabilities{}, err
	}
	c.Capabilities = caps
	return caps, nil
}

// resourceURL builds {endpoint}/v1/resources/{kind}/{name}. Resource API paths
// are root-level under the endpoint origin (not under /api).
func (c *Client) resourceURL(kind, name string, query url.Values) string {
	u := fmt.Sprintf("%s/v1/resources/%s/%s", c.endpoint, url.PathEscape(kind), url.PathEscape(name))
	if len(query) > 0 {
		u += "?" + query.Encode()
	}
	return u
}

func spaceQuery(space string) url.Values {
	if space == "" {
		return nil
	}
	q := url.Values{}
	q.Set("space", space)
	return q
}

func (c *Client) putResourceURL(kind, name string) string {
	return fmt.Sprintf("%s/v1/resources/%s/%s", c.endpoint, url.PathEscape(kind), url.PathEscape(name))
}

func (c *Client) previewURL() string {
	return c.endpoint + "/v1/resources/preview"
}

func (c *Client) targetPoolURL(name string, query url.Values) string {
	u := fmt.Sprintf("%s/v1/target-pools/%s", c.endpoint, url.PathEscape(name))
	if len(query) > 0 {
		u += "?" + query.Encode()
	}
	return u
}

// PutResource creates or updates a resource:
// PUT {endpoint}/v1/resources/{kind}/{name}. 200 => Resource with status.
func (c *Client) PutResource(ctx context.Context, kind, name string, body *Resource) (*Resource, error) {
	var out Resource
	if err := c.doJSON(ctx, http.MethodPut, c.putResourceURL(kind, name), body, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// GetResource reads a resource. A 404 is translated to ErrNotFound.
func (c *Client) GetResource(ctx context.Context, kind, name, space string) (*Resource, error) {
	var out Resource
	if err := c.doJSON(ctx, http.MethodGet, c.resourceURL(kind, name, spaceQuery(space)), nil, &out); err != nil {
		if code, ok := statusCode(err); ok && code == http.StatusNotFound {
			return nil, ErrNotFound
		}
		return nil, err
	}
	return &out, nil
}

// DeleteResource deletes a resource. 200/204 => done; a 404 is treated as
// already-deleted (no error).
func (c *Client) DeleteResource(ctx context.Context, kind, name, space string) error {
	if err := c.doJSON(ctx, http.MethodDelete, c.resourceURL(kind, name, spaceQuery(space)), nil, nil); err != nil {
		if code, ok := statusCode(err); ok && code == http.StatusNotFound {
			return nil
		}
		return err
	}
	return nil
}

// PreviewResource performs a best-effort plan-time preview:
// POST {endpoint}/v1/resources/preview. Callers tolerate any error by skipping.
func (c *Client) PreviewResource(ctx context.Context, body *Resource) (*PreviewResourceResult, error) {
	var out PreviewResourceResult
	if err := c.doJSON(ctx, http.MethodPost, c.previewURL(), body, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// PutTargetPool creates or updates a TargetPool:
// PUT {endpoint}/v1/target-pools/{name}. 200 => TargetPoolRecord.
func (c *Client) PutTargetPool(ctx context.Context, name, space string, spec TargetPoolSpec) (*TargetPoolRecord, error) {
	body := map[string]any{
		"space": space,
		"spec":  spec,
	}
	var out TargetPoolRecord
	if err := c.doJSON(ctx, http.MethodPut, c.targetPoolURL(name, nil), body, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// GetTargetPool reads a TargetPool. A 404 is translated to ErrNotFound.
func (c *Client) GetTargetPool(ctx context.Context, name, space string) (*TargetPoolRecord, error) {
	var out TargetPoolRecord
	if err := c.doJSON(ctx, http.MethodGet, c.targetPoolURL(name, spaceQuery(space)), nil, &out); err != nil {
		if code, ok := statusCode(err); ok && code == http.StatusNotFound {
			return nil, ErrNotFound
		}
		return nil, err
	}
	return &out, nil
}

// DeleteTargetPool removes a TargetPool. A 404 is treated as already-deleted.
func (c *Client) DeleteTargetPool(ctx context.Context, name, space string) error {
	if err := c.doJSON(ctx, http.MethodDelete, c.targetPoolURL(name, spaceQuery(space)), nil, nil); err != nil {
		if code, ok := statusCode(err); ok && code == http.StatusNotFound {
			return nil
		}
		return err
	}
	return nil
}

// doJSON marshals body (if any), sends the request, and decodes a 2xx response
// into out (if any). Non-2xx responses are parsed into *APIError.
func (c *Client) doJSON(ctx context.Context, method, fullURL string, body, out any) error {
	var reader io.Reader
	if body != nil {
		raw, err := json.Marshal(body)
		if err != nil {
			return fmt.Errorf("takosumi: encoding request body: %w", err)
		}
		reader = bytes.NewReader(raw)
	}

	req, err := http.NewRequestWithContext(ctx, method, fullURL, reader)
	if err != nil {
		return fmt.Errorf("takosumi: building request: %w", err)
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", c.userAgent)
	if c.token != "" {
		req.Header.Set("Authorization", "Bearer "+c.token)
	}

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return fmt.Errorf("takosumi: request to %s failed: %w", fullURL, err)
	}
	defer resp.Body.Close()

	data, err := io.ReadAll(resp.Body)
	if err != nil {
		return fmt.Errorf("takosumi: reading response body: %w", err)
	}

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return parseAPIError(resp.StatusCode, data)
	}

	if out != nil && len(bytes.TrimSpace(data)) > 0 {
		if err := json.Unmarshal(data, out); err != nil {
			return fmt.Errorf("takosumi: decoding response from %s: %w", fullURL, err)
		}
	}
	return nil
}

// parseAPIError decodes the nested error envelope
// ({ "error": { "code", "message", "requestId", "details" } }), falling back to
// the raw body when the response is not the expected JSON shape.
func parseAPIError(status int, data []byte) *APIError {
	apiErr := &APIError{StatusCode: status}
	if len(bytes.TrimSpace(data)) > 0 {
		var env errorEnvelope
		if err := json.Unmarshal(data, &env); err == nil {
			apiErr.Code = env.Error.Code
			apiErr.Message = env.Error.Message
			apiErr.RequestID = env.Error.RequestID
			apiErr.Details = env.Error.Details
		}
	}
	if apiErr.Message == "" {
		if trimmed := strings.TrimSpace(string(data)); trimmed != "" {
			apiErr.Message = trimmed
		} else {
			apiErr.Message = http.StatusText(status)
		}
	}
	return apiErr
}
