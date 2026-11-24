import {useState} from 'react';
import {Button} from '@/components/base/buttons/button';
import {Input} from '@/components/base/input/input';
import type {ProjectTitlePlan} from '@/model/project-title';

type Props = {
  plan: ProjectTitlePlan;
  blocked: boolean;
  onConfirm: (title: string) => boolean;
  onCancel: () => void;
};

export function ProjectTitlePreview({plan, blocked, onConfirm, onCancel}: Props) {
  const [title, setTitle] = useState(plan.title);
  const [failed, setFailed] = useState(false);
  const name = title.trim();
  const disabled = blocked || !name || name === plan.title.trim();

  return <section aria-label="修改作品书名" className="flex flex-col gap-4">
    <h3 className="font-story text-title-3-medium">修改作品书名</h3>
    <p className="wrap-anywhere text-body-regular">原书名「{plan.title}」，共 {plan.chapters.length} 章。</p>
    <p className="text-body-2-regular text-text-secondary">确认后会保存改名前、改名后的两份存稿，正文和待审意见会保留。</p>
    <p className="text-body-2-regular text-text-secondary">旧评阅报告须从对应存稿查看，不代表新书名版本通过评阅。</p>
    <form className="flex flex-col gap-4" onSubmit={event => {
      event.preventDefault();
      if (disabled) return;
      setFailed(!onConfirm(name));
    }}>
      <Input label="新书名" value={title} onChange={setTitle}/>
      {blocked
        ? <p role="alert" className="text-body-medium text-text-error-primary">来源已变化或有任务正在运行，请取消改名，待任务结束后重新打开。</p>
        : failed && <p role="alert" className="text-body-medium text-text-error-primary">未能修改书名，请取消改名并重新打开。</p>}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" variant="primary" disabled={disabled}>确认修改书名</Button>
        <Button type="button" variant="secondary" onClick={onCancel}>取消改名</Button>
      </div>
    </form>
  </section>;
}
