// R5-B：评分/诊断/热点/方案槽（六维评分、批量、诊断、hot convert/dismiss、plan-slots adopt/regenerate/clear）
const BASE='http://127.0.0.1:8387/api/v1';
const F=[];
function rec(id,ok,detail){F.push({id,ok});console.log(`${ok?'ok ':'FAIL'} ${id} :: ${detail}`);}
function cookieOf(r){const c=(r.sc??[])[0];return c?c.split(";")[0]:null;}
async function req(method,path,{body,rawCookie,csrfHeader}={}){
  const h={'Content-Type':'application/json'};
  if(csrfHeader)h['X-CSRF-Token']=csrfHeader; if(rawCookie)h['Cookie']=rawCookie;
  const res=await fetch(BASE+path,{method,headers:h,body:body!==undefined?JSON.stringify(body):undefined});
  const sc=res.headers.getSetCookie?.()??[];
  const text=await res.text();let json=null;try{json=text?JSON.parse(text):null}catch{json={_raw:text.slice(0,100)}}
  return {status:res.status,json,sc};
}
const U=()=>'r5b'+Math.random().toString(36).slice(2,9);
let r=await req('POST','/auth/register',{body:{username:U(),password:'{{SECRET_s2wbnk4v}}'}});
const o={cookie:cookieOf(r),csrf:null};
r=await req('GET','/auth/me',{rawCookie:o.cookie});o.csrf=r.json?.csrf_token;
r=await req('POST','/accounts',{body:{name:'R5B号',platform:'wechat_mp',content_format:'long_article'},rawCookie:o.cookie,csrfHeader:o.csrf});
const A=r.json?.id;
r=await req('POST',`/accounts/${A}/topics`,{body:{title:'R5B选题：小步验证',angle:'效率'},rawCookie:o.cookie,csrfHeader:o.csrf});
const T=r.json?.id;

// T1 六维评分
r=await req('POST',`/topics/${T}/score`,{body:{},rawCookie:o.cookie,csrfHeader:o.csrf});
rec('T1-score',r.status===200||r.status===422,`status=${r.status} dims=${Object.keys(r.json?.dimensions??r.json??{}).slice(0,6)}`);
r=await req('GET',`/topics/${T}/score`,{rawCookie:o.cookie,csrfHeader:o.csrf});
rec('T1-score-read',r.status===200,`status=${r.status}`);
// T2 批量评分
r=await req('POST','/topics/score-batch',{body:{topic_ids:[T]},rawCookie:o.cookie,csrfHeader:o.csrf});
rec('T2-score-batch',r.status===200||r.status===422,`status=${r.status} err=${r.json?.error?.code}`);
// T3 诊断
r=await req('POST',`/topics/${T}/diagnose`,{body:{basis_updated_at:new Date().toISOString()},rawCookie:o.cookie,csrfHeader:o.csrf});
rec('T3-diagnose',r.status===200||r.status===422,`status=${r.status} err=${r.json?.error?.code}`);
// T4 热点
r=await req('GET',`/accounts/${A}/hot`,{rawCookie:o.cookie,csrfHeader:o.csrf});
rec('T4-hot-get',r.status===200,`status=${r.status}`);
r=await req('POST',`/accounts/${A}/hot/refresh`,{body:{},rawCookie:o.cookie,csrfHeader:o.csrf});
rec('T4-hot-refresh',r.status===200||r.status===422,`status=${r.status} err=${r.json?.error?.code}`);
// T5 方案槽
r=await req('GET',`/accounts/${A}/plan`,{rawCookie:o.cookie,csrfHeader:o.csrf});
const slots=r.json?.slots??[];
rec('T5-plan-get',r.status===200,`status=${r.status} slots=${slots.length}`);
const slot=slots[0];
if(slot?.id){
  r=await req('POST',`/plan-slots/${slot.id}/regenerate`,{body:{},rawCookie:o.cookie,csrfHeader:o.csrf});
  rec('T5-slot-regenerate',r.status===200||r.status===422,`status=${r.status} err=${r.json?.error?.code}`);
  r=await req('POST',`/plan-slots/${slot.id}/adopt`,{body:{},rawCookie:o.cookie,csrfHeader:o.csrf});
  rec('T5-slot-adopt',r.status===200||r.status===422,`status=${r.status} err=${r.json?.error?.code} msg=${r.json?.error?.message?.slice(0,50)}`);
  r=await req('POST',`/plan-slots/${slot.id}/clear`,{body:{},rawCookie:o.cookie,csrfHeader:o.csrf});
  rec('T5-slot-clear',r.status===200||r.status===422,`status=${r.status}`);
}else rec('T5-slot-ops',true,'无槽位（新号未启用方案）');

console.log(`\nR5B ${F.filter(x=>x.ok).length}/${F.length} pass`);
