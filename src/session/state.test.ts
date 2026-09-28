import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import {
  acquireLock,
  liveSession,
  pidAlive,
  readState,
  removeState,
  sessionRef,
  writeState,
  type SessionState,
} from './state.js';

let root: string;
let previousHome: string | undefined;

before(() => {
  root = mkdtempSync(join(tmpdir(), 'gloss-state-'));
  previousHome = process.env.GLOSS_HOME;
  process.env.GLOSS_HOME = join(root, 'home');
});

after(() => {
  if (previousHome === undefined) delete process.env.GLOSS_HOME;
  else process.env.GLOSS_HOME = previousHome;
  rmSync(root, { recursive: true, force: true });
});

function dir(name: string): string {
  const path = join(root, name);
  mkdirSync(path, { recursive: true });
  return path;
}

const state = (values: Partial<SessionState> = {}): SessionState => ({
  pid: process.pid,
  port: 1,
  token: 'secret',
  cwd: '/somewhere',
  name: '',
  url: 'http://127.0.0.1:4400/',
  startedAt: 0,
  ...values,
});

/** A pid that is certainly not running: a child that has already exited. */
function deadPid(): number {
  const child = spawnSync(process.execPath, ['-e', '']);
  assert.ok(child.pid);
  return child.pid;
}

describe('sessionRef', () => {
  test('puts the files under GLOSS_HOME', () => {
    const ref = sessionRef(dir('a'));
    assert.equal(ref.statePath, join(root, 'home', 'sessions', `${ref.id}.json`));
    assert.equal(ref.logPath, join(root, 'home', 'logs', `${ref.id}.log`));
  });

  test('is the same for the same directory, and differs by directory and name', () => {
    const a = dir('a');
    assert.equal(sessionRef(a).id, sessionRef(a).id);
    assert.notEqual(sessionRef(a).id, sessionRef(dir('b')).id);
    assert.notEqual(sessionRef(a).id, sessionRef(a, 'mobile').id);
  });

  test('follows a symlink to the directory it names', () => {
    const real = dir('real');
    const link = join(root, 'link');
    symlinkSync(real, link);
    assert.equal(sessionRef(link).id, sessionRef(real).id);
  });
});

describe('the state file', () => {
  test('reads back what was written', () => {
    const ref = sessionRef(dir('rw'));
    assert.equal(readState(ref), null);
    writeState(ref, state({ port: 5123 }));
    assert.equal(readState(ref)?.port, 5123);
  });

  test('reads a file it cannot make sense of as no session', () => {
    const ref = sessionRef(dir('junk'));
    writeState(ref, state());
    writeFileSync(ref.statePath, '{"pid": "not a number"');
    assert.equal(readState(ref), null);
  });

  test('is removed only by the session that wrote it', () => {
    const ref = sessionRef(dir('owner'));
    writeState(ref, state({ pid: 42 }));
    removeState(ref, 41);
    assert.ok(existsSync(ref.statePath));
    removeState(ref, 42);
    assert.ok(!existsSync(ref.statePath));
  });
});

describe('liveSession', () => {
  test('clears away a file whose process is gone', async () => {
    const ref = sessionRef(dir('stale'));
    writeState(ref, state({ pid: deadPid() }));
    assert.equal(await liveSession(ref), null);
    assert.ok(!existsSync(ref.statePath));
  });

  test('does not trust a live pid that does not answer as a session', async () => {
    const ref = sessionRef(dir('reused-pid'));
    // This process is alive, but nothing on port 1 answers the health check.
    writeState(ref, state());
    assert.equal(await liveSession(ref), null);
    assert.ok(existsSync(ref.statePath));
  });
});

test('pidAlive', () => {
  assert.equal(pidAlive(process.pid), true);
  assert.equal(pidAlive(deadPid()), false);
});

describe('acquireLock', () => {
  test('lets one holder in at a time', async () => {
    const ref = sessionRef(dir('lock'));
    const release = await acquireLock(ref, 0);
    assert.ok(release);
    assert.equal(readFileSync(ref.lockPath, 'utf8'), String(process.pid));
    assert.equal(await acquireLock(ref, 150), null);
    release();
    const again = await acquireLock(ref, 0);
    assert.ok(again);
    again();
  });

  test('takes over a lock whose holder died', async () => {
    const ref = sessionRef(dir('dead-lock'));
    mkdirSync(join(root, 'home', 'sessions'), { recursive: true });
    writeFileSync(ref.lockPath, String(deadPid()));
    const release = await acquireLock(ref, 0);
    assert.ok(release);
    release();
  });

  test('waits out a lock being written rather than stealing it', async () => {
    const ref = sessionRef(dir('empty-lock'));
    mkdirSync(join(root, 'home', 'sessions'), { recursive: true });
    writeFileSync(ref.lockPath, '');
    assert.equal(await acquireLock(ref, 150), null);
    rmSync(ref.lockPath);
  });
});
