import {useRef, useState} from 'react';
import {Button} from '@/components/base/buttons/button';
import {Select, SelectItem} from '@/components/base/select/select';
import type {Version} from '@/model/types';

export function SavedManuscriptPreview({version}: {version: Version}) {
  const [index, setIndex] = useState(0);
  const [located, setLocated] = useState(false);
  const headings = useRef<Array<HTMLHeadingElement | null>>([]);
  const navigation = useRef<HTMLElement | null>(null);
  const count = version.chapters.length;

  function locate(nextIndex: number) {
    if (!Number.isInteger(nextIndex) || nextIndex < 0 || nextIndex >= count) return;
    setIndex(nextIndex);
    setLocated(true);
    // Let the select finish closing before moving focus into the manuscript.
    requestAnimationFrame(() => {
      const heading = headings.current[nextIndex];
      if (!heading) return;
      const body = heading.closest('.tw-manuscript-version-body');
      const topPadding = body ? parseFloat(getComputedStyle(body).paddingTop) || 0 : 0;
      heading.focus({preventScroll: true});
      if (body) {
        // Scroll only the reading pane: scrollIntoView also moves clipped dialog
        // ancestors, hiding the version list and dismissing the chapter menu.
        const offset = (navigation.current?.getBoundingClientRect().height ?? 0) + topPadding + 16;
        body.scrollTo({top: body.scrollTop + heading.getBoundingClientRect().top - body.getBoundingClientRect().top - offset, behavior: 'instant'});
      }
    });
  }

  return <>
    <h3 className="mb-6 font-story text-display-4-regular">{version.title ?? '存稿未记录书名'}</h3>
    <section ref={navigation} aria-label="存稿章节导航" className="sticky top-0 z-10 mb-6 flex flex-col gap-3 bg-background-primary-default">
      <Select
        aria-label="跳转存稿章节"
        popoverIsNonModal={false}
        selectedKey={count > 0 ? String(index) : null}
        isDisabled={count === 0}
        placeholder="暂无章节"
        onSelectionChange={key => { if (key !== null) locate(Number(key)); }}
        triggerClassName="w-full"
      >
        {version.chapters.map((chapter, chapterIndex) => {
          const label = `${chapterIndex + 1}. ${chapter.title.trim() || '未命名章节'}`;
          return <SelectItem key={chapterIndex} id={String(chapterIndex)} textValue={label}>{label}</SelectItem>;
        })}
      </Select>
      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="secondary" disabled={count === 0 || index === 0} onClick={() => locate(index - 1)}>上一章</Button>
        <Button type="button" variant="secondary" disabled={index >= count - 1} onClick={() => locate(index + 1)}>下一章</Button>
      </div>
      <p role="status" className="text-body-2-regular text-text-secondary">{located ? `已定位第 ${index + 1} / ${count} 章` : `共 ${count} 章`}</p>
    </section>
    {version.chapters.map((chapter, chapterIndex) => <section key={chapterIndex} className="mb-8">
      <h4
        ref={element => { headings.current[chapterIndex] = element; }}
        tabIndex={-1}
        aria-label={chapter.title.trim() ? undefined : `第 ${chapterIndex + 1} 章（未命名章节）`}
        className="min-h-8 mb-4 font-story text-title-3-medium outline-none focus-visible:ring-2 focus-visible:ring-border-focus-ring"
      >{chapter.title}</h4>
      <p className="whitespace-pre-wrap font-story text-headline-regular text-text-secondary">{chapter.body}</p>
    </section>)}
  </>;
}
