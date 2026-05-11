#!/usr/bin/env node
/**
 * Test runner for BEC-211 convergence detection tests.
 * This script runs the unit tests and reproduce tests for the deep-review convergence fix.
 */

import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Run vitest with specific test files
const testFiles = [
  'packages/core/src/__tests__/convergence.test.ts',
  'packages/core/src/__tests__/bec-211-reproduce.test.ts',
];

console.log('🧪 BEC-211 Test Runner');
console.log('='.repeat(60));
console.log('Running convergence detection tests...\n');

// Spawn vitest process
const vitest = spawn('pnpm', ['exec', 'vitest', 'run', ...testFiles], {
  cwd: __dirname,
  stdio: 'inherit',
  shell: true,
});

vitest.on('close', (code) => {
  console.log('\n' + '='.repeat(60));
  if (code === 0) {
    console.log('✅ All tests passed!');
  } else {
    console.log(`❌ Tests failed with exit code ${code}`);
  }
  process.exit(code);
});

vitest.on('error', (err) => {
  console.error('Failed to start vitest:', err);
  process.exit(1);
});
