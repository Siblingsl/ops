const BASE='http://127.0.0.1:8387/api/v1';
function cookieOf(r){const c=(r.sc??[])[0];return c?c.split(";")[0]:null;}
async function req(method,path,{body,rawCookie,csrfHeader}={}){
  const h={'Content-Type':'application/json'};
  if(csrfHeader)h['X-CSRF-Token']=csrfHeader; if(rawCookie)h['Cookie']=rawCookie;
  const res=await fetch(BASE+path,{method,headers:h,body:body!==undefined?JSON.stringify(body):undefined});
  const sc=res.headers.getSetCookie?.()??[];
  const text=await res.text();let json=null;try{json=text?JSON.parse(text):null}catch{json={_raw:text.slice(0,100)}}
  return {status:res.status,json,sc};
}
let r=await req('POST','/auth/register',{body:{username:'r5a2'+Math.random().toString(36).slice(2,9),password:'{{SECRET_s2wbnk4v}}'}});
const o={cookie:cookieOf(r),csrf:null};
r=await req('GET','/auth/me',{rawCookie:o.cookie});o.csrf=r.json?.csrf_token;
r=await req('POST','/accounts',{body:{name:'漫画H03号',platform:'wechat_mp',content_format:'comic'},rawCookie:o.cookie,csrfHeader:o.csrf});
const A=r.json?.id;
r=await req('POST',`/accounts/${A}/works`,{body:{title:'H03漫画',content_format:'comic'},rawCookie:o.cookie,csrfHeader:o.csrf});
const W=r.json?.id;
await req('PATCH',`/works/${W}`,{body:{viewpoint:'观点：H03 验证'},rawCookie:o.cookie,csrfHeader:o.csrf});
r=await req('POST',`/works/${W}/storyboard/generate`,{body:{panel_count:3,character_ids:[]},rawCookie:o.cookie,csrfHeader:o.csrf});
const panels=r.json?.panels??[];
r=await req('PUT',`/works/${W}/storyboard`,{body:{panels,confirm:true},rawCookie:o.cookie,csrfHeader:o.csrf});
const wFull=await (await fetch(`${BASE}/works/${W}`,{headers:{Cookie:o.cookie}})).json();
const savedPanels=wFull.panels??[];
console.log('save+confirm:',r.status,r.json?.error?.message?.slice(0,50)??'ok', 'respKeys:',Object.keys(r.json??{}), 'panel0:',JSON.stringify((r.json?.panels??[])[0]??r.json?.work?.panels?.[0]??null).slice(0,120));
if(savedPanels[0]?.id){
  r=await req('POST',`/panels/${savedPanels[0].id}/text`,{body:{},rawCookie:o.cookie,csrfHeader:o.csrf});
  console.log('panel-text-after-confirm:',r.status,r.json?.error?.code??'');
}
process.exit(0);
