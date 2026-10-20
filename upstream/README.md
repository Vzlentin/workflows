# Background code mode for pi-durable

`pi-background-codemode.patch` applies to `earendil-works/pi` at `bdd9f03`:

    git apply upstream/pi-background-codemode.patch

It adds `"background": true` to the code mode options line. The call returns at once and the script runs as a
background tool call, owned by the conversation, which reports its output as a follow-up input when it ends. Any tool
can do the same through `api.runInBackground()`.

Not done yet: a status and abort action for one background script, and a decision on `beforeTool` hooks, which see the
background call again.
