/*
 * 双端酒馆原生功能优化 —— 启动引导（真正的功能代码在 main.js）
 * Copyright (C) 2026 niyah_jz
 *
 * 这个文件只有一个职责：把 main.js 载进来，载不动就重试，重试完还不行就在页面顶部说清楚原因。
 * 为什么拆开：main.js 有 360 KB 上下，弱网/移动网络下偶尔会一次拉不全；
 * <script type="module" src> 失败时酒馆不会重试，结果就是"这次打开什么都没有、刷新才恢复"。
 * 引导文件只有几 KB，拉到的概率高得多；拉到了就由它去重试加载主体。
 */

/* 版本号不写死：取自己这次被加载时 <script src> 上的 ?ver（由 manifest 决定）。
   写死过一次，结果 manifest 升到 1.1.2、这里还是 1.1.1，main.js 就用旧查询串命中旧缓存，
   页面永远停在上一版，连自动重载都救不回来（2026-10-20 实测踩到）。 */
function wbmOwnStamp() {
    for (const node of document.querySelectorAll('script[src]')) {
        const src = String(node.src || '');
        if (src.indexOf('WorldbookEnhance') === -1) continue;
        try {
            const ver = new URL(src).searchParams.get('ver');
            if (ver) return ver;
        } catch (err) { /* 继续找下一个 */ }
    }
    return '1.2.0';
}

const WBM_VERSION = wbmOwnStamp();
const WBM_TRIES = 3;

window.__wbmBoot = { version: WBM_VERSION, build: WBM_VERSION };

/* 引导自己失败时不能依赖 style.css（它可能也没加载到），所以这几行样式写成内联 */
function wbmShowBootError(reason) {
    if (typeof document === 'undefined' || !document.body) return;
    const old = document.getElementById('wbm-boot-error');
    if (old) old.remove();
    const bar = document.createElement('div');
    bar.id = 'wbm-boot-error';
    bar.style.cssText = 'position:fixed;left:0;right:0;top:0;z-index:2147483000;padding:10px 14px;'
        + 'font:13px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif;background:#7a1f1f;color:#fff;'
        + 'box-shadow:0 2px 10px rgba(0,0,0,.45)';
    const text = document.createElement('div');
    text.style.cssText = 'padding-right:56px';
    text.textContent = '双端酒馆原生功能优化没有加载成功：' + reason;
    const hint = document.createElement('div');
    hint.style.cssText = 'margin-top:2px;opacity:.82';
    hint.textContent = 'index.js 与 main.js 必须放在同一目录，缺一个都跑不起来；请重新下载整个扩展目录后刷新页面。';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = '关闭';
    btn.style.cssText = 'position:absolute;right:10px;top:10px;background:none;border:1px solid rgba(255,255,255,.6);'
        + 'color:#fff;border-radius:4px;padding:2px 10px;font:inherit;cursor:pointer';
    btn.addEventListener('click', () => bar.remove());
    bar.appendChild(text);
    bar.appendChild(hint);
    bar.appendChild(btn);
    document.body.appendChild(bar);
}

let wbmLastError = null;
try {
    const stamp = encodeURIComponent(wbmOwnStamp());
    for (let attempt = 1; attempt <= WBM_TRIES; attempt += 1) {
        try {
            /* 每次重试都换 URL 查询串：避免浏览器直接命中"上次失败"的缓存结果 */
            await import('./main.js?ver=' + stamp + '&try=' + attempt);
            wbmLastError = null;
            break;
        } catch (err) {
            wbmLastError = err;
            console.warn('[wbm] main.js 加载失败（第 ' + attempt + '/' + WBM_TRIES + ' 次）', err);
            if (attempt < WBM_TRIES) await new Promise((resolve) => setTimeout(resolve, 700 * attempt));
        }
    }
} catch (err) {
    wbmLastError = err;
}

if (wbmLastError) {
    const message = String((wbmLastError && (wbmLastError.message || wbmLastError)) || '未知错误');
    const looksMissing = /dynamically imported module|module script failed|404|Failed to fetch/i.test(message);
    console.error('[wbm] 引导失败：', wbmLastError);
    wbmShowBootError(looksMissing ? '缺少 main.js（更新时只替换了 index.js）' : message.slice(0, 120));
}
