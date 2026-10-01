import { build } from 'esbuild';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The bar as one script a page can run, built when it is first asked for
 * rather than ahead of time, so Gloss keeps Reeve's habit of no build step.
 * esbuild is the one tsx already runs on.
 *
 * `session` mounts itself against the Gloss session's binding, in the
 * isolated world ../session/browser.ts runs it in. `demo` mounts nothing on
 * its own: it exposes `GlossDemo.mount(...)` for the demo page to call with a
 * round of its own (a `DemoRound`, from ./transport.ts).
 */
export type BarMode = 'session' | 'demo';

const ENTRIES: Record<BarMode, string> = {
  session: `
    import { mountBar } from './bar.js';
    import { bindingTransport } from './transport.js';
    mountBar(bindingTransport());
  `,
  demo: `
    import { mountBar } from './bar.js';
    import { memoryTransport } from './transport.js';
    export function mount(options) {
      mountBar(memoryTransport(options.round), { listOpen: options.listOpen, confirmOpen: options.confirmOpen });
    }
  `,
};

const built = new Map<BarMode, Promise<string>>();

export function bundleBar(mode: BarMode): Promise<string> {
  let script = built.get(mode);
  if (!script) {
    script = build({
      stdin: { contents: ENTRIES[mode], resolveDir: dirname(fileURLToPath(import.meta.url)), loader: 'ts' },
      bundle: true,
      format: 'iife',
      globalName: mode === 'demo' ? 'GlossDemo' : undefined,
      target: 'chrome120',
      write: false,
      logLevel: 'silent',
    }).then((result) => result.outputFiles[0]!.text);
    built.set(mode, script);
  }
  return script;
}
