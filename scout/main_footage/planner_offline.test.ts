import assert from 'node:assert/strict';
import { plannerIsOffline } from './plan_job.ts';

const offline = process.env.THOTH_PLANNER_OFFLINE;
const testContext = process.env.THOTH_PLANNER_TEST_CONTEXT;

try {
  process.env.THOTH_PLANNER_OFFLINE = '1';
  delete process.env.THOTH_PLANNER_TEST_CONTEXT;
  assert.throws(
    () => plannerIsOffline(),
    /THOTH_PLANNER_OFFLINE is test-only; refusing degraded planning outside test context/,
    'a stray .env flag must stop instead of silently degrading a production plan',
  );

  process.env.THOTH_PLANNER_TEST_CONTEXT = '1';
  assert.equal(plannerIsOffline(), true, 'the explicit test context retains offline acceptance');
} finally {
  if (offline === undefined) delete process.env.THOTH_PLANNER_OFFLINE;
  else process.env.THOTH_PLANNER_OFFLINE = offline;
  if (testContext === undefined) delete process.env.THOTH_PLANNER_TEST_CONTEXT;
  else process.env.THOTH_PLANNER_TEST_CONTEXT = testContext;
}

console.log('ok planner_offline');
