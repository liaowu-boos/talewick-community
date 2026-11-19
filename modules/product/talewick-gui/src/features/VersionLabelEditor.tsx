import {useState} from 'react';
import {Button} from '@/components/base/buttons/button';
import {Input} from '@/components/base/input/input';
import type {Version} from '@/model/types';

interface Props {
  version: Version;
  onRename: (versionId: string, label: string, expectedLabel: string) => boolean;
}

export function VersionLabelEditor({version, onRename}: Props) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(version.label);
  const [expectedLabel, setExpectedLabel] = useState(version.label);
  const [error, setError] = useState('');
  const stale = expectedLabel !== version.label;
  if (!editing) return <Button type="button" size="small" variant="secondary" onClick={() => {
    setName(version.label);
    setExpectedLabel(version.label);
    setError('');
    setEditing(true);
  }}>命名存稿</Button>;

  return <form aria-label="命名存稿" className="mb-4 flex flex-col gap-2" onSubmit={event => {
    event.preventDefault();
    if (!name.trim() || stale) return;
    if (onRename(version.id, name, expectedLabel)) setEditing(false);
    else setError('存稿已更新或已移除，请取消后重新选择。');
  }}>
    <Input label="存稿名称" value={name} onChange={setName} autoFocus />
    {stale && <p role="alert" className="text-body-2-regular text-text-error-primary">名称已被更新，请取消后重新命名。</p>}
    {error && <p role="alert" className="text-body-2-regular text-text-error-primary">{error}</p>}
    <div className="flex flex-wrap gap-2">
      <Button type="submit" size="small" disabled={!name.trim() || stale}>保存名称</Button>
      <Button type="button" size="small" variant="secondary" onClick={() => setEditing(false)}>取消命名</Button>
    </div>
  </form>;
}
