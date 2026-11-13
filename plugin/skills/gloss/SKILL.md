---
name: gloss
description: "Open a running web app (a dev server URL) in the Gloss review window, or wait on the Gloss server this directory is connected to, then apply the reviewers' feedback round by round until they approve. Use only when the user invokes /gloss or directly asks to review a page with Gloss."
allowed-tools: Bash(gloss:*), Bash(command -v gloss), Bash(mktemp:*), Bash(cat:*), Read, Edit, Write, Glob, Grep
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

If there is nothing, stop and tell the user to install it with
`brew install ryanbrunner/tap/gloss`, then run `gloss install-chromium` once.

## Step 2: Open the page

First check whether this directory is connected to a Gloss server, where
reviewers comment on the site from their own browsers rather than in a
window here:

```bash
gloss status --json
```

If it prints `"remote": true`, **do not run `gloss open`**. Tell the user:

> **"Connected to <url>. Waiting for the next round from its reviewers."**

then make the verdict file as below and go to Step 3. Everything after this
works the same, except where a step says **Connected**.

Otherwise, pass `$ARGUMENTS` through. If it is empty, ask the user for the
dev server URL.

```bash
gloss open $ARGUMENTS
```

Relay what it prints:

> **"Gloss is open on <url>. Add comments in the bar and press Submit to send
> them to me, or Approve when you are happy."**

Then make a file of this review's own for the verdicts, and remember the path
it prints. Every later step uses that path, written below as `<verdict-file>`.
A fixed path would be shared with every other review on the machine.

```bash
mktemp -t gloss-verdict.XXXXXX
```

## Step 3: Wait for the reviewer

**CRITICAL: run this with `run_in_background: true`.** The reviewer can take
longer than a foreground command is allowed to run.

```bash
gloss wait > <verdict-file>
```

stdout goes to the file so that nothing else is mixed into it; progress and
errors stay on stderr. The `>` empties the file first, so a wait that fails
leaves it empty rather than holding the last round. **Do not proceed until the background task has
finished.** Do not ask the user to type anything, and do not start another
`gloss wait` while this one is running.

## Step 4: Read the verdict

When the task finishes, note its exit code, then read the file:

```bash
cat <verdict-file>
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
- `version` is not `1`, or, **connected**, not `1` or `2`

None of those is approval, whatever else you saw. Never treat a missing or
unreadable result as approval.

- `"approved": true` → go to Step 6.
- `"approved": false` → go to Step 5.

**Connected**, the verdict is usually version 2: the same, plus `review`,
which review of the server's this round belongs to, and an `author` on each
comment, who wrote it. Rounds of different reviews can arrive one after
another; each is a round of its own review.

## Step 5: Apply the round

**Your next Gloss command must be `gloss working`, not `gloss wait`.** Until
you say you are working, `gloss wait` prints the same round again. If you do
see a `round` you have already handled (**connected**: the same `review` and
`round`), skip it rather than applying it twice.

```bash
gloss working "Addressing 3 comments from round 1"
```

The bar now says you are working, and the reviewer cannot submit or approve.

For each comment in `comments`:

1. Understand what it asks for. `page` is where the reviewer was when they
   wrote it.
2. Make the change with Edit. The dev server's own reload picks it up.
   **Connected**, the reviewer is on a deployed site, so nothing they see
   changes until your change is deployed: work on a branch, and commit or
   open a pull request as the user would want.
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

**Connected**, `gloss ready` reloads nothing: it posts the summary, which the
reviewer sees the next time they open the page. Say in the summary where the
change is (the branch or pull request) and that it shows once deployed.
Tell the user: **"Posted the summary for review <review>. The reviewer sees
it next time they open the page; the change shows once it is deployed."**
Then go back to Step 3.

If `gloss wait` ever exits 1 saying to run `gloss ready`, you skipped it: run
`gloss ready` with your summary, then wait again.

## Step 6: Approved

```bash
gloss close
```

Summarise for the user what changed across all the rounds.

**Connected**, an approval ends that one review, not the connection, and
other reviewers may still send rounds. **Do not run `gloss close`.**
Summarise what changed in that review, then ask the user whether to keep
waiting for more rounds (go back to Step 3) or stop. Run `gloss close` only
if they ask to disconnect this directory from the server.

## Notes

- `kind` is `"general"` for now. A comment with `"kind": "pinned"` has a
  `target` object saying which element it is about; treat it as a comment
  about that element.
- More than one review from one directory: add `--name <n>` to every
  `gloss` command.
- The verdict format is documented in `docs/verdict.md` in the Gloss repo.
- To connect a directory to a server, the user runs
  `gloss connect <server-url>` once (it may print a sign-in link to approve
  in a browser). Do not run it yourself unless they ask.
- The reviewer can turn on **Live** in the bar, or the session can be opened
  with `gloss open --live`. It changes nothing about this loop: comments
  can still arrive while you are `working`, they still wait for the next
  `gloss wait`, and `round` still never repeats. The only difference you may
  notice is that `gloss wait` can return the instant you run it right after
  `gloss ready`, because a comment written while you were busy went out
  automatically the moment you said you were ready.
