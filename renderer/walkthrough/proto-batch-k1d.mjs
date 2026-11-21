// K1d：模型配置链（providers/routes/agent 默认路由）+ 推送闸门（检查未确认）
const BASE='http://127.0.0.1:8387/api/v1';
const results=[];
function rec(id,name,ok,detail){results.push({id,name,ok});console.log(`${ok?'PASS':'FAIL'} ${id} ${name} :: ${detail}`);}
function cookieOf(r){const c=(r.sc??r.setCookie??[])[0];return c?c.split(";")[0]:null;}
async function req(method,path,{body,rawCookie,csrfHeader}={}){
  const h={'Content-Type':'application/json'};
  if(csrfHeader)h['X-CSRF-Token']=csrfHeader; if(rawCookie)h['Cookie']=rawCookie;
  const res=await fetch(BASE+path,{method,headers:h,body:body?JSON.stringify(body):undefined});
  const sc=res.headers.getSetCookie?.()??[];
  const text=await res.text();let json=null;try{json=text?JSON.parse(text):null}catch{json={_raw:text.slice(0,200)}}
  return {status:res.status,json,sc};
}
const U=()=>'wt'+Math.random().toString(36).slice(2,10);
const PW='{{SECRET_e7blpn2y}}';
let r=await req('POST','/auth/register',{body:{username:U(),password:PW}});
const o={cookie:cookieOf(r),csrf:null};
r=await req('GET','/auth/me',{rawCookie:o.cookie});o.csrf=r.json?.csrf_token;

// F-104 模型配置（模拟供应商）
r=await req('GET','/model-providers',{rawCookie:o.cookie,csrfHeader:o.csrf});
const provs=Array.isArray(r.json)?r.json:(r.json?.items??[]);
rec('F-104.1','供应商列表(含模拟)',r.status===200&&provs.length>=1,`n=${provs.length} names=${provs.map(p=>p.name).slice(0,3).join(',')}`);
const mockProv=provs.find(p=>/mock|模拟/i.test(p.name??''))??provs[0];
if(mockProv){
  r=await req('GET',`/model-providers/${mockProv.id}/models`,{rawCookie:o.cookie,csrfHeader:o.csrf}).catch(()=>({status:-1,json:{}}));
  rec('F-104.2','供应商模型列表',r.status===200||r.status===404,`status=${r.status}`);
}
r=await req('PUT','/model-routes/default',{body:{provider_id:mockProv?.id,model:'mock-writer'},rawCookie:o.cookie,csrfHeader:o.csrf});
rec('F-104.3','设默认模型路由',r.status===200||r.status===422,`status=${r.status} err=${r.json?.error?.code}`);
r=await req('POST',`/model-providers/${mockProv?.id}/test`,{body:{},rawCookie:o.cookie,csrfHeader:o.csrf});
rec('F-104.4','一键测试连通',r.status===200||r.status===404,`status=${r.status} err=${r.json?.error?.code}`);

// F-87 推送上限闸门
r=await req('POST','/accounts',{body:{name:'K1d',platform:'wechat_mp',content_format:'long_article'},rawCookie:o.cookie,csrfHeader:o.csrf});
const A=r.json?.id;
r=await req('POST',`/accounts/${A}/works`,{body:{title:'推送上限',content_format:'long_article'},rawCookie:o.cookie,csrfHeader:o.csrf});
const W=r.json?.id;
await req('PATCH',`/works/${W}`,{body:{content_md:'# 推送\n\n正文。'},rawCookie:o.cookie,csrfHeader:o.csrf});
r=await req('GET',`/works/${W}`,{rawCookie:o.cookie,csrfHeader:o.csrf});
const rev=r.json?.revision??r.json?.work?.revision;
r=await req('POST',`/works/${W}/wechat/push`,{body:{basis_revision:rev},rawCookie:o.cookie,csrfHeader:o.csrf});
rec('F-81.2','检查未确认推送被拦(human_step)',r.status===409&&r.json?.error?.code==='human_step_required',`status=${r.status} err=${r.json?.error?.code}`);

console.log(`\nSUMMARY ${results.filter(x=>x.ok).length}/${results.length} pass`);
