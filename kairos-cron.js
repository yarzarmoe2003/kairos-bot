/* ============================================================
   KAIROS CRON v1.0 — single-cycle engine for GitHub Actions
   ETH-USDT · OKX DEMO ONLY · 15-minute candles · long-only
   One run = one decision cycle. State persists via git commit.
   Keys come from GitHub Secrets: OKX_KEY / OKX_SECRET / OKX_PASS
   No keys? SHADOW MODE — logs decisions, places nothing.
   Hard-wired to demo: x-simulated-trading: 1 on every request.
   ============================================================ */
'use strict';
const https=require('https'),crypto=require('crypto'),fs=require('fs');
const INST='ETH-USDT',BAR='15m';
const FEE=0.001,RISK=1.5,WARM=60,MAXC=400;
const SPEC={lotSz:0.0001,minSz:0.0001,tickSz:0.01,minMkt:1};
const STATE=__dirname+'/kairos-state.json';
const KEYS={key:process.env.OKX_KEY||'',secret:process.env.OKX_SECRET||'',pass:process.env.OKX_PASS||''};
const HASKEYS=!!(KEYS.key&&KEYS.secret&&KEYS.pass);

let ST={settings:{sl:1.6,tp:2.4,trend:true,cool:3,running:true},
 pos:null,cool:0,trades:[],markers:[],candles:[],lastClosedT:0,avgVol:0,seen:0,
 fees:0,base:null,peak:null,maxDD:0,usdtEq:null,availUsd:null,eth:0,price:null};
try{const d=JSON.parse(fs.readFileSync(STATE,'utf8'));
 if(d&&d.settings){ST=Object.assign(ST,d);ST.pos=d.pos||null;}}catch(e){}
function save(){try{fs.writeFileSync(STATE,JSON.stringify({
 settings:ST.settings,pos:ST.pos,cool:ST.cool,trades:ST.trades.slice(0,120),
       skipAdopt:ST.skipAdopt,
 markers:ST.markers.slice(-60),candles:ST.candles.slice(-MAXC),lastClosedT:ST.lastClosedT,
 avgVol:ST.avgVol,seen:ST.seen,fees:ST.fees,base:ST.base,peak:ST.peak,maxDD:ST.maxDD}));}catch(e){}}
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
function equity(){return (ST.usdtEq||0)+(ST.eth||0)*(ST.price||0);}
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
function amendStop(x){
 priv('POST','/api/v5/trade/amend-algos',{algoId:x.algoId,instId:INST,newSlTriggerPx:rp(x.sl)})
  .then(j=>{if(j.code!=='0')throw new Error((j.data&&j.data[0]&&j.data[0].sMsg)||'amend rejected');})
  .catch(e=>log('server stop amend failed — '+e.message+' · local trail continues'));}

async function buy(c,a){
 if(!HASKEYS){log('SHADOW MODE — bull cross valid, no keys: order not placed');return;}
 if(ST.pos)return;
 const eq=equity();if(eq<=0){log('equity unknown — skipping');return;}
 const slD=ST.settings.sl*a,tpD=ST.settings.tp*a,entry0=c.c;
 let qty=(eq*RISK/100)/slD,capped=false;
 const capN=Math.max(0,ST.availUsd||0)*0.98;
 if(qty*entry0>capN){qty=capN/entry0;capped=true;}
 qty=Math.floor(qty/SPEC.lotSz)*SPEC.lotSz;qty=+q4(qty);
 if(qty<SPEC.minSz||qty*entry0<SPEC.minMkt){log('below spot minimums — skipped');return;}
 try{
  const r=await api('POST','/api/v5/trade/order',{instId:INST,tdMode:'cash',side:'buy',
   ordType:'market',sz:q4(qty),tgtCcy:'base_ccy'});
  const ordId=r.data&&r.data[0]&&r.data[0].ordId;
  ST.pos={side:1,entry:entry0,qty:qty,sl:entry0-slD,tp:entry0+tpD,atr:a,riskUSD:qty*slD,
   be:false,tOpen:Date.now(),ext:entry0,lastTrail:entry0,ordId:ordId,manual:false};
  ST.markers.push({t:c.t,p:entry0,type:'E'});save();
  log('BUY '+qty.toFixed(4)+' ETH @ ~'+entry0.toFixed(1)+' · SL '+ST.pos.sl.toFixed(1)+' · TP '+ST.pos.tp.toFixed(1)+(capped?' · cash-capped':''));
  await wait(1200);
  let ap=entry0,fsz=qty;
  try{const o=await api('GET','/api/v5/trade/order?ordId='+ordId+'&instId='+INST);
   const d=(o.data||[])[0]||{};
   if(d.avgPx)ap=parseFloat(d.avgPx);if(d.accFillSz)fsz=parseFloat(d.accFillSz);}catch(e){}
  const delta=ap-ST.pos.entry;
  ST.pos.entry=ap;ST.pos.qty=+q4(fsz);ST.pos.sl+=delta;ST.pos.tp+=delta;
  ST.pos.ext=ap;ST.pos.lastTrail=ap;
  log('fill confirmed @ '+ap.toFixed(1)+' · '+ST.pos.qty.toFixed(4)+' ETH');
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
 ST.trades.unshift({ts:Date.now(),src:'strategy',entry:x.entry,exit:exit,qty:x.qty,
  pnl:pnl,r:x.riskUSD?pnl/x.riskUSD:0,reason:reason,dur:Date.now()-x.tOpen});
 if(ST.trades.length>120)ST.trades.length=120;
 ST.markers.push({t:ST.candles.length?ST.candles[ST.candles.length-1].t:Date.now(),p:exit,type:'X',win:pnl>=0});
 if(pnl<0)ST.cool=ST.settings.cool;
 log((pnl>=0?'WIN ':'LOSS ')+reason+' @ '+exit.toFixed(1)+' · '+(pnl>=0?'+':'')+'$'+pnl.toFixed(2));
 snapshotEq();save();
}
function manage(){
 const x=ST.pos;if(!x||!ST.price)return;
 x.ext=Math.max(x.ext||x.entry,ST.price);
 let moved=false;
 if(!x.be&&x.ext>=x.entry+1.2*x.atr){x.sl=Math.max(x.sl,x.entry+0.1*x.atr);x.be=true;moved=true;
  log('breakeven — stop → '+x.sl.toFixed(1));}
 if(x.ext>=x.entry+2*x.atr){const ns=ST.price-1.2*x.atr;
  if(ns>x.sl){x.sl=ns;if(ns-(x.lastTrail||0)>0.15*x.atr){x.lastTrail=ns;moved=true;
   log('trail → '+ns.toFixed(1));}}}
 if(moved){save();if(x.algoId)amendStop(x);else if(HASKEYS)armOCO(x);}
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
 if(newest.t>ST.lastClosedT){
  const first=ST.lastClosedT>0;ST.lastClosedT=newest.t;
  if(first)onClosed();
  else log('history synced — '+ST.candles.length+' × '+BAR+' candles');
 }
}
function onClosed(){
 recompute();
 const i=ST.candles.length-1,c=ST.candles[i];if(i<1||!ST.ind)return;
 const f=ST.ind.f[i],s=ST.ind.s[i],t=ST.ind.t[i],r=ST.ind.r[i],a=ST.ind.a[i];
 const warmed=ST.candles.length>=WARM&&isFinite(r)&&isFinite(a)&&a>0;
 ST.seen++;snapshotEq();
 if(ST.pos){
  const crossDn=f<s&&ST.ind.f[i-1]>=ST.ind.s[i-1];
  if(crossDn){log('bear cross — selling back to USDT');sell(c.c,'SIGNAL');}
  else log('HOLD · uPnL '+(((ST.price||c.c)-ST.pos.entry)*ST.pos.qty).toFixed(2));
  save();return;
 }
 if(!ST.settings.running){save();return;}
 if(!warmed){log('calibrating — '+ST.candles.length+'/'+WARM+' candles');save();return;}
 if(ST.cool>0){ST.cool--;log('cooldown — '+ST.cool+' candles left');save();return;}
 const aPct=a/c.c;
 if(aPct<0.0004||aPct>0.02){log('volatility out of band ('+(aPct*100).toFixed(2)+'%)');save();return;}
 const cu=f>s&&ST.ind.f[i-1]<=ST.ind.s[i-1],cd=f<s&&ST.ind.f[i-1]>=ST.ind.s[i-1];
 const volOK=c.v>0.8*(ST.avgVol||c.v),bps=(f-s)/c.c*1e4;
 if(cd){log('bear cross — long-only spot: staying in cash');}
 else if(cu){
  const rej=[];
  if(ST.settings.trend&&!(c.c>t))rej.push('below EMA200');
  if(r<45||r>72)rej.push('RSI '+r.toFixed(1));
  if(!volOK)rej.push('thin tape');
  if(rej.length)log('bull cross +'+bps.toFixed(1)+'bps rejected — '+rej.join(' · '));
  else buy(c,a);
 }else log('SCAN · EMA Δ '+(bps>=0?'+':'')+bps.toFixed(1)+' bps · RSI '+r.toFixed(1)+' · '+(c.c>t?'above':'below')+' EMA200');
 const v20=ST.candles.slice(-20);
 ST.avgVol=v20.reduce((s2,x)=>s2+x.v,0)/Math.max(1,v20.length);
 save();
}
async function reconcile(){
 if(!HASKEYS)return;
 try{
  const b=await api('GET','/api/v5/account/balance');
  let usdt=0,avail=0,eth=0;
  (b.data||[]).forEach(d=>(d.details||[]).forEach(v=>{
   if(v.ccy==='USDT'){usdt=parseFloat(v.eq)||0;avail=parseFloat(v.availBal||v.availEq)||0;}
   if(v.ccy==='ETH')eth=parseFloat(v.eq)||0;}));
  ST.usdtEq=usdt;ST.availUsd=avail;ST.eth=eth;
     if(!ST.pos&&!ST.skipAdopt&&eth>=SPEC.minSz){await adopt(eth);}
  else if(ST.pos&&!ST.pos.closing&&eth<ST.pos.qty*0.5){
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
 log('SUMMARY · eq $'+equity().toFixed(2)+' · pos '+(ST.pos?('LONG '+ST.pos.qty+' @ '+ST.pos.entry):'CASH')+' · cool '+ST.cool+' · fills '+ST.trades.length+' · '+(HASKEYS?'LIVE DEMO':'SHADOW MODE'));
 process.exit(0);
})().catch(e=>{console.error('cycle failed:',e.message);save();process.exit(0);});
