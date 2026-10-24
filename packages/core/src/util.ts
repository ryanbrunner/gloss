/** Playwright errors carry a whole essay; the first line is the useful part. */
export function firstLine(cause: unknown): string {
  const text = cause instanceof Error ? cause.message : String(cause);
  return text.split('\n')[0] ?? text;
}
