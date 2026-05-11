// Temporary script to commit changes without a shell
// Run with: node _git-commit.mjs
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { cwd } from 'node:process';
import { unlink } from 'node:fs/promises';

const exec = promisify(execFile);
const dir = '/home/ura/data/runs/soZdl1m_zOaWk55Bvvqv8/worktree';

async function run(cmd, args, opts = {}) {
  const { stdout, stderr } = await exec(cmd, args, { cwd: dir, ...opts });
  if (stderr) process.stderr.write(stderr);
  return stdout;
}

try {
  console.log('cwd:', cwd());

  // Step 2: Check git status
  const statusOut = await run('git', ['status', '--porcelain']);
  console.log('=== Git status ===');
  console.log(statusOut || '(clean)');

  // Step 3: Stage the 3 files
  await run('git', ['add',
    'packages/core/src/pipeline/runner.ts',
    'packages/core/src/__tests__/reproduce-bec214-stall-detection.test.ts',
    'CLAUDE.md'
  ]);
  console.log('Staged 3 files.');

  // Step 4: Commit with the exact message
  const msg = `feat(runner): add checkForStalledRuns() stall detection (BEC-214)

Implements runner-level stall detection for pipeline runs that
have had no stage-boundary activity updates for more than the
configured threshold (default 30 min).

Changes:
- Add checkForStalledRuns(), startStalledRunDetection(), and
  stopStalledRunDetection() public methods to PipelineRunner
- Add stallThresholdMs and stallCheckIntervalMs to
  PipelineRunnerConfig (defaults: 30 min / 60 s)
- Wire startStalledRunDetection() into recoverStuckRuns() so the
  polling loop starts automatically at server startup
- Add getActiveWork import from coordination.js
- Replace reproduce gap-detection test with full integration tests
  covering ACs 1-3, 5, and 6
- Document new config params in CLAUDE.md

Detection uses active_work.updatedAt as the activity signal.
When a run's last stage boundary is older than stallThresholdMs,
the run is cancelled via requestStop('cancel'), DB status set to
'failed' with errorMessage='stalled process', active_work row
removed, and activeRuns slot freed.

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>`;

  const commitOut = await run('git', ['commit', '-m', msg]);
  console.log('=== Commit ===');
  console.log(commitOut);

  // Step 1: Delete this temp file (now that commit is done)
  await unlink(new URL(import.meta.url));
  console.log('Deleted _git-commit.mjs');

  // Step 5: pnpm build
  console.log('=== Running pnpm build ===');
  try {
    const buildOut = await run('pnpm', ['build'], { timeout: 120000 });
    console.log(buildOut);
    console.log('BUILD SUCCESS');
  } catch (buildErr) {
    console.error('BUILD FAILED:', buildErr.message);
    if (buildErr.stdout) console.log(buildErr.stdout);
    if (buildErr.stderr) console.error(buildErr.stderr);
  }

  // Step 6: Run the new tests
  console.log('=== Running vitest for BEC-214 tests ===');
  try {
    const testOut = await run(
      'npx', ['vitest', 'run', 'src/__tests__/reproduce-bec214-stall-detection.test.ts'],
      { cwd: dir + '/packages/core', timeout: 120000 }
    );
    console.log(testOut);
    console.log('TESTS DONE');
  } catch (testErr) {
    console.error('TEST RUN ERROR:', testErr.message);
    if (testErr.stdout) console.log(testErr.stdout);
    if (testErr.stderr) console.error(testErr.stderr);
  }

  // Step 7: Show last 3 commits
  const logOut = await run('git', ['log', '--oneline', '-3']);
  console.log('=== Last 3 commits ===');
  console.log(logOut);

} catch (err) {
  console.error('Error:', err.message);
  if (err.stdout) console.log('stdout:', err.stdout);
  if (err.stderr) console.error('stderr:', err.stderr);
  process.exit(1);
}
