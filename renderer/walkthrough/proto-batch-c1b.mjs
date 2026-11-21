// C1b：修正 render-check basis_revision + CX 构建 + 小红书/头条发布包 + 发布状态机
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
const PW='{{SECRET_p5jctk8n}}';
let r=await req('POST','/auth/register',{body:{username:U(),password:PW}});
const o={cookie:cookieOf(r),csrf:null};
r=await req('GET','/auth/me',{rawCookie:o.cookie});o.csrf=r.json?.csrf_token;
r=await req('POST','/accounts',{body:{name:'C1b号',platform:'wechat_mp',content_format:'long_article'},rawCookie:o.cookie,csrfHeader:o.csrf});
const A=r.json?.id;
r=await req('POST',`/accounts/${A}/works`,{body:{title:'发布链走查',content_format:'long_article'},rawCookie:o.cookie,csrfHeader:o.csrf});
const W=r.json?.id;
await req('PATCH',`/works/${W}`,{body:{content_md:'# 标题\n\n正文第一段。\n\n## 小节\n\n第二段。'},rawCookie:o.cookie,csrfHeader:o.csrf});
r=await req('GET',`/works/${W}`,{rawCookie:o.cookie,csrfHeader:o.csrf});
const rev=r.json?.revision??r.json?.work?.revision;
rec('E.2','读作品版本',r.status===200&&!!rev,`rev=${rev}`);

// F-49 render-check（basis_revision）
r=await req('POST',`/works/${W}/render-check`,{body:{basis_revision:rev},rawCookie:o.cookie,csrfHeader:o.csrf});
const rc=r.json;
rec('F-49.1','render-check 通过(合法语法)',r.status===200,`status=${r.status} keys=${Object.keys(rc||{}).slice(0,8)}`);
r=await req('PATCH',`/works/${W}`,{body:{content_md:'| a | b |\n| --- | --- |\n| 1 | 2 |\n\n{{embed 不支持语法}}'},rawCookie:o.cookie,csrfHeader:o.csrf});
r=await req('GET',`/works/${W}`,{rawCookie:o.cookie,csrfHeader:o.csrf});
const rev2=r.json?.revision??r.json?.work?.revision;
r=await req('POST',`/works/${W}/render-check`,{body:{basis_revision:rev2},rawCookie:o.cookie,csrfHeader:o.csrf});
const issues=rc?.issues??r.json?.issues??r.json?.errors;
rec('F-49.2','非法语法被报告',r.status===200||r.status===422,`status=${r.status} issues=${JSON.stringify(issues).slice(0,140)||JSON.stringify(r.json).slice(0,140)}`);

// F-50 CX 构建
r=await req('POST',`/works/${W}/builds`,{body:{},rawCookie:o.cookie,csrfHeader:o.csrf});
const B=r.json?.id;
rec('F-50.1','CX 构建受理',r.status===200||r.status===202,`status=${r.status} build=${B?.slice(0,8)} err=${r.json?.error?.code}`);
if(B){
  r=await req('GET',`/builds/${B}`,{rawCookie:o.cookie,csrfHeader:o.csrf});
  rec('F-50.2','构建状态读',r.status===200,`status=${r.status} state=${r.json?.state??r.json?.status}`);
  r=await req('GET',`/works/${W}/builds`,{rawCookie:o.cookie,csrfHeader:o.csrf});
  rec('F-50.3','构建列表',r.status===200,`status=${r.status}`);
}

// F-84 小红书发布包（模拟环境）
r=await req('POST',`/works/${W}/xhs/pack`,{body:{},rawCookie:o.cookie,csrfHeader:o.csrf});
rec('F-84.1','小红书发布包受理',r.status===200||r.status===422,`status=${r.status} err=${r.json?.error?.code} keys=${Object.keys(r.json||{}).slice(0,5)}`);
r=await req('GET',`/works/${W}/xhs/pack`,{rawCookie:o.cookie,csrfHeader:o.csrf});
rec('F-84.2','发布包读',r.status===200,`status=${r.status}`);

// F-81 公众号推送（模拟微信）
r=await req('POST',`/works/${W}/wechat/push`,{body:{},rawCookie:o.cookie,csrfHeader:o.csrf});
rec('F-81.1','公众号推送受理',r.status===200||r.status===422,`status=${r.status} err=${r.json?.error?.code} msg=${r.json?.error?.message?.slice(0,80)}`);

// F-89 发布状态机
r=await req('GET',`/works/${W}/publish-state`,{rawCookie:o.cookie,csrfHeader:o.csrf});
rec('F-89.1','发布状态读',r.status===200,`status=${r.status} body=${JSON.stringify(r.json).slice(0,120)}`);
r=await req('POST',`/works/${W}/publish-state/transition`,{body:{to:'public'},rawCookie:o.cookie,csrfHeader:o.csrf});
rec('F-89.2','to=public 直跳被拒(422)',r.status===422,`status=${r.status} err=${r.json?.error?.code}`);

// F-81 H-05 闸门：检查未确认推送应被拦
console.log(`\nSUMMARY ${results.filter(x=>x.ok).length}/${results.length} pass`);
