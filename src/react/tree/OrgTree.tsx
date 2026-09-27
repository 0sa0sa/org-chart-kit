import { useEffect, useId, useMemo, useRef, useState, type CSSProperties, type PointerEvent as RPointerEvent } from 'react';
import { forceSimulation, forceX, forceY, type Simulation, type SimulationNodeDatum } from 'd3-force';
import { hierarchy, tree } from 'd3-hierarchy';
import {
  ROOT_ID,
  canMoveOrg,
  childOrgs,
  depthOf,
  headcount,
  membersOf,
  newOrgId,
  pathOf,
  revertAction,
  subtreeIds,
  touched,
  type OrgState,
} from '../../core/model';
import { describe } from '../../core/describe';
import type { OrgEditor } from '../useOrgEditor';
import { useSize } from '../useSize';

/**
 * OrgTree — FounderOS の G-Brain を参考にした組織グラフ（ツリー版）。
 * 見た目（黒地・緑アクセント・等幅）は Brain を踏襲し、配置は組織図らしく
 * ルートを最上段に置いて下へ枝を広げるトップダウンのツリーにする。
 * メンバーは所属組織の直下に縦に並ぶ「葉」。
 * 編集は「ノードを別の組織ノードへ重ねる」= 付け替え。組織をつかむと配下の枝ごと持ち上がる。
 */

const COL = 138; // 兄弟の横間隔
const ROW = 150; // 深さ1段の縦間隔
const LEAF_GAP = 15; // メンバーの縦間隔

type Kind = 'org' | 'member';
type SimNode = SimulationNodeDatum & { id: string; kind: Kind; depth: number; r: number; tx: number; ty: number };
type Sel = { kind: Kind; id: string } | null;
type Drag = { id: string; kind: Kind; sx: number; sy: number; moved: boolean; carry: Set<string> };
type Target = { id: string; valid: boolean; reason?: string } | null;

const orgR = (depth: number, hc: number) =>
  depth === 0 ? 18 : Math.max(7, 13 - depth * 1.6) + Math.min(4, Math.sqrt(hc) * 0.7);

export type OrgTreeProps = {
  store: OrgEditor;
  /** 見出し。null でヘッダーごと隠す */
  title?: string | null;
  eyebrow?: string;
  className?: string;
  style?: CSSProperties;
};

/** 親要素いっぱいに広がる（親に高さが必要）。スタイルは `org-chart-kit/styles.css`。 */
export function OrgTree({ store, title = '組織グラフ', eyebrow = 'org chart', className, style }: OrgTreeProps) {
  const uid = useId().replace(/:/g, '');
  const { state, changes, dispatch } = store;
  const [wrapRef, size] = useSize<HTMLDivElement>();
  const svgRef = useRef<SVGSVGElement>(null);
  const nodesRef = useRef(new Map<string, SimNode>());
  const simRef = useRef<Simulation<SimNode, undefined>>();
  const [, setTick] = useState(0);
  const [cam, setCam] = useState({ x: 0, y: 0, k: 1 });
  const camRef = useRef(cam);
  camRef.current = cam;
  const [sel, setSel] = useState<Sel>(null);
  const [hover, setHover] = useState<string | null>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [target, setTarget] = useState<Target>(null);
  const panRef = useRef<{ x: number; y: number; cx: number; cy: number; moved: boolean } | null>(null);

  const touchedIds = useMemo(() => touched(changes), [changes]);
  const layout = useMemo(() => treeLayout(state), [state]);

  // ── simulation：ツリー上の定位置へバネで寄せる（構造が変わると枝がするりと組み替わる） ──
  useEffect(() => {
    const sim = forceSimulation<SimNode>()
      .force('x', forceX<SimNode>((d) => d.tx).strength(0.22))
      .force('y', forceY<SimNode>((d) => d.ty).strength(0.22))
      .velocityDecay(0.32)
      .alphaDecay(0.035)
      .on('tick', () => setTick((t) => t + 1));
    simRef.current = sim;
    return () => void sim.stop();
  }, []);

  useEffect(() => {
    const sim = simRef.current;
    if (!sim) return;
    const prev = nodesRef.current;
    const next = new Map<string, SimNode>();
    for (const [id, slot] of layout.slots) {
      const kind: Kind = state.orgs[id] ? 'org' : 'member';
      const depth = kind === 'org' ? depthOf(state, id) : depthOf(state, state.members[id].orgId) + 1;
      const r = kind === 'org' ? orgR(depth, headcount(state, id)) : 3.6;
      let n = prev.get(id);
      if (!n) {
        // 新しいノードは親の位置から生えてくる
        const parent = kind === 'org' ? state.orgs[id].parentId : state.members[id].orgId;
        const p = parent ? prev.get(parent) : undefined;
        n = { id, kind, depth, r, tx: slot.x, ty: slot.y, x: p?.x ?? slot.x, y: p?.y ?? slot.y };
      }
      Object.assign(n, { depth, r, tx: slot.x, ty: slot.y });
      next.set(id, n);
    }
    nodesRef.current = next;
    sim.nodes([...next.values()]);
    sim.alpha(Math.max(sim.alpha(), 0.9)).restart();
    if (sel && !(sel.kind === 'org' ? state.orgs[sel.id] : state.members[sel.id])) setSel(null);
  }, [layout]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── camera ────────────────────────────────────────────────────────────────
  const fit = () => {
    if (!size.w) return;
    const b = layout.bounds;
    const bw = b.x1 - b.x0 + 80;
    const bh = b.y1 - b.y0 + 90;
    const k = Math.min(1.2, (size.w - 40) / bw, (size.h - 40) / bh);
    setCam({ k, x: size.w / 2 - ((b.x0 + b.x1) / 2) * k, y: Math.max(56, (size.h - bh * k) / 2 + 40) - b.y0 * k });
  };
  // 初回とコンテナのサイズが変わった時（並列表示への切替など）に全体を収め直す
  const fitted = useRef('');
  useEffect(() => {
    const key = `${size.w}x${size.h}`;
    if (!size.w || fitted.current === key) return;
    fitted.current = key;
    fit();
  }, [size]); // eslint-disable-line react-hooks/exhaustive-deps

  const toWorld = (cx: number, cy: number) => {
    const r = svgRef.current!.getBoundingClientRect();
    const c = camRef.current;
    return { x: (cx - r.left - c.x) / c.k, y: (cy - r.top - c.y) / c.k };
  };

  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = svg.getBoundingClientRect();
      const px = e.clientX - r.left;
      const py = e.clientY - r.top;
      setCam((c) => {
        const k = Math.min(3.2, Math.max(0.25, c.k * Math.exp(-e.deltaY * 0.0015)));
        return { k, x: px - ((px - c.x) / c.k) * k, y: py - ((py - c.y) / c.k) * k };
      });
    };
    svg.addEventListener('wheel', onWheel, { passive: false });
    return () => svg.removeEventListener('wheel', onWheel);
  }, []);

  const centerOn = (id: string) => {
    const slot = layout.slots.get(id);
    if (!slot || !size.w) return;
    setCam((c) => ({ ...c, x: size.w / 2 - slot.x * c.k, y: size.h / 2.6 - slot.y * c.k }));
  };

  // ── drag & drop（付け替え） ───────────────────────────────────────────────
  const findTarget = (d: Drag, wx: number, wy: number): Target => {
    let best: { n: SimNode; dist: number } | null = null;
    for (const n of nodesRef.current.values()) {
      if (n.kind !== 'org' || d.carry.has(n.id)) continue;
      const dist = Math.hypot((n.x ?? 0) - wx, (n.y ?? 0) - wy);
      if (dist < n.r + 28 && (!best || dist < best.dist)) best = { n, dist };
    }
    if (!best) return null;
    const id = best.n.id;
    if (d.kind === 'member') {
      const same = state.members[d.id]?.orgId === id;
      return { id, valid: !same, reason: same ? '現在の所属' : undefined };
    }
    if (state.orgs[d.id]?.parentId === id) return { id, valid: false, reason: '現在の親' };
    return canMoveOrg(state, d.id, id) ? { id, valid: true } : { id, valid: false, reason: '自分の配下には移せません' };
  };

  /** 組織をつかんだら、配下の組織とメンバーも一緒に運ぶ */
  const carryOf = (n: SimNode) => {
    if (n.kind === 'member') return new Set([n.id]);
    const orgs = subtreeIds(state, n.id);
    const out = new Set(orgs);
    for (const m of Object.values(state.members)) if (orgs.has(m.orgId)) out.add(m.id);
    return out;
  };

  const onNodeDown = (e: RPointerEvent, n: SimNode) => {
    e.stopPropagation();
    svgRef.current?.setPointerCapture(e.pointerId);
    // ルートは動かせないので、つかんだらパンとして扱う
    if (n.id === ROOT_ID) {
      panRef.current = { x: e.clientX, y: e.clientY, cx: cam.x, cy: cam.y, moved: false };
      setDrag({ id: n.id, kind: 'org', sx: e.clientX, sy: e.clientY, moved: false, carry: new Set() });
      return;
    }
    setDrag({ id: n.id, kind: n.kind, sx: e.clientX, sy: e.clientY, moved: false, carry: carryOf(n) });
  };

  const onBgDown = (e: RPointerEvent) => {
    svgRef.current?.setPointerCapture(e.pointerId);
    panRef.current = { x: e.clientX, y: e.clientY, cx: cam.x, cy: cam.y, moved: false };
  };

  const pan = (e: RPointerEvent) => {
    const p = panRef.current;
    if (!p) return;
    const dx = e.clientX - p.x;
    const dy = e.clientY - p.y;
    if (Math.hypot(dx, dy) > 3) p.moved = true;
    setCam((c) => ({ ...c, x: p.cx + dx, y: p.cy + dy }));
  };

  const onMove = (e: RPointerEvent) => {
    if (drag && drag.id !== ROOT_ID) {
      const moved = drag.moved || Math.hypot(e.clientX - drag.sx, e.clientY - drag.sy) > 4;
      if (!moved) return;
      if (!drag.moved) {
        setDrag({ ...drag, moved: true });
        simRef.current?.alphaTarget(0.3).restart();
      }
      const head = nodesRef.current.get(drag.id);
      if (!head) return;
      const w = toWorld(e.clientX, e.clientY);
      const dx = w.x - head.tx;
      const dy = w.y - head.ty;
      for (const id of drag.carry) {
        const n = nodesRef.current.get(id);
        if (n) (n.fx = n.tx + dx), (n.fy = n.ty + dy);
      }
      setTarget(findTarget(drag, w.x, w.y));
      return;
    }
    pan(e);
  };

  const onUp = () => {
    if (drag) {
      for (const id of drag.carry) {
        const n = nodesRef.current.get(id);
        if (n) (n.fx = null), (n.fy = null);
      }
      simRef.current?.alphaTarget(0);
      const clicked = drag.id === ROOT_ID ? !panRef.current?.moved : !drag.moved;
      if (clicked) setSel({ kind: drag.kind, id: drag.id });
      else if (drag.moved && target?.valid) {
        dispatch(
          drag.kind === 'member'
            ? { type: 'moveMember', id: drag.id, orgId: target.id }
            : { type: 'moveOrg', id: drag.id, parentId: target.id },
        );
        setSel({ kind: drag.kind, id: drag.id });
      } else simRef.current?.alpha(0.6).restart(); // 元の枝へ戻る
      setDrag(null);
      setTarget(null);
      panRef.current = null;
      return;
    }
    if (panRef.current && !panRef.current.moved) setSel(null);
    panRef.current = null;
  };

  // ── focus ─────────────────────────────────────────────────────────────────
  const focus = useMemo(() => {
    if (!sel) return null;
    const orgId = sel.kind === 'org' ? sel.id : state.members[sel.id]?.orgId;
    if (!orgId || !state.orgs[orgId]) return null;
    const sub = sel.kind === 'org' ? subtreeIds(state, orgId) : new Set([orgId]);
    const orgs = new Set(sub);
    for (const p of pathOf(state, orgId)) orgs.add(p.id);
    const members = new Set(
      Object.values(state.members)
        .filter((m) => (sel.kind === 'org' ? sub.has(m.orgId) : m.id === sel.id))
        .map((m) => m.id),
    );
    return { orgs, members };
  }, [sel, state]);

  const lit = (id: string, kind: Kind) => !focus || (kind === 'org' ? focus.orgs : focus.members).has(id);

  const heads = useMemo(() => new Set(Object.values(state.orgs).map((o) => o.headId).filter(Boolean)), [state]);
  const nodes = [...nodesRef.current.values()].sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'member' ? -1 : 1));
  const get = (id: string) => nodesRef.current.get(id);
  const dragNode = drag?.moved ? get(drag.id) : undefined;
  const targetNode = target ? get(target.id) : undefined;
  const showMemberNames = cam.k > 0.8;
  const labelScale = 1 / Math.max(0.75, Math.min(cam.k, 1.5));
  const b = layout.bounds;

  return (
    <div className={`ock-tree${className ? ` ${className}` : ''}`} style={style}>
      {title !== null && (
      <header className="brain-head">
        <div>
          <div className="brain-eyebrow">{eyebrow}</div>
          <h1 className="brain-title">
            {title}<span className="brain-caret">_</span>
          </h1>
        </div>
        <div className="brain-legend">
          <span><i className="lg-org" />組織</span>
          <span><i className="lg-mem" />メンバー</span>
          <span><i className="lg-head" />責任者</span>
          <span><i className="lg-delta" />変更あり</span>
        </div>
      </header>
      )}

      <div className="brain-body">
        <Directory state={state} sel={sel} touchedOrgs={touchedIds.orgs} onSelect={(id) => (setSel({ kind: 'org', id }), centerOn(id))} dispatch={dispatch} />

        <div className="brain-canvas" ref={wrapRef}>
          <svg
            ref={svgRef}
            width={size.w}
            height={size.h}
            onPointerDown={onBgDown}
            onPointerMove={onMove}
            onPointerUp={onUp}
            className={drag?.moved ? 'is-dragging' : ''}
          >
            <defs>
              <radialGradient id={`${uid}-core`} r="1">
                <stop offset="0" stopColor="var(--accent)" stopOpacity="0.35" />
                <stop offset="1" stopColor="var(--accent)" stopOpacity="0" />
              </radialGradient>
            </defs>
            <g transform={`translate(${cam.x},${cam.y}) scale(${cam.k})`}>
              {/* 階層の段（L1, L2, …） */}
              {Array.from({ length: layout.maxDepth }, (_, i) => (
                <g key={i}>
                  <line x1={b.x0 - 60} x2={b.x1 + 60} y1={(i + 1) * ROW} y2={(i + 1) * ROW} className="kg-ring" />
                  <text x={b.x0 - 64} y={(i + 1) * ROW + 3} className="kg-ring-label kg-level" style={{ fontSize: 9 * labelScale }}>
                    L{i + 1}
                  </text>
                </g>
              ))}
              <circle r={64} fill={`url(#${uid}-core)`} />

              {/* 組織の枝（直角の組織図コネクタ） */}
              {Object.values(state.orgs).map((o) => {
                const s = o.parentId ? get(o.parentId) : undefined;
                const t = get(o.id);
                if (!s || !t) return null;
                const on = lit(s.id, 'org') && lit(t.id, 'org');
                const hot = !!focus && on;
                const lifted = drag?.moved && drag.id === o.id;
                return (
                  <path
                    key={`${s.id}>${t.id}`}
                    d={elbow(s, t)}
                    className={`kg-edge kg-edge-org${hot ? ' is-hot' : ''}${lifted ? ' is-detaching' : ''}`}
                    style={{ opacity: on ? undefined : 0.08 }}
                  />
                );
              })}

              {/* メンバーの葉（組織から垂れる細い幹） */}
              {Object.values(state.orgs).map((o) => {
                const s = get(o.id);
                const ms = membersOf(state, o.id);
                const last = ms.length ? get(ms[ms.length - 1].id) : undefined;
                if (!s || !last) return null;
                const on = lit(o.id, 'org');
                const x = (s.x ?? 0) + LEAF_X;
                return (
                  <g key={`leaf:${o.id}`} className={`kg-edge kg-edge-member${focus && on ? ' is-hot' : ''}`} style={{ opacity: on ? undefined : 0.08 }}>
                    <path
                      d={
                        `M${s.x},${(s.y ?? 0) + s.r}V${(s.y ?? 0) + s.r + 6}H${x}V${last.y}` +
                        ms.map((m) => {
                          const mn = get(m.id);
                          return mn && !(drag?.moved && drag.id === m.id) ? `M${x},${mn.y}H${(mn.x ?? 0) - mn.r}` : '';
                        }).join('')
                      }
                    />
                  </g>
                );
              })}

              {/* 付け替えのゴーストエッジ */}
              {dragNode && targetNode && (
                <g className={`kg-ghost ${target?.valid ? 'ok' : 'ng'}`}>
                  <path d={drag?.kind === 'member' ? `M${targetNode.x},${targetNode.y}L${dragNode.x},${dragNode.y}` : elbow(targetNode, dragNode)} />
                  <circle cx={targetNode.x} cy={targetNode.y} r={targetNode.r + 10} />
                </g>
              )}

              {/* ノード */}
              {nodes.map((n) => {
                const on = lit(n.id, n.kind);
                const isSel = sel?.id === n.id;
                const delta = n.kind === 'org' ? touchedIds.orgs.has(n.id) : touchedIds.members.has(n.id);
                const isHead = heads.has(n.id);
                const carried = !!drag?.moved && drag.carry.has(n.id);
                const memberName =
                  n.kind === 'member' && (showMemberNames || hover === n.id || isSel || carried || (focus && sel?.kind === 'org' && on))
                    ? state.members[n.id]?.name
                    : null;
                return (
                  <g
                    key={n.id}
                    transform={`translate(${n.x ?? 0},${n.y ?? 0})`}
                    className={`kg-node kg-${n.kind}${isSel ? ' is-sel' : ''}${n.id === ROOT_ID ? ' is-root' : ''}${carried ? ' is-drag' : ''}`}
                    style={{ opacity: on ? 1 : 0.14 }}
                    onPointerDown={(e) => onNodeDown(e, n)}
                    onPointerEnter={() => setHover(n.id)}
                    onPointerLeave={() => setHover((h) => (h === n.id ? null : h))}
                  >
                    {delta && <circle r={n.r + 5} className="kg-delta" />}
                    {isSel && <circle r={n.r + 4} className="kg-sel" />}
                    <circle r={n.r} className={`kg-dot${isHead ? ' is-head' : ''}`} />
                    {n.kind === 'org' && <circle r={Math.max(2, n.r * 0.32)} className="kg-core" />}
                    {n.kind === 'org' && (
                      <text y={-n.r - 7} className="kg-label kg-label-org" style={{ fontSize: 10.5 * labelScale }}>
                        {state.orgs[n.id]?.name}
                        <tspan className="kg-count"> ·{headcount(state, n.id)}</tspan>
                      </text>
                    )}
                    {memberName && (
                      <text x={8} dy="0.34em" className="kg-label kg-label-member" style={{ fontSize: 8.5 * labelScale }}>
                        {memberName}
                        {isHead && <tspan className="kg-count"> ◎</tspan>}
                      </text>
                    )}
                  </g>
                );
              })}
            </g>
          </svg>

          {dragNode && (
            <div className={`brain-drop-hint ${target ? (target.valid ? 'ok' : 'ng') : ''}`}>
              {target
                ? target.valid
                  ? `→ ${state.orgs[target.id].name} に${drag?.kind === 'member' ? '異動' : '付け替え'}`
                  : `× ${target.reason}`
                : drag?.kind === 'org'
                  ? '枝ごと運んで、新しい親の組織ノードに重ねる'
                  : '組織ノードに重ねて離す'}
            </div>
          )}

          <button className="brain-fit" onClick={fit} title="全体を表示">⤢ fit</button>
          <div className="brain-hint">drag → 組織に重ねる = 付け替え　click = 詳細　wheel = zoom　⌘Z = undo</div>
          <ChangeLog store={store} />
        </div>

        {sel && (
          <Inspector
            store={store}
            sel={sel}
            setSel={setSel}
            centerOn={centerOn}
            key={`${sel.kind}:${sel.id}`}
          />
        )}
      </div>
    </div>
  );
}

const LEAF_X = -6; // メンバーの列の x（組織ノード中心からのずれ）

/**
 * トップダウンの組織図レイアウト。組織は d3 の tidy tree で並べ、
 * メンバーは所属組織の直下に縦一列で垂らす（深い段ほど下へ伸びる葉）。
 */
function treeLayout(s: OrgState) {
  type TD = { id: string; children: TD[] };
  const build = (id: string): TD => ({ id, children: childOrgs(s, id).map((c) => build(c.id)) });
  const root = tree<TD>()
    .nodeSize([COL, ROW])
    .separation((a, b) => (a.parent === b.parent ? 1 : 1.2))(hierarchy(build(ROOT_ID)));

  const slots = new Map<string, { x: number; y: number }>();
  const bounds = { x0: 0, x1: 0, y0: -30, y1: 0 };
  let maxDepth = 0;
  root.each((n) => {
    slots.set(n.data.id, { x: n.x, y: n.y });
    maxDepth = Math.max(maxDepth, n.depth);
    const ms = membersOf(s, n.data.id);
    ms.forEach((m, i) => slots.set(m.id, { x: n.x + LEAF_X + 12, y: n.y + 30 + i * LEAF_GAP }));
    bounds.x0 = Math.min(bounds.x0, n.x - COL / 2);
    bounds.x1 = Math.max(bounds.x1, n.x + COL / 2);
    bounds.y1 = Math.max(bounds.y1, n.y + 30 + ms.length * LEAF_GAP);
  });
  return { slots, bounds, maxDepth };
}

/** 親の下端 → 段の中間で横に渡り → 子の上端へ降りる、角の丸い直角コネクタ */
function elbow(s: SimulationNodeDatum & { r?: number }, t: SimulationNodeDatum & { r?: number }) {
  const sx = s.x ?? 0;
  const sy = (s.y ?? 0) + (s.r ?? 0);
  const tx = t.x ?? 0;
  const ty = (t.y ?? 0) - (t.r ?? 0) - 18; // 子の名前ラベルの上で止める
  const my = sy + Math.max(20, (ty - sy) * 0.72);
  const dx = tx - sx;
  const rr = Math.min(8, Math.abs(dx) / 2, Math.abs(my - sy) / 2);
  if (Math.abs(dx) < 1) return `M${sx},${sy}V${ty}`;
  const dir = Math.sign(dx);
  return `M${sx},${sy}V${my - rr}Q${sx},${my} ${sx + dir * rr},${my}H${tx - dir * rr}Q${tx},${my} ${tx},${my + rr}V${ty}`;
}

// ── 左: ディレクトリ ─────────────────────────────────────────────────────────

function Directory({
  state,
  sel,
  touchedOrgs,
  onSelect,
  dispatch,
}: {
  state: OrgState;
  sel: Sel;
  touchedOrgs: Set<string>;
  onSelect: (id: string) => void;
  dispatch: OrgEditor['dispatch'];
}) {
  const [over, setOver] = useState<string | null>(null);
  const rows: { id: string; depth: number }[] = [];
  const walk = (id: string, depth: number) => {
    rows.push({ id, depth });
    childOrgs(state, id).forEach((c) => walk(c.id, depth + 1));
  };
  walk(ROOT_ID, 0);
  return (
    <aside className="brain-dir">
      <div className="brain-section-label">directory</div>
      <ul>
        {rows.map(({ id, depth }) => (
          <li
            key={id}
            draggable={id !== ROOT_ID}
            onDragStart={(e) => e.dataTransfer.setData('text/org', id)}
            onDragOver={(e) => (e.preventDefault(), setOver(id))}
            onDragLeave={() => setOver((o) => (o === id ? null : o))}
            onDrop={(e) => {
              const from = e.dataTransfer.getData('text/org');
              if (from) dispatch({ type: 'moveOrg', id: from, parentId: id });
              setOver(null);
            }}
            className={`${sel?.kind === 'org' && sel.id === id ? 'is-sel' : ''} ${over === id ? 'is-over' : ''}`}
            style={{ paddingLeft: 10 + depth * 12 }}
            onClick={() => onSelect(id)}
          >
            <span className="dir-branch">{depth ? '└' : '◉'}</span>
            <span className="dir-name">{state.orgs[id].name}</span>
            {touchedOrgs.has(id) && <span className="dir-delta">Δ</span>}
            <span className="dir-count">{headcount(state, id)}</span>
          </li>
        ))}
      </ul>
    </aside>
  );
}

// ── 右: インスペクター ───────────────────────────────────────────────────────

function Inspector({
  store,
  sel,
  setSel,
  centerOn,
}: {
  store: OrgEditor;
  sel: NonNullable<Sel>;
  setSel: (s: Sel) => void;
  centerOn: (id: string) => void;
}) {
  const { state, dispatch } = store;
  const inputRef = useRef<HTMLInputElement>(null);

  if (sel.kind === 'member') {
    const m = state.members[sel.id];
    if (!m) return null;
    const org = state.orgs[m.orgId];
    const isHead = org.headId === m.id;
    return (
      <aside className="brain-insp">
        <div className="brain-section-label">member</div>
        <div className="insp-name">{m.name}</div>
        <div className="insp-sub">
          {m.title} · {m.grade}
          {isHead && <span className="insp-badge">HEAD</span>}
        </div>
        <label className="insp-field">
          <span>所属</span>
          <OrgSelect state={state} value={m.orgId} onChange={(orgId) => dispatch({ type: 'moveMember', id: m.id, orgId })} />
        </label>
        <div className="insp-actions">
          <button disabled={isHead} onClick={() => dispatch({ type: 'setHead', orgId: org.id, memberId: m.id })}>
            ◎ {org.name} の責任者にする
          </button>
          <button onClick={() => (setSel({ kind: 'org', id: org.id }), centerOn(org.id))}>← {org.name}</button>
        </div>
      </aside>
    );
  }

  const o = state.orgs[sel.id];
  if (!o) return null;
  const direct = membersOf(state, o.id);
  const kids = childOrgs(state, o.id);
  return (
    <aside className="brain-insp">
      <div className="brain-section-label">org · L{depthOf(state, o.id)}</div>
      <input
        ref={inputRef}
        key={o.name}
        className="insp-name insp-input"
        defaultValue={o.name}
        onBlur={(e) => dispatch({ type: 'renameOrg', id: o.id, name: e.target.value })}
        onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
      />
      <div className="insp-path">
        {pathOf(state, o.id).map((p, i, a) => (
          <span key={p.id}>
            <button onClick={() => (setSel({ kind: 'org', id: p.id }), centerOn(p.id))}>{p.name}</button>
            {i < a.length - 1 && ' / '}
          </span>
        ))}
      </div>
      <div className="insp-stats">
        <div><b>{direct.length}</b>直属</div>
        <div><b>{headcount(state, o.id)}</b>配下合計</div>
        <div><b>{kids.length}</b>子組織</div>
      </div>
      <label className="insp-field">
        <span>責任者</span>
        <select value={o.headId ?? ''} onChange={(e) => dispatch({ type: 'setHead', orgId: o.id, memberId: e.target.value || null })}>
          <option value="">— 未設定 —</option>
          {direct.map((m) => (
            <option key={m.id} value={m.id}>{m.name}（{m.title}）</option>
          ))}
        </select>
      </label>
      {o.headId === null && <div className="insp-warn">! 責任者が未設定です</div>}
      <div className="brain-section-label">members</div>
      <ul className="insp-list">
        {direct.map((m) => (
          <li key={m.id} onClick={() => setSel({ kind: 'member', id: m.id })}>
            <span className={`insp-dot${o.headId === m.id ? ' is-head' : ''}`} />
            {m.name}
            <span className="insp-meta">{m.title} · {m.grade}</span>
          </li>
        ))}
        {!direct.length && <li className="insp-empty">直属メンバーなし</li>}
      </ul>
      {!!kids.length && (
        <>
          <div className="brain-section-label">children</div>
          <div className="insp-chips">
            {kids.map((k) => (
              <button key={k.id} onClick={() => (setSel({ kind: 'org', id: k.id }), centerOn(k.id))}>{k.name}</button>
            ))}
          </div>
        </>
      )}
      <div className="insp-actions">
        <button
          onClick={() => {
            const id = newOrgId();
            dispatch({ type: 'addOrg', parentId: o.id, id, name: '新しい組織' });
            setSel({ kind: 'org', id });
          }}
        >
          + 子組織を追加
        </button>
        {o.parentId && (
          <button className="danger" onClick={() => (dispatch({ type: 'deleteOrg', id: o.id }), setSel({ kind: 'org', id: o.parentId! }))}>
            解散（配下は親へ）
          </button>
        )}
      </div>
    </aside>
  );
}

function OrgSelect({ state, value, onChange }: { state: OrgState; value: string; onChange: (id: string) => void }) {
  const opts: { id: string; depth: number }[] = [];
  const walk = (id: string, d: number) => (opts.push({ id, depth: d }), childOrgs(state, id).forEach((c) => walk(c.id, d + 1)));
  walk(ROOT_ID, 0);
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)}>
      {opts.map(({ id, depth }) => (
        <option key={id} value={id}>{'　'.repeat(depth)}{state.orgs[id].name}</option>
      ))}
    </select>
  );
}

// ── 変更ログ ────────────────────────────────────────────────────────────────

function ChangeLog({ store }: { store: OrgEditor }) {
  const { state, base, changes, dispatch, undo, redo, reset, canUndo, canRedo } = store;
  const [open, setOpen] = useState(true);
  return (
    <div className={`brain-log${open ? '' : ' is-closed'}`}>
      <div className="log-head">
        <button className="log-toggle" onClick={() => setOpen(!open)}>
          Δ pending <b>{changes.length}</b>
        </button>
        <span className="log-tools">
          <button disabled={!canUndo} onClick={undo}>undo</button>
          <button disabled={!canRedo} onClick={redo}>redo</button>
          <button disabled={!changes.length} onClick={reset}>reset</button>
        </span>
      </div>
      {open && (
        <ol>
          {changes.map((c) => {
            const t = describe(base, state, c);
            const rev = revertAction(state, c);
            return (
              <li key={c.key}>
                <span className="log-verb">{t.verb}</span>
                <span className="log-subj">{t.subject}</span>
                {t.from && <span className="log-from">{t.from}</span>}
                {t.to && <span className="log-to">→ {t.to}</span>}
                {rev && (
                  <button className="log-rev" title="この変更だけ戻す" onClick={() => dispatch(rev)}>↺</button>
                )}
              </li>
            );
          })}
          {!changes.length && <li className="log-empty">no pending changes — drag a node to begin</li>}
        </ol>
      )}
    </div>
  );
}
