# Gloss

Review a running web app in a browser with a feedback bar across the top, and
hand what you wrote to Claude.

`gloss open <url>` opens the page in a Chromium window with the Gloss bar over
it. The bar collects the round's comments. The window stays open as a
session, so the bar can keep showing where things stand while Claude works;
later commands talk to that running session rather than starting another.

This is the first piece: the session, the window and the bar's general
comments. Submitting a round, waiting on Claude and approving come later, so
Submit and Approve are placeholders for now.

## Install

Node 22.12 or later.

```sh
npm install
npx playwright install chromium   # once: about 150 MB
npm link                          # optional: puts `gloss` on your PATH
```

Without `npm link`, run it as `node bin/gloss.js …` or `npm run gloss -- …`.

## Commands

```
gloss open <url> [--name N]    show <url> in the Gloss window, starting a session if there is none
gloss status [--name N] [--json]   exit 0 and say where the session is, or exit 1 if there is none
gloss close [--name N]         end the session and close its window
```

`gloss open` returns as soon as the window is up (within 15 seconds) and
prints the session's address. Run it again from the same directory and it
moves the same window to the new URL. Closing the window ends the session too.

There is one session per working directory. `--name` gives a directory more
than one.

### Where things live

- `~/.gloss/sessions/<id>.json`: the running session's pid, port and token.
  The id is a hash of the directory and `--name`. It is outside the repo, so
  a session never dirties a worktree.
- `~/.gloss/logs/<id>.log`: the session process's output.

Set `GLOSS_HOME` to move both.

### The session API

The session serves a small HTTP API on `127.0.0.1` only. Every request needs
the token from the state file:

```sh
state=~/.gloss/sessions/<id>.json
curl -H "Authorization: Bearer $(jq -r .token $state)" \
  "http://127.0.0.1:$(jq -r .port $state)/api/state"
```

| Route | |
| --- | --- |
| `GET /api/health` | `{ok, pid, url}`: the page the window is on now |
| `GET /api/state` | `{round, comments: [{id, body, createdAt}]}` |
| `POST /api/navigate` | `{url}`: move the window |
| `POST /api/close` | end the session |

## The bar

- Type a comment and press Enter or Add. Shift+Enter adds a new line.
- **Comments (n)** opens the list, where each comment can be deleted.
- Comments belong to the session, not the page, so they survive a reload and
  every tab shows the same list.
- The bar lives in a shadow root on one `<gloss-bar>` element on `<html>`. Page
  CSS cannot reach into it and its CSS cannot leak out. The one change to the
  page's own styles is `html { margin-top: 44px }`, which pushes the page down
  below the bar.

### Known gaps

- A `position: fixed; top: 0` header does not move down and sits under the
  bar. A sticky header starts below the bar but slides under it once you
  scroll. Layouts sized to `100vh` overflow by 44px.
- The window is Chrome for Testing, not your own browser: it has no profile,
  logins or extensions.

## Why Playwright, not a proxy or an iframe

To pin comments to elements later on, the bar needs to reach the page's DOM.
A cross-origin iframe can't do that, and `X-Frame-Options` or a CSP can refuse
framing altogether. That leaves two choices: a proxy that injects the bar
into the HTML it serves, or a browser that injects it for us. Gloss drives
Chromium with Playwright, and registers the bar with `addInitScript` and
`exposeBinding` on the browser context:

- **The page is untouched.** It loads from its real origin. A proxy would
  have to decompress and rewrite HTML and absolute URLs, relay the dev
  server's HMR websocket, strip CSP and frame headers, and keep cookies and
  redirects from escaping to the real origin.
- **A strict CSP doesn't stop it.** Init scripts run whatever the page's CSP
  says. The bar's styles are constructed stylesheets rather than `<style>`
  tags, and it talks to the session through the exposed binding rather than
  `fetch`, so neither `style-src` nor `connect-src` gets in the way.
- **It follows you.** New tabs, client-side navigation and full reloads all
  get the bar again.
- **HTTPS dev hosts load**, with `ignoreHTTPSErrors`, as in Reeve's screenshots.

The cost is the Chromium download and a window that isn't your everyday
browser. If Chromium is missing, `gloss open` exits 1 and says to run
`npx playwright install chromium`.

## Development

```sh
npm test              # unit tests
npm run typecheck
npm run dev -- -port 4400
npx tsx scripts/spikes/open-check.ts   # end to end, headless; needs Chromium
npx tsx scripts/spikes/nav-check.ts    # links, forms, client nav, X-Frame-Options: DENY
```

`npm run dev` serves a fixture storefront to point `gloss open` at. It also
reads `--port` and `PORT`. Query flags make each state of the bar reachable
by URL, using the same bar with its comments kept in the page:

| URL | |
| --- | --- |
| `/` | the storefront, no bar |
| `/?gloss` | the bar, empty |
| `/?gloss&seed=2&list` | two comments, with the list open |
| `/?fixed` | a `position: fixed` header |
| `/?fullheight` | an app shell sized to `100vh`, the shop scrolling inside it |
| `/?csp` | served with a strict Content-Security-Policy |

Two environment variables exist for the spike: `GLOSS_HEADLESS=1` runs the
session's Chromium headless, and `GLOSS_CDP_PORT` opens a DevTools port on it
so the spike can look inside the window.
