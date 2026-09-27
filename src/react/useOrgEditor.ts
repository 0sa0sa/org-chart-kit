import { useCallback, useEffect, useMemo, useReducer } from 'react';
import { createHistory, historyReducer, type HistoryCommand } from '../core/history';
import { diff, type Action, type OrgState } from '../core/model';

export type UseOrgEditorOptions = {
  /** ⌘Z / ⇧⌘Z（Ctrl も可）を window で拾う。ホストアプリの undo を奪わないよう既定はオフ。 */
  hotkeys?: boolean;
  /** present が変わるたびに呼ばれる（保存やプレビュー連携用） */
  onChange?: (state: OrgState) => void;
};

/**
 * 組織図の編集ストア。OrgTree / OrgMap に `store` として渡す。
 * 同じ store を複数のビューに渡せば、どちらで編集しても両方に反映される。
 */
export function useOrgEditor(baseline: OrgState, { hotkeys = false, onChange }: UseOrgEditorOptions = {}) {
  const [h, send] = useReducer(historyReducer, baseline, createHistory);
  const dispatch = useCallback((a: Action) => send(a), []);
  const exec = useCallback((c: HistoryCommand) => send(c), []);
  const undo = useCallback(() => send({ type: 'undo' }), []);
  const redo = useCallback(() => send({ type: 'redo' }), []);
  const reset = useCallback(() => send({ type: 'reset' }), []);
  /** 現在の状態を新しい基準にする（変更案を確定した後など） */
  const commit = useCallback(() => send({ type: 'rebase', baseline: h.present }), [h.present]);
  const changes = useMemo(() => diff(h.baseline, h.present), [h.baseline, h.present]);

  useEffect(() => {
    if (h.present !== h.baseline || h.past.length) onChange?.(h.present);
  }, [h.present]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!hotkeys) return;
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== 'z') return;
      if ((e.target as HTMLElement)?.closest('input, textarea, select, [contenteditable]')) return;
      e.preventDefault();
      if (e.shiftKey) redo();
      else undo();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [hotkeys, undo, redo]);

  return {
    state: h.present,
    base: h.baseline,
    changes,
    dispatch,
    exec,
    undo,
    redo,
    reset,
    commit,
    canUndo: h.past.length > 0,
    canRedo: h.future.length > 0,
  };
}

export type OrgEditor = ReturnType<typeof useOrgEditor>;
