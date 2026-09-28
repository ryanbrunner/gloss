---
name: gloss
description: "Open a running web app (a dev server URL) in the Gloss review window, then apply the reviewer's feedback round by round until they approve. Use only when the user invokes /gloss or directly asks to review a page with Gloss."
allowed-tools: Bash(gloss:*), Bash(command -v gloss), Bash(cat:*), Read, Edit, Write, Glob, Grep
argument-hint: "<url>"
---

# Review a page with Gloss

Gloss shows the page in a Chromium window with a feedback bar across the top.
The reviewer writes comments in the bar and presses **Submit** to send you a
round, or **Approve** when they are done. You apply each round, and the bar
tells them you are working and then shows them what changed.

Gloss never changes code itself. You do, between `gloss working` and
`gloss ready`.

## Step 1: Check Gloss is installed

```bash
command -v gloss
```

If there is nothing, stop and tell the user to run `npm link` in their Gloss
checkout (and `npx playwright install chromium` once).

## Step 2: Open the page

Pass `$ARGUMENTS` through. If it is empty, ask the user for the dev server URL.

```bash
gloss open $ARGUMENTS
```

Relay what it prints:

> **"Gloss is open on <url>. Add comments in the bar and press Submit to send
> them to me, or Approve when you are happy."**

## Step 3: Wait for the reviewer

**CRITICAL: run this with `run_in_background: true`.** The reviewer can take
longer than a foreground command is allowed to run.

```bash
gloss wait > "${TMPDIR:-/tmp}/gloss-verdict.json"
```

stdout goes to the file so that nothing else is mixed into it; progress and
errors stay on stderr. **Do not proceed until the background task has
finished.** Do not ask the user to type anything, and do not start another
`gloss wait` while this one is running.

## Step 4: Read the verdict

When the task finishes, note its exit code, then read the file:

```bash
cat "${TMPDIR:-/tmp}/gloss-verdict.json"
```

It is one JSON document:

```json
{ "version": 1, "approved": false, "round": 1, "page": "http://localhost:3000/",
  "comments": [{ "id": "c1", "kind": "general", "body": "The header is too tall",
                 "page": "http://localhost:3000/", "createdAt": 1767000000000,
                 "sentIn": 1, "target": null }] }
```

**The verdict must be explicit.** Stop the loop and tell the user there was
**no verdict** if any of these is true:

- the exit code was not 0 (stderr says why: the window was closed, or the
  session ended)
- the file is empty or is not JSON
- `version` is not `1`

None of those is approval, whatever else you saw. Never treat a missing or
unreadable result as approval.

- `"approved": true` → go to Step 6.
- `"approved": false` → go to Step 5.

## Step 5: Apply the round

**Your next Gloss command must be `gloss working`, not `gloss wait`.** Until
you say you are working, `gloss wait` prints the same round again. If you do
see a `round` you have already handled, skip it rather than applying it twice.

```bash
gloss working "Addressing 3 comments from round 1"
```

The bar now says you are working, and the reviewer cannot submit or approve.

For each comment in `comments`:

1. Understand what it asks for. `page` is where the reviewer was when they
   wrote it.
2. Make the change with Edit. The dev server's own reload picks it up.
3. Keep a one-line note of what you did.

If you finish some and want the bar to say where you are, run `gloss working`
again with a new message. Then, once everything is in:

```bash
gloss ready "Moved shipping above the total; linked Cart (2) to /cart"
```

This reloads the Gloss window, shows your summary in the bar, and hands the
next round to the reviewer. Keep the summary to a sentence or two, one clause
per comment.

Tell the user: **"Changes are in. Check them in the Gloss window, then Submit
more comments or Approve."** Then go back to Step 3.

If `gloss wait` ever exits 1 saying to run `gloss ready`, you skipped it: run
`gloss ready` with your summary, then wait again.

## Step 6: Approved

```bash
gloss close
```

Summarise for the user what changed across all the rounds.

## Notes

- `kind` is `"general"` for now. A comment with `"kind": "pinned"` has a
  `target` object saying which element it is about; treat it as a comment
  about that element.
- More than one review from one directory: add `--name <n>` to every
  `gloss` command.
- The verdict format is documented in `docs/verdict.md` in the Gloss repo.
