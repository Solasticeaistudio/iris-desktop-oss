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
- `openai-compatible`: a Rust HTTP client that loads `IRIS_BASE_URL`, `IRIS_MODEL`, and `IRIS_API_KEY` together from native environment configuration. Renderer messages cannot substitute the endpoint. Credentialed remote URLs require HTTPS; only explicit localhost loopback URLs may use HTTP. Redirects are disabled, and errors omit response bodies and credentials.

To add a provider, implement the interface, normalize its response into `ProviderChatResponse`, handle timeouts and malformed responses, and add tests for origin binding, redirect behavior, credential redaction, network errors, invalid responses, and tool-call parsing. Never accept a renderer-provided URL and automatically attach a native credential. Keep vendor-specific code at the provider boundary so the runtime remains independent of a model vendor.
