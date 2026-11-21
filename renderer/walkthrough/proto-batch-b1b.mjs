// 协议走查 B1b：修正字段名后复跑
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
const PW='{{SECRET_x8nbeuvk}}';
let r=await req('POST','/auth/register',{body:{username:U(),password:PW}});
const o={cookie:cookieOf(r),csrf:null};
r=await req('GET','/auth/me',{rawCookie:o.cookie});o.csrf=r.json?.csrf_token;
r=await req('POST','/accounts',{body:{name:'B1b号',platform:'wechat_mp',content_format:'long_article'},rawCookie:o.cookie,csrfHeader:o.csrf});
const A=r.json?.id;

// F-14 风格样本
let okAll=true;
for(let i=0;i<3;i++){
  const rr=await req('POST',`/accounts/${A}/style-samples`,{body:{title:`样本${i+1}`,content_md:`这是走查风格样本内容第${i+1}篇，包含常见的句子结构与表达习惯，用于检测上下文注入。`},rawCookie:o.cookie,csrfHeader:o.csrf});
  if(rr.status!==200)okAll=false;
}
rec('F-14.1','风格样本创建 x3',okAll,'3 条 200');
r=await req('POST',`/accounts/${A}/style-summary`,{body:{},rawCookie:o.cookie,csrfHeader:o.csrf});
rec('F-17.1','AI 风格摘要（模拟模型）',r.status===200,`status=${r.status} keys=${Object.keys(r.json||{}).slice(0,6)} err=${r.json?.error?.code}`);

// F-15 素材（kind 必填）
r=await req('POST','/materials',{body:{title:'走查素材',content:'素材正文内容，用于跨账号隔离验证。',kind:'案例'},rawCookie:o.cookie,csrfHeader:o.csrf});
const M=r.json?.id;
rec('F-15.1','建素材(带kind)',r.status===200&&!!M,`status=${r.status} mat=${M?.slice(0,8)}`);
r=await req('GET','/materials',{rawCookie:o.cookie,csrfHeader:o.csrf});
rec('F-15.2','素材列表',r.status===200,`status=${r.status}`);

// F-26 选题体检（basis_updated_at 必填）
r=await req('POST',`/accounts/${A}/topics`,{body:{title:'体检选题'},rawCookie:o.cookie,csrfHeader:o.csrf});
const T=r.json?.id;
const now=new Date().toISOString();
r=await req('POST',`/topics/${T}/diagnose`,{body:{basis_updated_at:now},rawCookie:o.cookie,csrfHeader:o.csrf});
rec('F-26.1','选题体检',r.status===200,`status=${r.status} err=${r.json?.error?.code} msg=${r.json?.error?.message?.slice(0,80)}`);

// F-29/F-30 创作：大纲+分段（模拟模型）
r=await req('POST',`/accounts/${A}/works`,{body:{title:'协议走查作品',content_format:'long_article'},rawCookie:o.cookie,csrfHeader:o.csrf});
const W=r.json?.id;
rec('A.1','建作品',r.status===200&&!!W,`work=${W?.slice(0,8)}`);
r=await req('POST',`/works/${W}/outline/generate`,{body:{viewpoint:'走查观点：小步验证优于一次性大改动'},rawCookie:o.cookie,csrfHeader:o.csrf});
rec('F-29.1','AI 大纲生成',r.status===200,`status=${r.status} err=${r.json?.error?.code} keys=${Object.keys(r.json||{}).slice(0,5)}`);
r=await req('PUT',`/works/${W}/outline`,{body:{sections:[{heading:'第一节',summary:'要点一'},{heading:'第二节',summary:'要点二'}]},rawCookie:o.cookie,csrfHeader:o.csrf});
rec('F-29.2','保存大纲',r.status===200,`status=${r.status} err=${r.json?.error?.code}`);

console.log(`\nSUMMARY ${results.filter(x=>x.ok).length}/${results.length} pass`);
