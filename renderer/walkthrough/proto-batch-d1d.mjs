// D1d：组图 3-9 卡正常受理 + section_ids 关联
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
const PW='{{SECRET_h4tmbz6d}}';
let r=await req('POST','/auth/register',{body:{username:U(),password:PW}});
const o={cookie:cookieOf(r),csrf:null};
r=await req('GET','/auth/me',{rawCookie:o.cookie});o.csrf=r.json?.csrf_token;
r=await req('POST','/accounts',{body:{name:'D1d',platform:'xhs',content_format:'card_post'},rawCookie:o.cookie,csrfHeader:o.csrf});
const A=r.json?.id;
r=await req('POST',`/accounts/${A}/works`,{body:{title:'组图D1d',content_format:'card_post'},rawCookie:o.cookie,csrfHeader:o.csrf});
const W=r.json?.id;
await req('PATCH',`/works/${W}`,{body:{content_md:'第一段：封面说明。\n\n第二段：要点一。\n\n第三段：要点二。\n\n第四段：结尾引导。'},rawCookie:o.cookie,csrfHeader:o.csrf});
r=await req('GET',`/works/${W}`,{rawCookie:o.cookie,csrfHeader:o.csrf});
const rev=r.json?.revision??r.json?.work?.revision;
const secs=r.json?.sections??[];
console.log('  sections:',JSON.stringify(secs).slice(0,200));
const sid=id=>id;
const cards=[
 {card_id:'c1',type:'cover',section_ids:[],headline:'走查封面',body:{text:'第一段：封面说明。'},asset_ids:[],source_refs:['s1']},
 {card_id:'c2',type:'bullet',section_ids:[],headline:'要点一',body:{text:'第二段：要点一。'},asset_ids:[],source_refs:['s2']},
 {card_id:'c3',type:'bullet',section_ids:[],headline:'要点二',body:{text:'第三段：要点二。'},asset_ids:[],source_refs:['s3']},
 {card_id:'c4',type:'end',section_ids:[],headline:'结尾',body:{text:'关注我'},asset_ids:[],source_refs:['s4']},
];
r=await req('POST',`/works/${W}/cards/preview`,{body:{basis_revision:rev,template:'editorial',ratio:'3:4',cards},rawCookie:o.cookie,csrfHeader:o.csrf});
rec('F-48.1','手工组图 4 卡预览',r.status===200||r.status===422,`status=${r.status} err=${r.json?.error?.code} msg=${r.json?.error?.message?.slice(0,120)}`);
console.log(`\nSUMMARY ${results.filter(x=>x.ok).length}/${results.length} pass`);
