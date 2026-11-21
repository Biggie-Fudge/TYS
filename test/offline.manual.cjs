// Manual check of offline durability: `PORT=3111 npm run dev` in one shell, then `node test/offline.manual.cjs`.
const { JSDOM, VirtualConsole } = require('jsdom'); const fs = require('fs'); const path = require('path'); const { webcrypto } = require('crypto');
const { IDBFactory } = require('fake-indexeddb');
const base = 'http://127.0.0.1:3111/', html = fs.readFileSync(path.join(__dirname, '../web/index.html'), 'utf8');
const idb = new IDBFactory(), net = { down: false }, errs = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function open() {
  const vc = new VirtualConsole(); vc.on('jsdomError', (e) => errs.push(e.message));
  const dom = new JSDOM(html, { runScripts: 'dangerously', url: base, virtualConsole: vc, pretendToBeVisual: true, beforeParse(w) {
    w.fetch = (u, o) => (net.down ? Promise.reject(new TypeError('offline')) : fetch(new URL(u, base), o));
    Object.defineProperty(w, 'crypto', { value: webcrypto }); w.TextEncoder = TextEncoder; w.indexedDB = idb; w.structuredClone = structuredClone;
  } });
  const w = dom.window, d = w.document;
  return { w, d, q: (s) => [...d.querySelectorAll(s)], click: (e) => { e = typeof e === 'string' ? d.querySelector(e) : e; if (!e) throw new Error('missing element'); e.dispatchEvent(new w.MouseEvent('click', { bubbles: true })); },
    bar: () => d.querySelector('.bar .pill').textContent, close: () => w.close() };
}
const serverRuns = async () => (await (await fetch(base + 'api/vessels/meridian/state')).json()).runs.length;
(async () => {
  const before = await serverRuns();
  let p = open(); await sleep(1500);
  console.log('1 first load:', p.bar(), '| checks listed', p.q('[data-a=start]').length);
  net.down = true;
  p.click(p.q('[data-a=start]').find((b) => b.textContent.includes('Weekly deck')));
  p.click(p.q('.item')[0].querySelector('[data-v=pass]')); p.click(p.q('.item')[2].querySelector('[data-v=pass]'));
  await sleep(500); p.close();

  p = open(); await sleep(1200);
  console.log('2 reopened with no network:', p.bar(), '| half-done checklist restored:', p.q('.item').length === 6 && p.q('.choice [aria-pressed=true]').length === 2);
  p.q('.item').forEach((it, i) => { it = p.q('.item')[i]; const pass = it.querySelector('[data-v=pass]'), num = it.querySelector('input[type=number]');
    if (pass) p.click(pass); else if (num) { num.value = '14'; num.dispatchEvent(new p.w.Event('input', { bubbles: true })); } else p.click(it.querySelector('[data-a=sample]')); });
  p.click('[data-a=sign]');
  p.d.getElementById('sg-user').value = [...p.d.getElementById('sg-user').options].find((o) => o.textContent.includes('Tess')).value;
  p.d.getElementById('sg-pin').value = '3333'; p.click('[data-a=pin]'); await sleep(600);
  console.log('3 signed offline:', p.d.getElementById('toast').textContent, '|', p.bar()); p.close();

  p = open(); await sleep(1200);
  console.log('4 reopened again, still offline:', p.bar(), '| server runs unchanged:', (await serverRuns()) === before);
  net.down = false; p.w.dispatchEvent(new p.w.Event('online')); await sleep(1500);
  console.log('5 network back:', p.d.getElementById('toast').textContent, '|', p.bar(), '| server runs +1:', (await serverRuns()) === before + 1);
  p.w.dispatchEvent(new p.w.Event('online')); await sleep(800);
  console.log('6 synced again, no duplicate:', (await serverRuns()) === before + 1);
  console.log('errors', errs); process.exit(errs.length ? 1 : 0);
})().catch((e) => { console.log('THROW', e.stack); process.exit(1); });
