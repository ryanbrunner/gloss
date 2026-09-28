# The verdict: what `gloss wait` prints

`gloss wait` blocks until the reviewer submits a round or approves, then
prints one JSON document on stdout. This page is the contract for programs
that read it, such as Reeve and the Gloss skill. The machine-readable form is
[`schema/verdict.v1.json`](../schema/verdict.v1.json) (JSON Schema 2020-12),
written from `src/verdict.ts`; `npm test` fails if the two drift apart.

## Approval

A consumer may treat the result as approval **only if all of these hold**:

1. `gloss wait` exited 0
2. stdout parsed as a single JSON document
3. `version === 1`
4. `approved === true`

Anything else is **no verdict**, never approval. That covers a non-zero exit,
a killed process, empty or unparseable output, an unknown version, and a
closed browser window. Submitting with no comments is not approval either:
the bar does not allow it.

## Exit status and streams

| Exit | stdout | Meaning |
| --- | --- | --- |
| 0 | one JSON document | the reviewer submitted a round (`approved: false`) or approved (`approved: true`) |
| 1 | nothing | no verdict: no session is running, the session ended while waiting (the window was closed, or `gloss close`), the agent is marked working (run `gloss ready` first), or the session answered with something that is not a version 1 verdict |
| 2 | nothing | the command line was wrong |

stdout carries the document and nothing else. Progress lines and the reason
for a non-zero exit go to stderr.

## The document, version 1

```json
{
  "version": 1,
  "approved": false,
  "round": 1,
  "page": "http://localhost:3000/cart",
  "comments": [
    {
      "id": "c1",
      "kind": "general",
      "body": "Order summary should show shipping before the total.",
      "page": "http://localhost:3000/cart",
      "createdAt": 1767000000000,
      "sentIn": 1,
      "target": null
    }
  ]
}
```

| Field | |
| --- | --- |
| `version` | `1`. A field that changes meaning gets a new version. |
| `approved` | `true` only when the reviewer pressed Approve. |
| `round` | The round this answers, from 1. Two verdicts with the same `round` are the same verdict. |
| `page` | The page the reviewer was on when they submitted or approved, or `null`. |
| `comments` | The comments sent in **this round only**. Earlier rounds are never sent again. Empty on approval. |
| `comments[].id` | Unique within the session. |
| `comments[].kind` | `"general"`. `"pinned"` is reserved; see below. |
| `comments[].body` | What the reviewer wrote, trimmed. May hold newlines. |
| `comments[].page` | The page the reviewer was on when they wrote it, or `null`. |
| `comments[].createdAt` | Milliseconds since the epoch. |
| `comments[].sentIn` | The round it went out in, always the same as `round`. |
| `comments[].target` | `null` for a general comment. |

The objects are open: fields may be added in version 1, and a consumer must
ignore any it does not know.

### Reserved: pinned comments

Version 1 writes only `"kind": "general"` with `"target": null`. Comments
pinned to an element will arrive as `"kind": "pinned"` with `target` set to an
object describing the element, without a new version. A version 1 consumer
must accept both and may treat a pinned comment as a general one about its
target.

## Asking twice gets the same round

The verdict stays in place until the agent calls `gloss working` or
`gloss ready`. Until then, every `gloss wait` prints the same document, so a
dropped connection or a killed background shell loses nothing. In return:

- After a verdict with `approved: false`, the next Gloss command is
  `gloss working` or `gloss ready`, not `gloss wait`.
- Dedupe on `round`: a round already handled is not applied twice.
- `gloss wait` while the agent is marked working exits 1 and says to run
  `gloss ready`, because the reviewer cannot submit until then.

After approval the session stays approved. Every later `gloss wait` prints
the same approval until the session is closed.

## Discarded comments

If the reviewer approves while they still have comments they never
submitted, the bar asks them to confirm. Confirming deletes those comments:
they are not in the verdict (`comments` is `[]`) and not in the session
afterwards.
