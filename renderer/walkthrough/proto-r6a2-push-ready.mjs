// R6-A2：补齐格式要素（摘要/作者/封面裁剪）→ complete → ready → push → 上限
const BASE='http://127.0.0.1:8387/api/v1';
const RES={sensitive:'kept',fact:'verified',similarity:'acknowledged',ad_law:'acknowledged',ai_disclosure:'acknowledged',stale:'verified',rewrite:'acknowledged'};
function cookieOf(r){const c=(r.sc??[])[0];return c?c.split(";")[0]:null;}
async function req(method,path,{body,rawCookie,csrfHeader}={}){
  const h={'Content-Type':'application/json'};
  if(csrfHeader)h['X-CSRF-Token']=csrfHeader; if(rawCookie)h['Cookie']=rawCookie;
  const res=await fetch(BASE+path,{method,headers:h,body:body!==undefined?JSON.stringify(body):undefined});
  const sc=res.headers.getSetCookie?.()??[];
  const text=await res.text();let json=null;try{json=text?JSON.parse(text):null}catch{json={_raw:text.slice(0,100)}}
  return {status:res.status,json,sc};
}
let r=await req('POST','/auth/register',{body:{username:'r6a2'+Math.random().toString(36).slice(2,9),password:'{{SECRET_s2wbnk4v}}'}});
const o={cookie:cookieOf(r),csrf:null};
r=await req('GET','/auth/me',{rawCookie:o.cookie});o.csrf=r.json?.csrf_token;
r=await req('POST','/accounts',{body:{name:'R6A2号',platform:'wechat_mp',content_format:'long_article'},rawCookie:o.cookie,csrfHeader:o.csrf});
const A=r.json?.id;
await req('PUT',`/accounts/${A}/wechat-credential`,{body:{app_id:'wx_r6a2',app_secret:'{{SECRET_s2wbnk4v}}'},rawCookie:o.cookie,csrfHeader:o.csrf});
await req('POST',`/accounts/${A}/wechat-credential/test`,{body:{},rawCookie:o.cookie,csrfHeader:o.csrf});
r=await req('POST',`/accounts/${A}/works`,{body:{title:'R6A2推送作品标题七个字',content_format:'long_article',viewpoint:'推送链路观点',summary:'这是摘要内容，控制在 120 字以内，供微信抓取。',wechat_fields:{author:'走查作者',source_url:''}},rawCookie:o.cookie,csrfHeader:o.csrf});
const W=r.json?.id;
await req('PATCH',`/works/${W}`,{body:{viewpoint:'推送链路走查观点：先补事实再下结论'},rawCookie:o.cookie,csrfHeader:o.csrf});
await req('PATCH',`/works/${W}`,{body:{content_md:'# 推送走查\n\n第一节：事实与验证方式，结论保持谨慎。\n\n## 第二节\n\n第二节内容完整。'},rawCookie:o.cookie,csrfHeader:o.csrf});
r=await req('PUT',`/works/${W}/outline`,{body:{items:[{heading:'第一节',summary:'事实'},{heading:'第二节',summary:'验证'}],confirm:true},rawCookie:o.cookie,csrfHeader:o.csrf});
console.log('outline-confirm:',r.status,'sectionsInResp:',(r.json?.sections??[]).length, JSON.stringify(r.json).slice(0,150));
await new Promise(res=>setTimeout(res,900));
r=await req('GET',`/works/${W}`,{rawCookie:o.cookie,csrfHeader:o.csrf});
for(const s of (r.json?.sections??[])){ const pr=await req('PATCH',`/sections/${s.id}`,{body:{content_md:'第一节记录可核对的事实并说明验证方式，结论保持谨慎，不夸大。',base_revision:s.revision},rawCookie:o.cookie,csrfHeader:o.csrf}); console.log('section-patch:',pr.status,s.id.slice(0,8),pr.json?.error?.message?.slice(0,60)??''); }
// 封面上传与裁剪
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==','base64');
const coverForm=new FormData(); coverForm.append('file',new File([png],'cover.png',{type:'image/png'}));
const coverRes=await fetch(BASE+`/works/${W}/assets`,{method:'POST',headers:{'X-CSRF-Token':o.csrf,Cookie:o.cookie},body:coverForm});
const coverJ=await coverRes.json();
console.log('cover-asset:',coverRes.status,coverJ?.id?.slice(0,8));
const wNow=await req('GET',`/works/${W}`,{rawCookie:o.cookie,csrfHeader:o.csrf});
if(coverJ?.id){ const cp=await req('PATCH',`/works/${W}`,{body:{cover_asset_id:coverJ.id,cover_crops:{'2.35_1':{x1:0,y1:0,x2:1,y2:0.425},'1_1':{x1:0,y1:0,x2:1,y2:1}},base_revision:wNow.json?.revision},rawCookie:o.cookie,csrfHeader:o.csrf}); console.log('cover-patch:',cp.status,cp.json?.error?.message?.slice(0,60)??'ok'); }
await req('POST',`/works/${W}/checks`,{body:{},rawCookie:o.cookie,csrfHeader:o.csrf});
let run=null;
for(let i=0;i<25;i++){
  await new Promise(res=>setTimeout(res,1000));
  const c=await req('GET',`/works/${W}/checks/latest`,{rawCookie:o.cookie,csrfHeader:o.csrf});
  run=c.json?.run;
  if(run&&run.fact_status!=='pending')break;
}
// 处理非 format 项
for(const item of run?.items??[]){
  if(item.category!=='format'&&!item.resolution){
    await req('PATCH',`/check-items/${item.id}`,{body:{resolution:RES[item.category]??'acknowledged'},rawCookie:o.cookie,csrfHeader:o.csrf}).catch(()=>{});
  }
}
const fmtUnresolved=(run?.items??[]).filter(i=>i.category==='format'&&!i.passed).map(i=>i.field??i.message.slice(0,14));
console.log('format unresolved:',fmtUnresolved.join(',')||'none');
r=await req('POST',`/works/${W}/checks/complete`,{body:{},rawCookie:o.cookie,csrfHeader:o.csrf});
console.log('complete:',r.status,r.json?.error?.message?.slice(0,60)??'ok');
// Q-14 参照：若 complete 因封面项被拒且封面 PATCH 已发，需**再次发起检查**（格式项是发起时快照）
if(r.status===409&&/格式/.test(r.json?.error?.message??'')){
  const re=await req('POST',`/works/${W}/checks`,{body:{},rawCookie:o.cookie,csrfHeader:o.csrf});
  for(let i=0;i<25;i++){
    await new Promise(res=>setTimeout(res,1000));
    const c=await req('GET',`/works/${W}/checks/latest`,{rawCookie:o.cookie,csrfHeader:o.csrf});
    run=c.json?.run;
    if(run&&run.fact_status!=='pending')break;
  }
  for(const item of run?.items??[]){
    if(item.category!=='format'&&!item.resolution){
      await req('PATCH',`/check-items/${item.id}`,{body:{resolution:RES[item.category]??'acknowledged'},rawCookie:o.cookie,csrfHeader:o.csrf}).catch(()=>{});
    }
  }
  r=await req('POST',`/works/${W}/checks/complete`,{body:{},rawCookie:o.cookie,csrfHeader:o.csrf});
  console.log('complete-2:',r.status,r.json?.error?.message?.slice(0,60)??'ok');
}
r=await req('GET',`/works/${W}`,{rawCookie:o.cookie,csrfHeader:o.csrf});
console.log('status:',r.json?.status);
if(r.json?.status==='ready'){
  r=await req('POST',`/works/${W}/wechat/push`,{body:{},rawCookie:o.cookie,csrfHeader:o.csrf});
  console.log('push1:',r.status,JSON.stringify(r.json).slice(0,160));
  if(r.status===200){
    const p2=await req('POST',`/works/${W}/wechat/push`,{body:{},rawCookie:o.cookie,csrfHeader:o.csrf});
    const p3=await req('POST',`/works/${W}/wechat/push`,{body:{},rawCookie:o.cookie,csrfHeader:ocsrf??o.csrf});
    const p4=await req('POST',`/works/${W}/wechat/push`,{body:{},rawCookie:o.cookie,csrfHeader:o.csrf});
    console.log(`daily-limit: p2=${p2.status} p3=${p3.status} p4=${p4.status} ${p4.json?.error?.message?.slice(0,60)??''}`);
  }
}
process.exit(0);
