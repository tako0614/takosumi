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

	KindObjectBucket           = "ObjectBucket"
	KindKVStore                = "KVStore"
	KindQueue                  = "Queue"
	KindSQLDatabase            = "SQLDatabase"
	KindContainerService       = "ContainerService"
	KindVectorIndex            = "VectorIndex"
	KindDurableWorkflow        = "DurableWorkflow"
	KindStatefulActorNamespace = "StatefulActorNamespace"
	KindSchedule               = "Schedule"

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
	Name            string                           `json:"name"`
	Type            string                           `json:"type"`
	Ref             string                           `json:"ref,omitempty"`
	CredentialRef   string                           `json:"credentialRef,omitempty"`
	Region          string                           `json:"region,omitempty"`
	Priority        int64                            `json:"priority"`
	Implementations []TargetImplementationDescriptor `json:"implementations,omitempty"`
}

type TargetImplementationDescriptor struct {
	Shape               string               `json:"shape"`
	Implementation      string               `json:"implementation"`
	Interfaces          map[string]string    `json:"interfaces"`
	NativeResourceType  string               `json:"nativeResourceType,omitempty"`
	Plugin              string               `json:"plugin,omitempty"`
	ProviderSource      string               `json:"providerSource,omitempty"`
	ProviderAlias       string               `json:"providerAlias,omitempty"`
	ProviderConfig      map[string]any       `json:"providerConfig,omitempty"`
	ModuleTemplate      string               `json:"moduleTemplate,omitempty"`
	ModuleInputMappings map[string]any       `json:"moduleInputMappings,omitempty"`
	ModuleOutputs       []TargetModuleOutput `json:"moduleOutputs,omitempty"`
	Options             map[string]any       `json:"options,omitempty"`
}

type TargetModuleOutput struct {
	Name string `json:"name"`
	Type string `json:"type"`
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
	PlanDigest             string              `json:"planDigest"`
	SpecDigest             string              `json:"specDigest"`
	ResolutionFingerprint  string              `json:"resolutionFingerprint"`
	Quote                  *DeploymentQuote    `json:"quote,omitempty"`
}

// DeploymentQuote is the immutable price snapshot attached to a Deploy API
// preview by a commercial host. OSS endpoints can omit it.
type DeploymentQuote struct {
	QuoteID                 string `json:"quoteId"`
	QuoteDigest             string `json:"quoteDigest"`
	RatingStatus            string `json:"ratingStatus"`
	Currency                string `json:"currency"`
	EstimatedTotalUSDmicros int64  `json:"estimatedTotalUsdMicros"`
	ExpiresAt               string `json:"expiresAt"`
}

// DeploymentReview presents the exact preview evidence accepted by apply.
// Quote evidence is required only when the host returned a priced quote.
type DeploymentReview struct {
	PlanDigest  string `json:"planDigest"`
	QuoteID     string `json:"quoteId,omitempty"`
	QuoteDigest string `json:"quoteDigest,omitempty"`
}

type applyResourceBody struct {
	Resource
	Review DeploymentReview `json:"review"`
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

func (c *Client) importResourceURL(kind, name string) string {
	return fmt.Sprintf("%s/v1/resources/%s/%s/import", c.endpoint, url.PathEscape(kind), url.PathEscape(name))
}

func (c *Client) observeResourceURL(kind, name, space string) string {
	u := fmt.Sprintf("%s/v1/resources/%s/%s/observe", c.endpoint, url.PathEscape(kind), url.PathEscape(name))
	if query := spaceQuery(space); len(query) > 0 {
		u += "?" + query.Encode()
	}
	return u
}

func (c *Client) refreshResourceURL(kind, name, space string) string {
	u := fmt.Sprintf("%s/v1/resources/%s/%s/refresh", c.endpoint, url.PathEscape(kind), url.PathEscape(name))
	if query := spaceQuery(space); len(query) > 0 {
		u += "?" + query.Encode()
	}
	return u
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

// PutResource creates or updates a resource through the canonical reviewed
// Deploy API lifecycle. It previews the exact desired Resource, then presents
// that plan and optional quote evidence to PUT. Backend selection and pricing
// remain server-side concerns.
func (c *Client) PutResource(ctx context.Context, kind, name string, body *Resource) (*Resource, error) {
	preview, err := c.PreviewResource(ctx, body)
	if err != nil {
		return nil, err
	}
	if strings.TrimSpace(preview.PlanDigest) == "" {
		return nil, errors.New("takosumi: Deploy API preview omitted planDigest")
	}
	review := DeploymentReview{PlanDigest: preview.PlanDigest}
	if preview.Quote != nil {
		if strings.TrimSpace(preview.Quote.QuoteID) == "" || strings.TrimSpace(preview.Quote.QuoteDigest) == "" {
			return nil, errors.New("takosumi: Deploy API preview returned incomplete quote evidence")
		}
		review.QuoteID = preview.Quote.QuoteID
		review.QuoteDigest = preview.Quote.QuoteDigest
	}

	var out Resource
	request := applyResourceBody{Resource: *body, Review: review}
	if err := c.doJSON(ctx, http.MethodPut, c.putResourceURL(kind, name), &request, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

type importResourceBody struct {
	Resource
	NativeID string `json:"nativeId"`
}

// ImportResource adopts one existing provider-native object using the full
// desired Resource spec. The server plans and applies a read-only
// config-driven import before publishing Resource-owned state and outputs.
func (c *Client) ImportResource(ctx context.Context, kind, name, nativeID string, body *Resource) (*Resource, error) {
	var out Resource
	request := importResourceBody{Resource: *body, NativeID: nativeID}
	if err := c.doJSON(ctx, http.MethodPost, c.importResourceURL(kind, name), &request, &out); err != nil {
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

// ObserveResource performs a read-only backend drift check and returns the
// Resource projection with updated conditions. A 404 is translated to
// ErrNotFound, matching GetResource.
func (c *Client) ObserveResource(ctx context.Context, kind, name, space string) (*Resource, error) {
	var out Resource
	if err := c.doJSON(ctx, http.MethodPost, c.observeResourceURL(kind, name, space), nil, &out); err != nil {
		if code, ok := statusCode(err); ok && code == http.StatusNotFound {
			return nil, ErrNotFound
		}
		return nil, err
	}
	return &out, nil
}

// RefreshResource updates the Resource-owned backend state and public outputs
// without mutating native provider resources. A 404 is translated to
// ErrNotFound, matching GetResource and ObserveResource.
func (c *Client) RefreshResource(ctx context.Context, kind, name, space string) (*Resource, error) {
	var out Resource
	if err := c.doJSON(ctx, http.MethodPost, c.refreshResourceURL(kind, name, space), nil, &out); err != nil {
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
	query := spaceQuery(space)
	if query == nil {
		query = url.Values{}
	}
	query.Set("managedBy", ManagedByOpenTofu)
	if err := c.doJSON(ctx, http.MethodDelete, c.resourceURL(kind, name, query), nil, nil); err != nil {
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
	_, err := c.doJSONHeaders(ctx, method, fullURL, nil, body, out)
	return err
}

// doJSONHeaders is doJSON plus request headers in and response headers out. It
// exists for surfaces such as /v1/interfaces that carry optimistic-concurrency
// evidence in ETag / If-Match headers.
func (c *Client) doJSONHeaders(ctx context.Context, method, fullURL string, reqHeaders map[string]string, body, out any) (http.Header, error) {
	var reader io.Reader
	if body != nil {
		raw, err := json.Marshal(body)
		if err != nil {
			return nil, fmt.Errorf("takosumi: encoding request body: %w", err)
		}
		reader = bytes.NewReader(raw)
	}

	req, err := http.NewRequestWithContext(ctx, method, fullURL, reader)
	if err != nil {
		return nil, fmt.Errorf("takosumi: building request: %w", err)
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", c.userAgent)
	if c.token != "" {
		req.Header.Set("Authorization", "Bearer "+c.token)
	}
	for key, value := range reqHeaders {
		req.Header.Set(key, value)
	}

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("takosumi: request to %s failed: %w", fullURL, err)
	}
	defer resp.Body.Close()

	data, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("takosumi: reading response body: %w", err)
	}

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return resp.Header, parseAPIError(resp.StatusCode, data)
	}

	if out != nil && len(bytes.TrimSpace(data)) > 0 {
		if err := json.Unmarshal(data, out); err != nil {
			return resp.Header, fmt.Errorf("takosumi: decoding response from %s: %w", fullURL, err)
		}
	}
	return resp.Header, nil
}

// KindInterface is the object kind for runtime Interface declarations.
const KindInterface = "Interface"

// InterfaceOwnerRef identifies the Workspace, Capsule, or Resource that owns
// an Interface. The provider's in-run author path always writes a Capsule
// owner taken from the ambient run identity.
type InterfaceOwnerRef struct {
	Kind string `json:"kind"`
	ID   string `json:"id"`
}

// InterfaceMaterializedFrom is the immutable declaration-source marker. A
// module-declared takosumi_interface materializes as "capsule_resource".
type InterfaceMaterializedFrom struct {
	Source string `json:"source"`
	Key    string `json:"key,omitempty"`
}

// InterfaceMetadata is the Interface metadata block.
type InterfaceMetadata struct {
	ID               string                     `json:"id"`
	WorkspaceID      string                     `json:"workspaceId"`
	Name             string                     `json:"name"`
	OwnerRef         InterfaceOwnerRef          `json:"ownerRef"`
	Generation       int64                      `json:"generation"`
	Labels           map[string]string          `json:"labels,omitempty"`
	MaterializedFrom *InterfaceMaterializedFrom `json:"materializedFrom,omitempty"`
	CreatedAt        string                     `json:"createdAt,omitempty"`
	UpdatedAt        string                     `json:"updatedAt,omitempty"`
}

// InterfaceInput is one named public input. Source selects the variant:
// "literal" carries Value, "capsule_output" carries CapsuleID + OutputName
// (+ optional Pointer), and "resource_output" carries ResourceID + OutputName
// (+ optional Pointer).
type InterfaceInput struct {
	Source     string          `json:"source"`
	Value      json.RawMessage `json:"value,omitempty"`
	CapsuleID  string          `json:"capsuleId,omitempty"`
	ResourceID string          `json:"resourceId,omitempty"`
	OutputName string          `json:"outputName,omitempty"`
	Pointer    string          `json:"pointer,omitempty"`
}

// InterfaceAccess is the Interface access policy block.
type InterfaceAccess struct {
	Visibility       string `json:"visibility"`
	PolicyRef        string `json:"policyRef,omitempty"`
	ResourceURIInput string `json:"resourceUriInput,omitempty"`
}

// InterfaceSpec is the desired runtime declaration. Document is deliberately
// opaque, non-secret JSON that protocol consumers interpret together with
// status.resolvedInputs. It is carried as a raw JSON value because the server
// contract types it as an arbitrary JsonValue (object, array, string, number,
// boolean, or null); the resource layer separately constrains the module-author
// document_json to a JSON object. Keeping the transport permissive means a
// single non-object document authored via another surface (for example a
// service-side interfaceBlueprint) never breaks reads or list projections.
type InterfaceSpec struct {
	Type     string                    `json:"type"`
	Version  string                    `json:"version"`
	Document json.RawMessage           `json:"document"`
	Inputs   map[string]InterfaceInput `json:"inputs,omitempty"`
	Access   InterfaceAccess           `json:"access"`
}

// InterfaceStatus is the observed Interface state.
type InterfaceStatus struct {
	Phase              string         `json:"phase,omitempty"`
	ObservedGeneration int64          `json:"observedGeneration,omitempty"`
	ResolvedRevision   int64          `json:"resolvedRevision,omitempty"`
	ResolvedInputs     map[string]any `json:"resolvedInputs,omitempty"`
	Conditions         []Condition    `json:"conditions,omitempty"`
}

// InterfaceRecord is the Interface object envelope returned by /v1/interfaces.
type InterfaceRecord struct {
	APIVersion string            `json:"apiVersion"`
	Kind       string            `json:"kind"`
	Metadata   InterfaceMetadata `json:"metadata"`
	Spec       InterfaceSpec     `json:"spec"`
	Status     InterfaceStatus   `json:"status"`
}

// CreateInterfaceRequest is the POST /v1/interfaces body.
type CreateInterfaceRequest struct {
	WorkspaceID string            `json:"workspaceId"`
	Name        string            `json:"name"`
	OwnerRef    InterfaceOwnerRef `json:"ownerRef"`
	Labels      map[string]string `json:"labels,omitempty"`
	Spec        InterfaceSpec     `json:"spec"`
}

// UpdateInterfaceRequest is the PATCH /v1/interfaces/{id} body. Labels is a
// pointer so callers can distinguish "leave labels alone" (nil) from "replace
// with this exact map" (non-nil, possibly empty).
type UpdateInterfaceRequest struct {
	Name   string             `json:"name,omitempty"`
	Labels *map[string]string `json:"labels,omitempty"`
	Spec   *InterfaceSpec     `json:"spec,omitempty"`
}

// InterfaceListFilter is the supported GET /v1/interfaces query surface.
// WorkspaceID is required by the endpoint. The endpoint has no name query
// parameter, so name matching stays client-side.
type InterfaceListFilter struct {
	WorkspaceID string
	Type        string
	OwnerKind   string
	OwnerID     string
}

type listInterfacesResponse struct {
	Interfaces []InterfaceRecord `json:"interfaces"`
}

func (c *Client) interfacesURL(query url.Values) string {
	u := c.endpoint + "/v1/interfaces"
	if len(query) > 0 {
		u += "?" + query.Encode()
	}
	return u
}

func (c *Client) interfaceURL(id string) string {
	return c.endpoint + "/v1/interfaces/" + url.PathEscape(id)
}

// CreateInterface performs POST /v1/interfaces and returns the created record
// plus the response ETag used later as If-Match evidence.
func (c *Client) CreateInterface(ctx context.Context, body *CreateInterfaceRequest) (*InterfaceRecord, string, error) {
	var out InterfaceRecord
	headers, err := c.doJSONHeaders(ctx, http.MethodPost, c.interfacesURL(nil), nil, body, &out)
	if err != nil {
		return nil, "", err
	}
	return &out, headers.Get("ETag"), nil
}

// GetInterface reads one Interface by id and returns the record plus the
// response ETag. A 404 is translated to ErrNotFound.
func (c *Client) GetInterface(ctx context.Context, id string) (*InterfaceRecord, string, error) {
	var out InterfaceRecord
	headers, err := c.doJSONHeaders(ctx, http.MethodGet, c.interfaceURL(id), nil, nil, &out)
	if err != nil {
		if code, ok := statusCode(err); ok && code == http.StatusNotFound {
			return nil, "", ErrNotFound
		}
		return nil, "", err
	}
	return &out, headers.Get("ETag"), nil
}

// ListInterfaces performs GET /v1/interfaces with the endpoint's supported
// query filters and returns the interfaces array.
func (c *Client) ListInterfaces(ctx context.Context, filter InterfaceListFilter) ([]InterfaceRecord, error) {
	if strings.TrimSpace(filter.WorkspaceID) == "" {
		return nil, errors.New("takosumi: ListInterfaces requires a workspaceId")
	}
	query := url.Values{}
	query.Set("workspaceId", filter.WorkspaceID)
	if filter.Type != "" {
		query.Set("type", filter.Type)
	}
	if filter.OwnerKind != "" {
		query.Set("ownerKind", filter.OwnerKind)
	}
	if filter.OwnerID != "" {
		query.Set("ownerId", filter.OwnerID)
	}
	var out listInterfacesResponse
	if _, err := c.doJSONHeaders(ctx, http.MethodGet, c.interfacesURL(query), nil, nil, &out); err != nil {
		return nil, err
	}
	return out.Interfaces, nil
}

// UpdateInterface performs PATCH /v1/interfaces/{id}. The endpoint requires
// If-Match to exactly equal the current Interface ETag; pass the ETag from a
// fresh GetInterface. It returns the updated record plus its new ETag.
func (c *Client) UpdateInterface(ctx context.Context, id, ifMatch string, body *UpdateInterfaceRequest) (*InterfaceRecord, string, error) {
	var out InterfaceRecord
	headers, err := c.doJSONHeaders(ctx, http.MethodPatch, c.interfaceURL(id), map[string]string{"If-Match": ifMatch}, body, &out)
	if err != nil {
		return nil, "", err
	}
	return &out, headers.Get("ETag"), nil
}

// DeleteInterface performs DELETE /v1/interfaces/{id}, which retires the
// Interface. The endpoint requires If-Match to exactly equal the current
// Interface ETag. A 404 is treated as already-retired (no error).
func (c *Client) DeleteInterface(ctx context.Context, id, ifMatch string) error {
	if _, err := c.doJSONHeaders(ctx, http.MethodDelete, c.interfaceURL(id), map[string]string{"If-Match": ifMatch}, nil, nil); err != nil {
		if code, ok := statusCode(err); ok && code == http.StatusNotFound {
			return nil
		}
		return err
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
