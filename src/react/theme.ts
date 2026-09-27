import type { CSSProperties } from 'react';

/**
 * 見た目のプリセット。
 * - 'light' / 'dark' / 'auto'（OS の配色設定 prefers-color-scheme に従う）。既定は OrgTree が 'dark'、OrgMap が 'light'。
 * - 'shadcn' / 'shadcn-v4' はホストアプリの shadcn/ui テーマ変数（--background, --primary, --radius …）を読み、
 *   ホスト側の light/dark 切替にも追従する。'shadcn' は Tailwind v3 系の HSL 三つ組（`--primary: 0 0% 9%`）、
 *   'shadcn-v4' は色そのもの（`--primary: oklch(...)`）を持つ変数向け。
 */
export type OrgTheme = 'light' | 'dark' | 'auto' | 'shadcn' | 'shadcn-v4';

/** 両ビュー共通のトークン */
const SHARED_TOKENS = [
  'bg', // 背景
  'surface', // パネル・カードの面
  'surface-2', // 一段沈んだ面
  'text', // 本文・線の基本色
  'text-2', // 補助テキスト
  'text-3', // 淡いテキスト・目盛り
  'font-body', // 本文フォント（font-family の値。'inherit' でホストに合わせる）
  'radius', // ボタン・入力・パネルの角丸（既定 0）
] as const;

/** OrgTree のトークン（CSS 変数 `--ock-<name>`） */
export const ORG_TREE_TOKENS = [
  ...SHARED_TOKENS,
  'border',
  'border-strong',
  'accent', // 選択・確定・コア（既定: 緑）
  'accent-soft', // accent の淡い面（既定: accent から自動計算）
  'accent-line', // accent の淡い線（既定: accent から自動計算）
  'glow', // 発光（既定: accent から自動計算）
  'member', // メンバーの点
  'danger', // 移動できない・解散
  'changed', // 変更あり（Δ）の印と変更ログの動詞
  'grid', // 背景のドット
  'shadow', // 詳細パネルの影
] as const;
export type OrgTreeToken = (typeof ORG_TREE_TOKENS)[number];

/** OrgMap のトークン（CSS 変数 `--ock-<name>`） */
export const ORG_MAP_TOKENS = [
  ...SHARED_TOKENS,
  'font-display', // 見出し・組織名・石の文字
  'line', // 罫線・枠（既定: text と同じ墨色）
  'seal', // 朱：責任者の印・異動の糸・落とし先
  'seal-soft', // 朱の淡い面（既定: seal から自動計算）
  'seal-edge', // 印の縁（既定: seal から自動計算）
  'on-seal', // 朱の上の文字
  'select', // 藍：選択中の区画・石
  'select-soft', // 藍の淡い面（既定: select から自動計算）
  'drop', // 落とせる区画の塗り（既定: seal と surface から自動計算）
  'depth-1', // 区画の塗り（深さ1〜4。深い区画ほど濃く）
  'depth-2',
  'depth-3',
  'depth-4',
  'tip-accent', // ツールチップの所属名
  'grain', // 紙の質感（background-image の値。'none' で無地）
] as const;
export type OrgMapToken = (typeof ORG_MAP_TOKENS)[number];

export type Tokens<T extends string> = Partial<Record<T, string>>;

/** tokens prop を `--ock-*` のインラインスタイルに変換する */
export function tokenStyle<T extends string>(tokens: Tokens<T> | undefined, style: CSSProperties | undefined) {
  if (!tokens) return style;
  const vars: Record<string, string> = {};
  for (const [k, v] of Object.entries(tokens)) if (v != null) vars[`--ock-${k}`] = v as string;
  return { ...vars, ...style } as CSSProperties;
}
