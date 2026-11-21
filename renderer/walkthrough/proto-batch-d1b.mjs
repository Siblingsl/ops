// D1b：视觉DNA(完整tokens schema)+主题清单（前端内建?）+组图计划字段
const BASE='http://127.0.0.1:8387/api/v1';
const results=[];
function rec(id,name,ok,detail){results.push({id,name,ok});console.log(`${ok?'PASS':'FAIL'} ${id} ${name} :: ${detail}`);}
function cookieOf(r){const c=r.setCookie[0];return c?c.split(';')[0]:null;}
async function req(method,path,{body,rawCookie,csrfHeader}={}){
  const h={'Content-Type':'application/json'};
  if(csrfHeader)h['X-CSRF-Token']=csrfHeader; if(rawCookie)h['Cookie']=rawCookie;
  const res=await fetch(BASE+path,{method,headers:h,body:body?JSON.stringify(body):undefined});
  const setCookie=res.headers.getSetCookie?.()??[];
  const text=await res.text();let json=null;try{json=text?JSON.parse(text):null}catch{json={_raw:text.slice(0,200)}}
  return {status:res.status,json,setCookie};
}
const U=()=>'wt'+Math.random().toString(36).slice(2,10);
const PW='{{SECRET_z5fjhb8k}}';
let r=await req('POST','/auth/register',{body:{username:U(),password:PW}});
const o={cookie:cookieOf(r),csrf:null};
r=await req('GET','/auth/me',{rawCookie:o.cookie});o.csrf=r.json?.csrf_token;
r=await req('POST','/accounts',{body:{name:'D1b',platform:'xhs',content_format:'card_post'},rawCookie:o.cookie,csrfHeader:o.csrf});
const A=r.json?.id;
const tokens={schema:'ops.visual-dna/v1',palette:{primary:'#1B5E20',secondary:'#1565C0',background:'#FFFFFF',text:'#212121',muted:'#555555'},font_stack:'system-sans',radius:12,spacing_scale:'1.00',logo_asset_id:null,watermark:{text:'',position:'bottom-right',opacity:'0.00'},card_template_default:'editorial',card_ratio_default:'3:4',end_copy:'关注我'};
r=await req('PUT',`/accounts/${A}/visual-dna`,{body:{base_version:0,tokens},rawCookie:o.cookie,csrfHeader:o.csrf});
rec('F-19.2','视觉DNA保存(201)',r.status===201||r.status===200,`status=${r.status} err=${r.json?.error?.code}`);
r=await req('GET',`/accounts/${A}/visual-dna`,{rawCookie:o.cookie,csrfHeader:o.csrf});
const ver=r.json?.base_version??r.json?.version;
rec('F-19.3','视觉DNA读回',r.status===200,`ver=${ver}`);
// CAS 冲突
r=await req('PUT',`/accounts/${A}/visual-dna`,{body:{base_version:0,tokens},rawCookie:o.cookie,csrfHeader:o.csrf});
rec('F-19.4','CAS 冲突 409',r.status===409,`status=${r.status} err=${r.json?.error?.code}`);
// 未知字段拒绝
const bad={...tokens,bogus_field:'x'};
r=await req('PUT',`/accounts/${A}/visual-dna`,{body:{base_version:ver,tokens:bad},rawCookie:o.cookie,csrfHeader:o.csrf});
rec('F-19.5','未知字段拒绝',r.status===422,`status=${r.status} err=${r.json?.error?.code}`);

// 组图计划（模拟模型）
r=await req('POST',`/accounts/${A}/works`,{body:{title:'组图D1b',content_format:'card_post'},rawCookie:o.cookie,csrfHeader:o.csrf});
const W=r.json?.id;
await req('PATCH',`/works/${W}`,{body:{content_md:'第一张：封面说明\n\n第二张：要点\n\n第三张：结尾'},rawCookie:o.cookie,csrfHeader:o.csrf});
r=await req('GET',`/works/${W}`,{rawCookie:o.cookie,csrfHeader:o.csrf});
const rev=r.json?.revision??r.json?.work?.revision;
r=await req('POST',`/works/${W}/cards/plan`,{body:{basis_revision:rev,section_start:1,section_end:3},rawCookie:o.cookie,csrfHeader:o.csrf});
rec('F-47.1','组图AI计划受理',r.status===200||r.status===202||r.status===422,`status=${r.status} err=${r.json?.error?.code} msg=${r.json?.error?.message?.slice(0,80)}`);

console.log(`\nSUMMARY ${results.filter(x=>x.ok).length}/${results.length} pass`);
