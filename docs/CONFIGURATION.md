# Configuration

IRIS separates non-secret settings from credentials and keeps provider destinations in the trusted Rust runtime. Windows users should prefer the in-app Settings panel; environment variables are intended for source-build automation and development.

## Reasoning

Open the gear icon and find **Reasoning provider**.

| Provider | Native base URL | Default model shown by IRIS | Credential |
| --- | --- | --- | --- |
| Offline mock | None | `offline-mock` | None |
| Gemini | `https://generativelanguage.googleapis.com/v1beta/openai` | `gemini-3.6-flash` | Gemini API key |
| OpenAI | `https://api.openai.com/v1` | `gpt-5-mini` | OpenAI API key |
| Custom / local | User-configured OpenAI-compatible URL | `llama3.2` as an editable example | Optional/required by server |

Model availability, quotas, and prices belong to the selected provider and may change. Enter a model ID available to your account. Use the provider's official key pages: [Gemini](https://ai.google.dev/gemini-api/docs/api-key), [OpenAI](https://platform.openai.com/api-keys).

Remote custom endpoints require HTTPS. Plain HTTP is accepted only for explicit localhost addresses such as `http://127.0.0.1:11434/v1`. Authenticated redirects are disabled. A custom credential is stored under an identity derived from the complete normalized base URL, so changing the URL does not move the key to another destination.

The **Test** button saves the current non-secret configuration and requests the provider's OpenAI-compatible `/models` route. Some otherwise compatible servers may not expose that route; a failed test can therefore mean either bad credentials/networking or an unsupported model-list endpoint.

## Voice

Voice configuration has three independent choices:

- microphone input device;
- speech-to-text provider and model;
- speech-output provider and voice.

Speech-to-text supports OpenAI and ElevenLabs. Speech output supports installed Windows system voices, OpenAI, and ElevenLabs. ElevenLabs keys can be created and scoped from the official [API keys documentation](https://elevenlabs.io/docs/overview/administration/workspaces/api-keys).

Reasoning and voice keys are separate vault entries. If one OpenAI key is used for both, save it once in Reasoning and once in Voice. IRIS never copies a reasoning key into the audio provider automatically.

Tap-to-talk is the safe default. Cloud wake-word mode causes detected utterances to be uploaded for transcription before IRIS can decide whether the wake phrase was spoken.

See [Voice](VOICE.md) for models, voice IDs, privacy, and fallback behavior.

## Environment fallback

Copy `.env.example` to `.env` only for local source development. `.env` is ignored and must never be committed.

```powershell
Copy-Item .env.example .env
```

Supported reasoning variables:

```env
IRIS_MODEL_PROVIDER=mock
IRIS_MODEL=your-model
IRIS_API_KEY=
IRIS_BASE_URL=https://example.com/v1
GEMINI_API_KEY=
```

`IRIS_MODEL_PROVIDER` accepts `mock`, `gemini`, `openai`, `openai-compatible`, or `custom`. `GEMINI_API_KEY` and `OPENAI_API_KEY` are provider-specific fallbacks. `IRIS_BASE_URL` is used only by `openai-compatible`/`custom` environment configuration.

Supported voice variables:

```env
IRIS_OPENAI_API_KEY=
IRIS_ELEVENLABS_API_KEY=
```

`OPENAI_API_KEY` and `ELEVENLABS_API_KEY` are accepted fallback names. Environment-defined provider configuration is used only when no in-app reasoning configuration has been saved. An environment credential cannot follow a later app-configured custom endpoint.

## Storage and reset behavior

Non-secret settings:

```text
%LOCALAPPDATA%\IRIS\reasoning\config.json
%LOCALAPPDATA%\IRIS\voice\config.json
```

Secrets are stored in Windows Credential Manager under IRIS-specific service identities. Removing a key through Settings removes that vault entry. Do not edit Credential Manager entries unless you understand which provider identity they belong to.

Foundry packages are stored under:

```text
%LOCALAPPDATA%\IRIS\capabilities
```

Workspaces, layouts, macros, and audit records use:

```text
%USERPROFILE%\.iris
```

Deleting local state is destructive and is not required for ordinary provider changes. Back up user-authored macros/workspaces first.

## Cost and privacy controls

- Provider keys use your provider account, quota, and billing.
- A reasoning request may include recent conversation, tool results, and explicitly attached visual context.
- Cloud STT receives recorded utterance audio.
- Cloud TTS receives response text.
- Cloud wake-word mode can upload non-wake ambient utterances.
- The offline mock and Windows system voice require no provider key, but the mock does not perform general reasoning.

Use provider-side spending limits and scoped keys where available. Never place real keys in issues, screenshots, documentation, tests, chat messages, or Git history.
