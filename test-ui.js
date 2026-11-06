const assert=require('node:assert/strict');
const {makeHarness}=require('./test-harness');
const article='<article><h1>界面测试正文</h1><p>'+('完整正文和来源应当保留，界面上的操作不得丢失已经编辑的内容。'.repeat(12))+'</p></article>';
let passed=0;
async function test(name,fn){
  try{await fn();passed++;console.log('PASS '+name);}
  catch(error){console.error('FAIL '+name);throw error;}
}
function query(h,id){return h.w.document.getElementById(id);}
async function withCapture(opts,fn){
  const h=makeHarness(article,opts);
  try{await h.api.clip();await fn(h,h.api.getLastClip());}
  finally{h.close();}
}
function change(h,id,value){const element=query(h,id);element.value=value;element.dispatchEvent(new h.w.Event('change'));}
function edit(h,text){const element=query(h,'uclip-preview');element.value+=text;element.dispatchEvent(new h.w.Event('input'));}
(async()=>{
  await test('首次打开尚未提取时不能导出空结果',async()=>{
    const h=makeHarness(article);
    try{assert.equal(h.api.version,'1.3.0');assert.ok(query(h,'uclip-openmd').disabled);assert.ok(query(h,'edit-tab').disabled);
      assert.equal(query(h,'read-frame').getAttribute('sandbox'),'');assert.equal(h.downloads.length,0);}
    finally{h.close();}
  });
  await test('默认MD也可阅读预览，切换HTML导出无需重新提取',()=>withCapture({},async(h,r)=>{
    assert.equal(r.html,null);assert.ok(r.previewHtml.includes('完整正文'));
    const before=h.api.getLastClip();change(h,'export-format','html');
    await h.export();assert.equal(h.api.getLastClip(),before);assert.equal(h.downloads.length,1);
    assert.ok(h.downloads[0].name.endsWith('.html'));assert.ok((await h.downloads[0].blob.text()).includes('完整正文'));
  }));
  await test('重新剪藏的取消操作保留当前编辑',()=>withCapture({},async(h,r)=>{
    edit(h,'\n保留这段编辑。');await query(h,'uclip-clip').onclick();
    assert.ok(!query(h,'replace-gate').hidden);assert.equal(h.api.getLastClip(),r);
    query(h,'replace-cancel').onclick();assert.ok(query(h,'uclip-preview').value.includes('保留这段编辑'));
    await h.export();assert.ok((await h.downloads[0].blob.text()).includes('保留这段编辑'));
  }));
  await test('快捷键保护编辑，确认替换后才重新提取',()=>withCapture({},async(h,r)=>{
    edit(h,'\n快捷键不能直接覆盖。');
    h.w.document.dispatchEvent(new h.w.KeyboardEvent('keydown',{key:'S',altKey:true,shiftKey:true,bubbles:true}));
    assert.equal(h.api.getLastClip(),r);assert.ok(!query(h,'replace-gate').hidden);
    await query(h,'replace-confirm').onclick();assert.notEqual(h.api.getLastClip(),r);
    assert.ok(!query(h,'uclip-preview').value.includes('快捷键不能直接覆盖'));assert.ok(!query(h,'read-view').hidden);
  }));
  await test('仅HTML导出清楚提示编辑不会进入快照',()=>withCapture({},async(h)=>{
    edit(h,'\n只进入Markdown的修改。');change(h,'export-format','html');
    assert.ok(query(h,'edit-note').textContent.includes('不会写入此次导出'));
    await h.export();assert.ok(!(await h.downloads[0].blob.text()).includes('只进入Markdown的修改'));
  }));
  await test('图片设置更改后阻止旧附件导出，重剪后恢复',()=>withCapture({},async(h)=>{
    query(h,'uclip-setbtn').onclick();query(h,'s_img').value='base64';query(h,'s_save').onclick();
    assert.ok(query(h,'uclip-openmd').disabled);await h.export();assert.equal(h.downloads.length,0);
    assert.ok(query(h,'uclip-status').textContent.includes('重新剪藏'));
    await query(h,'uclip-clip').onclick();assert.ok(!query(h,'uclip-openmd').disabled);
  }));
  await test('收起和重新展开不会丢失编辑，复制保留当前内容',()=>withCapture({},async(h)=>{
    let copied='';h.w.navigator.clipboard={writeText:async text=>{copied=text;}};
    edit(h,'\n收起后仍然保留。');query(h,'uclip-hide').onclick();h.menus.find(m=>m.name==='查看剪藏结果').callback();
    await query(h,'uclip-cp').onclick();assert.ok(copied.includes('收起后仍然保留'));assert.ok(!query(h,'edit-badge').hidden);
  }));
  await test('图片处理中禁用设置与导出，成功后恢复',async()=>{
    let pending;
    const h=makeHarness(article.replace('</article>','<img src="https://img.example/p.png"></article>'),{
      cfg:{imageMode:'local'},gmRequest:d=>{pending=d;}
    });
    try{
      const promise=h.api.clip();await new Promise(resolve=>setTimeout(resolve,0));
      assert.ok(query(h,'uclip-setbtn').disabled);assert.ok(query(h,'export-format').disabled);assert.ok(query(h,'uclip-openmd').disabled);
      assert.ok(pending);pending.onload({status:200,response:new Blob(['png-bytes'],{type:'image/png'}),responseHeaders:'content-type:image/png'});
      await promise;assert.ok(!query(h,'uclip-setbtn').disabled);assert.ok(!query(h,'uclip-openmd').disabled);
      const preview=query(h,'read-frame').srcdoc;assert.ok(preview.includes('data:image/png;base64,'));assert.ok(preview.includes("default-src 'none'"));
    }finally{h.close();}
  });
  await test('提取失败仍保留上一次可导出的正文',()=>withCapture({},async(h,r)=>{
    h.w.document.querySelector('article').replaceChildren();await h.api.clip();
    assert.equal(h.api.getLastClip(),r);assert.equal(query(h,'uclip-preview').value,r.md);
    assert.ok(query(h,'uclip-status').textContent.includes('失败'));await h.export();assert.equal(h.downloads.length,1);
  }));
  console.log('界面通过 '+passed+' / 失败 0');
})().catch(error=>{console.error(error.stack);process.exitCode=1;});
