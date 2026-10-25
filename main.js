/*
 * 世界书增强 —— SillyTavern 世界书面板增强扩展
 * Copyright (C) 2026 niyah_jz
 * 许可：AGPL-3.0（见仓库根目录 LICENSE）  仓库：https://github.com/Niyah-jz/SillyTavern-WorldbookEnhance
 *
 * 设计要点：
 *   · 待在酒馆原生的世界书面板里做增强，不另造悬浮球或独立窗口，因此可与悬浮类插件共存。
 *   · 两端统一接管「已启用的世界书」：隐藏原生 select 与 .select2-container，改用自绘可搜索列表。
 *     fail-safe：只有自绘列表成功挂载后才给 #WIMultiSelector 打 data-wbm-ready="1"，隐藏规则全部
 *     挂在该属性下；扩展加载失败或上游改版时属性不会写，原生控件自动保留，不会"藏了但替代品没出来"。
 *   · 添加世界书只列「未启用」的，点一下即启用、就地标 ✓（不移出列表以免跳动），再点一次撤销这次启用，
 *     结构上不存在误触取消已启用项的可能。
 *   · 数据（条目收藏 / 收藏置顶 / 操作历史 / 体检忽略 / 搜索范围）存酒馆本地设置
 *     extension_settings.worldbookMobileEnhance，落 data/<user>/settings.json，电脑与手机共用一份；
 *     localStorage 只在拿不到宿主接口时兜底。
 *   · 不改酒馆任何源码文件、不往酒馆目录写数据文件。对宿主接口与 DOM 的依赖全部有 typeof 守卫与
 *     try/catch，宿主升级导致变化时对应功能降级或静默消失，原生世界书始终可用。
 *
 * 性能：无轮询、无常驻定时器、无 rAF。只有两处事件钩子——条目列表子节点变化（重绘后重挂按钮）、
 * 表头宽度变化（宽度变了才重新对齐）。渲染前比签名，不变即 return。
 */
(function () {
    'use strict';

    const VERSION = (window.__wbmBoot && window.__wbmBoot.version) || '1.3.1';
    /* 构建标记：版本号不随小修变化（都写 1.0.3），只看版本号分不出新旧，
       所以另外标一个构建号，控制台里能直接看出页面跑的是哪一份。
       发布时与 manifest 里 js/css 的 ?ver 保持一致（构建脚本会校验）。 */
    const BUILD = (window.__wbmBoot && window.__wbmBoot.build) || VERSION;
    const ROOT_ID = 'wbm-list';
    const COLLAPSED_COUNT = 5;

    if (window.__worldbookEnhance === VERSION) {
        console.warn('[wbm] 已有一份 v' + VERSION + ' 在跑，这一份被跳过（多半是同目录里留了旧副本）：build=' + BUILD);
        /* 不静默退出：让已运行的那份重新自检一次，避免"上一份半路失败、这一份又被跳过"导致整页没功能 */
        try {
            if (typeof window.__wbmReboot === 'function') window.__wbmReboot();
        } catch (err) { /* 兜底失败就算了，原生界面照旧 */ }
        return;
    }
    window.__worldbookEnhance = VERSION;

    const state = {
        signature: '',
        expanded: false,
        addOpen: false,
        addQuery: '',
        actQuery: '',
        addItems: [],
        favOnly: false,
        pendingKill: null,
        killTimer: null,
        picker: null,
        /* 全局预设的临时界面状态：存名字的小行开着没、哪一行在改名、哪一行按了删除等着确认 */
        presetSaving: false,
        presetRenameId: null,
        presetDelArm: null,
        presetOverArm: null,
        groupRenameId: null,
        groupDelArm: null,
    };

    /* ---------------- 基础 ---------------- */

    function hostEl() { return document.querySelector('#WIMultiSelector'); }

    /* 自绘 SVG 图标：宿主自带的 Font Awesome 是裁剪过的子集，某些图标名（fa-angles-down /
   fa-arrow-up-arrow-down / fa-arrow-down-to-line）拿不到字形，浏览器画出「带叉的空框」。
   凡是我们自己注入的键，一律用内联 SVG，不依赖图标字体。 */
function wbmIcon(kind) {
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 16 16');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
    svg.classList.add('wbm-ico');
    const mk = (d, extra) => {
        const p = document.createElementNS(NS, 'path');
        p.setAttribute('d', d);
        p.setAttribute('fill', 'none');
        p.setAttribute('stroke', 'currentColor');
        p.setAttribute('stroke-width', extra && extra.w ? extra.w : '1.5');
        p.setAttribute('stroke-linecap', 'round');
        p.setAttribute('stroke-linejoin', 'round');
        svg.appendChild(p);
        return p;
    };
    if (kind === 'insert') {          // 插入到这一条下面
        mk('M8 2.2v7.1M5.2 6.6 8 9.4l2.8-2.8M3.2 12.6h9.6');
    } else if (kind === 'sort') {     // 进入调整排序：上下箭头
        mk('M5 11.6V4.4M2.6 6.8 5 4.4l2.4 2.4M11 4.4v7.2m-2.4-2.4L11 11.6l2.4-2.4');
    } else if (kind === 'exit') {     // 退出调整排序：叉
        mk('M4 4l8 8M12 4l-8 8');
    } else if (kind === 'check') {
        mk('M3.4 8.4 6.4 11.4l6.2-6.4');
    } else if (kind === 'up') {       // 上移一格（排序态每行）
        mk('M8 13V3.6M4.4 7.2 8 3.6l3.6 3.6');
    } else if (kind === 'down') {     // 下移一格（排序态每行）
        mk('M8 3v9.4M4.4 8.8 8 12.4l3.6-3.6');
    } else if (kind === 'copy') {     // 复制条目到其它预设：两张叠起来的纸
        mk('M6.2 6.2h6.4v6.4H6.2z');
        mk('M3.4 3.4h6.4v6.4');
    } else if (kind === 'search') {   // 搜索（1.3.39：插入提示词浮窗的入口键）
        mk('M11.4 7a4.4 4.4 0 1 1-8.8 0 4.4 4.4 0 0 1 8.8 0');
        mk('M10.6 10.6 13.4 13.4');
    } else if (kind === 'chev') {     // 下拉提示（1.3.41：人设分组横条）
        mk('M4.4 6.4 8 10l3.6-3.6');
    }
    return svg;
}

function el(tag, cls, text) {
        const node = document.createElement(tag);
        if (cls) node.className = cls;
        if (text !== undefined) node.textContent = text;
        return node;
    }

    /* toastr 的方法名只有 success / info / warning / error；
       本文件里有 14 处写成了 ok / warn / err，以前是静默失败（点了没反应）。 */
    const WBM_TOAST_ALIAS = { ok: 'success', warn: 'warning', err: 'error' };
    function toast(kind, text) {
        try {
            const api = window.toastr;
            const name = WBM_TOAST_ALIAS[kind] || kind;
            if (api && typeof api[name] === 'function') {
                api[name](text, '', { timeOut: name === 'error' ? 4000 : 1600, preventDuplicates: true });
            }
        } catch (e) { /* ignore */ }
    }

    /* #world_info 的 option 覆盖全部世界书：value=world_names 下标，selected=已启用 */
    function allBooks() {
        const out = [];
        document.querySelectorAll('#world_info option').forEach((opt) => {
            const name = String(opt.textContent || '').trim();
            const val = String(opt.value || '');
            if (name && val !== '') out.push({ name: name, index: val, on: !!opt.selected });
        });
        return out;
    }

    function activeSet() {
        const set = new Set();
        allBooks().forEach((b) => { if (b.on) set.add(b.name); });
        return set;
    }

    function editingName() {
        const sel = document.querySelector('#world_editor_select');
        const picked = sel && sel.selectedOptions && sel.selectedOptions[0];
        return picked ? String(picked.textContent || '').trim() : '';
    }

    /* 只派发**原生** change：jQuery 的 .trigger('change') 只走 jQuery 自己的处理器链，
       不派发原生事件；而宿主把「切换编辑哪本书」的处理器挂在 document 上（委托），
       原生监听器也收不到——实测点已启用的书，select 的值变了、编辑器却不换书。
       原生 dispatchEvent 同时能到达原生监听与 jQuery 监听，两边都满足。 */
    function fireChange(node) {
        if (!node) return;
        node.dispatchEvent(new Event('change', { bubbles: true }));
    }

    /* ---------------- 数据操作 ---------------- */

    function setActive(name, on) {
        const sel = document.querySelector('#world_info');
        if (!sel) return;
        let changed = false;
        for (const opt of sel.options) {
            if (String(opt.textContent || '').trim() !== name) continue;
            if (String(opt.value || '') === '') continue;
            if (!!opt.selected !== on) { opt.selected = on; changed = true; }
        }
        if (changed) {
            fireChange(sel);
            pushHistory({ act: on ? 'enable' : 'disable', at: Date.now(), from: name, to: name, count: 1, names: [] });
        }
        state.signature = '';
        render();
    }

    /* ---------------- 移动端键盘卡顿：压住酒馆自己的 resize hack ----------------
       酒馆在 public/scripts/browser-fixes.js:73-86 给所有移动端挂了这段：
       resize / orientationchange 时把 <html> 设成 position:fixed，下一帧再还原。
       它的真实目的是修 iOS「键盘收起后页面错位」的老毛病，但代价是**每次 resize
       都强制两次整页重排**——键盘弹出与收起各触发一次 resize，于是长聊天里就是
       肉眼可见的卡顿（本机实测 200 条消息时这段占 35ms，400 条占 67ms，手机上还要
       乘几倍；把它压掉后同样操作是 0.1ms）。
       Android 上这段 hack 修的是 iOS 的毛病，对它纯属开销：用 CSS（!important 能压住
       inline style）让它变成空操作。iOS 保持原样，免得那个老毛病回来。 */
    function silenceMobileResizeHack() {
        try {
            const ua = String(navigator.userAgent || '');
            const platform = String(navigator.platform || '');
            const isIOS = /iPad|iPhone|iPod/.test(platform)
                || (platform === 'MacIntel' && Number(navigator.maxTouchPoints) > 1);
            if (isIOS) return;
            if (!/Android/i.test(ua)) return;
            document.documentElement.classList.add('wbm-quiet-resize');
            console.info('[wbm] 已压住移动端 html 定位 hack：键盘弹出/收起不再强制两次整页重排');
        } catch (err) {
            /* 加不上就算了，最多回到原生表现 */
        }
    }

    /* ---------------- 手机端横滑条的"滑得动"提示 ----------------
       手机端为了省行数，把几排工具条改成单行横向滚动；但滚动条默认看不见，
       用户不知道右边还有东西。这里给它们算一个状态写进 data-xh：
       可滑时右端渐隐（CSS 用 mask 画），滑到底渐隐自动消失；同时留一条 3px 细滚动条。
       开销：只挂 passive scroll（滑的时候才出一次请求）+ 一次 ResizeObserver（尺寸变化时），
       rAF 合并，没有定时器、没有轮询。 */
    const scrollHintNodes = new Set();
    let scrollHintPending = false;

    function refreshScrollHints() {
        scrollHintPending = false;
        scrollHintNodes.forEach((node) => {
            if (!node.isConnected) {
                if (node.__wbmScrollRO) node.__wbmScrollRO.disconnect();
                scrollHintNodes.delete(node);
                return;
            }
            const max = node.scrollWidth - node.clientWidth;
            let mode = 'none';
            if (max > 2) {
                if (node.scrollLeft <= 2) mode = 'start';
                else if (node.scrollLeft >= max - 2) mode = 'end';
                else mode = 'mid';
            }
            if (node.dataset.xh !== mode) node.dataset.xh = mode;
        });
    }

    function scheduleScrollHints() {
        if (scrollHintPending) return;
        scrollHintPending = true;
        requestAnimationFrame(refreshScrollHints);
    }

    function attachScrollHint(node) {
        if (!node || node.__wbmScrollHint) return node;
        node.__wbmScrollHint = true;
        scrollHintNodes.add(node);
        node.addEventListener('scroll', scheduleScrollHints, { passive: true });
        /* 面板关着时尺寸是 0，靠它等"真正量得到宽度"的那一刻再算一次 */
        if (typeof ResizeObserver !== 'undefined') {
            node.__wbmScrollRO = new ResizeObserver(scheduleScrollHints);
            node.__wbmScrollRO.observe(node);
        }
        scheduleScrollHints();
        return node;
    }

    /* ---------------- 持久化：存进酒馆自己的本地设置（data/<user>/settings.json） ---------------- */

    /* 收藏不写浏览器存储：浏览器换一个、清一次缓存就没了，而且手机与电脑各存一份不同步。
       酒馆的 extension_settings 是服务端设置文件，两端共用、跟酒馆一起保存。
       注意：extension_settings 定义在 scripts/extensions.js 里，script.js 只是 import 它、
       不再导出——所以只能从 extensions.js 取；saveSettingsDebounced 才在 script.js 里。
       之前统一从 /script.js 取，取不到就静默退回 localStorage，正是"收藏没落盘、手机不同步"的根因。 */
    const SETTINGS_KEY = 'worldbookMobileEnhance';

    /* 条目搜索的范围：原生是全字段模糊搜（主关键词、分组、备注名、可选过滤器、正文、uid），
       这里只做"减法"——关掉哪一面，就不在那一面里找。三项全开＝完全等于原生行为。 */
    const SEARCH_SCOPE_VALUES = ['title', 'keys', 'body'];
    const SEARCH_SCOPES = [
        { value: 'title', label: '标题', hint: '备注名' },
        { value: 'keys', label: '关键词', hint: '主关键词与可选过滤器' },
        { value: 'body', label: '正文', hint: '条目正文' },
    ];

    const store = {
        favBooks: [],
        favPin: false,
        favEntries: [],
        entryFavPin: false,
        entryClickLock: true,
        msgDblClickEdit: true,
        /* 备选回复页码：接管酒馆原生页码位置（三选一），并把手机上「点了没反应」补成单击 */
        swipeTakeover: true,
        /* 正则守护：记下上次「启用中」的脚本 id，整批失效时按它恢复 */
        regexGuard: null,
        /* 人设管理：每个头像 id 归到哪个自建分组，以及列表当前筛的组 */
        personaGroups: {},
        personaFilter: '',
        /* 按分组显示时临时放大的每页条数，回到「全部」时按它还原 */
        personaPerPageSaved: '',
        /* 人设列表每页条数（按分组显示、设置分组浮层共用）：5 / 10 / 20 / 50 */
        personaPageSize: 10,
        editBarBothEnds: true,
        enhanceEnabled: true,
        /* 各功能区独立开关（1.3.56）：默认全开；关掉只影响自己那一块，总开关仍在上面 */
        features: { promptMgr: true, persona: true, talkPreset: true, headerAlign: true, regexGuard: true, frontendGuard: true },
        searchScope: SEARCH_SCOPE_VALUES.slice(),
        /* 「扫描全部聊天」与「扫描全部角色卡」的结果缓存：书名小写数组 + 时间 + 扫过的数量 */
        catChatBooks: [],
        catChatAt: 0,
        catChatCount: 0,
        catCharBooks: [],
        catCharAt: 0,
        catCharCount: 0,
        /* 全局启用预设：[{ id, name, books: [书名] }]，存服务端设置、两端共用 */
        presets: [],
        /* 预设分组：[{ id, name }]，组名由用户自己起；预设用 groupId 指过来，空串＝未分组 */
        presetGroups: [],
        /* 「自定义」这一套的内容：上一次不走任何预设时手勾的那几本。
           它自己也是一套预设，切走再切回来能回到你手勾的清单。 */
        customBooks: [],
        loaded: false,
        mode: 'local',
    };

    /* { settings, save }：settings 是宿主的 extension_settings 对象本体（改它就是改宿主数据） */
    let settingsApi = null;

    function legacyGet(key, fallback) {
        try {
            const raw = window.localStorage.getItem(key);
            if (!raw) return fallback;
            const val = JSON.parse(raw);
            return val === undefined ? fallback : val;
        } catch (err) {
            return fallback;
        }
    }

    function legacyBooks() {
        return (legacyGet('wbm-fav-books', []) || []).map(String);
    }

    function legacyEntries() {
        return (legacyGet('wbm-fav-entries', []) || []).filter((x) => x && x.book && x.uid !== undefined);
    }

    function legacyClear() {
        try {
            ['wbm-fav-books', 'wbm-fav-pin', 'wbm-fav-entries', 'wbm-fav-entry-pin']
                .forEach((key) => window.localStorage.removeItem(key));
        } catch (err) { /* 清不掉也无所谓，只是留了点垃圾 */ }
    }

    function unionBooks(a, b) {
        const out = [];
        (Array.isArray(a) ? a : []).concat(Array.isArray(b) ? b : []).forEach((x) => {
            const name = String(x || '');
            if (name && out.indexOf(name) === -1) out.push(name);
        });
        return out;
    }

    function unionEntries(a, b) {
        const out = [];
        const seen = new Set();
        (Array.isArray(a) ? a : []).concat(Array.isArray(b) ? b : []).forEach((x) => {
            if (!x || !x.book || x.uid === undefined) return;
            const key = JSON.stringify([String(x.book), String(x.uid)]);
            if (seen.has(key)) return;
            seen.add(key);
            out.push(x);
        });
        return out;
    }

    /* 搜索范围只存三个面的 id；读到坏数据就退回"三面全开"（＝原生行为） */
    function normalizeSearchScope(raw, fallback) {
        if (!Array.isArray(raw)) return (fallback || SEARCH_SCOPE_VALUES).slice();
        const out = [];
        raw.forEach((item) => {
            const value = String(item || '');
            if (SEARCH_SCOPE_VALUES.indexOf(value) === -1) return;
            if (out.indexOf(value) === -1) out.push(value);
        });
        return out;
    }

    async function resolveSettingsApi() {        /* 首选宿主挂在 window 上的上下文：extensionSettings 与 saveSettingsDebounced 都在里面
           （st-context.js:200 / :131），不依赖模块路径，最不容易失效。 */
        try {
            const ctx = window.SillyTavern && typeof window.SillyTavern.getContext === 'function'
                ? window.SillyTavern.getContext() : null;
            if (ctx && ctx.extensionSettings && typeof ctx.extensionSettings === 'object') {
                return {
                    settings: ctx.extensionSettings,
                    save: typeof ctx.saveSettingsDebounced === 'function' ? ctx.saveSettingsDebounced : null,
                };
            }
        } catch (err) { /* 退到模块导入 */ }

        let settings = null;
        /* 扩展位于 /scripts/extensions/third-party/<名>/，所以 ../../extensions.js = /scripts/extensions.js */
        for (const path of ['../../extensions.js', '/scripts/extensions.js']) {
            try {
                const mod = await import(path);
                if (mod && mod.extension_settings && typeof mod.extension_settings === 'object') {
                    settings = mod.extension_settings;
                    break;
                }
            } catch (err) { /* 换下一个候选 */ }
        }
        if (!settings) return null;
        let save = null;
        for (const path of ['/script.js', '../../../../script.js']) {
            try {
                const mod = await import(path);
                if (mod && typeof mod.saveSettingsDebounced === 'function') { save = mod.saveSettingsDebounced; break; }
            } catch (err) { /* 换下一个候选 */ }
        }
        return { settings, save };
    }

    async function loadStore() {
        settingsApi = await resolveSettingsApi();
        const legacy = {
            books: legacyBooks(),
            /* 旧版是裸字符串 '0'/'1' 存的，JSON.parse 之后是数字 1/0，按值比不要比字符串 */
            pin: Number(legacyGet('wbm-fav-pin', 0)) === 1,
            entries: legacyEntries(),
            entryPin: Number(legacyGet('wbm-fav-entry-pin', 0)) === 1,
        };
        const hasLegacy = !!(legacy.books.length || legacy.entries.length || legacy.pin || legacy.entryPin);

        if (settingsApi) {
            const cfg = settingsApi.settings[SETTINGS_KEY];
            const hasCfg = !!(cfg && typeof cfg === 'object');
            /* 先把"真正生效的那份"装进内存，再谈写盘：persistStore 是从 store 抄回去的，
               顺序反了会把刚迁移/刚合并的收藏写成空数组。 */
            if (hasCfg) {
                store.favBooks = Array.isArray(cfg.favBooks) ? cfg.favBooks.map(String) : [];
                store.favPin = !!cfg.favPin;
                store.favEntries = Array.isArray(cfg.favEntries)
                    ? cfg.favEntries.filter((x) => x && x.book && x.uid !== undefined) : [];
                store.entryFavPin = !!cfg.entryFavPin;
                store.entryClickLock = cfg.entryClickLock !== false;
                store.msgDblClickEdit = cfg.msgDblClickEdit !== false;
                store.swipeTakeover = cfg.swipeTakeover !== false;
                store.regexGuard = (cfg.regexGuard && Array.isArray(cfg.regexGuard.ids)) ? cfg.regexGuard : null;
                store.personaGroups = (cfg.personaGroups && typeof cfg.personaGroups === 'object') ? cfg.personaGroups : {};
                store.personaFilter = typeof cfg.personaFilter === 'string' ? cfg.personaFilter : '';
                store.personaPerPageSaved = typeof cfg.personaPerPageSaved === 'string' ? cfg.personaPerPageSaved : '';
                store.personaPageSize = [5, 10, 20, 50].indexOf(Number(cfg.personaPageSize)) >= 0 ? Number(cfg.personaPageSize) : 10;
                store.talkPresetGroups = (cfg.talkPresetGroups && typeof cfg.talkPresetGroups === 'object') ? cfg.talkPresetGroups : {};
                store.editBarBothEnds = cfg.editBarBothEnds !== false;
                store.enhanceEnabled = cfg.enhanceEnabled !== false;
                store.features = Object.assign({}, FEATURE_DEFAULTS, (cfg.features && typeof cfg.features === 'object') ? cfg.features : {});
                store.searchScope = normalizeSearchScope(cfg.searchScope, SEARCH_SCOPE_VALUES.slice());
                store.catChatBooks = Array.isArray(cfg.catChatBooks) ? cfg.catChatBooks.map(String) : [];
                store.catChatAt = Number(cfg.catChatAt) || 0;
                store.catChatCount = Number(cfg.catChatCount) || 0;
                store.catCharBooks = Array.isArray(cfg.catCharBooks) ? cfg.catCharBooks.map(String) : [];
                store.catCharAt = Number(cfg.catCharAt) || 0;
                store.catCharCount = Number(cfg.catCharCount) || 0;
                store.presets = normalizePresets(cfg.presets);
                store.presetGroups = normalizeGroups(cfg.presetGroups);
                /* 指向已不存在的分组的预设，一律回到未分组 */
                store.presets.forEach((preset) => {
                    if (preset.groupId && !store.presetGroups.some((group) => group.id === preset.groupId)) {
                        preset.groupId = '';
                    }
                });
                store.customBooks = Array.isArray(cfg.customBooks) ? cfg.customBooks.map(String) : [];
            } else {
                store.favBooks = legacy.books;
                store.favPin = legacy.pin;
                store.favEntries = legacy.entries;
                store.entryFavPin = legacy.entryPin;
            }
            if (!hasCfg) {
                /* 第一次跑：把以前留在浏览器里的收藏搬进服务端设置，并立刻写盘，好当场核对 */
                persistStore();
            } else if (hasLegacy) {
                /* 这台设备上还留着旧版存在浏览器里的收藏：并进服务端那份，两台设备各标过的星都不丢；
                   并完之后清掉本地副本，免得以后这里的老数据把已取消的收藏又顶回来。 */
                store.favBooks = unionBooks(store.favBooks, legacy.books);
                store.favEntries = unionEntries(store.favEntries, legacy.entries);
                store.favPin = store.favPin || legacy.pin;
                store.entryFavPin = store.entryFavPin || legacy.entryPin;
                persistStore();
            }
            /* 旧版操作历史存在 localStorage，第一次进新版时搬进设置里（搬完保留原键，
               万一新写法失效还能退回读取，代价只是一份几 KB 的旧副本） */
            const bucket = settingsApi.settings[SETTINGS_KEY];
            if (bucket && typeof bucket === 'object' && !Array.isArray(bucket.history)) {
                const old = readLegacyHistory();
                if (old.length) {
                    bucket.history = old;
                    persistStore();
                }
            }
            store.mode = 'server';
            if (hasLegacy) setTimeout(legacyClear, 5000);
        } else {
            store.favBooks = legacy.books;
            store.favPin = legacy.pin;
            store.favEntries = legacy.entries;
            store.entryFavPin = legacy.entryPin;
            store.searchScope = normalizeSearchScope(legacyGet('wbm-search-scope', null), SEARCH_SCOPE_VALUES.slice());
            store.mode = 'local';
            console.error('[wbm] 取不到酒馆的 extension_settings，收藏只能暂存浏览器，手机不会同步');
        }
        store.loaded = true;
        console.info('[wbm] 收藏存储=' + store.mode + '，书 ' + store.favBooks.length
            + ' 本、条目 ' + store.favEntries.length + ' 条');
        /* 便于在控制台核对：__wbmStore() */
        window.__wbmStore = () => ({
            mode: store.mode,
            hasApi: !!settingsApi,
            books: store.favBooks.length,
            entries: store.favEntries.length,
            inSettings: !!(settingsApi && settingsApi.settings[SETTINGS_KEY]),
        });
    }

    function persistStore() {
        if (settingsApi && settingsApi.settings) {
            /* 就地改我们那个对象：历史也住在里面，整块重建会把它冲掉 */
            const cfg = settingsBucket() || {};
            cfg.favBooks = store.favBooks.slice();
            cfg.favPin = !!store.favPin;
            cfg.favEntries = store.favEntries.slice();
            cfg.entryFavPin = !!store.entryFavPin;
            cfg.entryClickLock = store.entryClickLock !== false;
            cfg.msgDblClickEdit = store.msgDblClickEdit !== false;
            cfg.swipeTakeover = store.swipeTakeover !== false;
            cfg.personaGroups = (store.personaGroups && typeof store.personaGroups === 'object') ? store.personaGroups : {};
            cfg.personaFilter = String(store.personaFilter || '');
            cfg.personaPerPageSaved = String(store.personaPerPageSaved || '');
            cfg.personaPageSize = Number(store.personaPageSize) || 10;
            cfg.regexGuard = (store.regexGuard && Array.isArray(store.regexGuard.ids))
                ? { ids: store.regexGuard.ids.slice(), at: Number(store.regexGuard.at) || 0 }
                : null;
            cfg.talkPresetGroups = (store.talkPresetGroups && typeof store.talkPresetGroups === 'object') ? store.talkPresetGroups : {};
            cfg.editBarBothEnds = store.editBarBothEnds !== false;
            cfg.enhanceEnabled = store.enhanceEnabled !== false;
            cfg.features = Object.assign({}, FEATURE_DEFAULTS, (store.features && typeof store.features === 'object') ? store.features : {});
            cfg.searchScope = normalizeSearchScope(store.searchScope, SEARCH_SCOPE_VALUES.slice());
            store.searchScope = cfg.searchScope.slice();
            cfg.catChatBooks = store.catChatBooks.slice();
            cfg.catChatAt = Number(store.catChatAt) || 0;
            cfg.catChatCount = Number(store.catChatCount) || 0;
            cfg.catCharBooks = store.catCharBooks.slice();
            cfg.catCharAt = Number(store.catCharAt) || 0;
            cfg.catCharCount = Number(store.catCharCount) || 0;
            cfg.presets = store.presets.map((p) => ({ id: p.id, name: p.name, books: p.books.slice(), groupId: p.groupId || '' }));
            cfg.presetGroups = store.presetGroups.map((g) => ({ id: g.id, name: g.name }));
            cfg.customBooks = store.customBooks.slice();
            if (!Array.isArray(cfg.history)) cfg.history = [];
            settingsApi.settings[SETTINGS_KEY] = cfg;
            if (typeof settingsApi.save === 'function') settingsApi.save();
            return;
        }
        try {
            window.localStorage.setItem('wbm-fav-books', JSON.stringify(store.favBooks));
            window.localStorage.setItem('wbm-fav-pin', store.favPin ? '1' : '0');
            window.localStorage.setItem('wbm-fav-entries', JSON.stringify(store.favEntries));
            window.localStorage.setItem('wbm-fav-entry-pin', store.entryFavPin ? '1' : '0');
            window.localStorage.setItem('wbm-search-scope', JSON.stringify(store.searchScope));
        } catch (err) {
            console.warn('[wbm] 收藏保存失败', err);
        }
    }

    /* ---------------- 收藏（只加星标与筛选，不改动酒馆的排序语义） ---------------- */

    const FAV_KEY = 'wbm-fav-books';
    const FAV_PIN_KEY = 'wbm-fav-pin';

    function favSet() {
        return new Set(store.favBooks);
    }

    function saveFavSet(set) {
        store.favBooks = Array.from(set);
        persistStore();
    }

    function favPinOn() {
        return !!store.favPin;
    }

    function setFavPin(on) {
        store.favPin = !!on;
        persistStore();
    }

    function jumpToEditor(name) {
        const sel = document.querySelector('#world_editor_select');
        if (!sel) return;
        let index = null;
        for (const opt of sel.options) {
            if (String(opt.textContent || '').trim() === name && String(opt.value || '') !== '') { index = opt.value; break; }
        }
        if (index === null) { toast('warning', '世界书列表还没加载完'); return; }
        if (String(sel.value) === String(index)) { toast('info', '正在编辑：' + name); return; }
        sel.value = index;
        fireChange(sel);
        state.signature = '';
        render();
        toast('info', '已跳转：' + name);
    }

    /* ---------------- 「选择以编辑」接管（手机端：可搜索的选择面板） ---------------- */

    const EDITOR_PLACEHOLDER = '--- 选择以编辑 ---';

    let lastEditorOpen = 0;
    function requestEditorPicker() {
        /* pointerdown 与 click 都会来，500ms 内只认一次 */
        const now = Date.now();
        if (now - lastEditorOpen < 500) return;
        lastEditorOpen = now;
        openEditorPicker();
    }

    function editorSelect() { return document.querySelector('#world_editor_select'); }

    /* 关面板：留 190ms 让退场动画跑完；这期间遮罩仍在 DOM 里，顺手挡住那一下点击别穿透到背后 */
    function closeEditorPicker(immediate) {
        document.querySelectorAll('.wbm-picker').forEach((mask) => {
            /* 已经标过 closing 但还挂在页面上的：说明上次的 190ms 没跑到，
               这里直接摘掉，否则它会一直拦截点击（2026-10-21 人设浮层「卡住」的真因）。 */
            if (mask.dataset.closing === '1') { mask.remove(); return; }
            if (immediate === true) { mask.remove(); return; }
            mask.dataset.closing = '1';
            mask.style.pointerEvents = 'none';
            mask.classList.add('closing');
            setTimeout(() => mask.remove(), 190);
        });
        if (state.picker && !state.picker.isConnected) state.picker = null;
    }

    function currentEditingName() {
        const sel = editorSelect();
        if (!sel) return '';
        const picked = sel.selectedOptions && sel.selectedOptions[0];
        if (!picked || String(picked.value || '') === '') return '';
        return String(picked.textContent || '').trim();
    }

    /* 世界书的真实名字可能带首尾空格（酒馆允许；实测本机就有 6 本书的文件名以空格结尾）。
拿它当内部名传给 loadWorldInfo / moveWorldInfoEntry 时不能去掉空格，否则酒馆按名字查表查不到，
会弹「目标世界书 “X” 未找到」。界面照旧显示去掉空格的样子，交给酒馆的永远是原串。 */
function rawBookName(name) {
    const wanted = String(name || '');
    const raw = Array.from(document.querySelectorAll('#world_info option'))
        .map((opt) => String(opt.textContent || ''))
        .filter((text) => text !== '');
    if (raw.indexOf(wanted) !== -1) return wanted;
    const trimmed = wanted.trim();
    const hit = raw.find((text) => text.trim() === trimmed);
    return hit === undefined ? wanted : hit;
}

function allBookRawNames() {
    const out = [];
    document.querySelectorAll('#world_info option').forEach((opt) => {
        const text = String(opt.textContent || '');
        const value = String(opt.value || '');
        if (text !== '' && value !== '') out.push(text);
    });
    return out;
}

function updateEditorButton() {
        const btn = document.querySelector('.wbm-editor-btn');
        if (!btn) return;
        const name = currentEditingName();
        btn.textContent = name ? '编辑中：' + name : EDITOR_PLACEHOLDER;
        btn.classList.toggle('active', !!name);
    }

    /* ---------------- 手机端：宿主那几个原生 <select> 换成我们的浮层 ----------------
       手机点 <select> 弹的是系统自己的选择器（圆角滚轮/列表），跟酒馆主题完全两张皮，
       而且它盖住页面、选完才回来。这几个字段都是常用项，统一走我们自己的窗口：
       同样的遮罩与卡片、点一下即生效。桌面端不动（有 select2 / 原生下拉本来就顺手）。 */

    const NATIVE_SELECT_TITLES = {
        position: '插入位置',
        entryLogicType: '关键词逻辑',
        entryStateSelector: '条目状态',
        caseSensitive: '区分大小写',
        matchWholeWords: '整词匹配',
        useGroupScoring: '分组计分',
    };

    /* 工具栏上这两个也是原生下拉：条目排序（优先级/自定义/深度…）与每页条目数。
       它们不在条目列表里，单击保护管不到，所以这里自己拦——同样是"双击才开"。 */
    const TOOLBAR_SELECT_SPECS = [
        { selector: '#world_info_sort_order', title: '条目排序' },
        { selector: 'select.J-paginationjs-size-select', title: '每页条目数' },
    ];

    function toolbarSelectSpec(select) {
        if (!select || select.tagName !== 'SELECT') return null;
        for (const spec of TOOLBAR_SELECT_SPECS) {
            try {
                if (select.matches(spec.selector)) return spec;
            } catch (err) { /* 选择器写错就当没匹配 */ }
        }
        return null;
    }

    function compactViewport() {
        try {
            return window.matchMedia('(max-width: 760px), (max-width: 1100px) and (max-height: 520px), (max-width: 1100px) and (pointer: coarse)').matches;
        } catch (err) {
            return false;
        }
    }

    function nativeSelectWanted(select) {
        if (!select || select.tagName !== 'SELECT') return false;
        if (toolbarSelectSpec(select)) return true;
        if (!select.closest('#world_popup')) return false;
        return Object.prototype.hasOwnProperty.call(NATIVE_SELECT_TITLES, String(select.name || ''));
    }

    function nativeSelectTitle(select) {
        const spec = toolbarSelectSpec(select);
        if (spec) return spec.title;
        return NATIVE_SELECT_TITLES[String(select.name || '')] || '选择';
    }

    let nativePickerAt = 0;
    let nativePickerNode = null;

    /* 触发策略的三个选项在宿主里只有 emoji（index.html:7159 的 option 文本是 🔵/🟢/🔗，
       文字说明写在 title 上）。浮层里光显示一个圆圈看不出区别，这里补上中文状态名。 */
    const ENTRY_STATE_OPTION_LABELS = { constant: '🔵 常量', normal: '🟢 正常', vectorized: '🔗 向量化' };

    function nativeOptionLabel(select, option) {
        const value = String(option.value || '');
        if (String(select.name || '') === 'entryStateSelector' && ENTRY_STATE_OPTION_LABELS[value]) {
            return ENTRY_STATE_OPTION_LABELS[value];
        }
        const text = String(option.textContent || '').trim();
        return text || value;
    }

    function openNativeSelectPicker(select, onClose) {
        try {
            closeEditorPicker(true);
            const { mask, sheet } = makePickerShell();
            state.picker = mask;
            sheet.appendChild(el('div', 'wbm-picker-grip'));
            sheet.appendChild(el('div', 'wbm-picker-title', nativeSelectTitle(select)));
            const list = el('div', 'wbm-picker-list wbm-native-select-list');
            const all = Array.from(select.options);
            all.forEach((option, index) => {
                const label = nativeOptionLabel(select, option);
                if (option.hidden || !label) return;
                const row = el('div', 'wbm-picker-row' + (option.selected ? ' active' : ''));
                row.dataset.role = 'native-option';
                row.dataset.index = String(index);
                row.appendChild(el('span', 'wbm-picker-name', label));
                row.appendChild(el('span', 'wbm-picker-radio'));
                list.appendChild(row);
            });
            sheet.appendChild(list);
            mask.addEventListener('click', (event) => {
                const target = event.target;
                if (!(target instanceof Element)) return;
                if (target === mask) {
                    closeEditorPicker();
                    if (onClose) onClose();
                    return;
                }
                const row = target.closest('[data-role="native-option"]');
                if (!row) return;
                event.preventDefault();
                event.stopPropagation();
                const option = select.options[Number(row.dataset.index)];
                if (option) {
                    Array.from(select.options).forEach((opt) => { opt.selected = (opt === option); });
                    /* 条目表单里的下拉，宿主全部挂在 **input** 上（world-info.js 的
                       entryStateSelector:3209、position:3338、entryLogicType:3524 都是 .on('input')），
                       只派 change 等于当场白改：界面看着变了、saveWorldInfo 一次都没发，重绘后又缩回原值。
                       工具栏那两个下拉（排序 / 每页）挂的是 change，所以两个都派，两头都满足。 */
                    select.dispatchEvent(new Event('input', { bubbles: true }));
                    select.dispatchEvent(new Event('change', { bubbles: true }));
                }
                closeEditorPicker();
                if (onClose) onClose();
            });
            document.documentElement.appendChild(mask);
        } catch (err) {
            console.warn('[wbm] 原生下拉换浮层失败', err);
        }
    }

    function bindNativeSelectPicker() {
        if (bindNativeSelectPicker.done) return;
        bindNativeSelectPicker.done = true;
        /* 手机端：换成我们自己的浮层（master 认可）。
           电脑端：保留宿主原本的下拉，只加"双击解锁"——第一下拦掉并提示，第二下放行让原生下拉弹出来；
           所以电脑端不存在浮窗，也不会出现"双击打开又被第二下点到空处关掉"这种反人类的循环。 */
        const swallow = (event) => {
            event.preventDefault();
            event.stopPropagation();
            if (typeof event.stopImmediatePropagation === 'function') event.stopImmediatePropagation();
        };
        const handler = (event) => {
            if (!(event.target instanceof Element)) return;
            if (!enhancementsOn()) return;
            const target = event.target;
            const select = target.closest('select');
            if (!select) return;
            const spec = toolbarSelectSpec(select);
            /* 条目表单里的下拉由"单击保护"那条链路负责（双击进来），这里只管工具栏这两个 */
            if (!spec) return;
            if (select.options.length < 2) return;
            const now = Date.now();
            /* 同一次按压会先来 touchstart 再来 mousedown：60ms 内的算同一下 */
            if (nativePickerNode === select && now - nativePickerAt < 60) {
                nativePickerAt = now;
                if (compactViewport()) swallow(event);
                return;
            }
            if (nativePickerNode === select && now - nativePickerAt < 500) {
                nativePickerNode = null;
                nativePickerAt = 0;
                if (compactViewport()) {
                    swallow(event);
                    openNativeSelectPicker(select);
                }
                /* 电脑端：这一下不拦，宿主自己的下拉就弹出来了 */
                return;
            }
            nativePickerNode = select;
            nativePickerAt = now;
            swallow(event);
            toast('info', (compactViewport() ? '双击打开：' : '双击解锁：') + spec.title);
        };
        ['mousedown', 'touchstart'].forEach((type) => {
            document.addEventListener(type, handler, { capture: true, passive: false });
        });
    }

    /* ---------------- 选择以编辑：这些书各自是什么来路 ---------------- */

    /* ST 1.18 的来源（public/scripts/world-info.js）：
       角色卡主书 = character.data.extensions.world（:4369）
       附加世界书 = 设置里的 world_info.charLore[{name: 角色文件名, extraBooks:[]}]（:4376），
                    键是 getCharaFilename 算出的名字（avatar 去掉扩展名），不是显示名；
       聊天世界书 = chat_metadata.world_info（:4433）
       人设世界书 = power_user.persona_description_lorebook（:4454）
       全局世界书 = 这批就是「已启用为全局」的书，直接读 #world_info 的 selected 状态。
       注意：这台机的 script.js 是 module，characters / chat_metadata / world_info 都不在 window 上，
       只能走 getContext()，而 getContext 没暴露 world_info 设置对象，所以附加书得走一次接口。 */
    const CHAR_LORE_TTL = 60000;
    let charLoreCache = { at: 0, data: null };

    function stCtx() {
        try {
            const t = window.SillyTavern;
            return t && typeof t.getContext === 'function' ? t.getContext() : null;
        } catch (err) {
            return null;
        }
    }

    function currentCharFileName() {
        const ctx = stCtx();
        const ch = ctx && Array.isArray(ctx.characters) ? ctx.characters[ctx.characterId] : null;
        const avatar = ch && ch.avatar ? String(ch.avatar) : '';
        return avatar ? avatar.replace(/\.[^/.]+$/, '') : '';
    }

    /* 只取一次、缓存一分钟；拿不到就返回 null，面板照旧平铺，不会空 */
    async function ensureCharLore() {
        const now = Date.now();
        if (charLoreCache.data && now - charLoreCache.at < CHAR_LORE_TTL) return charLoreCache.data;
        try {
            const ctx = stCtx();
            if (!ctx || typeof ctx.getRequestHeaders !== 'function') return null;
            const headers = await ctx.getRequestHeaders();
            const res = await fetch('/api/settings/get', {
                method: 'POST',
                headers: Object.assign({ 'Content-Type': 'application/json' }, headers || {}),
                body: JSON.stringify({}),
            });
            if (!res.ok) return null;
            const data = await res.json();
            /* 这版酒馆的 /api/settings/get 把 settings 当 JSON 字符串塞回来（不是对象），
               不 parse 就永远查不到 world_info_settings，附加世界书那一组会一直是空的。 */
            let st = data && data.settings;
            if (typeof st === 'string') {
                try { st = JSON.parse(st); } catch (err) { st = null; }
            }
            const wi = st && st.world_info_settings && st.world_info_settings.world_info;
            charLoreCache = { at: Date.now(), data: wi || {} };
            return charLoreCache.data;
        } catch (err) {
            console.warn('[wbm] 取不到 world_info 设置，附加世界书这一组暂缺', err);
            return null;
        }
    }

    /* 分栏：一本书只进第一个命中的组（顺序即优先级），空组直接丢掉 */
    function editorBookGroups() {
        const sel = editorSelect();
        if (!sel) return [];
        const lower = (s) => String(s || '').trim().toLowerCase();
        const ctx = stCtx();
        const ch = ctx && Array.isArray(ctx.characters) ? ctx.characters[ctx.characterId] : null;
        const charWorld = ch && ch.data && ch.data.extensions ? ch.data.extensions.world : '';
        const chatWorld = ctx && ctx.chatMetadata ? ctx.chatMetadata.world_info : '';
        const personaWorld = ctx && ctx.powerUserSettings ? ctx.powerUserSettings.persona_description_lorebook : '';

        const charFile = currentCharFileName();
        const extraBooks = [];
        const wi = charLoreCache.data;
        if (wi && Array.isArray(wi.charLore) && charFile) {
            wi.charLore.forEach((item) => {
                if (item && item.name === charFile && Array.isArray(item.extraBooks)) {
                    item.extraBooks.forEach((b) => { if (b) extraBooks.push(lower(b)); });
                }
            });
        }

        const globals = new Set();
        document.querySelectorAll('#world_info option').forEach((opt) => {
            if (opt.selected && String(opt.value || '') !== '') globals.add(lower(opt.textContent));
        });

        const buckets = {
            character: { title: '角色卡世界书', names: [] },
            extra: { title: '附加世界书', names: [] },
            chat: { title: '聊天世界书', names: [] },
            persona: { title: '人设世界书', names: [] },
            global: { title: '全局世界书', names: [] },
            other: { title: '其他世界书', names: [] },
        };

        for (const opt of sel.options) {
            const value = String(opt.value || '');
            const name = String(opt.textContent || '').trim();
            if (value === '' || !name) continue;
            const key = lower(name);
            let bucket = 'other';
            if (charWorld && lower(charWorld) === key) bucket = 'character';
            else if (extraBooks.indexOf(key) !== -1) bucket = 'extra';
            else if (chatWorld && lower(chatWorld) === key) bucket = 'chat';
            else if (personaWorld && lower(personaWorld) === key) bucket = 'persona';
            else if (globals.has(key)) bucket = 'global';
            buckets[bucket].names.push({ name, value });
        }

        return ['character', 'extra', 'chat', 'persona', 'global', 'other']
            .map((k) => buckets[k])
            .filter((b) => b.names.length > 0);
    }

    function pickerRow(book, current) {
        const row = el('div', 'wbm-picker-row' + (book.value === current ? ' active' : ''));
        row.dataset.role = 'picker-row';
        row.dataset.value = book.value;
        row.dataset.name = book.name;
        row.appendChild(el('span', 'wbm-picker-name', book.name));
        row.appendChild(el('span', 'wbm-picker-radio'));
        return row;
    }

    /* 没有搜索词时分栏（空组不出现）；一旦输入搜索词就取消分栏、平铺命中项，
       搜索是"找某一本"的场景，分组只会把命中拆散。 */
    function fillEditorPickerList(list, query) {
        const sel = editorSelect();
        if (!sel) return;
        const current = String(sel.value || '');
        const q = String(query || '').trim().toLowerCase();
        list.textContent = '';

        const none = el('div', 'wbm-picker-row wbm-picker-exit' + (current === '' ? ' active' : ''));
        none.dataset.role = 'picker-row';
        none.dataset.value = '';
        none.dataset.name = '--- 选择以编辑 ---';
        none.appendChild(el('span', 'wbm-picker-name', '--- 选择以编辑 ---'));
        none.appendChild(el('span', 'wbm-picker-radio'));
        list.appendChild(none);

        if (q) {
            let hits = 0;
            for (const opt of sel.options) {
                const value = String(opt.value || '');
                const name = String(opt.textContent || '').trim();
                if (value === '' || !name) continue;
                if (name.toLowerCase().indexOf(q) === -1) continue;
                list.appendChild(pickerRow({ name, value }, current));
                hits += 1;
            }
            if (hits === 0) list.appendChild(el('div', 'wbm-none', '没有匹配的世界书'));
            return;
        }

        const groups = editorBookGroups();
        groups.forEach((group) => {
            const head = el('div', 'wbm-picker-group');
            head.appendChild(el('b', 'wbm-picker-group-title', group.title));
            head.appendChild(el('span', 'wbm-picker-group-count', String(group.names.length)));
            list.appendChild(head);
            group.names.forEach((book) => list.appendChild(pickerRow(book, current)));
        });
        if (!groups.length) list.appendChild(el('div', 'wbm-none', '还没有世界书'));
    }

    function filterEditorPicker(query) {
        const mask = state.picker;
        if (!mask || !mask.isConnected) return;
        const list = mask.querySelector('.wbm-picker-list');
        if (!list) return;
        const top = list.scrollTop;
        fillEditorPickerList(list, query);
        list.scrollTop = top;
    }

    /* 浮层外壳（遮罩 + 面板）：两个选择器（选择以编辑 / 移动·复制目标）共用。
       几何全写 inline，不依赖样式表能否命中，也不怕被宿主的层叠上下文压制。 */
    /* 键盘（视觉视口）真正遮住的高度 → 弹窗该上移多少像素：取一半正好把它挪到可见区中央；
       上限 160px，免得极端情况下把窗口顶出屏幕。Chrome 缩小布局视口时算出来是 0。 */
    function keyboardShiftPx(innerH, vvH, vvTop) {
        const covered = Math.max(0, Number(innerH || 0) - (Number(vvH || 0) + Number(vvTop || 0)));
        return Math.min(Math.round(covered / 2), 160);
    }

    function makePickerShell(opts) {
        /* flat：不要 backdrop-filter。人设浮层底下压着整屏头像，模糊每帧都要重算，
           低配机上会明显发卡（master 2026-10-21 报「点开分组就卡住」）。 */
        const flat = !!(opts && opts.flat);
        const mask = el('div', 'wbm-picker');
        const vw = Math.max(document.documentElement.clientWidth || 0, window.innerWidth || 0);
        const vh = Math.max(document.documentElement.clientHeight || 0, window.innerHeight || 0);
        /* 手机与桌面都垂直居中（同一套窗口） */
        const desktop = vw > 1000;
        mask.style.position = 'fixed';
        mask.style.top = '0';
        mask.style.left = '0';
        /* 遮罩尺寸下面统一用像素算（layout 函数），这里不给默认值：
           用 100% 时，一旦宿主的包含块不是视口（例如 html 被加过 transform/fixed），
           percentage 会算成 0，窗口就被摆到屏幕上方去了——手机端上一版正是这么翻车的。 */
        mask.style.zIndex = '2147483000';
        mask.style.display = 'flex';
        /* 两端都垂直居中：手机键盘弹起时，贴底的窗口会被输入法整块盖住 */
        mask.style.alignItems = 'center';
        mask.style.justifyContent = 'center';
        mask.style.background = 'rgba(0,0,0,.62)';
        /* 挂到 <html> 后不再继承 body 的字体/颜色，这里手动接上，避免出现系统默认黑字 */
        const bodyStyle = window.getComputedStyle(document.body);
        mask.style.fontFamily = bodyStyle.fontFamily;
        mask.style.fontSize = bodyStyle.fontSize;
        mask.style.color = bodyStyle.color;

        /* 关键：ST 在 <html> 上绑了 touchstart/mousedown「点到面板外面就收起所有抽屉」
           （script.js:12090-12128）。浮层挂在 <html> 下，天然在 .openDrawer 之外，
           而且不在它的白名单（.text_pole / .popup / …）里，所以手指一按，
           ST 就判定成"点了世界书面板外面"，直接把抽屉收掉。
           这里让浮层自己吃掉按压类事件，别让它们冒到 <html>/document。 */
        const stopPress = (event) => { event.stopPropagation(); };
        ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'touchstart', 'touchend', 'contextmenu', 'wheel', 'click']
            .forEach((type) => mask.addEventListener(type, stopPress, { passive: true }));

        /* 头部那个 ✕（data-role="picker-close"）由各浮层自己接事件时经常漏接，
           人设浮层就是漏接的那一个：✕ 画了出来但点它没反应。
           这里在遮罩层统一兜一次，任何浮层的 ✕ 都能关。 */
        mask.addEventListener('click', (event) => {
            const target = event.target;
            if (target instanceof Element && target.closest('[data-role="picker-close"]')) {
                event.preventDefault();
                closeEditorPicker();
            }
        });

        /* 按在浮层空白处滑动时不要带动背后页面滚（列表内的滚动仍交给浏览器原生处理） */
        mask.addEventListener('touchmove', (event) => {
            const target = event.target;
            if (target instanceof Element && target.closest('.wbm-picker-list, .wbm-picker-head, .wbm-prev-body')) return;
            event.stopPropagation();
            if (event.cancelable) event.preventDefault();
        }, { passive: false });

        const sheet = el('div', 'wbm-picker-sheet');
        sheet.style.display = 'flex';
        sheet.style.flexDirection = 'column';
        sheet.style.width = '100%';
        sheet.style.maxWidth = '760px';
        sheet.style.margin = '8px';
        sheet.style.borderRadius = '16px';
        sheet.style.border = '1px solid var(--SmartThemeBorderColor, rgba(255,255,255,.16))';
        sheet.style.background = 'var(--SmartThemeBlurTintColor, rgba(28,28,38,.96))';
        sheet.style.color = 'var(--SmartThemeBodyColor, inherit)';
        if (!flat) sheet.style.backdropFilter = 'blur(10px)';
        sheet.style.overflow = 'hidden';
        mask.appendChild(sheet);

        /* 尺寸全部按像素现算，并在窗口存续期间跟着「窗口变化 / 转屏 / 键盘」重算：
           · 遮罩 = 当前视口大小（不用 %，避免包含块不是视口时算成 0）；
           · 窗口高度上限 = 视口的 76%（桌面 78%），封顶 640px，横屏时自然变矮、内部滚动；
           · 键盘补偿只在"窗口里的输入框真的获得焦点"时生效——否则手机浏览器地址栏
             收起/展开也会被当成键盘，把窗口往上顶（上一版就是这么顶到页眉下面的）。
           事件都是被动的，不轮询；窗口关掉后自动摘监听。 */
        const layout = () => {
            const vwNow = Math.round(window.innerWidth || (document.documentElement.clientWidth || 0));
            const vhNow = Math.round(window.innerHeight || (document.documentElement.clientHeight || 0));
            if (vwNow > 0) mask.style.width = vwNow + 'px';
            if (vhNow > 0) mask.style.height = vhNow + 'px';
            const cap = Math.max(220, Math.min(Math.round(vhNow * (desktop ? 0.78 : 0.76)), 640));
            sheet.style.maxHeight = cap + 'px';
        };

        const sheetShift = () => {
            const active = document.activeElement;
            const typing = !!active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA')
                && sheet.contains(active);
            let shift = 0;
            if (typing && window.visualViewport) {
                const box = window.visualViewport;
                shift = keyboardShiftPx(window.innerHeight, box.height, box.offsetTop);
            }
            sheet.style.transform = shift > 1 ? 'translateY(-' + shift + 'px)' : '';
        };

        const vv = window.visualViewport;
        const follow = () => {
            if (!sheet.isConnected) {
                if (vv) {
                    vv.removeEventListener('resize', follow);
                    vv.removeEventListener('scroll', follow);
                }
                window.removeEventListener('resize', follow);
                window.removeEventListener('orientationchange', follow);
                return;
            }
            layout();
            sheetShift();
        };
        /* 1.3.48：全局监听必须在浮层被摘掉时同步摘除。
           以前只在 follow() 被 resize 事件触发、且发现 sheet 已断开时才自己摘——
           窗口不变就永远摘不掉，每个浮层留一份闭包把整棵树（几百个节点、两百多个监听）
           一起拽住（实测开关 20 次泄漏 +14263 节点 / +5420 监听器）。 */
        const teardown = () => {
            if (mask.__wbmTornDown) return;
            mask.__wbmTornDown = true;
            if (vv) {
                vv.removeEventListener('resize', follow);
                vv.removeEventListener('scroll', follow);
            }
            window.removeEventListener('resize', follow);
            window.removeEventListener('orientationchange', follow);
        };
        if (vv) {
            vv.addEventListener('resize', follow);
            vv.addEventListener('scroll', follow);
        }
        window.addEventListener('resize', follow);
        window.addEventListener('orientationchange', follow);
        const rawRemove = mask.remove.bind(mask);
        mask.remove = () => { teardown(); rawRemove(); };
        layout();
        return { mask, sheet };
    }

    /* 搜索胶囊 + ✕ 的头部（两个选择器共用） */
    function buildPickerHead(placeholder) {
        const head = el('div', 'wbm-picker-head');
        const field = el('div', 'wbm-picker-field');
        const icon = el('i', 'wbm-picker-icon fa-solid fa-magnifying-glass');
        const input = el('input', 'wbm-picker-search');
        input.type = 'search';
        input.dataset.role = 'picker-search';
        input.placeholder = placeholder;
        input.setAttribute('autocomplete', 'off');
        input.setAttribute('spellcheck', 'false');
        const close = el('button', 'wbm-picker-close', '✕');
        close.type = 'button';
        close.dataset.role = 'picker-close';
        field.appendChild(icon);
        field.appendChild(input);
        head.appendChild(field);
        head.appendChild(close);
        return { head, input };
    }

    /* 原生 select 的列表是系统画的，插不进搜索框；这里画一个外观贴近原生的全屏列表。
       只在点按按钮时创建，关闭即从 DOM 移除，没有常驻开销。 */
    function openEditorPicker() {
        try {
            closeEditorPicker(true);
            const sel = editorSelect();
            if (!sel) { console.warn('[wbm] world_editor_select 不存在'); return; }

            const { mask, sheet } = makePickerShell();
            state.picker = mask;

            const grip = el('div', 'wbm-picker-grip');
            const { head, input } = buildPickerHead('搜索世界书');

            const list = el('div', 'wbm-picker-list');
            fillEditorPickerList(list, '');

            sheet.appendChild(grip);
            sheet.appendChild(head);
            sheet.appendChild(list);

            /* 附加世界书只存在设置文件里，第一次打开时异步补上；
               拿到之后若面板还开着就重画一次，拿不到就当没有这一组 */
            if (!charLoreCache.data) {
                ensureCharLore().then((wi) => {
                    if (!wi) return;
                    applyEditorOptgroups();
                    if (!state.picker || !state.picker.isConnected) return;
                    const list2 = state.picker.querySelector('.wbm-picker-list');
                    if (list2) fillEditorPickerList(list2, input ? input.value : '');
                });
            }

            /* 手指按下时面板才出现，同一个手势后续的 click 会落在面板上——
               先吃掉打开后 420ms 内的点击，避免"轻点一下就被选中某一本" */
            const openedAt = Date.now();
            mask.addEventListener('click', (event) => {
                if (mask.dataset.closing === '1') return;
                /* 浮层内的一切点击都不上抛：宿主和其它插件的 document/html 级点击处理
                   一律不该因为"点了浮层"而生效 */
                event.stopPropagation();
                if (Date.now() - openedAt < 420) {
                    event.preventDefault();
                    return;
                }
                const target = event.target;
                if (!(target instanceof Element)) return;
                /* 点到胶囊的空白或放大镜上，等于点搜索框 */
                if (target !== input && target.closest('.wbm-picker-field')) { input.focus(); return; }
                if (target === mask) { closeEditorPicker(); return; }
                const roleEl = target.closest('[data-role]');
                if (!roleEl) return;
                const role = roleEl.dataset.role;
                if (role === 'picker-close') { closeEditorPicker(); return; }
                if (role === 'picker-row') {
                    event.preventDefault();
                    const target2 = editorSelect();
                    if (!target2) return;
                    target2.value = roleEl.dataset.value;
                    fireChange(target2);
                    updateEditorButton();
                    closeEditorPicker();
                }
            });

            mask.addEventListener('input', (event) => {
                const target = event.target;
                if (!(target instanceof HTMLInputElement)) return;
                if (target.dataset.role === 'picker-search') filterEditorPicker(target.value);
            });

            /* 挂到 html 而不是 body：body 上有 transform（UI 缩放）时，fixed 会相对它定位 */
            document.documentElement.appendChild(mask);
            const rect = mask.getBoundingClientRect();
            console.info('[wbm] picker opened ' + Math.round(rect.width) + 'x' + Math.round(rect.height) + ' rows=' + list.childElementCount);
        } catch (err) {
            console.error('[wbm] openEditorPicker failed', err);
        }
    }

    /* ---------------- 移动 / 复制条目：用同一套「搜索 + 列表」窗口替代 ST 原生弹窗 ---------------- */

    /* ST 的搬运函数是导出的（world-info.js:5902 moveWorldInfoEntry），直接复用，
       数据行为与原生完全一致（放目标书末尾、重新分配 uid、写盘）。 */
    let moveEntryFn = null;

    async function loadMoveFn() {
        try {
            const mod = await import('/scripts/world-info.js');
            return mod && typeof mod.moveWorldInfoEntry === 'function' ? mod.moveWorldInfoEntry : null;
        } catch (err) {
            console.warn('[wbm] 拿不到 moveWorldInfoEntry，保留 ST 原生弹窗', err);
            return null;
        }
    }

    /* 条目列表的搜索词与滚动位置：搬完必须原样还回去，
       否则 ST 的 reloadEditor 会把搜索清空、列表刷回顶部，每搬一条都要重搜一次。
       滚动目标不能写死：ST 1.18 的编辑器是内嵌的，#world_popup_entries_list 自己不带滚动条，
       真正在滚的是它的祖先（面板 #WorldInfo 那一层），所以要把整条可滚动祖先链都记下来。 */
    function scrollableAncestors(fromEl) {
        const nodes = [];
        let node = fromEl ? fromEl.parentElement : null;
        while (node && node !== document.documentElement) {
            if (node.scrollHeight - node.clientHeight > 2) nodes.push(node);
            node = node.parentElement;
        }
        return nodes;
    }

    /* 原生分页插件的当前页码（没装/没初始化时返回 0） */
    function currentPaginationPage() {
        try {
            const pager = window.jQuery ? window.jQuery('#world_info_pagination') : null;
            if (!pager || !pager.length) return 0;
            const page = Number(pager.pagination('getCurrentPageNum'));
            return Number.isFinite(page) && page > 0 ? page : 0;
        } catch (err) {
            return 0;
        }
    }

    function snapshotEntryUi() {
        const search = document.querySelector('#world_info_search');
        const list = document.querySelector('#world_popup_entries_list');
        return {
            search: search ? String(search.value || '') : '',
            page: currentPaginationPage(),
            nodes: scrollableAncestors(list).map((node) => ({ node, top: node.scrollTop })),
        };
    }

    function restoreEntryUi(snap) {
        const applySearch = () => {
            const search = document.querySelector('#world_info_search');
            if (search && snap.search && search.value !== snap.search) {
                search.value = snap.search;
                search.dispatchEvent(new Event('input', { bubbles: true }));
            }
        };
        const applyScroll = () => {
            snap.nodes.forEach((item) => {
                if (item.node && item.node.isConnected && item.top) item.node.scrollTop = item.top;
            });
        };
        let settle = null;
        let stopped = false;
        let pageDone = false;

        const restorePage = () => {
            if (pageDone || !snap.page || snap.page <= 1) return;
            pageDone = true;
            if (currentPaginationPage() === snap.page) return;
            try {
                const pager = window.jQuery && window.jQuery('#world_info_pagination');
                if (pager && pager.length) pager.pagination('go', snap.page);
            } catch (err) {
                console.warn('[wbm] 分页还原失败', err);
            }
        };

        applySearch();
        applyScroll();

        const list = document.querySelector('#world_popup_entries_list');
        if (!list || typeof MutationObserver !== 'function') {
            setTimeout(() => { applySearch(); restorePage(); applyScroll(); }, 600);
            return;
        }

        /* reloadEditor 是分批异步重建列表的（每批之间还有 await）：只抓"第一次变动"会补得太早，
           随后追加的行会把滚动顶回顶部。所以每来一批就补一次滚动，等它安静下来（400ms）再补分页——
           条目数超过分页大小（默认 25）时 ST 会把分页重置回第 1 页，光还原 scrollTop 是没有意义的。
           整体仍是一次性观察器 + 有上限的定时器：结尾 disconnect，最长 4 秒。 */
        const finish = () => {
            if (stopped) return;
            stopped = true;
            clearTimeout(settle);
            clearTimeout(capTimer);
            obs.disconnect();
            applyScroll();
        };

        const tick = () => {
            if (stopped) return;
            applyScroll();
            clearTimeout(settle);
            settle = setTimeout(() => {
                if (stopped) return;
                restorePage();
                applyScroll();
                /* 切页会再重建一次，等它静下来就收尾 */
                clearTimeout(settle);
                settle = setTimeout(finish, 700);
            }, 400);
        };

        const obs = new MutationObserver(tick);
        obs.observe(list, { childList: true, subtree: true });
        const capTimer = setTimeout(finish, 4000);
        tick();
    }

    function openMovePicker(uid, sourceWorld, entryName) {
        try {
            closeEditorPicker(true);
            const { mask, sheet } = makePickerShell();
            state.picker = mask;

            const grip = el('div', 'wbm-picker-grip');
            const { head, input } = buildPickerHead('搜索世界书');
            const title = el('div', 'wbm-picker-title',
                (entryName ? '「' + entryName + '」' : '这条条目') + '移入 / 复制到：');

            const list = el('div', 'wbm-picker-list');
            const rows = [];
            let chosen = '';
            const targets = allBookRawNames().filter((name) => name !== sourceWorld);
            targets.forEach((name) => {
                const row = el('div', 'wbm-picker-row');
                row.dataset.name = name;
                row.appendChild(el('span', 'wbm-picker-name', String(name).trim()));
                row.appendChild(el('span', 'wbm-picker-radio'));
                list.appendChild(row);
                rows.push(row);
            });
            if (targets.length === 0) list.appendChild(el('div', 'wbm-picker-empty', '没有其它世界书可以放'));

            const actions = el('div', 'wbm-picker-actions');
            const moveBtn = el('button', 'wbm-picker-action primary', '移动到所选');
            moveBtn.type = 'button';
            moveBtn.disabled = true;
            const copyBtn = el('button', 'wbm-picker-action', '复制到所选');
            copyBtn.type = 'button';
            copyBtn.disabled = true;
            actions.appendChild(moveBtn);
            actions.appendChild(copyBtn);

            sheet.appendChild(grip);
            sheet.appendChild(head);
            sheet.appendChild(title);
            sheet.appendChild(list);
            sheet.appendChild(actions);

            const pick = (name) => {
                chosen = name;
                rows.forEach((row) => row.classList.toggle('active', row.dataset.name === name));
                moveBtn.disabled = !name;
                copyBtn.disabled = !name;
            };

            const run = async (deleteOriginal) => {
                if (!chosen || !moveEntryFn) return;
                const targetName = chosen;
                closeEditorPicker(true);
                const snap = snapshotEntryUi();
                let ok = false;
                try {
                    ok = await moveEntryFn(sourceWorld, targetName, uid, { deleteOriginal });
                } catch (err) {
                    console.error('[wbm] move/copy failed', err);
                }
                if (ok) {
                    toast('info', (deleteOriginal ? '已移动：' : '已复制：') + targetName);
                    pushHistory({
                        at: Date.now(),
                        act: deleteOriginal ? 'move' : 'copy',
                        count: 1,
                        from: sourceWorld,
                        to: targetName,
                        names: [entryName || ('条目 ' + uid)],
                    });
                    restoreEntryUi(snap);
                } else {
                    toast('warning', '操作没成功，条目仍在原处');
                }
            };

            mask.addEventListener('click', (event) => {
                event.stopPropagation();
                const target = event.target;
                if (!(target instanceof Element)) return;
                if (target !== input && target.closest('.wbm-picker-field')) { input.focus(); return; }
                if (target === mask) { closeEditorPicker(); return; }
                if (target.closest('[data-role="picker-close"]')) { closeEditorPicker(); return; }
                const row = target.closest('.wbm-picker-row');
                if (row) { event.preventDefault(); pick(String(row.dataset.name || '')); }
            });

            moveBtn.addEventListener('click', () => { run(true); });
            copyBtn.addEventListener('click', () => { run(false); });

            input.addEventListener('input', () => {
                const q = input.value.trim().toLowerCase();
                rows.forEach((row) => {
                    const hit = !q || String(row.dataset.name || '').toLowerCase().indexOf(q) !== -1;
                    row.style.display = hit ? '' : 'none';
                });
            });

            document.documentElement.appendChild(mask);
            console.info('[wbm] move picker opened targets=' + targets.length);
        } catch (err) {
            console.error('[wbm] openMovePicker failed', err);
        }
    }

    /* ---------------- 批量移动 / 复制 ---------------- */

    /* WebView 98 以下没有 structuredClone：手机端旧 WebView 会在这里抛错，改用 JSON 深拷贝兜底 */
    const deepClone = (value) => (typeof structuredClone === 'function' ? structuredClone(value) : JSON.parse(JSON.stringify(value)));

    /* 批量走"一次载入、一次保存、一次重载"：不循环调 moveWorldInfoEntry（那样会重载 N 次）。
       用到的全是 ST 导出的底层函数，写盘语义与原生一致。 */
    async function runBatchMove(sourceName, targetName, uids, deleteOriginal) {
        try {
            const mod = await import('/scripts/world-info.js');
            const { loadWorldInfo, saveWorldInfo, getFreeWorldEntryUid } = mod;
            if (typeof loadWorldInfo !== 'function' || typeof saveWorldInfo !== 'function'
                || typeof getFreeWorldEntryUid !== 'function') return 0;
            const sourceData = await loadWorldInfo(sourceName);
            const targetData = await loadWorldInfo(targetName);
            if (!sourceData || !sourceData.entries || !targetData || !targetData.entries) return 0;

            let moved = 0;
            for (const uid of uids) {
                const key = String(uid);
                const entry = sourceData.entries[key];
                if (!entry) continue;
                const clone = deepClone(entry);
                const newUid = getFreeWorldEntryUid(targetData);
                if (newUid === null) break;
                clone.uid = newUid;
                const maxIdx = Object.values(targetData.entries)
                    .reduce((max, item) => Math.max(max, item.displayIndex ?? -1), -1);
                clone.displayIndex = maxIdx + 1;
                targetData.entries[newUid] = clone;
                if (deleteOriginal) {
                    delete sourceData.entries[key];
                    if (typeof mod.deleteWIOriginalDataValue === 'function') {
                        mod.deleteWIOriginalDataValue(sourceData, key);
                    }
                }
                moved += 1;
            }
            if (!moved) return 0;

            await saveWorldInfo(targetName, targetData, true);
            if (deleteOriginal) {
                await saveWorldInfo(sourceName, sourceData, true);
                if (typeof mod.reloadEditor === 'function') mod.reloadEditor(sourceName);
            }
            return moved;
        } catch (err) {
            console.error('[wbm] batch move failed', err);
            return 0;
        }
    }

    function openBatchPicker() {
        const bookName = rawBookName(currentEditingName());
        if (!bookName) { toast('warning', '先在「选择以编辑」里选中要操作的 World Info'); return; }

        (async () => {
            let mod = null;
            try {
                mod = await import('/scripts/world-info.js');
            } catch (err) {
                console.error('[wbm] 批量功能无法加载 world-info.js', err);
            }
            if (!mod || typeof mod.loadWorldInfo !== 'function') {
                toast('warning', '当前版本拿不到世界书接口，批量功能不可用');
                return;
            }
            let data = null;
            try { data = await mod.loadWorldInfo(bookName); } catch (err) { console.error(err); }
            if (!data || !data.entries) { toast('warning', '这本书没有条目'); return; }

            /* 顺序沿用 ST 自己「排序」下拉里当前选的那一档（Priority / Custom / Title / Tokens / Depth / Order / UID …），
               直接调宿主导出的 sortWorldInfoEntries，和原生条目列表、原生搜索结果的顺序完全一致。
               注意：原生搜索态会临时把下拉切到隐藏的 search 档（按相关度排），这时退回用户先前选的那档。 */
            const manualOrder = (a, b) => (a.displayIndex ?? 0) - (b.displayIndex ?? 0);
            let ordered = Object.values(data.entries);
            try {
                const select = document.querySelector('#world_info_sort_order');
                let opt = select && select.selectedOptions ? select.selectedOptions[0] : null;
                let customSort = null;
                if (opt && opt.dataset.rule === 'search') {
                    let saved = null;
                    try {
                        saved = window.accountStorage ? window.accountStorage.getItem('world_info_sort_order') : null;
                    } catch (err) { saved = null; }
                    const savedOpt = saved && select.querySelector('option[value="' + saved + '"]');
                    customSort = savedOpt
                        ? {
                            sortField: savedOpt.dataset.field,
                            sortOrder: savedOpt.dataset.order || 'desc',
                            sortRule: savedOpt.dataset.rule || 'priority',
                        }
                        : { sortRule: 'priority', sortOrder: 'desc' };
                }
                if (typeof mod.sortWorldInfoEntries === 'function') {
                    ordered = mod.sortWorldInfoEntries(ordered, customSort ? { customSort } : undefined);
                } else {
                    ordered = ordered.sort(manualOrder);
                }
            } catch (err) {
                console.warn('[wbm] 沿用原生排序失败，回退手动顺序', err);
                ordered = Object.values(data.entries).sort(manualOrder);
            }

            const entries = ordered
                .map((entry) => {
                    const name = String(entry.comment || '').trim() || ('条目 ' + entry.uid);
                    const keys = Array.isArray(entry.key) ? entry.key.join(' ') : String(entry.key || '');
                    return {
                        uid: String(entry.uid),
                        name,
                        /* 三个搜索面分开存小写副本：标题（备注名）/ 关键词 / 正文，
                           打开窗口期间才存在，关掉即丢，方便单独开关某一面。 */
                        nameLower: name.toLowerCase(),
                        keysLower: keys.toLowerCase(),
                        bodyLower: String(entry.content || '').toLowerCase(),
                    };
                });
            if (entries.length === 0) { toast('warning', '这本书没有条目'); return; }

            try {
                closeEditorPicker(true);
                const { mask, sheet } = makePickerShell();
                state.picker = mask;

                const grip = el('div', 'wbm-picker-grip');
                const { head, input } = buildPickerHead('搜索条目');
                /* 三个搜索面开关：默认全开，可以逐个关掉看只命中哪一面（全关就一条都不列） */
                const filters = el('div', 'wbm-picker-filters');
                const fieldOn = { title: true, key: true, content: true };
                [['title', '标题'], ['key', '关键词'], ['content', '正文']].forEach(([key, label]) => {
                    const chip = el('button', 'wbm-picker-chip', label);
                    chip.type = 'button';
                    chip.dataset.field = key;
                    chip.dataset.role = 'batch-field';
                    filters.appendChild(chip);
                });
                const title = el('div', 'wbm-picker-title', '');
                const list = el('div', 'wbm-picker-list');
                const empty = el('div', 'wbm-picker-empty', '没有匹配的条目');
                empty.style.display = 'none';
                list.appendChild(empty);
                const actions = el('div', 'wbm-picker-actions');

                sheet.appendChild(grip);
                sheet.appendChild(head);
                sheet.appendChild(filters);
                sheet.appendChild(title);
                sheet.appendChild(list);
                sheet.appendChild(actions);

                let mode = 'entries';      /* entries → targets */
                let selectedTarget = '';
                let batchFn = null;        /* 预载搬运/保存所需函数是否齐全 */
                const checked = new Set();
                const targets = allBookRawNames().filter((name) => name !== bookName);
                batchFn = typeof mod.saveWorldInfo === 'function' && typeof mod.getFreeWorldEntryUid === 'function';

                const mkBtn = (text, primary) => {
                    const btn = el('button', 'wbm-picker-action' + (primary ? ' primary' : ''), text);
                    btn.type = 'button';
                    return btn;
                };

                const hayOf = new Map(entries.map((item) => [item.uid, item]));

                const chipEls = () => Array.prototype.slice.call(filters.querySelectorAll('.wbm-picker-chip'));

                const syncChips = () => {
                    chipEls().forEach((chip) => {
                        chip.classList.toggle('on', fieldOn[chip.dataset.field] !== false);
                    });
                };

                /* 只把「开着的那几面」拼起来比：全关时拼出来是空串，任何搜索都不命中（方便挨个开开关看） */
                const searchTextOf = (item) => {
                    const parts = [];
                    if (fieldOn.title) parts.push(item.nameLower);
                    if (fieldOn.key) parts.push(item.keysLower);
                    if (fieldOn.content) parts.push(item.bodyLower);
                    return parts.join('\n');
                };

                /* 只用 display 过滤，不重绘：勾选状态与滚动位置都不会被打断 */
                const visibleRows = () => Array.prototype.filter.call(
                    list.querySelectorAll('.wbm-picker-row'),
                    (row) => row.style.display !== 'none',
                );

                const rowUid = (row) => String(row.dataset.uid || '');

                const allVisibleChecked = () => {
                    const rows = visibleRows();
                    return rows.length > 0 && rows.every((row) => checked.has(rowUid(row)));
                };

                const setRowChecked = (row, on) => {
                    if (on) checked.add(rowUid(row)); else checked.delete(rowUid(row));
                    row.classList.toggle('active', on);
                };

                /* 标题与按钮文案跟着「已选 / 命中 / 是否已全选」实时变 */
                const refreshEntryState = () => {
                    if (mode !== 'entries') return;
                    const shown = visibleRows().length;
                    const filtering = input.value.trim() !== ''
                        || !fieldOn.title || !fieldOn.key || !fieldOn.content;
                    const more = filtering ? ' · 命中 ' + shown + ' 条' : '';
                    title.textContent = '已选 ' + checked.size + ' 条（当前书：' + bookName + '）' + more;
                    const allBtn = actions.querySelector('[data-role="batch-all"]');
                    if (allBtn) allBtn.textContent = allVisibleChecked() ? '取消全选' : '全选';
                    const invertBtn = actions.querySelector('[data-role="batch-invert"]');
                    if (invertBtn) invertBtn.disabled = shown === 0;
                    const nextBtn = actions.querySelector('[data-role="batch-next"]');
                    if (nextBtn) nextBtn.disabled = checked.size === 0;
                };

                const renderActions = () => {
                    actions.textContent = '';
                    if (mode === 'entries') {
                        const allBtn = mkBtn('全选', false);
                        allBtn.dataset.role = 'batch-all';
                        const invertBtn = mkBtn('反选', false);
                        invertBtn.dataset.role = 'batch-invert';
                        const delBtn = mkBtn('删除', false);
                        delBtn.dataset.role = 'batch-delete';
                        delBtn.classList.add('danger');
                        const nextBtn = mkBtn('下一步', true);
                        nextBtn.classList.add('wide');
                        nextBtn.dataset.role = 'batch-next';
                        const recOnBtn = mkBtn('递归：开启', false);
                        recOnBtn.dataset.role = 'batch-rec-on';
                        const recOffBtn = mkBtn('递归：关闭', false);
                        recOffBtn.dataset.role = 'batch-rec-off';
                        actions.appendChild(allBtn);
                        actions.appendChild(invertBtn);
                        actions.appendChild(delBtn);
                        actions.appendChild(recOnBtn);
                        actions.appendChild(recOffBtn);
                        actions.appendChild(nextBtn);
                        let disarmTimer = null;
                        const disarm = () => {
                            if (disarmTimer) { clearTimeout(disarmTimer); disarmTimer = null; }
                            delBtn.textContent = '删除';
                            delBtn.classList.remove('armed');
                        };
                        const runDelete = async () => {
                            if (!checked.size || !batchFn) return;
                            const snap = snapshotEntryUi();
                            const uids = Array.from(checked);
                            closeEditorPicker(true);
                            const removed = await runBatchDelete(bookName, uids);
                            if (removed > 0) {
                                toast('info', '已删除 ' + removed + ' 条，可在「操作历史」里恢复');
                                restoreEntryUi(snap);
                            } else {
                                toast('warning', '删除没有成功');
                            }
                        };
                        allBtn.addEventListener('click', () => {
                            /* 已经全选了就变成取消全选，只作用于当前搜索结果 */
                            const on = !allVisibleChecked();
                            visibleRows().forEach((row) => setRowChecked(row, on));
                            refreshEntryState();
                        });
                        invertBtn.addEventListener('click', () => {
                            visibleRows().forEach((row) => setRowChecked(row, !checked.has(rowUid(row))));
                            refreshEntryState();
                        });
                        const runRec = async (value) => {
                            if (!checked.size) return;
                            const snap = snapshotEntryUi();
                            const count = await runBatchRecursion(bookName, Array.from(checked), value);
                            if (count > 0) {
                                toast('info', (value ? '已开启' : '已关闭') + '递归两项：' + count + ' 条');
                                restoreEntryUi(snap);
                                closeEditorPicker();
                            } else {
                                toast('info', '选中的条目已经是这个状态了，没有要改的');
                            }
                        };
                        recOnBtn.addEventListener('click', () => runRec(true));
                        recOffBtn.addEventListener('click', () => runRec(false));
                        /* 删除是不可逆里的可逆项：先点一下变「确认删除 N 条」，3 秒内再点才真删 */
                        delBtn.addEventListener('click', () => {
                            if (!checked.size) return;
                            if (!delBtn.classList.contains('armed')) {
                                delBtn.classList.add('armed');
                                delBtn.textContent = '确认删除 ' + checked.size + ' 条';
                                disarmTimer = setTimeout(disarm, 3000);
                                return;
                            }
                            disarm();
                            runDelete();
                        });
                        nextBtn.addEventListener('click', () => {
                            if (!checked.size) return;
                            mode = 'targets';
                            render();
                        });
                        refreshEntryState();
                    } else {
                        const backBtn = mkBtn('返回', false);
                        backBtn.addEventListener('click', () => { mode = 'entries'; render(); });
                        const moveBtn = mkBtn('移动到所选', true);
                        moveBtn.disabled = !selectedTarget;
                        moveBtn.dataset.role = 'batch-move';
                        const copyBtn = mkBtn('复制到所选', false);
                        copyBtn.disabled = !selectedTarget;
                        copyBtn.dataset.role = 'batch-copy';
                        const run = async (deleteOriginal) => {
                            if (!selectedTarget || !checked.size || !batchFn) return;
                            const snap = snapshotEntryUi();
                            closeEditorPicker(true);
                            const count = await runBatchMove(bookName, selectedTarget, Array.from(checked), deleteOriginal);
                            if (count > 0) {
                                toast('info', (deleteOriginal ? '已移动 ' : '已复制 ') + count + ' 条 → ' + selectedTarget);
                                pushHistory({
                                    at: Date.now(),
                                    act: deleteOriginal ? 'move' : 'copy',
                                    count,
                                    from: bookName,
                                    to: selectedTarget,
                                    names: entries.filter((item) => checked.has(item.uid)).map((item) => item.name).slice(0, 5),
                                });
                                restoreEntryUi(snap);
                            } else {
                                toast('warning', '批量操作没有成功');
                            }
                        };
                        moveBtn.addEventListener('click', () => { run(true); });
                        copyBtn.addEventListener('click', () => { run(false); });
                        actions.appendChild(backBtn);
                        actions.appendChild(moveBtn);
                        actions.appendChild(copyBtn);
                    }
                };

                /* 过滤只切 display：勾选状态、滚动位置、按钮文案都不重绘 */
                const applyTableFilter = () => {
                    const q = input.value.trim().toLowerCase();
                    const noField = mode === 'entries'
                        && !fieldOn.title && !fieldOn.key && !fieldOn.content;
                    let shown = 0;
                    Array.prototype.forEach.call(list.querySelectorAll('.wbm-picker-row'), (row) => {
                        let hit = true;
                        if (noField) {
                            /* 三面全关：一条都不列，方便挨个开开关看命中哪一面 */
                            hit = false;
                        } else if (q) {
                            if (mode === 'entries') {
                                const item = hayOf.get(rowUid(row));
                                hit = !!item && searchTextOf(item).indexOf(q) !== -1;
                            } else {
                                hit = String(row.dataset.name || '').toLowerCase().indexOf(q) !== -1;
                            }
                        }
                        row.style.display = hit ? '' : 'none';
                        if (hit) shown += 1;
                    });
                    empty.style.display = shown === 0 ? '' : 'none';
                    refreshEntryState();
                };

                const render = () => {
                    list.textContent = '';
                    list.appendChild(empty);
                    input.value = '';
                    input.placeholder = mode === 'entries' ? '搜索条目' : '搜索世界书';
                    filters.style.display = mode === 'entries' ? '' : 'none';
                    if (mode === 'entries') {
                        empty.textContent = '没有匹配的条目';
                        entries.forEach((item) => {
                            const row = el('div', 'wbm-picker-row' + (checked.has(item.uid) ? ' active' : ''));
                            row.dataset.uid = item.uid;
                            row.dataset.name = item.name;
                            row.appendChild(el('span', 'wbm-picker-name', item.name));
                            row.appendChild(el('span', 'wbm-picker-box'));
                            list.appendChild(row);
                        });
                    } else {
                        title.textContent = '把 ' + checked.size + ' 条搬到哪里？（当前书：' + bookName + '）';
                        empty.textContent = targets.length === 0 ? '没有其它世界书可以放' : '没有匹配的世界书';
                        targets.forEach((name) => {
                            const row = el('div', 'wbm-picker-row' + (selectedTarget === name ? ' active' : ''));
                            row.dataset.name = name;
                            row.appendChild(el('span', 'wbm-picker-name', String(name).trim()));
                            row.appendChild(el('span', 'wbm-picker-radio'));
                            list.appendChild(row);
                        });
                    }
                    syncChips();
                    renderActions();
                    applyTableFilter();
                };

                mask.addEventListener('click', (event) => {
                    event.stopPropagation();
                    const target = event.target;
                    if (!(target instanceof Element)) return;
                    if (target !== input && target.closest('.wbm-picker-field')) { input.focus(); return; }
                    if (target === mask) { closeEditorPicker(); return; }
                    if (target.closest('[data-role="picker-close"]')) { closeEditorPicker(); return; }
                    const chip = target.closest('[data-role="batch-field"]');
                    if (chip) {
                        event.preventDefault();
                        const field = String(chip.dataset.field || '');
                        if (field) {
                            fieldOn[field] = !fieldOn[field];
                            syncChips();
                            applyTableFilter();
                        }
                        return;
                    }
                    const row = target.closest('.wbm-picker-row');
                    if (!row) return;
                    event.preventDefault();
                    if (mode === 'entries') {
                        const uid = rowUid(row);
                        setRowChecked(row, !checked.has(uid));
                        refreshEntryState();
                    } else {
                        selectedTarget = String(row.dataset.name || '');
                        list.querySelectorAll('.wbm-picker-row').forEach((item) => {
                            item.classList.toggle('active', item.dataset.name === selectedTarget);
                        });
                        renderActions();
                    }
                });

                input.addEventListener('input', applyTableFilter);

                render();
                document.documentElement.appendChild(mask);
                console.info('[wbm] batch picker opened entries=' + entries.length);
            } catch (err) {
                console.error('[wbm] openBatchPicker failed', err);
            }
        })();
    }

    /* ---------------- 操作历史 / 回收站（本次酒馆启动期间） ---------------- */

    /* 开销账：普通记录 150~300 字节；只有「删除」记录额外带被删条目的原文（这就是回收站）。
       三重上限：60 条记录、整体序列化 ≤1.5MB、单次删除原文 ≤200KB，超了都丢最旧的。
       写盘只在操作成功那一刻发生一次（localStorage，<1ms）：没有定时器、没有轮询，
       窗口不开时没有任何常驻对象。用 localStorage 而不是 sessionStorage，是因为它
       落在浏览器配置目录里、刷新与崩溃重启都还在，正好满足"误删后重启还能恢复"。 */
    const HISTORY_KEY = 'wbm-op-history';
    const HISTORY_MAX = 300;
    const HISTORY_BYTES = 8000 * 1024;
    const HISTORY_PAYLOAD_BYTES = 2000 * 1024;

    /* 设置里那个属于我们的对象（没有就返回 null，由调用方退回 localStorage）。
       历史与收藏同一份数据：服务端 settings.json 里，换浏览器/换设备都在，也不吃 localStorage 的 5MB 配额。
       装了鸡尾酒（cocktail-plus）的机器上，它的 /api/settings/save 走 patch 模式只传差异。 */
    function settingsBucket() {
        if (!settingsApi || !settingsApi.settings) return null;
        const cfg = settingsApi.settings[SETTINGS_KEY];
        return cfg && typeof cfg === 'object' ? cfg : null;
    }

    function readLegacyHistory() {
        try {
            const raw = window.localStorage.getItem(HISTORY_KEY);
            const list = raw ? JSON.parse(raw) : [];
            return Array.isArray(list) ? list.filter((item) => item && typeof item === 'object') : [];
        } catch (err) {
            return [];
        }
    }

    function readHistory() {
        const cfg = settingsBucket();
        if (cfg) {
            const list = cfg.history;
            return Array.isArray(list) ? list.filter((item) => item && typeof item === 'object') : [];
        }
        return readLegacyHistory();
    }

    function writeHistory(list) {
        const out = list.slice(0, HISTORY_MAX);
        /* 按整体体积再裁一遍：宁可少记几条，也不能让设置文件无限长 */
        while (out.length > 0 && JSON.stringify(out).length > HISTORY_BYTES) out.pop();
        const cfg = settingsBucket();
        if (cfg) {
            cfg.history = out;
            persistStore();
            return;
        }
        try {
            window.localStorage.setItem(HISTORY_KEY, JSON.stringify(out));
        } catch (err) {
            console.warn('[wbm] 写操作历史失败', err);
        }
    }

    function pushHistory(record) {
        if (!record || !record.act) return;
        if (!record.from) return;
        if ((record.act === 'move' || record.act === 'copy') && !record.to) return;
        const list = readHistory();
        list.unshift(record);
        writeHistory(list);
    }

    function historyClock(at) {
        const d = new Date(Number(at) || Date.now());
        const pad = (n) => (n < 10 ? '0' + n : String(n));
        return pad(d.getHours()) + ':' + pad(d.getMinutes());
    }

    function historyText(item) {
        const count = Number(item.count) || 0;
        const from = String(item.from || '');
        const to = String(item.to || '');
        switch (item.act) {
            case 'move': return '移动 ' + count + ' 条：' + from + ' → ' + to;
            case 'copy': return '复制 ' + count + ' 条：' + from + ' → ' + to;
            case 'delete': return '删除 ' + count + ' 条：' + from;
            case 'restore': return '恢复 ' + count + ' 条：' + from;
            case 'recursion': return (item.on ? '开启' : '关闭') + '递归开关（不可递归+防止进一步递归）：' + count + ' 条 · ' + from;
            case 'undo-recursion': return '撤销递归开关 ' + count + ' 条 · ' + from;
            case 'keywords': return '关键词工具：合并追加 / 整理 ' + count + ' 条 · ' + from;
            case 'healthfix': return '体检修复：整理关键词 ' + count + ' 条 · ' + from;
            case 'replace': return '替换 ' + (Number(item.hits) || 0) + ' 处（' + count + ' 条）：' + from
                + '「' + String(item.find || '').slice(0, 12) + '」→「' + String(item.repl || '').slice(0, 12) + '」';
            case 'undo-replace': return '撤销替换 ' + count + ' 条：' + from;
            case 'enable': return '启用世界书：' + from;
            case 'disable': return '停用世界书：' + from;
            case 'edit': return '编辑正文：' + from;
            case 'undo-edit': return '撤销正文编辑：' + from;
            default: return String(item.act || '');
        }
    }

    /* 把一条「删除」记录里的条目写回原书：新 uid、displayIndex 排到最后 */
    /* 书被删或改名之后，这条删除记录就恢复不了了。标死它，别让「恢复」按钮一直亮着假装能用。 */
    function markHistoryBookGone(record) {
        try {
            const list = readHistory();
            const idx = list.findIndex((item) => item.at === record.at && item.act === record.act);
            if (idx === -1) return;
            list[idx].bookGone = true;
            writeHistory(list);
        } catch (err) { /* 标不上也不影响拒绝恢复这件事本身 */ }
    }

    async function restoreHistoryRecord(record) {
        const book = String(record && record.from ? record.from : '');
        const payload = record && Array.isArray(record.entries) ? record.entries : [];
        if (!book || !payload.length) {
            toast('warning', '这条记录里没有可恢复的原文');
            return false;
        }
        try {
            const mod = await import('/scripts/world-info.js');
            const { loadWorldInfo, saveWorldInfo, getFreeWorldEntryUid } = mod;
            if (typeof loadWorldInfo !== 'function' || typeof saveWorldInfo !== 'function'
                || typeof getFreeWorldEntryUid !== 'function') {
                toast('warning', '当前版本拿不到世界书接口，恢复失败');
                return false;
            }
            /* loadWorldInfo 先查内存缓存：书要是在另一台设备上被删了，这边缓存里还有旧数据，
               直接 save 会把那本书悄悄重建出来。先踢掉缓存，问一次服务端才算数。 */
            if (mod.worldInfoCache && typeof mod.worldInfoCache.delete === 'function') {
                mod.worldInfoCache.delete(book);
            }
            const data = await loadWorldInfo(book);
            if (!data || !data.entries) {
                markHistoryBookGone(record);
                toast('warning', '「' + book + '」已经不在了（被删或改名），这条恢复不了');
                return false;
            }
            let added = 0;
            payload.forEach((entry) => {
                const newUid = getFreeWorldEntryUid(data);
                if (newUid === null) return;
                const clone = JSON.parse(JSON.stringify(entry));
                clone.uid = newUid;
                const maxIdx = Object.values(data.entries).reduce((max, item) => Math.max(max, item.displayIndex ?? -1), -1);
                clone.displayIndex = maxIdx + 1;
                data.entries[newUid] = clone;
                added += 1;
            });
            if (!added) return false;
            await saveWorldInfo(book, data, true);
            if (typeof mod.reloadEditor === 'function') mod.reloadEditor(book);
            pushHistory({
                act: 'restore', at: Date.now(), from: book, to: book, count: added,
                names: payload.map((entry) => String(entry.comment || '').trim() || ('条目 ' + entry.uid)).slice(0, 5),
            });
            toast('info', '已恢复 ' + added + ' 条到「' + book + '」');
            return true;
        } catch (err) {
            console.error('[wbm] 恢复条目失败', err);
            toast('warning', '恢复没有成功');
            return false;
        }
    }

    /* 批量删除：返回删除条数；被删条目的原文存进历史记录，就是回收站 */
    async function runBatchDelete(bookName, uids) {
        try {
            const mod = await import('/scripts/world-info.js');
            const { loadWorldInfo, saveWorldInfo } = mod;
            if (typeof loadWorldInfo !== 'function' || typeof saveWorldInfo !== 'function') return 0;
            const data = await loadWorldInfo(bookName);
            if (!data || !data.entries) return 0;
            const removed = [];
            uids.forEach((uid) => {
                const key = String(uid);
                const entry = data.entries[key];
                if (!entry) return;
                removed.push(JSON.parse(JSON.stringify(entry)));
                delete data.entries[key];
                if (typeof mod.deleteWIOriginalDataValue === 'function') mod.deleteWIOriginalDataValue(data, key);
            });
            if (!removed.length) return 0;
            const names = removed.map((entry) => String(entry.comment || '').trim() || ('条目 ' + entry.uid));
            const tooBig = JSON.stringify(removed).length > HISTORY_PAYLOAD_BYTES;
            await saveWorldInfo(bookName, data, true);
            if (typeof mod.reloadEditor === 'function') mod.reloadEditor(bookName);
            pushHistory({
                act: 'delete', at: Date.now(), from: bookName, to: bookName,
                count: removed.length, names: names.slice(0, 5),
                entries: tooBig ? [] : removed,
                payloadDropped: tooBig ? true : undefined,
            });
            return removed.length;
        } catch (err) {
            console.error('[wbm] 批量删除失败', err);
            return 0;
        }
    }

    /* 窗口顶部的容量提示：让 master 一眼看到还剩多少，不用猜什么时候会被淘汰 */
    function historyUsageText(list) {
        const rows = Array.isArray(list) ? list : [];
        let chars = 0;
        try {
            chars = JSON.stringify(rows).length;
        } catch (err) {
            chars = 0;
        }
        const mb = (n) => (n / (1024 * 1024)).toFixed(1) + ' MB';
        const used = chars >= 1024 * 1024 ? mb(chars) : Math.max(1, Math.round(chars / 1024)) + ' KB';
        const cap = mb(HISTORY_BYTES);
        const near = rows.length >= HISTORY_MAX * 0.9 || chars >= HISTORY_BYTES * 0.9;
        return '已存 ' + rows.length + ' / ' + HISTORY_MAX + ' 条 · 占用约 ' + used
            + '，上限 ' + cap + '（超了先淘汰最早的记录）'
            + (near ? ' · 已接近上限' : '');
    }

    function openHistoryPicker() {
        try {
            closeEditorPicker(true);
            const { mask, sheet } = makePickerShell();
            state.picker = mask;

            const grip = el('div', 'wbm-picker-grip');
            const { head, input } = buildPickerHead('搜索操作');
            const title = el('div', 'wbm-picker-title', '');
            const usage = el('div', 'wbm-prev-meta wbm-hist-usage', '');
            const box = el('div', 'wbm-picker-list');
            const empty = el('div', 'wbm-picker-empty', '还没有操作记录');
            const actions = el('div', 'wbm-picker-actions');
            const clearBtn = el('button', 'wbm-picker-action', '清空历史');
            clearBtn.type = 'button';
            clearBtn.dataset.role = 'hist-clear';
            const closeBtn = el('button', 'wbm-picker-action primary', '关闭');
            closeBtn.type = 'button';
            closeBtn.dataset.role = 'hist-close';
            actions.appendChild(clearBtn);
            actions.appendChild(closeBtn);

            const syncTitle = () => {
                const records = readHistory();
                const total = records.length;
                title.textContent = total
                    ? '最近 ' + total + ' 条操作 · 点一条打开那本书，删除的记录可恢复'
                    : '还没有操作记录';
                usage.textContent = total ? historyUsageText(records) : '';
                usage.style.display = total ? '' : 'none';
            };

            const drawRows = (query) => {
                box.textContent = '';
                box.appendChild(empty);
                const q = String(query || '').trim().toLowerCase();
                let shown = 0;
                readHistory().forEach((item, index) => {
                    const names = Array.isArray(item.names) ? item.names.map(String) : [];
                    const line = historyClock(item.at) + ' ' + historyText(item);
                    const hay = (line + ' ' + names.join(' ')).toLowerCase();
                    if (q && hay.indexOf(q) === -1) return;
                    const row = el('div', 'wbm-picker-row wbm-hist-row');
                    row.dataset.role = 'hist-row';
                    row.dataset.index = String(index);
                    const col = el('div', 'wbm-hist-col');
                    col.appendChild(el('span', 'wbm-hist-line', line));
                    const meta = [];
                    if (names.length) meta.push(names.join('、'));
                    if (item.act === 'delete' && item.payloadDropped) meta.push('原文过大，未保留');
                    if (item.act === 'replace' && item.payloadDropped) meta.push('原文过大，不能撤销');
                    if (item.bookGone) meta.push('原书已删除，只能翻看记录');
                    if (meta.length) col.appendChild(el('span', 'wbm-hist-names', meta.join(' · ')));
                    row.appendChild(col);
                    if ((item.act === 'replace' || item.act === 'keywords' || item.act === 'healthfix'
                        || item.act === 'edit')
                        && Array.isArray(item.entries) && item.entries.length) {
                        if (item.bookGone) {
                            row.appendChild(el('span', 'wbm-hist-gone', '原书已删'));
                        } else {
                            const undoBtn = el('button', 'wbm-hist-restore', '撤销');
                            undoBtn.type = 'button';
                            undoBtn.dataset.role = 'hist-undo-replace';
                            undoBtn.dataset.index = String(index);
                            row.appendChild(undoBtn);
                        }
                    }
                    if (item.act === 'recursion' && Array.isArray(item.entries) && item.entries.length) {
                        if (item.bookGone) {
                            row.appendChild(el('span', 'wbm-hist-gone', '原书已删'));
                        } else {
                            const undoBtn = el('button', 'wbm-hist-restore', '撤销');
                            undoBtn.type = 'button';
                            undoBtn.dataset.role = 'hist-undo-recursion';
                            undoBtn.dataset.index = String(index);
                            row.appendChild(undoBtn);
                        }
                    }
                    if (item.act === 'delete' && Array.isArray(item.entries) && item.entries.length) {
                        if (item.bookGone) {
                            row.appendChild(el('span', 'wbm-hist-gone', '原书已删'));
                        } else {
                            const restoreBtn = el('button', 'wbm-hist-restore', '恢复');
                            restoreBtn.type = 'button';
                            restoreBtn.dataset.role = 'hist-restore';
                            restoreBtn.dataset.index = String(index);
                            row.appendChild(restoreBtn);
                        }
                    }
                    box.appendChild(row);
                    shown += 1;
                });
                empty.textContent = q ? '没有匹配的记录' : '还没有操作记录';
                empty.style.display = shown === 0 ? '' : 'none';
            };

            sheet.appendChild(grip);
            sheet.appendChild(head);
            sheet.appendChild(title);
            sheet.appendChild(usage);
            sheet.appendChild(box);
            sheet.appendChild(actions);

            /* 手指按下去才出现的窗口：同一次手势后续的 click 会落在窗口上，先吃掉 420ms */
            const openedAt = Date.now();
            mask.addEventListener('click', (event) => {
                if (mask.dataset.closing === '1') return;
                event.stopPropagation();
                if (Date.now() - openedAt < 420) { event.preventDefault(); return; }
                const target = event.target;
                if (!(target instanceof Element)) return;
                if (target !== input && target.closest('.wbm-picker-field')) { input.focus(); return; }
                if (target === mask) { closeEditorPicker(); return; }
                const roleEl = target.closest('[data-role]');
                if (!roleEl) return;
                const role = roleEl.dataset.role;
                if (role === 'picker-close' || role === 'hist-close') { closeEditorPicker(); return; }
                if (role === 'hist-clear') {
                    event.preventDefault();
                    writeHistory([]);
                    syncTitle();
                    drawRows(input.value);
                    return;
                }
                if (role === 'hist-restore') {
                    event.preventDefault();
                    const index = Number(roleEl.dataset.index);
                    const record = readHistory()[index];
                    if (!record) return;
                    restoreHistoryRecord(record).then((ok) => {
                        if (ok) {
                            /* 恢复过的记录把原文清掉，避免重复恢复出一堆重复条目 */
                            const list = readHistory();
                            const idx = list.findIndex((item) => item.at === record.at && item.act === 'delete');
                            if (idx !== -1) {
                                list[idx].entries = [];
                                list[idx].names = [];
                                writeHistory(list);
                            }
                        }
                        /* 失败也要重画：原书没了的时候这一行要立刻变成「原书已删」 */
                        syncTitle();
                        drawRows(input.value);
                    });
                    return;
                }
                if (role === 'hist-undo-replace') {
                    event.preventDefault();
                    const index = Number(roleEl.dataset.index);
                    const record = readHistory()[index];
                    if (!record) return;
                    undoHistoryReplace(record).then((ok) => {
                        if (ok) {
                            const list = readHistory();
                            const idx = list.findIndex((item) => item.at === record.at && item.act === record.act);
                            if (idx !== -1) {
                                list[idx].entries = [];
                                writeHistory(list);
                            }
                        }
                        syncTitle();
                        drawRows(input.value);
                    });
                    return;
                }
                if (role === 'hist-undo-recursion') {
                    event.preventDefault();
                    const index = Number(roleEl.dataset.index);
                    const record = readHistory()[index];
                    if (!record) return;
                    undoHistoryRecursion(record).then((ok) => {
                        if (ok) {
                            const list = readHistory();
                            const idx = list.findIndex((item) => item.at === record.at && item.act === 'recursion');
                            if (idx !== -1) {
                                list[idx].entries = [];
                                writeHistory(list);
                            }
                        }
                        syncTitle();
                        drawRows(input.value);
                    });
                    return;
                }
                if (role === 'hist-row') {
                    event.preventDefault();
                    const record = readHistory()[Number(roleEl.dataset.index)];
                    if (!record) return;
                    /* 忘了搬到哪 → 点一条直接切到那本书 */
                    const sel = editorSelect();
                    const opt = sel ? Array.prototype.find.call(sel.options, (o) => String(o.textContent || '').trim() === String(record.to || record.from)) : null;
                    if (sel && opt) {
                        sel.value = opt.value;
                        fireChange(sel);
                        updateEditorButton();
                    }
                    closeEditorPicker();
                }
            });

            input.addEventListener('input', () => drawRows(input.value));

            syncTitle();
            drawRows('');
            document.documentElement.appendChild(mask);
            console.info('[wbm] history opened records=' + readHistory().length);
        } catch (err) {
            console.error('[wbm] openHistoryPicker failed', err);
        }
    }

    /* 接管 ST 原生的「删除条目」按钮（.delete_entry_button）：先把原文取出来再删，
       删完写一条带原文的历史记录——这就是回收站，随时可以恢复。 */
    async function deleteEntryWithHistory(worldName, uid) {
        try {
            let world = String(worldName || '');
            if (!world) world = currentEditingName();
            if (!world || !uid) return false;
            const mod = await import('/scripts/world-info.js');
            const { loadWorldInfo, saveWorldInfo } = mod;
            if (typeof loadWorldInfo !== 'function' || typeof saveWorldInfo !== 'function') {
                toast('warning', '当前版本拿不到世界书接口，删除失败');
                return false;
            }
            const data = await loadWorldInfo(world);
            const key = String(uid);
            const entry = data && data.entries ? data.entries[key] : null;
            if (!entry) return false;
            const copy = JSON.parse(JSON.stringify(entry));
            const name = String(copy.comment || '').trim() || ('条目 ' + copy.uid);
            delete data.entries[key];
            if (typeof mod.deleteWIOriginalDataValue === 'function') mod.deleteWIOriginalDataValue(data, key);
            await saveWorldInfo(world, data, true);
            if (typeof mod.reloadEditor === 'function') mod.reloadEditor(world);
            pushHistory({
                act: 'delete', at: Date.now(), from: world, to: world, count: 1,
                names: [name], entries: [copy],
            });
            toast('info', '已删除「' + name + '」，可在「操作历史」里恢复');
            return true;
        } catch (err) {
            console.error('[wbm] 删除条目失败', err);
            toast('warning', '删除没有成功');
            return false;
        }
    }

    /* 删除按钮的 uid / 书名都在它兄弟节点 .move_entry_button 的属性上（ST 只给那个设了 attr） */
    function bindDeleteEntryHook() {
        document.addEventListener('click', (event) => {
            if (!enhancementsOn()) return;
            const target = event.target;
            if (!(target instanceof Element)) return;
            const btn = target.closest('.delete_entry_button');
            if (!btn) return;
            const holder = btn.parentElement ? btn.parentElement.querySelector('.move_entry_button') : null;
            const uid = holder ? holder.getAttribute('data-uid') : btn.getAttribute('data-uid');
            const world = holder ? holder.getAttribute('data-current-world') : currentEditingName();
            if (!uid) return;
            event.preventDefault();
            event.stopPropagation();
            deleteEntryWithHistory(world, uid);
        }, true);
    }

    /* ---------------- 条目正文预览（只读，不写任何数据） ---------------- */

    /* ---------------- 收藏条目（按 书名 + uid 记，存在本机） ---------------- */

    const FAV_ENTRY_KEY = 'wbm-fav-entries';
    const FAV_ENTRY_MAX = 500;

    function favEntryList() {
        return store.favEntries;
    }

    function favEntryKey(book, uid) {
        return String(book) + '' + String(uid);
    }

    function favEntryKeySet() {
        return new Set(favEntryList().map((x) => favEntryKey(x.book, x.uid)));
    }

    function saveFavEntryList(list) {
        store.favEntries = list.slice(0, FAV_ENTRY_MAX);
        persistStore();
    }

    function toggleFavEntry(book, uid, name) {
        const list = favEntryList();
        const key = favEntryKey(book, uid);
        const index = list.findIndex((x) => favEntryKey(x.book, x.uid) === key);
        if (index >= 0) {
            list.splice(index, 1);
            saveFavEntryList(list);
            return false;
        }
        list.unshift({ book: String(book), uid: String(uid), name: String(name || '') });
        saveFavEntryList(list);
        return true;
    }

    function previewMetaLine(entry, bookName) {
        const bits = [];
        if (entry.constant) bits.push('常驻');
        if (entry.disable) bits.push('已禁用');
        if (Number.isFinite(Number(entry.order))) bits.push('Order ' + entry.order);
        if (Number.isFinite(Number(entry.depth))) bits.push('Depth ' + entry.depth);
        if (Number.isFinite(Number(entry.probability))) bits.push('触发 ' + entry.probability + '%');
        bits.push(bookName);
        return bits.join(' · ');
    }

    /* 关键词三行：主要关键词 / 逻辑 / 可选过滤器。
       逻辑只有存在可选过滤器时才有意义，所以没有可选过滤器时连逻辑一起不显示。 */
    const WI_LOGIC_LABELS = [
        { value: 0, label: 'AND ANY', hint: '可选过滤器任一命中即可' },
        { value: 3, label: 'AND ALL', hint: '可选过滤器全部命中' },
        { value: 1, label: 'NOT ALL', hint: '可选过滤器并非全部命中' },
        { value: 2, label: 'NOT ANY', hint: '可选过滤器一个都没命中' },
    ];

    function keywordArray(value) {
        if (Array.isArray(value)) {
            return value.map((k) => String(k == null ? '' : k).trim()).filter(Boolean);
        }
        return String(value == null ? '' : value).split(KEY_SPLIT).map((k) => k.trim()).filter(Boolean);
    }

    function entryLogicLabel(entry) {
        const value = Number(entry && entry.selectiveLogic);
        const hit = WI_LOGIC_LABELS.find((item) => item.value === value) || WI_LOGIC_LABELS[0];
        return hit.label + '（' + hit.hint + '）';
    }

    function buildKeywordLines(entry) {
        const box = el('div', 'wbm-prev-kwlines');
        const primary = keywordArray(entry && entry.key);
        const secondary = keywordArray(entry && entry.keysecondary);
        const addLine = (label, values) => {
            const line = el('div', 'wbm-prev-kwline');
            line.appendChild(el('span', 'wbm-prev-kwlabel', label));
            if (!values.length) {
                line.appendChild(el('span', 'wbm-prev-kwempty', '（空）'));
            } else {
                values.forEach((key) => line.appendChild(el('span', 'wbm-prev-key', key)));
            }
            box.appendChild(line);
        };
        addLine('主要关键词', primary);
        if (secondary.length) {
            const logic = el('div', 'wbm-prev-kwline');
            logic.appendChild(el('span', 'wbm-prev-kwlabel', '逻辑'));
            logic.appendChild(el('span', 'wbm-prev-kwvalue', entryLogicLabel(entry)));
            box.appendChild(logic);
            addLine('可选过滤器', secondary);
        }
        return box;
    }

    function renderPreviewSheet(bookName, entry) {
        const { mask, sheet } = makePickerShell();
        state.picker = mask;

        const grip = el('div', 'wbm-picker-grip');
        const head = el('div', 'wbm-picker-head');
        const titleBox = el('div', 'wbm-prev-title',
            String(entry.comment || '').trim() || ('条目 ' + entry.uid));
        const close = el('button', 'wbm-picker-close', '✕');
        close.type = 'button';
        close.dataset.role = 'preview-close';
        head.appendChild(titleBox);
        head.appendChild(close);

        const body = el('div', 'wbm-prev-body');
        body.appendChild(el('div', 'wbm-prev-meta', previewMetaLine(entry, String(bookName || ''))));
        body.appendChild(buildKeywordLines(entry));
        body.appendChild(el('div', 'wbm-prev-text', String(entry.content || '')));

        sheet.appendChild(grip);
        sheet.appendChild(head);
        sheet.appendChild(body);

        mask.addEventListener('click', (event) => {
            event.stopPropagation();
            const target = event.target;
            if (!(target instanceof Element)) return;
            if (target === mask || target.closest('[data-role="preview-close"]')) closeEditorPicker();
        });

        document.documentElement.appendChild(mask);
        return mask;
    }

    async function openPreview(worldName, uid) {
        try {
            const world = String(worldName || '') || currentEditingName();
            if (!world || !uid) return;
            const mod = await import('/scripts/world-info.js');
            if (typeof mod.loadWorldInfo !== 'function') {
                toast('warning', '当前版本拿不到世界书接口，预览不可用');
                return;
            }
            const data = await mod.loadWorldInfo(world);
            const entry = data && data.entries ? data.entries[String(uid)] : null;
            if (!entry) { toast('warning', '取不到这条条目的内容'); return; }
            renderPreviewSheet(world, entry);
        } catch (err) {
            console.error('[wbm] 预览失败', err);
            toast('warning', '预览没有成功');
        }
    }

    /* 预览按钮要插在 ST 每次重绘的条目头里：只盯条目列表的重建（childList），
       不轮询、不盯整页；列表不变时回调一次都不会触发。点开是只读浮层，不碰任何数据。 */
    let previewObserver = null;

    /* 表头（酒馆自己的 #WIEntryHeaderTitlesPC）是独立一排、靠 padding 与固定宽度对齐字段的；
       我们往里加图标后条目名那一格变窄，后面的列就整体左移，表头因此错位。
       这里直接量出「每个字段的左边」再把对应小标题按同样位置摆过去——只动我们量出来的 inline 样式，
       每行/每个分页都重新量一次，所以改字号、改主题宽度也能自动跟上。手机端不做（手机有行内标签）。 */

    /* 表头小标题按字数对折成两行：4 字→2+2。幂等，重复跑不会越折越碎 */
    function wrapLabelTwoLines(label) {
        const text = String(label.textContent || '').replace(/\s+/g, '');
        if (text.length < 3) return;
        const mid = Math.ceil(text.length / 2);
        label.dataset.wbmText = text;
        label.textContent = '';
        label.appendChild(document.createTextNode(text.slice(0, mid)));
        label.appendChild(document.createElement('br'));
        label.appendChild(document.createTextNode(text.slice(mid)));
        label.style.whiteSpace = 'normal';
        label.style.lineHeight = '1.15';
    }

    /* 字段块是否被压到名字框下方（= 条目行折成两排）。
       判定不猜宽度，量真实位置：控件块的上沿明显低于名字框上沿就算折了。 */
    function entryFieldsWrapped() {
        const list = document.querySelector('#world_popup_entries_list');
        if (!list) return false;
        const row = list.querySelector('.world_entry');
        if (!row) return false;
        const name = row.querySelector('textarea[name="comment"]');
        const controls = row.querySelector('.WIEnteryHeaderControls');
        if (!name || !controls) return false;
        const a = name.getBoundingClientRect();
        const b = controls.getBoundingClientRect();
        if (!a.height || !b.height) return false;
        return b.top > a.top + 4;
    }

    function alignEntryHeaders() {
        if (!featureOn('headerAlign')) { resetEntryHeaders(); return false; }
        const list = document.querySelector('#world_popup_entries_list');
        if (!list) return false;
        /* 折成两排时整排表头无法与任何一列对齐（master 2026-10-23 反馈图1），
           让它让位，改用每格自己的小标题——宿主本来就有 .WIEntryHeaderTitleMobile，
           手机端就是这么显示的，这里复用它，不再另造一套标注。
           顺序：先判折行再判宽度。1.3.53 把宽度早退放在前面，≤1000px 直接 return，
           折行类永远打不上（1.3.54 实测 760/390 漏标）。 */
        const wrappedNow = entryFieldsWrapped();
        list.classList.toggle('wbm-wi-wrapped', wrappedNow);
        if (window.matchMedia && window.matchMedia('(max-width: 1000px)').matches) return false;
        const header = document.getElementById('WIEntryHeaderTitlesPC');
        if (!header) return false;
        if (wrappedNow) return true;
        const row = list.querySelector('.world_entry');
        if (!row) return false;
        const fields = [
            row.querySelector('textarea[name="comment"]'),
            row.querySelector('select[name="entryStateSelector"]'),
            row.querySelector('select[name="position"]'),
            row.querySelector('input[name="depth"]'),
            row.querySelector('input[name="order"]'),
            row.querySelector('input[name="probability"]'),
        ];
        const labels = Array.prototype.slice.call(header.children);
        if (labels.length < fields.length || fields.some((f) => !f)) return false;

        const headerRect = header.getBoundingClientRect();
        header.style.position = 'relative';
        header.style.justifyContent = 'flex-start';
        header.style.alignItems = 'center';
        header.style.paddingLeft = '0';
        header.style.paddingRight = '0';
        const height = Math.max(headerRect.height, 18);
        header.style.minHeight = height + 'px';
        labels.forEach((label) => {
            label.style.position = 'absolute';
            /* 小标题属于这条表头，垂直只在「条内」居中：top:50% + translateY(-50%)。
               不要按字段中线算——那会把小标题推到条目行上压住输入框（1.3.54 的错，master 满屏截图）。 */
            label.style.top = '50%';
            label.style.left = '0px';
            label.style.width = 'auto';
            label.style.transform = 'translateY(-50%)';
        });
        labels.forEach((label, index) => {
            const fieldRect = fields[index].getBoundingClientRect();
            const width = Math.max(24, Math.round(fieldRect.width));
            /* 第二个是「触发策略」：四个字塞进一个下拉的宽度会折成「触发策」+「略」，
               这里按字数对折成两行（触发 / 策略），再把它摆到那一列正中 */
            if (index === 1) {
                wrapLabelTwoLines(label);
                const centered = fieldRect.left - headerRect.left + (fieldRect.width - width) / 2;
                label.style.left = Math.max(0, Math.round(centered)) + 'px';
                label.style.width = width + 'px';
                label.style.textAlign = 'center';
                return;
            }
            const left = Math.max(0, Math.round(fieldRect.left - headerRect.left));
            /* 强制居中对齐到对应选项列：左边缘与宽度都取字段的，文字居中 */
            label.style.left = left + 'px';
            label.style.width = width + 'px';
            label.style.textAlign = 'center';
        });
        /* 小标题改成绝对定位后就不再撑高度，折成两行的那个会溢出表头盒子压到第一条条目上，
           所以按最高的那个小标题把表头高度补回来。 */
        const tallest = labels.reduce((m, l) => Math.max(m, l.getBoundingClientRect().height), 18);
        header.style.minHeight = Math.round(tallest) + 'px';
        return true;
    }

    function injectPreviewButtons() {
        if (!enhancementsOn()) return;
        const list = document.querySelector('#world_popup_entries_list');
        if (!list) return;
        const favs = favEntryKeySet();
        const rows = list.querySelectorAll('.world_entry');
        for (let i = 0; i < rows.length; i++) {
            const row = rows[i];
            const moveBtn = row.querySelector('.move_entry_button');
            if (!moveBtn || !moveBtn.parentNode) continue;
            const uid = moveBtn.getAttribute('data-uid') || '';
            const world = moveBtn.getAttribute('data-current-world') || '';
            if (row.querySelector('.wbm-preview-btn')) continue;
            /* 挂到原生控件行末尾，但收进我们自己的容器里，方便手机端排成三行 */
            const host = moveBtn.parentNode;
            const star = el('i', 'menu_button wbm-fav-entry-btn');
            const faved = favs.has(favEntryKey(world, uid));
            star.textContent = faved ? '★' : '☆';
            star.classList.toggle('on', faved);
            star.title = faved ? '取消收藏这条条目' : '收藏这条条目';
            star.setAttribute('aria-label', star.title);
            star.dataset.uid = uid;
            star.dataset.world = world;

            const btn = el('i', 'menu_button wbm-preview-btn fa-solid fa-eye');
            btn.title = '预览内容';
            btn.setAttribute('aria-label', '预览内容');
            btn.dataset.uid = uid;
            btn.dataset.world = world;

            const actions = el('div', 'wbm-entry-actions');
            host.appendChild(actions);
            actions.appendChild(star);
            actions.appendChild(btn);
            ['.move_entry_button', '.duplicate_entry_button', '.delete_entry_button'].forEach((sel) => {
                const node = row.querySelector(sel);
                if (node) actions.appendChild(node);
            });
        }
        arrangeMobileEntryFields();
        /* 表头对齐不再挂在每次重绘上（它要读一次布局，1000 条/页时这一下就是几百毫秒）：
           改由 ResizeObserver 盯着表头自己的宽度，只在宽度变了（开面板、改窗口、跨断点）时对齐一次。 */
        ensureHeaderAlignObserver();
        alignEntryHeadersOnce();
        applyEntryFavFilter();
        ensureContentGuard();
        lockEntryContents();
    }

    /* ---------------- 条目防误触：字段级保护 ----------------
       结论（master 判的）：整条双击解锁不好用。改成"按字段双击"：
         · 文本/数字字段：默认 readonly（仍可选中复制），双击该字段才解锁，字段右侧出现「取消 / 保存」，
           按保存只把这一处改动交给宿主（它自己写 data、镜像、存盘、算词数）；按取消还原，不写盘。
         · 复选框（不可递归 / 防止进一步递归 / 延迟到递归 / 无视预算限额 等全部）：单击无效，
           双击＝切换一次并立刻保存（勾选本身就是结果，不需要确认键）。
         · 下拉（触发策略、插入位置）：单击无效，双击＝打开原生下拉，选完由宿主即时保存。
         · 关键词选择器同理：单击无效，双击打开。
         · 启用开关（killSwitch）、折叠箭头、我们的按钮不受影响。
       顶栏不再单独放图标，开关挪到筛选条最左边的胶囊上（master 定）。 */
    let contentGuardBound = false;
    const LOCK_EXCLUDE_SEL = '.killSwitch, .inline-drawer-toggle, .editor_maximize, .wbm-entry-actions,'
        + ' .wbm-preview-btn, .wbm-fav-entry-btn, .wbm-field-bar, .wbm-edit-bar, .move_entry_button,'
        + ' .duplicate_entry_button, .delete_entry_button';
    /* 保存时才写的数据字段（按控件 name 索引）。关键词与可选过滤器每个条目有两个同名控件
       （标签式 select 与纯文本 textarea，手机端用后者），两个都要能双击改，所以都登记 */
    const FIELD_DATA_NAME = {
        content: 'content',
        comment: 'comment',
        key: 'key',
        keysecondary: 'keysecondary',
        depth: 'depth',
        order: 'order',
        probability: 'probability',
        automationId: 'automationId',
        sticky: 'sticky',
        cooldown: 'cooldown',
        delay: 'delay',
        groupWeight: 'groupWeight',
    };
    /* 这几个字段在酒馆数据里还有一份旧格式镜像，写回时要一起同步（撤销用） */
    const UNDO_FIELD_KEYS = {
        depth: 'extensions.depth',
        order: 'insertion_order',
        probability: 'extensions.probability',
        automationId: 'extensions.automation_id',
        sticky: 'extensions.sticky',
        cooldown: 'extensions.cooldown',
        delay: 'extensions.delay',
        groupWeight: 'extensions.group_weight',
    };

    /* 总开关（静音键）：关掉后所有增强都不挂载、不响应，界面回到原生酒馆；
       各子开关的状态原样保留，重新打开即恢复。设置抽屉本身永远留着，否则解不开。 */
    /* ---------------- 各功能区的独立开关（1.3.56） ----------------
       master 2026-10-23：不需要的人应该能自己关掉。每个开关只管自己那一块：
       关掉＝把自绘的节点收走、行为退回原生，不影响别的区；总开关仍是上面的「全部关闭」。 */
    const FEATURE_DEFAULTS = { promptMgr: true, persona: true, talkPreset: true, headerAlign: true, regexGuard: true, frontendGuard: true, promptEditorCap: true };

    function featureOn(key) {
        if (!enhancementsOn()) return false;
        const f = (store.features && typeof store.features === 'object') ? store.features : null;
        if (!f) return true;
        return f[key] !== false;
    }

    function setFeature(key, on) {
        if (!store.features || typeof store.features !== 'object') store.features = Object.assign({}, FEATURE_DEFAULTS);
        store.features[key] = !!on;
        persistStore();
    }

    /* 提示词管理器：工具条、插入搜索条、排序态、查找高亮全收走，退出排序态但不回写 order
       （关功能不等于替用户改数据）。 */
    function teardownPromptMgrDom() {
        try { if (pmSortOn) exitPmSort({ skipRepair: true }); } catch (err) { console.warn('[wbm] 退出排序态失败', err); }
        try { clearPromptFind(); } catch (err) { /* 没开查找时不用清 */ }
        const list = document.getElementById('completion_prompt_manager_list');
        if (list) {
            try { stripSortRows(list, pmSortTargets()); } catch (err) { /* 列表已换掉就跳过 */ }
            list.classList.remove('wbm-sorting');
            list.querySelectorAll('li.wbm-find-hit, li.wbm-find-cur, li.wbm-find-pulse').forEach((li) => {
                li.classList.remove('wbm-find-hit', 'wbm-find-cur', 'wbm-find-pulse');
            });
        }
        const bar = document.querySelector('#completion_prompt_manager > .wbm-prompt-bar');
        if (bar) bar.remove();
        const appendBar = document.querySelector('.wbm-append-bar');
        if (appendBar) appendBar.remove();
        const ver = document.querySelector('.completion_prompt_manager_footer .wbm-pm-ver');
        if (ver) ver.remove();
        if (pmExtrasObserver) {
            try { pmExtrasObserver.disconnect(); } catch (err) { /* 已经断开 */ }
            pmExtrasObserver = null;
            pmExtrasObserverTarget = null;
        }
        wbmBarNode = null;
        wbmAppendBarNode = null;
        decoratePromptRows.lastSignature = '';
        decoratePromptRows.mode = null;
    }

    /* 人设：横条、标签、分页一起收走，并把人全部放回来、每页条数还原成用户的设置 */
    function teardownPersona() {
        const bar = document.getElementById('wbm-persona-bar');
        if (bar) bar.remove();
        document.querySelectorAll('#user_avatar_block .wbm-persona-tag').forEach((node) => node.remove());
        document.querySelectorAll('#user_avatar_block .avatar-container').forEach((box) => {
            setPersonaBoxVisible(box, true);
            box.style.display = '';
        });
        const hostPager = document.getElementById('persona_pagination_container');
        if (hostPager) hostPager.style.display = '';
        const gp = document.getElementById('wbm-persona-grouppager');
        if (gp) gp.remove();
        /* 筛选状态故意保留：重开开关就回到原来那个组（大师 2026-10-23 的开关语义是"暂时不用这块"） */
        personaApplyPaging().catch(() => {});
    }

    /* 表头：把我们写进去的 inline 全清掉（含「触发策略」被拆成的两行），交还给宿主样式 */
    function resetEntryHeaders() {
        const list = document.querySelector('#world_popup_entries_list');
        if (list) list.classList.remove('wbm-wi-wrapped');
        const header = document.getElementById('WIEntryHeaderTitlesPC');
        if (header) {
            header.style.position = '';
            header.style.justifyContent = '';
            header.style.alignItems = '';
            header.style.paddingLeft = '';
            header.style.paddingRight = '';
            header.style.minHeight = '';
            Array.from(header.children).forEach((label) => {
                const text = label.dataset ? label.dataset.wbmText : '';
                if (text) label.textContent = text;
                if (label.dataset) delete label.dataset.wbmText;
                label.removeAttribute('style');
            });
        }
        headerAlignDone = false;
    }

    function applyFeatureToggle(key) {
        try {
            if (key === 'promptMgr') {
                if (featureOn('promptMgr')) hookPromptManagerExtras();
                else teardownPromptMgrDom();
            } else if (key === 'persona') {
                if (featureOn('persona')) ensurePersonaBar();
                else teardownPersona();
            } else if (key === 'talkPreset') {
                if (featureOn('talkPreset')) ensureTalkPresetButton();
                else {
                    const btn = document.getElementById('wbm-talk-preset-btn');
                    if (btn) btn.remove();
                }
            } else if (key === 'headerAlign') {
                if (featureOn('headerAlign')) { alignEntryHeadersOnce(); ensureHeaderAlignObserver(); }
                else resetEntryHeaders();
            } else if (key === 'regexGuard') {
                if (featureOn('regexGuard')) regexGuardCheck({ silent: true });
            } else if (key === 'promptEditorCap') {
                syncPromptEditorCap();
            } else if (key === 'frontendGuard') {
                if (featureOn('frontendGuard')) ensureFrontendCardsRendered().catch(() => {});
            }
        } catch (err) {
            console.warn('[wbm] 切换功能开关失败：' + key, err);
        }
        syncPanelNotes();
    }

    function enhancementsOn() {
        return store.enhanceEnabled !== false;
    }

    function editBarOn() {
        return store.editBarBothEnds !== false;
    }

    function clickLockOn() {
        return store.entryClickLock !== false;
    }

    function setClickLock(on) {
        store.entryClickLock = !!on;
        persistStore();
        syncLockChip();
    }

    function lockChipLabel() {
        return clickLockOn() ? '双击编辑' : '单击编辑';
    }

    function syncLockChip() {
        document.querySelectorAll('[data-role="entry-clicklock"]').forEach((chip) => {
            chip.classList.toggle('on', clickLockOn());
            chip.textContent = lockChipLabel();
            const text = clickLockOn()
                ? '双击编辑：条目内容已锁定，单击改不动；想改就在那个字段上双击（复选框与下拉也是双击）'
                : '单击编辑：已解除锁定，条目内容点一下就能改';
            chip.title = text;
            chip.setAttribute('aria-label', text);
        });
    }

    function inEntryList(node) {
        try { return node instanceof Element && !!node.closest('#world_popup_entries_list'); } catch (err) { return false; }
    }

    function entryControls(row) {
        return Array.prototype.slice.call(row.querySelectorAll('input, textarea, select'))
            .filter((node) => !node.closest(LOCK_EXCLUDE_SEL));
    }

    /* 酒馆里有些字段的标题写在控件外面，用 HTML 的 for 关联：
       <small for="sticky">黏性</small>、<small for="characterFilter">绑定到角色或标签</small>、
       <label for="order">顺序：</label>。点这种标题在原生语义里等于点控件——移动端点
       「绑定到角色或标签」的标题就会直接弹出原生多选面板，绕过我们的单击拦截。
       所以这里按 for 找回受控控件，单击按控件同等对待。 */
    function refControlOf(node, row) {
        if (!node || !node.closest) return null;
        const holder = node.closest('[for]');
        if (!holder) return null;
        const target = String(holder.getAttribute('for') || '').trim();
        if (!target) return null;
        const scope = row || node.closest('.world_entry') || document.querySelector('#world_popup_entries_list');
        if (!scope) return null;
        let control = null;
        try {
            const byId = document.getElementById(target);
            if (byId && scope.contains(byId) && byId.matches('input, textarea, select')) control = byId;
        } catch (err) { control = null; }
        if (!control) {
            try { control = scope.querySelector('[name="' + target.replace(/["\\]/g, '\\$&') + '"]'); } catch (err) { control = null; }
        }
        if (!control || !control.matches('input, textarea, select')) return null;
        if (control.closest(LOCK_EXCLUDE_SEL)) return null;
        return control;
    }

    function isTextField(node) {
        if (!node) return false;
        if (node.tagName === 'TEXTAREA') return true;
        if (node.tagName !== 'INPUT') return false;
        const type = String(node.type || 'text').toLowerCase();
        return type === 'text' || type === 'number' || type === 'search' || type === '';
    }

    function lockControl(node) {
        if (isTextField(node)) node.readOnly = true;
        if (node.classList && node.classList.contains('ui-autocomplete-input')) {
            try { const $ = window.jQuery; if ($) $(node).autocomplete('close'); } catch (err) { /* 忽略 */ }
        }
        node.classList.add('wbm-field-locked');
        node.classList.remove('wbm-field-editing');
    }

    function unlockControl(node) {
        if (isTextField(node)) node.readOnly = false;
        node.classList.remove('wbm-field-locked');
        node.classList.add('wbm-field-editing');
    }

    function lockRow(row) {
        if (!row) return;
        const on = clickLockOn();
        const bar = row.querySelector('.wbm-edit-bar');
        const barVisible = !!bar && bar.hidden === false;
        const editNode = row.__wbmEditNode;
        const editing = on && barVisible && editNode && (editNode.isConnected !== false) && row.contains(editNode)
            ? editNode : null;
        entryControls(row).forEach((node) => {
            const isEditing = node.classList.contains('wbm-field-editing');
            /* 只有"当前正在编辑的那一个控件"可以保持解锁，其余残留编辑态一律锁回去
               （防止重绘/换字段后某个框卡在可编辑状态，单击就能改） */
            if (isEditing && node !== editing) {
                node.classList.remove('wbm-field-editing');
                if (on) lockControl(node);
                else if (isTextField(node)) node.readOnly = false;
                return;
            }
            if (isEditing) return;
            if (on) lockControl(node);
            else {
                if (isTextField(node)) node.readOnly = false;
                node.classList.remove('wbm-field-locked');
            }
        });
        syncLockChip();
    }

    function lockEntryContents() {
        if (!enhancementsOn()) return;
        const list = document.querySelector('#world_popup_entries_list');
        if (!list) return;
        list.querySelectorAll('.world_entry').forEach(lockRow);
        syncLockChip();
    }

    /* 动作条只作用于"到底哪一个控件在被编辑"：按元素身份取，不按 name 去找。
       关键词（key）与可选过滤器（keysecondary）各有两个同名控件——标签式 select 与纯文本
       textarea，按 name 找会拿到那个看不见的，于是取消/保存落空、亮着的框保持解锁。 */
    function barTarget(row) {
        if (!row) return null;
        const ref = row.__wbmEditNode;
        if (ref && (ref.isConnected === undefined || ref.isConnected) && row.contains(ref)) return ref;
        const list = Array.prototype.slice.call(row.querySelectorAll('.wbm-field-editing'));
        const visible = list.filter((node) => node.getClientRects().length > 0);
        return visible[0] || list[0] || null;
    }

    function editBar(row) {
        let bar = row.querySelector('.wbm-edit-bar');
        if (bar) return bar;
        bar = el('span', 'wbm-edit-bar');
        bar.hidden = true;
        const cancel = el('button', 'wbm-edit-btn wbm-edit-cancel', '取消');
        cancel.type = 'button';
        const save = el('button', 'wbm-edit-btn wbm-edit-save', '保存');
        save.type = 'button';
        save.title = '保存这一处改动（Ctrl+Enter）';
        bar.appendChild(cancel);
        bar.appendChild(save);
        /* 位置固定一处（master 定的）：thin 控件行（展开箭头＋启用开关那一行）的末尾，
           视觉上就落在触发概率右边、收藏左边。折叠与展开都在同一处，
           因此不会再有「先折叠双击留下一个位置、之后永远钉在那儿」的问题。 */
        const host = row.querySelector('.world_entry_thin_controls');
        if (host) host.appendChild(bar); else row.appendChild(bar);
        bar.addEventListener('click', (event) => {
            const btn = event.target instanceof Element ? event.target.closest('button') : null;
            if (!btn) return;
            event.preventDefault();
            event.stopPropagation();
            const node = barTarget(row);
            if (!node) {
                bar.hidden = true;
                delete row.dataset.wbmEditField;
                delete row.__wbmEditNode;
                lockRow(row);
                return;
            }
            if (btn.classList.contains('wbm-edit-cancel')) cancelField(node);
            else saveField(node);
        });
        return bar;
    }

    /* 这一行条目到底属于哪本世界书：以条目自己的 data-current-world 为准。
       编辑器下拉的选中项在某些时序下会和实际渲染的书不同步（比如列表刚重建过），
       按下拉取书名会把改动/历史记到别人书上，撤销时就会写错书。 */
    function rowBook(row) {
        const mv = row ? row.querySelector('.move_entry_button') : null;
        const name = mv ? String(mv.getAttribute('data-current-world') || '') : '';
        return name || currentEditingName();
    }

    async function dataValueOf(row, field) {
        const uid = (function () {
            const mv = row.querySelector('.move_entry_button');
            return mv ? String(mv.getAttribute('data-uid') || '') : '';
        })();
        const book = rowBook(row);
        if (!uid || !book) return undefined;
        try {
            const mod = await import('/scripts/world-info.js');
            const data = await mod.loadWorldInfo(book);
            const entry = data && data.entries ? data.entries[String(uid)] : null;
            if (!entry) return undefined;
            const value = entry[field];
            return Array.isArray(value) ? value.slice() : value;
        } catch (err) {
            return undefined;
        }
    }

    async function openFieldEditor(node) {
        if (!node || node.classList.contains('wbm-field-editing')) return;
        const row = node.closest('.world_entry');
        if (!row) return;
        /* 同一时间只允许一处处于编辑态——范围是整张条目列表，不只这一行（master 定的）：
           点了别的条目就先把上一条还原掉，否则会同时冒出好几组「取消 / 保存」。 */
        const list = document.querySelector('#world_popup_entries_list') || row;
        Array.prototype.slice.call(list.querySelectorAll('.wbm-field-editing')).forEach((other) => {
            if (other !== node) cancelField(other);
        });
        node.dataset.wbmBefore = node.value == null ? '' : String(node.value);
        if (node.name && FIELD_DATA_NAME[node.name]) {
            const before = await dataValueOf(row, FIELD_DATA_NAME[node.name]);
            node.dataset.wbmDataBefore = before === undefined ? '' : JSON.stringify(before);
        }
        unlockControl(node);
        row.__wbmEditNode = node;
        row.dataset.wbmEditField = node.name || '';
        const bar = editBar(row);
        if (bar) bar.hidden = false;
        try { node.focus({ preventScroll: true }); } catch (err) { node.focus(); }
        const pos = node.value ? node.value.length : 0;
        try { node.setSelectionRange(pos, pos); } catch (err) { /* 忽略 */ }
    }

    function closeFieldEditor(node, revert) {
        if (!node) return;
        if (revert && node.dataset.wbmBefore != null) node.value = node.dataset.wbmBefore;
        delete node.dataset.wbmBefore;
        delete node.dataset.wbmDataBefore;
        const row = node.closest('.world_entry');
        if (row) {
            const bar = row.querySelector('.wbm-edit-bar');
            if (bar) bar.hidden = true;
            delete row.dataset.wbmEditField;
            if (row.__wbmEditNode === node) delete row.__wbmEditNode;
        }
        node.classList.remove('wbm-field-editing');
        if (row && clickLockOn()) lockControl(node);
        else node.classList.remove('wbm-field-locked');
        /* 收尾扫一遍：这一行里若还有别的残留编辑态（同名控件拿错、重绘时序），一起还原并锁回去，
           不让任何一个框停在"亮着且单击可改"的状态 */
        if (!row) return;
        Array.prototype.slice.call(row.querySelectorAll('.wbm-field-editing')).forEach((other) => {
            if (other === node) return;
            if (other.dataset.wbmBefore != null) other.value = other.dataset.wbmBefore;
            delete other.dataset.wbmBefore;
            delete other.dataset.wbmDataBefore;
            other.classList.remove('wbm-field-editing');
            if (clickLockOn()) lockControl(other);
            else if (isTextField(other)) other.readOnly = false;
        });
    }

    function cancelField(node) {
        closeFieldEditor(node, true);
    }

    function saveField(node) {
        const before = node.dataset.wbmBefore == null ? '' : String(node.dataset.wbmBefore);
        const dataBeforeRaw = node.dataset.wbmDataBefore;
        const value = node.value == null ? '' : String(node.value);
        const row = node.closest('.world_entry');
        const name = node.name || '';
        if (!row || !name || !FIELD_DATA_NAME[name]) { closeFieldEditor(node, false); return; }
        if (value === before) {
            closeFieldEditor(node, false);
            toast('info', '这一处没改动，不用保存');
            return;
        }
        /* 先解锁再放行一次原生 input/change，宿主的处理器会把值写进 data、镜像并存盘 */
        node.readOnly = false;
        row.dataset.wbmSaving = '1';
        try {
            node.dispatchEvent(new Event('input', { bubbles: true }));
            node.dispatchEvent(new Event('change', { bubbles: true }));
        } catch (err) {
            console.warn('[wbm] 保存字段时宿主没接住', err);
            delete row.dataset.wbmSaving;
            closeFieldEditor(node, false);
            toast('warning', '保存没成功，这一处可能没写进去');
            return;
        }
        delete row.dataset.wbmSaving;
        closeFieldEditor(node, false);
        const field = FIELD_DATA_NAME[name];
        const uid = (function () {
            const mv = row.querySelector('.move_entry_button');
            return mv ? String(mv.getAttribute('data-uid') || '') : '';
        })();
        const book = rowBook(row);
        const nameInput = row.querySelector('textarea[name="comment"]');
        const label = nameInput && nameInput.value ? String(nameInput.value) : '';
        let beforeValue;
        try { beforeValue = dataBeforeRaw ? JSON.parse(dataBeforeRaw) : undefined; } catch (err) { beforeValue = undefined; }
        const beforeMap = {};
        if (beforeValue !== undefined) beforeMap[field] = beforeValue;
        else if (field === 'content' || field === 'comment') beforeMap[field] = before;
        pushHistory({
            act: 'edit',
            at: Date.now(),
            from: book,
            to: book,
            count: 1,
            entries: Object.keys(beforeMap).length ? [{ uid, name: label.slice(0, 40), before: beforeMap }] : [],
            payloadDropped: Object.keys(beforeMap).length ? undefined : true,
            names: [label.slice(0, 20)],
        });
        toast('info', '已保存这一处，改错了可以在操作历史里撤销');
    }

    function toggleCheckbox(node) {
        node.checked = !node.checked;
        try {
            const $ = window.jQuery;
            if ($) $(node).trigger('input');
            else node.dispatchEvent(new Event('input', { bubbles: true }));
        } catch (err) {
            console.warn('[wbm] 勾选没写进去', err);
        }
        toast('info', node.checked ? '已勾选（双击可再切换）' : '已取消勾选（双击可再切换）');
    }

    function openSelect(node) {
        const $ = window.jQuery;
        try { if (node.closest('.select2-container') && $) return; } catch (err) { /* 忽略 */ }
        /* 「用户主动打开」的标记：单击拦截放行、change 回滚也不动手；
           20 秒后自动收回，避免一次双击把这个字段永久解锁 */
        node.classList.add('wbm-select-open');
        const release = () => node.classList.remove('wbm-select-open');
        /* 多选列表框（绑定到角色或标签、筛选生成触发器）本身就把选项摊在页面上，
           没有"弹出层"这一说，所以不调 showPicker，直接解锁让用户点选项 */
        if (node.multiple) {
            setTimeout(release, 20000);
            toast('info', '已解锁：现在点选项即可勾选/取消，20 秒后自动锁定');
            return;
        }
        /* 手机端一律用我们自己的浮层：showPicker() 弹的是浏览器/系统那套选择器，
           和酒馆主题完全两张皮，还盖住整页——master 明确不要它 */
        if (compactViewport()) {
            /* 浮层关掉就立刻收回解锁标记：这套交互点一下即完成，不需要 20 秒的解锁窗口 */
            openNativeSelectPicker(node, release);
            return;
        }
        try {
            if (typeof node.showPicker === 'function') {
                node.showPicker();
                setTimeout(release, 20000);
                return;
            }
        } catch (err) { /* 落到下面的兜底 */ }
        /* 没有 showPicker 的浏览器：临时放开一下，让用户直接点 */
        node.classList.add('wbm-field-editing');
        node.removeAttribute('readonly');
        setTimeout(() => {
            release();
            node.classList.remove('wbm-field-editing');
            if (clickLockOn()) lockControl(node);
        }, 20000);
        toast('info', '这里已临时解锁，20 秒内可以直接选择');
    }

    function ensureContentGuard() {
        if (contentGuardBound) return;
        contentGuardBound = true;
        /* 单击：文本字段已经 readonly 不用管；复选框与下拉在锁定状态下吞掉单击 */
        const swallow = (event) => {
            const node = event.target;
            if (!inEntryList(node)) return;
            if (node.closest(LOCK_EXCLUDE_SEL)) return;
            if (node.closest('.wbm-field-bar')) return;
            if (!clickLockOn()) return;
            /* select2 的可见外壳与它内部的搜索框都不是"输入框"的常规语义，单独拦 */
            if (node.closest('.select2-container, .select2-selection')) {
                event.preventDefault();
                event.stopPropagation();
                if (typeof event.stopImmediatePropagation === 'function') event.stopImmediatePropagation();
                return;
            }
            /* 复选框普遍包在 <label class="checkbox_label"> 里，点的是 label/span，不是 input */
            const label = node.closest('label');
            if (label && label.querySelector('input[type="checkbox"], input[type="radio"], select')) {
                event.preventDefault();
                event.stopPropagation();
                if (typeof event.stopImmediatePropagation === 'function') event.stopImmediatePropagation();
                return;
            }
            /* 写在控件外面的标题（<small for="sticky">、<label for="order">）：点它等于点控件，
               移动端点「绑定到角色或标签」的标题会弹出原生多选面板，一并拦住 */
            const refNode = refControlOf(node);
            if (refNode && refNode !== node && !refNode.classList.contains('wbm-field-editing')) {
                event.preventDefault();
                event.stopPropagation();
                if (typeof event.stopImmediatePropagation === 'function') event.stopImmediatePropagation();
                return;
            }
            /* <select multiple> 里被点的是 <option>，不是 select 本身：按它所属的 select 判断，
               否则 option 会漏过拦截、一碰就改选中项（手机端误触的主因） */
            const ownerSel = node.matches('select') ? node : (node.closest ? node.closest('select') : null);
            if (!node.matches('input, textarea, select') && !ownerSel) return;
            if (ownerSel && (ownerSel.classList.contains('wbm-field-editing')
                || ownerSel.classList.contains('wbm-select-open'))) return;
            /* 带自动补全的文本框（自动化 ID 这类）：锁定态单击会聚焦并弹出候选，
               点候选等于直接改值，所以连单击一起吞掉，只留双击。 */
            if (isTextField(node)) {
                if (node.classList.contains('wbm-field-editing')) return;
                if (!node.classList.contains('ui-autocomplete-input')) return;
                try { const $ = window.jQuery; if ($) $(node).autocomplete('close'); } catch (err) { /* 忽略 */ }
                event.preventDefault();
                event.stopPropagation();
                if (typeof event.stopImmediatePropagation === 'function') event.stopImmediatePropagation();
                return;
            }
            if (node.classList.contains('wbm-field-editing')) return;
            event.preventDefault();
            event.stopPropagation();
            if (typeof event.stopImmediatePropagation === 'function') event.stopImmediatePropagation();
        };
        document.addEventListener('mousedown', swallow, true);
        document.addEventListener('click', swallow, true);
        /* 编辑期间不许宿主实时保存：只有按「保存」时我们放行一次 */
        const blockDuringEdit = (event) => {
            const node = event.target;
            if (!inEntryList(node)) return;
            if (!node.classList || !node.classList.contains('wbm-field-editing')) return;
            const row = node.closest('.world_entry');
            if (!row || row.dataset.wbmSaving === '1') return;
            event.stopPropagation();
            if (typeof event.stopImmediatePropagation === 'function') event.stopImmediatePropagation();
        };
        document.addEventListener('input', blockDuringEdit, true);
        document.addEventListener('change', blockDuringEdit, true);
        /* 移动端的关键差异：<select multiple>（绑定到角色或标签、筛选生成触发器）的选中项
           由浏览器在触屏 touchend/pointerup 阶段就直接改掉，根本轮不到 mousedown 的
           preventDefault，所以桌面上能拦、手机上一碰就变。
           这里在 touchstart（最早的阶段）就吞掉它，并自己实现「双击解锁」：
           同一控件 420ms 内连点两次 → 进入可编辑（wbm-select-open），之后正常点选。 */
        let wbmLastTapNode = null;
        let wbmLastTapAt = 0;
        let wbmHintAt = 0;
        const wbmTouchHint = () => {
            const now = Date.now();
            if (now - wbmHintAt > 5000) {
                wbmHintAt = now;
                toast('info', '条目已锁定：双击才能改');
            }
        };
        /* 触屏上要拦两类东西，都是在 touchstart 阶段就生效了，等 mousedown 已经来晚了：
           ① <select multiple>（绑定到角色或标签、筛选生成触发器）：选中项在触摸阶段就被改；
           ② 带自动补全的输入框（自动化 ID）：touchstart 就聚焦、弹出候选，点候选等于直接改值，
              readonly 挡不住它。两者统一在这里吞掉，双击＝进入编辑。 */
        const touchGuard = (event) => {
            const t = event.target;
            if (!t || !t.closest) return;
            if (!inEntryList(t)) return;
            if (!clickLockOn()) return;
            if (t.closest(LOCK_EXCLUDE_SEL)) return;
            const sel = (t.matches && t.matches('select')) ? t : t.closest('select');
            const field = (t.matches && t.matches('input, textarea')) ? t : null;
            const autoField = field && field.classList && field.classList.contains('ui-autocomplete-input') ? field : null;
            const target = sel || autoField;
            if (!target) return;
            if (target.classList.contains('wbm-select-open') || target.classList.contains('wbm-field-editing')) return;
            if (event.cancelable) event.preventDefault();
            event.stopPropagation();
            if (typeof event.stopImmediatePropagation === 'function') event.stopImmediatePropagation();
            const now = Date.now();
            if (wbmLastTapNode === target && now - wbmLastTapAt < 420) {
                wbmLastTapNode = null;
                wbmLastTapAt = 0;
                if (sel) openSelect(sel);
                else openFieldEditor(autoField);
                return;
            }
            wbmLastTapNode = target;
            wbmLastTapAt = now;
            if (autoField) {
                try { const $ = window.jQuery; if ($) $(autoField).autocomplete('close'); } catch (err) { /* 忽略 */ }
            }
            wbmTouchHint();
        };
        document.addEventListener('touchstart', touchGuard, { capture: true, passive: false });
        /* 兜底：万一控件被重绘、或 lockRow 没赶上新节点，只要"锁定态下还能聚焦"就当场锁回去。
           判据是能不能改值，不是 class 上有没有 wbm-field-locked。 */
        document.addEventListener('focusin', (event) => {
            const node = event.target;
            if (!node || !inEntryList(node)) return;
            if (!clickLockOn()) return;
            if (node.closest(LOCK_EXCLUDE_SEL)) return;
            if (!node.matches || !node.matches('input, textarea, select')) return;
            if (node.classList.contains('wbm-field-editing')) return;
            if (isTextField(node)) node.readOnly = true;
            node.classList.add('wbm-field-locked');
            try {
                const $ = window.jQuery;
                if ($ && node.classList.contains('ui-autocomplete-input')) $(node).autocomplete('close');
            } catch (err) { /* 忽略 */ }
            try { node.blur(); } catch (err) { /* 忽略 */ }
        }, true);

        /* 兜底：万一本机浏览器在 preventDefault 之后仍改动了多选里的选中项，
           锁定状态下把 change 直接回滚（快照在 mousedown 时记下）。
           双击打开过的字段带 wbm-select-open，不参与回滚。 */
        document.addEventListener('mousedown', (event) => {
            const t = event.target;
            if (!t || !t.closest) return;
            const sel = (t.matches && t.matches('select')) ? t : t.closest('select');
            if (!sel || !inEntryList(sel)) return;
            if (sel.classList.contains('wbm-field-editing') || sel.classList.contains('wbm-select-open')) return;
            try {
                sel.dataset.wbmPrev = JSON.stringify(
                    Array.prototype.map.call(sel.selectedOptions || [], (o) => o.value));
            } catch (err) { /* 忽略 */ }
        }, true);
        document.addEventListener('change', (event) => {
            const sel = event.target;
            if (!sel || sel.tagName !== 'SELECT') return;
            if (!inEntryList(sel)) return;
            if (!clickLockOn()) return;
            if (sel.classList.contains('wbm-field-editing') || sel.classList.contains('wbm-select-open')) return;
            const prev = sel.dataset.wbmPrev;
            if (!prev) return;
            let want;
            try { want = new Set(JSON.parse(prev)); } catch (err) { return; }
            Array.prototype.forEach.call(sel.options, (o) => { o.selected = want.has(o.value); });
            event.stopPropagation();
            toast('info', '条目已锁定：双击这个下拉才能改');
        }, true);
        /* 双击：按字段类型分流 */
        document.addEventListener('dblclick', (event) => {
            const node = event.target;
            if (!inEntryList(node)) return;
            if (node.closest(LOCK_EXCLUDE_SEL)) return;
            if (node.closest('.wbm-field-bar')) return;
            let control = node.matches('input, textarea, select') ? node : node.closest('input, textarea, select');
            if (!control) {
                const lab = node.closest('label');
                if (lab) control = lab.querySelector('input[type="checkbox"], input[type="radio"], select');
            }
            /* 标题写在控件外面（<small for="sticky">黏性</small>）：双击标题也要能进编辑 */
            if (!control) control = refControlOf(node);
            if (!control) return;
            event.preventDefault();
            event.stopPropagation();
            if (!clickLockOn()) return;
            if (isTextField(control)) { openFieldEditor(control); return; }
            if (control.tagName === 'SELECT') { openSelect(control); return; }
            if (control.type === 'checkbox' || control.type === 'radio') { toggleCheckbox(control); return; }
        }, true);
        /* Ctrl+Enter 保存这一处，Esc 取消 */
        document.addEventListener('keydown', (event) => {
            const node = event.target;
            if (!inEntryList(node) || !node.matches('textarea, input')) return;
            if (!node.classList.contains('wbm-field-editing')) return;
            if (event.key === 'Escape') { event.preventDefault(); cancelField(node); return; }
            if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); saveField(node); }
        }, true);
        /* select2 那层壳：单击吞掉，双击打开 */
        document.addEventListener('dblclick', (event) => {
            const shell = event.target instanceof Element ? event.target.closest('.select2-container') : null;
            if (!shell || !inEntryList(shell)) return;
            if (!clickLockOn()) return;
            const select = (function () {
                const row = shell.closest('.world_entry');
                const prev = shell.previousElementSibling;
                if (prev && prev.matches('select, input, textarea')) return prev;
                return row ? row.querySelector('select[name="position"], select[name="entryStateSelector"]') : null;
            })();
            if (!select) return;
            event.preventDefault();
            event.stopPropagation();
            const $ = window.jQuery;
            const s2 = $ && $(select).data('select2');
            if (s2 && typeof s2.open === 'function') { s2.open(); return; }
            openSelect(select);
        }, true);
    }

    /* 表头列宽只跟容器宽度有关，与条目数无关，所以没必要每渲染一次就量一次 */
    let headerAlignObserver = null;
    let headerAlignDone = false;

    /* 只补一次：首次渲染时若观察者的初始回调发生在"还没有条目"之前，这里兜住 */
    function alignEntryHeadersOnce() {
        if (headerAlignDone) return;
        if (alignEntryHeaders()) headerAlignDone = true;
    }

    function ensureHeaderAlignObserver() {
        if (!featureOn('headerAlign')) return;
        const header = document.getElementById('WIEntryHeaderTitlesPC');
        if (!header) return;
        if (headerAlignObserver) return;
        if (typeof ResizeObserver !== 'function') {
            /* 老浏览器：只在第一次渲染后补一次，不轮询 */
            setTimeout(alignEntryHeaders, 0);
            return;
        }
        headerAlignObserver = new ResizeObserver((entries) => {
            const box = entries && entries[0] ? entries[0].contentRect : null;
            /* 面板收起时宽度是 0，这时候量出来的位置全是错的，直接跳过 */
            if (box && box.width < 50) return;
            headerAlignDone = alignEntryHeaders();
        });
        headerAlignObserver.observe(header);
        /* 列表宽度跟着面板走：宽度一变就可能从单排变两排（或反过来），要重新判定。
           表头自己的宽度不变，只盯它不会触发。 */
        const listForObserve = document.querySelector('#world_popup_entries_list');
        if (listForObserve) headerAlignObserver.observe(listForObserve);
    }

    /* 条目头的 DOM 现在两端一致：触发策略（🔵/🟢/🔗）本来就坐在标题右边，删除键本来就跟着
       移动/复制那两个兄弟位。手机端的重排全部交给 CSS（标题行 → 字段网格 → 右下角功能键），
       这里只做一次归位，防的是旧版本把这两颗控件搬进字段网格留下的痕迹。 */
    function arrangeMobileEntryFields() {
        const list = document.querySelector('#world_popup_entries_list');
        if (!list) return;
        const rows = list.querySelectorAll('.world_entry');
        for (let i = 0; i < rows.length; i++) {
            const row = rows[i];
            const stateSel = row.querySelector('select[name="entryStateSelector"]');
            const titleBox = row.querySelector('.WIEntryTitleAndStatus');
            const actions = row.querySelector('.wbm-entry-actions');
            const del = row.querySelector('.delete_entry_button');
            if (stateSel && titleBox && stateSel.parentElement !== titleBox) titleBox.appendChild(stateSel);
            if (actions && del && del.parentElement !== actions) actions.appendChild(del);
        }
    }

    function bindPreviewHook() {
        document.addEventListener('click', (event) => {
            const target = event.target;
            if (!(target instanceof Element)) return;
            const favBtn = target.closest('.wbm-fav-entry-btn');
            if (favBtn) {
                event.preventDefault();
                event.stopPropagation();
                const holder = favBtn.parentElement ? favBtn.parentElement.querySelector('.move_entry_button') : null;
                const uid = holder ? holder.getAttribute('data-uid') : favBtn.dataset.uid;
                const world = holder ? holder.getAttribute('data-current-world') : favBtn.dataset.world;
                const row = favBtn.closest('.world_entry');
                const nameBox = row ? row.querySelector('textarea[name="comment"], .comment') : null;
                const name = nameBox ? String(nameBox.value || nameBox.textContent || '').trim() : '';
                const on = toggleFavEntry(world, uid, name);
                favBtn.textContent = on ? '★' : '☆';
                favBtn.classList.toggle('on', on);
                favBtn.title = on ? '取消收藏这条条目' : '收藏这条条目';
                return;
            }
            const btn = target.closest('.wbm-preview-btn');
            if (!btn) return;
            /* uid / 书名现读兄弟按钮，避免 ST 重绘时序造成的旧值 */
            const holder = btn.parentElement ? btn.parentElement.querySelector('.move_entry_button') : null;
            const uid = holder ? holder.getAttribute('data-uid') : btn.dataset.uid;
            const world = holder ? holder.getAttribute('data-current-world') : btn.dataset.world;
            event.preventDefault();
            event.stopPropagation();
            openPreview(world, uid);
        }, true);

        const attach = (tries) => {
            const list = document.querySelector('#world_popup_entries_list');
            if (!list) {
                if (tries > 0) setTimeout(() => attach(tries - 1), 1000);
                return;
            }
            if (previewObserver) previewObserver.disconnect();
            if (typeof MutationObserver !== 'function') { injectPreviewButtons(); return; }
            /* subtree:true 是必需的：条目正文框不是随列表一起渲染的，酒馆是在「展开条目」时才把
               那一块 DOM 建出来（收起状态下行里只有备注框）。只盯 childList 的话，展开时不会回调，
               正文框就永远拿不到 readonly。这里用 rAF 合帧，一次重绘/一次展开只跑一次。 */
            let scheduled = false;
            previewObserver = new MutationObserver(() => {
                if (scheduled) return;
                scheduled = true;
                const run = () => { scheduled = false; injectPreviewButtons(); };
                if (typeof requestAnimationFrame === 'function') requestAnimationFrame(run);
                else setTimeout(run, 16);
            });
            previewObserver.observe(list, { childList: true, subtree: true });
            injectPreviewButtons();
        };
        attach(10);
    }

    /* ---------------- 条目列表的「仅收藏 / 收藏置顶」 ---------------- */

    /* 与酒馆原生排序的协调：只用 CSS 的 flex order 把收藏项提到前面，
       DOM 顺序一律不动——这样酒馆的拖拽（自定义排序）、分页、搜索过滤都保持原语义。
       关闭置顶时把 class 与 inline order 全部清掉，界面回到完全原生的样子。 */
    const FAV_ENTRY_PIN_KEY = 'wbm-fav-entry-pin';
    let entryFavOnly = false;

    function entryFavPinOn() {
        return !!store.entryFavPin;
    }

    function setEntryFavPin(on) {
        store.entryFavPin = !!on;
        persistStore();
    }

    function entryRowUid(row) {
        const fromAttr = row.getAttribute('uid');
        if (fromAttr) return String(fromAttr);
        const moveBtn = row.querySelector('.move_entry_button');
        return moveBtn ? String(moveBtn.getAttribute('data-uid') || '') : '';
    }

    /* 一次遍历：加/去 .wbm-fav-hidden（不用 inline display，免得把酒馆搜索隐藏的行又显示出来），
       置顶打开时给行写 flex order。行数就是一个分页的量（默认 25），开销可忽略。 */
    /* 条目筛选：三个触发策略是同一个维度（互相 OR，可多选）；「已禁用」「仅收藏」是另外两个维度，
       维度之间 AND。一个都不勾 = 不筛选。
       触发策略三档就是那个圆点下拉：🔵 常量（常驻注入）、🟢 正常（关键词命中才注入）、
       🔗 向量化（靠向量库召回，没装向量扩展基本用不到，所以很少有人见）。 */
    const ENTRY_STATE_LABELS = [
        { value: 'constant', label: '🔵 常量' },
        { value: 'normal', label: '🟢 正常' },
        { value: 'vectorized', label: '🔗 向量化' },
    ];
    const entryStateFilter = new Set();
    let entryDisabledOnly = false;

    function entryPassesFilter(info, opts) {
        if (opts.favOnly && !info.faved) return false;
        if (opts.disabledOnly && !info.disabled) return false;
        if (opts.states && opts.states.size && !opts.states.has(String(info.state || ''))) return false;
        return true;
    }

    function entryRowState(row) {
        const sel = row.querySelector('select[name="entryStateSelector"]');
        return sel ? String(sel.value || '') : '';
    }

    function applyEntryFavFilter() {
        const list = document.querySelector('#world_popup_entries_list');
        if (!list) return;
        const book = currentEditingName();
        const favs = book ? favEntryKeySet() : new Set();
        /* 接管成功时整本书已由宿主管线排好，页内不再摆 DOM 顺序；只有兜底时才用 order。
           注意：开关本身的状态看 entryFavPinOn()，不能用"页内排序是否生效"当状态。 */
        const pinOn = entryFavPinOn();
        const pinPage = pinOn && !wiFilterPatched;
        list.classList.toggle('wbm-order-on', pinPage);
        const rows = list.querySelectorAll('.world_entry');
        const opts = { favOnly: entryFavOnly, disabledOnly: entryDisabledOnly, states: entryStateFilter };
        for (let i = 0; i < rows.length; i++) {
            const row = rows[i];
            const uid = entryRowUid(row);
            const faved = !!book && !!uid && favs.has(favEntryKey(book, uid));
            const info = {
                faved,
                disabled: row.classList.contains('disabledWIEntry'),
                state: entryRowState(row),
            };
            /* 接管成功后由宿主管线负责筛选，这里只剩置顶排序，不再重复隐藏 */
            if (!wiFilterPatched) row.classList.toggle('wbm-fav-hidden', !entryPassesFilter(info, opts));
            if (pinPage) row.style.order = faved ? '0' : '1';
            else if (row.style.order) row.style.order = '';
        }
        const chipOnly = document.querySelector('.wbm-entry-favbar [data-role="entry-favonly"]');
        if (chipOnly) chipOnly.classList.toggle('on', entryFavOnly);
        const chipDisabled = document.querySelector('.wbm-entry-favbar [data-role="entry-disabled"]');
        if (chipDisabled) chipDisabled.classList.toggle('on', entryDisabledOnly);
        document.querySelectorAll('.wbm-entry-favbar [data-role^="entry-state-"]').forEach((chip) => {
            chip.classList.toggle('on', entryStateFilter.has(String(chip.dataset.state || '')));
        });
        syncSearchScopeChips();
        const chipPin = document.querySelector('.wbm-entry-favbar [data-role="entry-favpin"]');
        if (chipPin) {
            chipPin.classList.toggle('on', pinOn);
            chipPin.textContent = pinOn ? '收藏置顶：开' : '收藏置顶：关';
        }
    }

    /* 全库筛选：酒馆的编辑器是分页渲染的，但它在渲染前会先走一遍
       worldInfoFilter.applyFilters(data)——那是"排序 → 分页"之前的全量数据。
       我们把这个实例方法包一层，先让酒馆自己的搜索过滤跑完，再按我们的筛选条件过滤，
       于是筛选和酒馆的搜索/排序/分页走同一条管线，命中数也就是全库命中数。
       （不改宿主源码，只替换单例上的方法引用；宿主重装/升级导致方法缺失时自动退回原来的分页内筛选。） */
    /* 搜索范围：三面里只要有关掉的一面，就自己先过一遍候选（只在这一种情况多走一遍；
       三面全开时一个字节都不碰，等于原生）。做法是"先剔掉不该搜的"，再交给酒馆自己的
       模糊搜与相关度打分，所以排序、分页、命中数仍然全部由宿主管线算。 */
    function scopeFilterEnabled() {
        return !Array.isArray(store.searchScope) || store.searchScope.length !== SEARCH_SCOPE_VALUES.length;
    }

    function searchTermOf(helper) {
        try {
            const term = helper && typeof helper.getFilterData === 'function'
                ? helper.getFilterData('world_info_search') : '';
            return String(term == null ? '' : term).trim();
        } catch (err) {
            return '';
        }
    }

    /* 现在的范围，用中文说清楚（搜索框空着时点键给一句提示，免得以为没生效） */
    function searchScopeSummary() {
        const scope = Array.isArray(store.searchScope) ? store.searchScope : SEARCH_SCOPE_VALUES;
        if (!scope.length) return '三个面都关了，搜什么都列不出条目';
        if (scope.length === SEARCH_SCOPE_VALUES.length) return '全部字段（等同原生）';
        return scope.map((value) => {
            const hit = SEARCH_SCOPES.find((item) => item.value === value);
            return hit ? hit.label : value;
        }).join('、');
    }

    function entryMatchesSearchScope(entry, term) {        const needle = String(term || '').toLowerCase();
        if (!needle) return true;
        const scope = Array.isArray(store.searchScope) ? store.searchScope : SEARCH_SCOPE_VALUES;
        if (!scope.length) return false; /* 三面全关＝什么都不显示，方便一面一面地点着看 */
        const parts = [];
        if (scope.indexOf('title') !== -1) parts.push(entry.comment);
        if (scope.indexOf('keys') !== -1) {
            if (Array.isArray(entry.key)) parts.push(entry.key.join('\n'));
            if (Array.isArray(entry.keysecondary)) parts.push(entry.keysecondary.join('\n'));
        }
        if (scope.indexOf('body') !== -1) parts.push(entry.content);
        return String(parts.join('\n')).toLowerCase().indexOf(needle) !== -1;
    }

    /* 三枚小键贴在条目搜索框右边：搜索框 → 搜索范围 → 排序下拉。
       那一行是宿主的静态工具条，不随条目重绘，插一次就够。 */
    function buildSearchScopeBar() {
        const bar = el('div', 'wbm-search-scope');
        bar.appendChild(el('span', 'wbm-scope-label', '搜索范围'));
        const scope = Array.isArray(store.searchScope) ? store.searchScope : SEARCH_SCOPE_VALUES;
        SEARCH_SCOPES.forEach((item) => {
            const on = scope.indexOf(item.value) !== -1;
            const chip = el('button', 'menu_button wbm-chip wbm-chip-sm' + (on ? ' on' : ''), item.label);
            chip.type = 'button';
            chip.dataset.role = 'search-scope-' + item.value;
            chip.dataset.scope = item.value;
            chip.title = '条目搜索只在「' + item.hint + '」里找；三个全关＝搜什么都列不出条目';
            chip.setAttribute('aria-pressed', on ? 'true' : 'false');
            chip.addEventListener('click', (event) => {
                event.preventDefault();
                event.stopPropagation();
                toggleSearchScope(item.value);
            });
            bar.appendChild(chip);
        });
        return bar;
    }

    function syncSearchScopeChips() {
        const scope = Array.isArray(store.searchScope) ? store.searchScope : SEARCH_SCOPE_VALUES;
        document.querySelectorAll('.wbm-search-scope [data-role^="search-scope-"]').forEach((chip) => {
            const on = scope.indexOf(String(chip.dataset.scope || '')) !== -1;
            chip.classList.toggle('on', on);
            chip.setAttribute('aria-pressed', on ? 'true' : 'false');
        });
    }

    function ensureSearchScopeBar() {
        const input = document.getElementById('world_info_search');
        if (!input || !input.parentNode) return;
        if (!input.parentNode.querySelector('.wbm-search-scope')) {
            input.insertAdjacentElement('afterend', buildSearchScopeBar());
        }
        /* 装上我们的键之后才裁短排序下拉，没装成功就不动原生观感 */
        if (input.parentNode.classList) input.parentNode.classList.add('wbm-scope-row');
        syncSearchScopeChips();
        ensureWorldRow();
    }

    /* ---------------- 世界书选择那一排的整理 ----------------
       原生把「创建 / or / 选择以编辑 / 导入 / 导出 / 重命名 / 复制 / 删除」八个元素
       塞在同一个 flex 容器里（public/index.html:4824），桌面一行装得下，手机装不下，
       于是第五个图标（垃圾桶）被 wrap 挤成孤行——这是从电脑硬搬过来的痕迹。
       这里把它按语义拆成两排：
         第一排（挑一本书）＝ 创建 · or · 选择以编辑 · 世界书分类
         第二排（动这本书）＝ 导入 · 导出 · 重命名 · 复制 · 删除   五等分占满，谁都不掉队
       实现只在导入键前插一个零高断行节点，不改宿主的 DOM 与事件。 */
    function ensureWorldRow() {
        const create = document.getElementById('world_create_button');
        const row = create && create.parentNode;
        if (!row) return;
        if (row.classList) row.classList.add('wbm-world-row');
        ensureRowBreak(row);

        let btn = row.querySelector('.wbm-cat-btn');
        if (!btn) {
            btn = el('button', 'menu_button wbm-cat-btn');
            btn.type = 'button';
            btn.dataset.role = 'category-open';
            btn.title = '世界书分类：按来源挑一本书来编辑';
            btn.setAttribute('aria-label', '世界书分类');
            btn.appendChild(el('i', 'fa-solid fa-layer-group'));
            const activate = (event) => {
                event.preventDefault();
                event.stopPropagation();
                openCategoryPanel();
            };
            btn.addEventListener('click', activate);
            btn.addEventListener('pointerdown', (event) => { event.stopPropagation(); });
        }
        /* 紧跟在「选择以编辑」右侧：两者都是"挑一本书"，放一起不用解释 */
        const anchor = categoryAnchor(row);
        if (anchor && anchor.parentNode === row && anchor.nextElementSibling !== btn) {
            anchor.insertAdjacentElement('afterend', btn);
        }
    }

    /* 「选择以编辑」后端到底是谁：手机端是自绘的 .wbm-editor-wrap，
       电脑端是 ST 自己放出来的 select2 容器（它俩谁在 select 后面就跟谁）。 */
    function categoryAnchor(row) {
        const sel = editorSelect();
        if (!sel || sel.parentNode !== row) return null;
        let anchor = sel;
        let node = sel.nextElementSibling;
        while (node && node.classList
            && (node.classList.contains('wbm-editor-wrap')
                || node.classList.contains('select2-container')
                || node.classList.contains('select2'))) {
            anchor = node;
            node = node.nextElementSibling;
        }
        return anchor;
    }

    function ensureRowBreak(row) {
        if (row.querySelector('.wbm-rowbreak')) return;
        const importBtn = row.querySelector('#world_import_button');
        if (!importBtn) return;
        const brk = el('div', 'wbm-rowbreak');
        brk.setAttribute('aria-hidden', 'true');
        importBtn.insertAdjacentElement('beforebegin', brk);
    }

    /* ---------------- 世界书分类：按全量绑定关系分两段 ----------------
       口径（master 定）：绑定＝在任一张角色卡、任一份人设、任一个聊天或全局清单里出现过，
       与"当前选中什么"无关。一本书只归一个小组，顺序即优先级：
       角色卡 > 附加 > 人设 > 聊天 > 全局；一处都没命中的才算「未绑定」。 */

    const CAT_GROUPS = [
        { key: 'character', title: '角色卡世界书' },
        { key: 'extra', title: '附加世界书' },
        { key: 'persona', title: '人设世界书' },
        { key: 'chat', title: '聊天世界书' },
        { key: 'global', title: '全局世界书' },
    ];
    const CAT_NOTE = '一本书只归一处：同时被多处引用时，按 角色卡 → 附加 → 人设 → 聊天 → 全局 取靠前那一处。';
    const CAT_DOT_NOTE = '名字后面的小圆点＝这本书在别处还被引用（不一定是全局）。';

    function nameKey(s) {
        return String(s || '').trim().toLowerCase();
    }

    function catSel() {
        if (!(state.catSel instanceof Set)) state.catSel = new Set();
        return state.catSel;
    }

    /* 全量绑定集合：角色卡/附加/人设尽量全取（人设遍历所有 persona，角色卡靠逐张扫描），
       聊天靠"扫描全部聊天"补全，当前聊天的绑定无条件算上。 */
    function bindSources() {
        const ctx = stCtx();
        /* characters 数组是浅拷贝（shallow:true，data 里只有 name/tags/extensions.fav），
           读不到 extensions.world，所以角色卡主书只能靠扫描结果；当前这张卡顺手补一次。 */
        const chars = new Set((Array.isArray(store.catCharBooks) ? store.catCharBooks : []).map(nameKey));
        if (ctx && Array.isArray(ctx.characters)) {
            const cur = ctx.characters[ctx.characterId];
            const w = cur && cur.data && cur.data.extensions ? cur.data.extensions.world : '';
            if (w) chars.add(nameKey(w));
        }
        const extras = new Set();
        const wi = charLoreCache.data;
        if (wi && Array.isArray(wi.charLore)) {
            wi.charLore.forEach((item) => {
                if (item && Array.isArray(item.extraBooks)) {
                    item.extraBooks.forEach((b) => { if (b) extras.add(nameKey(b)); });
                }
            });
        }
        const personas = new Set();
        const pu = ctx && ctx.powerUserSettings;
        if (pu) {
            if (pu.persona_description_lorebook) personas.add(nameKey(pu.persona_description_lorebook));
            const map = pu.persona_descriptions;
            if (map && typeof map === 'object') {
                Object.keys(map).forEach((k) => {
                    const item = map[k];
                    if (item && item.lorebook) personas.add(nameKey(item.lorebook));
                });
            }
        }
        const chats = new Set((Array.isArray(store.catChatBooks) ? store.catChatBooks : []).map(nameKey));
        const cur = ctx && ctx.chatMetadata ? ctx.chatMetadata.world_info : '';
        [].concat(cur || []).forEach((b) => { if (b) chats.add(nameKey(b)); });
        const globals = new Set();
        document.querySelectorAll('#world_info option').forEach((opt) => {
            if (opt.selected && String(opt.value || '') !== '') globals.add(nameKey(opt.textContent));
        });
        return { chars, extras, personas, chats, globals };
    }

    function categoryData() {
        const sel = editorSelect();
        if (!sel) return null;
        const src = bindSources();
        const buckets = {};
        CAT_GROUPS.forEach((g) => { buckets[g.key] = []; });
        const unbound = [];
        let total = 0;
        for (const opt of sel.options) {
            const value = String(opt.value || '');
            const name = String(opt.textContent || '').trim();
            if (value === '' || !name) continue;
            total += 1;
            const key = nameKey(name);
            const hits = [];
            if (src.chars.has(key)) hits.push('character');
            if (src.extras.has(key)) hits.push('extra');
            if (src.personas.has(key)) hits.push('persona');
            if (src.chats.has(key)) hits.push('chat');
            if (src.globals.has(key)) hits.push('global');
            if (!hits.length) { unbound.push({ name, value }); continue; }
            buckets[hits[0]].push({ name, value, extra: hits.length - 1 });
        }
        /* 五个小组一律显示（空的也显示 0）：master 要能一眼看出"这一类现在没有书"，
           而不是以为分组坏了 */
        const bound = CAT_GROUPS.map((g) => ({ key: g.key, title: g.title, books: buckets[g.key] }));
        return {
            total,
            bound,
            boundCount: CAT_GROUPS.reduce((n, g) => n + buckets[g.key].length, 0),
            unbound,
        };
    }

    function catBookRow(book, opts) {
        const option = opts || {};
        const row = el('div', 'wbm-picker-row' + (book.value === option.current ? ' active' : ''));
        row.dataset.role = 'picker-row';
        row.dataset.value = book.value;
        row.dataset.name = book.name;
        row.appendChild(el('span', 'wbm-picker-name', book.name));
        if (book.extra > 0) {
            const dot = el('span', 'wbm-cat-dot');
            dot.title = '这本书还在别处被引用';
            row.appendChild(dot);
        }
        if (option.checkbox) {
            const box = el('input', 'wbm-cat-check');
            box.type = 'checkbox';
            box.checked = !!option.checked;
            box.dataset.role = 'cat-check';
            box.dataset.name = book.name;
            /* 勾选框外面套一层 label：命中区从 18px 放大到 44px，手机上也能点中 */
            const pick = el('label', 'wbm-cat-pick');
            pick.appendChild(box);
            row.appendChild(pick);
        } else {
            row.appendChild(el('span', 'wbm-picker-radio'));
        }
        return row;
    }

    function catSectHead(title, count) {
        const head = el('div', 'wbm-cat-sect-head');
        head.appendChild(el('b', 'wbm-cat-sect-title', title));
        head.appendChild(el('span', 'wbm-picker-group-count', String(count)));
        return head;
    }

    function catScanBar() {
        const bar = el('div', 'wbm-cat-scanbar');
        if (state.catScanning) {
            bar.appendChild(el('span', 'wbm-cat-scanstate', '正在扫描全部聊天…… 数据多时要等一会儿，先别关窗'));
            return bar;
        }
        if (store.catChatAt) {
            const at = new Date(Number(store.catChatAt));
            const pad = (n) => (n < 10 ? '0' + n : String(n));
            bar.appendChild(el('span', 'wbm-cat-scanstate',
                '已扫描 ' + Number(store.catChatCount) + ' 个聊天，找到 ' + store.catChatBooks.length + ' 本 · '
                + (at.getMonth() + 1) + '-' + pad(at.getDate()) + ' ' + pad(at.getHours()) + ':' + pad(at.getMinutes())));
        } else {
            bar.appendChild(el('span', 'wbm-cat-scanstate', '聊天绑定要扫过全部聊天才知道，点右边按钮开始'));
        }
        const btn = el('button', 'menu_button wbm-chip wbm-chip-sm', store.catChatAt ? '重新扫描' : '扫描全部聊天');
        btn.type = 'button';
        btn.dataset.role = 'cat-scan';
        bar.appendChild(btn);
        return bar;
    }

    function catCharScanBar() {
        const bar = el('div', 'wbm-cat-scanbar');
        if (state.catCharScanning) {
            bar.appendChild(el('span', 'wbm-cat-scanstate',
                '正在读取角色卡绑定 ' + state.catCharDone + ' / ' + state.catCharTotal + '，可以先看别的组'));
            return bar;
        }
        if (store.catCharAt) {
            const at = new Date(Number(store.catCharAt));
            const pad = (n) => (n < 10 ? '0' + n : String(n));
            bar.appendChild(el('span', 'wbm-cat-scanstate',
                '已读 ' + Number(store.catCharCount) + ' 张卡，找到 ' + store.catCharBooks.length + ' 本绑定 · '
                + (at.getMonth() + 1) + '-' + pad(at.getDate()) + ' ' + pad(at.getHours()) + ':' + pad(at.getMinutes())));
        } else {
            bar.appendChild(el('span', 'wbm-cat-scanstate',
                '酒馆给的卡表是浅数据（只有名字和标签），角色卡绑了哪本书必须逐张打开才知道'));
        }
        const btn = el('button', 'menu_button wbm-chip wbm-chip-sm', store.catCharAt ? '重新读取' : '读取全部角色卡');
        btn.type = 'button';
        btn.dataset.role = 'cat-scan-char';
        bar.appendChild(btn);
        return bar;
    }

    function catDeleteBar(books) {
        const n = catSel().size;
        const confirming = !!state.catConfirm;
        const bar = el('div', 'wbm-cat-delbar');
        bar.appendChild(el('span', 'wbm-cat-del-label', confirming
            ? '确认删除这 ' + n + ' 本？删的是磁盘文件，不可撤销'
            : '已选 ' + n + ' 本'));
        const all = el('button', 'menu_button wbm-chip wbm-chip-sm', '全选 ' + books.length + ' 本');
        all.type = 'button';
        all.dataset.role = 'cat-check-all';
        bar.appendChild(all);
        const clear = el('button', 'menu_button wbm-chip wbm-chip-sm', '清空');
        clear.type = 'button';
        clear.dataset.role = 'cat-check-clear';
        bar.appendChild(clear);
        const cancel = el('button', 'menu_button wbm-chip wbm-chip-sm', '取消');
        cancel.type = 'button';
        cancel.dataset.role = 'cat-del-cancel';
        cancel.hidden = !confirming;
        bar.appendChild(cancel);
        const go = el('button', 'menu_button wbm-chip wbm-chip-sm redWarningBG',
            confirming ? '删除 ' + n + ' 本' : '删除所选');
        go.type = 'button';
        go.dataset.role = 'cat-del-go';
        go.disabled = n === 0;
        bar.appendChild(go);
        return bar;
    }

    function catGroup(group, current, isUnbound) {
        const wrap = el('div', 'wbm-cat-group');
        const open = state.catOpen === group.key;
        const head = el('div', 'wbm-cat-group-head' + (open ? ' open' : ''));
        head.dataset.role = 'cat-group';
        head.dataset.key = group.key;
        head.appendChild(el('span', 'wbm-cat-caret', open ? '▾' : '▸'));
        head.appendChild(el('span', 'wbm-cat-group-title', group.title));
        head.appendChild(el('span', 'wbm-picker-group-count', String(group.books.length)));
        const cross = group.books.filter((b) => b && b.extra > 0).length;
        if (cross > 0) head.appendChild(el('span', 'wbm-cat-cross', cross + ' 本另有绑定'));
        if (group.key === 'chat' && !store.catChatAt) {
            head.appendChild(el('span', 'wbm-cat-scanhint', '未扫描 · 点这里'));
        }
        if (group.key === 'character') {
            if (state.catCharScanning) {
                head.appendChild(el('span', 'wbm-cat-scanhint',
                    '读取中 ' + state.catCharDone + ' / ' + state.catCharTotal));
            } else if (!store.catCharAt) {
                head.appendChild(el('span', 'wbm-cat-scanhint', '未扫描 · 点这里'));
            }
        }
        wrap.appendChild(head);
        if (!open) return wrap;

        if (group.key === 'chat') wrap.appendChild(catScanBar());
        if (group.key === 'character') wrap.appendChild(catCharScanBar());

        const list = el('div', 'wbm-cat-books');
        const picked = catSel();
        group.books.forEach((b) => list.appendChild(catBookRow(b, {
            current,
            checkbox: !!isUnbound,
            checked: isUnbound && picked.has(b.name),
        })));
        if (!group.books.length) {
            list.appendChild(el('div', 'wbm-none', isUnbound ? '没有未绑定的世界书' : '这一组现在是 0 本'));
        }
        wrap.appendChild(list);
        if (isUnbound) wrap.appendChild(catDeleteBar(group.books));
        return wrap;
    }

    /* 搜索：①书名（本地过滤 options，零请求）②条目标题（要读书，先建索引再过滤）。
       两种模式搜完都还是按两段五组展示，组标题上的数字就是命中数。 */
    function catMatch(book) {
        const q = String(state.catQuery || '').trim().toLowerCase();
        if (!q) return true;
        const key = nameKey(book.name);
        if (state.catMode === 'title') {
            const idx = state.titleIndex;
            if (!idx) return false;
            const titles = idx.get(key);
            return !!titles && titles.indexOf(q) >= 0;
        }
        return key.indexOf(q) >= 0;
    }

    /* 条目标题索引：把所有书的 entries[*].comment 拼成一条小写长串，按书缓存。
       978 本要逐本 loadWorldInfo 一次，做成分批+进度，只在第一次切到"条目标题"时跑。 */
    async function buildTitleIndex() {
        if (state.titleIndexBuilding || state.titleIndex) return;
        state.titleIndexBuilding = true;
        state.titleDone = 0;
        state.titleTotal = 0;
        renderCategoryPanel();
        try {
            const mod = await import('/scripts/world-info.js');
            const sel = editorSelect();
            const names = [];
            if (sel) {
                for (const opt of sel.options) {
                    const name = String(opt.textContent || '').trim();
                    if (String(opt.value || '') !== '' && name) names.push(name);
                }
            }
            state.titleTotal = names.length;
            renderCategoryPanel();
            const index = new Map();
            let cursor = 0;
            const worker = async () => {
                while (cursor < names.length) {
                    const name = names[cursor++];
                    try {
                        const data = await mod.loadWorldInfo(name);
                        const entries = data && data.entries ? data.entries : {};
                        const parts = [];
                        Object.keys(entries).forEach((uid) => {
                            const title = entries[uid] && entries[uid].comment;
                            if (title) parts.push(String(title));
                        });
                        index.set(nameKey(name), parts.join('\n').toLowerCase());
                    } catch (err) {
                        /* 单本读失败就跳过 */
                    }
                    state.titleDone += 1;
                    if (state.titleDone % 40 === 0) renderCategoryPanel();
                }
            };
            const conc = Math.max(1, Math.min(6, names.length));
            await Promise.all(Array.from({ length: conc }, () => worker()));
            state.titleIndex = index;
        } catch (err) {
            console.warn('[wbm] 建立条目标题索引失败', err);
            toast('error', '读取条目失败：' + (err && err.message ? err.message : err));
        } finally {
            state.titleIndexBuilding = false;
            renderCategoryPanel();
        }
    }

    function renderCategoryPanel() {
        const mask = state.picker;
        if (!mask || !mask.isConnected) return;
        const body = mask.querySelector('.wbm-cat-body');
        if (!body) return;
        const data = categoryData();
        if (!data) return;
        const sel = editorSelect();
        const current = sel ? String(sel.value || '') : '';
        body.textContent = '';

        const searching = !!String(state.catQuery || '').trim();
        const boundFiltered = data.bound.map((g) => ({
            key: g.key,
            title: g.title,
            books: g.books.filter(catMatch),
        }));
        const boundCount = boundFiltered.reduce((n, g) => n + g.books.length, 0);
        const unboundFiltered = data.unbound.filter(catMatch);

        /* 条目标题模式下还没建好索引：先报进度，别让人以为搜不到 */
        if (searching && state.catMode === 'title' && !state.titleIndex) {
            body.appendChild(el('div', 'wbm-cat-note wbm-cat-warn', state.titleIndexBuilding
                ? '正在读取全部条目的标题 ' + state.titleDone + ' / ' + state.titleTotal + '，读完才会出结果。'
                : '按条目标题搜索要先把所有书的条目读一遍。'));
        }

        const secBound = el('div', 'wbm-cat-sect');
        secBound.appendChild(catSectHead('绑定中', boundCount));
        if (!searching) {
            secBound.appendChild(el('div', 'wbm-cat-note', CAT_NOTE));
            secBound.appendChild(el('div', 'wbm-cat-note', CAT_DOT_NOTE));
        }
        boundFiltered.forEach((g) => secBound.appendChild(catGroup(g, current, false)));
        body.appendChild(secBound);

        const secFree = el('div', 'wbm-cat-sect');
        secFree.appendChild(catSectHead('未绑定', unboundFiltered.length));
        if (!searching) {
            /* 角色卡还没扫过时这里的数字一定偏大，明说一句，别让人以为分类不准 */
            if (!store.catCharAt) {
                secFree.appendChild(el('div', 'wbm-cat-note wbm-cat-warn',
                    state.catCharScanning
                        ? '正在读取角色卡绑定（' + state.catCharDone + ' / ' + state.catCharTotal + '），读完这里的数字才会准。'
                        : '角色卡绑定还没扫描，这里可能混进已绑定到角色卡的书；点「角色卡世界书」扫一次即可。'));
            }
            /* 聊天同理：没扫过就不知道有没有书只被某个聊天绑着 */
            if (!store.catChatAt) {
                secFree.appendChild(el('div', 'wbm-cat-note wbm-cat-warn',
                    '还没做过「聊天世界书」扫描，这里可能混进只被某个聊天绑定的书。'));
            }
        }
        secFree.appendChild(catGroup({ key: 'unbound', title: '未被引用', books: unboundFiltered }, current, true));
        body.appendChild(secFree);


        if (searching && boundCount === 0 && unboundFiltered.length === 0 && (state.catMode !== 'title' || state.titleIndex)) {
            body.appendChild(el('div', 'wbm-none', '没有匹配的世界书'));
        }
    }

    function refreshCatDeleteBar() {
        const bar = document.querySelector('.wbm-cat-delbar');
        if (!bar) return;
        const n = catSel().size;
        const confirming = !!state.catConfirm;
        const label = bar.querySelector('.wbm-cat-del-label');
        if (label) {
            label.textContent = confirming
                ? '确认删除这 ' + n + ' 本？删的是磁盘文件，不可撤销'
                : '已选 ' + n + ' 本';
        }
        const go = bar.querySelector('[data-role="cat-del-go"]');
        if (go) {
            go.textContent = confirming ? '删除 ' + n + ' 本' : '删除所选';
            go.disabled = n === 0;
        }
        const cancel = bar.querySelector('[data-role="cat-del-cancel"]');
        if (cancel) cancel.hidden = !confirming;
    }

    function syncCatChecks() {
        const picked = catSel();
        document.querySelectorAll('.wbm-cat-books [data-role="cat-check"]').forEach((box) => {
            box.checked = picked.has(box.dataset.name);
        });
    }

    /* 读取全部角色卡绑定的世界书：酒馆的 /api/characters/all 给的是浅数据（shallow:true），
       里面没有 extensions.world，只能逐张 POST /api/characters/get 取回完整卡再读。
       实测 40 张并发 8 用 487ms（12ms/张），918 张约 11 秒；结果进缓存，之后打开秒出。 */
    async function scanCharacterWorlds(force) {
        if (state.catCharScanning) return;
        if (!force && store.catCharAt) return;
        state.catCharScanning = true;
        state.catCharDone = 0;
        state.catCharTotal = 0;
        renderCategoryPanel();
        try {
            const ctx = stCtx();
            const headers = await ctx.getRequestHeaders();
            const hdr = Object.assign({ 'Content-Type': 'application/json' }, headers || {});
            const listRes = await fetch('/api/characters/all', {
                method: 'POST',
                headers: hdr,
                body: JSON.stringify({}),
            });
            if (!listRes.ok) throw new Error('HTTP ' + listRes.status);
            const cards = await listRes.json();
            const list = (Array.isArray(cards) ? cards : []).filter((c) => c && c.avatar);
            state.catCharTotal = list.length;
            renderCategoryPanel();

            const books = new Set();
            let cursor = 0;
            const worker = async () => {
                while (cursor < list.length) {
                    const card = list[cursor++];
                    try {
                        const res = await fetch('/api/characters/get', {
                            method: 'POST',
                            headers: hdr,
                            body: JSON.stringify({ avatar_url: card.avatar }),
                        });
                        if (res.ok) {
                            const j = await res.json();
                            const w = j && j.data && j.data.extensions ? j.data.extensions.world : '';
                            if (w) books.add(nameKey(w));
                        }
                    } catch (err) {
                        /* 单张读失败就跳过，不打断整轮 */
                    }
                    state.catCharDone += 1;
                    if (state.catCharDone % 60 === 0) renderCategoryPanel();
                }
            };
            const conc = Math.max(1, Math.min(8, list.length));
            await Promise.all(Array.from({ length: conc }, () => worker()));

            store.catCharBooks = Array.from(books);
            store.catCharAt = Date.now();
            store.catCharCount = list.length;
            persistStore();
            toast('info', '角色卡读取完成：' + list.length + ' 张卡，' + books.size + ' 本被角色卡绑定');
        } catch (err) {
            console.warn('[wbm] 读取角色卡绑定失败', err);
            toast('error', '读取角色卡失败：' + (err && err.message ? err.message : err));
        } finally {
            state.catCharScanning = false;
            renderCategoryPanel();
        }
    }

    /* 扫描全部聊天：一次 POST /api/chats/recent {metadata:true} 拿到每个聊天的 chat_metadata，
       服务端只回元数据与最后一条消息，不回全部消息。结果落进 extension_settings 缓存。 */
    async function scanAllChats() {
        if (state.catScanning) return;
        state.catScanning = true;
        renderCategoryPanel();
        try {
            const ctx = stCtx();
            const headers = await ctx.getRequestHeaders();
            const res = await fetch('/api/chats/recent', {
                method: 'POST',
                headers: Object.assign({ 'Content-Type': 'application/json' }, headers || {}),
                body: JSON.stringify({ max: 100000, metadata: true }),
            });
            if (!res.ok) throw new Error('HTTP ' + res.status);
            const list = await res.json();
            const books = new Set();
            (Array.isArray(list) ? list : []).forEach((c) => {
                const w = c && c.chat_metadata ? c.chat_metadata.world_info : null;
                [].concat(w || []).forEach((b) => { if (b) books.add(nameKey(b)); });
            });
            store.catChatBooks = Array.from(books);
            store.catChatAt = Date.now();
            store.catChatCount = Array.isArray(list) ? list.length : 0;
            persistStore();
            state.catScanning = false;
            state.catOpen = 'chat';
            renderCategoryPanel();
            toast('info', '扫描完成：' + store.catChatCount + ' 个聊天，找到 ' + books.size + ' 本被聊天绑定的世界书');
        } catch (err) {
            state.catScanning = false;
            renderCategoryPanel();
            toast('error', '扫描失败：' + (err && err.message ? err.message : err));
        }
    }

    /* 批量删除：只删勾选的未绑定书，删前二次确认（不给备份，master 定的）。
       走宿主导出的 deleteWorldInfo 而不是自己拼 /api/worldinfo/delete——它还会同步
       world_names、把书从全局启用清单里摘掉、清角色卡与人设的绑定，列表才不会留幽灵项。 */
    /* 兜底删除：直接打 /api/worldinfo/delete。宿主 deleteWorldInfo 前置判断
       world_names.includes(name)，列表没刷新或书刚写进磁盘时会被它直接判 false。 */
    async function deleteWorldInfoFallback(name) {
        try {
            const ctx = stCtx();
            const headers = (ctx && typeof ctx.getRequestHeaders === 'function')
                ? ctx.getRequestHeaders()
                : { 'Content-Type': 'application/json' };
            const res = await fetch('/api/worldinfo/delete', {
                method: 'POST',
                headers,
                body: JSON.stringify({ name: name }),
            });
            if (!res.ok) return false;
            try {
                const mod = await import('/scripts/world-info.js');
                if (mod && typeof mod.updateWorldInfoList === 'function') await mod.updateWorldInfoList();
            } catch (err) { /* 列表刷新失败不影响删除本身 */ }
            return true;
        } catch (err) {
            console.warn('[wbm] 直接删除失败：', name, err);
            return false;
        }
    }

    async function deleteSelectedBooks() {
        const names = Array.from(catSel());
        if (!names.length) return;
        state.catDeleting = true;
        let mod = null;
        try {
            mod = await import('/scripts/world-info.js');
        } catch (err) {
            console.warn('[wbm] 载入 world-info.js 失败，改用直接接口：', err);
        }
        const failed = [];
        for (const name of names) {
            let done = false;
            if (mod && typeof mod.deleteWorldInfo === 'function') {
                try {
                    done = await mod.deleteWorldInfo(name);
                } catch (err) {
                    done = false;
                }
            }
            if (!done) done = await deleteWorldInfoFallback(name);
            if (!done) failed.push(name);
        }
        state.catDeleting = false;
        catSel().clear();
        state.catConfirm = 0;
        const ok = names.length - failed.length;
        let msg = '删除完成：成功 ' + ok + ' 本';
        if (failed.length) {
            msg += '，失败 ' + failed.length + ' 本（' + failed.slice(0, 2).join('、')
                + (failed.length > 2 ? '…' : '') + '）';
        }
        toast(failed.length ? 'warning' : 'info', msg);
        if (mod && typeof mod.updateWorldInfoList === 'function') {
            try { await mod.updateWorldInfoList(); } catch (err) { /* 忽略 */ }
        }
        renderCategoryPanel();
    }

    /* ---------------- 全局启用预设：一键把「启用了哪几本全局世界书」整套换掉 ---------------- */

    /* 预设只存"书名清单"，不存下标：book 的下标会随增删书变化，存书名才经得起改动。
       切换走宿主自己的路径——把 #world_info 的 option 选好再 trigger('change')，
       酒馆会重算 selected_world_info、存设置、通知生成端刷新，我们不碰它的内部变量。 */
    function normalizePresets(raw) {
        const out = [];
        (Array.isArray(raw) ? raw : []).forEach((item, i) => {
            if (!item || typeof item !== 'object') return;
            const name = String(item.name || '').trim().slice(0, 40);
            if (!name) return;
            const books = [];
            (Array.isArray(item.books) ? item.books : []).forEach((b) => {
                const n = String(b || '').trim();
                if (n && books.indexOf(n) === -1) books.push(n);
            });
            out.push({ id: String(item.id || ('p' + i + '-' + Date.now())), name: name, books: books, groupId: String(item.groupId || '') });
        });
        return out;
    }

    function presetSameBooks(a, b) {
        if (a.length !== b.length) return false;
        const x = a.slice().sort().join('\n');
        const y = b.slice().sort().join('\n');
        return x === y;
    }

    function presetForBooks(books) {
        for (const preset of store.presets) {
            if (presetSameBooks(preset.books, books)) return preset;
        }
        return null;
    }

    function presetById(id) {
        return store.presets.find((p) => p.id === id) || null;
    }

    function nextPresetName() {
        const used = new Set(store.presets.map((p) => p.name));
        let n = 1;
        while (used.has('预设' + n)) n += 1;
        return '预设' + n;
    }

    function currentGlobalBooks() {
        const out = [];
        allBooks().forEach((b) => { if (b.on) out.push(b.name); });
        return out;
    }

    /* 把全局启用清单整体换成 books；返回 { applied, missing }（missing＝预设里有、书库里没有的书名） */
    function applyGlobalBooks(books) {
        const sel = document.getElementById('world_info');
        if (!sel) return { applied: 0, missing: (books || []).slice() };
        const want = new Set(books || []);
        const present = new Set();
        Array.from(sel.options).forEach((opt) => {
            const name = String(opt.textContent || '').trim();
            const on = !!name && want.has(name);
            opt.selected = on;
            if (on) present.add(name);
        });
        /* 必须发**原生** change：宿主的 select2 药丸刷新与保存逻辑都挂在元素的 change 上，
           实测 jQuery 的 trigger('change') 在这套环境里传不到它们（药丸不动、清单也不落盘）。 */
        sel.dispatchEvent(new Event('change', { bubbles: true }));
        return { applied: present.size, missing: (books || []).filter((n) => !present.has(n)) };
    }

    /* 宿主的全局启用清单被改（自己勾选、换书、别处套用）时，把按钮上的"当前是哪套"跟着改回来。
       自己套用预设也会走这次 change，refreshPresetBar 幂等，重复调用无害。 */
    function hookGlobalPresetRefresh() {
        const sel = document.getElementById('world_info');
        if (!sel || sel.__wbmPresetHook) return;
        sel.__wbmPresetHook = true;
        sel.addEventListener('change', () => {
            const books = currentGlobalBooks();
            /* 套用预设之后清单会命中某套预设，这时不动「自定义」 */
            if (!presetForBooks(books)) rememberCustomBooks(books);
            refreshPresetBar();
        });
    }

    function persistPresets() {
        persistStore();
        refreshPresetBar();
    }

    /* 用当前全局清单存一套新预设；同名的直接覆盖（省掉"先删后建"） */
    function presetSaveCurrent(rawName) {
        const books = currentGlobalBooks();
        const name = String(rawName || '').trim().slice(0, 40) || nextPresetName();
        const existing = store.presets.find((p) => p.name === name);
        if (existing) {
            existing.books = books;
            persistPresets();
            toast('info', '已覆盖「' + name + '」：启用 ' + books.length + ' 本');
            renderCategoryPanel();
            return existing;
        }
        const preset = { id: 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), name: name, books: books };
        store.presets.push(preset);
        persistPresets();
        toast('info', '已存为「' + name + '」：启用 ' + books.length + ' 本');
        renderCategoryPanel();
        return preset;
    }

    function presetApply(id) {
        const preset = presetById(id);
        if (!preset) return;
        const result = applyGlobalBooks(preset.books);
        let text = '已套用「' + preset.name + '」：启用 ' + result.applied + ' 本';
        if (result.missing.length) {
            text += '（' + result.missing.length + ' 本已不在书库，跳过：' + result.missing.slice(0, 3).join('、')
                + (result.missing.length > 3 ? '…' : '') + '）';
        }
        toast(result.missing.length ? 'warning' : 'info', text);
        refreshPresetBar();
        renderCategoryPanel();
    }

    function presetOverwrite(id) {
        const preset = presetById(id);
        if (!preset) return;
        preset.books = currentGlobalBooks();
        persistPresets();
        toast('info', '已用当前清单覆盖「' + preset.name + '」：启用 ' + preset.books.length + ' 本');
        renderCategoryPanel();
    }

    function presetRename(id, rawName) {
        const preset = presetById(id);
        if (!preset) return false;
        const name = String(rawName || '').trim().slice(0, 40);
        if (!name) { toast('error', '名字不能为空'); return false; }
        if (name === preset.name) return true;
        if (store.presets.some((p) => p !== preset && p.name === name)) {
            toast('error', '已经有叫「' + name + '」的预设了');
            return false;
        }
        preset.name = name;
        persistPresets();
        renderCategoryPanel();
        return true;
    }

    function presetRemove(id) {
        const preset = presetById(id);
        if (!preset) return;
        store.presets = store.presets.filter((p) => p.id !== id);
        persistPresets();
        toast('info', '已删除预设「' + preset.name + '」（不影响当前启用的书）');
        renderCategoryPanel();
    }

    /* 世界书面板里的那一行：全局世界书预设 [当前：xxx ▾] [存为预设]（+ 输入名字的小行） */
    function refreshPresetBar() {
        const row = document.querySelector('.wbm-preset-row');
        if (!row) return;
        const btnText = row.querySelector('.wbm-preset-btn-text');
        if (!btnText) return;
        const books = currentGlobalBooks();
        const active = presetForBooks(books);
        /* 第一次装配时，若当前清单本来就不属于任何预设，就把它当作「自定义」那套记下来 */
        if (!store.customBooks.length && books.length && !active) rememberCustomBooks(books);
        btnText.textContent = active ? active.name : '自定义';
        row.classList.toggle('wbm-preset-dirty', !active);
        const saveRow = row.querySelector('.wbm-preset-saverow');
        if (saveRow) saveRow.hidden = !state.presetSaving;
        const input = row.querySelector('[data-role="preset-name"]');
        if (input && state.presetSaving && !input.dataset.ready) {
            input.placeholder = nextPresetName();
            input.dataset.ready = '1';
        }
    }

    function ensurePresetBar() {
        if (!enhancementsOn()) return;
        const host = document.getElementById('WIMultiSelector');
        if (!host) return;
        if (host.querySelector('.wbm-preset-row')) { refreshPresetBar(); return; }

        const row = el('div', 'wbm-preset-row');
        row.dataset.role = 'preset-row';
        row.appendChild(el('span', 'wbm-favbar-label', '全局世界书预设'));
        /* 这里不放进原生 <select>：系统选择器给选项文字换不了字体、也摆不到右侧，
           改成"看起来像下拉"的按钮，点开是我们自己的浮层列表。 */
        const pickBtn = el('button', 'menu_button wbm-preset-btn');
        pickBtn.type = 'button';
        pickBtn.dataset.role = 'preset-open';
        pickBtn.title = '选一套预设，把它存的那几本全局世界书整套启用';
        pickBtn.appendChild(el('span', 'wbm-preset-btn-text', '自定义（未套用预设）'));
        pickBtn.appendChild(el('span', 'wbm-preset-caret'));
        row.appendChild(pickBtn);
        const saveBtn = el('button', 'menu_button wbm-chip wbm-preset-save', '存为预设');
        saveBtn.type = 'button';
        saveBtn.dataset.role = 'preset-save';
        saveBtn.title = '把当前启用的这几本存成一套预设';
        row.appendChild(saveBtn);

        /* 存名字的小行：空着不填就用"预设N" */
        const saveRow = el('div', 'wbm-preset-saverow');
        saveRow.hidden = true;
        const nameInput = document.createElement('input');
        nameInput.className = 'text_pole wbm-preset-name';
        nameInput.type = 'text';
        nameInput.dataset.role = 'preset-name';
        nameInput.maxLength = 40;
        saveRow.appendChild(nameInput);
        const okBtn = el('button', 'menu_button wbm-chip wbm-chip-sm', '保存');
        okBtn.type = 'button';
        okBtn.dataset.role = 'preset-save-ok';
        saveRow.appendChild(okBtn);
        const cancelBtn = el('button', 'menu_button wbm-chip wbm-chip-sm', '取消');
        cancelBtn.type = 'button';
        cancelBtn.dataset.role = 'preset-save-cancel';
        saveRow.appendChild(cancelBtn);
        row.appendChild(saveRow);

        row.addEventListener('click', (event) => {
            const target = event.target;
            if (!(target instanceof Element)) return;
            const roleEl = target.closest('[data-role]');
            if (!roleEl || !row.contains(roleEl)) return;
            const role = roleEl.dataset.role;
            if (role === 'preset-open') {
                event.preventDefault();
                event.stopPropagation();
                openPresetPicker();
                return;
            }
            if (role === 'preset-save') {
                event.preventDefault();
                event.stopPropagation();
                state.presetSaving = true;
                refreshPresetBar();
                const input = row.querySelector('[data-role="preset-name"]');
                if (input) {
                    input.placeholder = nextPresetName();
                    input.value = '';
                    input.focus();
                }
                return;
            }
            if (role === 'preset-save-ok') {
                event.preventDefault();
                event.stopPropagation();
                const input = row.querySelector('[data-role="preset-name"]');
                state.presetSaving = false;
                presetSaveCurrent(input ? input.value : '');
                refreshPresetBar();
                return;
            }
            if (role === 'preset-save-cancel') {
                event.preventDefault();
                event.stopPropagation();
                state.presetSaving = false;
                refreshPresetBar();
            }
        });

        saveRow.addEventListener('keydown', (event) => {
            if (event.key !== 'Enter') return;
            const input = row.querySelector('[data-role="preset-name"]');
            state.presetSaving = false;
            presetSaveCurrent(input ? input.value : '');
            refreshPresetBar();
        });

        const rangeBlock = host.querySelector('.range-block-range');
        if (rangeBlock && rangeBlock.parentNode === host) host.insertBefore(row, rangeBlock.nextSibling);
        else host.appendChild(row);
        refreshPresetBar();
    }

    /* 「自定义」＝上一次手勾的那套。当前清单既不是任何预设、又和它不同时，就把它更新成当前清单。
       这样"切到预设 → 再点自定义"能回到手勾的那几本，而不是点了没反应。 */
    function rememberCustomBooks(books) {
        if (!Array.isArray(books) || presetSameBooks(store.customBooks, books)) return;
        store.customBooks = books.slice();
        persistStore();
    }

    function applyCustomBooks() {
        const books = Array.isArray(store.customBooks) ? store.customBooks : [];
        /* 空的一套照样能套用：那就等于不启用任何全局世界书 */
        const result = applyGlobalBooks(books);
        let text = books.length
            ? '已套用「自定义」：启用 ' + result.applied + ' 本'
            : '已套用「自定义」（空）：全局世界书全部停用';
        if (result.missing.length) text += '（' + result.missing.length + ' 本已不在书库，跳过）';
        toast(result.missing.length ? 'warning' : 'info', text);
        refreshPresetBar();
        renderCategoryPanel();
    }

    /* 预设浮层：名字在左、本数在最右（小一号等宽字），当前那套高亮 */
    /* 预设浮层：名字在左、本数在最右（小一号等宽字），当前那套高亮。
       每套预设右侧给「分组」和「删除」两个键——分组、改名组这些操作都在这一层做，
       分类面板那边不再管预设的分组。 */
    function openPresetPicker() {
        try {
            /* 关窗就作废上一次的「确认覆盖 / 确认删除」：否则关掉再打开还是确认态，
               读者以为点一下就覆盖，其实那一下才是真正的覆盖 */
            state.presetOverArm = null;
            state.presetDelArm = null;
            closeEditorPicker(true);
            const { mask, sheet } = makePickerShell();
            state.picker = mask;
            sheet.appendChild(el('div', 'wbm-picker-grip'));
            const titleRow = el('div', 'wbm-picker-titlerow');
            titleRow.appendChild(el('div', 'wbm-picker-title', '全局世界书预设'));
            const manageBtn = el('button', 'wbm-preset-tool', '管理分组');
            manageBtn.type = 'button';
            manageBtn.dataset.role = 'preset-manage-groups';
            manageBtn.title = '新建分组、给分组改名或删除';
            titleRow.appendChild(manageBtn);
            sheet.appendChild(titleRow);
            const list = el('div', 'wbm-picker-list');
            const books = currentGlobalBooks();
            const active = presetForBooks(books);
            const customBooks = Array.isArray(store.customBooks) ? store.customBooks : [];

            const mkTool = (label, role, id, extra) => {
                const btn = el('button', 'wbm-preset-tool' + (extra || ''), label);
                btn.type = 'button';
                btn.dataset.role = role;
                btn.dataset.id = id;
                return btn;
            };
            const mkRow = (id, name, count, isActive) => {
                const row = el('div', 'wbm-picker-row wbm-preset-opt' + (isActive ? ' active' : ''));
                row.dataset.role = 'preset-pick';
                row.dataset.id = id || '';
                row.appendChild(el('span', 'wbm-picker-name', String(name).trim()));
                /* 四个小键包成一格：电脑端照旧排在名字右边、本数顶到最右；
                   手机端由 CSS 把这一整格挪到第二行靠右，名字在第一行用满宽度 */
                if (id && id !== 'custom') {
                    const tools = el('div', 'wbm-preset-tools');
                    tools.appendChild(mkTool('分组', 'preset-move', id));
                    tools.appendChild(mkTool('改名', 'preset-rename-inline', id));
                    const over = state.presetOverArm === id;
                    tools.appendChild(mkTool(over ? '确认覆盖' : '覆盖', 'preset-over-inline', id, over ? ' armed' : ''));
                    const armed = state.presetDelArm === id;
                    tools.appendChild(mkTool(armed ? '确认' : '删除', 'preset-del-inline', id, armed ? ' armed' : ''));
                    row.appendChild(tools);
                }
                row.appendChild(el('span', 'wbm-picker-count', count + ' 本'));
                row.appendChild(el('span', 'wbm-picker-radio'));
                return row;
            };
            const mkLabel = (text) => el('div', 'wbm-picker-group-label', text);

            list.appendChild(mkRow('custom', '自定义', customBooks.length, !active));
            if (!store.presets.length) {
                list.appendChild(el('div', 'wbm-none', '还没有预设：关掉窗口，点右边「存为预设」存一套。'));
            }
            const ungrouped = store.presets.filter((preset) => !preset.groupId);
            if (ungrouped.length) {
                list.appendChild(mkLabel('未分组'));
                ungrouped.forEach((preset) => {
                    list.appendChild(mkRow(preset.id, preset.name, preset.books.length, !!(active && active.id === preset.id)));
                });
            }
            store.presetGroups.forEach((group) => {
                const items = store.presets.filter((preset) => preset.groupId === group.id);
                if (!items.length) return;
                list.appendChild(mkLabel(group.name));
                items.forEach((preset) => {
                    list.appendChild(mkRow(preset.id, preset.name, preset.books.length, !!(active && active.id === preset.id)));
                });
            });
            sheet.appendChild(list);
            /* 一行做就地编辑：改完只重画这一行，浮层本身不动。
               原因：分组、改名很少只做一次，关掉再开会丢掉位置（master 2026-10-22 的要求）。 */
            const rerenderRow = (row, id) => {
                const preset = presetById(id);
                if (!preset) { row.remove(); return; }
                const fresh = mkRow(preset.id, preset.name, preset.books.length, !!(active && active.id === preset.id));
                row.replaceWith(fresh);
            };
            const startPresetRenameInline = (row, id) => {
                const preset = presetById(id);
                if (!preset || !row) return;
                row.dataset.role = 'preset-edit';
                row.innerHTML = '';
                const field = el('input', 'wbm-name-input-inline');
                field.type = 'text';
                field.maxLength = 40;
                field.value = preset.name;
                const ok = el('button', 'wbm-picker-action primary', '确定');
                const cancel = el('button', 'wbm-picker-action', '取消');
                ok.type = 'button';
                cancel.type = 'button';
                const submit = () => {
                    if (presetRename(id, field.value)) rerenderRow(row, id);
                    else { field.focus(); field.select(); }
                };
                ok.addEventListener('click', (ev) => { ev.preventDefault(); ev.stopPropagation(); submit(); });
                cancel.addEventListener('click', (ev) => { ev.preventDefault(); ev.stopPropagation(); rerenderRow(row, id); });
                field.addEventListener('keydown', (ev) => {
                    if (ev.key === 'Enter') { ev.preventDefault(); submit(); }
                    if (ev.key === 'Escape') { ev.preventDefault(); rerenderRow(row, id); }
                });
                row.appendChild(el('span', 'wbm-picker-name', '改名 →'));
                row.appendChild(field);
                row.appendChild(ok);
                row.appendChild(cancel);
                setTimeout(() => { field.focus(); field.select(); }, 20);
            };
            const startPresetGroupInline = (row, id) => {
                const preset = presetById(id);
                if (!preset || !row) return;
                row.dataset.role = 'preset-edit';
                row.innerHTML = '';
                const chips = el('div', 'wbm-inline-groups');
                const chip = (gid, text, on) => {
                    const b = el('button', 'wbm-picker-action' + (on ? ' primary' : ''), text);
                    b.type = 'button';
                    b.addEventListener('click', (ev) => {
                        ev.preventDefault();
                        ev.stopPropagation();
                        if (gid === '__new') { askNewGroup(); return; }
                        movePresetToGroup(id, gid);
                        rerenderRow(row, id);
                    });
                    chips.appendChild(b);
                };
                const askNewGroup = () => {
                    chips.textContent = '';
                    const field = el('input', 'wbm-name-input-inline');
                    field.type = 'text';
                    field.maxLength = 30;
                    field.placeholder = '新分组名';
                    const ok = el('button', 'wbm-picker-action primary', '确定');
                    ok.type = 'button';
                    ok.addEventListener('click', (ev) => {
                        ev.preventDefault();
                        ev.stopPropagation();
                        const group = createGroup(field.value);
                        if (!group) { field.focus(); return; }
                        movePresetToGroup(id, group.id);
                        rerenderRow(row, id);
                    });
                    chips.appendChild(field);
                    chips.appendChild(ok);
                    setTimeout(() => field.focus(), 20);
                };
                row.appendChild(el('span', 'wbm-picker-name', preset.name + ' →'));
                chip('', '不分组', !preset.groupId);
                store.presetGroups.forEach((g) => chip(g.id, g.name, preset.groupId === g.id));
                chip('__new', '新建…', false);
                row.appendChild(chips);
            };
            list.addEventListener('click', (event) => {
                const target = event.target;
                if (!(target instanceof Element)) return;
                if (target.closest('[data-role="preset-edit"]')) return;
                const moveBtn = target.closest('[data-role="preset-move"]');
                if (moveBtn) {
                    event.preventDefault();
                    event.stopPropagation();
                    startPresetGroupInline(moveBtn.closest('[data-role="preset-pick"]'), moveBtn.dataset.id);
                    return;
                }
                const renameBtn = target.closest('[data-role="preset-rename-inline"]');
                if (renameBtn) {
                    event.preventDefault();
                    event.stopPropagation();
                    startPresetRenameInline(renameBtn.closest('[data-role="preset-pick"]'), renameBtn.dataset.id);
                    return;
                }
                const overBtn = target.closest('[data-role="preset-over-inline"]');
                if (overBtn) {
                    event.preventDefault();
                    event.stopPropagation();
                    const id = overBtn.dataset.id;
                    if (state.presetOverArm !== id) {
                        state.presetOverArm = id;
                        overBtn.textContent = '确认覆盖';
                        overBtn.classList.add('armed');
                        return;
                    }
                    state.presetOverArm = null;
                    presetOverwrite(id);
                    rerenderRow(overBtn.closest('[data-role="preset-pick"]'), id);
                    return;
                }
                const delBtn = target.closest('[data-role="preset-del-inline"]');
                if (delBtn) {
                    event.preventDefault();
                    event.stopPropagation();
                    const id = delBtn.dataset.id;
                    if (state.presetDelArm !== id) {
                        state.presetDelArm = id;
                        delBtn.textContent = '确认';
                        delBtn.classList.add('armed');
                        return;
                    }
                    state.presetDelArm = null;
                    const delRow = delBtn.closest('[data-role="preset-pick"]');
                    presetRemove(id);
                    if (delRow) delRow.remove();
                    return;
                }
                const row = target.closest('[data-role="preset-pick"]');
                if (!row) return;
                event.preventDefault();
                event.stopPropagation();
                const id = row.dataset.id;
                state.presetOverArm = null;
                state.presetDelArm = null;
                closeEditorPicker();
                if (id === 'custom') applyCustomBooks();
                else if (id) presetApply(id);
            });
            sheet.addEventListener('click', (event) => {
                const target = event.target;
                if (!(target instanceof Element)) return;
                if (!target.closest('[data-role="preset-manage-groups"]')) return;
                event.preventDefault();
                event.stopPropagation();
                closeEditorPicker();
                setTimeout(() => openGroupPicker(null, true), 60);
            });
            mask.addEventListener('click', (event) => {
                if (event.target === mask) closeEditorPicker();
            });
            document.documentElement.appendChild(mask);
        } catch (err) {
            console.warn('[wbm] 打开预设浮层失败', err);
        }
    }

    /* ---- 预设分组：组名由用户自己起，预设可以移到任意一组 ---- */
    function normalizeGroups(raw) {
        const out = [];
        (Array.isArray(raw) ? raw : []).forEach((item, i) => {
            if (!item || typeof item !== 'object') return;
            const name = String(item.name || '').trim().slice(0, 30);
            if (!name) return;
            out.push({ id: String(item.id || ('g' + i + '-' + Date.now())), name: name });
        });
        return out;
    }

    function groupById(gid) {
        return store.presetGroups.find((g) => g.id === gid) || null;
    }

    function groupNameOf(gid) {
        const group = gid ? groupById(gid) : null;
        return group ? group.name : '未分组';
    }

    function createGroup(rawName) {
        const name = String(rawName || '').trim().slice(0, 30);
        if (!name) return null;
        const exist = store.presetGroups.find((g) => g.name === name);
        if (exist) return exist;
        const group = { id: 'g' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5), name: name };
        store.presetGroups.push(group);
        persistStore();
        return group;
    }

    function movePresetToGroup(presetId, gid) {
        const preset = presetById(presetId);
        if (!preset) return;
        preset.groupId = gid || '';
        persistPresets();
        toast('info', '「' + preset.name + '」已移到「' + groupNameOf(preset.groupId) + '」');
        renderCategoryPanel();
    }

    function renameGroup(gid, rawName) {
        const group = groupById(gid);
        if (!group) return false;
        const name = String(rawName || '').trim().slice(0, 30);
        if (!name) { toast('error', '组名不能为空'); return false; }
        if (store.presetGroups.some((g) => g !== group && g.name === name)) {
            toast('error', '已经有叫「' + name + '」的分组了');
            return false;
        }
        group.name = name;
        persistPresets();
        renderCategoryPanel();
        return true;
    }

    function removeGroup(gid) {
        const group = groupById(gid);
        if (!group) return;
        /* 组里还有预设就一起放回未分组，别把预设连带删掉 */
        store.presets.forEach((p) => { if (p.groupId === gid) p.groupId = ''; });
        store.presetGroups = store.presetGroups.filter((g) => g.id !== gid);
        persistPresets();
        toast('info', '已删除分组「' + group.name + '」（组里的预设回到未分组）');
        renderCategoryPanel();
    }

    /* 预设改名小浮层（分类面板里那一块撤掉后，改名/覆盖都收在预设浮层里） */
    function openPresetRename(presetId) {
        const preset = presetById(presetId);
        if (!preset) return;
        try {
            closeEditorPicker(true);
            const { mask, sheet } = makePickerShell();
            state.picker = mask;
            sheet.appendChild(el('div', 'wbm-picker-grip'));
            sheet.appendChild(el('div', 'wbm-picker-title', '重命名预设'));
            const box = el('div', 'wbm-preset-saverow wbm-group-new');
            const input = document.createElement('input');
            input.className = 'text_pole wbm-preset-name';
            input.type = 'text';
            input.maxLength = 40;
            input.value = preset.name;
            input.dataset.role = 'preset-rename-field';
            box.appendChild(input);
            const ok = el('button', 'menu_button wbm-chip wbm-chip-sm', '保存');
            ok.type = 'button';
            ok.dataset.role = 'preset-rename-save';
            box.appendChild(ok);
            const cancel = el('button', 'menu_button wbm-chip wbm-chip-sm', '取消');
            cancel.type = 'button';
            cancel.dataset.role = 'preset-rename-cancel2';
            box.appendChild(cancel);
            sheet.appendChild(box);
            const save = () => {
                if (presetRename(preset.id, input.value)) {
                    closeEditorPicker();
                    toast('info', '已改名为「' + preset.name + '」');
                }
            };
            box.addEventListener('click', (event) => {
                const target = event.target;
                if (!(target instanceof Element)) return;
                if (target.closest('[data-role="preset-rename-save"]')) {
                    event.preventDefault();
                    event.stopPropagation();
                    save();
                    return;
                }
                if (target.closest('[data-role="preset-rename-cancel2"]')) {
                    event.preventDefault();
                    event.stopPropagation();
                    closeEditorPicker();
                }
            });
            box.addEventListener('keydown', (event) => {
                if (event.key === 'Enter') save();
            });
            mask.addEventListener('click', (event) => {
                if (event.target === mask) closeEditorPicker();
            });
            document.documentElement.appendChild(mask);
            input.focus();
            input.select();
        } catch (err) {
            console.warn('[wbm] 打开改名浮层失败', err);
        }
    }

    /* 分组管理浮层：①把某套预设移进某组（不分组 / 各分组 / 新建组）
       ②给分组改名、删分组（删组时组里的预设回到未分组）。
       传 manageOnly=true 时只做分组管理、不移动任何预设（从预设浮层的「分组」键进来）。 */
    function openGroupPicker(presetId, manageOnly) {
        const preset = presetId ? presetById(presetId) : null;
        if (!manageOnly && !preset) return;
        try {
            closeEditorPicker(true);
            const { mask, sheet } = makePickerShell();
            state.picker = mask;
            const closeSelf = () => {
                if (mask.dataset.closing === '1') return;
                mask.dataset.closing = '1';
                mask.classList.add('closing');
                setTimeout(() => mask.remove(), 190);
            };
            sheet.appendChild(el('div', 'wbm-picker-grip'));
            sheet.appendChild(el('div', 'wbm-picker-title', preset ? '「' + preset.name + '」放到哪个分组' : '分组管理'));

            const list = el('div', 'wbm-picker-list');
            const rebuild = () => {
                /* 重建（保存改名、新建/删除分组后）保留滚动位置，别让读者从头再找 */
                state.groupPickerTop = list.scrollTop;
                mask.remove();
                openGroupPicker(presetId, manageOnly);
            };

            if (preset) {
                const mkRow = (gid, name, isActive) => {
                    const row = el('div', 'wbm-picker-row' + (isActive ? ' active' : ''));
                    row.dataset.role = 'group-pick';
                    row.dataset.gid = gid || '';
                    row.appendChild(el('span', 'wbm-picker-name', String(name).trim()));
                    row.appendChild(el('span', 'wbm-picker-radio'));
                    return row;
                };
                list.appendChild(mkRow('', '不分组', !preset.groupId));
                store.presetGroups.forEach((group) => {
                    const count = store.presets.filter((p) => p.groupId === group.id).length;
                    list.appendChild(mkRow(group.id, group.name + '（' + count + ' 套）', preset.groupId === group.id));
                });
            } else if (!store.presetGroups.length) {
                list.appendChild(el('div', 'wbm-none', '还没有分组：在下面起个名字新建一组。'));
            }

            /* 分组管理行：组名 + 改名/删除（分组浮层里才有意义，单独进来时也一样） */
            const mgmt = el('div', 'wbm-group-mgmt');
            store.presetGroups.forEach((group) => {
                const row = el('div', 'wbm-group-mgmt-row');
                row.dataset.gid = group.id;
                const count = store.presets.filter((p) => p.groupId === group.id).length;
                row.appendChild(el('span', 'wbm-group-mgmt-name', group.name + '（' + count + ' 套）'));
                const tools = el('span', 'wbm-group-mgmt-tools');
                const renameBtn = el('button', 'wbm-preset-tool', '改名');
                renameBtn.type = 'button';
                renameBtn.dataset.role = 'group-rename';
                renameBtn.dataset.gid = group.id;
                tools.appendChild(renameBtn);
                const armed = state.groupDelArm === group.id;
                const delBtn = el('button', 'wbm-preset-tool' + (armed ? ' armed' : ''), armed ? '确认' : '删除');
                delBtn.type = 'button';
                delBtn.dataset.role = 'group-del';
                delBtn.dataset.gid = group.id;
                tools.appendChild(delBtn);
                row.appendChild(tools);
                mgmt.appendChild(row);
            });
            if (store.presetGroups.length) sheet.appendChild(list);
            else sheet.appendChild(list);
            sheet.appendChild(mgmt);

            /* 底部：新建分组（组名自己填） */
            const footer = el('div', 'wbm-preset-saverow wbm-group-new');
            const input = document.createElement('input');
            input.className = 'text_pole wbm-preset-name';
            input.type = 'text';
            input.maxLength = 30;
            input.placeholder = '新建分组，起个名字';
            input.dataset.role = 'group-name-input';
            footer.appendChild(input);
            const ok = el('button', 'menu_button wbm-chip wbm-chip-sm', preset ? '新建并移入' : '新建分组');
            ok.type = 'button';
            ok.dataset.role = 'group-create';
            footer.appendChild(ok);
            sheet.appendChild(footer);

            const createAndMaybeMove = () => {
                const group = createGroup(input.value);
                if (!group) { toast('error', '先给分组起个名字'); return; }
                if (preset) {
                    movePresetToGroup(preset.id, group.id);
                    closeSelf();
                } else {
                    toast('info', '已新建分组「' + group.name + '」');
                    rebuild();
                }
            };

            list.addEventListener('click', (event) => {
                const target = event.target;
                if (!(target instanceof Element)) return;
                const row = target.closest('[data-role="group-pick"]');
                if (!row || !preset) return;
                event.preventDefault();
                event.stopPropagation();
                movePresetToGroup(preset.id, row.dataset.gid);
                closeSelf();
            });

            mgmt.addEventListener('click', (event) => {
                const target = event.target;
                if (!(target instanceof Element)) return;
                const renameBtn = target.closest('[data-role="group-rename"]');
                if (renameBtn) {
                    event.preventDefault();
                    event.stopPropagation();
                    const gid = renameBtn.dataset.gid;
                    const groupRow = renameBtn.closest('.wbm-group-mgmt-row');
                    const nameSpan = groupRow.querySelector('.wbm-group-mgmt-name');
                    const tools = groupRow.querySelector('.wbm-group-mgmt-tools');
                    const group = groupById(gid);
                    if (!group || !nameSpan) return;
                    /* 就地变成输入框：改完保存 / 取消 */
                    nameSpan.textContent = '';
                    const nameInput = document.createElement('input');
                    nameInput.className = 'text_pole wbm-name-input-inline';
                    nameInput.type = 'text';
                    nameInput.maxLength = 30;
                    nameInput.value = group.name;
                    nameSpan.appendChild(nameInput);
                    tools.textContent = '';
                    const okBtn = el('button', 'wbm-preset-tool', '保存');
                    okBtn.type = 'button';
                    const cancelBtn = el('button', 'wbm-preset-tool', '取消');
                    cancelBtn.type = 'button';
                    tools.appendChild(okBtn);
                    tools.appendChild(cancelBtn);
                    nameInput.focus();
                    okBtn.addEventListener('click', (ev) => {
                        ev.preventDefault();
                        ev.stopPropagation();
                        if (renameGroup(gid, nameInput.value)) rebuild();
                    });
                    cancelBtn.addEventListener('click', (ev) => {
                        ev.preventDefault();
                        ev.stopPropagation();
                        rebuild();
                    });
                    return;
                }
                const delBtn = target.closest('[data-role="group-del"]');
                if (delBtn) {
                    event.preventDefault();
                    event.stopPropagation();
                    const gid = delBtn.dataset.gid;
                    if (state.groupDelArm !== gid) {
                        state.groupDelArm = gid;
                        delBtn.textContent = '确认';
                        delBtn.classList.add('armed');
                        return;
                    }
                    state.groupDelArm = null;
                    removeGroup(gid);
                    rebuild();
                }
            });

            footer.addEventListener('click', (event) => {
                const target = event.target;
                if (!(target instanceof Element)) return;
                if (!target.closest('[data-role="group-create"]')) return;
                event.preventDefault();
                event.stopPropagation();
                createAndMaybeMove();
            });
            footer.addEventListener('keydown', (event) => {
                if (event.key !== 'Enter') return;
                createAndMaybeMove();
            });
            mask.addEventListener('click', (event) => {
                if (event.target === mask) closeSelf();
            });
            document.documentElement.appendChild(mask);
            if (state.groupPickerTop) list.scrollTop = state.groupPickerTop;
            input.focus();
        } catch (err) {
            console.warn('[wb] 打开分组浮层失败', err);
        }
    }

    function openCategoryPanel() {
        try {
            closeEditorPicker(true);
            const sel = editorSelect();
            if (!sel) return;
            state.catSel = new Set();
            state.catConfirm = 0;
            state.catScanning = false;
            state.catQuery = '';
            if (!state.catMode) state.catMode = 'book';

            const { mask, sheet } = makePickerShell();
            state.picker = mask;

            const grip = el('div', 'wbm-picker-grip');
            const title = el('div', 'wbm-picker-title', '世界书分类');

            /* 搜索条：左边输入框，右边两个模式键（书名 / 条目标题） */
            const searchRow = el('div', 'wbm-cat-search');
            const input = el('input', 'text_pole wbm-cat-input');
            input.type = 'search';
            /* 提示文字必须跟着模式走：切到"条目标题"还写着"搜索书名"，
               会让人以为模式没生效 */
            const catPlaceholder = (mode) => (mode === 'title' ? '搜索条目标题' : '搜索书名');
            input.placeholder = catPlaceholder(state.catMode);
            input.dataset.role = 'cat-query';
            searchRow.appendChild(input);
            const mkMode = (label, mode) => {
                const btn = el('button', 'menu_button wbm-chip wbm-chip-sm' + (state.catMode === mode ? ' on' : ''), label);
                btn.type = 'button';
                btn.dataset.role = 'cat-mode';
                btn.dataset.mode = mode;
                return btn;
            };
            searchRow.appendChild(mkMode('书名', 'book'));
            searchRow.appendChild(mkMode('条目标题', 'title'));

            const body = el('div', 'wbm-picker-list wbm-cat-body');
            sheet.appendChild(grip);
            sheet.appendChild(title);
            sheet.appendChild(searchRow);
            sheet.appendChild(body);

            input.addEventListener('input', () => {
                state.catQuery = input.value;
                renderCategoryPanel();
            });

            const openedAt = Date.now();
            /* 2026-10-20 master 报：确认删除后"回到对话页面、什么都没删"。
               原因是面板会异步重绘（扫描进度、ST 更新书单），按下与抬起落在不同元素上时，
               浏览器把 click 派发到两者最近的共同祖先——也就是这层遮罩 mask，
               于是走了「点遮罩＝关闭」这条分支。记下按下时的目标，抬起落在遮罩时不当成关闭。 */
            /* downRole=false 表示直接按在遮罩上（真的要关窗）；
               字符串（含空串）表示按在面板内部——此时抬起落到遮罩是重绘造成的假点击。
               注意不能记元素本身：面板重绘会把那个按钮从 DOM 里摘掉，contains() 就失效了。 */
            let downRole = false;
            mask.addEventListener('pointerdown', (event) => {
                const t = event.target instanceof Element ? event.target : null;
                if (!t) { downRole = false; return; }
                if (t === mask) { downRole = false; return; }
                const r = t.closest('[data-role]');
                downRole = r ? (r.dataset.role || '') : '';
            }, true);
            mask.addEventListener('click', (event) => {
                if (mask.dataset.closing === '1') return;
                event.stopPropagation();
                if (Date.now() - openedAt < 420) { event.preventDefault(); return; }
                const target = event.target;
                if (!(target instanceof Element)) return;
                if (target === mask) {
                    const pressed = downRole;
                    downRole = false;
                    if (pressed !== false) {
                        /* 按下在面板里、抬起落到遮罩：重绘导致的假点击。
                           如果按下的正是「删除 N 本」，直接当成一次确认，别让人白点一下。 */
                        if (pressed === 'cat-del-go' && catSel().size && state.catConfirm) deleteSelectedBooks();
                        return;
                    }
                    closeEditorPicker();
                    return;
                }
                downRole = false;
                const roleEl = target.closest('[data-role]');
                if (!roleEl) return;
                const role = roleEl.dataset.role;
                if (role === 'picker-close') { closeEditorPicker(); return; }
                if (role === 'cat-check') {
                    const name = roleEl.dataset.name;
                    if (!name) return;
                    if (roleEl.checked) catSel().add(name);
                    else catSel().delete(name);
                    state.catConfirm = 0;
                    refreshCatDeleteBar();
                    return;
                }
                if (role === 'cat-group') {
                    const key = roleEl.dataset.key;
                    state.catOpen = state.catOpen === key ? null : key;
                    renderCategoryPanel();
                    return;
                }
                if (role === 'cat-scan') { event.preventDefault(); scanAllChats(); return; }
                if (role === 'cat-scan-char') { event.preventDefault(); scanCharacterWorlds(true); return; }
                if (role === 'cat-mode') {
                    const mode = roleEl.dataset.mode === 'title' ? 'title' : 'book';
                    if ((state.catMode || 'book') === mode) return;
                    state.catMode = mode;
                    document.querySelectorAll('[data-role="cat-mode"]').forEach((btn) => {
                        btn.classList.toggle('on', btn.dataset.mode === mode);
                    });
                    const catInput = document.querySelector('[data-role="cat-query"]');
                    if (catInput) catInput.placeholder = catPlaceholder(mode);
                    if (mode === 'title') buildTitleIndex();
                    renderCategoryPanel();
                    return;
                }
                if (role === 'cat-check-all') {
                    document.querySelectorAll('.wbm-cat-books [data-role="cat-check"]').forEach((box) => {
                        catSel().add(box.dataset.name);
                    });
                    state.catConfirm = 0;
                    syncCatChecks();
                    refreshCatDeleteBar();
                    return;
                }
                if (role === 'cat-check-clear') {
                    catSel().clear();
                    state.catConfirm = 0;
                    syncCatChecks();
                    refreshCatDeleteBar();
                    return;
                }
                if (role === 'cat-del-go') {
                    if (!catSel().size) return;
                    if (!state.catConfirm) { state.catConfirm = 1; refreshCatDeleteBar(); return; }
                    deleteSelectedBooks();
                    return;
                }
                if (role === 'cat-del-cancel') { state.catConfirm = 0; refreshCatDeleteBar(); return; }
                if (role === 'preset-apply') {
                    event.preventDefault();
                    state.presetRenameId = null;
                    state.presetDelArm = null;
                    if (roleEl.dataset.id === 'custom') applyCustomBooks();
                    else presetApply(roleEl.dataset.id);
                    return;
                }
                if (role === 'preset-overwrite') {
                    event.preventDefault();
                    presetOverwrite(roleEl.dataset.id);
                    return;
                }
                if (role === 'preset-group') {
                    event.preventDefault();
                    state.presetRenameId = null;
                    state.presetDelArm = null;
                    openGroupPicker(roleEl.dataset.id);
                    return;
                }
                if (role === 'preset-group-rename') {
                    event.preventDefault();
                    state.groupRenameId = roleEl.dataset.gid;
                    state.groupDelArm = null;
                    renderCategoryPanel();
                    const gInput = document.querySelector('[data-role="preset-group-rename-input"]');
                    if (gInput) gInput.focus();
                    return;
                }
                if (role === 'preset-group-rename-cancel') {
                    event.preventDefault();
                    state.groupRenameId = null;
                    renderCategoryPanel();
                    return;
                }
                if (role === 'preset-group-rename-ok') {
                    event.preventDefault();
                    const gInput = document.querySelector('[data-role="preset-group-rename-input"]');
                    if (gInput && renameGroup(roleEl.dataset.gid, gInput.value)) state.groupRenameId = null;
                    renderCategoryPanel();
                    return;
                }
                if (role === 'preset-group-del') {
                    event.preventDefault();
                    const gid = roleEl.dataset.gid;
                    if (state.groupDelArm !== gid) {
                        state.groupDelArm = gid;
                        renderCategoryPanel();
                        return;
                    }
                    state.groupDelArm = null;
                    removeGroup(gid);
                    return;
                }
                if (role === 'preset-rename') {
                    event.preventDefault();
                    state.presetRenameId = roleEl.dataset.id;
                    state.presetDelArm = null;
                    renderCategoryPanel();
                    const renameInput = document.querySelector('[data-role="preset-rename-input"]');
                    if (renameInput) renameInput.focus();
                    return;
                }
                if (role === 'preset-rename-cancel') {
                    event.preventDefault();
                    state.presetRenameId = null;
                    renderCategoryPanel();
                    return;
                }
                if (role === 'preset-rename-ok') {
                    event.preventDefault();
                    const renameInput = document.querySelector('[data-role="preset-rename-input"]');
                    if (renameInput && presetRename(roleEl.dataset.id, renameInput.value)) {
                        state.presetRenameId = null;
                    }
                    renderCategoryPanel();
                    return;
                }
                if (role === 'preset-del') {
                    event.preventDefault();
                    const id = roleEl.dataset.id;
                    if (state.presetDelArm !== id) {
                        state.presetDelArm = id;
                        renderCategoryPanel();
                        return;
                    }
                    state.presetDelArm = null;
                    presetRemove(id);
                    return;
                }
                if (role === 'picker-row') {
                    event.preventDefault();
                    /* 已经在勾选状态时，点行只切换勾选；否则手一滑就被带去编辑器，勾好的全丢 */
                    if (catSel().size) {
                        const name = roleEl.dataset.name;
                        if (name) {
                            if (catSel().has(name)) catSel().delete(name);
                            else catSel().add(name);
                            state.catConfirm = 0;
                            syncCatChecks();
                            refreshCatDeleteBar();
                        }
                        return;
                    }
                    const target2 = editorSelect();
                    if (!target2) return;
                    target2.value = roleEl.dataset.value;
                    fireChange(target2);
                    updateEditorButton();
                    closeEditorPicker();
                }
            });

            document.documentElement.appendChild(mask);
            renderCategoryPanel();

            /* 没扫过角色卡就先扫一次：酒馆给的是浅数据，不扫的话"未绑定"必然偏大。
               只在第一次打开时跑，结果进缓存；扫描期间面板照常可用。 */
            if (!store.catCharAt) scanCharacterWorlds(false);

            /* 附加世界书在设置里，第一次打开异步补一次，拿到就重画 */
            if (!charLoreCache.data) {
                ensureCharLore().then((wi) => {
                    if (!wi) return;
                    applyEditorOptgroups();
                    if (!state.picker || !state.picker.isConnected) return;
                    renderCategoryPanel();
                });
            }
        } catch (err) {
            console.error('[wbm] openCategoryPanel failed', err);
        }
    }

    function toggleSearchScope(value) {
        const current = Array.isArray(store.searchScope) ? store.searchScope.slice() : SEARCH_SCOPE_VALUES.slice();
        const at = current.indexOf(value);
        if (at === -1) current.push(value);
        else current.splice(at, 1);
        store.searchScope = normalizeSearchScope(current, SEARCH_SCOPE_VALUES.slice());
        persistStore();
        syncSearchScopeChips();
        /* 先确保宿主那层筛选接管已经装上：否则"搜索框空着时点键、再输入"会完全不生效 */
        ensureFilterPatch().then(() => {
            const input = document.getElementById('world_info_search');
            if (input && String(input.value || '').trim()) {
                refreshFilterView();
                return;
            }
            toast('info', '搜索范围：' + searchScopeSummary() + '（在条目搜索框里输入时生效）');
        });
    }

    let wiFilterPatched = false;

    /* 收藏置顶要覆盖整本书，就不能只摆当前这一页的 DOM 顺序：酒馆的渲染链是
       applyFilters → sortWorldInfoEntries（原地 sort）→ 分页切片。
       所以 applyFilters 返回一个"比较器把收藏项排到最前"的数组子类，
       宿主紧接着那次原地排序就会把收藏项顶到整本书最前面，分页也从第 1 页开始。
       这条管线只有编辑器在用（checkWorldInfo 不调 applyFilters），不影响对话注入顺序。 */
    let pinCtx = null;
    class WbmPinnedList extends Array {
        sort(cmp) {
            const wrapped = (a, b) => {
                const ka = pinCtx && a ? favEntryKey(pinCtx.book, a.uid) : null;
                const kb = pinCtx && b ? favEntryKey(pinCtx.book, b.uid) : null;
                const fa = ka && pinCtx.favs.has(ka) ? 0 : 1;
                const fb = kb && pinCtx.favs.has(kb) ? 0 : 1;
                if (fa !== fb) return fa - fb;
                return typeof cmp === 'function' ? cmp(a, b) : 0;
            };
            return super.sort(wrapped);
        }
    }

    async function ensureFilterPatch() {
        if (wiFilterPatched) return true;
        try {
            const mod = await import('/scripts/world-info.js');
            const helper = mod.worldInfoFilter;
            if (!helper || typeof helper.applyFilters !== 'function') return false;
            const original = helper.applyFilters.bind(helper);
            helper.applyFilters = (...args) => {
                if (Array.isArray(args[0]) && scopeFilterEnabled()) {
                    const term = searchTermOf(helper);
                    if (term) {
                        args[0] = args[0].filter((entry) => !!entry && entryMatchesSearchScope(entry, term));
                    }
                }
                const raw = original(...args);
                let list = Array.isArray(raw) ? raw : [];
                const book = currentEditingName();
                const favs = favEntryKeySet();
                if (entryFavOnly || entryDisabledOnly || entryStateFilter.size) {
                    const opts = {
                        favOnly: entryFavOnly,
                        disabledOnly: entryDisabledOnly,
                        states: entryStateFilter,
                    };
                    list = list.filter((entry) => {
                        if (!entry) return false;
                        const state = entry.constant === true ? 'constant'
                            : (entry.vectorized === true ? 'vectorized' : 'normal');
                        const faved = !!book && favs.has(favEntryKey(book, entry.uid));
                        return entryPassesFilter({ faved, disabled: entry.disable === true, state }, opts);
                    });
                }
                pinCtx = null;
                if (!entryFavPinOn() || !book || !favs.size) return list;
                pinCtx = { book, favs };
                const pinned = new WbmPinnedList();
                for (let i = 0; i < list.length; i++) pinned.push(list[i]);
                return pinned;
            };
            wiFilterPatched = true;
            console.info('[wbm] 已接管世界书筛选与收藏置顶，两者现在都覆盖全库');
            return true;
        } catch (err) {
            console.warn('[wbm] 接管世界书筛选失败，退回当前页筛选', err);
            return false;
        }
    }

    /* 改了筛选条件后要让酒馆重算一次列表：onDataChanged 就是它自己的 updateEditor() */
    async function refreshFilterView() {
        const ok = await ensureFilterPatch();
        if (ok) {
            try {
                const mod = await import('/scripts/world-info.js');
                const helper = mod.worldInfoFilter;
                if (helper && typeof helper.onDataChanged === 'function') {
                    helper.onDataChanged();
                    return;
                }
            } catch (err) { /* 落到下面的兜底 */ }
        }
        /* 兜底：拿不到宿主管线时退回"只筛当前页 + 自动跳页" */
        applyEntryFavFilter();
        nudgeFilterPage();
    }

    /* 筛选只作用于当前页（酒馆是分页渲染的）。当前页 0 命中时，
       算出第一页有命中的页并跳过去，免得 master 以为筛选坏了。 */
    function visibleEntryCount() {
        const list = document.querySelector('#world_popup_entries_list');
        if (!list) return 0;
        let n = 0;
        const rows = list.querySelectorAll('.world_entry');
        for (let i = 0; i < rows.length; i += 1) {
            if (!rows[i].classList.contains('wbm-fav-hidden')) n += 1;
        }
        return n;
    }

    async function jumpToFirstMatchingPage(book, favs) {
        try {
            const pager = window.jQuery ? window.jQuery('#world_info_pagination') : null;
            if (!pager || !pager.length) return 0;
            const mod = await import('/scripts/world-info.js');
            if (typeof mod.loadWorldInfo !== 'function') return 0;
            if (mod.worldInfoCache && typeof mod.worldInfoCache.delete === 'function') mod.worldInfoCache.delete(book);
            const data = await mod.loadWorldInfo(book);
            if (!data || !data.entries) return 0;
            let ordered = Object.values(data.entries).filter(Boolean);
            const sel = document.querySelector('#world_info_sort_order');
            const rule = sel && sel.selectedOptions && sel.selectedOptions[0]
                ? String(sel.selectedOptions[0].dataset.rule || '') : '';
            if (typeof mod.sortWorldInfoEntries === 'function') {
                try {
                    ordered = mod.sortWorldInfoEntries(ordered,
                        rule === 'custom' ? { customSort: true } : undefined) || ordered;
                } catch (err) { /* 排序失败就按原始顺序找 */ }
            }
            const opts = { favOnly: entryFavOnly, disabledOnly: entryDisabledOnly, states: entryStateFilter };
            let index = -1;
            for (let i = 0; i < ordered.length; i += 1) {
                const entry = ordered[i];
                const state = entry.constant === true ? 'constant'
                    : (entry.vectorized === true ? 'vectorized' : 'normal');
                const faved = favs.has(favEntryKey(book, entry.uid));
                if (entryPassesFilter({ faved, disabled: entry.disable === true, state }, opts)) {
                    index = i;
                    break;
                }
            }
            if (index < 0) return -1;
            const totalPage = Number(pager.pagination('getTotalPage')) || 1;
            const pageSize = Math.max(1, Math.ceil(ordered.length / totalPage));
            return Math.floor(index / pageSize) + 1;
        } catch (err) {
            console.warn('[wbm] 计算命中页失败', err);
            return 0;
        }
    }

    async function nudgeFilterPage() {
        if (!entryFavOnly && !entryDisabledOnly && !entryStateFilter.size) return;
        const book = currentEditingName();
        if (!book || visibleEntryCount() > 0) return;
        const favs = favEntryKeySet();
        const page = await jumpToFirstMatchingPage(book, favs);
        if (page === -1) {
            toast('info', '整本没有符合条件的条目');
            return;
        }
        if (page > 0 && page !== currentPaginationPage()) {
            toast('info', '筛选只作用于当前页：第 ' + page + ' 页有命中，已跳过去');
            try {
                window.jQuery('#world_info_pagination').pagination('go', page);
            } catch (err) { /* 跳页失败就保持原样 */ }
        }
    }

    function buildEntryFavBar() {
        const bar = el('div', 'wbm-entry-favbar');
        const onlyBtn = el('button', 'menu_button wbm-chip' + (entryFavOnly ? ' on' : ''), '★ 仅收藏');
        onlyBtn.type = 'button';
        onlyBtn.dataset.role = 'entry-favonly';
        const pinBtn = el('button', 'menu_button wbm-chip' + (entryFavPinOn() ? ' on' : ''),
            entryFavPinOn() ? '收藏置顶：开' : '收藏置顶：关');
        pinBtn.type = 'button';
        pinBtn.dataset.role = 'entry-favpin';
        onlyBtn.addEventListener('click', (event) => {
            event.preventDefault();
            event.stopPropagation();
            entryFavOnly = !entryFavOnly;
            applyEntryFavFilter();
            refreshFilterView();
        });
        pinBtn.addEventListener('click', (event) => {
            event.preventDefault();
            event.stopPropagation();
            setEntryFavPin(!entryFavPinOn());
            applyEntryFavFilter();
            /* 置顶现在由宿主管线按整本书排序，必须让它重算一次列表 */
            refreshFilterView();
        });
        const disabledBtn = el('button', 'menu_button wbm-chip' + (entryDisabledOnly ? ' on' : ''), '只看已禁用');
        disabledBtn.type = 'button';
        disabledBtn.dataset.role = 'entry-disabled';
        disabledBtn.title = '只看被开关关掉的条目';
        disabledBtn.addEventListener('click', (event) => {
            event.preventDefault();
            event.stopPropagation();
            entryDisabledOnly = !entryDisabledOnly;
            applyEntryFavFilter();
            refreshFilterView();
        });
        bar.appendChild(el('span', 'wbm-favbar-label', '筛选'));
        bar.appendChild(onlyBtn);
        bar.appendChild(disabledBtn);
        ENTRY_STATE_LABELS.forEach((item) => {
            const chip = el('button', 'menu_button wbm-chip'
                + (entryStateFilter.has(item.value) ? ' on' : ''), item.label);
            chip.type = 'button';
            chip.dataset.role = 'entry-state-' + item.value;
            chip.dataset.state = item.value;
            chip.title = '只看「' + item.label.slice(item.label.indexOf(' ') + 1) + '」的条目，可与其它状态叠加';
            chip.addEventListener('click', (event) => {
                event.preventDefault();
                event.stopPropagation();
                if (entryStateFilter.has(item.value)) entryStateFilter.delete(item.value);
                else entryStateFilter.add(item.value);
                applyEntryFavFilter();
                refreshFilterView();
            });
            bar.appendChild(chip);
        });
        bar.appendChild(pinBtn);
        return attachScrollHint(bar);
    }

    /* ---------------- 批量替换（只作用于当前这本世界书；结果进操作历史，可撤销） ---------------- */

    /* 三枚胶囊对应四类字段：关键词这一项里包含主关键词与次要关键词（1.18 里两者都是数组） */
    const REPLACE_GROUPS = [
        { id: 'comment', label: '备注名', fields: ['comment'] },
        { id: 'key', label: '关键词', fields: ['key', 'keysecondary'] },
        { id: 'content', label: '正文', fields: ['content'] },
    ];
    const REPLACE_FIELDS = ['comment', 'key', 'keysecondary', 'content'];
    const REPLACE_FIELD_LABEL = {
        comment: '备注名', key: '关键词', keysecondary: '次要关键词', content: '正文',
    };
    /* 1.18 里还有一份给旧格式用的镜像数据，改完要同步过去，否则下次酒馆重存会把它改回去 */
    const REPLACE_ORIGINAL_KEY = {
        comment: 'comment', content: 'content', key: 'keys', keysecondary: 'secondary_keys',
    };

    /* 单段文本里把 find 换成 repl，返回 {text, hits}。纯文本替换，不碰正则；大小写可选 */
    function replaceInText(text, find, repl, caseSensitive) {
        const src = String(text == null ? '' : text);
        if (!find || !src) return { text: src, hits: 0 };
        if (caseSensitive) {
            const parts = src.split(find);
            return { text: parts.join(repl), hits: parts.length - 1 };
        }
        const lowerSrc = src.toLowerCase();
        const lowerFind = find.toLowerCase();
        let out = '';
        let i = 0;
        let hits = 0;
        while (true) {
            const at = lowerSrc.indexOf(lowerFind, i);
            if (at === -1) { out += src.slice(i); break; }
            out += src.slice(i, at) + repl;
            i = at + find.length;
            hits += 1;
        }
        return { text: out, hits };
    }

    /* 关键词按逗号拆开并去重：酒馆只认英文逗号，作者写成中文逗号时整条会变成一个"含逗号的词"，
       于是永远匹配不到。批量替换里凡是动过关键词，都顺手按 , ， 、 归一化一遍。 */
    function splitKeywords(list) {
        const out = [];
        (Array.isArray(list) ? list : [list]).forEach((item) => {
            String(item == null ? '' : item).split(/[,，、]/).forEach((part) => {
                const key = part.trim();
                if (key && out.indexOf(key) === -1) out.push(key);
            });
        });
        return out;
    }

    function cloneFieldValue(value) {
        return Array.isArray(value) ? value.slice() : value;
    }

    /* 对整本书就地替换。返回 { hits, entries, changed:[{uid,name,before}] }，
       before 只留真正要改的字段——撤销就靠它原样写回。纯函数，方便单独测。 */
    function applyReplacements(data, find, repl, fields, caseSensitive) {
        const result = { hits: 0, entries: 0, changed: [] };
        if (!data || !data.entries || !find || !fields || !fields.length) return result;
        Object.keys(data.entries).forEach((uid) => {
            const entry = data.entries[uid];
            if (!entry) return;
            const before = {};
            let touched = false;
            fields.forEach((field) => {
                const current = entry[field];
                const isKeys = field === 'key' || field === 'keysecondary';
                if (typeof current !== 'string' && !Array.isArray(current)) return;
                let hits = 0;
                let next = null;
                if (isKeys) {
                    const list = Array.isArray(current) ? current : String(current || '').split(',');
                    const parts = [];
                    list.forEach((item) => {
                        const out = replaceInText(String(item == null ? '' : item), find, repl, caseSensitive);
                        hits += out.hits;
                        parts.push(out.text);
                    });
                    next = splitKeywords(parts);
                } else {
                    const out = replaceInText(current, find, repl, caseSensitive);
                    hits = out.hits;
                    next = out.text;
                }
                if (!hits) return;
                before[field] = cloneFieldValue(current);
                entry[field] = next;
                result.hits += hits;
                touched = true;
            });
            if (!touched) return;
            result.entries += 1;
            result.changed.push({
                uid: String(uid),
                name: String(entry.comment || '').trim() || ('条目 ' + uid),
                before,
            });
        });
        return result;
    }

    /* 撤销：把记录里的原文写回对应 uid（uid 已经不存在的就跳过并计数） */
    function undoReplacements(data, notes) {
        const result = { restored: 0, skipped: 0 };
        if (!data || !data.entries || !Array.isArray(notes)) return result;
        notes.forEach((note) => {
            const entry = note && data.entries[String(note.uid)];
            if (!entry || !note.before || typeof note.before !== 'object') { result.skipped += 1; return; }
            Array.from(new Set(REPLACE_FIELDS.concat(Object.keys(UNDO_FIELD_KEYS)))).forEach((field) => {
                if (!Object.prototype.hasOwnProperty.call(note.before, field)) return;
                const value = note.before[field];
                entry[field] = Array.isArray(value) ? value.slice() : value;
            });
            result.restored += 1;
        });
        return result;
    }

    /* 改完字段后把旧格式镜像也同步掉（酒馆自己的 setter 就是两处一起改的） */
    function syncOriginalData(mod, data, changed) {
        if (!mod || typeof mod.setWIOriginalDataValue !== 'function') return;
        (changed || []).forEach((item) => {
            const entry = data.entries[item.uid];
            if (!entry) return;
            Object.keys(item.before || {}).forEach((field) => {
                const mapKey = REPLACE_ORIGINAL_KEY[field] || UNDO_FIELD_KEYS[field];
                if (mapKey) mod.setWIOriginalDataValue(data, item.uid, mapKey, entry[field]);
            });
        });
    }

    /* 不做真的替换，只在副本上算一遍，供预览用 */
    function replacePreview(data, find, repl, fields, caseSensitive, limit) {
        let clone = null;
        try {
            clone = JSON.parse(JSON.stringify(data));
        } catch (err) {
            clone = null;
        }
        if (!clone) return { hits: 0, entries: 0, rows: [] };
        const res = applyReplacements(clone, find, repl, fields, caseSensitive);
        const rows = res.changed.slice(0, limit).map((item) => {
            const field = ['content', 'key', 'keysecondary', 'comment']
                .find((f) => item.before[f] !== undefined) || 'content';
            const raw = item.before[field];
            const text = Array.isArray(raw) ? raw.join(', ') : String(raw == null ? '' : raw);
            const at = text.toLowerCase().indexOf(String(find).toLowerCase());
            const start = at > 36 ? at - 36 : 0;
            const snippet = text.slice(start, start + 90).replace(/\s+/g, ' ');
            return {
                name: item.name,
                field,
                snippet: (start > 0 ? '…' : '') + snippet + (text.length > start + 90 ? '…' : ''),
            };
        });
        return { hits: res.hits, entries: res.entries, rows };
    }

    /* 撤销一条「替换」记录：整书载入 → 把改前原文写回 → 一次保存 → 重载编辑器 */
    async function undoHistoryReplace(record) {
        const book = String(record && record.from ? record.from : '');
        const notes = record && Array.isArray(record.entries) ? record.entries : [];
        if (!book || !notes.length) {
            toast('warning', '这条记录没留原文（可能过大未保留），撤不了');
            return false;
        }
        try {
            const mod = await import('/scripts/world-info.js');
            if (typeof mod.loadWorldInfo !== 'function' || typeof mod.saveWorldInfo !== 'function') {
                toast('warning', '当前版本拿不到世界书接口，撤销失败');
                return false;
            }
            if (mod.worldInfoCache && typeof mod.worldInfoCache.delete === 'function') mod.worldInfoCache.delete(book);
            const snap = snapshotEntryUi();
            const data = await mod.loadWorldInfo(book);
            if (!data || !data.entries) {
                markHistoryBookGone(record);
                toast('warning', '「' + book + '」已经不在了（被删或改名），撤销不了');
                return false;
            }
            const res = undoReplacements(data, notes);
            syncOriginalData(mod, data, notes);
            if (!res.restored) {
                toast('warning', '没有条目能写回（可能已经被删掉）');
                return false;
            }
            await mod.saveWorldInfo(book, data, true);
            if (typeof mod.reloadEditor === 'function') mod.reloadEditor(book);
            pushHistory({
                at: Date.now(), act: record.act === 'edit' ? 'undo-edit' : 'undo-replace', from: book, to: book,
                count: res.restored,
                find: String(record.find || '').slice(0, 60),
                repl: String(record.repl || '').slice(0, 60),
                names: notes.map((n) => String(n && n.name || '')).filter(Boolean).slice(0, 5),
            });
            restoreEntryUi(snap);
            toast('info', (record.act === 'edit' ? '已撤销正文编辑：写回 ' : '已撤销替换：写回 ') + res.restored + ' 条'
                + (res.skipped ? '，' + res.skipped + ' 条已不存在' : ''));
            return true;
        } catch (err) {
            console.error('[wbm] 撤销替换失败', err);
            toast('warning', '撤销没有成功');
            return false;
        }
    }

    /* 「批量替换」窗口：只服务当前编辑的这本世界书 */
    async function openReplacePicker() {
        const book = currentEditingName();
        if (!book) {
            toast('warning', '先选一本世界书');
            return;
        }
        let mod = null;
        let data = null;
        try {
            mod = await import('/scripts/world-info.js');
            data = await mod.loadWorldInfo(book);
        } catch (err) {
            console.error('[wbm] 打开批量替换失败', err);
        }
        if (!data || !data.entries) {
            toast('warning', '读不到这本书的条目');
            return;
        }

        const { mask, sheet } = makePickerShell();
        state.picker = mask;
        const head = buildPickerHead('要查找的内容');
        const findInput = head.input;

        const titleLine = el('div', 'wbm-prev-meta', '批量替换 · ' + book);
        const replRow = el('div', 'wbm-replace-row');
        replRow.appendChild(el('span', 'wbm-replace-label', '替换为'));
        const replInput = el('input', 'text_pole wbm-replace-field');
        replInput.type = 'text';
        replInput.setAttribute('autocomplete', 'off');
        replInput.setAttribute('spellcheck', 'false');
        replInput.placeholder = '留空＝删除找到的内容';
        replRow.appendChild(replInput);

        const chips = el('div', 'wbm-favbar wbm-replace-chips');
        const fieldOn = { comment: false, key: true, content: true };
        REPLACE_GROUPS.forEach((group) => {
            const on = !!fieldOn[group.id];
            const chip = el('button', 'menu_button wbm-chip' + (on ? ' on' : ''), group.label);
            chip.type = 'button';
            chip.addEventListener('click', () => {
                fieldOn[group.id] = !fieldOn[group.id];
                chip.classList.toggle('on', fieldOn[group.id]);
                refresh();
            });
            chips.appendChild(chip);
        });
        let caseSensitive = false;
        const caseChip = el('button', 'menu_button wbm-chip', '区分大小写');
        caseChip.type = 'button';
        caseChip.addEventListener('click', () => {
            caseSensitive = !caseSensitive;
            caseChip.classList.toggle('on', caseSensitive);
            refresh();
        });
        chips.appendChild(caseChip);

        const list = el('div', 'wbm-picker-list');
        const actions = el('div', 'wbm-picker-actions');
        const runBtn = el('button', 'wbm-picker-action primary wide', '替换');
        runBtn.type = 'button';
        runBtn.disabled = true;
        actions.appendChild(runBtn);

        sheet.appendChild(head.head);
        sheet.appendChild(titleLine);
        sheet.appendChild(replRow);
        sheet.appendChild(chips);
        sheet.appendChild(list);
        sheet.appendChild(actions);

        const fieldsNow = () => {
            const list = [];
            REPLACE_GROUPS.forEach((group) => {
                if (!fieldOn[group.id]) return;
                group.fields.forEach((field) => { if (list.indexOf(field) === -1) list.push(field); });
            });
            return list;
        };

        const refresh = () => {
            const find = String(findInput.value || '');
            list.textContent = '';
            runBtn.disabled = true;
            runBtn.textContent = '替换';
            if (!find) {
                list.appendChild(el('div', 'wbm-picker-empty', '输入要查找的内容，下面会列出命中'));
                return;
            }
            const fields = fieldsNow();
            if (!fields.length) {
                list.appendChild(el('div', 'wbm-picker-empty', '至少留一面：备注名 / 关键词 / 正文'));
                return;
            }
            const preview = replacePreview(data, find, String(replInput.value || ''), fields, caseSensitive, 40);
            list.appendChild(el('div', 'wbm-prev-meta',
                '命中 ' + preview.hits + ' 处，涉及 ' + preview.entries + ' 条'));
            preview.rows.forEach((row) => {
                const item = el('div', 'wbm-picker-row');
                const col = el('div', 'wbm-hist-col');
                col.appendChild(el('span', 'wbm-hist-line', row.name + ' · ' + REPLACE_FIELD_LABEL[row.field]));
                col.appendChild(el('span', 'wbm-replace-hit', row.snippet));
                item.appendChild(col);
                list.appendChild(item);
            });
            if (preview.entries > preview.rows.length) {
                list.appendChild(el('div', 'wbm-picker-empty',
                    '……还有 ' + (preview.entries - preview.rows.length) + ' 条没列出'));
            }
            runBtn.textContent = '替换 ' + preview.hits + ' 处（' + preview.entries + ' 条）';
            runBtn.disabled = preview.hits === 0;
        };

        runBtn.addEventListener('click', async () => {
            const find = String(findInput.value || '');
            const repl = String(replInput.value || '');
            const fields = fieldsNow();
            if (!find || !fields.length) return;
            runBtn.disabled = true;
            runBtn.textContent = '替换中…';
            try {
                const snap = snapshotEntryUi();
                /* 真改之前踢掉缓存，拿服务端最新的那本，免得把别处刚做的改动覆盖掉 */
                if (mod.worldInfoCache && typeof mod.worldInfoCache.delete === 'function') mod.worldInfoCache.delete(book);
                const fresh = await mod.loadWorldInfo(book);
                if (!fresh || !fresh.entries) {
                    toast('warning', '读不到这本书');
                    refresh();
                    return;
                }
                const res = applyReplacements(fresh, find, repl, fields, caseSensitive);
                if (!res.hits) {
                    toast('warning', '没有命中');
                    refresh();
                    return;
                }
                syncOriginalData(mod, fresh, res.changed);
                await mod.saveWorldInfo(book, fresh, true);
                if (typeof mod.reloadEditor === 'function') mod.reloadEditor(book);
                const tooBig = JSON.stringify(res.changed).length > HISTORY_PAYLOAD_BYTES;
                pushHistory({
                    at: Date.now(), act: 'replace', from: book, to: book,
                    count: res.entries, hits: res.hits,
                    find: find.slice(0, 60), repl: repl.slice(0, 60),
                    fields,
                    names: res.changed.map((x) => x.name).slice(0, 5),
                    entries: tooBig ? [] : res.changed,
                    payloadDropped: tooBig,
                });
                toast('info', '已替换 ' + res.hits + ' 处（' + res.entries + ' 条）'
                    + (tooBig ? '；原文过大未保留，不能撤销' : '，可在「操作历史」里撤销'));
                restoreEntryUi(snap);
                closeEditorPicker();
            } catch (err) {
                console.error('[wbm] 批量替换失败', err);
                toast('warning', '替换没有成功');
                refresh();
            }
        });

        let typing = null;
        const onType = () => {
            clearTimeout(typing);
            typing = setTimeout(refresh, 140);
        };
        findInput.addEventListener('input', onType);
        replInput.addEventListener('input', onType);

        const openedAt = Date.now();
        mask.addEventListener('click', (event) => {
            const target = event.target;
            if (!(target instanceof Element)) return;
            if (target.closest('[data-role="picker-close"]')) {
                closeEditorPicker();
                return;
            }
            if (target === mask && Date.now() - openedAt > 300) closeEditorPicker();
        });

        document.documentElement.appendChild(mask);
        refresh();
        findInput.focus();
    }

    /* ---------------- 一键递归开关（不可递归 / 防止进一步递归） ---------------- */

    const RECURSION_FLAGS = [
        {
            field: 'excludeRecursion',
            original: 'extensions.exclude_recursion',
            extKey: 'exclude_recursion',
            label: '不可递归',
            hint: '不会被别的条目激活',
        },
        {
            field: 'preventRecursion',
            original: 'extensions.prevent_recursion',
            extKey: 'prevent_recursion',
            label: '防止进一步递归',
            hint: '不会再去激活别的条目',
        },
    ];

    /* 撤销一次递归开关：按记录里的 before 把两项布尔值写回（uid 已不存在的跳过） */
    function undoRecursionFlags(data, notes) {
        const result = { restored: 0, skipped: 0 };
        if (!data || !data.entries || !Array.isArray(notes)) return result;
        notes.forEach((note) => {
            const entry = note && data.entries[String(note.uid)];
            if (!entry || !note.before || typeof note.before !== 'object') {
                result.skipped += 1;
                return;
            }
            RECURSION_FLAGS.forEach((flag) => {
                if (!Object.prototype.hasOwnProperty.call(note.before, flag.field)) return;
                const value = !!note.before[flag.field];
                entry[flag.field] = value;
                if (entry.extensions && typeof entry.extensions === 'object') {
                    entry.extensions[flag.extKey] = value;
                }
            });
            result.restored += 1;
        });
        return result;
    }

    /* 撤销一条「递归开关」记录：整书载入 → 写回两条布尔 → 一次保存 → 重载 */
    async function undoHistoryRecursion(record) {
        const book = String(record && record.from ? record.from : '');
        const notes = record && Array.isArray(record.entries) ? record.entries : [];
        if (!book || !notes.length) {
            toast('warning', '这条记录没留原文，撤不了');
            return false;
        }
        try {
            const mod = await import('/scripts/world-info.js');
            if (typeof mod.loadWorldInfo !== 'function' || typeof mod.saveWorldInfo !== 'function') {
                toast('warning', '当前版本拿不到世界书接口，撤销失败');
                return false;
            }
            if (mod.worldInfoCache && typeof mod.worldInfoCache.delete === 'function') mod.worldInfoCache.delete(book);
            const snap = snapshotEntryUi();
            const data = await mod.loadWorldInfo(book);
            if (!data || !data.entries) {
                markHistoryBookGone(record);
                toast('warning', '「' + book + '」已经不在了（被删或改名），撤销不了');
                return false;
            }
            const res = undoRecursionFlags(data, notes);
            if (!res.restored) {
                toast('warning', '没有条目能写回（可能已经被删掉）');
                return false;
            }
            if (typeof mod.setWIOriginalDataValue === 'function') {
                notes.forEach((note) => {
                    const entry = data.entries[String(note && note.uid)];
                    if (!entry) return;
                    RECURSION_FLAGS.forEach((flag) => {
                        mod.setWIOriginalDataValue(data, String(note.uid), flag.original, !!entry[flag.field]);
                    });
                });
            }
            await mod.saveWorldInfo(book, data, true);
            if (typeof mod.reloadEditor === 'function') mod.reloadEditor(book);
            pushHistory({
                at: Date.now(), act: 'undo-recursion', from: book, to: book,
                count: res.restored,
                names: notes.map((n) => String(n && n.name || '')).filter(Boolean).slice(0, 5),
            });
            restoreEntryUi(snap);
            toast('info', '已撤销递归开关：写回 ' + res.restored + ' 条'
                + (res.skipped ? '，' + res.skipped + ' 条已不存在' : ''));
            return true;
        } catch (err) {
            console.error('[wbm] 撤销递归开关失败', err);
            toast('warning', '撤销没有成功');
            return false;
        }
    }

    /* 批量给指定条目开/关递归两项（批量操作里用），返回 changed 供历史撤销。
       已经是目标状态的条目直接跳过——不然历史里会多一条"前后无变化"的撤销记录。 */
    function applyRecursionToEntries(data, uids, value) {
        const changed = [];
        const want = !!value;
        (uids || []).forEach((uid) => {
            const entry = data && data.entries ? data.entries[String(uid)] : null;
            if (!entry) return;
            if (RECURSION_FLAGS.every((flag) => (entry[flag.field] === true) === want)) return;
            const before = {};
            RECURSION_FLAGS.forEach((flag) => {
                before[flag.field] = !!entry[flag.field];
                entry[flag.field] = !!value;
                if (entry.extensions && typeof entry.extensions === 'object') {
                    entry.extensions[flag.extKey] = !!value;
                }
            });
            changed.push({
                uid: String(uid),
                name: String(entry.comment || '').trim() || ('条目 ' + uid),
                before,
            });
        });
        return changed;
    }

    /* 只对选中的条目批量开关递归（结果可撤销，和整书那个共用记录格式） */
    async function runBatchRecursion(book, uids, value) {
        try {
            const mod = await import('/scripts/world-info.js');
            if (typeof mod.loadWorldInfo !== 'function' || typeof mod.saveWorldInfo !== 'function') return 0;
            if (mod.worldInfoCache && typeof mod.worldInfoCache.delete === 'function') mod.worldInfoCache.delete(book);
            const data = await mod.loadWorldInfo(book);
            if (!data || !data.entries) return 0;
            const changed = applyRecursionToEntries(data, uids, value);
            if (!changed.length) return 0;
            if (typeof mod.setWIOriginalDataValue === 'function') {
                changed.forEach((item) => {
                    const entry = data.entries[item.uid];
                    if (!entry) return;
                    RECURSION_FLAGS.forEach((flag) => {
                        mod.setWIOriginalDataValue(data, item.uid, flag.original, !!entry[flag.field]);
                    });
                });
            }
            await mod.saveWorldInfo(book, data, true);
            if (typeof mod.reloadEditor === 'function') mod.reloadEditor(book);
            pushHistory({
                at: Date.now(), act: 'recursion', from: book, to: book, count: changed.length,
                on: !!value,
                names: changed.map((x) => x.name).slice(0, 5),
                entries: changed,
            });
            return changed.length;
        } catch (err) {
            console.error('[wbm] 批量递归开关失败', err);
            return 0;
        }
    }

    async function openRecursionPicker() {
        const book = currentEditingName();
        if (!book) {
            toast('warning', '先选一本世界书');
            return;
        }
        let mod = null;
        let data = null;
        try {
            mod = await import('/scripts/world-info.js');
            data = await mod.loadWorldInfo(book);
        } catch (err) {
            console.error('[wbm] 打开递归开关失败', err);
        }
        if (!data || !data.entries) {
            toast('warning', '读不到这本书的条目');
            return;
        }

        const uids = Object.keys(data.entries);
        const { mask, sheet } = makePickerShell();
        state.picker = mask;

        const head = el('div', 'wbm-picker-head');
        head.appendChild(el('div', 'wbm-prev-title', '递归开关 · ' + book));
        const close = el('button', 'wbm-picker-close', '✕');
        close.type = 'button';
        close.dataset.role = 'picker-close';
        head.appendChild(close);

        const list = el('div', 'wbm-picker-list');
        RECURSION_FLAGS.forEach((flag) => {
            const row = el('div', 'wbm-picker-row');
            const col = el('div', 'wbm-hist-col');
            col.appendChild(el('span', 'wbm-hist-line', flag.label + ' · ' + flag.hint));
            const on = uids.filter((uid) => data.entries[uid] && data.entries[uid][flag.field]).length;
            col.appendChild(el('span', 'wbm-hist-names', '当前 ' + on + ' / ' + uids.length + ' 条已开启'));
            row.appendChild(col);
            list.appendChild(row);
        });
        list.appendChild(el('div', 'wbm-warn-row',
            '⚠️ 危险操作：这两项会直接影响检索行为。开错会让本该被其它条目激活的条目失效；'
            + '反过来，本来就是"触发器"的条目应该保持关闭。'
            + '每次操作都会记进「操作历史」，误操作可以在那里点「撤销」原样还原。'));
        list.appendChild(el('div', 'wbm-picker-empty',
            '写卡、改卡时可以全部开启，再把要当触发器的条目手动关掉；'
            + '「批量操作」里也有批量开关这两项的功能。'));

        const actions = el('div', 'wbm-picker-actions');
        const onBtn = el('button', 'wbm-picker-action primary wide', '全部开启这两项');
        onBtn.type = 'button';
        const offBtn = el('button', 'wbm-picker-action', '全部关闭');
        offBtn.type = 'button';
        /* 已经是全开/全关时把对应的按钮按掉，免得点下去什么都没变还留一条记录 */
        const allOn = uids.every((uid) => RECURSION_FLAGS.every((flag) => !!(data.entries[uid] && data.entries[uid][flag.field])));
        const allOff = uids.every((uid) => RECURSION_FLAGS.every((flag) => !(data.entries[uid] && data.entries[uid][flag.field])));
        if (allOn) {
            onBtn.disabled = true;
            onBtn.title = '这本书的条目已经全部开启了这两项';
        }
        if (allOff) {
            offBtn.disabled = true;
            offBtn.title = '这本书的条目已经全部关闭了这两项';
        }
        actions.appendChild(onBtn);
        actions.appendChild(offBtn);

        sheet.appendChild(head);
        sheet.appendChild(list);
        sheet.appendChild(actions);

        const apply = async (value) => {
            onBtn.disabled = true;
            offBtn.disabled = true;
            try {
                const snap = snapshotEntryUi();
                if (mod.worldInfoCache && typeof mod.worldInfoCache.delete === 'function') mod.worldInfoCache.delete(book);
                const fresh = await mod.loadWorldInfo(book);
                if (!fresh || !fresh.entries) {
                    toast('warning', '读不到这本书');
                    onBtn.disabled = false;
                    offBtn.disabled = false;
                    return;
                }
                /* 只改"还不是这个状态"的条目：前后无变化就不写盘、不记历史 */
                const changed = applyRecursionToEntries(fresh, Object.keys(fresh.entries), value);
                if (!changed.length) {
                    toast('info', '这本书的条目已经' + (value ? '全部开启' : '全部关闭')
                        + '这两项了，没有要改的');
                    onBtn.disabled = false;
                    offBtn.disabled = false;
                    restoreEntryUi(snap);
                    return;
                }
                if (typeof mod.setWIOriginalDataValue === 'function') {
                    changed.forEach((item) => {
                        const entry = fresh.entries[item.uid];
                        if (!entry) return;
                        RECURSION_FLAGS.forEach((flag) => {
                            mod.setWIOriginalDataValue(fresh, item.uid, flag.original, !!entry[flag.field]);
                        });
                    });
                }
                await mod.saveWorldInfo(book, fresh, true);
                if (typeof mod.reloadEditor === 'function') mod.reloadEditor(book);
                pushHistory({
                    at: Date.now(), act: 'recursion', from: book, to: book, count: changed.length,
                    on: !!value,
                    names: changed.map((x) => x.name).slice(0, 5),
                    entries: changed,
                });
                restoreEntryUi(snap);
                closeEditorPicker();
                toast('info', (value ? '已开启' : '已关闭') + '递归开关：' + changed.length + ' 条');
            } catch (err) {
                console.error('[wbm] 设置递归开关失败', err);
                toast('warning', '设置没有成功');
                onBtn.disabled = false;
                offBtn.disabled = false;
            }
        };
        onBtn.addEventListener('click', () => apply(true));
        offBtn.addEventListener('click', () => apply(false));

        const openedAt = Date.now();
        mask.addEventListener('click', (event) => {
            const target = event.target;
            if (!(target instanceof Element)) return;
            if (target.closest('[data-role="picker-close"]')) {
                closeEditorPicker();
                return;
            }
            if (target === mask && Date.now() - openedAt > 300) closeEditorPicker();
        });

        document.documentElement.appendChild(mask);
    }

    /* ---------------- 条目体检（BETA：只做整理与提示，不改酒馆的判定逻辑） ---------------- */

    const KEY_SPLIT = /[,，、\n\r]/;

    /* 关键词数组「修好」的版本：trim + 按逗号拆开 + 去重 */
    function cleanKeywordList(list) {
        const seen = new Set();
        const out = [];
        (Array.isArray(list) ? list : (list ? [list] : [])).forEach((item) => {
            String(item == null ? '' : item).split(KEY_SPLIT).forEach((part) => {
                const key = part.trim();
                if (!key || seen.has(key)) return;
                seen.add(key);
                out.push(key);
            });
        });
        return out;
    }

    function sameKeywordList(a, b) {
        const x = Array.isArray(a) ? a : [];
        const y = Array.isArray(b) ? b : [];
        if (x.length !== y.length) return false;
        for (let i = 0; i < x.length; i += 1) if (x[i] !== y[i]) return false;
        return true;
    }

    /* 体检：只读扫描，返回问题分类清单。opts.longBody 是正文超长阈值 */
    function auditBook(data, opts) {
        const config = Object.assign({ longBody: 4000, longKey: 20, ignore: null }, opts || {});
        const limits = config;
        const report = {
            comma: [], dup: [], longKey: [], noKey: [], onlySecondary: [],
            noBody: [], long: [], zero: [],
            sameName: [], recOff: [], total: 0, ignored: 0,
        };
        if (!data || !data.entries) return report;
        const byName = new Map();
        Object.keys(data.entries).forEach((uid) => {
            const entry = data.entries[uid];
            if (!entry) return;
            /* 本机忽略：master 自己勾掉"我知道，别再说"的条目 */
            if (config.ignore && config.ignore.has(String(uid))) {
                report.ignored += 1;
                return;
            }
            report.total += 1;
            const name = String(entry.comment || '').trim() || ('条目 ' + uid);
            const keys = Array.isArray(entry.key) ? entry.key : [];
            const keys2 = Array.isArray(entry.keysecondary) ? entry.keysecondary : [];
            const all = keys.concat(keys2);
            const joined = all.join('\u0001');

            if (/[，、]/.test(joined)) report.comma.push({ uid, name });
            const seen = new Set();
            let dup = false;
            all.forEach((item) => {
                const key = String(item || '').trim();
                if (!key) return;
                if (seen.has(key)) dup = true;
                seen.add(key);
            });
            if (dup) report.dup.push({ uid, name });
            /* 只报"像人话却超长"的词；带 - 或 _ 的（数据库条目 Key、表格名）本来就是标识符，不提醒 */
            if (all.some((item) => {
                const key = String(item || '').trim();
                if (key.length <= limits.longKey) return false;
                return !/[-_]/.test(key);
            })) {
                report.longKey.push({ uid, name });
            }
            /* 常量档不看关键词，所以只有非常量才要求有关键词。
               主关键词为空、只填了可选过滤器是更隐蔽的一种：可选过滤器只在主关键词命中之后
               才参与判断（world-info.js:4802 起，主关键词不命中就直接 continue），所以这条永不触发。 */
            if (entry.constant !== true && keys.length === 0) {
                if (keys2.length) report.onlySecondary.push({ uid, name });
                else report.noKey.push({ uid, name });
            }
            if (!String(entry.content || '').trim()) report.noBody.push({ uid, name });
            /* 正文长短本来就有长有短，master 明确说不用提醒，这里不再收集 */
            if (Number(entry.probability) <= 0) report.zero.push({ uid, name });
            /* 不检查 depth：@D 的深度 0 是合法值（ST 直接用 entry.depth，0 照用），
               而没填时宿主会走 DEFAULT_DEPTH=4，都不是"永不触发"的问题，报了只会误伤。 */
            if (!entry.excludeRecursion && !entry.preventRecursion) report.recOff.push({ uid, name });
            const list = byName.get(name) || [];
            list.push(uid);
            byName.set(name, list);
        });
        byName.forEach((uids, name) => {
            if (uids.length > 1) report.sameName.push({ name, uids });
        });
        return report;
    }

    /* 只做安全归一化：trim + 拆中文逗号 + 去重。返回 changed（带 before，可撤销） */
    function applyKeywordNormalize(data, uids) {
        const changed = [];
        (uids || []).forEach((uid) => {
            const entry = data && data.entries ? data.entries[String(uid)] : null;
            if (!entry) return;
            const before = {};
            ['key', 'keysecondary'].forEach((field) => {
                if (!Array.isArray(entry[field])) return;
                const clean = cleanKeywordList(entry[field]);
                if (sameKeywordList(entry[field], clean)) return;
                before[field] = entry[field].slice();
                entry[field] = clean;
            });
            if (Object.keys(before).length) {
                changed.push({
                    uid: String(uid),
                    name: String(entry.comment || '').trim() || ('条目 ' + uid),
                    before,
                });
            }
        });
        return changed;
    }

    /* 把关键词归一化写盘（体检的「一键修」用；saveKeywordFix 的 act 仍保留 keywords，方便读旧记录） */
    async function saveKeywordFix(book, mutate, historyAct) {
        const mod = await import('/scripts/world-info.js');
        if (typeof mod.loadWorldInfo !== 'function' || typeof mod.saveWorldInfo !== 'function') return 0;
        if (mod.worldInfoCache && typeof mod.worldInfoCache.delete === 'function') mod.worldInfoCache.delete(book);
        const snap = snapshotEntryUi();
        const data = await mod.loadWorldInfo(book);
        if (!data || !data.entries) {
            toast('warning', '读不到这本书');
            return 0;
        }
        const changed = mutate(data);
        if (!changed || !changed.length) return 0;
        if (typeof mod.setWIOriginalDataValue === 'function') {
            changed.forEach((item) => {
                const entry = data.entries[item.uid];
                if (!entry) return;
                if (Object.prototype.hasOwnProperty.call(item.before, 'key')) {
                    mod.setWIOriginalDataValue(data, item.uid, 'keys', entry.key);
                }
                if (Object.prototype.hasOwnProperty.call(item.before, 'keysecondary')) {
                    mod.setWIOriginalDataValue(data, item.uid, 'secondary_keys', entry.keysecondary);
                }
            });
        }
        await mod.saveWorldInfo(book, data, true);
        if (typeof mod.reloadEditor === 'function') mod.reloadEditor(book);
        pushHistory({
            at: Date.now(), act: historyAct || 'keywords', from: book, to: book,
            count: changed.length,
            names: changed.map((x) => x.name).slice(0, 5),
            entries: changed,
        });
        restoreEntryUi(snap);
        return changed.length;
    }

    /* 体检的「本机忽略」：存进 extension_settings，和收藏同一份 */
    function healthIgnoreKey(book, uid) {
        return String(book) + '\u0000' + String(uid);
    }

    function healthIgnoreSet(book) {
        const cfg = settingsBucket();
        const list = cfg && Array.isArray(cfg.healthIgnore) ? cfg.healthIgnore : [];
        const prefix = String(book) + '\u0000';
        const out = new Set();
        list.forEach((key) => {
            const text = String(key);
            if (text.indexOf(prefix) === 0) out.add(text.slice(prefix.length));
        });
        return out;
    }

    function toggleHealthIgnore(book, uid) {
        const cfg = settingsBucket();
        if (!cfg) return false;
        const key = healthIgnoreKey(book, uid);
        const list = Array.isArray(cfg.healthIgnore) ? cfg.healthIgnore.slice() : [];
        const index = list.indexOf(key);
        if (index >= 0) list.splice(index, 1);
        else list.push(key);
        cfg.healthIgnore = list;
        persistStore();
        return index < 0;
    }

    /* 条目体检窗口：分类可展开，点条目名看正文摘录，可「忽略」这类提醒 */
    async function openHealthCheck() {
        const book = currentEditingName();
        if (!book) {
            toast('warning', '先选一本世界书');
            return;
        }
        let data = null;
        try {
            const mod = await import('/scripts/world-info.js');
            data = await mod.loadWorldInfo(book);
        } catch (err) {
            console.error('[wbm] 体检读取失败', err);
        }
        if (!data || !data.entries) {
            toast('warning', '读不到这本书的条目');
            return;
        }

        const ignore = healthIgnoreSet(book);
        const report = auditBook(data, { ignore });

        const { mask, sheet } = makePickerShell();
        state.picker = mask;
        const head = el('div', 'wbm-picker-head');
        head.appendChild(el('div', 'wbm-prev-title', '条目体检 BETA · ' + book));
        const close = el('button', 'wbm-picker-close', '✕');
        close.type = 'button';
        close.dataset.role = 'picker-close';
        head.appendChild(close);

        const list = el('div', 'wbm-picker-list');

        list.appendChild(el('div', 'wbm-warn-row',
            '谨慎操作：这里的「一键修」会真的改写条目数据（目前只改关键词：拆中文逗号、去重）。'
            + '每次修复都会记进「操作历史」，改错了可以去那里点「撤销」原样还原。'));

        /* ⓘ 说明：纯静态文本折叠，不请求、不扫描，零开销 */
        const infoBtn = el('button', 'wbm-health-info', 'ⓘ 这项检查都查什么、能修什么');
        const infoBody = el('div', 'wbm-health-info-body');
        infoBody.style.display = 'none';
        [
            '能自动修（会写盘、可撤销）：',
            '· 关键词里有中文逗号 / 顿号 —— 酒馆只认英文逗号，这种词会被当成一个整词，永远不触发；',
            '· 关键词重复 —— 同一个词在主/次关键词里出现多次。',
            '只提示、不自动改（要人工判断）：',
            '· 单个关键词超长 —— 可能是粘在一起漏了逗号（带 - 或 _ 的标识符不报）；',
            '· 没有关键词却不是常量档 —— 正常档没关键词就永不触发；',
            '· 只填了可选过滤器、主关键词为空 —— 可选过滤器只在主关键词命中后才参与判断，所以这条永不触发，'
            + '要激活请把触发词填进主关键词；',
            '· 正文为空；',
            '· 触发概率为 0；',
            '· 备注名重复；',
            '· 「不可递归 / 防止进一步递归」都没开 —— 只是提示，触发器本来就该关着。',
            '点分类展开，点条目名就地看摘录，点「全文」打开只读预览，点「忽略」以后不再提这一条。',
        ].forEach((line) => infoBody.appendChild(el('div', 'wbm-health-info-line', line)));
        infoBtn.addEventListener('click', (event) => {
            event.preventDefault();
            event.stopPropagation();
            const open = infoBody.style.display !== 'none';
            infoBody.style.display = open ? 'none' : '';
            infoBtn.classList.toggle('open', !open);
        });
        list.appendChild(infoBtn);
        list.appendChild(infoBody);

        const categories = [
            { key: 'comma', label: '关键词里有中文逗号 / 顿号（会被当成一个词，永不触发）', fix: true },
            { key: 'dup', label: '关键词重复', fix: true },
            { key: 'longKey', label: '单个关键词超长（可能漏了逗号粘成一坨）', fix: false },
            { key: 'noKey', label: '没有关键词却不是常量档（永不触发）', fix: false },
            { key: 'onlySecondary', label: '只填了可选过滤器、主关键词为空（永不触发）', fix: false },
            { key: 'noBody', label: '正文为空', fix: false },
            { key: 'zero', label: '触发概率为 0', fix: false },
            { key: 'sameName', label: '备注名重复', fix: false },
            { key: 'recOff', label: '「不可递归 / 防止进一步递归」都没开（仅提示）', fix: false, info: true },
        ];

        let problems = 0;
        const fixUids = [];

        const buildEntryLine = (item) => {
            const uid = String(item.uid === undefined ? '' : item.uid);
            const name = item.name || ('同名 ' + (item.uids || []).length + ' 条');
            const line = el('div', 'wbm-health-item');
            const nameBtn = el('button', 'wbm-health-name', name);
            nameBtn.type = 'button';
            const excerpt = el('div', 'wbm-health-excerpt');
            excerpt.style.display = 'none';
            const entry = uid ? data.entries[uid] : null;
            const body = entry ? String(entry.content || '') : '';
            nameBtn.addEventListener('click', (event) => {
                event.preventDefault();
                event.stopPropagation();
                const open = excerpt.style.display !== 'none';
                if (open) {
                    excerpt.style.display = 'none';
                    return;
                }
                if (!excerpt.textContent) {
                    if (entry) excerpt.appendChild(buildKeywordLines(entry));
                    excerpt.appendChild(el('div', 'wbm-prev-meta',
                        entry ? '正文 ' + body.length + ' 字' : '读不到这条数据'));
                    excerpt.appendChild(el('div', 'wbm-health-body',
                        body ? body.slice(0, 300) + (body.length > 300 ? '…' : '') : '（正文为空）'));
                }
                excerpt.style.display = '';
            });
            line.appendChild(nameBtn);
            if (uid && statusOfUid(uid) === 'server') {
                const previewBtn = el('button', 'wbm-health-act', '全文');
                previewBtn.type = 'button';
                previewBtn.addEventListener('click', (event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    const world = currentEditingName();
                    closeEditorPicker(true);
                    openPreview(world, uid);
                });
                line.appendChild(previewBtn);
                const ignoreBtn = el('button', 'wbm-health-act', '忽略');
                ignoreBtn.type = 'button';
                ignoreBtn.title = '以后体检不再提醒这一条（存在酒馆本地设置里）';
                ignoreBtn.addEventListener('click', (event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    toggleHealthIgnore(book, uid);
                    ignoreBtn.textContent = '已忽略';
                    ignoreBtn.disabled = true;
                    toast('info', '已忽略这一条，下次体检不再提它');
                });
                line.appendChild(ignoreBtn);
            }
            const wrap = el('div', 'wbm-health-linewrap');
            wrap.appendChild(line);
            wrap.appendChild(excerpt);
            return wrap;
        };

        /* 忽略状态与 server/local 无关，这里只用来决定是否给「全文/忽略」按钮 */
        function statusOfUid(uid) {
            return data.entries[String(uid)] ? 'server' : 'none';
        }

        categories.forEach((category) => {
            const items = report[category.key] || [];
            if (!items.length) return;
            if (!category.info) problems += items.length;
            if (category.fix) {
                items.forEach((item) => {
                    if (item && item.uid !== undefined) fixUids.push(String(item.uid));
                });
            }
            const box = el('div', 'wbm-health-cat');
            const headBtn = el('button', 'wbm-health-head',
                items.length + ' 条 · ' + category.label);
            headBtn.type = 'button';
            const detail = el('div', 'wbm-health-list');
            detail.style.display = 'none';
            items.slice(0, 80).forEach((item) => detail.appendChild(buildEntryLine(item)));
            if (items.length > 80) {
                detail.appendChild(el('div', 'wbm-picker-empty', '……还有 ' + (items.length - 80) + ' 条没列出'));
            }
            headBtn.addEventListener('click', (event) => {
                event.preventDefault();
                event.stopPropagation();
                const open = detail.style.display !== 'none';
                detail.style.display = open ? 'none' : '';
                headBtn.classList.toggle('open', !open);
            });
            box.appendChild(headBtn);
            box.appendChild(detail);
            list.appendChild(box);
        });

        if (!problems) {
            list.appendChild(el('div', 'wbm-picker-empty', '没发现可自动修的问题，这本书挺干净。'));
        }
        list.appendChild(el('div', 'wbm-prev-meta',
            '共扫描 ' + report.total + ' 条' + (report.ignored ? '（另有 ' + report.ignored + ' 条按 master 的要求忽略）' : '')
            + '。点分类展开，点条目名看正文摘录，或按「全文」打开预览。'));

        const actions = el('div', 'wbm-picker-actions');
        const fixBtn = el('button', 'wbm-picker-action primary wide',
            fixUids.length ? '一键修关键词（' + fixUids.length + ' 条）' : '没有可自动修的问题');
        fixBtn.type = 'button';
        fixBtn.disabled = !fixUids.length;
        actions.appendChild(fixBtn);

        sheet.appendChild(head);
        sheet.appendChild(list);
        sheet.appendChild(actions);

        fixBtn.addEventListener('click', async () => {
            fixBtn.disabled = true;
            fixBtn.textContent = '修复中…';
            try {
                const changed = await saveKeywordFix(book,
                    (fresh) => applyKeywordNormalize(fresh, fixUids.filter((uid) => !ignore.has(uid))), 'healthfix');
                if (!changed) {
                    toast('warning', '没有需要改的地方');
                    fixBtn.disabled = false;
                    return;
                }
                toast('info', '已整理 ' + changed + ' 条的关键词，可在「操作历史」里撤销');
                closeEditorPicker();
            } catch (err) {
                console.error('[wbm] 体检修复失败', err);
                toast('warning', '修复没有成功');
                fixBtn.disabled = false;
            }
        });

        const openedAt = Date.now();
        mask.addEventListener('click', (event) => {
            const target = event.target;
            if (!(target instanceof Element)) return;
            if (target.closest('[data-role="picker-close"]')) {
                closeEditorPicker();
                return;
            }
            if (target === mask && Date.now() - openedAt > 300) closeEditorPicker();
        });

        document.documentElement.appendChild(mask);
    }

    function ensureBatchBar() {
        if (!enhancementsOn()) return;
        /* 搜索范围的小键在搜索框那一行、和批量条无关，每次渲染都确认一遍（幂等）；
           宿主筛选接管也在第一次渲染时装上，别等到"点了筛选键"才装。 */
        ensureSearchScopeBar();
        ensureFilterPatch();
        ensurePresetBar();
        hookGlobalPresetRefresh();
        const entriesList = document.querySelector('#world_popup_entries_list');
        if (!entriesList || !entriesList.parentNode) return;
        if (entriesList.parentNode.querySelector('.wbm-batch-bar')) return;
        const bar = el('div', 'wbm-batch-bar');
        /* 按键的用途分两组，各自一个带标注的小框，和筛选条同一套外观 */
        const dataGroup = el('div', 'wbm-tool-group');
        dataGroup.appendChild(el('span', 'wbm-favbar-label', '批量整理'));
        const checkGroup = el('div', 'wbm-tool-group');
        checkGroup.appendChild(el('span', 'wbm-favbar-label', '检查记录'));

        const mkTool = (label, role, handler, group) => {
            const node = el('button', 'menu_button wbm-chip wbm-batch-btn', label);
            node.type = 'button';
            node.dataset.role = role;
            node.addEventListener('click', (event) => {
                event.preventDefault();
                event.stopPropagation();
                handler();
            });
            group.appendChild(node);
            return node;
        };

        mkTool('批量替换', 'replace-open', openReplacePicker, dataGroup);
        mkTool('批量操作', 'batch-open', openBatchPicker, dataGroup);
        mkTool('递归设置', 'recursion-open', openRecursionPicker, dataGroup);
        mkTool('条目体检 BETA', 'health-open', openHealthCheck, checkGroup);
        mkTool('操作历史', 'history-open', openHistoryPicker, checkGroup);

        /* 「双击编辑条目 / 单击编辑」不再放这排按钮里：它不是整理也不是筛选，
           而且不需要频繁切换，统一收到「扩展程序 → 双端酒馆原生功能优化」抽屉里。 */

        bar.appendChild(dataGroup);
        bar.appendChild(checkGroup);
        attachScrollHint(bar);
        entriesList.parentNode.insertBefore(bar, entriesList);
        if (!entriesList.parentNode.querySelector('.wbm-entry-favbar')) {
            entriesList.parentNode.insertBefore(buildEntryFavBar(), entriesList);
        }
    }

    /* 接管 ST 的「移动/复制条目」按钮（.move_entry_button）：捕获阶段拦下，
       原生那个只有下拉框、位置又怪的 Popup 就不再出现 */
    function bindMoveEntryHook() {
        document.addEventListener('click', (event) => {
            if (!enhancementsOn()) return;
            const target = event.target;
            if (!(target instanceof Element)) return;
            const btn = target.closest('.move_entry_button');
            if (!btn) return;
            const uid = btn.getAttribute('data-uid');
            const sourceWorld = btn.getAttribute('data-current-world');
            if (!uid || !sourceWorld) return;
            event.preventDefault();
            event.stopPropagation();
            const row = btn.closest('.world_entry');
            const nameBox = row ? row.querySelector('textarea[name="comment"], .comment') : null;
            const entryName = nameBox ? String(nameBox.value || nameBox.textContent || '').trim() : '';
            openMovePicker(uid, sourceWorld, entryName);
        }, true);
    }

    function ensureEditorPicker() {
        if (!enhancementsOn()) return;
        const sel = editorSelect();
        if (!sel || !sel.parentNode) return;
        watchEditorSelect();
        applyEditorOptgroups();
        if (sel.parentNode.querySelector('.wbm-editor-wrap')) return;

        const wrap = el('div', 'wbm-editor-wrap');
        const btn = el('button', 'wbm-editor-btn', EDITOR_PLACEHOLDER);
        btn.type = 'button';
        btn.dataset.role = 'editor-btn';
        const activate = (event) => {
            event.preventDefault();
            event.stopPropagation();
            requestEditorPicker();
        };
        btn.addEventListener('click', activate);
        btn.addEventListener('pointerdown', activate);
        wrap.appendChild(btn);

        if (sel.nextSibling) sel.parentNode.insertBefore(wrap, sel.nextSibling);
        else sel.parentNode.appendChild(wrap);
    }

    /* 电脑端这个下拉是 ST 自己的 select2（world-info.js:6272，只在 !isMobile() 时初始化），
       它直接吃 <optgroup>。所以分栏写进 select 本体，两端都认：
       电脑端 select2 立刻出现分组标题，手机端我们自己的面板读 sel.options 也照旧工作。
       ST 每次刷新世界书列表都会把 option 全删了重加（updateWorldInfoList），
       所以这里挂一个只盯这个 select 的 MutationObserver，被冲掉就补回来；签名没变就什么都不做。 */
    /* 分组结构是否还在：ST 刷新列表时只删 option、把空 <optgroup> 留着，
       所以光看"有没有 optgroup"会误判成还在，必须连"组里有没有东西"一起查 */
    function editorGroupsIntact(sel) {
        if (!sel) return false;
        const groups = sel.querySelectorAll('optgroup');
        if (!groups.length) return false;
        for (const group of groups) {
            if (group.children.length === 0) return false;
        }
        for (const node of sel.children) {
            if (node.tagName === 'OPTION' && String(node.value || '') !== '') return false;
        }
        return true;
    }

    function applyEditorOptgroups() {
        const sel = editorSelect();
        if (!sel) return;
        if (!enhancementsOn()) return;
        const groups = editorBookGroups();
        if (!groups.length) return;
        const sig = groups.map((g) => g.title + ':' + g.names.map((b) => b.value).join(',')).join('|');
        if (sel.dataset.wbmGroupSig === sig && editorGroupsIntact(sel)) return;

        const current = String(sel.value || '');
        const frag = document.createDocumentFragment();
        const placeholder = sel.querySelector('option[value=""]');
        if (placeholder) frag.appendChild(placeholder.cloneNode(true));
        groups.forEach((group) => {
            const og = document.createElement('optgroup');
            /* select2 只能显示一个 label 字符串，数量就拼进来，和手机端分组标题带的数字对齐 */
            og.label = group.title + ' · ' + group.names.length;
            group.names.forEach((book) => {
                const opt = document.createElement('option');
                opt.value = book.value;
                opt.textContent = book.name;
                if (book.value === current) opt.selected = true;
                og.appendChild(opt);
            });
            frag.appendChild(og);
        });
        sel.textContent = '';
        sel.appendChild(frag);
        sel.dataset.wbmGroupSig = sig;
        /* select2 的下拉是点开时才从 <select> 重建的，这里只需要让它知道内容换了 */
        try {
            if (window.jQuery && window.jQuery(sel).data('select2')) {
                window.jQuery(sel).trigger('change.select2');
            }
        } catch (err) { /* 拿不到 select2 就当没有 */ }
    }

    function watchEditorSelect() {
        const sel = editorSelect();
        if (!sel || sel.dataset.wbmObserve === '1') return;
        sel.dataset.wbmObserve = '1';
        if (typeof MutationObserver !== 'function') return;
        new MutationObserver(() => {
            /* ST 刷新列表只删 option，空 optgroup 会留下；结构一旦不完整就把签名作废重做 */
            if (!editorGroupsIntact(sel)) delete sel.dataset.wbmGroupSig;
            applyEditorOptgroups();
        }).observe(sel, { childList: true });
    }

    /* 开聊天、换角色、群组变化、世界书列表更新之后，"哪本是角色卡书 / 聊天书 / 附加书"全变了，
       但这些变化**不会改动 <select> 的 DOM**，只等 MutationObserver 会一直停在旧分组
       （实测：冷启动进 Welcome 时分出来的组只有全局+其他，点开聊天后仍然不更新）。
       所以必须靠宿主事件重算；60ms 合并一次，避免连续事件里重复计算。 */
    function bindWorldContextEvents() {
        const ctx = stCtx();
        if (!ctx || !ctx.eventSource || typeof ctx.eventSource.on !== 'function' || !ctx.eventTypes) return;
        if (window.__wbmCtxEventsBound === VERSION) return;
        window.__wbmCtxEventsBound = VERSION;
        let timer = null;
        const kick = () => {
            if (timer) clearTimeout(timer);
            timer = setTimeout(() => {
                timer = null;
                if (!enhancementsOn()) return;
                ensureCharLore().then(() => applyEditorOptgroups());
            }, 60);
        };
        ['CHAT_CHANGED', 'CHARACTER_EDITED', 'GROUP_UPDATED', 'WORLDINFO_UPDATED'].forEach((name) => {
            const evt = ctx.eventTypes[name];
            if (!evt) return;
            try { ctx.eventSource.on(evt, kick); } catch (err) { /* 不认识这个事件就跳过 */ }
        });
    }

    /* ---------------- 停用二次确认 ---------------- */

    function clearKill() {
        if (state.killTimer) { clearTimeout(state.killTimer); state.killTimer = null; }
        state.pendingKill = null;
        document.querySelectorAll('#' + ROOT_ID + ' .wbm-row.confirming').forEach((row) => {
            row.classList.remove('confirming');
            const btn = row.querySelector('.wbm-kill');
            if (btn) btn.textContent = '✕';
        });
    }

    function requestKill(name, row) {
        if (!row) return;
        if (state.pendingKill === name) {
            clearKill();
            setActive(name, false);
            toast('info', '已停用：' + name);
            return;
        }
        clearKill();
        state.pendingKill = name;
        row.classList.add('confirming');
        const btn = row.querySelector('.wbm-kill');
        if (btn) btn.textContent = '再点一次';
        state.killTimer = setTimeout(clearKill, 2600);
    }

    /* ---------------- 构建 ---------------- */

    function buildActRow(name, editing, favs) {
        const row = el('div', 'wbm-row' + (name === editing ? ' editing' : ''));
        row.dataset.name = name;
        row.dataset.role = 'jump';
        row.appendChild(el('span', 'wbm-name', name));
        if (name === editing) row.appendChild(el('span', 'wbm-hint', '编辑中'));
        const faved = !!(favs && favs.has(name));
        const star = el('button', 'wbm-star' + (faved ? ' on' : ''), faved ? '★' : '☆');
        star.type = 'button';
        star.dataset.role = 'fav';
        star.setAttribute('aria-label', faved ? '取消收藏' : '收藏');
        row.appendChild(star);
        const kill = el('button', 'wbm-kill', '✕');
        kill.type = 'button';
        kill.dataset.role = 'kill';
        row.appendChild(kill);
        return row;
    }

    function buildAddRow(name, on) {
        const row = el('div', 'wbm-addrow' + (on ? ' on' : ''));
        row.dataset.name = name;
        row.dataset.role = 'addrow';
        row.appendChild(el('span', 'wbm-addname', name));
        row.appendChild(el('span', 'wbm-addmark', on ? '✓ 已启用' : '＋'));
        return row;
    }

    /* 全部渲染、由容器高度决定看得到几行：折叠态是一个可滑动的小窗（5 行高），
       展开态是 15 行高的大窗。屏外的行由 content-visibility 跳过布局与绘制。 */
    function fillActList(list, actives, editing, favs) {
        list.textContent = '';
        actives.forEach((name) => list.appendChild(buildActRow(name, editing, favs)));
    }

    function buildAddPanel(active) {
        const panel = el('div', 'wbm-addpanel');

        const search = el('input', 'wbm-search');
        search.type = 'text';
        search.placeholder = '搜索世界书';
        search.value = state.addQuery;
        search.dataset.role = 'addsearch';
        panel.appendChild(search);

        const list = el('div', 'wbm-addlist');
        if (state.addItems.length === 0) {
            list.appendChild(el('div', 'wbm-none', '全部世界书都已启用'));
        } else {
            state.addItems.forEach((name) => list.appendChild(buildAddRow(name, active.has(name))));
        }
        panel.appendChild(list);
        return panel;
    }

    /* ---------------- 过滤（只切 display，不重绘） ---------------- */

    function applyActFilter() {
        const root = document.getElementById(ROOT_ID);
        if (!root) return;
        const q = state.actQuery.trim().toLowerCase();
        /* 搜索时把窗口撑到展开高度，否则只能在小窗里翻 */
        root.classList.toggle('searching', q !== '');
        const favs = favSet();
        const rows = root.querySelectorAll('.wbm-actives .wbm-row');
        for (let i = 0; i < rows.length; i++) {
            const raw = String(rows[i].dataset.name || '');
            const name = raw.toLowerCase();
            const hitQuery = !q || name.indexOf(q) !== -1;
            const hitFav = !state.favOnly || favs.has(raw);
            rows[i].style.display = (hitQuery && hitFav) ? '' : 'none';
        }
        const more = root.querySelector('[data-role="more"]');
        if (more) more.style.display = q ? 'none' : '';
    }

    function applyAddFilter() {
        const root = document.getElementById(ROOT_ID);
        if (!root) return;
        const q = state.addQuery.trim().toLowerCase();
        const rows = root.querySelectorAll('.wbm-addrow');
        for (let i = 0; i < rows.length; i++) {
            const name = String(rows[i].dataset.name || '').toLowerCase();
            rows[i].style.display = (!q || name.indexOf(q) !== -1) ? '' : 'none';
        }
    }

    /* ---------------- 渲染 ---------------- */

    function render() {
        try {
            renderInner();
        } catch (err) {
            /* 任何意外都退回 ST 原生控件，绝不让「原生藏了、替代品没出来」 */
            console.error('[wbm] render failed, fallback to native', err);
            const host = hostEl();
            if (host) host.removeAttribute('data-wbm-ready');
            const root = document.getElementById(ROOT_ID);
            if (root) root.remove();
            state.signature = '';
        }
    }

    function renderInner() {
        const host = hostEl();
        if (!host || !enhancementsOn()) return;

        const books = allBooks();
        const root0 = document.getElementById(ROOT_ID);

        /* 世界书列表还没 populate：不接管，保留 ST 原生控件 */
        if (books.length === 0) {
            if (root0) root0.remove();
            host.removeAttribute('data-wbm-ready');
            state.signature = '';
            return;
        }

        const active = activeSet();
        let actives = books.filter((b) => b.on).map((b) => b.name);
        const favs = favSet();
        const pin = favPinOn();
        /* 置顶只在用户明确打开时生效，稳定排序：收藏项浮到最前，其余保持酒馆原有顺序 */
        if (pin) {
            actives = actives.filter((name) => favs.has(name)).concat(actives.filter((name) => !favs.has(name)));
        }
        const editing = editingName();
        const signature = [
            actives.join('\u0001'),
            editing,
            String(books.length),
            state.expanded ? '1' : '0',
            state.addOpen ? '1' : '0',
            state.addItems.join('\u0002'),
            Array.from(favs).sort().join(''),
            pin ? '1' : '0',
            state.favOnly ? '1' : '0',
        ].join('|');

        if (signature === state.signature) {
            applyActFilter();
            applyAddFilter();
            return;
        }
        state.signature = signature;

        /* 重绘会换掉整棵 DOM，滚动位置会丢——点一下世界书就跳回顶端，误点后要重新划回来。
           这里先把两个滚动窗的位置记下来，挂载后原样还原。 */
        const prevActScroll = root0 ? (root0.querySelector('.wbm-actives') || {}).scrollTop || 0 : 0;
        const prevAddScroll = root0 ? (root0.querySelector('.wbm-addlist') || {}).scrollTop || 0 : 0;

        if (root0) root0.remove();

        const root = el('div');
        root.id = ROOT_ID;
        if (state.expanded) root.classList.add('expanded');

        /* 头部 */
        const header = el('div', 'wbm-header');
        header.appendChild(el('span', 'wbm-title', '已启用 ' + actives.length + ' 本'));
        const addBtn = el('button', 'wbm-add', state.addOpen ? '收起添加' : '＋ 添加');
        addBtn.type = 'button';
        addBtn.dataset.role = 'add';
        header.appendChild(addBtn);
        root.appendChild(header);

        /* 添加面板：只列未启用的，点一下即启用 */
        if (state.addOpen) root.appendChild(buildAddPanel(active));

        /* 已启用列表 */
        if (actives.length === 0) {
            root.appendChild(el('div', 'wbm-empty', '当前没有启用全局世界书，点「＋ 添加」'));
        } else {
            root.appendChild(el('div', 'wbm-tip', '点名称跳转编辑 · ✕ 停用'));
            /* 搜索框常驻：只要还有启用的世界书就显示，不再按数量阈值忽然冒出来 */
            const search = el('input', 'wbm-search');
            search.type = 'text';
            search.placeholder = '搜索已启用';
            search.value = state.actQuery;
            search.dataset.role = 'actsearch';
            root.appendChild(search);
            const favBar = el('div', 'wbm-favbar');
            const favOnlyBtn = el('button', 'menu_button wbm-chip' + (state.favOnly ? ' on' : ''), '★ 收藏');
            favOnlyBtn.type = 'button';
            favOnlyBtn.dataset.role = 'favonly';
            const pinBtn = el('button', 'menu_button wbm-chip' + (pin ? ' on' : ''), pin ? '收藏置顶：开' : '收藏置顶：关');
            pinBtn.type = 'button';
            pinBtn.dataset.role = 'favpin';
            favBar.appendChild(favOnlyBtn);
            favBar.appendChild(pinBtn);
            root.appendChild(attachScrollHint(favBar));
            const list = el('div', 'wbm-actives');
            fillActList(list, actives, editing, favs);
            root.appendChild(list);
            if (actives.length > COLLAPSED_COUNT) {
                const more = el('button', 'wbm-more', state.expanded ? '收起' : '展开（共 ' + actives.length + ' 本）');
                more.type = 'button';
                more.dataset.role = 'more';
                root.appendChild(more);
            }
        }

        const mount = host.querySelector('.range-block-range') || host;
        mount.appendChild(root);
        host.setAttribute('data-wbm-ready', '1');
        if (!window.__wbmLogged) {
            window.__wbmLogged = 1;
            console.info('[wbm] mounted v' + VERSION + ' build=' + BUILD + ' into', mount.className || mount.id, 'rows=' + actives.length);
        }

        applyActFilter();
        applyAddFilter();

        /* 还原滚动位置：点一下世界书（含误点启用的）不该把清单弹回顶端 */
        const actList = root.querySelector('.wbm-actives');
        const addList = root.querySelector('.wbm-addlist');
        if (actList && prevActScroll > 0) actList.scrollTop = prevActScroll;
        if (addList && prevAddScroll > 0) addList.scrollTop = prevAddScroll;
    }

    /* ---------------- 双击正文进入编辑（等同点那颗铅笔） ---------------- */

    /* 只认正文 .mes_text；思考块与各种美化折叠块不处理（折叠块自己要用双击开合）。
       返回该消息自己的铅笔按钮；条件不满足一律返回 null（静默不动作）。 */
    function msgEditButtonFor(node) {
        if (!(node instanceof Element)) return null;
        const text = node.closest('.mes_text');
        if (!text) return null;
        if (node.closest('a, button, input, textarea, details, summary, .mes_reasoning, .reasoning')) return null;
        if (node.closest('[contenteditable="true"]')) return null;
        const mes = text.closest('.mes');
        if (!mes) return null;
        if (mes.classList.contains('streaming')) return null;
        if (mes.querySelector('.edit_textarea')) return null;
        const btn = mes.querySelector('.mes_button.mes_edit');
        if (!btn) return null;
        return btn;
    }

    function enterMessageEdit(btn) {
        try { btn.click(); } catch (err) { /* 忽略 */ }
    }

    /* ---------------- 备选回复页码：接管位置 + 手机单击打开 ----------------

    酒馆的页码和右箭头同住 .swipeRightBlock（absolute、right:0 bottom:0，竖排＝页码在箭头下面）。
    美化的做法各不相同：双色盒子把它改成 row-reverse（页码到箭头左边）并给消息底部留空行；
    寰宇独奏把页码绝对定位甩到气泡右上角，用 SVG 背景图把左右箭头换成小兔子（默认透明、悬停才显形）。

    我们的做法是只挪「页码」这一个盒子，箭头一根手指都不碰，所以小兔子之类的替换图标原样保留：
    页码一律搬到 .mes 里绝对居中，消息底部补齐一条等高的空行，不与正文抢位置。
    用 body 上的类驱动，关闭开关即原样还原（搬出去的页码会被搬回原容器）。
    2026-10-20 master 定：左边/下面两档显示都错位，砍掉，只留中间。 */

    function swipeTakeoverOn() {
        return enhancementsOn() && store.swipeTakeover !== false;
    }

    /* 每个页码原本挂在哪个容器里：关掉开关时要放回去，不能留在原地 */
    const swipeCounterHome = new WeakMap();
    let swipeObserver = null;
    let swipeReapplyQueued = false;

    /* 酒馆在 #sheld 里会留多份 #chat（移屏用的克隆体尺寸为 0），getElementById 拿到的不一定是
        真正显示消息的那份。按「含 .mes 且最宽」挑，拿不到再退回 getElementById。 */
    function swipeChatRoot() {
        const all = Array.from(document.querySelectorAll('#chat'));
        let best = null;
        let bestW = -1;
        for (const el of all) {
            if (!el.querySelector('.mes')) continue;
            const w = el.getBoundingClientRect().width;
            if (w > bestW) { bestW = w; best = el; }
        }
        return best || document.getElementById('chat');
    }

    function applySwipeCounterLayout() {
        const on = swipeTakeoverOn();
        const body = document.body;
        if (!body) return;
        body.classList.toggle('wbm-swipe-on', on);
        body.classList.remove('wbm-swipe-left', 'wbm-swipe-below');
        const root = swipeChatRoot();
        if (!root) return;
        if (on) {
            root.querySelectorAll('.mes .swipes-counter').forEach(centerCounter);
        } else {
            root.querySelectorAll('.mes .swipes-counter').forEach(restoreCounter);
        }
    }

    /* 把一个页码搬进它所在的 .mes（幂等：已经在里面就只补 home 记录，一次 DOM 都不动） */
    function centerCounter(counter) {
        const mes = counter.parentElement && counter.parentElement.closest
            ? counter.parentElement.closest('.mes')
            : null;
        if (!mes) return;
        if (!swipeCounterHome.has(counter)) swipeCounterHome.set(counter, counter.parentElement);
        if (counter.parentElement === mes) return;
        mes.appendChild(counter);
    }

    function restoreCounter(counter) {
        const home = swipeCounterHome.get(counter);
        if (home && home.isConnected && counter.parentElement !== home) home.appendChild(counter);
    }

    /* 只处理新来的节点：整片扫一遍在 900 条消息的聊天里每次都是 900 次 closest，太费 */
    function handleSwipeNode(node) {
        if (!node || node.nodeType !== 1) return;
        if (!swipeTakeoverOn()) return;
        if (node.classList && node.classList.contains('swipes-counter')) {
            if (node.closest('.mes')) centerCounter(node);
            return;
        }
        if (!node.querySelectorAll) return;
        node.querySelectorAll('.mes .swipes-counter').forEach(centerCounter);
    }

    function queueSwipeLayout() {
        if (swipeReapplyQueued) return;
        swipeReapplyQueued = true;
        requestAnimationFrame(() => {
            swipeReapplyQueued = false;
            applySwipeCounterLayout();
        });
    }

    function hookSwipeLayout() {
        if (swipeObserver) return;
        const chat = swipeChatRoot();
        if (!chat) return;
        swipeObserver = new MutationObserver((records) => {
            if (!swipeTakeoverOn()) return;
            for (const record of records) {
                if (!record.addedNodes || !record.addedNodes.length) continue;
                record.addedNodes.forEach(handleSwipeNode);
            }
        });
        /* 只盯新消息进来（childList），不盯文本变化，避免酒馆更新页码时自己触发自己 */
        swipeObserver.observe(chat, { childList: true });
        applySwipeCounterLayout();
    }

    /* 单击页码打开备选列表。酒馆 1.18 在手机端只绑了长按（swipe-picker.js:426-431），
        电脑端虽然绑了 click，但页码被美化改成绝对定位/半透明后经常点不中，
        master 2026-10-20 报「电脑和手机都经常单击没用」。所以这里不依赖原始事件目标，
        统一在 pointerup 里按坐标自己找页码，找到就开窗（弹窗本身仍走原生的书签按钮）。 */
    function bindSwipeCounterTap() {
        if (window.__wbmSwipeTap === VERSION) return;
        window.__wbmSwipeTap = VERSION;
        let lastAt = 0;
        /* 我们自己开过窗之后，原生的 click 会再开一个（两层弹窗）；在捕获阶段吃掉那一下 */
        let suppressClickUntil = 0;

        document.addEventListener('click', (event) => {
            if (performance.now() > suppressClickUntil) return;
            if (!(event.target instanceof Element)) return;
            if (!event.target.closest('.swipes-counter')) return;
            event.preventDefault();
            event.stopPropagation();
        }, true);

        function counterNear(x, y, target) {
            if (target instanceof Element) {
                const direct = target.closest('.swipes-counter');
                if (direct && direct.closest('#chat')) return direct;
            }
            /* 页码半透明、美化还加过 transform，元素栈里未必直接是它：逐层看 */
            const stack = typeof document.elementsFromPoint === 'function'
                ? document.elementsFromPoint(x, y)
                : [];
            for (const el of stack) {
                if (!(el instanceof Element) || !el.closest) continue;
                const hit = el.closest('.swipes-counter');
                if (hit && hit.closest('#chat')) return hit;
            }
            /* 指尖落在气泡下沿的留白里（页码周围的 26px）也算点到：手机上尤其常见 */
            const mes = target instanceof Element && target.closest ? target.closest('.mes') : null;
            if (!mes) return null;
            const counter = mes.querySelector('.swipes-counter');
            if (!counter) return null;
            const rect = counter.getBoundingClientRect();
            if (!rect.width || !rect.height) return null;
            const dx = x - (rect.left + rect.width / 2);
            const dy = y - (rect.top + rect.height / 2);
            return Math.hypot(dx, dy) <= 26 ? counter : null;
        }

        function openFromCounter(counter) {
            if (!counter.isConnected) return false;
            if (document.querySelector('.swipe_picker_block')) return true;
            const now = performance.now();
            if (now - lastAt < 350) return true;
            const mes = counter.closest('.mes');
            const bookmark = mes && mes.querySelector('.mes_swipe_picker');
            if (!bookmark) return false;
            lastAt = now;
            suppressClickUntil = now + 600;
            counter.classList.add('wbm-tap-flash');
            setTimeout(() => counter.classList.remove('wbm-tap-flash'), 220);
            bookmark.click();
            return true;
        }

        /* pointerup 对鼠标/触屏/笔都一样，且不会被长按（触摸）抢走 */
        document.addEventListener('pointerup', (event) => {
            if (!swipeTakeoverOn()) return;
            if (typeof event.button === 'number' && event.button > 0) return;
            const counter = counterNear(event.clientX, event.clientY, event.target);
            if (!counter) return;
            openFromCounter(counter);
        }, true);

        /* 老 WebView 没有 PointerEvent 时，退回触摸判定（轻触才算，滑动/长按不动） */
        if (!window.PointerEvent) {
            let press = null;
            document.addEventListener('touchstart', (event) => {
                press = null;
                if (!swipeTakeoverOn() || !event.touches || event.touches.length !== 1) return;
                const counter = counterNear(event.touches[0].clientX, event.touches[0].clientY, event.target);
                if (!counter) return;
                const t = event.touches[0];
                press = { counter, x: t.clientX, y: t.clientY, at: performance.now() };
            }, true);
            document.addEventListener('touchmove', (event) => {
                if (!press) return;
                const t = event.touches && event.touches[0];
                if (!t) { press = null; return; }
                if (Math.hypot(t.clientX - press.x, t.clientY - press.y) > 10) press = null;
            }, true);
            document.addEventListener('touchcancel', () => { press = null; }, true);
            document.addEventListener('touchend', () => {
                const st = press;
                press = null;
                if (!st || !swipeTakeoverOn()) return;
                if (performance.now() - st.at > 350) return;
                openFromCounter(st.counter);
            }, true);
        }
    }

    /* 批量删除备选回复：酒馆原生每条备选右上有垃圾桶（swipe-picker.js 的
        .swipe_picker_delete），一次只能删一条。这里在弹窗标题栏加一个按钮，
        按「保留当前正在看的这一条、其余全删」批量点原生垃圾桶——
        删除逻辑、二次确认、保存、界面刷新全部走原生，我们不直接改数据、也不写操作历史。 */
    function bindSwipeBulkDelete() {
        if (window.__wbmBulkBound === VERSION) return;
        window.__wbmBulkBound = VERSION;
        const wait = (ms) => new Promise((r) => setTimeout(r, ms));
        let armed = false;
        let busy = false;
        let injectQueued = false;

        function pickerMessageId(header) {
            /* 2026-10-20 实测：页码输入框不在 header.parentElement 里（它在弹窗内另一层
               .text_label 中），所以旧写法取不到 id、整条删除流程直接空转。改成从整个弹窗里找，
               再退回「最后一条消息」兜底——弹窗永远是为某条消息打开的。 */
            const scope = (header && header.closest('.popup, .dialogue_popup')) || document;
            const input = scope.querySelector('input[id^="swipe_picker_id_"]')
                || document.querySelector('input[id^="swipe_picker_id_"]');
            const raw = input && input.id ? String(input.id).replace('swipe_picker_id_', '') : '';
            const direct = Number(raw);
            if (Number.isInteger(direct)) return direct;
            const last = document.querySelector('#chat .mes.last_mes');
            const fallback = Number(last && last.getAttribute('mesid'));
            return Number.isInteger(fallback) ? fallback : NaN;
        }

        function chatMessageAt(id) {
            const ctx = window.SillyTavern && window.SillyTavern.getContext ? window.SillyTavern.getContext() : null;
            return ctx && Array.isArray(ctx.chat) ? ctx.chat[id] : null;
        }

        function resetArmed(btn) {
            armed = false;
            if (!btn) return;
            btn.classList.remove('armed');
            const span = btn.querySelector('span');
            if (span) span.textContent = '批量删除';
        }

        let selectMode = false;
        let selected = new Set();
        let pickerBound = false;
        let lastPickId = -1;
        let lastPickAt = 0;

        function pickerBlocks() {
            return Array.from(document.querySelectorAll('.swipe_picker_div .swipe_picker_block'));
        }

        function pickerPopup() {
            return Array.from(document.querySelectorAll('.popup:not(.hidden), .dialogue_popup:not(.hidden)'))
                .find((p) => p.querySelector('.swipe_picker_div, .swipe_picker_block')) || null;
        }

        function currentSwipeId() {
            const header = pickerPopup() && pickerPopup().querySelector('.swipe_picker_header');
            const messageId = header ? pickerMessageId(header) : NaN;
            const message = Number.isInteger(messageId) ? chatMessageAt(messageId) : null;
            return message ? Number(message.swipe_id ?? 0) : 0;
        }

        function paintButton(btn) {
            if (!btn) return;
            const span = btn.querySelector('span');
            const icon = btn.querySelector('i');
            if (!selectMode) {
                btn.classList.remove('armed');
                if (icon) icon.className = 'fa-solid fa-list-check';
                if (span) span.textContent = '\u6279\u91cf\u5220\u9664';
                return;
            }
            btn.classList.toggle('armed', selected.size > 0);
            if (icon) icon.className = selected.size > 0 ? 'fa-solid fa-trash-can' : 'fa-solid fa-xmark';
            if (span) span.textContent = selected.size > 0
                ? '\u5220\u9664\u5df2\u9009 ' + selected.size + ' \u6761'
                : '\u9000\u51fa\u9009\u62e9';
        }

        function syncPicks() {
            const alive = new Set(pickerBlocks().map(function (b) { return Number(b.getAttribute('data-swipe-id')); }));
            Array.from(selected).forEach(function (id) { if (!alive.has(id)) selected.delete(id); });
            pickerBlocks().forEach((block) => {
                const id = Number(block.getAttribute('data-swipe-id'));
                const pick = block.querySelector('.wbm-swipe-pick');
                if (!pick) return;
                pick.classList.toggle('checked', selected.has(id));
                pick.setAttribute('aria-checked', String(selected.has(id)));
                block.classList.toggle('wbm-picked', selected.has(id));
            });
            const btn = document.querySelector('.wbm-swipe-bulk');
            paintButton(btn);
        }

        function togglePick(id) {
            if (selected.has(id)) selected.delete(id);
            else selected.add(id);
            syncPicks();
        }

        function enterSelect(btn) {
            selectMode = true;
            /* 2026-10-20 master 反馈：默认全选太危险（一点就删掉一堆），进来一律是空的，
                要删哪几条就自己勾哪几条；「全选」「清空」放在标题栏，想省事也能一键。 */
            selected = new Set();
            pickerBlocks().forEach((block) => {
                block.classList.add('wbm-select-on');
                if (!block.querySelector('.wbm-swipe-pick')) {
                    const pick = document.createElement('span');
                    pick.className = 'wbm-swipe-pick';
                    pick.setAttribute('role', 'checkbox');
                    pick.setAttribute('aria-checked', 'false');
                    pick.innerHTML = '<i class="fa-solid fa-check"></i>';
                    block.prepend(pick);
                }
            });
            paintButton(btn);
            ensureSelectTools(true);
            syncPicks();
        }

        function selectAll() {
            selected = new Set(pickerBlocks().map((b) => Number(b.getAttribute('data-swipe-id'))));
            syncPicks();
        }

        function exitSelect(btn) {
            selectMode = false;
            selected = new Set();
            pickerBlocks().forEach((block) => {
                block.classList.remove('wbm-select-on', 'wbm-picked');
                const pick = block.querySelector('.wbm-swipe-pick');
                if (pick) pick.remove();
            });
            paintButton(btn);
            ensureSelectTools(false);
        }

        /* 2026-10-20 master 报：关掉弹窗（或点页码 go 跳到另一条）再打开，「批量删除」文字回来了、
           但内部还在选择态，一点就直接弹「是否删除选择的 4 条」。这里把选择态彻底清掉：
           弹窗每次重新出现、以及弹窗消失时都调一次。 */
        function resetSelect() {
            selectMode = false;
            selected = new Set();
            armed = false;
            const tools = document.querySelector('.wbm-swipe-tools');
            if (tools) tools.remove();
            document.querySelectorAll('.wbm-swipe-pick').forEach(function (node) { node.remove(); });
            document.querySelectorAll('.swipe_picker_block').forEach(function (block) {
                block.classList.remove('wbm-select-on', 'wbm-picked');
            });
            const btn = document.querySelector('.wbm-swipe-bulk');
            if (btn) {
                btn.classList.remove('armed', 'wbm-busy');
                paintButton(btn);
            }
        }

                /* 标题栏上的「全选 / 清空」：只在选择模式里出现，退出即摘掉 */
        function ensureSelectTools(on) {
            const header = document.querySelector('.wbm-swipe-header');
            if (!header) return;
            const right = header.querySelector('.wbm-swipe-right') || header;
            const old = header.querySelector('.wbm-swipe-tools');
            if (!on) {
                if (old) old.remove();
                return;
            }
            if (old) return;
            const tools = document.createElement('div');
            tools.className = 'wbm-swipe-tools';
            tools.innerHTML = '<span class="wbm-swipe-tool" data-role="all">全选</span><span class="wbm-swipe-tool" data-role="none">清空</span>';
            tools.addEventListener('click', (event) => {
                const target = event.target;
                if (!(target instanceof Element)) return;
                const role = target.getAttribute('data-role');
                if (!role) return;
                event.preventDefault();
                event.stopPropagation();
                if (role === 'all') selectAll();
                else {
                    selected = new Set();
                    syncPicks();
                }
            });
            const closeBtn = right.querySelector('.popup-button-close');
            if (closeBtn) right.insertBefore(tools, closeBtn);
            else right.appendChild(tools);
        }

        /* 选择模式下点条目本身＝勾选/取消勾选，不再切到那条备选 */
        function guardBlockClicks() {
            if (pickerBound) return;
            pickerBound = true;
            document.addEventListener('click', (event) => {
                if (!selectMode) return;
                const target = event.target;
                if (!(target instanceof Element)) return;
                const header = document.querySelector('.swipe_picker_header');
                if (!header) return;
                if (target.closest('.wbm-swipe-bulk, .popup-button-close, .popup-button-cancel, .popup-button-ok')) return;
                if (target.closest('.swipe_picker_delete, .swipe_picker_branch, .swipe_picker_copy, .swipe_picker_expand_label, .swipe_picker_expand_toggle')) return;
                const block = target.closest('.swipe_picker_block');
                if (!block) return;
                const blockId = Number(block.getAttribute('data-swipe-id'));
                event.preventDefault();
                event.stopPropagation();
                /* 双击会连发两次 click：第二次不再切换，否则刚勾上又被取消 */
                const now = performance.now();
                if (blockId === lastPickId && now - lastPickAt < 350) return;
                lastPickId = blockId;
                lastPickAt = now;
                togglePick(blockId);
            }, true);
        }

        async function closePicker() {
            const dialog = pickerPopup();
            if (!dialog) return;
            const close = dialog.querySelector('.popup-button-close')
                || dialog.querySelector('.popup-button-cancel')
                || dialog.querySelector('.popup-button-ok');
            if (close) close.click();
            for (let i = 0; i < 20 && pickerBlocks().length; i++) await wait(50);
        }

        /* 二次确认：走酒馆自己的弹窗样式，标题栏一致、手机上也好点 */
        /* 2026-10-20 master 报：选择模式里不小心双击会直接跳到那条备选。
           原生只挡了 click，dblclick 仍会落到条目上，这里一并吃掉。 */
        function guardBlockDbl(event) {
            if (!selectMode) return;
            const target = event.target;
            if (!(target instanceof Element)) return;
            if (target.closest('.wbm-swipe-bulk, .wbm-swipe-tool, .popup-button-close, .popup-button-cancel, .popup-button-ok')) return;
            if (!target.closest('.swipe_picker_block')) return;
            event.preventDefault();
            event.stopPropagation();
        }
        document.addEventListener('dblclick', guardBlockDbl, true);

        async function confirmDelete(count) {
            const ctx = window.SillyTavern && window.SillyTavern.getContext ? window.SillyTavern.getContext() : null;
            const text = '确定删除已选的 ' + count + ' 条备选回复？删除后无法恢复。';
            if (ctx && typeof ctx.callGenericPopup === 'function' && ctx.POPUP_TYPE) {
                try {
                    const result = await ctx.callGenericPopup(text, ctx.POPUP_TYPE.CONFIRM, '', {
                        okButton: '删除',
                        cancelButton: '取消',
                    });
                    const pr = ctx.POPUP_RESULT || {};
                    return result === pr.AFFIRMATIVE || result === true;
                } catch (err) {
                    console.warn('[wbm] 确认弹窗失败，退回原生 confirm：', err);
                }
            }
            return window.confirm(text);
        }

        /* 一次改完再存一次：以前是逐条点原生垃圾桶，每点一次都要重绘整个弹窗 + 出一条读条，
            60 条要等十几秒，中途碰屏幕还会打断（master 2026-10-20 报的）。 */
        async function runBulk(btn, header) {
            const ctx = window.SillyTavern && window.SillyTavern.getContext ? window.SillyTavern.getContext() : null;
            const messageId = pickerMessageId(header);
            const message = chatMessageAt(messageId);
            if (!message || !Array.isArray(message.swipes)) { exitSelect(btn); return; }
            const total = message.swipes.length;
            const targets = Array.from(selected)
                .filter((i) => Number.isInteger(i) && i >= 0 && i < total)
                .sort((a, b) => b - a);
            if (!targets.length) { exitSelect(btn); return; }
            if (targets.length >= total) {
                toast('warning', '至少要保留一条备选回复');
                return;
            }
            const go = await confirmDelete(targets.length);
            if (!go) return;

            busy = true;
            btn.classList.add('wbm-busy');
            const span = btn.querySelector('span');
            if (span) span.textContent = '正在删除…';

            const swipes = message.swipes.slice();
            const infos = Array.isArray(message.swipe_info) ? message.swipe_info.slice() : [];
            const drop = new Set(targets);
            const keepId = Number(message.swipe_id ?? 0);
            const nextSwipes = [];
            const nextInfos = [];
            let nextId = -1;
            for (let i = 0; i < swipes.length; i++) {
                if (drop.has(i)) continue;
                if (i === keepId) nextId = nextSwipes.length;
                nextSwipes.push(swipes[i]);
                if (infos.length) nextInfos.push(infos[i] || {});
            }
            /* 当前这条被删掉时（master 2026-10-20 要求）落到剩下的最新一条 */
        if (nextId < 0) nextId = nextSwipes.length - 1;
        if (!nextSwipes.length) {
                busy = false;
                btn.classList.remove('wbm-busy');
                exitSelect(btn);
                toast('warning', '至少要保留一条备选回复');
                return;
            }

            message.swipes = nextSwipes;
            if (infos.length) message.swipe_info = nextInfos;
            else delete message.swipe_info;
            message.swipe_id = nextId;
            message.mes = nextSwipes[nextId];

            exitSelect(btn);
            await closePicker();
            try {
                if (ctx && typeof ctx.saveChat === 'function') await ctx.saveChat();
                if (ctx && typeof ctx.printMessages === 'function') await ctx.printMessages();
            } catch (err) {
                console.warn('[wbm] 保存删除结果失败：', err);
            }
            busy = false;
            btn.classList.remove('wbm-busy');
            toast('info', '已删除 ' + targets.length + ' 条备选回复，剩 ' + nextSwipes.length + ' 条');
        }

        function inject(header) {
            if (!header || header.querySelector('.wbm-swipe-bulk')) return;
            /* 新弹窗一定是干净状态：上一个弹窗的选择态不能带过来 */
            if (selectMode || selected.size) resetSelect();
            header.classList.add('wbm-swipe-header');
            /* 关闭键搬进我们自己的右侧容器：这样标题栏是「标题 | 居中按钮 | 右侧一组」的
                真三栏，按钮不会压到弹窗标题栏下面的那条分隔线。关闭键的事件绑在元素本身上，
                换父节点不影响（popup.js:256 直接 querySelector 拿元素后 addEventListener）。 */
            let right = header.querySelector('.wbm-swipe-right');
            if (!right) {
                right = document.createElement('div');
                right.className = 'wbm-swipe-right';
                header.appendChild(right);
            }
            const closeBtn = header.querySelector('.popup-button-close');
            if (closeBtn && closeBtn.parentElement !== right) right.appendChild(closeBtn);
            const btn = document.createElement('div');
            btn.className = 'wbm-swipe-bulk';
            btn.setAttribute('role', 'button');
            btn.innerHTML = '<i class="fa-solid fa-list-check"></i><span>\u6279\u91cf\u5220\u9664</span>';
            btn.addEventListener('click', (event) => {
                event.preventDefault();
                event.stopPropagation();
                if (busy) return;
                const messageId = pickerMessageId(header);
                const message = chatMessageAt(messageId);
                const total = message && Array.isArray(message.swipes) ? message.swipes.length : 0;
                /* 弹窗一直开着、用页码 go 跳到另一条时，条目会被重建，勾选框随之消失；
               这时如果还处在选择态，selected 里就是旧索引，按下去会删错条目。
               没有勾选框就当作没在选择，重新从头进入选择态。 */
            if (selectMode && !document.querySelectorAll('.wbm-swipe-pick').length) {
                selectMode = false;
                selected = new Set();
            }
            if (total < 2) {
                    toast('info', '\u8fd9\u6761\u6d88\u606f\u53ea\u6709\u4e00\u6761\u5907\u9009\u56de\u590d');
                    return;
                }
                if (!selectMode) {
                    enterSelect(btn);
                    return;
                }
                if (!selected.size) {
                    exitSelect(btn);
                    return;
                }
                runBulk(btn, header);
            });
            header.appendChild(btn);
        }

        guardBlockClicks();

        /* 弹窗开着时用页码 go 跳转，条目会被整段重建、勾选框随之消失。
           盯住条目容器：一旦勾选框没了就当退出选择态，按钮文字也跟着复原。 */
        let blocksObserver = null;
        let blocksWatched = null;
        function ensureBlocksWatch() {
            const div = pickerPopup() && pickerPopup().querySelector('.swipe_picker_div');
            if (!div || div === blocksWatched) return;
            if (blocksObserver) blocksObserver.disconnect();
            blocksWatched = div;
            blocksObserver = new MutationObserver(() => {
                if (selectMode && !document.querySelectorAll('.wbm-swipe-pick').length) resetSelect();
            });
            blocksObserver.observe(div, { childList: true });
        }

        function scan() {
            injectQueued = false;
            const header = document.querySelector('.popup:not(.hidden) .swipe_picker_header, .dialogue_popup:not(.hidden) .swipe_picker_header');
            if (header) { inject(header); ensureBlocksWatch(); }
            else if (selectMode || selected.size) resetSelect();
        }

        function queueScan() {
            if (injectQueued) return;
            injectQueued = true;
            requestAnimationFrame(scan);
        }

        /* 只观 body 的结构变化；有弹窗时才真正查一次标题栏，聊天流式输出不会走进 inject。 */
        const observer = new MutationObserver((records) => {
            for (const r of records) {
                if (r.addedNodes && r.addedNodes.length) { queueScan(); return; }
            }
        });
        observer.observe(document.body, { childList: true, subtree: true });
        queueScan();
    }

    /* ================= ⑧ 前端卡漏渲染守护（1.3.52）=================
   酒馆助手（JS-Slash-Runner）把消息里的整页 HTML 包成 div.TH-render + iframe 显示，
   它的重建全靠宿主事件；偶尔会漏掉一条，消息正文停在 <pre><code> 的代码块，刷新才恢复。
   这里只查不画：发现「该显示却没显示」就替它补发一次重建事件，渲染仍由酒馆助手做，
   我们不碰 .mes_text 的内容，也不自己造 iframe。 */

    const frontendGuardTries = new Map();
    let frontendGuardChat = '';
    let frontendGuardAt = 0;
    let frontendGuardTimer = 0;
    let frontendGuardRetry = 0;
    let frontendGuardRunning = false;

    function tavernHelperRender() {
        try {
            const ctx = stCtx();
            const th = ctx && ctx.extensionSettings && ctx.extensionSettings.tavern_helper;
            const render = th && th.render;
            return render && render.enabled !== false ? render : null;
        } catch (err) {
            return null;
        }
    }

    function looksLikeFrontendCard(textNode) {
        if (!textNode) return false;
        if (textNode.querySelector('.TH-render, iframe')) return false;
        const pre = textNode.querySelector('pre');
        if (!pre) return false;
        return /(html>|<head[ >]|<body[ >])/i.test(pre.textContent || '');
    }

    /* 每条消息最多试三次：1＝「消息被编辑」（温和，只让酒馆助手重建这一条），
       2＝「消息刚渲染完」（兜底，1.3.52 实测有的情况下第一条路会连包裹层一起摘掉），
       3 之后就放手，不再反复打扰。 */
    async function ensureFrontendCardsRendered() {
        if (!featureOn('frontendGuard')) return 0;
        if (!tavernHelperRender()) return 0;
        if (!document.getElementById('tavern_helper')) return 0;
        if (frontendGuardRunning) return 0;
        const ctx = stCtx();
        if (!ctx || !ctx.eventSource || !ctx.eventTypes) return 0;
        if (!ctx.eventTypes.MESSAGE_EDITED || !ctx.eventTypes.CHARACTER_MESSAGE_RENDERED) return 0;
        const chat = Array.isArray(ctx.chat) ? ctx.chat : [];
        const chatKey = String(ctx.chatId || '') + '#' + chat.length;
        if (chatKey !== frontendGuardChat) { frontendGuardChat = chatKey; frontendGuardTries.clear(); }
        const now = Date.now();
        if (now - frontendGuardAt < 1500) return 0;
        const depth = Number(tavernHelperRender().depth) || 0;
        const minId = depth > 0 ? Math.max(0, chat.length - depth) : 0;
        frontendGuardRunning = true;
        try {
            const nodes = document.querySelectorAll('#chat .mes');
            for (const mes of nodes) {
                const id = Number(mes.getAttribute('mesid'));
                if (!Number.isFinite(id) || id < minId) continue;
                if (!looksLikeFrontendCard(mes.querySelector('.mes_text'))) continue;
                const tries = frontendGuardTries.get(id) || 0;
                if (tries >= 3) continue;
                frontendGuardTries.set(id, tries + 1);
                frontendGuardAt = now;
                if (tries === 0) {
                    console.info('[wbm] 第 ' + id + ' 条该显示前端卡却没显示，请酒馆助手重建');
                    await ctx.eventSource.emit(ctx.eventTypes.MESSAGE_EDITED, id);
                    clearTimeout(frontendGuardRetry);
                    frontendGuardRetry = setTimeout(() => { ensureFrontendCardsRendered().catch(() => {}); }, 2500);
                } else {
                    console.info('[wbm] 第 ' + id + ' 条仍未重建，改用渲染事件再试一次');
                    await ctx.eventSource.emit(ctx.eventTypes.CHARACTER_MESSAGE_RENDERED, id, 'wbm-guard');
                }
                return 1;
            }
        } catch (err) {
            console.warn('[wbm] 补渲染失败', err);
        } finally {
            frontendGuardRunning = false;
        }
        return 0;
    }

    function bindFrontendCardGuard() {
        const ctx = stCtx();
        if (!ctx || !ctx.eventSource || !ctx.eventTypes) return;
        if (window.__wbmFrontendGuardBound === VERSION) return;
        window.__wbmFrontendGuardBound = VERSION;
        const schedule = () => {
            if (!featureOn('frontendGuard')) return;
            clearTimeout(frontendGuardTimer);
            frontendGuardTimer = setTimeout(() => { ensureFrontendCardsRendered().catch(() => {}); }, 5000);
        };
        ['CHARACTER_MESSAGE_RENDERED', 'CHAT_CHANGED', 'MESSAGE_SWIPED', 'GENERATION_ENDED'].forEach((name) => {
            const type = ctx.eventTypes[name];
            if (!type) return;
            try { ctx.eventSource.on(type, schedule); } catch (err) { /* 宿主没这个事件就跳过 */ }
        });
        schedule();
    }

    /* ================= ② 对话补全预设：搜索 + 分组 + 删除 =================
   ST 原生的预设下拉只能一行行翻，几十个预设很难找；这里在它旁边加一个「搜索」按钮，
   窗口里按分组列出来，支持改名分组、两步确认删除。预设本身仍是 ST 的那一套
   （#settings_preset_openai + data-preset-manager-*），我们只做入口，不另存数据。 */

function talkPresetSelect() {
    const sel = document.getElementById('settings_preset_openai');
    return sel instanceof HTMLSelectElement ? sel : null;
}

function talkPresetGroups() {
    if (!store.talkPresetGroups || typeof store.talkPresetGroups !== 'object') store.talkPresetGroups = {};
    return store.talkPresetGroups;
}

function talkPresetNames(sel) {
    return Array.from(sel.options).map((o) => String(o.textContent || '').trim()).filter((v) => !!v);
}

function talkPresetValue(name) {
    const sel = talkPresetSelect();
    if (!sel) return '';
    const hit = Array.from(sel.options).find((o) => String(o.textContent || '').trim() === name);
    return hit ? hit.value : '';
}

function talkPresetCurrentName() {
    const sel = talkPresetSelect();
    if (!sel) return '';
    const opt = sel.options[sel.selectedIndex];
    return opt ? String(opt.textContent || '').trim() : '';
}

function applyTalkPreset(name) {
    const sel = talkPresetSelect();
    if (!sel || !name) return false;
    const value = talkPresetValue(name);
    if (value === '') return false;
    sel.value = value;
    fireChange(sel);
    return true;
}

function ensureTalkPresetButton() {
    if (!featureOn('talkPreset')) {
        const old = document.getElementById('wbm-talk-preset-btn');
        if (old) old.remove();
        return;
    }
    const sel = talkPresetSelect();
    if (!sel) return;
    if (document.getElementById('wbm-talk-preset-btn')) return;
    const btn = el('button', 'menu_button wbm-talk-preset-btn');
    btn.type = 'button';
    btn.id = 'wbm-talk-preset-btn';
    btn.title = '搜索 / 分组 / 删除对话补全预设';
    btn.appendChild(el('i', 'fa-solid fa-sliders'));
    btn.appendChild(el('span', 'wbm-talk-preset-btn-text', '管理'));
    btn.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        console.info('[wbm] talk preset button clicked');
        openTalkPresetPicker();
    });
    sel.insertAdjacentElement('afterend', btn);
}

function openTalkPresetPicker() {
    const sel = talkPresetSelect();
    if (!sel) return;
    closeEditorPicker(true);
    console.info('[wbm] talk preset picker open, options=' + sel.options.length);
    const groups = talkPresetGroups();
    const current = talkPresetCurrentName();
    let names = talkPresetNames(sel);

    let shell;
    try {
        shell = makePickerShell();
    } catch (err) {
        console.error('[wbm] talk preset shell failed', err);
        return;
    }
    console.info('[wbm] talk preset shell ok ' + !!shell);
    const { mask, sheet } = shell;
    const grip = el('div', 'wbm-picker-grip');
    const { head, input } = buildPickerHead('搜索预设名');
    const titleRow = el('div', 'wbm-picker-titlerow');
    const title = el('div', 'wbm-picker-title', '对话补全预设（当前：' + (current || '—') + '）');
    const batchBtn = el('button', 'wbm-preset-tool wbm-talk-batch-btn', '批量…');
    batchBtn.type = 'button';
    titleRow.appendChild(title);
    titleRow.appendChild(batchBtn);
    const list = el('div', 'wbm-picker-list');
    /* 批量模式的操作条：已选 N 个 | 全选 | 清空 | 分组 | 删除 | 退出 */
    const batchBar = el('div', 'wbm-talk-batchbar');
    batchBar.hidden = true;
    const batchCount = el('span', 'wbm-talk-batch-count', '');
    const mkBarBtn = (text, cls) => {
        const b = el('button', 'wbm-preset-tool' + (cls ? ' ' + cls : ''), text);
        b.type = 'button';
        batchBar.appendChild(b);
        return b;
    };
    batchBar.appendChild(batchCount);
    const allBtn = mkBarBtn('全选');
    const noneBtn = mkBarBtn('清空');
    const groupAllBtn = mkBarBtn('分组');
    const delAllBtn = mkBarBtn('删除');
    const exitBtn = mkBarBtn('退出', 'wbm-talk-batch-exit');
    /* 批量分组时填一次组名，一次套到所有已选行 */
    const batchGroupRow = el('div', 'wbm-picker-row wbm-talk-batch-grouprow');
    batchGroupRow.hidden = true;
    const batchGroupInput = el('input', 'wbm-name-input-inline');
    batchGroupInput.type = 'text';
    batchGroupInput.placeholder = '组名（留空＝移出分组）';
    const batchGroupOk = el('button', 'wbm-picker-action primary', '确定');
    batchGroupOk.type = 'button';
    const batchGroupCancel = el('button', 'wbm-picker-action', '取消');
    batchGroupCancel.type = 'button';
    batchGroupRow.appendChild(batchGroupInput);
    batchGroupRow.appendChild(batchGroupOk);
    batchGroupRow.appendChild(batchGroupCancel);
    sheet.appendChild(grip);
    sheet.appendChild(head);
    sheet.appendChild(titleRow);
    sheet.appendChild(batchBar);
    sheet.appendChild(batchGroupRow);
    sheet.appendChild(list);

    let delArm = '';
    let selectMode = false;
    const picked = new Set();
    /* 分组默认折叠，只展开「当前预设」所在的那一组（master 2026-10-21 要求）。
       初始化延后到首次渲染：groupOf 定义在更下面，此处直接调用会 ReferenceError。 */
    const collapsedGroups = new Set();
    let collapsedReady = false;

    const pickedInView = () => names.filter((n) => picked.has(n));

    const syncBatchBar = () => {
        batchBar.hidden = !selectMode;
        batchGroupRow.hidden = !selectMode || batchGroupRow.dataset.open !== '1';
        titleRow.hidden = selectMode;
        const count = picked.size;
        batchCount.textContent = '已选 ' + count + ' 个';
        for (const b of [groupAllBtn, delAllBtn]) {
            b.classList.toggle('wbm-busy', count === 0);
        }
        delAllBtn.textContent = count ? '删除 ' + count + ' 个' : '删除';
    };

    const enterBatch = () => {
        selectMode = true;
        collapsedGroups.clear();
        /* 危险操作默认一条都不选（master 2026-10-20 定过的规矩） */
        picked.clear();
        syncBatchBar();
        renderRows(input.value);
    };

    const exitBatch = () => {
        selectMode = false;
        picked.clear();
        batchGroupRow.dataset.open = '';
        syncBatchBar();
        /* 退出批量后回到默认折叠（只展开当前预设那组），否则一手滑就摊开 88 行 */
        collapsedGroups.clear();
        collapsedReady = false;
        renderRows(input.value);
    };

    const groupOf = (name) => String(groups[name] || '').trim();

    const renderRows = (query) => {
        list.innerHTML = '';
        if (!collapsedReady) {
            collapsedReady = true;
            const currentGroup = groupOf(current);
            for (const n of names) {
                if (groupOf(n) !== currentGroup) collapsedGroups.add(groupOf(n));
            }
        }
        const keyword = String(query || '').trim().toLowerCase();
        const rows = names
            .filter((name) => !keyword || String(name).toLowerCase().includes(keyword) || groupOf(name).toLowerCase().includes(keyword))
            .sort((a, b) => {
                const ga = groupOf(a) || '\uffff未分组';
                const gb = groupOf(b) || '\uffff未分组';
                return ga === gb ? String(a).localeCompare(String(b), 'zh-Hans-CN') : String(ga).localeCompare(String(gb), 'zh-Hans-CN');
            });
        let lastGroup = null;
        let bucket = null;
        const isOpen = (group) => {
            if (keyword) return true;        /* 搜索时全部摊开，否则搜到的东西藏在折叠里 */
            if (selectMode) return true;     /* 批量勾选时也要看得见 */
            return !collapsedGroups.has(group);
        };
        rows.forEach((name) => {
            const group = groupOf(name);
            if (group !== lastGroup) {
                lastGroup = group;
                const open = isOpen(group);
                const head = el('div', 'wbm-picker-group-label wbm-talk-group-toggle');
                head.dataset.group = group || '';
                head.appendChild(el('i', 'fa-solid ' + (open ? 'fa-caret-down' : 'fa-caret-right')));
                head.appendChild(el('span', 'wbm-talk-group-name', group || '未分组'));
                const total = rows.filter((n) => groupOf(n) === group).length;
                head.appendChild(el('span', 'wbm-talk-group-count', String(total)));
                head.addEventListener('click', (event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    if (keyword) return;
                    const key = head.dataset.group;
                    if (collapsedGroups.has(key)) collapsedGroups.delete(key);
                    else collapsedGroups.add(key);
                    renderRows(input.value);
                });
                list.appendChild(head);
                bucket = el('div', 'wbm-talk-group-body');
                bucket.hidden = !open;
                list.appendChild(bucket);
            }
            const row = el('div', 'wbm-picker-row wbm-talk-preset-row');
            if (name === current) row.classList.add('active');
            if (selectMode && picked.has(name)) row.classList.add('wbm-picked');
            row.dataset.name = name;
            if (selectMode) {
                const pick = el('span', 'wbm-swipe-pick' + (picked.has(name) ? ' checked' : ''));
                pick.appendChild(el('i', 'fa-solid fa-check'));
                row.appendChild(pick);
            }
            row.appendChild(el('span', 'wbm-picker-name', name === current ? name + '（当前）' : name));

            const tools = el('div', 'wbm-preset-tools');
            const groupBtn = el('button', 'wbm-preset-tool', '分组');
            groupBtn.type = 'button';
            groupBtn.addEventListener('click', (event) => {
                event.preventDefault();
                event.stopPropagation();
                startGroupEdit(row, name);
            });
            const delBtn = el('button', 'wbm-preset-tool' + (delArm === name ? ' armed' : ''), delArm === name ? '确认删除' : '删除');
            delBtn.type = 'button';
            delBtn.addEventListener('click', (event) => {
                event.preventDefault();
                event.stopPropagation();
                if (delArm !== name) {
                    delArm = name;
                    renderRows(input.value);
                    return;
                }
                delArm = '';
                deleteTalkPreset(name);
            });
            tools.appendChild(groupBtn);
            tools.appendChild(delBtn);
            row.appendChild(tools);

            row.addEventListener('click', (event) => {
                if (event.target.closest('.wbm-preset-tools') || event.target.closest('input')) return;
                if (selectMode) {
                    if (picked.has(name)) picked.delete(name);
                    else picked.add(name);
                    syncBatchBar();
                    renderRows(input.value);
                    return;
                }
                applyTalkPreset(name);
                closeEditorPicker();
                toast('ok', '已切换到预设「' + name + '」');
            });
            (bucket || list).appendChild(row);
        });
        if (!rows.length) list.appendChild(el('div', 'wbm-picker-empty', '没有匹配的预设'));
    };

    const startGroupEdit = (row, name) => {
        row.innerHTML = '';
        const field = el('input', 'wbm-name-input-inline');
        field.type = 'text';
        field.value = groupOf(name);
        field.placeholder = '分组名（留空＝未分组）';
        field.dataset.role = 'talk-group-name';
        const ok = el('button', 'wbm-picker-action primary', '确定');
        ok.type = 'button';
        const cancel = el('button', 'wbm-picker-action', '取消');
        cancel.type = 'button';
        const commit = () => {
            const value = String(field.value || '').trim();
            const map = talkPresetGroups();
            if (value) map[name] = value;
            else delete map[name];
            persistStore();
            /* 就地重画、窗口保持打开：分组往往要连着给好几行做，
               关掉再打开会丢掉搜索词与滚动位置（master 2026-10-22 指出） */
            const keepTop = list.scrollTop;
            collapsedGroups.delete(value);
            renderRows(input.value);
            list.scrollTop = keepTop;
            toast('info', value ? '「' + name + '」已归到「' + value + '」' : '「' + name + '」已移出分组');
        };
        ok.addEventListener('click', (event) => { event.preventDefault(); event.stopPropagation(); commit(); });
        cancel.addEventListener('click', (event) => { event.preventDefault(); event.stopPropagation(); renderRows(input.value); });
        field.addEventListener('keydown', (event) => {
            if (event.key === 'Enter') { event.preventDefault(); commit(); }
            if (event.key === 'Escape') { event.preventDefault(); renderRows(input.value); }
        });
        row.appendChild(el('span', 'wbm-picker-name', name + ' →'));
        row.appendChild(field);
        row.appendChild(ok);
        row.appendChild(cancel);
        setTimeout(() => field.focus(), 30);
    };

    /* 删一个预设文件，并把宿主下拉里的同名 option 摘掉（批量删除也走这里）。
       返回 true 表示服务器确实删掉了。 */
    const removePresetFile = async (name) => {
        const ctx = SillyTavern.getContext();
        try {
            const res = await fetch('/api/presets/delete', {
                method: 'POST',
                headers: ctx.getRequestHeaders(),
                body: JSON.stringify({ apiId: 'openai', name }),
            });
            if (!res.ok) throw new Error('HTTP ' + res.status);
        } catch (err) {
            console.error('[wbm] 删除预设失败', name, err);
            return false;
        }
        const list = talkPresetSelect();
        if (list) {
            const opt = Array.from(list.options).find((o) => String(o.textContent || '').trim() === name);
            if (opt) {
                const wasSelected = opt.selected;
                opt.remove();
                if (wasSelected && list.options.length) {
                    list.selectedIndex = 0;
                    list.dispatchEvent(new Event('change', { bubbles: true }));
                }
            }
        }
        return true;
    };

    const deleteTalkPreset = async (name) => {
        /* 同样保持窗口打开：删完一个接着删下一个，不用重新找入口 */
        const keepTop = list.scrollTop;
        const ok = await removePresetFile(name);
        if (!ok) {
            toast('err', '删除预设「' + name + '」失败，请刷新后再试');
            return;
        }
        delete talkPresetGroups()[name];
        persistStore();
        const hostSel = talkPresetSelect();
        if (hostSel) names = talkPresetNames(hostSel);
        picked.delete(name);
        renderRows(input.value);
        list.scrollTop = keepTop;
        toast('ok', '已删除预设「' + name + '」');
    };

    batchBtn.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        if (selectMode) exitBatch();
        else enterBatch();
    });
    allBtn.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        for (const n of names) picked.add(n);
        syncBatchBar();
        renderRows(input.value);
    });
    noneBtn.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        picked.clear();
        syncBatchBar();
        renderRows(input.value);
    });
    exitBtn.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        exitBatch();
    });
    groupAllBtn.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        if (!picked.size) { toast('info', '先勾选要分组的预设'); return; }
        const open = batchGroupRow.dataset.open === '1';
        batchGroupRow.dataset.open = open ? '' : '1';
        batchGroupInput.value = open ? '' : groupOf(names.find((n) => picked.has(n)) || '');
        syncBatchBar();
        if (!open) setTimeout(() => batchGroupInput.focus(), 30);
    });
    batchGroupCancel.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        batchGroupRow.dataset.open = '';
        syncBatchBar();
    });
    batchGroupOk.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        const value = String(batchGroupInput.value || '').trim();
        const map = talkPresetGroups();
        let n = 0;
        for (const name of picked) {
            if (value) map[name] = value;
            else delete map[name];
            n += 1;
        }
        persistStore();
        batchGroupRow.dataset.open = '';
        toast('ok', value ? '已把 ' + n + ' 个预设移到「' + value + '」' : '已把 ' + n + ' 个预设移出分组');
        exitBatch();
    });
    batchGroupInput.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') { event.preventDefault(); batchGroupOk.click(); }
        if (event.key === 'Escape') { event.preventDefault(); batchGroupCancel.click(); }
    });
    delAllBtn.addEventListener('click', async (event) => {
        event.preventDefault();
        event.stopPropagation();
        const targets = pickedInView();
        if (!targets.length) { toast('info', '先勾选要删除的预设'); return; }
        if (targets.length >= names.length) { toast('warning', '至少要保留一个预设'); return; }
        delAllBtn.classList.add('wbm-busy');
        try {
            const ctx = SillyTavern.getContext();
            const go = await ctx.callGenericPopup(
                '删除已选的 ' + targets.length + ' 个预设？删除后无法恢复。',
                ctx.POPUP_TYPE.CONFIRM, '', { okButton: '删除', cancelButton: '取消' });
            if (go !== ctx.POPUP_RESULT.AFFIRMATIVE) return;
            let okCount = 0;
            const failed = [];
            for (const name of targets) {
                const ok = await removePresetFile(name);
                if (ok) okCount += 1;
                else failed.push(name);
            }
            toast(failed.length ? 'warning' : 'ok',
                '删除完成：成功 ' + okCount + ' 个' + (failed.length ? '，失败 ' + failed.length + ' 个（' + failed.join('、') + '）' : ''));
            /* 列表按宿主下拉重新取一遍，否则删掉的行还挂在浮层上 */
            names = talkPresetNames(sel);
            picked.clear();
            exitBatch();
        } finally {
            delAllBtn.classList.remove('wbm-busy');
        }
    });

    input.addEventListener('input', () => renderRows(input.value));
    renderRows('');
    document.documentElement.appendChild(mask);
    console.info('[wbm] talk preset mask in dom ' + mask.isConnected + ' rows=' + list.childElementCount);
    setTimeout(() => input.focus(), 40);
}

/* ================= ③ 提示词：插入到指定位置 =================
   原生「插入」把提示词 unshift 到列表最前面（PromptManager.js:961 appendPrompt），
   想放到正文后面只能一条条拖回去。这里在插入键旁边加一个按钮：
   选一个位置，一次性把它插到那里（并保存、重绘）。 */

let oaiSettingsCache = null;

async function getOaiSettings() {
    if (oaiSettingsCache) return oaiSettingsCache;
    try {
        const mod = await import('/scripts/openai.js');
        oaiSettingsCache = mod && mod.oai_settings ? mod.oai_settings : null;
    } catch (err) {
        console.warn('[wbm] 拿不到 oai_settings', err);
        oaiSettingsCache = null;
    }
    return oaiSettingsCache;
}

function promptNameOf(settings, id) {
    const prompts = (settings && settings.prompts) || [];
    const hit = prompts.find((p) => p && p.identifier === id);
    return hit ? (hit.name || id) : id;
}

function activeOrderList(settings, id) {
    const lists = (settings && settings.prompt_order) || [];
    if (!lists.length) return null;
    const hit = lists.find((l) => l && Array.isArray(l.order) && l.order.some((e) => e && e.identifier === id));
    if (hit) return hit;
    const nonEmpty = lists.find((l) => l && Array.isArray(l.order) && l.order.length);
    return nonEmpty || lists[0];
}

/* 找出「屏幕上正在显示的那份顺序」：优先用 DOM 里 li 的 data-pm-identifier 序列去匹配，
   因为 settings.prompt_order 是按角色/预设分组的数组，光看第一个元素很可能改到别的组。 */
function orderListForDisplay(settings) {
    const lists = (settings && settings.prompt_order) || [];
    if (!lists.length) return null;
    const domIds = [...document.querySelectorAll('#completion_prompt_manager_list li[data-pm-identifier]')]
        .map((li) => li.getAttribute('data-pm-identifier'));
    if (domIds.length) {
        const exact = lists.find((l) => l && Array.isArray(l.order)
            && l.order.length === domIds.length
            && l.order.every((e, i) => e && e.identifier === domIds[i]));
        if (exact) return exact;
    }
    return lists[0];
}

/* 一次性移动：把 moving 移到 target 之后（targetId 为 null = 移到最末尾）。
   位置用 identifier 定位，不再用 DOM 下标——2026-10-22 master 报的两个错都是下标漂移：
   从后往前移会多插一位（1,2,4,3,5），移完还不退出移动态。 */
async function movePromptAfter(movingId, targetId) {
    const settings = await getOaiSettings();
    if (!settings) return { ok: false, why: 'no-settings' };
    const list = orderListForDisplay(settings);
    if (!list || !Array.isArray(list.order)) return { ok: false, why: 'no-order' };

    const order = list.order;
    const from = order.findIndex((e) => e && e.identifier === movingId);
    if (from < 0) return { ok: false, why: 'moving-missing' };
    const [entry] = order.splice(from, 1);

    let to;
    if (!targetId) {
        to = order.length;
    } else {
        /* 注意：这一步是在「已经移除 moving」之后的数组里找目标，所以 to = t + 1 就是「目标之后」 */
        const t = order.findIndex((e) => e && e.identifier === targetId);
        to = t < 0 ? order.length : t + 1;
    }
    order.splice(to, 0, entry);

    /* 一次操作结束就退出移动态：底部下拉复位、高亮清掉、↓ 变灰 */
    const sel = document.getElementById('completion_prompt_manager_footer_append_prompt');
    if (sel && sel.value) {
        sel.value = '';
        sel.dispatchEvent(new Event('change', { bubbles: true }));
    }
    syncPromptBar();

    const ctx = window.SillyTavern && window.SillyTavern.getContext ? window.SillyTavern.getContext() : null;
    if (ctx && typeof ctx.saveSettingsDebounced === 'function') ctx.saveSettingsDebounced();

    /* 视觉：直接把这一行搬到目标行后面，不用等宿主 debounce 重绘 */
    const selId = (v) => '#completion_prompt_manager_list li[data-pm-identifier="' + CSS.escape(v) + '"]';
    const item = document.querySelector(selId(movingId));
    const targetLi = targetId ? document.querySelector(selId(targetId)) : null;
    if (item && item.parentElement) {
        if (targetLi) targetLi.insertAdjacentElement('afterend', item);
        else item.parentElement.appendChild(item);
        item.classList.add('wbm-pm-flash');
        setTimeout(() => item.classList.remove('wbm-pm-flash'), 900);
    }
    return { ok: true };
}

/* 1.3.44 性能：jQuery UI 每次 setOption 都会重建 items 集合（内部 .find().add().sort()，
   201 行时实测 3 秒白烧约 190ms CPU）。这里统一「先读实例状态、一致就什么都不动」，
   只在不一致时（宿主重绘后）才写一次。 */
function wbmSortableInstance() {
    const $ = window.jQuery;
    const list = document.getElementById('completion_prompt_manager_list');
    if (!$ || !list || !$.fn || !$.fn.sortable) return null;
    const $list = $(list);
    const inst = $list.data('ui-sortable') || $list.data('sortable');
    return inst ? { $list: $list, inst: inst } : null;
}

/* 桌面端把拖拽限定在 ☰ 那根把手上（宿主默认 handle:null，整行都是把手，
   delay 只有 30ms，所以点开关/点名字稍微一动就被判成拖拽，master 2026-10-22 报的）。
   手机端宿主本来就是 .drag-handle，这里统一一次。 */
function pinPromptDragHandle() {
    const $ = window.jQuery;
    const list = document.getElementById('completion_prompt_manager_list');
    if (!$ || !list || !$.fn || !$.fn.sortable) return false;
    /* 1.3.15：桌面端不钉把手（与 TT 一致，整行可拖），只有触屏才用 .drag-handle；
       拖拽判停(distance)与 cancel 由 hardenPromptSortable 负责。
       2026-10-22 事故：这三个函数曾被之前的补丁插进了本函数的体内，导致全部不可见
       （控制台一直报 hardenPromptSortable is not defined），这里把函数体恢复干净。 */
    /* 2026-10-22 master：「为什么不彻底覆盖掉滑动功能？」
       拖拽整个去掉——手机、电脑、排序态都不留。☰ 由 CSS 隐藏，sortable 直接 disable，
       以后只有两条路：每行 ↑↓ 微调一格，或勾选后点 ↓ 批量落位。 */
    const $list = $(list);
    const inst = $list.data('ui-sortable') || $list.data('sortable');
    if (!inst) return false;
    /* 1.3.44 性能：已经钉好了就直接返回，别再 setOption（每次都会重建 items 集合）。 */
    if (inst.options && inst.options.disabled === true && inst.options.handle === '.wbm-never-drag') return true;
    try {
        if (typeof inst.option === 'function') {
            inst.option('disabled', true);
            inst.option('handle', '.wbm-never-drag');
        }
    } catch (err) { return false; }
    return true;
}

/* ---------------------------------------------------------------------------
   2026-10-22 master 报「电脑端 ST 点星号，条目被瞬间拖起、瞬间消失，TT 却没这事」。
   ST 的 sortupdate 回调把 DOM 里的 identifier 直接 map 回 prompt_order 里的对象，
   只要某个 identifier 不在当前这份 prompt_order 里（我们早先移动条目时弄丢过、
   或者某条是新加的还没进 order），map 结果就是 undefined，写回后那一项变成 null，
   宿主重绘时该行「消失」。
   ①补全：任何一次拖拽之前，把 DOM 里有、order 里没有的 identifier 补进去；
   ②判停：给宿主的 sortable 加 distance（移动超过 10px 才算拖拽），单击/轻微抖动不再触发 sortupdate。
   --------------------------------------------------------------------------- */
function ensurePromptOrderComplete() {
    const settings = oaiSettingsCache;
    if (!settings) return false;
    const list = orderListForDisplay(settings);
    if (!list || !Array.isArray(list.order)) return false;
    const known = new Set(list.order.filter(Boolean).map((entry) => entry.identifier));
    const rows = [...document.querySelectorAll('#completion_prompt_manager_list li[data-pm-identifier]')];
    let changed = false;
    for (const li of rows) {
        const id = li.getAttribute('data-pm-identifier');
        if (!id || known.has(id)) continue;
        const disabled = li.classList.contains('completion_prompt_manager_prompt_disabled')
            || li.classList.contains('prompt_manager_prompt_disabled');
        list.order.push({ identifier: id, enabled: !disabled });
        known.add(id);
        changed = true;
    }
    const before = list.order.length;
    list.order = list.order.filter((entry) => entry && entry.identifier);
    if (list.order.length !== before) changed = true;
    if (changed) {
        try {
            const ctx = SillyTavern.getContext();
            if (ctx && typeof ctx.saveSettingsDebounced === 'function') ctx.saveSettingsDebounced();
        } catch (err) {
            console.warn('[wbm] 补全 prompt_order 后保存失败', err);
        }
        console.log('[wbm] prompt_order 已补全缺失条目，避免拖拽后出现空洞');
    }
    return changed;
}

/* 以 DOM 顺序为准重建当前这份 prompt_order（拖拽后兜底，专治 ST 把项写成 null）。 */
function repairPromptOrderFromDom() {
    const settings = oaiSettingsCache;
    if (!settings) return false;
    const list = orderListForDisplay(settings);
    if (!list || !Array.isArray(list.order)) return false;
    const rows = [...document.querySelectorAll('#completion_prompt_manager_list li[data-pm-identifier]')];
    if (!rows.length) return false;
    const byId = new Map();
    for (const entry of list.order) if (entry && entry.identifier) byId.set(entry.identifier, entry);
    let changed = false;
    const next = rows.map((li) => {
        const id = li.getAttribute('data-pm-identifier');
        const hit = byId.get(id);
        if (hit) {
            const disabled = li.classList.contains('completion_prompt_manager_prompt_disabled')
                || li.classList.contains('prompt_manager_prompt_disabled');
            if (hit.enabled === disabled) { hit.enabled = !disabled; changed = true; }
            return hit;
        }
        changed = true;
        const disabled = li.classList.contains('completion_prompt_manager_prompt_disabled')
            || li.classList.contains('prompt_manager_prompt_disabled');
        return { identifier: id, enabled: !disabled };
    });
    const hasHoles = list.order.some((entry) => !entry || !entry.identifier);
    if (hasHoles) changed = true;
    if (!changed && list.order.length === next.length) return false;
    list.order = next;
    try {
        const ctx = SillyTavern.getContext();
        if (ctx && typeof ctx.saveSettingsDebounced === 'function') ctx.saveSettingsDebounced();
        console.log('[wbm] 已按 DOM 顺序重建 prompt_order（' + next.length + ' 条）');
    } catch (err) {
        console.warn('[wbm] 重建 prompt_order 后保存失败', err);
    }
    return true;
}

function hardenPromptSortable() {
    const $ = window.jQuery;
    const list = document.getElementById('completion_prompt_manager_list');
    if (!$ || !list || !$.fn || !$.fn.sortable) return false;
    const $list = $(list);
    const inst = $list.data('ui-sortable') || $list.data('sortable');
    if (!inst) return false;
    /* cancel 覆盖「控件区 + 名字区（星号、检视链接）+ 计数」：宿主桌面端 handle 为 null（整行都能拖），
       点星号/名字稍微一动就被判成拖拽，表现就是「点一下条目就消失」。 */
    const wantCancel = '.wbm-pm-seq, .wbm-pm-box, .wbm-pm-insert, .wbm-prompt-bar, .prompt_manager_prompt_controls, .prompt_manager_prompt_controls *, .completion_prompt_manager_prompt_name, .completion_prompt_manager_prompt_name *, .prompt_manager_prompt_name, .prompt_manager_prompt_name *, .prompt_manager_prompt_tokens, input, textarea, select, button, a';
    /* 1.3.44 性能：先比对实例上真实生效的选项，全都对得上就一次 setOption 都不发。
       （jQuery UI 每次 setOption 都会重建内部 items 集合并做 DOM 顺序排序，
       201 行时 3 秒空闲实测 compareDocumentPosition 138.9ms + uniqueSort 17.4ms。） */
    /* 1.3.47：拖拽已经彻底下线（master 2026-10-22「为什么不彻底覆盖掉滑动功能？」），
       所以无论排序态还是正常态，sortable 的目标状态都只有一个：关掉、把手换成永远匹配不到的选择器。
       以前排序态会把它重新 enable 并换成 .drag-handle，于是每次进出排序态都要发好几轮 setOption
       （实测 6 次进出 +9.3MB / +206 监听器），而拖拽其实一次也用不上。 */
    const opt = inst.options || {};
    const wantHandle = '.wbm-never-drag';
    if (opt.disabled !== true || opt.handle !== wantHandle || opt.cancel !== wantCancel) {
        try {
            if (opt.disabled !== true) $list.sortable('disable');
            if (opt.handle !== wantHandle) $list.sortable('option', 'handle', wantHandle);
            if (opt.cancel !== wantCancel) $list.sortable('option', 'cancel', wantCancel);
            $list.data('wbmSortDisabled', true);
        } catch (err) {
            return false;
        }
    }
    if (!$list.data('wbmSortHooked')) {
        $list.data('wbmSortHooked', true);
        $list.on('sortstart', () => { ensurePromptOrderComplete(); });
        $list.on('sortupdate', () => {
            /* 宿主自己的 sortupdate 会先跑：它用 idToObjectMap 把 DOM 顺序映射回 order，
               只要有一个 identifier 不在那份 order 里，结果就是 undefined → 写成 null →
               重绘时那一行「消失」（ST 1.18 的已知缺陷，TT 新版改用
               resolvePromptOrderFromDomIdentifiers 并抛错）。我们在它之后重建一遍：
               以 DOM 顺序为准，把每一项还原成 {identifier, enabled}，写回并保存。 */
            window.setTimeout(() => {
                try { repairPromptOrderFromDom(); } catch (err) { console.warn('[wbm] 修复 prompt_order 失败', err); }
                ensurePromptOrderComplete();
            }, 0);
        });
    }
    return true;
}

/* 宿主每次重绘提示词列表都会重建 sortable（distance 回到 1、cancel 只剩 input），
   所以每次按下都在 document 捕获阶段抢先加固：jQuery UI 在 mousedown 里读选项，
   捕获阶段先跑，能保证「这一次按下」就是 10px 判停 + 名字/控件区不参与拖拽。 */
function hookPromptSortableCapture() {
    if (window.__wbmSortCapture === (window.__wbmBoot && window.__wbmBoot.build)) return;
    window.__wbmSortCapture = (window.__wbmBoot && window.__wbmBoot.build) || '1';
    /* 拖拽的唯一合法入口：排序态下的 ☰。
       其它任何地方按下，都在 document 捕获阶段把事件截住 —— 宿主的 sortable 监听挂在列表元素上，
       事件到不了列表，它就永远抓不起这一行。之前靠 sortable('disable') / handle / cancel 三件套都没用，
       因为宿主每次重绘都会重新 .sortable({...})，状态总被覆盖（master 2026-10-22 指出方向：
       「你明明把拖拽功能关闭了，但不在排序状态下点击星号还是能抓起，你没发现你一直改错了方向吗？」）。 */
    const block = (event) => {
        const target = event.target;
        if (!target || !target.closest) return;
        if (!target.closest('#completion_prompt_manager_list')) return;
        /* 1.3.37 性能：这里以前每按一下就 hardenPromptSortable() + ensurePromptOrderComplete()
           （读整份 prompt_order、扫 150 行 DOM），还排一个 400ms 的 repairPromptOrderFromDom，
           它一旦判出差异就 saveSettingsDebounced → 宿主整表重绘。手机上每滑一下都要来一轮，
           就是 master 报的「滑动/移动条目卡顿」的主要来源。拖拽已整体下线，ST 把项写成 null
           只可能由 sortupdate 产生，那条路已经修了，所以这里只做「事件截住」一件事。 */
        /* 拖拽已整体下线（2026-10-22 master 定）：任何平台、任何状态都不放行拖拽起点。 */
        event.stopPropagation();
        if (event.stopImmediatePropagation) event.stopImmediatePropagation();
    };
    document.addEventListener('mousedown', block, true);
    document.addEventListener('touchstart', block, { capture: true, passive: true });
    /* 兜底：万一宿主在别的时机把拖拽打开了，一有拖动动作就立刻关掉并把顺序按数据复位。 */
    if (!window.__wbmDragKill) {
        window.__wbmDragKill = true;
        const kill = () => {
            try {
                const list = document.getElementById('completion_prompt_manager_list');
                const inst = list && window.jQuery ? window.jQuery(list).data('ui-sortable') : null;
                if (inst && typeof inst.option === 'function' && inst.options && inst.options.disabled === false) {
                    inst.option('disabled', true);
                    console.warn('[wbm] 宿主重开了拖拽，已再次关闭');
                }
            } catch (err) { /* 忽略 */ }
        };
        document.addEventListener('mousedown', kill, true);
        document.addEventListener('touchstart', kill, { capture: true, passive: true });
    }
}

/* 每行一个「↓」：把底部下拉里选中的那条插到这一行之后（方案 A，一步到位）。
   底部另给一行提示：「当前移动：X · 点任意行下方的 ↓」，以及「插到最末尾」。 */
let wbmBarNode = null;
let wbmAppendBarNode = null;

/* 1.3.49：宿主每次点开关都会 renderPromptManager()，它把 #completion_prompt_manager
   整块 innerHTML='' 清掉，我们的工具条与插入搜索行也跟着消失。以前要等 620ms 的
   slowWork 才补回来，这期间列表整体上移 45px——master 报的「开关卡顿、界面上下跳、
   点快了还开关错条目」就是它。这里缓存节点引用，被清掉当场插回去（同步，不等 rAF）。 */
function ensureDockMounted() {
    /* 1.3.60 修：静音或关掉提示词模块时，观察者回调仍会把缓存节点插回去（实测总开关关了
       工具条又出现）。这里先看开关状态。 */
    if (!enhancementsOn() || !featureOn('promptMgr')) return;
    let mounted = false;
    const host = document.getElementById('completion_prompt_manager');
    if (host && wbmBarNode && !wbmBarNode.isConnected) {
        host.insertBefore(wbmBarNode, host.firstElementChild || null);
        mounted = true;
        try { syncPromptBar(); } catch (err) { /* 图标没同步上也无所谓 */ }
    }
    const foot = document.querySelector('.completion_prompt_manager_footer');
    if (foot && foot.parentElement && wbmAppendBarNode && !wbmAppendBarNode.isConnected) {
        foot.parentElement.insertBefore(wbmAppendBarNode, foot);
        mounted = true;
    }
    return mounted;
}

function ensurePromptInsertButton() {
    if (!featureOn('promptMgr')) return;
    /* 1.3.14：旧的「下拉选一条 + 每行一个 ↓」已下线，改由「调整排序」弹窗承担（master 2026-10-22 决定）。
       1.3.15：这里只剩触屏端的把手规则 + 一个可见的版本号。 */
    pinPromptDragHandle();
    try {
        const footer = document.querySelector('.completion_prompt_manager_footer');
        if (footer && !footer.querySelector('.wbm-pm-ver')) {
            const tag = el('span', 'wbm-pm-ver', '排序 ' + VERSION);
            footer.appendChild(tag);
        }
    } catch (err) { /* 版本号只是给人看的，失败不影响功能 */ }
    try { ensurePromptAppendTools(); } catch (err) { console.warn('[wbm] 插入提示词工具失败', err); }
    /* 已经挂在管理器顶部的那条就直接复用，别重建。 */
    if (document.querySelector('.wbm-prompt-bar')) {
        syncPromptBar();
        return;
    }
    if (wbmBarNode) {
        if (!wbmBarNode.isConnected) ensureDockMounted();
        if (wbmBarNode.isConnected) { syncPromptBar(); return; }
    }
    for (const footer of document.querySelectorAll('.completion_prompt_manager_footer')) {
        if (footer.querySelector('.wbm-prompt-bar')) continue;
        const chain = footer.querySelector('.fa-chain');
        if (!chain) continue;
        const bar = el('div', 'wbm-prompt-bar');
        wbmBarNode = bar;
        /* 1.3.37：「把勾选的条目移至最末尾」已下线（master 2026-10-22：
           「不生效，而且也没必要，干脆砍掉」）。工具条只剩排序键 + 已选计数。 */
        const sortBtn = el('button', 'wbm-prompt-sortbtn');
    sortBtn.appendChild(wbmIcon('sort'));
        sortBtn.type = 'button';
        sortBtn.title = '调整排序';
        sortBtn.setAttribute('aria-label', sortBtn.title);
        sortBtn.addEventListener('mousedown', (event) => event.stopPropagation());
        sortBtn.addEventListener('click', (event) => {
            event.preventDefault();
            event.stopPropagation();
            togglePmSort();
        });
        /* 1.3.38：靠左的「复制到其它预设」入口（master 定的位置：左边这个键，
           右边仍然是进入/退出调整排序）。 */
        const copyBtn = el('button', 'wbm-prompt-copybtn');
        copyBtn.appendChild(wbmIcon('copy'));
        copyBtn.type = 'button';
        copyBtn.title = '复制勾选的条目到其它预设';
        copyBtn.setAttribute('aria-label', copyBtn.title);
        copyBtn.addEventListener('mousedown', (event) => event.stopPropagation());
        copyBtn.addEventListener('click', (event) => {
            event.preventDefault();
            event.stopPropagation();
            Promise.resolve(openCopyToPresetPicker()).catch((err) => {
                console.error('[wbm] copy picker failed', err);
                toast('err', '打开复制窗口失败');
            });
        });
        const countNode = el('span', 'wbm-prompt-count');
        countNode.style.display = 'none';
        bar.appendChild(copyBtn);
        /* 1.3.40：放大镜键开/关查找行。整条栏在侧栏里只有 243px 宽，
           按钮行里塞输入框只剩 47px，所以查找行单独占第二行（平时收起，不占高度）。 */
        const findBtn = el('button', 'wbm-prompt-findbtn');
        findBtn.appendChild(wbmIcon('search'));
        findBtn.type = 'button';
        findBtn.title = '查找条目';
        findBtn.setAttribute('aria-label', findBtn.title);
        findBtn.addEventListener('mousedown', (event) => event.stopPropagation());
        findBtn.addEventListener('click', (event) => {
            event.preventDefault();
            event.stopPropagation();
            toggleFindTools();
        });
        bar.appendChild(findBtn);
        bar.appendChild(countNode);
        bar.appendChild(sortBtn);
        bar.appendChild(wbmBuildFindTools());
        /* 1.3.25：工具条常驻管理器顶部；1.3.26：不再每次重建（重建会把按钮文案打回「调整排序」，
           就是 master 报的「点进排序立刻又变回进入排序」）。 */
        const host = document.getElementById('completion_prompt_manager') || (chain.closest('#completion_prompt_manager_list') || chain).parentElement;
        const older = [...document.querySelectorAll('.wbm-prompt-bar')].filter((b) => b !== bar);
        older.forEach((b) => b.remove());
        if (host && bar.parentElement !== host) host.insertBefore(bar, host.firstElementChild || null);
    }
    pinPromptDragHandle();
    syncPromptBar();
}

function movingPromptId() {
    const sel = document.getElementById('completion_prompt_manager_footer_append_prompt');
    return sel ? sel.value : '';
}

function syncPromptBar() {
    const id = movingPromptId();
    const settings = oaiSettingsCache;
    const name = (id && settings) ? promptNameOf(settings, id) : id;
    const shortName = name && name.length > 26 ? name.slice(0, 26) + '…' : name;
    for (const bar of document.querySelectorAll('.wbm-prompt-bar')) {
        const sortBtn = bar.querySelector('.wbm-prompt-sortbtn');
        if (sortBtn) {
            /* 纯图标 + title：排序态是 ✕（退出），平时是 ↑↓（进入）。
               1.3.37：状态没变就不动 DOM——以前每次 sync 都拆掉 SVG 重画一遍。 */
            const mode = pmSortOn ? 'exit' : 'sort';
            if (sortBtn.dataset.wbmIcon !== mode) {
                sortBtn.dataset.wbmIcon = mode;
                sortBtn.classList.toggle('wbm-on', pmSortOn);
                sortBtn.title = pmSortOn ? '退出调整排序' : '调整排序';
                sortBtn.setAttribute('aria-label', sortBtn.title);
                while (sortBtn.firstChild) sortBtn.removeChild(sortBtn.firstChild);
                sortBtn.appendChild(wbmIcon(mode));
            }
        }
        const count = bar.querySelector('.wbm-prompt-count');
        if (count) {
            const want = pmSortOn ? String(pmSortSel.size) : '';
            if (count.textContent !== want) count.textContent = want;
            const disp = pmSortOn ? '' : 'none';
            if (count.style.display !== disp) count.style.display = disp;
        }
        bar.querySelectorAll('.wbm-prompt-bar-hint').forEach((n) => n.remove());
    }
    const sel = document.getElementById('completion_prompt_manager_footer_append_prompt');
    if (sel && !sel.dataset.wbmHooked) {
        sel.dataset.wbmHooked = '1';
        sel.addEventListener('change', () => setTimeout(() => {
            syncPromptBar();
            decoratePromptRows();
        }, 30));
    }
    decoratePromptRows();
}
/* 微调一格（不进入排序态）：每行名字后面一对 ↑↓，点一次换一位、立刻保存。
   master 2026-10-22：「如果我只是想要微调选项上下位置，也要进入专门的排序模式吗？
   滑动功能被取消了，为什么没有个按键可以方便我上下移动一位？」 */
async function movePromptStep(id, dir) {
    try {
        const settings = oaiSettingsCache || await getOaiSettings();
        const list = orderListForDisplay(settings);
        if (!list || !Array.isArray(list.order)) return false;
        const idx = list.order.findIndex((entry) => entry && entry.identifier === id);
        if (idx < 0) return false;
        const j = idx + dir;
        if (j < 0 || j >= list.order.length) return false;
        const [entry] = list.order.splice(idx, 1);
        list.order.splice(j, 0, entry);
        const rows = pmSortTargets();
        const li = rows.find((r) => r.getAttribute('data-pm-identifier') === id);
        if (li && li.parentNode) {
            const cur = rows.indexOf(li);
            if (dir > 0) li.parentNode.insertBefore(li, rows[cur + 2] || null);
            else li.parentNode.insertBefore(li, rows[cur - 1] || null);
            li.classList.add('wbm-pm-flash');
            setTimeout(() => li.classList.remove('wbm-pm-flash'), 900);
        }
        SillyTavern.getContext().saveSettingsDebounced();
        /* 1.3.37 性能：以前这里把签名清空再全量 decoratePromptRows()——149 行重扫 + 4~6 次
           querySelector/行，一次换位就几十毫秒。现在只动受影响的那几行。
           换一位只交换相邻两行的序号与首末箭头，其余行完全不变。 */
        const after = pmSortTargets();
        decoratePromptRows.lastSignature = after.map((r) => r.getAttribute('data-pm-identifier')).join('|') + (pmSortOn ? '#S' : '#N');
        decoratePromptRows.mode = pmSortOn;
        if (pmSortOn) {
            const hot = new Set([j - 1, j, j + 1, j + 2].filter((n) => n >= 0 && n < after.length));
            for (const n of hot) {
                const row = after[n];
                const p = wbmRowParts(row);
                const want = String(n + 1);
                if (p.seq && p.seq.textContent !== want) p.seq.textContent = want;
                setRowArrows(row, n, after.length);
            }
        }
        return true;
    } catch (err) {
        console.warn('[wbm] 微调失败', err);
        return false;
    }
}
/* 一枚 ↑/↓：外壳是 span（CSS 尺寸/悬停都挂在外壳上），里面是自绘 SVG。
   1.3.36 之前这里写的是 <span class="fa-solid fa-arrow-up">，宿主那份裁剪过的 Font Awesome
   没有 .fa-arrow-up，浏览器就画「带叉的空框」——master 2026-10-22 报的正是这个。 */
function pmStepButton(cls, icon, label) {
    const node = el('span', cls);
    node.appendChild(wbmIcon(icon));
    node.title = label;
    node.setAttribute('role', 'button');
    node.setAttribute('aria-label', label);
    return node;
}

/* 1.3.37：ensureStepButtons() 已删除——它从来没被调用过（装饰逻辑在 decoratePromptRows 里），
   留两份「建 ↑↓」的实现只会让下次改动漏掉一处。 */
/* 委托：点 ↑↓ 直接在数据里挪一格。整张列表只挂一个监听。 */
function delegatePromptStep() {
    const list = document.getElementById('completion_prompt_manager_list');
    if (!list || list.dataset.wbmStepDelegated) return;
    list.dataset.wbmStepDelegated = '1';
    list.addEventListener('click', (event) => {
        /* 1.3.34：↑↓ 现在只存在于排序态（正常态是 Token 数字），所以判据反过来。 */
        if (!pmSortOn) return;
        const target = event.target;
        if (!target || !target.closest) return;
        const btn = target.closest('.wbm-pm-step-up, .wbm-pm-step-down');
        if (!btn) return;
        event.preventDefault();
        event.stopPropagation();
        if (event.stopImmediatePropagation) event.stopImmediatePropagation();
        const li = btn.closest('li[data-pm-identifier]');
        if (!li) return;
        const id = li.getAttribute('data-pm-identifier');
        if (!id) return;
        movePromptStep(id, btn.classList.contains('wbm-pm-step-up') ? -1 : 1);
    }, true);
}

/* 1.3.46：排序态的点击都走这里——整张列表一份监听，行上不挂任何监听器。
   原因：每行挂 4 个监听（⤓ 的 mousedown / pointerdown / click + 行点击）在 201 行时
   是 800 多个闭包，进出排序态时随旧行滞留（实测 6 次 +7.9MB / +403 监听器）。 */
function delegateSortRowEvents() {
    const list = document.getElementById('completion_prompt_manager_list');
    if (!list || list.dataset.wbmRowDelegated) return;
    list.dataset.wbmRowDelegated = '1';
    /* 按下就截住：行尾这几枚键不该被宿主的 sortable 抓起来（拖拽已下线，抓起来只会乱跳） */
    const swallow = (event) => {
        const t = event.target;
        if (!t || !t.closest) return;
        if (!t.closest('.wbm-pm-insert, .wbm-pm-step, .wbm-pm-box')) return;
        event.stopPropagation();
    };
    list.addEventListener('mousedown', swallow, true);
    list.addEventListener('pointerdown', swallow, true);
    list.addEventListener('touchstart', swallow, { capture: true, passive: true });
    list.addEventListener('click', (event) => {
        if (!pmSortOn) return;
        const t = event.target;
        if (!t || !t.closest) return;
        const arrow = t.closest('.wbm-pm-insert');
        if (arrow) {
            event.preventDefault();
            event.stopPropagation();
            const target = arrow.closest('li[data-pm-identifier]');
            if (target) moveSelectedBelow(target);
            return;
        }
        if (t.closest('.prompt_manager_prompt_controls, .drag-handle, .wbm-pm-step, a')) return;
        const li = t.closest('li[data-pm-identifier]');
        if (!li) return;
        const lid = li.getAttribute('data-pm-identifier');
        if (!lid) return;
        event.preventDefault();
        event.stopPropagation();
        if (pmSortSel.has(lid)) pmSortSel.delete(lid); else pmSortSel.add(lid);
        syncSortSelection(li);
    }, true);
}

/* 给列表每一行注入「↓」小键（列表每次重绘都要补）。
   位置：行尾控件区的最前面（detach / edit / toggle 之前）——master 认可的上一版位置。 */
/* ================= 排序状态（1.3.18，master 2026-10-22 定） =================
   进入后：行尾的删除 / 启用 / 编辑三枚原生键全部隐藏，只留「序号 · ☰ · 名字 · 勾选框」，
   勾选条目后点目标行的 ↓ 批量落位；☐ 仍可拖动微调。退出时三枚键原样回来，顺序存一次。 */
let pmSortOn = false;
const pmSortSel = new Set();

/* ================= 1.3.40：查找已有条目（工具条上的查找框） =================
   master 2026-10-22：参考 txt 编辑器的查找——搜已经添加好的那些条目，用上下切换跳转。
   注意：**不筛选、不改变顺序**，只高亮命中行并滚过去；排序功能不能被查找框干扰。 */
let pmFindQuery = '';
let pmFindIdx = -1;

function pmRowLabel(li) {
    const nameEl = li && li.querySelector('.completion_prompt_manager_prompt_name, .prompt_manager_prompt_name');
    const text = nameEl ? nameEl.textContent : (li ? li.textContent : '');
    return String(text || '').trim();
}

function wbmFindNodes() {
    const bar = document.querySelector('#completion_prompt_manager > .wbm-prompt-bar') || document.querySelector('.wbm-prompt-bar');
    if (!bar) return null;
    return {
        bar,
        input: bar.querySelector('.wbm-prompt-find'),
        count: bar.querySelector('.wbm-find-count'),
        prev: bar.querySelector('.wbm-find-prev'),
        next: bar.querySelector('.wbm-find-next'),
    };
}

function syncFindButtons(nodes, total) {
    if (!nodes) return;
    const text = pmFindQuery.trim() ? (total ? (pmFindIdx + 1) + '/' + total : '0/0') : '';
    if (nodes.count && nodes.count.textContent !== text) nodes.count.textContent = text;
    const off = !total;
    if (nodes.prev && nodes.prev.disabled !== off) nodes.prev.disabled = off;
    if (nodes.next && nodes.next.disabled !== off) nodes.next.disabled = off;
}

function markPromptFind(opts) {
    const list = document.getElementById('completion_prompt_manager_list');
    const nodes = wbmFindNodes();
    const scroll = !(opts && opts.scroll === false);
    const q = pmFindQuery.trim().toLowerCase();
    if (list) list.querySelectorAll('.wbm-find-hit, .wbm-find-cur').forEach((n) => n.classList.remove('wbm-find-hit', 'wbm-find-cur'));
    let hits = [];
    if (list && q) {
        for (const li of pmSortTargets()) {
            if (pmRowLabel(li).toLowerCase().includes(q)) {
                li.classList.add('wbm-find-hit');
                hits.push(li);
            }
        }
    }
    if (!hits.length) pmFindIdx = -1;
    else if (pmFindIdx < 0 || pmFindIdx >= hits.length) pmFindIdx = 0;
    if (hits.length) {
        const cur = hits[pmFindIdx];
        cur.classList.add('wbm-find-cur');
        if (scroll) wbmFlashFind(cur);
        if (scroll) {
            try { cur.scrollIntoView({ block: 'center' }); } catch (err) { cur.scrollIntoView(); }
        }
    }
    syncFindButtons(nodes, hits.length);
    if (nodes && nodes.input && nodes.input.value !== pmFindQuery) nodes.input.value = pmFindQuery;
    return hits.length;
}

function wbmFlashFind(li) {
    /* 只有一个命中时，上下键跳的永远是同一行——没有视觉反馈会让人以为「点了没反应」，
       所以每次跳转都让当前行闪一下。 */
    if (!li) return;
    li.classList.remove('wbm-find-pulse');
    void li.offsetWidth;
    li.classList.add('wbm-find-pulse');
    clearTimeout(wbmFlashFind.timer);
    wbmFlashFind.timer = setTimeout(() => li.classList.remove('wbm-find-pulse'), 620);
}

function stepPromptFind(delta) {
    const list = document.getElementById('completion_prompt_manager_list');
    if (!list || !pmFindQuery.trim()) return 0;
    let hits = Array.from(list.querySelectorAll('li.wbm-find-hit'));
    if (!hits.length) {
        /* 宿主重绘后高亮类可能丢过一次：原地重算，别直接返回 0 */
        if (!markPromptFind({ scroll: false })) return 0;
        hits = Array.from(list.querySelectorAll('li.wbm-find-hit'));
        if (!hits.length) return 0;
    }
    pmFindIdx = ((pmFindIdx < 0 ? 0 : pmFindIdx) + delta + hits.length) % hits.length;
    hits.forEach((li) => li.classList.remove('wbm-find-cur'));
    const cur = hits[pmFindIdx];
    cur.classList.add('wbm-find-cur');
    try { cur.scrollIntoView({ block: 'center' }); } catch (err) { /* 忽略 */ }
    wbmFlashFind(cur);
    syncFindButtons(wbmFindNodes(), hits.length);
    return hits.length;
}

function clearPromptFind() {
    pmFindQuery = '';
    pmFindIdx = -1;
    markPromptFind({ scroll: false });
}

function toggleFindTools(force) {
    const nodes = wbmFindNodes();
    if (!nodes || !nodes.bar) return false;
    const open = (typeof force === 'boolean') ? force : !nodes.bar.classList.contains('wbm-find-open');
    nodes.bar.classList.toggle('wbm-find-open', open);
    if (open) {
        if (nodes.input) {
            nodes.input.value = pmFindQuery;
            try { nodes.input.focus(); nodes.input.select(); } catch (err) { /* 忽略 */ }
        }
    } else {
        if (nodes.input) nodes.input.value = '';
        clearPromptFind();
    }
    return open;
}

function wbmBuildFindTools() {
    const wrap = el('div', 'wbm-find-tools');
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'text_pole wbm-prompt-find';
    input.placeholder = '查找条目';
    input.setAttribute('autocomplete', 'off');
    input.setAttribute('aria-label', '在当前提示词列表里查找');
    input.addEventListener('mousedown', (event) => event.stopPropagation());
    input.addEventListener('touchstart', (event) => event.stopPropagation(), { passive: true });
    input.addEventListener('input', () => {
        pmFindQuery = input.value;
        pmFindIdx = -1;
        markPromptFind();
    });
    /* 焦点不在输入框时（滚过列表后焦点常常丢了）也接受回车/上下键 */
    document.addEventListener('keydown', (event) => {
        const bar = document.querySelector('.wbm-prompt-bar');
        if (!bar || !bar.classList.contains('wbm-find-open')) return;
        if (!pmFindQuery.trim()) return;
        if (event.target === input) return;
        const tag = (event.target && event.target.tagName) || '';
        if (tag === 'TEXTAREA' || tag === 'INPUT') return;
        if (event.key === 'Enter') { event.preventDefault(); stepPromptFind(event.shiftKey ? -1 : 1); return; }
        if (event.key === 'ArrowDown' && !event.altKey) { event.preventDefault(); stepPromptFind(1); return; }
        if (event.key === 'ArrowUp' && !event.altKey) { event.preventDefault(); stepPromptFind(-1); return; }
    });

    input.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
            event.preventDefault();
            stepPromptFind(event.shiftKey ? -1 : 1);
            return;
        }
        if (event.key === 'ArrowDown') { event.preventDefault(); stepPromptFind(1); return; }
        if (event.key === 'ArrowUp') { event.preventDefault(); stepPromptFind(-1); return; }
        if (event.key === 'Escape') {
            event.preventDefault();
            input.value = '';
            toggleFindTools(false);
        }
    });
    const mkBtn = (cls, icon, label, delta) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = cls;
        btn.appendChild(wbmIcon(icon));
        btn.title = label;
        btn.setAttribute('aria-label', label);
        btn.disabled = true;
        btn.addEventListener('mousedown', (event) => event.stopPropagation());
        btn.addEventListener('click', (event) => {
            event.preventDefault();
            event.stopPropagation();
            stepPromptFind(delta);
        });
        return btn;
    };
    wrap.appendChild(input);
    wrap.appendChild(mkBtn('wbm-find-prev', 'up', '上一个匹配', -1));
    wrap.appendChild(mkBtn('wbm-find-next', 'down', '下一个匹配', 1));
    wrap.appendChild(el('span', 'wbm-find-count', ''));
    return wrap;
}

function pmSortTargets() {
    return [...document.querySelectorAll('#completion_prompt_manager_list li[data-pm-identifier]')];
}

function applyPromptOrderFromIds(ids) {
    const settings = oaiSettingsCache;
    if (!settings) return false;
    const list = orderListForDisplay(settings);
    if (!list || !Array.isArray(list.order)) return false;
    const byId = new Map();
    for (const entry of list.order) if (entry && entry.identifier) byId.set(entry.identifier, entry);
    const next = [];
    for (const id of ids) {
        if (!id) continue;
        const hit = byId.get(id);
        if (hit) { next.push(hit); byId.delete(id); }
        else next.push({ identifier: id, enabled: true });
    }
    for (const rest of byId.values()) next.push(rest);
    list.order = next;
    try {
        const ctx = SillyTavern.getContext();
        if (ctx && typeof ctx.saveSettingsDebounced === 'function') ctx.saveSettingsDebounced();
    } catch (err) { console.warn('[wbm] 保存排序失败', err); }
    return true;
}

function refreshSortSeq() {
    pmSortTargets().forEach((li, i) => {
        const p = wbmRowParts(li);
        const want = String(i + 1);
        if (p.seq && p.seq.textContent !== want) p.seq.textContent = want;
    });
}
/* 1.3.37 性能：把每行要用到的子元素挂在行元素上（li.__wbm）。
   之后一次装饰 / 一次移动只做属性读写，不再「149 行 × 4~6 次 querySelector」。
   宿主重绘会把整行换掉，所以先校验引用还在文档里，失效就重取。 */
function wbmRowParts(li) {
    let p = li.__wbm;
    if (p && p.seq && p.seq.isConnected) return p;
    p = li.__wbm = {
        seq: li.querySelector('.wbm-pm-seq'),
        box: li.querySelector('.wbm-pm-box'),
        arrow: li.querySelector('.wbm-pm-insert'),
        step: li.querySelector('.wbm-pm-step'),
    };
    p.up = p.step ? p.step.querySelector('.wbm-pm-step-up') : null;
    p.down = p.step ? p.step.querySelector('.wbm-pm-step-down') : null;
    return p;
}

/* 赋同值不写：149 行每次都赋同样值也会触发样式重算（1.3.31 的教训）。 */
function wbmDim(node, on) {
    if (!node) return;
    const want = on ? '.22' : '';
    if (node.style.opacity !== want) node.style.opacity = want;
}

/* 首行没有「上移」、末行没有「下移」。 */
function setRowArrows(li, index, total) {
    const p = wbmRowParts(li);
    wbmDim(p.up, index === 0);
    wbmDim(p.down, index === total - 1);
}

function updateSortBarCount() {
    const count = document.querySelector('.wbm-prompt-bar .wbm-prompt-count');
    if (!count) return;
    const want = pmSortOn ? String(pmSortSel.size) : '';
    if (count.textContent !== want) count.textContent = want;
    const disp = pmSortOn ? '' : 'none';
    if (count.style.display !== disp) count.style.display = disp;
}

/* onlyLi 只给一行时就用它（勾选一行不必再扫全表）。 */
function syncSortSelection(onlyLi) {
    const rows = onlyLi ? [onlyLi] : pmSortTargets();
    const anyPicked = pmSortSel.size > 0;
    for (const li of rows) {
        const p = wbmRowParts(li);
        const on = pmSortSel.has(li.getAttribute('data-pm-identifier'));
        if (li.classList.contains('wbm-pm-picked') !== on) li.classList.toggle('wbm-pm-picked', on);
        if (p.box) {
            if (p.box.classList.contains('on') !== on) p.box.classList.toggle('on', on);
            p.box.setAttribute('aria-checked', on ? 'true' : 'false');
        }
        if (p.arrow && p.arrow.classList.contains('wbm-pm-arrow-off') === anyPicked) {
            p.arrow.classList.toggle('wbm-pm-arrow-off', !anyPicked);
        }
    }
    /* 1.3.33：勾选变化要同步底栏计数（以前只在 syncPromptBar 里更新，永远显示 0）。 */
    updateSortBarCount();
}

function moveSelectedBelow(targetLi) {
    const targetId = targetLi ? targetLi.getAttribute('data-pm-identifier') : null;
    const picked = [...pmSortSel];
    if (!picked.length) { toast('warn', '先勾选要移动的条目，再点目标行的 ⤓'); return; }
    const order = pmSortTargets().map((li) => li.getAttribute('data-pm-identifier'));
    const movingSet = new Set(picked);
    const moving = order.filter((id) => movingSet.has(id));
    const rest = order.filter((id) => !movingSet.has(id));
    let at = targetId ? rest.indexOf(targetId) : rest.length - 1;
    if (at < 0) at = rest.length - 1;
    const next = rest.slice(0, at + 1).concat(moving, rest.slice(at + 1));
    if (next.join('|') === order.join('|')) { toast('info', '这些条目已经在那里了'); return; }
    applyPromptOrderFromIds(next);
    const map = new Map(pmSortTargets().map((li) => [li.getAttribute('data-pm-identifier'), li]));
    const list = document.getElementById('completion_prompt_manager_list');
    if (list) for (const id of next) { const li = map.get(id); if (li) list.appendChild(li); }
    refreshSortSeq();
    pmSortSel.clear();
    syncSortSelection();
    toast('ok', '已把 ' + moving.length + ' 条移到目标位置');
}

/* ================= ④ 跨预设复制条目（1.3.38） =================
   master 2026-10-22：「现在只需要做快速复制到另一个预设的功能就好了」——
   勾选的条目整条（名字/正文/角色/注入位置一并）复制到另一个预设的最顶部。
   只做复制不做移动；目标预设单选；复制完不自动切过去（三条都是 master 定的）。 */

function wbmNewPromptId() {
    try {
        if (window.crypto && typeof window.crypto.randomUUID === 'function') return window.crypto.randomUUID();
    } catch (err) { /* ignore */ }
    return 'wbm-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
}

/* 内置条目不能复制：它们的 identifier 是写死的（main / worldInfoBefore / charDescription …），
   复制到别的预设会与目标里同 identifier 的那条撞车（宿主按 identifier 匹配，两边互相顶）。
   判据用宿主自己的标记位：PromptManager.addPrompt 给用户新建条目写的是
   system_prompt:false / marker:false，内置的必是两者之一 —— 比硬编码名单可靠。 */
function isWbmUserPrompt(p) {
    return !!p && !p.system_prompt && !p.marker;
}

function orderEntryEnabled(list, id) {
    if (!list || !Array.isArray(list.order)) return true;
    const hit = list.order.find((e) => e && e.identifier === id);
    return hit ? hit.enabled !== false : true;
}

async function copyPromptsToPreset(targetName, ids) {
    const settings = await getOaiSettings();
    if (!settings) return { ok: false, why: '拿不到当前预设' };
    const ctx = window.SillyTavern && typeof window.SillyTavern.getContext === 'function'
        ? window.SillyTavern.getContext() : null;
    const pm = ctx && typeof ctx.getPresetManager === 'function' ? ctx.getPresetManager('openai') : null;
    if (!pm || typeof pm.getPresetList !== 'function' || typeof pm.savePreset !== 'function') {
        return { ok: false, why: '这个酒馆版本没有预设管理接口' };
    }
    const list = pm.getPresetList('openai');
    const names = (list && list.preset_names) || {};
    const idx = names[targetName];
    if (idx === undefined || !list.presets || !list.presets[idx]) {
        return { ok: false, why: '找不到预设「' + targetName + '」' };
    }
    /* 先克隆再改：写盘失败时内存里那份不能被改脏 */
    const target = structuredClone(list.presets[idx]);
    const srcOrder = orderListForDisplay(settings);
    const prompts = Array.isArray(settings.prompts) ? settings.prompts : [];
    const made = [];
    for (const id of ids) {
        const src = prompts.find((p) => p && p.identifier === id);
        if (!src || !isWbmUserPrompt(src)) continue;
        const copy = structuredClone(src);
        copy.identifier = wbmNewPromptId();
        /* 启用状态以源条目在当前这份顺序里的为准（enabled 存在 prompt_order 的条目上，
           不在 prompts 的条目上） */
        made.push({ prompt: copy, enabled: orderEntryEnabled(srcOrder, id) });
    }
    if (!made.length) return { ok: false, why: '没有可复制的条目' };

    target.prompts = Array.isArray(target.prompts) ? target.prompts : [];
    for (const m of made) target.prompts.push(m.prompt);

    /* 落到目标预设最顶部。prompt_order 是按角色分组的数组，每份都要有这一条，
       否则切到别的角色就看不见它。 */
    if (!Array.isArray(target.prompt_order)) target.prompt_order = [];
    if (target.prompt_order.length) {
        for (const l of target.prompt_order) {
            if (!l || !Array.isArray(l.order)) continue;
            const mine = made
                .filter((m) => !l.order.some((e) => e && e.identifier === m.prompt.identifier))
                .map((m) => ({ identifier: m.prompt.identifier, enabled: m.enabled }));
            if (mine.length) l.order.unshift(...mine);
        }
    } else {
        /* 目标预设没有顺序表（极少见）：拿当前这份顺序当底，把新条目插到最前面 */
        const base = srcOrder ? structuredClone(srcOrder) : { character_id: 100001, order: [] };
        const rest = Array.isArray(base.order) ? base.order.filter((e) => e && e.identifier) : [];
        base.order = made.map((m) => ({ identifier: m.prompt.identifier, enabled: m.enabled })).concat(rest);
        target.prompt_order = [base];
    }

    await pm.savePreset(targetName, target, { skipUpdate: true });
    /* 内存里那份预设副本也要带上新条目：宿主切预设时读的是 openai_settings（= list.presets），
       不更新的话切过去看不到，得重启酒馆。 */
    list.presets[idx] = target;
    /* 启用状态是照源预设搬过来的：源里是关的，搬过去也是关的。
       报给界面用，免得读者看到「复制成功」却在目标里找不到生效的条目。 */
    const off = made.filter((m) => m.enabled === false).length;
    return { ok: true, count: made.length, off };
}

async function openCopyToPresetPicker() {
    try {
        if (!pmSortOn) {
            toast('warn', '先点右侧「调整排序」，勾选条目后再点左边这个键');
            return;
        }
        const picked = [...pmSortSel];
        if (!picked.length) { toast('warn', '先勾选要复制的条目，再点这个键'); return; }
        /* 1.3.38b：这里以前只读 oaiSettingsCache，而缓存是 getOaiSettings() 异步填的，
           冷启动后第一次点会空 → 误报「还没读完」。改走宿主暴露的 chatCompletionSettings，
           再兜底异步取一次。 */
        const hostCtx = window.SillyTavern && typeof window.SillyTavern.getContext === 'function'
            ? window.SillyTavern.getContext() : null;
        const settings = (hostCtx && hostCtx.chatCompletionSettings)
            || oaiSettingsCache || await getOaiSettings();
        if (!settings) { toast('warn', '拿不到当前预设，稍等一下再点'); return; }
        const prompts = Array.isArray(settings.prompts) ? settings.prompts : [];
        const copyable = [];
        let skipped = 0;
        for (const id of picked) {
            const p = prompts.find((x) => x && x.identifier === id);
            if (!p) continue;
            if (!isWbmUserPrompt(p)) { skipped += 1; continue; }
            copyable.push(id);
        }
        if (!copyable.length) {
            toast('warn', '勾选的 ' + skipped + ' 条都是内置条目，内置条目不能跨预设复制');
            return;
        }
        const pm = hostCtx && typeof hostCtx.getPresetManager === 'function' ? hostCtx.getPresetManager('openai') : null;
        const list = pm && typeof pm.getPresetList === 'function' ? pm.getPresetList('openai') : null;
        const all = Object.keys((list && list.preset_names) || {});
        const current = (settings.preset_settings_openai || '');
        const others = all.filter((n) => n !== current);
        if (!others.length) { toast('warn', '没有其它预设可以复制'); return; }

        /* 1.3.39：目标预设按「分组」排（master 2026-10-22：「应该借用我们自己添加的预设管理分组
           形成联动。也就是按分组展示」）。分组数据就是对话补全预设那一套 store.talkPresetGroups，
           键是预设名、值是组名；没分组的一律落到最后的「未分组」。 */
        const groups = (store.talkPresetGroups && typeof store.talkPresetGroups === 'object') ? store.talkPresetGroups : {};
        const groupOf = (name) => String(groups[name] || '').trim();
        const sorted = others.slice().sort((a, b) => {
            const ga = groupOf(a) || '\uffff未分组';
            const gb = groupOf(b) || '\uffff未分组';
            return ga === gb ? String(a).localeCompare(String(b), 'zh-Hans-CN') : String(ga).localeCompare(String(gb), 'zh-Hans-CN');
        });

        closeEditorPicker(true);
        const { mask, sheet } = makePickerShell();
        const { head, input } = buildPickerHead('搜索预设');
        const hint = el('div', 'wbm-copy-hint');
        hint.textContent = '把勾选的 ' + copyable.length + ' 条复制到目标预设的最顶部'
            + (skipped ? '（已跳过 ' + skipped + ' 条内置条目）' : '')
            + '；点下面的预设选中，再确认才会复制';
        const listEl = el('div', 'wbm-picker-list');

        /* 底部确认条：先在列表里选一个预设，这里写明「会保存一次」，按确认才写盘。
           不做二级弹窗（master 明确否过两级弹窗）。 */
        const confirmBar = el('div', 'wbm-copy-confirm');
        confirmBar.hidden = true;
        const confirmText = el('div', 'wbm-copy-confirm-text', '');
        const confirmRow = el('div', 'wbm-copy-confirm-actions');
        const cancelBtn = el('button', 'wbm-picker-action', '取消');
        const okBtn = el('button', 'wbm-picker-action primary', '确认复制');
        cancelBtn.type = 'button';
        okBtn.type = 'button';
        confirmRow.appendChild(cancelBtn);
        confirmRow.appendChild(okBtn);
        confirmBar.appendChild(confirmText);
        confirmBar.appendChild(confirmRow);

        let pending = '';
        const setPending = (name) => {
            pending = name || '';
            for (const row of listEl.querySelectorAll('[data-role="copy-preset"]')) {
                row.classList.toggle('active', !!pending && row.dataset.name === pending);
            }
            if (!pending) { confirmBar.hidden = true; return; }
            confirmText.textContent = '复制到「' + pending + '」会立刻保存该预设一次（写入磁盘文件）';
            okBtn.textContent = '复制到「' + pending + '」';
            confirmBar.hidden = false;
        };

        const fill = (query) => {
            listEl.textContent = '';
            const kw = String(query || '').trim().toLowerCase();
            let shown = 0;
            let lastGroup = null;
            for (const name of sorted) {
                const group = groupOf(name);
                if (kw && !name.toLowerCase().includes(kw) && !group.toLowerCase().includes(kw)) continue;
                if (group !== lastGroup) {
                    lastGroup = group;
                    listEl.appendChild(el('div', 'wbm-picker-group-label', group || '未分组'));
                }
                const row = el('div', 'wbm-picker-row wbm-copy-preset-row' + (name === pending ? ' active' : ''));
                row.dataset.role = 'copy-preset';
                row.dataset.name = name;
                row.appendChild(el('span', 'wbm-copy-row-name', name));
                listEl.appendChild(row);
                shown += 1;
            }
            if (!shown) listEl.appendChild(el('div', 'wbm-picker-empty', kw ? '没有匹配的预设' : '没有其它预设'));
        };
        fill('');
        sheet.appendChild(el('div', 'wbm-picker-grip'));
        sheet.appendChild(head);
        sheet.appendChild(hint);
        sheet.appendChild(listEl);
        sheet.appendChild(confirmBar);

        cancelBtn.addEventListener('click', (event) => { event.preventDefault(); event.stopPropagation(); setPending(''); });
        okBtn.addEventListener('click', async (event) => {
            event.preventDefault();
            event.stopPropagation();
            if (mask.dataset.busy === '1') return;
            const name = pending;
            if (!name) return;
            mask.dataset.busy = '1';
            okBtn.textContent = '复制中…';
            const res = await copyPromptsToPreset(name, copyable);
            if (res && res.ok) {
                toast('ok', '已把 ' + res.count + ' 条复制到「' + name + '」的最顶部，并保存了该预设'
                    + (skipped ? '，跳过 ' + skipped + ' 条内置条目' : '')
                    + (res.off ? '，其中 ' + res.off + ' 条保持关闭状态' : ''));
                closeEditorPicker();
                return;
            }
            mask.dataset.busy = '';
            okBtn.textContent = '复制到「' + name + '」';
            toast('err', '复制失败：' + ((res && res.why) || '未知原因'));
        });

        mask.addEventListener('click', (event) => {
            event.stopPropagation();
            if (mask.dataset.closing === '1') return;
            const hit = event.target instanceof Element ? event.target : null;
            if (!hit) return;
            if (hit === mask) { closeEditorPicker(); return; }
            if (hit.closest('[data-role="picker-close"]')) { closeEditorPicker(); return; }
            if (hit.closest('.wbm-copy-confirm')) return;
            const row = hit.closest('[data-role="copy-preset"]');
            if (!row) return;
            if (mask.dataset.busy === '1') return;
            setPending(row.dataset.name || '');
        });
        mask.addEventListener('input', (event) => {
            const t = event.target;
            if (t instanceof HTMLInputElement && t.dataset.role === 'picker-search') fill(t.value);
        });
        /* 挂到 html 而不是 body：body 上有 transform（UI 缩放）时 fixed 会相对它定位 */
        document.documentElement.appendChild(mask);
        if (input) input.focus();
    } catch (err) {
        console.error('[wbm] openCopyToPresetPicker failed', err);
        toast('err', '打开复制窗口失败');
    }
}

/* ================= 1.3.39：插入提示词的搜索 / 触屏浮窗 =================
   master 2026-10-22：「因为添加提示词还需要从提示词库中选出来然后添加，因此需要制作搜索功能，
   而且手机端还是一贯地需要把下拉栏改成我们自己的浮窗。」
   原版那条路是「底部一个 68 项的 select + 一个链条键（Insert prompt）」：
   电脑端保留原版下拉，在它上面加一条实时搜索（照样过滤原生 option，不替换）；
   触屏端把下拉收起来，改用我们自己的浮窗（原生 select 手机上太难用）。 */
const WBM_APPEND_SEL_ID = 'completion_prompt_manager_footer_append_prompt';

function wbmAppendSelect() {
    const sel = document.getElementById(WBM_APPEND_SEL_ID);
    return sel instanceof HTMLSelectElement ? sel : null;
}

/* 插入走酒馆自己的那条路：先把 select 的 value 指到目标条目，再点它的链条键
   （handleAppendPrompt → appendPrompt + render + save）。不自己写 settings。 */
function appendPromptById(id) {
    const sel = wbmAppendSelect();
    if (!sel || !id) return false;
    if (!Array.from(sel.options).some((o) => o.value === id)) return false;
    const footer = sel.closest('.completion_prompt_manager_footer');
    const chain = footer ? footer.querySelector('.fa-chain') : null;
    if (!chain) return false;
    sel.value = id;
    chain.click();
    return true;
}

function openAppendPromptPicker() {
    const sel = wbmAppendSelect();
    if (!sel) return;
    /* 下拉里列的是「这个预设所有非内置提示词」，其中一部分已经在列表里了。
       宿主 appendPrompt 对已在列表里的条目是空操作（-1 === index 才 unshift），
       所以这些行要标出来，别让 master 点了以为坏了。 */
    const inList = new Set(Array.from(document.querySelectorAll('#completion_prompt_manager_list li[data-pm-identifier]'))
        .map((li) => li.getAttribute('data-pm-identifier')));
    const items = Array.from(sel.options)
        .map((o) => ({ id: o.value, name: String(o.textContent || '').trim(), inList: inList.has(o.value) }))
        .filter((x) => !!x.id && !!x.name);
    if (!items.length) { toast('warn', '这个预设里还没有可插入的提示词'); return; }
    closeEditorPicker(true);
    const { mask, sheet } = makePickerShell();
    const { head, input } = buildPickerHead('搜索提示词');
    const hint = el('div', 'wbm-copy-hint', '点一条就插到列表最下面（和原版链条键同一个动作）');
    const listEl = el('div', 'wbm-picker-list');
    const fill = (query) => {
        listEl.textContent = '';
        const kw = String(query || '').trim().toLowerCase();
        let shown = 0;
        for (const item of items) {
            if (kw && !item.name.toLowerCase().includes(kw)) continue;
            const row = el('div', 'wbm-picker-row' + (item.inList ? ' wbm-append-inlist' : ''));
            row.dataset.role = 'append-prompt';
            row.dataset.id = item.id;
            row.dataset.inlist = item.inList ? '1' : '';
            row.appendChild(el('span', 'wbm-copy-row-name', item.name));
            if (item.inList) row.appendChild(el('span', 'wbm-append-tag', '已在列表'));
            listEl.appendChild(row);
            shown += 1;
        }
        if (!shown) listEl.appendChild(el('div', 'wbm-picker-empty', '没有匹配的提示词'));
    };
    fill('');
    sheet.appendChild(el('div', 'wbm-picker-grip'));
    sheet.appendChild(head);
    sheet.appendChild(hint);
    sheet.appendChild(listEl);
    mask.addEventListener('click', (event) => {
        event.stopPropagation();
        if (mask.dataset.closing === '1') return;
        const hit = event.target instanceof Element ? event.target : null;
        if (!hit) return;
        if (hit === mask) { closeEditorPicker(); return; }
        if (hit.closest('[data-role="picker-close"]')) { closeEditorPicker(); return; }
        const row = hit.closest('[data-role="append-prompt"]');
        if (!row) return;
        const id = row.dataset.id || '';
        if (!id) return;
        if (row.dataset.inlist === '1') {
            const nm = (row.querySelector('.wbm-copy-row-name') || {}).textContent || '这一条';
            toast('info', '「' + nm + '」已经在列表里，不用再加一次');
            return;
        }
        closeEditorPicker();
        if (!appendPromptById(id)) toast('err', '插入失败：这一条已经不在下拉里了');
    });
    mask.addEventListener('input', (event) => {
        const t = event.target;
        if (t instanceof HTMLInputElement && t.dataset.role === 'picker-search') fill(t.value);
    });
    document.documentElement.appendChild(mask);
    if (input) input.focus();
}

/* 底部那排：电脑端＝搜索框（过滤原生下拉的 option），触屏端＝「选提示词」按钮（开浮窗）。
   宿主每次重绘列表都会重造 footer，所以这里做幂等：已经有了就只更新 coarse 标记。 */
function ensurePromptAppendTools() {
    if (!featureOn('promptMgr')) return;
    const sel = wbmAppendSelect();
    if (!sel) return;
    const footer = sel.closest('.completion_prompt_manager_footer');
    const host = footer ? footer.parentElement : null;
    if (!host) return;
    let bar = host.querySelector('.wbm-append-bar');
    if (!bar && wbmAppendBarNode) {
        /* 1.3.49：宿主重绘把 footer 整块换掉时，把缓存的那一条插回去，别重建（重建会闪一下）。 */
        host.insertBefore(wbmAppendBarNode, footer);
        bar = wbmAppendBarNode;
    }
    if (!bar) {
        bar = el('div', 'wbm-append-bar');
        wbmAppendBarNode = bar;
        const search = el('input', 'text_pole wbm-append-search');
        search.type = 'text';
        search.placeholder = '筛选下面的下拉框';
        search.dataset.role = 'append-search';
        search.setAttribute('autocomplete', 'off');
        const btn = el('button', 'menu_button wbm-append-btn');
        btn.type = 'button';
        btn.title = '搜索并选择要插入的提示词';
        btn.appendChild(wbmIcon('search'));
        btn.appendChild(el('span', 'wbm-append-btn-text', '选提示词'));
        const count = el('span', 'wbm-append-count', '');
        bar.appendChild(search);
        bar.appendChild(btn);
        bar.appendChild(count);
        host.insertBefore(bar, footer);
        const apply = () => {
            /* 1.3.49：select 由宿主重绘时会被换掉，所以每次现取，不能闭包旧节点。 */
            const cur = wbmAppendSelect();
            if (!cur) return;
            const kw = String(search.value || '').trim().toLowerCase();
            let shown = 0;
            for (const opt of Array.from(cur.options)) {
                const name = String(opt.textContent || '').toLowerCase();
                const hide = !!kw && !name.includes(kw);
                if (opt.hidden !== hide) opt.hidden = hide;
                if (!hide) shown += 1;
            }
            count.textContent = kw ? ('匹配 ' + shown + ' / ' + cur.options.length) : '';
        };
        search.addEventListener('input', apply);
        search.addEventListener('keydown', (event) => {
            if (event.key !== 'Enter') return;
            event.preventDefault();
            const cur = wbmAppendSelect();
            const first = cur ? Array.from(cur.options).find((o) => !o.hidden) : null;
            if (first) appendPromptById(first.value);
        });
        btn.addEventListener('click', (event) => {
            event.preventDefault();
            event.stopPropagation();
            openAppendPromptPicker();
        });
    }
    const coarse = !!(window.matchMedia && window.matchMedia('(pointer: coarse)').matches);
    const want = coarse ? '1' : '';
    if (bar.dataset.coarse !== want) bar.dataset.coarse = want;
}

function exitPmSort(opts) {
    /* 1.3.39：换预设时也要退出排序模式。那种时刻 DOM 正被宿主重绘，
       不能再按 DOM 去反推 prompt_order（会把旧顺序写进新预设），所以给个跳过修复的口子。 */
    const skipRepair = !!(opts && opts.skipRepair);
    pmSortOn = false;
    pmSortSel.clear();
    /* 1.3.47：这里不再去改 sortable 的选项。
       以前这里把 handle 设成 false，下一轮 pinPromptDragHandle 又设回 '.wbm-never-drag'，
       两边来回改就是 setOption 风暴的来源（每次都会重建内部 items）。 */
    const list = document.getElementById('completion_prompt_manager_list');
    if (list) list.classList.remove('wbm-sorting');
    document.querySelectorAll('#completion_prompt_manager_list .wbm-pm-seq, #completion_prompt_manager_list .wbm-pm-box, #completion_prompt_manager_list .wbm-pm-insert').forEach((n) => n.remove());
    pmSortTargets().forEach((li) => li.classList.remove('wbm-pm-picked'));
    if (!skipRepair) {
        try { repairPromptOrderFromDom(); } catch (err) { console.warn('[wbm] 退出排序后修复失败', err); }
    }
    /* 别往按钮里写中文：它的内容是 SVG，写 textContent 会把图标冲掉（1.3.35 的 bb）。
       统一交给 syncPromptBar 换回 ↑↓ 图标。 */
    syncPromptBar();
}

function enterPmSort() {
    pmSortOn = true;
    pmSortSel.clear();
    const list = document.getElementById('completion_prompt_manager_list');
    if (list) list.classList.add('wbm-sorting');
    /* 同上：按钮内容是 SVG，不能写 textContent；syncPromptBar 负责把图标换成 ✕。 */
    syncPromptBar();
    decoratePromptRows();
    syncSortSelection();
}

function togglePmSort() {
    /* 宿主在列表重绘时会重新 sortable()，disabled 会被复位；这里排几次重关。 */
    [0, 120, 400, 900].forEach((ms) => setTimeout(pinPromptDragHandle, ms));
    if (pmSortOn) exitPmSort(); else enterPmSort();
}

/* 1.3.37：装饰（序号 / 勾选框 / ⤓ / ↑↓）的增删集中在这里。
   性能要点：①签名早退（修掉正常态永远不相等的老 bug）；②逐行元素引用缓存；
   ③换位走 movePromptStep 的增量路径，不回到这里全量重扫。 */
const WBM_SORT_PARTS = '.wbm-pm-seq, .wbm-pm-box, .wbm-pm-insert, .wbm-pm-step';

/* 宿主重绘会重建 sortable（拖拽又被打开），所以要补一次；只留一个重试定时器。 */
function pinPromptDragHandleSoon() {
    if (pinPromptDragHandle()) { decoratePromptRows.pinRetry = 0; return; }
    if (decoratePromptRows.pinRetry) return;
    decoratePromptRows.pinRetry = setTimeout(() => { decoratePromptRows.pinRetry = 0; pinPromptDragHandle(); }, 400);
}

function decorateSortRows(list, rows) {
    list.classList.add('wbm-sorting');
    rows.forEach((li, i) => {
        const p = wbmRowParts(li);
        const want = String(i + 1);
        if (!p.seq) {
            p.seq = el('span', 'wbm-pm-seq', want);
            li.insertBefore(p.seq, li.firstChild);
        } else if (p.seq.textContent !== want) {
            p.seq.textContent = want;
        }
        if (!p.box) {
            p.box = el('span', 'wbm-pm-box');
            p.box.setAttribute('role', 'checkbox');
            p.seq.insertAdjacentElement('afterend', p.box);
        }
        if (!p.arrow) {
            p.arrow = el('span', 'wbm-pm-insert');
            p.arrow.appendChild(wbmIcon('insert'));
            p.arrow.title = '把勾选的条目插到这一行下面';
            p.arrow.setAttribute('role', 'button');
            /* 1.3.37：⤓ 从「勾选框右边」挪到行尾（↑↓ 左边）。它原来紧贴勾选框，
               手机上勾选时经常点到它、把条目搬到错误位置（master 报的误触）。 */
            const stepNode = li.querySelector('.wbm-pm-step');
            if (stepNode) li.insertBefore(p.arrow, stepNode);
            else li.appendChild(p.arrow);
        }
        if (!p.step) {
            p.step = el('span', 'wbm-pm-step');
            p.step.appendChild(pmStepButton('wbm-pm-step-up', 'up', '上移一格'));
            p.step.appendChild(pmStepButton('wbm-pm-step-down', 'down', '下移一格'));
            p.up = p.step.querySelector('.wbm-pm-step-up');
            p.down = p.step.querySelector('.wbm-pm-step-down');
            li.appendChild(p.step);
        }
        setRowArrows(li, i, rows.length);
    });
    syncSortSelection();
    delegatePromptStep();
    delegateSortRowEvents();
}

function stripSortRows(list, rows) {
    /* 一次查全表再摘，比每行各查一次快（1.3.31 的经验）。 */
    const junk = list.querySelectorAll(WBM_SORT_PARTS);
    if (junk.length) junk.forEach((n) => n.remove());
    for (const li of rows) {
        if (li.__wbm) li.__wbm = null;
        if (li.classList.contains('wbm-pm-picked') || li.classList.contains('wbm-pm-moving') || li.classList.contains('wbm-pm-hover')) {
            li.classList.remove('wbm-pm-picked', 'wbm-pm-moving', 'wbm-pm-hover');
        }
    }
    list.classList.remove('wbm-sorting');
}

/* 自愈：DOM 行数比数据少 → 宿主把某一行「吞」了（prompt_order 里出现空项）。
   1.3.37：改成 Set 查表（原来是每份 order × 每行 ids.includes，O(n²)），并 3 秒最多查一次。 */
function healPromptRows(rows) {
    try {
        const now = Date.now();
        if (decoratePromptRows.healing) return;
        if (now - (decoratePromptRows.checkedAt || 0) < 3000) return;
        decoratePromptRows.checkedAt = now;
        const ctx = SillyTavern.getContext();
        const lists = ctx.chatCompletionSettings && ctx.chatCompletionSettings.prompt_order;
        if (!Array.isArray(lists) || !rows.length) return;
        const ids = new Set(rows.map((li) => li.getAttribute('data-pm-identifier')));
        let bestMatched = 0;
        let bestFilled = 0;
        for (const l of lists) {
            if (!Array.isArray(l.order) || !l.order.length) continue;
            let filled = 0;
            let matched = 0;
            for (const e of l.order) {
                if (!e || !e.identifier) continue;
                filled++;
                if (ids.has(e.identifier)) matched++;
            }
            if (matched > bestMatched) { bestMatched = matched; bestFilled = filled; }
        }
        if (!bestFilled || rows.length >= bestFilled) return;
        /* 绝不能拿 DOM 反写数据：DOM 少一行时反写等于把那条删掉。只能请宿主重绘。 */
        const pm = ctx.PromptManager;
        if (pm && typeof pm.render === 'function') {
            decoratePromptRows.healing = true;
            pm.render();
            console.warn('[wbm] 行数不一致（DOM ' + rows.length + ' / 数据 ' + bestFilled + '），已尝试重绘');
            window.setTimeout(() => { decoratePromptRows.healing = false; }, 800);
        }
    } catch (err) { /* 自愈失败不影响正常使用 */ }
}

function decoratePromptRows() {
    if (!featureOn('promptMgr')) return;
    const list = document.getElementById('completion_prompt_manager_list');
    if (!list) return;
    const rows = pmSortTargets();
    /* 签名 = 行 id 顺序 + 模式。1.3.37 修掉一只让早退永不生效的 bug：
       以前比较用 '#N'、写入用 ''，正常态永远不相等，于是每次调用都白扫 149 行。 */
    const sig = rows.map((li) => li.getAttribute('data-pm-identifier')).join('|') + (pmSortOn ? '#S' : '#N');
    const intact = !rows.length || (pmSortOn
        ? !!(rows[0].__wbm && rows[0].__wbm.seq && rows[0].__wbm.seq.isConnected)
        : !list.querySelector(WBM_SORT_PARTS));
    if (sig === decoratePromptRows.lastSignature && decoratePromptRows.mode === pmSortOn && intact) {
        pinPromptDragHandleSoon();
        return;
    }
    ensurePromptHooks();
    if (pmSortOn) decorateSortRows(list, rows);
    else stripSortRows(list, rows);
    pinPromptDragHandleSoon();
    decoratePromptRows.lastSignature = sig;
    decoratePromptRows.mode = pmSortOn;
    healPromptRows(rows);
    /* 宿主重绘会把 li 换掉，查找高亮跟着丢；这里补回来（不滚屏）。 */
    if (pmFindQuery) markPromptFind({ scroll: false });
}
/* ================= ④ 提示词编辑弹窗：保存键常驻 =================
   原文的保存/重置/关闭在长表单最底部，提示词一长就得先滚到底。给那一行贴住底部。 */

/* 三个钩子幂等，列表每次重绘都调一遍（1.3.15）。
   之前它们被写在 decoratePromptRows 的 return 之后，等于从没执行过 —— 这就是
   「distance 仍是 1、点星号还是被当成拖拽」的真正原因。 */
function ensurePromptHooks() {
    try { hardenPromptSortable(); } catch (err) { console.warn('[wbm] sortable 加固失败', err); }
    try { ensurePromptOrderComplete(); } catch (err) { console.warn('[wbm] prompt_order 补全失败', err); }
    try { hookPromptSortableCapture(); } catch (err) { console.warn('[wbm] sortable 捕获挂钩失败', err); }
}

function ensureStickySave() {
    const btn = document.getElementById('completion_prompt_manager_popup_entry_form_save');
    if (!btn) return;
    const row = btn.closest('.completion_prompt_manager_popup_entry_form_control') || btn.parentElement;
    if (!row || row.classList.contains('wbm-pm-sticky')) return;
    row.classList.add('wbm-pm-sticky');
}

let pmExtrasObserver = null;
let pmExtrasObserverTarget = null;

function hookPromptManagerExtras() {
    if (!featureOn('promptMgr')) { teardownPromptMgrDom(); return; }
    /* 1.3.44 性能：每 5 秒的看门狗都会调这里，而下面 6 个函数里有两个要扫 200+ 行 DOM。
       观察者还挂在活着的节点上、工具条也还在，就说明什么都没丢，直接返回。 */
    if (pmExtrasObserver && pmExtrasObserverTarget && pmExtrasObserverTarget.isConnected
        && document.querySelector('#completion_prompt_manager > .wbm-prompt-bar')) return;
    ensurePromptHooks();
    ensurePromptInsertButton();
    syncPromptBar();
    ensureStickySave();
    hardenPromptSortable();
    ensurePromptOrderComplete();
    hookPromptSortableCapture();
    if (pmExtrasObserver) {
        /* 宿主重绘会把管理器整块换掉，旧 observer 就失效了；发现脱挂就重建。 */
        if (pmExtrasObserverTarget && pmExtrasObserverTarget.isConnected) return;
        try { pmExtrasObserver.disconnect(); } catch (err) { /* 忽略 */ }
        pmExtrasObserver = null;
    }
    /* 1.3.26 性能：只盯提示词管理器本身。以前盯 document.body + subtree，
       150 行的重绘会把全页变动都喂进来（master 报明显卡顿）。 */
    const target = document.getElementById('completion_prompt_manager') || document.body;
    pmExtrasObserverTarget = target;
    if (!target) return;

    let slowPending = 0;
    let fastPending = 0;
    let lastSlow = 0;
    let lastRowCount = -1;

    const slowWork = () => {
        slowPending = 0;
        lastSlow = Date.now();
        ensurePromptInsertButton();
        ensurePromptAppendTools();
        ensureStickySave();
        hardenPromptSortable();
        /* 1.3.31：ensurePromptOrderComplete 会遍历整份 prompt_order（150+ 条），
           以前每次结构变化都跑一遍。改成只在「行数变了」时才跑——点开关只是重绘，行数不变。 */
        const count = document.querySelectorAll('#completion_prompt_manager_list li[data-pm-identifier]').length;
        if (count !== lastRowCount) {
            lastRowCount = count;
            ensurePromptOrderComplete();
        }
    };

    /* 宿主每次重绘提示词列表都会把我们的 ↓ 一起清掉（1.3.10 之前要等 300ms 才补，
       于是点开关时箭头会「闪一下不见」——master 2026-10-22 报的闪烁就是这么来的）。
       列表内的变动走 rAF 立刻补，只有底部/弹窗这类慢活才用节流。 */
    const fastWork = () => {
        fastPending = 0;
        decoratePromptRows();
        /* 宿主重绘会重造 footer，搜索行要立刻补回来（否则会闪一下不见）。 */
        ensurePromptAppendTools();
    };

    pmExtrasObserver = new MutationObserver((records) => {
        /* 1.3.49：被清掉的工具条在这里当场插回去（微任务阶段，赶在同一帧绘制前）。 */
        ensureDockMounted();
        /* 1.3.29 性能：只认「元素节点进出」。宿主会时不时改 Token 计数这类纯文本，
           原来把它也当结构变化 → 每 300ms 重扫 150 行（实测 idle 3 秒 9 次、每次 11ms 白烧）。 */
        let structural = false;
        for (const rec of records) {
            if (rec.type !== 'childList') continue;
            for (const n of rec.addedNodes) { if (n.nodeType === 1) { structural = true; break; } }
            if (!structural) for (const n of rec.removedNodes) { if (n.nodeType === 1) { structural = true; break; } }
            if (structural) break;
        }
        if (!structural) return;
        const list = document.getElementById('completion_prompt_manager_list');
        let touchedList = false;
        if (list) {
            for (const rec of records) {
                if (rec.target === list || (rec.target.nodeType === 1 && list.contains(rec.target))) {
                    touchedList = true;
                    break;
                }
            }
        }
        if (touchedList && !fastPending) fastPending = requestAnimationFrame(fastWork);

        const gap = Date.now() - lastSlow;
        if (gap >= 600) {
            slowWork();
            return;
        }
        if (slowPending) return;
        slowPending = setTimeout(slowWork, 620 - gap);
    });
    pmExtrasObserver.observe(target, { childList: true, subtree: true });
}

function bindMessageDblClick() {
        /* 只挂一次：boot 失败重试、看门狗补挂都会再进来，
            重复绑定会让「一次轻触」被自己的两个处理器配成一对，等于单击就进编辑
            （2026-10-20 实测：一次点击产生两条 touchend 记录，hits 立刻 +1）。 */
        if (window.__wbmDblBound === VERSION) return;
        window.__wbmDblBound = VERSION;
        /* 电脑：原生 dblclick */
        document.addEventListener('dblclick', (event) => {
            if (!enhancementsOn() || store.msgDblClickEdit === false) return;
            /* 注意：桌面双击一定会顺手选中一个词，所以这里不能用「有选区就跳过」，
               否则功能永远不触发（这正是 1.0.5.1 电脑端双击无效的原因）。 */
            const btn = msgEditButtonFor(event.target);
            if (!btn) return;
            event.preventDefault();
            event.stopPropagation();
            enterMessageEdit(btn);
        }, true);
        /* 手机：系统不派 dblclick（双击＝选词），自己数两次轻触。
           2026-10-20 master 录屏实测：连续滑动会被配成一对。原因有两条——
           ① touchend 在滑动手势结束时照常触发，滑动通常不产生选区；
           ② 原来的配对窗口 420ms 比实测相邻甩动间隔（70–240ms）宽得多。
           所以先给每一按定「轻触资格」，不合格的手势连同待配对的那半下一起作废。 */
        const TAP_MAX_MOVE = 10;     // px：手指位移超过就算滑动，不算轻触（安卓 touch slop 8dp）
        const TAP_MAX_MS = 350;      // ms：按住超过就算长按，不算轻触
        const PAIR_MAX_MS = 400;     // ms：两次轻触的最大间隔（真机实测 300ms 上下已属正常双击）
        const PAIR_MAX_DIST = 30;    // px：两次落点的最大距离
        let pressed = null;          // 当前手势 { x, y, at, moved }
        let scrolled = false;        // 本次手势期间页面是否滚动过
        let lastTap = null;          // 上一次合格轻触 { mes, x, y, at }

        /* 滚动事件不冒泡，但捕获阶段能收到；任何滚动都让本次手势失去轻触资格 */
        document.addEventListener('scroll', () => { scrolled = true; }, { capture: true, passive: true });

        document.addEventListener('touchstart', (event) => {
            scrolled = false;
            if (event.touches.length !== 1) {
                /* 双指（缩放/双指滑动）：整串作废 */
                pressed = null;
                lastTap = null;
                scrolled = true;
                return;
            }
            const point = event.touches[0];
            pressed = { x: point.clientX, y: point.clientY, at: performance.now(), moved: false };
        }, { capture: true, passive: true });

        document.addEventListener('touchmove', (event) => {
            if (!pressed) return;
            const point = event.touches[0];
            if (!point) return;
            if (Math.abs(point.clientX - pressed.x) > TAP_MAX_MOVE
                || Math.abs(point.clientY - pressed.y) > TAP_MAX_MOVE) pressed.moved = true;
        }, { capture: true, passive: true });

        document.addEventListener('touchcancel', () => { pressed = null; lastTap = null; }, { capture: true, passive: true });

        document.addEventListener('touchend', (event) => {
            if (!enhancementsOn() || store.msgDblClickEdit === false) return;
            const gesture = pressed;
            pressed = null;
            if (event.touches && event.touches.length > 0) { lastTap = null; return; }
            const btn = msgEditButtonFor(event.target);
            if (!btn) { lastTap = null; return; }
            const sel = window.getSelection();
            if (sel && String(sel).length > 0) { lastTap = null; return; }
            const point = event.changedTouches && event.changedTouches[0];
            if (!gesture || !point) { lastTap = null; return; }
            /* 滑动 / 长按 / 手势期间滚过页面：都不是轻触，顺便清掉待配对的那半下 */
            if (gesture.moved || scrolled || performance.now() - gesture.at > TAP_MAX_MS) {
                lastTap = null;
                return;
            }
            const mes = btn.closest('.mes');
            const now = performance.now();
            const x = point.clientX;
            const y = point.clientY;
            const paired = lastTap && lastTap.mes === mes
                && Math.abs(x - lastTap.x) < PAIR_MAX_DIST
                && Math.abs(y - lastTap.y) < PAIR_MAX_DIST
                && now - lastTap.at < PAIR_MAX_MS;
            if (paired) {
                lastTap = null;
                if (event.cancelable) event.preventDefault();
                enterMessageEdit(btn);
                return;
            }
            lastTap = { mes, x, y, at: now };
        }, { capture: true, passive: false });
    }

    /* ---------------- 消息编辑：右下角再挂一排原生按钮

    /* ---------------- 消息编辑：右下角再挂一排原生按钮 ---------------- */

    /* 酒馆原生那排 .mes_edit_buttons 在消息头部右上角，长消息要往上翻才够得着。
       做法：顶部那排原样保留不动，编辑期间在**同一条消息**的右下角克隆一排同样的按钮
       （master 定的「上下都留选项」）。克隆体仍然是酒馆原生的类名，所以点击走的还是
       宿主自己的委托处理器（closest('.mes') 找到的是同一条消息），没有自造的保存/删除逻辑。
       只在编辑期间存在，退出编辑即移除；观察器也只盯正在编辑的那一条消息。 */
    const BOTTOM_ROW_ID = 'wbm-bottom-editrow';
    const EDITING_CLASS = 'wbm-editing';
    let bottomRow = null;
    let bottomRowMes = null;
    let bottomRowObserver = null;

    function currentEditMes() {
        const ta = document.querySelector('.edit_textarea');
        return ta ? ta.closest('.mes') : null;
    }

    /* 只点顶部那排的原生按钮。cloneNode 出来的克隆体不能自己承接「确认」（见下），
       而且 querySelector 在文档顺序上虽然先命中原生那排，但显式限定更稳。 */
    function clickEditButton(sel) {
        const mes = currentEditMes();
        if (!mes) return;
        const btn = mes.querySelector('.mes_edit_buttons ' + sel) || mes.querySelector(sel);
        if (btn) btn.click();
    }

    function dropBottomRow() {
        if (bottomRowObserver) {
            bottomRowObserver.disconnect();
            bottomRowObserver = null;
        }
        if (bottomRow && bottomRow.parentNode) bottomRow.parentNode.removeChild(bottomRow);
        /* 老 WebView 不认 :has()，用类名兜底（隐藏的正是编辑期间那条消息的页码） */
        if (bottomRowMes && bottomRowMes.classList) bottomRowMes.classList.remove(EDITING_CLASS);
        bottomRow = null;
        bottomRowMes = null;
    }

    function syncBottomRow() {
        if (!enhancementsOn() || !editBarOn()) {
            dropBottomRow();
            return;
        }
        const mes = currentEditMes();
        if (!mes) { dropBottomRow(); return; }
        const src = mes.querySelector('.mes_edit_buttons');
        if (!src) return;
        if (bottomRow && bottomRow.parentNode && bottomRowMes === mes) return;

        dropBottomRow();
        const row = document.createElement('div');
        row.id = BOTTOM_ROW_ID;
        for (const child of Array.from(src.children)) row.appendChild(child.cloneNode(true));
        mes.appendChild(row);
        /* 编辑期间这条消息的页码与左右滑档必须让位：我们把页码搬到了气泡正中下方，
           它正好和右下角这排按钮同一水平线，手机上会叠在一起（master 2026-10-20 报）。 */
        if (mes.classList) mes.classList.add(EDITING_CLASS);
        bottomRow = row;
        bottomRowMes = mes;
        /* 编辑结束（textarea 消失）就拆掉这排；只盯这一条消息，退出必须 disconnect */
        bottomRowObserver = new MutationObserver(() => {
            if (!bottomRowMes) return;
            if (!bottomRowMes.querySelector('.edit_textarea')) dropBottomRow();
        });
        bottomRowObserver.observe(mes, { childList: true, subtree: true });
    }

    function bindMsgEditRow() {
        /* 克隆出来的「确认」不能让它自己走酒馆的处理器：酒馆按点击到的那个按钮往上找
           .mes_block（script.js:8081 updateMessage 里是 div.closest('.mes_block')），
           我们的那排挂在 .mes 下，closest 拿到 null → 抛异常 → 消息正文被清空、编辑态卡死
           （2026-10-20 TT 实测的「点绿色确认吞住」就是这个）。所以捕获阶段把它转交给原生那排。 */
        const CLONED_EDIT_BTNS = '.mes_edit_done, .mes_edit_cancel, .mes_edit_copy, .mes_edit_delete,'
            + ' .mes_edit_up, .mes_edit_down, .mes_edit_add_reasoning';
        document.addEventListener('click', (event) => {
            const t = event.target;
            if (!t || !t.closest) return;
            if (!t.closest('#wbm-bottom-editrow')) return;
            const clone = t.closest(CLONED_EDIT_BTNS);
            if (!clone) return;
            /* 一个都不自己处理：统一转交给顶部那排的原生按钮。
               酒馆这些处理器都要往上找 .mes_block（updateMessage 里是 div.closest('.mes_block')），
               而克隆的这排挂在 .mes 下，closest 拿到 null 就抛异常 —— 正文被清空、编辑态卡死。 */
            event.preventDefault();
            event.stopPropagation();
            const mes = clone.closest('.mes');
            if (!mes) return;
            const key = Array.from(clone.classList).find((c) => c.indexOf('mes_edit') === 0);
            const native = key ? mes.querySelector('.mes_edit_buttons .' + key) : null;
            if (native) native.click();
        }, true);
        /* 编辑框拿到焦点那一刻（双击进编辑、点铅笔进编辑都会经过这里）挂上右下角那排 */
        document.addEventListener('focusin', (event) => {
            const t = event.target;
            if (t && t.matches && t.matches('.edit_textarea')) syncBottomRow();
        }, true);
        /* Esc 取消；Ctrl+Enter 酒馆自己已支持，不重复实现 */
        document.addEventListener('keydown', (event) => {
            if (event.key !== 'Escape') return;
            if (!enhancementsOn()) return;
            if (!currentEditMes()) return;
            event.preventDefault();
            event.stopPropagation();
            clickEditButton('.mes_edit_cancel');
        }, true);
        syncBottomRow();
    }

    /* ---------------- 扩展设置面板（扩展程序页里的「双端酒馆原生功能优化」） ---------------- */

    /* 总开关关掉后要能原地退回原生酒馆，不刷新页：把插进宿主 DOM 的东西收走、标记清掉，
       世界书那边靠的是 [data-wbm-ready] 这个 fail-safe 标记（去掉它原生控件立刻回来）。 */
    function teardownInjected() {
        const host = hostEl();
        if (host) {
            host.removeAttribute('data-wbm-ready');
            if (host.dataset.wbmBound) delete host.dataset.wbmBound;
        }
        /* 「选择以编辑」的分组是写进原生 select 的 optgroup 里的，
           静音时要还原成 ST 原始的扁平顺序（按 value 就是 world_names 下标），
           否则界面看着是原生了，下拉里还留着我们的分组 */
        const editorSel = document.querySelector('#world_editor_select');
        if (editorSel && editorSel.querySelector('optgroup')) {
            const flat = Array.from(editorSel.options).sort((a, b) => Number(a.value || 0) - Number(b.value || 0));
            editorSel.textContent = '';
            flat.forEach((opt) => editorSel.appendChild(opt));
            delete editorSel.dataset.wbmGroupSig;
        }
        dropBottomRow();
        /* 自绘列表的根节点没有 class（只有 id），按前缀那批收不走，单独收一次 */
        const listRoot = document.getElementById(ROOT_ID);
        if (listRoot && listRoot.parentNode) listRoot.parentNode.removeChild(listRoot);
        /* 缓存节点也要清掉，否则观察者下一次回调会把它插回来（同 1.3.60 的坑） */
        wbmBarNode = null;
        wbmAppendBarNode = null;
        /* 我们插进宿主的节点类名一律以 wbm- 开头，按前缀整批收走；
           设置抽屉要留着，否则关掉以后解不开。宿主自己的表单控件只清标记、不删。 */
        document.querySelectorAll('[class*="wbm-"]').forEach((node) => {
            if (node.closest && node.closest('#wbm-settings')) return;
            const tag = node.tagName;
            if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
            /* 致命坑（1.3.57 实测）：接管备选页码时给 <body> 加过 wbm-swipe-on，
               于是 body 也命中这个前缀，静音时把 body 整块删掉——页面只剩 head，
               白屏、document.body === null，刷新也救不回来（设置里存着 off）。
               骨架节点只摘我们的 class，绝不删。 */
            if (tag === 'HTML' || tag === 'HEAD' || tag === 'BODY' || node === document.body || node === document.documentElement) {
                Array.from(node.classList || []).forEach((cls) => {
                    if (String(cls).indexOf('wbm-') === 0) node.classList.remove(cls);
                });
                return;
            }
            if (node.parentNode) node.parentNode.removeChild(node);
        });
        document.querySelectorAll('[data-wbm-locked], [data-wbm-editing]').forEach((node) => {
            node.removeAttribute('data-wbm-locked');
            node.removeAttribute('data-wbm-editing');
            node.classList.remove('wbm-field-locked');
            if (node.readOnly) node.readOnly = false;
        });
        /* 挂在宿主元素上的排版标记一并摘掉，否则关掉总开关后仍是我们的排法 */
        document.querySelectorAll('.wbm-world-row, .wbm-scope-row').forEach((node) => {
            node.classList.remove('wbm-world-row');
            node.classList.remove('wbm-scope-row');
        });
        document.querySelectorAll('[data-xh]').forEach((node) => node.removeAttribute('data-xh'));
        state.signature = '';
    }

    function applyEnhanceState() {
        syncPromptEditorCap();
        if (enhancementsOn()) {
            document.documentElement.removeAttribute('data-wbm-off');
            state.signature = '';
            ensureEditorPicker();
            ensureBatchBar();
            render();
            injectPreviewButtons();
            lockEntryContents();
            syncBottomRow();
            updateEditorButton();
            try { if (featureOn('promptMgr')) hookPromptManagerExtras(); } catch (err) { /* 稍后看门狗还会补 */ }
            try { if (featureOn('talkPreset')) ensureTalkPresetButton(); } catch (err) { /* 忽略 */ }
            try { ensurePersonaBarLater(); } catch (err) { /* 忽略 */ }
            try { if (featureOn('headerAlign')) { alignEntryHeadersOnce(); ensureHeaderAlignObserver(); } } catch (err) { /* 忽略 */ }
        } else {
            document.documentElement.setAttribute('data-wbm-off', '1');
            /* 关闭方向不再就地拆（1.3.0 修）：teardownInjected 按 [class*="wbm-"] 整批删节点，
               而我们给宿主的行加过 wbm-world-row / wbm-scope-row 这类标记，于是把宿主的
               「创建 / 选择以编辑」整行也一起删掉，世界书面板只剩一行空壳（master 报的那个 bug）。
               现在关闭一律走刷新：这里只挂标记，真正的原生界面由刷新后的新页面给出。 */
        }
        applySwipeCounterLayout();
        syncPanelNotes();
    }


    /* ---------------- ① 正则脚本守护 ----------------
       症状：酒馆里正则脚本会"整批失效"——刷新后全局脚本全变未启用，或者换了对话补全预设后
       该预设携带的正则不再生效（酒馆按 预设名+接口 白名单才读它）。
       做法：① 记下上次启用中的脚本 id，检测到"一条都不剩"就按记录恢复并提示；
             ② 抽屉里给出当前预设的正则许可状态，一键允许。 */
    function regexScriptList() {
        const ctx = (window.SillyTavern && window.SillyTavern.getContext)
            ? window.SillyTavern.getContext() : null;
        const scripts = (ctx && ctx.extensionSettings && Array.isArray(ctx.extensionSettings.regex))
            ? ctx.extensionSettings.regex : [];
        return scripts;
    }

    function regexEnabledIds() {
        return regexScriptList()
            .filter((item) => item && item.id && item.disabled !== true)
            .map((item) => String(item.id));
    }

    async function regexEngine() {
        try {
            return await import('/scripts/extensions/regex/engine.js');
        } catch (err) {
            console.warn('[wbm] 取不到正则扩展的接口', err);
            return null;
        }
    }

    async function regexPresetState() {
        const engine = await regexEngine();
        if (!engine || typeof engine.getCurrentPresetAPI !== 'function') return null;
        const apiId = engine.getCurrentPresetAPI();
        const presetName = engine.getCurrentPresetName();
        if (!apiId || !presetName) return null;
        const allowed = (typeof engine.isPresetScriptsAllowed === 'function')
            ? !!engine.isPresetScriptsAllowed(apiId, presetName) : null;
        return { apiId, presetName, allowed };
    }

    async function syncRegexPanel() {
        const note = document.getElementById('wbm-note-regex');
        if (!note) return;
        const total = regexScriptList().length;
        const enabled = regexEnabledIds().length;
        let text = '全局正则 ' + enabled + ' / ' + total + ' 条启用';
        const preset = await regexPresetState();
        const btn = document.getElementById('wbm-regex-allow');
        if (preset) {
            text += '；当前预设「' + preset.presetName + '」'
                + (preset.allowed ? '已允许携带正则' : '未允许携带正则');
        }
        if (btn) btn.style.display = (preset && preset.allowed === false) ? '' : 'none';
        note.textContent = text;
    }

    async function allowRegexForCurrentPreset() {
        const engine = await regexEngine();
        if (!engine || typeof engine.getCurrentPresetAPI !== 'function') {
            toast('warn', '取不到正则扩展，可能没有启用它');
            return;
        }
        const apiId = engine.getCurrentPresetAPI();
        const presetName = engine.getCurrentPresetName();
        if (!apiId || !presetName) {
            toast('warn', '当前接口没有对话补全预设，不需要这一步');
            return;
        }
        engine.allowPresetScripts(apiId, presetName);
        syncRegexPanel();
        toast('ok', '已允许预设「' + presetName + '」携带的正则生效');
    }

    async function regexGuardCheck(options) {
        const silent = !!(options && options.silent);
        if (featureOn('regexGuard')) {
            const ids = regexEnabledIds();
            const prev = (store.regexGuard && Array.isArray(store.regexGuard.ids)) ? store.regexGuard.ids : null;
            if (ids.length === 0 && prev && prev.length) {
                const restore = new Set(prev);
                let restored = 0;
                for (const item of regexScriptList()) {
                    if (item && restore.has(String(item.id)) && item.disabled === true) {
                        item.disabled = false;
                        restored += 1;
                    }
                }
                if (restored) {
                    const ctx = window.SillyTavern.getContext();
                    if (typeof ctx.saveSettingsDebounced === 'function') ctx.saveSettingsDebounced();
                    if (!silent) {
                        toast('warn', '正则脚本被整体关掉了，已按上次记录恢复 ' + restored + ' 条');
                    }
                    syncRegexPanel();
                    return;
                }
            }
            if (ids.length && (!prev || prev.length !== ids.length || prev.join('|') !== ids.join('|'))) {
                store.regexGuard = { ids: ids, at: Date.now() };
                persistStore();
            }
        }
        syncRegexPanel();
    }


    /* 人设增删改名后缓存要失效，否则浮层里还是旧名字（宿主发的事件，不轮询） */
    function bindPersonaCacheRefresh() {
        /* 人设抽屉是懒渲染：第一次打开时才把面板塞进 DOM。打开后补挂一次横条，
           这样总开关重开时即使面板当时还没渲染，用户一开抽屉就补上。 */
        try {
            const icon = document.querySelector('#persona-management-button .drawer-icon');
            if (icon && icon.dataset.wbmPersonaWatch !== VERSION) {
                icon.dataset.wbmPersonaWatch = VERSION;
                icon.addEventListener('click', () => { setTimeout(() => { try { ensurePersonaBarLater(); } catch (err) { /* 忽略 */ } }, 120); });
            }
        } catch (err) { /* 忽略 */ }
        if (window.__wbmPersonaCacheBound === VERSION) return;
        const ctx = stCtx();
        if (!ctx || !ctx.eventSource || typeof ctx.eventSource.on !== 'function' || !ctx.eventTypes) return;
        window.__wbmPersonaCacheBound = VERSION;
        ['PERSONA_CHANGED', 'PERSONA_CREATED', 'PERSONA_UPDATED', 'PERSONA_RENAMED', 'PERSONA_DELETED'].forEach((name) => {
            const type = ctx.eventTypes[name];
            if (!type) return;
            ctx.eventSource.on(type, () => {
                personaDropIdCache();
                syncPersonaBar();
            });
        });
    }

    /* 正则面板跟着「当前预设」走：面板文字写的就是当前预设的许可状态，
       换预设不刷新就会显示上一个预设的结论（2026-10-22 实测：面板写着「Default」，
       实际已经是「Izumi 1004 政委改」）。宿主在预设切换后会发 PRESET_CHANGED，
       只挂一个监听，不做轮询。 */
    function bindRegexPanelRefresh() {
        if (window.__wbmRegexPanelBound === VERSION) return;
        const ctx = stCtx();
        if (!ctx || !ctx.eventSource || typeof ctx.eventSource.on !== 'function' || !ctx.eventTypes) return;
        window.__wbmRegexPanelBound = VERSION;
        let timer = null;
        const kick = () => {
            if (timer) clearTimeout(timer);
            timer = setTimeout(() => {
                timer = null;
                if (!enhancementsOn()) return;
                syncRegexPanel();
            }, 120);
        };
        ['PRESET_CHANGED', 'MAIN_API_CHANGED'].forEach((name) => {
            const evt = ctx.eventTypes[name];
            if (!evt) return;
            try { ctx.eventSource.on(evt, kick); } catch (err) { /* 不认识这个事件就跳过 */ }
        });
        /* 1.3.39：换了预设就该退出排序模式（master 2026-10-22：「我们切换预设居然不自动退出编辑模式吗？
           应该退出的吧？」）。排序态里存的是旧预设的勾选与序号，留着只会误导。
           不按 DOM 回写顺序（skipRepair），宿主这时正在重绘。 */
        const onPresetChanged = () => {
            if (!pmSortOn) return;
            try { exitPmSort({ skipRepair: true }); } catch (err) { console.warn('[wbm] 换预设退出排序失败', err); }
        };
        const presetEvt = ctx.eventTypes.PRESET_CHANGED;
        if (presetEvt) { try { ctx.eventSource.on(presetEvt, onPresetChanged); } catch (err) { /* 忽略 */ } }
    }

    /* 提示词行的红色「移除」键（detach，fa-link-slash）：点一下就把条目从预设里摘掉，
       master 2026-10-21 误点过。这里加一道确认，确认后才放行给酒馆自己的处理器。 */
    function bindPromptDetachGuard() {
        if (window.__wbmDetachGuard === VERSION) return;
        window.__wbmDetachGuard = VERSION;

        document.addEventListener('click', async (event) => {
            const hit = event.target instanceof Element ? event.target.closest('.prompt-manager-detach-action') : null;
            if (!hit) return;
            if (window.__wbmDetachOk === true) { window.__wbmDetachOk = false; return; }
            event.preventDefault();
            event.stopPropagation();
            event.stopImmediatePropagation();

            const row = hit.closest('li');
            const nameEl = row ? row.querySelector('.completion_prompt_manager_prompt_name, .prompt_manager_prompt_name') : null;
            const name = (nameEl ? nameEl.textContent : '').trim() || '这条提示词';
            // 注意：本文件的模块作用域里没有 ctx，必须每次现取
            const ctx = SillyTavern.getContext();
            const verdict = await ctx.callGenericPopup(
                '要从当前预设里移除「' + name + '」吗？',
                ctx.POPUP_TYPE.CONFIRM,
                '',
                { okButton: '移除', cancelButton: '取消' },
            );
            if (verdict !== ctx.POPUP_RESULT.AFFIRMATIVE) return;

            window.__wbmDetachOk = true;
            hit.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
            setTimeout(() => { window.__wbmDetachOk = false; }, 800);
        }, true);
    }

    /* ---------------- ⑤ 人设管理：分组 + 手机折叠 ----------------
       人设面板原生只有搜索、A-Z、分页。这里加一排分组胶囊（全部 / 未分组 / 自建组），
       点「设置分组」在浮层里给每个头像挑组；手机端左栏整块可收起，先看当前人设与描述。 */
    let personaBusy = false;

    function personaIdOf(container) {
        return container ? String(container.dataset.avatarId || '') : '';
    }

    function personaGroupOf(id) {
        const map = (store.personaGroups && typeof store.personaGroups === 'object') ? store.personaGroups : {};
        const name = map[id];
        return (typeof name === 'string' && name.trim()) ? name.trim() : '';
    }

    function personaGroupNames() {
        const map = (store.personaGroups && typeof store.personaGroups === 'object') ? store.personaGroups : {};
        const set = new Set();
        Object.keys(map).forEach((key) => {
            const value = map[key];
            if (typeof value === 'string' && value.trim()) set.add(value.trim());
        });
        return Array.from(set).sort((a, b) => String(a).localeCompare(String(b), 'zh-Hans-CN'));
    }

    function setPersonaGroup(id, group) {
        if (!id) return;
        if (!store.personaGroups || typeof store.personaGroups !== 'object') store.personaGroups = {};
        const name = String(group || '').trim();
        if (name) store.personaGroups[id] = name;
        else delete store.personaGroups[id];
        persistStore();
        applyPersonaFilter();
        syncPersonaBar();
    }

    /* 宿主的人设列表是分页渲染的（默认 5 个/页），DOM 里只有当前页。
       只把不匹配的盒子藏起来，碰上「这一页的人设全在组里」就整页空白——
       master 2026-10-22 报的「切换分组无效」正是这个：他那一页恰好人设都在组里。
       做法：按组显示时临时把每页条数拉到 1000，让所有头像都进 DOM；回到「全部」还原。 */
    let personaPagesApi = null;

    async function personaHostApi() {
        if (personaPagesApi) return personaPagesApi;
        try {
            const acct = await import('/scripts/util/AccountStorage.js');
            const pmod = await import('/scripts/personas.js');
            if (!acct || !pmod || !acct.accountStorage) return null;
            personaPagesApi = { storage: acct.accountStorage, personas: pmod };
        } catch (err) {
            console.warn('[wbm] 取人设分页接口失败', err);
            personaPagesApi = null;
        }
        return personaPagesApi;
    }

    function personaFilterActive() {
        return String(store.personaFilter || '') !== '';
    }

    /* 全部头像 id 缓存：宿主每取一次都要 POST /api/avatars/get，分组计数、人数统计
       反复触发会把这条接口打爆（master 2026-10-23 报「现在的我就已经有点卡了」）。
       TT 版酒馆是把 userAvatars 缓存在模块级变量里——这里只借这个思路，代码是自己的。 */
    let personaIdCache = null;

    function personaDropIdCache() {
        personaIdCache = null;
    }

    async function personaAllIds(force) {
        if (!force && Array.isArray(personaIdCache)) return personaIdCache;
        try {
            const api = await personaHostApi();
            if (api && typeof api.personas.getUserAvatars === 'function') {
                const ids = await api.personas.getUserAvatars(false);
                if (Array.isArray(ids)) {
                    personaIdCache = ids.slice();
                    return personaIdCache;
                }
            }
        } catch (err) {
            console.warn('[wbm] 取头像 id 失败', err);
        }
        /* 宿主接口拿不到时退回当前页 DOM，至少不让界面空掉 */
        return Array.from(document.querySelectorAll('#user_avatar_block .avatar-container'))
            .map((box) => personaIdOf(box))
            .filter(Boolean);
    }

    /* 按组显示时宿主必须把整份人设都画出来，客户端才藏得掉——这是宿主的契约。
       但每页条数只按「真实人数」取最小值：以前固定 1000，人设一多就是整页重渲 + 1000 个
       带头像的盒子进 DOM，滚动都卡（master 2026-10-23 的原话）。 */
    async function personaApplyPaging() {
        const api = await personaHostApi();
        if (!api || typeof api.personas.getUserAvatars !== 'function') return;
        const key = 'Personas_PerPage';
        try {
            if (personaFilterActive()) {
                const ids = await personaAllIds();
                const need = Math.max(1, Array.isArray(ids) ? ids.length : 0);
                const target = String(need);
                if (String(api.storage.getItem(key) || '') === target) return;
                if (!store.personaPerPageSaved) {
                    store.personaPerPageSaved = String(api.storage.getItem(key) || '') || '5';
                    persistStore();
                }
                api.storage.setItem(key, target);
                await api.personas.getUserAvatars(true);
                return;
            }
            if (store.personaPerPageSaved) {
                const back = String(store.personaPerPageSaved) || '5';
                store.personaPerPageSaved = '';
                persistStore();
                api.storage.setItem(key, back);
                await api.personas.getUserAvatars(true);
            }
        } catch (err) {
            console.warn('[wbm] 人设分页调整失败', err);
        }
    }

    /* 分组计数：按宿主给的全部头像 id 算，不能只看当前页 */
    async function personaGroupCounts() {
        const out = { total: 0, none: 0, groups: {} };
        const ids = await personaAllIds();
        out.total = ids.length;
        personaTotalCount = ids.length;
        ids.forEach((id) => {
            const group = personaGroupOf(id);
            if (!group) out.none += 1;
            else out.groups[group] = (out.groups[group] || 0) + 1;
        });
        return out;
    }

    /* 管理浮层的数据源：直接读宿主的人设表，不依赖列表 DOM。
       宿主的 .ch_additional_info 就是「用户设定名称（选填，仅显示）」；
       重名的几个人设只显示名字根本分不清（master 2026-10-23 的截图）。 */
    async function personaAllRows() {
        const ids = await personaAllIds(true);
        const ctx = stCtx();
        const pu = (ctx && ctx.powerUserSettings) || {};
        const names = (pu.personas && typeof pu.personas === 'object') ? pu.personas : {};
        const descs = (pu.persona_descriptions && typeof pu.persona_descriptions === 'object') ? pu.persona_descriptions : {};
        personaTotalCount = ids.length;
        const rows = ids.map((id) => {
            const desc = descs[id] || {};
            return {
                id,
                name: String(names[id] || '').trim() || String(id || '').replace(/\.[a-z0-9]+$/i, ''),
                title: String(desc.title || '').trim(),
                group: personaGroupOf(id),
            };
        });
        rows.sort((a, b) => String(a.name).localeCompare(String(b.name), 'zh-Hans-CN') || String(a.id).localeCompare(String(b.id)));
        return rows;
    }

    /* 每页条数可调：按分组显示、设置分组浮层共用这一档（master 2026-10-23：
       「按分组显示能不能也做到10个一页的分页功能？或者都改成能够自定义一页数量」）。 */
    const WBM_PERSONA_PAGE_SIZES = [5, 10, 20, 50];
    let personaGroupPage = 0;
    /* 当前分组里到底有多少个：横条那句「N / M 个人设」要用它，
       不能数 DOM——分页之后 DOM 里可见的只有当前页那几个。 */
    let personaMatchedCount = 0;

    function wbmPersonaPageSize() {
        const n = Number(store.personaPageSize);
        return WBM_PERSONA_PAGE_SIZES.indexOf(n) >= 0 ? n : 10;
    }

    function setPersonaPageSize(size) {
        const n = Number(size);
        if (WBM_PERSONA_PAGE_SIZES.indexOf(n) < 0) return wbmPersonaPageSize();
        store.personaPageSize = n;
        persistStore();
        personaGroupPage = 0;
        /* 正在按分组显示时立刻按新条数重排，不用等下次开关 */
        if (personaFilterActive()) applyPersonaFilter();
        return n;
    }

    /* 藏掉一行时连 img 的 src 一起摘下来：49 个不可见的头像同时解码才是真的卡，
       只改 display 浏览器照样把图都读进内存（master 2026-10-23 的顾虑）。 */
    function setPersonaBoxVisible(box, show) {
        box.style.display = show ? '' : 'none';
        const img = box.querySelector('.avatar img') || box.querySelector('img');
        if (!img) return;
        if (!show) {
            const src = img.getAttribute('src');
            if (src) {
                img.dataset.wbmSrc = src;
                img.removeAttribute('src');
            }
            return;
        }
        if (img.dataset.wbmSrc) {
            img.setAttribute('src', img.dataset.wbmSrc);
            delete img.dataset.wbmSrc;
        }
    }

    /* 组内页码挂在我们自己的横条里、独占第二行：宿主那排工具条在 390 宽下已经没有空位，
       插进去会被 flex 压成 0×0（1.3.43 首测在手机上量到的）。宿主分页条筛选期间藏起来。 */
    function personaGroupPager() {
        const bar = document.getElementById('wbm-persona-bar');
        if (!bar) return null;
        let node = document.getElementById('wbm-persona-grouppager');
        if (!node) {
            node = el('div', 'wbm-persona-grouppager');
            node.id = 'wbm-persona-grouppager';
            bar.appendChild(node);
        }
        return node;
    }

    function syncPersonaGroupPager(active, matched, pages) {
        const host = document.getElementById('persona_pagination_container');
        const node = personaGroupPager();
        if (!node) return;
        if (!active) {
            if (node.style.display !== 'none') node.style.display = 'none';
            if (host && host.style.display === 'none') host.style.display = '';
            return;
        }
        if (host) host.style.display = 'none';
        /* 基础样式是 display:none，内联必须写具体值——写空串会退回 none（1.3.43 首测：
           页码在 DOM 里、文案也在，但量出来 0×0，就是这个坑） */
        node.style.display = 'flex';
        node.innerHTML = '';
        const prev = el('button', 'wbm-persona-pagebtn', '‹');
        prev.type = 'button';
        prev.title = '上一页';
        prev.disabled = personaGroupPage <= 0;
        prev.addEventListener('click', (event) => {
            event.preventDefault();
            event.stopPropagation();
            if (personaGroupPage <= 0) return;
            personaGroupPage -= 1;
            applyPersonaFilter();
        });
        const next = el('button', 'wbm-persona-pagebtn', '›');
        next.type = 'button';
        next.title = '下一页';
        next.disabled = personaGroupPage >= pages - 1;
        next.addEventListener('click', (event) => {
            event.preventDefault();
            event.stopPropagation();
            if (personaGroupPage >= pages - 1) return;
            personaGroupPage += 1;
            applyPersonaFilter();
        });
        node.appendChild(prev);
        node.appendChild(el('span', 'wbm-persona-pageinfo', (personaGroupPage + 1) + ' / ' + pages + ' 页 · ' + matched + ' 个'));
        node.appendChild(next);
        node.dataset.page = String(personaGroupPage + 1);
        node.dataset.pages = String(pages);
    }

    function applyPersonaFilter() {
        if (!featureOn('persona')) return;
        if (!enhancementsOn()) return;
        const active = String(store.personaFilter || '');
        const boxes = Array.from(document.querySelectorAll('#user_avatar_block .avatar-container'));
        personaBusy = true;
        try {
            const matched = [];
            boxes.forEach((box) => {
                const group = personaGroupOf(personaIdOf(box));
                if (!active || (active === '__none__' ? !group : group === active)) matched.push(box);
                /* 标签挂在名字块里（名字右边）。原来挂在 .avatar-container 上，
                   会被整块底部挤走，看着像没有标签（master 2026-10-22 报的 ①）。 */
                const host = box.querySelector('.character_name_block') || box;
                let badge = box.querySelector('.wbm-persona-tag');
                if (!badge) badge = el('span', 'wbm-persona-tag');
                if (badge.parentNode !== host) host.appendChild(badge);
                const label = group || '未分组';
                if (badge.textContent !== label) badge.textContent = label;
                badge.classList.toggle('wbm-persona-tag-none', !group);
            });
            const size = wbmPersonaPageSize();
            const pages = Math.max(1, Math.ceil(matched.length / size));
            if (personaGroupPage > pages - 1) personaGroupPage = pages - 1;
            if (personaGroupPage < 0) personaGroupPage = 0;
            const from = active ? personaGroupPage * size : 0;
            const upto = active ? from + size : boxes.length;
            const wanted = active ? new Set(matched.slice(from, upto)) : null;
            boxes.forEach((box) => {
                setPersonaBoxVisible(box, active ? wanted.has(box) : true);
            });
            personaMatchedCount = matched.length;
            syncPersonaGroupPager(active, matched.length, pages);
        } finally {
            personaBusy = false;
        }
        syncPersonaBar();
        personaApplyPaging().catch(() => {});
    }

    function personaFilterLabel() {
        const active = String(store.personaFilter || '');
        if (!active) return '全部';
        if (active === '__none__') return '未分组';
        return active;
    }

    /* 全部人设数（不受分页影响），浮层里算出来就记下来给横条用 */
    let personaTotalCount = 0;

    /* 切换分组后让横条自己闪一下：短促的一次高亮，不轮询、不改布局 */
    function flashPersonaBar() {
        const bar = document.getElementById('wbm-persona-bar');
        if (!bar) return;
        bar.classList.remove('wbm-flash');
        void bar.offsetWidth;
        bar.classList.add('wbm-flash');
        setTimeout(() => bar.classList.remove('wbm-flash'), 700);
    }

    function syncPersonaBar() {
        const bar = document.getElementById('wbm-persona-bar');
        if (!bar) return;
        const label = bar.querySelector('.wbm-persona-filter-label');
        if (label) {
            const text = '按分组显示：' + personaFilterLabel();
            if (label.textContent !== text) label.textContent = text;
        }
        const hint = bar.querySelector('.wbm-persona-hint');
        if (hint) {
            const boxes = Array.from(document.querySelectorAll('#user_avatar_block .avatar-container'));
            const total = personaTotalCount || boxes.length;
            /* 筛选态用分组命中数：DOM 里可见的只是当前那一页，数它会变成「10 / 29」这种假数 */
            const shown = personaFilterActive() ? personaMatchedCount : total;
            const text = personaFilterActive() ? (shown + ' / ' + total + ' 个人设') : (total ? (total + ' 个人设') : '');
            if (hint.textContent !== text) hint.textContent = text;
        }
    }

    /* 列表里真正的名字在 .ch_name（见 index.html 的 #user_avatar_template）；
       .persona_name 只有右侧控制区那份才有，取到的是空，于是界面一直显示图片文件名。 */
    function personaDisplayName(box) {
        const pick = (sel) => {
            const node = box ? box.querySelector(sel) : null;
            return node ? String(node.textContent || '').trim() : '';
        };
        const name = pick('.ch_name') || pick('.persona_name');
        if (name) return name;
        const desc = pick('.ch_description').split('\n')[0].trim();
        if (desc) return desc;
        return String((box && box.dataset.avatarId) || '').replace(/\.[a-z0-9]+$/i, '');
    }

    function personaRows() {
        return Array.from(document.querySelectorAll('#user_avatar_block .avatar-container')).map((box) => {
            const id = personaIdOf(box);
            return { id, name: personaDisplayName(box) || id, group: personaGroupOf(id) };
        });
    }

    /* 按分组显示：外面只留一条横条，点开这一层再选。
       层内顺序按 master 定的：全部 → 各组（没有就不出现）→ 未分组，只做显示切换。 */
    async function openPersonaFilterPicker() {
        document.querySelectorAll('.wbm-picker').forEach((old) => old.remove());
        const { mask, sheet } = makePickerShell({ flat: true });
        sheet.appendChild(el('div', 'wbm-picker-grip'));
        const titleRow = el('div', 'wbm-picker-titlerow');
        titleRow.appendChild(el('div', 'wbm-picker-title', '按分组显示'));
        const filterClose = el('button', 'wbm-picker-close', '✕');
        filterClose.type = 'button';
        filterClose.setAttribute('data-role', 'picker-close');
        filterClose.title = '关闭';
        titleRow.appendChild(filterClose);
        sheet.appendChild(titleRow);
        const listEl = el('div', 'wbm-picker-list');
        sheet.appendChild(listEl);
        document.documentElement.appendChild(mask);
        const active = String(store.personaFilter || '');
        const counts = await personaGroupCounts();
        const groups = personaGroupNames().filter((name) => counts.groups[name]);
        const items = [{ key: '', label: '全部', count: counts.total }]
            .concat(groups.map((name) => ({ key: name, label: name, count: counts.groups[name] || 0 })))
            .concat([{ key: '__none__', label: '未分组', count: counts.none }]);
        listEl.innerHTML = '';
        items.forEach((item) => {
            if (!item.count && item.key && item.key !== '__none__') return;
            const row = el('div', 'wbm-picker-row wbm-persona-filter-row' + (item.key === active ? ' on' : ''));
            row.dataset.key = item.key;
            const line = el('div', 'wbm-picker-line');
            line.appendChild(el('span', 'wbm-picker-name', item.label));
            line.appendChild(el('span', 'wbm-picker-count', item.count + ' 个'));
            row.appendChild(line);
            const pick = (event) => {
                if (event) {
                    event.preventDefault();
                    event.stopPropagation();
                }
                store.personaFilter = item.key;
                persistStore();
                personaGroupPage = 0;
                closeEditorPicker();
                syncPersonaBar();
                applyPersonaFilter();
                /* 「点完到底切没切」要有可感知的反馈：横条闪一下 + 一句带人数的提示 */
                flashPersonaBar();
                toast('ok', '已切换到「' + personaFilterLabel() + '」，' + (item.key ? (item.count + ' 个人设') : (counts.total + ' 个人设')));
            };
            row.addEventListener('click', pick);
            listEl.appendChild(row);
        });
        if (!listEl.children.length) listEl.appendChild(el('div', 'wbm-picker-empty', '还没有分组：点右边「设置分组」给头像分组'));
    }

    /* 设置分组浮层（1.3.42）：列表不再让宿主整份重渲，而是自己按数据渲染、每页 10 个翻页。
       每行同时显示名字与「用户设定名称」，右侧是当前分组。 */
    async function openPersonaGroupManager() {
        document.querySelectorAll('.wbm-picker').forEach((old) => old.remove());
        const { mask, sheet } = makePickerShell({ flat: true });
        sheet.appendChild(el('div', 'wbm-picker-grip'));
        const { head, input } = buildPickerHead('搜索名字或用户设定名称');
        const titleRow = el('div', 'wbm-picker-titlerow');
        titleRow.appendChild(el('div', 'wbm-picker-title', '设置分组'));
        const closeBtn = el('button', 'wbm-picker-close', '✕');
        closeBtn.type = 'button';
        closeBtn.setAttribute('data-role', 'picker-close');
        closeBtn.title = '关闭';
        titleRow.appendChild(closeBtn);
        const listEl = el('div', 'wbm-picker-list');
        const pager = el('div', 'wbm-persona-pager');
        sheet.appendChild(head);
        sheet.appendChild(titleRow);
        sheet.appendChild(listEl);
        sheet.appendChild(pager);
        listEl.appendChild(el('div', 'wbm-picker-empty', '正在读取人设…'));
        document.documentElement.appendChild(mask);

        let PAGE = wbmPersonaPageSize();
        let rows = [];
        let page = 0;

        const syncDatalist = () => {
            const datalist = document.getElementById('wbm-persona-group-list');
            if (!datalist) return;
            datalist.innerHTML = '';
            personaGroupNames().forEach((name) => {
                const option = document.createElement('option');
                option.value = name;
                datalist.appendChild(option);
            });
        };

        const hits = () => {
            const keyword = String(input.value || '').trim().toLowerCase();
            if (!keyword) return rows;
            return rows.filter((row) => (row.name + ' ' + row.title + ' ' + row.id).toLowerCase().includes(keyword));
        };

        const renderPager = (total) => {
            pager.innerHTML = '';
            const pages = Math.max(1, Math.ceil(total / PAGE));
            if (page > pages - 1) page = pages - 1;
            if (page < 0) page = 0;
            const prev = el('button', 'wbm-persona-pagebtn', '上一页');
            prev.type = 'button';
            prev.disabled = page <= 0;
            prev.addEventListener('click', (event) => {
                event.preventDefault();
                event.stopPropagation();
                if (page <= 0) return;
                page -= 1;
                renderRows();
            });
            const next = el('button', 'wbm-persona-pagebtn', '下一页');
            next.type = 'button';
            next.disabled = page >= pages - 1;
            next.addEventListener('click', (event) => {
                event.preventDefault();
                event.stopPropagation();
                if (page >= pages - 1) return;
                page += 1;
                renderRows();
            });
            pager.appendChild(prev);
            pager.appendChild(el('span', 'wbm-persona-pageinfo', (page + 1) + ' / ' + pages + ' 页 · 共 ' + total + ' 个'));
            pager.appendChild(next);
            const sizeBtn = el('button', 'wbm-persona-sizebtn', '每页 ' + PAGE);
            sizeBtn.type = 'button';
            sizeBtn.title = '点一下换一档：5 / 10 / 20 / 50';
            sizeBtn.addEventListener('click', (event) => {
                event.preventDefault();
                event.stopPropagation();
                const idx = WBM_PERSONA_PAGE_SIZES.indexOf(wbmPersonaPageSize());
                setPersonaPageSize(WBM_PERSONA_PAGE_SIZES[(idx + 1) % WBM_PERSONA_PAGE_SIZES.length]);
                PAGE = wbmPersonaPageSize();
                page = 0;
                renderRows();
            });
            pager.appendChild(sizeBtn);
            pager.dataset.total = String(total);
            pager.dataset.page = String(page + 1);
        };

        const openEditor = (item, row) => {
            if (item.querySelector('.wbm-preset-saverow')) return;
            const saver = el('div', 'wbm-preset-saverow');
            const box = el('input', 'wbm-name-input-inline');
            box.type = 'text';
            box.placeholder = '组名，留空＝未分组';
            box.value = row.group || '';
            box.setAttribute('list', 'wbm-persona-group-list');
            const ok = el('button', 'wbm-preset-tool', '确定');
            ok.type = 'button';
            const cancel = el('button', 'wbm-preset-tool', '取消');
            cancel.type = 'button';
            saver.appendChild(box);
            saver.appendChild(ok);
            saver.appendChild(cancel);
            item.appendChild(saver);
            box.focus();
            box.select();
            const done = (commit) => {
                if (commit) {
                    setPersonaGroup(row.id, box.value);
                    row.group = String(box.value || '').trim();
                    const tag = item.querySelector('.wbm-persona-row-group');
                    if (tag) {
                        tag.textContent = row.group || '未分组';
                        tag.classList.toggle('wbm-persona-row-group-none', !row.group);
                    }
                    syncDatalist();
                }
                saver.remove();
            };
            ok.addEventListener('click', (event) => { event.preventDefault(); event.stopPropagation(); done(true); });
            cancel.addEventListener('click', (event) => { event.preventDefault(); event.stopPropagation(); done(false); });
            box.addEventListener('keydown', (event) => {
                if (event.key === 'Enter') { event.preventDefault(); event.stopPropagation(); done(true); }
                if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); done(false); }
            });
        };

        const renderRows = () => {
            listEl.innerHTML = '';
            const list = hits();
            const start = page * PAGE;
            list.slice(start, start + PAGE).forEach((row) => {
                const item = el('div', 'wbm-picker-row wbm-persona-row');
                item.dataset.id = row.id;
                item.title = row.id;
                item.appendChild(el('span', 'wbm-picker-name', row.name));
                if (row.title) item.appendChild(el('span', 'wbm-persona-row-title', row.title));
                item.appendChild(el('span', 'wbm-persona-row-group' + (row.group ? '' : ' wbm-persona-row-group-none'), row.group || '未分组'));
                const editBtn = el('button', 'wbm-preset-tool', '设置分组');
                editBtn.type = 'button';
                editBtn.addEventListener('click', (event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    openEditor(item, row);
                });
                item.appendChild(editBtn);
                /* 整行也能点开：行看着像按钮，只认右端那个小键就会「点了没反应」 */
                item.addEventListener('click', (event) => {
                    if (event.target.closest('.wbm-preset-tool') || event.target.closest('.wbm-preset-saverow')) return;
                    openEditor(item, row);
                });
                listEl.appendChild(item);
            });
            if (!list.length) listEl.appendChild(el('div', 'wbm-picker-empty', '没有匹配的人设'));
            renderPager(list.length);
        };

        rows = await personaAllRows();
        syncPersonaBar();
        syncDatalist();
        renderRows();
        input.addEventListener('input', () => { page = 0; renderRows(); });
        setTimeout(() => input.focus(), 40);
    }

    function ensurePersonaCollapse() {
        const block = document.getElementById('persona-management-block');
        if (!block) return;
        const left = block.querySelector('.persona_management_left_column');
        if (!left || left.querySelector('#wbm-persona-collapse')) return;
        const btn = el('button', 'menu_button wbm-persona-collapse', '收起人设列表');
        btn.type = 'button';
        btn.id = 'wbm-persona-collapse';
        left.insertBefore(btn, left.firstChild);
        const setCollapsed = (on) => {
            left.classList.toggle('wbm-collapsed', !!on);
            btn.textContent = on ? '展开人设列表' : '收起人设列表';
        };
        btn.addEventListener('click', (event) => {
            event.preventDefault();
            event.stopPropagation();
            setCollapsed(!left.classList.contains('wbm-collapsed'));
        });
        if (compactViewport()) setCollapsed(true);
    }

    /* 总开关关→开后宿主的人设面板可能还没渲染出来，ensurePersonaBar 会空跑一次；
       这里做有限次重试，挂上就停（1.3.58 实测：不重试则 pb 一直是 0）。 */
    let personaMountTries = 0;
    function ensurePersonaBarLater() {
        if (!featureOn('persona')) return;
        if (document.getElementById('wbm-persona-bar')) { applyPersonaFilter(); return; }
        personaMountTries = 0;
        const tick = () => {
            if (!featureOn('persona')) return;
            if (document.getElementById('wbm-persona-bar')) { applyPersonaFilter(); return; }
            personaMountTries += 1;
            try { ensurePersonaBar(); } catch (err) { /* 下一轮再试 */ }
            if (!document.getElementById('wbm-persona-bar') && personaMountTries < 10) {
                setTimeout(tick, 500);
            }
        };
        setTimeout(tick, 0);
    }

    function ensurePersonaBar() {
        if (!featureOn('persona')) { teardownPersona(); return; }
        const block = document.getElementById('persona-management-block');
        const list = document.getElementById('user_avatar_block');
        if (!block || !list) return;
        const left = block.querySelector('.persona_management_left_column');
        if (!left) return;
        ensurePersonaCollapse();
        if (document.getElementById('wbm-persona-bar')) {
            applyPersonaFilter();
            return;
        }
        const bar = document.createElement('div');
        bar.id = 'wbm-persona-bar';
        bar.className = 'wbm-persona-bar';
        bar.innerHTML = '<button type="button" class="wbm-persona-filter">'
            + '<span class="wbm-persona-filter-label">按分组显示：全部</span>'
            + '</button>'
            + '<button type="button" class="wbm-persona-manage">设置分组</button>'
            + '<span class="wbm-persona-hint"></span>'
            + '<datalist id="wbm-persona-group-list"></datalist>';
        left.insertBefore(bar, list);
        const filterBtn = bar.querySelector('.wbm-persona-filter');
        /* 图标一律内联 SVG：宿主那套 Font Awesome 是子集，缺字形就画成空框 */
        try {
            if (filterBtn && !filterBtn.querySelector('.wbm-ico')) filterBtn.appendChild(wbmIcon('chev'));
        } catch (err) { /* 图标挂了不影响功能 */ }
        if (filterBtn) {
            filterBtn.addEventListener('click', (event) => {
                event.preventDefault();
                event.stopPropagation();
                openPersonaFilterPicker().catch((err) => console.warn('[wbm] 打开分组切换失败', err));
            });
        }
        bar.querySelector('.wbm-persona-manage').addEventListener('click', (event) => {
            event.preventDefault();
            event.stopPropagation();
            openPersonaGroupManager();
        });
        const observer = new MutationObserver(() => {
            if (personaBusy) return;
            applyPersonaFilter();
            syncPersonaBar();
        });
        observer.observe(list, { childList: true, subtree: true });
        syncPersonaBar();
        applyPersonaFilter();
        /* 总数要走宿主接口拿（DOM 里只有当前页那几个） */
        personaGroupCounts().then(() => syncPersonaBar()).catch(() => {});
    }

    /* 模块级开关：master 要求按模块开，不要把每个小功能都拆成独立开关。
       一个模块 = 一组必须一起工作的功能，关掉就整块回到原生酒馆。 */
    function featureFlagGet(key) {
        if (key === 'entryClickLock') return clickLockOn();
        if (key === 'msgDblClickEdit') return store.msgDblClickEdit !== false;
        if (key === 'editBarBothEnds') return editBarOn();
        if (key === 'swipeTakeover') return store.swipeTakeover !== false;
        return featureOn(key);
    }
    function featureFlagSet(key, on) {
        if (key === 'entryClickLock') { store.entryClickLock = !!on; persistStore(); return; }
        if (key === 'msgDblClickEdit') { store.msgDblClickEdit = !!on; persistStore(); return; }
        if (key === 'editBarBothEnds') { store.editBarBothEnds = !!on; persistStore(); return; }
        if (key === 'swipeTakeover') { store.swipeTakeover = !!on; persistStore(); return; }
        setFeature(key, !!on);
    }

    function panelNote(id, text) {
        const node = document.getElementById(id);
        if (node) node.textContent = text;
    }

    /* 提示词编辑框：只在 html 上挂一个类，样式纯 CSS，不去操作酒馆自己的按钮 */
    function syncPromptEditorCap() {
        try {
            document.documentElement.classList.toggle('wbm-pmcap-on', featureFlagGet('promptEditorCap'));
        } catch (err) { /* 页面还没 documentElement 时跳过 */ }
    }

    function syncPanelNotes() {
        panelNote('wbm-note-enhance', enhancementsOn()
            ? '当前：全部增强生效中。'
            : '当前：已全部关闭，界面就是原生酒馆；下面各开关的状态都保留着，重新勾上即恢复。');
        panelNote('wbm-note-entrylock', featureFlagGet('entryClickLock')
            ? '已开启：单击选中条目，双击才进入编辑。'
            : '已关闭：单击条目即可编辑（原生行为）。');
        panelNote('wbm-note-headeralign', featureFlagGet('headerAlign')
            ? '已开启：表头单排时对齐各列；行折成两排时改用每格小标题。'
            : '已关闭：表头与条目都交给原生样式。');
        panelNote('wbm-note-msgdbl', featureFlagGet('msgDblClickEdit')
            ? '已开启：双击消息正文进入编辑。'
            : '已关闭：只能用铅笔按钮编辑。');
        panelNote('wbm-note-editbar', featureFlagGet('editBarBothEnds')
            ? '已开启：编辑框上下都有保存 / 取消栏。'
            : '已关闭：编辑框只保留原生顶部按钮。');
        panelNote('wbm-note-swipe', featureFlagGet('swipeTakeover')
            ? '已开启：备选页码固定在气泡下方正中，点中间打开备选列表。'
            : '已关闭：备选页码留在原位。');
        panelNote('wbm-note-promptmgr', featureFlagGet('promptMgr')
            ? '已开启：提示词管理器底部有复制 / 查找 / 排序三键，列表右上有筛选框。'
            : '已关闭：提示词管理器只用原生界面。');
        panelNote('wbm-note-talkpreset', featureFlagGet('talkPreset')
            ? '已开启：预设下拉旁多一个「管理」键，可分组、重命名、排序。'
            : '已关闭：预设下拉回到原生。');
        panelNote('wbm-note-pmeditorcap', featureFlagGet('promptEditorCap')
            ? '已开启：编辑框最高约占半屏，长内容在框里滚动，底部按钮始终看得见。'
            : '已关闭：编辑框按酒馆原样展开（TT 酒馆默认就是全展开）。');
        panelNote('wbm-note-persona', featureFlagGet('persona')
            ? '已开启：人设面板顶部有「按分组显示」与「设置分组」。'
            : '已关闭：人设面板保持原生，分组数据仍保留。');
        panelNote('wbm-note-regexguard', featureFlagGet('regexGuard')
            ? '已开启：正则被整批关掉时，按上次记录自动恢复。'
            : '已关闭：不自动恢复，单条开关始终不受影响。');
        panelNote('wbm-note-frontendguard', featureFlagGet('frontendGuard')
            ? '已开启：酒馆助手漏渲染前端卡时，请它重建一次。'
            : '已关闭：不干预酒馆助手的渲染。');
        const content = document.querySelector('#wbm-settings .inline-drawer-content');
        if (content) content.dataset.wbmIdle = enhancementsOn() ? '0' : '1';
        syncPromptEditorCap();
    }

    function injectSettingsPanel() {
        const host = document.getElementById('extensions_settings');
        if (!host || document.getElementById('wbm-settings')) return;
        const wrap = document.createElement('div');
        wrap.id = 'wbm-settings';
        wrap.className = 'inline-drawer';
        wrap.innerHTML = [
            '<div class="inline-drawer-toggle inline-drawer-header">',
            '<b>双端酒馆原生功能优化</b>',
            '<div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>',
            '</div>',
            '<div class="inline-drawer-content">',

            '<label class="checkbox_label wbm-opt-label" for="wbm-opt-enhance">',
            '<input id="wbm-opt-enhance" type="checkbox">',
            '<span class="wbm-opt-text"><span class="wbm-opt-title">全部关闭（回到原生酒馆）</span>',
            '<span class="wbm-opt-note" id="wbm-note-enhance"></span></span>',
            '</label>',

            '<div class="wbm-opt-group"><b>世界书功能</b></div>',
            '<label class="checkbox_label wbm-opt-label" for="wbm-opt-entrylock">',
            '<input id="wbm-opt-entrylock" type="checkbox">',
            '<span class="wbm-opt-text"><span class="wbm-opt-title">双击修改世界书条目（单击不改）</span>',
            '<span class="wbm-opt-note" id="wbm-note-entrylock"></span></span>',
            '</label>',

            '<label class="checkbox_label wbm-opt-label" for="wbm-opt-headeralign">',
            '<input id="wbm-opt-headeralign" type="checkbox">',
            '<span class="wbm-opt-text"><span class="wbm-opt-title">条目表头自动对齐</span>',
            '<span class="wbm-opt-note" id="wbm-note-headeralign"></span></span>',
            '</label>',

            '<div class="wbm-opt-group"><b>对话功能</b></div>',
            '<label class="checkbox_label wbm-opt-label" for="wbm-opt-msgdbl">',
            '<input id="wbm-opt-msgdbl" type="checkbox">',
            '<span class="wbm-opt-text"><span class="wbm-opt-title">双击正文进入编辑</span>',
            '<span class="wbm-opt-note" id="wbm-note-msgdbl"></span></span>',
            '</label>',

            '<label class="checkbox_label wbm-opt-label" for="wbm-opt-editbar">',
            '<input id="wbm-opt-editbar" type="checkbox">',
            '<span class="wbm-opt-text"><span class="wbm-opt-title">编辑框上下操作栏</span>',
            '<span class="wbm-opt-note" id="wbm-note-editbar"></span></span>',
            '</label>',

            '<label class="checkbox_label wbm-opt-label" for="wbm-opt-swipe">',
            '<input id="wbm-opt-swipe" type="checkbox">',
            '<span class="wbm-opt-text"><span class="wbm-opt-title">接管备选回复页码</span>',
            '<span class="wbm-opt-note" id="wbm-note-swipe"></span></span>',
            '</label>',

            '<div class="wbm-opt-group"><b>提示词与预设</b></div>',
            '<label class="checkbox_label wbm-opt-label" for="wbm-opt-promptmgr">',
            '<input id="wbm-opt-promptmgr" type="checkbox">',
            '<span class="wbm-opt-text"><span class="wbm-opt-title">提示词管理器的排序、查找与复制</span>',
            '<span class="wbm-opt-note" id="wbm-note-promptmgr"></span></span>',
            '</label>',

            '<label class="checkbox_label wbm-opt-label" for="wbm-opt-talkpreset">',
            '<input id="wbm-opt-talkpreset" type="checkbox">',
            '<span class="wbm-opt-text"><span class="wbm-opt-title">预设下拉旁的「管理」键与分组</span>',
            '<span class="wbm-opt-note" id="wbm-note-talkpreset"></span></span>',
            '</label>',
            '<label class="checkbox_label wbm-opt-label" for="wbm-opt-pmeditorcap">',
            '<input id="wbm-opt-pmeditorcap" type="checkbox">',
            '<span class="wbm-opt-text"><span class="wbm-opt-title">提示词编辑框限制高度</span>',
            '<span class="wbm-opt-note" id="wbm-note-pmeditorcap"></span></span>',
            '</label>',

            '<div class="wbm-opt-group"><b>人设功能</b></div>',
            '<label class="checkbox_label wbm-opt-label" for="wbm-opt-persona">',
            '<input id="wbm-opt-persona" type="checkbox">',
            '<span class="wbm-opt-text"><span class="wbm-opt-title">按分组显示人设与分页</span>',
            '<span class="wbm-opt-note" id="wbm-note-persona"></span></span>',
            '</label>',

            '<div class="wbm-opt-group"><b>正则防波动</b></div>',
            '<label class="checkbox_label wbm-opt-label" for="wbm-opt-regexguard">',
            '<input id="wbm-opt-regexguard" type="checkbox">',
            '<span class="wbm-opt-text"><span class="wbm-opt-title">正则被整批关闭时自动恢复</span>',
            '<span class="wbm-opt-note" id="wbm-note-regexguard"></span></span>',
            '</label>',

            '<label class="checkbox_label wbm-opt-label" for="wbm-opt-frontendguard">',
            '<input id="wbm-opt-frontendguard" type="checkbox">',
            '<span class="wbm-opt-text"><span class="wbm-opt-title">前端卡漏渲染时补渲染</span>',
            '<span class="wbm-opt-note" id="wbm-note-frontendguard"></span></span>',
            '</label>',

            '<div class="wbm-opt-group"><b>正则脚本</b></div>',
            '<div class="wbm-opt-text"><span class="wbm-opt-note" id="wbm-note-regex"></span></div>',
            '<button id="wbm-regex-allow" class="menu_button" type="button" style="display:none">允许当前预设使用正则</button>',

            '</div>',
        ].join('');
        host.appendChild(wrap);

        const enhanceBox = wrap.querySelector('#wbm-opt-enhance');
        const msgBox = wrap.querySelector('#wbm-opt-msgdbl');
        const lockBox = wrap.querySelector('#wbm-opt-entrylock');
        const barBox = wrap.querySelector('#wbm-opt-editbar');

        if (enhanceBox) {
            enhanceBox.checked = enhancementsOn();
            enhanceBox.addEventListener('change', () => {
                store.enhanceEnabled = !!enhanceBox.checked;
                persistStore();
                if (enhanceBox.checked) applyEnhanceState();
                if (enhanceBox.checked) {
                    /* 全部关闭 → 再打开：卸载是不可逆的（人设横条要等宿主把人设面板渲染出来，
                       提示词工具条要等管理器重绘），逐块重挂容易漏。直接重载一次最稳，
                       代价只有一次刷新。关闭方向仍然就地卸载，不刷新。 */
                    toast('info', '已开启：全部增强生效，正在刷新界面…');
                    /* 酒馆的 saveSettingsDebounced 有 1 秒防抖：刷新太早会把刚改的值丢掉
                       （1.3.58 实测 600ms 刷新后开关又变回关），这里等它落盘再刷。 */
                    setTimeout(() => {
                        try { window.location.reload(); } catch (err) { /* 刷不动就保持当前状态 */ }
                    }, 2400);
                    return;
                }
                toast('info', '已全部关闭：正在刷新回原生界面…');
                /* 关闭方向也重载一次（1.3.0 修）：就地卸载会把我们挂在宿主元素上的排法、
                   宿主自己的 select2 药丸外壳留在半截状态，实测「已启用的世界书」和条目详情
                   会显示不全，与「关掉即回原生」的承诺不符。重载最干净，代价同样一次刷新。 */
                try { saveSettingsDebounced(); } catch (err) { /* 忽略 */ }
                setTimeout(() => {
                    try { window.location.reload(); } catch (err) { /* 刷不动就保持当前状态 */ }
                }, 2400);
            });
        }
        const FEATURE_ROWS = [
            ['wbm-opt-entrylock', 'entryClickLock', '条目单击锁定、双击才改', '条目单击即可编辑'],
            ['wbm-opt-headeralign', 'headerAlign', '条目表头自动对齐', '条目表头交给原生样式'],
            ['wbm-opt-msgdbl', 'msgDblClickEdit', '双击正文进入编辑', '双击正文不再进入编辑'],
            ['wbm-opt-editbar', 'editBarBothEnds', '编辑框上下操作栏', '编辑框只在顶部有按钮'],
            ['wbm-opt-swipe', 'swipeTakeover', '接管备选回复页码', '备选页码回到原位'],
            ['wbm-opt-promptmgr', 'promptMgr', '提示词管理器的排序、查找与复制', '提示词管理器回到原生'],
            ['wbm-opt-talkpreset', 'talkPreset', '预设下拉旁的「管理」键与分组', '预设下拉回到原生'],
            ['wbm-opt-pmeditorcap', 'promptEditorCap', '提示词编辑框在区块内滚动', '提示词编辑框按酒馆原样展开'],
            ['wbm-opt-persona', 'persona', '按分组显示人设与分页', '人设面板回到原生'],
            ['wbm-opt-regexguard', 'regexGuard', '正则被整批关闭时自动恢复', '不再自动恢复正则'],
            ['wbm-opt-frontendguard', 'frontendGuard', '前端卡漏渲染时补渲染', '不干预酒馆助手的渲染'],
        ];
        FEATURE_ROWS.forEach((row) => {
            const box = wrap.querySelector('#' + row[0]);
            if (!box) return;
            box.checked = featureFlagGet(row[1]);
            box.addEventListener('change', () => {
                const on = !!box.checked;
                featureFlagSet(row[1], on);
                applyFeatureToggle(row[1]);
                if (row[1] === 'entryClickLock') { lockEntryContents(); syncLockChip(); }
                if (row[1] === 'msgDblClickEdit') { syncBottomRow(); }
                if (row[1] === 'editBarBothEnds') { syncBottomRow(); }
                if (row[1] === 'swipeTakeover') { applySwipeCounterLayout(); }
                syncPanelNotes();
                toast('info', (on ? '已开启：' : '已关闭：') + (on ? row[2] : row[3]));
            });
        });
        const regexBtn = wrap.querySelector('#wbm-regex-allow');
        if (regexBtn) {
            regexBtn.addEventListener('click', () => { allowRegexForCurrentPreset(); });
        }
        syncPanelNotes();
        regexGuardCheck({ silent: true });
    }

    /* ---------------- 事件（只挂 #WIMultiSelector 容器） ---------------- */

    function onClick(event) {
        const target = event.target;
        if (!(target instanceof Element)) return;
        const host = hostEl();
        if (!host || !host.contains(target)) return;
        const root = document.getElementById(ROOT_ID);
        if (!root || !root.contains(target)) return;

        const roleEl = target.closest('[data-role]');
        if (!roleEl || !root.contains(roleEl)) return;
        const role = roleEl.dataset.role;

        if (role === 'add') {
            event.preventDefault();
            state.addOpen = !state.addOpen;
            if (state.addOpen) {
                /* 打开时快照"当前未启用"的清单，之后启用了也不移出列表，避免跳动 */
                state.addItems = allBooks().filter((b) => !b.on).map((b) => b.name);
                state.addQuery = '';
            }
            state.signature = '';
            render();
            return;
        }

        if (role === 'more') {
            event.preventDefault();
            state.expanded = !state.expanded;
            state.signature = '';
            render();
            return;
        }

        if (role === 'addrow') {
            event.preventDefault();
            const name = roleEl.dataset.name || '';
            if (!name) return;
            setActive(name, !activeSet().has(name));
            return;
        }

        if (role === 'fav') {
            event.preventDefault();
            event.stopPropagation();
            const row = roleEl.closest('.wbm-row');
            const name = row ? String(row.dataset.name || '') : '';
            if (!name) return;
            const favs = favSet();
            if (favs.has(name)) favs.delete(name); else favs.add(name);
            saveFavSet(favs);
            state.signature = '';
            render();
            return;
        }

        if (role === 'favonly') {
            event.preventDefault();
            state.favOnly = !state.favOnly;
            state.signature = '';
            render();
            return;
        }

        if (role === 'favpin') {
            event.preventDefault();
            setFavPin(!favPinOn());
            state.signature = '';
            render();
            return;
        }

        if (role === 'kill') {
            event.preventDefault();
            event.stopPropagation();
            const row = roleEl.closest('.wbm-row');
            if (!row) return;
            requestKill(row.dataset.name || '', row);
            return;
        }

        if (role === 'jump') {
            if (roleEl.classList.contains('confirming')) return;
            jumpToEditor(roleEl.dataset.name || '');
        }
    }

    function onInput(event) {
        const t = event.target;
        if (!(t instanceof HTMLInputElement)) return;
        const role = t.dataset.role;
        if (role === 'addsearch') {
            state.addQuery = t.value;
            applyAddFilter();
        } else if (role === 'actsearch') {
            state.actQuery = t.value;
            applyActFilter();
        }
    }

    function onChanged(event) {
        const t = event.target;
        if (!(t instanceof Element)) return;
        if (t.id === 'world_info' || t.id === 'world_editor_select') {
            if (t.id === 'world_editor_select') updateEditorButton();
            applyEditorOptgroups();
            state.signature = '';
            render();
        }
    }

    /* ---------------- 面板开合 ---------------- */

    function panelVisible() {
        if (window.jQuery) {
            try { return window.jQuery('#WorldInfo').is(':visible'); } catch (e) { /* ignore */ }
        }
        const panel = document.getElementById('WorldInfo');
        if (!panel) return false;
        const rect = panel.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
    }

    /* 收起世界书面板时把展开态与搜索词复位，下次打开是干净状态 */
    function resetPanelState() {
        closeEditorPicker(true);
        if (!state.addOpen && !state.actQuery && !state.expanded && !state.pendingKill) return;
        state.addOpen = false;
        state.addQuery = '';
        state.actQuery = '';
        state.expanded = false;
        clearKill();
        state.signature = '';
        render();
    }

    /* 挂上了却没有高度，说明被别的东西压死了：撤回接管，保留 ST 原生控件 */
    function verifyMount() {
        const root = document.getElementById(ROOT_ID);
        const host = hostEl();
        if (!root || !host) return;
        if (root.offsetHeight >= 20) return;
        console.warn('[wbm] list mounted without height, fallback to native');
        root.remove();
        host.removeAttribute('data-wbm-ready');
        state.signature = '';
    }

    /* ---------------- 网络抖动兜底：样式表重试 ---------------- */

/* ==== WBM_CSS_BEGIN（由 .tmp-wbm-test/patch-inline-css.py 生成，勿手改） ==== */
const WBM_CSS = "/* 世界书增强 · 样式 v1.2.0\n   全部限定在 #WIMultiSelector / #wbm-list 之内，不碰全局，避免与鸡尾酒等扩展互相覆盖。\n   原生控件只在 [data-wbm-ready=\"1\"]（自绘列表已成功挂载）时才隐藏，\n   扩展加载失败或上游改版时属性不会写，ST 原生下拉自动保留。 */\n\n#WIMultiSelector[data-wbm-ready=\"1\"] > .range-block-range > select#world_info,\n#WIMultiSelector[data-wbm-ready=\"1\"] .range-block-range > .select2-container {\n    display: none !important;\n}\n\n#wbm-list,\n#wbm-list * { box-sizing: border-box; }\n\n/* ST 原本给 .range-block-range 的是 flex:5（= basis 0%）。这个值有两个坑：\n   ① 加 min-width:0 会让 Chrome 把它算成 0 宽（内容全被挤成一字一行）；\n   ② 保持 min-width:auto 时，长书名的 min-content 会把它撑得比容器还宽，\n      列表溢出到右栏下面、「收起添加」按钮点不到。\n   改成 basis 100% 后宽度严格等于容器宽，两条坑一起没了。 */\n#WIMultiSelector[data-wbm-ready=\"1\"] > .range-block-range {\n    flex: 0 0 100%;\n    min-width: 0;\n}\n\n/* flex 子项默认 min-width:auto，不接受小于内容宽度。世界书名字是 nowrap，\n   长名会把整条链路顶宽、把「收起添加」按钮推出屏幕。整条链都放开 0。\n   注意：不要给 `#WIMultiSelector > .range-block-range` 加 min-width:0 就完事——\n   见上面的注释，光加 min-width:0 会让它塌成 0 宽。 */\n#WIMultiSelector[data-wbm-ready=\"1\"],\n#wbm-list,\n#wbm-list .wbm-header,\n#wbm-list .wbm-actives,\n#wbm-list .wbm-addpanel,\n#wbm-list .wbm-addlist,\n#wbm-list .wbm-row,\n#wbm-list .wbm-addrow {\n    min-width: 0;\n    max-width: 100%;\n}\n\n#wbm-list {\n    display: flex;\n    flex-direction: column;\n    gap: 6px;\n    margin-top: 6px;\n    width: 100%;\n}\n\n/* ---------- 头部 ---------- */\n#wbm-list .wbm-header {\n    display: flex;\n    flex-wrap: wrap;\n    align-items: center;\n    justify-content: space-between;\n    gap: 6px;\n    min-width: 0;\n}\n#wbm-list .wbm-title {\n    flex: 1 1 auto;\n    min-width: 0;\n    font-size: 12px;\n    opacity: .8;\n    overflow: hidden;\n    text-overflow: ellipsis;\n    white-space: nowrap;\n}\n#wbm-list .wbm-add {\n    flex: 0 0 auto;\n    padding: 3px 9px;\n    font-size: 11.5px;\n    line-height: 1.3;\n    white-space: nowrap;\n    border: 1px solid var(--SmartThemeBorderColor, #666);\n    background: transparent;\n    color: inherit;\n    border-radius: 999px;\n    cursor: pointer;\n}\n\n/* ---------- 搜索框 ---------- */\n#wbm-list .wbm-search {\n    width: 100%;\n    padding: 6px 10px;\n    font-size: 13px;\n    border-radius: 8px;\n    border: 1px solid var(--SmartThemeBorderColor, rgba(255, 255, 255, .15));\n    background: var(--black30a, rgba(0, 0, 0, .2));\n    color: inherit;\n    outline: none;\n}\n\n/* ---------- 提示 ---------- */\n#wbm-list .wbm-tip { font-size: 11px; opacity: .5; }\n\n/* ---------- 已启用列表：折叠是 5 行高的滑动窗，展开是 15 行 ---------- */\n#wbm-list .wbm-actives {\n    display: flex;\n    flex-direction: column;\n    gap: 5px;\n    max-height: calc(33px * 5 + 5px * 4);\n    overflow-y: auto;\n    overflow-x: hidden;\n    /* 不给 contain：列表滑到尽头（或本身不够滑）时，余下的手势要继续交给外层世界书面板，\n       否则收起态只有 5 行高、滑条行程极短，手指在里面划就是\"划不动\"的感觉 */\n    overscroll-behavior: auto;\n    /* 把重排限制在列表内部：键盘收起触发整页重排时，外部不必重算每一行 */\n    contain: content;\n}\n#wbm-list.expanded .wbm-actives,\n#wbm-list.searching .wbm-actives {\n    max-height: calc(33px * 15 + 5px * 14);\n}\n#wbm-list .wbm-row {\n    display: flex;\n    align-items: center;\n    gap: 6px;\n    padding: 6px 10px;\n    min-height: 33px;\n    border-radius: 9px;\n    background: var(--SmartThemeBlurTintColor, rgba(255, 255, 255, .06));\n    border: 1px solid var(--SmartThemeBorderColor, rgba(255, 255, 255, .15));\n    cursor: pointer;\n}\n#wbm-list .wbm-row.editing { border-color: var(--SmartThemeQuoteColor, #c9a86a); }\n#wbm-list .wbm-row.confirming { border-color: #c0392b; }\n#wbm-list .wbm-name {\n    flex: 1 1 auto;\n    min-width: 0;\n    overflow: hidden;\n    text-overflow: ellipsis;\n    white-space: nowrap;\n    font-size: 14px;\n}\n#wbm-list .wbm-hint { flex: 0 0 auto; font-size: 11px; opacity: .55; }\n#wbm-list .wbm-kill {\n    flex: 0 0 auto;\n    padding: 2px 8px;\n    font-size: 12px;\n    border: 1px solid var(--SmartThemeBorderColor, #666);\n    background: transparent;\n    color: inherit;\n    border-radius: 999px;\n    cursor: pointer;\n}\n#wbm-list .wbm-row.confirming .wbm-kill { border-color: #c0392b; color: #e74c3c; }\n\n/* ---------- 展开 / 收起 ---------- */\n#wbm-list .wbm-more {\n    align-self: center;\n    padding: 4px 14px;\n    font-size: 12px;\n    opacity: .85;\n    border: 1px solid var(--SmartThemeBorderColor, #666);\n    background: transparent;\n    color: inherit;\n    border-radius: 999px;\n    cursor: pointer;\n}\n\n/* ---------- 添加面板 ---------- */\n/* 与已启用列表同一款式：不套外框，直接是搜索框 + 同形制的行，右边自然对齐 */\n#wbm-list .wbm-addpanel {\n    display: flex;\n    flex-direction: column;\n    gap: 6px;\n    padding: 0;\n    border: none;\n    background: none;\n    border-radius: 0;\n}\n#wbm-list .wbm-addlist {\n    display: flex;\n    flex-direction: column;\n    gap: 4px;\n    /* 固定像素高度：vh 会随手机键盘弹出而变，一变小一变大就是两次整页重排 */\n    max-height: 280px;\n    overflow-y: auto;\n    overflow-x: hidden;\n    /* 同上：到底后把余下的滑动交还给面板 */\n    overscroll-behavior: auto;\n    contain: content;\n}\n#wbm-list .wbm-addrow {\n    display: flex;\n    align-items: center;\n    gap: 8px;\n    padding: 6px 10px;\n    min-height: 33px;\n    border-radius: 9px;\n    border: 1px solid var(--SmartThemeBorderColor, rgba(255, 255, 255, .15));\n    background: var(--SmartThemeBlurTintColor, rgba(255, 255, 255, .06));\n    cursor: pointer;\n}\n#wbm-list .wbm-addrow:hover { background: rgba(255, 255, 255, .05); }\n#wbm-list .wbm-addrow.on {\n    border-color: rgba(120, 200, 140, .6);\n    background: rgba(120, 200, 140, .12);\n}\n#wbm-list .wbm-addname {\n    flex: 1 1 auto;\n    min-width: 0;\n    overflow: hidden;\n    text-overflow: ellipsis;\n    white-space: nowrap;\n    font-size: 14px;\n}\n#wbm-list .wbm-addmark { flex: 0 0 auto; font-size: 12px; opacity: .75; }\n#wbm-list .wbm-addrow.on .wbm-addmark { color: #7ec890; opacity: 1; }\n#wbm-list .wbm-none,\n#wbm-list .wbm-empty { font-size: 12px; opacity: .6; padding: 4px 2px; }\n\n@media (max-width: 1000px) {\n    /* 手机上让世界书区独占一整行，避免被左侧栏挤到溢出（只在已接管时生效） */\n    #WIMultiSelector[data-wbm-ready=\"1\"] { flex: 1 1 100% !important; width: 100% !important; }\n    /* 自绘列表的头部已经写明\"已启用 N 本\"，ST 那行提示可省 */\n    #WIMultiSelector[data-wbm-ready=\"1\"] > .range-block-title { display: none; }\n    #wbm-list .wbm-addlist { max-height: 260px; }\n    /* 整块列表区左右各留 12px：让头部、搜索框、已启用列表、添加面板、展开按钮\n       一起缩进（视觉对齐），留白不属于任何滚动容器，手指落在上面就是拖整个面板。 */\n    #wbm-list { padding: 0 12px; }\n    /* 「全局世界书激活设置」那一栏：常态就占满整行，不要点开之后才变宽 */\n    #WorldInfo .range-block > .inline-drawer { width: 100%; flex: 1 1 100%; min-width: 0; }\n    #WorldInfo .range-block > .inline-drawer > .inline-drawer-header { width: 100%; box-sizing: border-box; }\n}\n\n/* ---------- 「选择以编辑」：手机端用仿原生的全屏列表 + 顶部搜索 ---------- */\n.wbm-editor-wrap { display: none; }\n\n@media (max-width: 1000px) {\n    #world_editor_select { display: none !important; }\n    /* 酒馆给这个下拉套出来的 select2 替身必须一起藏：只藏了原生 select 的话，\n       窄屏上会出现\"两个选择器\"并排抢宽度，书名一长就把右边的分类图标挤出行外。 */\n    #world_popup .wbm-world-row .select2-container { display: none !important; }\n\n    .wbm-editor-wrap {\n        display: block;\n        flex: 1 1 auto;\n        min-width: 0;\n        width: auto;\n    }\n    .wbm-editor-btn {\n        display: block;\n        width: 100%;\n        min-width: 110px;\n        padding: 6px 10px;\n        font-size: 13px;\n        text-align: center;\n        border-radius: 8px;\n        border: 1px solid var(--SmartThemeBorderColor, #666);\n        background: var(--black30a, rgba(0, 0, 0, .2));\n        color: inherit;\n        cursor: pointer;\n        white-space: nowrap;\n        overflow: hidden;\n        text-overflow: ellipsis;\n        position: relative;\n        z-index: 1;\n    }\n    .wbm-editor-btn.active { border-color: var(--SmartThemeQuoteColor, #c9a86a); }\n}\n\n/* 全屏选择器：外观贴 ST 原生弹窗 + 手机原生 sheet 的手势暗示，只为在顶部加一条实时搜索。\n   全部为静态样式与一次性动画，没有滚动监听也没有常驻 rAF。 */\n.wbm-picker {\n    position: fixed;\n    inset: 0;\n    z-index: 2147483000;\n    display: flex;\n    /* 垂直居中（原来是 flex-end 贴底）：手机键盘弹起时，贴底的窗口会被输入法整块盖住；\n       居中的话窗口主体落在屏幕中段，输入框和列表都还在可视范围里。 */\n    align-items: center;\n    justify-content: center;\n    background: rgba(0, 0, 0, .6);\n    animation: wbm-mask-in .14s ease-out both;\n}\n.wbm-picker.closing { animation: wbm-mask-out .16s ease-in both; }\n\n.wbm-picker-sheet {\n    display: flex;\n    flex-direction: column;\n    width: 100%;\n    max-width: 760px;\n    /* dvh 随键盘变化，键盘弹起时窗口自己变矮；720px 是桌面上的上限，免得窗口过大 */\n    max-height: min(82dvh, 720px);\n    margin: 8px;\n    border-radius: 16px;\n    border: 1px solid var(--SmartThemeBorderColor, #444);\n    background: var(--SmartThemeBlurTintColor, #1c1c26);\n    /* 顶沿一道极淡高光，面板才不像一块贴上去的灰板 */\n    box-shadow: 0 -2px 30px rgba(0, 0, 0, .5), inset 0 1px 0 rgba(255, 255, 255, .07);\n    padding-bottom: max(8px, env(safe-area-inset-bottom, 0px));\n    overflow: hidden;\n    animation: wbm-sheet-in .18s cubic-bezier(.2, .8, .2, 1) both;\n}\n.wbm-picker.closing .wbm-picker-sheet { animation: wbm-sheet-out .16s ease-in both; }\n\n/* 抓握条：暗示这是从底部升起、可下滑收起的面板 */\n.wbm-picker-grip {\n    flex: 0 0 auto;\n    width: 36px;\n    height: 4px;\n    margin: 8px auto 0;\n    border-radius: 999px;\n    background: var(--SmartThemeBorderColor, rgba(255, 255, 255, .3));\n    opacity: .8;\n}\n\n.wbm-picker-head {\n    display: flex;\n    align-items: center;\n    gap: 6px;\n    padding: 8px 10px 10px;\n    border-bottom: 1px solid var(--SmartThemeBorderColor, rgba(128, 128, 128, .3));\n}\n\n/* 搜索胶囊：视觉重心给它，ST 的 .text_pole 方框不再参与 */\n.wbm-picker-field {\n    display: flex;\n    align-items: center;\n    gap: 8px;\n    flex: 1 1 auto;\n    min-width: 0;\n    height: 42px;\n    padding: 0 14px;\n    border-radius: 999px;\n    border: 1px solid var(--SmartThemeBorderColor, rgba(255, 255, 255, .16));\n    background: rgba(128, 128, 128, .22);\n    background: color-mix(in srgb, var(--SmartThemeBodyColor, #ccc) 8%, transparent);\n    transition: border-color .15s ease;\n}\n.wbm-picker-field:focus-within { border-color: var(--SmartThemeQuoteColor, #c9a86a); }\n.wbm-picker-icon {\n    flex: 0 0 auto;\n    width: 16px;\n    font-size: 13px;\n    text-align: center;\n    opacity: .6;\n}\n.wbm-picker-search {\n    flex: 1 1 auto;\n    min-width: 0;\n    width: auto;\n    height: 100%;\n    margin: 0;\n    padding: 0;\n    border: none;\n    border-radius: 0;\n    background: transparent;\n    box-shadow: none;\n    outline: none;\n    color: inherit;\n    caret-color: var(--SmartThemeQuoteColor, currentColor);\n    font-family: inherit;\n    font-size: 15px;\n}\n.wbm-picker-search::-webkit-search-cancel-button,\n.wbm-picker-search::-webkit-search-decoration { -webkit-appearance: none; appearance: none; }\n.wbm-picker-search::placeholder { color: inherit; opacity: .45; }\n\n/* ✕ 只做幽灵按钮，不跟搜索抢视觉；按下去才有底色 */\n.wbm-picker-close {\n    flex: 0 0 auto;\n    width: 38px;\n    height: 38px;\n    padding: 0;\n    border: none;\n    border-radius: 11px;\n    background: transparent;\n    color: inherit;\n    font-size: 15px;\n    line-height: 1;\n    opacity: .7;\n    cursor: pointer;\n}\n.wbm-picker-close:active {\n    background: rgba(128, 128, 128, .28);\n    background: color-mix(in srgb, var(--SmartThemeBodyColor, #ccc) 16%, transparent);\n    opacity: 1;\n}\n\n.wbm-picker-list {\n    flex: 1 1 auto;\n    min-height: 0;\n    overflow-y: auto;\n    overflow-x: hidden;\n    overscroll-behavior: contain;\n    padding: 6px 8px 10px;\n    /* 上下渐隐，一眼看出还能继续滚；纯 CSS，没有滚动监听 */\n    -webkit-mask-image: linear-gradient(to bottom, transparent 0, #000 4px, #000 calc(100% - 8px), transparent 100%);\n    mask-image: linear-gradient(to bottom, transparent 0, #000 4px, #000 calc(100% - 8px), transparent 100%);\n}\n\n/* 行改成内缩的圆角块：选中行才浮主题色底，其余只在按下时给反馈 */\n.wbm-picker-row {\n    display: flex;\n    align-items: center;\n    gap: 10px;\n    min-height: 48px;\n    margin: 2px 0;\n    padding: 0 12px;\n    border-radius: 10px;\n    font-size: 16px;\n    cursor: pointer;\n    transition: background-color .12s ease;\n}\n.wbm-picker-row:active {\n    background: rgba(128, 128, 128, .18);\n    background: color-mix(in srgb, var(--SmartThemeBodyColor, #ccc) 12%, transparent);\n}\n.wbm-picker-row.active {\n    background: rgba(128, 128, 128, .16);\n    background: color-mix(in srgb, var(--SmartThemeQuoteColor, #c9a86a) 16%, transparent);\n    /* 左沿一道主题色细条：比纯底色更容易一眼认出\"当前编辑的是这本\" */\n    box-shadow: inset 3px 0 0 var(--SmartThemeQuoteColor, #c9a86a);\n}\n.wbm-picker-row.active .wbm-picker-name { font-weight: 600; }\n.wbm-picker-exit { min-height: 44px; font-size: 15px; opacity: .72; }\n\n/* 分栏标题：粘在列表顶端，长名单滚下去也知道自己在哪一组。\n   底色跟面板本体取同一个变量，滚动时不会透出下面的行。 */\n.wbm-picker-group {\n    position: sticky;\n    top: 0;\n    z-index: 1;\n    display: flex;\n    align-items: baseline;\n    gap: 8px;\n    margin: 6px 0 2px;\n    padding: 8px 12px 6px;\n    background: var(--SmartThemeBlurTintColor, #1c1c26);\n}\n\n.wbm-picker-group-title {\n    color: var(--SmartThemeQuoteColor, inherit);\n    font-size: 13px;\n    letter-spacing: .4px;\n    opacity: .9;\n}\n\n.wbm-picker-group-count {\n    font-size: 12px;\n    opacity: .55;\n}\n\n/* 悬浮窗的标题行（世界书分类用；「选择以编辑」不显示，保持原样） */\n.wbm-picker-title {\n    flex: 0 0 auto;\n    padding: 2px 18px 8px;\n    font-size: 15px;\n    font-weight: 600;\n    letter-spacing: .3px;\n    color: var(--SmartThemeQuoteColor, inherit);\n}\n\n/* 「世界书分类」入口：一枚图标，紧跟在「选择以编辑」右侧（两者都是\"挑一本书\"）。\n   尺寸按手指能点中来做，不靠缩小换空间。 */\n.wbm-cat-btn {\n    flex: 0 0 auto;\n    display: inline-flex;\n    align-items: center;\n    justify-content: center;\n    width: 34px;\n    height: 32px;\n    margin: 0;\n    padding: 0;\n    border-radius: 8px;\n    border: 1px solid var(--SmartThemeBorderColor, #666);\n    background: rgba(128, 128, 128, .08);\n    background: color-mix(in srgb, var(--SmartThemeBodyColor, #ccc) 8%, transparent);\n    color: inherit;\n    cursor: pointer;\n}\n\n.wbm-cat-btn:hover {\n    border-color: var(--SmartThemeQuoteColor, #c9a86a);\n}\n\n.wbm-cat-btn .fa-solid {\n    font-size: 14px;\n    line-height: 1;\n}\n\n/* 手机端用来把「世界书选择」那排折成两排的零高节点；桌面不需要，常态关掉 */\n.wbm-rowbreak { display: none; }\n\n/* ---------- 全局启用预设：世界书面板里「Active World(s)」下面的一行 ---------- */\n.wbm-preset-row {\n    display: flex;\n    flex-wrap: wrap;\n    align-items: center;\n    gap: 6px;\n    width: 100%;\n    margin-top: 6px;\n}\n\n.wbm-preset-row .wbm-favbar-label { flex: 0 0 auto; }\n\n/* 看起来像下拉的按钮：点开是我们自己的浮层（原生 select 改不了选项字体） */\n.wbm-preset-btn {\n    flex: 1 1 8em;\n    min-width: 0;\n    height: 30px;\n    padding: 0 8px;\n    display: flex;\n    align-items: center;\n    gap: 6px;\n    font-family: inherit;\n    font-size: 12px;\n    border-radius: 6px;\n    text-align: left;\n}\n\n.wbm-preset-btn-text {\n    flex: 1 1 auto;\n    min-width: 0;\n    overflow: hidden;\n    text-overflow: ellipsis;\n    white-space: nowrap;\n}\n\n.wbm-preset-caret {\n    flex: 0 0 auto;\n    width: 0;\n    height: 0;\n    border-left: 4px solid transparent;\n    border-right: 4px solid transparent;\n    border-top: 5px solid currentColor;\n    opacity: .7;\n}\n\n/* 预设浮层里每行右侧的本数：等宽小字，跟名字拉开层级 */\n.wbm-picker-count {\n    flex: 0 0 auto;\n    margin-left: auto;\n    padding-left: 8px;\n    font-family: ui-monospace, \"Cascadia Mono\", Consolas, \"Courier New\", monospace;\n    font-size: 11px;\n    letter-spacing: .5px;\n    opacity: .7;\n    white-space: nowrap;\n}\n\n/* 预设行：本数直接顶到最右（不再让单选圈占住右边），\n   当前那套靠整行高亮 + 名字加粗区分 */\n.wbm-preset-opt .wbm-picker-name { flex: 1 1 auto; }\n\n/* 预设行里键多（分组/改名/覆盖/删除），窄屏允许折一行 */\n.wbm-preset-opt {\n    flex-wrap: wrap;\n    row-gap: 4px;\n}\n\n.wbm-preset-opt .wbm-picker-radio { display: none; }\n\n/* 四个小键的容器：电脑端仍排在名字右边，本数照旧顶到最右 */\n.wbm-preset-opt .wbm-preset-tools {\n    display: flex;\n    align-items: center;\n    gap: 6px;\n    flex: 0 0 auto;\n    margin-left: 8px;\n}\n\n.wbm-preset-opt .wbm-preset-tools .wbm-preset-tool { margin-left: 0; }\n\n/* 手机端：名字与「N 本」在第二行，四个小键整格挪到下方靠右。\n   之前四个键挤在名字右边（合计两百多像素），长名字只剩几十像素、全被省略号吃掉。 */\n@media (max-width: 760px), (max-width: 1100px) and (max-height: 520px), (max-width: 1100px) and (pointer: coarse) {\n    .wbm-preset-opt { padding-top: 7px; padding-bottom: 7px; }\n    .wbm-preset-opt .wbm-picker-name { order: 1; }\n    .wbm-preset-opt .wbm-picker-count { order: 2; }\n    .wbm-preset-opt .wbm-preset-tools {\n        order: 3;\n        flex: 0 0 100%;\n        justify-content: flex-end;\n        margin: 2px 0 0;\n    }\n}\n\n.wbm-preset-opt.active .wbm-picker-name::before {\n    content: \"✓ \";\n    color: var(--SmartThemeQuoteColor, inherit);\n}\n\n.wbm-preset-save {\n    flex: 0 0 auto;\n    height: 30px;\n    padding: 0 11px;\n    border-radius: 999px;\n    font-size: 12px;\n    line-height: 1;\n}\n\n/* 存名字的小行：留空就用\"预设N\"，所以占位提示里写的就是那个默认名 */\n.wbm-preset-saverow {\n    display: flex;\n    flex-wrap: wrap;\n    align-items: center;\n    gap: 6px;\n    width: 100%;\n}\n\n.wbm-preset-saverow[hidden] { display: none; }\n\n.wbm-preset-name {\n    flex: 1 1 8em;\n    min-width: 0;\n    height: 30px;\n    font-family: inherit;\n    font-size: 13px;\n}\n\n/* ---------- 预设管理（在分类面板里）：一项一张卡片，项与项之间留白 ---------- */\n.wbm-preset-sect { padding-top: 10px; }\n\n.wbm-preset-list {\n    display: flex;\n    flex-direction: column;\n    gap: 6px;\n    padding: 6px 14px 0;\n}\n\n.wbm-preset-item {\n    display: flex;\n    flex-direction: column;\n    gap: 6px;\n    padding: 8px;\n    border-radius: 9px;\n    border: 1px solid var(--SmartThemeBorderColor, rgba(128, 128, 128, .45));\n    background: rgba(128, 128, 128, .08);\n    background: color-mix(in srgb, var(--SmartThemeBodyColor, #ccc) 6%, transparent);\n}\n\n/* 第一行：名字占满左侧，本数顶到最右；第二行按键右对齐 */\n.wbm-preset-item-line {\n    display: flex;\n    align-items: baseline;\n    gap: 8px;\n    width: 100%;\n}\n\n.wbm-preset-item-name {\n    flex: 1 1 auto;\n    min-width: 0;\n    font-size: 13px;\n    overflow: hidden;\n    text-overflow: ellipsis;\n    white-space: nowrap;\n}\n\n.wbm-preset-item-name.on {\n    color: var(--SmartThemeQuoteColor, inherit);\n    font-weight: 600;\n}\n\n.wbm-preset-item-count {\n    flex: 0 0 auto;\n    margin-left: auto;\n    font-family: ui-monospace, \"Cascadia Mono\", Consolas, \"Courier New\", monospace;\n    font-size: 11px;\n    letter-spacing: .5px;\n    opacity: .72;\n    white-space: nowrap;\n}\n\n.wbm-preset-actions {\n    display: flex;\n    flex-wrap: wrap;\n    gap: 6px;\n    justify-content: flex-end;\n    width: 100%;\n}\n\n.wbm-preset-item .wbm-chip {\n    flex: 0 0 auto;\n    height: 30px;\n    padding: 0 10px;\n    border-radius: 999px;\n    font-size: 12px;\n    line-height: 1;\n}\n\n.wbm-preset-item .wbm-chip.danger {\n    color: var(--SmartThemeEmColor, #d08a8a);\n    border-color: var(--SmartThemeEmColor, rgba(208, 138, 138, .6));\n}\n\n.wbm-preset-item .wbm-preset-name { flex: 1 1 6em; }\n\n/* ---- 预设分组：组名一行（名字 + 几套 + 改名/删除），下面是该组的预设卡片 ---- */\n.wbm-preset-group-head {\n    display: flex;\n    align-items: center;\n    flex-wrap: wrap;\n    gap: 8px;\n    margin: 8px 0 2px;\n    padding: 4px 2px 4px 6px;\n    border-left: 2px solid var(--SmartThemeBorderColor, rgba(128, 128, 128, .45));\n}\n\n.wbm-preset-group-name {\n    flex: 1 1 auto;\n    min-width: 0;\n    overflow: hidden;\n    text-overflow: ellipsis;\n    white-space: nowrap;\n    font-size: 13px;\n    font-weight: 600;\n    color: var(--SmartThemeQuoteColor, inherit);\n}\n\n.wbm-preset-group-count {\n    flex: 0 0 auto;\n    font-family: ui-monospace, \"Cascadia Mono\", Consolas, \"Courier New\", monospace;\n    font-size: 11px;\n    letter-spacing: .5px;\n    opacity: .7;\n    white-space: nowrap;\n}\n\n.wbm-preset-group-actions {\n    flex: 0 0 auto;\n    display: flex;\n    gap: 4px;\n}\n\n.wbm-preset-group-actions .wbm-chip {\n    height: 26px;\n    padding: 0 9px;\n    border-radius: 999px;\n    font-size: 11px;\n    line-height: 1;\n}\n\n.wbm-group-rename-input {\n    flex: 1 1 100%;\n    margin: 2px 0 4px;\n}\n\n.wbm-preset-group-actions .wbm-chip.danger {\n    color: var(--SmartThemeEmColor, #d08a8a);\n    border-color: var(--SmartThemeEmColor, rgba(208, 138, 138, .6));\n}\n\n/* 浮层里的分组小标题（不可点） */\n.wbm-picker-group-label {\n    padding: 10px 14px 4px;\n    font-size: 12px;\n    font-weight: 600;\n    color: var(--SmartThemeQuoteColor, inherit);\n    opacity: .85;\n}\n\n/* 浮层里每套预设右侧的小键：分组 / 删除（删除第一下变「确认」） */\n.wbm-preset-tool {\n    flex: 0 0 auto;\n    margin-left: 8px;\n    padding: 3px 9px;\n    border-radius: 999px;\n    border: 1px solid var(--SmartThemeBorderColor, rgba(128, 128, 128, .45));\n    background: transparent;\n    color: var(--SmartThemeBodyColor, inherit);\n    font-family: inherit;\n    font-size: 12px;\n    line-height: 1.2;\n    cursor: pointer;\n}\n\n.wbm-preset-tool.armed {\n    border-color: var(--SmartThemeEmColor, rgba(208, 138, 138, .7));\n    color: var(--SmartThemeEmColor, #d08a8a);\n    font-weight: 600;\n}\n\n/* 分组管理区（分组浮层里的组名行，可改名 / 删除） */\n.wbm-group-mgmt {\n    padding: 4px 14px 2px;\n}\n\n.wbm-group-mgmt-row {\n    display: flex;\n    align-items: center;\n    flex-wrap: wrap;\n    gap: 8px;\n    padding: 6px 8px;\n    margin-bottom: 6px;\n    border-radius: 8px;\n    border: 1px solid var(--SmartThemeBorderColor, rgba(128, 128, 128, .4));\n    background: rgba(128, 128, 128, .08);\n    background: color-mix(in srgb, var(--SmartThemeBodyColor, #ccc) 6%, transparent);\n}\n\n.wbm-group-mgmt-name {\n    flex: 1 1 auto;\n    min-width: 0;\n    font-size: 13px;\n    overflow: hidden;\n    text-overflow: ellipsis;\n    white-space: nowrap;\n}\n\n.wbm-group-mgmt-tools {\n    flex: 0 0 auto;\n    display: flex;\n    gap: 6px;\n}\n\n.wbm-name-input-inline {\n    width: 100%;\n    height: 30px;\n    font-size: 13px;\n    /* 跟随主题：原来是不带背景/颜色的裸 input，截图里就是一格刺眼的白底 */\n    padding: 0 8px;\n    border-radius: 6px;\n    border: 1px solid var(--SmartThemeBorderColor, rgba(128, 128, 128, .45));\n    background: color-mix(in srgb, var(--SmartThemeBlurTintColor, rgba(28, 28, 38, .9)) 92%, transparent);\n    color: var(--SmartThemeBodyColor, inherit);\n    font-family: inherit;\n}\n\n.wbm-name-input-inline:focus {\n    outline: none;\n    border-color: var(--SmartThemeEmColor, rgba(156, 123, 214, .8));\n}\n\n/* 分类面板里显示这套预设属于哪一组（只做提示，不给操作） */\n.wbm-preset-item-group {\n    flex: 0 0 auto;\n    font-size: 11px;\n    opacity: .65;\n    white-space: nowrap;\n}\n\n/* 新建分组那一行（浮层底部） */\n.wbm-group-new {\n    padding: 8px 14px 12px;\n    border-top: 1px solid var(--SmartThemeBorderColor, rgba(128, 128, 128, .35));\n}\n\n\n/* 可横滑的条：右端渐隐，告诉手指右边还有东西；滑到底（data-xh=\"end\"）渐隐自动消失。\n   状态由 JS 写在 data-xh 上，滚动时才写，没有常驻开销。 */\n.wbm-batch-bar[data-xh=\"start\"],\n.wbm-batch-bar[data-xh=\"mid\"],\n.wbm-entry-favbar[data-xh=\"start\"],\n.wbm-entry-favbar[data-xh=\"mid\"],\n.wbm-favbar[data-xh=\"start\"],\n.wbm-favbar[data-xh=\"mid\"] {\n    -webkit-mask-image: linear-gradient(to right, #000 calc(100% - 40px), rgba(0, 0, 0, 0));\n    mask-image: linear-gradient(to right, #000 calc(100% - 40px), rgba(0, 0, 0, 0));\n}\n\n/* 电脑端：「选择以编辑」是酒馆自己的 select2，分组靠 <optgroup> 传下去，\n   这里只给它的分组标题上主题色，让它和手机端的分栏长得一样 */\n/* ---------- 世界书分类面板：两段（绑定中 / 未绑定）+ 小组行 ---------- */\n.wbm-cat-sect {\n    padding: 2px 0 10px;\n}\n\n.wbm-cat-sect + .wbm-cat-sect {\n    border-top: 1px solid var(--SmartThemeBorderColor, rgba(128, 128, 128, .35));\n    padding-top: 10px;\n}\n\n.wbm-cat-sect-head {\n    display: flex;\n    align-items: baseline;\n    gap: 8px;\n    padding: 6px 14px 4px;\n}\n\n.wbm-cat-sect-title {\n    font-size: 13px;\n    letter-spacing: .5px;\n    color: var(--SmartThemeQuoteColor, inherit);\n}\n\n/* 分类面板顶部的搜索条：输入框 + 两个模式键 */\n.wbm-cat-search {\n    display: flex;\n    align-items: center;\n    gap: 6px;\n    padding: 0 12px 8px;\n    flex-wrap: nowrap;\n}\n\n.wbm-cat-input {\n    flex: 1 1 auto;\n    min-width: 0;\n    height: 32px;\n}\n\n.wbm-cat-search .wbm-chip-sm {\n    flex: 0 0 auto;\n    height: 32px;\n}\n\n/* 归属排法说明：一行小灰字，让用户不用猜\"这本书为什么不在全局那组\" */\n.wbm-cat-note {\n    padding: 0 14px 8px;\n    font-size: 11.5px;\n    line-height: 1.5;\n    opacity: .62;\n}\n\n/* 还没扫描时的提醒：换成强调色，和普通说明区分开 */\n.wbm-cat-note.wbm-cat-warn {\n    opacity: .95;\n    color: var(--SmartThemeEmColor, #e1ecaa);\n}\n\n.wbm-cat-group {\n    margin: 0 6px;\n    border-radius: 8px;\n}\n\n.wbm-cat-group-head {\n    display: flex;\n    align-items: center;\n    gap: 8px;\n    padding: 9px 10px;\n    border-radius: 8px;\n    cursor: pointer;\n}\n\n.wbm-cat-group-head:hover {\n    background: rgba(128, 128, 128, .10);\n    background: color-mix(in srgb, var(--SmartThemeBodyColor, #ccc) 7%, transparent);\n}\n\n.wbm-cat-group-head.open {\n    background: rgba(128, 128, 128, .14);\n    background: color-mix(in srgb, var(--SmartThemeBodyColor, #ccc) 10%, transparent);\n}\n\n.wbm-cat-caret {\n    flex: 0 0 auto;\n    width: 12px;\n    font-size: 11px;\n    opacity: .7;\n}\n\n.wbm-cat-group-title {\n    flex: 1 1 auto;\n    min-width: 0;\n    overflow: hidden;\n    text-overflow: ellipsis;\n    white-space: nowrap;\n    font-size: 14px;\n}\n\n/* 交叉提示：一句话，不落在每一行上 */\n.wbm-cat-cross {\n    flex: 0 0 auto;\n    font-size: 11px;\n    opacity: .62;\n}\n\n.wbm-cat-scanhint {\n    flex: 0 0 auto;\n    font-size: 11px;\n    color: var(--SmartThemeQuoteColor, inherit);\n    opacity: .9;\n}\n\n/* 组内滚动：展开一组时只在这块里滚，别的组不被推走 */\n.wbm-cat-books {\n    max-height: 60vh;\n    overflow-y: auto;\n    overscroll-behavior-y: contain;\n    padding: 2px 0 6px;\n}\n\n/* 交叉标记：零文字的圆点，悬停才说明 */\n.wbm-cat-dot {\n    flex: 0 0 auto;\n    width: 6px;\n    height: 6px;\n    margin-right: 8px;\n    border-radius: 50%;\n    background: var(--SmartThemeQuoteColor, rgba(200, 170, 110, .9));\n    opacity: .85;\n}\n\n.wbm-cat-check {\n    flex: 0 0 auto;\n    width: 18px;\n    height: 18px;\n    margin: 0 2px 0 8px;\n    accent-color: var(--SmartThemeQuoteColor, #c9a86a);\n}\n\n.wbm-cat-scanbar {\n    display: flex;\n    align-items: center;\n    gap: 8px;\n    flex-wrap: wrap;\n    padding: 2px 12px 8px;\n}\n\n.wbm-cat-scanstate {\n    flex: 1 1 140px;\n    min-width: 0;\n    font-size: 12px;\n    line-height: 1.5;\n    opacity: .75;\n}\n\n.wbm-cat-delbar {\n    display: flex;\n    align-items: center;\n    gap: 6px;\n    flex-wrap: wrap;\n    padding: 8px 12px 10px;\n    border-top: 1px dashed var(--SmartThemeBorderColor, rgba(128, 128, 128, .45));\n}\n\n.wbm-cat-del-label {\n    flex: 1 1 100%;\n    font-size: 12px;\n    line-height: 1.5;\n    opacity: .85;\n}\n\n.select2-results__group,\n.select2-results__option--group {\n    color: var(--SmartThemeQuoteColor, inherit);\n    background: transparent;\n    font-size: .82em;\n    font-weight: 600;\n    letter-spacing: .3px;\n    padding: 6px 8px 2px;\n    cursor: default;\n}\n\n.wbm-picker-name {\n    flex: 1 1 auto;\n    min-width: 0;\n    overflow: hidden;\n    text-overflow: ellipsis;\n    white-space: nowrap;\n}\n\n/* 圆环 → 选中时填主题色并打勾 */\n.wbm-picker-radio {\n    position: relative;\n    flex: 0 0 auto;\n    width: 20px;\n    height: 20px;\n    border-radius: 50%;\n    border: 2px solid var(--SmartThemeBorderColor, rgba(170, 170, 170, .9));\n    box-sizing: border-box;\n    transition: background-color .12s ease, border-color .12s ease;\n}\n.wbm-picker-row.active .wbm-picker-radio {\n    border-color: var(--SmartThemeQuoteColor, #d4b06a);\n    background: var(--SmartThemeQuoteColor, #d4b06a);\n}\n.wbm-picker-row.active .wbm-picker-radio::after {\n    content: '';\n    position: absolute;\n    left: 50%;\n    top: 50%;\n    width: 5px;\n    height: 9px;\n    border: solid var(--SmartThemeBlurTintColor, #1c1c26);\n    border-width: 0 2px 2px 0;\n    box-sizing: border-box;\n    transform: translate(-50%, -58%) rotate(42deg);\n}\n\n.wbm-picker-empty {\n    padding: 26px 12px;\n    text-align: center;\n    font-size: 14px;\n    opacity: .55;\n}\n\n/* 移动 / 复制：标题行 + 底部两个动作按钮 */\n/* 搜索面开关（标题 / 关键词 / 正文）：默认全开，可逐个关掉；关掉的变暗只剩描边 */\n.wbm-picker-filters {\n    flex: 0 0 auto;\n    display: flex;\n    gap: 8px;\n    padding: 2px 12px 0;\n}\n.wbm-picker-chip {\n    flex: 0 0 auto;\n    height: 30px;\n    padding: 0 13px;\n    border-radius: 999px;\n    border: 1px solid rgba(128, 128, 128, .45);\n    border-color: color-mix(in srgb, var(--SmartThemeBodyColor, #ccc) 30%, transparent);\n    background: transparent;\n    color: inherit;\n    font-family: inherit;\n    font-size: 13px;\n    line-height: 1;\n    opacity: .55;\n    cursor: pointer;\n    transition: opacity .12s ease, background-color .12s ease, border-color .12s ease;\n}\n.wbm-picker-chip.on {\n    opacity: 1;\n    border-color: var(--SmartThemeQuoteColor, #c9a86a);\n    background: rgba(128, 128, 128, .18);\n    background: color-mix(in srgb, var(--SmartThemeQuoteColor, #c9a86a) 16%, transparent);\n    color: var(--SmartThemeQuoteColor, #c9a86a);\n    font-weight: 600;\n}\n.wbm-picker-chip:active {\n    background: rgba(128, 128, 128, .28);\n    background: color-mix(in srgb, var(--SmartThemeBodyColor, #ccc) 16%, transparent);\n}\n\n.wbm-picker-title {\n    flex: 0 0 auto;\n    padding: 10px 12px 2px;\n    font-size: 13px;\n    opacity: .8;\n    overflow-wrap: anywhere;\n}\n.wbm-picker-actions {\n    flex: 0 0 auto;\n    display: flex;\n    flex-wrap: wrap;\n    gap: 8px;\n    padding: 8px 10px 4px;\n    border-top: 1px solid var(--SmartThemeBorderColor, rgba(128, 128, 128, .3));\n}\n/* 底部动作按钮：直接照 ST 自己的 .menu_button 走（底色=主题模糊层、描边=主题描边、\n   按下用 brightness 提亮），这样换主题时和酒馆里其它按钮一起变，不会像外挂 */\n.wbm-picker-action {\n    flex: 1 1 0;\n    min-width: 0;\n    height: 40px;\n    border-radius: 10px;\n    border: 1px solid var(--SmartThemeBorderColor, rgba(128, 128, 128, .45));\n    background: var(--SmartThemeBlurTintColor, rgba(0, 0, 0, .2));\n    color: var(--SmartThemeBodyColor, inherit);\n    font-family: inherit;\n    font-size: 14px;\n    cursor: pointer;\n    filter: grayscale(.5);\n    transition: filter .12s ease, background-color .12s ease;\n}\n.wbm-picker-action.primary {\n    border-color: var(--SmartThemeQuoteColor, #c9a86a);\n    color: var(--SmartThemeQuoteColor, #c9a86a);\n    filter: none;\n}\n/* 主按钮独占一行：三个按钮挤在一行时手机上文字必被压扁 */\n.wbm-picker-action.wide { flex: 1 1 100%; }\n.wbm-picker-action:active { filter: grayscale(.2) brightness(1.25); }\n.wbm-picker-action.primary:active { filter: brightness(1.25); }\n.wbm-picker-action:disabled { opacity: .45; filter: grayscale(1); cursor: default; }\n\n/* 多选用的方块勾（批量搬运条目时用） */\n.wbm-picker-box {\n    position: relative;\n    flex: 0 0 auto;\n    width: 20px;\n    height: 20px;\n    border-radius: 6px;\n    border: 2px solid var(--SmartThemeBorderColor, rgba(170, 170, 170, .9));\n    box-sizing: border-box;\n    transition: background-color .12s ease, border-color .12s ease;\n}\n.wbm-picker-row.active .wbm-picker-box {\n    border-color: var(--SmartThemeQuoteColor, #d4b06a);\n    background: var(--SmartThemeQuoteColor, #d4b06a);\n}\n.wbm-picker-row.active .wbm-picker-box::after {\n    content: '';\n    position: absolute;\n    left: 50%;\n    top: 50%;\n    width: 5px;\n    height: 9px;\n    border: solid var(--SmartThemeBlurTintColor, #1c1c26);\n    border-width: 0 2px 2px 0;\n    box-sizing: border-box;\n    transform: translate(-50%, -58%) rotate(42deg);\n}\n\n/* 批量移动/复制入口：条目列表上方的小按钮 */\n.wbm-batch-bar {\n    display: flex;\n    flex-wrap: wrap;\n    gap: 8px;\n    justify-content: flex-end;\n    margin: 2px 0 6px;\n}\n/* 分组小框：和筛选条同形制（圆角、主题描边、极淡底色），标注在左 */\n.wbm-tool-group {\n    display: flex;\n    flex-wrap: wrap;\n    align-items: center;\n    gap: 6px;\n    padding: 6px 8px;\n    border-radius: 9px;\n    border: 1px solid var(--SmartThemeBorderColor, rgba(128, 128, 128, .45));\n    background: rgba(128, 128, 128, .08);\n    background: color-mix(in srgb, var(--SmartThemeBodyColor, #ccc) 6%, transparent);\n}\n/* 工具栏按键：底色/描边/文字全部交给酒馆的 .menu_button（那就跟着主题走），\n   这里只管圆角与内距，和筛选条的胶囊保持同一形制。 */\n.wbm-batch-btn {\n    flex: 0 0 auto;\n    width: auto;\n    margin: 0;\n    height: 26px;\n    padding: 5px 11px;\n    border-radius: 999px;\n    font-family: inherit;\n    font-size: 12px;\n    line-height: 1;\n    white-space: nowrap;\n    cursor: pointer;\n}\n.wbm-batch-btn:active { filter: brightness(1.3); }\n\n/* 删除按钮：危险动作单独一档颜色，按一下变「确认删除 N 条」再由主题强调色提醒 */\n.wbm-picker-action.danger {\n    border-color: var(--SmartThemeBorderColor, rgba(128, 128, 128, .45));\n    color: var(--SmartThemeEmColor, #d08a8a);\n    filter: none;\n}\n.wbm-picker-action.danger.armed {\n    border-color: var(--SmartThemeQuoteColor, #c9a86a);\n    color: var(--SmartThemeQuoteColor, #c9a86a);\n    font-weight: 600;\n}\n/* 历史记录里的「恢复」小按钮 */\n.wbm-hist-restore {\n    flex: 0 0 auto;\n    height: 28px;\n    padding: 0 12px;\n    border-radius: 999px;\n    border: 1px solid var(--SmartThemeBorderColor, rgba(128, 128, 128, .45));\n    background: transparent;\n    color: var(--SmartThemeQuoteColor, #c9a86a);\n    font-family: inherit;\n    font-size: 12px;\n    cursor: pointer;\n}\n.wbm-hist-restore:active { background: rgba(128, 128, 128, .24); }\n\n/* 原书已经被删掉的删除记录：恢复不了，给一个安静的标记代替「恢复」按钮 */\n.wbm-hist-gone {\n    flex: 0 0 auto;\n    padding: 3px 9px;\n    border-radius: 999px;\n    border: 1px solid var(--SmartThemeBorderColor, rgba(128, 128, 128, .45));\n    font-size: 12px;\n    line-height: 1.4;\n    opacity: .6;\n    white-space: nowrap;\n}\n\n/* 批量替换窗口：替换词输入行 + 命中片段行 */\n.wbm-replace-row {\n    display: flex;\n    align-items: center;\n    gap: 8px;\n    padding: 2px 12px 8px;\n}\n.wbm-replace-label {\n    flex: 0 0 auto;\n    font-size: 12px;\n    opacity: .65;\n    white-space: nowrap;\n}\n.wbm-replace-field {\n    flex: 1 1 auto;\n    min-width: 0;\n    margin: 0 !important;\n    padding: 6px 9px;\n    font-size: 13px;\n    border-radius: 8px;\n}\n.wbm-replace-chips {\n    flex-wrap: wrap;\n    padding: 0 12px 6px;\n    justify-content: flex-start;\n}\n.wbm-replace-hit {\n    font-size: 12px;\n    line-height: 1.45;\n    opacity: .72;\n    overflow: hidden;\n    text-overflow: ellipsis;\n    white-space: nowrap;\n}\n\n/* 操作历史的行：第一行是\"时间 动作 N 条：A → B\"，第二行是条目名 */\n.wbm-hist-row {\n    align-items: flex-start;\n    padding: 9px 12px;\n}\n.wbm-hist-col {\n    display: flex;\n    flex-direction: column;\n    gap: 2px;\n    flex: 1 1 auto;\n    min-width: 0;\n}\n.wbm-hist-line {\n    font-size: 14px;\n    line-height: 1.35;\n    overflow: hidden;\n    text-overflow: ellipsis;\n    white-space: nowrap;\n}\n.wbm-hist-names {\n    font-size: 12px;\n    line-height: 1.3;\n    opacity: .62;\n    overflow: hidden;\n    text-overflow: ellipsis;\n    white-space: nowrap;\n}\n\n/* 收藏筛选条：★ 收藏（只看收藏）与 收藏置顶 开关并排 */\n.wbm-favbar {\n    display: flex;\n    gap: 6px;\n    padding: 0 2px 2px;\n}\n/* 这两个键同时带 .menu_button：底色、描边、文字全交给酒馆自己的按钮样式，\n   主题里改 .menu_button 时它们跟着一起变（以前写死透明底 + opacity，换主题就显得像外挂）。 */\n.wbm-chip {\n    flex: 0 0 auto;\n    width: auto;\n    margin: 0;\n    height: 26px;\n    padding: 0 11px;\n    border-radius: 999px;\n    font-family: inherit;\n    font-size: 12px;\n    line-height: 1;\n    white-space: nowrap;\n    cursor: pointer;\n}\n.wbm-chip.on {\n    border-color: var(--SmartThemeQuoteColor, #c9a86a);\n    color: var(--SmartThemeQuoteColor, #c9a86a);\n    font-weight: 600;\n    /* 酒馆原生按钮自带 grayscale(.5)，选中态要让它退回去，否则主题强调色会被洗灰 */\n    filter: none;\n}\n\n/* ---------- 移动端键盘卡顿：压住酒馆自己的 resize hack ----------\n   酒馆在 browser-fixes.js:84 里每次 resize 把 <html> 设成 position:fixed 再还原\n   （本意是修 iOS 的定位错位），代价是每次键盘弹出/收起都强制两次整页重排。\n   Android 上这纯属开销，所以 JS 会给 <html> 加这个 class；iOS 不加。\n   !important 能压住酒馆写进去的 inline style，赋值照旧、重排不再发生。 */\nhtml.wbm-quiet-resize {\n    position: static !important;\n}\n\n/* ---------- 条目搜索范围：贴在搜索框右边、排序下拉左边 ---------- */\n/* 那一行是宿主的静态工具条（图标 + 搜索框 + 排序下拉）。我们把三枚小键插在\n   搜索框与排序下拉之间，并接管两者原来的 flex:1，让排序下拉被裁短、把宽度让给搜索框。 */\n.wbm-search-scope {\n    display: flex;\n    align-items: center;\n    flex-wrap: wrap;\n    gap: 4px;\n    flex: 0 1 auto;\n    min-width: 0;\n}\n.wbm-scope-label {\n    flex: 0 0 auto;\n    font-size: 11px;\n    line-height: 1.4;\n    opacity: .55;\n    white-space: nowrap;\n}\n.wbm-chip-sm {\n    height: 22px;\n    padding: 0 8px;\n    font-size: 11px;\n    border-radius: 999px;\n}\n.wbm-scope-row #world_info_search {\n    flex: 1 1 120px;\n    min-width: 5em;\n}\n/* 排序下拉：从\"和搜索框各占一半\"改成固定一块，宽到能读完 Priority / Title A-Z */\n.wbm-scope-row #world_info_sort_order {\n    flex: 0 0 auto;\n    width: 8.5em;\n    min-width: 0;\n    max-width: 8.5em;\n}\n/* 手机/平板判定：不再只看宽度。\n   只写 \"max-width:760px\" 时，手机一横过来（844×390）和 iPad 竖屏（768）都掉到桌面样式里，\n   所以判据换成三种任命中其一：窄屏 / 短边矮（横屏手机）/ 触屏（iPad 等，宽度封顶 1100，\n   免得把触屏一体机也算进来）。CSS 不能在媒体查询里引用变量，这条表达式在三处出现，改要一起改。 */\n@media (max-width: 760px), (max-width: 1100px) and (max-height: 520px), (max-width: 1100px) and (pointer: coarse) {\n    /* 窄屏上标签让位给三个键本身（键名已经说明了用途）；\n       排序下拉不再挤在同一行尾巴上，改为独占下一行、占满宽度，读起来才像个控件行 */\n    .wbm-scope-row .wbm-scope-label { display: none; }\n    .wbm-scope-row #world_info_sort_order {\n        flex: 1 1 100%;\n        width: auto;\n        max-width: none;\n    }\n    .wbm-chip-sm { height: 20px; padding: 0 6px; font-size: 10px; }\n}\n/* 行里的收藏星标：只切收藏，不触发跳转 */\n.wbm-star {\n    flex: 0 0 auto;\n    width: 28px;\n    height: 28px;\n    padding: 0;\n    border: none;\n    border-radius: 8px;\n    background: transparent;\n    color: inherit;\n    font-size: 15px;\n    line-height: 1;\n    opacity: .45;\n    cursor: pointer;\n}\n.wbm-star.on {\n    opacity: 1;\n    color: var(--SmartThemeQuoteColor, #c9a86a);\n}\n.wbm-star:active { background: rgba(128, 128, 128, .24); }\n\n/* 条目列表的「仅收藏 / 收藏置顶」小条：紧跟在条目列表上方的工具栏下面 */\n/* 筛选条：整个框按内容收窄、靠右对齐；「筛选」标注紧贴第一个键，不飘到最左边 */\n.wbm-entry-favbar {\n    display: flex;\n    flex-wrap: wrap;\n    align-items: center;\n    gap: 6px;\n    justify-content: flex-start;\n    width: fit-content;\n    max-width: 100%;\n    margin: 0 0 6px auto;\n    padding: 6px 8px;\n    border-radius: 9px;\n    border: 1px solid var(--SmartThemeBorderColor, rgba(128, 128, 128, .45));\n    background: rgba(128, 128, 128, .08);\n    background: color-mix(in srgb, var(--SmartThemeBodyColor, #ccc) 6%, transparent);\n}\n/* 标注：字号跟着主题字号走，颜色取主题正文色，只在右侧拉一道分隔线 */\n.wbm-favbar-label {\n    flex: 0 0 auto;\n    padding-right: 8px;\n    margin-right: 2px;\n    border-right: 1px solid var(--SmartThemeBorderColor, rgba(128, 128, 128, .45));\n    color: var(--SmartThemeBodyColor, inherit);\n    font-size: 13px;\n    font-weight: 600;\n    line-height: 1.2;\n    opacity: .9;\n    white-space: nowrap;\n}\n/* 收藏筛选：用 class 隐藏，不动 inline display，免得和酒馆自己的搜索过滤打架 */\n#world_popup_entries_list .wbm-fav-hidden { display: none !important; }\n/* 置顶：只借 flex order 排视觉顺序，DOM 顺序保持原生（拖拽/分页/搜索都不受影响） */\n#world_popup_entries_list.wbm-order-on {\n    display: flex;\n    flex-direction: column;\n}\n\n/* 五个操作收在一个容器里：桌面排一行（收藏、预览、移动/复制、删除），手机排三行 */\n.wbm-entry-actions {\n    display: flex;\n    align-items: center;\n    gap: 2px;\n    flex: 0 0 auto;\n}\n@media (max-width: 1000px) {\n    .wbm-entry-actions {\n        display: flex;\n        flex-wrap: nowrap;\n        gap: 6px;\n        align-items: center;\n        justify-content: flex-end;\n        margin-left: auto;\n    }\n    /* 手机上按钮放大到手指好按：五个键等宽等高，排成一行 */\n    .wbm-entry-actions > * {\n        flex: 0 0 auto;\n        min-width: 38px;\n        height: 34px;\n        display: inline-flex;\n        align-items: center;\n        justify-content: center;\n        padding: 0 !important;\n        margin: 0 !important;\n        font-size: 16px;\n        line-height: 1;\n    }\n}\n.wbm-fav-entry-btn,\n.wbm-preview-btn {\n    flex: 0 0 auto;\n    cursor: pointer;\n    font-style: normal;\n    line-height: 1;\n    padding: 2px 7px !important;\n    font-size: 13px;\n    margin: 0 !important;\n}\n.wbm-fav-entry-btn { opacity: .55; }\n.wbm-fav-entry-btn.on {\n    opacity: 1;\n    color: var(--SmartThemeQuoteColor, #c9a86a);\n    /* 酒馆原生按钮带 grayscale(.5)，收藏态要露出主题强调色就得把它撤掉 */\n    filter: none;\n}\n\n/* 只读预览浮层 */\n.wbm-prev-title {\n    flex: 1 1 auto;\n    min-width: 0;\n    overflow: hidden;\n    text-overflow: ellipsis;\n    white-space: nowrap;\n    font-size: 15px;\n    font-weight: 600;\n}\n.wbm-prev-body {\n    flex: 1 1 auto;\n    min-height: 0;\n    overflow-y: auto;\n    overscroll-behavior: contain;\n    padding: 4px 14px 14px;\n    -webkit-user-select: text;\n    user-select: text;\n}\n.wbm-prev-meta {\n    font-size: 12px;\n    opacity: .6;\n    margin-bottom: 8px;\n    overflow-wrap: anywhere;\n}\n.wbm-prev-keys {\n    display: flex;\n    flex-wrap: wrap;\n    gap: 6px;\n    margin-bottom: 10px;\n}\n.wbm-prev-key {\n    padding: 2px 9px;\n    border-radius: 999px;\n    border: 1px solid var(--SmartThemeBorderColor, rgba(128, 128, 128, .45));\n    background: rgba(128, 128, 128, .16);\n    background: color-mix(in srgb, var(--SmartThemeBodyColor, #ccc) 10%, transparent);\n    font-size: 12px;\n    line-height: 1.6;\n}\n/* 预览里的关键词分区：主要关键词 / 逻辑 / 可选过滤器，各自一行、标签在前 */\n.wbm-prev-kwlines {\n    margin-bottom: 4px;\n}\n.wbm-prev-kwline {\n    display: flex;\n    flex-wrap: wrap;\n    align-items: center;\n    gap: 6px;\n    margin-bottom: 8px;\n}\n.wbm-prev-kwlabel {\n    font-size: 12px;\n    font-weight: 600;\n    opacity: .65;\n    margin-right: 2px;\n    white-space: nowrap;\n}\n.wbm-prev-kwempty {\n    font-size: 12px;\n    opacity: .45;\n}\n.wbm-prev-kwvalue {\n    font-size: 12px;\n    opacity: .8;\n    overflow-wrap: anywhere;\n}\n.wbm-prev-text {\n    font-size: 14px;\n    line-height: 1.7;\n    white-space: pre-wrap;\n    overflow-wrap: anywhere;\n}\n\n\n/* ---------- 窄屏重排：标题行（标题＋触发策略）→ 字段网格 → 功能键 ---------- */\n@media (max-width: 1000px) {\n    /* 条目之间拉开距离并加分隔线，否则上下两条黏在一起分不清 */\n    #world_popup_entries_list .world_entry + .world_entry {\n        margin-top: 14px;\n        padding-top: 12px;\n        border-top: 1px solid var(--SmartThemeBorderColor, rgba(128, 128, 128, .35));\n    }\n    /* 折叠箭头、开关、拖动把手始终在条目头的同一条中线上：这里绝不能再改成 flex-start，\n       否则箭头和开关会飘到左上角，跟中间的 ☰ 错开（v2.4.0 的失误） */\n    #world_popup_entries_list .world_entry_thin_controls {\n        align-items: center;\n    }\n\n    /* 标题行：标题吃满剩下的宽度；触发策略（🔵/🟢/🔗）留在标题右边，\n       不再像之前那样被搬进字段网格、撑成一整条拉到满宽 */\n    #world_popup_entries_list .WIEntryTitleAndStatus {\n        flex: 1 1 100%;\n        width: 100%;\n        min-width: 0;\n        gap: 6px;\n    }\n    #world_popup_entries_list .WIEntryTitleAndStatus > .flex-container {\n        flex: 1 1 auto;\n        width: auto;\n        min-width: 0;\n    }\n    #world_popup_entries_list .WIEntryTitleAndStatus textarea[name=\"comment\"] {\n        width: 100% !important;\n    }\n    #world_popup_entries_list .WIEntryTitleAndStatus select[name=\"entryStateSelector\"] {\n        flex: 0 0 auto;\n        align-self: center;\n        width: auto !important;\n        min-width: 40px;\n        height: 32px;\n    }\n\n    /* 字段：标签小一号、控件撑满格子，四列宽度一致 */\n    #world_popup_entries_list .WIEnteryHeaderControls {\n        flex: 1 1 100%;\n        width: 100%;\n        display: grid;\n        grid-template-columns: repeat(2, minmax(0, 1fr));\n        gap: 8px 10px;\n        align-items: end;\n    }\n    #world_popup_entries_list .WIEnteryHeaderControls > * {\n        min-width: 0;\n    }\n    #world_popup_entries_list .WIEnteryHeaderControls .WIEntryHeaderTitleMobile {\n        display: block;\n        font-size: 12px;\n        line-height: 1.3;\n        opacity: .7;\n        margin: 0 0 2px;\n    }\n    #world_popup_entries_list .WIEnteryHeaderControls select,\n    #world_popup_entries_list .WIEnteryHeaderControls input {\n        width: 100% !important;\n        max-width: none !important;\n    }\n}\n\n/* 空间不够把五个键塞在标题行右边时（竖屏手机、横屏手机、平板）：整排锁在条目右下角，\n   标题与字段因此能用满整行。命中条件同上（窄屏 / 短边矮 / 触屏）。 */\n@media (max-width: 760px), (max-width: 1100px) and (max-height: 520px), (max-width: 1100px) and (pointer: coarse) {\n    #world_popup_entries_list .world_entry .inline-drawer-header {\n        position: relative;\n        padding-bottom: 42px;\n    }\n    #world_popup_entries_list .wbm-entry-actions {\n        position: absolute;\n        right: 0;\n        bottom: 0;\n        margin: 0;\n    }\n}\n\n/* 横屏手机 / 平板：空间够了，字段排三列 */\n@media (min-width: 641px) and (max-width: 1000px) {\n    #world_popup_entries_list .WIEnteryHeaderControls {\n        grid-template-columns: repeat(3, minmax(0, 1fr));\n    }\n}\n\n/* 再宽一些、而且不是触屏（鼠标操作的窄窗）：五个键回到标题行右侧、跟标题对齐靠上。\n   触屏和平板一律留在右下角，那里最好按。 */\n@media (min-width: 761px) and (max-width: 1000px) and (pointer: fine) {\n    #world_popup_entries_list .wbm-entry-actions {\n        align-self: flex-start;\n        margin-top: 2px;\n    }\n}\n\n@keyframes wbm-mask-in { from { opacity: 0; } to { opacity: 1; } }\n@keyframes wbm-mask-out { from { opacity: 1; } to { opacity: 0; } }\n@keyframes wbm-sheet-in { from { transform: translateY(14px); opacity: .6; } to { transform: none; opacity: 1; } }\n@keyframes wbm-sheet-out { from { transform: none; opacity: 1; } to { transform: translateY(14px); opacity: 0; } }\n\n/* 操作历史顶部的容量提示：与上面「最近 N 条操作…」同一条左边线（标题内边距左 12px） */\n.wbm-hist-usage {\n    opacity: .5;\n    font-size: 11px;\n    padding: 0 12px;\n    margin: -2px 0 6px;\n}\n\n/* 危险操作提示条（递归开关等） */\n.wbm-warn-row {\n    margin: 0 0 8px;\n    padding: 8px 10px;\n    border-radius: 8px;\n    border: 1px solid var(--SmartThemeBorderColor, rgba(128, 128, 128, .45));\n    background: rgba(128, 128, 128, .12);\n    background: color-mix(in srgb, var(--SmartThemeEmColor, #e1ecaa) 14%, transparent);\n    font-size: 12px;\n    line-height: 1.55;\n}\n\n/* 体检窗口：可展开的分类、条目行、正文摘录 */\n.wbm-health-cat {\n    display: flex;\n    flex-direction: column;\n    margin-bottom: 6px;\n}\n.wbm-health-head {\n    width: 100%;\n    text-align: left;\n    padding: 8px 10px;\n    border-radius: 8px;\n    border: 1px solid var(--SmartThemeBorderColor, rgba(128, 128, 128, .45));\n    background: rgba(128, 128, 128, .10);\n    background: color-mix(in srgb, var(--SmartThemeBodyColor, #ccc) 7%, transparent);\n    color: inherit;\n    font-family: inherit;\n    font-size: 13px;\n    line-height: 1.4;\n    cursor: pointer;\n}\n.wbm-health-head::before { content: '▸ '; opacity: .7; }\n.wbm-health-head.open::before { content: '▾ '; }\n.wbm-health-list {\n    display: flex;\n    flex-direction: column;\n    gap: 2px;\n    padding: 4px 0 6px 10px;\n}\n.wbm-health-linewrap { display: flex; flex-direction: column; }\n.wbm-health-item { display: flex; align-items: center; gap: 6px; padding: 2px 0; }\n.wbm-health-name {\n    flex: 1 1 auto;\n    min-width: 0;\n    text-align: left;\n    padding: 4px 6px;\n    border: none;\n    border-radius: 6px;\n    background: transparent;\n    color: var(--SmartThemeQuoteColor, #c9a86a);\n    font-family: inherit;\n    font-size: 12px;\n    line-height: 1.4;\n    cursor: pointer;\n    overflow: hidden;\n    text-overflow: ellipsis;\n    white-space: nowrap;\n}\n.wbm-health-act {\n    flex: 0 0 auto;\n    padding: 3px 8px;\n    border-radius: 999px;\n    border: 1px solid var(--SmartThemeBorderColor, rgba(128, 128, 128, .45));\n    background: transparent;\n    color: inherit;\n    font-family: inherit;\n    font-size: 11px;\n    line-height: 1.4;\n    opacity: .8;\n    cursor: pointer;\n}\n.wbm-health-excerpt { padding: 2px 6px 8px; }\n.wbm-health-body {\n    font-size: 12px;\n    line-height: 1.55;\n    white-space: pre-wrap;\n    opacity: .82;\n    max-height: 160px;\n    overflow-y: auto;\n}\n\n/* 体检：ⓘ 说明折叠 */\n.wbm-health-info {\n    align-self: flex-start;\n    margin: 0 0 6px;\n    padding: 5px 10px;\n    border-radius: 999px;\n    border: 1px solid var(--SmartThemeBorderColor, rgba(128, 128, 128, .45));\n    background: transparent;\n    color: var(--SmartThemeBodyColor, inherit);\n    font-family: inherit;\n    font-size: 12px;\n    line-height: 1.4;\n    opacity: .8;\n    cursor: pointer;\n}\n.wbm-health-info.open { opacity: 1; }\n.wbm-health-info-body {\n    margin: 0 0 8px;\n    padding: 8px 10px;\n    border-radius: 8px;\n    border: 1px solid var(--SmartThemeBorderColor, rgba(128, 128, 128, .35));\n    background: rgba(128, 128, 128, .08);\n    font-size: 12px;\n    line-height: 1.55;\n}\n.wbm-health-info-line { opacity: .85; }\n\n/* ---- 正文防误触：默认只读，双击进编辑，标题旁出「取消 / 保存」 ---- */\n.wbm-edit-actions {\n    display: inline-flex;\n    align-items: center;\n    gap: 6px;\n    margin-left: 8px;\n    vertical-align: middle;\n}\n.wbm-edit-actions[hidden] { display: none !important; }\n.wbm-edit-btn {\n    font: inherit;\n    font-size: 12px;\n    line-height: 1;\n    padding: 4px 11px;\n    border-radius: 999px;\n    cursor: pointer;\n    border: 1px solid var(--SmartThemeBorderColor, rgba(255, 255, 255, .28));\n    background: color-mix(in srgb, var(--SmartThemeBlurTintColor, #202020) 88%, transparent);\n    color: var(--SmartThemeBodyColor, #ddd);\n    transition: filter .12s ease, background .12s ease;\n}\n.wbm-edit-btn:hover { filter: brightness(1.18); }\n.wbm-edit-btn:active { filter: brightness(.92); }\n.wbm-edit-cancel { opacity: .85; }\n/* 确认键跟随酒馆主题：底色/描边取主题强调色（--SmartThemeQuoteColor），文字取正文色 */\n.wbm-edit-save {\n    font-weight: 700;\n    border-color: var(--SmartThemeQuoteColor, rgba(140, 190, 255, .85));\n    background: color-mix(in srgb, var(--SmartThemeQuoteColor, #8cbeff) 22%, transparent);\n    color: var(--SmartThemeBodyColor, #eee);\n}\n.wbm-edit-save:hover {\n    background: color-mix(in srgb, var(--SmartThemeQuoteColor, #8cbeff) 38%, transparent);\n    filter: none;\n}\n/* 字段级「取消 / 保存」：贴着被解锁的那个字段放 */\n.wbm-field-bar {\n    display: inline-flex;\n    align-items: center;\n    gap: 4px;\n    margin-left: 6px;\n    vertical-align: middle;\n}\n.wbm-field-bar[hidden] { display: none !important; }\n/* 正在编辑的那个字段加一圈强调色，别让人找不到 */\n.wbm-field-editing {\n    outline: 1px solid var(--SmartThemeQuoteColor, rgba(140, 190, 255, .8));\n    outline-offset: 1px;\n}\ntextarea.wbm-content-locked { cursor: pointer; }\ntextarea.wbm-content-editing {\n    outline: 1px solid var(--SmartThemeQuoteColor, rgba(120, 190, 255, .8));\n    outline-offset: 1px;\n}\n\n/* ---- 条目防误触锁：下拉/复选/关键词点不动，双击条目进编辑态 ---- */\n.wbm-inert {\n    pointer-events: none !important;\n}\n/* 被 select2 包一层的下拉（关键词、触发策略等）：锁住时连它那一层也点不动 */\n.world_entry[data-wbm-locked=\"1\"] .select2-container,\n.world_entry[data-wbm-locked=\"1\"] .select2-selection {\n    pointer-events: none !important;\n}\n.wbm-field-locked {\n    cursor: pointer;\n}\n/* 编辑态的条目：整块加一圈淡淡的强调色，让人一眼知道\"现在这条可以改\" */\n.world_entry[data-wbm-editing=\"1\"] {\n    outline: 1px solid var(--SmartThemeQuoteColor, rgba(120, 190, 255, .55));\n    outline-offset: -1px;\n}\n.wbm-edit-bar {\n    display: inline-flex;\n    align-items: center;\n    gap: 6px;\n    margin-right: 6px;\n}\n.wbm-edit-bar[hidden] { display: none !important; }\n/* 顶栏上的开关图标 */\n#wbm-lock-toggle {\n    cursor: pointer;\n}\n#wbm-lock-toggle.wbm-lock-on {\n    color: var(--SmartThemeQuoteColor, #7cc0ff);\n}\n\n/* ================= 消息编辑：右下角再挂一排原生按钮 ================= */\n\n/* 顶部那排（.mes_edit_buttons）原样保留，不动它。这里说的是编辑期间由 index.js\n   克隆到消息右下角的第二排（#wbm-bottom-editrow）：长消息点完铅笔不用再往上翻。\n   克隆体用的还是酒馆原生的类名（.mes_edit_done 等），所以配色、点击行为全部照旧，\n   下面只是把它摆到 .mes 的右下角，并按宿主原排的尺寸把外面那层容器量出来。 */\n#wbm-bottom-editrow {\n    position: absolute;\n    right: 8px;\n    bottom: 6px;\n    left: auto;\n    top: auto;\n    display: inline-flex;\n    flex-direction: row;\n    align-items: center;\n    gap: 5px;\n    padding: 0;\n    margin: 0;\n    z-index: 50;\n}\n\n/* 尺寸与透明度对齐宿主原生那排（.mes_edit_buttons .menu_button 的同一套数值），\n   落在容器外时宿主的规则选不到，这里补一份，避免克隆出来的按钮比上面那排更大更亮 */\n#wbm-bottom-editrow .menu_button {\n    opacity: 0.5;\n    padding: 0;\n    margin: 0;\n    font-size: 1rem;\n    height: 2rem;\n    aspect-ratio: 1 / 1;\n    display: flex;\n    justify-content: center;\n    align-items: center;\n    cursor: pointer;\n}\n\n#wbm-bottom-editrow .menu_button:hover {\n    opacity: 1;\n}\n\n/* 把正在编辑的正文顶起来，给下面那排按钮腾出位置：最后一行不会被按钮压住。\n   条件写成「这条消息里确实有那排克隆按钮」——关掉开关或总开关后按钮不生成，\n   这里也就不会白白多出一段空白。 */\n.mes:has(> #wbm-bottom-editrow) > .mes_block > .mes_text {\n    padding-bottom: calc(2rem + 14px);\n}\n\n/* 编辑期间让开这条消息的左右滑档箭头与滑档计数：它们也钉在消息右下角，\n   z-index(9999) 比按钮高，留着的下场是挡住最右边的取消键。只在有那排按钮时生效。 */\n.mes:has(> #wbm-bottom-editrow) > .swipeRightBlock,\n.mes:has(> #wbm-bottom-editrow) > .swipe_left,\n.mes:has(> #wbm-bottom-editrow) > .swipe_right {\n    display: none !important;\n}\n\n/* 页码被我们接管后钉在气泡正中下方（不再是 .swipeRightBlock 的孩子），上面那条选不到它，\n   它会和右下角那排按钮同一水平线、手机上图标直接叠在一起。编辑期间这条消息的页码一并让位；\n   .wbm-editing 是老 WebView 不认 :has() 时的兜底（由 main.js 的 syncBottomRow 加/删）。 */\n.mes:has(> #wbm-bottom-editrow) > .swipes-counter,\n.mes:has(> #wbm-bottom-editrow) .swipes-counter,\n.mes.wbm-editing .swipes-counter {\n    display: none !important;\n}\n\n/* ================= 扩展设置抽屉 ================= */\n\n/* 分组小标题：用主题引色，换主题时跟着变 */\n#wbm-settings .wbm-opt-group {\n    margin: 16px 0 8px;\n    padding-top: 10px;\n    border-top: 1px solid var(--SmartThemeBorderColor, rgba(255, 255, 255, .15));\n}\n\n#wbm-settings .wbm-opt-group > b {\n    color: var(--SmartThemeQuoteColor, inherit);\n    font-size: .95em;\n    letter-spacing: .3px;\n}\n\n/* 每个开关做成一张小卡片：左边一条主题色强调线 + 很淡的主题底色 + 卡与卡之间留白。\n   换主题时强调线与底色都跟着变（color-mix 前面垫 rgba 兜底，老浏览器也有底线）。 */\n#wbm-settings .wbm-opt-label {\n    display: flex;\n    align-items: flex-start;\n    gap: 8px;\n    margin: 0 0 10px;\n    padding: 8px 10px 9px;\n    border-left: 3px solid var(--SmartThemeQuoteColor, rgba(128, 128, 128, .6));\n    border-radius: 6px;\n    /* 底色取自正文色：深色主题是提亮、浅色主题是压暗，两边都看得出\"这是一张卡\"。\n       先写 rgba 兜底，再用 color-mix 跟主题走。 */\n    background: rgba(255, 255, 255, .05);\n    background: color-mix(in srgb, var(--SmartThemeBodyColor, rgba(255, 255, 255, .9)) 9%, transparent);\n}\n\n#wbm-settings .wbm-opt-label:hover {\n    background: rgba(255, 255, 255, .09);\n    background: color-mix(in srgb, var(--SmartThemeBodyColor, rgba(255, 255, 255, .9)) 15%, transparent);\n}\n\n/* 说明文字：放进开关的 label 里、和标题同一列，这样无论主题把复选框画多大，\n   说明都从标题的左边开始，不会吊在复选框底下 */\n#wbm-settings .wbm-opt-text {\n    display: flex;\n    flex-direction: column;\n    gap: 4px;\n    min-width: 0;\n}\n\n#wbm-settings .wbm-opt-title {\n    line-height: 1.4;\n}\n\n#wbm-settings .wbm-opt-note {\n    font-size: .85em;\n    line-height: 1.5;\n    opacity: .8;\n}\n\n/* 总开关关着时，下面几项就地变淡，提示\"现在没在生效\"，但仍然可以预先设置 */\n#wbm-settings .inline-drawer-content[data-wbm-idle=\"1\"] .wbm-opt-group,\n#wbm-settings .inline-drawer-content[data-wbm-idle=\"1\"] .wbm-opt-label {\n    opacity: .55;\n}\n\n#wbm-settings .inline-drawer-content[data-wbm-idle=\"1\"] #wbm-opt-enhance {\n    opacity: 1;\n}\n\n/* ================= 手机端：把世界书面板那几排控件压紧 ================= */\n\n/* 目标：不缩小按键（手指要能点中），只把\"折行\"消掉。\n   具体是——搜索区压成两排、世界书选择那排拆成\"选书 / 动书\"两排、\n   批量整理与筛选条各自横向滚动，不再折成三四行。\n   命中条件与上面两处相同：窄屏 / 短边矮（横屏手机）/ 触屏平板。 */\n@media (max-width: 760px), (max-width: 1100px) and (max-height: 520px), (max-width: 1100px) and (pointer: coarse) {\n    /* 搜索行：按实际宽度自然换行（不强行单行，否则尾部控件会被挤出屏幕外够不到）：\n       搜索框自己占一行，三枚范围键 + 排序挤在下一行，仍然是两行。 */\n    .wbm-scope-row {\n        flex-wrap: wrap;\n        align-items: center;\n        gap: 5px;\n    }\n    .wbm-scope-row .wbm-search-scope {\n        flex-wrap: nowrap;\n        flex: 0 1 auto;\n    }\n    .wbm-scope-row #world_info_search {\n        flex: 1 1 100%;\n        min-width: 4.5em;\n        order: 1;\n    }\n    .wbm-scope-row .wbm-search-scope { order: 2; }\n    .wbm-scope-row #world_info_sort_order {\n        flex: 1 1 auto;\n        width: auto;\n        max-width: none;\n        min-width: 5.5em;\n        order: 3;\n    }\n    /* 范围键放大到手指能点中（原来 20px 太矮），但仍排在同一行 */\n    .wbm-scope-row .wbm-chip-sm {\n        height: 28px;\n        padding: 0 8px;\n        font-size: 12px;\n    }\n\n    /* ---------- 世界书选择那一排：拆成两排 ---------- */\n    /* 第一排（挑一本书）：创建 · or · 选择以编辑 · 世界书分类\n       第二排（动这本书）：导入 · 导出 · 重命名 · 复制 · 删除 —— 五等分占满 */\n    .wbm-world-row {\n        flex-wrap: wrap;\n        align-items: center;\n        gap: 6px;\n    }\n    .wbm-world-row .wbm-rowbreak {\n        display: block;\n        flex: 0 0 100%;\n        width: 100%;\n        height: 0;\n        margin: 0;\n        padding: 0;\n        border: 0;\n    }\n    .wbm-world-row #world_create_button,\n    .wbm-world-row > small {\n        flex: 0 0 auto;\n    }\n    .wbm-world-row #world_create_button { height: 34px; }\n    /* 书名再长也不许把右边那枚分类图标挤走：\n       basis 取 0（不是 auto）——auto 会先按内容宽度撑开，长书名就把兄弟挤出行外；\n       min-width 归零 + overflow 兜底，按钮内部自己省略号截断。 */\n    .wbm-world-row .wbm-editor-wrap {\n        flex: 1 1 0;\n        min-width: 0;\n        max-width: 100%;\n        overflow: hidden;\n    }\n    .wbm-world-row .wbm-editor-btn {\n        display: block;\n        width: 100%;\n        min-width: 0;\n        max-width: 100%;\n        box-sizing: border-box;\n        white-space: nowrap;\n        overflow: hidden;\n        text-overflow: ellipsis;\n    }\n    .wbm-world-row .wbm-cat-btn {\n        flex: 0 0 34px;\n        width: 34px;\n        height: 34px;\n    }\n    .wbm-world-row #world_import_button,\n    .wbm-world-row #world_popup_export,\n    .wbm-world-row #world_popup_name_button,\n    .wbm-world-row #world_duplicate,\n    .wbm-world-row #world_popup_delete {\n        flex: 1 1 0;\n        min-width: 34px;\n        max-width: none;\n        height: 34px;\n        margin: 0 !important;\n        padding: 0;\n        display: inline-flex;\n        align-items: center;\n        justify-content: center;\n        font-size: 15px;\n        line-height: 1;\n    }\n\n    /* ---------- 横滑条：留一条 3px 细滚动条，滑得动看得出来 ---------- */\n    /* 批量整理 / 检查记录：一行，横向滚动，不再折行 */\n    .wbm-batch-bar {\n        flex-wrap: nowrap;\n        justify-content: flex-start;\n        overflow-x: auto;\n        overflow-y: hidden;\n        padding-bottom: 5px;\n        scrollbar-width: thin;\n        scrollbar-color: var(--SmartThemeQuoteColor, rgba(170, 170, 170, .6)) transparent;\n        /* 滚到边上别把整页带着动 */\n        overscroll-behavior-x: contain;\n    }\n    .wbm-batch-bar .wbm-tool-group {\n        flex: 0 0 auto;\n        flex-wrap: nowrap;\n    }\n\n    /* 条目筛选条同理：一行横向滚动 */\n    .wbm-entry-favbar {\n        flex-wrap: nowrap;\n        overflow-x: auto;\n        overflow-y: hidden;\n        padding-bottom: 5px;\n        scrollbar-width: thin;\n        scrollbar-color: var(--SmartThemeQuoteColor, rgba(170, 170, 170, .6)) transparent;\n        overscroll-behavior-x: contain;\n    }\n    .wbm-entry-favbar .wbm-chip,\n    .wbm-entry-favbar .menu_button {\n        flex: 0 0 auto;\n    }\n\n    /* 已启用列表头顶的 ★收藏 / 收藏置顶 同理 */\n    .wbm-favbar {\n        flex-wrap: nowrap;\n        overflow-x: auto;\n        overflow-y: hidden;\n        padding-bottom: 3px;\n        scrollbar-width: thin;\n        scrollbar-color: var(--SmartThemeQuoteColor, rgba(170, 170, 170, .6)) transparent;\n        overscroll-behavior-x: contain;\n    }\n\n    /* WebKit 的细滚动条（上面 scrollbar-width 对 Chrome 已生效，这里统一大小与取色） */\n    .wbm-batch-bar::-webkit-scrollbar,\n    .wbm-entry-favbar::-webkit-scrollbar,\n    .wbm-favbar::-webkit-scrollbar {\n        height: 3px;\n        background: transparent;\n    }\n    .wbm-batch-bar::-webkit-scrollbar-track,\n    .wbm-entry-favbar::-webkit-scrollbar-track,\n    .wbm-favbar::-webkit-scrollbar-track { background: transparent; }\n    .wbm-batch-bar::-webkit-scrollbar-thumb,\n    .wbm-entry-favbar::-webkit-scrollbar-thumb,\n    .wbm-favbar::-webkit-scrollbar-thumb {\n        border-radius: 2px;\n        background: var(--SmartThemeQuoteColor, rgba(170, 170, 170, .6));\n    }\n\n    /* 按键别缩得太小：手机上一律不低于 30px 高 */\n    #wbm-list .wbm-chip,\n    .wbm-entry-favbar .wbm-chip {\n        height: 30px;\n        font-size: 12px;\n        padding: 0 11px;\n    }\n\n    /* 「选择以编辑」按钮允许被压缩，避免把宿主那排图标挤到下一行 */\n    .wbm-editor-wrap { min-width: 0; }\n    .wbm-editor-btn { min-width: 0; }\n\n}\n\n/* 够宽（600px 以上：横屏手机、平板、电脑）：搜索区挤回一行，把高度还给条目列表。\n   手机竖屏（390 那档）不命中，那边仍然是\"搜索框独占一排 + 键与排序一排\"。 */\n@media (min-width: 600px) {\n    .wbm-scope-row #world_info_search {\n        flex: 1 1 6em;\n        min-width: 4em;\n    }\n    .wbm-scope-row .wbm-search-scope {\n        flex: 0 0 auto;\n        flex-wrap: nowrap;\n    }\n    .wbm-scope-row #world_info_sort_order {\n        flex: 0 0 auto;\n        width: 8.5em;\n        max-width: 8.5em;\n        min-width: 0;\n    }\n}\n\n/* ================= 备选回复页码接管 =================\n    目标：页码固定在消息气泡下方正中，手机上也要点得中。\n    原则：只动 .swipes-counter 这一个盒子，.swipe_right / .swipe_left 一根手指都不碰——\n    所以把箭头换成小兔子之类的美化照旧生效；地方不够时宁可让箭头压住页码，\n    也绝不把箭头挤开（master 2026-10-20 定的）。\n    2026-10-20 master 复测：左边/下面两档显示都错位，砍掉，只保留中间。 */\n\nbody.wbm-swipe-on #chat .mes .swipes-counter {\n    font-size: 14px !important;\n    line-height: 1.3 !important;\n    min-width: 46px !important;\n    height: auto !important;\n    padding: 3px 10px !important;\n    margin: 0 !important;\n    border-radius: 999px;\n    opacity: .55 !important;\n    pointer-events: auto !important;\n    transition: opacity .15s ease, background-color .15s ease;\n}\n\nbody.wbm-swipe-on #chat .mes .swipes-counter:hover,\nbody.wbm-swipe-on #chat .mes .swipes-counter:focus-visible {\n    opacity: .95 !important;\n    background-color: color-mix(in srgb, var(--SmartThemeBodyColor, #ffffff) 12%, transparent) !important;\n}\n\n/* 页码搬进 .mes 绝对居中，消息底部补一条等高空行（学双色盒子的做法） */\nbody.wbm-swipe-on #chat .mes {\n    position: relative;\n    padding-bottom: 26px !important;\n}\n\nbody.wbm-swipe-on #chat .mes .swipes-counter {\n    position: absolute !important;\n    left: 50% !important;\n    right: auto !important;\n    top: auto !important;\n    bottom: 3px !important;\n    transform: translateX(-50%) !important;\n    align-self: auto !important;\n    order: 0 !important;\n}\n\n/* 手机：字再大一号、点击区撑到 44pt 上下，但视觉上仍然只是一个数字 */\n@media (max-width: 760px), (max-width: 1100px) and (max-height: 520px), (max-width: 1100px) and (pointer: coarse) {\n    body.wbm-swipe-on #chat .mes .swipes-counter {\n        font-size: 15px !important;\n        min-width: 60px !important;\n        padding: 7px 14px !important;\n        bottom: 4px !important;\n    }\n\n    body.wbm-swipe-on #chat .mes {\n        padding-bottom: 36px !important;\n    }\n}\n\n/* 备选回复弹窗标题栏里的「批量删除」（三栏网格：标题左 / 按钮中 / 关闭右上）\n   以前用绝对定位居中，按钮比标题栏高，下沿压在了弹窗的分隔线上（master 2026-10-20 报的）。 */\n.wbm-swipe-header {\n    display: grid !important;\n    grid-template-columns: 1fr auto 1fr;\n    align-items: center;\n    column-gap: 8px;\n    padding: 6px 0 10px !important;\n    min-height: 44px;\n    row-gap: 0;\n}\n\n.wbm-swipe-header > h3,\n.wbm-swipe-header > .swipe_picker_title {\n    grid-column: 1;\n    justify-self: start;\n    margin: 0 !important;\n    min-width: 0;\n    overflow: hidden;\n    text-overflow: ellipsis;\n    white-space: nowrap;\n}\n\n.wbm-swipe-header .wbm-swipe-bulk {\n    grid-column: 2;\n    justify-self: center;\n}\n\n.wbm-swipe-header .wbm-swipe-right {\n    grid-column: 3;\n    justify-self: end;\n    display: inline-flex;\n    align-items: center;\n    gap: 10px;\n    min-width: 0;\n}\n\n.wbm-swipe-header .wbm-swipe-right .popup-button-close {\n    margin-left: 0 !important;\n}\n\n.wbm-swipe-header .wbm-swipe-tool {\n    cursor: pointer;\n    user-select: none;\n    padding: 2px 4px;\n    border-radius: 4px;\n    transition: background-color .12s ease, opacity .12s ease;\n}\n\n.wbm-swipe-header .wbm-swipe-tools {\n    display: inline-flex;\n    align-items: center;\n    gap: 12px;\n    flex: 0 0 auto;\n    white-space: nowrap;\n}\n\n.wbm-swipe-header .wbm-swipe-tool {\n    flex: 0 0 auto;\n    white-space: nowrap;\n}\n\n@media (max-width: 480px) {\n    .wbm-swipe-header .wbm-swipe-tools { gap: 10px; }\n    .wbm-swipe-header .wbm-swipe-right { gap: 8px; }\n}\n\n.wbm-swipe-header .wbm-swipe-tool:hover {\n    opacity: 1;\n    background-color: color-mix(in srgb, var(--SmartThemeBodyColor, #ffffff) 14%, transparent);\n}\n\n.wbm-swipe-bulk {\n    display: inline-flex;\n    align-items: center;\n    gap: 6px;\n    flex: 0 0 auto;\n    padding: 5px 12px;\n    border: 1px solid var(--SmartThemeBorderColor, rgba(255, 255, 255, .18));\n    border-radius: 8px;\n    font-size: 13px;\n    line-height: 1.2;\n    opacity: .8;\n    cursor: pointer;\n    user-select: none;\n    white-space: nowrap;\n    transition: opacity .15s ease, border-color .15s ease, background-color .15s ease;\n}\n\n.wbm-swipe-bulk:hover {\n    opacity: 1;\n    border-color: var(--SmartThemeEmColor, #9c7bd6);\n}\n\n.wbm-swipe-bulk.armed {\n    opacity: 1;\n    border-color: var(--SmartThemeEmColor, #d6747b);\n    background-color: color-mix(in srgb, var(--SmartThemeEmColor, #d6747b) 14%, transparent);\n}\n\n.wbm-swipe-bulk.wbm-busy {\n    opacity: .6;\n    pointer-events: none;\n}\n\n/* 选择模式：每条备选左侧一个勾选圈，点条目本身＝勾选，不再切换正文 */\n.wbm-swipe-pick {\n    flex: 0 0 auto;\n    align-self: center;\n    display: inline-flex;\n    align-items: center;\n    justify-content: center;\n    width: 22px;\n    height: 22px;\n    margin-right: 6px;\n    border: 1px solid var(--SmartThemeBorderColor, rgba(255, 255, 255, .35));\n    border-radius: 50%;\n    opacity: .7;\n    transition: opacity .12s ease, background-color .12s ease, border-color .12s ease;\n}\n\n.wbm-swipe-pick i {\n    font-size: 11px;\n    opacity: 0;\n    transition: opacity .12s ease;\n}\n\n.wbm-swipe-pick.checked {\n    opacity: 1;\n    border-color: var(--SmartThemeEmColor, #9c7bd6);\n    background-color: color-mix(in srgb, var(--SmartThemeEmColor, #9c7bd6) 26%, transparent);\n}\n\n.wbm-swipe-pick.checked i {\n    opacity: 1;\n}\n\n.swipe_picker_block.wbm-select-on {\n    cursor: pointer;\n}\n\n.swipe_picker_block.wbm-picked {\n    box-shadow: inset 3px 0 0 var(--SmartThemeEmColor, #9c7bd6);\n}\n\n/* 页码轻触反馈：点到了就能看出来，不用等弹窗 */\n.swipes-counter.wbm-tap-flash {\n    opacity: 1 !important;\n    background-color: color-mix(in srgb, var(--SmartThemeBodyColor, #ffffff) 22%, transparent) !important;\n}\n\n/* 分类面板：勾选框外面那层，44px 命中区（手机点得中） */\n.wbm-cat-pick {\n    flex: 0 0 auto;\n    display: inline-flex;\n    align-items: center;\n    justify-content: center;\n    width: 44px;\n    height: 44px;\n    margin: -10px -8px -10px 0;\n    cursor: pointer;\n}\n\n/* ---------------- ② 对话补全预设：搜索按钮 ---------------- */\n#wbm-talk-preset-btn {\n    flex: 0 0 auto;\n    display: inline-flex;\n    align-items: center;\n    gap: 4px;\n    height: 32px;\n    padding: 0 10px;\n    margin-left: 4px;\n    font-size: 13px;\n}\n#wbm-talk-preset-btn .wbm-talk-preset-btn-text { white-space: nowrap; }\n.wbm-talk-preset-row.active .wbm-picker-name { color: var(--SmartThemeQuoteColor, inherit); }\n.wbm-talk-preset-row .wbm-preset-tools { margin-left: auto; }\n\n/* 预设名太长时「分组 / 删除」不能被挤到第二行（master 2026-10-21 手机端报的）：\n   名字这一格吃掉余量并自己省略号，右侧工具固定宽度、永不换行。 */\n.wbm-talk-preset-row {\n    flex-wrap: nowrap !important;\n}\n\n.wbm-talk-preset-row .wbm-picker-name {\n    flex: 1 1 auto;\n    min-width: 0;\n    overflow: hidden;\n    text-overflow: ellipsis;\n    white-space: nowrap;\n}\n\n.wbm-talk-preset-row .wbm-preset-tools {\n    flex: 0 0 auto;\n    flex-wrap: nowrap;\n    gap: 10px;\n}\n\n.wbm-talk-preset-row .wbm-preset-tool {\n    flex: 0 0 auto;\n    white-space: nowrap;\n}\n\n.wbm-talk-preset-row .wbm-picker-count {\n    flex: 0 0 auto;\n    white-space: nowrap;\n}\n\n/* 分组标题兼折叠开关：点一下展开/收起，右侧是本组条数 */\n.wbm-picker-group-label.wbm-talk-group-toggle {\n    display: flex;\n    align-items: center;\n    gap: 6px;\n    cursor: pointer;\n    user-select: none;\n    min-height: 28px;\n}\n\n.wbm-picker-group-label.wbm-talk-group-toggle:hover {\n    color: var(--SmartThemeEmColor, inherit);\n}\n\n.wbm-picker-group-label.wbm-talk-group-toggle > i {\n    font-size: 11px;\n    opacity: .75;\n}\n\n.wbm-picker-group-label.wbm-talk-group-toggle > .wbm-talk-group-name {\n    overflow: hidden;\n    text-overflow: ellipsis;\n    white-space: nowrap;\n}\n\n.wbm-picker-group-label.wbm-talk-group-toggle > .wbm-talk-group-count {\n    margin-left: auto;\n    font-family: ui-monospace, monospace;\n    font-size: 11px;\n    opacity: .55;\n}\n\n.wbm-talk-group-body[hidden] {\n    display: none !important;\n}\n\n/* 批量条：已选 N 个 | 全选 | 清空 | 分组 | 删除 | 退出\n   手机上也要能一行放下，所以字小一号、间距收紧，绝不换行。 */\n.wbm-talk-batchbar {\n    display: flex;\n    align-items: center;\n    gap: 8px;\n    flex-wrap: nowrap;\n    min-height: 32px;\n    padding: 2px 12px 6px;\n    white-space: nowrap;\n}\n\n.wbm-talk-batchbar[hidden] {\n    display: none !important;\n}\n\n.wbm-talk-batch-count {\n    flex: 0 0 auto;\n    font-family: ui-monospace, monospace;\n    font-size: 11px;\n    opacity: .7;\n    margin-right: auto;\n}\n\n.wbm-talk-batchbar .wbm-preset-tool {\n    flex: 0 0 auto;\n    white-space: nowrap;\n    font-size: 12px;\n    padding: 4px 10px;\n}\n\n.wbm-talk-batchbar .wbm-talk-batch-exit {\n    opacity: .8;\n}\n\n.wbm-talk-batch-grouprow[hidden] {\n    display: none !important;\n}\n\n@media (max-width: 480px) {\n    .wbm-talk-batchbar {\n        gap: 5px;\n        padding: 2px 8px 6px;\n    }\n\n    .wbm-talk-batch-count {\n        font-size: 10px;\n    }\n\n    .wbm-talk-batchbar .wbm-preset-tool {\n        font-size: 11px;\n        padding: 4px 6px;\n    }\n}\n\n/* 行内改名/分组那一排：输入框占余量，「确定 / 取消」不压缩。\n   原来两个键用 .wbm-picker-action（flex:1 1 0 + min-width:0），被 width:100% 的输入框挤成\n   14px 宽，「确定」「取消」两个字竖着排（master 2026-10-21 截图报的就是这个）。 */\n.wbm-picker-row .wbm-name-input-inline {\n    flex: 1 1 6em;\n    width: auto;\n    min-width: 0;\n}\n\n.wbm-picker-row .wbm-name-input-inline ~ .wbm-picker-action {\n    flex: 0 0 auto;\n    width: auto;\n    min-width: 56px;\n    padding: 0 12px;\n    white-space: nowrap;\n}\n\n/* 手机：行内改名那一排仍是一行，但把名字截短、输入框保底留够宽度。\n   一行塞四个东西时输入框原来只剩 49px，打字看不到自己输入了什么。 */\n@media (max-width: 760px), (max-width: 1100px) and (max-height: 520px), (max-width: 1100px) and (pointer: coarse) {\n    .wbm-picker-row .wbm-name-input-inline {\n        flex: 1 1 7em;\n        min-width: 7em;\n    }\n\n    .wbm-picker-row .wbm-name-input-inline ~ .wbm-picker-name,\n    .wbm-picker-row .wbm-picker-name:has(+ .wbm-name-input-inline) {\n        flex: 0 1 auto;\n        max-width: 84px;\n        overflow: hidden;\n        text-overflow: ellipsis;\n        white-space: nowrap;\n    }\n\n    .wbm-picker-row .wbm-name-input-inline ~ .wbm-picker-action {\n        min-width: 52px;\n        padding: 0 10px;\n    }\n}\n\n/* 两级插入窗口：步骤提示（第 1 步 / 第 2 步），以及隐藏的按钮不占位 */\n.wbm-picker-group-label.wbm-step-marker {\n    opacity: .6;\n    font-family: ui-monospace, monospace;\n    font-size: 11px;\n    letter-spacing: .02em;\n}\n\n.wbm-picker-actions > [hidden] {\n    display: none !important;\n}\n\n/* 关键：提示词管理器整块是 #ai_response_configuration（flex 行）里的 flex 子项，\n   默认 min-width:auto 会让它的 min-content 把抽屉撑到 700px 宽 —— 行尾的原生按钮就被\n   画到抽屉外面（压在对话区上），点击落到对话区 → 表现为「点不到开关/找不到排序键」。\n   这里把 min-width 链条全部放开，行内元素自己省略，宽度跟随抽屉。 */\n#completion_prompt_manager {\n    min-width: 0 !important;\n    width: 100% !important;\n    max-width: 100%;\n}\n#completion_prompt_manager .range-block,\n#completion_prompt_manager_list,\n#completion_prompt_manager_list li,\nli.completion_prompt_manager_prompt {\n    min-width: 0 !important;\n    max-width: 100%;\n    box-sizing: border-box;\n}\nli.completion_prompt_manager_prompt {\n    flex-wrap: nowrap;\n    overflow: hidden;\n}\nli.completion_prompt_manager_prompt .completion_prompt_manager_prompt_name {\n    min-width: 0 !important;\n    overflow: hidden;\n    text-overflow: ellipsis;\n    white-space: nowrap;\n}\n.completion_prompt_manager_footer {\n    flex-wrap: wrap !important;\n    min-width: 0 !important;\n}\n\n/* 方案 A：每行一个「↓」，点它就是「把当前选中的那条插到这行之后」 */\n.wbm-prompt-bar {\n    display: flex;\n    align-items: center;\n    gap: 10px;\n    padding: 4px 6px;\n    min-width: 0;\n}\n\n.wbm-prompt-bar-hint {\n    flex: 1 1 auto;\n    min-width: 0;\n    font-size: 12px;\n    line-height: 1.3;\n    opacity: .7;\n    overflow: hidden;\n    text-overflow: ellipsis;\n    white-space: nowrap;\n}\n\n/* 行内「↓」：默认半透明，悬停才亮，避免抢走原生按钮的注意力 */\n.prompt_manager_prompt_controls .wbm-pm-insert {\n    display: inline-flex;\n    align-items: center;\n    justify-content: center;\n    padding: 2px 4px;\n    margin-right: 4px;\n    border-radius: 4px;\n    font-size: 12px;\n    opacity: .45;\n    cursor: pointer;\n}\n\n.prompt_manager_prompt_controls .wbm-pm-insert:hover {\n    opacity: 1;\n    color: var(--SmartThemeEmColor, #9c7bd6);\n}\n\n@media (max-width: 760px), (max-width: 1100px) and (pointer: coarse) {\n    .prompt_manager_prompt_controls .wbm-pm-insert {\n        padding: 8px 10px;\n        font-size: 14px;\n        opacity: .7;\n    }\n\n    .wbm-prompt-bar-hint {\n        font-size: 11px;\n    }\n}\n\n/* 提示词行的「↓」：行尾控件区最前（detach / edit / toggle 之前）。\n   默认半透明，行悬停时才醒目；行尾那几个是酒馆原生键，我们的键排在最前不贴边。 */\n#completion_prompt_manager_list .wbm-pm-insert {\n    flex: 0 0 auto;\n    display: inline-flex;\n    align-items: center;\n    justify-content: center;\n    width: 22px;\n    height: 22px;\n    margin: 0 4px 0 0;\n    border-radius: 5px;\n    font-size: 11px;\n    opacity: .35;\n    cursor: pointer;\n    transition: opacity .12s ease, background-color .12s ease, color .12s ease;\n}\n\n#completion_prompt_manager_list li:hover .wbm-pm-insert {\n    opacity: .9;\n}\n\n#completion_prompt_manager_list .wbm-pm-insert:hover {\n    opacity: 1;\n    color: var(--SmartThemeEmColor, #9c7bd6);\n    background-color: color-mix(in srgb, var(--SmartThemeEmColor, #9c7bd6) 20%, transparent);\n}\n\n/* 没选中移动对象时：所有 ↓ 变灰、不可点 */\n/* 没选移动对象时：只压暗，不能变「点不动的死键」——点不动等于没反馈，\n   master 会判成「下箭头无法点击」。点它会 toast 提示并高亮底部下拉。 */\n#completion_prompt_manager_list .wbm-pm-insert.wbm-pm-insert-off {\n    opacity: .3;\n    cursor: help;\n}\n\n#completion_prompt_manager_list .wbm-pm-insert.wbm-pm-insert-off:hover {\n    opacity: .75;\n    color: var(--SmartThemeBodyColor, inherit);\n    background-color: transparent;\n}\n\n/* 底部下拉被提醒时闪一下，告诉用户「要在这里选条目」 */\n#completion_prompt_manager_footer_append_prompt.wbm-pm-attn {\n    outline: 2px solid var(--SmartThemeEmColor, #9c7bd6);\n    outline-offset: 1px;\n    animation: wbm-pm-attn 1.2s ease-out;\n}\n\n@keyframes wbm-pm-attn {\n    0% { background-color: color-mix(in srgb, var(--SmartThemeEmColor, #9c7bd6) 45%, transparent); }\n    100% { background-color: transparent; }\n}\n\n/* 拖拽把手：桌面端只有 ☰ 能拖，给它留够命中区并给出抓取手势 */\n#completion_prompt_manager_list li[data-pm-identifier] .drag-handle {\n    display: inline-flex;\n    align-items: center;\n    justify-content: center;\n    width: 26px;\n    margin-right: 2px;\n    cursor: grab;\n    user-select: none;\n}\n\n#completion_prompt_manager_list li[data-pm-identifier] .drag-handle:active {\n    cursor: grabbing;\n}\n\n/* 正在移动的那一条：左侧竖色条 + 淡底，和底部下拉里的名字对得上 */\n/* 移动中的那一行整条变色（master：标识不明显，直接让整个条目变色、随主题） */\n#completion_prompt_manager_list li.wbm-pm-moving {\n    box-shadow: inset 4px 0 0 var(--SmartThemeEmColor, #9c7bd6);\n    background-color: color-mix(in srgb, var(--SmartThemeEmColor, #9c7bd6) 26%, transparent) !important;\n    outline: 1px solid color-mix(in srgb, var(--SmartThemeEmColor, #9c7bd6) 55%, transparent);\n    outline-offset: -1px;\n}\n#completion_prompt_manager_list li.wbm-pm-moving .prompt_manager_prompt_name,\n#completion_prompt_manager_list li.wbm-pm-moving .prompt_manager_prompt_name * {\n    color: var(--SmartThemeEmColor, #9c7bd6) !important;\n}\n\n/* 悬停预演：这一行下沿亮一条线，提示落点 */\n#completion_prompt_manager_list li.wbm-pm-hover {\n    box-shadow: inset 0 -2px 0 var(--SmartThemeEmColor, #9c7bd6);\n}\n\n/* 刚移动完成的那一条：闪一下再淡掉 */\n#completion_prompt_manager_list li.wbm-pm-flash {\n    animation: wbm-pm-flash 0.9s ease-out;\n}\n\n@keyframes wbm-pm-flash {\n    0% { background-color: color-mix(in srgb, var(--SmartThemeEmColor, #9c7bd6) 38%, transparent); }\n    100% { background-color: transparent; }\n}\n\n@media (max-width: 760px), (max-width: 1100px) and (pointer: coarse) {\n    #completion_prompt_manager_list .wbm-pm-insert {\n        width: 30px;\n        height: 30px;\n        font-size: 13px;\n        opacity: .6;\n    }\n}\n\n/* ---------------- ③ 提示词插入到指定位置 ---------------- */\n.wbm-prompt-insert-btn { flex: 0 0 auto; }\n.wbm-prompt-insert-btn::after { content: ''; }\n\n/* ---------------- ④ 提示词编辑弹窗：保存键常驻 ---------------- */\n.wbm-pm-sticky {\n    position: sticky;\n    bottom: 0;\n    z-index: 5;\n    display: flex;\n    align-items: center;\n    justify-content: flex-end;\n    gap: 8px;\n    flex-wrap: wrap;\n    padding: 8px 4px;\n    margin-top: 6px;\n    background: var(--SmartThemeBlurTintColor, rgba(28, 28, 38, .96));\n    border-top: 1px solid var(--SmartThemeBorderColor, rgba(255, 255, 255, .16));\n    box-shadow: 0 -6px 12px -8px var(--SmartThemeShadowColor, rgba(0, 0, 0, .6));\n}\n\n/* ================= 人设管理：分组 + 手机折叠 ================= */\n.wbm-persona-bar {\n    display: flex;\n    align-items: center;\n    gap: 6px;\n    flex-wrap: wrap;\n    margin-bottom: 8px;\n}\n\n.wbm-persona-chips {\n    display: flex;\n    gap: 6px;\n    flex-wrap: wrap;\n    flex: 1 1 auto;\n    min-width: 0;\n}\n\n.wbm-persona-hint {\n    font-family: ui-monospace, monospace;\n    font-size: 11px;\n    opacity: .6;\n    margin-left: auto;\n}\n\n.wbm-persona-tag {\n    display: inline-block;\n    margin-top: 2px;\n    padding: 1px 6px;\n    border-radius: 999px;\n    border: 1px solid var(--SmartThemeBorderColor);\n    font-size: 10px;\n    line-height: 14px;\n    max-width: 100%;\n    overflow: hidden;\n    text-overflow: ellipsis;\n    white-space: nowrap;\n    opacity: .8;\n}\n\n.wbm-persona-collapse {\n    display: inline-flex;\n    width: 100%;\n    justify-content: center;\n    margin-bottom: 8px;\n}\n\n.persona_management_left_column.wbm-collapsed {\n    flex: 0 0 auto;\n}\n\n/* 手机收起人设列表时，我们那排筛选胶囊与「分组…」要留着——\n   否则想按组筛选、想打开分组浮层，连入口都被一起收走了（master 2026-10-21 报「点开分组浮层就卡住」，手机端连点开都做不到）。 */\n.persona_management_left_column.wbm-collapsed > *:not(#wbm-persona-collapse):not(#wbm-persona-bar) {\n    display: none !important;\n}\n\n.persona_management_left_column.wbm-collapsed > #wbm-persona-bar {\n    display: flex !important;\n}\n\n.wbm-persona-row {\n    flex-wrap: wrap;\n    row-gap: 6px;\n}\n\n.wbm-persona-row .wbm-picker-line {\n    display: flex;\n    align-items: center;\n    gap: 8px;\n    width: 100%;\n    min-width: 0;\n}\n\n.wbm-persona-row .wbm-picker-name {\n    flex: 1 1 auto;\n    min-width: 0;\n    overflow: hidden;\n    text-overflow: ellipsis;\n    white-space: nowrap;\n}\n\n/* ---------------- 人设分组浮层（2026-10-21） ---------------- */\n/* 标题行：左边标题、右边「关闭」，任何状态下都能退出 */\n.wbm-picker-titlerow {\n    display: flex;\n    align-items: center;\n    gap: 10px;\n    padding: 2px 12px 6px;\n}\n\n.wbm-picker-titlerow .wbm-picker-title {\n    flex: 1 1 auto;\n    min-width: 0;\n    overflow: hidden;\n    text-overflow: ellipsis;\n    white-space: nowrap;\n}\n\n.wbm-picker-close {\n    flex: 0 0 auto;\n    padding: 5px 14px;\n    min-height: 32px;\n    border-radius: 999px;\n    border: 1px solid var(--SmartThemeBorderColor, rgba(128, 128, 128, .45));\n    background: transparent;\n    color: var(--SmartThemeBodyColor, inherit);\n    font-family: inherit;\n    font-size: 13px;\n    line-height: 1.2;\n    cursor: pointer;\n}\n\n.wbm-picker-close:hover {\n    border-color: var(--SmartThemeEmColor, rgba(156, 123, 214, .8));\n}\n\n.wbm-persona-row .wbm-picker-line { cursor: pointer; }\n\n/* 组名输入行：输入框占余量、两个键不压缩（原来输入框 width:100% 把「确定/取消」挤成竖排） */\n.wbm-preset-saverow .wbm-name-input-inline {\n    flex: 1 1 8em;\n    width: auto;\n    min-width: 0;\n}\n\n.wbm-preset-saverow .wbm-preset-tool {\n    flex: 0 0 auto;\n    white-space: nowrap;\n    padding: 5px 14px;\n    min-height: 30px;\n    font-size: 13px;\n}\n\n/* ---- 提示词管理器：把手显示规则（1.3.14，按 TT 酒馆的行为对齐） ----\n   TT 的 promptmanager.css 只在把手真正生效时才显示 ☰；电脑端整行可拖，所以不显示。\n   这里用同样的规则：细指针（鼠标）隐藏装饰性把手，粗指针（触屏）显示并和星号拉开距离。 */\n@media (pointer: fine) {\n    #completion_prompt_manager_list .drag-handle,\n    .completion_prompt_manager_prompt > .drag-handle {\n        display: none !important;\n    }\n}\n\n@media (pointer: coarse) {\n    #completion_prompt_manager_list .drag-handle,\n    .completion_prompt_manager_prompt > .drag-handle {\n        padding: 2px 10px 2px 2px;\n        margin-right: 8px;\n        opacity: 0.8;\n        cursor: grab;\n    }\n\n    #completion_prompt_manager_list .drag-handle:active,\n    .completion_prompt_manager_prompt > .drag-handle:active {\n        cursor: grabbing;\n    }\n}\n\n/* 提示词管理器底部的版本标记：用来确认页面跑的是哪一版（排查缓存用） */\n.wbm-pm-ver {\n    margin-left: auto;\n    font-family: ui-monospace, monospace;\n    font-size: 10px;\n    opacity: .45;\n    white-space: nowrap;\n}\n/* ================= 排序状态（1.3.18） ================= */\n#completion_prompt_manager_list.wbm-sorting li .prompt_manager_prompt_controls {\n    display: none !important;\n}\n\n#completion_prompt_manager_list.wbm-sorting .drag-handle {\n    display: inline-flex !important;\n    align-items: center;\n    justify-content: center;\n    width: 26px;\n    margin-right: 2px;\n    opacity: .8;\n    cursor: grab;\n    user-select: none;\n}\n\n#completion_prompt_manager_list .wbm-pm-seq {\n    flex: 0 0 auto;\n    min-width: 1.7em;\n    text-align: right;\n    font-family: ui-monospace, monospace;\n    font-size: 11px;\n    opacity: .6;\n    margin-right: 6px;\n}\n\n#completion_prompt_manager_list .wbm-pm-box {\n    flex: 0 0 auto;\n    position: relative;\n    width: 18px;\n    height: 18px;\n    border-radius: 5px;\n    border: 2px solid var(--SmartThemeBorderColor, rgba(170, 170, 170, .9));\n    box-sizing: border-box;\n    margin-right: 5px;\n    cursor: pointer;\n}\n\n#completion_prompt_manager_list .wbm-pm-box.on {\n    border-color: var(--SmartThemeQuoteColor, #d4b06a);\n    background: var(--SmartThemeQuoteColor, #d4b06a);\n}\n\n#completion_prompt_manager_list .wbm-pm-box.on::after {\n    content: '';\n    position: absolute;\n    left: 50%;\n    top: 50%;\n    width: 5px;\n    height: 9px;\n    border: solid var(--SmartThemeBlurTintColor, #1c1c26);\n    border-width: 0 2px 2px 0;\n    box-sizing: border-box;\n    transform: translate(-50%, -58%) rotate(42deg);\n}\n\n#completion_prompt_manager_list li.wbm-pm-picked {\n    background-color: color-mix(in srgb, var(--SmartThemeEmColor, #9c7bd6) 18%, transparent) !important;\n}\n\n#completion_prompt_manager_list .wbm-pm-insert.wbm-pm-arrow-off {\n    opacity: .25;\n    cursor: help;\n}\n\n#completion_prompt_manager_list.wbm-sorting li .wbm-pm-insert {\n    width: 22px;\n    height: 22px;\n    margin-right: 6px;\n    opacity: .5;\n}\n\n#completion_prompt_manager_list.wbm-sorting li:hover .wbm-pm-insert {\n    opacity: 1;\n}\n\n.wbm-prompt-sortbtn {\n    flex: 0 0 auto;\n    padding: 4px 12px;\n    border-radius: 8px;\n    border: 1px solid var(--SmartThemeBorderColor, rgba(128, 128, 128, .4));\n    background: transparent;\n    color: inherit;\n    font-family: inherit;\n    font-size: 12px;\n    line-height: 1.2;\n    cursor: pointer;\n    white-space: nowrap;\n}\n\n.wbm-prompt-sortbtn:hover {\n    border-color: var(--SmartThemeEmColor, #9c7bd6);\n    color: var(--SmartThemeEmColor, #9c7bd6);\n}\n\n/* ================= 排序态排版（1.3.19） =================\n   排序态只留「序号 · 勾选 · ☰ · ↓ · 名字 · token」，行内一律单行、名字省略。 */\n#completion_prompt_manager_list.wbm-sorting li[data-pm-identifier] {\n    display: flex;\n    align-items: center;\n    gap: 2px;\n    padding: 4px 8px 4px 2px;\n    min-height: 34px;\n    box-sizing: border-box;\n}\n\n#completion_prompt_manager_list.wbm-sorting li .wbm-pm-seq {\n    min-width: 1.5em;\n    margin: 0 2px 0 0;\n    font-size: 11px;\n    line-height: 1;\n}\n\n#completion_prompt_manager_list.wbm-sorting li .wbm-pm-box {\n    width: 16px;\n    height: 16px;\n    margin: 0 4px 0 2px;\n}\n\n#completion_prompt_manager_list.wbm-sorting li .drag-handle {\n    width: 20px;\n    margin: 0 2px 0 0;\n}\n\n#completion_prompt_manager_list.wbm-sorting li .wbm-pm-insert {\n    width: 18px;\n    height: 22px;\n    margin: 0 4px 0 0;\n}\n\n#completion_prompt_manager_list.wbm-sorting li .completion_prompt_manager_prompt_name,\n#completion_prompt_manager_list.wbm-sorting li .prompt_manager_prompt_name {\n    flex: 1 1 auto;\n    min-width: 0;\n    overflow: hidden;\n    text-overflow: ellipsis;\n    white-space: nowrap;\n}\n\n#completion_prompt_manager_list.wbm-sorting li .completion_prompt_manager_prompt_tokens,\n#completion_prompt_manager_list.wbm-sorting li .prompt_manager_prompt_tokens,\n#completion_prompt_manager_list.wbm-sorting li > span:last-child {\n    flex: 0 0 auto;\n    padding-left: 6px;\n    opacity: .45;\n    white-space: nowrap;\n}\n\n/* ================= 排序态视觉顺序（1.3.21） =================\n   宿主把每一行设成 `display: grid; grid-template-columns: 4fr 80px 45px`（css/promptmanager.css:20），\n   ☰ 又是 position:absolute —— 所以我们只写 li{display:flex} 是压不住的（网格优先级更高），\n   表现就是名字换行、星号和 ☰ 叠在一起。这里用同样的 id 链 + !important 才真正接管。 */\n#completion_prompt_manager #completion_prompt_manager_list.wbm-sorting li[data-pm-identifier] {\n    display: flex !important;\n    flex-wrap: nowrap !important;\n    align-items: center !important;\n    grid-template-columns: none !important;\n    gap: 4px !important;\n    padding: 5px 8px !important;\n    min-height: 40px;\n    box-sizing: border-box;\n    overflow: hidden;\n}\n\n#completion_prompt_manager #completion_prompt_manager_list.wbm-sorting li[data-pm-identifier] > .wbm-pm-seq {\n    order: -5;\n    flex: 0 0 auto !important;\n    min-width: 1.4em;\n    margin: 0 !important;\n    text-align: right;\n    font-size: 11px;\n    line-height: 1;\n}\n\n#completion_prompt_manager #completion_prompt_manager_list.wbm-sorting li[data-pm-identifier] > .wbm-pm-box {\n    order: -4;\n    flex: 0 0 auto !important;\n    width: 16px !important;\n    height: 16px !important;\n    margin: 0 2px 0 0 !important;\n}\n\n#completion_prompt_manager #completion_prompt_manager_list.wbm-sorting li[data-pm-identifier] > .drag-handle {\n    order: -3;\n    position: static !important;\n    top: auto !important;\n    height: auto !important;\n    width: 16px !important;\n    min-width: 16px !important;\n    padding: 0 !important;\n    margin: 0 !important;\n    display: inline-flex !important;\n    align-items: center;\n    justify-content: center;\n    font-size: 13px;\n    line-height: 1;\n    opacity: .75;\n    cursor: grab;\n}\n\n#completion_prompt_manager #completion_prompt_manager_list.wbm-sorting li[data-pm-identifier] > .wbm-pm-insert {\n    order: -2;\n    flex: 0 0 auto !important;\n    width: 18px !important;\n    height: 22px !important;\n    margin: 0 2px 0 0 !important;\n}\n\n#completion_prompt_manager #completion_prompt_manager_list.wbm-sorting li[data-pm-identifier] > .completion_prompt_manager_prompt_name {\n    order: 1;\n    flex: 1 1 auto !important;\n    min-width: 0;\n    display: flex !important;\n    align-items: center;\n    gap: 2px;\n    overflow: hidden;\n    white-space: nowrap !important;\n    line-height: 1.3;\n}\n\n#completion_prompt_manager #completion_prompt_manager_list.wbm-sorting li[data-pm-identifier] > .completion_prompt_manager_prompt_name > a {\n    overflow: hidden;\n    text-overflow: ellipsis;\n    white-space: nowrap;\n    min-width: 0;\n}\n\n#completion_prompt_manager #completion_prompt_manager_list.wbm-sorting li[data-pm-identifier] > span:not(.drag-handle):not(.wbm-pm-seq):not(.wbm-pm-box):not(.wbm-pm-insert):not(.completion_prompt_manager_prompt_name) {\n    order: 2;\n    flex: 0 0 auto !important;\n}\n\n#completion_prompt_manager #completion_prompt_manager_list.wbm-sorting li[data-pm-identifier] > .prompt_manager_prompt_tokens {\n    order: 3;\n    flex: 0 0 auto !important;\n    padding-left: 6px;\n    opacity: .5;\n}\n\n/* ================= 1.3.22：星号不吃指针、触屏不显示拖拽把手 ================= */\n#completion_prompt_manager_list .completion_prompt_manager_prompt_name .fa-solid.fa-asterisk,\n#completion_prompt_manager_list .completion_prompt_manager_prompt_name .fa-solid.fa-asterisk * {\n    pointer-events: none !important;\n}\n\n@media (pointer: coarse) {\n    #completion_prompt_manager #completion_prompt_manager_list.wbm-sorting li[data-pm-identifier] > .drag-handle {\n        display: none !important;\n    }\n}\n\n/* 触屏（手机/平板）不提供拖拽：☰ 直接不画。排序用勾选 + ↓。 */\n@media (pointer: coarse) {\n    #completion_prompt_manager #completion_prompt_manager_list li[data-pm-identifier] > .drag-handle,\n    #completion_prompt_manager #completion_prompt_manager_list.wbm-sorting li[data-pm-identifier] > .drag-handle {\n        display: none !important;\n    }\n}\n\n/* ================= 1.3.24：拖拽整体下线 + 顶部常驻工具条 + 每行 ↑↓ 微调 ================= */\n/* ☰ 不再出现（手机、电脑、排序态都一样） */\n#completion_prompt_manager #completion_prompt_manager_list li[data-pm-identifier] > .drag-handle,\n#completion_prompt_manager #completion_prompt_manager_list.wbm-sorting li[data-pm-identifier] > .drag-handle {\n    display: none !important;\n}\n\n/* 工具条常驻在提示词管理器顶部，滚到列表中间也看得到 */\n#completion_prompt_manager > .wbm-prompt-bar {\n    position: sticky;\n    top: 0;\n    z-index: 7;\n    display: flex;\n    align-items: center;\n    gap: 10px;\n    flex-wrap: wrap;\n    margin: 0 0 6px;\n    padding: 7px 4px;\n    background: var(--SmartThemeBlurTintColor, rgba(28, 28, 38, .96));\n    border-bottom: 1px solid var(--SmartThemeBorderColor, rgba(255, 255, 255, .12));\n}\n#completion_prompt_manager > .wbm-prompt-bar .wbm-prompt-bar-hint {\n    flex: 1 1 12em;\n    min-width: 0;\n}\n\n/* 每行 ↑↓：一对小键，紧挨行尾控件区，默认低调、悬停变亮 */\n#completion_prompt_manager_list li[data-pm-identifier] .wbm-pm-step {\n    display: inline-flex;\n    align-items: center;\n    gap: 2px;\n    margin-right: 6px;\n    flex: 0 0 auto;\n}\n#completion_prompt_manager_list li[data-pm-identifier] .wbm-pm-step > * {\n    width: 22px;\n    height: 22px;\n    display: inline-flex;\n    align-items: center;\n    justify-content: center;\n    border-radius: 6px;\n    font-size: 12px;\n    opacity: .5;\n    cursor: pointer;\n    color: var(--SmartThemeBodyColor, #e6e6e6);\n}\n#completion_prompt_manager_list li[data-pm-identifier] .wbm-pm-step > *:hover {\n    opacity: 1;\n    background: color-mix(in srgb, var(--SmartThemeEmColor, #9c7bd6) 24%, transparent);\n}\n\n/* 排序态：鼠标移上去时不要丢掉行框（master：「选项高亮时，选项框会消失」） */\n#completion_prompt_manager #completion_prompt_manager_list.wbm-sorting li[data-pm-identifier]:hover {\n    background-color: color-mix(in srgb, var(--SmartThemeBorderColor, #ffffff) 10%, transparent);\n    outline: 1px solid color-mix(in srgb, var(--SmartThemeEmColor, #9c7bd6) 40%, transparent);\n    outline-offset: -1px;\n}\n\n/* 酒馆原生那句「单击滑块以手动输入值。」常驻在 AI 面板顶端，盖在内容上；这里收掉 */\n#left-nav-panel #clickSlidersTips {\n    display: none !important;\n}\n\n/* ================= 1.3.26：↑↓ 收进行尾控件区（不再占第二行）+ 排序态隐藏 ================= */\n#completion_prompt_manager_list li[data-pm-identifier] .wbm-pm-step {\n    display: inline-flex;\n    align-items: center;\n    gap: 0;\n    margin: 0 4px 0 0;\n    padding: 0;\n    flex: 0 0 auto;\n    line-height: 1;\n}\n#completion_prompt_manager_list li[data-pm-identifier] .wbm-pm-step > * {\n    width: 18px;\n    height: 18px;\n    display: inline-flex;\n    align-items: center;\n    justify-content: center;\n    border-radius: 4px;\n    font-size: 10px;\n    opacity: .55;\n    cursor: pointer;\n    color: var(--SmartThemeBodyColor, #e6e6e6);\n    margin: 0;\n}\n#completion_prompt_manager_list li[data-pm-identifier] .wbm-pm-step > *:hover {\n    opacity: 1;\n    background: color-mix(in srgb, var(--SmartThemeEmColor, #9c7bd6) 22%, transparent);\n}\n\n/* 1.3.33：排序态要显示 ↑↓（顶替 Token 数字），旧的隐藏规则已删除。 */\n\n/* 工具条：没有说明文字，按钮靠右排一行 */\n#completion_prompt_manager > .wbm-prompt-bar {\n    gap: 8px;\n    padding: 6px 4px;\n}\n#completion_prompt_manager > .wbm-prompt-bar .wbm-prompt-bar-hint {\n    display: none !important;\n}\n\n\n/* ================= 1.3.32：底栏回到「上一版」观感 + 排序态 token↔↑↓ 换位 ================= */\n#completion_prompt_manager > .wbm-prompt-bar {\n    gap: 10px;\n    padding: 8px 6px;\n    margin: 0 0 8px;\n    background: var(--SmartThemeBlurTintColor, rgba(28, 28, 38, .96));\n    border-bottom: 1px solid var(--SmartThemeBorderColor, rgba(255, 255, 255, .12));\n    justify-content: flex-end;\n    flex-wrap: nowrap;\n}\n\n#completion_prompt_manager > .wbm-prompt-bar .wbm-prompt-count {\n    margin-right: auto;\n    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;\n    font-size: 11px;\n    opacity: .6;\n    white-space: nowrap;\n}\n\n#completion_prompt_manager > .wbm-prompt-bar .wbm-prompt-sortbtn {\n    flex: 0 0 auto;\n    display: inline-flex;\n    align-items: center;\n    justify-content: center;\n    width: 30px;\n    height: 28px;\n    padding: 0;\n    border-radius: 8px;\n    border: 1px solid var(--SmartThemeBorderColor, rgba(128, 128, 128, .4));\n    background: transparent;\n    color: var(--SmartThemeBodyColor, inherit);\n    font-size: 13px;\n    line-height: 1;\n    cursor: pointer;\n}\n\n#completion_prompt_manager > .wbm-prompt-bar .wbm-prompt-sortbtn:hover {\n    border-color: var(--SmartThemeEmColor, #9c7bd6);\n    color: var(--SmartThemeEmColor, #9c7bd6);\n}\n\n#completion_prompt_manager > .wbm-prompt-bar .wbm-prompt-sortbtn.wbm-on {\n    border-color: var(--SmartThemeEmColor, #9c7bd6);\n    color: var(--SmartThemeEmColor, #9c7bd6);\n}\n\n/* 排序态：Token 数字让位给 ↑↓ */\n#completion_prompt_manager_list.wbm-sorting li[data-pm-identifier] .prompt_manager_prompt_tokens,\n#completion_prompt_manager_list.wbm-sorting li[data-pm-identifier] .prompt_manager_prompt_tokens * {\n    display: none !important;\n}\n\n#completion_prompt_manager_list.wbm-sorting li[data-pm-identifier] .wbm-pm-step {\n    display: inline-flex !important;\n    align-items: center;\n    gap: 2px;\n    margin: 0 2px 0 6px;\n    padding: 0;\n    flex: 0 0 auto;\n    line-height: 1;\n    order: 99;\n}\n\n#completion_prompt_manager_list.wbm-sorting li[data-pm-identifier] .wbm-pm-step > * {\n    width: 22px;\n    height: 22px;\n    display: inline-flex;\n    align-items: center;\n    justify-content: center;\n    border-radius: 6px;\n    font-size: 12px;\n    opacity: .6;\n    cursor: pointer;\n    color: var(--SmartThemeBodyColor, #e6e6e6);\n    margin: 0;\n}\n\n#completion_prompt_manager_list.wbm-sorting li[data-pm-identifier] .wbm-pm-step > *:hover {\n    opacity: 1;\n    background: color-mix(in srgb, var(--SmartThemeEmColor, #9c7bd6) 24%, transparent);\n}\n\n/* 自绘 SVG 图标（1.3.35）：不依赖宿主裁剪过的图标字体 */\n.wbm-ico { width: 14px; height: 14px; display: block; flex: 0 0 auto; pointer-events: none; }\n.wbm-pm-insert .wbm-ico { width: 13px; height: 13px; }\n.wbm-pm-step .wbm-ico { width: 12px; height: 12px; }\n.wbm-prompt-bar button .wbm-ico { width: 14px; height: 14px; }\n#wbm-talk-preset-btn .wbm-ico { width: 13px; height: 13px; }\n\n/* ================= 1.3.36：排序态 ↑↓ 改用自绘 SVG ================= */\n/* 宿主那份 Font Awesome 是裁剪过的子集，没有 .fa-arrow-up / .fa-arrow-down，\n   之前每行 ↑↓ 是空的「带叉方框」（master 2026-10-22 报的「直接不显示按键」）。\n   现在按钮里放 <svg class=wbm-ico>，不依赖任何图标字体。 */\n#completion_prompt_manager_list.wbm-sorting li[data-pm-identifier] .wbm-pm-step .wbm-ico {\n    width: 14px;\n    height: 14px;\n}\n\n/* 触屏（手机/平板）：↑↓ 抬到 30×28。master 定的可点下限是图标键 34×32、胶囊 30，\n   22px 在手机上是「难以触发」那一档；桌面保持 22px，不为此挤小密度。 */\n@media (pointer: coarse) {\n    #completion_prompt_manager_list li[data-pm-identifier] .wbm-pm-step > * {\n        width: 30px;\n        height: 28px;\n    }\n    #completion_prompt_manager_list.wbm-sorting li[data-pm-identifier] .wbm-pm-step > * {\n        width: 30px;\n        height: 28px;\n    }\n    #completion_prompt_manager_list.wbm-sorting li[data-pm-identifier] .wbm-pm-step .wbm-ico {\n        width: 16px;\n        height: 16px;\n        height: 16px;\n    }\n}\n\n/* 行内 ⤓：不必选中条目也一直看得见。之前 .25 的透明度在深色主题上等于没有键，\n   master 2026-10-22：「⤓ 不再隐身，直接不显示按键了」。没勾选时点它会提示先勾选。 */\n#completion_prompt_manager_list .wbm-pm-insert.wbm-pm-arrow-off {\n    opacity: .7;\n    cursor: pointer;\n}\n#completion_prompt_manager #completion_prompt_manager_list.wbm-sorting li[data-pm-identifier] > .wbm-pm-insert {\n    width: 22px !important;\n    height: 26px !important;\n    margin-right: 4px !important;\n    opacity: .85;\n}\n@media (pointer: coarse) {\n    /* 旧的 !important（width:18px/height:22px）在前，必须同样 !important 才压得住。 */\n    #completion_prompt_manager #completion_prompt_manager_list li[data-pm-identifier] > .wbm-pm-insert,\n    #completion_prompt_manager #completion_prompt_manager_list.wbm-sorting li[data-pm-identifier] > .wbm-pm-insert {\n        width: 30px !important;\n        height: 28px !important;\n    }\n    #completion_prompt_manager_list .wbm-pm-insert .wbm-ico {\n        width: 16px;\n        height: 16px;\n    }\n}\n/* ================= 1.3.37：性能 + 手机触摸 ================= */\n/* ⤓ 从勾选框右边挪到行尾（↑↓ 左边）：它原来紧贴勾选框，勾选时经常点到它、把条目搬错位置。\n   order 排序：seq(-5) box(-4) ☰(-3) name(1) 其它(2) token(3) ⤓(98) ↑↓(99)。 */\n#completion_prompt_manager #completion_prompt_manager_list.wbm-sorting li[data-pm-identifier] > .wbm-pm-insert {\n    order: 98 !important;\n    margin: 0 0 0 8px !important;\n}\n/* 三个自绘键统一：去掉双击缩放/300ms 等待，也不再出蓝色高亮块。 */\n#completion_prompt_manager_list .wbm-pm-box,\n#completion_prompt_manager_list .wbm-pm-insert,\n#completion_prompt_manager_list .wbm-pm-step > * {\n    touch-action: manipulation;\n    -webkit-tap-highlight-color: transparent;\n    user-select: none;\n}\n@media (pointer: coarse) {\n    /* 勾选框放大到 20px 并与 ⤓ 之间留出整整一个名字区的距离（⤓ 已在行尾）。 */\n    #completion_prompt_manager #completion_prompt_manager_list.wbm-sorting li[data-pm-identifier] > .wbm-pm-box {\n        width: 20px !important;\n        height: 20px !important;\n        margin: 0 8px 0 0 !important;\n    }\n}\n\n\n/* ================= 1.3.38：复制到其它预设 ================= */\n/* 工具栏靠左那个键：与右边排序键同尺寸，靠 margin-right:auto 顶到最左，\n   已选计数改靠右（原来 count 上的 margin-right:auto 会把它也拉到左边）。 */\n#completion_prompt_manager > .wbm-prompt-bar .wbm-prompt-copybtn {\n    flex: 0 0 auto;\n    display: inline-flex;\n    align-items: center;\n    justify-content: center;\n    width: 30px;\n    height: 28px;\n    padding: 0;\n    margin: 0 auto 0 0;\n    border-radius: 8px;\n    border: 1px solid var(--SmartThemeBorderColor, rgba(128, 128, 128, .4));\n    background: transparent;\n    color: var(--SmartThemeBodyColor, inherit);\n    font-size: 13px;\n    line-height: 1;\n    cursor: pointer;\n    touch-action: manipulation;\n    -webkit-tap-highlight-color: transparent;\n}\n#completion_prompt_manager > .wbm-prompt-bar .wbm-prompt-copybtn:hover {\n    border-color: var(--SmartThemeEmColor, #9c7bd6);\n    color: var(--SmartThemeEmColor, #9c7bd6);\n}\n#completion_prompt_manager > .wbm-prompt-bar .wbm-prompt-count {\n    margin-right: 0;\n}\n/* 浮层顶部那句「把 N 条复制到…」，以及预设行里用等宽字体把名字排整齐 */\n.wbm-copy-hint {\n    padding: 8px 14px 6px;\n    font-size: 12px;\n    line-height: 1.5;\n    opacity: .75;\n}\n.wbm-copy-row-name {\n    min-width: 0;\n    overflow: hidden;\n    text-overflow: ellipsis;\n    white-space: nowrap;\n}\n#wbm-settings #wbm-regex-allow {\n    display: block;\n    width: 100%;\n    max-width: 100%;\n    white-space: nowrap;\n    text-align: center;\n    box-sizing: border-box;\n    margin: 8px 0 2px;\n}\n/* ================= 1.3.39：勾选框跟随主题 ================= */\n/* master 2026-10-22 报「勾选框没有随主体变化」，美化「寰宇独奏v1.5」下直接看不见。\n   查下来那套美化的 --SmartThemeBorderColor 是 rgba(251,219,179,0)（全透明），\n   而勾选框原来只靠 border: 2px solid var(--SmartThemeBorderColor) 画框 → 框线透明。\n   改成从正文字色调出来的灰：任何主题下都与底色有反差；勾选后的勾用底色画。 */\n#completion_prompt_manager_list .wbm-pm-box {\n    border-color: color-mix(in srgb, var(--SmartThemeBodyColor, #cfcfcf) 55%, transparent);\n    background: color-mix(in srgb, var(--SmartThemeBodyColor, #cfcfcf) 8%, transparent);\n}\n#completion_prompt_manager_list .wbm-pm-box:hover {\n    border-color: color-mix(in srgb, var(--SmartThemeBodyColor, #cfcfcf) 80%, transparent);\n}\n#completion_prompt_manager_list .wbm-pm-box.on {\n    border-color: color-mix(in srgb, var(--SmartThemeBodyColor, #cfcfcf) 85%, transparent);\n    background: color-mix(in srgb, var(--SmartThemeBodyColor, #cfcfcf) 88%, transparent);\n}\n#completion_prompt_manager_list .wbm-pm-box.on::after {\n    border-color: var(--SmartThemeBlurTintColor, #1c1c26);\n}\n\n/* ================= 1.3.39：插入提示词的搜索行 / 触屏浮窗 ================= */\n.wbm-append-bar {\n    display: flex;\n    align-items: center;\n    gap: 8px;\n    flex-wrap: nowrap;\n    margin: 6px 0 4px;\n}\n.wbm-append-bar .wbm-append-search {\n    flex: 1 1 auto;\n    min-width: 0;\n    height: 30px;\n    padding: 0 10px;\n    box-sizing: border-box;\n    font-family: inherit;\n}\n.wbm-append-bar .wbm-append-btn {\n    display: none;\n    flex: 0 0 auto;\n    align-items: center;\n    gap: 6px;\n    height: 30px;\n    padding: 0 12px;\n    white-space: nowrap;\n}\n.wbm-append-bar .wbm-append-count {\n    flex: 0 0 auto;\n    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;\n    font-size: 11px;\n    opacity: .6;\n    white-space: nowrap;\n}\n@media (pointer: coarse) {\n    /* 手机：原生下拉收起来，改用我们自己的浮窗 */\n    .wbm-append-bar[data-coarse='1'] .wbm-append-search { display: none; }\n    .wbm-append-bar[data-coarse='1'] .wbm-append-btn { display: inline-flex; }\n    #completion_prompt_manager_footer_append_prompt { display: none !important; }\n}\n\n/* ================= 1.3.39：复制确认条 ================= */\n.wbm-copy-confirm {\n    flex: 0 0 auto;\n    border-top: 1px solid color-mix(in srgb, var(--SmartThemeBodyColor, #cfcfcf) 22%, transparent);\n    padding: 10px 14px 14px;\n    background: var(--SmartThemeBlurTintColor, rgba(28, 28, 38, .96));\n}\n.wbm-copy-confirm-text {\n    font-size: 12px;\n    line-height: 1.5;\n    opacity: .85;\n    margin-bottom: 8px;\n}\n.wbm-copy-confirm-actions {\n    display: flex;\n    gap: 8px;\n    justify-content: flex-end;\n}\n.wbm-copy-preset-row.active {\n    background: color-mix(in srgb, var(--SmartThemeEmColor, #9c7bd6) 22%, transparent);\n}\n.wbm-append-tag {\n    margin-left: auto;\n    padding-left: 10px;\n    font-size: 11px;\n    line-height: 1.4;\n    opacity: .55;\n    white-space: nowrap;\n}\n.wbm-append-inlist { opacity: .7; }\n\n/* ================= 1.3.40：查找已有条目 ================= */\n/* master 2026-10-22：参考 txt 编辑器的查找——搜已经添加好的条目，用上下切换跳转。\n   只高亮 + 跳转，不筛选、不动顺序。侧栏只有 243px 宽，所以查找行单独占第二行、平时收起。 */\n#completion_prompt_manager > .wbm-prompt-bar {\n    flex-wrap: wrap;\n}\n#completion_prompt_manager > .wbm-prompt-bar .wbm-prompt-findbtn {\n    flex: 0 0 auto;\n    display: inline-flex;\n    align-items: center;\n    justify-content: center;\n    width: 30px;\n    height: 28px;\n    padding: 0;\n    border-radius: 8px;\n    border: 1px solid var(--SmartThemeBorderColor, rgba(128, 128, 128, .4));\n    background: transparent;\n    color: var(--SmartThemeBodyColor, inherit);\n    cursor: pointer;\n    touch-action: manipulation;\n    -webkit-tap-highlight-color: transparent;\n}\n#completion_prompt_manager > .wbm-prompt-bar .wbm-prompt-findbtn:hover,\n#completion_prompt_manager > .wbm-prompt-bar.wbm-find-open .wbm-prompt-findbtn {\n    border-color: var(--SmartThemeEmColor, #9c7bd6);\n    color: var(--SmartThemeEmColor, #9c7bd6);\n}\n#completion_prompt_manager > .wbm-prompt-bar .wbm-find-tools {\n    display: none;\n    align-items: center;\n    gap: 6px;\n    flex: 1 0 100%;\n    min-width: 0;\n    margin: 2px 0 0;\n}\n#completion_prompt_manager > .wbm-prompt-bar.wbm-find-open .wbm-find-tools {\n    display: flex;\n}\n#completion_prompt_manager > .wbm-prompt-bar .wbm-prompt-find {\n    flex: 1 1 auto;\n    min-width: 0;\n    height: 28px;\n    padding: 0 10px;\n    box-sizing: border-box;\n    font-family: inherit;\n}\n#completion_prompt_manager > .wbm-prompt-bar .wbm-find-prev,\n#completion_prompt_manager > .wbm-prompt-bar .wbm-find-next {\n    flex: 0 0 auto;\n    display: inline-flex;\n    align-items: center;\n    justify-content: center;\n    width: 24px;\n    height: 28px;\n    padding: 0;\n    border-radius: 6px;\n    border: 1px solid color-mix(in srgb, var(--SmartThemeBodyColor, #cfcfcf) 40%, transparent);\n    background: transparent;\n    color: var(--SmartThemeBodyColor, inherit);\n    cursor: pointer;\n}\n#completion_prompt_manager > .wbm-prompt-bar .wbm-find-prev:disabled,\n#completion_prompt_manager > .wbm-prompt-bar .wbm-find-next:disabled {\n    opacity: .3;\n    cursor: default;\n}\n#completion_prompt_manager > .wbm-prompt-bar .wbm-find-count {\n    flex: 0 0 auto;\n    min-width: 34px;\n    text-align: right;\n    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;\n    font-size: 11px;\n    opacity: .7;\n    white-space: nowrap;\n}\n#completion_prompt_manager_list li[data-pm-identifier].wbm-find-hit {\n    background: color-mix(in srgb, var(--SmartThemeEmColor, #9c7bd6) 16%, transparent);\n}\n#completion_prompt_manager_list li[data-pm-identifier].wbm-find-cur {\n    background: color-mix(in srgb, var(--SmartThemeEmColor, #9c7bd6) 28%, transparent);\n    outline: 2px solid color-mix(in srgb, var(--SmartThemeEmColor, #9c7bd6) 70%, transparent);\n    outline-offset: -2px;\n}\n@media (pointer: coarse) {\n    #completion_prompt_manager > .wbm-prompt-bar .wbm-find-prev,\n    #completion_prompt_manager > .wbm-prompt-bar .wbm-find-next {\n        width: 30px;\n        height: 30px;\n    }\n}.wbm-persona-bar{display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-bottom:8px;}.wbm-persona-filter{display:flex;align-items:center;gap:8px;width:100%;min-height:38px;padding:0 10px;border-radius:10px;border:1px solid color-mix(in srgb, var(--SmartThemeBodyColor, #cfcfcf) 42%, transparent);background:color-mix(in srgb, var(--SmartThemeEmColor, #9c7bd6) 12%, transparent);color:var(--SmartThemeBodyColor, inherit);font:inherit;font-size:13px;line-height:1.2;text-align:left;cursor:pointer;}.wbm-persona-filter:hover{border-color:var(--SmartThemeEmColor, #9c7bd6);}.wbm-persona-filter-label{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}.wbm-persona-filter .wbm-ico{flex:0 0 auto;width:14px;height:14px;opacity:.75;}.wbm-persona-manage{flex:0 0 auto;height:30px;padding:0 12px;border-radius:999px;border:1px solid color-mix(in srgb, var(--SmartThemeBodyColor, #cfcfcf) 42%, transparent);background:transparent;color:var(--SmartThemeBodyColor, inherit);font:inherit;font-size:12px;cursor:pointer;}.wbm-persona-manage:hover{border-color:var(--SmartThemeEmColor, #9c7bd6);}.wbm-persona-hint{flex:0 0 auto;margin-left:auto;font-family:ui-monospace, monospace;font-size:11px;opacity:.6;}.wbm-persona-filter-row.on{border-color:var(--SmartThemeEmColor, #9c7bd6);background:color-mix(in srgb, var(--SmartThemeEmColor, #9c7bd6) 20%, transparent);}.wbm-persona-tag{display:inline-flex;align-items:center;margin-left:6px;padding:0 6px;border-radius:999px;border:1px solid color-mix(in srgb, var(--SmartThemeBodyColor, #cfcfcf) 42%, transparent);background:color-mix(in srgb, var(--SmartThemeEmColor, #9c7bd6) 18%, transparent);color:var(--SmartThemeBodyColor, inherit);font-size:10px;line-height:14px;max-width:96px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;vertical-align:middle;}.wbm-persona-tag-none{background:transparent;opacity:.5;}@media (pointer: coarse){.wbm-persona-filter{min-height:42px;font-size:14px;}.wbm-persona-manage{height:34px;font-size:13px;}}\n/* ================= 1.3.43：人设列表分页 ================= */\n/* master 2026-10-23：角色多了列表特别长、还要同时显示多张图，所以按分组显示也分页。\n   页码占宿主分页条的位置（筛选时宿主那排临时藏起来），一个键换每页条数 5/10/20/50。 */\n.wbm-persona-grouppager {\n    display: none;\n    align-items: center;\n    gap: 6px;\n    flex: 1 0 100%;\n    min-width: 0;\n    margin-top: 2px;\n}\n.wbm-persona-grouppager .wbm-persona-pagebtn {\n    height: 26px;\n    min-width: 26px;\n    padding: 0 6px;\n    font-size: 13px;\n    line-height: 1;\n}\n.wbm-persona-grouppager .wbm-persona-pageinfo {\n    font-size: 11px;\n    white-space: nowrap;\n    overflow: hidden;\n    text-overflow: ellipsis;\n}\n.wbm-persona-sizebtn {\n    flex: 0 0 auto;\n    height: 30px;\n    padding: 0 10px;\n    border-radius: 999px;\n    border: 1px solid color-mix(in srgb, var(--SmartThemeBodyColor, #cfcfcf) 42%, transparent);\n    background: transparent;\n    color: var(--SmartThemeBodyColor, inherit);\n    font: inherit;\n    font-size: 11.5px;\n    white-space: nowrap;\n    cursor: pointer;\n}\n.wbm-persona-sizebtn:hover {\n    border-color: var(--SmartThemeEmColor, #9c7bd6);\n    color: var(--SmartThemeEmColor, #9c7bd6);\n}\n@media (pointer: coarse) {\n    .wbm-persona-grouppager .wbm-persona-pagebtn { height: 30px; min-width: 30px; }\n    .wbm-persona-sizebtn { height: 34px; font-size: 12.5px; }\n}\n\n/* ================= 1.3.42：人设分组性能与手感 ================= */\n.wbm-picker-row:hover{background:color-mix(in srgb, var(--SmartThemeBodyColor, #cfcfcf) 8%, transparent);}.wbm-picker-row:active{background:color-mix(in srgb, var(--SmartThemeEmColor, #9c7bd6) 26%, transparent);}.wbm-persona-filter-row{cursor:pointer;}.wbm-persona-row{display:flex;flex-wrap:nowrap;align-items:center;gap:8px;}.wbm-persona-row .wbm-picker-name{flex:0 1 auto;max-width:46%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}.wbm-persona-row-title{flex:0 1 auto;min-width:0;max-width:38%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11.5px;opacity:.6;}.wbm-persona-row-group{flex:0 0 auto;margin-left:auto;padding:0 8px;border-radius:999px;border:1px solid color-mix(in srgb, var(--SmartThemeBodyColor, #cfcfcf) 40%, transparent);background:color-mix(in srgb, var(--SmartThemeEmColor, #9c7bd6) 18%, transparent);font-size:11px;line-height:18px;white-space:nowrap;max-width:104px;overflow:hidden;text-overflow:ellipsis;}.wbm-persona-row-group-none{background:transparent;opacity:.45;}.wbm-persona-row .wbm-preset-tool{flex:0 0 auto;white-space:nowrap;}.wbm-persona-pager{display:flex;align-items:center;gap:10px;padding:8px 14px 12px;flex:0 0 auto;}.wbm-persona-pagebtn{height:30px;padding:0 12px;border-radius:8px;border:1px solid color-mix(in srgb, var(--SmartThemeBodyColor, #cfcfcf) 42%, transparent);background:transparent;color:var(--SmartThemeBodyColor, inherit);font:inherit;font-size:12px;cursor:pointer;}.wbm-persona-pagebtn:hover:not(:disabled){border-color:var(--SmartThemeEmColor, #9c7bd6);color:var(--SmartThemeEmColor, #9c7bd6);}.wbm-persona-pagebtn:disabled{opacity:.35;cursor:default;}.wbm-persona-pageinfo{flex:1 1 auto;text-align:center;font-family:ui-monospace, monospace;font-size:11.5px;opacity:.7;}.wbm-persona-bar.wbm-flash .wbm-persona-filter{animation:wbm-flash .62s ease-out 1;}@keyframes wbm-flash{from{box-shadow:0 0 0 3px color-mix(in srgb, var(--SmartThemeEmColor, #9c7bd6) 65%, transparent);}to{box-shadow:0 0 0 0 transparent;}}@media (pointer: coarse){.wbm-persona-pagebtn{height:36px;font-size:13px;}.wbm-persona-row .wbm-preset-tool{min-height:34px;}}\n\n/* ===== 1.3.45：行内编辑与分组，浮层不关 ===== */\n.wbm-inline-groups { display: flex; flex-wrap: wrap; gap: 6px; flex: 1 1 auto; min-width: 0; }\n.wbm-inline-groups .wbm-picker-action { height: 26px; padding: 0 8px; font-size: 12.5px; }\n.wbm-picker-row[data-role='preset-edit'] { flex-wrap: wrap; gap: 6px; align-items: center; cursor: default; }\n.wbm-picker-row[data-role='preset-edit']:hover { background: transparent; }\n.wbm-picker-titlerow .wbm-preset-tool { margin-left: auto; }\n@media (pointer: coarse) {\n    .wbm-inline-groups .wbm-picker-action { height: 32px; padding: 0 10px; font-size: 13.5px; }\n}\n\n#completion_prompt_manager_list li.wbm-find-pulse{animation:wbm-find-pulse .62s ease-out}@keyframes wbm-find-pulse{0%{box-shadow:0 0 0 2px color-mix(in srgb, var(--SmartThemeEmColor, #9c7bd6) 85%, transparent)}100%{box-shadow:0 0 0 2px color-mix(in srgb, var(--SmartThemeEmColor, #9c7bd6) 0%, transparent)}}\n\n/* ---------- 1.3.51：宿主分页控件不许被压扁（TT 的 #WorldInfo 固定 640px） ---------- */\n.wbm-scope-row #world_info_pagination {\n    flex: 0 0 auto;\n}\n.wbm-scope-row #world_info_pagination .paginationjs,\n.wbm-scope-row #world_info_pagination .paginationjs-nav,\n.wbm-scope-row #world_info_pagination .paginationjs-pages {\n    flex: 0 0 auto;\n}\n.wbm-scope-row #world_info_pagination .paginationjs-nav {\n    white-space: nowrap;\n}\n.wbm-scope-row #world_info_pagination select {\n    flex: 0 0 auto;\n    min-width: 4.6em;\n}\n\n/* 条目标题的伸缩底线：宿主给的是 flex:1 1 0%，抽屉一窄就压到 min-content */\n#world_popup_entries_list .WIEntryTitleAndStatus {\n    flex: 1 1 22em;\n    min-width: 14em;\n}\n#world_popup_entries_list .WIEntryTitleAndStatus > .flex-container {\n    flex: 1 1 auto;\n    min-width: 0;\n}\n#world_popup_entries_list .WIEntryTitleAndStatus textarea[name=\"comment\"] {\n    width: 100%;\n}\n\n/* ================= 1.3.53：世界书条目表头 ================= */\n/* 单排：小标题垂直居中到列中线（master 2026-10-23：位置对，但要上下居中） */\n#world_popup_entries_list > #WIEntryHeaderTitlesPC {\n    align-items: center;\n}\n/* 表头条内垂直居中：这条 !important 是刻意的——宿主模板给 <small> 带 inline 样式，\n   而且 alignEntryHeaders() 也会写 inline top，两者都要被这条压住，统一由样式表说话。 */\n#world_popup_entries_list > #WIEntryHeaderTitlesPC > small {\n    top: 50% !important;\n    transform: translateY(-50%) !important;\n}\n\n/* 折成两排：整排表头无法与任何一列对齐，让位给每格自己的小标题\n   （复用宿主的 .WIEntryHeaderTitleMobile，手机端就是这么显示的，不另造标注）。\n   左右留白收到最小，四个字段按剩余宽度自动排一行或两行。 */\n#world_popup_entries_list.wbm-wi-wrapped > #WIEntryHeaderTitlesPC {\n    display: none !important;\n}\n#world_popup_entries_list.wbm-wi-wrapped .WIEnteryHeaderControls {\n    flex-wrap: wrap;\n    gap: 6px 10px;\n}\n#world_popup_entries_list.wbm-wi-wrapped .WIEnteryHeaderControls .world_entry_form_control {\n    flex: 1 1 7em;\n    min-width: 0;\n}\n#world_popup_entries_list.wbm-wi-wrapped .WIEnteryHeaderControls .WIEntryHeaderTitleMobile {\n    display: block !important;\n    font-size: 11.5px;\n    line-height: 1.25;\n    opacity: .68;\n    margin: 0 0 2px;\n    padding: 0 1px;\n    white-space: nowrap;\n}\n#world_popup_entries_list.wbm-wi-wrapped .WIEnteryHeaderControls select,\n#world_popup_entries_list.wbm-wi-wrapped .WIEnteryHeaderControls input {\n    width: 100% !important;\n    max-width: none !important;\n}\n\n/* ================= 提示词编辑框限制高度（1.3.0） =================\n   TT 酒馆里预设条目的编辑框会按内容整段展开，长条目时底部按钮被顶出视野。\n   这里只给酒馆自己的编辑框加一个上限，让它像 ST 那样在框内滚动；\n   酒馆（或其它扩展）自带的复制、查找、替换等按钮一律不碰、也不重排。 */\nhtml.wbm-pmcap-on #completion_prompt_manager_popup .completion_prompt_manager_popup_entry_form_control:has(#completion_prompt_manager_popup_entry_form_prompt) {\n    min-height: 0;\n    overflow: hidden;\n}\nhtml.wbm-pmcap-on #completion_prompt_manager_popup #completion_prompt_manager_popup_entry_form_prompt {\n    flex: 1 1 auto;\n    height: auto;\n    min-height: 200px;\n    max-height: min(52vh, 640px);\n    max-height: min(52dvh, 640px);\n    overflow-y: auto;\n    resize: vertical;\n}\n@media (max-width: 760px) {\n    html.wbm-pmcap-on #completion_prompt_manager_popup #completion_prompt_manager_popup_entry_form_prompt {\n        max-height: min(46vh, 520px);\n        max-height: min(46dvh, 520px);\n    }\n}\n";
/* ==== WBM_CSS_END ==== */

    function ourScriptUrl() {
        for (const node of document.querySelectorAll('script[src]')) {
            const src = String(node.src || '');
            if (src.indexOf('WorldbookEnhance') === -1) continue;
            return src;
        }
        return null;
    }

    /* 酒馆是按 manifest 里的路径去请求 style.css 的，弱网/一次没拉全时 <link> 在、link.sheet 却是 null，
       界面就变成"没样式的裸 HTML"，用户视角等于"扩展没加载出来"。这里带随机参数重试两次。 */
    let styleRetry = 0;
    /* 样式全部内置在 main.js 里（WBM_CSS），启动时以 <style> 注入。
       不向宿主请求任何 .css：TauriTavern 会把「manifest 声明的样式表加载失败」
       当成扩展加载失败，酒馆本体弱网时也会出现「样式没到手」的裸界面。 */
    function injectInlineStyles() {
        if (!document.head) return false;
        if (document.getElementById('wbm-style-inline')) return true;
        const node = document.createElement('style');
        node.id = 'wbm-style-inline';
        node.textContent = WBM_CSS;
        document.head.appendChild(node);
        return true;
    }

    /* 样式全部内置在 main.js 里（WBM_CSS），启动时以 <style> 注入。
       不向宿主请求任何 .css：TauriTavern 会把「manifest 声明的样式表加载失败」
       当成扩展加载失败，酒馆本体弱网时也会出现「样式没到手」的裸界面。 */
    function injectInlineStyles() {
        if (!document.head) return false;
        if (document.getElementById('wbm-style-inline')) return true;
        const node = document.createElement('style');
        node.id = 'wbm-style-inline';
        node.textContent = WBM_CSS;
        document.head.appendChild(node);
        return true;
    }

    function ensureStyles() {
        injectInlineStyles();
    }

    function bindPanelWatcher() {
        const icon = document.getElementById('WIDrawerIcon');
        if (!icon || icon.dataset.wbmWatch === '1') return;
        icon.dataset.wbmWatch = '1';
        icon.addEventListener('click', () => {
            /* 抽屉有切换动画，等它落定后再判断是开还是关 */
            setTimeout(() => {
                if (panelVisible()) { verifyMount(); applyEditorOptgroups(); } else { resetPanelState(); }
            }, 420);
        });
    }

    /* ---------------- 换个版本就自动重载（等效于硬刷新） ---------------- */

    /* 酒馆加载扩展时请求 manifest.json 是不带版本参数的，浏览器会缓存它；
       于是"文件已经更新了，页面还在跑旧版"，非要手动 Ctrl+Shift+R。
       这里在启动时主动取一次 manifest，并且用 cache:'reload' 让这次请求既绕过缓存、
       又把缓存里那份换成新的；版本不一致就提示一下再重载。重载后 manifest 是新的，
       页面自然会按新的 ?ver 去拿 js/css，效果等同于硬刷新。
       防循环：sessionStorage 记住"已经为这个新版本重载过一次"，服务器还没跟上时只重载一次。 */
    const VERSION_RELOAD_KEY = 'wbm-version-reload';
    /* 早期版本自动重载时会在地址上带 ?wbm_reload=时间戳，那个查询串会让酒馆的背景页标签
       把整份页面当远程内容再灌一份进来（见下面对 _isLocal 的说明）。这里负责收尾：
       发现页面上真的出现了重复副本，就把我们自己的参数摘掉、干净地重载一次。 */
    const RELOAD_PARAM = 'wbm_reload';
    const URL_HEAL_KEY = 'wbm-url-heal';

    function extensionManifestUrl() {
        const scripts = document.querySelectorAll('script[src]');
        for (const node of scripts) {
            const src = String(node.src || '');
            if (src.indexOf('WorldbookEnhance') === -1) continue;
            try { return new URL('manifest.json', src).href; } catch (err) { /* 继续找 */ }
        }
        return null;
    }

    /* 正在跑的这个文件是哪个 ?ver —— 与 manifest 里 js 的 ?ver 比，比版本号更细：
       以后小修不改版本号、只改 ?ver 也能被认出来 */
    function loadedScriptStamp() {
        for (const node of document.querySelectorAll('script[src]')) {
            const src = String(node.src || '');
            if (src.indexOf('WorldbookEnhance') === -1) continue;
            try { return new URL(src).searchParams.get('ver') || ''; } catch (err) { /* 继续找 */ }
        }
        return '';
    }

    let lastVersionCheckAt = 0;

    async function checkForNewVersion() {
        /* 后台标签页/手机切后台时不查、更不重载：回来时 visibilitychange 会再触发一次 */
        if (document.visibilityState !== 'visible') return;
        lastVersionCheckAt = Date.now();
        try {
            const url = extensionManifestUrl();
            if (!url) return;
            const res = await fetch(url, { cache: 'reload' });
            if (!res.ok) return;
            const manifest = await res.json();
            const latestVersion = String((manifest && manifest.version) || '').trim();
            let latestStamp = '';
            try { latestStamp = new URL(String(manifest.js || ''), url).searchParams.get('ver') || ''; } catch (err) { /* ignore */ }
            const nowStamp = loadedScriptStamp();
            /* 版本号一致、且 ?ver 也一致 → 已经是最新的 */
            const sameVersion = !latestVersion || latestVersion === VERSION;
            const sameStamp = !latestStamp || !nowStamp || latestStamp === nowStamp;
            if (sameVersion && sameStamp) {
                /* 已经是最新：把上一轮留下的防循环记录清掉，下次更新还能自动重载 */
                try { sessionStorage.removeItem(VERSION_RELOAD_KEY); } catch (err) { /* ignore */ }
                return;
            }
            const target = (latestVersion || VERSION) + (latestStamp ? '#' + latestStamp : '');
            let already = '';
            try { already = String(sessionStorage.getItem(VERSION_RELOAD_KEY) || ''); } catch (err) { /* ignore */ }
            if (already === target) {
                console.warn('[wbm] 已为重载到 ' + target + ' 试过一次，页面仍是 ' + VERSION + '，不再重复（多半是浏览器缓存或服务器还没跟上）');
                return;
            }
            /* 每 10 分钟最多自动重载一次：手机反复切前后台不会变成反复刷新 */
            const RELOAD_AT_KEY = 'wbm-version-reload-at';
            try {
                const lastAt = Number(sessionStorage.getItem(RELOAD_AT_KEY) || 0);
                if (lastAt && Date.now() - lastAt < 10 * 60 * 1000) {
                    console.info('[wbm] 10 分钟内已自动重载过一次，这次只提示不刷新');
                    toast('info', '双端酒馆原生功能优化有新版本，下次刷新后生效');
                    return;
                }
            } catch (err) { /* ignore */ }
            /* 有弹窗/输入框在用时不要打断：等下一次切回或在用户自己刷新时生效 */
            if (document.querySelector('.popup:not(.hidden), .dialogue_popup:not(.hidden)')) {
                console.info('[wbm] 有弹窗打开，暂不自动重载');
                return;
            }
            try { sessionStorage.setItem(VERSION_RELOAD_KEY, target); } catch (err) { /* ignore */ }
            console.info('[wbm] 发现新版本 ' + target + '（当前 ' + VERSION + '），1 秒后重载');
            toast('info', '双端酒馆原生功能优化有新版本，正在重载…');
            setTimeout(async () => {
                /* 关键：先把 manifest 用 cache:'reload' 拉一遍，把浏览器缓存里那份换成新的；
                   只调 location.reload() 的话，页面多半还会拿缓存里的旧 manifest，
                   重载完仍是旧版，而防循环机制不会让我们再试第二次——看着就像"自动重载没生效" */
                try {
                    const murl = extensionManifestUrl();
                    if (murl) await fetch(murl, { cache: 'reload' });
                } catch (err) { /* 预热失败也照常重载 */ }
                try {
                    /* 记录本次自动重载的时间，10 分钟内不再自动重载第二次 */
                    sessionStorage.setItem('wbm-version-reload-at', String(Date.now()));
                } catch (err) { /* ignore */ }
                try {
                    /* 重载地址**不能带查询串**：酒馆的背景页标签用 jQuery UI tabs，
                       它的 _isLocal 判断是「去掉 # 之后的 href === 去掉 # 之后的 location.href」，
                       地址上一旦有 ?xxx=1，本地锚点就会被当成远程标签，于是它把整份页面当成
                       远程内容 ajax 回来、灌进背景标签面板——页面上就多出一整套重复的
                       #top-settings-holder / #world_editor_select / #extensions_settings。
                       后果：所有扩展设置挂进隐藏副本（扩展程序页看着空）、按 id 取到的
                       编辑器下拉是副本（点书名不跳转）、DOM 翻倍后整页变卡。
                       所以只清掉我们自己的参数、不带新参数重载。 */
                    const target2 = new URL(window.location.href);
                    if (target2.searchParams.has(RELOAD_PARAM)) target2.searchParams.delete(RELOAD_PARAM);
                    window.location.replace(target2.href);
                } catch (err) {
                    window.location.reload();
                }
            }, 900);
        } catch (err) {
            /* 取不到 manifest 就照常运行，不打扰读者 */
        }
    }

    /* 手势：完全交给浏览器原生滚动 + 原生链式滚动（overscroll-behavior: auto）。
       曾经试过用 JS 接管（到边界就手动写外层 scrollTop），结果是和原生链式叠加：
       撞顶那一下会跳、脱离边界后的速度也不对。人性化的做法是自己不插手。 */

    /* ---------------- 启动 ---------------- */

    let bootTries = 0;

    /* 地址上带了我们自己的重载参数、而页面上确实多出一整套重复的顶栏 → 干净地重载一次。
       重复副本是从"整份页面被当成远程标签内容"来的，只有换掉那个地址才能真修好；
       同一目标只做一次，避免出事时反复刷新。 */
    function healDuplicatedPage() {
        const dup = document.querySelectorAll('#top-settings-holder').length > 1;
        let url = null;
        try { url = new URL(window.location.href); } catch (err) { url = null; }
        const dirty = !!(url && url.searchParams.has(RELOAD_PARAM));
        if (!dup || !dirty) {
            if (!dup) {
                try { sessionStorage.removeItem(URL_HEAL_KEY); } catch (err) { /* ignore */ }
            }
            return false;
        }
        let already = '';
        try { already = String(sessionStorage.getItem(URL_HEAL_KEY) || ''); } catch (err) { already = ''; }
        if (already === '1') {
            console.warn('[wbm] 地址里还留着 ' + RELOAD_PARAM + '，页面仍有重复副本；请手动刷新一次');
            return false;
        }
        try { sessionStorage.setItem(URL_HEAL_KEY, '1'); } catch (err) { /* ignore */ }
        url.searchParams.delete(RELOAD_PARAM);
        try {
            window.history.replaceState(null, '', url.pathname + url.search + url.hash);
        } catch (err) { /* 拿不到 history 就直接重载 */ }
        console.info('[wbm] 页面出现重复副本（重载地址带着查询串），正在用干净地址重载一次');
        window.location.reload();
        return true;
    }

    function boot() {
        /* 挂载中途任何一步抛错（宿主 DOM 还没齐、接口临时不可用）都不能让整套东西半死不活：
           清掉"已绑定"标记后按退避重试，日志里留下现场，看门狗还会再补一次。 */
        try {
            bootStep();
        } catch (err) {
            console.error('[wbm] 挂载过程出错，已回退并稍后重试：', err);
            const h = hostEl();
            if (h) h.removeAttribute('data-wbm-bound');
            bootTries += 1;
            if (bootTries <= 40) setTimeout(boot, 500);
            else if (bootTries <= 150) setTimeout(boot, 2000);
        }
    }

    function bootStep() {
        if (healDuplicatedPage()) return;
        /* 总开关在设置里已经是「全部关闭」：本次只把设置面板挂回去，其余一律不接管。
           这样关闭状态下界面是货真价实的原生酒馆（1.3.0 修：以前会半接管，
           teardown 还按 [class*="wbm-"] 误删宿主的工具行，世界书面板只剩空壳）。 */
        try {
            if (document.documentElement.getAttribute('data-wbm-booted-off') === '1') return;
            const earlyCfg = ((stCtx() && stCtx().extensionSettings) || {})[SETTINGS_KEY];
            if (earlyCfg && earlyCfg.enhanceEnabled === false) {
                document.documentElement.setAttribute('data-wbm-booted-off', '1');
                document.documentElement.setAttribute('data-wbm-off', '1');
                injectInlineStyles();
                loadStore().then(() => {
                    injectSettingsPanel();
                    syncPanelNotes();
                }).catch(() => {});
                return;
            }
        } catch (err) { /* 拿不到设置就按开启走 */ }
        const host = hostEl();
        if (!host) {
            bootTries += 1;
            /* 面板可能比脚本晚很久才建好：TauriTavern 首启要先走完引导（实测主界面 ready 后扩展才激活），
               安卓 WebView 冷启动也会拖到十几秒。前 20 秒每 0.5 秒找一次，之后每 2 秒一次、总共找 5 分钟，
               期间一直找不到只打一行日志，不静默退出。 */
            if (bootTries <= 40) setTimeout(boot, 500);
            else if (bootTries <= 150) setTimeout(boot, 2000);
            else if (!window.__wbmBootGaveUp) {
                window.__wbmBootGaveUp = true;
                console.warn('[wbm] 5 分钟内没找到世界书面板（#WIMultiSelector），本次不接管；如果是新客户端/自定义界面，请把这一行发给我');
            }
            return;
        }
        if (host.dataset.wbmBound === VERSION) return;
        host.dataset.wbmBound = VERSION;
        host.addEventListener('click', onClick);
        host.addEventListener('input', onInput);
        /* ST 用 jQuery 的 trigger('change') 宣告"世界书列表已填充"，
           而 jQuery trigger 不会触发原生 addEventListener 的监听，
           所以这里必须用 jQuery 委托再绑一次，否则首次 populate 后接管不上。 */
        if (window.jQuery) {
            window.jQuery(document).on('change.wbm', '#world_info, #world_editor_select', onChanged);
        }
        document.addEventListener('change', onChanged, true);
        bindPanelWatcher();
        ensureEditorPicker();
        bindWorldContextEvents();
        ensureBatchBar();
        bindPreviewHook();
        silenceMobileResizeHack();
        bindMessageDblClick();
        bindSwipeCounterTap();
        bindSwipeBulkDelete();
        ensureTalkPresetButton();
        hookPromptManagerExtras();
        bindPromptDetachGuard();
        bindRegexPanelRefresh();
    bindPersonaCacheRefresh();
        bindFrontendCardGuard();
        ensurePersonaBar();
        setTimeout(() => { regexGuardCheck({ silent: true }); }, 4000);
        setTimeout(() => { ensurePersonaBar(); }, 1200);
        hookSwipeLayout();
        bindMsgEditRow();
        /* 横滑提示：窗口尺寸/横竖屏一变就重算一次（只写状态，不重排内容） */
        if (!window.__wbmScrollHintBound) {
            window.__wbmScrollHintBound = true;
            window.addEventListener('resize', scheduleScrollHints, { passive: true });
            window.addEventListener('orientationchange', scheduleScrollHints, { passive: true });
        }
        /* 启动后查一次版本（约 300 字节的请求）；有新版本会提示并重载 */
        setTimeout(checkForNewVersion, 1500);
        /* 弱网兜底：样式表没生效就重试（多一次 <link>，没有轮询、没有性能代价） */
        injectInlineStyles();
        injectInlineStyles();
        injectInlineStyles();
        injectInlineStyles();
        injectInlineStyles();
        setTimeout(ensureStyles, 2500);
        setTimeout(ensureStyles, 6000);
        /* 切回这个标签页时再查一次（60 秒内不重复）：我这边更新完，master 不用手动刷新也能拿到新版 */
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState !== 'visible') return;
            if (Date.now() - lastVersionCheckAt < 60000) return;
            checkForNewVersion();
        });
        /* 收藏存在酒馆本地设置里：读回来之后再刷新一次界面，避免首帧空收藏 */
        loadStore().then(() => {
            state.signature = '';
            render();
            injectPreviewButtons();
            applyEntryFavFilter();
            injectSettingsPanel();
            /* 附加世界书存在设置文件里，桌面端的分组也要用到，开机补一次（一分钟缓存） */
            ensureCharLore().then(() => applyEditorOptgroups());
            /* 读完设置再对齐总开关：上次是「全部关闭」的话，这里立刻退回原生酒馆 */
            applyEnhanceState();
        });
        updateEditorButton();
        /* 预载 ST 的搬运函数；拿不到就不接管「移动/复制」，原生弹窗照旧（fail-safe） */
        loadMoveFn().then((fn) => {
            if (!fn) return;
            moveEntryFn = fn;
            bindMoveEntryHook();
            bindDeleteEntryHook();
        });
        /* 手机端把宿主的原生下拉（排序 / 插入位置 / 关键词逻辑 / 条目状态 等）换成我们的浮层 */
        bindNativeSelectPicker();
        /* 兜底：万一按钮自身的监听被别的东西吃掉，document 委托还能打开 */
        document.addEventListener('click', (event) => {
            const t = event.target;
            if (!(t instanceof Element)) return;
            const btn = t.closest('[data-role="editor-btn"]');
            if (!btn) return;
            event.preventDefault();
            requestEditorPicker();
        });
        render();
        startWatchdog();
    }

    /* 装完不等于装稳：宿主可能在扩展激活之后再把世界书区域重建一次（换用户、切角色、TT 从后台恢复），
       我们的节点跟着丢掉、但本次脚本不会再执行一遍。看门狗每 5 秒复核一次：面板在、我们的列表不在，
       就自己重新挂一次（最多补 120 次 = 10 分钟）。 */
    let watchdogTimer = null;
    let watchdogTries = 0;

    function startWatchdog() {
        if (watchdogTimer) return;
        watchdogTries = 0;
        /* 挂着时每 5 秒只做两次 getElementById，代价可以忽略；面板被重建后能立刻补挂，
           所以这个表不自动停（只在彻底放弃时停）。 */
        watchdogTimer = setInterval(() => {
            const host = hostEl();
            const root = document.getElementById(ROOT_ID);
            /* 宿主会整块重建「扩展程序」抽屉，我们的设置面板跟着没了就点不回来（1.3.56 实测） */
            if (document.getElementById('extensions_settings') && !document.getElementById('wbm-settings')) {
                try { injectSettingsPanel(); } catch (err) { /* 下次再看 */ }
            }
            if (host && root && host.getAttribute('data-wbm-ready') === '1') {
                watchdogTries = 0;
                /* 1.3.44 性能：宿主没重建时这里什么都别做（以前每 5 秒跑一遍
                   syncPromptBar + ensurePromptOrderComplete，等于每 5 秒白扫 200+ 行）。 */
                const barGone = !document.querySelector('#completion_prompt_manager > .wbm-prompt-bar');
                const btnGone = !document.getElementById('wbm-talk-preset-btn');
                if (!barGone && !btnGone) return;
                if (btnGone) ensureTalkPresetButton();
                if (barGone) { hookPromptManagerExtras(); }
                bindPromptDetachGuard();
                return;
            }
            watchdogTries += 1;
            if (watchdogTries > 120) {
                clearInterval(watchdogTimer);
                watchdogTimer = null;
                console.warn('[wbm] 十分钟内未能挂载，已停止重试；界面上若没有我们的按钮，请刷新一次并把这条日志发给我');
                return;
            }
            if (!host) return;
            if (host.dataset.wbmBound === VERSION) host.removeAttribute('data-wbm-bound');
            state.signature = '';
            bootTries = 0;
            boot();
        }, 5000);
    }

    /* 同目录里留了两份时，后加载的那份不另起一套，只催前面那份重新自检 */
    window.__wbmReboot = () => {
        const host = hostEl();
        if (!host) { bootTries = 0; boot(); return; }
        if (host.dataset.wbmBound === VERSION) host.removeAttribute('data-wbm-bound');
        state.signature = '';
        bootTries = 0;
        boot();
        startWatchdog();
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', boot, { once: true });
    } else {
        boot();
    }
})();
