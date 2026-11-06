const assert=require('node:assert/strict');
const {makeHarness}=require('./test-harness');
(async()=>{
 const h=makeHarness('',{url:'https://xueqiu.com/1247347556/409443228',snowman:[
  {id:409443228,type:3,title:'复盘：拿不住的原因',article:'<p>今天复盘 <strong>$SH600519$</strong> 这只票。</p><p>关注 #白酒# 板块。</p>',
   created_at:1767225720000,like_count:342,reply_count:58,retweet_count:91,user:{id:'1247347556',screen_name:'逸修'}},
  {id:409443229,type:0,text:'转发一个观点，稍后再看。正文内容足够。',
   created_at:1767225800000,user:{id:'1247347556',screen_name:'逸修'},
   retweet_status:{id:999,article:'<p>原文内容在此。</p>',user:{id:'777',screen_name:'某人'}}}
 ]});
 let count=0;
 const chk=(name,fn)=>{fn();count++;console.log('PASS '+name);};
 try {
  const adapter=h.api.findAdapter(h.w.location.href);
  const data=await adapter.source();
  chk('真实适配器返回两条',()=>assert.equal(data.items.length,2));
  chk('保留原文 id 和地址',()=>assert.equal(data.items[0].url,'https://xueqiu.com/1247347556/409443228'));
  chk('标题作者解析',()=>assert.equal(data.items[0].author,'逸修'));
  chk('互动数完整解析',()=>assert.deepEqual([data.items[0].likes,data.items[0].replies,data.items[0].retweets],[342,58,91]));
  await h.api.clip();
  const result=h.api.getLastClip();assert.ok(result);
  chk('整条流程保留行内连续性',()=>assert.ok(result.md.includes('今天复盘 **$SH600519$** 这只票。')));
  chk('股票代码和话题保留',()=>assert.ok(result.md.includes('SH600519') && result.md.includes('白酒')));
  chk('转发地址和原文保留',()=>assert.ok(result.md.includes('https://xueqiu.com/777/999') && result.md.includes('原文内容在此')));
  chk('毫秒时间戳正确',()=>assert.ok(result.md.includes('2026-01-01') && !result.md.includes('undefined')));
  console.log('通过 '+count+' / 失败 0');
 } finally {h.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
