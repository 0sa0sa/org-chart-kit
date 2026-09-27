import { useEffect, useId, useMemo, useRef, useState, type CSSProperties, type PointerEvent as RPointerEvent } from 'react';
import { hierarchy, pack, type HierarchyCircularNode } from 'd3-hierarchy';
import {
  ROOT_ID,
  canMoveOrg,
  childOrgs,
  headcount,
  membersOf,
  newOrgId,
  pathOf,
  revertAction,
  subtreeIds,
  touched,
  type Change,
  type OrgState,
} from '../../core/model';
import { describe } from '../../core/describe';
import type { OrgEditor } from '../useOrgEditor';
import { tokenStyle, type OrgMapToken, type OrgTheme, type Tokens } from '../theme';
import { useSize } from '../useSize';

/**
 * OrgMap — 「組織の地図」。
 * 親子関係を矢印ではなく「内側にあること」で表す。組織は区画（入れ子の円）、メンバーは石。
 * 石や区画を別の区画の内側へ落とすと所属が変わる。元の所属からは朱の糸が伸び、異動案の帳面に記録される。
 */

const S = 1000; // パックレイアウトの仮想座標系

type PData = { id: string; kind: 'org' | 'member' | 'pad'; children?: PData[] };
type PNode = HierarchyCircularNode<PData>;
type Sel = { kind: 'org' | 'member'; id: string } | null;
type Drag = { kind: 'org' | 'member'; id: string; sx: number; sy: number; moved: boolean; wx: number; wy: number };
type VB = { x: number; y: number; w: number; h: number };

const padOf = (height: number) => (height > 2 ? 30 : height > 1 ? 24 : 14);

const KANJI = '〇一二三四五六七八九';
const kanjiNum = (n: number): string =>
  n <= 10 ? (n === 10 ? '十' : KANJI[n]) : n < 20 ? `十${KANJI[n - 10]}` : `${KANJI[Math.floor(n / 10)]}十${n % 10 ? KANJI[n % 10] : ''}`;

export type OrgMapProps = {
  store: OrgEditor;
  /** 左の背表紙の縦書きタイトル。null で背表紙ごと隠す */
  title?: string | null;
  subtitle?: string;
  /** 帳面の見出し横の注記（例: 「第一稿　二〇二六年九月」） */
  planLabel?: string;
  /** 配色のプリセット（既定 'light'） */
  theme?: OrgTheme;
  /** 個別の色・フォントの上書き（CSS 変数 --ock-* と同じ。祖先要素の CSS で指定してもよい） */
  tokens?: Tokens<OrgMapToken>;
  className?: string;
  style?: CSSProperties;
};

/** 親要素いっぱいに広がる（親に高さが必要）。スタイルは `org-chart-kit/styles.css`。 */
export function OrgMap({ store, title = '組織の地図', subtitle = 'ORG MAP', planLabel = '', theme = 'light', tokens, className, style }: OrgMapProps) {
  const uid = useId().replace(/:/g, '');
  const { state, base, changes, dispatch } = store;
  const [wrapRef, size] = useSize<HTMLDivElement>();
  const svgRef = useRef<SVGSVGElement>(null);
  const [sel, setSel] = useState<Sel>(null);
  const [zoomId, setZoomId] = useState<string>(ROOT_ID);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [hover, setHover] = useState<{ id: string; x: number; y: number } | null>(null);
  const [spot, setSpot] = useState<string | null>(null); // 帳面ホバー中の変更
  const touchedIds = useMemo(() => touched(changes), [changes]);

  // ── layout ────────────────────────────────────────────────────────────────
  const layout = useMemo(() => {
    const heads = new Set(Object.values(state.orgs).map((o) => o.headId));
    const build = (id: string): PData => {
      const kids: PData[] = [
        ...childOrgs(state, id).map((c) => build(c.id)),
        ...membersOf(state, id).map((m) => ({ id: m.id, kind: 'member' as const })),
      ];
      return { id, kind: 'org', children: kids.length ? kids : [{ id: `pad:${id}`, kind: 'pad' }] };
    };
    const root = hierarchy(build(ROOT_ID)).sum((d) =>
      d.kind === 'member' ? (heads.has(d.id) ? 1.5 : 1) : d.kind === 'pad' ? 2.6 : 0,
    );
    const packed = pack<PData>()
      .size([S, S])
      .padding((d) => (d.data.kind === 'org' ? padOf(d.height) : 0))(root);
    const orgs = new Map<string, PNode>();
    const members = new Map<string, PNode>();
    packed.each((n) => {
      if (n.data.kind === 'org') orgs.set(n.data.id, n);
      else if (n.data.kind === 'member') members.set(n.data.id, n);
    });
    return { orgs, members, heads };
  }, [state]);

  // ── camera（viewBox をなめらかに寄せる） ───────────────────────────────────
  const targetVB = useMemo<VB>(() => {
    const n = layout.orgs.get(zoomId) ?? layout.orgs.get(ROOT_ID)!;
    const aspect = size.w && size.h ? size.w / size.h : 1;
    const pad = n.r * 0.12 + 10;
    // 小さな区画に寄りすぎて石が巨大化しないよう、見える範囲に下限を設ける
    const span = Math.max((n.r + pad) * 2, S * 0.3);
    let h = span;
    let w = h * aspect;
    if (w < h) (w = span), (h = w / aspect);
    return { x: n.x - w / 2, y: n.y - h / 2, w, h };
  }, [layout, zoomId, size]);

  const [vb, setVb] = useState<VB>(targetVB);
  const vbRef = useRef(vb);
  vbRef.current = vb;
  const first = useRef(true);
  useEffect(() => {
    if (first.current && size.w) {
      first.current = false;
      setVb(targetVB);
      return;
    }
    let raf = 0;
    const step = () => {
      const c = vbRef.current;
      const k = 0.16;
      const n = {
        x: c.x + (targetVB.x - c.x) * k,
        y: c.y + (targetVB.y - c.y) * k,
        w: c.w + (targetVB.w - c.w) * k,
        h: c.h + (targetVB.h - c.h) * k,
      };
      const done = Math.abs(n.w - targetVB.w) < 0.5 && Math.abs(n.x - targetVB.x) < 0.5 && Math.abs(n.y - targetVB.y) < 0.5;
      setVb(done ? targetVB : n);
      if (!done) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [targetVB, size.w]);

  const scale = size.w ? size.w / vb.w : 1; // 仮想座標 1 あたりの画面 px

  useEffect(() => {
    if (!state.orgs[zoomId]) setZoomId(ROOT_ID);
    if (sel && !(sel.kind === 'org' ? state.orgs[sel.id] : state.members[sel.id])) setSel(null);
  }, [state]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || (e.target as HTMLElement)?.closest('input, select')) return;
      const parent = state.orgs[zoomId]?.parentId;
      if (sel) setSel(null);
      else if (parent) setZoomId(parent);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [sel, zoomId, state]);

  // ── pointer ───────────────────────────────────────────────────────────────
  const toWorld = (cx: number, cy: number) => {
    const r = svgRef.current!.getBoundingClientRect();
    const c = vbRef.current;
    return { x: c.x + ((cx - r.left) / r.width) * c.w, y: c.y + ((cy - r.top) / r.height) * c.h };
  };

  /** 点を含む最も深い区画。組織をドラッグ中はその配下を除外する。 */
  const territoryAt = (wx: number, wy: number, exclude?: Set<string>) => {
    let best: PNode | null = null;
    for (const n of layout.orgs.values()) {
      if (exclude?.has(n.data.id)) continue;
      if (Math.hypot(n.x - wx, n.y - wy) <= n.r && (!best || n.depth > best.depth)) best = n;
    }
    return best?.data.id ?? null;
  };

  const excluded = useMemo(
    () => (drag?.kind === 'org' ? subtreeIds(state, drag.id) : undefined),
    [drag?.kind, drag?.id, state],
  );
  const dropId = drag?.moved ? territoryAt(drag.wx, drag.wy, excluded) : null;
  const dropState: 'ok' | 'same' | null = (() => {
    if (!drag?.moved || !dropId) return null;
    if (drag.kind === 'member') return state.members[drag.id]?.orgId === dropId ? 'same' : 'ok';
    return canMoveOrg(state, drag.id, dropId) ? 'ok' : 'same';
  })();

  const onDown = (e: RPointerEvent, kind: 'org' | 'member', id: string) => {
    e.stopPropagation();
    if (e.button !== 0) return;
    svgRef.current?.setPointerCapture(e.pointerId);
    const w = toWorld(e.clientX, e.clientY);
    setDrag({ kind, id, sx: e.clientX, sy: e.clientY, moved: false, wx: w.x, wy: w.y });
  };

  const onMove = (e: RPointerEvent) => {
    if (!drag) return;
    const moved = drag.moved || Math.hypot(e.clientX - drag.sx, e.clientY - drag.sy) > 5;
    if (!moved) return;
    if (drag.kind === 'org' && drag.id === ROOT_ID) return;
    const w = toWorld(e.clientX, e.clientY);
    setDrag({ ...drag, moved: true, wx: w.x, wy: w.y });
    setHover(null);
  };

  // pointer capture で dblclick が svg に吸われるので、同じ区画への素早い2回クリックを自前で判定する
  const lastClick = useRef({ id: '', t: 0 });
  const onUp = () => {
    if (!drag) return;
    if (!drag.moved) {
      const now = performance.now();
      const dbl = lastClick.current.id === drag.id && now - lastClick.current.t < 380;
      lastClick.current = { id: drag.id, t: now };
      if (dbl && drag.kind === 'org') setZoomId(drag.id);
      setSel({ kind: drag.kind, id: drag.id });
    } else if (dropId && dropState === 'ok') {
      dispatch(
        drag.kind === 'member'
          ? { type: 'moveMember', id: drag.id, orgId: dropId }
          : { type: 'moveOrg', id: drag.id, parentId: dropId },
      );
      setSel({ kind: drag.kind, id: drag.id });
    }
    setDrag(null);
  };

  // ── render helpers ────────────────────────────────────────────────────────
  const orgList = [...layout.orgs.values()].sort((a, b) => a.depth - b.depth);
  const memberList = [...layout.members.values()];
  const spotIds = useMemo(() => {
    const c = changes.find((x) => x.key === spot);
    if (!c) return new Set<string>();
    if (c.kind === 'member-move') return new Set([c.memberId, c.from, c.to]);
    if (c.kind === 'org-move') return new Set([c.orgId, c.from, c.to]);
    if (c.kind === 'org-remove') return new Set<string>();
    return new Set([c.orgId]);
  }, [spot, changes]);

  const threads = changes.filter((c): c is Extract<Change, { kind: 'member-move' }> => c.kind === 'member-move');
  const draggedNode = drag?.moved ? (drag.kind === 'org' ? layout.orgs.get(drag.id) : layout.members.get(drag.id)) : undefined;

  return (
    <div className={`ock-map${className ? ` ${className}` : ''}`} data-ock-theme={theme} style={tokenStyle(tokens, style)}>
      {title !== null && (
        <div className="t-spine">
          <div className="t-spine-title">{title}</div>
          <div className="t-spine-sub">{subtitle}</div>
        </div>
      )}

      <div className="t-map" ref={wrapRef}>
        <nav className="t-crumbs">
          {pathOf(state, zoomId).map((o, i, a) => (
            <span key={o.id}>
              <button onClick={() => setZoomId(o.id)} className={i === a.length - 1 ? 'is-cur' : ''}>{o.name}</button>
              {i < a.length - 1 && <em>›</em>}
            </span>
          ))}
        </nav>

        <svg
          ref={svgRef}
          width={size.w}
          height={size.h}
          viewBox={`${vb.x} ${vb.y} ${vb.w} ${vb.h}`}
          onPointerMove={onMove}
          onPointerUp={onUp}
          onPointerDown={() => {
            // 余白での素早い2回クリックで一段引く（区画側と同じ判定に揃える）
            const now = performance.now();
            const dbl = lastClick.current.id === '#bg' && now - lastClick.current.t < 380;
            lastClick.current = { id: '#bg', t: now };
            const p = state.orgs[zoomId]?.parentId;
            if (dbl && p) setZoomId(p);
            setSel(null);
          }}
          className={drag?.moved ? 'is-dragging' : ''}
          style={{ ['--_ock-px' as string]: 1 / scale } as CSSProperties}
        >
          <defs>
            <pattern id={`${uid}-hatch`} width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(35)">
              <line y2="6" className="t-hatch-line" />
            </pattern>
          </defs>

          {/* 区画 */}
          {orgList.map((n) => {
            const id = n.data.id;
            const o = state.orgs[id];
            const isNew = !base.orgs[id];
            const isDrop = dropId === id;
            const isSel = sel?.kind === 'org' && sel.id === id;
            const ghosted = drag?.moved && drag.kind === 'org' && excluded?.has(id);
            // ラベルは親の余白帯（padding）に収まる大きさまで
            const fs = Math.max(6, Math.min(padOf(n.height) * 0.62, n.r * 0.16));
            const ar = n.r - fs * 0.95;
            const labelArc = `M${-ar},0 A${ar},${ar} 0 0 1 ${ar},0`;
            const cls = [
              't-org',
              `d${Math.min(n.depth, 4)}`,
              isDrop ? `is-drop ${dropState}` : '',
              isSel ? 'is-sel' : '',
              touchedIds.orgs.has(id) ? 'is-touched' : '',
              spotIds.has(id) ? 'is-spot' : '',
              ghosted ? 'is-ghost' : '',
            ].join(' ');
            return (
              <g
                key={id}
                className={cls}
                style={{ transform: `translate(${n.x}px, ${n.y}px)` }}
                onPointerDown={(e) => onDown(e, 'org', id)}
              >
                <circle className="t-org-fill" style={{ r: n.r } as CSSProperties} />
                {isNew && <circle className="t-org-hatch" fill={`url(#${uid}-hatch)`} style={{ r: n.r } as CSSProperties} />}
                <circle className="t-org-contour" style={{ r: Math.max(0, n.r - 3.2) } as CSSProperties} />
                <path id={`${uid}-arc-${id}`} d={labelArc} className="t-arc" />
                <text className={`t-org-label${n.depth === 0 ? ' is-root' : ''}`} style={{ fontSize: fs }}>
                  <textPath href={`#${uid}-arc-${id}`} startOffset="50%">
                    {o.name}
                  </textPath>
                </text>
                {n.r * scale > 60 && (
                  <text className="t-org-count" y={n.r - fs * 0.4} style={{ fontSize: fs * 0.62 }}>
                    {headcount(state, id)}名{o.headId === null ? '・責任者空席' : ''}
                  </text>
                )}
                {o.headId === null && (
                  <rect className="t-vacant" x={-fs * 0.45} y={-n.r - fs * 0.45} width={fs * 0.9} height={fs * 0.9} />
                )}
                {isNew && <Tag y={-n.r} fs={fs}>新設</Tag>}
                {!isNew && touchedIds.orgs.has(id) && base.orgs[id]?.parentId !== o.parentId && <Tag y={-n.r} fs={fs}>移設</Tag>}
              </g>
            );
          })}

          {/* 異動の糸：元の区画の中心から石へ */}
          {threads.map((c) => {
            const from = layout.orgs.get(c.from);
            const to = layout.members.get(c.memberId);
            if (!from || !to) return null;
            const mx = (from.x + to.x) / 2 + (to.y - from.y) * 0.18;
            const my = (from.y + to.y) / 2 - (to.x - from.x) * 0.18;
            const d = `M ${from.x} ${from.y} Q ${mx} ${my} ${to.x} ${to.y}`;
            return (
              <g key={c.key} className={`t-thread${spot === c.key ? ' is-spot' : ''}`}>
                <path style={{ d: `path('${d}')` } as CSSProperties} />
                <circle className="t-thread-origin" cx={from.x} cy={from.y} r={3.2} />
              </g>
            );
          })}

          {/* 石 */}
          {memberList.map((n) => {
            const m = state.members[n.data.id];
            const isHead = layout.heads.has(m.id);
            const r = n.r * 0.86;
            const showName = n.r * scale > 17;
            const cls = [
              't-stone',
              isHead ? 'is-head' : '',
              sel?.kind === 'member' && sel.id === m.id ? 'is-sel' : '',
              touchedIds.members.has(m.id) ? 'is-moved' : '',
              spotIds.has(m.id) ? 'is-spot' : '',
              drag?.moved && drag.id === m.id ? 'is-lifted' : '',
            ].join(' ');
            return (
              <g
                key={m.id}
                className={cls}
                style={{ transform: `translate(${n.x}px, ${n.y}px)` }}
                onPointerDown={(e) => onDown(e, 'member', m.id)}
                onPointerEnter={(e) => !drag && setHover({ id: m.id, x: e.clientX, y: e.clientY })}
                onPointerLeave={() => setHover((h) => (h?.id === m.id ? null : h))}
              >
                {isHead ? (
                  <rect className="t-stone-body" x={-r} y={-r} width={r * 2} height={r * 2} rx={r * 0.22} />
                ) : (
                  <circle className="t-stone-body" r={r} />
                )}
                <text className="t-stone-char" style={{ fontSize: r * 1.05 }} dy="0.36em">
                  {m.name[0]}
                </text>
                {showName && (
                  <text className="t-stone-name" y={r + r * 0.62} style={{ fontSize: Math.min(r * 0.5, 9) }}>
                    {m.name}
                  </text>
                )}
              </g>
            );
          })}

          {/* ドラッグ中の持ち上げた石／区画 */}
          {draggedNode && drag && (
            <g className="t-lift" transform={`translate(${drag.wx},${drag.wy})`}>
              {drag.kind === 'member' ? (
                <>
                  <circle r={draggedNode.r * 1.25} className="t-lift-shadow" />
                  <circle r={draggedNode.r} className="t-lift-body" />
                  <text dy="0.36em" style={{ fontSize: draggedNode.r * 1.05 }}>{state.members[drag.id].name[0]}</text>
                </>
              ) : (
                <>
                  <circle r={Math.min(draggedNode.r, vb.w * 0.12)} className="t-lift-ring" />
                  <text dy="0.36em" style={{ fontSize: Math.max(9, vb.w * 0.016) }}>{state.orgs[drag.id].name}</text>
                </>
              )}
            </g>
          )}
        </svg>

        {drag?.moved && (
          <div className={`t-drop-caption ${dropState ?? ''}`}>
            {dropId
              ? dropState === 'ok'
                ? <>「{state.orgs[dropId].name}」へ{drag.kind === 'member' ? '異動' : '移設'}</>
                : <>ここは今の居場所です</>
              : <>区画の内側で離してください</>}
          </div>
        )}

        {hover && !drag && state.members[hover.id] && (
          <MemberTip state={state} id={hover.id} x={hover.x} y={hover.y} />
        )}

        <div className="t-legend">
          <span><i className="lg-terr" />区画＝組織</span>
          <span><i className="lg-stone" />石＝メンバー</span>
          <span><i className="lg-seal" />印＝責任者</span>
          <span><i className="lg-vac" />空席</span>
          <span><i className="lg-thread" />異動の糸</span>
        </div>
        <div className="t-howto">石・区画を別の区画の内側へ置く ／ ダブルクリックで寄る・背景で引く ／ Esc</div>
      </div>

      <Ledger
        store={store}
        planLabel={planLabel}
        sel={sel}
        setSel={setSel}
        zoomTo={setZoomId}
        spot={spot}
        setSpot={setSpot}
      />
    </div>
  );
}

function Tag({ y, fs, children }: { y: number; fs: number; children: string }) {
  const w = fs * 2.6;
  return (
    <g className="t-tag" transform={`translate(${fs * 1.4}, ${y - fs * 0.2}) rotate(-8)`}>
      <rect x={-w / 2} y={-fs * 0.62} width={w} height={fs * 1.24} rx={fs * 0.12} />
      <text dy="0.36em" style={{ fontSize: fs * 0.72 }}>{children}</text>
    </g>
  );
}

function MemberTip({ state, id, x, y }: { state: OrgState; id: string; x: number; y: number }) {
  const m = state.members[id];
  const org = state.orgs[m.orgId];
  return (
    <div className="t-tip" style={{ left: x + 14, top: y + 14 }}>
      <b>{m.name}</b>
      <span>{m.title}・{m.grade}</span>
      <span className="t-tip-org">{org.name}{org.headId === m.id ? '　責任者' : ''}</span>
    </div>
  );
}

// ── 右: 帳面（選択カード＋異動案） ─────────────────────────────────────────────

function Ledger({
  store,
  planLabel,
  sel,
  setSel,
  zoomTo,
  spot,
  setSpot,
}: {
  store: OrgEditor;
  planLabel: string;
  sel: Sel;
  setSel: (s: Sel) => void;
  zoomTo: (id: string) => void;
  spot: string | null;
  setSpot: (k: string | null) => void;
}) {
  const { state, base, changes, dispatch, undo, redo, reset, canUndo, canRedo } = store;
  const counts = changes.reduce<Record<string, number>>((a, c) => ((a[c.kind] = (a[c.kind] ?? 0) + 1), a), {});

  return (
    <aside className="t-ledger">
      {sel && <Card key={`${sel.kind}:${sel.id}`} store={store} sel={sel} setSel={setSel} zoomTo={zoomTo} />}

      <section className="t-plan">
        <header>
          <h2>異動案</h2>
          <span className="t-plan-meta">{planLabel}</span>
        </header>
        <div className="t-plan-sum">
          <span><b>{counts['member-move'] ?? 0}</b>名 異動</span>
          <span><b>{counts['org-move'] ?? 0}</b> 移設</span>
          <span><b>{counts['org-add'] ?? 0}</b> 新設</span>
          <span><b>{(counts['org-rename'] ?? 0) + (counts['head'] ?? 0) + (counts['org-remove'] ?? 0)}</b> その他</span>
        </div>
        <ol>
          {changes.map((c, i) => {
            const t = describe(base, state, c);
            const rev = revertAction(state, c);
            return (
              <li
                key={c.key}
                className={spot === c.key ? 'is-spot' : ''}
                onPointerEnter={() => setSpot(c.key)}
                onPointerLeave={() => setSpot(null)}
              >
                <span className="t-no">{kanjiNum(i + 1)}</span>
                <span className="t-verb">{t.verb}</span>
                <span className="t-body">
                  <b>{t.subject}</b>
                  {(t.from || t.to) && (
                    <span className="t-route">
                      {t.from && <s>{t.from}</s>}
                      {t.from && t.to && <em> ⟶ </em>}
                      {t.to && <span>{t.to}</span>}
                    </span>
                  )}
                </span>
                {rev && <button className="t-undo-one" onClick={() => dispatch(rev)}>取消</button>}
              </li>
            );
          })}
          {!changes.length && (
            <li className="t-empty">まだ白紙です。地図の上で石を別の区画へ置いてみてください。</li>
          )}
        </ol>
        <footer>
          <button disabled={!canUndo} onClick={undo}>一手戻す</button>
          <button disabled={!canRedo} onClick={redo}>やり直す</button>
          <button disabled={!changes.length} onClick={reset}>白紙に戻す</button>
        </footer>
      </section>
    </aside>
  );
}

function Card({
  store,
  sel,
  setSel,
  zoomTo,
}: {
  store: OrgEditor;
  sel: NonNullable<Sel>;
  setSel: (s: Sel) => void;
  zoomTo: (id: string) => void;
}) {
  const { state, dispatch } = store;

  if (sel.kind === 'member') {
    const m = state.members[sel.id];
    if (!m) return null;
    const org = state.orgs[m.orgId];
    const isHead = org.headId === m.id;
    return (
      <section className="t-card">
        <div className="t-card-kicker">石　メンバー</div>
        <div className="t-card-title">{m.name}</div>
        <div className="t-card-sub">{m.title}・等級 {m.grade}{isHead ? '・責任者' : ''}</div>
        <label className="t-field">
          <span>所属する区画</span>
          <select value={m.orgId} onChange={(e) => dispatch({ type: 'moveMember', id: m.id, orgId: e.target.value })}>
            {orderedOrgs(state).map(({ id, depth }) => (
              <option key={id} value={id}>{'　'.repeat(depth)}{state.orgs[id].name}</option>
            ))}
          </select>
        </label>
        <div className="t-card-actions">
          <button disabled={isHead} onClick={() => dispatch({ type: 'setHead', orgId: org.id, memberId: m.id })}>印を押す（責任者に）</button>
          <button onClick={() => (setSel({ kind: 'org', id: org.id }), zoomTo(org.id))}>{org.name}を見る</button>
        </div>
      </section>
    );
  }

  const o = state.orgs[sel.id];
  if (!o) return null;
  const direct = membersOf(state, o.id);
  return (
    <section className="t-card">
      <div className="t-card-kicker">区画　組織</div>
      <input
        key={o.name}
        className="t-card-title t-card-input"
        defaultValue={o.name}
        onBlur={(e) => dispatch({ type: 'renameOrg', id: o.id, name: e.target.value })}
        onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
      />
      <div className="t-card-sub">
        {pathOf(state, o.id).slice(0, -1).map((p) => p.name).join(' › ') || '最上位'}
      </div>
      <div className="t-card-figs">
        <div><b>{direct.length}</b>直属</div>
        <div><b>{headcount(state, o.id)}</b>総勢</div>
        <div><b>{childOrgs(state, o.id).length}</b>内の区画</div>
      </div>
      <label className="t-field">
        <span>責任者（印）</span>
        <select value={o.headId ?? ''} onChange={(e) => dispatch({ type: 'setHead', orgId: o.id, memberId: e.target.value || null })}>
          <option value="">空席</option>
          {direct.map((m) => (
            <option key={m.id} value={m.id}>{m.name}（{m.title}）</option>
          ))}
        </select>
      </label>
      <div className="t-card-actions">
        <button onClick={() => zoomTo(o.id)}>この区画に寄る</button>
        <button
          onClick={() => {
            const id = newOrgId();
            dispatch({ type: 'addOrg', parentId: o.id, id, name: '新しい組織' });
            setSel({ kind: 'org', id });
          }}
        >
          内側に区画を設ける
        </button>
        {o.parentId && (
          <button className="danger" onClick={() => (dispatch({ type: 'deleteOrg', id: o.id }), setSel({ kind: 'org', id: o.parentId! }))}>
            区画を解く（中身は外へ）
          </button>
        )}
      </div>
    </section>
  );
}

function orderedOrgs(state: OrgState) {
  const out: { id: string; depth: number }[] = [];
  const walk = (id: string, d: number) => (out.push({ id, depth: d }), childOrgs(state, id).forEach((c) => walk(c.id, d + 1)));
  walk(ROOT_ID, 0);
  return out;
}
