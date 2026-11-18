export const chatPage = `<!doctype html><html><head><title>Employee request</title></head><body>
<nav><a href="/">Setup</a> <a href="/policies">Policies and runs</a></nav>
<h1>Employee purchase request</h1>
<label>Name <input id="actor"></label><label>Snapshot ID <input id="snapshot"></label><button id="start">Start request</button>
<pre id="state" role="status"></pre><div id="candidates"></div>
<form id="form"><label>Message <input id="message" required></label><button>Send</button></form>
<button id="retry" hidden>Retry message</button><button id="confirm" hidden>Confirm and create PR</button>
<script>
let id,revision=0,pending;
const el=id=>document.getElementById(id);
async function request(path,body){const r=await fetch(path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});const data=await r.json();if(!r.ok)throw data;return data;}
function show(data){revision=data.revision;el('state').textContent=JSON.stringify(data.createdPr||data.summary||data.question,null,2);el('confirm').hidden=!data.ready||!!data.createdPr;el('candidates').replaceChildren();for(const item of data.candidates||[]){const b=document.createElement('button');b.textContent=item.item_code+' '+item.description+' ('+item.uom+')';b.onclick=()=>send({candidate:item.item_code});el('candidates').append(b);}}
async function send(body){pending=body;el('retry').hidden=true;try{show(await request('/api/chat/'+id,{...body,revision}));el('message').value='';}catch(e){el('state').textContent=e.error||String(e);el('retry').hidden=!e.retryable;}}
el('start').onclick=async()=>{try{const data=await request('/api/chat',{actor:el('actor').value,snapshotId:el('snapshot').value});id=data.id;show(data);}catch(e){el('state').textContent=e.error||String(e);}};
el('form').onsubmit=e=>{e.preventDefault();send({message:el('message').value});};
el('retry').onclick=()=>send(pending);
el('confirm').onclick=()=>send({confirm:true});
</script></body></html>`;
