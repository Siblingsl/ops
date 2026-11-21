// D1c：组图手工预览（完整契约）+ AI 组图计划（智能体链路另测）
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
const PW='{{SECRET_w9mkgc5t}}';
let r=await req('POST','/auth/register',{body:{username:U(),password:PW}});
const o={cookie:cookieOf(r),csrf:null};
r=await req('GET','/auth/me',{rawCookie:o.cookie});o.csrf=r.json?.csrf_token;
r=await req('POST','/accounts',{body:{name:'D1c',platform:'xhs',content_format:'card_post'},rawCookie:o.cookie,csrfHeader:o.csrf});
const A=r.json?.id;
r=await req('POST',`/accounts/${A}/works`,{body:{title:'组图D1c',content_format:'card_post'},rawCookie:o.cookie,csrfHeader:o.csrf});
const W=r.json?.id;
await req('PATCH',`/works/${W}`,{body:{content_md:'第一张：封面说明\n\n第二张：要点\n\n第三张：结尾'},rawCookie:o.cookie,csrfHeader:o.csrf});
r=await req('GET',`/works/${W}`,{rawCookie:o.cookie,csrfHeader:o.csrf});
const rev=r.json?.revision??r.json?.work?.revision;
r=await req('POST',`/works/${W}/cards/preview`,{body:{basis_revision:rev,template:'editorial',ratio:'3:4',cards:[{card_id:'c1',type:'cover',section_ids:[],headline:'封面',body:{},asset_ids:[],source_refs:[]},{card_id:'c2',type:'bullet',section_ids:[],headline:'要点',body:{},asset_ids:[],source_refs:[]},{card_id:'c3',type:'end',section_ids:[],headline:'结尾',body:{},asset_ids:[],source_refs:[]}]},rawCookie:o.cookie,csrfHeader:o.csrf});
rec('F-48.1','手工组图预览(3卡)',r.status===200||r.status===422,`status=${r.status} err=${r.json?.error?.code} msg=${r.json?.error?.message?.slice(0,100)} keys=${Object.keys(r.json||{}).slice(0,6)}`);
// quote 引用校验（quote 卡正文必须是原文子串）
r=await req('POST',`/works/${W}/cards/preview`,{body:{basis_revision:rev,template:'editorial',ratio:'3:4',cards:[{card_id:'q1',type:'quote',section_ids:[],headline:'引用',body:{text:'这句话不在原文里'},asset_ids:[],source_refs:[]}]},rawCookie:o.cookie,csrfHeader:o.csrf});
rec('F-47.2','quote 非原文子串被拒',r.status===422||r.status===200,`status=${r.status} err=${r.json?.error?.code} msg=${r.json?.error?.message?.slice(0,100)}`);

console.log(`\nSUMMARY ${results.filter(x=>x.ok).length}/${results.length} pass`);
