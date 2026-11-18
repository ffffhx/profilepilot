const {seg,eo,eio,lerp}=kit;
kit.scene('end',{
 init(kit){
  this.root=W.mount(kit,'end','15 秒样片');
  this.root.querySelector('.brand').style.display='none';
  this.root.querySelector('.foot').textContent='功能示意 · 安装步骤以仓库说明为准';
  this.root.append(kit.h('<div class="end-lockup" style="position:absolute;left:208px;top:324px;display:flex;align-items:center;gap:48px"><img class="end-logo" src="'+kit.assets.url('profilepilot.png')+'" style="width:210px;height:210px"><div class="words" style="position:relative;gap:14px"><h1 style="font-size:150px;line-height:1.15;font-weight:650;letter-spacing:-6px">ProfilePilot</h1><p style="font-size:47px;line-height:1.5">多个 Agent，各做各的任务。</p></div></div>'));
  this.root.append(kit.h('<div class="words end-action" style="left:466px;top:658px;width:1200px;gap:28px"><p style="font-size:42px;line-height:1.4">从一次真实任务开始。</p><div class="end-link" style="display:flex;gap:24px;align-items:center"><span style="font-size:43px;letter-spacing:-.5px">github.com/ffffhx/profilepilot</span><svg width="48" height="48" viewBox="0 0 48 48" style="stroke:var(--main);fill:none;stroke-width:3"><path d="M9 24 H38 M27 13 L38 24 L27 35"/></svg></div></div>'));
  this.lockup=this.root.querySelector('.end-lockup');this.action=this.root.querySelector('.end-action');this.link=this.root.querySelector('.end-link');
 },
 render(t){
  W.reveal(this.lockup,t,-.4,30,.65);
  this.lockup.style.transform='translateY('+lerp(7,-2,eio(seg(t,0,4)))+'px)';
  W.reveal(this.action,t,.05,18,.65);
  this.link.style.transform='translateX('+lerp(0,6,eio(seg(t,.5,4)))+'px)';
  W.progress(this.root,t,11);
 }
});
