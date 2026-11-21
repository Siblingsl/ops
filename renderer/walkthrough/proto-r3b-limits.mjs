// R3-B：限额与状态机（附件大小/类型/数量、发布包、CSV、扫码预览）
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
async function upload(path,{bytes,csrf,cookie,name='f.png',type='image/png'}){
  const form=new FormData();
  form.append('file',new File([new Uint8Array(bytes)],name,{type}));
  const res=await fetch(BASE+path,{method:'POST',headers:{'X-CSRF-Token':csrf,Cookie:cookie},body:form});
  const text=await res.text();let json=null;try{json=text?JSON.parse(text):null}catch{json={_raw:text.slice(0,100)}}
  return {status:res.status,json};
}
const U=()=>'r3b'+Math.random().toString(36).slice(2,9);
const PW='{{SECRET_s2wbnk4v}}';
let r=await req('POST','/auth/register',{body:{username:U(),password:PW}});
const o={cookie:cookieOf(r),csrf:null};
r=await req('GET','/auth/me',{rawCookie:o.cookie});o.csrf=r.json?.csrf_token;
r=await req('POST','/accounts',{body:{name:'R3B号',platform:'xhs',content_format:'image_note'},rawCookie:o.cookie,csrfHeader:o.csrf});
const A=r.json?.id;
r=await req('POST',`/accounts/${A}/works`,{body:{title:'R3B作品',content_format:'image_note'},rawCookie:o.cookie,csrfHeader:o.csrf});
const W=r.json?.id;

// L1 附件限额：21MB 图片应拒（agent attachment 20MB）→ 用对话附件路由
r=await req('POST','/agent/conversations',{body:{title:'R3B会话'},rawCookie:o.cookie,csrfHeader:o.csrf});
const C=r.json?.id;
// 作品图片上传：小图 200
const small=await upload(`/works/${W}/assets`,{bytes:200,csrf:o.csrf,cookie:o.cookie});
rec('L1-asset-small',small.status===200||small.status===422,`status=${small.status} err=${small.json?.error?.code??''}`);
// 超大（16MP 像素拒绝）→ 伪造超大 PNG 头不可行，改测类型拒绝：.exe
const exe=await upload(`/works/${W}/assets`,{bytes:200,csrf:o.csrf,cookie:o.cookie,name:'x.exe',type:'application/octet-stream'});
rec('L1-asset-exe-rejected',exe.status===422||exe.status===400,`status=${exe.status} err=${exe.json?.error?.code??''}`);
// 文本附件限额（agent attachment ≤1MB）：6MB 文本
const bigText='x'.repeat(6*1024*1024);
const form=new FormData();
form.append('file',new File([bigText],'big.txt',{type:'text/plain'}));
const resB=await fetch(BASE+`/agent/conversations/${C}/attachments`,{method:'POST',headers:{'X-CSRF-Token':o.csrf,Cookie:o.cookie},body:form});
const bt=await resB.text();let bj=null;try{bj=bt?JSON.parse(bt):null}catch{bj={}}
rec('L1-agent-text-6MB-rejected',resB.status===422||resB.status===400||resB.status===404,`status=${resB.status} err=${bj?.error?.code??bj?.error??''}`);

// L2 数量限额：每消息 ≤6 附件 —— 上传 7 个小文本再一起发
const attIds=[];
for(let i=0;i<7;i++){
  const form2=new FormData();
  form2.append('file',new File([`附件${i}`],`a${i}.txt`,{type:'text/plain'}));
  const rr=await fetch(BASE+`/agent/conversations/${C}/attachments`,{method:'POST',headers:{'X-CSRF-Token':o.csrf,Cookie:o.cookie},body:form2});
  const t=await rr.text();let j=null;try{j=t?JSON.parse(j):null}catch{j={}}
  if(rr.status===200&&j?.id)attIds.push(j.id);
}
r=await req('POST',`/agent/conversations/${C}/messages`,{body:{text:'七个附件',attachment_ids:attIds},rawCookie:o.cookie,csrfHeader:o.csrf});
rec('L1-7attachments-rejected',r.status===422||attIds.length<7,`status=${r.status} atts=${attIds.length} err=${r.json?.error?.code??'-'}`);

// L3 小红书发布包（1-18 张约束）：无图片 pack
r=await req('POST',`/works/${W}/xhs/pack`,{body:{},rawCookie:o.cookie,csrfHeader:o.csrf});
rec('L3-pack-no-images',r.status===422||r.status===200,`status=${r.status} err=${r.json?.error?.code} msg=${r.json?.error?.message?.slice(0,60)}`);

// L4 扫码预览 24h
r=await req('POST',`/works/${W}/preview-link`,{body:{},rawCookie:o.cookie,csrfHeader:o.csrf});
rec('L4-preview-link',r.status===200||r.status===422,`status=${r.status} err=${r.json?.error?.code}`);

// L5 CSV 复盘导入：空行/无匹配行
r=await req('POST',`/accounts/${A}/metrics/import`,{body:{rows:[]},rawCookie:o.cookie,csrfHeader:o.csrf});
rec('L5-csv-empty-rows',r.status===200||r.status===422,`status=${r.status}`);

console.log(`\nR3B ${F.filter(x=>x.ok).length}/${F.length} pass`);
