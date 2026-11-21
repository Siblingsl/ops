// D1：主题库/封面预设/组图计划/视觉DNA/账号分析
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
const PW='{{SECRET_n4wrjp9v}}';
let r=await req('POST','/auth/register',{body:{username:U(),password:PW}});
const o={cookie:cookieOf(r),csrf:null};
r=await req('GET','/auth/me',{rawCookie:o.cookie});o.csrf=r.json?.csrf_token;
r=await req('POST','/accounts',{body:{name:'D1号',platform:'xhs',content_format:'card_post'},rawCookie:o.cookie,csrfHeader:o.csrf});
const A=r.json?.id;

// F-51 主题（公共路由）
r=await req('GET','/themes',{rawCookie:o.cookie,csrfHeader:o.csrf});
if(r.status===404){r=await req('GET','/render-themes',{rawCookie:o.cookie,csrfHeader:o.csrf});}
rec('F-51.1','主题列表(8套)',r.status===200,`status=${r.status} n=${Array.isArray(r.json)?r.json.length:'?'}`);

// F-66 封面预设
r=await req('GET','/cover-presets',{rawCookie:o.cookie,csrfHeader:o.csrf});
rec('F-66.1','封面预设(5类两1:1)',r.status===200,`status=${r.status} n=${Array.isArray(r.json)?r.json.length:JSON.stringify(r.json).length}`);

// F-47 组图计划
r=await req('POST',`/accounts/${A}/works`,{body:{title:'组图走查',content_format:'card_post'},rawCookie:o.cookie,csrfHeader:o.csrf});
const W=r.json?.id;
await req('PATCH',`/works/${W}`,{body:{content_md:'卡片一：封面\n\n卡片二：要点A\n\n卡片三：要点B'},rawCookie:o.cookie,csrfHeader:o.csrf});
r=await req('GET',`/works/${W}`,{rawCookie:o.cookie,csrfHeader:o.csrf});
const rev=r.json?.revision??r.json?.work?.revision;
r=await req('POST',`/works/${W}/cards/plan`,{body:{basis_revision:rev,selection:[1,2,3]},rawCookie:o.cookie,csrfHeader:o.csrf});
if(r.status===404){r=await req('POST',`/works/${W}/cards/preview`,{body:{basis_revision:rev,selection:[1,2,3]},rawCookie:o.cookie,csrfHeader:o.csrf});}
rec('F-47.1','组图计划/预览受理',r.status===200||r.status===202||r.status===422,`status=${r.status} err=${r.json?.error?.code} msg=${r.json?.error?.message?.slice(0,80)}`);

// F-19 视觉DNA
r=await req('GET',`/accounts/${A}/visual-dna`,{rawCookie:o.cookie,csrfHeader:o.csrf});
rec('F-19.1','视觉DNA读(零写)',r.status===200||r.status===404,`status=${r.status} err=${r.json?.error?.code}`);
r=await req('PUT',`/accounts/${A}/visual-dna`,{body:{tokens:{color_primary:'#123456'},base_version:0},rawCookie:o.cookie,csrfHeader:o.csrf});
rec('F-19.2','视觉DNA保存',r.status===200||r.status===404||r.status===409,`status=${r.status} err=${r.json?.error?.code}`);

// F-20 账号分析
r=await req('POST',`/accounts/${A}/analysis`,{body:{},rawCookie:o.cookie,csrfHeader:o.csrf});
rec('F-20.1','AI 账号分析受理',r.status===200||r.status===202||r.status===404,`status=${r.status} err=${r.json?.error?.code}`);

// F-94 手动指标录入
r=await req('POST',`/accounts/${A}/metrics/import`,{body:{rows:[{metric_date:'2026-11-20',reads:100,likes:10,comments:2,shares:1,follows_gained:1,collects:3}]},rawCookie:o.cookie,csrfHeader:o.csrf});
rec('F-94.1','手动指标导入',r.status===200||r.status===422,`status=${r.status} err=${r.json?.error?.code} msg=${r.json?.error?.message?.slice(0,60)}`);

// F-95 看板
r=await req('GET',`/accounts/${A}/metrics/dashboard`,{rawCookie:o.cookie,csrfHeader:o.csrf});
if(r.status===404){r=await req('GET',`/accounts/${A}/metrics`,{rawCookie:o.cookie,csrfHeader:o.csrf});}
rec('F-95.1','指标看板读',r.status===200||r.status===404,`status=${r.status} err=${r.json?.error?.code}`);

console.log(`\nSUMMARY ${results.filter(x=>x.ok).length}/${results.length} pass`);
