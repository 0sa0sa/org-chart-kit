import { apply, type Action, type OrgState } from './model';

/** undo/redo 付きの編集履歴。baseline は「変更前」の基準で、diff はこれとの差分になる。 */
export type History = { baseline: OrgState; past: OrgState[]; present: OrgState; future: OrgState[] };
export type HistoryCommand = Action | { type: 'undo' } | { type: 'redo' } | { type: 'reset' } | { type: 'rebase'; baseline: OrgState };

export const createHistory = (baseline: OrgState, present: OrgState = baseline): History => ({
  baseline,
  past: [],
  present,
  future: [],
});

export function historyReducer(h: History, c: HistoryCommand): History {
  switch (c.type) {
    case 'undo':
      return h.past.length
        ? { ...h, past: h.past.slice(0, -1), present: h.past[h.past.length - 1], future: [h.present, ...h.future] }
        : h;
    case 'redo':
      return h.future.length ? { ...h, past: [...h.past, h.present], present: h.future[0], future: h.future.slice(1) } : h;
    case 'reset':
      return h.present === h.baseline ? h : { ...h, past: [...h.past, h.present], present: h.baseline, future: [] };
    case 'rebase':
      // 変更案を確定（保存）した後などに、現在の状態を新しい基準にする
      return createHistory(c.baseline);
    default: {
      const next = apply(h.present, c);
      return next ? { ...h, past: [...h.past, h.present], present: next, future: [] } : h;
    }
  }
}
