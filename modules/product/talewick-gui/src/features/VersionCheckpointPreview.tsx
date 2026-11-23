import {useState} from 'react';
import {Button} from '@/components/base/buttons/button';
import {Input} from '@/components/base/input/input';
import type {CheckpointPlan} from '@/model/version-checkpoint';

type Props = {
  plan: CheckpointPlan;
  blocked: boolean;
  pendingCount: number;
  onConfirm: (label: string) => boolean;
  onCancel: () => void;
};

export function VersionCheckpointPreview({plan, blocked, pendingCount, onConfirm, onCancel}: Props) {
  const [label, setLabel] = useState('');
  const [failed, setFailed] = useState(false);

  return <section aria-label="保存命名存稿" className="flex flex-col gap-4">
    <h3 className="font-story text-title-3-medium">保存命名存稿</h3>
    <p className="wrap-anywhere text-body-regular">作品「{plan.title}」，共 {plan.chapters.length} 章。</p>
    <p className="text-body-2-regular text-text-secondary">本次只记录当前已保存的书名与正文。待审建议共 {pendingCount} 条，继续保留在当前作品中，不包含在存稿里。旧存稿会保留。</p>
    <form className="flex flex-col gap-4" onSubmit={event => {
      event.preventDefault();
      const name = label.trim();
      if (blocked || !name) return;
      setFailed(!onConfirm(name));
    }}>
      <Input label="存稿名称" placeholder="例如：交给试读前" value={label} onChange={setLabel}/>
      {blocked
        ? <p role="alert" className="text-body-medium text-text-error-primary">预览已过期，请取消保存并重新打开。</p>
        : failed && <p role="alert" className="text-body-medium text-text-error-primary">来源已变化，请取消保存并重新打开。</p>}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" variant="primary" disabled={blocked || !label.trim()}>确认保存存稿</Button>
        <Button type="button" variant="secondary" onClick={onCancel}>取消保存存稿</Button>
      </div>
    </form>
  </section>;
}
