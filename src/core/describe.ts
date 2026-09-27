import { orgName, type Change, type OrgState } from './model';

export type ChangeText = { verb: string; subject: string; from?: string; to?: string };

/** 変更1件を「誰/何を・どこから・どこへ」に分解する（表示は各バリアントに任せる） */
export function describe(base: OrgState, cur: OrgState, c: Change): ChangeText {
  const on = (id: string | null) => orgName(base, cur, id);
  const mn = (id: string | null) => (id ? (cur.members[id] ?? base.members[id])?.name ?? '—' : '不在');
  switch (c.kind) {
    case 'member-move':
      return { verb: '異動', subject: mn(c.memberId), from: on(c.from), to: on(c.to) };
    case 'org-move':
      return { verb: '移設', subject: on(c.orgId), from: on(c.from), to: on(c.to) };
    case 'org-rename':
      return { verb: '改称', subject: c.from, to: c.to };
    case 'org-add':
      return { verb: '新設', subject: on(c.orgId), to: on(c.parent) };
    case 'org-remove':
      return { verb: '解散', subject: c.name };
    case 'head':
      return { verb: '責任者', subject: on(c.orgId), from: mn(c.from), to: mn(c.to) };
  }
}
