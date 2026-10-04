/** The bar's height, and so how far the page is pushed down to make room for it. */
export const BAR_HEIGHT = 44;

/**
 * The bar's change to the page's own layout. Moving `html` down moves
 * everything in normal flow with it; scroll-padding.ts adds the bar's height
 * to the page's own scroll padding, so an anchor jump lands below both. An
 * element pinned to the viewport does not move with `html`; pinned.ts moves
 * those. `vh` still measures the whole window; viewport.ts takes OFFSET off
 * the page's `vh` lengths, so it is set alongside the margin it matches.
 */
export const PAGE_OFFSET = `html{margin-top:${BAR_HEIGHT}px!important;--gloss-offset:${BAR_HEIGHT}px!important}`;

/**
 * How far the page is pushed down right now, for a `calc()` in the page's own
 * styles. Nothing, should the page throw PAGE_OFFSET out.
 */
export const OFFSET = 'var(--gloss-offset, 0px)';

/** Where the bar sheds its labels to fit a phone. */
export const NARROW = '(max-width: 640px)';

/** The line the status takes under the bar on a phone, where the bar has no room for it. */
export const STATUS_HEIGHT = 24;

/**
 * Added to PAGE_OFFSET while that line is showing, so it pushes the page down
 * rather than covering it. The matching scroll padding is scroll-padding.ts's,
 * which has to add it to whatever the page sets rather than replace it.
 */
export const STATUS_OFFSET = `@media ${NARROW}{html{margin-top:${BAR_HEIGHT + STATUS_HEIGHT}px!important;--gloss-offset:${BAR_HEIGHT + STATUS_HEIGHT}px!important}}`;

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
const FONT = '-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif';

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
  position: relative;
  z-index: 4;
  display: flex;
  align-items: center;
  gap: 10px;
  height: ${BAR_HEIGHT}px;
  padding: 0 12px;
  background: ${INK};
  border-bottom: 1px solid ${EDGE};
  color: ${TEXT};
  font: 13px/1.35 ${FONT};
  -webkit-font-smoothing: antialiased;
}
.mark { display: flex; align-items: center; }
.mark svg { flex: none; }
/* Interact and Select, as one segmented control. */
.tools { display: flex; flex: none; border: 1px solid ${EDGE}; border-radius: 6px; overflow: hidden; }
.tool {
  display: flex;
  align-items: center;
  gap: 5px;
  height: 28px;
  padding: 0 10px;
  border: none;
  border-radius: 0;
  background: ${PANEL};
  color: ${MUTED};
}
.tool + .tool { border-left: 1px solid ${EDGE}; }
.tool svg { flex: none; }
.tool[aria-pressed="true"] { background: rgba(56, 189, 248, 0.12); color: ${SKY}; }
.tool:not(:disabled):hover { color: ${TEXT}; }
.tool[aria-pressed="true"]:not(:disabled):hover { color: ${SKY}; }
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
.submit, .send { color: ${SKY}; border-color: rgba(56, 189, 248, 0.35); background: rgba(56, 189, 248, 0.08); }
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
  z-index: 5;
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
  font: 13px/1.35 ${FONT};
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
/* A pinned comment: its marker's number, and the element under the comment. */
.num {
  flex: none;
  width: 18px;
  height: 18px;
  border-radius: 50%;
  background: ${SKY};
  color: ${INK};
  font-size: 10px;
  font-weight: 700;
  line-height: 18px;
  text-align: center;
}
.sent .num { background: ${MUTED}; opacity: 0.7; }
.meta { display: block; margin-top: 3px; color: ${MUTED}; font-size: 11px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.summary { padding: 10px 13px; border-bottom: 1px solid ${EDGE}; background: rgba(56, 189, 248, 0.06); white-space: pre-wrap; }
.summary .label { display: block; margin-bottom: 3px; color: ${SKY}; font-size: 11px; font-weight: 600; }

/*
 * Drawn over the page: the outline in Select mode, the numbered markers, and
 * the comment box. Under the bar and the list, which they may slide beneath
 * as the page scrolls; never in the way of the pointer, but for the markers
 * and the box.
 */
.highlight, .marker, .composer { position: fixed; }
.highlight {
  z-index: 1;
  pointer-events: none;
  border: 2px solid ${SKY};
  border-radius: 3px;
  background: rgba(56, 189, 248, 0.1);
}
.highlight.picked { background: rgba(56, 189, 248, 0.16); }
.chip {
  position: absolute;
  left: -2px;
  bottom: calc(100% + 3px);
  display: flex;
  gap: 6px;
  padding: 1px 6px;
  border-radius: 4px;
  background: ${INK};
  color: ${SKY};
  font: 11px/16px ${FONT};
  white-space: nowrap;
}
.chip-tag { font-weight: 600; }
.low .chip { top: 2px; bottom: auto; left: 2px; }
.marker {
  z-index: 2;
  width: 20px;
  height: 20px;
  margin: -10px 0 0 -10px;
  border: 2px solid #fff;
  border-radius: 50%;
  background: ${SKY};
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.35);
  color: ${INK};
  font: 700 10px/16px ${FONT};
  text-align: center;
  cursor: pointer;
}
.marker.sent { background: ${MUTED}; opacity: 0.55; }
.composer {
  z-index: 3;
  width: min(320px, calc(100vw - 16px));
  padding: 10px;
  background: ${PANEL};
  border: 1px solid ${EDGE};
  border-radius: 8px;
  box-shadow: 0 12px 32px rgba(0, 0, 0, 0.45);
  color: ${TEXT};
  font: 13px/1.35 ${FONT};
  -webkit-font-smoothing: antialiased;
}
.composer-heading { margin-bottom: 8px; color: ${MUTED}; font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.composer textarea { display: block; width: 100%; height: 64px; background: ${INK}; white-space: pre-wrap; overflow-y: auto; }
.composer-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 10px; }
/* Out of the session's screenshot of a pinned element, for the moment it takes. */
.capturing { visibility: hidden !important; }

@media ${NARROW} {
  .bar { gap: 6px; padding: 0 8px; }
  .mark, .toggle-label { display: none; }
  button { padding: 0 8px; }
  /* The tools become one icon button, Select, pressed while it is on. */
  .tools { border: none; }
  .tool.interact, .tool-label { display: none; }
  .tool.select { width: 30px; height: 30px; justify-content: center; padding: 0; border: 1px solid ${EDGE}; border-radius: 6px; }
  .confirming .tools { display: none; }
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
