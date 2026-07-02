const { chromium } = require('playwright');
(async () => {
  let failures = 0;
  const ok = (c,m)=>{ if(!c){console.log('  FAIL: '+m);failures++;} else console.log('  ok: '+m); };
  const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
  const page = await browser.newPage({ viewport:{width:1280,height:720} });
  const errors = [];
  page.on('pageerror', e=>errors.push(String(e)));
  page.on('console', msg=>{ if(msg.type()==='error') errors.push(msg.text()); });

  await page.goto('http://localhost:8000/index.html');
  await page.waitForFunction(() => window.__sim && document.querySelectorAll('#nodeLayer .node').length === 7);
  ok(true, 'page loads, 7 nodes rendered');

  console.log('== UI smoke ==');
  // pause so wall-clock ticks don't interfere with assertions
  await page.click('#playBtn');
  const dayBefore = await page.textContent('#dayLabel');
  await page.waitForTimeout(1200);
  ok(await page.textContent('#dayLabel') === dayBefore, 'pause freezes day counter');
  await page.click('#stepBtn');
  const d1 = await page.evaluate(()=>__sim.state.day);
  await page.click('#stepBtn');
  ok(await page.evaluate(()=>__sim.state.day) === d1+1, 'Step advances exactly 1 day');

  for(const t of ['responses','scenarios','metrics','shocks']){
    await page.click(`.tab[data-tab="${t}"]`);
    ok(await page.isVisible('#panel-'+t), 'tab switches to '+t);
  }
  // tooltip
  await page.hover('#dayLabel');
  await page.waitForTimeout(200);
  ok(await page.isVisible('#tooltip.on'), 'tooltip shows on hover');
  const tipCount = await page.evaluate(()=>document.querySelectorAll('[data-tip]').length);
  ok(tipCount > 30, 'many data-tip elements ('+tipCount+')');
  const missingTips = await page.evaluate(()=>{
    const keys = new Set(Object.keys(TIPS));
    return [...new Set([...document.querySelectorAll('[data-tip]')].map(e=>e.getAttribute('data-tip')))].filter(k=>!keys.has(k));
  });
  ok(missingTips.length===0, 'every data-tip key has copy'+(missingTips.length?' (missing: '+missingTips+')':''));

  console.log('== Sim in browser ==');
  await page.evaluate(()=>{ __sim.reset(); __sim.state.running=false; __sim.runDays(300); });
  const m = await page.evaluate(()=>__sim.metrics());
  ok(m.stockoutEvents===0 && m.wastedUnits<1e-6 && m.service>99.9, 'baseline 300d clean in browser');
  const snapEq = await page.evaluate(()=>{
    __sim.reset(); __sim.state.running=false; __sim.runDays(50); const a=__sim.snapshot();
    __sim.reset(); __sim.state.running=false; __sim.runDays(50); return a===__sim.snapshot();
  });
  ok(snapEq, 'determinism in browser');

  // scenario 4 -> W1 node shows OUT class, R1/R2 go bad
  await page.evaluate(()=>{ __sim.reset(); __sim.state.running=false; __sim.runDays(30); __sim.applyScenario(4); __sim.runDays(6); });
  await page.waitForTimeout(300); // let a frame render
  const classes = await page.evaluate(()=>{
    const g = [...document.querySelectorAll('#nodeLayer .node')];
    return g.map(n=>n.getAttribute('class'));
  });
  ok(classes[1].includes('node--out'), 'W1 renders node--out (got '+classes[1]+')');
  ok(classes[3].includes('node--bad')||classes[4].includes('node--bad'), 'R1/R2 render node--bad');
  ok(!classes[5].includes('node--bad') && !classes[6].includes('node--bad'), 'R3/R4 stay healthy');
  ok(await page.isVisible('#banner.on'), 'scenario banner visible');
  // reroute edge appears when assigned
  await page.evaluate(()=>{ __sim.state.stores[0].assignedWh=1; __sim.runDays(3); });
  await page.waitForTimeout(300);
  const rerouteShown = await page.evaluate(()=>{
    const paths=[...document.querySelectorAll('#edgeLayer path')];
    return paths.some(p=>p.getAttribute('class').includes('reroute') && !p.classList.contains('hidden'));
  });
  ok(rerouteShown, 'reroute edge drawn while active');
  // clear shocks via banner button
  await page.click('#clearBannerBtn');
  ok(!(await page.isVisible('#banner.on')), 'Clear shocks hides banner');
  ok(await page.evaluate(()=>!__sim.state.warehouses[0].outage), 'outage cleared');

  // Reset restores sliders to defaults
  await page.evaluate(()=>{ __sim.state.shocks.globalDemandMult=2.5; });
  await page.click('#resetBtn');
  ok(await page.evaluate(()=>__sim.state.shocks.globalDemandMult===1 && __sim.state.day===0), 'Reset restores defaults & day 0');

  // speed select changes tick period
  await page.selectOption('#speedSel','250');
  ok(await page.evaluate(()=>__sim.state.tickPeriodMs===250), 'speed select changes tick period');

  // no NaN/undefined visible in text
  await page.evaluate(()=>{ __sim.state.running=false; __sim.state.warehouses[0].capMult=0; __sim.state.warehouses[0].outage=true; __sim.runDays(10); });
  await page.waitForTimeout(300);
  const badText = await page.evaluate(()=>/NaN|Infinity|undefined/.test(document.body.innerText));
  ok(!badText, 'no NaN/Infinity/undefined in rendered text');

  console.log('== PWA ==');
  await page.evaluate(()=>__sim.reset());
  await page.reload();
  await page.waitForFunction(()=>window.__sim);
  const swActive = await page.evaluate(async ()=>{
    if(!('serviceWorker' in navigator)) return 'unsupported';
    const reg = await navigator.serviceWorker.ready;
    return !!(reg && reg.active);
  });
  ok(swActive===true, 'service worker active after reload (got '+swActive+')');

  // screenshot for projector legibility (run a bit for realistic state)
  await page.evaluate(()=>{ __sim.reset(); __sim.state.running=false; __sim.runDays(45); });
  await page.waitForTimeout(400);
  await page.screenshot({ path:require('path').join(__dirname,'screenshot-baseline.png') });
  await page.evaluate(()=>{ __sim.applyScenario(4); __sim.runDays(5); });
  await page.waitForTimeout(400);
  await page.screenshot({ path:require('path').join(__dirname,'screenshot-scenario4.png') });
  console.log('  screenshots saved');

  ok(errors.length===0, 'no console/page errors'+(errors.length?': '+errors.slice(0,3).join(' | '):''));
  await browser.close();
  console.log('\n'+(failures===0?'*** BROWSER ALL PASS ***':failures+' FAILURES'));
  process.exit(failures?1:0);
})().catch(e=>{ console.error(e); process.exit(1); });
