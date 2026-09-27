import { describe as suite, expect, it } from 'vitest';
import {
  apply,
  canMoveOrg,
  diff,
  headcount,
  pathOf,
  revertAction,
  touched,
  type Action,
  type OrgState,
} from '../src/core/model';
import { describe } from '../src/core/describe';
import { createHistory, historyReducer } from '../src/core/history';
import { sampleOrg } from '../playground/src/fixtures';

const run = (s: OrgState, ...as: Action[]) =>
  as.reduce((cur, a) => {
    const next = apply(cur, a);
    if (!next) throw new Error(`rejected: ${JSON.stringify(a)}`);
    return next;
  }, s);

suite('apply: moveOrg', () => {
  const base = sampleOrg();

  it('親を付け替える', () => {
    const s = run(base, { type: 'moveOrg', id: 'design', parentId: 'biz' });
    expect(s.orgs.design.parentId).toBe('biz');
    expect(pathOf(s, 'design').map((o) => o.id)).toEqual(['root', 'biz', 'design']);
  });

  it('自分の配下へは移せない（循環）', () => {
    expect(canMoveOrg(base, 'prod', 'web')).toBe(false);
    expect(apply(base, { type: 'moveOrg', id: 'prod', parentId: 'web' })).toBeNull();
    expect(apply(base, { type: 'moveOrg', id: 'prod', parentId: 'prod' })).toBeNull();
  });

  it('ルートは動かせない・同じ親への移動は無変更', () => {
    expect(apply(base, { type: 'moveOrg', id: 'root', parentId: 'biz' })).toBeNull();
    expect(apply(base, { type: 'moveOrg', id: 'web', parentId: 'dev' })).toBeNull();
  });

  it('元の状態を書き換えない（イミュータブル）', () => {
    run(base, { type: 'moveOrg', id: 'design', parentId: 'biz' });
    expect(base.orgs.design.parentId).toBe('prod');
  });
});

suite('apply: moveMember / setHead', () => {
  const base = sampleOrg();
  const koba = Object.values(base.members).find((m) => m.name === '小林 さくら')!;

  it('所属を変える', () => {
    const s = run(base, { type: 'moveMember', id: koba.id, orgId: 'infra' });
    expect(s.members[koba.id].orgId).toBe('infra');
    expect(headcount(s, 'web')).toBe(headcount(base, 'web') - 1);
  });

  it('責任者が異動すると元の組織の責任者は空席になる', () => {
    expect(base.orgs.web.headId).toBe(koba.id);
    const s = run(base, { type: 'moveMember', id: koba.id, orgId: 'infra' });
    expect(s.orgs.web.headId).toBeNull();
  });

  it('責任者は直属メンバーからしか選べない', () => {
    expect(apply(base, { type: 'setHead', orgId: 'infra', memberId: koba.id })).toBeNull();
    const hayashi = Object.values(base.members).find((m) => m.name === '林 健太')!;
    const s = run(base, { type: 'setHead', orgId: 'infra', memberId: hayashi.id });
    expect(s.orgs.infra.headId).toBe(hayashi.id);
  });
});

suite('apply: addOrg / deleteOrg / renameOrg', () => {
  const base = sampleOrg();

  it('解散すると子組織とメンバーは親へ繰り上がる', () => {
    const s = run(base, { type: 'deleteOrg', id: 'dev' });
    expect(s.orgs.dev).toBeUndefined();
    expect(s.orgs.web.parentId).toBe('prod');
    const devMembers = Object.values(base.members).filter((m) => m.orgId === 'dev');
    for (const m of devMembers) expect(s.members[m.id].orgId).toBe('prod');
    expect(Object.keys(s.members)).toHaveLength(Object.keys(base.members).length);
  });

  it('ルートは解散できない', () => {
    expect(apply(base, { type: 'deleteOrg', id: 'root' })).toBeNull();
  });

  it('改称は前後の空白を落とし、空文字や同名は無変更', () => {
    expect(run(base, { type: 'renameOrg', id: 'web', name: '  フロントエンド ' }).orgs.web.name).toBe('フロントエンド');
    expect(apply(base, { type: 'renameOrg', id: 'web', name: '   ' })).toBeNull();
    expect(apply(base, { type: 'renameOrg', id: 'web', name: 'Webチーム' })).toBeNull();
  });

  it('新設は既存IDと衝突しない', () => {
    expect(apply(base, { type: 'addOrg', parentId: 'root', id: 'web', name: 'x' })).toBeNull();
    const s = run(base, { type: 'addOrg', parentId: 'sales', id: 'n1', name: '新しい組織' });
    expect(s.orgs.n1).toEqual({ id: 'n1', name: '新しい組織', parentId: 'sales', headId: null });
  });
});

suite('diff / revertAction / describe', () => {
  const base = sampleOrg();
  const kato = Object.values(base.members).find((m) => m.name === '加藤 陽介')!;
  const cur = run(
    base,
    { type: 'moveOrg', id: 'design', parentId: 'biz' },
    { type: 'moveMember', id: kato.id, orgId: 'infra' },
    { type: 'renameOrg', id: 'mkt', name: 'グロース部' },
    { type: 'addOrg', parentId: 'sales', id: 'n1', name: '新しい組織' },
    { type: 'deleteOrg', id: 'recruit' },
  );
  const changes = diff(base, cur);

  it('ベースラインとの差分を種類ごとに列挙する', () => {
    expect(changes.map((c) => c.key).sort()).toEqual(
      [`mm:${kato.id}`, 'add:n1', 'mv:design', 'ren:mkt', 'rm:recruit', ...recruitMembersMoved(base, cur)].sort(),
    );
  });

  it('差分がなければ空', () => {
    expect(diff(base, base)).toEqual([]);
  });

  it('個別取消は逆操作を返し、適用すると該当の差分だけ消える', () => {
    const mv = changes.find((c) => c.key === `mm:${kato.id}`)!;
    const back = apply(cur, revertAction(cur, mv)!)!;
    expect(diff(base, back).map((c) => c.key)).not.toContain(`mm:${kato.id}`);
    expect(diff(base, back)).toHaveLength(changes.length - 1);
  });

  it('解散の取消は個別にはできない（undo で戻す）', () => {
    expect(revertAction(cur, changes.find((c) => c.kind === 'org-remove')!)).toBeNull();
  });

  it('touched は変更に関わった組織とメンバーを返す', () => {
    const t = touched(changes);
    expect(t.orgs.has('design')).toBe(true);
    expect(t.members.has(kato.id)).toBe(true);
  });

  it('describe は「誰が・どこから・どこへ」に分解する', () => {
    const t = describe(base, cur, changes.find((c) => c.kind === 'member-move' && c.memberId === kato.id)!);
    expect(t).toEqual({ verb: '異動', subject: '加藤 陽介', from: 'Webチーム', to: '基盤チーム' });
    expect(describe(base, cur, changes.find((c) => c.kind === 'org-remove')!)).toEqual({ verb: '解散', subject: '採用チーム' });
  });
});

function recruitMembersMoved(base: OrgState, cur: OrgState) {
  return Object.values(base.members)
    .filter((m) => m.orgId === 'recruit' && cur.members[m.id].orgId !== 'recruit')
    .map((m) => `mm:${m.id}`);
}

suite('historyReducer', () => {
  const base = sampleOrg();
  const mv: Action = { type: 'moveOrg', id: 'design', parentId: 'biz' };

  it('操作・undo・redo・reset', () => {
    let h = createHistory(base);
    h = historyReducer(h, mv);
    expect(h.present.orgs.design.parentId).toBe('biz');
    h = historyReducer(h, { type: 'undo' });
    expect(h.present).toBe(base);
    h = historyReducer(h, { type: 'redo' });
    expect(h.present.orgs.design.parentId).toBe('biz');
    h = historyReducer(h, { type: 'reset' });
    expect(h.present).toBe(base);
    // reset も1手として戻せる
    expect(historyReducer(h, { type: 'undo' }).present.orgs.design.parentId).toBe('biz');
  });

  it('不正な操作は履歴を積まない', () => {
    const h = createHistory(base);
    expect(historyReducer(h, { type: 'moveOrg', id: 'prod', parentId: 'web' })).toBe(h);
  });

  it('新しい操作をすると redo は捨てられる', () => {
    let h = historyReducer(createHistory(base), mv);
    h = historyReducer(h, { type: 'undo' });
    h = historyReducer(h, { type: 'renameOrg', id: 'web', name: 'Web' });
    expect(h.future).toEqual([]);
  });

  it('rebase で現在を新しい基準にする', () => {
    const h = historyReducer(historyReducer(createHistory(base), mv), { type: 'rebase', baseline: base });
    expect(h.baseline).toBe(base);
    expect(h.past).toEqual([]);
  });
});
