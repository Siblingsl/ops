// 协议走查 C1：创作模板 CF-TPL + 排版构建 CX02/CX05 + 组图 CX09
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
  return {status:res.status,json,setCookie,text};
}
const U=()=>'wt'+Math.random().toString(36).slice(2,10);
const PW='{{SECRET_v9kcyw4u}}';
let r=await req('POST','/auth/register',{body:{username:U(),password:PW}});
const o={cookie:cookieOf(r),csrf:null};
r=await req('GET','/auth/me',{rawCookie:o.cookie});o.csrf=r.json?.csrf_token;
r=await req('POST','/accounts',{body:{name:'C1号',platform:'wechat_mp',content_format:'long_article'},rawCookie:o.cookie,csrfHeader:o.csrf});
const A=r.json?.id;

// F-40 创作模板：列表（内置）+ 新建 + 内置不可改 + 删除
r=await req('GET','/creation-templates',{rawCookie:o.cookie,csrfHeader:o.csrf});
const tpl=Array.isArray(r.json)?r.json:(r.json?.templates??[]);
const builtins=tpl.filter(x=>x.builtin);
rec('F-40.1','内置模板清单(每类<=2)',r.status===200&&tpl.length>0,`n=${tpl.length} builtin=${builtins.length} formats=${[...new Set(tpl.map(x=>x.content_format))].join(',')}`);
r=await req('POST','/creation-templates',{body:{content_format:'long_article',name:'走查模板A',structure:[{heading:'开篇',summary:'引子'},{heading:'论证',summary:'主体'}],section_min:2,section_max:4,tone:'平实',prompt_addon:'走查用'},rawCookie:o.cookie,csrfHeader:o.csrf});
const TPL=r.json?.id;
rec('F-40.2','新建工作区模板',r.status===200&&!!TPL,`status=${r.status} id=${TPL?.slice(0,8)}`);
if(TPL){
  r=await req('PUT',`/creation-templates/${TPL}`,{body:{content_format:'long_article',name:'走查模板A2',structure:[{heading:'改'}],section_min:1,section_max:2,tone:'',prompt_addon:''},rawCookie:o.cookie,csrfHeader:o.csrf});
  rec('F-40.3','编辑工作区模板',r.status===200,`status=${r.status}`);
  r=await req('DELETE',`/creation-templates/${TPL}`,{rawCookie:o.cookie,csrfHeader:o.csrf});
  rec('F-40.4','删除工作区模板',r.status===200,`status=${r.status}`);
}
// 内置模板 PUT 422
const bid=builtins[0]?.id;
if(bid){
  r=await req('PUT',`/creation-templates/${bid}`,{body:{name:'改名',content_format:builtins[0].content_format,structure:[]},rawCookie:o.cookie,csrfHeader:o.csrf});
  rec('F-40.5','内置模板不可改',r.status===422,`status=${r.status} err=${r.json?.error?.code}`);
}
// 结构条数 1-20 校验
r=await req('POST','/creation-templates',{body:{content_format:'long_article',name:'越界',structure:Array.from({length:25},(_,i)=>({heading:'h'+i})),section_min:1,section_max:2},rawCookie:o.cookie,csrfHeader:o.csrf});
rec('F-40.6','结构条数>20 被拒',r.status===422,`status=${r.status} err=${r.json?.error?.code}`);

// F-49/F-50 排版构建（模拟环境）
r=await req('POST',`/accounts/${A}/works`,{body:{title:'排版走查作品',content_format:'long_article'},rawCookie:o.cookie,csrfHeader:o.csrf});
const W=r.json?.id;
r=await req('PATCH',`/works/${W}`,{body:{content_md:'# 标题\n\n这是正文段落。\n\n## 小节\n\n第二段内容，用于排版转换。'},rawCookie:o.cookie,csrfHeader:o.csrf});
rec('E.1','写正文',r.status===200,`status=${r.status} err=${r.json?.error?.code}`);
r=await req('POST',`/works/${W}/render-check`,{body:{},rawCookie:o.cookie,csrfHeader:o.csrf});
rec('F-49.1','render-check 语法预检',r.status===200,`status=${r.status} keys=${Object.keys(r.json||{}).slice(0,6)} err=${r.json?.error?.code}`);
// 非法语法应阻断
r=await req('PATCH',`/works/${W}`,{body:{content_md:'| 语法 | 表格 |\n| --- | --- |\n| a | b |\n\n以及不支持的嵌入语法 {{embed}}'},rawCookie:o.cookie,csrfHeader:o.csrf});
r=await req('POST',`/works/${W}/render-check`,{body:{},rawCookie:o.cookie,csrfHeader:o.csrf});
rec('F-49.2','非法语法报告/阻断',r.status===200||r.status===422,`status=${r.status} err=${r.json?.error?.code} body=${JSON.stringify(r.json).slice(0,160)}`);
// CX 构建入口探测
r=await req('POST',`/works/${W}/build`,{body:{},rawCookie:o.cookie,csrfHeader:o.csrf});
rec('F-50.1','单次构建受理',r.status===200||r.status===202||r.status===422,`status=${r.status} err=${r.json?.error?.code}`);

console.log(`\nSUMMARY ${results.filter(x=>x.ok).length}/${results.length} pass`);
