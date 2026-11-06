// ==UserScript==
// @name         万能剪藏 · Universal Clipper
// @namespace    https://local.universal.clipper
// @version      1.3.0
// @description  通用网页剪藏：一键把文章、社区帖、文档、论坛内容转为本地 Markdown（含完整元数据与图片本地化）。内置站点适配器，可扩展。
// @author       -
// @match        *://*/*
// @exclude      *://localhost/*
// @exclude      *://127.0.0.1/*
// @exclude      *://*.google.com/search*
// @exclude      *://*.bing.com/search*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_xmlhttpRequest
// @grant        GM_registerMenuCommand
// @grant        unsafeWindow
// @connect      *
// @noframes
// @run-at       document-idle
// @noframes
// ==/UserScript==

/* ================================================================== *
 *  万能剪藏 · 架构说明
 *
 *  四层结构，每层独立可替换：
 *
 *    1) 内核 Kernel        —— 站点无关的通用能力
 *       · autoScroll        尝试滚动加载更多内容
 *       · extractContent    选区优先，其次专属数据源、正文选择器与通用提取
 *       · html2md           HTML → Markdown
 *       · buildMeta         YAML frontmatter 生成
 *       · localizeImages    图片本地化（并发 + 重试 + 降级）
 *
 *    2) 适配器 Adapters    —— 每站一小段配置，见 ADAPTERS
 *       每个适配器只负责三件事：
 *         content  正文选择器（可多个，按优先级）
 *         meta     元数据选择器
 *         scroll   滚动加载的容器与触发方式
 *         source   可选。站点专属数据源，同步或异步均可，返回 {items:[...]}。
 *                   用于接入内嵌 JSON（如雪球 SNOWMAN_STATUS）或站点接口翻页
 *                   （如雪球 user_timeline.json，需在设置里开启「接口翻页」）。
 *       未命中任何适配器时，走内核的启发式兜底
 *
 *    3) 输出 Output         —— 以 Markdown 为主，agent 易读
 *       · YAML frontmatter 完整元数据
 *       · 正文 Markdown
 *       · 图片本地化后相对路径引用
 *
 *    4) UI                  —— 面板 / 设置 / 快捷键
 *
 *  设计约束：适配器以声明为主，可用 source 提供专属数据源。新增一个站点通常
 *  只需要往ADAPTERS 里加 5~15 行配置，不需要动内核。
 * ================================================================== */

(function () {
  'use strict';

  const NS = 'univ_clipper_';

  /* ============================ 配置 ============================ */

  const DEFAULTS = {
    // 输出
    outputFormat: 'md',        // md | html | both
    imageMode: 'local',        // local | base64 | link
    imageQuality: 0.9,         // 预留配置（当前保留原图，不重压缩）
    maxImageKB: 1200,          // 单图超过则保留链接而非内联
    imageConcurrency: 4,
    localizeTimeout: 20000,
    saveSubfolder: '剪藏',

    // 元数据
    frontmatter: true,
    addSourceBlock: true,
    includeTags: true,
    collectInteractions: true,  // 记录点赞/评论/转发数（社区类站点有意义）
    dedupe: true,              // 同 URL 已剪过则提示

    // 滚动
    autoScroll: true,
    scrollMaxSteps: 60,
    scrollStableCount: 3,
    scrollDelay: 650,

    // 接口翻页（仅对提供 async source 的适配器生效，如雪球时间线/专栏）
    apiPaging: false,           // 默认关闭：多数场景不需要，且会产生额外请求
    apiMaxPages: 3,             // 最多翻几页
    apiMaxItems: 100,           // 最多取多少条
    apiDelay: 1200,             // 每页间隔(ms)，别调太小以免触发风控

    // 交互
    floatingBtn: true,
    floatingPosition: null,  // 归一化位置，跨页面保存并适应窗口尺寸
    shortcut: 'Alt+Shift+S',
    debug: false,

    // 预留（第一版不启用，接口已留好）
    aiEndpoint: '',
    aiModel: '',
    aiEnabled: false
  };

  const cfg = Object.assign({}, DEFAULTS, GM_getValue(NS + 'cfg', {}));
  const saveCfg = () => GM_setValue(NS + 'cfg', cfg);

  const state = {
    busy: false,
    abort: false,
    lastClip: null
  };

  const history = GM_getValue(NS + 'history', {}); // url -> {at, title}
  const saveHistory = () => GM_setValue(NS + 'history', history);

  /* ============================ 工具 ============================ */

  const log = (...a) => { if (cfg.debug) console.log('[万能剪藏]', ...a); };
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const nowSec = () => Date.now() / 1000;

  function escFilename(s) {
    return String(s || '')
      .replace(/[\\/:*?"<>|#%]/g, '-')
      .replace(/[\u0000-\u001f]/g, '')
      .replace(/\s+/g, ' ')
      .replace(/^[\s.\-]+|[\s.\-]+$/g, '')
      .slice(0, 100) || 'untitled';
  }

  function fmtDate(ts, withTime) {
    const value = Number(ts);
    const d = ts == null ? new Date() : new Date(Math.abs(value) >= 1e12 ? value : value * 1000);
    const p = n => String(n).padStart(2, '0');
    const date = d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
    return withTime ? date + ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) : date;
  }

  function absUrl(u) {
    if (!u) return '';
    try { return new URL(u, location.href).href; } catch (e) { return u; }
  }

  function absAllUrls(root) {
    if (!root) return root;
    root.querySelectorAll('img').forEach(el => {
      const lazy = el.getAttribute('data-src') || el.getAttribute('data-original') || el.getAttribute('data-lazy-src');
      const src = lazy || el.getAttribute('src') || el.currentSrc;
      if (src) el.setAttribute('src', absUrl(src));
      // Export the resolved image, not a responsive alternative that bypasses localization.
      el.removeAttribute('srcset');
      ['data-src','data-original','data-lazy-src','loading'].forEach(a => el.removeAttribute(a));
    });
    root.querySelectorAll('a[href]').forEach(el => el.setAttribute('href', absUrl(el.getAttribute('href'))));
    return root;
  }

  function yamlStr(s) {
    return JSON.stringify(String(s == null ? '' : s).replace(/\r?\n/g,' ').trim());
  }

  function hostOf(u) {
    try { return new URL(u || location.href).hostname.replace(/^www\./, ''); } catch (e) { return ''; }
  }

  /* ================================================================== *
   *  内核 1：自动滚动加载
   * ================================================================== */

  async function autoScroll(adapter) {
    if (!cfg.autoScroll) return { limited: false };
    const sel = adapter && adapter.scroll && adapter.scroll.container;
    const candidate = sel && document.querySelector(sel);
    const scrollable = candidate && candidate.scrollHeight > candidate.clientHeight + 4 &&
      /auto|scroll|overlay/.test(window.getComputedStyle(candidate).overflowY);
    const target = scrollable ? candidate : document.scrollingElement || document.documentElement;
    if (!target) return { limited: false };
    const isWindow = target === document.scrollingElement || target === document.documentElement;
    let stable = 0;
    for (let i = 1; i <= cfg.scrollMaxSteps && !state.abort; i++) {
      const before = target.scrollHeight;
      if (isWindow) window.scrollBy(0, Math.round(window.innerHeight * 0.9));
      else target.scrollTop += Math.round(target.clientHeight * 0.9);
      await sleep(cfg.scrollDelay);
      const more = adapter && adapter.scroll && adapter.scroll.moreSelector;
      const btn = more && document.querySelector(more);
      if (btn && !btn.disabled) { btn.click(); await sleep(cfg.scrollDelay); }
      const after = target.scrollHeight;
      const viewport = isWindow ? window.innerHeight : target.clientHeight;
      const pos = isWindow ? window.scrollY : target.scrollTop;
      const atBottom = pos + viewport >= after - 4;
      stable = atBottom && after === before ? stable + 1 : 0;
      ui.status('滚动加载中… 第 ' + i + ' 步，底部连续 ' + stable + ' 次无新增');
      if (stable >= cfg.scrollStableCount) return { limited: false };
    }
    return { limited: true };
  }

  /* ================================================================== *
   *  内核 2：正文提取（五级降级链）
   * ================================================================== */

  // 常见的"噪音容器"特征：命中则整体排除

  const NEGATIVE = [
    'nav', 'aside', '[role="navigation"]', '[role="banner"]', '[role="contentinfo"]',
    '.comment', '.comments', '.comment-list', '.comment-section', '.comment-area',
    '.comment-thread', '.comments-area', '.reply-list', '.replies',
    '.CommentList', '.Comments-container', '.ReplyList',
    '#comments', '#comment', '#comment-list', '#disqus_thread',
    '[data-testid="comment"]', '[data-testid="comment-list"]',
    '.sidebar', '.advertisement', '.ad', '.ads', '.recommend', '.recommendations',
    '.related', '.related-posts', '.recommended-posts', '.toolbar', '.breadcrumb',
    '.nav', '.navbar', '.site-header', '.site-footer', '.share', '.social',
    '#uclip-panel', '#uclip-fab'
  ];

  function isNoiseElement(el) {
    if (!el || !el.closest) return false;
    if (NEGATIVE.some(sel => { try { return !!el.closest(sel); } catch (e) { return false; } })) return true;
    const explicit = /^(?:comments?|replies|reply|recommend(?:ations|ed)?|related|sidebar|advertisement)(?:[-_]|list|section|area|thread|container|box|item|s$|$)/i;
    for (let cur=el;cur;cur=cur.parentElement) {
      if ([cur.id,...cur.classList].some(h=>explicit.test(h))) return true;
    }
    return false;
  }

  function removeNoise(root, adapter) {
    const kill = ['script','style','noscript','iframe','object','embed','svg','canvas','video','audio',
      'form','button','input','select','textarea','[hidden]','[aria-hidden="true"]','.hidden','.sr-only','.visually-hidden'];
    const sels = kill.concat(NEGATIVE, (adapter && adapter.exclude) || []);
    for (const sel of sels) {
      try { root.querySelectorAll(sel).forEach(el => el.remove()); } catch (e) { log('invalid noise selector',sel); }
    }
    // Class/id hints only identify explicit UI containers; avoid deleting code-comment spans.
    root.querySelectorAll('[class],[id]').forEach(el => {
      const hints = [el.id, ...el.classList];
      const explicit = /^(?:comments?|replies|reply|recommend(?:ations|ed)?|related|sidebar|advertisement)(?:[-_]|list|section|area|thread|container|box|item|s$|$)/i;
      if (hints.some(h => explicit.test(h))) el.remove();
    });
    root.querySelectorAll('*').forEach(el => {
      for (const attr of [...el.attributes]) {
        if (/^on/i.test(attr.name) || attr.name === 'srcdoc' ||
            (/^(?:href|src|xlink:href|action|formaction)$/i.test(attr.name) && /^\s*(?:javascript|vbscript):/i.test(attr.value))) {
          el.removeAttribute(attr.name);
        }
      }
    });
  }

  function cleanContent(el, adapter) {
    const clean = el.cloneNode(true);
    removeNoise(clean, adapter);
    absAllUrls(clean);
    return clean;
  }

  function textLen(el) { return (el.innerText || el.textContent || '').trim().length; }

  /** 链接密度：正文链接占比低，导航/列表页链接密度高 */
  function linkDensity(el) {
    const total = textLen(el);
    if (!total) return 1;
    let linkText = 0;
    el.querySelectorAll('a').forEach(a => { linkText += (a.innerText || a.textContent || '').trim().length; });
    return linkText / total;
  }

  /** 段落得分：p/pre/blockquote 数量与总字数加权，命中典型的正文特征 */
  function paragraphScore(el) {
    const ps = el.querySelectorAll('p').length;
    const pre = el.querySelectorAll('pre').length;
    const h = el.querySelectorAll('h1,h2,h3,h4').length;
    const t = textLen(el);
    let s = 0;
    s += ps * 12;
    s += pre * 8;
    s += h * 4;
    s += Math.min(t / 100, 40);          // 字数贡献，封顶
    s -= linkDensity(el) * 30;           // 链接密度惩罚
    if (t < 120) s -= 60;                // 太短不像正文
    return s;
  }

  /**
   * 提取正文。降级链，首选适配器自定义数据源。
   *
   * 适配器可选提供 source(adapter, ctx) 返回 {items:[...]}，
   * 可以是同步对象，也可以是 Promise（用于接入需要网络请求的站点接口，
   * 如雪球 user_timeline.json 翻页）。
   */
  async function extractContent(adapter) {
    const selection = window.getSelection && window.getSelection();
    if (selection && selection.rangeCount && selection.toString().trim().length >= 20 &&
        !isNoiseElement(selection.anchorNode && selection.anchorNode.parentElement)) {
      const holder = document.createElement('div');
      holder.appendChild(selection.getRangeAt(0).cloneContents());
      const clean = cleanContent(holder, adapter);
      if (textLen(clean) >= 20) return { el: clean, via: 'selection', confidence: 1, warnings: [] };
    }
    if (adapter && typeof adapter.source === 'function') {
      try {
        const custom = await adapter.source(adapter);
        if (custom && Array.isArray(custom.items) && custom.items.length) {
          return { items: custom.items, via: 'source:' + (adapter.name || 'custom'),
            confidence: 1, warnings: custom.warnings || [], coverage: custom.coverage || 'source' };
        }
      } catch (e) { log('adapter source failed:', e); }
    }
    const bestFrom = (sel, min) => {
      let nodes;
      try { nodes = [...document.querySelectorAll(sel)].filter(el => !isNoiseElement(el)); }
      catch (e) { return null; }
      const candidates = nodes.slice(0,100).map(el => cleanContent(el, adapter))
        .filter(el => textLen(el) >= min);
      candidates.sort((a,b) => paragraphScore(b) - paragraphScore(a));
      return candidates.length ? { el: candidates[0], warnings: candidates.length > 1 ?
        ['页面有多个正文候选，已选择得分最高的一处；可选中文字后重新剪藏。'] : [] } : null;
    };
    if (adapter && adapter.content) {
      for (const sel of [].concat(adapter.content)) {
        const best = bestFrom(sel,80);
        if (best) return Object.assign(best,{ via: 'adapter:' + sel, confidence: 0.95 });
      }
    }
    const ld = extractFromJsonLd();
    if (ld) return ld;
    const semantic = ['.article-content','.post-content','.entry-content','.rich_media_content',
      '#article','.markdown-body','.article-body','.post-body','article','main','[role="main"]'];
    for (const sel of semantic) {
      const best = bestFrom(sel,200);
      if (best && linkDensity(best.el) < 0.5) return Object.assign(best,{ via: 'semantic:' + sel, confidence: 0.8 });
    }
    const body = document.body && cleanContent(document.body, adapter);
    if (!body) return null;
    const cands = [...body.querySelectorAll('div,section,td,article,main')]
      .filter(el => textLen(el) > 200 && el.children.length < 200);
    let best = null, bestScore = 0;
    for (const el of cands) {
      const score = paragraphScore(el);
      if (score > bestScore) { best = el; bestScore = score; }
    }
    if (best && bestScore > 30) return { el: best, via: 'heuristic',
      confidence: Math.min(bestScore/100,0.7), warnings: ['正文由通用规则识别，请核对范围。'] };
    return { el: body, via: 'fallback:body', confidence: 0.2,
      warnings: ['未能定位正文，已提取清理后的整页内容；建议选中文字后重新剪藏。'] };
  }

  /** 从 JSON-LD / OpenGraph 提取文章正文（很多新闻站直接给 articleBody） */
  function extractFromJsonLd() {
    const articles = [];
    const visit = obj => {
      if (Array.isArray(obj)) return obj.forEach(visit);
      if (!obj || typeof obj !== 'object') return;
      if (obj['@graph']) visit(obj['@graph']);
      const types = [].concat(obj['@type'] || []);
      if (types.some(t => ['Article','NewsArticle','BlogPosting','TechArticle'].includes(t)) &&
          typeof obj.articleBody === 'string' && obj.articleBody.trim().length > 200) articles.push(obj);
    };
    document.querySelectorAll('script[type="application/ld+json"]').forEach(el => {
      try { visit(JSON.parse(el.textContent)); } catch (e) {}
    });
    if (!articles.length) return null;
    const title = firstText(document,['meta[property="og:title"]','h1']) || document.title;
    const score = a => (a.headline && title.includes(a.headline) ? 1e7 : 0) + a.articleBody.length;
    articles.sort((a,b) => score(b)-score(a));
    const a = articles[0], holder = document.createElement('div');
    holder.textContent = a.articleBody;
    return { el: holder, rawMarkdown: a.articleBody, via: 'json-ld', confidence: 0.9,
      warnings: [], meta: { title: a.headline, author: typeof a.author === 'string' ? a.author :
        (a.author && (a.author.name || a.author[0]?.name)), datePublished: a.datePublished,
        dateModified: a.dateModified } };
  }

  /* ================================================================== *
   *  内核 3：HTML → Markdown
   * ================================================================== */

  const BLOCKISH = new Set(['P','DIV','SECTION','ARTICLE','BLOCKQUOTE','UL','OL',
    'LI','TABLE','TR','PRE','H1','H2','H3','H4','H5','H6','HR','FIGURE','FIGCAPTION']);

  function escapeMd(s) {
    return String(s)
      .replace(/([\\`*_[\]<>])/g, '\\$1')
      // 行首标记转义：以真正的新行开头为界（(?:^|\n)），
      // 不能用 /m + $锚点 —— 传入的常是单个文本节点片段，
      // 用 $ 会在片段末尾产生意外换行，把内联元素拆成多行。
      .replace(/(^|\n)(#{1,6})([ \t])/g, '$1\\$2$3')
      .replace(/(^|\n)(\d+)\./g, '$1$2\\.')
      .replace(/(^|\n)([-*+])([ \t])/g, '$1\\$2$3');
  }

  function html2md(htmlOrNode) {
    let root = htmlOrNode;
    if (typeof htmlOrNode === 'string') {
      const tpl = document.createElement('template');
      tpl.innerHTML = htmlOrNode;
      root = tpl.content;
    }
    const out = [];
    walk(root, out);
    // 必须用 join('')，不能join('\n')：
    // out 里混合了「行内片段」与「块级分隔符」两类角色。
    // 行内片段（正文、**加粗**、链接）必须首尾相连，
    // 换行只在块级元素显式 push 的 '\n\n' 处产生。
    // 用 join('\n') 会把"这是**加粗**和"这种连续语句
    // 拆成多行，破坏语义连续性，agent 解析时尤其明显。
    return tidy(out.join(''));
  }

  function walk(node, out) {
    for (const c of node.childNodes) {
      if (c.nodeType === Node.TEXT_NODE) {
        out.push(escapeMd(c.nodeValue.replace(/\s+/g, ' ')));
        continue;
      }
      if (c.nodeType !== Node.ELEMENT_NODE) continue;

      const tag = c.tagName.toUpperCase();
      if (['SCRIPT','STYLE','NOSCRIPT','TEMPLATE'].includes(tag)) continue;

      switch (tag) {
        case 'BR': out.push('\n'); break;

        case 'HR': out.push('\n\n---\n\n'); break;

        case 'IMG': {
          const src = (c.getAttribute('src') || '').replace(/ /g,'%20').replace(/\(/g,'%28').replace(/\)/g,'%29');
          const alt = escapeMd((c.getAttribute('alt') || '').trim());
          const title = (c.getAttribute('title') || '').trim().replace(/"/g,'\\"');
          if (src) out.push(`\n\n![${alt}](${src}${title ? ' "' + title + '"' : ''})\n\n`);
          break;
        }

        case 'A': {
          const inner = []; walk(c, inner);
          const txt = inner.join('').trim();
          const href = absUrl(c.getAttribute('href') || '');
          if (!href || /^javascript:/i.test(href)) { out.push(txt); }
          else if (!txt) { out.push(href); }
          else out.push(`[${txt}](${href})`);
          break;
        }

        case 'STRONG': case 'B': {
          const i = []; walk(c, i);
          const t = i.join('').trim();
          out.push(t ? `**${t}**` : '');
          break;
        }

        case 'EM': case 'I': {
          const i = []; walk(c, i);
          const t = i.join('').trim();
          out.push(t ? `*${t}*` : '');
          break;
        }

        case 'DEL': case 'S': case 'STRIKE': {
          const i = []; walk(c, i);
          const t = i.join('').trim();
          out.push(t ? `~~${t}~~` : '');
          break;
        }

        case 'CODE': {
          if (c.parentElement && c.parentElement.tagName.toUpperCase() === 'PRE') break;
          const i = []; walk(c, i);
          out.push('`' + i.join('').replace(/`/g, '') + '`');
          break;
        }

        case 'PRE': {
          const code = (c.textContent || '').replace(/\n+$/, '');
          const lang = ((c.querySelector('code') || {}).className || '')
            .match(/language-([\w+#-]+)/)?.[1] || '';
          out.push(`\n\n\`\`\`${lang}\n${code}\n\`\`\`\n\n`);
          break;
        }

        case 'BLOCKQUOTE': {
          const i = []; walk(c, i);
          const t = tidy(i.join('')).split('\n').map(l => '> ' + l).join('\n');
          out.push('\n\n' + t + '\n\n');
          break;
        }


        case 'UL': case 'OL': {
          let n = Number(c.getAttribute('start')) || 1;
          out.push('\n\n');
          for (const li of c.children) {
            if (li.tagName.toUpperCase() !== 'LI') continue;
            const parts = []; walk(li,parts);
            const lines = tidy(parts.join('')).split('\n');
            const marker = tag === 'OL' ? n + '. ' : '- ';
            out.push(marker + (lines.shift() || '') + '\n');
            for (const line of lines) out.push(line ? ' '.repeat(marker.length) + line + '\n' : '\n');
            n++;
          }
          out.push('\n');
          break;
        }

        case 'TABLE': {
          const rows = [...c.querySelectorAll('tr')].map(tr =>
            [...tr.children].map(td => {
              const o = []; walk(td, o);
              return tidy(o.join(' ')).replace(/\|/g, '\\|');
            })
          ).filter(r => r.length && r.some(x => x.trim()));
          if (!rows.length) break;

          const width = Math.max(...rows.map(r => r.length));
          const pad = r => { const x = r.slice(); while (x.length < width) x.push(''); return x; };
          const head = pad(rows[0]);
          out.push('\n\n| ' + head.join(' | ') + ' |\n');
          out.push('| ' + head.map(() => '---').join(' | ') + ' |\n');
          for (const r of rows.slice(1)) out.push('| ' + pad(r).join(' | ') + ' |\n');
          out.push('\n');
          break;
        }

        case 'H1': case 'H2': case 'H3': case 'H4': case 'H5': case 'H6': {
          const lv = Number(tag[1]);
          const i = []; walk(c, i);
          const t = tidy(i.join(' '));
          if (t) out.push(`\n\n${'#'.repeat(lv)} ${t}\n\n`);
          break;
        }

        case 'DEL_': case 'INS': {
          const i = []; walk(c, i);
          out.push(i.join(''));
          break;
        }

        default: {
          if (BLOCKISH.has(tag)) {
            out.push('\n\n'); walk(c, out); out.push('\n\n');
          } else {
            walk(c, out);
          }
        }
      }
    }
  }

  function tidy(s) {
    return String(s)
      .replace(/\u00a0/g, ' ')
      .replace(/[ \t]+$/gm, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  /* ================================================================== *
   *  内核 4：元数据提取
   * ================================================================== */

  function firstText(root, sels) {
    if (!root) return '';
    for (const s of sels) {
      let el = null;
      try { el = root.querySelector(s); } catch (e) { continue; }
      if (!el) continue;
      const v = (el.getAttribute('content') || el.getAttribute('datetime') ||
                 el.innerText || el.textContent || '').trim();
      if (v) return v;
    }
    return '';
  }

  function extractMeta(adapter, ldMeta) {
    const m = Object.assign({}, ldMeta || {});

    // OpenGraph 优先
    const og = n => firstText(document, [`meta[property="og:${n}"]`, `meta[name="og:${n}"]`]);

    m.title = m.title || og('title') || firstText(document, ['h1']) || document.title || '';
    m.title = m.title.trim();

    m.author = m.author
      || og('article:author')
      || firstText(document, [
        'meta[name="author"]', 'meta[property="article:author"]',
        '[rel="author"]', '.author-name', '.author', '.byline', '.post-author',
        '[itemprop="author"] [itemprop="name"]'
      ]);

    m.description = m.description || og('description')
      || firstText(document, ['meta[name="description"]', 'meta[property="og:description"]']);

    m.siteName = m.siteName || og('site_name') || hostOf(location.href);

    // 时间：优先结构化数据，其次 <time datetime>，再次适配器选择器
    m.datePublished = m.datePublished
      || firstText(document, ['meta[property="article:published_time"]',
                              'meta[name="publishdate"]', 'meta[itemprop="datePublished"]'])
      || firstText(document, ['time[datetime]', 'time']);
    m.dateModified = m.dateModified
      || firstText(document, ['meta[property="article:modified_time"]']);

    if (adapter && adapter.meta) {
      const extra = adapter.meta();
      for (const k in extra) {
        if (extra[k] && !m[k]) m[k] = extra[k];
      }
    }

    m.url = location.href;
    m.domain = hostOf(location.href);
    return m;
  }

  function parseDate(s) {
    if (!s) return null;
    const t = Date.parse(s);
    if (!isNaN(t)) return t / 1000;
    // 相对时间：3小时前 / 昨天 / 2天前
    const rel = String(s).match(/(\d+)\s*(秒|分钟|小时|天|周|个月|月|年)前/);
    if (rel) {
      const n = Number(rel[1]);
      const unit = { '秒':1,'分钟':60,'小时':3600,'天':86400,'周':604800,
                     '个月':2592000,'月':2592000,'年':31536000 }[rel[2]];
      if (unit) return nowSec() - n * unit;
    }
    if (/今天/.test(s)) return nowSec();
    if (/昨天/.test(s)) return nowSec() - 86400;
    return null;
  }

  function extractTags(meta, contentText, root) {
    const tags = new Set();

    // 页面内的标签/分类链接
    if (cfg.includeTags) {
      (root || document).querySelectorAll('a[href*="/tag/"], a[href*="/category/"], a[href*="/labels/"], .tag, .tags a, .category a')
        .forEach(el => {
          const t = (el.innerText || el.textContent || '').trim();
          if (t && t.length <= 20 && t.length > 1) tags.add(t);
        });
    }

    // 正文里的 #话题#
    const re = /#([^#\n<>]{1,30})#/g;
    let m;
    const text = contentText || '';
    while ((m = re.exec(text))) tags.add(m[1].trim());

    return [...tags].filter(Boolean).slice(0, 12);
  }

  /* ================================================================== *
   *  内核 5：图片本地化
   * ================================================================== */

  function guessExt(ct, url) {
    const u = (url || '').split('?')[0];
    const m = u.match(/\.(jpe?g|png|gif|webp|svg|avif)$/i);
    if (m) return '.' + m[1].toLowerCase().replace('jpeg', 'jpg');
    const map = { 'image/jpeg':'jpg', 'image/jpg':'jpg', 'image/png':'png', 'image/gif':'gif',
                  'image/webp':'webp', 'image/svg+xml':'svg', 'image/avif':'avif' };
    return '.' + (map[(ct || '').toLowerCase()] || 'jpg');
  }

  function fetchBlob(url, timeout) {
    return new Promise((resolve,reject) => {
      GM_xmlhttpRequest({
        method: 'GET', url, timeout, responseType: 'blob', anonymous: false,
        onload: r => {
          const match = (r.responseHeaders || '').match(/content-type:\s*([^\r\n;]+)/i);
          const type = (match ? match[1] : r.response && r.response.type || '').trim().toLowerCase();
          if (r.status < 200 || r.status >= 300) return reject(new Error('HTTP ' + r.status));
          if (!/^image\//.test(type)) return reject(new Error('response is not an image'));
          if (!r.response || !(r.response instanceof Blob || r.response instanceof ArrayBuffer)) {
            return reject(new Error('response is not binary'));
          }
          const blob = r.response instanceof Blob ? r.response : new Blob([r.response],{type});
          if (!blob.size) return reject(new Error('empty image'));
          resolve({blob,type});
        },
        onerror: () => reject(new Error('network error')),
        ontimeout: () => reject(new Error('timeout'))
      });
    });
  }

  async function blobToDataUrl(blob) {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let binary = '';
    for (let i=0;i<bytes.length;i+=32768) binary += String.fromCharCode(...bytes.subarray(i,i+32768));
    return 'data:' + (blob.type || 'application/octet-stream') + ';base64,' + btoa(binary);
  }

  /**
   * 把 Markdown 里的图片 URL 换成本地相对路径。
   * 产物：一个 zip-ready 的 { 'images/xx.jpg': ArrayBuffer } 映射，
   * 由调用方决定如何落盘（本脚本用多文件下载 + 单文件 HTML 内联）。
   */
  async function localizeImages(markdown, meta, hooks) {
    const re = /!\[(?:\\.|[^\]\\])*\]\((https?:[^\s)]+)(?:\s+"(?:\\.|[^"])*")?\)/g;
    const urls = [...new Set([...markdown.matchAll(re)].map(m=>m[1]))];
    const replacements = new Map();
    const assets = [], failed = [];
    if (cfg.imageMode === 'link') return { md: markdown, assets, failed, replacements,
      total: urls.length, localized: 0 };
    const folder = escFilename(cfg.saveSubfolder || '剪藏');
    const slug = escFilename(meta.title || 'page').slice(0,40);
    const queue = urls.map((url,i)=>({url,index:i+1}));
    let done = 0;
    const work = async () => {
      while (queue.length && !state.abort) {
        const {url,index} = queue.shift();
        try {
          let image;
          for (let attempt=0;attempt<2;attempt++) {
            try { image = await fetchBlob(url,cfg.localizeTimeout); break; }
            catch (e) { if (attempt === 1) throw e; await sleep(250); }
          }
          const {blob,type} = image;
          if (blob.size > Number(cfg.maxImageKB)*1024) throw new Error('image exceeds size limit');
          const name = slug + '-img' + String(index).padStart(2,'0') + guessExt(type,url);
          if (cfg.imageMode === 'base64') replacements.set(url,await blobToDataUrl(blob));
          else {
            const path = folder + '/' + name;
            replacements.set(url,encodeURI(path).replace(/\(/g,'%28').replace(/\)/g,'%29'));
            assets.push({name,path,blob,url});
          }
        } catch (e) { failed.push(url); log('img fail',url,e.message); }
        done++;
        if (hooks && hooks.onProgress) hooks.onProgress(done,urls.length);
      }
    };
    await Promise.all(Array.from({length:Math.max(1,Math.min(cfg.imageConcurrency,6))},work));
    const md = markdown.replace(re,(full,url)=> replacements.has(url) ?
      full.replace('(' + url,'(' + replacements.get(url)) : full);
    return {md,assets,failed,replacements,total:urls.length,localized:replacements.size};
  }

  /* ================================================================== *
   *  输出层：Markdown 组装
   * ================================================================== */

  function buildMarkdown(meta, contentMd, quoteMd, tickers, options = {}) {
    const parts = [];

    if (options.frontmatter == null ? cfg.frontmatter : options.frontmatter) {
      const y = ['---'];
      y.push(`title: ${yamlStr(meta.title)}`);
      y.push(`url: ${yamlStr(meta.url)}`);
      y.push(`source: ${yamlStr(meta.domain)}`);
      if (meta.author) y.push(`author: ${yamlStr(meta.author)}`);
      if (meta.authorId) y.push(`authorId: ${yamlStr(meta.authorId)}`);
      if (meta.datePublished) y.push(`published: ${yamlStr(meta.datePublished)}`);
      if (meta.dateModified && meta.dateModified !== meta.datePublished) {
        y.push(`modified: ${yamlStr(meta.dateModified)}`);
      }
      if (meta.siteName) y.push(`site: ${yamlStr(meta.siteName)}`);
      if (meta.tags && meta.tags.length) y.push(`tags: [${meta.tags.map(yamlStr).join(', ')}]`);
      if (tickers && tickers.length) y.push(`tickers: [${tickers.join(', ')}]`);
      if (cfg.collectInteractions) {
        if (meta.likes != null) y.push(`likes: ${meta.likes}`);
        if (meta.replies != null) y.push(`replies: ${meta.replies}`);
        if (meta.retweets != null) y.push(`retweets: ${meta.retweets}`);
      }
      if (meta.retweetedStatus) y.push(`retweetOf: ${yamlStr(meta.retweetedStatus)}`);
      if (meta.type) y.push(`type: ${yamlStr(meta.type)}`);
      if (meta.itemCount) y.push('items: ' + meta.itemCount);
      if (meta.wordCount) y.push(`words: ${meta.wordCount}`);
      if (meta.clipVia) y.push(`clippedVia: ${yamlStr(meta.clipVia)}`);
      y.push('clippedAt: ' + yamlStr(fmtDate(nowSec(), true)));
      if (meta.extractVia) y.push('extraction: ' + yamlStr(meta.extractVia));
      if (meta.captureStatus) y.push('captureStatus: ' + yamlStr(meta.captureStatus));
      if (meta.captureWarnings && meta.captureWarnings.length) y.push('captureWarnings: [' + meta.captureWarnings.map(yamlStr).join(', ') + ']');
      y.push('---');
      parts.push(y.join('\n'));
    }

    let body = '';
    if (options.sourceBlock == null ? cfg.addSourceBlock : options.sourceBlock) {
      body += `> **${meta.title || '无标题'}**\n`;
      if (meta.author) body += `> 作者：${meta.author}\n`;
      if (meta.datePublished) body += `> 发布：${meta.datePublished}\n`;
      if (meta.description) body += `> 摘要：${meta.description}\n`;
      body += `> 来源：[${meta.domain}](${meta.url})\n\n`;
      if (cfg.collectInteractions && meta.likes != null) {
        body += '> 点赞：' + meta.likes + ' · 评论：' + (meta.replies || 0) + ' · 转发：' + (meta.retweets || 0) + '\n\n';
      }
    }

    body += contentMd;

    if (quoteMd) {
      body += `\n\n## 转发原文\n\n${quoteMd}`;
    }

    if (tickers && tickers.length) {
      body += `\n\n---\n\n\`\`\`\`${tickers.map(t => '$' + t + '$').join(' ')}\`\`\`\`\n`;
    }

    parts.push(body);
    return parts.join('\n\n').replace(/\n{3,}/g, '\n\n') + '\n';
  }

  function buildHtml(meta, contentEl, images) {
    const clone = contentEl.cloneNode(true);
    removeNoise(clone);
    absAllUrls(clone);
    if (images && images.replacements) clone.querySelectorAll('img[src]').forEach(img => {
      const key = (img.getAttribute('src') || '').replace(/ /g,'%20').replace(/\(/g,'%28').replace(/\)/g,'%29');
      if (images.replacements.has(key)) img.setAttribute('src',images.replacements.get(key));
    });

    const title = meta.title || document.title;
    return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src 'self' data: http: https:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title>
<meta name="clipped-from" content="${escapeHtml(meta.url)}">
${meta.author ? `<meta name="author" content="${escapeHtml(meta.author)}">` : ''}
${meta.datePublished ? `<meta name="published" content="${escapeHtml(meta.datePublished)}">` : ''}
<style>
  :root{--fg:#1f2328;--bg:#fff;--muted:#6b7280;--bd:#d1d9e0;--ac:#0969da}
  @media (prefers-color-scheme:dark){:root{--fg:#e6edf3;--bg:#0d1117;--bd:#30363d;--muted:#8b949e;--ac:#4493f8}}
  *{box-sizing:border-box}
  body{max-width:46em;margin:0 auto;padding:48px 24px 96px;
    font:16px/1.75 -apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif;
    color:var(--fg);background:var(--bg);-webkit-font-smoothing:antialiased}
  h1,h2,h3,h4{line-height:1.3;margin:1.6em 0 .6em;font-weight:600}
  h1{font-size:1.9em;margin-top:0}h2{font-size:1.45em;padding-bottom:.3em;border-bottom:1px solid var(--bd)}
  h3{font-size:1.2em}
  p{margin:1em 0}
  a{color:var(--ac);text-decoration:none}a:hover{text-decoration:underline}
  img{max-width:100%;height:auto;border-radius:6px;margin:.4em 0}
  pre{background:color-mix(in srgb,var(--fg) 7%,transparent);padding:16px;border-radius:8px;
    overflow:auto;font:13px/1.6 ui-monospace,SFMono-Regular,Consolas,monospace}
  code{background:color-mix(in srgb,var(--fg) 8%,transparent);padding:.15em .4em;border-radius:4px;
    font:13px ui-monospace,SFMono-Regular,Consolas,monospace}
  pre code{background:none;padding:0}
  blockquote{margin:1em 0;padding:.2em 1em;border-left:3px solid var(--bd);color:var(--muted)}
  table{border-collapse:collapse;width:100%;margin:1em 0;font-size:.94em}
  th,td{border:1px solid var(--bd);padding:8px 12px;text-align:left}
  th{background:color-mix(in srgb,var(--fg) 5%,transparent)}
  hr{border:none;border-top:1px solid var(--bd);margin:2em 0}
  .meta{color:var(--muted);font-size:.92em;border-bottom:1px solid var(--bd);padding-bottom:16px;margin-bottom:28px}
  .meta a{color:var(--muted)}
</style>
</head>
<body>
<article>
<div class="meta">
  ${meta.author ? `<div>作者：${escapeHtml(meta.author)}</div>` : ''}
  ${meta.datePublished ? `<div>发布：${escapeHtml(meta.datePublished)}</div>` : ''}
  <div>来源：<a href="${escapeHtml(meta.url)}">${escapeHtml(meta.domain)}</a></div>
  <div>剪藏于 ${fmtDate(nowSec(), true)}</div>
</div>
${clone.innerHTML}
</article>
</body>
</html>`;
  }

  function escapeHtml(s) {
    return String(s || '').replace(/[&<>"']/g, c =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  /* ================================================================== *
   *  站点适配器注册表
   *
   *  每个适配器只需声明选择器与滚动策略。新增站点改这里即可，
   *  不需要动内核。match 用 URL 正则；content/meta/scroll 见上。
   * ================================================================== */

  const ADAPTERS = [
    /* ---------- 中文社区 ---------- */
    {
      name: '知乎',
      hosts: ['zhihu.com'],
      match: /(?:^|\.)zhihu\.com/,
      content: ['.RichContent-inner', '.Post-RichTextContainer', '.QuestionAnswer-content',
                '.RichText', 'article.Post', '.List-item .RichContent-inner'],
      meta: () => ({
        author: firstText(document, ['.AuthorInfo-name', '.Profile-name', '.name']),
        datePublished: firstText(document, ['time[itemprop="dateCreated"]', '.ContentItem-time'])
      }),
      scroll: { container: '.ContentTimeline-list, .List' }
    },
    {
      name: '微信公众号',
      hosts: ['mp.weixin.qq.com'],
      match: /mp\.weixin\.qq\.com/,
      content: ['#js_content', '.rich_media_content', '#img-content'],
      meta: () => ({
        author: firstText(document, ['#js_name', '.rich_media_meta_nickname', '.wx_follow_nickname']),
        datePublished: firstText(document, ['#publish_time', '.rich_media_meta_text em']),
        siteName: firstText(document, ['#js_profile_qrcode_title', '.profile_nickname']) || '微信公众号'
      })
    },
    {
      name: '小红书',
      hosts: ['xiaohongshu.com', 'xhslink.com'],
      match: /(?:^|\.)xiaohongshu\.com|(?:^|\.)xhslink\.com/,
      content: ['#noteContainer .note-content', '.note-content', '#detail-desc', '.desc'],
      meta: () => ({
        author: firstText(document, ['.author-wrapper .username', '.user-name', '.author .name']),
        datePublished: firstText(document, ['.bottom-container .date', '.date', 'span.date']),
        title: firstText(document, ['#detail-title', '.title'])
      })
    },
    {
      name: '哔哩哔哩',
      hosts: ['bilibili.com'],
      match: /(?:^|\.)bilibili\.com/,
      content: ['.article-holder', '.video-desc-container', '#viewbox_report', '.rich_text_area'],
      meta: () => ({
        title: firstText(document, ['h1.video-title', '.video-title', 'h1']),
        author: firstText(document, ['.up-name', '.username']),
        datePublished: firstText(document, ['.pubdate', '.video-pubdate', 'time'])
      }),
      scroll: { container: '#app .video-info-v1' }
    },
    {
      name: '豆瓣',
      hosts: ['douban.com'],
      match: /(?:^|\.)douban\.com/,
      content: ['.note-content', '.topic-content', '#main .article', '.bb-nc'],
      meta: () => ({
        author: firstText(document, ['.author .name', '.note-author']),
        title: firstText(document, ['.note-title h1', 'h1.title'])
      })
    },
    {
      name: '雪球',
      hosts: ['xueqiu.com'],
      match: /(?:^|\.)xueqiu\.com/,
      content: ['.status-content', '.status-body', '.article__bd__detail', '.detail-body'],
      meta: () => ({
        author: firstText(document, ['.status-name', '.name']),
        datePublished: firstText(document, ['a.status-time', '.status-time', 'time'])
      }),
      scroll: { container: '#timeline' },

      // 雪球专属数据源：页面内嵌的 SNOWMAN_STATUS 全量 JSON。
      // 比 DOM 干净得多（标题/正文/时间/互动数齐全），是雪球的最优路径。
      //
      // 若开启设置里的「接口翻页」且本页没拿到内嵌数据，则退回同源接口分页取全量：
      //   /v4/statuses/user_timeline.json  用户时间线
      //   /statuses/column.json             专栏列表
      // 同源 fetch 会自动带上页面已有的登录 cookie，无需手工管理 token。
      source: async (adapter) => {
        const fromSnowman = () => {
          const pageWindow = typeof unsafeWindow === 'undefined' ? window : unsafeWindow;
          const arr = pageWindow.SNOWMAN_STATUS;
          if (!Array.isArray(arr) || !arr.length) return null;
          const items = arr
            .filter(x => x && (x.article || x.text))
            .map(x => {
              const html = x.article || x.text || '';
              const plain = html.replace(/<[^>]+>/g, '');
              return {
                id: x.id,
                url: x.user && x.id ? 'https://xueqiu.com/' + (x.user.id || x.user.uid) + '/' + x.id : location.href,
                title: x.title || plain.slice(0, 40),
                html,
                createdAt: x.created_at,
                author: x.user && (x.user.screen_name || x.user.name),
                authorId: x.user && (x.user.id || x.user.uid),
                likes: x.like_count,
                replies: x.reply_count,
                retweets: x.retweet_count,
                retweetedStatus: x.retweet_status && x.retweet_status.user
                  ? `https://xueqiu.com/${x.retweet_status.user.id || x.retweet_status.user.uid}/${x.retweet_status.id}`
                  : '',
                quoteHtml: x.retweet_status ? (x.retweet_status.article || x.retweet_status.text || '') : '',
                type: x.type === 3 ? 'article' : 'status'
              };
            })
            .filter(x => x.html);
          return items.length ? items : null;
        };

        const direct = fromSnowman();
        if (direct || !cfg.apiPaging) return direct ? { items: direct } : null;

        // ---- 接口翻页 ----
        const m = location.pathname.match(/\/(\d{6,})(?:$|\/(\d+))/);
        const userId = m && m[1];
        if (!userId) return null;

        const isColumn = /\/(?:column|c\/)/.test(location.pathname) || !!m[2];
        const seen = new Set();
        const out = [];
        const warnings = [];
        let exhausted = false, lastPage = 0;
        const fetchPage = async path => {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(),cfg.localizeTimeout || 20000);
          try {
            const res = await fetch(path,{credentials:'include',headers:{Accept:'application/json'},signal:controller.signal});
            if (!res.ok) throw new Error('HTTP ' + res.status);
            return await res.json();
          } finally { clearTimeout(timer); }
        };

        for (let page = 1; page <= cfg.apiMaxPages && out.length < cfg.apiMaxItems; page++) {
          const path = isColumn
            ? `/statuses/column.json?uid=${encodeURIComponent(userId)}&page=${page}&size=30`
            : `/v4/statuses/user_timeline.json?user_id=${encodeURIComponent(userId)}&page=${page}&size=30`;
          try {
            lastPage = page;
            const json = await fetchPage(path);
            if (json.error_description) throw new Error(json.error_description);

            const list = json && (json.list ||
              (json.items && json.items.map(it => it.status)) || json.statuses);
            if (!list || !list.length) { exhausted = true; break; }

            for (const s0 of list) {
              const s = s0 && s0.status ? s0.status : s0;
              if (!s || !s.id || seen.has(s.id)) continue;
              const html = s.article || s.text || '';
              if (!html) continue;
              seen.add(s.id);
              out.push({
                id: s.id,
                url: s.user && s.id ? 'https://xueqiu.com/' + (s.user.id || s.user.uid) + '/' + s.id : location.href,
                title: s.title || html.replace(/<[^>]+>/g, '').slice(0, 40),
                html,
                createdAt: s.created_at,
                author: s.user && (s.user.screen_name || s.user.name),
                authorId: s.user && (s.user.id || s.user.uid),
                likes: s.like_count,
                replies: s.reply_count != null ? s.reply_count : s.comment_count,
                retweets: s.retweet_count,
                retweetedStatus: s.retweet_status && s.retweet_status.user
                  ? `https://xueqiu.com/${s.retweet_status.user.id || s.retweet_status.user.uid}/${s.retweet_status.id}`
                  : '',
                quoteHtml: s.retweet_status ? (s.retweet_status.article || s.retweet_status.text || '') : '',
                type: s.article ? 'article' : 'status'
              });
              if (out.length >= cfg.apiMaxItems) break;
            }
            ui.status(`接口翻页 ${page}/${cfg.apiMaxPages}，已取 ${out.length} 条`);
            if (page < cfg.apiMaxPages && out.length < cfg.apiMaxItems) await sleep(cfg.apiDelay);
          } catch (e) {
            warnings.push('接口翻页提前中断：' + e.message);
            log('xueqiu api page fail:', e);
            break;
          }
        }
        if (out.length >= cfg.apiMaxItems) warnings.push('已达到条数上限，结果可能不是全部历史。');
        else if (!exhausted && lastPage >= cfg.apiMaxPages) warnings.push('已达到翻页上限，结果可能不是全部历史。');
        return out.length ? { items: out, warnings, coverage: 'paged' } : null;
      }
    },

    /* ---------- 海外 ---------- */
    {
      name: 'Twitter/X',
      hosts: ['twitter.com', 'x.com'],
      match: /(?:^|\.)twitter\.com|(?:^|\.)x\.com/,
      content: ['article[data-testid="tweet"]', '.tweet-text', '[data-testid="tweetText"]'],
      meta: () => ({
        author: firstText(document, ['[data-testid="User-Name"]', '.fullname']),
        datePublished: firstText(document, ['time[datetime]', 'time']),
        title: firstText(document, ['[data-testid="tweetText"]', '.tweet-text'])
      }),
      scroll: { container: null, moreSelector: '[data-testid="load-more"]' }
    },
    {
      name: 'Reddit',
      hosts: ['reddit.com', 'redd.it'],
      match: /(?:^|\.)reddit\.com|(?:^|\.)redd\.it/,
      content: ['[data-testid="post-container"] .md', '.usertext-body .md',
                'div[slot="text-body"]', '.expando .md'],
      meta: () => ({
        title: firstText(document, ['[data-testid="post-content"] h1', 'h1']),
        author: firstText(document, ['[data-testid="author"]']),
        datePublished: firstText(document, ['faceplate-time', 'time'])
      })
    },
    {
      name: 'YouTube',
      hosts: ['youtube.com', 'youtu.be'],
      match: /(?:^|\.)youtube\.com|(?:^|\.)youtu\.be/,
      content: ['#above-the-fold #description', 'ytd-watch-metadata #description',
                '#description-inline-expander', 'ytd-text-video #description'],
      meta: () => ({
        title: firstText(document, [
          'h1.ytd-watch-metadata', '#title h1', 'h1.title yt-formatted-string'
        ]),
        author: firstText(document, ['#owner #channel-name', 'ytd-channel-name']),
        datePublished: firstText(document, ['#date-text', 'meta[itemprop="uploadDate"]', '#upload-date'])
      })
    },

    /* ---------- 技术文档 ---------- */
    {
      name: 'GitHub',
      hosts: ['github.com'],
      match: /(?:^|\.)github\.com/,
      content: ['.markdown-body', '.js-comment-container .markdown-body',
                  'article.markdown-body', '.Box-body'],
      meta: () => ({
        title: firstText(document, ['bdi.js-issue-title', '.js-issue-title', 'h1']),
        author: firstText(document, ['.author', '.Link--primary'])
      })
    },
    {
      name: 'MDN',
      hosts: ['developer.mozilla.org'],
      match: /developer\.mozilla\.org/,
      content: ['.main-page-content', 'article', '.article-content'],
      meta: () => ({ title: firstText(document, ['h1']) })
    },
    {
      name: 'Stack Overflow',
      hosts: ['stackoverflow.com'],
      match: /stackoverflow\.com/,
      content: ['.s-prose.js-post-body', '#question .s-prose', '.js-post-body'],
      meta: () => ({
        title: firstText(document, ['h1 a', '.question-hyperlink', 'h1']),
        author: firstText(document, ['.user-details a', '.post-signature .user-details a'])
      })
    },
    {
      name: '通用技术文档',
      fallback: true,
      match: /(readthedocs\.io|developer\..*\.(com|org|io)|docs\.[a-z0-9-]+\.[a-z]{2,}|\.readthedocs\.)/,
      content: ['.document', '.rst-content', 'article[role="main"]', 'main', '.markdown-body'],
      meta: () => ({ title: firstText(document, ['h1']) })
    },

    /* ---------- 资讯/博客/新闻 ---------- */
    {
      name: '少数派',
      hosts: ['sspai.com'],
      match: /sspai\.com/,
      content: ['.article-content', '.wwarticle', 'article'],
      meta: () => ({
        author: firstText(document, ['.author-name', '.author']),
        datePublished: firstText(document, ['time', '.created', '[title]'])
      })
    },
    {
      name: '掘金',
      hosts: ['juejin.cn'],
      match: /juejin\.cn/,
      content: ['.article-content', '.markdown-body', 'article'],
      meta: () => ({
        author: firstText(document, ['.author-name', '.username']),
        datePublished: firstText(document, ['time', '.article-suspended'])
      })
    },
    {
      name: '阮一峰/常见博客',
      hosts: ['ruanyifeng.com', 'guokun.wang', 'xiaolai.com', 'houzhi.me'],
      match: /(ruanyifeng\.com|guokun\.wang|xiaolai\.com|houzhi\.me)/,
      content: ['#main-content', '.entry-content', '.post-content', 'article'],
      meta: () => ({ datePublished: firstText(document, ['time', '.date']) })
    },
    {
      name: 'Substack',
      hosts: ['substack.com'],
      match: /substack\.com/,
      content: ['.available-content', '.post-content', 'article'],
      meta: () => ({
        author: firstText(document, ['.byline-names', '.byline']),
        datePublished: firstText(document, ['time', '.pencraft'])
      })
    },
    {
      name: 'Medium',
      hosts: ['medium.com'],
      match: /medium\.com/,
      content: ['article section', '.post-content', 'article'],
      meta: () => ({
        author: firstText(document, ['a[data-testid="authorLink"]', '.byline a']),
        datePublished: firstText(document, ['time'])
      })
    }
  ];

  function findAdapter(url) {
    let u;
    try { u = new URL(url); } catch (e) { return null; }
    const hostname = u.hostname.toLowerCase();
    const hits = ADAPTERS.filter(a => a.hosts ? a.hosts.some(h => hostname === h || hostname.endsWith('.' + h)) :
      a.match.test(hostname));
    hits.sort((a,b) => Number(!!a.fallback) - Number(!!b.fallback));
    return hits[0] || null;
  }

  /** 识别正文里的 $SH600519$ / $2400.HK$ 这类股票标记（雪球常见） */
  function extractTickers(text) {
    if (!text) return [];
    const out = new Set();
    const re = /\$([A-Za-z]{0,2}\d{4,6}(?:\.[A-Za-z]{1,3})?)\$/g;
    let m;
    while ((m = re.exec(text))) out.add(m[1]);
    return [...out];
  }

  /** 把适配器自定义数据源返回的条目，转成内核统一的 item 结构 */
  function normalizeItem(o, fallbackHtml) {
    const holder = document.createElement('div');
    if (o.html || o.article || fallbackHtml) holder.innerHTML = o.html || o.article || fallbackHtml;
    else holder.textContent = o.text || '';
    const clean = cleanContent(holder);
    const contentMd = html2md(clean);
    const quote = document.createElement('div');
    quote.innerHTML = o.quoteHtml || '';
    const cleanQuote = cleanContent(quote);
    const ts = Number(o.createdAt);
    return { id: o.id, title: o.title || textLen(clean) && (clean.textContent || '').trim().slice(0,40) || '无标题',
      contentMd, contentEl: clean, quoteMd: (o.retweetedStatus ? '[原文](' + o.retweetedStatus + ')\n\n' : '') + html2md(cleanQuote), quoteEl: cleanQuote,
      author: o.author || '', authorId: o.authorId || '',
      url: o.url || location.href, created: Number.isFinite(ts) && ts > 0 ? fmtDate(ts,true) : '',
      likes: Number(o.likes) || 0, replies: Number(o.replies) || 0, retweets: Number(o.retweets) || 0,
      retweetedStatus: o.retweetedStatus || '', tickers: extractTickers(contentMd),
      topics: extractTags(null,contentMd,clean), type: o.type || 'status' };
  }

  /* ================================================================== *
   *  剪藏主流程
   * ================================================================== */

  async function clip() {
    if (state.busy) { ui.warn('正在处理中，请稍候'); return; }
    state.busy = true; state.abort = false;
    ui.setBusy(true);ui.toggle(true);
    try {
      const adapter = findAdapter(location.href);
      const warnings = [];
      const selection = window.getSelection && window.getSelection();
      const selected = selection && selection.toString().trim().length >= 20 &&
        !isNoiseElement(selection.anchorNode && selection.anchorNode.parentElement);
      if (cfg.autoScroll && !selected) {
        const scroll = await autoScroll(adapter);
        if (scroll.limited) warnings.push('滚动达到上限，懒加载内容可能未全部加载。');
      }
      ui.status('提取正文…');
      const found = await extractContent(adapter);
      if (!found) throw new Error('未能提取正文，请确认页面已加载完成');
      warnings.push(...(found.warnings || []));
      let meta, contentEl, body, tickers = [];
      if (found.items && found.items.length) {
        const items = found.items.map(o=>normalizeItem(o)).filter(x=>x.contentMd.length > 10);
        if (!items.length) throw new Error('自定义数据源返回的条目内容为空');
        const metas = items.map(it=>({
          title:it.title,url:it.url,domain:hostOf(it.url),author:it.author,authorId:it.authorId,
          datePublished:it.created,siteName:adapter.name,tags:[...it.topics,...it.tickers].slice(0,12),
          likes:it.likes,replies:it.replies,retweets:it.retweets,retweetedStatus:it.retweetedStatus,
          type:it.type,clipVia:adapter.name,extractVia:found.via,
          wordCount:it.contentMd.replace(/\s+/g,'').length
        }));
        meta = Object.assign({},metas[0]);
        if (items.length > 1) {
          meta.title = items.length + ' 条剪藏 · ' + (meta.author || meta.title);
          meta.url = location.href; meta.datePublished = ''; meta.type = 'collection';
          meta.itemCount = items.length;
          meta.tags = [...new Set(metas.flatMap(m=>m.tags))].slice(0,12);
          if (!metas.every(m=>m.author === meta.author)) { meta.author=''; meta.authorId=''; }
          ['likes','replies','retweets','retweetedStatus'].forEach(k=>delete meta[k]);
        }
        meta.wordCount = items.reduce((n,x)=>n+x.contentMd.replace(/\s+/g,'').length,0);
        body = metas.map((m,i)=> (items.length > 1 ? '## ' + (i+1) + '. ' + escapeMd(m.title) + '\n\n' : '') +
          buildMarkdown(m,items[i].contentMd,items[i].quoteMd,items[i].tickers,
            {frontmatter:false,sourceBlock:items.length > 1 && cfg.addSourceBlock})).join('\n\n---\n\n');
        contentEl = document.createElement('div');
        items.forEach((it,i)=>{
          const section = document.createElement('section'), title = document.createElement('h1');
          title.textContent = it.title; section.appendChild(title);
          if (items.length > 1) {
            const details = document.createElement('p');
            details.textContent = [it.author && '作者：'+it.author, it.created && '发布：'+it.created,
              cfg.collectInteractions && '点赞：'+it.likes+' · 评论：'+it.replies+' · 转发：'+it.retweets].filter(Boolean).join('；');
            section.appendChild(details);
          }
          if (items.length > 1) {
            const source = document.createElement('p'), link = document.createElement('a');
            link.href = it.url; link.textContent = '原文：' + it.url; source.appendChild(link); section.appendChild(source);
          }
          section.appendChild(it.contentEl.cloneNode(true));
          if (it.quoteMd) {
            const h = document.createElement('h2'); h.textContent = '转发原文';
            section.appendChild(h);
            if (it.retweetedStatus) { const a = document.createElement('a'); a.href=it.retweetedStatus; a.textContent='转发原文地址'; section.appendChild(a); }
            section.appendChild(it.quoteEl.cloneNode(true));
          }
          contentEl.appendChild(section);
        });
      } else {
        contentEl = cleanContent(found.el,adapter);
        body = found.rawMarkdown ? tidy(found.rawMarkdown) : html2md(contentEl);
        if (!body || body.length < 20) throw new Error('正文内容过短，请选中文字后重试');
        meta = extractMeta(adapter,found.meta);
        meta.clipVia = adapter ? adapter.name : '通用启发式';
        meta.extractVia = found.via;
        meta.wordCount = body.replace(/\s+/g,'').length;
        tickers = extractTickers(body);
        meta.tags = [...new Set([...extractTags(meta,body,contentEl),...tickers])].slice(0,12);
      }
      const images = await localizeImages(body,meta,{onProgress:(d,t)=>ui.status('图片处理 ' + d + '/' + t + '…')});
      if (images.failed.length) warnings.push(images.failed.length + ' 张图片未能保存，保留了远程链接。');
      if (cfg.imageMode === 'link' && images.total) warnings.push('保留了 ' + images.total + ' 张远程图片链接，离线可能无法显示。');
      const prev = history[location.href];
      if (cfg.dedupe && prev) warnings.push('此页面于 ' + fmtDate(prev.at,true) + ' 已提取过，请注意重复。');
      meta.captureStatus = warnings.length || found.confidence < 0.75 ? 'needs-review' : 'captured';
      meta.captureWarnings = warnings;
      let md = buildMarkdown(meta,images.md,'',tickers);
      if (warnings.length) md += '\n> 剪藏提示：' + warnings.join('；') + '\n';
      if (warnings.length) {
        const note=document.createElement('p');note.textContent='剪藏提示：'+warnings.join('；');
        contentEl.appendChild(note);
      }
      const previewHtml=buildHtml(meta,contentEl,images);
      const html=(cfg.outputFormat==='html' || cfg.outputFormat==='both')?previewHtml:null;
      history[location.href] = {at:nowSec(),title:meta.title,n:((prev && prev.n)||0)+1};
      saveHistory();
      const result = {md,html,previewHtml,imageMode:cfg.imageMode,assets:images.assets,meta,adapter,via:found.via,
        warnings,imageSummary:{total:images.total,localized:images.localized,failed:images.failed.length}};
      state.lastClip = result;
      await ui.showResult(result);
    } catch (e) { ui.warn('失败：' + e.message); log(e); }
    finally { state.busy = false; state.abort = false; ui.setBusy(false); }
  }

  /* ================================================================== *
   *  下载
   * ================================================================== */

  function filenameFor(meta, ext) {
    const tpl = `${fmtDate(parseDate(meta.datePublished) || nowSec())}-${meta.title || 'untitled'}`;
    return escFilename(tpl) + '.' + ext;
  }


  function crc32(bytes) {
    let crc = 0xffffffff;
    for (const byte of bytes) {
      crc ^= byte;
      for (let i=0;i<8;i++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
    return (crc ^ 0xffffffff) >>> 0;
  }

  async function buildZip(files) {
    const encoder = new TextEncoder(), locals = [], central = [];
    let offset = 0, centralSize = 0;
    const now = new Date();
    const time = (now.getHours()<<11) | (now.getMinutes()<<5) | Math.floor(now.getSeconds()/2);
    const date = ((Math.max(1980,now.getFullYear())-1980)<<9) | ((now.getMonth()+1)<<5) | now.getDate();
    for (const file of files) {
      const name = encoder.encode(file.name);
      const bytes = typeof file.data === 'string' ? encoder.encode(file.data) :
        new Uint8Array(await file.data.arrayBuffer());
      const crc = crc32(bytes), local = new Uint8Array(30), centralEntry = new Uint8Array(46);
      const l = new DataView(local.buffer), c = new DataView(centralEntry.buffer);
      l.setUint32(0,0x04034b50,true); l.setUint16(4,20,true); l.setUint16(6,0x800,true);
      l.setUint16(10,time,true); l.setUint16(12,date,true); l.setUint32(14,crc,true);
      l.setUint32(18,bytes.length,true); l.setUint32(22,bytes.length,true); l.setUint16(26,name.length,true);
      c.setUint32(0,0x02014b50,true); c.setUint16(4,20,true); c.setUint16(6,20,true); c.setUint16(8,0x800,true);
      c.setUint16(12,time,true); c.setUint16(14,date,true); c.setUint32(16,crc,true);
      c.setUint32(20,bytes.length,true); c.setUint32(24,bytes.length,true); c.setUint16(28,name.length,true);
      c.setUint32(42,offset,true);
      locals.push(local,name,bytes); central.push(centralEntry,name);
      offset += local.length + name.length + bytes.length;
      centralSize += centralEntry.length + name.length;
    }
    const end = new Uint8Array(22), e = new DataView(end.buffer);
    e.setUint32(0,0x06054b50,true); e.setUint16(8,files.length,true); e.setUint16(10,files.length,true);
    e.setUint32(12,centralSize,true); e.setUint32(16,offset,true);
    return new Blob([...locals,...central,end],{type:'application/zip'});
  }

  async function saveFiles({md,html,assets,meta}) {
    const base = filenameFor(meta,'').replace(/\.$/,'');
    const files = [];
    if (md && (cfg.outputFormat === 'md' || cfg.outputFormat === 'both')) files.push({name:base+'.md',data:md});
    if (html && (cfg.outputFormat === 'html' || cfg.outputFormat === 'both')) files.push({name:base+'.html',data:html});
    if (!files.length) throw new Error('当前结果没有所选格式的正文');
    if (assets && assets.length) {
      for (const a of assets) files.push({name:a.path,data:a.blob});
      downloadBlob(base+'.zip',await buildZip(files));
      ui.ok('已发起 ZIP 下载（正文与 ' + assets.length + ' 张图片）；解压后阅读');
    } else {
      for (const file of files) downloadText(file.name,file.data);
      ui.ok('已发起 ' + files.length + ' 个正文文件下载');
    }
  }

  function downloadBlob(name,blob) {
    const url = URL.createObjectURL(blob), a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(()=>URL.revokeObjectURL(url),10000);
  }

  function downloadText(name,text) {
    downloadBlob(name,new Blob([text],{type:name.endsWith('.html') ? 'text/html;charset=utf-8' : 'text/markdown;charset=utf-8'}));
  }

  async function copyText(text) {
    try { await navigator.clipboard.writeText(text); return true; }
    catch (e) {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.cssText = 'position:fixed;opacity:0';
      document.body.appendChild(ta); ta.select();
      const okd = document.execCommand('copy');
      ta.remove();
      return okd;
    }
  }

  /* ================================================================== *
   *  UI
   * ================================================================== */


  const ui = (() => {
    let panel, elStatus, elPreview, elInfo, elBtn, elOut, current=null;
    let busy=false, captureKey='', suppressEntryClick=false;
    const CSS = `
#uclip-panel{all:initial;position:fixed;z-index:2147483647;display:none;flex-direction:column;overflow:hidden;right:24px;bottom:24px;width:428px;max-width:calc(100vw - 32px);height:min(742px,calc(100dvh - 48px));max-height:calc(100dvh - 48px);border:1px solid #d6dce4;border-radius:14px;background:#fff;color:#202630;box-shadow:0 16px 52px #26344926,0 2px 8px #26344912;font:13px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif;color-scheme:light}
#uclip-panel .uclip-hd{padding:14px 18px;background:#fff;gap:10px;border-bottom:1px solid #e8ebef;min-height:66px}
#uclip-panel .uclip-ic{width:30px;height:30px;font-size:14px;border-radius:8px;background:#1f6feb;color:#fff}
#uclip-panel .uclip-hd b{font-weight:600;font-size:15px;color:#202630;line-height:1.45}
#uclip-panel .uclip-hd b small{display:block;font-size:11px;font-weight:400;color:#687283;margin-top:2px}
#uclip-panel .uclip-btn{width:40px;height:34px;font-size:12px;line-height:1.4;color:#606b7b;border-radius:6px}
#uclip-panel #uclip-hide{font-size:22px;width:30px}
#uclip-panel .uclip-btn:hover{background:#f0f3f7;color:#222}
#uclip-panel .uclip-bd{padding:0;display:flex;flex-direction:column;height:calc(100% - 66px);overflow:auto;overscroll-behavior:contain}
#uclip-panel .review-top{padding:18px 20px 12px;flex:0 0 auto}
#uclip-panel .review-context{display:flex;gap:10px;align-items:center;flex-wrap:wrap;color:#647084;font-size:11px}
#uclip-panel .scope-label{background:#edf4ff;color:#1b59b7;padding:2px 7px;border-radius:4px;font-size:11px}
#uclip-panel #review-title{font-size:20px;font-weight:600;line-height:1.45;letter-spacing:-.3px;margin:13px 0 8px;color:#202630;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
#uclip-panel .review-source{font-size:11px;color:#657082;white-space:normal;overflow-wrap:anywhere}
#uclip-panel .review-tools{margin-top:15px;display:flex;gap:10px;align-items:center;justify-content:space-between}
#uclip-panel #scope-help{font-size:11px;line-height:1.6;max-width:242px;color:#677183}
#uclip-panel #clip-slot{flex:0 0 auto}
#uclip-panel #uclip-clip{font-size:11px;min-width:84px;padding:5px 9px;color:#3c4a5f;border:1px solid #dbe1e9;background:#fff}
#uclip-panel #uclip-clip:hover{background:#f3f6fa}
#uclip-panel .review-notice{margin:0 20px 12px;background:#fff7e9;border:1px solid #efdebf;border-radius:7px;color:#815016;padding:10px 12px;font-size:12px;flex:0 0 auto}
#uclip-panel .notice-head{display:flex;gap:12px;align-items:center;justify-content:space-between}
#uclip-panel .notice-head strong{font-weight:550}
#uclip-panel #notice-detail{border:0;background:none;color:#815016;padding:0;font-size:11px;text-decoration:underline;text-underline-offset:3px}
#uclip-panel #notice-list{padding-left:17px;margin:8px 0 0;font-size:11px;line-height:1.7}
#uclip-panel #replace-gate p{font-size:11px;margin:3px 0 9px}
#uclip-panel .gate-actions{display:flex;gap:8px}
#uclip-panel .gate-actions button{padding:4px 9px;border:1px solid #d4bc93;border-radius:5px;font-size:11px;background:#fff;color:#744914}
#uclip-panel .preview-deck{margin:0 20px;min-height:150px;flex:1 0 210px;display:flex;flex-direction:column;border:1px solid #e1e5eb;border-radius:8px;overflow:hidden}
#uclip-panel .view-tabs{padding:0 13px;display:flex;gap:20px;align-items:center;border-bottom:1px solid #e5e9ef;background:#fafbfc;min-height:42px;flex:0 0 auto}
#uclip-panel .view-tabs button{background:none;border:0;border-bottom:2px solid transparent;align-self:stretch;padding:9px 0 7px;color:#687285;font-size:12px}
#uclip-panel .view-tabs button[aria-selected="true"]{color:#1c5ab5;border-bottom-color:#1f6feb;font-weight:550}
#uclip-panel #edit-badge{color:#8b5b24;font-size:10px;margin-left:auto}
#uclip-panel #read-view{position:relative;flex:1;min-height:150px;display:flex}
#uclip-panel #read-frame{border:0;width:100%;height:100%;min-height:150px;flex:1;background:#fff}
#uclip-panel .read-empty{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;flex-direction:column;background:#fff;color:#4f5f73}
#uclip-panel .read-empty strong{font-size:14px;font-weight:550}#uclip-panel .read-empty p{font-size:12px;color:#718095}
#uclip-panel #edit-view{flex:1;min-height:150px;display:flex;flex-direction:column;background:#fbfcfd}
#uclip-panel .edit-hint{margin:0;padding:9px 12px;border-bottom:1px solid #e8ecf0;color:#6c7787;font-size:10px;line-height:1.6}
#uclip-panel #editor-slot{flex:1;min-height:110px;display:flex}
#uclip-panel #uclip-preview{width:100%;height:100%;min-height:110px;margin:0;resize:none;border:0;border-radius:0;padding:14px;font:12px/1.65 Consolas,ui-monospace,monospace;background:#fbfcfd;color:#253247;flex:1}
#uclip-panel .edit-note{margin:7px 20px 0;color:#855b29;font-size:10px}
#uclip-panel .review-footer{padding:14px 20px 16px;flex:0 0 auto}
#uclip-panel .export-choice{display:flex;gap:7px;align-items:center;flex-wrap:wrap;font-size:11px;color:#647084;margin-bottom:12px}
#uclip-panel .export-choice label{flex:0 0 auto}
#uclip-panel #export-format{border:0;background:#f0f3f7;color:#40536f;padding:4px 6px;border-radius:4px;font-size:11px}
#uclip-panel #export-package{margin-left:auto;color:#667387;font-size:10px}
#uclip-panel .export-actions{display:flex;gap:9px;align-items:stretch}
#uclip-panel #copy-slot{flex:0 0 104px}#uclip-panel #export-slot{flex:1}
#uclip-panel #uclip-cp,#uclip-panel #uclip-openmd{width:100%;min-height:42px;border-radius:7px;font-size:13px}
#uclip-panel #uclip-cp{background:#fff;border-color:#d6dee8;color:#42546d}
#uclip-panel #uclip-openmd{background:#1f6feb;border-color:#1f6feb;color:#fff;font-weight:550}
#uclip-panel #uclip-openmd:hover{background:#1a5fd0}
#uclip-panel .uclip-st{font-size:11px;min-height:0;margin:8px 0 0;color:#647084;line-height:1.6}
#uclip-panel .uclip-st.warn{color:#86551c}#uclip-panel .uclip-st.ok{color:#357152}
#uclip-panel .export-caption{display:block;font-size:10px;color:#667387;margin-top:5px}
#uclip-info{display:none}
#uclip-panel .uclip-set.on{position:absolute;inset:66px 0 0;background:#fff;overflow:auto;padding:16px 20px 30px;z-index:2}
#uclip-panel .uclip-set label{display:block;font-size:12px;color:#43536b;margin:16px 0 5px}
#uclip-panel .uclip-set input,#uclip-panel .uclip-set select{display:block;width:100%;font:12px/1.5 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif;padding:8px 9px;min-height:35px;color:#35445a;background:#fff;border:1px solid #d5dee9}
#uclip-panel .uclip-set .uclip-hint{margin-top:6px;font-size:11px;line-height:1.65;color:#657489}
#uclip-panel .settings-head{display:flex;align-items:center;justify-content:space-between;padding-bottom:10px;border-bottom:1px solid #e5eaf1}
#uclip-panel .settings-head strong{font-size:15px;font-weight:600}
#uclip-panel .settings-head button{background:#f0f3f8;border:0;border-radius:5px;color:#475d7a;padding:5px 9px;font-size:12px}
#uclip-fab{width:42px;min-width:0;height:42px;border-radius:12px;right:24px;bottom:24px;background:#1f6feb;box-shadow:0 3px 12px #1f6feb2b;padding:0}
#uclip-fab svg{display:block;width:22px;height:22px;pointer-events:none}
#uclip-fab:hover{background:#1a5fd0}
#uclip-fab:focus-visible{outline:2px solid #93bcfc;outline-offset:3px}
#uclip-fab[data-dragging="true"]{cursor:grabbing;box-shadow:0 5px 18px #1f6feb45}
#uclip-panel :focus-visible{outline:2px solid #93bcfc;outline-offset:2px}
@media(max-width:600px){#uclip-panel{right:12px;bottom:12px;max-width:calc(100vw - 24px);height:min(742px,calc(100dvh - 24px));max-height:calc(100dvh - 24px)}#uclip-fab{right:12px;bottom:12px}#uclip-panel .review-top{padding:15px 16px 11px}#uclip-panel .preview-deck{margin:0 16px}#uclip-panel .review-footer{padding:12px 16px 14px}#uclip-panel .review-notice{margin:0 16px 10px}#uclip-panel #export-package{margin-left:0}#uclip-panel #review-title{font-size:18px}}
@media(prefers-reduced-motion:no-preference){#uclip-panel{animation:uclip-panel-in .18s ease-out}@keyframes uclip-panel-in{from{opacity:.4;transform:translateY(7px)}to{opacity:1;transform:translateY(0)}}}

#uclip-panel,#uclip-panel *{box-sizing:border-box}
#uclip-panel [hidden]{display:none!important}
#uclip-panel button,#uclip-panel select,#uclip-panel input,#uclip-panel textarea{font-family:inherit}
#uclip-panel .uclip-hd{display:flex;align-items:center;cursor:move;user-select:none;touch-action:none}
#uclip-panel .uclip-hd b{flex:1}
#uclip-panel .uclip-ic{display:flex;align-items:center;justify-content:center;flex:0 0 auto}
#uclip-panel .uclip-btn{display:flex;align-items:center;justify-content:center;border:0;background:transparent;cursor:pointer}
#uclip-panel .uclip-act{padding:7px 9px;border:1px solid #d6dee8;border-radius:6px;background:#fff;color:#42546d;cursor:pointer;font-size:12px;line-height:1.5}
#uclip-panel .uclip-act.pri{background:#1f6feb;border-color:#1f6feb;color:#fff}
#uclip-panel button:disabled{opacity:.45;cursor:not-allowed}
#uclip-panel .uclip-row{display:flex;gap:8px;flex-wrap:wrap;margin-top:14px}
#uclip-panel .uclip-row button{flex:1}
#uclip-panel .uclip-set{display:none}
#uclip-panel .uclip-set.on{display:block}
#uclip-panel > .uclip-bd{height:auto;flex:1;min-height:0;overflow:hidden}
#uclip-panel .uclip-hd{flex:0 0 auto;padding-top:12px;padding-bottom:12px}
#uclip-panel .uclip-review{flex:1;min-height:0;overflow:auto;overscroll-behavior:contain;display:flex;flex-direction:column;padding-bottom:8px}
#uclip-panel .preview-deck{flex:1 0 180px}
#uclip-panel .review-footer{border-top:1px solid #edf0f4;background:#fff}
#uclip-panel .review-source a{color:#526784;text-decoration:none}
#uclip-panel .review-source a:hover{text-decoration:underline}
#uclip-fab{display:none;position:fixed;z-index:2147483646;border:0;color:#fff;cursor:grab;align-items:center;justify-content:center;box-sizing:border-box;touch-action:none;user-select:none}
@media(max-height:640px){#uclip-panel .preview-deck{flex-basis:130px;min-height:130px}#uclip-panel .review-top{padding-top:12px;padding-bottom:9px}#uclip-panel .review-footer{padding-top:10px;padding-bottom:10px}#uclip-panel .export-caption{display:none}}
`;
    const layout = `
<div class="uclip-review"><div class="review-top">
<div class="review-context"><span id="scope-label" class="scope-label">自动识别正文</span><span id="review-count">准备剪藏</span></div>
<h2 id="review-title">先核对，再留下</h2>
<div class="review-source" id="review-source">正文、原始来源和必要图片</div>
<div class="review-tools"><span id="scope-help">范围不对？在原网页选中文字后重剪。</span><span id="clip-slot"></span></div>
</div>
<div class="review-notice" id="review-notice" hidden><div class="notice-head"><strong id="notice-title"></strong><button id="notice-detail" type="button" aria-expanded="false">详情</button></div><ul id="notice-list" hidden></ul></div>
<div id="replace-gate" class="review-notice" hidden><strong>正文有修改。</strong><p>重新提取会替换这些修改。</p><div class="gate-actions"><button type="button" id="replace-cancel">保留修改</button><button type="button" id="replace-confirm">替换并重剪</button></div></div>
<div class="preview-deck">
<div class="view-tabs" role="tablist" aria-label="核对方式"><button type="button" id="read-tab" role="tab" aria-selected="true" aria-controls="read-view">正文预览</button><button type="button" id="edit-tab" role="tab" aria-selected="false" aria-controls="edit-view">编辑内容</button><span id="edit-badge" hidden>已编辑</span></div>
<div id="read-view" role="tabpanel" aria-labelledby="read-tab"><iframe id="read-frame" title="提取正文预览" sandbox=""></iframe><div class="read-empty" id="read-empty"><strong>把值得留下的内容收好</strong><p>剪藏后在这里核对正文与图片。</p></div></div>
<div id="edit-view" role="tabpanel" aria-labelledby="edit-tab" hidden><p class="edit-hint">这里是 Markdown 格式；修改会写入 Markdown 导出。</p><div id="editor-slot"></div></div>
</div>
<div id="edit-note" class="edit-note" hidden>正文有修改；HTML 快照仍为提取时的内容。</div>
</div><div class="review-footer"><div class="export-choice"><label for="export-format">保存为</label><select id="export-format"><option value="md">Markdown</option><option value="both">Markdown + HTML</option><option value="html">HTML 快照</option></select><span id="export-package">含图片时打包 ZIP</span></div><div class="export-actions"><span id="copy-slot"></span><span id="export-slot"></span></div><div id="status-slot"></div><span class="export-caption">下载发起后，可在浏览器下载记录中查看。</span></div>
<div id="settings-slot"></div>`;
    const $ = id => panel.querySelector('#'+id);
    function configKey() {
      const keys=['imageMode','maxImageKB','saveSubfolder','autoScroll','apiPaging',
        'apiMaxPages','apiMaxItems','apiDelay','frontmatter','addSourceBlock','includeTags','collectInteractions','dedupe'];
      return JSON.stringify(keys.map(key=>cfg[key]));
    }
    const modified=()=>!!current && elPreview.value!==current.md;
    function stale(){return !!current && captureKey!==configKey();}
    function build() {
      const style=document.createElement('style');style.textContent=CSS;document.head.appendChild(style);
      elBtn=document.createElement('button');elBtn.id='uclip-fab';elBtn.type='button';
      elBtn.innerHTML='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="6" cy="6" r="3"></circle><circle cx="6" cy="18" r="3"></circle><path d="m8.12 8.12 12.88 12.88M14 10l7-7M8.12 15.88 12 12"></path></svg>';
      elBtn.title='Clip · 点击剪藏本页（'+cfg.shortcut+'）；拖动调整位置';
      elBtn.setAttribute('aria-label','Clip · 剪藏本页');
      elBtn.onclick=e=>{
        if(suppressEntryClick && e && e.detail!==0){suppressEntryClick=false;e.preventDefault();return;}
        suppressEntryClick=false;return requestClip();
      };
      document.body.appendChild(elBtn);draggableEntry();
      panel=document.createElement('section');panel.id='uclip-panel';
      panel.setAttribute('aria-label','万能剪藏');panel.setAttribute('data-screen-label','浮动剪藏面板');
      const header=document.createElement('div');header.className='uclip-hd';
      header.innerHTML='<span class="uclip-ic">剪</span><b>万能剪藏<small>正文与来源，一起留下</small></b>'+
        '<button type="button" class="uclip-btn" id="uclip-setbtn" aria-label="打开剪藏设置">设置</button>'+
        '<button type="button" class="uclip-btn" id="uclip-hide" aria-label="收起剪藏面板">×</button>';
      const body=document.createElement('div');body.className='uclip-bd';body.innerHTML=layout;
      panel.append(header,body);document.body.appendChild(panel);
      elStatus=document.createElement('div');elStatus.id='uclip-status';elStatus.className='uclip-st';
      elStatus.setAttribute('role','status');elStatus.setAttribute('aria-live','polite');$('status-slot').appendChild(elStatus);
      elPreview=document.createElement('textarea');elPreview.id='uclip-preview';elPreview.className='uclip-pre';
      elPreview.setAttribute('aria-label','编辑剪藏 Markdown');elPreview.spellcheck=false;
      elPreview.placeholder='剪藏结果会显示在这里，可编辑后导出。';$('editor-slot').appendChild(elPreview);
      elInfo=document.createElement('div');elInfo.id='uclip-info';elInfo.hidden=true;body.appendChild(elInfo);
      const clipButton=document.createElement('button');clipButton.id='uclip-clip';clipButton.type='button';
      clipButton.className='uclip-act';clipButton.textContent='剪藏本页';$('clip-slot').appendChild(clipButton);
      clipButton.onclick=requestClip;
      clipButton.addEventListener('mousedown',e=>{
        const selection=window.getSelection();
        if(selection && selection.toString().trim().length>=20 && !panel.contains(selection.anchorNode))e.preventDefault();
      });
      const exportButton=document.createElement('button');exportButton.id='uclip-openmd';exportButton.type='button';
      exportButton.className='uclip-act pri';exportButton.textContent='导出剪藏';$('export-slot').appendChild(exportButton);
      exportButton.onclick=async()=>{
        if(!current){warn('请先剪藏');return;}
        if(busy){warn('正在处理中，请稍候');return;}
        if(stale()){warn('设置已更改，请重新剪藏后导出。');return;}
        try {await saveFiles(Object.assign({},current,{md:elPreview.value,html:current.previewHtml || current.html}));}
        catch(e){warn('导出失败：'+e.message);}
      };
      const copyButton=document.createElement('button');copyButton.id='uclip-cp';copyButton.type='button';
      copyButton.className='uclip-act';copyButton.textContent='复制内容';$('copy-slot').appendChild(copyButton);
      copyButton.onclick=async()=>{
        if(!elPreview.value)return warn('内容为空');
        const copied=await copyText(elPreview.value);status(copied?'已复制到剪贴板':'复制失败',copied?'ok':'warn');
      };
      const settings=document.createElement('div');settings.id='uclip-settings';settings.className='uclip-set';
      $('settings-slot').appendChild(settings);
      $('uclip-setbtn').onclick=()=>{
        if(settings.classList.contains('on'))settings.classList.remove('on');
        else openSettings();
      };
      $('uclip-hide').onclick=()=>toggle(false);
      elOut=$('export-format');elOut.value=cfg.outputFormat;
      elOut.onchange=()=>{cfg.outputFormat=elOut.value;saveCfg();updateControls();
        if(settings.dataset.built)settings.querySelector('#s_fmt').value=cfg.outputFormat;};
      $('read-tab').onclick=()=>switchView('read');
      $('edit-tab').onclick=()=>switchView('edit');
      [$('read-tab'),$('edit-tab')].forEach(tab=>tab.addEventListener('keydown',e=>{
        if(!['ArrowLeft','ArrowRight'].includes(e.key) || !current)return;
        e.preventDefault();const which=tab.id==='read-tab'?'edit':'read';switchView(which);
        $(which+'-tab').focus();
      }));
      elPreview.addEventListener('input',updateControls);
      $('notice-detail').onclick=()=>{
        const open=$('notice-list').hidden;$('notice-list').hidden=!open;
        $('notice-detail').setAttribute('aria-expanded',String(open));$('notice-detail').textContent=open?'收起':'详情';
      };
      $('replace-cancel').onclick=()=>{$('replace-gate').hidden=true;$('uclip-clip').focus();};
      $('replace-confirm').onclick=()=>{$('replace-gate').hidden=true;return clip();};
      document.addEventListener('keydown',e=>{
        if(e.key!=='Escape' || panel.style.display==='none')return;
        if(settings.classList.contains('on')){settings.classList.remove('on');$('uclip-setbtn').focus();}
        else if(!$('replace-gate').hidden){$('replace-gate').hidden=true;$('uclip-clip').focus();}
        else toggle(false);
      });
      draggable(header,panel);
      switchView('read');updateControls();updateFloatingButton();
      window.addEventListener('resize',applyFloatingPosition);
      if(typeof GM_registerMenuCommand==='function'){
        GM_registerMenuCommand('剪藏本页（'+cfg.shortcut+'）',requestClip);
        GM_registerMenuCommand('查看剪藏结果',()=>toggle(true));
        GM_registerMenuCommand('剪藏设置',openSettings);
        GM_registerMenuCommand('显示 / 隐藏浮动入口',()=>{
          cfg.floatingBtn=!cfg.floatingBtn;saveCfg();updateFloatingButton();
          if(settings.dataset.built)settings.querySelector('#s_floating').value=cfg.floatingBtn?'1':'0';
          status(cfg.floatingBtn?'已启用浮动入口':'已隐藏浮动入口，可用快捷键或菜单剪藏','ok');
        });
      }
    }
    function openSettings(){
      if(busy)return warn('正在处理中，请稍候');
      toggle(true);
      const settings=$('uclip-settings');
      if(!settings.dataset.built){buildSettings(settings);settings.dataset.built='1';}
      settings.classList.add('on');settings.scrollTop=0;
    }
    function entryBounds(){
      const right=Math.max(0,innerWidth-42-12),bottom=Math.max(0,innerHeight-42-12);
      return {left:Math.min(12,right),top:Math.min(12,bottom),right,bottom};
    }
    function applyFloatingPosition(){
      const pos=cfg.floatingPosition;
      if(!pos || !Number.isFinite(pos.x) || !Number.isFinite(pos.y)){
        elBtn.style.left='';elBtn.style.top='';elBtn.style.right='';elBtn.style.bottom='';return;
      }
      const b=entryBounds(),clamp=n=>Math.max(0,Math.min(1,n));
      elBtn.style.left=(b.left+clamp(pos.x)*(b.right-b.left))+'px';
      elBtn.style.top=(b.top+clamp(pos.y)*(b.bottom-b.top))+'px';
      elBtn.style.right='auto';elBtn.style.bottom='auto';
    }
    function updateFloatingButton(){
      elBtn.style.display=cfg.floatingBtn && panel.style.display!=='flex'?'flex':'none';
      applyFloatingPosition();
    }
    function draggableEntry(){
      let drag=null;
      elBtn.addEventListener('pointerdown',e=>{
        if(e.button!==0 || e.isPrimary===false)return;
        const r=elBtn.getBoundingClientRect();
        suppressEntryClick=false;drag={id:e.pointerId,x:e.clientX,y:e.clientY,left:r.left,top:r.top,moved:false};
        // 保留网页选区；按钮点击和拖动均不改变待剪藏范围。
        e.preventDefault();
        if(elBtn.setPointerCapture)elBtn.setPointerCapture(e.pointerId);
      });
      elBtn.addEventListener('pointermove',e=>{
        if(!drag || drag.id!==e.pointerId)return;
        const dx=e.clientX-drag.x,dy=e.clientY-drag.y;
        if(!drag.moved && Math.hypot(dx,dy)<6)return;
        drag.moved=true;elBtn.dataset.dragging='true';
        const b=entryBounds();
        elBtn.style.left=Math.max(b.left,Math.min(b.right,drag.left+dx))+'px';
        elBtn.style.top=Math.max(b.top,Math.min(b.bottom,drag.top+dy))+'px';
        elBtn.style.right='auto';elBtn.style.bottom='auto';
        e.preventDefault();
      });
      const end=e=>{
        if(!drag || drag.id!==e.pointerId)return;
        if(drag.moved){
          suppressEntryClick=true;
          const b=entryBounds(),left=parseFloat(elBtn.style.left),top=parseFloat(elBtn.style.top);
          cfg.floatingPosition={x:(left-b.left)/Math.max(1,b.right-b.left),y:(top-b.top)/Math.max(1,b.bottom-b.top)};
          saveCfg();
        }
        drag=null;delete elBtn.dataset.dragging;
      };
      elBtn.addEventListener('pointerup',end);elBtn.addEventListener('pointercancel',end);
      elBtn.addEventListener('lostpointercapture',end);
    }
    function switchView(which) {
      const read=which==='read';$('read-view').hidden=!read;$('edit-view').hidden=read;
      $('read-tab').setAttribute('aria-selected',String(read));$('edit-tab').setAttribute('aria-selected',String(!read));
      $('read-tab').tabIndex=read?0:-1;$('edit-tab').tabIndex=read?-1:0;
      if(!read)elPreview.focus();
    }
    function updateControls() {
      if(!panel)return;
      $('uclip-clip').disabled=busy;$('uclip-openmd').disabled=busy || !current || stale();
      $('uclip-cp').disabled=busy || !current;$('edit-tab').disabled=!current;
      $('uclip-setbtn').disabled=busy;elOut.disabled=busy;
      const edited=modified();$('edit-badge').hidden=!edited;$('edit-note').hidden=!edited;
      $('edit-note').textContent=cfg.outputFormat==='html'?'当前仅导出 HTML，编辑内容不会写入此次导出。':
        cfg.outputFormat==='md'?'预览显示提取时的正文；修改会进入 Markdown 文件。':
        '修改会进入 Markdown；HTML 快照仍为提取时的内容。';
      $('export-package').textContent=current && current.assets.length?'ZIP · '+current.assets.length+' 张图片':
        current && current.imageMode==='base64'?'图片内嵌在正文中':'不含本地图片附件';
      if(stale())warn('设置已更改，请重新剪藏后导出。');
    }
    function setBusy(value){busy=value;updateControls();}
    function requestClip() {
      toggle(true);
      if(busy)return warn('正在处理中，请稍候');
      if(modified()){$('replace-gate').hidden=false;$('replace-cancel').focus();return;}
      return clip();
    }
    async function renderPreview(result) {
      try {
        const doc=new DOMParser().parseFromString(result.previewHtml || result.html || '','text/html');
        doc.querySelectorAll('script,iframe,object,embed,link,.meta,meta[http-equiv]').forEach(node=>node.remove());
        const title=doc.querySelector('h1');if(title && title.textContent.trim()===result.meta.title)title.remove();
        const assets=new Map();
        await Promise.all(result.assets.map(async asset=>assets.set(asset.path,await blobToDataUrl(asset.blob))));
        doc.querySelectorAll('img').forEach(img=>{
          let src=img.getAttribute('src') || '';try{src=decodeURI(src);}catch(e){}
          if(assets.has(src))img.src=assets.get(src);
          else if(!/^data:image\//i.test(src)){
            const placeholder=doc.createElement('p');placeholder.className='uclip-image-missing';
            placeholder.textContent=(result.imageMode==='link'?'图片保留为原始链接：':'图片未保存：')+(img.alt || '正文图片');
            img.replaceWith(placeholder);
          }
        });
        doc.querySelectorAll('a').forEach(a=>a.removeAttribute('href'));
        const csp=doc.createElement('meta');csp.httpEquiv='Content-Security-Policy';
        csp.content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'";
        doc.head.prepend(csp);
        const style=doc.createElement('style');
        style.textContent=':root{color-scheme:light}body{padding:8px 19px 28px;max-width:none;margin:0;background:#fff;color:#344054;font:14px/1.85 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif}h1{font-size:18px;line-height:1.5;margin:12px 0 16px}h2{font-size:16px;border:0;padding:0;margin:22px 0 10px}p{margin:12px 0}img{max-width:100%;height:auto;border-radius:0}figure{margin:18px 0}figcaption{font-size:11px;color:#67758b}blockquote{color:#607089;border-color:#d1dce9;padding:0 12px;margin:20px 0}table{max-width:100%}pre{overflow:auto}.uclip-image-missing{padding:20px 12px;border:1px dashed #dbbe8f;color:#8a611f;background:#fff9ef;font-size:12px}';
        doc.head.appendChild(style);
        $('read-frame').srcdoc='<!doctype html>'+doc.documentElement.outerHTML;$('read-empty').hidden=true;
      } catch(e) {
        $('read-empty').hidden=false;$('read-empty').textContent='预览不可用，请切换到编辑内容核对。';
      }
    }
    async function showResult(result) {
      current=result;captureKey=configKey();elPreview.value=result.md;elInfo.textContent=result.via;
      $('review-title').textContent=result.meta.title || '未命名剪藏';
      $('review-count').textContent='约 '+result.meta.wordCount+' 字 · '+result.imageSummary.total+' 张图片';
      $('review-source').replaceChildren();
      const detail=document.createElement('span');detail.textContent=[result.meta.author,result.meta.datePublished].filter(Boolean).join(' · ');
      $('review-source').appendChild(detail);
      const source=document.createElement('a');source.href=result.meta.url;source.target='_blank';source.rel='noopener noreferrer';
      source.textContent=(detail.textContent?' · ':'')+(result.meta.domain || hostOf(result.meta.url) || '原文');
      $('review-source').appendChild(source);
      const selected=result.via==='selection';$('scope-label').textContent=selected?'已选中的正文':'自动识别正文';
      $('scope-help').textContent=selected?'只保留选中的范围；可在原网页重新选择。':'范围不对？在原网页选中文字后重剪。';
      $('uclip-clip').textContent='重新剪藏';$('replace-gate').hidden=true;
      const warnings=[...(result.warnings || [])];
      if(!warnings.length && result.meta.captureStatus==='needs-review')warnings.push('正文范围仍需人工核对。');
      $('review-notice').hidden=!warnings.length;$('notice-list').replaceChildren();
      warnings.forEach(w=>{const li=document.createElement('li');li.textContent=w;$('notice-list').appendChild(li);});
      $('notice-title').textContent=result.imageSummary.failed?result.imageSummary.failed+' 张图片未保存，离线显示可能受影响':'剪藏范围或完整性需要核对';
      $('notice-list').hidden=true;$('notice-detail').setAttribute('aria-expanded','false');$('notice-detail').textContent='详情';
      switchView('read');await renderPreview(result);updateControls();
      if(result.imageSummary.failed)warn(result.imageSummary.failed+' 张图片未能保存，请核对上方提示。');
      else if(warnings.length)warn('提取完成，请核对上方提示。');
      else ok('提取完成，可编辑后导出');
    }
    function status(t,k) {if(!elStatus)return;elStatus.textContent=t;elStatus.className='uclip-st'+(k?' '+k:'');}
    const warn=t=>status(t,'warn'),ok=t=>status(t,'ok');
    function toggle(show) {
      if(!panel)return;panel.style.display=show?'flex':'none';
      updateFloatingButton();
      if(show && panel.style.left)constrainPanel(panel);
      if(!show && cfg.floatingBtn)elBtn.focus();
    }
    function constrainPanel(box) {
      if(box.style.display==='none')return;
      const r=box.getBoundingClientRect();
      box.style.left=Math.max(0,Math.min(innerWidth-r.width,r.left))+'px';
      box.style.top=Math.max(0,Math.min(innerHeight-r.height,r.top))+'px';
      box.style.right='auto';box.style.bottom='auto';
    }
    function draggable(header,box) {
      let drag=null;
      header.addEventListener('pointerdown',e=>{
        if(e.button!==0 || e.target.closest('button'))return;
        const r=box.getBoundingClientRect();drag={id:e.pointerId,x:e.clientX,y:e.clientY,left:r.left,top:r.top};
        box.style.animation='none';
        if(header.setPointerCapture)header.setPointerCapture(e.pointerId);
        e.preventDefault();
      });
      header.addEventListener('pointermove',e=>{
        if(!drag || drag.id!==e.pointerId)return;
        box.style.left=(drag.left+e.clientX-drag.x)+'px';box.style.top=(drag.top+e.clientY-drag.y)+'px';
        box.style.right='auto';box.style.bottom='auto';constrainPanel(box);
      });
      const end=e=>{if(!drag || e.pointerId!==drag.id)return;drag=null;};
      header.addEventListener('pointerup',end);header.addEventListener('pointercancel',end);
      window.addEventListener('resize',()=>{if(box.style.left)constrainPanel(box);});
    }
    function buildSettings(box) {
      box.innerHTML = `
        <label>浮动剪藏入口</label>
        <select id="s_floating">
          <option value="1">显示剪刀图标</option>
          <option value="0">隐藏（使用快捷键或脚本菜单）</option>
        </select>
        <div class="uclip-hint">点击图标直接剪藏；拖动可调整位置并跨页面保留。快捷键：Alt+Shift+S。</div>
        <div class="uclip-row"><button class="uclip-act" id="s_position" type="button">恢复图标默认位置</button></div>

        <label>输出格式</label>
        <select id="s_fmt">
          <option value="md">Markdown（推荐）</option>
          <option value="both">Markdown + HTML 快照</option>
          <option value="html">仅 HTML 快照</option>
        </select>

        <label>图片处理</label>
        <select id="s_img">
          <option value="local">正文与图片打包 ZIP（推荐）</option>
          <option value="base64">内嵌图片（文件较大）</option>
          <option value="link">保留原始链接（文件最小）</option>
        </select>
        <div class="uclip-hint">base64 会内联到正文；超限或失败的图片保留远程链接，并提示核对。</div>

        <label>单图上限（KB）</label>
        <input id="s_maxkb" type="number" min="50" step="50">
        <div class="uclip-hint">超过此大小的图片不做本地化，避免卡住和体积膨胀。</div>

        <label>自动滚动加载</label>
        <select id="s_scroll">
          <option value="1">开启（尝试加载更多内容）</option>
          <option value="0">关闭（短页面更快）</option>
        </select>

        <label>接口翻页（批量）</label>
        <select id="s_apipg">
          <option value="0">关闭（默认，按当前页剪藏）</option>
          <option value="1">开启（按上限获取更多内容）</option>
        </select>
        <div class="uclip-hint">
          仅对提供了接口数据源的站点有效（目前是雪球）。开启后会按下面的页数与间隔请求，
          结果受页数与条数上限限制。默认关闭。
        </div>

        <label>翻页页数上限</label>
        <input id="s_apipp" type="number" min="1" max="50" step="1">
        <div class="uclip-hint">每页条数由站点决定；达到上限会保留提示。</div>

        <label>翻页最多取条数</label>
        <input id="s_apimi" type="number" min="10" step="10">

        <label>翻页请求间隔（毫秒）</label>
        <input id="s_apidl" type="number" min="600" step="100">
        <div class="uclip-hint">请求之间的最短等待时间，默认 1200 毫秒。</div>

        <label>同链接重复剪藏提醒</label>
        <select id="s_dedupe">
          <option value="1">提醒</option>
          <option value="0">不提醒</option>
        </select>

        <label>图片附件目录名</label>
        <input id="s_sub" type="text">

        <div class="uclip-row" style="margin-top:12px">
          <button class="uclip-act pri" id="s_save">保存设置</button>
          <button class="uclip-act" id="s_reset">恢复默认</button>
          <button class="uclip-act" id="s_clear">清空历史</button>
        </div>`;

      const head = document.createElement('div'); head.className='settings-head';
      const title=document.createElement('strong');title.textContent='剪藏设置';
      const back=document.createElement('button');back.type='button';back.textContent='返回正文';
      back.onclick=()=>{box.classList.remove('on');panel.querySelector('#uclip-setbtn').focus();};
      head.append(title,back);box.prepend(head);
      box.querySelectorAll('label').forEach(label=>{
        const input=label.nextElementSibling;
        if(input && input.id) label.htmlFor=input.id;
      });
      const $ = id => box.querySelector(id);
      $('#s_floating').value = cfg.floatingBtn ? '1' : '0';
      $('#s_position').onclick=()=>{
        cfg.floatingPosition=null;saveCfg();applyFloatingPosition();status('图标位置已恢复默认','ok');
      };
      $('#s_fmt').value = cfg.outputFormat;
      $('#s_img').value = cfg.imageMode;
      $('#s_maxkb').value = cfg.maxImageKB;
      $('#s_scroll').value = cfg.autoScroll ? '1' : '0';
      $('#s_apipg').value = cfg.apiPaging ? '1' : '0';
      $('#s_apipp').value = cfg.apiMaxPages;
      $('#s_apimi').value = cfg.apiMaxItems;
      $('#s_apidl').value = cfg.apiDelay;
      $('#s_dedupe').value = cfg.dedupe ? '1' : '0';
      $('#s_sub').value = cfg.saveSubfolder;

      $('#s_save').onclick = () => {
        cfg.floatingBtn = $('#s_floating').value === '1';
        cfg.outputFormat = $('#s_fmt').value;
        cfg.imageMode = $('#s_img').value;
        cfg.maxImageKB = Math.max(50, Number($('#s_maxkb').value) || DEFAULTS.maxImageKB);
        cfg.autoScroll = $('#s_scroll').value === '1';
        cfg.apiPaging = $('#s_apipg').value === '1';
        cfg.apiMaxPages = Math.min(50, Math.max(1, Number($('#s_apipp').value) || DEFAULTS.apiMaxPages));
        cfg.apiMaxItems = Math.max(10, Number($('#s_apimi').value) || DEFAULTS.apiMaxItems);
        cfg.apiDelay = Math.max(600, Number($('#s_apidl').value) || DEFAULTS.apiDelay);
        cfg.dedupe = $('#s_dedupe').value === '1';
        cfg.saveSubfolder = escFilename($('#s_sub').value || DEFAULTS.saveSubfolder);
        saveCfg();
        status('设置已保存', 'ok');
        box.classList.remove('on');elOut.value=cfg.outputFormat;updateControls();updateFloatingButton();
      };
      $('#s_reset').onclick = () => {
        Object.assign(cfg, DEFAULTS);
        saveCfg();
        box.innerHTML = ''; delete box.dataset.built; box.classList.remove('on');
        status('已恢复默认', 'ok');elOut.value=cfg.outputFormat;updateControls();updateFloatingButton();
      };
      $('#s_clear').onclick = () => {
        Object.keys(history).forEach(k => delete history[k]);
        saveHistory();
        status('历史已清空', 'ok');
      };
    }


    return {build,status,warn,ok,showResult,toggle,setBusy,requestClip};
  })();

  /* ============================ 快捷键 ============================ */


  document.addEventListener('keydown', e => {
    const parts = cfg.shortcut.toLowerCase().split('+');
    const key = parts[parts.length-1];
    if (e.key.toLowerCase() === key && e.altKey === parts.includes('alt') &&
        e.shiftKey === parts.includes('shift') && e.ctrlKey === parts.includes('ctrl') &&
        e.metaKey === (parts.includes('meta') || parts.includes('cmd'))) {
      e.preventDefault();
      ui.requestClip();
    }
  });

  /* ============================ 启动 ============================ */

  if (document.body) ui.build();
  else document.addEventListener('DOMContentLoaded', () => ui.build());

  // 便于排错
  window.__universalClipper = {
    clip,
    extractContent,
    findAdapter,
    html2md,
    getLastClip: () => state.lastClip,
    ADAPTERS,
    cfg,
    version: '1.3.0'
  };
  log('已启动 · 适配器', ADAPTERS.map(a => a.name).join(', '));
})();