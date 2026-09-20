import http from "node:http";
import { pathToFileURL } from "node:url";
export async function startTaskFixture(port = 0) {
  const records = [];
  const events = [];
  let sequence = 0;
  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>ProfilePilot 任务验收站</title><style>body{max-width:800px;margin:40px auto;font:16px/1.8 sans-serif;background:#f6f4ec;color:#182820}input,select,button{font:inherit;padding:10px;margin:8px}label{display:block}nav a{margin-right:20px}.card{background:white;padding:30px;border:1px solid #ddd;border-radius:12px}</style></head><body>
  <h1>浏览器任务验收站</h1><p>当前账号：test@example.test</p><nav><a href="/apply">招聘申请</a><a href="/admin">后台录入</a><a href="/shop">购物表单</a><a href="/records">提交记录</a><a href="/report.csv" download>下载报表</a></nav><div id="content" class="card"></div>
  <script>
  const logEvent=value=>fetch('/api/events',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(value)}).catch(()=>{});
  window.addEventListener('error',event=>logEvent({type:'error',message:event.message}));
  document.addEventListener('invalid',event=>logEvent({type:'invalid',field:event.target.name,message:event.target.validationMessage}),true);
  document.addEventListener('click',event=>{if(event.target.tagName==='BUTTON')logEvent({type:'click',text:event.target.textContent})},true);
  const area=document.getElementById('content');
  async function records(){const r=await fetch('/api/records').then(r=>r.json());area.innerHTML='<h2>提交记录</h2>'+r.map(x=>'<p>编号 '+x.id+' · '+x.kind+' · '+x.name+' · '+x.email+'</p>').join('')||'暂无记录';}
  if(location.pathname==='/records')records();else{
    const kind=location.pathname==='/shop'?'购物':location.pathname==='/admin'?'商品录入':'招聘申请';
    area.innerHTML='<h2>'+kind+'</h2><form id="form"><label>姓名 / 商品名称<input name="name" required></label><label>邮箱<input name="email" type="email" required></label><label>城市<select name="city"><option value="">请选择</option><option>上海</option><option>北京</option></select></label><label>附件<input name="file" type="file"></label><label><input type="checkbox" name="agree" required>确认资料正确</label><button type="button" id="dynamic">展开额外信息</button><div id="extra"></div><button type="submit">'+(kind==='购物'?'提交订单':'提交申请')+'</button><label><input type="checkbox" name="disconnect">模拟提交后连接中断</label></form><p id="result" role="status"></p>';
    document.getElementById('dynamic').onclick=()=>document.getElementById('extra').innerHTML='<label>补充说明<input name="notes"></label>';
    document.getElementById('form').onsubmit=async e=>{e.preventDefault();const f=new FormData(e.target);const body={kind,name:f.get('name'),email:f.get('email'),city:f.get('city'),notes:f.get('notes'),file:f.get('file')?.name,disconnect:f.has('disconnect')};try{const r=await fetch('/api/submit',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}).then(r=>r.json());document.getElementById('result').textContent='提交成功，编号 '+r.id;}catch{document.getElementById('result').textContent='连接中断，请检查提交记录，不要重复提交。';}};
  }
  </script></body></html>`;
  const server = http.createServer(async (req, res) => {
    if (req.url === "/api/events") { let text = ""; for await (const chunk of req) text += chunk; try { events.push(JSON.parse(text)); } catch {} res.end("ok"); return; }
    if (req.url === "/report.csv") { res.writeHead(200, { "content-type": "text/csv;charset=utf-8", "content-disposition": "attachment; filename=report.csv" }); res.end("id,name\nPP-1,test\n"); return; }
    if (req.url === "/api/records") { res.setHeader("content-type", "application/json"); res.end(JSON.stringify(records)); return; }
    if (req.url === "/api/submit" && req.method === "POST") {
      let data = ""; for await (const chunk of req) { data += chunk; if (data.length > 100000) { res.writeHead(413).end(); return; } }
      try { const value = JSON.parse(data); const receipt = { ...value, id: `PP-${++sequence}` }; records.push(receipt);
        // Deliver headers then truncate the body. Destroying a reused socket
        // before ANY response bytes lets Chrome transparently retry the POST,
        // which would test HTTP retry semantics rather than Agent recovery.
        if (value.disconnect) { res.writeHead(200, { "content-type": "application/json", "content-length": "1000" }); res.write('{"id":', () => res.destroy()); return; }
        res.setHeader("content-type", "application/json"); res.end(JSON.stringify(receipt));
      } catch { res.writeHead(400).end("Invalid payload"); } return;
    }
    res.setHeader("content-type", "text/html;charset=utf-8"); res.end(html);
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", resolve); });
  return { url: `http://127.0.0.1:${server.address().port}`, records, events, close: () => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }) };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const fixture = await startTaskFixture(Number(process.env.PORT || 4317)); console.log(`Task fixture: ${fixture.url}`);
}
