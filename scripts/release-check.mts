#!/usr/bin/env node
/**
 * Release verification: one command that proves the repo is shippable.
 *
 * Runs the full gate sequence every release must pass, in order, with
 * clear pass/fail output and a non-zero exit on any failure:
 *
 *   1. install (frozen lockfile)
 *   2. typecheck (every workspace package)
 *   3. tests (every suite)
 *   4. api production smoke (boot + /health + search round-trip)
 *   5. dashboard build (static output compiles)
 *   6. docs build (site renders, link integrity)
 *   7. docker image build + container health probe (when docker is up)
 *
 * Usage: node scripts/release-check.mts [--skip-docker]
 */

import { spawnSync } from 'node:child_process';

const ROOT = new URL('..', import.meta.url).pathname;
const skipDocker = process.argv.includes('--skip-docker');

interface Step {
  name: string;
  run: () => number;
}

function sh(command: string, args: string[], options: { cwd?: string; env?: Record<string, string> } = {}): number {
  const result = spawnSync(command, args, {
    cwd: options.cwd ? `${ROOT}${options.cwd}` : ROOT,
    env: { ...process.env, ...(options.env ?? {}) },
    stdio: 'inherit',
  });
  return result.status ?? 1;
}

const steps: Step[] = [
  { name: 'install (frozen)', run: () => sh('pnpm', ['install', '--frozen-lockfile']) },
  { name: 'typecheck (all packages)', run: () => sh('pnpm', ['typecheck']) },
  { name: 'tests (all suites)', run: () => sh('pnpm', ['test']) },
  {
    name: 'api smoke (boot + health + search)',
    run: () => sh('node', ['scripts/smoke-api.mts']),
  },
  {
    name: 'dashboard build',
    run: () =>
      sh('pnpm', ['--filter', '@querynx/dashboard', 'exec', 'next', 'build'], {
        env: { NEXT_TELEMETRY_DISABLED: '1' },
      }),
  },
  {
    name: 'docs build + tests',
    run: () => sh('pnpm', ['--filter', '@querynx/docs', 'test']),
  },
];

if (!skipDocker) {
  steps.push({
    name: 'docker image + container probe',
    run: () =>
      sh('bash', [
        '-c',
        'docker build -f infrastructure/docker/Dockerfile.api -t querynx-release-check:latest . && ' +
          'docker run -d --name querynx-release-check -p 13001:3001 -e HOST=0.0.0.0 querynx-release-check:latest && ' +
          'ok=1; for i in $(seq 1 30); do curl -sf http://127.0.0.1:13001/health >/dev/null && break; sleep 2; done; ' +
          'curl -sf http://127.0.0.1:13001/health || ok=0; docker rm -f querynx-release-check >/dev/null 2>&1; [ "$ok" = 1 ]',
      ]),
  });
}

console.log(`\n=== Querynx release check (${steps.length} gates) ===\n`);
let failed = 0;

for (const [index, step] of steps.entries()) {
  const label = `[${index + 1}/${steps.length}] ${step.name}`;
  console.log(`\n>>> ${label}`);
  const start = Date.now();
  const code = step.run();
  const seconds = ((Date.now() - start) / 1000).toFixed(0);
  if (code === 0) {
    console.log(`<<< PASS ${label} (${seconds}s)`);
  } else {
    console.error(`<<< FAIL ${label} (exit ${code}, ${seconds}s)`);
    failed++;
    break; // gates are ordered; later gates depend on earlier ones
  }
}

console.log('');
if (failed > 0) {
  console.error('RELEASE CHECK: FAILED');
  process.exit(1);
}
console.log('RELEASE CHECK: ALL GATES PASSED');
