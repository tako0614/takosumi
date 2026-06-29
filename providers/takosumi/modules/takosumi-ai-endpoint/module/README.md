# takosumi-ai-endpoint

Pure value-projection module for the `AIEndpoint` Resource Shape.

The selected AI provider or gateway is a Takosumi Resolver/Target/Adapter
decision. This module does not carry upstream API keys and does not call an AI
provider directly.

`providerPreferences` and routing inputs are preference metadata only. Unknown
AI providers, model families, regions, and routing strategies are accepted by
the shape contract when they are valid tokens, then accepted or rejected by the
Takosumi endpoint's engine, TargetPool capability evidence, and operator
policy.
