import assert from 'node:assert/strict';
import { productionPlannerProviders } from './plan_job.ts';

const offline = process.env.THOTH_PLANNER_OFFLINE;
const testContext = process.env.THOTH_PLANNER_TEST_CONTEXT;

try {
  process.env.THOTH_PLANNER_OFFLINE = '1';
  process.env.THOTH_PLANNER_TEST_CONTEXT = '1';
  assert.throws(
    () => productionPlannerProviders(import.meta.dirname),
    /planner_offline_environment_not_supported/,
    'production configuration must reject both former environment flags',
  );
} finally {
  if (offline === undefined) delete process.env.THOTH_PLANNER_OFFLINE;
  else process.env.THOTH_PLANNER_OFFLINE = offline;
  if (testContext === undefined) delete process.env.THOTH_PLANNER_TEST_CONTEXT;
  else process.env.THOTH_PLANNER_TEST_CONTEXT = testContext;
}

console.log('ok planner_offline');
