import {Button} from '@/components/base/buttons/button';
import type {ChapterRestorePlan} from '@/model/store';
import {VersionComparison} from './VersionComparison';

type Props = {
  plan: ChapterRestorePlan;
  pendingCount: number;
  onConfirm: () => void;
  onCancel: () => void;
  blocked: boolean;
};

export function ChapterRestorePreview({plan, pendingCount, onConfirm, onCancel, blocked}: Props) {
  return <section aria-label="单章恢复预览" className="flex flex-col gap-4">
    <h3 className="font-story text-title-3-medium">单章恢复预览</h3>
    <p className="text-body-regular">确认后会先备份当前整稿，再用存稿「{plan.versionLabel}」中的章名和正文替换当前章。</p>
    <p className="text-body-2-regular text-text-secondary">书名、章节顺序和其他章节保持原样。{pendingCount > 0
      ? `本章的 ${pendingCount} 条待审意见会保留。`
      : '本章暂无待审意见。'}</p>
    <VersionComparison
      previous={{id: plan.projectId, label: '当前章', date: '', chapters: [plan.current]}}
      current={[plan.source]}
      beforeLabel="当前章"
      afterLabel="来源存稿的章"
    />
    {blocked && <p role="alert" className="text-body-medium text-text-error-primary">预览已过期，请取消恢复并重新选择章节。</p>}
    <div className="flex flex-wrap gap-2">
      <Button type="button" variant="primary" disabled={blocked} onClick={onConfirm}>确认恢复本章</Button>
      <Button type="button" variant="secondary" onClick={onCancel}>取消恢复</Button>
    </div>
  </section>;
}
