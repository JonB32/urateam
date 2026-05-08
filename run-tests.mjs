#!/usr/bin/env node
// Test runner for BEC-170 verification

import { spawn } from 'child_process';
import { resolve } from 'path';

const cwd = process.cwd();
console.log(`Running tests from: ${cwd}\n`);

// Run the test command
const child = spawn('pnpm', ['test'], {
  cwd,
  stdio: 'inherit',
  shell: '/bin/bash'
});

child.on('close', (code) => {
  process.exit(code);
});

child.on('error', (err) => {
  console.error('Failed to run tests:', err);
  process.exit(1);
});
