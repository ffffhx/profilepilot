window.W = {
  mount(kit,id,tag='15 秒样片 · 功能示意') {
    const root=kit.h('<div class="scene-root '+id+'-root"><div class="ground"></div><div class="brand"><img src="'+kit.assets.url('profilepilot.png')+'"><span>ProfilePilot</span></div><div class="tag">'+kit.esc(tag)+'</div><div class="foot">让 Agent 连接你的本地工作</div><div class="progress"><i></i></div></div>');
    kit.stage.append(root);
    return root;
  },
  reveal(el,t,at=0,dist=25,dur=.7) {
    const p=kit.eo(kit.seg(t,at,at+dur));
    el.style.opacity=p;
    el.style.transform='translateY('+((1-p)*dist)+'px)';
  },
  progress(root,t,start) {root.querySelector('.progress>i').style.transform='scaleX('+kit.clamp01((start+t)/15)+')';},
  dot(svg,c,x,y){c.setAttribute('cx',x.toFixed(2));c.setAttribute('cy',y.toFixed(2));},
  pathPoint(p,x0,y0,x1,y1,x2,y2){return [(1-p)*(1-p)*x0+2*(1-p)*p*x1+p*p*x2,(1-p)*(1-p)*y0+2*(1-p)*p*y1+p*p*y2];}
};
