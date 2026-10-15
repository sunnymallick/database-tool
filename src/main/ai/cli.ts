/**
 * Locating and probing the `claude` binary the Agent SDK drives, plus the
 * environment and working directory every AI subprocess gets.
 */
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, sep } from 'node:path';
import { dataDir } from '../paths';

/**
 * Environment for the CLI: the app's environment minus anything that marks
 * it as running inside another Claude Code session (the app may be launched
 * from one), which would otherwise change how the child CLI behaves.
 */
export function sanitizedEnv(base: NodeJS.ProcessEnv = process.env): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(base)) {
    if (value === undefined) continue;
    if (key === 'CLAUDECODE' || key.startsWith('CLAUDE_CODE_')) continue;
    // Per-session markers a parent Claude Code session exports to its children.
    if (key === 'CLAUDE_PID' || key === 'CLAUDE_EFFORT') continue;
    out[key] = value;
  }
  out.CLAUDE_AGENT_SDK_CLIENT_APP = 'database-tool';
  return out;
}

/** Empty, stable working directory for the CLI (`--resume` finds sessions by cwd). */
export function aiWorkspaceDir(): string {
  const dir = join(dataDir(), 'ai-workspace');
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Package names the SDK tries for its native binary, in its own order. */
function bundledCandidates(platform = process.platform, arch = process.arch): string[] {
  const base = '@anthropic-ai/claude-agent-sdk';
  const exe = platform === 'win32' ? '.exe' : '';
  const pkgs =
    platform === 'linux' ? [`${base}-linux-${arch}`, `${base}-linux-${arch}-musl`] : [`${base}-${platform}-${arch}`];
  return pkgs.map((p) => `${p}/claude${exe}`);
}

/**
 * Inside a packaged app the binary resolves into app.asar, which cannot be
 * executed; electron-builder's asarUnpack copies it next to the archive.
 */
export function unpackedPath(path: string): string {
  const marker = `app.asar${sep}`;
  return path.includes(marker) ? path.replace(marker, `app.asar.unpacked${sep}`) : path;
}

/** The SDK's bundled native binary, or null when the platform package is missing. */
export function bundledCliPath(): string | null {
  const require = createRequire(import.meta.url);
  for (const candidate of bundledCandidates()) {
    try {
      const resolved = unpackedPath(require.resolve(candidate));
      if (existsSync(resolved)) return resolved;
    } catch {
      // try the next candidate
    }
  }
  return null;
}

export interface ResolvedCli {
  path: string;
  source: 'bundled' | 'configured';
  /**
   * Pass as `pathToClaudeCodeExecutable`. Unset for the bundled binary in a
   * dev/unpackaged run so the SDK resolves it itself.
   */
  explicitPath?: string;
}

export function resolveCli(configuredPath: string): ResolvedCli | { error: string } {
  const configured = configuredPath.trim();
  if (configured) {
    if (!existsSync(configured)) {
      return {
        error: `The Claude CLI path in Settings does not exist: ${configured}. Fix it or clear it to use the bundled CLI.`
      };
    }
    return { path: configured, source: 'configured', explicitPath: configured };
  }
  const bundled = bundledCliPath();
  if (!bundled) {
    return {
      error: `The bundled Claude CLI for ${process.platform}-${process.arch} is missing. Reinstall the app, or set the path to an installed \`claude\` in Settings.`
    };
  }
  return {
    path: bundled,
    source: 'bundled',
    explicitPath: bundled.includes(`app.asar.unpacked${sep}`) ? bundled : undefined
  };
}

interface ExecResult {
  stdout: string;
  stderr: string;
  error: (Error & { code?: unknown; killed?: boolean }) | null;
}

function run(path: string, args: string[], timeoutMs: number): Promise<ExecResult> {
  return new Promise((resolve) => {
    execFile(
      path,
      args,
      { timeout: timeoutMs, env: sanitizedEnv() as NodeJS.ProcessEnv, cwd: aiWorkspaceDir(), maxBuffer: 1 << 20 },
      (error, stdout, stderr) => resolve({ stdout: String(stdout), stderr: String(stderr), error })
    );
  });
}

export interface CliProbe {
  version: string | null;
  error?: string;
  loggedIn: boolean | null;
  authMethod?: string;
  subscriptionType?: string;
}

/** `claude --version` then `claude auth status --json`, each with a timeout. */
export async function probeCli(path: string, timeoutMs = 10_000): Promise<CliProbe> {
  const ver = await run(path, ['--version'], timeoutMs);
  if (ver.error && !ver.stdout.trim()) {
    const reason = ver.error.killed ? `timed out after ${timeoutMs / 1000}s` : ver.error.message;
    return { version: null, loggedIn: null, error: `The Claude CLI at ${path} did not respond to --version (${reason}).` };
  }
  const version = /(\d+\.\d+\.\d+[\w.-]*)/.exec(ver.stdout)?.[1] ?? (ver.stdout.trim() || null);

  const auth = await run(path, ['auth', 'status', '--json'], timeoutMs);
  try {
    const parsed = JSON.parse(auth.stdout) as { loggedIn?: unknown; authMethod?: unknown; subscriptionType?: unknown };
    return {
      version,
      loggedIn: typeof parsed.loggedIn === 'boolean' ? parsed.loggedIn : null,
      authMethod: typeof parsed.authMethod === 'string' ? parsed.authMethod : undefined,
      subscriptionType: typeof parsed.subscriptionType === 'string' ? parsed.subscriptionType : undefined
    };
  } catch {
    // Older CLIs have no `auth status`; the first turn reports login problems instead.
    return { version, loggedIn: null };
  }
}
