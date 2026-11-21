// 协议走查 B1：选题池（建议/状态流转/体检/库存）+ 风格样本/素材
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
const PW='{{SECRET_r4mdsqxm}}';
let r=await req('POST','/auth/register',{body:{username:U(),password:PW}});
const o={cookie:cookieOf(r),csrf:null};
r=await req('GET','/auth/me',{rawCookie:o.cookie});o.csrf=r.json?.csrf_token;
r=await req('POST','/accounts',{body:{name:'B1选题',platform:'wechat_mp',content_format:'long_article'},rawCookie:o.cookie,csrfHeader:o.csrf});
const A=r.json?.id;

// F-21 手动建选题
r=await req('POST',`/accounts/${A}/topics`,{body:{title:'走查选题一',angle:'如何用小步走查发现界面错位'},rawCookie:o.cookie,csrfHeader:o.csrf});
const T1=r.json?.id??r.json?.topic?.id;
rec('F-21.1','手动建选题',r.status===200&&!!T1,`status=${r.status} topic=${T1?.slice(0,8)}`);

// F-22 AI 选题建议（模拟模型）
r=await req('POST',`/accounts/${A}/topics/suggest`,{body:{},rawCookie:o.cookie,csrfHeader:o.csrf});
const sugg=r.json?.suggestions??r.json?.items??(Array.isArray(r.json)?r.json:[]);
rec('F-22.1','AI 建议返回列表',r.status===200,`status=${r.status} n=${sugg.length??'?'}`);

// F-23 状态流转
r=await req('PATCH',`/topics/${T1}`,{body:{status:'adopted'},rawCookie:o.cookie,csrfHeader:o.csrf});
rec('F-23.1','待定->已采用',r.status===200,`status=${r.status} err=${r.json?.error?.code}`);
r=await req('POST',`/topics/${T1}/works`,{body:{},rawCookie:o.cookie,csrfHeader:o.csrf});
const W=r.json?.id??r.json?.work?.id;
rec('F-23.2','开始创作（带选题）',r.status===200&&!!W,`status=${r.status} work=${W?.slice(0,8)}`);

// F-26 选题体检
r=await req('POST',`/topics/${T1}/diagnose`,{body:{},rawCookie:o.cookie,csrfHeader:o.csrf});
rec('F-26.1','选题体检',r.status===200,`status=${r.status} keys=${Object.keys(r.json||{}).slice(0,6)}`);
r=await req('GET',`/topics/${T1}/diagnoses`,{rawCookie:o.cookie,csrfHeader:o.csrf});
rec('F-26.2','体检历史',r.status===200,`status=${r.status}`);

// F-27 选题库存
r=await req('GET',`/accounts/${A}/topic-stock`,{rawCookie:o.cookie,csrfHeader:o.csrf});
rec('F-27.1','选题库存读',r.status===200,`status=${r.status} body=${JSON.stringify(r.json).slice(0,120)}`);
r=await req('POST',`/topics/${T1}/verify`,{body:{},rawCookie:o.cookie,csrfHeader:o.csrf});
rec('F-27.2','库存核验',r.status===200||r.status===422,`status=${r.status} err=${r.json?.error?.code}`);

// F-14 风格样本（3-10 边界）
let okCreate=true;
for(let i=0;i<3;i++){
  const rr=await req('POST',`/accounts/${A}/style-samples`,{body:{title:`样本${i+1}`,content:'这是走查风格样本内容，包含一些常见的句子结构。'},rawCookie:o.cookie,csrfHeader:o.csrf});
  if(rr.status!==200)okCreate=false;
}
rec('F-14.1','风格样本创建 x3',okCreate,'3 条全部 200');
r=await req('POST',`/accounts/${A}/style-summary`,{body:{},rawCookie:o.cookie,csrfHeader:o.csrf});
rec('F-17.1','AI 风格摘要',r.status===200,`status=${r.status} keys=${Object.keys(r.json||{}).slice(0,5)}`);

// F-15 素材
r=await req('POST','/materials',{body:{title:'走查素材',content:'素材正文内容'},rawCookie:o.cookie,csrfHeader:o.csrf});
const M=r.json?.id;
rec('F-15.1','建素材',r.status===200&&!!M,`status=${r.status} mat=${M?.slice(0,8)}`);
r=await req('GET','/materials',{rawCookie:o.cookie,csrfHeader:o.csrf});
rec('F-15.2','素材列表',r.status===200,`status=${r.status}`);

console.log(`\nSUMMARY ${results.filter(x=>x.ok).length}/${results.length} pass`);
