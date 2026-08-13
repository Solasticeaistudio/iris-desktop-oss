# Tool development

Tools are registered in `src/lib/toolRegistry.ts`. A tool must have a stable name, clear description, structured input parameters, a handler, a risk level, and explicit approval metadata. There is no unrestricted default.

```ts
toolRegistry.add({
  name: "read_example",
  description: "Read a bounded local value",
  riskLevel: "low",
  requiresApproval: false,
  parameters: {
    path: { type: "string", description: "Absolute path", required: true },
  },
  handler: async ({ path }) => {
    // Validate scope and content before reading.
    return { path, value: "..." };
  },
});
```

Before adding a tool:

1. Decide whether the action is read-only, reversible, high-impact, or destructive.
2. Add strict parameter validation and reject unknown parameters.
3. Use the highest reasonable risk level; destructive, external, privileged, and irreversible actions require approval. Missing risk metadata makes registration fail.
4. Keep native effects behind the guarded sensitive or control dispatcher. Do not add raw implementation functions to renderer IPC.
5. Return structured, bounded results and avoid returning secrets or unnecessary file contents.
6. Add tests for unknown tools, invalid arguments, approval denial, and the native guard.

The registry records an audit event for attempted execution, denial, errors, and success. Model tool schemas are generated from the same registry, so a model cannot request an unregistered capability.

For a high/critical tool, add its schema and risk to the Rust guarded dispatcher and keep the operating-system implementation as a plain private function. Never register that implementation directly with `generate_handler!`. Native approval must bind the request ID, tool, normalized arguments, and risk before dispatch. A TypeScript-only confirmation is not an authorization boundary.

Mouse, keyboard, focus, and scrolling belong to a native target-bound computer-control dispatcher. A session authorizes one existing PID/HWND/executable for at most 120 seconds; another application requires another authorization. Keyboard/scroll actions require the approved foreground target, mouse coordinates remain inside its bounds, and terminals are never eligible. Allowlisted launching does not itself grant input control. A control session is not approval for a sensitive, destructive, external-communication, or shell operation. It restricts where IRIS may perform GUI interaction, but cannot universally determine the semantic effect of every control exposed by the target application; IDEs such as Visual Studio Code and Cursor may contain integrated terminals, consoles, extensions, or other powerful local interfaces. File and clipboard reads must be classified for privacy impact because their results can be returned to a remote model provider.

## Built-in composition and privacy audit

| Tool | Previous risk | Current risk | Native requirement |
| --- | --- | --- | --- |
| launch/open app | Medium | Medium | Strict allowlist; terminals excluded; later input needs target authorization |
| type text / key combo | Medium | Medium | Target-bound 120-second session; foreground revalidated |
| move/click/double/right click/scroll/focus | Medium | Medium | Target-bound session; foreground/bounds revalidated |
| drag | High | High | Exact one-time approval plus target-bound session and endpoint containment |
| drag | High | High | Exact single-use approval |
| read file | Low | High | Exact path validation and single-use privacy approval |
| read clipboard | Low | High | Single-use privacy approval; no polling |
| take screenshot | Low | Low | Local observation; user controls provider submission |
| open URL / web search | High | High | Exact single-use approval |
| write/delete filesystem | High/Critical | High/Critical | Exact single-use approval and native path guards |
| restore workspace | Medium | High | Exact single-use approval because applications are launched |

Risk is evaluated both per tool and for composability. Ordinary control sessions never authorize destructive tools, sensitive reads, arbitrary executables, or terminal shells.
