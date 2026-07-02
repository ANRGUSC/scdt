const fs=require('fs');
const html=fs.readFileSync(require('path').join(__dirname,'..','index.html'),'utf8');
const script=html.split('<script>')[1].split('</script>')[0];
global.window={};global.document={addEventListener(){},getElementById(){return null},querySelectorAll(){return[]},createElementNS(){return{}},createElement(){return{style:{},appendChild(){},setAttribute(){},addEventListener(){}}}};
global.navigator={serviceWorker:null};global.requestAnimationFrame=()=>0;global.performance={now:()=>0};
eval(script); const S=global.window.__sim; const st=()=>S.state;
let f=0; const ok=(c,m)=>{ if(!c){console.log('  FAIL: '+m);f++;} else console.log('  ok: '+m); };

console.log('== 1. Baseline: healthy & bounded over 300 days ==');
S.reset(); let minInv=1e9,maxInv=-1e9,maxUtil=-1e9;
for(let d=1;d<=300;d++){ S.runDays(1); for(const w of st().warehouses){minInv=Math.min(minInv,w.inv);maxInv=Math.max(maxInv,w.inv);} for(const u of S.metrics().whUtil){if(u!=null)maxUtil=Math.max(maxUtil,u);} }
let m=S.metrics();
ok(m.stockoutEvents===0,'no stockouts');
ok(m.wastedUnits<1e-6,'no waste');
ok(m.service>99.9,'service 100%');
ok(minInv>5,'WH never empties (min '+minInv.toFixed(1)+')');
ok(maxInv<120,'WH never overflows (max '+maxInv.toFixed(1)+')');
ok(maxUtil<0.70,'WH always green, util<70% (peak '+(maxUtil*100).toFixed(0)+'%)');
ok(m.costPerDay>=75&&m.costPerDay<=95,'cost/day $'+m.costPerDay.toFixed(0)+' in [75,95]');
ok(st().stores.every(r=>r.onHand>5),'stores onHand>5');
ok(m.sysInventory>200&&m.sysInventory<380,'sysInv '+m.sysInventory.toFixed(0)+' ~ several days demand');

console.log('== 2. Determinism (exact reset reproduces run) ==');
S.reset();S.runDays(50);const a=S.snapshot();S.reset();S.runDays(50);const b=S.snapshot();
ok(a===b,'snapshot(50) identical after reset');

console.log('== 3. Each scenario shows its failure signature ==');
S.reset();S.runDays(30);S.applyScenario(1);S.runDays(40);m=S.metrics();ok(m.service<95&&st().counters.unmetUnits>0,'S1 spike: service<95% + lost sales ('+m.service.toFixed(0)+'%)');
S.reset();S.runDays(30);S.applyScenario(2);S.runDays(18);ok(st().warehouses.some(w=>w.overflowQueue>0||whEffCap(w)&&w.inv/whEffCap(w)>=0.9),'S2 drop: WH congests');
S.reset();S.runDays(30);S.applyScenario(3);S.runDays(40);m=S.metrics();ok(Math.abs(m.producedToday-18)<0.01&&m.stockoutEvents>0,'S3 cap cut: produced=18 + stockouts');
S.reset();S.runDays(30);S.applyScenario(4);S.runDays(6);let ss=st().stores.map(r=>r.state);ok((ss[0]==='stockout'||ss[1]==='stockout')&&ss[2]!=='stockout'&&ss[3]!=='stockout'&&st().warehouses[0].outage,'S4 outage: R1/R2 out, R3/R4 ok');
S.reset();S.runDays(30);S.applyScenario(5);S.runDays(20);ok(st().warehouses[0].overflowQueue>0,'S5 crunch: W1 overflow '+st().warehouses[0].overflowQueue.toFixed(0));
S.reset();S.runDays(30);S.applyScenario(6);S.runDays(40);m=S.metrics();ok(m.stockoutEvents>0&&Math.abs(m.producedToday-40)<0.01,'S6 low freq: stockouts while producing 40');
S.reset();S.runDays(30);S.applyScenario(7);S.set({overflowPolicy:'waste'});S.runDays(15);ok(S.metrics().wastedUnits>0,'S7 overproduce+waste: waste>0');

console.log('== 4. Responses measurably mitigate ==');
S.reset();S.runDays(30);S.applyScenario(1);st().factory.setpoint=60;S.runDays(30);ok(S.metrics().service>=95,'S1: production 60 -> service>=95% ('+S.metrics().service.toFixed(0)+')');
S.reset();S.runDays(30);S.applyScenario(4);st().responses.splitToW1=0;st().stores[0].assignedWh=1;st().stores[1].assignedWh=1;S.runDays(30);m=S.metrics();ok(m.service>=95&&st().costs.reroute>0,'S4: reroute -> service>=95% + reroute cost booked');
S.reset();S.runDays(30);S.applyScenario(6);let so=st().counters.stockoutEvents;st().responses.rShipEvery=1;S.runDays(20);ok(st().counters.stockoutEvents===so,'S6: freq 1 -> no new stockouts');
S.reset();S.runDays(30);S.applyScenario(2);S.runDays(15);st().factory.setpoint=4;S.runDays(45);ok(S.metrics().whUtil.every(u=>u<0.70),'S2: under-produce -> WH drains <70% ('+S.metrics().whUtil.map(u=>(u*100).toFixed(0))+')');
// Rerouting pitfall: reroute R1->W2 during baseline; W2's inventory must deplete and W1 must stop supplying R1.
S.reset();S.runDays(30);st().stores[0].assignedWh=1;
{ let origins=new Set(), dips=0;
  for(let d=0;d<6;d++){ const pre=st().warehouses[1].inv; S.runDays(1);
    for(const sh of st().shipments) if(sh.to==='R1') origins.add(sh.from);
    if(st().warehouses[1].inv<pre) dips++; }
  ok([...origins].every(o=>o==='W2')&&dips>0,'reroute pitfall: only W2 supplies R1 and W2 inv depletes'); }

console.log('== 5. Guard rails: no NaN/Infinity with capMult=0 + outage ==');
S.reset();st().warehouses[0].capMult=0;st().warehouses[0].outage=true;S.runDays(20);
ok(!/NaN|Infinity/.test(JSON.stringify(S.metrics())),'no NaN/Infinity in metrics (null=OUT is allowed)');
ok(st().factory.producedToday>=0,'production finite');

console.log('\n'+(f===0?'*** ALL PASS ***':f+' FAILURES'));
process.exit(f?1:0);
