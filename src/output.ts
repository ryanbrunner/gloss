/**
 * What `gloss` exits with. `status` answers with these too, so a script can
 * ask whether a session is running without that being a failure worth printing.
 */
export const EXIT = {
  ok: 0,
  /** The command could not do what it was asked: no session, no browser, the session refused. */
  error: 1,
  /** The command line was wrong. The usage text is printed too. */
  usage: 2,
} as const;

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

/**
 * An error meant for whoever is at the terminal: printed as its message alone,
 * with no stack. A usage mistake gets the usage text too.
 */
export class CliError extends Error {
  constructor(
    message: string,
    readonly exitCode: ExitCode = EXIT.error,
  ) {
    super(message);
  }
}

export const usageError = (message: string) => new CliError(message, EXIT.usage);

/** Runs a `parseArgs` call, so an unknown flag or a missing value is a usage error rather than a stack. */
export function parseOrUsage<T>(parse: () => T): T {
  try {
    return parse();
  } catch (e) {
    if ((e as { code?: string }).code?.startsWith('ERR_PARSE_ARGS')) throw usageError((e as Error).message);
    throw e;
  }
}

/**
 * With `--json`, stdout carries the JSON and nothing else, so another tool can
 * parse it whole. Everything said to a person goes through `note`, to stderr.
 */
export function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

export function print(line = ''): void {
  process.stdout.write(`${line}\n`);
}

export function note(line: string): void {
  process.stderr.write(`${line}\n`);
}
