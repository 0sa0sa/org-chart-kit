import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ORG_MAP_TOKENS, ORG_TREE_TOKENS, tokenStyle } from '../src/react/theme';

const read = (p: string) => readFileSync(new URL(`../src/react/${p}`, import.meta.url), 'utf8');

/** selector で始まる最初のブロックで宣言されている --_ock-* を集める */
function declared(css: string, selector: string) {
  const at = css.indexOf(selector);
  if (at < 0) throw new Error(`block not found: ${selector}`);
  const body = css.slice(at, css.indexOf('}', at));
  return [...body.matchAll(/--_ock-([a-z0-9-]+): var\(--ock-([a-z0-9-]+),/g)].map((m) => {
    expect(m[1]).toBe(m[2]); // 内部名と公開名は一致させる
    return m[1];
  });
}
const used = (...srcs: string[]) =>
  new Set(srcs.flatMap((s) => [...s.matchAll(/var\(--_ock-([a-z0-9-]+)/g)].map((m) => m[1])).filter((t) => t !== 'px'));

const views = [
  { name: 'OrgTree', css: 'tree/tree.css', tsx: 'tree/OrgTree.tsx', root: '.ock-tree', tokens: ORG_TREE_TOKENS, other: 'light', derived: ['accent-soft', 'accent-line', 'glow'] },
  { name: 'OrgMap', css: 'map/map.css', tsx: 'map/OrgMap.tsx', root: '.ock-map', tokens: ORG_MAP_TOKENS, other: 'dark', derived: ['seal-soft', 'seal-edge', 'select-soft', 'drop'] },
] as const;

for (const v of views) {
  describe(`${v.name} のトークン`, () => {
    const css = read(v.css);

    it('型に挙げたトークンが既定のテーマですべて宣言されている（過不足なし）', () => {
      const base = declared(css, `${v.root},`);
      expect([...base].sort()).toEqual([...v.tokens].sort());
    });

    it('もう一方のテーマは、自動計算やフォント以外の色をすべて持つ', () => {
      const alt = new Set(declared(css, `${v.root}[data-ock-theme='${v.other}']`));
      for (const t of alt) expect(v.tokens).toContain(t);
      const auto = new Set(declared(css, `${v.root}[data-ock-theme='auto']`));
      expect(auto).toEqual(alt);
      // 色の基本トークンは必ず上書きしている
      for (const t of ['bg', 'surface', 'text', 'text-2', 'text-3']) expect(alt.has(t)).toBe(true);
    });

    it('CSS と TSX が参照する内部変数はすべてトークンとして定義されている', () => {
      for (const t of used(css, read(v.tsx))) expect(v.tokens).toContain(t);
    });

    it('クラスセレクタはルート以外に ock- 接頭辞を持たない（keyframes 名の置換がクラス名を巻き込んでいない）', () => {
      const selectors = css.replace(/@keyframes[^{]+\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/g, '').replace(/\{[^{}]*\}/g, '{}');
      const stray = [...selectors.matchAll(/\.(ock-[a-z0-9-]+)/g)].map((m) => m[1]).filter((c) => c !== 'ock-tree' && c !== 'ock-map');
      expect(stray).toEqual([]);
    });

    it('shadcn / shadcn-v4 は自動計算以外のトークンをすべてホストの変数から決める', () => {
      const need = v.tokens.filter((t) => !(v.derived as readonly string[]).includes(t)).sort();
      for (const theme of ['shadcn', 'shadcn-v4']) {
        expect(declared(css, `${v.root}[data-ock-theme='${theme}']`).sort()).toEqual(need);
      }
      const block = (theme: string) => {
        const at = css.indexOf(`${v.root}[data-ock-theme='${theme}']`);
        return css.slice(at, css.indexOf('}', at));
      };
      expect(block('shadcn')).toContain('hsl(var(--background))'); // v3: HSL の三つ組を hsl() で包む
      expect(block('shadcn-v4')).not.toContain('hsl(');            // v4: 変数が色そのもの
    });

    it('トークン定義の外に生の色が残っていない', () => {
      const outside = css.replace(/^\s*--_ock-[^\n]*$/gm, '');
      expect(outside.match(/#[0-9a-f]{3,8}\b|rgba?\(/gi)).toBeNull();
    });
  });
}

describe('tokenStyle', () => {
  it('tokens を --ock-* に変換し、style を後勝ちにする', () => {
    expect(tokenStyle({ accent: '#f60', bg: 'black' }, { width: 10 })).toEqual({ '--ock-accent': '#f60', '--ock-bg': 'black', width: 10 });
    expect(tokenStyle(undefined, { width: 10 })).toEqual({ width: 10 });
  });
});
