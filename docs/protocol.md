# The Gloss protocol: what `gloss connect` talks to

`gloss wait`, `working` and `ready` talk to a Gloss session over HTTP. The
session `gloss open` starts serves that API on `127.0.0.1`. A directory
connected with `gloss connect <server-url>` talks to the same API on a
server elsewhere instead: one whose reviewers comment from their own
browsers, possibly many reviewers in many reviews at once.

This page is that API, for anyone writing such a server or another client.
`createApp` in [`@glossdev/core/server`](../packages/core/src/server.ts)
implements the server side, and a server built on it gets everything below
except sign-in and how it shares rounds out between agents, which are its
own. `scripts/spikes/remote-check.ts` is a small but complete example.

## Routes

Every route is under the server URL the client was given: `gloss connect
https://gloss.example/v1/projects/acme` means
`https://gloss.example/v1/projects/acme/api/verdict`, and so on.

| Route | |
| --- | --- |
| `GET /api/health` | `{ok: true, url, capabilities: {navigate, reload, close, reviews}, …}`. A session adds its `pid`. |
| `GET /api/state[?review=R]` | The round as the bar sees it: `{round, phase, message, summary, summaryRound, live, comments}`. |
| `GET /api/verdict?wait=N` | The next verdict ([docs/verdict.md](verdict.md)), or `{pending: true}` after `N` seconds (at most 30). |
| `POST /api/working` | `{message?, review?}`: the agent has the round. |
| `POST /api/ready` | `{summary?, review?}`: the agent is done. Answers `{ok, phase, reloaded}`. |
| `POST /api/live` | `{live, review?}`: turns live mode on or off. |
| `POST /api/navigate` | `{url}`: only where `capabilities.navigate`. |
| `POST /api/close` | Ends the session: only where `capabilities.close`. |

A route a server cannot serve answers `501`. Errors are
`{error: "<a sentence for the person at the terminal>"}`, with:

| Status | Meaning |
| --- | --- |
| 400 | The request was wrong, such as a missing `review`. |
| 401 | No token, or one the server no longer takes. The client says to `gloss login` and stops. |
| 404 | No such review, or none this caller may see. |
| 409 | The round cannot move that way now, such as `ready` on a round nobody is working on. |
| 410 | The session is ending; there will be no verdict. |
| 501 | Not something this server does. |

A connection that fails, or a 5xx, is not an answer: `gloss wait` asks
again, less and less often, for as long as it takes.

## Many reviews

A server whose health says `capabilities.reviews: true` holds many reviews,
each with a store of its own. Then:

- `GET /api/verdict` waits on all of them and answers with a **version 2**
  verdict, whose `review` says which review it is. What a version 2
  verdict means is in [docs/verdict.md](verdict.md#version-2-many-reviews).
- Every other route about a round names its review: `?review=` on
  `/api/state`, and `review` in the body of `working`, `ready` and `live`.
  The client names the review of the last verdict it printed.
- One review being worked on holds up no other, so `/api/verdict` is not
  refused while an agent is working on one of them.

### Which agent gets which round

The server decides. Every request from `gloss` carries
`x-gloss-client: <uuid>`, one id per connected directory, kept across
reconnects to the same server. The expected behaviour, and what
`remote-check` checks:

1. A round handed to one client is that client's: asked again, before it
   says `working` or `ready`, it gets the **same verdict again**, and no
   other client is handed it.
2. It stays that client's through `working` until `ready`.
3. A client that has gone quiet loses it. `CommentStore.requeue()` puts a
   round that was being worked on back to waiting, as it was submitted.
4. An approval handed to a client is done with once that client asks for
   its next verdict. Until then, it is handed to that client again, like
   any other verdict.

## Pictures

A store keeps whatever its host puts in `pin.screenshot`. For a server, that
is usually a key into its own storage. In the verdicts it hands out, it
links the picture as `target.screenshotUrl`:

- relative to the server URL, or absolute;
- https, or http only on loopback;
- a PNG, at most 10 MB.

`gloss wait` fetches each one and replaces `target.screenshot` with the
local path it saved it to. It sends the token only to the server's own
origin, so a link elsewhere has to work without it, as a signed URL does.
A `screenshot` field from the server is always dropped, since a path on the
server is no file on the agent's machine.

## Signing in

`gloss login <server-url>` (and `gloss connect`, when health answers 401)
uses the OAuth 2.0 device authorization grant (RFC 8628):

1. `GET <origin>/.well-known/gloss.json` gives
   `{device_authorization_endpoint, token_endpoint, client_id}`. Both
   endpoints must be on the same origin as the server.
2. A form `POST` of `client_id` to the device endpoint gives
   `{device_code, user_code, verification_uri, verification_uri_complete?,
   expires_in, interval?}`. `gloss` prints the link and code on stderr.
3. `gloss` polls the token endpoint with
   `grant_type=urn:ietf:params:oauth:grant-type:device_code`, honouring
   `authorization_pending`, `slow_down`, `access_denied` and
   `expired_token`, until it gets `{access_token}`.

The token is sent as `Authorization: Bearer <token>` to that origin, and is
kept in `$GLOSS_HOME/credentials.json` (mode 0600), one per origin.
`GLOSS_TOKEN` in the environment stands in for every sign-in.

## The reviewers' side

How reviewers reach a server is not part of this protocol, and the bar
does not care: it talks through a `Transport` (`@glossdev/core/bar`). A
server applies what a reviewer does with `handleRpc` from
`@glossdev/core`. It passes the `url` and `topFrame` as something other
than the page saw them, and the `author` it signed in, never one the page
sends.
