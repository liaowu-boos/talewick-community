import {useState} from 'react';
import {Button} from '@/components/base/buttons/button';
import {Input} from '@/components/base/input/input';
import type {VersionForkPlan} from '@/model/version-fork';

type Props = {
  plan: VersionForkPlan;
  blocked: boolean;
  onConfirm: (title: string) => boolean;
  onCancel: () => void;
};

export function VersionForkPreview({plan, blocked, onConfirm, onCancel}: Props) {
  const [title, setTitle] = useState(`${plan.fallbackTitle}（副本）`);
  const [failed, setFailed] = useState(false);

  return <section aria-label="从存稿新建作品" className="flex flex-col gap-4">
    <h3 className="font-story text-title-3-medium">从存稿新建作品</h3>
    <p className="wrap-anywhere text-body-regular">来源存稿「{plan.source.label}」，作品「{plan.fallbackTitle}」，共 {plan.source.chapters.length} 章。</p>
    <p className="text-body-2-regular text-text-secondary">复制此存稿正文，原作品不变。旧评阅报告、任务和待审修改不复制。</p>
    <form className="flex flex-col gap-4" onSubmit={event => {
      event.preventDefault();
      const name = title.trim();
      if (blocked || !name) return;
      setFailed(!onConfirm(name));
    }}>
      <Input label="新作品名称" value={title} onChange={setTitle}/>
      {blocked
        ? <p role="alert" className="text-body-medium text-text-error-primary">预览已过期，请取消新建并重新选择存稿。</p>
        : failed && <p role="alert" className="text-body-medium text-text-error-primary">未能新建作品，请取消新建并重新选择存稿。</p>}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" variant="primary" disabled={blocked || !title.trim()}>确认新建作品</Button>
        <Button type="button" variant="secondary" onClick={onCancel}>取消新建</Button>
      </div>
    </form>
  </section>;
}
