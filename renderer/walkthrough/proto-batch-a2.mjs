// 协议走查 A2：账号类型迁移 D-123 / 凭证脱敏 / 角色边界 / 头条
const BASE='http://127.0.0.1:8387/api/v1';
const results=[];
function rec(id,name,ok,detail){results.push({id,name,ok});console.log(`${ok?'PASS':'FAIL'} ${id} ${name} :: ${detail}`);}
function cookieOf(r){const c=r.setCookie[0];return c?c.split(';')[0]:null;}
async function req(method,path,{body,rawCookie,csrfHeader}={}){
  const h={'Content-Type':'application/json'};
  if(csrfHeader)h['X-CSRF-Token']=csrfHeader;
  if(rawCookie)h['Cookie']=rawCookie;
  const res=await fetch(BASE+path,{method,headers:h,body:body?JSON.stringify(body):undefined});
  const setCookie=res.headers.getSetCookie?.()??[];
  const text=await res.text();let json=null;try{json=text?JSON.parse(text):null}catch{json={_raw:text.slice(0,200)}}
  return {status:res.status,json,setCookie};
}
const U=()=>'wt'+Math.random().toString(36).slice(2,10);
const PW='Wt!Passw0rd9x';
let r=await req('POST','/auth/register',{body:{username:U(),password:PW}});
const owner={cookie:cookieOf(r),csrf:null};
r=await req('GET','/auth/me',{rawCookie:owner.cookie});owner.csrf=r.json?.csrf_token;

// 建两个账号：long_article 与 comic
r=await req('POST','/accounts',{body:{name:'LA走查',platform:'wechat_mp',content_format:'long_article'},rawCookie:owner.cookie,csrfHeader:owner.csrf});
const la=r.json?.id;
rec('A2.1','建 long_article 账号',r.status===200&&!!la,`acct=${la?.slice(0,8)}`);
r=await req('POST','/accounts',{body:{name:'CM走查',platform:'wechat_mp',content_format:'comic'},rawCookie:owner.cookie,csrfHeader:owner.csrf});
const cm=r.json?.id;
rec('A2.2','建 comic 账号',r.status===200&&!!cm,`acct=${cm?.slice(0,8)}`);

// F-08 类型迁移：未确认 409 confirm_required
r=await req('PATCH',`/accounts/${la}`,{body:{content_format:'card_post'},rawCookie:owner.cookie,csrfHeader:owner.csrf});
rec('F-08.1','类型迁移缺确认 409',r.status===409&&r.json?.error?.code==='confirm_required',`status=${r.status} err=${r.json?.error?.code}`);
// 确认后迁移
r=await req('PATCH',`/accounts/${la}`,{body:{content_format:'card_post',confirm_type_change:true},rawCookie:owner.cookie,csrfHeader:owner.csrf});
const tc=r.json?.type_change;
rec('F-08.2','确认迁移成功+摘要',r.status===200&&!!tc,`status=${r.status} tc=${JSON.stringify(tc).slice(0,120)}`);
// 跨平台迁移 422
r=await req('PATCH',`/accounts/${cm}`,{body:{platform:'xhs',confirm_type_change:true},rawCookie:owner.cookie,csrfHeader:owner.csrf});
rec('F-08.3','跨平台迁移 422',r.status===422,`status=${r.status} err=${r.json?.error?.code}`);

// F-07 凭证：存 + 读脱敏 + 测试
r=await req('PUT',`/accounts/${la}/wechat-credential`,{body:{app_id:'wx_wt_123',app_secret:'secret_abc'},rawCookie:owner.cookie,csrfHeader:owner.csrf});
rec('F-07.1','存凭证 200',r.status===200,`status=${r.status}`);
r=await req('GET',`/accounts/${la}`,{rawCookie:owner.cookie,csrfHeader:owner.csrf});
const raw=JSON.stringify(r.json);
const hasPlain=raw.includes('secret_abc');
rec('F-07.2','凭证脱敏（响应不含明文 secret）',r.status===200&&!hasPlain,`status=${r.status} plain=${hasPlain}`);
r=await req('POST',`/accounts/${la}/wechat-credential/test`,{body:{},rawCookie:owner.cookie,csrfHeader:owner.csrf});
rec('F-07.3','连通检测（模拟环境）',r.status===200||r.status===502,`status=${r.status} body=${JSON.stringify(r.json).slice(0,140)}`);

// F-06 停用/恢复/删除
r=await req('POST',`/accounts/${cm}/disable`,{body:{},rawCookie:owner.cookie,csrfHeader:owner.csrf});
rec('F-06.1','账号停用',r.status===200,`status=${r.status}`);
r=await req('POST',`/accounts/${cm}/enable`,{body:{},rawCookie:owner.cookie,csrfHeader:owner.csrf});
rec('F-06.2','账号恢复',r.status===200,`status=${r.status}`);

// F-88 头条账号
r=await req('POST','/accounts',{body:{name:'TT走查',platform:'toutiao',content_format:'long_article'},rawCookie:owner.cookie,csrfHeader:owner.csrf});
rec('F-88.1','建头条账号',r.status===200,`status=${r.status} err=${r.json?.error?.code}`);

// F-05 viewer 越权：注册新用户加入，降级 viewer
let m=await req('POST','/auth/register',{body:{username:U(),password:PW}});
const viewer={cookie:cookieOf(m),csrf:null};
r=await req('GET','/auth/me',{rawCookie:viewer.cookie});viewer.csrf=r.json?.csrf_token;
r=await req('GET','/workspaces/current/invites',{rawCookie:owner.cookie,csrfHeader:owner.csrf});
const inv=(r.json?.[0])??(r.json?.invites?.[0]);
r=await req('POST','/workspaces/current/invites',{body:{},rawCookie:owner.cookie,csrfHeader:owner.csrf});
const code2=r.json?.code;
await req('POST','/workspaces/join',{body:{code:code2},rawCookie:viewer.cookie,csrfHeader:viewer.csrf});
// 降为 viewer
r=await req('GET','/workspaces/current/members',{rawCookie:owner.cookie,csrfHeader:owner.csrf});
const list=Array.isArray(r.json)?r.json:(r.json?.members??[]);
const vEntry=list.find(x=>x.username&&x.role!=='owner');
if(vEntry){r=await req('PATCH',`/workspaces/current/members/${vEntry.user_id}`,{body:{role:'viewer'},rawCookie:owner.cookie,csrfHeader:owner.csrf});}
else{r={status:-1,json:{}}}
rec('F-05.5','成员降级为 viewer',r.status===200,`status=${r.status} err=${r.json?.error?.code} n=${list.length}`);
// viewer 写账号 403
r=await req('POST','/accounts',{body:{name:'viewer越权',platform:'wechat_mp',content_format:'long_article'},rawCookie:viewer.cookie,csrfHeader:viewer.csrf});
rec('F-05.6','viewer 建账号 403',r.status===403,`status=${r.status} err=${r.json?.error?.code}`);

console.log(`\nSUMMARY ${results.filter(x=>x.ok).length}/${results.length} pass`);
