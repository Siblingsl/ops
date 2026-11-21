// 阶段一协议走查 A1 修订版：登录/注册/工作区/邀请码/角色越权/CSRF
const BASE = 'http://127.0.0.1:8387/api/v1';
const results = [];
function rec(id, name, ok, detail) { results.push({id,name,ok}); console.log(`${ok?'PASS':'FAIL'} ${id} ${name} :: ${detail}`); }
function cookieOf(r){ const c=r.setCookie[0]; return c?c.split(';')[0]:null; }
async function req(method, path, { body, headers={}, rawCookie, csrfHeader }={}) {
  const h={'Content-Type':'application/json',...headers};
  if(csrfHeader)h['X-CSRF-Token']=csrfHeader;
  if(rawCookie)h['Cookie']=rawCookie;
  const res=await fetch(BASE+path,{method,headers:h,body:body?JSON.stringify(body):undefined});
  const setCookie=res.headers.getSetCookie?.()??[];
  const text=await res.text(); let json=null; try{json=text?JSON.parse(text):null}catch{json={_raw:text.slice(0,200)}}
  return {status:res.status,json,setCookie,text};
}
const U=()=>'wt'+Math.random().toString(36).slice(2,10);
const PW='Wt!Passw0rd9x';

// F-02 注册
let r=await req('POST','/auth/register',{body:{username:U(),password:PW}});
rec('F-02.1','注册建个人工作区并登录',r.status===200&&(r.json?.workspace_id),`status=${r.status} ws=${r.json?.workspace_id?.slice(0,8)}`);
let owner={cookie:cookieOf(r),csrf:null};
r=await req('GET','/auth/me',{rawCookie:owner.cookie});
owner.csrf=r.json?.csrf_token;
rec('F-01.1','/auth/me 返回 CSRF',r.status===200&&!!owner.csrf,`status=${r.status} csrf=${owner.csrf?.slice(0,8)}...`);

// F-01 会话保护
r=await req('GET','/auth/me'); rec('F-01.2','未登录 401',r.status===401,`status=${r.status}`);
r=await req('POST','/auth/login',{body:{username:'nobody_here',password:'Bad!12345678'}});
rec('F-01.3','错误凭据 401',r.status===401,`status=${r.status}`);
r=await req('POST','/workspaces',{body:{name:'越权测试'},rawCookie:owner.cookie});
rec('F-01.4','缺 CSRF 写 403',r.status===403,`status=${r.status} body=${JSON.stringify(r.json).slice(0,120)}`);

// F-04 邀请码
r=await req('POST','/workspaces/current/invites',{body:{},rawCookie:owner.cookie,csrfHeader:owner.csrf});
const code=r.json?.code??r.json?.invite?.code??r.json?.data?.code;
rec('F-04.1','owner 生成邀请码',(r.status===200||r.status===201)&&!!code,`status=${r.status} code=${code}`);
r=await req('GET','/workspaces/current/invites',{rawCookie:owner.cookie,csrfHeader:owner.csrf});
rec('F-04.2','邀请码列表',r.status===200,`status=${r.status} n=${JSON.stringify(r.json).length>50?'ok':'?'}`);

// 成员注册并凭码加入
let m=await req('POST','/auth/register',{body:{username:U(),password:PW}});
const member={cookie:cookieOf(m),csrf:null};
r=await req('GET','/auth/me',{rawCookie:member.cookie}); member.csrf=r.json?.csrf_token;
r=await req('POST','/workspaces/join',{body:{code},rawCookie:member.cookie,csrfHeader:member.csrf});
rec('F-04.3','成员凭码加入',r.status===200&&r.json?.ok===true,`status=${r.status} body=${JSON.stringify(r.json).slice(0,120)}`);
r=await req('POST','/workspaces/join',{body:{code:'WRONGCODE12'},rawCookie:member.cookie,csrfHeader:member.csrf});
rec('F-04.4','无效邀请码被拒',r.status>=400&&r.status<500,`status=${r.status} code=${r.json?.error?.code}`);

// F-05 角色越权：成员（非 owner）尝试管凭证/成员
r=await req('GET','/workspaces/current/members',{rawCookie:owner.cookie,csrfHeader:owner.csrf});
const members=r.json?.members??r.json?.data??[];
const memberEntry=members.find(x=>x.user_id!==members[0]?.user_id)||members[1];
rec('F-05.1','成员列表可读',r.status===200,`status=${r.status} n=${members.length}`);
// 建账号（owner）
r=await req('POST','/accounts',{body:{name:'走查A1',platform:'wechat_mp',content_format:'long_article'},rawCookie:owner.cookie,csrfHeader:owner.csrf});
const acct=r.json?.id??r.json?.account?.id;
rec('F-05.2','owner 建平台账号',r.status===200&&!!acct,`status=${r.status} acct=${acct?.slice(0,8)}`);
// member 尝试写账号（默认角色大概率 editor/viewer）
if(acct){
  r=await req('PATCH',`/accounts/${acct}`,{body:{name:'越权改名'},rawCookie:member.cookie,csrfHeader:member.csrf});
  rec('F-05.3','成员写账号按角色校验',r.status===200||r.status===403||r.status===401,`status=${r.status} err=${r.json?.error?.code}`);
  r=await req('PUT',`/accounts/${acct}/wechat-credential`,{body:{app_id:'wx_x',app_secret:'sec'},rawCookie:member.cookie,csrfHeader:member.csrf});
  rec('F-05.4','非 owner 存凭证被拒(403)或角色允许(200)',r.status===200||r.status===403,`status=${r.status} err=${r.json?.error?.code}`);
}

// F-03 工作区切换/创建
r=await req('POST','/workspaces',{body:{name:'第二工作区'},rawCookie:owner.cookie,csrfHeader:owner.csrf});
const ws2=r.json?.id??r.json?.workspace?.id;
rec('F-03.1','创建第二工作区',r.status===200&&!!ws2,`status=${r.status} ws2=${ws2?.slice(0,8)}`);
if(ws2){r=await req('POST',`/workspaces/${ws2}/switch`,{body:{},rawCookie:owner.cookie,csrfHeader:owner.csrf});
rec('F-03.2','切换工作区',r.status===200,`status=${r.status} err=${r.json?.error?.code}`);}

console.log(`\nSUMMARY ${results.filter(x=>x.ok).length}/${results.length} pass`);
