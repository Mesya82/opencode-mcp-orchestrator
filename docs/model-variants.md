# Model variants

OpenCode MCP Orchestrator can configure an OpenCode model variant independently for Scout, Worker, and Runner.

Variants are model-specific. The project does not maintain a list of reasoning levels or variant names. During interactive configuration it asks OpenCode for the structured model catalog and offers exactly the variants advertised by the selected model.

For a model that advertises variants, the installer offers `Default` plus those variant IDs. `Default` means the bridge omits the `variant` field from `session.switchModel()` and lets OpenCode choose the model's normal default behavior.

Different roles may use different variants even when they use the same model. For example:

```json
{
  "version": 1,
  "models": {
    "scout": "opencode/example-model",
    "worker": "opencode/example-model",
    "runner": "opencode/example-model"
  },
  "modelVariants": {
    "scout": "low",
    "worker": "medium",
    "runner": "minimal"
  }
}
```

`modelVariants` is optional and role entries are optional. Existing configurations that only contain `models` remain valid and preserve the previous behavior.

OpenCode V2 stable may expose a healthy structured `/api/model` endpoint while returning an empty catalog. The configurator treats an empty or otherwise unusable structured catalog the same as unavailable variant metadata and falls back to the `opencode models` command. This is an expected compatibility path, not a reason to invent provider, model, or variant data.

In fallback mode the installer does not guess variant names. Existing variant selections are preserved for unchanged models; newly selected models use the OpenCode default until structured variant metadata becomes available again.

At runtime the selected role is sent to OpenCode as:

```js
{
  model: {
    providerID,
    id,
    variant // omitted for Default
  }
}
```

Variant configuration is intentionally generic. A provider may use variants for reasoning effort or for another model-specific behavior, so the orchestrator stores the opaque variant ID reported by OpenCode rather than interpreting it.
