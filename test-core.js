/**
 * 内核函数回归测试
 * 从 universal-clipper.user.js 中抽出纯函数，在 Node + jsdom 里跑真实网页结构
 */
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const SRC = fs.readFileSync(
  path.join(__dirname, 'universal-clipper.user.js'), 'utf-8');

/* ---------- 抽取内核纯函数（保持与源文件一致） ---------- */

function extractBlock(src, startMark, endMark) {
  const a = src.indexOf(startMark);
  const b = src.indexOf(endMark, a);
  if (a < 0 || b < 0) throw new Error('cannot locate: ' + startMark);
  return src.slice(a, b);
}

const BLOCKISH_SRC = `const BLOCKISH = new Set(['P','DIV','SECTION','ARTICLE','BLOCKQUOTE','UL','OL',
    'LI','TABLE','TR','PRE','H1','H2','H3','H4','H5','H6','HR','FIGURE','FIGCAPTION']);`;

const escapeMdSrc = extractBlock(SRC, 'function escapeMd(s) {', 'function html2md(');
const walkTidySrc = extractBlock(SRC, 'function walk(node, out) {', '/* ======');
const html2mdSrc = extractBlock(SRC, 'function html2md(htmlOrNode) {', 'function walk(node, out)');
const tidySrc = extractBlock(SRC, 'function tidy(s) {', '/* ======');
const yamlStrSrc = extractBlock(SRC, 'function yamlStr(s) {', 'function hostOf(');
const escFilenameSrc = extractBlock(SRC, 'function escFilename(s) {', 'function fmtDate(');
const absUrlSrc = extractBlock(SRC, 'function absUrl(u) {', 'function absAllUrls(');

const CORE = `
${BLOCKISH_SRC}
${escapeMdSrc}
${absUrlSrc}
${tidySrc}
${walkTidySrc}
${html2mdSrc}
${yamlStrSrc}
${escFilenameSrc}
return { escapeMd, html2md, tidy, yamlStr, escFilename };
`;

function makeCore(dom) {
  const { window } = dom;
  const fn = new window.Function(
    'document', 'Node', 'URL', 'location',
    CORE
  );
  return fn(window.document, window.Node, window.URL,
             { href: 'https://example.com/a' });
}

/* ---------- 测试用例 ---------- */

const CASES = [
  {
    name: '标准技术博客（含代码块/列表/表格/图片/链接）',
    html: `<article><h1>标题</h1>
      <p>这是<strong>加粗</strong>和<em>斜体</em>，还有<code>inline code</code>。</p>
      <ul><li>要点一</li><li>要点二</li></ul>
      <ol><li>第一</li><li>第二</li></ol>
      <pre><code class="language-js">const a = 1;
console.log(a);</code></pre>
      <table><thead><tr><th>字段</th><th>含义</th></tr></thead>
      <tbody><tr><td>id</td><td>标识</td></tr></tbody></table>
      <blockquote>引用一句话</blockquote>
      <p><img src="/img/a.png" alt="截图"> 和 <a href="/b">另一个页面</a></p>
      <hr><p>结尾。</p></article>`
  },
  {
    name: '知乎风格（RichContent + 嵌套 + 相对链接）',
    html: `<div class="RichContent-inner"><p>知乎回答正文，<b>重点</b>在这里。</p>
      <div class="RichText-inner"><p>嵌套段落</p></div>
      <p><a href="https://www.zhihu.com/question/1/answer/2">原问题</a></p></div>`
  },
  {
    name: '微信公众号（rich_media_content + 大量无关节点）',
    html: `<div class="rich_media_content" id="js_content">
      <p>公众号正文第一段。</p>
      <div class="comment"><p>不该出现的评论</p></div>
      <p>公众号正文第二段，有<a href="https://mp.weixin.qq.com/s?__biz=x">内部链接</a>。</p>
      <script>var x = 1;</script>
      <p>第三段。</p></div>`
  },
  {
    name: 'Reddit 风格（md 类名 + 深层嵌套）',
    html: `<div class="expando"><div class="md"><p>Reddit 正文</p>
      <p><a href="/r/x/comments/1/">permalink</a></p>
      <blockquote><p>嵌套引用</p><p>第二行</p></blockquote></div></div>`
  },
  {
    name: '技术文档（大量 pre/code + 定义列表式结构）',
    html: `<main><h2>API 文档</h2>
      <pre><code>def hello():
    return 1</code></pre>
      <h3>参数</h3><p><code>x</code> — 输入值</p>
      <pre><code>curl -X GET https://api.example.com</code></pre></main>`
  },
  {
    name: '边界：空内容',
    html: `<article></article>`
  },
  {
    name: '边界：纯图片页',
    html: `<div><img src="1.jpg" alt="a"><img src="2.jpg" alt="b"></div>`
  },
  {
    name: '特殊字符（管道符/星号/井号）',
    html: `<div><p>表格符 | 在正文，星号 * 星号，井号 # 标题</p>
      <p>1. 不是列表</p></div>`
  }
];

/* ---------- 行内连续性（防回归） ----------
 * 曾经的 bug：html2md 用 out.join('\n') 拼接，把
 * "这是**加粗**和"拆成多行，破坏 agent 解析的语义连续性。
 * 行内片段必须首尾相连。*/
const INLINE_CASES = [
  {
    name: '行内元素不得被拆行',
    html: '<article><p>这是<strong>加粗</strong>和<em>斜体</em>，还有<code>x</code>。</p></article>',
    expect: '这是**加粗**和*斜体*，还有`x`。',
    contains: true
  },
  {
    name: '链接与文字连续',
    html: '<p>详见<a href="https://e.com/x">这个页面</a>的说明。</p>',
    expect: '详见[这个页面](https://e.com/x)的说明。',
    contains: true
  },
  {
    name: '块级元素之间保留空行',
    html: '<div><p>第一段</p><p>第二段</p></div>',
    expect: '第一段\n\n第二段',
    contains: true
  }
];

/* ---------- YAML / 文件名 ---------- */

const YAML_CASES = [
  ['普通标题', '"普通标题"'],
  ['带: 冒号', '"带: 冒号"'],
  ['#井号开头', '"#井号开头"'],
  ['数字123', '"数字123"'],            // 非纯数字，裸值安全
  ['123', '"123"'],                 // 纯数字会被 YAML 解析成整数，必须加引号
  ['3.14', '"3.14"'],
  ['true', '"true"'],               // YAML 布尔字面量
  ['null', '"null"'],
  ['2026-10-07', '"2026-10-07"'],     // YAML 会当日期但仍可解析，保持原样可接受
  ['带"引号"', '"带\\"引号\\""'],
  ['a,b', '"a,b"'],
  ['[x]', '"[x]"'],
  ['', '""']
];

const FN_CASES = [
  ['正常标题', '正常标题'],
  ['a/b\\c:d*e?f"g<h>i|j', 'a-b-c-d-e-f-g-h-i-j'],
  ['有#标签', '有-标签'],
  ['   前后空格   ', '前后空格'],
  ['../../etc/passwd', 'etc-passwd']
];

/* ---------- 运行 ---------- */

let pass = 0, fail = 0;

function run() {
  for (const c of CASES) {
    const dom = new JSDOM(`<!doctype html><html><body>${c.html}</body></html>`);
    const core = makeCore(dom);
    try {
      const md = core.html2md(c.html);
      const expected = [
         ['这是**加粗**和*斜体*','const a = 1;','| 字段 | 含义 |','![截图](/img/a.png)'],
         ['知乎回答正文，**重点**在这里。','嵌套段落'],
         ['公众号正文第一段。','第三段。'],
         ['Reddit 正文','> 嵌套引用','[permalink](https://example.com/r/x/comments/1/)'],
         ['def hello():','    return 1','## API 文档'],
         [],
         ['![a](1.jpg)','![b](2.jpg)'],
         ['表格符 | 在正文','1\\. 不是列表']
       ][CASES.indexOf(c)];
       const ok = typeof md === 'string' && expected.every(t=>md.includes(t)) &&
         !md.includes('var x = 1;') && (c.html !== '<article></article>' || md === '');
      if (ok) { pass++; console.log(`  PASS  ${c.name}`); }
      else { fail++; console.log(`  FAIL  ${c.name} — 返回非字符串`); }
      if (process.env.SHOW) {
        console.log('    ── 长度 ' + md.length + ' ──');
        console.log(md.split('\n').slice(0, 18).map(l => '    | ' + l).join('\n'));
        console.log();
      }
    } catch (e) {
      fail++;
      console.log(`  FAIL  ${c.name} — ${e.message}`);
    }
  }

  console.log('\n--- 行内连续性（防回归） ---');
  for (const c of INLINE_CASES) {
    const dom = new JSDOM(`<!doctype html><html><body>${c.html}</body></html>`);
    const core = makeCore(dom);
    try {
      const md = core.html2md(c.html);
      if (md.includes(c.expect)) {
        pass++; console.log(`  PASS  ${c.name}`);
      } else {
        fail++;
        console.log(`  FAIL  ${c.name}`);
        console.log(`        期望包含: ${JSON.stringify(c.expect)}`);
        console.log(`        实际输出: ${JSON.stringify(md)}`);
      }
    } catch (e) {
      fail++; console.log(`  FAIL  ${c.name} — ${e.message}`);
    }
  }

  console.log('\n--- yamlStr ---');
  for (const [input, expect] of YAML_CASES) {
    const dom = new JSDOM('<!doctype html><body></body>');
    const core = makeCore(dom);
    const got = core.yamlStr(input);
    if (got === expect) { pass++; console.log(`  PASS  ${JSON.stringify(input)} → ${got}`); }
    else { fail++; console.log(`  FAIL  ${JSON.stringify(input)} → ${got} (期望 ${expect})`); }
  }

  console.log('\n--- escFilename ---');
  for (const [input, expect] of FN_CASES) {
    const dom = new JSDOM('<!doctype html><body></body>');
    const core = makeCore(dom);
    const got = core.escFilename(input);
    const good = got === expect && !/[\\/:*?"<>|#]/.test(got) && !/^\.\.?$/.test(got) && got.length > 0;
    if (good) { pass++; console.log(`  PASS  ${JSON.stringify(input)} → ${JSON.stringify(got)}`); }
    else { fail++; console.log(`  FAIL  ${JSON.stringify(input)} → ${JSON.stringify(got)} (含非法字符)`); }
  }

  console.log(`\n========== 通过 ${pass} / 失败 ${fail} ==========`);
  process.exit(fail ? 1 : 0);
}

run();