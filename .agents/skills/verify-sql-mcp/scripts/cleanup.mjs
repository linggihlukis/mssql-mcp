// cleanup.mjs — stop only the MCP processes this run started, remove only this run's scratch state.
//
// Cleanup never removes evidence: the JSON-RPC frames, tool results, stderr, and read-backs are the
// proof and must survive teardown. There is no test data on the server to remove, because this
// skill never writes anything there.
//
// A pid alone is not proof of identity — Windows recycles pids. Each recorded pid is therefore
// checked against the spawn time recorded in the run's frames. When that check cannot be made
// (process inspection is denied in some sandboxes), the pid is reported as `unverified` and the
// script exits non-zero rather than claiming a clean teardown it cannot prove.
//
// Usage:
//   node .agents/skills/verify-sql-mcp/scripts/cleanup.mjs            # newest run
//   node .agents/skills/verify-sql-mcp/scripts/cleanup.mjs --run <dir>

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs, resolveRunDir } from './lib.mjs';

function recordedProcesses(runDir) {
  const processes = new Map();
  for (const name of fs.readdirSync(runDir)) {
    if (!name.startsWith('frames-') || !name.endsWith('.jsonl')) continue;
    for (const line of fs.readFileSync(path.join(runDir, name), 'utf8').split(/\r?\n/)) {
      if (!line.trim()) continue;
      let frame;
      try {
        frame = JSON.parse(line);
      } catch {
        continue;
      }
      const { pid, spawnedAt, event } = frame?.payload ?? {};
      if (event === 'spawn' && Number.isInteger(pid)) {
        processes.set(pid, { pid, spawnedAt: spawnedAt ?? null, session: frame.session });
      }
    }
  }
  return [...processes.values()];
}

/**
 * Establish liveness without spawning anything: signal 0 throws ESRCH when the pid is free.
 * Only a live pid needs the expensive identity check, and in a sandboxed run most pids are already
 * gone by the time cleanup runs.
 */
function liveness(pid) {
  try {
    process.kill(pid, 0);
    return 'alive';
  } catch (error) {
    if (error.code === 'ESRCH') return 'gone';
    if (error.code === 'EPERM') return 'alive';
    return 'unknown';
  }
}

/**
 * Ask Windows when the pid started. `CommandLine` is unreadable in some sandboxes, but `StartTime`
 * via Get-Process is available; a start time at or after the recorded spawn time means this is the
 * process the run created, not a recycled pid.
 */
function inspect(pid) {
  try {
    const output = execFileSync(
      'powershell',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `$p = Get-Process -Id ${Number(pid)} -ErrorAction SilentlyContinue;
if ($null -eq $p) { 'GONE' } else { 'ALIVE|' + $p.ProcessName + '|' + $p.StartTime.ToUniversalTime().ToString('o') }`,
      ],
      { encoding: 'utf8', timeout: 20_000 },
    ).trim();
    if (output === 'GONE') return { state: 'gone' };
    const [marker, processName, startTime] = output.split('|');
    if (marker !== 'ALIVE') return { state: 'unknown', raw: output };
    return { state: 'alive', processName, startTime };
  } catch (error) {
    return { state: 'unknown', raw: error.message };
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const runDir = resolveRunDir(args.run);
  const result = {
    runDir,
    stopped: [],
    alreadyGone: [],
    unverified: [],
    skipped: [],
    removed: [],
    kept: [],
  };

  for (const recorded of recordedProcesses(runDir)) {
    if (liveness(recorded.pid) === 'gone') {
      result.alreadyGone.push(recorded.pid);
      continue;
    }
    const seen = inspect(recorded.pid);
    if (seen.state === 'gone') {
      result.alreadyGone.push(recorded.pid);
      continue;
    }
    if (seen.state === 'unknown') {
      result.unverified.push({ ...recorded, reason: seen.raw });
      continue;
    }
    // Alive. Only stop it when the start time proves it is the process this run spawned.
    const recordedStart = recorded.spawnedAt ? Date.parse(recorded.spawnedAt) : null;
    const actualStart = Date.parse(seen.startTime);
    const sameProcess =
      recordedStart !== null && Number.isFinite(actualStart) && actualStart >= recordedStart - 2000;
    if (!sameProcess) {
      result.unverified.push({
        ...recorded,
        reason: `start time ${seen.startTime} predates the recorded spawn; refusing to signal a recycled pid`,
      });
      continue;
    }
    try {
      process.kill(recorded.pid, 'SIGTERM');
      result.stopped.push({ pid: recorded.pid, processName: seen.processName });
    } catch (error) {
      result.skipped.push({ pid: recorded.pid, reason: error.code || error.message });
    }
  }

  // Scratch state created by this run only. Evidence files are never in this list.
  for (const scratch of ['mcp-data']) {
    const target = path.join(runDir, scratch);
    if (fs.existsSync(target)) {
      fs.rmSync(target, { recursive: true, force: true });
      result.removed.push(scratch);
    }
  }

  for (const name of fs.readdirSync(runDir)) {
    if (['.json', '.jsonl', '.log', '.md'].some((extension) => name.endsWith(extension))) {
      result.kept.push(name);
    }
  }

  const clean = result.unverified.length === 0 && result.skipped.length === 0;
  result.clean = clean;
  fs.writeFileSync(path.join(runDir, 'cleanup.json'), `${JSON.stringify(result, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.stdout.write(`\nevidence kept in ${runDir}\n`);
  if (!clean) {
    process.stdout.write(
      '\nNOT CLEAN: some pids could not be verified. Re-run cleanup with process-inspection access, or stop them by pid manually.\n',
    );
    process.exitCode = 1;
  }
}

main();
