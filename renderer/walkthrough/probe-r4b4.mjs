// 游标语义完整：seq 重放 + 410 过期路径（模拟 floor）+ 他人会话
const BASE='http://127.0.0.1:8387/api/v1';
const reg=await fetch(BASE+'/auth/register',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'r4b4'+Math.random().toString(36).slice(2,9),password:'{{SECRET_s2wbnk4v}}'})});
const cookie=reg.headers.getSetCookie().map(s=>s.split(';')[0]).join('; ');
const me=await (await fetch(BASE+'/auth/me',{headers:{Cookie:cookie}})).json();
const csrf=me.csrf_token;
const cr=await fetch(BASE+'/agent/conversations',{method:'POST',headers:{'Content-Type':'application/json','Cookie':cookie,'X-CSRF-Token':csrf},body:JSON.stringify({title:'b4游标'})});
const C=(await cr.json()).id;
// 读初始事件拿 lastSeq
const sse1=await fetch(BASE+`/agent/conversations/${C}/events`,{headers:{Cookie:cookie}});
let buf='';const reader=sse1.body.getReader();const dec=new TextDecoder();const t0=Date.now();
while(Date.now()-t0<1200){const {done,value}=await reader.read();if(done)break;buf+=dec.decode(value);}
try{await reader.cancel()}catch{}
const seqs=[...buf.matchAll(/id:\s*(\d+)/g)].map(m=>Number(m[1]));
const last=seqs.at(-1)??0;
console.log('initial seqs:',seqs.slice(0,5),'last=',last);
// after=last → 只收新事件（阻塞中 1.2s 内应无新事件）
const sse2=await fetch(BASE+`/agent/conversations/${C}/events?after_event_seq=${last}`,{headers:{Cookie:cookie}});
let buf2='';const reader2=sse2.body.getReader();const t2=Date.now();
while(Date.now()-t2<1200){const {done,value}=await reader2.read();if(done)break;buf2+=dec.decode(value);}
try{await reader2.cancel()}catch{}
const seqs2=[...buf2.matchAll(/id:\s*(\d+)/g)].map(m=>Number(m[1]));
console.log(`after=${last}: replayed=${seqs2.length===0?'none':'YES-BUG'}`);
// after=0 → 全量重放
const sse3=await fetch(BASE+`/agent/conversations/${C}/events?after_event_seq=0`,{headers:{Cookie:cookie}});
let buf3='';const reader3=sse3.body.getReader();const t3=Date.now();
while(Date.now()-t3<1200){const {done,value}=await reader3.read();if(done)break;buf3+=dec.decode(value);}
try{await reader3.cancel()}catch{}
const seqs3=[...buf3.matchAll(/id:\s*(\d+)/g)].map(m=>Number(m[1]));
console.log(`after=0: replayed=${seqs3.length} (>=initial ${seqs.length})`);
// 他人会话
const reg2=await fetch(BASE+'/auth/register',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'r4b4x'+Math.random().toString(36).slice(2,9),password:'{{SECRET_s2wbnk4v}}'})});
const cookie2=reg2.headers.getSetCookie().map(s=>s.split(';')[0]).join('; ');
const r2=await fetch(BASE+`/agent/conversations/${C}/events`,{headers:{Cookie:cookie2}});
console.log('other-user:',r2.status);
process.exit(0);
