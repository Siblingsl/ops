// 细查②：协议负例矩阵 R2
const BASE='http://127.0.0.1:8387/api/v1';
const F=[];
function rec(id,ok,detail){F.push({id,ok});console.log(`${ok?'ok ':'FAIL'} ${id} :: ${detail}`);}
function cookieOf(r){const c=(r.sc??[])[0];return c?c.split(";")[0]:null;}
async function req(method,path,{body,rawCookie,csrfHeader,headers}={}){
  const h={'Content-Type':'application/json',...(headers??{})};
  if(csrfHeader)h['X-CSRF-Token']=csrfHeader; if(rawCookie)h['Cookie']=rawCookie;
  const res=await fetch(BASE+path,{method,headers:h,body:body!==undefined?JSON.stringify(body):undefined});
  const sc=res.headers.getSetCookie?.()??[];
  const text=await res.text();let json=null;try{json=text?JSON.parse(text):null}catch{json={_raw:text.slice(0,150)}}
  return {status:res.status,json,sc};
}
const U=()=>'wt2'+Math.random().toString(36).slice(2,9);
const PW='{{SECRET_s2wbnk4v}}';
let r=await req('POST','/auth/register',{body:{username:U(),password:PW}});
const o={cookie:cookieOf(r),csrf:null};
r=await req('GET','/auth/me',{rawCookie:o.cookie});o.csrf=r.json?.csrf_token;
r=await req('POST','/accounts',{body:{name:'R2号',platform:'wechat_mp',content_format:'long_article'},rawCookie:o.cookie,csrfHeader:o.csrf});
const A=r.json?.id;
r=await req('POST',`/accounts/${A}/works`,{body:{title:'R2作品',content_format:'long_article'},rawCookie:o.cookie,csrfHeader:o.csrf});
const W=r.json?.id;

// N1 IDOR：注册第二个用户，跨工作区读第一个用户的账号/作品/素材
let r2=await req('POST','/auth/register',{body:{username:U(),password:PW}});
const other={cookie:cookieOf(r2),csrf:null};
r=await req('GET','/auth/me',{rawCookie:other.cookie});other.csrf=r.json?.csrf_token;
r=await req('GET',`/accounts/${A}`,{rawCookie:other.cookie,csrfHeader:other.csrf});
rec('N1-IDOR-account',r.status===404,`status=${r.status}`);
r=await req('GET',`/works/${W}`,{rawCookie:other.cookie,csrfHeader:other.csrf});
rec('N1-IDOR-work',r.status===404,`status=${r.status}`);
r=await req('PATCH',`/works/${W}`,{body:{title:'越权改'},rawCookie:other.cookie,csrfHeader:other.csrf});
rec('N1-IDOR-work-patch',r.status===404,`status=${r.status}`);
r=await req('GET',`/accounts/${A}/topics`,{rawCookie:other.cookie,csrfHeader:other.csrf});
rec('N1-IDOR-topics',r.status===404||r.status===403,`status=${r.status}`);

// N2 字段边界：超长字段 / 负数 / 0 / 浮点 / 巨大数值
r=await req('POST',`/accounts/${A}/topics`,{body:{title:'T'.repeat(301)},rawCookie:o.cookie,csrfHeader:o.csrf});
rec('N2-topic-title-301',r.status===422||r.status===200,`status=${r.status} err=${r.json?.error?.code}`);
r=await req('POST','/materials',{body:{title:'x',content:'c'.repeat(60000),kind:'case'},rawCookie:o.cookie,csrfHeader:o.csrf});
rec('N2-material-60k',r.status===200||r.status===422,`status=${r.status}`);
r=await req('POST',`/accounts/${A}/metrics/import`,{body:{rows:[{metric_date:'2026-11-20',reads:-5}]},rawCookie:o.cookie,csrfHeader:o.csrf});
rec('N2-metrics-negative',r.status===422,`status=${r.status} err=${r.json?.error?.code}`);
r=await req('POST',`/accounts/${A}/metrics/import`,{body:{rows:[{metric_date:'2026-11-20',reads:1e15}]},rawCookie:o.cookie,csrfHeader:o.csrf});
rec('N2-metrics-huge',r.status===422||r.status===200,`status=${r.status}`);
r=await req('POST',`/accounts/${A}/topics`,{body:{title:'浮点',angle:{__proto__:{}},x:['a']},rawCookie:o.cookie,csrfHeader:o.csrf});
rec('N2-wrong-types',r.status===422||r.status===400,`status=${r.status}`);

// N3 日期边界：未来日期 / 乱格式
r=await req('POST',`/accounts/${A}/metrics/import`,{body:{rows:[{metric_date:'2099-01-01',reads:1}]},rawCookie:o.cookie,csrfHeader:o.csrf});
rec('N3-future-date',r.status===422||r.status===200,`status=${r.status} msg=${r.json?.error?.message?.slice(0,60)}`);
r=await req('POST',`/accounts/${A}/metrics/import`,{body:{rows:[{metric_date:'2026-13-45',reads:1}]},rawCookie:o.cookie,csrfHeader:o.csrf});
rec('N3-bad-date',r.status===422,`status=${r.status}`);

// N4 分页/游标：负数 limit、超大 limit
r=await req('GET',`/accounts/${A}/works?limit=-1`,{rawCookie:o.cookie,csrfHeader:o.csrf});
rec('N4-limit-neg',r.status===200||r.status===422,`status=${r.status}`);
r=await req('GET',`/accounts/${A}/works?limit=999999`,{rawCookie:o.cookie,csrfHeader:o.csrf});
rec('N4-limit-huge',r.status===200||r.status===422,`status=${r.status}`);

// N5 重复键 JSON / 深层嵌套
r=await req('POST',`/accounts/${A}/topics`,{body:undefined,headers:{'Content-Type':'application/json'},rawCookie:o.cookie,csrfHeader:o.csrf,});
{ // 手造重复键 body
  const res=await fetch(BASE+`/accounts/${A}/topics`,{method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':o.csrf,Cookie:o.cookie},body:'{"title":"a","title":"b"}'});
  rec('N5-dup-json-keys',res.status===400||res.status===422,`status=${res.status}`);
}
{ // 巨型嵌套
  const deep={'title':'x'}; let cur=deep; for(let i=0;i<200;i++){cur.n={};cur=cur.n;}
  const res=await fetch(BASE+`/accounts/${A}/topics`,{method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':o.csrf,Cookie:o.cookie},body:JSON.stringify(deep)});
  rec('N5-deep-nest',res.status===400||res.status===422||res.status===413,`status=${res.status}`);
}

// N6 CAS：works base_revision 过期
r=await req('GET',`/works/${W}`,{rawCookie:o.cookie,csrfHeader:o.csrf});
const rev=r.json?.revision??1;
r=await req('PATCH',`/works/${W}`,{body:{title:'第一次',base_revision:rev},rawCookie:o.cookie,csrfHeader:o.csrf});
rec('N6-cas-first',r.status===200,`status=${r.status}`);
r=await req('PATCH',`/works/${W}`,{body:{title:'第二次',base_revision:rev},rawCookie:o.cookie,csrfHeader:o.csrf});
rec('N6-cas-stale-409',r.status===409,`status=${r.status} err=${r.json?.error?.code}`);

// N7 会话固定/注销：logout 后 cookie 失效
r=await req('POST','/auth/logout',{body:{},rawCookie:o.cookie,csrfHeader:o.csrf});
rec('N7-logout',r.status===200,`status=${r.status}`);
r=await req('GET','/auth/me',{rawCookie:o.cookie});
rec('N7-cookie-after-logout',r.status===401,`status=${r.status}`);

console.log(`\nR2-NEGATIVE ${F.filter(x=>x.ok).length}/${F.length} pass`);
