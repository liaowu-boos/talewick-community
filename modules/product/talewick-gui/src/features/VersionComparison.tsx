import {Fragment, useMemo, useState} from 'react';
import {Button} from '@/components/base/buttons/button';
import {compareManuscripts} from '@/model/version-comparison';
import {diffVersionText} from '@/model/version-text-diff';
import type {Chapter, Version} from '@/model/types';

type Labels = {beforeLabel: string; afterLabel: string};
type BodyProps = Labels & {before?: Chapter; after?: Chapter};

function BodyComparison({before, after, beforeLabel, afterLabel}: BodyProps) {
  const oldText = before?.body ?? '';
  const newText = after?.body ?? '';
  const segments = useMemo(() => diffVersionText(oldText, newText), [oldText, newText]);

  function side(label: string, chapter: Chapter, kind: 'delete' | 'insert') {
    return <section aria-label={`${label}正文`} className="min-w-0">
      <h5 className="mb-2 text-body-2-medium">{label}</h5>
      {chapter.body.length === 0 ? <p className="text-caption-1-regular text-text-secondary">正文为空</p> :
        <p className="whitespace-pre-wrap break-words font-story text-headline-regular">{segments.map((part, index) => {
          if (part.kind === 'equal') return <Fragment key={index}>{part.text}</Fragment>;
          if (part.kind !== kind) return null;
          return kind === 'delete' ? <del key={index}>{part.text}</del> : <ins key={index}>{part.text}</ins>;
        })}</p>}
    </section>;
  }

  return <div className="grid gap-4 md:grid-cols-2">
    {before && side(beforeLabel, before, 'delete')}
    {after && side(afterLabel, after, 'insert')}
  </div>;
}

function ChapterText(props: BodyProps) {
  const [expanded, setExpanded] = useState(false);
  const length = Math.max(props.before?.body.length ?? 0, props.after?.body.length ?? 0);
  if (length <= 1200) return <BodyComparison {...props}/>;
  return <details onToggle={event => setExpanded(event.currentTarget.open)}>
    <summary className="cursor-pointer text-body-2-medium">查看整章正文差异</summary>
    {expanded && <div className="mt-3"><BodyComparison {...props}/></div>}
  </details>;
}

type Props = {
  previous: Version;
  current: Chapter[];
  currentTitle?: string;
  compareTitles?: boolean;
  beforeLabel?: string;
  afterLabel?: string;
  onRestoreChapter?: (chapterId: string) => void;
};

export function VersionComparison({previous, current, currentTitle, compareTitles = currentTitle !== undefined, beforeLabel = '历史版本', afterLabel = '当前稿件', onRestoreChapter}: Props) {
  const {titleStatus, orderChanged, chapters} = compareManuscripts(
    {title: previous.title, chapters: previous.chapters}, {title: currentTitle, chapters: current},
  );

  return <section aria-label={`${beforeLabel}与${afterLabel}的版本比较`} className="flex flex-col gap-4">
    <p className="text-body-2-medium">比较方向：从{beforeLabel}到{afterLabel}</p>
    {compareTitles && titleStatus === 'changed' && <p className="text-body-regular">书名变更：<del>{previous.title}</del> → <ins>{currentTitle}</ins></p>}
    {compareTitles && titleStatus === 'unknown' && <p className="text-body-2-regular text-text-secondary">存稿的书名记录不全，无法核对书名。</p>}
    {orderChanged && <p className="text-body-2-medium">章节顺序已调整。</p>}
    {!chapters.length && !orderChanged && <p className="text-body-2-regular text-text-secondary">章节顺序、章名和正文均相同。</p>}
    {chapters.map(({id, before, after, beforeIndex, afterIndex, moved}) => {
      const title = (after ?? before)?.title || '未命名章节';
      return <section key={id} className="tw-manuscript-history-change flex flex-col gap-3">
        <h4 className="font-story text-title-3-medium">{title}</h4>
        {!before && after && <p className="text-body-2-medium">新增章节 · {afterLabel}第 {afterIndex + 1} 章</p>}
        {before && !after && <p className="text-body-2-medium">删除章节 · {beforeLabel}第 {beforeIndex + 1} 章</p>}
        {before && after && before.title !== after.title && <p className="text-body-regular">章节改名：<del>{before.title}</del> → <ins>{after.title}</ins></p>}
        {before && after && moved && <p className="text-body-2-medium">{beforeIndex === afterIndex
          ? `两个版本中均为第 ${afterIndex + 1} 章，与其他章节的相对顺序已变。`
          : <>章节移动：{beforeLabel}第 {beforeIndex + 1} 章 → {afterLabel}第 {afterIndex + 1} 章</>}</p>}
        {before?.body !== after?.body && <ChapterText before={before} after={after} beforeLabel={beforeLabel} afterLabel={afterLabel}/>}
        {onRestoreChapter && before && after && (before.title !== after.title || before.body !== after.body) &&
          <Button type="button" variant="secondary" size="small" className="self-start" onClick={() => onRestoreChapter(id)}>恢复本章</Button>}
      </section>;
    })}
  </section>;
}
