/** The bar's height, and so how far the page is pushed down to make room for it. */
export const BAR_HEIGHT = 44;

/**
 * The bar's change to the page's own layout. Moving `html` down moves
 * everything in normal flow with it; scroll-padding.ts adds the bar's height
 * to the page's own scroll padding, so an anchor jump lands below both. An
 * element pinned to the viewport does not move with `html`; pinned.ts moves
 * those.
 */
export const PAGE_OFFSET = `html{margin-top:${BAR_HEIGHT}px!important}`;

/** Where the bar sheds its labels to fit a phone. */
export const NARROW = '(max-width: 640px)';

/** The line the status takes under the bar on a phone, where the bar has no room for it. */
export const STATUS_HEIGHT = 24;

/**
 * Added to PAGE_OFFSET while that line is showing, so it pushes the page down
 * rather than covering it. The matching scroll padding is scroll-padding.ts's,
 * which has to add it to whatever the page sets rather than replace it.
 */
export const STATUS_OFFSET = `@media ${NARROW}{html{margin-top:${BAR_HEIGHT + STATUS_HEIGHT}px!important}}`;

/**
 * Reeve's dark palette, from reeve/packages/web/src/index.css, so the bar
 * reads as the same family of tool.
 */
const INK = '#0e1116';
const PANEL = '#161b22';
const EDGE = '#262d38';
const TEXT = '#e6edf3';
const MUTED = '#8b949e';
const SKY = '#38bdf8';
const EMERALD = '#34d399';

/**
 * Everything inside the shadow root. `:host` starts from `all: initial`, with
 * `!important` so a page rule such as `* { box-sizing: … }` or one aimed at
 * custom elements cannot reach the host either; an important declaration in a
 * shadow tree beats one from the page.
 */
export const BAR_STYLES = `
:host {
  all: initial !important;
  display: block !important;
  position: fixed !important;
  top: 0 !important;
  left: 0 !important;
  right: 0 !important;
  height: ${BAR_HEIGHT}px !important;
  z-index: 2147483647 !important;
}
* { box-sizing: border-box; }
.bar {
  display: flex;
  align-items: center;
  gap: 10px;
  height: ${BAR_HEIGHT}px;
  padding: 0 12px;
  background: ${INK};
  border-bottom: 1px solid ${EDGE};
  color: ${TEXT};
  font: 13px/1.35 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
  -webkit-font-smoothing: antialiased;
}
.mark { font-weight: 700; letter-spacing: -0.01em; white-space: nowrap; }
.round {
  padding: 1px 9px;
  border: 1px solid ${EDGE};
  border-radius: 999px;
  color: ${MUTED};
  font-size: 12px;
  white-space: nowrap;
}
textarea {
  flex: 0 1 400px;
  min-width: 60px;
  height: 30px;
  margin: 0;
  padding: 6px 10px;
  border: 1px solid ${EDGE};
  border-radius: 6px;
  background: ${PANEL};
  color: ${TEXT};
  font: inherit;
  line-height: 16px;
  resize: none;
  overflow: hidden;
  /* One line that scrolls sideways, like an input, but a Shift+Enter newline is kept. */
  white-space: pre;
}
textarea::placeholder { color: ${MUTED}; }
textarea:focus { outline: none; border-color: ${SKY}; }
button {
  height: 30px;
  margin: 0;
  padding: 0 12px;
  border: 1px solid ${EDGE};
  border-radius: 6px;
  background: ${PANEL};
  color: ${TEXT};
  font: inherit;
  font-weight: 500;
  white-space: nowrap;
  cursor: pointer;
}
button:not(:disabled):hover { border-color: #3a4350; }
button:focus-visible { outline: 2px solid ${SKY}; outline-offset: 1px; }
button:disabled, textarea:disabled { opacity: 0.45; cursor: not-allowed; }
[hidden] { display: none !important; }
.toggle[aria-expanded="true"] { border-color: ${SKY}; }
/* Drawn rather than a ▴, which some system fonts render as a dot. */
.caret {
  display: none;
  margin-left: 6px;
  vertical-align: 2px;
  border-left: 3.5px solid transparent;
  border-right: 3.5px solid transparent;
  border-bottom: 5px solid currentColor;
}
.toggle[aria-expanded="true"] .caret { display: inline-block; }
.spacer { flex: 1; }
.submit { color: ${SKY}; border-color: rgba(56, 189, 248, 0.35); background: rgba(56, 189, 248, 0.08); }
.approve { color: ${EMERALD}; border-color: rgba(52, 211, 153, 0.3); background: rgba(52, 211, 153, 0.07); }
.error { color: #f87171; font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
.status {
  flex: 0 1 auto;
  min-width: 0;
  max-width: 520px;
  color: ${MUTED};
  font-size: 12px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.status[data-phase="reviewing"] { color: ${TEXT}; }
.status[data-phase="working"] { color: ${SKY}; }
.status[data-phase="approved"] { color: ${EMERALD}; font-weight: 600; }
/* A pulse while Claude has the round, so the bar reads as busy at a glance. */
.status[data-phase="working"]::before {
  content: "";
  display: inline-block;
  width: 7px;
  height: 7px;
  margin-right: 7px;
  vertical-align: 1px;
  border-radius: 50%;
  background: currentColor;
  animation: gloss-pulse 1.2s ease-in-out infinite;
}
@keyframes gloss-pulse { 50% { opacity: 0.25; } }
.error:empty, .status:empty { display: none; }
.confirm { display: flex; align-items: center; gap: 8px; min-width: 0; }
.confirm-text { color: ${TEXT}; font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }

.list {
  position: fixed;
  top: ${BAR_HEIGHT + 4}px;
  width: min(420px, calc(100vw - 16px));
  max-height: calc(100vh - ${BAR_HEIGHT + 16}px);
  overflow-y: auto;
  margin: 0;
  padding: 0;
  list-style: none;
  background: ${PANEL};
  border: 1px solid ${EDGE};
  border-radius: 8px;
  box-shadow: 0 12px 32px rgba(0, 0, 0, 0.45);
  color: ${TEXT};
  font: 13px/1.35 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
  -webkit-font-smoothing: antialiased;
}
.list[hidden] { display: none; }
.item { display: flex; align-items: flex-start; gap: 12px; padding: 10px 12px 10px 13px; }
.item + .item { border-top: 1px solid ${EDGE}; }
.body { flex: 1; white-space: pre-wrap; overflow-wrap: anywhere; }
.delete {
  flex: none;
  width: 20px;
  height: 20px;
  padding: 0;
  border: none;
  background: none;
  color: ${MUTED};
  font-size: 16px;
  line-height: 20px;
  font-weight: 400;
}
.delete:hover { color: ${TEXT}; }
.empty { padding: 10px 13px; color: ${MUTED}; }
.group {
  padding: 12px 13px 4px;
  border-top: 1px solid ${EDGE};
  color: ${MUTED};
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.04em;
  text-transform: uppercase;
}
.group + .item { border-top: none; }
.sent { color: ${MUTED}; }
.summary { padding: 10px 13px; border-bottom: 1px solid ${EDGE}; background: rgba(56, 189, 248, 0.06); white-space: pre-wrap; }
.summary .label { display: block; margin-bottom: 3px; color: ${SKY}; font-size: 11px; font-weight: 600; }

@media ${NARROW} {
  .bar { gap: 6px; padding: 0 8px; }
  .round, .toggle-label { display: none; }
  button { padding: 0 8px; }
  /* The prompt needs the whole bar: the comment box steps aside while it is up. */
  .confirming textarea, .confirming .add, .confirming .toggle { display: none; }
  .confirming .spacer { display: none; }
  .confirm { flex: 1; justify-content: flex-end; }
  .confirm-text { white-space: normal; font-size: 11px; line-height: 13px; }
  /* No room in the bar itself: the status hangs just under it, a line of its own. */
  .status {
    position: fixed;
    top: ${BAR_HEIGHT}px;
    left: 0;
    right: 0;
    max-width: none;
    height: ${STATUS_HEIGHT}px;
    padding: 0 10px;
    line-height: ${STATUS_HEIGHT - 1}px;
    background: ${INK};
    border-bottom: 1px solid ${EDGE};
  }
}
`;
