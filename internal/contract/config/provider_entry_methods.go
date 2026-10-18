package config

import (
	"net/netip"
	"net/url"
	"slices"
	"strings"

	"reasonix/internal/contract/provider"
)

// HasModel reports whether m is one of the provider's models.
func (e *ProviderEntry) HasModel(m string) bool {
	return slices.Contains(e.ModelList(), m)
}

// PriceForModel returns the configured per-1M-token price for model. Per-model
// prices win; the legacy provider-wide price is a fallback for older configs.
func (e *ProviderEntry) PriceForModel(model string) *provider.Pricing {
	if e == nil {
		return nil
	}
	if e.Prices != nil {
		if p := e.Prices[strings.TrimSpace(model)]; p != nil {
			return clonePricing(p)
		}
	}
	return clonePricing(e.Price)
}

func (e *ProviderEntry) applyModelPrice() {
	if e == nil {
		return
	}
	e.Price = e.PriceForModel(e.Model)
}

func (e *ProviderEntry) applyModelOverride() {
	if e == nil || len(e.ModelOverrides) == 0 {
		return
	}
	ov, ok := e.modelOverrideForModel(e.Model)
	if !ok {
		return
	}
	if ov.ReasoningProtocol != "" {
		e.ReasoningProtocol = ov.ReasoningProtocol
	}
	if ov.SupportedEfforts != nil {
		e.SupportedEfforts = append([]string(nil), ov.SupportedEfforts...)
	}
	if ov.DefaultEffort != "" || ov.SupportedEfforts != nil {
		e.DefaultEffort = ov.DefaultEffort
	}
	if ov.Vision != nil {
		e.visionOverride = ov.Vision
	}
	if ov.ContextWindow > 0 {
		e.ContextWindow = ov.ContextWindow
	}
	if ov.MaxOutputTokens != 0 {
		e.MaxOutputTokens = ov.MaxOutputTokens
	}
}

func (e *ProviderEntry) modelOverrideForModel(model string) (ProviderModelOverride, bool) {
	key, ok := e.modelOverrideKey(model)
	if !ok {
		return ProviderModelOverride{}, false
	}
	return e.ModelOverrides[key], true
}

func clonePricing(p *provider.Pricing) *provider.Pricing {
	if p == nil {
		return nil
	}
	cp := *p
	return &cp
}

// APIKey resolves the entry's API key from its api_key_env.
func (e *ProviderEntry) APIKey() string {
	if e == nil {
		return ""
	}
	if e.resolvedAPIKey != "" {
		return e.resolvedAPIKey
	}
	if e.APIKeyEnv == "" {
		return ""
	}
	value, _, _ := storedCredentialValue(e.roots, e.APIKeyEnv)
	return value
}

func (e *ProviderEntry) APIKeySourceLabel() string {
	if e == nil || strings.TrimSpace(e.APIKeyEnv) == "" {
		return ""
	}
	if e.resolvedAPIKey != "" {
		return credentialSourceLabel(e.resolvedSource)
	}
	return ResolveCredentialForRootGlobalFirst(".", e.APIKeyEnv).Source.Label
}

// RequiresAPIKey reports whether this provider should be hidden/validated when
// its configured api_key_env is empty. A blank api_key_env means the provider is
// intentionally no-auth. Local OpenAI-compatible gateways often keep a legacy
// api_key_env in config even though they accept unauthenticated requests, so
// loopback/private endpoints are also allowed to run without a resolved key.
func (e *ProviderEntry) RequiresAPIKey() bool {
	if e == nil {
		return false
	}
	if strings.TrimSpace(e.APIKeyEnv) == "" {
		return providerBaseURLRequiresAPIKey(e.BaseURL)
	}
	return !providerBaseURLAllowsMissingAPIKey(e.BaseURL)
}

func providerBaseURLRequiresAPIKey(raw string) bool {
	switch officialProviderHost(raw) {
	case "api.deepseek.com", "api.xiaomimimo.com", "token-plan-cn.xiaomimimo.com", "api.minimaxi.com", "api.openai.com":
		return true
	default:
		return false
	}
}

func providerBaseURLAllowsMissingAPIKey(raw string) bool {
	u, err := url.Parse(strings.TrimSpace(raw))
	if err != nil {
		return false
	}
	host := strings.Trim(strings.ToLower(u.Hostname()), "[]")
	if host == "localhost" || strings.HasSuffix(host, ".localhost") {
		return true
	}
	addr, err := netip.ParseAddr(host)
	if err != nil {
		return false
	}
	return addr.IsLoopback() || addr.IsPrivate() || addr.IsLinkLocalUnicast()
}

// Configured reports whether the provider is selectable. Providers that do not
// require an API key are configured by definition; providers that name an env var
// require that variable to resolve unless their endpoint is local/private.
func (e *ProviderEntry) Configured() bool {
	return e != nil && (!e.RequiresAPIKey() || e.APIKey() != "")
}
