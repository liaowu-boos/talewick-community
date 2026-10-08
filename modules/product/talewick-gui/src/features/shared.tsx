import { useId, type ComponentProps, type ReactElement, type ReactNode } from 'react';
import { Dialog, Focusable, Heading, Modal, ModalOverlay, TextArea } from 'react-aria-components';
import { RiCloseLine } from '@remixicon/react';
import { IconButton } from '@/components/base/buttons/icon-button';
import { TextField } from '@/components/base/input/input';
import { Label } from '@/components/base/input/label';
import { HintText } from '@/components/base/input/hint-text';
import { Tooltip, TooltipTrigger } from '@/components/base/tooltip/tooltip';
import { cx } from '@/utils/cx';

declare global { interface Window { TALEWICK_ASSETS?: Record<string, string> } }
export const asset = (name: string) => window.TALEWICK_ASSETS?.[name] ?? `${import.meta.env.BASE_URL}assets/${name}`;

export function Logo({ className }: { className?: string }) {
  return <svg viewBox="0 0 64 64" className={cx('size-12', className)} role="img" aria-label="Talewick">
    <path d="M8 30c8-11 10 14 17 11 5-2 5-16 10-14 4 1 6 17 12 10 4-4-3-10 4-18 3-3 5-5 5-9 5 9-1 12-5 16-3 3 0 15-7 18-8 4-11-10-14-10-2 0-4 11-11 9-5-1-8-17-11-13z" fill="currentColor" />
  </svg>;
}

export function Hint({ text, children }: { text: string; children: ComponentProps<typeof Focusable>['children'] }) {
  return <TooltipTrigger delay={350}><Focusable>{children}</Focusable><Tooltip placement="right">{text}</Tooltip></TooltipTrigger>;
}

/** Product composition using the same React Aria foundation as BoardUI forms. */
export function TextAreaField({ label, value, onChange, placeholder, rows = 4, className, inputClassName, focusRing = 'input', error, isDisabled, autoFocus, onKeyDown, onSelect, inputRef, maxLength }: {
  label: string; value: string; onChange: (value: string) => void; placeholder?: string;
  rows?: number; className?: string; inputClassName?: string; error?: string;
  /** Container mode requires the caller to show focus on the surrounding control. */
  focusRing?: 'input' | 'container';
  isDisabled?: boolean; autoFocus?: boolean; onKeyDown?: ComponentProps<typeof TextArea>['onKeyDown'];
  onSelect?: ComponentProps<typeof TextArea>['onSelect']; inputRef?: ComponentProps<typeof TextArea>['ref']; maxLength?: number;
}) {
  return <TextField value={value} onChange={onChange} isDisabled={isDisabled} isInvalid={Boolean(error)} className={cx('tw-textarea-field', className)}>
    <Label className="sr-only">{label}</Label>
    <TextArea ref={inputRef} rows={rows} autoFocus={autoFocus} placeholder={placeholder} onKeyDown={onKeyDown} onSelect={onSelect} maxLength={maxLength}
      className={cx('w-full resize-none rounded-xl border border-border-button-default bg-background-tertiary-default p-4 text-headline-regular text-text-primary outline-none placeholder:text-text-placeholder disabled:cursor-not-allowed disabled:opacity-60', focusRing === 'input' && 'focus-visible:ring-2 focus-visible:ring-border-focus-ring', inputClassName)} />
    {error && <HintText isInvalid>{error}</HintText>}
  </TextField>;
}

/** General-purpose overlay absent from the registry; preserves RAC focus management. */
export function DialogShell({ title, description, open, onClose, children, footer, className }: {
  title: string; description?: string; open: boolean; onClose: () => void;
  children: ReactNode; footer?: ReactNode; className?: string;
}) {
  const titleId = useId();
  return <ModalOverlay isOpen={open} onOpenChange={value => { if (!value) onClose(); }} isDismissable className="tw-modal-overlay">
    <Modal className={cx('tw-modal glass-panel', className)}>
      <Dialog aria-labelledby={titleId} className="flex max-h-[90dvh] flex-col outline-none">
        <div className="flex items-start justify-between gap-4 border-b border-separator-border p-6">
          <div className="flex flex-col gap-2"><Heading slot="title" id={titleId} className="text-title-2-semibold">{title}</Heading>{description && <p className="text-body-regular text-text-secondary">{description}</p>}</div>
          <IconButton icon={RiCloseLine} aria-label="关闭窗口" onClick={onClose} className="shrink-0" />
        </div>
        <div className="min-h-0 overflow-y-auto p-6">{children}</div>
        {footer && <div className="flex flex-wrap items-center justify-end gap-3 border-t border-separator-border p-6">{footer}</div>}
      </Dialog>
    </Modal>
  </ModalOverlay>;
}

export function EmptyState({ icon, title, description, children }: { icon?: ReactNode; title: string; description: string; children?: ReactNode }) {
  return <div className="flex flex-col items-center gap-4 py-12 text-center">{icon}<h3 className="text-title-3-medium">{title}</h3><p className="max-w-md text-body-regular text-text-secondary">{description}</p>{children}</div>;
}

export function formatDate(value: number | string) {
  return new Date(value).toLocaleString('zh-CN', { month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export function downloadText(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
  const anchor = document.createElement('a'); anchor.href = url; anchor.download = name; anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
