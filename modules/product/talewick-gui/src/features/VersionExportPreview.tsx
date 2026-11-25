import {useState} from 'react';
import {Button} from '@/components/base/buttons/button';
import {Input} from '@/components/base/input/input';
import type {VersionExportPlan} from '@/model/version-export';

type Props = {
  plan: VersionExportPlan;
  blocked: boolean;
  onDownload: (format: 'txt' | 'md', missingTitle?: string) => boolean;
  onCancel: () => void;
};

export function VersionExportPreview({plan, blocked, onDownload, onCancel}: Props) {
  const [missingTitle, setMissingTitle] = useState('');
  const [failed, setFailed] = useState(false);
  const needsTitle = !plan.version.title?.trim();
  const disabled = blocked || (needsTitle && !missingTitle.trim());

  function download(format: 'txt' | 'md') {
    if (disabled) return;
    setFailed(!onDownload(format, needsTitle ? missingTitle.trim() : undefined));
  }

  return <section aria-label="导出所选存稿" className="flex flex-col gap-4">
    <h3 className="font-story text-title-3-medium">导出所选存稿</h3>
    <p className="wrap-anywhere text-body-regular">存稿「{plan.version.label}」，共 {plan.version.chapters.length} 章。</p>
    <p className="wrap-anywhere text-body-regular">{needsTitle ? '存稿未记录书名' : `存稿书名「${plan.version.title}」`}</p>
    <p className="text-body-2-regular text-text-secondary">只导出所选存稿正文，不包含修改建议或评阅报告，不修改当前稿或原存稿。</p>
    {needsTitle && <div className="flex flex-col gap-2">
      <Input label="导出书名" value={missingTitle} onChange={setMissingTitle}/>
      <p className="text-body-2-regular text-text-secondary">请填写导出书名，仅用于本次导出，不会补写存稿。</p>
    </div>}
    {blocked
      ? <p role="alert" className="text-body-medium text-text-error-primary">所选存稿已变化或已移除，请返回存稿并重新打开导出。</p>
      : failed && <p role="alert" className="text-body-medium text-text-error-primary">未能下载，请返回存稿并重新打开导出。</p>}
    <div className="flex flex-wrap gap-2">
      <Button type="button" variant="primary" disabled={disabled} onClick={() => download('md')}>下载 Markdown</Button>
      <Button type="button" variant="secondary" disabled={disabled} onClick={() => download('txt')}>下载 TXT</Button>
      <Button type="button" variant="ghost" onClick={onCancel}>返回存稿</Button>
    </div>
  </section>;
}
