# Annotation system

IRIS can display screen annotations through the dedicated annotation webview. Annotation requests are ordinary registered tools: the model emits a structured tool call, the runtime validates its schema and policy metadata, and only then does the native layer update the overlay.

Model response text is never parsed as an executable action language. Text that resembles commands, markup, or function calls remains presentation-only.

## Execution path

```text
model structured tool call
        |
        v
TypeScript registry validation
        |
        v
risk and approval policy
        |
        v
native Tauri command ACL and argument validation
        |
        v
annotation overlay event
```

The annotation window receives only the event/window permissions and explicitly listed application commands required to draw and dismiss annotations. It does not receive the main window's tool execution surface.

## Security notes

- Unknown annotation tools and malformed coordinates fail closed.
- Annotation content is rendered as data, not injected executable HTML.
- Annotation tools cannot authorize unrelated desktop-control or destructive operations.
- Approval grants, when required by policy, are bound to the exact structured request.
