#!/usr/bin/env node
const { execSync } = require('child_process');

// Set SHELL environment variable
process.env.SHELL = '/bin/bash';

console.log('Running test suite for BEC-167 verification...\n');

try {
  const output = execSync('pnpm test', {
    cwd: '/home/ura/data/runs/luSvuTE5bovSq0qdolh_O/worktree',
    encoding: 'utf-8',
    stdio: 'pipe'
  });
  console.log(output);
  console.log('\n✅ Tests completed successfully!');
} catch (error) {
  console.log(error.stdout || '');
  console.error('\n❌ Test execution failed:');
  console.error(error.stderr || error.message);
  process.exit(1);
}
