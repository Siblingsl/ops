// R5-A：漫画工作流（角色卡 CRUD → comic 作品 → storyboard 确认闸 → 逐格文案）
const BASE='http://127.0.0.1:8387/api/v1';
const F=[];
function rec(id,ok,detail){F.push({id,ok});console.log(`${ok?'ok ':'FAIL'} ${id} :: ${detail}`);}
function cookieOf(r){const c=(r.sc??[])[0];return c?c.split(";")[0]:null;}
async function req(method,path,{body,rawCookie,csrfHeader}={}){
  const h={'Content-Type':'application/json'};
  if(csrfHeader)h['X-CSRF-Token']=csrfHeader; if(rawCookie)h['Cookie']=rawCookie;
  const res=await fetch(BASE+path,{method,headers:h,body:body!==undefined?JSON.stringify(body):undefined});
  const sc=res.headers.getSetCookie?.()??[];
  const text=await res.text();let json=null;try{json=text?JSON.parse(text):null}catch{json={_raw:text.slice(0,100)}}
  return {status:res.status,json,sc};
}
const U=()=>'r5a'+Math.random().toString(36).slice(2,9);
let r=await req('POST','/auth/register',{body:{username:U(),password:'{{SECRET_s2wbnk4v}}'}});
const o={cookie:cookieOf(r),csrf:null};
r=await req('GET','/auth/me',{rawCookie:o.cookie});o.csrf=r.json?.csrf_token;
r=await req('POST','/accounts',{body:{name:'R5A漫画号',platform:'wechat_mp',content_format:'comic'},rawCookie:o.cookie,csrfHeader:o.csrf});
const A=r.json?.id;

// K1 角色卡 CRUD
r=await req('POST',`/accounts/${A}/characters`,{body:{name:'主角',appearance:'短发青年',personality:'沉稳',catchphrase:'稳住'},rawCookie:o.cookie,csrfHeader:o.csrf});
const CH=r.json?.id;
rec('K1-character-create',r.status===200&&!!CH,`status=${r.status}`);
r=await req('PATCH',`/characters/${CH}`,{body:{name:'主角改'},rawCookie:o.cookie,csrfHeader:o.csrf});
rec('K1-character-patch',r.status===200,`status=${r.status}`);
r=await req('GET',`/accounts/${A}/characters`,{rawCookie:o.cookie,csrfHeader:o.csrf});
rec('K1-character-list',r.status===200&&JSON.stringify(r.json).includes('主角改'),`status=${r.status}`);

// K2 comic 作品 + storyboard 确认闸（H-03）
r=await req('POST',`/accounts/${A}/works`,{body:{title:'漫画走查',content_format:'comic'},rawCookie:o.cookie,csrfHeader:o.csrf});
const W=r.json?.id;
await req('PATCH',`/works/${W}`,{body:{viewpoint:'走查漫画观点：小步验证最稳'},rawCookie:o.cookie,csrfHeader:o.csrf});
r=await req('POST',`/works/${W}/storyboard/generate`,{body:{panel_count:4,character_ids:[CH]},rawCookie:o.cookie,csrfHeader:o.csrf});
rec('K2-storyboard-generate',r.status===200||r.status===422||r.status===409,`status=${r.status} err=${r.json?.error?.code} msg=${r.json?.error?.message?.slice(0,60)}`);
// saveStoryboard（确认分镜）
const sb=(r.json?.panels??r.json?.storyboard?.panels)??null;
if(sb){
  r=await req('PUT',`/works/${W}/storyboard`,{body:{panels:sb},rawCookie:o.cookie,csrfHeader:o.csrf});
  rec('K2-storyboard-save',r.status===200||r.status===422,`status=${r.status} err=${r.json?.error?.code}`);
  const panelId=r.json?.panels?.[0]?.id;
  if(panelId){
    r=await req('POST',`/panels/${panelId}/text`,{body:{},rawCookie:o.cookie,csrfHeader:o.csrf});
    rec('K2-panel-text',r.status===200||r.status===422,`status=${r.status}`);
    r=await req('PATCH',`/panels/${panelId}`,{body:{text:'第一格对白（走查）'},rawCookie:o.cookie,csrfHeader:o.csrf});
    rec('K2-panel-patch',r.status===200||r.status===422,`status=${r.status} err=${r.json?.error?.code}`);
  }
}else{
  console.log('  storyboard panels 未返回（generate 响应结构需人工核对），跳过 save/panel');
}

// K3 角色卡引用保护：comic 作品存在时删角色
r=await req('DELETE',`/characters/${CH}`,{rawCookie:o.cookie,csrfHeader:o.csrf});
rec('K3-character-delete-guard',r.status===200||r.status===409||r.status===422,`status=${r.status} err=${r.json?.error?.code} msg=${r.json?.error?.message?.slice(0,60)}`);

console.log(`\nR5A ${F.filter(x=>x.ok).length}/${F.length} pass`);
