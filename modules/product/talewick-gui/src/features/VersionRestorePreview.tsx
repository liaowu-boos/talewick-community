import {Button} from '@/components/base/buttons/button';
import type {VersionRestorePlan} from '@/model/store';
import {VersionComparison} from './VersionComparison';

type Props = {
  plan: VersionRestorePlan;
  blocked: boolean;
  onConfirm: () => void;
  onCancel: () => void;
};

export function VersionRestorePreview({plan, blocked, onConfirm, onCancel}: Props) {
  const targetTitle = plan.source.title || plan.current.title;

  return <section aria-label="整稿恢复预览" className="flex flex-col gap-4">
    <h3 className="font-story text-title-3-medium">整稿恢复预览</h3>
    <p className="wrap-anywhere text-body-regular">确认后会先备份当前整稿，再恢复存稿「{plan.source.label}」中的稿件。</p>
    {!plan.source.title && <p className="wrap-anywhere text-body-2-regular text-text-secondary">来源存稿未记录书名，恢复后沿用当前书名「{plan.current.title}」。</p>}
    <p className="text-body-2-regular text-text-secondary">已有修改建议及处理记录共 {plan.pendingEdits.length} 条将清除。恢复后进入阅读模式。</p>
    <VersionComparison
      previous={{id: plan.projectId, label: '当前稿', date: '', ...plan.current}}
      current={plan.source.chapters}
      currentTitle={targetTitle}
      compareTitles
      beforeLabel="当前稿"
      afterLabel="来源存稿"
    />
    {blocked && <p role="alert" className="text-body-medium text-text-error-primary">预览已过期，请取消恢复并重新选择存稿。</p>}
    <div className="flex flex-wrap gap-2">
      <Button type="button" variant="primary" disabled={blocked} onClick={onConfirm}>确认恢复整稿</Button>
      <Button type="button" variant="secondary" onClick={onCancel}>取消恢复</Button>
    </div>
  </section>;
}
