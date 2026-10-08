import { createContext, useContext } from 'react';
import type { AppState } from '@/model/types';

export interface WorkspaceActions {
  state: AppState;
  update: (recipe: (draft: AppState) => void) => void;
  notify: (message: string) => void;
  openProject: (id: string) => void;
  startNew: () => void;
}

export const WorkspaceContext = createContext<WorkspaceActions | null>(null);
export function useWorkspace() {
  const value = useContext(WorkspaceContext);
  if (!value) throw new Error('Talewick workspace is not initialized.');
  return value;
}
