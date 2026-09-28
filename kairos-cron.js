/* ============================================================
   KAIROS CRON v1.5-sd — Supply & Demand + RSI · frequency build
   ETH-USDT · OKX DEMO ONLY · 15m candles · long-only
   ------------------------------------------------------------
   STRATEGY — "THE ZONE SNIPER" (minimal parameters):
   · Demand zones auto-detected from pivot bounces (fresh OK)
   · BUY: price dips into zone AND RSI(14) < 40
   · SL: zone low − 0.5×ATR · risk 1.5% of the $10k book
   · TP: max(2× risk, supply ceiling if ≥ 2× risk) — R:R ≥ 2:1
   · Cooldown 2 candles after loss · chaos guard ATR% > 2.5%
   · Time-stop: position older than 12h exits at market
   Safety frame: $10k virtual book · auto fresh $10k attempt
   if blown · OCO on OKX servers · all prior guards kept.
   ============================================================ */
'use strict';
const https=require('https'),crypto=require('crypto'),fs=require('fs');
const INST='ETH-USDT',BAR='15m';
const FEE=0.001,RISK=1.5,WARM=60,MAXC=400;
const VCAP0=10000,VCAP_FLOOR=100;
const RSI_BUY=40,PIV=3,ZTOL=0.005,CHAOS=0.025,MAX_HOLD_MS=12*3600e3;
const SPEC={lotSz:0.0001,minSz:0.0001,tickSz:0.01,minMkt:1};
const STATE=__dirname+'/kairos-state.json';
const KEYS={key:process.env.OKX_KEY||'',secret:process.env.OKX_SECRET||'',pass:process.env.OKX_PASS||''};
const HASKEYS=!!(KEYS.key&&KEYS.secret&&KEYS.pass);

let ST={settings:{sl:1.6,tp:2.4,cool:2,running:true},
 pos:null,cool:0,trades:[],markers:[],candles:[],lastClosedT:0,avgVol:0,seen:0,
 fees:0,base:null,peak:null,maxDD:0,usdtEq:null,availUsd:null,eth:0,price:null,
 skipAdopt:false,attempts:1};
try{const d=JSON.parse(fs.readFileSync(STATE,'utf8'));
 if(d&&d.settings){ST=Object.assign(ST,d);ST.pos=d.pos||null;}}catch(e){}
if(ST.base==null)ST.base=VCAP0;
function save(){try{fs.writeFileSync(STATE,JSON.stringify({
 settings:ST.settings,pos:ST.pos,cool:ST.cool,trades:ST.trades.slice(0,120),
 markers:ST.markers.slice(-60),candles:ST.candles.slice(-MAXC),lastClosedT:ST.lastClosedT,
 avgVol:ST.avgVol,seen:ST.seen,fees:ST.fees,base:ST.base,peak:ST.peak,maxDD:ST.maxDD,
 skipAdopt:ST.skipAdopt,attempts:ST.attempts}));}catch(e){}}
const wait=ms=>new Promise(r=>setTimeout(r,ms));
const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
const rp=v=>(Math.round(v/SPEC.tickSz)*SPEC.tickSz).toFixed(2);
const q4=v=>(+v).toFixed(4);
function log(m){console.log('[KAIROS]',m);}

function httpReq(opts,body){return new Promise((res,rej)=>{
 const req=https.request(opts,r=>{let b='';r.on('data',c=>b+=c);
  r.on('end',()=>{try{res(JSON.parse(b));}catch(e){rej(new Error('bad json'));}});});
 req.on('error',rej);req.setTimeout(15000,()=>req.destroy(new Error('timeout')));
 if(body)req.write(body);req.end();});}
function pub(p){return httpReq({hostname:'www.okx.com',path:p,method:'GET',
 headers:{'Content-Type':'application/json'}});}
function priv(method,p,body){if(!HASKEYS)return Promise.reject(new Error('no keys — shadow'));
 const data=body?JSON.stringify(body):'';const ts=new Date().toISOString();
 const sign=crypto.createHmac('sha256',KEYS.secret).update(ts+method+p+data).digest('base64');
 return httpReq({hostname:'www.okx.com',path:p,method:method,headers:{
  'Content-Type':'application/json','OK-ACCESS-KEY':KEYS.key,'OK-ACCESS-SIGN':sign,
  'OK-ACCESS-TIMESTAMP':ts,'OK-ACCESS-PASSPHRASE':KEYS.pass,'x-simulated-trading':'1'}},data||null);}
async function api(method,p,body){const j=await priv(method,p,body);
 if(j.code&&j.code!=='0'){const m=(j.data&&j.data[0]&&(j.data[0].sMsg||j.data[0].sCode))||j.msg||('code '+j.code);
  throw new Error(m);}return j;}

function ema(v,n){const k=2/(n+1),o=[];let e=v[0];
 for(let i=0;i<v.length;i++){e=i?v[i]*k+e*(1-k):v[0];o.push(e);}return o;}
function rsi(c,n){const o=c.map(()=>NaN);let ag=0,al=0;
 for(let i=1;i<c.length;i++){const d=c[i]-c[i-1],g=Math.max(d,0),l=Math.max(-d,0);
  if(i<=n){ag+=g;al+=l;if(i===n){ag/=n;al/=n;o[i]=100-100/(1+ag/(al||1e-9));}}
  else{ag=(ag*(n-1)+g)/n;al=(al*(n-1)+l)/n;o[i]=100-100/(1+ag/(al||1e-9));}}return o;}
function atr(cs,n){const o=cs.map(()=>NaN);let a=null;
 for(let i=1;i<cs.length;i++){const tr=Math.max(cs[i].h-cs[i].l,Math.abs(cs[i].h-cs[i-1].c),Math.abs(cs[i].l-cs[i-1].c));
  a=a==null?tr:(a*(n-1)+tr)/n;if(i>=n)o[i]=a;}return o;}
function recompute(){if(ST.candles.length<2)return;
 const c=ST.candles.map(x=>x.c);
 ST.ind={f:ema(c,12),s:ema(c,26),t:ema(c,200),r:rsi(c,14),a:atr(ST.candles,14)};}

function virtualEquity(){
 let v=ST.base??VCAP0;
 for(const t of ST.trades)v+=(t.pnl||0);
 if(ST.pos&&ST.price)v+=(ST.price-ST.pos.entry)*ST.pos.qty;
 return v;
}
function equity(){return virtualEquity();}
function snapshotEq(){const eq=equity();if(ST.base==null)ST.base=eq;
 if(eq>(ST.peak||0))ST.peak=eq;const dd=(ST.peak-eq)/ST.peak;if(dd>ST.maxDD)ST.maxDD=dd;}

function armOCO(x){return api('POST','/api/v5/trade/order-algo',{instId:INST,ordType:'oco',tdMode:'cash',
  side:'sell',sz:q4(x.qty),tpTriggerPx:rp(x.tp),tpOrdPx:rp(x.tp),
  slTriggerPx:rp(x.sl),slOrdPx:'-1'})
 .then(j=>{x.algoId=j.data&&j.data[0]&&j.data[0].algoId;
  log('server OCO armed · TP '+x.tp.toFixed(1)+' / SL '+x.sl.toFixed(1));save();})
 .catch(e=>{x.algoId=null;log('OCO arm failed — '+e.message+' · local mgmt only');});}
async function cancelAlgos(){try{
 const p=await api('GET','/api/v5/trade/orders-algo-pending?ordType=oco&instId='+INST);
 const rows=(p.data||[]).filter(z=>z.instId===INST);
 if(rows.length)await api('POST','/api/v5/trade/cancel-algos',rows.map(z=>({algoId:z.algoId,instId:INST})));
 return rows.length;}catch(e){return 0;}}

/* ---------------- ZONES ---------------- */
function computeZones(cs){
 if(cs.length<30)return[];
 const piv=[];
 for(let i=PIV;i<cs.length-PIV;i++){
  let isH=true,isL=true;
  for(let j=i-PIV;j<=i+PIV;j++){
   if(j===i)continue;
   if(cs[j].h>cs[i].h)isH=false;
   if(cs[j].l<cs[i].l)isL=false;
  }
  if(isH)piv.push({p:cs[i].h,t:cs[i].t});
  if(isL)piv.push({p:cs[i].l,t:cs[i].t});
 }
 piv.sort((a,b)=>a.p-b.p);
 const tol=cs[cs.length-1].c*ZTOL;
 const groups=[];let cur=[];
 for(const v of piv){
  if(!cur.length||v.p-cur[cur.length-1].p<=tol)cur.push(v);
  else{groups.push(cur);cur=[v];}
 }
 if(cur.length)groups.push(cur);
 return groups.map(g=>({
  lo:Math.min.apply(null,g.map(x=>x.p)),
  hi:Math.max.apply(null,g.map(x=>x.p)),
  n:g.length,
  last:Math.max.apply(null,g.map(x=>x.t))
 }));
}
function supportHit(zones,c,a){
 let best=null;
 for(const z of zones){
  if(c.l<=z.hi&&c.c>=z.lo-0.25*a&&z.hi<=c.c*1.01){
   if(!best||z.hi>best.hi)best=z;
  }
 }
 return best;
}
function nextResistance(zones,price){
 let best=null;
 for(const z of zones){if(z.lo>price*1.001){if(!best||z.lo<best.lo)best=z;}}
 return best;
}

/* ---------------- execution ---------------- */
async function buy(c,a,sup){
 if(!HASKEYS){log('SHADOW — zone setup valid at '+sup.lo.toFixed(1)+'-'+sup.hi.toFixed(1)+' · no keys: order not placed');return;}
 if(ST.pos)return;
 const eq=equity();if(eq<=0){log('virtual equity depleted — skipping');return;}
 const entry0=c.c;
 const stop=sup.lo-0.5*a;
 const slD=entry0-stop;
 if(!(slD>0)){log('bad stop geometry — skipped');return;}
 const minTp=entry0+2*slD;
 const zones=computeZones(ST.candles);
 const res=nextResistance(zones,entry0);
 let tp,tptag;
 if(res&&res.hi>=minTp){tp=res.hi;tptag='ceiling';}
 else{tp=minTp;tptag='2R';}
 let qty=(eq*RISK/100)/slD,capped=false;
 const capN=Math.min(eq*0.98,Math.max(0,ST.availUsd||0)*0.98);
 if(qty*entry0>capN){qty=capN/entry0;capped=true;}
 qty=Math.floor(qty/SPEC.lotSz)*SPEC.lotSz;qty=+q4(qty);
 if(qty<SPEC.minSz||qty*entry0<SPEC.minMkt){log('below spot minimums — skipped');return;}
 try{
  const r=await api('POST','/api/v5/trade/order',{instId:INST,tdMode:'cash',side:'buy',
   ordType:'market',sz:q4(qty),tgtCcy:'base_ccy'});
  const ordId=r.data&&r.data[0]&&r.data[0].ordId;
  ST.pos={side:1,entry:entry0,qty:qty,sl:stop,tp:tp,atr:a,riskUSD:qty*slD,
   be:false,tOpen:Date.now(),ext:entry0,lastTrail:entry0,ordId:ordId,manual:false,
   zone:sup.lo.toFixed(1)+'-'+sup.hi.toFixed(1)};
  ST.markers.push({t:c.t,p:entry0,type:'E'});save();
  log('BUY '+qty.toFixed(4)+' ETH @ ~'+entry0.toFixed(1)+' at demand zone '+ST.pos.zone
   +' · SL '+stop.toFixed(1)+' · TP '+tp.toFixed(1)+' ('+tptag+', '+(slD>0?((tp-entry0)/slD).toFixed(1):'2')+'R)'
   +' · risk $'+(qty*slD).toFixed(2)+(capped?' · capped':''));
  await wait(1200);
  let ap=entry0,fsz=qty;
  try{const o=await api('GET','/api/v5/trade/order?ordId='+ordId+'&instId='+INST);
   const d=(o.data||[])[0]||{};
   if(d.avgPx)ap=parseFloat(d.avgPx);if(d.accFillSz)fsz=parseFloat(d.accFillSz);}catch(e){}
  const delta=ap-ST.pos.entry;
  ST.pos.entry=ap;ST.pos.qty=+q4(fsz);
  ST.pos.sl=ap-(entry0-stop);ST.pos.tp=ap+(tp-entry0);
  ST.pos.ext=ap;ST.pos.lastTrail=ap;
  log('fill confirmed @ '+ap.toFixed(1)+' · '+ST.pos.qty.toFixed(4)+' ETH · R:R 1:'+(slD>0?((ST.pos.tp-ST.pos.entry)/(ap-ST.pos.sl)).toFixed(1):'2'));
  await armOCO(ST.pos);save();
 }catch(e){ST.pos=null;log('buy rejected — '+e.message);save();}
}
async function sell(raw,reason){
 const x=ST.pos;if(!x||x.closing)return;x.closing=true;save();
 try{const n=await cancelAlgos();if(n)log('canceled '+n+' pending OCO before sell');}catch(e){}
 if(!HASKEYS){finalizeTrade(raw,reason);return;}
 let exit=raw;
 try{
  const r=await api('POST','/api/v5/trade/order',{instId:INST,tdMode:'cash',side:'sell',
   ordType:'market',sz:q4(x.qty),tgtCcy:'base_ccy'});
  await wait(1200);
  try{const o=await api('GET','/api/v5/trade/order?instId='+INST+'&limit=5');
   const d=(o.data||[]).find(z=>z.state==='filled'&&z.side==='sell');
   if(d&&d.avgPx)exit=parseFloat(d.avgPx);}catch(e){}
  await cancelAlgos();
 }catch(e){x.closing=false;save();
  log('sell failed — '+e.message+' · if OCO fired, next run records it');return;}
 finalizeTrade(exit,reason);
}
function finalizeTrade(exit,reason){
 const x=ST.pos;if(!x)return;ST.pos=null;
 const fee=x.qty*exit*FEE,pnl=(exit-x.entry)*x.qty-fee;
 ST.fees+=fee;
 ST.trades.unshift({ts:Date.now(),src:x.manual?'manual':'strategy',entry:x.entry,exit:exit,qty:x.qty,
  pnl:pnl,r:x.riskUSD?pnl/x.riskUSD:0,reason:reason,dur:Date.now()-x.tOpen});
 if(ST.trades.length>120)ST.trades.length=120;
 ST.markers.push({t:ST.candles.length?ST.candles[ST.candles.length-1].t:Date.now(),p:exit,type:'X',win:pnl>=0});
 if(pnl<0)ST.cool=ST.settings.cool;
 log((pnl>=0?'WIN ':'LOSS ')+reason+' @ '+exit.toFixed(1)+' · '+(pnl>=0?'+':'')+'$'+pnl.toFixed(2)
  +' · virtual equity $'+equity().toFixed(2));
 snapshotEq();save();
}
function manage(){
 const x=ST.pos;if(!x||!ST.price)return;
 if(ST.price<=x.sl)sell(x.sl,'STOP');
 else if(ST.price>=x.tp)sell(x.tp,'TARGET');
}
async function pollCandles(){
 const j=await pub('/api/v5/market/candles?instId='+INST+'&bar='+BAR+'&limit=300');
 const rows=(j.data||[]).map(k=>({t:+k[0],o:+k[1],h:+k[2],l:+k[3],c:+k[4],v:+k[5]})).reverse();
 const closed=rows.slice(0,-1);
 if(!closed.length)return;
 ST.candles=closed.slice(-MAXC);recompute();
 if(!ST.price)ST.price=closed[closed.length-1].c;
 const newest=closed[closed.length-1];
    if(!ST.lastClosedT){
      ST.lastClosedT=newest.t;
      log('history synced — '+ST.candles.length+' × '+BAR+' candles');
    }else if(newest.t>ST.lastClosedT){
      let fired=0;
      for(const cc of ST.candles){
        if(cc.t>ST.lastClosedT){ onClosedAt(cc); fired++; }
      }
      if(!fired){
        ST.lastClosedT=newest.t;
        onClosed();
        fired=1;
      }
      log('processed '+fired+' closed candle'+(fired>1?'s':''));
    }else{
      /* no new candle yet — but run diagnostics so RSI/zones stay live */
      recompute();
      ST.seen++;
      snapshotEq();
      save();
    }
}function onClosed(){
  onClosedAt(ST.candles[ST.candles.length-1]);
}
function onClosedAt(c){
  recompute();
  const i=ST.candles.indexOf(c);if(i<1||!ST.ind||!c)return;
 const r=ST.ind.r[i],a=ST.ind.a[i];
 const warmed=ST.candles.length>=WARM&&isFinite(r)&&isFinite(a)&&a>0;
 ST.seen++;snapshotEq();
 if(ST.pos){
  const x=ST.pos;
  if(Date.now()-x.tOpen>MAX_HOLD_MS&&!x.closing){
   log('time-stop — position older than 12h · exiting at market');
   sell(c.c,'TIME');
  }else log('HOLD · uPnL '+(((ST.price||c.c)-x.entry)*x.qty).toFixed(2)+' · zone '+x.zone+' · SL '+x.sl.toFixed(1)+' / TP '+x.tp.toFixed(1));
  save();return;
 }
 if(!ST.settings.running){save();return;}
 if(!warmed){log('calibrating — '+ST.candles.length+'/'+WARM+' candles');save();return;}
 if(ST.cool>0){ST.cool--;log('cooldown — '+ST.cool+' candles left');save();return;}
 const aPct=a/c.c;
 if(aPct>CHAOS){log('chaos guard — ATR '+(aPct*100).toFixed(2)+'% too wild · standing down');save();return;}
 const zones=computeZones(ST.candles);
 const sup=supportHit(zones,c,a);
 if(sup&&isFinite(r)&&r<RSI_BUY){
  log('SETUP — price in demand zone '+sup.lo.toFixed(1)+'-'+sup.hi.toFixed(1)
   +' ('+sup.n+' bounce'+(sup.n>1?'s':'')+') · RSI '+r.toFixed(1)+' stretched · buying');
  buy(c,a,sup);
 }
 else if(sup){if(ST.seen%2===0)log('in zone '+sup.lo.toFixed(1)+'-'+sup.hi.toFixed(1)+' · RSI '+r.toFixed(1)+' not stretched (need <'+RSI_BUY+') · waiting');}
 else if(ST.seen%3===0){
  log('SCAN · RSI '+r.toFixed(1)+' · '+zones.length+' zones tracked · hunting a zone dip');
 }
 const v20=ST.candles.slice(-20);
 ST.avgVol=v20.reduce((s2,x)=>s2+x.v,0)/Math.max(1,v20.length);
 save();
}
async function pollPrice(){
 try{
  const j=await pub('/api/v5/market/ticker?instId='+INST);
  const p=parseFloat(j.data&&j.data[0]&&j.data[0].last);
  if(p){ST.price=p;if(ST.pos)manage();}
 }catch(e){}
}
async function reconcile(){
 if(!HASKEYS)return;
 try{
  const b=await api('GET','/api/v5/account/balance');
  let usdt=0,avail=0,ethEq=0,ethBal=0;
  (b.data||[]).forEach(d=>(d.details||[]).forEach(v=>{
   if(v.ccy==='USDT'){usdt=parseFloat(v.eq)||0;avail=parseFloat(v.availBal||v.availEq)||0;}
   if(v.ccy==='ETH'){ethEq=parseFloat(v.eq)||0;ethBal=parseFloat(v.bal)||0;}}));
  ST.usdtEq=usdt;ST.availUsd=avail;ST.eth=ethBal;
  if(ST.pos&&ethBal<0){
   log('SKIP','reality diverged — ETH balance '+ethBal.toFixed(4)+' · external account change · dropping ghost position');
   await cancelAlgos();ST.pos=null;save();return;
  }
  if(ST.pos&&ST.pos.closing&&ethBal>=ST.pos.qty*0.5){
   ST.pos.closing=false;log('stuck closing flag cleared — position still held');save();
  }
  if(!ST.pos&&!ST.skipAdopt&&ethBal>=SPEC.minSz){await adopt(ethBal);}
  else if(ST.pos&&!ST.pos.closing&&ethBal<ST.pos.qty*0.5){
   const pr=ST.price||ST.pos.entry;
   const hitTp=pr>=ST.pos.tp,hitSl=pr<=ST.pos.sl;
   let exit=hitTp?ST.pos.tp:hitSl?ST.pos.sl:pr;
   try{const fl=await api('GET','/api/v5/trade/fills-history?instId='+INST+'&limit=10');
    const sells=(fl.data||[]).filter(z=>z.side==='sell');
    if(sells.length)exit=parseFloat(sells[0].fillPx)||exit;}catch(e){}
   await cancelAlgos();ST.pos.closing=true;
   finalizeTrade(exit,hitTp?'TARGET':hitSl?'STOP':'SIGNAL');
   log('OCO fired between runs — trade recorded from fills');
  }
  else if(ST.pos&&!ST.pos.closing&&!ST.pos.algoId){await armOCO(ST.pos);}
  if(!ST.pos){
   const eq=virtualEquity();
   if(eq<VCAP_FLOOR){
    ST.attempts=(ST.attempts||1)+1;
    log('*** VIRTUAL ACCOUNT BLOWN — equity $'+eq.toFixed(2)+' · fresh $'+VCAP0+' · ATTEMPT #'+ST.attempts+' ***');
    ST.base=VCAP0-ST.trades.reduce((s,t)=>s+(t.pnl||0),0);
    ST.peak=VCAP0;ST.cool=0;save();
   }
  }
 }catch(e){log('reconcile: '+e.message);}
}
async function adopt(eth){
 let entry=ST.price||0;
 try{const fl=await api('GET','/api/v5/trade/fills-history?instId='+INST+'&limit=20');
  const buys=(fl.data||[]).filter(z=>z.side==='buy');
  if(buys.length)entry=parseFloat(buys[0].fillPx)||entry;}catch(e){}
 if(!entry)return;
 const a=(ST.ind&&ST.ind.a)?ST.ind.a[ST.candles.length-1]:NaN;
 const atrV=(isFinite(a)&&a>0)?a:entry*0.006;
 ST.pos={side:1,entry:entry,qty:eth,sl:entry-atrV*ST.settings.sl,tp:entry+atrV*ST.settings.tp,
  atr:atrV,riskUSD:eth*atrV*ST.settings.sl,be:false,tOpen:Date.now(),ext:entry,lastTrail:entry};
 log('adopted ETH balance '+eth.toFixed(4)+' @ ~'+entry.toFixed(1));
 await armOCO(ST.pos);save();
}
async function loadSpec(){
 try{const j=await pub('/api/v5/public/instruments?instType=SPOT&instId='+INST);
  const d=(j.data||[])[0];
  if(d){SPEC.lotSz=parseFloat(d.lotSz)||SPEC.lotSz;SPEC.minSz=parseFloat(d.minSz)||SPEC.minSz;
   SPEC.tickSz=parseFloat(d.tickSz)||SPEC.tickSz;SPEC.minMkt=parseFloat(d.minMktSz)||1;}}catch(e){}
}
(async()=>{
 try{await loadSpec();}catch(e){}
 try{await pollCandles();}catch(e){log('candle fetch failed — '+e.message);}
 try{const j=await pub('/api/v5/market/ticker?instId='+INST);
  const p=parseFloat(j.data&&j.data[0]&&j.data[0].last);
  if(p){ST.price=p;if(ST.pos)manage();}}catch(e){}
 try{await reconcile();}catch(e){}
 snapshotEq();save();
 log('SUMMARY · vcap $'+equity().toFixed(2)+' · pos '+(ST.pos?('LONG '+ST.pos.qty+' @ '+ST.pos.entry):'CASH')
  +' · cool '+ST.cool+' · fills '+ST.trades.length+' · attempt #'+(ST.attempts||1)
  +' · '+(HASKEYS?'LIVE DEMO':'SHADOW MODE'));
 process.exit(0);
})().catch(e=>{console.error('cycle failed:',e.message);save();process.exit(0);});
