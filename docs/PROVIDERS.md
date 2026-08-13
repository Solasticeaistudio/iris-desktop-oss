# Provider development

The provider boundary is `IrisModelProvider` in `src/lib/modelProvider.ts`:

```ts
interface IrisModelProvider {
  id: string;
  name: string;
  supportsVision?: boolean;
  supportsTools?: boolean;
  supportsStreaming?: boolean;
  chat(request: ProviderChatRequest): Promise<ProviderChatResponse>;
}
```

A provider receives normalized messages and the registry's tool schemas. It returns text and optional structured calls containing a registered tool name and JSON arguments. It must not execute tools itself. Invalid or malformed calls are passed to the registry and fail closed.

The shipped providers are:

- `mock`: deterministic, offline, credential-free development provider.
- `openai-compatible`: a Rust HTTP client backed by native in-app or environment configuration. Gemini and OpenAI use fixed presets; custom credentials are bound to the complete normalized base URL. Renderer messages cannot substitute the endpoint. Credentialed remote URLs require HTTPS; only explicit localhost loopback URLs may use HTTP. Redirects are disabled, responses are bounded, and errors omit response bodies and credentials.

Voice providers are a separate native boundary. OpenAI speech-to-text/text-to-speech and ElevenLabs speech-to-text/text-to-speech use fixed HTTPS API origins, reject redirects, bound request and response sizes, and load credentials from Windows Credential Manager or explicit environment variables. The renderer can store or clear a credential but cannot retrieve its value. Windows system speech remains available without a cloud TTS credential. See `docs/VOICE.md`.

To add a provider, implement the interface, normalize its response into `ProviderChatResponse`, handle timeouts and malformed responses, and add tests for origin binding, redirect behavior, credential redaction, network errors, invalid responses, and tool-call parsing. Never accept a renderer-provided URL and automatically attach a native credential. Keep vendor-specific code at the provider boundary so the runtime remains independent of a model vendor.
