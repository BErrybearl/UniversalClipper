/* ==================================================================
 * 雪球接口翻页数据源测试
 *
 * 测的是 universal-clipper.user.js 里雪球适配器的 source() 函数本身，
 * 从真实源文件中按括号配平提取，不用复刻版——复刻版会掩盖真实缺陷。
 *
 * 覆盖：
 *   1. SNOWMAN_STATUS 内嵌数据优先（不发起任何请求）
 *   2. apiPaging 关闭时不发请求
 *   3. apiPaging 开启且无内嵌数据时走接口翻页
 *   4. 翻页去重、条数上限、延迟间隔、错误中断
 * ================================================================== */

const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const SRC = fs.readFileSync(
  path.join(__dirname, 'universal-clipper.user.js'), 'utf-8');

/* ---------- 从真实源文件提取雪球 source 函数 ---------- */
function extractXueqiuSource() {
  const marker = 'source: async (adapter) => {';
  const i = SRC.indexOf(marker);
  if (i < 0) throw new Error('未找到雪球 source 函数');
  // 去掉 "source: " 前缀，得到一个箭头函数的表达式体
  const expr = SRC.slice(i + 'source: '.length);
  let d = 0, started = false, end = -1;
  for (let k = expr.indexOf('{'); k < expr.length; k++) {
    if (expr[k] === '{') { d++; started = true; }
    else if (expr[k] === '}') { d--; if (started && d === 0) { end = k; break; } }
  }
  if (end < 0) throw new Error('花括号配平失败');
  return expr.slice(0, end + 1);
}

const SRC_FN = extractXueqiuSource();

/* ---------- 测试脚手架 ---------- */
let pass = 0, fail = 0;
const failures = [];

function chk(name, cond, extra) {
  if (cond) { pass++; console.log('  \u2713 ' + name); }
  else { fail++; failures.push(name); console.log('  \u2717 ' + name + (extra ? '  → ' + extra : '')); }
}
function section(t) { console.log('\n--- ' + t + ' ---'); }

/**
 * 在给定的 window 环境下运行真实的 source 函数。
 * @param opts.snowman  window.SNOWMAN_STATUS 的值
 * @param opts.cfg      cfg 对象
 * @param opts.pathname location.pathname
 * @param opts.fetchImpl fetch 的模拟实现
 */
function runSource(opts) {
  const dom = new JSDOM('<!doctype html><html><body></body></html>');
  const w = dom.window;
  if (opts.snowman !== undefined) w.SNOWMAN_STATUS = opts.snowman;

  const sleep = ms => new Promise(r => setTimeout(r, 0)); // 测试里不真等

  const calls = [];
  const fetchImpl = async (p, init) => {
    calls.push(p);
    if (!opts.fetchImpl) throw new Error('不应发起请求');
    return opts.fetchImpl(p, calls.length);
  };

  const ui = { status: () => {} };
  const cfg = Object.assign(
    { apiPaging: false, apiMaxPages: 3, apiMaxItems: 100, apiDelay: 1200 },
    opts.cfg || {}
  );
  const location = { pathname: opts.pathname || '/', origin: 'https://xueqiu.com' };
  const log = () => {};

  const factory = new w.Function(
    'cfg', 'window', 'document', 'location', 'fetch', 'sleep', 'ui', 'log',
    'return (' + SRC_FN + ');'
  );
  const fn = factory(cfg, w, w.document, location, fetchImpl, sleep, ui, log);

  return fn({ name: '\u96ea\u7403' }).then(r => ({ result: r, calls }));
}

function jsonResp(obj, ok = true) {
  return { ok, json: async () => obj };
}

/* ==================================================================
 * 用例
 * ================================================================== */

async function main() {
  /* ---------- 1. SNOWMAN_STATUS 优先 ---------- */
  section('SNOWMAN_STATUS 优先，不发请求');
  {
    const snowman = [{
      id: 1, type: 3, title: '\u4e13\u680f\u6587\u7ae0',
      article: '<p>\u4eca\u5929\u590d\u76d8 <strong>$SH600519$</strong>\u3002</p>',
      created_at: 1767225720, like_count: 342, reply_count: 58, retweet_count: 91,
      user: { id: '1247347556', screen_name: '\u9038\u4fee' }
    }];
    const r2 = await runSource({snowman, cfg:{apiPaging:true}, pathname:'/1247347556'});
    chk('返回 items 数组', !!(r2.result && Array.isArray(r2.result.items)),
        JSON.stringify(r2.result).slice(0, 120));
    chk('未发起任何请求', r2.calls.length === 0, 'calls=' + r2.calls.length);
    if (r2.result && r2.result.items) {
      const it = r2.result.items[0];
      chk('标题解析正确', it.title === '\u4e13\u680f\u6587\u7ae0');
      chk('作者解析正确', it.author === '\u9038\u4fee');
      chk('互动数解析正确', it.likes === 342 && it.replies === 58 && it.retweets === 91);
      chk('类型识别为 article', it.type === 'article');
    }
  }

  /* ---------- 2. apiPaging 关闭 ---------- */
  section('apiPaging 关闭时不发请求');
  {
    const d = new JSDOM('<!doctype html><html><body></body></html>');
    const w = d.window;
    const calls = [];
    const cfg = { apiPaging: false, apiMaxPages: 3, apiMaxItems: 100, apiDelay: 0 };
    const location = { pathname: '/1247347556', origin: 'https://xueqiu.com' };
    const factory = new w.Function(
      'cfg', 'window', 'document', 'location', 'fetch', 'sleep', 'ui', 'log',
      'return (' + SRC_FN + ');'
    );
    const fn = factory(cfg, w, w.document, location,
      async p => { calls.push(p); throw new Error('不应发请求'); },
      () => Promise.resolve(), { status: () => {} }, () => {});
    const r = await fn({ name: '\u96ea\u7403' });
    chk('返回 null', r === null, JSON.stringify(r));
    chk('未发起请求', calls.length === 0);
  }

  /* ---------- 3. 接口翻页 ---------- */
  section('apiPaging 开启 → 走 user_timeline 接口翻页');
  {
    const d = new JSDOM('<!doctype html><html><body></body></html>');
    const w = d.window;
    const calls = [];
    const page1 = { list: [
      { id: 11, article: '<p>\u7b2c\u4e00\u7bc7\u4e13\u680f</p>', created_at: 100,
        user: { id: '1', screen_name: 'A' }, like_count: 5 },
      { id: 12, text: '<p>\u7b2c\u4e8c\u7bc7\u52a8\u6001</p>', created_at: 101,
        user: { id: '1', screen_name: 'A' } }
    ]};
    const page2 = { list: [
      { id: 12, text: '<p>\u91cd\u590d\u9879\u5e94\u88ab\u53bb\u91cd</p>', created_at: 101 }, // 重复
      { id: 13, article: '<p>\u7b2c\u4e09\u7bc7</p>', created_at: 102,
        user: { id: '1', screen_name: 'A' } }
    ]};
    const page3 = { list: [] };  // 空 → 中止

    const cfg = { apiPaging: true, apiMaxPages: 5, apiMaxItems: 100, apiDelay: 0 };
    const location = { pathname: '/1247347556', origin: 'https://xueqiu.com' };
    const factory = new w.Function(
      'cfg', 'window', 'document', 'location', 'fetch', 'sleep', 'ui', 'log',
      'return (' + SRC_FN + ');'
    );
    const fn = factory(cfg, w, w.document, location,
      async (p) => {
        calls.push(p);
        const m = /page=(\d+)/.exec(p);
        const pg = m ? +m[1] : 1;
        if (pg === 1) return jsonResp(page1);
        if (pg === 2) return jsonResp(page2);
        return jsonResp(page3);
      },
      () => Promise.resolve(), { status: () => {} }, () => {});

    const r = await fn({ name: '\u96ea\u7403' });
    chk('返回 items', !!(r && Array.isArray(r.items)));
    if (r && r.items) {
      chk('去重后共 3 条', r.items.length === 3, 'got ' + r.items.length);
      chk('按id 11,12,13 顺序', JSON.stringify(r.items.map(x=>x.id)) === '[11,12,13]');
      chk('article 识别为 article 类型', r.items[0].type === 'article');
      chk('text 识别为 status 类型', r.items[1].type === 'status');
      chk('无空 html 条目', r.items.every(x => x.html && x.html.length > 0));
    }
    chk('请求了 3 页后遇空页停止', calls.length === 3, 'calls=' + calls.length);
    chk('URL 指向 user_timeline 接口',
        calls.length > 0 && calls[0].indexOf('/v4/statuses/user_timeline.json') === 0, calls[0]);
    chk('URL 带 user_id 与 page', calls[0].indexOf('user_id=1247347556') > 0 && calls[0].indexOf('page=1') > 0);
  }

  /* ---------- 4. 条数上限 ---------- */
  section('apiMaxItems 上限生效');
  {
    const d = new JSDOM('<!doctype html><html><body></body></html>');
    const w = d.window;
    const calls = [];
    // 每页返回不同的 id，否则去重后永远只有第一页的 30 条
    const makePage = pg => ({ list: Array.from({ length: 30 }, (_, i) => ({
      id: pg * 1000 + i, article: '<p>page' + pg + ' item' + i + '</p>',
      created_at: pg * 100 + i, user: { id: '1', screen_name: 'A' }
    }))});
    const cfg = { apiPaging: true, apiMaxPages: 10, apiMaxItems: 40, apiDelay: 0 };
    const location = { pathname: '/1247347556', origin: 'https://xueqiu.com' };
    const factory = new w.Function(
      'cfg', 'window', 'document', 'location', 'fetch', 'sleep', 'ui', 'log',
      'return (' + SRC_FN + ');'
    );
    const fn = factory(cfg, w, w.document, location,
      async p => {
        calls.push(p);
        const m = /page=(\d+)/.exec(p);
        return jsonResp(makePage(m ? +m[1] : 1));
      },
      () => Promise.resolve(), { status: () => {} }, () => {});
    const r = await fn({ name: '\u96ea\u7403' });
    chk('不超过 apiMaxItems=40', r && r.items.length <= 40, 'got ' + (r ? r.items.length : 0));
    chk('确实取到接近上限的数量', r && r.items.length === 40, 'got ' + (r ? r.items.length : 0));
    chk('达到上限后停止请求', calls.length === 2, 'calls=' + calls.length);
  }

  /* ---------- 5. 专栏接口 ---------- */
  section('专栏路径走 column.json');
  {
    const d = new JSDOM('<!doctype html><html><body></body></html>');
    const w = d.window;
    const calls = [];
    const cfg = { apiPaging: true, apiMaxPages: 1, apiMaxItems: 100, apiDelay: 0 };
    // /1247347556/409443228 这类带动态 id 的路径 → 视为专栏/单篇
    const location = { pathname: '/1247347556/409443228', origin: 'https://xueqiu.com' };
    const factory = new w.Function(
      'cfg', 'window', 'document', 'location', 'fetch', 'sleep', 'ui', 'log',
      'return (' + SRC_FN + ');'
    );
    const fn = factory(cfg, w, w.document, location,
      async p => { calls.push(p); return jsonResp({ list: [] }); },
      () => Promise.resolve(), { status: () => {} }, () => {});
    const r = await fn({ name: '\u96ea\u7403' });
    chk('专栏路径使用 column.json',
        calls.length > 0 && calls[0].indexOf('/statuses/column.json') === 0,
        calls[0] || '(无请求)');
    chk('空列表时返回 null', r === null);
  }

  /* ---------- 6. 错误中断 ---------- */
  section('接口报错时安全降级');
  {
    const d = new JSDOM('<!doctype html><html><body></body></html>');
    const w = d.window;
    const cfg = { apiPaging: true, apiMaxPages: 5, apiMaxItems: 100, apiDelay: 0 };
    const location = { pathname: '/1247347556', origin: 'https://xueqiu.com' };
    const factory = new w.Function(
      'cfg', 'window', 'document', 'location', 'fetch', 'sleep', 'ui', 'log',
      'return (' + SRC_FN + ');'
    );
    const fn = factory(cfg, w, w.document, location,
      async () => { throw new Error('\u7f51\u7edc\u5f02\u5e38'); },
      () => Promise.resolve(), { status: () => {} }, () => {});
    let r, threw = false;
    try { r = await fn({ name: '\u96ea\u7403' }); } catch (e) { threw = true; }
    chk('fetch 抛错不外泄', !threw);
    chk('降级返回 null（交给DOM 兜底）', r === null, JSON.stringify(r));
  }

  /* ---------- 7. 非雪球路径 ---------- */
  section('URL 无用户 id 时不发请求');
  {
    const d = new JSDOM('<!doctype html><html><body></body></html>');
    const w = d.window;
    const calls = [];
    const cfg = { apiPaging: true, apiMaxPages: 5, apiMaxItems: 100, apiDelay: 0 };
    const location = { pathname: '/about', origin: 'https://xueqiu.com' };
    const factory = new w.Function(
      'cfg', 'window', 'document', 'location', 'fetch', 'sleep', 'ui', 'log',
      'return (' + SRC_FN + ');'
    );
    const fn = factory(cfg, w, w.document, location,
      async p => { calls.push(p); return jsonResp({ list: [] }); },
      () => Promise.resolve(), { status: () => {} }, () => {});
    const r = await fn({ name: '\u96ea\u7403' });
    chk('返回 null', r === null);
    chk('未发起请求', calls.length === 0);
  }

  /* ---------- 汇总 ---------- */
  console.log('\n' + '='.repeat(46));
  console.log('通过 ' + pass + '  失败 ' + fail);
  if (fail) {
    console.log('失败项：\n  - ' + failures.join('\n  - '));
  }
  console.log('='.repeat(46));
  process.exit(fail ? 1 : 0);
}

main().catch(e => {
  console.error('\n测试执行异常：', e);
  process.exit(1);
});
