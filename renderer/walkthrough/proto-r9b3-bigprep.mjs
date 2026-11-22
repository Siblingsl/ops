const BASE='http://127.0.0.1:8388/api/v1';
async function req(method,path,{body,rawCookie,csrfHeader}={}){
  const h={'Content-Type':'application/json'};
  if(csrfHeader)h['X-CSRF-Token']=csrfHeader;
  if(rawCookie)h['Cookie']=rawCookie;
  const res=await fetch(BASE+path,{method,headers:h,body:body!==undefined?JSON.stringify(body):undefined});
  const t=await res.text();let j=null;try{j=JSON.parse(t)}catch{}
  return {status:res.status,json:j,headers:res.headers};
}
const r0=await req('POST','/auth/register',{body:{username:'r9big'+Math.random().toString(36).slice(2,9),password:'{{SECRET_s2wbnk4v}}'}});
const o={cookie:(r0.headers?.getSetCookie?.()??[])[0].split(';')[0]};
const me=await req('GET','/auth/me',{rawCookie:o.cookie});
const csrf=me.json?.csrf_token ?? null;
console.log('csrf:',csrf?'yes':'NO');
const pv=await req('GET','/model-providers',{rawCookie:o.cookie,csrfHeader:csrf});
for(const p of (pv.json??[])){
  if((p.models??[]).includes('mock-writer')){
    const cap=(p.capabilities??[]).find(c=>c.model==='mock-writer');
    if(!cap?.tools_ok){const st=await req('POST','/model-providers/'+p.id+'/selftest',{body:{model:'mock-writer'},rawCookie:o.cookie,csrfHeader:csrf});console.log('selftest:',st.status);}
    break;
  }
}
const c=await req('POST','/agent/conversations',{body:{},rawCookie:o.cookie,csrfHeader:csrf});
console.log('conv:',c.json?.id);
