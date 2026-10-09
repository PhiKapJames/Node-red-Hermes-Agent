# Application adapter boundary

Keep application policy separate from the Hermes client package.

An input adapter authenticates/filters the source, suppresses duplicate transport deliveries, chooses an opaque client ID, and maps its payload into `msg.hermes`. It may set author, explicitly selected client context, and instructions about style, output size or wording. Neither the transport's identity claims nor a model prompt grants privileges.

```js
// Example contract, not a source-specific parser.
msg.hermes = {
    input: msg.application.text,
    clientId: msg.application.clientId,
    author: { id: msg.application.clientId, name: msg.application.displayName, is_bot: false },
    context: msg.application.modelVisibleContext,
    instructions: msg.application.responseInstructions
};
return msg;
```

Alternatively use Hermes Prepare to map these paths without a Function node. Keep routing metadata elsewhere in msg; the Agent preserves unrelated fields without automatically sending them to the model.

An authorized control adapter routes a separate message to Hermes Control:

```js
msg.hermesControl = { action: "reset" };
return msg;
```

Recognition of a textual command belongs in that adapter. Never connect unfiltered external events directly to a dynamic Control node.

A downstream adapter consumes **only Agent output 1** as a successful answer. It implements destination limits and delivery logic. A prompt cannot guarantee a byte limit: validate the response before delivery. For channels that cannot carry a complete answer, choose a complete shorter answer or a safe application-level fallback; do not depend on this library to silently truncate it.

Lifecycle events (output 2) are operational data, not additional user replies. Errors (output 3) require a separate application policy. Catch and output 3 both report errors: do not forward both into the same delivery path.
