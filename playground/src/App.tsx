import { useEffect, useState } from 'react';
import { OrgMap, OrgTree, useOrgEditor, type OrgTheme } from 'org-chart-kit/react';
import { sampleOrg } from './fixtures';

type Mode = 'a' | 'b' | 'split';
const MODES: { id: Mode; label: string; sub: string }[] = [
  { id: 'a', label: 'A', sub: 'ツリー' },
  { id: 'b', label: 'B', sub: '地図' },
  { id: 'split', label: 'A|B', sub: '並べる' },
];

const BASELINE = sampleOrg();

/** 2つのビューは同じ editor を共有する。どちらで編集しても、もう一方に即反映される。 */
export function App() {
  const editor = useOrgEditor(BASELINE, { hotkeys: true });
  const [mode, setMode] = useState<Mode>(() => {
    const h = location.hash.slice(1);
    return h === 'a' || h === 'b' || h === 'split' ? h : 'a';
  });
  useEffect(() => void history.replaceState(null, '', `#${mode}`), [mode]);
  // 配色のプリセット（'default' は各ビューの既定: ツリー=dark / 地図=light）と、アクセント色の上書き
  const [theme, setTheme] = useState<'default' | OrgTheme>('default');
  const [accent, setAccent] = useState('');

  return (
    <div className={`app mode-${mode}`}>
      <div className="switch" role="tablist">
        {MODES.map((m) => (
          <button key={m.id} role="tab" aria-selected={mode === m.id} onClick={() => setMode(m.id)}>
            <b>{m.label}</b>
            <span>{m.sub}</span>
          </button>
        ))}
        <span className="switch-count" title="共有中の変更数">Δ {editor.changes.length}</span>
        <select className="switch-theme" aria-label="配色" value={theme} onChange={(e) => setTheme(e.target.value as typeof theme)}>
          <option value="default">配色: 既定</option>
          <option value="light">light</option>
          <option value="dark">dark</option>
          <option value="auto">auto</option>
        </select>
        <label className="switch-accent" title="アクセント色（ツリーの accent / 地図の seal）">
          <input type="color" value={accent || '#3df08c'} onChange={(e) => setAccent(e.target.value)} />
          {accent && <button onClick={() => setAccent('')} aria-label="アクセント色を戻す">×</button>}
        </label>
      </div>
      {mode !== 'b' && (
        <div className="pane">
          <OrgTree
            store={editor}
            eyebrow="org-chart-kit · OrgTree"
            theme={theme === 'default' ? 'dark' : theme}
            tokens={accent ? { accent } : undefined}
          />
        </div>
      )}
      {mode !== 'a' && (
        <div className="pane">
          <OrgMap
            store={editor}
            subtitle="ORG-CHART-KIT · ORGMAP"
            planLabel="第一稿　二〇二六年九月"
            theme={theme === 'default' ? 'light' : theme}
            tokens={accent ? { seal: accent } : undefined}
          />
        </div>
      )}
    </div>
  );
}
