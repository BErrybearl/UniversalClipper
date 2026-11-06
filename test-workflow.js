const assert=require('node:assert/strict');
const {crc32}=require('node:zlib');
const {makeHarness}=require('./test-harness');
const text='正文讨论产业发展与长期研究，完整保留重要论据和具体案例。'.repeat(18);
const png=Buffer.from('89504e470d0a1a0a00000000','hex');
let pass=0;
async function test(name,fn) {
 try {await fn();pass++;console.log('PASS '+name);}
 catch(e){console.error('FAIL '+name);throw e;}
}
function imageOK(details){assert.equal(details.responseType,'blob');details.onload({
 status:200,response:new Blob([png],{type:'image/png'}),responseHeaders:'content-type: image/png'
});}
async function capture(html,opts,fn){
 const h=makeHarness(html,opts);
 try {await h.api.clip();const r=h.api.getLastClip();assert.ok(r,h.w.document.querySelector('#uclip-status').textContent);await fn(h,r);}
 finally{h.close();}
}
async function readZip(blob){
 const b=Buffer.from(await blob.arrayBuffer()), files=new Map();let offset=0;
 while(b.readUInt32LE(offset)===0x04034b50){
  assert.equal(b.readUInt16LE(offset+8),0);
  assert.equal(b.readUInt16LE(offset+6)&0x800,0x800);
  const length=b.readUInt32LE(offset+18),names=b.readUInt16LE(offset+26),extra=b.readUInt16LE(offset+28);
  const name=b.subarray(offset+30,offset+30+names).toString('utf8');
  const start=offset+30+names+extra, data=b.subarray(start,start+length);
  assert.equal(crc32(data),b.readUInt32LE(offset+14),'ZIP CRC mismatch');
  files.set(name,data);offset=start+length;
 }
 assert.equal(b.readUInt32LE(offset),0x02014b50);
 assert.equal(b.readUInt32LE(b.length-22),0x06054b50);
 assert.equal(b.readUInt16LE(b.length-12),files.size);
 assert.equal(b.readUInt32LE(b.length-6),offset);
 return files;
}
(async()=>{
 await test('正常域名命中，域名伪装和查询参数不会误命中',async()=>{
  const h=makeHarness('');
  try {
   assert.equal(h.api.findAdapter('https://xueqiu.com/1').name,'雪球');
   assert.equal(h.api.findAdapter('https://www.zhihu.com/a').name,'知乎');
   assert.equal(h.api.findAdapter('https://developer.mozilla.org/a').name,'MDN');
   assert.equal(h.api.findAdapter('https://xueqiu.com.evil.example/a'),null);
   assert.equal(h.api.findAdapter('https://example.com/?url=https://xueqiu.com/1'),null);
   assert.equal(h.api.findAdapter('not a url'),null);
  } finally{h.close();}
 });
 await test('超过600字的评论和推荐图被排除，正文图片保留',()=>capture(
  '<article><h1>研究正文</h1><p>'+text+'</p><img src="https://img.example/body.png">'+
  '<section class="comments"><p>长评论污染'+text.repeat(3)+'</p><img src="https://img.example/comment.png"></section>'+
  '<div class="related"><p>推荐污染'+text+'</p><img src="https://img.example/related.png"></div></article>',
  {cfg:{imageMode:'local'},gmRequest:imageOK},(h,r)=>{
   assert.ok(r.md.includes('正文讨论'));assert.ok(!r.md.includes('长评论污染'));
   assert.ok(!r.md.includes('推荐污染'));assert.equal(h.requests.length,1);
   assert.equal(h.requests[0].url,'https://img.example/body.png');
  }));
 await test('评论文章先出现且更长时仍选择正文',()=>capture(
  '<article class="CommentArea"><p>评论污染'+text.repeat(4)+'</p></article><article><p>'+text+'</p></article>',{},
  (h,r)=>{assert.ok(!r.md.includes('评论污染'));assert.ok(r.md.includes('正文讨论'));}));
 await test('正文范围外的无关图文和标签不会混入',()=>capture(
  '<aside><p>侧栏污染'+text+'</p><span class="tag">无关标签</span><img src="https://img.example/sidebar.png"></aside>'+
  '<main><div class="post-content"><p>'+text+'</p><span class="tag">正文标签</span></div>'+
  '<section class="recommend"><p>推荐污染'+text+'</p></section></main>',{},
  (h,r)=>{assert.ok(!r.md.includes('侧栏污染'));assert.ok(!r.md.includes('推荐污染'));assert.ok(!r.md.includes('无关标签'));assert.ok(r.meta.tags.includes('正文标签'));}));
 await test('正常引用和代码注释不被误删',()=>capture(
  '<article><p>'+text+'</p><blockquote>这段引用讨论评论机制，应完整保存。</blockquote>'+
  '<span class="code-comment">代码注释保留</span><section class="shareholder-analysis"><p>股东分析保留</p></section></article>',{},
  (h,r)=>{assert.ok(r.md.includes('评论机制'));assert.ok(r.md.includes('代码注释保留'));assert.ok(r.md.includes('股东分析保留'));}));
 await test('可用选中文字明确剪藏范围',async()=>{
  const h=makeHarness('<article><p>'+text+'</p><p id="chosen">选中段落只需要保留这一段，超过二十字即可明确剪藏范围。</p></article>');
  try{
   const range=h.w.document.createRange();range.selectNodeContents(h.w.document.querySelector('#chosen'));
   h.w.getSelection().addRange(range);await h.api.clip();
   const r=h.api.getLastClip();assert.equal(r.via,'selection');assert.ok(r.md.includes('选中段落'));
   assert.ok(!r.md.includes('正文讨论'));
  }finally{h.close();}
 });
 await test('懒加载地址被采用，原页面属性不受剪藏修改',()=>capture(
  '<article><p>'+text+'</p><img id="lazy" src="data:image/gif;base64,R0lGODlhAQABAAAA" data-src="https://img.example/full.png"></article>',
  {cfg:{imageMode:'local'},gmRequest:imageOK},(h,r)=>{
   assert.equal(h.requests[0].url,'https://img.example/full.png');
   assert.equal(h.w.document.querySelector('#lazy').getAttribute('data-src'),'https://img.example/full.png');
   assert.equal(r.assets.length,1);
  }));
 await test('本地图片 ZIP 保持路径与原始二进制，预览修改进入MD',()=>capture(
  '<article><p>'+text+'</p><img src="https://img.example/a.png" title="图标题"></article>',
  {cfg:{imageMode:'local',outputFormat:'both'},gmRequest:imageOK},async(h,r)=>{
   h.w.document.querySelector('#uclip-preview').value=r.md+'\n用户追加修改';
   await h.export();assert.equal(h.downloads.length,1);assert.ok(h.downloads[0].name.endsWith('.zip'));
   const files=await readZip(h.downloads[0].blob), asset=r.assets[0];
   assert.deepEqual(files.get(asset.path),png);
   const md=[...files].find(([n])=>n.endsWith('.md'))[1].toString();
   const html=[...files].find(([n])=>n.endsWith('.html'))[1].toString();
   assert.ok(md.includes('用户追加修改'));assert.ok(md.includes(encodeURI(asset.path)));
   assert.ok(html.includes(encodeURI(asset.path)));
  }));
 await test('base64 真正内联且保留图片标题，无需图片附件',()=>capture(
  '<article><p>'+text+'</p><img src="https://img.example/a.png" title="图标题"></article>',
  {cfg:{imageMode:'base64',outputFormat:'both'},gmRequest:imageOK},async(h,r)=>{
   assert.ok(r.md.includes('data:image/png;base64,'+png.toString('base64')));
   assert.ok(r.md.includes('"图标题"'));assert.ok(r.html.includes('data:image/png;base64,'));
   assert.equal(r.assets.length,0);assert.equal(r.imageSummary.localized,1);
   await h.export();assert.equal(h.downloads.length,2);
  }));
 await test('图片请求失败会重试、保留链接并显示明确提示',()=>capture(
  '<article><p>'+text+'</p><img src="https://img.example/fail.png"></article>',
  {cfg:{imageMode:'local'},gmRequest:d=>d.onerror()},(h,r)=>{
   assert.equal(h.requests.length,2);assert.ok(r.md.includes('https://img.example/fail.png'));
   assert.equal(r.meta.captureStatus,'needs-review');assert.equal(r.imageSummary.failed,1);
   assert.ok(h.w.document.querySelector('#uclip-status').textContent.includes('未能保存'));
  }));
 await test('返回HTML的伪图片不会当成图片保存',()=>capture(
  '<article><p>'+text+'</p><img src="https://img.example/login.png"></article>',
  {cfg:{imageMode:'local'},gmRequest:d=>d.onload({status:200,response:new Blob(['<html>login</html>'],{type:'text/html'}),responseHeaders:'content-type: text/html'})},
  (h,r)=>{assert.equal(r.assets.length,0);assert.equal(r.imageSummary.failed,1);}));
 await test('雪球仅HTML格式实际导出HTML并包含转发原文',()=>capture('',{
  url:'https://xueqiu.com/123456789/100',cfg:{outputFormat:'html'},
  snowman:[{id:100,article:'<p>'+text+'</p>',user:{id:'123456789',screen_name:'作者'},created_at:1767225720000,
   retweet_status:{id:99,article:'<p>转发原文保留。</p>',user:{id:'222222222'}}}]
 },async(h,r)=>{
  assert.ok(r.html);assert.ok(r.html.includes('转发原文保留'));
  assert.ok(r.html.includes('https://xueqiu.com/222222222/99'));
  await h.export();assert.equal(h.downloads.length,1);assert.ok(h.downloads[0].name.endsWith('.html'));
 }));
 await test('快捷键触发剪藏，增加Ctrl时不误触发',async()=>{
  const h=makeHarness('<article><p>'+text+'</p></article>');
  try{
   const event=new h.w.KeyboardEvent('keydown',{key:'s',altKey:true,shiftKey:true,cancelable:true});
   h.w.document.dispatchEvent(event);
   for(let i=0;i<100 && !h.api.getLastClip();i++) await new Promise(r=>setTimeout(r,1));
   const r=h.api.getLastClip();assert.ok(r);assert.ok(event.defaultPrevented);
   h.w.document.dispatchEvent(new h.w.KeyboardEvent('keydown',{key:'s',altKey:true,shiftKey:true,ctrlKey:true}));
   await new Promise(resolve=>setTimeout(resolve,2));assert.equal(h.api.getLastClip(),r);
  }finally{h.close();}
 });
 await test('HTML清除可执行属性和链接，快照限制脚本执行',()=>capture(
  '<article><p>'+text+'</p><img src="data:image/png;base64,AA==" onerror="alert(1)">'+
  '<a href="javascript:alert(2)">正常可读文字</a><iframe srcdoc="bad"></iframe></article>',
  {cfg:{outputFormat:'both'}},(h,r)=>{
   assert.ok(!r.html.includes('onerror'));assert.ok(!r.html.includes('javascript:'));
   assert.ok(!r.html.includes('srcdoc'));assert.ok(r.html.includes('Content-Security-Policy'));
   assert.ok(r.html.includes('正常可读文字'));
  }));
 await test('JSON-LD多个条目选择与标题对应的文章，不拼入推荐正文',()=>capture(
  '<h1>主文章</h1><script type="application/ld+json">'+JSON.stringify({'@graph':[
   {'@type':'Article',headline:'主文章',articleBody:text},
   {'@type':'Article',headline:'推荐文章',articleBody:'推荐污染'+text.repeat(3)}
  ]})+'</script>',{},(h,r)=>{assert.equal(r.via,'json-ld');assert.ok(!r.md.includes('推荐污染'));assert.equal(r.meta.title,'主文章');}));
 await test('整页兜底明确标注待核对，并移除剪藏面板自身内容',()=>capture(
  '<p>不足以命中正文识别的普通内容，但仍有二十字以上可以保存。</p>',{},
  (h,r)=>{assert.equal(r.via,'fallback:body');assert.equal(r.meta.captureStatus,'needs-review');
   assert.ok(!r.md.includes('导出 MD'));assert.ok(r.warnings.length);}));
 await test('嵌套列表和有序列表起始编号保留',async()=>{
  const h=makeHarness('');
  try{
   const md=h.api.html2md('<ul><li>父项<ul><li>子项</li></ul></li></ul><ol start="3"><li>第三项</li></ol>');
   assert.match(md,/- 父项\n(?:\n)?  - 子项/);assert.ok(md.includes('3. 第三项'));
  }finally{h.close();}
 });

 await test('长页滚动到达底部才停止，非滚动容器回退窗口',async()=>{
  const h=makeHarness('<div id="timeline"><article><p>'+text+'</p></article></div>',
   {cfg:{autoScroll:true,scrollDelay:0,scrollMaxSteps:80}});
  try{
   let top=0;const height=20000;
   Object.defineProperty(h.w.document.documentElement,'scrollHeight',{get:()=>height});
   Object.defineProperty(h.w,'innerHeight',{value:800});
   Object.defineProperty(h.w,'scrollY',{get:()=>top});
   h.w.scrollBy=(x,y)=>{top=Math.min(height-800,top+y);};
   h.api.ADAPTERS.unshift({name:'测试容器',hosts:['example.com'],content:['article'],scroll:{container:'#timeline'}});
   await h.api.clip();const r=h.api.getLastClip();assert.ok(r);assert.equal(top,height-800);
   assert.ok(!r.warnings.some(x=>x.includes('滚动达到上限')));
   top=0;h.api.cfg.scrollMaxSteps=2;await h.api.clip();
   assert.ok(h.api.getLastClip().warnings.some(x=>x.includes('滚动达到上限')));
  }finally{h.close();}
 });
 await test('接口翻页部分成功后失败仍保存内容并标注中断',()=>capture('',{
  url:'https://xueqiu.com/123456789',cfg:{apiPaging:true,apiDelay:0,apiMaxPages:3},
  fetch:async path=>path.includes('page=1') ?
   {ok:true,json:async()=>({list:[{id:100,article:'<p>'+text+'</p>',user:{id:'123456789'}}]})} :
   {ok:false,status:429}
 },(h,r)=>{assert.ok(r.md.includes('正文讨论'));assert.ok(r.warnings.some(x=>x.includes('提前中断')));
   assert.equal(r.meta.captureStatus,'needs-review');assert.ok(r.md.includes('HTTP 429'));}));
 await test('接口达到页数上限明确标注并保留真实条目地址',()=>capture('',{
  url:'https://xueqiu.com/123456789',cfg:{apiPaging:true,apiDelay:0,apiMaxPages:1},
  fetch:async()=>({ok:true,json:async()=>({list:[{id:100,article:'<p>'+text+'</p>',user:{id:'123456789'}}]})})
 },(h,r)=>{assert.ok(r.md.includes('https://xueqiu.com/123456789/100'));assert.ok(r.warnings.some(x=>x.includes('翻页上限')));}));
 console.log('工作流通过 '+pass+' / 失败 0');
})().catch(e=>{console.error(e);process.exitCode=1;});
