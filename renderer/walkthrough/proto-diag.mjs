// 复核 B1 失败项：取错误明细，判断是请求体不符还是业务缺陷
const BASE='http://127.0.0.1:8387/api/v1';
async function req(method,path,{body,rawCookie,csrfHeader}={}){
  const h={'Content-Type':'application/json'};
  if(csrfHeader)h['X-CSRF-Token']=csrfHeader; if(rawCookie)h['Cookie']=rawCookie;
  const res=await fetch(BASE+path,{method,headers:h,body:body?JSON.stringify(body):undefined});
  const setCookie=res.headers.getSetCookie?.()??[];
  const text=await res.text();let json=null;try{json=text?JSON.parse(text):null}catch{json={_raw:text.slice(0,300)}}
  return {status:res.status,json,setCookie};
}
const U=()=>'wt'+Math.random().toString(36).slice(2,10);
const PW='{{SECRET_j7hqbvcm}}';
let r=await req('POST','/auth/register',{body:{username:U(),password:PW}});
const o={cookie:r.setCookie[0].split(';')[0],csrf:null};
r=await req('GET','/auth/me',{rawCookie:o.cookie});o.csrf=r.json?.csrf_token;
r=await req('POST','/accounts',{body:{name:'诊断号',platform:'wechat_mp',content_format:'long_article'},rawCookie:o.cookie,csrfHeader:o.csrf});
const A=r.json?.id;

// 素材 422 明细
r=await req('POST','/materials',{body:{title:'走查素材',content:'素材正文内容'},rawCookie:o.cookie,csrfHeader:o.csrf});
console.log('materials POST:',r.status,JSON.stringify(r.json).slice(0,300));
// 风格样本失败明细
r=await req('POST',`/accounts/${A}/style-samples`,{body:{title:'样本1',content:'这是走查风格样本内容。'},rawCookie:o.cookie,csrfHeader:o.csrf});
console.log('style-samples POST:',r.status,JSON.stringify(r.json).slice(0,300));
// 建一个选题再体检
r=await req('POST',`/accounts/${A}/topics`,{body:{title:'诊断选题'},rawCookie:o.cookie,csrfHeader:o.csrf});
const T=r.json?.id??r.json?.topic?.id;
console.log('topic:',r.status,T);
r=await req('POST',`/topics/${T}/diagnose`,{body:{},rawCookie:o.cookie,csrfHeader:o.csrf});
console.log('diagnose:',r.status,JSON.stringify(r.json).slice(0,300));
