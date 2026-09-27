/**
 * 組織図のデータモデルと編集操作（React 非依存）。
 * 組織は種別（本部/部/チーム…）を持たず、すべて Org。parentId で任意の深さに入れ子になる。
 * ルートは parentId が null の組織で、ID は ROOT_ID（'root'）固定。
 */

export type Org = {
  id: string;
  name: string;
  parentId: string | null;
  headId: string | null;
};

export type Member = {
  id: string;
  name: string;
  title: string;
  grade: string;
  orgId: string;
};

export type OrgState = {
  orgs: Record<string, Org>;
  members: Record<string, Member>;
};

export type Action =
  | { type: 'moveOrg'; id: string; parentId: string }
  | { type: 'moveMember'; id: string; orgId: string }
  | { type: 'renameOrg'; id: string; name: string }
  | { type: 'addOrg'; parentId: string; id: string; name: string }
  | { type: 'deleteOrg'; id: string }
  | { type: 'setHead'; orgId: string; memberId: string | null };

// ── queries ──────────────────────────────────────────────────────────────────

export const ROOT_ID = 'root';

export const childOrgs = (s: OrgState, id: string) =>
  Object.values(s.orgs).filter((o) => o.parentId === id);

export const membersOf = (s: OrgState, orgId: string) =>
  Object.values(s.members).filter((m) => m.orgId === orgId);

export function depthOf(s: OrgState, id: string): number {
  let d = 0;
  let cur = s.orgs[id];
  while (cur?.parentId) {
    d++;
    cur = s.orgs[cur.parentId];
  }
  return d;
}

/** root → id までの組織列 */
export function pathOf(s: OrgState, id: string): Org[] {
  const out: Org[] = [];
  let cur: Org | undefined = s.orgs[id];
  while (cur) {
    out.unshift(cur);
    cur = cur.parentId ? s.orgs[cur.parentId] : undefined;
  }
  return out;
}

/** b が a 自身または a の配下にあるか */
export function isWithin(s: OrgState, a: string, b: string): boolean {
  let cur: Org | undefined = s.orgs[b];
  while (cur) {
    if (cur.id === a) return true;
    cur = cur.parentId ? s.orgs[cur.parentId] : undefined;
  }
  return false;
}

export function subtreeIds(s: OrgState, id: string): Set<string> {
  const out = new Set<string>([id]);
  const walk = (x: string) => childOrgs(s, x).forEach((c) => (out.add(c.id), walk(c.id)));
  walk(id);
  return out;
}

export function headcount(s: OrgState, id: string): number {
  const ids = subtreeIds(s, id);
  return Object.values(s.members).filter((m) => ids.has(m.orgId)).length;
}

/** 移動先として妥当か（循環しない・同じ場所でない） */
export function canMoveOrg(s: OrgState, id: string, parentId: string): boolean {
  const o = s.orgs[id];
  if (!o || !s.orgs[parentId] || id === ROOT_ID) return false;
  if (o.parentId === parentId) return false;
  return !isWithin(s, id, parentId);
}

// ── reducer ──────────────────────────────────────────────────────────────────

/** 不正な操作は null を返す（状態を変えない） */
export function apply(s: OrgState, a: Action): OrgState | null {
  switch (a.type) {
    case 'moveOrg': {
      if (!canMoveOrg(s, a.id, a.parentId)) return null;
      return { ...s, orgs: { ...s.orgs, [a.id]: { ...s.orgs[a.id], parentId: a.parentId } } };
    }
    case 'moveMember': {
      const m = s.members[a.id];
      if (!m || !s.orgs[a.orgId] || m.orgId === a.orgId) return null;
      const orgs = { ...s.orgs };
      const from = orgs[m.orgId];
      if (from.headId === m.id) orgs[from.id] = { ...from, headId: null };
      return { orgs, members: { ...s.members, [m.id]: { ...m, orgId: a.orgId } } };
    }
    case 'renameOrg': {
      const o = s.orgs[a.id];
      const name = a.name.trim();
      if (!o || !name || o.name === name) return null;
      return { ...s, orgs: { ...s.orgs, [o.id]: { ...o, name } } };
    }
    case 'addOrg': {
      if (!s.orgs[a.parentId] || s.orgs[a.id]) return null;
      return {
        ...s,
        orgs: { ...s.orgs, [a.id]: { id: a.id, name: a.name, parentId: a.parentId, headId: null } },
      };
    }
    case 'deleteOrg': {
      const o = s.orgs[a.id];
      if (!o || !o.parentId) return null;
      const orgs = { ...s.orgs };
      delete orgs[o.id];
      // 子組織とメンバーは親へ繰り上げる
      for (const c of Object.values(orgs)) if (c.parentId === o.id) orgs[c.id] = { ...c, parentId: o.parentId };
      const members = { ...s.members };
      for (const m of Object.values(members)) if (m.orgId === o.id) members[m.id] = { ...m, orgId: o.parentId };
      return { orgs, members };
    }
    case 'setHead': {
      const o = s.orgs[a.orgId];
      if (!o || o.headId === a.memberId) return null;
      if (a.memberId && s.members[a.memberId]?.orgId !== o.id) return null;
      return { ...s, orgs: { ...s.orgs, [o.id]: { ...o, headId: a.memberId } } };
    }
  }
}

let seq = 0;
export const newOrgId = () => `new-${Date.now().toString(36)}-${seq++}`;

// ── diff（ベースラインとの差分 = 変更案） ─────────────────────────────────────

export type Change =
  | { key: string; kind: 'member-move'; memberId: string; from: string; to: string }
  | { key: string; kind: 'org-move'; orgId: string; from: string; to: string }
  | { key: string; kind: 'org-rename'; orgId: string; from: string; to: string }
  | { key: string; kind: 'org-add'; orgId: string; parent: string }
  | { key: string; kind: 'org-remove'; orgId: string; name: string }
  | { key: string; kind: 'head'; orgId: string; from: string | null; to: string | null };

/** 組織名はベースライン側の名前を優先して解決（削除済みも表示できるように） */
export const orgName = (base: OrgState, cur: OrgState, id: string | null) =>
  (id && (cur.orgs[id]?.name ?? base.orgs[id]?.name)) || '—';

export function diff(base: OrgState, cur: OrgState): Change[] {
  const out: Change[] = [];
  for (const o of Object.values(cur.orgs)) {
    const b = base.orgs[o.id];
    if (!b) {
      out.push({ key: `add:${o.id}`, kind: 'org-add', orgId: o.id, parent: o.parentId! });
      continue;
    }
    if (b.name !== o.name) out.push({ key: `ren:${o.id}`, kind: 'org-rename', orgId: o.id, from: b.name, to: o.name });
    if (b.parentId !== o.parentId && b.parentId && o.parentId)
      out.push({ key: `mv:${o.id}`, kind: 'org-move', orgId: o.id, from: b.parentId, to: o.parentId });
    if (b.headId !== o.headId) out.push({ key: `head:${o.id}`, kind: 'head', orgId: o.id, from: b.headId, to: o.headId });
  }
  for (const b of Object.values(base.orgs))
    if (!cur.orgs[b.id]) out.push({ key: `rm:${b.id}`, kind: 'org-remove', orgId: b.id, name: b.name });
  for (const m of Object.values(cur.members)) {
    const b = base.members[m.id];
    if (b && b.orgId !== m.orgId)
      out.push({ key: `mm:${m.id}`, kind: 'member-move', memberId: m.id, from: b.orgId, to: m.orgId });
  }
  return out;
}

/** 個別の変更だけを取り消すための逆操作（戻せないものは null） */
export function revertAction(cur: OrgState, c: Change): Action | null {
  switch (c.kind) {
    case 'member-move':
      return cur.orgs[c.from] ? { type: 'moveMember', id: c.memberId, orgId: c.from } : null;
    case 'org-move':
      return canMoveOrg(cur, c.orgId, c.from) ? { type: 'moveOrg', id: c.orgId, parentId: c.from } : null;
    case 'org-rename':
      return { type: 'renameOrg', id: c.orgId, name: c.from };
    case 'org-add':
      return { type: 'deleteOrg', id: c.orgId };
    case 'head':
      return c.from === null || cur.members[c.from]?.orgId === c.orgId
        ? { type: 'setHead', orgId: c.orgId, memberId: c.from }
        : null;
    case 'org-remove':
      return null; // 削除の復元は undo で行う
  }
}

/** 変更の影響を受けた ID（ハイライト用） */
export function touched(changes: Change[]) {
  const orgs = new Set<string>();
  const members = new Set<string>();
  for (const c of changes) {
    if (c.kind === 'member-move') members.add(c.memberId);
    else if (c.kind !== 'org-remove') orgs.add(c.orgId);
  }
  return { orgs, members };
}
