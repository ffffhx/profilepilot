kit.score(function(S,T){
 S.tempo(120);
 S.program('keys','ep',{rev:.18,gain:-5});
 S.program('pulse','pluck',{rev:.12,gain:-8});
 S.program('bass','bass',{gain:-8});
 const chords=[['D3','F#3','A3','E4'],['B2','D3','F#3','A3'],['G2','B2','D3','A3'],['A2','C#3','E3','B3'],['G2','B2','D3','A3'],['A2','C#3','E3','B3']];
 chords.forEach((c,i)=>{const at=i*2;S.chord('keys',c,{t:at,dur:1.8,vel:i<2?45:57});if(i>0)S.note('bass',c[0],{t:at,dur:1.5,vel:51});});
 const tune=['F#4','A4','E4','D4','A4','B4','A4','F#4','E4','F#4','A4','E4','B4','A4','F#4','E4'];
 tune.forEach((n,i)=>S.note('pulse',n,{t:3+i*.5,dur:.28,vel:46+(i%4===0?10:0)}));
 for(let b=8;b<22;b++){S.drum('hat',{beat:b+.5,vel:23});if(b%2===0)S.drum('kick',{beat:b,vel:43});if(b%4===2)S.drum('sidestick',{beat:b,vel:35});}
 S.fx('click',.35,{vel:30});
 [.35,.59,.83].forEach(d=>S.fx('pop',T.parallel+d,{vel:24}));
 S.fx('ding',T.parallel+3.35,{vel:38,pitch:'D5'});
 S.chord('keys',['D3','A3','E4','F#4'],{t:T.end,dur:3.8,vel:70});
 S.note('bass','D2',{t:T.end,dur:2.5,vel:52});
 S.fx('chime',T.end+.08,{vel:42});
 S.master({gain:-5,fadeOut:1.1});
});
