import { useEffect, useId, useMemo, useRef, useState, type CSSProperties, type PointerEvent as RPointerEvent } from 'react';
import { forceSimulation, forceX, forceY, type Simulation, type SimulationNodeDatum } from 'd3-force';
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
  type Member,
  type OrgState,
} from '../../core/model';
import { describe } from '../../core/describe';
import type { OrgEditor } from '../useOrgEditor';
import { tokenStyle, type OrgTheme, type OrgTreeToken, type Tokens } from '../theme';
import { useSize } from '../useSize';

/**
 * OrgTree — FounderOS の G-Brain を参考にした組織グラフ（ツリー版）。
 * 見た目（黒地・緑アクセント・等幅・発光するコア）は Brain を踏襲し、配置は組織図らしく
 * ルートを最上段に置いて下へ枝を広げるトップダウンのツリーにする。
 *
 * - 組織は「コンソールカード」: 深さと人数の見出し、組織名、責任者の席、直属メンバーのグリフ（名字の一文字）。
 * - 葉だけを子に持つ組織は、子を縦に積んでレールでつなぐ（横に広がりすぎない）。
 * - 編集は「カードやグリフを別のカードに重ねる」= 付け替え／異動。組織をつかむと配下の枝ごと持ち上がる。
 */

// カードの寸法（ワールド座標）
const W = 164; // カード幅
const PAD = 12;
const AV = 22; // グリフ（アバター）の直径
const AV_GAP = 5;
const PER_ROW = Math.floor((W - PAD * 2 + AV_GAP) / (AV + AV_GAP)); // 1行のグリフ数
const MAX_ROWS = 3;
const HEAD_Y = 66; // 責任者の席（中心）
const ROW0_Y = 98; // メンバー1行目（中心）
const VGAP = 46; // 親カードの下端 → 子カードの上端
const HGAP = 26; // 兄弟の横間隔
const STACK_GAP = 12; // 縦積みの間隔
const INDENT = 22; // 縦積みの字下げ（レールの分）
const RAIL_X = 12; // 親カード左端からレールまで
const LOD_K = 0.56; // これより引くと、カードの中身を畳んで名前だけを大きく出す

type Kind = 'org' | 'member';
type SimNode = SimulationNodeDatum & { id: string; kind: Kind; tx: number; ty: number; hidden?: boolean };
type Sel = { kind: Kind; id: string } | null;
type Drag = { id: string; kind: Kind; sx: number; sy: number; moved: boolean; carry: Set<string> };
type Target = { id: string; valid: boolean; reason?: string } | null;
type Link = 'elbow' | 'rail';

export type OrgTreeProps = {
  store: OrgEditor;
  /** 見出し。null でヘッダーごと隠す */
  title?: string | null;
  eyebrow?: string;
  /** 配色のプリセット（既定 'dark'） */
  theme?: OrgTheme;
  /** 個別の色・フォントの上書き（CSS 変数 --ock-* と同じ。祖先要素の CSS で指定してもよい） */
  tokens?: Tokens<OrgTreeToken>;
  className?: string;
  style?: CSSProperties;
};

/** 親要素いっぱいに広がる（親に高さが必要）。スタイルは `org-chart-kit/styles.css`。 */
export function OrgTree({ store, title = '組織グラフ', eyebrow = 'org chart', theme = 'dark', tokens, className, style }: OrgTreeProps) {
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
  const layout = useMemo(() => cardLayout(state), [state]);

  // ── simulation：定位置へバネで寄せる（構造が変わるとカードとグリフがするりと組み替わる） ──
  useEffect(() => {
    const sim = forceSimulation<SimNode>()
      .force('x', forceX<SimNode>((d) => d.tx).strength(0.24))
      .force('y', forceY<SimNode>((d) => d.ty).strength(0.24))
      .velocityDecay(0.34)
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
      let n = prev.get(id);
      if (!n) {
        // 新しいカードは親の位置から、グリフは所属カードの位置から現れる
        const parent = kind === 'org' ? state.orgs[id].parentId : state.members[id].orgId;
        const p = parent ? prev.get(parent) : undefined;
        n = { id, kind, tx: slot.x, ty: slot.y, x: p?.x ?? slot.x, y: p?.y ?? slot.y };
      }
      Object.assign(n, { tx: slot.x, ty: slot.y, hidden: slot.hidden });
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
    const bw = b.x1 - b.x0 + 60;
    const bh = b.y1 - b.y0 + 60;
    const k = Math.min(1.1, (size.w - 32) / bw, (size.h - 40) / bh);
    setCam({ k, x: size.w / 2 - ((b.x0 + b.x1) / 2) * k, y: Math.max(24, (size.h - bh * k) / 2) + 30 * k - b.y0 * k });
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
        const k = Math.min(3, Math.max(0.2, c.k * Math.exp(-e.deltaY * 0.0015)));
        return { k, x: px - ((px - c.x) / c.k) * k, y: py - ((py - c.y) / c.k) * k };
      });
    };
    svg.addEventListener('wheel', onWheel, { passive: false });
    return () => svg.removeEventListener('wheel', onWheel);
  }, []);

  const centerOn = (id: string) => {
    const orgId = state.orgs[id] ? id : state.members[id]?.orgId;
    const slot = orgId ? layout.slots.get(orgId) : undefined;
    if (!slot || !size.w) return;
    const h = layout.heights.get(orgId!) ?? 0;
    setCam((c) => {
      const k = Math.max(c.k, 0.8); // 詳細が読める距離まで寄る
      return { k, x: size.w / 2 - slot.x * k, y: size.h / 2.4 - (slot.y + h / 2) * k };
    });
  };

  // ── drag & drop（付け替え） ───────────────────────────────────────────────
  const cardAt = (d: Drag, wx: number, wy: number): Target => {
    let best: { id: string; dist: number } | null = null;
    for (const n of nodesRef.current.values()) {
      if (n.kind !== 'org' || d.carry.has(n.id)) continue;
      const h = layout.heights.get(n.id) ?? 0;
      const x0 = (n.x ?? 0) - W / 2;
      const y0 = n.y ?? 0;
      // カードの矩形との距離（中なら0）。少しだけ外側でも拾う
      const dx = Math.max(x0 - wx, 0, wx - (x0 + W));
      const dy = Math.max(y0 - wy, 0, wy - (y0 + h));
      const dist = Math.hypot(dx, dy);
      if (dist <= 14 && (!best || dist < best.dist)) best = { id: n.id, dist };
    }
    if (!best) return null;
    const id = best.id;
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

  const grabOffset = useRef({ x: 0, y: 0 });
  const onMove = (e: RPointerEvent) => {
    if (drag && drag.id !== ROOT_ID) {
      const moved = drag.moved || Math.hypot(e.clientX - drag.sx, e.clientY - drag.sy) > 4;
      if (!moved) return;
      const head = nodesRef.current.get(drag.id);
      if (!head) return;
      const w = toWorld(e.clientX, e.clientY);
      if (!drag.moved) {
        // つかんだ場所を保ったまま運ぶ（カードの角が指先に飛ばない）
        const s = toWorld(drag.sx, drag.sy);
        grabOffset.current = { x: (head.x ?? 0) - s.x, y: (head.y ?? 0) - s.y };
        setDrag({ ...drag, moved: true });
        setHover(null);
        simRef.current?.alphaTarget(0.3).restart();
      }
      const dx = w.x + grabOffset.current.x - head.tx;
      const dy = w.y + grabOffset.current.y - head.ty;
      for (const id of drag.carry) {
        const n = nodesRef.current.get(id);
        if (n) (n.fx = n.tx + dx), (n.fy = n.ty + dy);
      }
      setTarget(cardAt(drag, w.x, w.y));
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
      } else simRef.current?.alpha(0.6).restart(); // 元の場所へ戻る
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
        .filter((m) => (sel.kind === 'org' ? sub.has(m.orgId) : m.id === sel.id || m.orgId === orgId))
        .map((m) => m.id),
    );
    return { orgs, members };
  }, [sel, state]);

  const lit = (id: string, kind: Kind) => !focus || (kind === 'org' ? focus.orgs : focus.members).has(id);

  const get = (id: string) => nodesRef.current.get(id);
  const orgNodes = [...nodesRef.current.values()].filter((n) => n.kind === 'org');
  const memberNodes = [...nodesRef.current.values()].filter((n) => n.kind === 'member');
  // 運んでいるものは最前面へ
  const carried = (id: string) => !!drag?.moved && drag.carry.has(id);
  const byCarry = (a: SimNode, b: SimNode) => Number(carried(a.id)) - Number(carried(b.id));
  const dragNode = drag?.moved ? get(drag.id) : undefined;
  const targetNode = target ? get(target.id) : undefined;
  const lod = cam.k < LOD_K;
  const hoverMember = hover && state.members[hover] && !drag?.moved ? state.members[hover] : null;

  const linkPath = (childId: string) => {
    const o = state.orgs[childId];
    const s = o?.parentId ? get(o.parentId) : undefined;
    const t = get(childId);
    if (!s || !t) return null;
    const sh = layout.heights.get(s.id) ?? 0;
    return layout.links.get(childId) === 'rail' ? rail(s, sh, t) : elbow(s, sh, t);
  };

  return (
    <div className={`ock-tree${className ? ` ${className}` : ''}`} data-ock-theme={theme} style={tokenStyle(tokens, style)}>
      {title !== null && (
      <header className="brain-head">
        <div>
          <div className="brain-eyebrow">{eyebrow}</div>
          <h1 className="brain-title">
            {title}<span className="brain-caret">_</span>
          </h1>
        </div>
        <div className="brain-legend">
          <span><i className="lg-card" />組織</span>
          <span><i className="lg-glyph">加</i>メンバー</span>
          <span><i className="lg-glyph is-head">中</i>責任者</span>
          <span><i className="lg-vacant" />空席</span>
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
            className={`${drag?.moved ? 'is-dragging' : ''}${lod ? ' is-lod' : ''}`}
          >
            <defs>
              <radialGradient id={`${uid}-core`} r="0.5">
                <stop offset="0" stopColor="var(--_ock-accent)" stopOpacity="0.28" />
                <stop offset="1" stopColor="var(--_ock-accent)" stopOpacity="0" />
              </radialGradient>
            </defs>
            <g transform={`translate(${cam.x},${cam.y}) scale(${cam.k})`}>
              {/* コアの発光（ルートカードの背後） */}
              {get(ROOT_ID) && (
                <ellipse
                  cx={get(ROOT_ID)!.x}
                  cy={(get(ROOT_ID)!.y ?? 0) + (layout.heights.get(ROOT_ID) ?? 0) / 2}
                  rx={W * 1.4}
                  ry={W * 0.9}
                  fill={`url(#${uid}-core)`}
                />
              )}

              {/* 組織の枝 */}
              {Object.values(state.orgs).map((o) => {
                const d = o.parentId ? linkPath(o.id) : null;
                if (!d) return null;
                const on = lit(o.parentId!, 'org') && lit(o.id, 'org');
                return (
                  <path
                    key={`${o.parentId}>${o.id}`}
                    d={d}
                    className={`kg-edge kg-edge-org${focus && on ? ' is-hot' : ''}${drag?.moved && drag.id === o.id ? ' is-detaching' : ''}`}
                    style={{ opacity: on ? undefined : 0.1 }}
                  />
                );
              })}

              {/* 付け替えのゴーストエッジ */}
              {dragNode && targetNode && (
                <g className={`kg-ghost ${target?.valid ? 'ok' : 'ng'}`}>
                  <path
                    d={
                      drag?.kind === 'member'
                        ? `M${targetNode.x},${(targetNode.y ?? 0) + (layout.heights.get(targetNode.id) ?? 0) / 2}L${dragNode.x},${dragNode.y}`
                        : elbow(targetNode, layout.heights.get(targetNode.id) ?? 0, dragNode)
                    }
                  />
                  <rect
                    x={(targetNode.x ?? 0) - W / 2 - 6}
                    y={(targetNode.y ?? 0) - 6}
                    width={W + 12}
                    height={(layout.heights.get(targetNode.id) ?? 0) + 12}
                    className="kg-ghost-frame"
                  />
                </g>
              )}

              {/* 組織カード */}
              {orgNodes.sort(byCarry).map((n) => (
                <OrgCard
                  key={n.id}
                  node={n}
                  state={state}
                  h={layout.heights.get(n.id) ?? 0}
                  overflow={layout.overflow.get(n.id) ?? 0}
                  k={cam.k}
                  lit={lit(n.id, 'org')}
                  selected={sel?.kind === 'org' && sel.id === n.id}
                  changed={touchedIds.orgs.has(n.id)}
                  carried={carried(n.id)}
                  isDropTarget={target?.id === n.id}
                  onPointerDown={(e) => onNodeDown(e, n)}
                />
              ))}

              {/* メンバーのグリフ */}
              {memberNodes.sort(byCarry).map((n) => {
                const m = state.members[n.id];
                if (!m) return null;
                const org = state.orgs[m.orgId];
                const isHead = org?.headId === m.id;
                const isSel = sel?.kind === 'member' && sel.id === m.id;
                return (
                  <g
                    key={n.id}
                    transform={`translate(${n.x ?? 0},${n.y ?? 0})`}
                    className={[
                      'kg-node kg-member',
                      isHead ? 'is-head' : '',
                      isSel ? 'is-sel' : '',
                      touchedIds.members.has(m.id) ? 'is-changed' : '',
                      carried(m.id) ? 'is-drag' : '',
                      n.hidden && !carried(m.id) ? 'is-hidden' : '',
                    ].join(' ')}
                    data-name={m.name}
                    data-org={m.orgId}
                    style={{ opacity: lit(m.id, 'member') ? undefined : 0.16 }}
                    onPointerDown={(e) => onNodeDown(e, n)}
                    onPointerEnter={() => setHover(m.id)}
                    onPointerLeave={() => setHover((h) => (h === m.id ? null : h))}
                  >
                    {touchedIds.members.has(m.id) && <circle r={AV / 2 + 4} className="kg-delta" />}
                    <circle r={AV / 2} className="kg-dot kg-av" />
                    <text className="kg-av-char" dy="0.36em">{m.name[0]}</text>
                  </g>
                );
              })}

              {/* グリフのツールチップ */}
              {hoverMember && get(hoverMember.id) && (
                <GlyphTip m={hoverMember} x={get(hoverMember.id)!.x ?? 0} y={get(hoverMember.id)!.y ?? 0} k={cam.k} state={state} />
              )}
            </g>
          </svg>

          {dragNode && (
            <div className={`brain-drop-hint ${target ? (target.valid ? 'ok' : 'ng') : ''}`}>
              {target
                ? target.valid
                  ? `→ ${state.orgs[target.id].name} に${drag?.kind === 'member' ? '異動' : '付け替え'}`
                  : `× ${target.reason}`
                : drag?.kind === 'org'
                  ? '枝ごと運んで、新しい親のカードに重ねる'
                  : '異動先のカードに重ねて離す'}
            </div>
          )}

          <button className="brain-fit" onClick={fit} title="全体を表示">⤢ fit</button>
          <div className="brain-hint">drag → カードに重ねる = 付け替え・異動　click = 詳細　wheel = zoom</div>
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

// ── カード ──────────────────────────────────────────────────────────────────

function OrgCard({
  node,
  state,
  h,
  overflow,
  k,
  lit,
  selected,
  changed,
  carried,
  isDropTarget,
  onPointerDown,
}: {
  node: SimNode;
  state: OrgState;
  h: number;
  overflow: number;
  k: number;
  lit: boolean;
  selected: boolean;
  changed: boolean;
  carried: boolean;
  isDropTarget: boolean;
  onPointerDown: (e: RPointerEvent) => void;
}) {
  const o = state.orgs[node.id];
  if (!o) return null;
  const isRoot = o.id === ROOT_ID;
  const head = o.headId ? state.members[o.headId] : undefined;
  const hc = headcount(state, o.id);
  const direct = membersOf(state, o.id).length;
  const kids = childOrgs(state, o.id).length;
  const nameSize = o.name.length > 10 ? 12 : 13.5;
  // 引いたとき（LOD）は名前だけを、画面上で読める大きさに拡大して出す
  const lodSize = Math.min(22, Math.max(13, 11 / k), (W - 20) / Math.max(4, o.name.length));

  return (
    <g
      transform={`translate(${(node.x ?? 0) - W / 2},${node.y ?? 0})`}
      className={[
        'kg-org kg-card',
        isRoot ? 'is-root' : '',
        selected ? 'is-sel' : '',
        changed ? 'is-changed' : '',
        carried ? 'is-drag' : '',
        isDropTarget ? 'is-target' : '',
        head ? '' : 'is-vacant',
      ].join(' ')}
      data-org={o.id}
      style={{ opacity: lit ? undefined : 0.16 }}
      onPointerDown={onPointerDown}
    >
      <rect className="kg-card-bg" width={W} height={h} />
      {changed && <rect className="kg-card-delta" x={-4} y={-4} width={W + 8} height={h + 8} />}
      <circle className="kg-dot kg-port" cx={W / 2} cy={0} r={2.6} />
      {kids > 0 && <circle className="kg-port" cx={W / 2} cy={h} r={2.6} />}

      <g className="kg-card-detail">
        <circle className="kg-card-core" cx={PAD + 3} cy={PAD + 6} r={isRoot ? 3.4 : 2.6} />
        <text className="kg-eyebrow" x={PAD + 12} y={PAD + 9}>
          {isRoot ? 'ROOT' : `L${depthOf(state, o.id)}`} · {hc}名{kids ? ` · ${kids}組織` : ''}
        </text>
        <text className="kg-card-name" x={PAD} y={PAD + 29} style={{ fontSize: nameSize }}>
          {o.name}
        </text>
        <line className="kg-hair" x1={PAD} x2={W - PAD} y1={PAD + 38} y2={PAD + 38} />
        {head ? (
          <>
            <text className="kg-head-name" x={PAD + AV + 8} y={HEAD_Y - 2}>{head.name}</text>
            <text className="kg-head-title" x={PAD + AV + 8} y={HEAD_Y + 10}>{head.title} · {head.grade}</text>
          </>
        ) : (
          <>
            <circle className="kg-vacant-seat" cx={PAD + AV / 2} cy={HEAD_Y} r={AV / 2} />
            <text className="kg-vacant-label" x={PAD + AV + 8} y={HEAD_Y + 4}>責任者 空席</text>
          </>
        )}
        {direct - (head ? 1 : 0) > 0 && <line className="kg-hair is-faint" x1={PAD} x2={W - PAD} y1={HEAD_Y + 18} y2={HEAD_Y + 18} />}
        {overflow > 0 && (
          <text className="kg-overflow" x={W - PAD} y={h - PAD + 1}>+{overflow}</text>
        )}
      </g>

      <g className="kg-card-lod">
        <text x={W / 2} y={h / 2 - 2} style={{ fontSize: lodSize }}>{o.name}</text>
        <text className="kg-lod-count" x={W / 2} y={h / 2 + lodSize * 0.9} style={{ fontSize: lodSize * 0.62 }}>
          {hc}名
        </text>
      </g>
    </g>
  );
}

function GlyphTip({ m, x, y, k, state }: { m: Member; x: number; y: number; k: number; state: OrgState }) {
  const s = 1 / Math.max(0.7, Math.min(k, 1.6));
  const org = state.orgs[m.orgId];
  const line1 = m.name;
  const line2 = `${m.title} · ${m.grade}${org?.headId === m.id ? ' · 責任者' : ''}`;
  const w = Math.max(line1.length * 12, line2.length * 7.6) * s + 18 * s;
  return (
    <g className="kg-tip" transform={`translate(${x},${y - AV / 2 - 8})`} style={{ pointerEvents: 'none' }}>
      <rect x={-w / 2} y={-40 * s} width={w} height={34 * s} />
      <text y={-25 * s} style={{ fontSize: 12 * s }}>{line1}</text>
      <text className="kg-tip-sub" y={-12 * s} style={{ fontSize: 9.5 * s }}>{line2}</text>
    </g>
  );
}

/**
 * カードのレイアウト（ワールド座標）。組織の位置はカードの上辺中央。
 * - 子が複数あり、1つでも孫を持つ場合は横に並べて親を中央に（直角コネクタ）。
 * - 子がすべて葉なら、親の下に字下げして縦に積む（左のレールでつなぐ）。
 * メンバーは所属カードの中：責任者は「席」、それ以外は下のグリフ列。
 */
function cardLayout(s: OrgState) {
  const slots = new Map<string, { x: number; y: number; hidden?: boolean }>();
  const heights = new Map<string, number>();
  const links = new Map<string, Link>();
  const overflow = new Map<string, number>();

  const others = (id: string) => {
    const o = s.orgs[id];
    return membersOf(s, id).filter((m) => m.id !== o.headId);
  };
  const cardH = (id: string) => {
    const n = others(id).length;
    const rows = Math.min(MAX_ROWS, Math.ceil(n / PER_ROW));
    return rows ? ROW0_Y + (rows - 1) * (AV + AV_GAP) + AV / 2 + PAD : HEAD_Y + AV / 2 + PAD;
  };
  const isLeaf = (id: string) => childOrgs(s, id).length === 0;
  const stacked = (id: string) => {
    const kids = childOrgs(s, id);
    return kids.length > 0 && kids.every((c) => isLeaf(c.id));
  };

  // 部分木の幅
  const widthMemo = new Map<string, number>();
  const width = (id: string): number => {
    if (widthMemo.has(id)) return widthMemo.get(id)!;
    const kids = childOrgs(s, id);
    const w = !kids.length ? W : stacked(id) ? W + INDENT : kids.reduce((a, c) => a + width(c.id), 0) + HGAP * (kids.length - 1);
    widthMemo.set(id, Math.max(W, w));
    return widthMemo.get(id)!;
  };

  const bounds = { x0: Infinity, x1: -Infinity, y0: Infinity, y1: -Infinity };
  const placeCard = (id: string, cx: number, top: number) => {
    const h = cardH(id);
    heights.set(id, h);
    slots.set(id, { x: cx, y: top });
    bounds.x0 = Math.min(bounds.x0, cx - W / 2);
    bounds.x1 = Math.max(bounds.x1, cx + W / 2);
    bounds.y0 = Math.min(bounds.y0, top);
    bounds.y1 = Math.max(bounds.y1, top + h);
    // メンバー：責任者の席、残りはグリフ列
    const o = s.orgs[id];
    const left = cx - W / 2;
    if (o.headId && s.members[o.headId]?.orgId === id) slots.set(o.headId, { x: left + PAD + AV / 2, y: top + HEAD_Y });
    const rest = others(id);
    const cap = PER_ROW * MAX_ROWS;
    rest.forEach((m, i) => {
      const j = Math.min(i, cap - 1);
      slots.set(m.id, {
        x: left + PAD + AV / 2 + (j % PER_ROW) * (AV + AV_GAP),
        y: top + ROW0_Y + Math.floor(j / PER_ROW) * (AV + AV_GAP),
        hidden: i >= cap - 1 && rest.length > cap,
      });
    });
    overflow.set(id, rest.length > cap ? rest.length - cap + 1 : 0);
    return h;
  };

  const place = (id: string, left: number, top: number) => {
    const kids = childOrgs(s, id);
    const w = width(id);
    if (!kids.length) {
      placeCard(id, left + w / 2, top);
      return;
    }
    if (stacked(id)) {
      const h = placeCard(id, left + W / 2, top);
      let y = top + h + VGAP * 0.6;
      for (const c of kids) {
        links.set(c.id, 'rail');
        placeCard(c.id, left + INDENT + W / 2, y);
        y += heights.get(c.id)! + STACK_GAP;
      }
      return;
    }
    // 横並び：子を先に置いて、親を子の中心の中央へ
    const h = cardH(id);
    let x = left + (w - (kids.reduce((a, c) => a + width(c.id), 0) + HGAP * (kids.length - 1))) / 2;
    const centers: number[] = [];
    for (const c of kids) {
      links.set(c.id, 'elbow');
      place(c.id, x, top + h + VGAP);
      centers.push(slots.get(c.id)!.x);
      x += width(c.id) + HGAP;
    }
    placeCard(id, (centers[0] + centers[centers.length - 1]) / 2, top);
  };
  place(ROOT_ID, -width(ROOT_ID) / 2, 0);

  return { slots, heights, links, overflow, bounds };
}

/** 親カードの下辺 → 段の中間で横に渡り → 子カードの上辺へ降りる、角の丸い直角コネクタ */
function elbow(s: SimulationNodeDatum, sh: number, t: SimulationNodeDatum) {
  const sx = s.x ?? 0;
  const sy = (s.y ?? 0) + sh;
  const tx = t.x ?? 0;
  const ty = t.y ?? 0;
  const my = sy + Math.max(10, (ty - sy) / 2);
  const dx = tx - sx;
  const rr = Math.min(8, Math.abs(dx) / 2, Math.abs(my - sy) / 2, Math.abs(ty - my) / 2);
  if (Math.abs(dx) < 1) return `M${sx},${sy}V${ty}`;
  const dir = Math.sign(dx);
  return `M${sx},${sy}V${my - rr}Q${sx},${my} ${sx + dir * rr},${my}H${tx - dir * rr}Q${tx},${my} ${tx},${my + rr}V${ty}`;
}

/** 縦積み用：親カード左寄りのレールを下り、子カードの左辺へ入る */
function rail(s: SimulationNodeDatum, sh: number, t: SimulationNodeDatum) {
  const rx = (s.x ?? 0) - W / 2 + RAIL_X;
  const sy = (s.y ?? 0) + sh;
  const tx = (t.x ?? 0) - W / 2;
  const ty = (t.y ?? 0) + 22;
  const rr = Math.min(7, Math.abs(tx - rx) / 2);
  return `M${rx},${sy}V${ty - rr}Q${rx},${ty} ${rx + rr},${ty}H${tx}`;
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
