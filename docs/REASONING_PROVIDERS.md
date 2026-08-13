# Reasoning providers

IRIS uses a native reasoning-provider boundary. Conversation messages and governed tool schemas reach Rust, which selects the configured endpoint, model, and credential. Renderer requests cannot supply an authenticated destination or retrieve a stored key.

## In-app configuration

Open **Settings → Reasoning provider** and choose:

- **Offline mock** — deterministic, credential-free development and Foundry testing.
- **Google Gemini** — fixed to `https://generativelanguage.googleapis.com/v1beta/openai`.
- **OpenAI** — fixed to `https://api.openai.com/v1`.
- **Custom / local** — an explicitly configured OpenAI-compatible base URL.

Select or enter a model, save the provider, store its API key, and use **Test**. Gemini and OpenAI require a credential. A local compatible service may be credential-free.

On Windows, credentials are stored in Windows Credential Manager. Non-secret settings are stored under the local IRIS application-data directory in `IRIS/reasoning/config.json`. The renderer receives only configured/not-configured status.

Custom credentials are keyed to a fingerprint of the complete normalized base URL. Changing the custom URL does not transfer authority to use the previous endpoint's credential. Remote custom endpoints require HTTPS; plain HTTP is accepted only for explicit localhost addresses. Redirects are disabled.

## Environment fallback

Source builds may use environment variables when no in-app configuration exists:

```text
IRIS_MODEL_PROVIDER=gemini | openai | openai-compatible | custom | mock
IRIS_MODEL=<model identifier>
IRIS_API_KEY=<credential>
IRIS_BASE_URL=<required for openai-compatible/custom>
```

`GEMINI_API_KEY` and `OPENAI_API_KEY` are accepted provider-specific fallbacks. Environment credentials apply only to environment-defined provider configuration; they are not attached to a custom endpoint later saved through the app.

Provider results are untrusted and limited to 4 MiB before JSON parsing. Provider failures withhold response bodies to avoid reflecting credentials or sensitive prompt content.
