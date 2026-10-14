import {manuscriptFingerprint} from '../../runtime/checks.mjs';

const scenario = (id, chapters) => ({
  id, chapters,
  report: {manuscriptSha256: manuscriptFingerprint(chapters), summary: '固定离线复核输入。', issues: []},
});

// Independently written public fixtures. No private manuscript excerpts or model output.
export const continuityChainScenarios = Object.freeze([
  scenario('synthetic-timeline-conflict', [
    {id:'ch-1', title:'约定', body:'周一，管理员写下：三天之内归还展厅，也就是周三。'},
    {id:'ch-3', title:'次日', body:'第二天早上，两位志愿者开始撤下展板。'},
    {id:'ch-4', title:'同日下午', body:'当天的通知仍写着后天下午归还展厅，通知没有变更过。'},
    {id:'ch-6', title:'再过一夜', body:'第二天上午，两位志愿者继续整理展板。'},
    {id:'ch-9', title:'又过一夜', body:'第三天早上，双方按照最初的周三约定签字。'},
  ]),
  scenario('synthetic-handover-conflict', [
    {id:'ch-10', title:'归还展厅', body:'交接前，展厅里只剩展架和一箱工具。\n\n管理员说：“两间空的，没有留物。”\n\n管理员先签，收回全部钥匙；清单不接受遗留物。\n\n天黑以后，志愿者才把展架和工具搬出展厅。'},
  ]),
  scenario('explicit-reschedule-counterexample', [
    {id:'a', title:'原约', body:'周一，管理员说：“原定周三归还展厅。”'},
    {id:'b', title:'改期', body:'周二双方书面改期：归还改到周五，周三不再办理。'},
    {id:'c', title:'回忆', body:'她想起十年前的周三也归还过一间展厅，那是另一次活动。'},
    {id:'d', title:'履行', body:'三天后，周五下午三点，双方按新约完成归还。'},
  ]),
  scenario('temporary-key-counterexample', [
    {id:'a', title:'临时借用', body:'志愿者把备用钥匙临时交给布展队，约定六点归还，自己保留主钥匙和出入权。清单写明展架由下一组接收。'},
    {id:'b', title:'正式归还', body:'六点，布展队归还备用钥匙。下一组签收展架，双方这才移交展厅和全部钥匙。'},
  ]),
  scenario('insufficient-date-boundary', [
    {id:'a', title:'没有起点', body:'管理员留言：“后天再来。”'},
    {id:'b', title:'没有连接', body:'第二天，走廊仍然亮着灯。'},
  ]),
  scenario('unwritten-handoff-boundary', [
    {id:'a', title:'早先', body:'上午，主钥匙在小禾手里。'},
    {id:'b', title:'后来', body:'三天后，小江用主钥匙打开展厅。'},
  ]),
]);

// Expectations are protocol-test metadata, never sent as model input.
export const continuityChainExpectedResults = Object.freeze({
  'synthetic-timeline-conflict':'contradiction',
  'synthetic-handover-conflict':'contradiction',
  'explicit-reschedule-counterexample':'explained',
  'temporary-key-counterexample':'explained',
  'insufficient-date-boundary':'unknown',
  'unwritten-handoff-boundary':'unknown',
});

export const getContinuityChainScenario = id => {
  const found = continuityChainScenarios.find(item => item.id === id);
  if (!found) throw new Error(`unknown continuity scenario: ${id}`);
  return structuredClone(found);
};
