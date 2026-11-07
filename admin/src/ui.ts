export function renderPage(nonce: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Enshrouded Admin</title>
<style nonce="${nonce}">
:root{--bg:#fff;--fg:#1a1a1a;--muted:#666;--card:#f4f4f5;--line:#e0e0e3;--accent:#2f6f4f;--bad:#b3261e}
@media (prefers-color-scheme:dark){:root{--bg:#141416;--fg:#ececec;--muted:#9a9aa0;--card:#1e1e21;--line:#323236;--accent:#5fb98a;--bad:#f2867e}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,sans-serif}
main{max-width:30rem;margin:0 auto;padding:2rem 1rem}h1{font-size:1.4rem;margin:0 0 1.25rem}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:1rem;margin-bottom:1rem}
.row{display:flex;justify-content:space-between;gap:1rem;padding:.35rem 0}.muted{color:var(--muted)}
button,a.btn{font:inherit;padding:.6rem 1rem;border-radius:8px;border:1px solid var(--line);background:var(--bg);color:var(--fg);cursor:pointer;text-decoration:none;display:inline-block}
button.primary,a.btn.primary{background:var(--accent);border-color:var(--accent);color:#fff}
button:disabled{opacity:.5;cursor:default}.err{color:var(--bad)}code{word-break:break-all}
</style></head><body><main>
<h1>Enshrouded server</h1>
<div id="app" class="card muted">Loading…</div>
<script nonce="${nonce}">
const app=document.getElementById('app');
const hdr={'x-requested-with':'enshrouded-admin'};
let timer;
function el(tag,props,...kids){const e=document.createElement(tag);Object.assign(e,props||{});for(const k of kids)e.append(k);return e}
function row(k,v){return el('div',{className:'row'},el('span',{className:'muted'},k),el('span',{},v))}
async function api(path,method){const r=await fetch(path,{method:method||'GET',headers:hdr,credentials:'same-origin'});
  const body=await r.json().catch(()=>({}));return{ok:r.ok,status:r.status,body}}
function signedOut(){app.replaceChildren(el('p',{},'Sign in to manage the server.'),el('a',{className:'btn primary',href:'/api/auth/github'},'Sign in with GitHub'))}
async function act(path){app.querySelectorAll('button').forEach(b=>b.disabled=true);await api(path,'POST');await render()}
async function reveal(btn,out){const r=await api('/api/password');if(r.ok){out.textContent=r.body.password;btn.remove()}}
async function render(){
  clearTimeout(timer);
  const s=await api('/api/status');
  if(s.status===401)return signedOut();
  if(!s.ok){app.replaceChildren(el('p',{className:'err'},'Could not load status.'));return}
  const st=s.body.state;
  const pw=el('code',{},'••••••••');
  const showBtn=el('button',{},'Show');showBtn.onclick=()=>reveal(showBtn,pw);
  const actions=el('div',{className:'row'});
  if(st==='stopped'){const b=el('button',{className:'primary'},'Start server');b.onclick=()=>act('/api/start');actions.append(b)}
  else if(st==='running'){const b=el('button',{},'Stop server');b.onclick=()=>act('/api/stop');actions.append(b)}
  else actions.append(el('span',{className:'muted'},'Working…'));
  const out=app.replaceChildren(row('State',st),row('Address',s.body.address),row('Password',el('span',{},pw,' ',showBtn)),actions,
    el('p',{className:'muted'},'Starting takes a few minutes. The server stops itself after about 30 idle minutes.'),
    el('button',{onclick:async()=>{await api('/api/auth/logout','POST');signedOut()}},'Sign out'));
  if(st==='pending'||st==='stopping')timer=setTimeout(render,5000);
}
render();
</script></main></body></html>`;
}
