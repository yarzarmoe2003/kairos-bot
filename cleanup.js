'use strict';
const https=require('https'),crypto=require('crypto');
const K={key:process.env.OKX_KEY||'',secret:process.env.OKX_SECRET||'',pass:process.env.OKX_PASS||''};
function req(method,path,body){return new Promise((res,rej)=>{
  const data=body?JSON.stringify(body):'';
  const ts=new Date().toISOString();
  const sign=crypto.createHmac('sha256',K.secret).update(ts+method+path+data).digest('base64');
  const r=https.request({hostname:'www.okx.com',path:path,method:method,headers:{
    'Content-Type':'application/json','OK-ACCESS-KEY':K.key,'OK-ACCESS-SIGN':sign,
    'OK-ACCESS-TIMESTAMP':ts,'OK-ACCESS-PASSPHRASE':K.pass,'x-simulated-trading':'1'}},
    resp=>{let b='';resp.on('data',c=>b+=c);
      resp.on('end',()=>{try{res(JSON.parse(b));}catch(e){rej(new Error('bad json'));}});});
  r.on('error',rej);r.setTimeout(15000,()=>r.destroy(new Error('timeout')));
  if(data)r.write(data);r.end();});}
async function main(){
  console.log('--- canceling ALL pending algo orders ---');
  const types=['oco','conditional','trigger','trailing_stop','move_order_stop','iceberg','twap'];
  let killed=0;
  for(const t of types){
    try{
      const p=await req('GET','/api/v5/trade/orders-algo-pending?ordType='+t);
      for(const row of (p.data||[])){
        const c=await req('POST','/api/v5/trade/cancel-algos',[{algoId:row.algoId,instId:row.instId}]);
        const ok=(c.data&&c.data[0]&&c.data[0].sCode)==='0';
        console.log((ok?'CANCELED':'FAILED')+' '+t+' '+row.instId+' id='+row.algoId);
        if(ok)killed++;
      }
    }catch(e){console.log('scan '+t+': '+e.message);}
  }
  console.log('algo canceled: '+killed);
  console.log('--- pending regular orders ---');
  try{
    const p=await req('GET','/api/v5/trade/orders-pending');
    for(const o of (p.data||[])){
      const c=await req('POST','/api/v5/trade/cancel-order',{instId:o.instId,ordId:o.ordId});
      console.log('cancel '+o.instId+' '+((c.data&&c.data[0]&&c.data[0].sMsg)||''));
    }
    if(!(p.data||[]).length)console.log('none');
  }catch(e){console.log('orders-pending: '+e.message);}
  console.log('--- balances ---');
  const b=await req('GET','/api/v5/account/balance');
  (b.data||[]).forEach(d=>(d.details||[]).forEach(v=>
    console.log('BAL '+v.ccy+' eq='+(v.eq||0)+' avail='+(v.availBal||v.availEq||0))));
  console.log('DONE — retry the OKX demo reset now');
}
main().catch(e=>{console.error('FATAL '+e.message);process.exit(1);});
