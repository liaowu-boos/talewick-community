import {useState} from 'react';
import {Button} from '@/components/base/buttons/button';
import {Input} from '@/components/base/input/input';
import type {Version} from '@/model/types';
import {cx} from '@/utils/cx';
import {formatDate} from '@/features/shared';

type Props = {
  versions: Version[];
  selectedId: string;
  onSelect: (id: string) => void;
};

export function VersionList({versions, selectedId, onSelect}: Props) {
  const [query, setQuery] = useState('');
  const search = query.trim().toLowerCase();
  const visibleVersions = versions.map((version, index) => ({version, number: index + 1})).reverse().filter(({version}) =>
    version.label.toLowerCase().includes(search) || (version.title ?? '').toLowerCase().includes(search));
  const selected = versions.find(version => version.id === selectedId);
  const selectedHidden = selected && !visibleVersions.some(({version}) => version.id === selectedId);
  const latestId = versions.at(-1)?.id;

  return <section aria-label="选择历史版本" className="tw-manuscript-version-list min-w-0">
    <Input label="查找存稿" placeholder="存稿名称或书名" value={query} onChange={setQuery}/>
    {query.length > 0 && <Button type="button" variant="ghost" size="small" className="self-start" onClick={() => setQuery('')}>清除查找</Button>}
    {selectedHidden && <div className="flex flex-col items-start gap-2">
      <p role="status" className="wrap-anywhere text-body-2-regular text-text-secondary">预览仍为所选存稿「{selected.label}」，该存稿未出现在查找结果中。</p>
      <Button type="button" variant="secondary" size="small" onClick={() => setQuery('')}>显示所选存稿</Button>
    </div>}
    {visibleVersions.length === 0 && <p role="status" className="text-body-2-regular text-text-secondary">{versions.length === 0 ? '暂无历史存稿。' : '没有找到匹配的存稿，请尝试其他名称或书名。'}</p>}
    {visibleVersions.map(({version, number}) => <Button
      key={version.id}
      type="button"
      variant="ghost"
      onClick={() => onSelect(version.id)}
      aria-pressed={version.id === selectedId}
      className={cx('tw-manuscript-version-item shrink-0', version.id === selectedId && 'is-selected')}
    >
      <span aria-hidden="true" className="tw-manuscript-version-node"/>
      <span className="flex min-w-0 flex-1 flex-col gap-1 text-left">
        <span className="wrap-anywhere text-body-medium">{version.label}</span>
        <span className="text-caption-2-regular text-text-secondary">存稿 {number}</span>
        <span className="text-caption-1-regular text-text-tertiary">{formatDate(version.date)}</span>
        <span className="text-caption-2-regular text-text-secondary">{version.chapters.length} 章{version.id === latestId ? ' · 最近版本' : ''}</span>
      </span>
    </Button>)}
  </section>;
}
