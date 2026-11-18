import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCanvas, loadImage, GlobalFonts } from '@napi-rs/canvas';
import { marked } from 'marked';
import archiver from 'archiver';

// Generates local launch assets from versioned text. No external publication.
const root = fileURLToPath(new URL('../', import.meta.url));
const dir = path.join(root, 'docs/promotion-launch');
const out = path.join(root, 'artifacts/promotion-launch');
const read = p => fs.readFileSync(path.join(root,p),'utf8');
const write = (p,s) => {fs.mkdirSync(path.dirname(p),{recursive:true});fs.writeFileSync(p,s);};
let loadedFont=false;
for(const font of [process.env.PROFILEPILOT_PROMO_FONT,'C:/Windows/Fonts/msyh.ttc','/System/Library/Fonts/PingFang.ttc'].filter(Boolean)) {
  if(fs.existsSync(font)) { GlobalFonts.registerFromPath(font,'LaunchCN'); loadedFont=true; break; }
}
if(!loadedFont) throw Error('Set PROFILEPILOT_PROMO_FONT to an installed Chinese font file before rendering.');
if(fs.existsSync('C:/Windows/Fonts/msyhbd.ttc')) GlobalFonts.registerFromPath('C:/Windows/Fonts/msyhbd.ttc','LaunchBold');
const logo = await loadImage(path.join(root,'public/assets/profilepilot-mark.svg'));
const ink='#10244b', muted='#536780', blue='#1558ed', line='#d7e2ef', paper='#f6f9fd';
let c, g;
const dimensions=[];
function page(w,h,bg=paper){c=createCanvas(w,h);g=c.getContext('2d');g.fillStyle=bg;g.fillRect(0,0,w,h);g.textBaseline='top';}
function text(s,x,y,size=32,color=ink,bold=false){g.font=`${bold?'700':'400'} ${size}px ${bold?'LaunchBold, ':''}LaunchCN, sans-serif`;g.fillStyle=color;g.fillText(s,x,y);}
function wrap(s,x,y,width,size=30,color=muted,leading=1.65){let row='';for(const ch of s){g.font=`400 ${size}px LaunchCN, sans-serif`;if(ch==='\n'||g.measureText(row+ch).width>width){text(row,x,y,size,color);y+=size*leading;row=ch==='\n'?'':ch;}else row+=ch;}if(row){text(row,x,y,size,color);y+=size*leading;}return y;}
function box(x,y,w,h,fill='#fff'){g.fillStyle=fill;g.fillRect(x,y,w,h);g.strokeStyle=line;g.lineWidth=2;g.strokeRect(x,y,w,h);}
function rule(x,y,w){g.strokeStyle=line;g.lineWidth=2;g.beginPath();g.moveTo(x,y);g.lineTo(x+w,y);g.stroke();}
function brand(y=65){g.drawImage(logo,70,y,46,46);text('ProfilePilot',132,y,34,ink,true);}
function save(p){write(p,c.toBuffer('image/png'));dimensions.push({file:path.relative(dir,p).replaceAll('\\','/'),width:c.width,height:c.height});}
function card(n,title,sub){page(1080,1440);brand();text(`${String(n).padStart(2,'0')} / 06`,850,76,25,muted);title.forEach((s,i)=>text(s,70,190+i*91,72,ink,true));wrap(sub,74,410,920,29);rule(70,1320,940);text('使用流程图解 · 非运行截图',70,1350,24,muted);text('ffffhx / profilepilot',730,1350,24,muted);}
function row(n,head,body,y){text(n,76,y,35,blue,true);text(head,150,y,37,ink,true);wrap(body,150,y+66,780,29);}

page(1200,630,'#fff');brand(60);text('把网页任务交给',70,174,68,ink,true);text('你正在用的 Agent。',70,265,68,ink,true);text('网站读取 · 独立目标 · 人工接管',74,394,30,muted);rule(70,481,1060);text('Chrome   /   Electron   /   Android',74,518,28,blue);text('MIT 开源',975,518,28,ink);save(path.join(dir,'assets/social-cover.png'));write(path.join(root,'site/assets/social-cover.png'),c.toBuffer('image/png'));

page(1600,900);brand(64);text('第一次任务，从一个网页开始。',70,165,60,ink,true);
['安装对应桌面版','连接 Chrome 扩展','安装 CLI + Skill','交给已有 Agent'].forEach((s,i)=>{const x=70+i*385;text(String(i+1).padStart(2,'0'),x,305,60,blue,true);text(s,x,400,32,ink,true);wrap(['核对系统与版本说明','选择日常 Profile 并配对','重新打开终端检查连接','只读指定页面并核对来源'][i],x,466,320,26);});
box(70,620,1460,155);wrap('请读取 ProfilePilot Skill，检查默认目标、连接和占用；总结我指定网页的三条要点，保留原链接，完成后结束控制会话。',105,653,1380,29,ink);text('流程图解 · 具体安装状态以下载版本说明为准',70,824,23,muted);save(path.join(dir,'assets/first-task.png'));

card(1,['给现有 AI','接上网页和安卓。'],'继续使用 Claude Code / Codex，把任务交给本地工具。');
box(70,550,940,180);text('你的 Agent',110,590,46,ink,true);text('使用配套 Skill 与 ppilot CLI',110,660,29,muted);
text('↓',500,756,64,blue);box(70,865,940,290);text('Chrome   /   Electron   /   Android',105,914,34,ink,true);wrap('读取指定页面，检查本地应用，验证手机任务。每次先选对目标，再检查控制权。',110,1000,840,32);save(path.join(dir,'assets/xhs-01.png'));

card(2,['找商品之前，','先把条件写清楚。'],'以闲鱼内存筛选为例：先约定任务，再读取页面。');
row('01','规格','DDR5 · 32GB · 笔记本\n确认单条还是套装。',565);
row('02','预算与排除项','预算由你提供。维修情况没写清，\n就标记待确认。',790);
row('03','任务边界','只搜索与整理，不联系卖家、\n不下单、不把挂牌价当成交价。',1015);save(path.join(dir,'assets/xhs-02.png'));

card(3,['结果要能核对，','也要敢写“不知道”。'],'输出字段示意；没有填写虚构商品、价格或卖家。');
box(70,550,940,610);text('每个候选都保留这些',110,590,38,ink,true);
[['标题与原链接','回到原页面核对'],['挂牌价与规格','保留页面证据'],['符合 / 不符合','附原文依据'],['待确认项','缺失信息不猜测']].forEach(([a,b],i)=>{const y=697+i*107;rule(110,y-21,860);text(a,110,y,32,ink,true);text(b,560,y,28,muted);});
wrap('反复采样只能积累之后的记录，不能补出过去一年的价格。',80,1210,920,26);save(path.join(dir,'assets/xhs-03.png'));

card(4,['两个任务，','各自用自己的目标。'],'并行范围：不同 Profile / 独立应用。');
[['Agent A','资料 Profile','收集网页资料'],['Agent B','测试 Profile','检查本地项目']].forEach(([a,b,d],i)=>{box(70+i*490,565,450,490);text(a,105+i*490,615,42,ink,true);text('↓',255+i*490,710,50,blue);text(b,105+i*490,815,35,ink,true);text(d,105+i*490,907,30,muted);});
wrap('同一 Profile 一次一个控制会话。目标被占用时提示，不直接抢走。',80,1120,920,33);save(path.join(dir,'assets/xhs-04.png'));

card(5,['需要你操作时，','先接管，再交还。'],'保留同一个任务与目标，避免误操作。');
row('01','暂停 / 接管','Agent 停止后续输入，由你处理页面。',570);
row('02','明确交还','你确认可以继续后，恢复原会话。',805);
row('03','重新观察','读取最新页面状态，再执行下一步。\n结果不明的动作不自动重放。',1040);save(path.join(dir,'assets/xhs-05.png'));

card(6,['先完成一个','能核对的小任务。'],'不需要先换掉你熟悉的编程 Agent。');
row('1','安装 → 扩展配对','按版本说明完成连接，装好 CLI / Skill。',565);
row('2','只读一个指定网页','标题、三条要点、原链接。核对后结束会话。',770);
row('3','再试你的实际任务','闲鱼筛选、小红书资料、网页与安卓验收。',975);
text('GitHub 搜索：ffffhx/profilepilot',80,1200,32,blue,true);save(path.join(dir,'assets/xhs-06.png'));

for(const [name,w,h] of [['promo-small',440,280],['promo-marquee',1400,560]]){page(w,h,'#eef5ff');const side=h*.52;g.drawImage(logo,(w-side)/2,(h-side)/2,side,side);save(path.join(dir,`store/${name}.png`));}

const manifest=JSON.parse(read('extensions/profilepilot/manifest.json'));
const storeDoc=read('docs/native-extension-store.md');
write(path.join(dir,'store/description.zh-CN.txt'),storeDoc.split('## 商店文案')[1].split('## 权限理由')[0].trim()+'\n');
const permissions=Object.fromEntries([...storeDoc.matchAll(/^\| ([^|]+) \| ([^|]+) \|$/gm)].slice(2).map(m=>[m[1].trim(),m[2].trim()]));
const permissionReasons={permissions:Object.fromEntries(manifest.permissions.map(k=>{if(!permissions[k])throw Error('Missing reason: '+k);return [k,permissions[k]];})),host_permissions:{'<all_urls>':permissions['http/https 全站']}};
write(path.join(dir,'store/permissions.zh-CN.json'),JSON.stringify(permissionReasons,null,2)+'\n');
write(path.join(dir,'store/privacy.zh-CN.md'),read('docs/native-extension-privacy.md'));
write(path.join(dir,'store/icon-128.png'),fs.readFileSync(path.join(root,'extensions/profilepilot/icons/icon-128.png')));
for(const f of fs.readdirSync(path.join(out,'extension'))) write(path.join(dir,'store',f),fs.readFileSync(path.join(out,'extension',f)));

const copy=read('docs/promotion-launch/channel-copy.md');
const tweets=[...copy.matchAll(/<!-- tweet:(.*?) -->\s*([\s\S]*?)\s*<!-- \/tweet -->/g)].map(m=>{const body=m[2].trim();const plain=body.replace(/https?:\/\/\S+/g,'x'.repeat(23));const weight=[...plain].reduce((n,ch)=>{const p=ch.codePointAt(0);return n+(p<=0x10ff||(p>=0x2000&&p<=0x200d)||(p>=0x2010&&p<=0x201f)||(p>=0x2032&&p<=0x2037)?1:2);},0);if(weight>280)throw Error(m[1]+' exceeds 280: '+weight);return {id:m[1],weight,limit:280,body};});
for(const t of tweets)write(path.join(dir,`copy/x-${t.id}.txt`),t.body+'\n');
const validation={generatedOn:'2026-11-15',tweets:tweets.map(({body,...t})=>t),dimensions,extensionVersion:manifest.version,published:false,notes:['Graphics are explanatory illustrations, not runtime proof.','Release, store identity, real screenshots and macOS pilot remain gates.']};
write(path.join(dir,'validation.json'),JSON.stringify(validation,null,2)+'\n');

const escape=s=>s.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('"','&quot;');
const docs=[['channel-copy','渠道文案与常见回复'],['store-submission','扩展商店提交材料'],['pilot-and-measurement','试用邀请与记录方法'],['comparison-protocol','三方比较协议'],['repository-metadata','仓库介绍与英文入口'],['release-readiness','已完成与待发布事项']];
const articles=docs.map(([file,label])=>`<section class="document" id="${file}"><div class="section-head"><h2>${label}</h2><a href="${file}.md" download>下载 Markdown</a><button data-copy="source-${file}" type="button">复制全文</button></div><details><summary>展开内容</summary><div class="prose">${marked.parse(read(`docs/promotion-launch/${file}.md`))}</div></details><textarea id="source-${file}" hidden>${escape(read(`docs/promotion-launch/${file}.md`))}</textarea></section>`).join('');
const html=`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>ProfilePilot · 推广材料包</title><link rel="stylesheet" href="launch.css"></head><body><a class="skip" href="#main">跳到正文</a><header><a class="brand" href="#"><img src="../../public/assets/profilepilot-mark.svg" alt="">ProfilePilot</a><nav aria-label="材料导航"><a href="#copy">文案</a><a href="#images">配图</a><a href="#store-submission">商店</a><a href="#release-readiness">发布状态</a></nav></header><main id="main"><div class="intro"><p class="date">2026.11.15 · 本地交付 · 尚未对外发布</p><h1>视频之外，<br>把发布要用的东西准备好。</h1><p class="lede">文案、图文素材、上手指南、商店材料和反馈入口，都放在这里。你可以直接查看、复制或整包下载。</p><div class="actions"><a class="primary" href="../../artifacts/promotion-launch/ProfilePilot-launch-kit.zip" download>下载完整材料包</a><a href="../../site/start.html">查看中英文上手页 ↗</a><a href="/">预览新版官网 ↗</a></div></div><p class="status"><strong>发布前还有实际条件：</strong>新版下载包验证、商店账号与正式 ID、最终运行截图、macOS 和新用户试用。对应材料已备，尚未发生的结果没有填成完成。<a href="#release-readiness">查看记录</a>。</p><section id="copy"><h2>直接复制的 X 文案</h2><p>英文串共六条，中文一条；每条均已按 280 字符上限核验。</p>${tweets.map(t=>`<details class="tweet"><summary>${t.id==='zh'?'中文单条':'英文 '+t.id.split('-')[1]}<span>${t.weight} / 280</span></summary><p id="${t.id}">${escape(t.body)}</p><button data-copy="${t.id}" type="button">复制这条</button><a href="copy/x-${t.id}.txt" download>下载文本</a></details>`).join('')}</section>${articles.slice(0,articles.indexOf('<section class="document" id="store-submission"'))}<section id="images"><h2>配图可直接下载</h2><p>社交封面和首次任务图；六张小红书流程图均为 1080 × 1440。图中没有虚构商品或测试成绩。</p><div class="wide-images">${['social-cover','first-task'].map((n,i)=>`<figure><a href="assets/${n}.png" target="_blank"><img src="assets/${n}.png" alt="${i?'首次任务上手步骤':'ProfilePilot 社交封面'}" loading="lazy"></a><figcaption><a href="assets/${n}.png" download>${i?'下载上手步骤图':'下载社交封面'}</a></figcaption></figure>`).join('')}</div><div class="gallery">${Array.from({length:6},(_,i)=>`<figure><a href="assets/xhs-0${i+1}.png" target="_blank"><img src="assets/xhs-0${i+1}.png" alt="流程图解 ${i+1}：${['接入已有 Agent','写清筛选条件','结果保留证据','分开管理目标','人工接管与交还','第一次任务'][i]}" loading="lazy"></a><figcaption><a href="assets/xhs-0${i+1}.png" download>下载第 ${i+1} 张</a></figcaption></figure>`).join('')}</div></section>${articles.slice(articles.indexOf('<section class="document" id="store-submission"'))}<section><h2>安装包与空白记录表</h2><ul><li><a href="store/profilepilot-extension-${manifest.version}.zip" download>扩展 ${manifest.version} ZIP</a> · <a href="store/validation.json">打包校验</a></li><li><a href="store/description.zh-CN.txt">商店文案</a> · <a href="store/permissions.zh-CN.json">权限理由</a> · <a href="store/privacy.zh-CN.md">隐私说明</a></li><li><a href="store/promo-small.png" download>440 × 280 宣传图</a> · <a href="store/promo-marquee.png" download>1400 × 560 宣传图</a> · <a href="store/icon-128.png" download>128 图标</a></li><li><a href="pilot.csv" download>试用记录 CSV</a> · <a href="feedback.csv" download>反馈 CSV</a> · <a href="comparison-runs.csv" download>比较记录 CSV</a> · <a href="release-queue.csv" download>发布队列 CSV</a></li><li><a href="../../.github/ISSUE_TEMPLATE/first-task.yml">首次使用反馈表单</a> · <a href="../../.github/ISSUE_TEMPLATE/site-read.yml">站点读取反馈表单</a></li></ul></section><footer>没有代发帖子、发送邀请、购买账号或部署官网。视频由你自行安排。<a href="../promotion-plan.html">查看原推广方案</a></footer></main><div id="copy-status" role="status" aria-live="polite"></div><script src="launch.js"></script></body></html>`;
write(path.join(dir,'index.html'),html);

const zipPath=path.join(out,'ProfilePilot-launch-kit.zip');
await new Promise((resolve,reject)=>{const stream=fs.createWriteStream(zipPath);const zip=archiver('zip',{zlib:{level:9}});stream.on('close',resolve);stream.on('error',reject);zip.on('error',reject);zip.pipe(stream);zip.directory(dir,'docs/promotion-launch');for(const p of ['site/start.html','site/styles.css','site/script.js','site/extension-privacy.html','site/assets','public/assets','docs/screenshots/workspace-agent.png','docs/promotion-plan.html','docs/promotion-plan.md','docs/native-extension-store.md','.github/ISSUE_TEMPLATE']){const f=path.join(root,p);if(fs.statSync(f).isDirectory())zip.directory(f,p);else zip.file(f,{name:p});}zip.file(path.join(root,'site/index.html'),{name:'index.html'});zip.finalize();});
console.log(JSON.stringify({directory:dir,zip:zipPath,zipBytes:fs.statSync(zipPath).size,tweets:validation.tweets,images:dimensions.length},null,2));
