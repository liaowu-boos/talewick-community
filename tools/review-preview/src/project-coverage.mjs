import assert from 'node:assert/strict';

/** The count covers only mappings from sealed stages. Unsealed work has no known citation denominator. */
export function projectCoverage(terminal, sealed, totalStages, exactMappings) {
  assert(Number.isInteger(sealed) && sealed >= 0 && sealed <= totalStages);
  assert(Number.isInteger(exactMappings) && exactMappings >= 0);
  const complete = terminal.status === 'complete';
  if (complete) assert.equal(sealed, totalStages, 'Complete terminal lacks all seals');
  return {
    process: {
      status: complete ? 'complete' : sealed > 0 ? 'partial' : 'failed',
      completed: sealed,
      total: totalStages,
      summary: `实际终态 ${terminal.status}，模型请求 ${terminal.externalRequests} 次。`,
    },
    citations: {
      total: complete ? exactMappings : null,
      checked: exactMappings,
      exact: exactMappings,
      failures: [],
      originalPassed: complete && exactMappings > 0 ? true : null,
      summary: `逐条比对已封存阶段中的 ${exactMappings} 处引文映射。未封存部分不计入。`,
    },
  };
}
