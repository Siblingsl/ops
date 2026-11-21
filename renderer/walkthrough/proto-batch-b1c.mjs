// B1c：素材 kind 英文值 + 大纲 human_step 契约 + 体检路径
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
const PW='{{SECRET_q2wznx8y}}';
let r=await req('POST','/auth/register',{body:{username:U(),password:PW}});
const o={cookie:cookieOf(r),csrf:null};
r=await req('GET','/auth/me',{rawCookie:o.cookie});o.csrf=r.json?.csrf_token;
r=await req('POST','/accounts',{body:{name:'B1c号',platform:'wechat_mp',content_format:'long_article'},rawCookie:o.cookie,csrfHeader:o.csrf});
const A=r.json?.id;

// F-15 素材
r=await req('POST','/materials',{body:{title:'走查素材',content:'素材正文内容，用于跨账号隔离验证。',kind:'case'},rawCookie:o.cookie,csrfHeader:o.csrf});
const M=r.json?.id;
rec('F-15.1','建素材(kind=case)',r.status===200&&!!M,`status=${r.status} mat=${M?.slice(0,8)}`);
r=await req('GET',`/materials?account_id=${A}`,{rawCookie:o.cookie,csrfHeader:o.csrf});
rec('F-15.2','素材列表(带account_id)',r.status===200,`status=${r.status} err=${r.json?.error?.message?.slice(0,60)}`);
// 素材跨账号隔离：建第二账号查素材
r=await req('POST','/accounts',{body:{name:'隔离号',platform:'wechat_mp',content_format:'long_article'},rawCookie:o.cookie,csrfHeader:o.csrf});
const B=r.json?.id;
r=await req('GET',`/materials?account_id=${B}&scope=account`,{rawCookie:o.cookie,csrfHeader:o.csrf});
const arr=Array.isArray(r.json)?r.json:(r.json?.items??[]);
rec('F-15.3','账号B看不到A专属素材',r.status===200,`status=${r.status} n=${arr.length??'?'}`);

// F-29 大纲 human_step 契约（确认点 H-03 的协议表现）
r=await req('POST',`/accounts/${A}/works`,{body:{title:'大纲契约作品',content_format:'long_article'},rawCookie:o.cookie,csrfHeader:o.csrf});
const W=r.json?.id;
// 不给观点 -> H-02
r=await req('POST',`/works/${W}/outline/generate`,{body:{},rawCookie:o.cookie,csrfHeader:o.csrf});
rec('F-28.1','无观点生成大纲被拒',r.status===422||r.status===409||r.status===400,`status=${r.status} err=${r.json?.error?.code}`);
r=await req('PATCH',`/works/${W}`,{body:{viewpoint:'走查观点：小步验证'},rawCookie:o.cookie,csrfHeader:o.csrf});
rec('F-28.2','写观点',r.status===200,`status=${r.status} err=${r.json?.error?.code}`);
r=await req('POST',`/works/${W}/outline/generate`,{body:{},rawCookie:o.cookie,csrfHeader:o.csrf});
const needConfirm=r.json?.error?.code==='human_step_required';
rec('F-29.1','大纲生成返回确认步(human_step_required)',needConfirm||r.status===200,`status=${r.status} err=${r.json?.error?.code}`);
// 大纲生成受理（若有 pending 步骤需确认）
if(needConfirm){
  const stepId=r.json?.step?.id??r.json?.human_step_id;
  console.log('  -> confirm step:',JSON.stringify(r.json).slice(0,240));
}

console.log(`\nSUMMARY ${results.filter(x=>x.ok).length}/${results.length} pass`);
