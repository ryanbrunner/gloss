# @glossdev/core

The parts of [Gloss](https://github.com/ryanbrunner/gloss) that any host of a
review can run. The Gloss CLI is one host; it uses these through its own
session process and Playwright. Another host, such as a server that relays
reviews or a browser extension that carries the bar, uses the same pieces:

| Import | What it is | Needs |
| --- | --- | --- |
| `@glossdev/core` | `CommentStore`, the round's state machine; the verdict schema an agent reads; `handleRpc`, the checks a call from the bar goes through | nothing |
| `@glossdev/core/bar` | `mountBar(transport, options)`, the feedback bar (`options.shadow: 'closed'` for pages the host does not trust), and the `Transport` interface it talks through | a DOM |
| `@glossdev/core/server` | `createApp`, the agent's HTTP API (`/api/verdict`, `/api/working`, `/api/ready`, …) as a Hono app, for one store or many reviews, and `Waits` | `hono` |
| `@glossdev/core/verdict.v1.json`, `verdict.v2.json` | the verdict as JSON Schema: v1 from a session, v2 from a server holding many reviews | |

None of it imports Node, so it bundles for a browser or a Workers runtime.

The verdict is a contract with other programs and only grows; see
[docs/verdict.md](https://github.com/ryanbrunner/gloss/blob/main/docs/verdict.md).
This package is released with the Gloss CLI, under the same version.

MIT licensed.
