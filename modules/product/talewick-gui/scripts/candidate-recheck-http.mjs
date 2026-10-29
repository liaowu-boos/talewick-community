#!/usr/bin/env node
/** Submit only to an explicitly selected local runtime; --submit may trigger its configured model. */
const argv = process.argv.slice(2);
const option = name => { const index = argv.indexOf(name); return index >= 0 ? argv[index + 1] : undefined; };
const origin = option('--origin') || 'http://127.0.0.1:4322';
const projectId = option('--project');
const sourceTaskId = option('--source-task');
const submit = argv.includes('--submit');
if (!/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(origin) || !/^[\w-]{1,160}$/.test(projectId || '') || !/^[\w-]{1,160}$/.test(sourceTaskId || '')) {
  console.error('Usage: node scripts/candidate-recheck-http.mjs --origin http://127.0.0.1:PORT --project PROJECT_ID --source-task UUID [--submit]');
  process.exitCode = 2;
} else if (!submit) {
  console.log(JSON.stringify({ dryRun: true, method: 'POST', url: `${origin}/api/candidate-rechecks`, body: { projectId, sourceTaskId } }, null, 2));
} else {
  const call = async (url, body) => {
    const response = await fetch(url, { method: body ? 'POST' : 'GET', headers: body ? { 'Content-Type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined });
    const value = await response.json();
    if (!response.ok) throw new Error(value.error || `HTTP ${response.status}`);
    return value;
  };
  try {
    const { task } = await call(`${origin}/api/candidate-rechecks`, { projectId, sourceTaskId });
    console.log(JSON.stringify({ id: task.id, status: task.status, sourceTaskId, candidateSha256: task.candidateSha256 }));
    for (let poll = 0; poll < 600; poll++) {
      await new Promise(resolve => setTimeout(resolve, 2000));
      const { tasks } = await call(`${origin}/api/candidate-rechecks?projectId=${encodeURIComponent(projectId)}`);
      const current = tasks.find(item => item.id === task.id);
      if (!current) throw new Error('任务在本机复查列表中消失。');
      if (!['queued', 'running'].includes(current.status)) {
        console.log(JSON.stringify(current, null, 2));
        process.exitCode = current.status === 'reviewed_no_reported_conflict' ? 0 : 1;
        break;
      }
      if (poll === 599) throw new Error('轮询超时；任务仍保存在服务端，可稍后按 id 查询。');
    }
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
