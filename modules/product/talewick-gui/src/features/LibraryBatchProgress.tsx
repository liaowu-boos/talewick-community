import { useId } from 'react';
import { ProgressBar } from 'react-aria-components';
import { Button } from '@/components/base/buttons/button';
import { cx } from '@/utils/cx';
import { batchActionAllowed, batchCountsText, batchPublicMessage, batchStateLabel, type BatchActionKey, type BatchResponse } from '@/model/library';

export function LibraryBatchProgress({ state, expanded, onExpand, pending, stale, onAction }: {
  state: BatchResponse; expanded: boolean; onExpand: () => void; pending: readonly string[]; stale: boolean;
  onAction: (key: BatchActionKey) => void;
}) {
  const detailsId = useId();
  const { queue, actions } = state;
  if (!queue.registrations.length && !queue.batches.length) return null;
  const activeRun = pending.includes('run') || actions.run?.status === 'running';
  const recovering = pending.includes('recover') || actions.recover?.status === 'running';
  const cancelling = pending.some(key => key.startsWith('cancel:')) || Object.entries(actions).some(([key, action]) => key.startsWith('cancel:') && action?.status === 'running');
  const actionErrors = Object.entries(actions).filter(([, action]) => action?.status === 'failed');
  return <section aria-label="批量拆解任务" className="my-6 flex flex-col gap-3 rounded-3xl border border-border-button-default bg-background-primary-default p-4">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div><h3 className="font-story text-headline-medium">批量拆解</h3><p className="text-body-regular text-text-secondary">已完成并复核 {queue.checked} / {queue.targetCount} 篇</p></div>
      <div className="flex flex-wrap items-center gap-2">
        {queue.queued > 0 && <Button size="small" disabled={!batchActionAllowed(state, 'run', pending, stale)} onClick={() => onAction('run')}>{activeRun ? '正在拆解' : '开始已登记作品'}</Button>}
        <Button variant="ghost" size="small" aria-expanded={expanded} aria-controls={detailsId} onClick={onExpand}>{expanded ? '收起批量进度' : '展开批量进度'}</Button>
      </div>
    </div>
    <p className="text-body-2-regular text-text-secondary">{queue.drainStatus === 'failed' || queue.drainStatus === 'pending' ? '尚未确认后台结束' : batchStateLabel(queue, activeRun, cancelling)}。{queue.queued > 0 && !activeRun ? '登记只保存原文，点击开始后才会分析。' : '完成数仅包含通过复核且可检索的分析；待修订不计入完成。'}</p>
    {(queue.halted || queue.recoveryRequired > 0) && <p role="status" className="text-body-regular text-text-error-primary">任务已暂停，请核对已保存结果。失败记录保留，恢复核对不会自动重试失败。</p>}
    {(queue.drainStatus === 'failed' || queue.drainStatus === 'pending') && <p role="status" className="text-body-regular text-text-error-primary">后台尚未确认所有调用结束，请保留服务并核对处理状态。</p>}
    {(queue.closed || queue.requiresReopen) && <p className="text-body-regular text-text-secondary">批量服务已停止接收操作，请重新启动本机服务后核对状态。</p>}
    {recovering && <p role="status" className="text-body-regular">正在核对已保存结果，尚未确认恢复完成……</p>}
    {actions.recover?.status === 'completed' && !recovering && <p className="text-body-2-regular text-text-secondary">上次恢复核对已结束，当前结果见各批进度；失败未自动重试。</p>}
    {actionErrors.map(([key, action]) => <p role="alert" key={key} className="text-body-regular text-text-error-primary">{key === 'run' ? '开始操作' : key === 'recover' ? '恢复核对' : `第 ${queue.registrations.findIndex(batch => batch.batchId === key.slice(7)) + 1} 批取消`}未完成：{batchPublicMessage(action?.error)}</p>)}
    <div id={detailsId} hidden={!expanded} className={cx('flex-col gap-4', expanded ? 'flex' : 'hidden')}>
      <p className="text-body-2-regular text-text-secondary">{batchCountsText(queue)}。每批 10 篇，最多 10 批。</p>
      <ol className="flex flex-col gap-4">
        {queue.registrations.map((registration, index) => {
          const batch = queue.batches.find(value => value.batchId === registration.batchId);
          const key: BatchActionKey = `cancel:${registration.batchId}`;
          const cancelling = pending.includes(key) || actions[key]?.status === 'running';
          return <li key={registration.batchId} className="flex flex-col gap-2 border-t border-separator-border pt-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h4 className="text-body-medium">第 {index + 1} 批 · {batch ? batchStateLabel(batch, activeRun, cancelling) : '登记未完成'}</h4>
              {batch && (batch.queued + batch.running > 0 || batch.recoveryRequired > 0 || cancelling) && <Button size="small" variant="ghost" disabled={!batchActionAllowed(state, key, pending, stale)} onClick={() => onAction(key)}>{cancelling ? '等待取消结束' : `取消第 ${index + 1} 批`}</Button>}
            </div>
            {batch ? <>
              <ProgressBar aria-label={`第 ${index + 1} 批已完成并复核`} value={batch.checked} maxValue={10} className="source-progress">
                {({ percentage }) => <><p className="text-body-2-regular text-text-secondary">完成并复核 {batch.checked} / 10 篇</p><div className="source-progress-track"><div className="source-progress-fill" style={{ width: `${percentage ?? 0}%` }} /></div></>}
              </ProgressBar>
              <p className="text-body-2-regular text-text-secondary">{batchCountsText(batch)}</p>
              {batch.needs_review > 0 && <p className="text-body-2-regular text-text-secondary">待修订分析尚未通过复核；即使原文可检索，也不计为完成。</p>}
              {cancelling && <p role="status" className="text-body-2-regular text-text-secondary">取消已请求，正在等待后台调用结束；已保存结果保留。</p>}
            </> : <p className="text-body-regular text-text-secondary">原文已保存 {registration.saved} / 10 篇，尚未开始。本次选择仍在页面中时可继续登记；刷新后需核对原登记记录。</p>}
          </li>;
        })}
      </ol>
      <div className="flex flex-wrap items-center gap-3"><Button size="small" variant="secondary" disabled={!batchActionAllowed(state, 'recover', pending, stale)} onClick={() => onAction('recover')}>{recovering ? '正在恢复核对' : '恢复核对已保存结果'}</Button><p className="text-body-2-regular text-text-tertiary">只核对保存状态，不自动重试失败，也不开始等待中的作品。</p></div>
    </div>
  </section>;
}
