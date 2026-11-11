/**
 * Entry point for `db-tool` (out/main/cli.js). The packaged app ships a shim
 * at Contents/Resources/bin/db-tool that runs this file on the app's own
 * Electron binary with ELECTRON_RUN_AS_NODE=1. In development:
 * `pnpm cli <args>`.
 *
 * Must not import 'electron'.
 */
import { createRequire } from 'node:module';
import { run } from './run';

// stdout carries results (or the MCP protocol); any stray library logging goes to stderr.
console.log = console.error;
console.info = console.error;
console.debug = console.error;

function version(): string {
  try {
    // ../../package.json from both src/cli/index.ts and out/main/cli.js.
    return (createRequire(import.meta.url)('../../package.json') as { version: string }).version;
  } catch {
    return '0.0.0';
  }
}

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    process.stdin.on('data', (c: Buffer) => chunks.push(c));
    process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    process.stdin.on('error', reject);
  });
}

const abort = new AbortController();
process.on('SIGINT', () => {
  if (abort.signal.aborted) process.exit(130);
  abort.abort();
});

const argv = process.argv.slice(2);
const code = await run(
  argv,
  {
    stdout: (t) => void process.stdout.write(t),
    stderr: (t) => void process.stderr.write(t),
    stdoutIsTTY: process.stdout.isTTY === true,
    readStdin: process.stdin.isTTY || argv[0] === 'mcp' ? undefined : readStdin,
    env: process.env,
    signal: abort.signal
  },
  {},
  version()
);
process.exitCode = code;
// Driver pools normally close cleanly; don't let a stray handle keep the process alive.
setTimeout(() => process.exit(code), 3000).unref();
