// playground を実ブラウザで操作して、両ビューの編集が反映されることを確かめるスモークテスト。
// 事前に `bun run dev` を起動しておく。Chrome の場所は CHROME_PATH で上書きできる。
//   bun run e2e            → 検証のみ
//   bun run e2e -- shots   → docs/ にスクリーンショットも保存
import { chromium } from 'playwright-core';

const URL = process.env.PLAYGROUND_URL ?? 'http://localhost:5191';
const CHROME = process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const SHOTS = process.argv.includes('shots') ? new globalThis.URL('../docs/', import.meta.url).pathname : null;

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 880 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));

let failed = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? `  (${detail})` : ''}`);
  if (!ok) failed++;
};
const shot = async (name) => SHOTS && page.screenshot({ path: `${SHOTS}${name}.png` });
const count = async () => Number((await page.textContent('.switch-count')).replace(/\D/g, ''));
const box = (sel, text, inner) =>
  page.evaluate(
    ([sel, text, inner]) => {
      const g = [...document.querySelectorAll(sel)].find((g) => g.textContent.includes(text));
      if (!g) return null;
      const r = (inner ? g.querySelector(inner) : g).getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2, w: r.width };
    },
    [sel, text, inner],
  );
const drag = async (a, b, { hold } = {}) => {
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  for (let i = 1; i <= 18; i++) await page.mouse.move(a.x + ((b.x - a.x) * i) / 18, a.y + ((b.y - a.y) * i) / 18);
  await page.waitForTimeout(300);
  if (hold) await hold();
  await page.mouse.up();
  await page.waitForTimeout(2200);
};

// ── OrgTree ──
await page.goto(`${URL}/#a`);
await page.waitForTimeout(3000);
await shot('a-overview');
{
  const design = await box('g.kg-org', 'デザイン室', '.kg-dot');
  const biz = await box('g.kg-org', 'ビジネス本部', '.kg-dot');
  await drag(design, { x: biz.x, y: biz.y + 4 }, {
    hold: async () => {
      check('tree: ドラッグ中に付け替え先を表示', (await page.textContent('.brain-drop-hint')).includes('ビジネス本部'));
      await shot('a-dragging');
    },
  });
  check('tree: 組織を枝ごと付け替え', (await count()) === 1);
  check('tree: 変更ログに記録', (await page.textContent('.brain-log')).includes('デザイン室'));

  const kato = await box('g.kg-member', '加藤', '.kg-dot');
  const infra = await box('g.kg-org', '基盤チーム', '.kg-dot');
  await drag(kato, infra);
  check('tree: メンバーを異動', (await count()) === 2);

  // 自分の配下へは移せない
  const prod = await box('g.kg-org', 'プロダクト本部', '.kg-dot');
  const web = await box('g.kg-org', 'Webチーム', '.kg-dot');
  await drag(prod, web, {
    // 組織をつかむと配下も一緒に運ばれるので、自分の配下は落とし先の候補にならない
    hold: async () => check('tree: 自分の配下は落とし先にならない', !(await page.textContent('.brain-drop-hint')).includes('Webチーム')),
  });
  check('tree: 循環する付け替えは反映されない', (await count()) === 2);

  await page.keyboard.press('Meta+z');
  await page.waitForTimeout(400);
  check('tree: ⌘Z で1手戻る', (await count()) === 1);
}

// ── OrgMap ──
await page.click('.switch button:nth-child(2)');
await page.waitForTimeout(1200);
await shot('b-overview');
{
  const before = await count();
  const kato = await box('g.t-stone', '加');
  const cs = await box('g.t-org.d2', 'カスタマーサクセス部');
  await drag(kato, { x: cs.x, y: cs.y + cs.w * 0.25 }, {
    hold: async () => {
      check('map: 落とす区画を表示', (await page.textContent('.t-drop-caption')).includes('カスタマーサクセス部'));
      await shot('b-dragging');
    },
  });
  check('map: 石を置いて異動', (await count()) === before + 1);
  check('map: 帳面に異動先が出る', (await page.textContent('.t-plan')).includes('カスタマーサクセス部'));

  await page.click('.t-undo-one');
  await page.waitForTimeout(900);
  check('map: 個別取消', (await count()) === before);

  const sales = await box('g.t-org.d2', '営業部');
  await page.mouse.click(sales.x, sales.y - sales.w * 0.42);
  await page.waitForTimeout(300);
  await page.click('text=内側に区画を設ける');
  await page.waitForTimeout(900);
  check('map: 区画を新設', (await count()) === before + 1);

  const biz = await box('g.t-org.d1', 'ビジネス本部');
  await page.mouse.dblclick(biz.x - biz.w * 0.44, biz.y);
  await page.waitForTimeout(1500);
  check('map: ダブルクリックで寄る', (await page.textContent('.t-crumbs')).includes('ビジネス本部'));
  await shot('b-zoom');
}

// ── 並列：同じ変更が両方に見える ──
await page.click('.switch button:nth-child(3)');
await page.waitForTimeout(2500);
const logN = await page.locator('.brain-log li').count();
const planN = await page.locator('.t-plan li').count();
check('split: 両ビューが同じ変更を表示', logN === planN && logN === (await count()), `${logN} / ${planN}`);
await shot('split');

// ── テーマ：プリセットとトークン上書き ──
{
  const probe = (sel) =>
    page.evaluate((sel) => {
      const el = document.querySelector(sel);
      const cs = getComputedStyle(el);
      return { bg: cs.backgroundColor, accent: cs.getPropertyValue('--_ock-accent').trim(), seal: cs.getPropertyValue('--_ock-seal').trim() };
    }, sel);
  const treeDark = await probe('.ock-tree');
  const mapLight = await probe('.ock-map');
  await page.selectOption('.switch-theme', 'light');
  await page.waitForTimeout(400);
  const treeLight = await probe('.ock-tree');
  check('theme: ツリーを light に切替', treeDark.bg !== treeLight.bg && treeLight.bg === 'rgb(245, 244, 239)', treeLight.bg);
  await page.selectOption('.switch-theme', 'dark');
  await page.waitForTimeout(400);
  const mapDark = await probe('.ock-map');
  check('theme: 地図を dark に切替', mapLight.bg !== mapDark.bg && mapDark.bg === 'rgb(20, 18, 14)', mapDark.bg);
  await shot('themes-dark');
  await page.selectOption('.switch-theme', 'light');
  await page.fill('.switch-accent input', '#ff6600');
  await page.waitForTimeout(400);
  const t = await probe('.ock-tree');
  const m = await probe('.ock-map');
  check('tokens: アクセント色を上書き', t.accent === '#ff6600' && m.seal === '#ff6600', `${t.accent} / ${m.seal}`);
  await shot('themes-light-accent');
  await page.click('.switch-accent button');
  await page.selectOption('.switch-theme', 'default');
}

check('コンソールエラーなし', errors.length === 0, errors.join(' | '));
await browser.close();
process.exit(failed ? 1 : 0);
