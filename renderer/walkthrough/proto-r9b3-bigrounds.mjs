const BASE='http://127.0.0.1:8388/api/v1';
import { spawnSync } from 'node:child_process';
function psql(sql){
  const r=spawnSync('docker',['exec','-i','ops-dev-postgres-1','psql','-U','ops','-d','ops_e2e','-t','-A','-v','ON_ERROR_STOP=1'],{input:sql+'\n',encoding:'utf8',timeout:30000});
  if(r.status!==0)throw new Error('psql: '+(r.stderr||'').slice(0,150));
  return r.stdout.trim().split('\n').filter(l=>!/^(INSERT|UPDATE|DELETE) \d+/.test(l)).pop()??'';
}
async function req(method,path,{body,rawCookie,csrfHeader}={}){
  const h={'Content-Type':'application/json'};
  if(csrfHeader)h['X-CSRF-Token']=csrfHeader;
  if(rawCookie)h['Cookie']=rawCookie;
  const res=await fetch(BASE+path,{method,headers:h,body:body!==undefined?JSON.stringify(body):undefined});
  const t=await res.text();let j=null;try{j=JSON.parse(t)}catch{}
  return {status:res.status,json:j,headers:res.headers};
}
const CONV=process.argv[2];
const owner=psql(`SELECT u.username FROM agent_conversation c JOIN app_user u ON u.id=c.user_id WHERE c.id='${CONV}'`);
let r=await req('POST','/auth/login',{body:{username:owner,password:'{{SECRET_s2wbnk4v}}'}});
const o={cookie:(r.headers?.getSetCookie?.()??[])[0].split(';')[0]};
r=await req('GET','/auth/me',{rawCookie:o.cookie});
r=await req('GET','/auth/me',{rawCookie:o.cookie});const csrf=((r.json&&r.json.csrf_token)||globalThis.R9CSRF||'x');
const filler='这一段是长文本素材：记录可核对的事实来源、数据口径与验证方式，用于压缩窗口边界验证，内容保持谨慎且不夸大。'.repeat(15);
const t0=Date.now();
let ok=0;
for(let i=0;i<70;i++){
  const resp=await req('POST',`/agent/conversations/${CONV}/messages`,{
    body:{text:`R9-2 大窗第 ${i+1} 轮。${filler}`,request_id:crypto.randomUUID(),protocol_version:2},
    rawCookie:o.cookie,csrfHeader:csrf});
  if(resp.status===202)ok++; else if(i<3)console.log('  round',i+1,resp.status,resp.json?.error?.code);
  await new Promise(res=>setTimeout(res,700));
}
console.log(`rounds ok=${ok}/70 elapsed=${((Date.now()-t0)/1000).toFixed(0)}s`);
console.log('chars in messages:',psql(`SELECT sum(length(content)) FROM agent_message WHERE conversation_id='${CONV}';`));
r=await req('GET',`/agent/conversations/${CONV}/compact-preview`,{rawCookie:o.cookie,csrfHeader:csrf});
console.log('compact-preview:',r.status,JSON.stringify(r.json));
r=await req('POST',`/agent/conversations/${CONV}/compact`,{body:{request_id:crypto.randomUUID(),protocol_version:2},rawCookie:o.cookie,csrfHeader:csrf});
console.log('compact POST:',r.status,r.json?.error?.code??('accepted run='+r.json?.run_id?.slice(0,8)));
console.log('events:',psql(`SELECT count(*) FROM agent_event WHERE conversation_id='${CONV}';`));
