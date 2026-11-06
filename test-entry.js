const assert=require('node:assert/strict');
const {makeHarness}=require('./test-harness');
const article='<article><h1>入口测试正文</h1><p>'+('需要保存完整正文，入口只在用户触发时开始剪藏。'.repeat(14))+'</p></article>';
let passed=0;
const q=(h,id)=>h.w.document.getElementById(id);
const menu=(h,text)=>h.menus.find(m=>m.name.includes(text)).callback;
async function test(name,fn){await fn();passed++;console.log('PASS '+name);}
function pointer(h,el,type,x,y){
  const e=new h.w.MouseEvent(type,{clientX:x,clientY:y,button:0,bubbles:true,cancelable:true});
  Object.defineProperty(e,'pointerId',{value:1});Object.defineProperty(e,'isPrimary',{value:true});el.dispatchEvent(e);
}
(async()=>{
  await test('图形入口一次点击直接剪藏，进入页面不自行提取或下载',async()=>{
    const h=makeHarness(article);
    try{
      assert.equal(h.api.getLastClip(),null);assert.equal(h.downloads.length,0);
      assert.ok(q(h,'uclip-fab').querySelector('svg'));
      await q(h,'uclip-fab').onclick();assert.ok(h.api.getLastClip());
      assert.equal(q(h,'uclip-panel').style.display,'flex');assert.equal(h.downloads.length,0);
    }finally{h.close();}
  });
  await test('直接入口遵循未导出修改保护',async()=>{
    const h=makeHarness(article);
    try{
      await h.api.clip();const old=h.api.getLastClip();
      q(h,'uclip-preview').value+='\\n不可丢失的编辑';q(h,'uclip-preview').dispatchEvent(new h.w.Event('input'));
      q(h,'uclip-hide').onclick();await q(h,'uclip-fab').onclick();
      assert.equal(h.api.getLastClip(),old);assert.ok(!q(h,'replace-gate').hidden);
      q(h,'replace-cancel').onclick();assert.ok(q(h,'uclip-preview').value.includes('不可丢失的编辑'));
    }finally{h.close();}
  });
  await test('浮动入口隐藏时仍可通过菜单剪藏和打开设置',async()=>{
    const h=makeHarness(article,{cfg:{floatingBtn:false}});
    try{
      assert.equal(q(h,'uclip-fab').style.display,'none');
      menu(h,'剪藏设置')();assert.ok(q(h,'uclip-settings').classList.contains('on'));
      assert.equal(q(h,'s_floating').value,'0');
      q(h,'uclip-settings').querySelector('.settings-head button').onclick();
      await menu(h,'剪藏本页')();assert.ok(h.api.getLastClip());
    }finally{h.close();}
  });
  await test('隐藏入口设置跨页面保留，并且不使已有结果失效',async()=>{
    const h=makeHarness(article);
    let stored;
    try{
      await h.api.clip();q(h,'uclip-setbtn').onclick();q(h,'s_floating').value='0';q(h,'s_save').onclick();
      assert.ok(!q(h,'uclip-openmd').disabled);q(h,'uclip-hide').onclick();
      assert.equal(q(h,'uclip-fab').style.display,'none');stored=structuredClone(h.stored);
    }finally{h.close();}
    const next=makeHarness(article,{stored});
    try{assert.equal(next.api.cfg.floatingBtn,false);assert.equal(q(next,'uclip-fab').style.display,'none');}
    finally{next.close();}
  });
  await test('菜单切换入口与设置值保持一致，查看结果不重新提取',async()=>{
    const h=makeHarness(article);
    try{
      await h.api.clip();const before=h.api.getLastClip();q(h,'uclip-setbtn').onclick();
      menu(h,'显示 / 隐藏')();assert.equal(q(h,'s_floating').value,'0');
      q(h,'uclip-settings').querySelector('.settings-head button').onclick();q(h,'uclip-hide').onclick();
      menu(h,'查看剪藏结果')();assert.equal(h.api.getLastClip(),before);
      q(h,'uclip-hide').onclick();menu(h,'显示 / 隐藏')();assert.equal(q(h,'uclip-fab').style.display,'flex');
    }finally{h.close();}
  });
  await test('保存的位置适应窗口变化，恢复默认清除位置记录',async()=>{
    const h=makeHarness(article,{cfg:{floatingPosition:{x:0.8,y:0.7}}});
    try{
      const left=parseFloat(q(h,'uclip-fab').style.left);assert.ok(left>0&&left<h.w.innerWidth-42);
      h.w.innerWidth=390;h.w.innerHeight=500;h.w.dispatchEvent(new h.w.Event('resize'));
      assert.ok(parseFloat(q(h,'uclip-fab').style.left)<=336);
      assert.ok(parseFloat(q(h,'uclip-fab').style.top)<=446);
      menu(h,'剪藏设置')();q(h,'s_position').onclick();assert.equal(h.api.cfg.floatingPosition,null);
      assert.equal(q(h,'uclip-fab').style.left,'');assert.equal(q(h,'uclip-fab').style.top,'');
      const saved=Object.entries(h.stored).find(([key])=>key.endsWith('cfg'))[1];assert.equal(saved.floatingPosition,null);
    }finally{h.close();}
  });
  await test('拖动保存位置且松开不误剪藏，键盘点击仍能正常触发',async()=>{
    const h=makeHarness(article);
    try{
      const button=q(h,'uclip-fab');button.getBoundingClientRect=()=>({left:900,top:600,width:42,height:42});
      pointer(h,button,'pointerdown',920,620);pointer(h,button,'pointermove',420,220);pointer(h,button,'pointerup',420,220);
      assert.ok(h.api.cfg.floatingPosition.x>=0&&h.api.cfg.floatingPosition.x<=1);
      button.dispatchEvent(new h.w.MouseEvent('click',{detail:1,cancelable:true}));
      assert.equal(h.api.getLastClip(),null);
      const saved=Object.entries(h.stored).find(([key])=>key.endsWith('cfg'))[1];assert.equal(saved.floatingPosition.x,h.api.cfg.floatingPosition.x);assert.equal(saved.floatingPosition.y,h.api.cfg.floatingPosition.y);
      await button.onclick(new h.w.MouseEvent('click',{detail:0}));assert.ok(h.api.getLastClip());
    }finally{h.close();}
  });
  await test('剪藏进行中再次点击只打开进度，不重复执行',async()=>{
    let pending;
    const h=makeHarness(article.replace('</article>','<img src="https://img.example/entry.png"></article>'),{
      cfg:{imageMode:'local'},gmRequest:d=>{pending=d;}
    });
    try{
      const capture=q(h,'uclip-fab').onclick();await new Promise(resolve=>setTimeout(resolve,0));
      assert.ok(pending);q(h,'uclip-hide').onclick();await q(h,'uclip-fab').onclick();
      assert.equal(q(h,'uclip-panel').style.display,'flex');assert.equal(h.requests.length,1);
      assert.ok(q(h,'uclip-status').textContent.includes('正在处理中'));
      pending.onload({status:200,response:new Blob(['png-bytes'],{type:'image/png'}),responseHeaders:'content-type:image/png'});
      await capture;assert.ok(h.api.getLastClip());assert.ok(!q(h,'uclip-openmd').disabled);
    }finally{h.close();}
  });
  console.log('入口通过 '+passed+' / 失败 0');
})().catch(error=>{console.error(error.stack);process.exitCode=1;});
