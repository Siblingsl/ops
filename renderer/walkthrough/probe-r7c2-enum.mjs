// R7-C2：枚举完备性与错误码一致性抽查
const BASE='http://127.0.0.1:8387/api/v1';
async function req(method,path,{body,cookie,csrf}={}){
  const h={'Content-Type':'application/json'};
  if(csrf)h['X-CSRF-Token']=csrf;
  if(cookie)h['Cookie']=cookie;
  const res=await fetch(BASE+path,{method,headers:h,body:body!==undefined?JSON.stringify(body):undefined});
  const text=await res.text();let json=null;try{json=text?JSON.parse(text):null}catch{json={_raw:text.slice(0,80)}}
  return {status:res.status,json};
}
const reg=await fetch(BASE+'/auth/register',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'r7c2'+Math.random().toString(36).slice(2,9),password:'{{SECRET_s2wbnk4v}}'})});
const cookie=reg.headers.getSetCookie().map(x=>x.split(';')[0]).join('; ');
const me=await (await fetch(BASE+'/auth/me',{headers:{Cookie:cookie}})).json();
const cs=me.csrf_token;
const acc=await req('POST','/accounts',{body:{name:'枚举号',platform:'wechat_mp',content_format:'long_article'},cookie,csrf:cs}); const A=acc.json?.id;
// E1 无效枚举抽查（全部应 422 且 code=validation_failed）
const cases=[
 ['work 无效形态',`/accounts/${A}/works`,{title:'枚举作品',content_format:'bogus_format'}],
 ['topic 无效状态',null,null],
 ['material 无效 kind','/materials',{title:'x',content:'y',kind:'bogus_kind',account_id:A}],
 ['comment 无效 state',null,null],
];
let r=await req('POST',`/accounts/${A}/works`,{body:{title:'枚举作品',content_format:'bogus_format'},cookie,csrf:cs});
console.log('work bogus format:',r.status,r.json?.error?.code);
r=await req('POST','/materials',{body:{title:'x',content:'y',kind:'bogus_kind',account_id:A},cookie,csrf:cs});
console.log('material bogus kind:',r.status,r.json?.error?.code);
r=await req('POST',`/accounts/${A}/topics`,{body:{title:'枚举选题标题',status:'bogus_status'},cookie,csrf:cs});
console.log('topic create bogus status:',r.status,r.json?.error?.code);
// 422 错误码统一性检查
r=await req('POST',`/accounts/${A}/works`,{body:{title:'',content_format:'long_article'},cookie,csrf:cs});
console.log('empty title code:',r.json?.error?.code,'msg:',r.json?.error?.message?.slice(0,40));
process.exit(0);
