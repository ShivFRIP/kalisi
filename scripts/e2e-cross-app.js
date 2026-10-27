// Cross-app check on the production build served by FastAPI (port 8000):
// the driver boards the demo rider with the code shown in the rider's app, and the rider's app reflects it.
// Needs Playwright (npm i -D playwright && npx playwright install chromium) and a freshly seeded server whose
// demo clock is before 07:50, e.g. `python -m kalisi.seed --reset --at 07:40`. Screenshots go next to this file.
const { chromium } = require('playwright');
const BASE = process.env.BASE || 'http://localhost:8000', S = __dirname + '/';
const errs = [];
const watch = (p, tag) => { p.on('pageerror', e => errs.push(`${tag} pageerror: ${e.message}`));
  p.on('console', m => { if (m.type() === 'error' && !/409|422|Failed to load resource/.test(m.text())) errs.push(`${tag} console: ${m.text()}`); }); };
async function signIn(p, app, phone) {
  await p.goto(`${BASE}/${app}`); await p.waitForLoadState('networkidle');
  await p.getByLabel('Mobile number').fill(phone); await p.getByRole('button', { name: 'Send code' }).click();
  await p.getByRole('button', { name: 'Sign in' }).click(); await p.waitForTimeout(1500);
}
(async () => {
  const b = await chromium.launch();
  const rider = await (await b.newContext({ viewport: { width: 390, height: 844 } })).newPage(); watch(rider, 'rider');
  const driver = await (await b.newContext({ viewport: { width: 390, height: 844 } })).newPage(); watch(driver, 'driver');
  const ops = await (await b.newContext({ viewport: { width: 1440, height: 900 } })).newPage(); watch(ops, 'ops');

  await signIn(rider, 'rider', '0000010001');
  const codeLabel = await rider.locator('[aria-label^="Boarding code"]').first().getAttribute('aria-label');
  const code = codeLabel.replace(/\D/g, '');
  console.log('rider sees boarding code', code);
  await rider.screenshot({ path: S + 'x1_rider_before.png' });

  await signIn(driver, 'driver', '0000020001');
  await driver.screenshot({ path: S + 'x2_driver_today.png' });
  await driver.getByText(/Next trip: K1|Continue K1/).first().click();
  await driver.waitForTimeout(1200);
  await driver.getByRole('button', { name: /Start trip|Take over trip/ }).click(); await driver.waitForTimeout(1500);
  for (let i = 0; i < 6; i++) {
    const name = (await driver.locator('.drv-stopname').first().innerText()).trim();
    const arrived = driver.getByRole('button', { name: 'Arrived' });
    if (await arrived.count()) { await arrived.click(); await driver.waitForTimeout(1200); }
    if (name === 'Kukatpally Metro') break;
    await driver.getByRole('button', { name: 'Depart' }).click(); await driver.waitForTimeout(600);
    const leave = driver.getByRole('button', { name: 'Leave anyway' });
    if (await leave.count()) { await leave.click(); }
    await driver.waitForTimeout(1200);
  }
  await driver.screenshot({ path: S + 'x3_driver_at_stop.png' });
  await driver.getByRole('button', { name: /^Board Priya/ }).click(); await driver.waitForTimeout(500);
  await driver.keyboard.type(code); await driver.waitForTimeout(2500);
  await driver.screenshot({ path: S + 'x4_driver_boarded.png' });

  await rider.reload(); await rider.waitForTimeout(2500);
  const riderText = await rider.locator('main, .page').first().innerText();
  console.log('rider shows on board:', /on board/i.test(riderText));
  await rider.screenshot({ path: S + 'x5_rider_onboard.png' });

  await signIn(ops, 'ops', '0000000001'); await ops.waitForTimeout(2000);
  await ops.screenshot({ path: S + 'x6_ops_overview.png' });
  await ops.goto(BASE + '/ops/allocation'); await ops.waitForTimeout(2500);
  await ops.screenshot({ path: S + 'x7_ops_allocation.png', fullPage: true });
  await ops.goto(BASE + '/ops/live'); await ops.waitForTimeout(2500);
  await ops.screenshot({ path: S + 'x8_ops_live.png' });
  const manifest = await rider.evaluate(() => document.getElementById('manifest')?.getAttribute('href'));
  const sw = await rider.evaluate(async () => (await navigator.serviceWorker.getRegistration())?.active ? 'active' : 'none');
  console.log('rider manifest', manifest, '| service worker', sw);
  console.log('errors:', errs.length ? errs : 'none');
  await b.close();
})();
