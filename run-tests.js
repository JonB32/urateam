#!/usr/bin/env node
/**
 * Shell-environment bootstrap shim for running pnpm test when the SHELL
 * environment variable is unset or points to a non-existent binary (e.g.
 * in minimal Alpine/BusyBox containers where only /bin/sh is available).
 *
 * This script is intentionally minimal — it exists solely to unblock
 * `pnpm test` in those environments. Normal CI and developer machines should
 * invoke `pnpm test` directly.
 */
const { execSync } = require('child_process');
const path = require('path');

// Use the directory containing this script as the working directory so the
// script is portable regardless of where it is invoked from.
const cwd = path.resolve(__dirname);

// Provide a sensible fallback shell so execSync can spawn child processes.
// Prefer the existing SHELL if it looks like an executable path; otherwise
// fall back to /bin/sh (available on all POSIX systems, including BusyBox).
if (!process.env.SHELL || !process.env.SHELL.startsWith('/')) {
  process.env.SHELL = '/bin/sh';
}

console.log('Running test suite...\n');
console.log('Working directory:', cwd);
console.log('Shell:', process.env.SHELL, '\n');

try {
  const output = execSync('pnpm test', {
    cwd,
    encoding: 'utf-8',
    stdio: 'pipe',
  });
  console.log(output);
  console.log('\n✅ Tests completed successfully!');
} catch (error) {
  console.log(error.stdout || '');
  console.error('\n❌ Test execution failed:');
  console.error(error.stderr || error.message);
  process.exit(1);
}
