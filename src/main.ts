import { close } from './commands/close.js';
import { connect } from './commands/connect.js';
import { installChromium } from './commands/install-chromium.js';
import { login, logout } from './commands/login.js';
import { open } from './commands/open.js';
import { ready } from './commands/ready.js';
import { status } from './commands/status.js';
import { wait } from './commands/wait.js';
import { working } from './commands/working.js';
import { CliError, EXIT, note, print, usageError } from './output.js';
import { runSession } from './session/run.js';
import { VERSION } from './version.js';

const USAGE = `Usage: gloss <command> [options]

  gloss open <url> [--name N] [--live]
      Show <url> in a Chromium window with the Gloss bar across the top, and
      return once it is up. The window stays open, as a session, until it is
      closed. Run again from the same directory, it moves that window to
      <url> rather than opening another. --live starts the session with the
      bar's Live control already on, so a comment goes to the agent as soon
      as it is written rather than waiting for Submit; the bar's own control
      turns it back off.
  gloss status [--name N] [--json]
      Whether this directory has a session: exit 0 if it does, 1 if not.
  gloss close [--name N]
      End the session, and close its window; or, connected to a server,
      disconnect from it.
  gloss connect <server-url> [--name N]
      Take this directory's rounds from a Gloss server elsewhere, such as an
      inbox reviewers write to from their own browsers, rather than from a
      window here (docs/protocol.md). Signs this machine in first if the
      server asks. Then wait, working and ready talk to it, until close.
  gloss login <server-url> / gloss logout <server-url>
      Sign this machine in to, or out of, a Gloss server: login prints a link
      to approve in a browser. GLOSS_TOKEN stands in for a sign-in.
  gloss install-chromium [--with-deps]
      Download the Chromium that Gloss's own Playwright drives, once, into
      Playwright's cache (about 150 MB). --with-deps also installs the
      system libraries it needs on Linux (sudo).
  gloss --version
      Print Gloss's version.

The review loop, for the agent:

  gloss wait [--name N]
      Block until the reviewer submits a round or approves, then print the
      verdict as one JSON document on stdout (docs/verdict.md). Only
      "approved": true is approval. Exit 1, with nothing on stdout, when
      there is no verdict: no session, or it ended while waiting. Asked
      again before \`working\` or \`ready\`, it prints the same round.
      From a server with many reviews, the verdict is version 2, and says
      which review it is: working and ready act on that one.
  gloss working [message] [--name N]
      Say the agent has the round. The bar shows Claude is working, with the
      message, and the reviewer cannot submit or approve.
  gloss ready [summary] [--name N]
      Say the agent is done. The window reloads, the bar shows the summary,
      and the next round is the reviewer's. In live mode, comments written
      while the agent worked go out at once, as the next round. A server
      with no window reloads nothing: the reviewer sees the summary when
      they next open the page.

--name   more than one session from one directory: each name is a session of
         its own.

Sessions are found through state files in $GLOSS_HOME/sessions, where
GLOSS_HOME is ~/.gloss unless set. Each session's output is in
$GLOSS_HOME/logs. Sign-ins are in $GLOSS_HOME/credentials.json.

Exit status is 0 on success, 1 when the command could not do what it was
asked, and 2 for a mistake in the command itself.`;

const COMMANDS: Record<string, (args: string[]) => Promise<void>> = {
  open,
  status,
  close,
  connect,
  login,
  logout,
  'install-chromium': installChromium,
  wait,
  working,
  ready,
  // Not for people: the session process `open` starts. Left out of the usage.
  __session: runSession,
};

async function main(argv: string[]): Promise<void> {
  const [first] = argv;
  if (first === undefined || first === 'help' || first === '--help' || first === '-h') return print(USAGE);
  if (first === 'version' || first === '--version' || first === '-v') return print(VERSION);
  const command = Object.hasOwn(COMMANDS, first) ? COMMANDS[first] : undefined;
  if (!command) throw usageError(`unknown command '${first}'`);
  if (argv.includes('--help') || argv.includes('-h')) return print(USAGE);
  return command(argv.slice(1));
}

try {
  await main(process.argv.slice(2));
} catch (e) {
  if (!(e instanceof CliError)) throw e;
  note(`gloss: ${e.message}`);
  if (e.exitCode === EXIT.usage) note(`\n${USAGE}`);
  process.exitCode = e.exitCode;
}
