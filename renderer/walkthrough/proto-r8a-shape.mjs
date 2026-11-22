// R8-C：API 响应形状一致性（跨端点：空数组 vs null、分页形状、字段命名风格）
const BASE='http://127.0.0.1:8387/api/v1';
const F=[];
function rec(id,ok,detail){F.push({id,ok});console.log(`${ok?'ok ':'FAIL'} ${id} :: ${detail}`);}
async function req(method,path,{body,cookie,csrf}={}){
  const h={'Content-Type':'application/json'};
  if(csrf)h['X-CSRF-Token']=csrf;
  if(cookie)h['Cookie']=cookie;
  const res=await fetch(BASE+path,{method,headers:h,body:body!==undefined?JSON.stringify(body):undefined});
  const text=await res.text();let json=null;try{json=text?JSON.parse(text):null}catch{json={_raw:text.slice(0,80)}}
  return {status:res.status,json};
}
const reg=await fetch(BASE+'/auth/register',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'r8a'+Math.random().toString(36).slice(2,9),password:'{{SECRET_s2wbnk4v}}'})});
const cookie=reg.headers.getSetCookie().map(x=>x.split(';')[0]).join('; ');
const me=await (await fetch(BASE+'/auth/me',{headers:{Cookie:cookie}})).json();
const cs=me.csrf_token;
const acc=await req('POST','/accounts',{body:{name:'R8A形状号',platform:'wechat_mp',content_format:'long_article'},cookie,csrf:cs}); const A=acc.json?.id;
const wr=await req('POST',`/accounts/${A}/works`,{body:{title:'R8A形状作品（六字以上）',content_format:'long_article'},cookie,csrf:cs}); const W=wr.json?.id;

// 空集合形态抽查：新号各列表应返回 [] 而非 null
const checks=[
 ['topics',`/accounts/${A}/topics`],
 ['materials',`/materials?account_id=${A}`],
 ['style-samples',`/accounts/${A}/style-samples`],
 ['characters',`/accounts/${A}/characters`],
 ['followers',`/accounts/${A}/followers`],
 ['comments',`/accounts/${A}/comments`],
 ['builds',`/works/${W}/builds`],
 ['sections',null],
];
for(const [name,path] of checks){
  if(!path)continue;
  const r=await req('GET',path,{cookie,csrf:cs});
  const j=r.json;
  const arr=Array.isArray(j)?j:(j?.items??j?.data);
  const kind=Array.isArray(arr)?'array':(arr===undefined||arr===null)?typeof j==='object'&&j!==null?'object-shape':'null':'primitive';
  console.log(`${name}: status=${r.status} shape=${kind}${kind==='array'?' n='+arr.length:''}`);
  if(kind==='null')rec('null-shape-'+name,false,`返回 null 而非 []`);
}
// work 详情内嵌空数组
const w=await req('GET',`/works/${W}`,{cookie,csrf:cs});
for(const k of ['sections','tags','topics']){
  const v=w.json?.[k];
  console.log(`work.${k}: ${Array.isArray(v)?'array(n='+v.length+')':typeof v}`);
  if(v===null)rec('null-embed-'+k,false,'work 内嵌字段为 null');
}
let r=null;
// 分页形状抽查（有分页的端点）
r=await req('GET','/admin/audit-logs?limit=5',{cookie,csrf:cs});
console.log('audit-logs shape:',r.status,Object.keys(r.json??{}).slice(0,5));
process.exit(0);
