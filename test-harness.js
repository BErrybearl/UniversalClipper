const fs = require('node:fs');
const path = require('node:path');
const { JSDOM, VirtualConsole } = require('jsdom');
const SRC = fs.readFileSync(path.join(__dirname,'universal-clipper.user.js'),'utf8');
function makeHarness(html,opts={}) {
  const dom = new JSDOM('<!doctype html><html><head><title>测试文章</title></head><body>'+html+'</body></html>',{
    url:opts.url || 'https://example.com/article',runScripts:'outside-only',
    pretendToBeVisual:true,virtualConsole:new VirtualConsole()
  });
  const w=dom.window, downloads=[], requests=[], blobUrls=new Map();
  const stored=opts.stored || {},menus=[];
  const previous=Object.entries(stored).find(([key])=>key.endsWith('cfg'))?.[1] || {};
  const config=Object.assign({autoScroll:false,imageMode:'link',dedupe:false,outputFormat:'md'},previous,opts.cfg);
  w.GM_getValue=(key,def)=>key.endsWith('cfg') ? config : stored[key] || def;
  w.GM_setValue=(key,v)=>stored[key]=structuredClone(v);
  w.GM_registerMenuCommand=(name,callback)=>{menus.push({name,callback});return menus.length;};
  w.GM_xmlhttpRequest=details=>{
    requests.push(details);
    queueMicrotask(()=>{
      if (opts.gmRequest) opts.gmRequest(details);
      else details.onerror();
    });
    return {abort(){}};
  };
  w.TextEncoder=TextEncoder;w.Blob=Blob;w.ArrayBuffer=ArrayBuffer;
  w.URL.createObjectURL=blob=>{const key='blob:review-'+blobUrls.size;blobUrls.set(key,blob);return key;};
  w.URL.revokeObjectURL=()=>{};
  w.HTMLAnchorElement.prototype.click=function(){
    if (this.download) downloads.push({name:this.download,blob:blobUrls.get(this.href)});
  };
  if (opts.snowman) w.SNOWMAN_STATUS=opts.snowman;
  if (opts.fetch) w.fetch=opts.fetch;
  w.eval(SRC);
  return {dom,w,api:w.__universalClipper,downloads,requests,stored,menus,
    close:()=>dom.window.close(),
    export:()=>w.document.querySelector('#uclip-openmd').onclick()
  };
}
module.exports={makeHarness};
