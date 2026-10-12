import { RiFileTextLine, RiPlayLine } from '@remixicon/react';
import { Button } from '@/components/base/buttons/button';
import { AgentThinking } from '@/components/application/agent-thinking/agent-thinking';
import { runtimeBusy, runtimeEngineLabel, runtimeProgressDetail, runtimeResumeLabel, runtimeResumeMessage, runtimeStage, taskActive } from '@/model/runtime';
import type { Project, RuntimeTask } from '@/model/types';

export interface CreationProgressProps {
  project: Project;
  onTaskAction: (action: 'resume' | 'cancel') => void;
  onResult: (task: RuntimeTask) => void;
}

/** Presentation shared by chat and reader. Only the runtime owns task transitions. */
export function CreationProgress({ project, onTaskAction, onResult }: CreationProgressProps) {
  const binding = project.runtime;
  const task = binding?.task;
  const pending = project.pendingEdits.filter(edit => edit.status === 'pending').length;
  const busy = runtimeBusy(project);
  const resumeMessage = runtimeResumeMessage(task);
  let title: string;
  let detail: string;

  if (!binding) {
    title = pending ? `${pending} 处修改待审阅` : project.chapters.length ? '文稿已就绪' : project.mode === 'auto' ? '准备开始成稿' : '当前参与模式暂未接通';
    detail = pending ? '在文稿中采纳修改或保留原文，再提交下一次修改要求。' : project.chapters.length ? '可以阅读、编辑和导出，也可以选中文字提出修改要求。' : project.mode === 'auto' ? '在对话中写下创作要求，提交后开始生成。' : '请切换为一键成稿。已有稿件仍可阅读、编辑和提交修改要求。';
  } else if (binding.submitting) {
    title = task ? '正在更新任务…' : '正在提交创作要求…';
    detail = '已有想法和正文保持原样，等待服务确认。';
  } else if (taskActive(task)) {
    title = binding.connectionError ? '等待重新取得任务进度' : runtimeStage(task!);
    detail = binding.connectionError ? '正在尝试恢复连接。收到任务状态后会继续显示进度。' : runtimeProgressDetail(task);
  } else if (task?.status === 'needs_input') {
    title = '补充创作要求';
    detail = `${task.question || '请补充本次创作的具体要求。'} 在下方输入框补充后发送即可。`;
  } else if (binding.resultDisposition === 'held') {
    title = '本次结果已保留';
    detail = binding.message || '当前稿件保持原样，可以先查看本次返回的结果。';
  } else if (task?.status === 'completed') {
    title = pending ? `${pending} 处修改待审阅` : task.kind === 'create' ? '完整初稿已就绪' : '本轮修改已完成';
    detail = pending ? '在文稿中逐条采纳或保留原文。待审建议不会写入导出稿件。' : binding.message || '可以继续阅读、编辑，或从版本记录回看和导出稿件。';
  } else {
    title = task ? runtimeStage(task) : '创作等待连接';
    detail = runtimeProgressDetail(task) || '创作要求已保存在本机，可以继续未完成步骤。';
  }

  return <div className="creation-progress" aria-label="创作进度" aria-busy={busy}>
    <div className="creation-progress-copy">
      {busy ? <AgentThinking label={title} tone="primary" shimmer={false} showTimer={false} /> : <p className="text-body-medium" aria-live="polite">{title}</p>}
      <p className="text-caption-1-regular text-text-secondary">{resumeMessage || detail}</p>
      {task && <p className="text-caption-1-regular text-text-secondary">本次任务：{runtimeEngineLabel(task.engine)}</p>}
      {task?.error && task.status !== 'needs_input' && task.error !== detail && <p className="text-caption-1-regular text-text-error-primary">{task.error}</p>}
      {binding?.connectionError && <p className="text-caption-1-regular text-text-error-primary">{binding.connectionError}</p>}
    </div>
    <div className="creation-progress-actions">
      {taskActive(task) && <Button size="small" variant="secondary" disabled={binding?.submitting} onClick={() => onTaskAction('cancel')}>取消任务</Button>}
      {binding && !binding.submitting && !resumeMessage && (!task || ['failed', 'interrupted', 'cancelled'].includes(task.status)) && <Button size="small" variant="primary" leadingIcon={RiPlayLine} onClick={() => onTaskAction('resume')}>{task ? runtimeResumeLabel(task) : '继续未完成步骤'}</Button>}
      {task?.partialDraft && <Button size="small" variant="secondary" leadingIcon={RiFileTextLine} onClick={() => onResult(task)}>查看已保存草稿（未完成）</Button>}
      {task?.result && <Button size="small" variant="secondary" leadingIcon={RiFileTextLine} onClick={() => onResult(task)}>查看本次结果与检查报告</Button>}
    </div>
  </div>;
}
