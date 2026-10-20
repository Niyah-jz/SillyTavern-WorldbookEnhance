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

    const VERSION = (window.__wbmBoot && window.__wbmBoot.version) || '1.2.3';
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

    function el(tag, cls, text) {
        const node = document.createElement(tag);
        if (cls) node.className = cls;
        if (text !== undefined) node.textContent = text;
        return node;
    }

    function toast(kind, text) {
        try {
            const api = window.toastr;
            if (api && typeof api[kind] === 'function') {
                api[kind](text, '', { timeOut: kind === 'error' ? 4000 : 1600, preventDuplicates: true });
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
        editBarBothEnds: true,
        enhanceEnabled: true,
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
                store.editBarBothEnds = cfg.editBarBothEnds !== false;
                store.enhanceEnabled = cfg.enhanceEnabled !== false;
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
            cfg.editBarBothEnds = store.editBarBothEnds !== false;
            cfg.enhanceEnabled = store.enhanceEnabled !== false;
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
            if (mask.dataset.closing === '1') return;
            if (immediate === true) { mask.remove(); return; }
            mask.dataset.closing = '1';
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
                const label = String(option.textContent || '').trim();
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
                    /* 原生 change：宿主的排序/位置/逻辑都是靠它落账 */
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

    function makePickerShell() {
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
        ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'touchstart', 'touchend', 'contextmenu', 'wheel']
            .forEach((type) => mask.addEventListener(type, stopPress, { passive: true }));

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
        sheet.style.backdropFilter = 'blur(10px)';
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
        if (vv) {
            vv.addEventListener('resize', follow);
            vv.addEventListener('scroll', follow);
        }
        window.addEventListener('resize', follow);
        window.addEventListener('orientationchange', follow);
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
        label.textContent = '';
        label.appendChild(document.createTextNode(text.slice(0, mid)));
        label.appendChild(document.createElement('br'));
        label.appendChild(document.createTextNode(text.slice(mid)));
        label.style.whiteSpace = 'normal';
        label.style.lineHeight = '1.15';
    }

    function alignEntryHeaders() {
        if (window.matchMedia && window.matchMedia('(max-width: 1000px)').matches) return false;
        const list = document.querySelector('#world_popup_entries_list');
        const header = document.getElementById('WIEntryHeaderTitlesPC');
        if (!list || !header) return false;
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
        header.style.paddingLeft = '0';
        header.style.paddingRight = '0';
        const height = Math.max(headerRect.height, 18);
        header.style.minHeight = height + 'px';
        labels.forEach((label) => {
            label.style.position = 'absolute';
            label.style.top = '0';
            label.style.left = '0px';
            label.style.width = 'auto';
            label.style.transform = 'none';
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
            sheet.appendChild(el('div', 'wbm-picker-title', '全局世界书预设'));
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
            list.addEventListener('click', (event) => {
                const target = event.target;
                if (!(target instanceof Element)) return;
                const moveBtn = target.closest('[data-role="preset-move"]');
                if (moveBtn) {
                    event.preventDefault();
                    event.stopPropagation();
                    /* 换成"分组管理"浮层：那边既能移动，也能给分组改名/删除 */
                    closeEditorPicker();
                    setTimeout(() => openGroupPicker(moveBtn.dataset.id, true), 60);
                    return;
                }
                const renameBtn = target.closest('[data-role="preset-rename-inline"]');
                if (renameBtn) {
                    event.preventDefault();
                    event.stopPropagation();
                    closeEditorPicker();
                    setTimeout(() => openPresetRename(renameBtn.dataset.id), 60);
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
                    closeEditorPicker();
                    presetOverwrite(id);
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
                    closeEditorPicker();
                    presetRemove(id);
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
        /* 我们插进宿主的节点类名一律以 wbm- 开头，按前缀整批收走；
           设置抽屉要留着，否则关掉以后解不开。宿主自己的表单控件只清标记、不删。 */
        document.querySelectorAll('[class*="wbm-"]').forEach((node) => {
            if (node.closest && node.closest('#wbm-settings')) return;
            const tag = node.tagName;
            if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
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
        } else {
            document.documentElement.setAttribute('data-wbm-off', '1');
            teardownInjected();
        }
        applySwipeCounterLayout();
        syncPanelNotes();
    }

    function panelNote(id, text) {
        const node = document.getElementById(id);
        if (node) node.textContent = text;
    }

    function syncPanelNotes() {
        panelNote('wbm-note-enhance', enhancementsOn()
            ? '当前：全部增强生效中。'
            : '当前：已全部关闭，界面就是原生酒馆；下面各开关的状态都保留着，重新勾上即恢复。');
        panelNote('wbm-note-entrylock', clickLockOn()
            ? '已开启：条目内容被锁住，单击改不动；想改就双击那个字段（复选框与下拉也是双击）。'
            : '已关闭：条目内容点一下就能改。');
        panelNote('wbm-note-msgdbl', store.msgDblClickEdit !== false
            ? '已开启：双击消息正文＝点那颗铅笔；思考块与折叠美化块不处理。'
            : '已关闭：双击正文不触发编辑，仍需点铅笔。');
        panelNote('wbm-note-editbar', editBarOn()
            ? '已开启：编辑期间在消息右下角再挂一排同样的按钮，顶部那排照旧，长消息不用往上翻。'
            : '已关闭：只留消息顶部那排原生按钮。');
        panelNote('wbm-note-swipe', store.swipeTakeover !== false
            ? '已接管：页码显示在消息气泡下方正中；手机上点一下页码就能打开备选回复列表，长按也仍然有效。'
            : '已关闭：页码留在美化/酒馆原本的位置，手机上需要长按才打开。');
        const content = document.querySelector('#wbm-settings .inline-drawer-content');
        if (content) content.dataset.wbmIdle = enhancementsOn() ? '0' : '1';
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
                applyEnhanceState();
                toast('info', enhanceBox.checked
                    ? '已开启：全部增强生效'
                    : '已全部关闭：界面回到原生酒馆，各开关状态已保留');
            });
        }
        if (lockBox) {
            lockBox.checked = clickLockOn();
            lockBox.addEventListener('change', () => {
                store.entryClickLock = !!lockBox.checked;
                persistStore();
                lockEntryContents();
                syncLockChip();
                syncPanelNotes();
                toast('info', lockBox.checked
                    ? '已开启：条目单击锁定、双击才改'
                    : '已关闭：条目单击即可编辑');
            });
        }
        if (msgBox) {
            msgBox.checked = store.msgDblClickEdit !== false;
            msgBox.addEventListener('change', () => {
                store.msgDblClickEdit = !!msgBox.checked;
                persistStore();
                syncPanelNotes();
                toast('info', msgBox.checked ? '已开启：双击正文进入编辑' : '已关闭：双击正文不再进入编辑');
            });
        }
        const swipeBox = wrap.querySelector('#wbm-opt-swipe');
        if (swipeBox) {
            swipeBox.checked = store.swipeTakeover !== false;
            swipeBox.addEventListener('change', () => {
                store.swipeTakeover = !!swipeBox.checked;
                persistStore();
                applySwipeCounterLayout();
                syncPanelNotes();
                toast('info', swipeBox.checked
                    ? '已接管页码：点击页码打开备选回复列表（手机上单击即可）'
                    : '已放开页码：回到酒馆原生位置与长按行为');
            });
        }
        if (barBox) {
            barBox.checked = editBarOn();
            barBox.addEventListener('change', () => {
                store.editBarBothEnds = !!barBox.checked;
                persistStore();
                syncBottomRow();
                syncPanelNotes();
                toast('info', barBox.checked
                    ? '已开启：编辑框右下角也有操作栏'
                    : '已关闭：编辑框只保留顶部那排按钮');
            });
        }
        syncPanelNotes();
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
const WBM_CSS = "/* 世界书增强 · 样式 v1.2.0\n   全部限定在 #WIMultiSelector / #wbm-list 之内，不碰全局，避免与鸡尾酒等扩展互相覆盖。\n   原生控件只在 [data-wbm-ready=\"1\"]（自绘列表已成功挂载）时才隐藏，\n   扩展加载失败或上游改版时属性不会写，ST 原生下拉自动保留。 */\n\n#WIMultiSelector[data-wbm-ready=\"1\"] > .range-block-range > select#world_info,\n#WIMultiSelector[data-wbm-ready=\"1\"] .range-block-range > .select2-container {\n    display: none !important;\n}\n\n#wbm-list,\n#wbm-list * { box-sizing: border-box; }\n\n/* ST 原本给 .range-block-range 的是 flex:5（= basis 0%）。这个值有两个坑：\n   ① 加 min-width:0 会让 Chrome 把它算成 0 宽（内容全被挤成一字一行）；\n   ② 保持 min-width:auto 时，长书名的 min-content 会把它撑得比容器还宽，\n      列表溢出到右栏下面、「收起添加」按钮点不到。\n   改成 basis 100% 后宽度严格等于容器宽，两条坑一起没了。 */\n#WIMultiSelector[data-wbm-ready=\"1\"] > .range-block-range {\n    flex: 0 0 100%;\n    min-width: 0;\n}\n\n/* flex 子项默认 min-width:auto，不接受小于内容宽度。世界书名字是 nowrap，\n   长名会把整条链路顶宽、把「收起添加」按钮推出屏幕。整条链都放开 0。\n   注意：不要给 `#WIMultiSelector > .range-block-range` 加 min-width:0 就完事——\n   见上面的注释，光加 min-width:0 会让它塌成 0 宽。 */\n#WIMultiSelector[data-wbm-ready=\"1\"],\n#wbm-list,\n#wbm-list .wbm-header,\n#wbm-list .wbm-actives,\n#wbm-list .wbm-addpanel,\n#wbm-list .wbm-addlist,\n#wbm-list .wbm-row,\n#wbm-list .wbm-addrow {\n    min-width: 0;\n    max-width: 100%;\n}\n\n#wbm-list {\n    display: flex;\n    flex-direction: column;\n    gap: 6px;\n    margin-top: 6px;\n    width: 100%;\n}\n\n/* ---------- 头部 ---------- */\n#wbm-list .wbm-header {\n    display: flex;\n    flex-wrap: wrap;\n    align-items: center;\n    justify-content: space-between;\n    gap: 6px;\n    min-width: 0;\n}\n#wbm-list .wbm-title {\n    flex: 1 1 auto;\n    min-width: 0;\n    font-size: 12px;\n    opacity: .8;\n    overflow: hidden;\n    text-overflow: ellipsis;\n    white-space: nowrap;\n}\n#wbm-list .wbm-add {\n    flex: 0 0 auto;\n    padding: 3px 9px;\n    font-size: 11.5px;\n    line-height: 1.3;\n    white-space: nowrap;\n    border: 1px solid var(--SmartThemeBorderColor, #666);\n    background: transparent;\n    color: inherit;\n    border-radius: 999px;\n    cursor: pointer;\n}\n\n/* ---------- 搜索框 ---------- */\n#wbm-list .wbm-search {\n    width: 100%;\n    padding: 6px 10px;\n    font-size: 13px;\n    border-radius: 8px;\n    border: 1px solid var(--SmartThemeBorderColor, rgba(255, 255, 255, .15));\n    background: var(--black30a, rgba(0, 0, 0, .2));\n    color: inherit;\n    outline: none;\n}\n\n/* ---------- 提示 ---------- */\n#wbm-list .wbm-tip { font-size: 11px; opacity: .5; }\n\n/* ---------- 已启用列表：折叠是 5 行高的滑动窗，展开是 15 行 ---------- */\n#wbm-list .wbm-actives {\n    display: flex;\n    flex-direction: column;\n    gap: 5px;\n    max-height: calc(33px * 5 + 5px * 4);\n    overflow-y: auto;\n    overflow-x: hidden;\n    /* 不给 contain：列表滑到尽头（或本身不够滑）时，余下的手势要继续交给外层世界书面板，\n       否则收起态只有 5 行高、滑条行程极短，手指在里面划就是\"划不动\"的感觉 */\n    overscroll-behavior: auto;\n    /* 把重排限制在列表内部：键盘收起触发整页重排时，外部不必重算每一行 */\n    contain: content;\n}\n#wbm-list.expanded .wbm-actives,\n#wbm-list.searching .wbm-actives {\n    max-height: calc(33px * 15 + 5px * 14);\n}\n#wbm-list .wbm-row {\n    display: flex;\n    align-items: center;\n    gap: 6px;\n    padding: 6px 10px;\n    min-height: 33px;\n    border-radius: 9px;\n    background: var(--SmartThemeBlurTintColor, rgba(255, 255, 255, .06));\n    border: 1px solid var(--SmartThemeBorderColor, rgba(255, 255, 255, .15));\n    cursor: pointer;\n}\n#wbm-list .wbm-row.editing { border-color: var(--SmartThemeQuoteColor, #c9a86a); }\n#wbm-list .wbm-row.confirming { border-color: #c0392b; }\n#wbm-list .wbm-name {\n    flex: 1 1 auto;\n    min-width: 0;\n    overflow: hidden;\n    text-overflow: ellipsis;\n    white-space: nowrap;\n    font-size: 14px;\n}\n#wbm-list .wbm-hint { flex: 0 0 auto; font-size: 11px; opacity: .55; }\n#wbm-list .wbm-kill {\n    flex: 0 0 auto;\n    padding: 2px 8px;\n    font-size: 12px;\n    border: 1px solid var(--SmartThemeBorderColor, #666);\n    background: transparent;\n    color: inherit;\n    border-radius: 999px;\n    cursor: pointer;\n}\n#wbm-list .wbm-row.confirming .wbm-kill { border-color: #c0392b; color: #e74c3c; }\n\n/* ---------- 展开 / 收起 ---------- */\n#wbm-list .wbm-more {\n    align-self: center;\n    padding: 4px 14px;\n    font-size: 12px;\n    opacity: .85;\n    border: 1px solid var(--SmartThemeBorderColor, #666);\n    background: transparent;\n    color: inherit;\n    border-radius: 999px;\n    cursor: pointer;\n}\n\n/* ---------- 添加面板 ---------- */\n/* 与已启用列表同一款式：不套外框，直接是搜索框 + 同形制的行，右边自然对齐 */\n#wbm-list .wbm-addpanel {\n    display: flex;\n    flex-direction: column;\n    gap: 6px;\n    padding: 0;\n    border: none;\n    background: none;\n    border-radius: 0;\n}\n#wbm-list .wbm-addlist {\n    display: flex;\n    flex-direction: column;\n    gap: 4px;\n    /* 固定像素高度：vh 会随手机键盘弹出而变，一变小一变大就是两次整页重排 */\n    max-height: 280px;\n    overflow-y: auto;\n    overflow-x: hidden;\n    /* 同上：到底后把余下的滑动交还给面板 */\n    overscroll-behavior: auto;\n    contain: content;\n}\n#wbm-list .wbm-addrow {\n    display: flex;\n    align-items: center;\n    gap: 8px;\n    padding: 6px 10px;\n    min-height: 33px;\n    border-radius: 9px;\n    border: 1px solid var(--SmartThemeBorderColor, rgba(255, 255, 255, .15));\n    background: var(--SmartThemeBlurTintColor, rgba(255, 255, 255, .06));\n    cursor: pointer;\n}\n#wbm-list .wbm-addrow:hover { background: rgba(255, 255, 255, .05); }\n#wbm-list .wbm-addrow.on {\n    border-color: rgba(120, 200, 140, .6);\n    background: rgba(120, 200, 140, .12);\n}\n#wbm-list .wbm-addname {\n    flex: 1 1 auto;\n    min-width: 0;\n    overflow: hidden;\n    text-overflow: ellipsis;\n    white-space: nowrap;\n    font-size: 14px;\n}\n#wbm-list .wbm-addmark { flex: 0 0 auto; font-size: 12px; opacity: .75; }\n#wbm-list .wbm-addrow.on .wbm-addmark { color: #7ec890; opacity: 1; }\n#wbm-list .wbm-none,\n#wbm-list .wbm-empty { font-size: 12px; opacity: .6; padding: 4px 2px; }\n\n@media (max-width: 1000px) {\n    /* 手机上让世界书区独占一整行，避免被左侧栏挤到溢出（只在已接管时生效） */\n    #WIMultiSelector[data-wbm-ready=\"1\"] { flex: 1 1 100% !important; width: 100% !important; }\n    /* 自绘列表的头部已经写明\"已启用 N 本\"，ST 那行提示可省 */\n    #WIMultiSelector[data-wbm-ready=\"1\"] > .range-block-title { display: none; }\n    #wbm-list .wbm-addlist { max-height: 260px; }\n    /* 整块列表区左右各留 12px：让头部、搜索框、已启用列表、添加面板、展开按钮\n       一起缩进（视觉对齐），留白不属于任何滚动容器，手指落在上面就是拖整个面板。 */\n    #wbm-list { padding: 0 12px; }\n    /* 「全局世界书激活设置」那一栏：常态就占满整行，不要点开之后才变宽 */\n    #WorldInfo .range-block > .inline-drawer { width: 100%; flex: 1 1 100%; min-width: 0; }\n    #WorldInfo .range-block > .inline-drawer > .inline-drawer-header { width: 100%; box-sizing: border-box; }\n}\n\n/* ---------- 「选择以编辑」：手机端用仿原生的全屏列表 + 顶部搜索 ---------- */\n.wbm-editor-wrap { display: none; }\n\n@media (max-width: 1000px) {\n    #world_editor_select { display: none !important; }\n    /* 酒馆给这个下拉套出来的 select2 替身必须一起藏：只藏了原生 select 的话，\n       窄屏上会出现\"两个选择器\"并排抢宽度，书名一长就把右边的分类图标挤出行外。 */\n    #world_popup .wbm-world-row .select2-container { display: none !important; }\n\n    .wbm-editor-wrap {\n        display: block;\n        flex: 1 1 auto;\n        min-width: 0;\n        width: auto;\n    }\n    .wbm-editor-btn {\n        display: block;\n        width: 100%;\n        min-width: 110px;\n        padding: 6px 10px;\n        font-size: 13px;\n        text-align: center;\n        border-radius: 8px;\n        border: 1px solid var(--SmartThemeBorderColor, #666);\n        background: var(--black30a, rgba(0, 0, 0, .2));\n        color: inherit;\n        cursor: pointer;\n        white-space: nowrap;\n        overflow: hidden;\n        text-overflow: ellipsis;\n        position: relative;\n        z-index: 1;\n    }\n    .wbm-editor-btn.active { border-color: var(--SmartThemeQuoteColor, #c9a86a); }\n}\n\n/* 全屏选择器：外观贴 ST 原生弹窗 + 手机原生 sheet 的手势暗示，只为在顶部加一条实时搜索。\n   全部为静态样式与一次性动画，没有滚动监听也没有常驻 rAF。 */\n.wbm-picker {\n    position: fixed;\n    inset: 0;\n    z-index: 2147483000;\n    display: flex;\n    /* 垂直居中（原来是 flex-end 贴底）：手机键盘弹起时，贴底的窗口会被输入法整块盖住；\n       居中的话窗口主体落在屏幕中段，输入框和列表都还在可视范围里。 */\n    align-items: center;\n    justify-content: center;\n    background: rgba(0, 0, 0, .6);\n    animation: wbm-mask-in .14s ease-out both;\n}\n.wbm-picker.closing { animation: wbm-mask-out .16s ease-in both; }\n\n.wbm-picker-sheet {\n    display: flex;\n    flex-direction: column;\n    width: 100%;\n    max-width: 760px;\n    /* dvh 随键盘变化，键盘弹起时窗口自己变矮；720px 是桌面上的上限，免得窗口过大 */\n    max-height: min(82dvh, 720px);\n    margin: 8px;\n    border-radius: 16px;\n    border: 1px solid var(--SmartThemeBorderColor, #444);\n    background: var(--SmartThemeBlurTintColor, #1c1c26);\n    /* 顶沿一道极淡高光，面板才不像一块贴上去的灰板 */\n    box-shadow: 0 -2px 30px rgba(0, 0, 0, .5), inset 0 1px 0 rgba(255, 255, 255, .07);\n    padding-bottom: max(8px, env(safe-area-inset-bottom, 0px));\n    overflow: hidden;\n    animation: wbm-sheet-in .18s cubic-bezier(.2, .8, .2, 1) both;\n}\n.wbm-picker.closing .wbm-picker-sheet { animation: wbm-sheet-out .16s ease-in both; }\n\n/* 抓握条：暗示这是从底部升起、可下滑收起的面板 */\n.wbm-picker-grip {\n    flex: 0 0 auto;\n    width: 36px;\n    height: 4px;\n    margin: 8px auto 0;\n    border-radius: 999px;\n    background: var(--SmartThemeBorderColor, rgba(255, 255, 255, .3));\n    opacity: .8;\n}\n\n.wbm-picker-head {\n    display: flex;\n    align-items: center;\n    gap: 6px;\n    padding: 8px 10px 10px;\n    border-bottom: 1px solid var(--SmartThemeBorderColor, rgba(128, 128, 128, .3));\n}\n\n/* 搜索胶囊：视觉重心给它，ST 的 .text_pole 方框不再参与 */\n.wbm-picker-field {\n    display: flex;\n    align-items: center;\n    gap: 8px;\n    flex: 1 1 auto;\n    min-width: 0;\n    height: 42px;\n    padding: 0 14px;\n    border-radius: 999px;\n    border: 1px solid var(--SmartThemeBorderColor, rgba(255, 255, 255, .16));\n    background: rgba(128, 128, 128, .22);\n    background: color-mix(in srgb, var(--SmartThemeBodyColor, #ccc) 8%, transparent);\n    transition: border-color .15s ease;\n}\n.wbm-picker-field:focus-within { border-color: var(--SmartThemeQuoteColor, #c9a86a); }\n.wbm-picker-icon {\n    flex: 0 0 auto;\n    width: 16px;\n    font-size: 13px;\n    text-align: center;\n    opacity: .6;\n}\n.wbm-picker-search {\n    flex: 1 1 auto;\n    min-width: 0;\n    width: auto;\n    height: 100%;\n    margin: 0;\n    padding: 0;\n    border: none;\n    border-radius: 0;\n    background: transparent;\n    box-shadow: none;\n    outline: none;\n    color: inherit;\n    caret-color: var(--SmartThemeQuoteColor, currentColor);\n    font-family: inherit;\n    font-size: 15px;\n}\n.wbm-picker-search::-webkit-search-cancel-button,\n.wbm-picker-search::-webkit-search-decoration { -webkit-appearance: none; appearance: none; }\n.wbm-picker-search::placeholder { color: inherit; opacity: .45; }\n\n/* ✕ 只做幽灵按钮，不跟搜索抢视觉；按下去才有底色 */\n.wbm-picker-close {\n    flex: 0 0 auto;\n    width: 38px;\n    height: 38px;\n    padding: 0;\n    border: none;\n    border-radius: 11px;\n    background: transparent;\n    color: inherit;\n    font-size: 15px;\n    line-height: 1;\n    opacity: .7;\n    cursor: pointer;\n}\n.wbm-picker-close:active {\n    background: rgba(128, 128, 128, .28);\n    background: color-mix(in srgb, var(--SmartThemeBodyColor, #ccc) 16%, transparent);\n    opacity: 1;\n}\n\n.wbm-picker-list {\n    flex: 1 1 auto;\n    min-height: 0;\n    overflow-y: auto;\n    overflow-x: hidden;\n    overscroll-behavior: contain;\n    padding: 6px 8px 10px;\n    /* 上下渐隐，一眼看出还能继续滚；纯 CSS，没有滚动监听 */\n    -webkit-mask-image: linear-gradient(to bottom, transparent 0, #000 4px, #000 calc(100% - 8px), transparent 100%);\n    mask-image: linear-gradient(to bottom, transparent 0, #000 4px, #000 calc(100% - 8px), transparent 100%);\n}\n\n/* 行改成内缩的圆角块：选中行才浮主题色底，其余只在按下时给反馈 */\n.wbm-picker-row {\n    display: flex;\n    align-items: center;\n    gap: 10px;\n    min-height: 48px;\n    margin: 2px 0;\n    padding: 0 12px;\n    border-radius: 10px;\n    font-size: 16px;\n    cursor: pointer;\n    transition: background-color .12s ease;\n}\n.wbm-picker-row:active {\n    background: rgba(128, 128, 128, .18);\n    background: color-mix(in srgb, var(--SmartThemeBodyColor, #ccc) 12%, transparent);\n}\n.wbm-picker-row.active {\n    background: rgba(128, 128, 128, .16);\n    background: color-mix(in srgb, var(--SmartThemeQuoteColor, #c9a86a) 16%, transparent);\n    /* 左沿一道主题色细条：比纯底色更容易一眼认出\"当前编辑的是这本\" */\n    box-shadow: inset 3px 0 0 var(--SmartThemeQuoteColor, #c9a86a);\n}\n.wbm-picker-row.active .wbm-picker-name { font-weight: 600; }\n.wbm-picker-exit { min-height: 44px; font-size: 15px; opacity: .72; }\n\n/* 分栏标题：粘在列表顶端，长名单滚下去也知道自己在哪一组。\n   底色跟面板本体取同一个变量，滚动时不会透出下面的行。 */\n.wbm-picker-group {\n    position: sticky;\n    top: 0;\n    z-index: 1;\n    display: flex;\n    align-items: baseline;\n    gap: 8px;\n    margin: 6px 0 2px;\n    padding: 8px 12px 6px;\n    background: var(--SmartThemeBlurTintColor, #1c1c26);\n}\n\n.wbm-picker-group-title {\n    color: var(--SmartThemeQuoteColor, inherit);\n    font-size: 13px;\n    letter-spacing: .4px;\n    opacity: .9;\n}\n\n.wbm-picker-group-count {\n    font-size: 12px;\n    opacity: .55;\n}\n\n/* 悬浮窗的标题行（世界书分类用；「选择以编辑」不显示，保持原样） */\n.wbm-picker-title {\n    flex: 0 0 auto;\n    padding: 2px 18px 8px;\n    font-size: 15px;\n    font-weight: 600;\n    letter-spacing: .3px;\n    color: var(--SmartThemeQuoteColor, inherit);\n}\n\n/* 「世界书分类」入口：一枚图标，紧跟在「选择以编辑」右侧（两者都是\"挑一本书\"）。\n   尺寸按手指能点中来做，不靠缩小换空间。 */\n.wbm-cat-btn {\n    flex: 0 0 auto;\n    display: inline-flex;\n    align-items: center;\n    justify-content: center;\n    width: 34px;\n    height: 32px;\n    margin: 0;\n    padding: 0;\n    border-radius: 8px;\n    border: 1px solid var(--SmartThemeBorderColor, #666);\n    background: rgba(128, 128, 128, .08);\n    background: color-mix(in srgb, var(--SmartThemeBodyColor, #ccc) 8%, transparent);\n    color: inherit;\n    cursor: pointer;\n}\n\n.wbm-cat-btn:hover {\n    border-color: var(--SmartThemeQuoteColor, #c9a86a);\n}\n\n.wbm-cat-btn .fa-solid {\n    font-size: 14px;\n    line-height: 1;\n}\n\n/* 手机端用来把「世界书选择」那排折成两排的零高节点；桌面不需要，常态关掉 */\n.wbm-rowbreak { display: none; }\n\n/* ---------- 全局启用预设：世界书面板里「Active World(s)」下面的一行 ---------- */\n.wbm-preset-row {\n    display: flex;\n    flex-wrap: wrap;\n    align-items: center;\n    gap: 6px;\n    width: 100%;\n    margin-top: 6px;\n}\n\n.wbm-preset-row .wbm-favbar-label { flex: 0 0 auto; }\n\n/* 看起来像下拉的按钮：点开是我们自己的浮层（原生 select 改不了选项字体） */\n.wbm-preset-btn {\n    flex: 1 1 8em;\n    min-width: 0;\n    height: 30px;\n    padding: 0 8px;\n    display: flex;\n    align-items: center;\n    gap: 6px;\n    font-family: inherit;\n    font-size: 12px;\n    border-radius: 6px;\n    text-align: left;\n}\n\n.wbm-preset-btn-text {\n    flex: 1 1 auto;\n    min-width: 0;\n    overflow: hidden;\n    text-overflow: ellipsis;\n    white-space: nowrap;\n}\n\n.wbm-preset-caret {\n    flex: 0 0 auto;\n    width: 0;\n    height: 0;\n    border-left: 4px solid transparent;\n    border-right: 4px solid transparent;\n    border-top: 5px solid currentColor;\n    opacity: .7;\n}\n\n/* 预设浮层里每行右侧的本数：等宽小字，跟名字拉开层级 */\n.wbm-picker-count {\n    flex: 0 0 auto;\n    margin-left: auto;\n    padding-left: 8px;\n    font-family: ui-monospace, \"Cascadia Mono\", Consolas, \"Courier New\", monospace;\n    font-size: 11px;\n    letter-spacing: .5px;\n    opacity: .7;\n    white-space: nowrap;\n}\n\n/* 预设行：本数直接顶到最右（不再让单选圈占住右边），\n   当前那套靠整行高亮 + 名字加粗区分 */\n.wbm-preset-opt .wbm-picker-name { flex: 1 1 auto; }\n\n/* 预设行里键多（分组/改名/覆盖/删除），窄屏允许折一行 */\n.wbm-preset-opt {\n    flex-wrap: wrap;\n    row-gap: 4px;\n}\n\n.wbm-preset-opt .wbm-picker-radio { display: none; }\n\n/* 四个小键的容器：电脑端仍排在名字右边，本数照旧顶到最右 */\n.wbm-preset-opt .wbm-preset-tools {\n    display: flex;\n    align-items: center;\n    gap: 6px;\n    flex: 0 0 auto;\n    margin-left: 8px;\n}\n\n.wbm-preset-opt .wbm-preset-tools .wbm-preset-tool { margin-left: 0; }\n\n/* 手机端：名字与「N 本」在第二行，四个小键整格挪到下方靠右。\n   之前四个键挤在名字右边（合计两百多像素），长名字只剩几十像素、全被省略号吃掉。 */\n@media (max-width: 760px), (max-width: 1100px) and (max-height: 520px), (max-width: 1100px) and (pointer: coarse) {\n    .wbm-preset-opt { padding-top: 7px; padding-bottom: 7px; }\n    .wbm-preset-opt .wbm-picker-name { order: 1; }\n    .wbm-preset-opt .wbm-picker-count { order: 2; }\n    .wbm-preset-opt .wbm-preset-tools {\n        order: 3;\n        flex: 0 0 100%;\n        justify-content: flex-end;\n        margin: 2px 0 0;\n    }\n}\n\n.wbm-preset-opt.active .wbm-picker-name::before {\n    content: \"✓ \";\n    color: var(--SmartThemeQuoteColor, inherit);\n}\n\n.wbm-preset-save {\n    flex: 0 0 auto;\n    height: 30px;\n    padding: 0 11px;\n    border-radius: 999px;\n    font-size: 12px;\n    line-height: 1;\n}\n\n/* 存名字的小行：留空就用\"预设N\"，所以占位提示里写的就是那个默认名 */\n.wbm-preset-saverow {\n    display: flex;\n    flex-wrap: wrap;\n    align-items: center;\n    gap: 6px;\n    width: 100%;\n}\n\n.wbm-preset-saverow[hidden] { display: none; }\n\n.wbm-preset-name {\n    flex: 1 1 8em;\n    min-width: 0;\n    height: 30px;\n    font-family: inherit;\n    font-size: 13px;\n}\n\n/* ---------- 预设管理（在分类面板里）：一项一张卡片，项与项之间留白 ---------- */\n.wbm-preset-sect { padding-top: 10px; }\n\n.wbm-preset-list {\n    display: flex;\n    flex-direction: column;\n    gap: 6px;\n    padding: 6px 14px 0;\n}\n\n.wbm-preset-item {\n    display: flex;\n    flex-direction: column;\n    gap: 6px;\n    padding: 8px;\n    border-radius: 9px;\n    border: 1px solid var(--SmartThemeBorderColor, rgba(128, 128, 128, .45));\n    background: rgba(128, 128, 128, .08);\n    background: color-mix(in srgb, var(--SmartThemeBodyColor, #ccc) 6%, transparent);\n}\n\n/* 第一行：名字占满左侧，本数顶到最右；第二行按键右对齐 */\n.wbm-preset-item-line {\n    display: flex;\n    align-items: baseline;\n    gap: 8px;\n    width: 100%;\n}\n\n.wbm-preset-item-name {\n    flex: 1 1 auto;\n    min-width: 0;\n    font-size: 13px;\n    overflow: hidden;\n    text-overflow: ellipsis;\n    white-space: nowrap;\n}\n\n.wbm-preset-item-name.on {\n    color: var(--SmartThemeQuoteColor, inherit);\n    font-weight: 600;\n}\n\n.wbm-preset-item-count {\n    flex: 0 0 auto;\n    margin-left: auto;\n    font-family: ui-monospace, \"Cascadia Mono\", Consolas, \"Courier New\", monospace;\n    font-size: 11px;\n    letter-spacing: .5px;\n    opacity: .72;\n    white-space: nowrap;\n}\n\n.wbm-preset-actions {\n    display: flex;\n    flex-wrap: wrap;\n    gap: 6px;\n    justify-content: flex-end;\n    width: 100%;\n}\n\n.wbm-preset-item .wbm-chip {\n    flex: 0 0 auto;\n    height: 30px;\n    padding: 0 10px;\n    border-radius: 999px;\n    font-size: 12px;\n    line-height: 1;\n}\n\n.wbm-preset-item .wbm-chip.danger {\n    color: var(--SmartThemeEmColor, #d08a8a);\n    border-color: var(--SmartThemeEmColor, rgba(208, 138, 138, .6));\n}\n\n.wbm-preset-item .wbm-preset-name { flex: 1 1 6em; }\n\n/* ---- 预设分组：组名一行（名字 + 几套 + 改名/删除），下面是该组的预设卡片 ---- */\n.wbm-preset-group-head {\n    display: flex;\n    align-items: center;\n    flex-wrap: wrap;\n    gap: 8px;\n    margin: 8px 0 2px;\n    padding: 4px 2px 4px 6px;\n    border-left: 2px solid var(--SmartThemeBorderColor, rgba(128, 128, 128, .45));\n}\n\n.wbm-preset-group-name {\n    flex: 1 1 auto;\n    min-width: 0;\n    overflow: hidden;\n    text-overflow: ellipsis;\n    white-space: nowrap;\n    font-size: 13px;\n    font-weight: 600;\n    color: var(--SmartThemeQuoteColor, inherit);\n}\n\n.wbm-preset-group-count {\n    flex: 0 0 auto;\n    font-family: ui-monospace, \"Cascadia Mono\", Consolas, \"Courier New\", monospace;\n    font-size: 11px;\n    letter-spacing: .5px;\n    opacity: .7;\n    white-space: nowrap;\n}\n\n.wbm-preset-group-actions {\n    flex: 0 0 auto;\n    display: flex;\n    gap: 4px;\n}\n\n.wbm-preset-group-actions .wbm-chip {\n    height: 26px;\n    padding: 0 9px;\n    border-radius: 999px;\n    font-size: 11px;\n    line-height: 1;\n}\n\n.wbm-group-rename-input {\n    flex: 1 1 100%;\n    margin: 2px 0 4px;\n}\n\n.wbm-preset-group-actions .wbm-chip.danger {\n    color: var(--SmartThemeEmColor, #d08a8a);\n    border-color: var(--SmartThemeEmColor, rgba(208, 138, 138, .6));\n}\n\n/* 浮层里的分组小标题（不可点） */\n.wbm-picker-group-label {\n    padding: 10px 14px 4px;\n    font-size: 12px;\n    font-weight: 600;\n    color: var(--SmartThemeQuoteColor, inherit);\n    opacity: .85;\n}\n\n/* 浮层里每套预设右侧的小键：分组 / 删除（删除第一下变「确认」） */\n.wbm-preset-tool {\n    flex: 0 0 auto;\n    margin-left: 8px;\n    padding: 3px 9px;\n    border-radius: 999px;\n    border: 1px solid var(--SmartThemeBorderColor, rgba(128, 128, 128, .45));\n    background: transparent;\n    color: var(--SmartThemeBodyColor, inherit);\n    font-family: inherit;\n    font-size: 12px;\n    line-height: 1.2;\n    cursor: pointer;\n}\n\n.wbm-preset-tool.armed {\n    border-color: var(--SmartThemeEmColor, rgba(208, 138, 138, .7));\n    color: var(--SmartThemeEmColor, #d08a8a);\n    font-weight: 600;\n}\n\n/* 分组管理区（分组浮层里的组名行，可改名 / 删除） */\n.wbm-group-mgmt {\n    padding: 4px 14px 2px;\n}\n\n.wbm-group-mgmt-row {\n    display: flex;\n    align-items: center;\n    flex-wrap: wrap;\n    gap: 8px;\n    padding: 6px 8px;\n    margin-bottom: 6px;\n    border-radius: 8px;\n    border: 1px solid var(--SmartThemeBorderColor, rgba(128, 128, 128, .4));\n    background: rgba(128, 128, 128, .08);\n    background: color-mix(in srgb, var(--SmartThemeBodyColor, #ccc) 6%, transparent);\n}\n\n.wbm-group-mgmt-name {\n    flex: 1 1 auto;\n    min-width: 0;\n    font-size: 13px;\n    overflow: hidden;\n    text-overflow: ellipsis;\n    white-space: nowrap;\n}\n\n.wbm-group-mgmt-tools {\n    flex: 0 0 auto;\n    display: flex;\n    gap: 6px;\n}\n\n.wbm-name-input-inline {\n    width: 100%;\n    height: 30px;\n    font-size: 13px;\n}\n\n/* 分类面板里显示这套预设属于哪一组（只做提示，不给操作） */\n.wbm-preset-item-group {\n    flex: 0 0 auto;\n    font-size: 11px;\n    opacity: .65;\n    white-space: nowrap;\n}\n\n/* 新建分组那一行（浮层底部） */\n.wbm-group-new {\n    padding: 8px 14px 12px;\n    border-top: 1px solid var(--SmartThemeBorderColor, rgba(128, 128, 128, .35));\n}\n\n\n/* 可横滑的条：右端渐隐，告诉手指右边还有东西；滑到底（data-xh=\"end\"）渐隐自动消失。\n   状态由 JS 写在 data-xh 上，滚动时才写，没有常驻开销。 */\n.wbm-batch-bar[data-xh=\"start\"],\n.wbm-batch-bar[data-xh=\"mid\"],\n.wbm-entry-favbar[data-xh=\"start\"],\n.wbm-entry-favbar[data-xh=\"mid\"],\n.wbm-favbar[data-xh=\"start\"],\n.wbm-favbar[data-xh=\"mid\"] {\n    -webkit-mask-image: linear-gradient(to right, #000 calc(100% - 40px), rgba(0, 0, 0, 0));\n    mask-image: linear-gradient(to right, #000 calc(100% - 40px), rgba(0, 0, 0, 0));\n}\n\n/* 电脑端：「选择以编辑」是酒馆自己的 select2，分组靠 <optgroup> 传下去，\n   这里只给它的分组标题上主题色，让它和手机端的分栏长得一样 */\n/* ---------- 世界书分类面板：两段（绑定中 / 未绑定）+ 小组行 ---------- */\n.wbm-cat-sect {\n    padding: 2px 0 10px;\n}\n\n.wbm-cat-sect + .wbm-cat-sect {\n    border-top: 1px solid var(--SmartThemeBorderColor, rgba(128, 128, 128, .35));\n    padding-top: 10px;\n}\n\n.wbm-cat-sect-head {\n    display: flex;\n    align-items: baseline;\n    gap: 8px;\n    padding: 6px 14px 4px;\n}\n\n.wbm-cat-sect-title {\n    font-size: 13px;\n    letter-spacing: .5px;\n    color: var(--SmartThemeQuoteColor, inherit);\n}\n\n/* 分类面板顶部的搜索条：输入框 + 两个模式键 */\n.wbm-cat-search {\n    display: flex;\n    align-items: center;\n    gap: 6px;\n    padding: 0 12px 8px;\n    flex-wrap: nowrap;\n}\n\n.wbm-cat-input {\n    flex: 1 1 auto;\n    min-width: 0;\n    height: 32px;\n}\n\n.wbm-cat-search .wbm-chip-sm {\n    flex: 0 0 auto;\n    height: 32px;\n}\n\n/* 归属排法说明：一行小灰字，让用户不用猜\"这本书为什么不在全局那组\" */\n.wbm-cat-note {\n    padding: 0 14px 8px;\n    font-size: 11.5px;\n    line-height: 1.5;\n    opacity: .62;\n}\n\n/* 还没扫描时的提醒：换成强调色，和普通说明区分开 */\n.wbm-cat-note.wbm-cat-warn {\n    opacity: .95;\n    color: var(--SmartThemeEmColor, #e1ecaa);\n}\n\n.wbm-cat-group {\n    margin: 0 6px;\n    border-radius: 8px;\n}\n\n.wbm-cat-group-head {\n    display: flex;\n    align-items: center;\n    gap: 8px;\n    padding: 9px 10px;\n    border-radius: 8px;\n    cursor: pointer;\n}\n\n.wbm-cat-group-head:hover {\n    background: rgba(128, 128, 128, .10);\n    background: color-mix(in srgb, var(--SmartThemeBodyColor, #ccc) 7%, transparent);\n}\n\n.wbm-cat-group-head.open {\n    background: rgba(128, 128, 128, .14);\n    background: color-mix(in srgb, var(--SmartThemeBodyColor, #ccc) 10%, transparent);\n}\n\n.wbm-cat-caret {\n    flex: 0 0 auto;\n    width: 12px;\n    font-size: 11px;\n    opacity: .7;\n}\n\n.wbm-cat-group-title {\n    flex: 1 1 auto;\n    min-width: 0;\n    overflow: hidden;\n    text-overflow: ellipsis;\n    white-space: nowrap;\n    font-size: 14px;\n}\n\n/* 交叉提示：一句话，不落在每一行上 */\n.wbm-cat-cross {\n    flex: 0 0 auto;\n    font-size: 11px;\n    opacity: .62;\n}\n\n.wbm-cat-scanhint {\n    flex: 0 0 auto;\n    font-size: 11px;\n    color: var(--SmartThemeQuoteColor, inherit);\n    opacity: .9;\n}\n\n/* 组内滚动：展开一组时只在这块里滚，别的组不被推走 */\n.wbm-cat-books {\n    max-height: 60vh;\n    overflow-y: auto;\n    overscroll-behavior-y: contain;\n    padding: 2px 0 6px;\n}\n\n/* 交叉标记：零文字的圆点，悬停才说明 */\n.wbm-cat-dot {\n    flex: 0 0 auto;\n    width: 6px;\n    height: 6px;\n    margin-right: 8px;\n    border-radius: 50%;\n    background: var(--SmartThemeQuoteColor, rgba(200, 170, 110, .9));\n    opacity: .85;\n}\n\n.wbm-cat-check {\n    flex: 0 0 auto;\n    width: 18px;\n    height: 18px;\n    margin: 0 2px 0 8px;\n    accent-color: var(--SmartThemeQuoteColor, #c9a86a);\n}\n\n.wbm-cat-scanbar {\n    display: flex;\n    align-items: center;\n    gap: 8px;\n    flex-wrap: wrap;\n    padding: 2px 12px 8px;\n}\n\n.wbm-cat-scanstate {\n    flex: 1 1 140px;\n    min-width: 0;\n    font-size: 12px;\n    line-height: 1.5;\n    opacity: .75;\n}\n\n.wbm-cat-delbar {\n    display: flex;\n    align-items: center;\n    gap: 6px;\n    flex-wrap: wrap;\n    padding: 8px 12px 10px;\n    border-top: 1px dashed var(--SmartThemeBorderColor, rgba(128, 128, 128, .45));\n}\n\n.wbm-cat-del-label {\n    flex: 1 1 100%;\n    font-size: 12px;\n    line-height: 1.5;\n    opacity: .85;\n}\n\n.select2-results__group,\n.select2-results__option--group {\n    color: var(--SmartThemeQuoteColor, inherit);\n    background: transparent;\n    font-size: .82em;\n    font-weight: 600;\n    letter-spacing: .3px;\n    padding: 6px 8px 2px;\n    cursor: default;\n}\n\n.wbm-picker-name {\n    flex: 1 1 auto;\n    min-width: 0;\n    overflow: hidden;\n    text-overflow: ellipsis;\n    white-space: nowrap;\n}\n\n/* 圆环 → 选中时填主题色并打勾 */\n.wbm-picker-radio {\n    position: relative;\n    flex: 0 0 auto;\n    width: 20px;\n    height: 20px;\n    border-radius: 50%;\n    border: 2px solid var(--SmartThemeBorderColor, rgba(170, 170, 170, .9));\n    box-sizing: border-box;\n    transition: background-color .12s ease, border-color .12s ease;\n}\n.wbm-picker-row.active .wbm-picker-radio {\n    border-color: var(--SmartThemeQuoteColor, #d4b06a);\n    background: var(--SmartThemeQuoteColor, #d4b06a);\n}\n.wbm-picker-row.active .wbm-picker-radio::after {\n    content: '';\n    position: absolute;\n    left: 50%;\n    top: 50%;\n    width: 5px;\n    height: 9px;\n    border: solid var(--SmartThemeBlurTintColor, #1c1c26);\n    border-width: 0 2px 2px 0;\n    box-sizing: border-box;\n    transform: translate(-50%, -58%) rotate(42deg);\n}\n\n.wbm-picker-empty {\n    padding: 26px 12px;\n    text-align: center;\n    font-size: 14px;\n    opacity: .55;\n}\n\n/* 移动 / 复制：标题行 + 底部两个动作按钮 */\n/* 搜索面开关（标题 / 关键词 / 正文）：默认全开，可逐个关掉；关掉的变暗只剩描边 */\n.wbm-picker-filters {\n    flex: 0 0 auto;\n    display: flex;\n    gap: 8px;\n    padding: 2px 12px 0;\n}\n.wbm-picker-chip {\n    flex: 0 0 auto;\n    height: 30px;\n    padding: 0 13px;\n    border-radius: 999px;\n    border: 1px solid rgba(128, 128, 128, .45);\n    border-color: color-mix(in srgb, var(--SmartThemeBodyColor, #ccc) 30%, transparent);\n    background: transparent;\n    color: inherit;\n    font-family: inherit;\n    font-size: 13px;\n    line-height: 1;\n    opacity: .55;\n    cursor: pointer;\n    transition: opacity .12s ease, background-color .12s ease, border-color .12s ease;\n}\n.wbm-picker-chip.on {\n    opacity: 1;\n    border-color: var(--SmartThemeQuoteColor, #c9a86a);\n    background: rgba(128, 128, 128, .18);\n    background: color-mix(in srgb, var(--SmartThemeQuoteColor, #c9a86a) 16%, transparent);\n    color: var(--SmartThemeQuoteColor, #c9a86a);\n    font-weight: 600;\n}\n.wbm-picker-chip:active {\n    background: rgba(128, 128, 128, .28);\n    background: color-mix(in srgb, var(--SmartThemeBodyColor, #ccc) 16%, transparent);\n}\n\n.wbm-picker-title {\n    flex: 0 0 auto;\n    padding: 10px 12px 2px;\n    font-size: 13px;\n    opacity: .8;\n    overflow-wrap: anywhere;\n}\n.wbm-picker-actions {\n    flex: 0 0 auto;\n    display: flex;\n    flex-wrap: wrap;\n    gap: 8px;\n    padding: 8px 10px 4px;\n    border-top: 1px solid var(--SmartThemeBorderColor, rgba(128, 128, 128, .3));\n}\n/* 底部动作按钮：直接照 ST 自己的 .menu_button 走（底色=主题模糊层、描边=主题描边、\n   按下用 brightness 提亮），这样换主题时和酒馆里其它按钮一起变，不会像外挂 */\n.wbm-picker-action {\n    flex: 1 1 0;\n    min-width: 0;\n    height: 40px;\n    border-radius: 10px;\n    border: 1px solid var(--SmartThemeBorderColor, rgba(128, 128, 128, .45));\n    background: var(--SmartThemeBlurTintColor, rgba(0, 0, 0, .2));\n    color: var(--SmartThemeBodyColor, inherit);\n    font-family: inherit;\n    font-size: 14px;\n    cursor: pointer;\n    filter: grayscale(.5);\n    transition: filter .12s ease, background-color .12s ease;\n}\n.wbm-picker-action.primary {\n    border-color: var(--SmartThemeQuoteColor, #c9a86a);\n    color: var(--SmartThemeQuoteColor, #c9a86a);\n    filter: none;\n}\n/* 主按钮独占一行：三个按钮挤在一行时手机上文字必被压扁 */\n.wbm-picker-action.wide { flex: 1 1 100%; }\n.wbm-picker-action:active { filter: grayscale(.2) brightness(1.25); }\n.wbm-picker-action.primary:active { filter: brightness(1.25); }\n.wbm-picker-action:disabled { opacity: .45; filter: grayscale(1); cursor: default; }\n\n/* 多选用的方块勾（批量搬运条目时用） */\n.wbm-picker-box {\n    position: relative;\n    flex: 0 0 auto;\n    width: 20px;\n    height: 20px;\n    border-radius: 6px;\n    border: 2px solid var(--SmartThemeBorderColor, rgba(170, 170, 170, .9));\n    box-sizing: border-box;\n    transition: background-color .12s ease, border-color .12s ease;\n}\n.wbm-picker-row.active .wbm-picker-box {\n    border-color: var(--SmartThemeQuoteColor, #d4b06a);\n    background: var(--SmartThemeQuoteColor, #d4b06a);\n}\n.wbm-picker-row.active .wbm-picker-box::after {\n    content: '';\n    position: absolute;\n    left: 50%;\n    top: 50%;\n    width: 5px;\n    height: 9px;\n    border: solid var(--SmartThemeBlurTintColor, #1c1c26);\n    border-width: 0 2px 2px 0;\n    box-sizing: border-box;\n    transform: translate(-50%, -58%) rotate(42deg);\n}\n\n/* 批量移动/复制入口：条目列表上方的小按钮 */\n.wbm-batch-bar {\n    display: flex;\n    flex-wrap: wrap;\n    gap: 8px;\n    justify-content: flex-end;\n    margin: 2px 0 6px;\n}\n/* 分组小框：和筛选条同形制（圆角、主题描边、极淡底色），标注在左 */\n.wbm-tool-group {\n    display: flex;\n    flex-wrap: wrap;\n    align-items: center;\n    gap: 6px;\n    padding: 6px 8px;\n    border-radius: 9px;\n    border: 1px solid var(--SmartThemeBorderColor, rgba(128, 128, 128, .45));\n    background: rgba(128, 128, 128, .08);\n    background: color-mix(in srgb, var(--SmartThemeBodyColor, #ccc) 6%, transparent);\n}\n/* 工具栏按键：底色/描边/文字全部交给酒馆的 .menu_button（那就跟着主题走），\n   这里只管圆角与内距，和筛选条的胶囊保持同一形制。 */\n.wbm-batch-btn {\n    flex: 0 0 auto;\n    width: auto;\n    margin: 0;\n    height: 26px;\n    padding: 5px 11px;\n    border-radius: 999px;\n    font-family: inherit;\n    font-size: 12px;\n    line-height: 1;\n    white-space: nowrap;\n    cursor: pointer;\n}\n.wbm-batch-btn:active { filter: brightness(1.3); }\n\n/* 删除按钮：危险动作单独一档颜色，按一下变「确认删除 N 条」再由主题强调色提醒 */\n.wbm-picker-action.danger {\n    border-color: var(--SmartThemeBorderColor, rgba(128, 128, 128, .45));\n    color: var(--SmartThemeEmColor, #d08a8a);\n    filter: none;\n}\n.wbm-picker-action.danger.armed {\n    border-color: var(--SmartThemeQuoteColor, #c9a86a);\n    color: var(--SmartThemeQuoteColor, #c9a86a);\n    font-weight: 600;\n}\n/* 历史记录里的「恢复」小按钮 */\n.wbm-hist-restore {\n    flex: 0 0 auto;\n    height: 28px;\n    padding: 0 12px;\n    border-radius: 999px;\n    border: 1px solid var(--SmartThemeBorderColor, rgba(128, 128, 128, .45));\n    background: transparent;\n    color: var(--SmartThemeQuoteColor, #c9a86a);\n    font-family: inherit;\n    font-size: 12px;\n    cursor: pointer;\n}\n.wbm-hist-restore:active { background: rgba(128, 128, 128, .24); }\n\n/* 原书已经被删掉的删除记录：恢复不了，给一个安静的标记代替「恢复」按钮 */\n.wbm-hist-gone {\n    flex: 0 0 auto;\n    padding: 3px 9px;\n    border-radius: 999px;\n    border: 1px solid var(--SmartThemeBorderColor, rgba(128, 128, 128, .45));\n    font-size: 12px;\n    line-height: 1.4;\n    opacity: .6;\n    white-space: nowrap;\n}\n\n/* 批量替换窗口：替换词输入行 + 命中片段行 */\n.wbm-replace-row {\n    display: flex;\n    align-items: center;\n    gap: 8px;\n    padding: 2px 12px 8px;\n}\n.wbm-replace-label {\n    flex: 0 0 auto;\n    font-size: 12px;\n    opacity: .65;\n    white-space: nowrap;\n}\n.wbm-replace-field {\n    flex: 1 1 auto;\n    min-width: 0;\n    margin: 0 !important;\n    padding: 6px 9px;\n    font-size: 13px;\n    border-radius: 8px;\n}\n.wbm-replace-chips {\n    flex-wrap: wrap;\n    padding: 0 12px 6px;\n    justify-content: flex-start;\n}\n.wbm-replace-hit {\n    font-size: 12px;\n    line-height: 1.45;\n    opacity: .72;\n    overflow: hidden;\n    text-overflow: ellipsis;\n    white-space: nowrap;\n}\n\n/* 操作历史的行：第一行是\"时间 动作 N 条：A → B\"，第二行是条目名 */\n.wbm-hist-row {\n    align-items: flex-start;\n    padding: 9px 12px;\n}\n.wbm-hist-col {\n    display: flex;\n    flex-direction: column;\n    gap: 2px;\n    flex: 1 1 auto;\n    min-width: 0;\n}\n.wbm-hist-line {\n    font-size: 14px;\n    line-height: 1.35;\n    overflow: hidden;\n    text-overflow: ellipsis;\n    white-space: nowrap;\n}\n.wbm-hist-names {\n    font-size: 12px;\n    line-height: 1.3;\n    opacity: .62;\n    overflow: hidden;\n    text-overflow: ellipsis;\n    white-space: nowrap;\n}\n\n/* 收藏筛选条：★ 收藏（只看收藏）与 收藏置顶 开关并排 */\n.wbm-favbar {\n    display: flex;\n    gap: 6px;\n    padding: 0 2px 2px;\n}\n/* 这两个键同时带 .menu_button：底色、描边、文字全交给酒馆自己的按钮样式，\n   主题里改 .menu_button 时它们跟着一起变（以前写死透明底 + opacity，换主题就显得像外挂）。 */\n.wbm-chip {\n    flex: 0 0 auto;\n    width: auto;\n    margin: 0;\n    height: 26px;\n    padding: 0 11px;\n    border-radius: 999px;\n    font-family: inherit;\n    font-size: 12px;\n    line-height: 1;\n    white-space: nowrap;\n    cursor: pointer;\n}\n.wbm-chip.on {\n    border-color: var(--SmartThemeQuoteColor, #c9a86a);\n    color: var(--SmartThemeQuoteColor, #c9a86a);\n    font-weight: 600;\n    /* 酒馆原生按钮自带 grayscale(.5)，选中态要让它退回去，否则主题强调色会被洗灰 */\n    filter: none;\n}\n\n/* ---------- 移动端键盘卡顿：压住酒馆自己的 resize hack ----------\n   酒馆在 browser-fixes.js:84 里每次 resize 把 <html> 设成 position:fixed 再还原\n   （本意是修 iOS 的定位错位），代价是每次键盘弹出/收起都强制两次整页重排。\n   Android 上这纯属开销，所以 JS 会给 <html> 加这个 class；iOS 不加。\n   !important 能压住酒馆写进去的 inline style，赋值照旧、重排不再发生。 */\nhtml.wbm-quiet-resize {\n    position: static !important;\n}\n\n/* ---------- 条目搜索范围：贴在搜索框右边、排序下拉左边 ---------- */\n/* 那一行是宿主的静态工具条（图标 + 搜索框 + 排序下拉）。我们把三枚小键插在\n   搜索框与排序下拉之间，并接管两者原来的 flex:1，让排序下拉被裁短、把宽度让给搜索框。 */\n.wbm-search-scope {\n    display: flex;\n    align-items: center;\n    flex-wrap: wrap;\n    gap: 4px;\n    flex: 0 1 auto;\n    min-width: 0;\n}\n.wbm-scope-label {\n    flex: 0 0 auto;\n    font-size: 11px;\n    line-height: 1.4;\n    opacity: .55;\n    white-space: nowrap;\n}\n.wbm-chip-sm {\n    height: 22px;\n    padding: 0 8px;\n    font-size: 11px;\n    border-radius: 999px;\n}\n.wbm-scope-row #world_info_search {\n    flex: 1 1 120px;\n    min-width: 5em;\n}\n/* 排序下拉：从\"和搜索框各占一半\"改成固定一块，宽到能读完 Priority / Title A-Z */\n.wbm-scope-row #world_info_sort_order {\n    flex: 0 0 auto;\n    width: 8.5em;\n    min-width: 0;\n    max-width: 8.5em;\n}\n/* 手机/平板判定：不再只看宽度。\n   只写 \"max-width:760px\" 时，手机一横过来（844×390）和 iPad 竖屏（768）都掉到桌面样式里，\n   所以判据换成三种任命中其一：窄屏 / 短边矮（横屏手机）/ 触屏（iPad 等，宽度封顶 1100，\n   免得把触屏一体机也算进来）。CSS 不能在媒体查询里引用变量，这条表达式在三处出现，改要一起改。 */\n@media (max-width: 760px), (max-width: 1100px) and (max-height: 520px), (max-width: 1100px) and (pointer: coarse) {\n    /* 窄屏上标签让位给三个键本身（键名已经说明了用途）；\n       排序下拉不再挤在同一行尾巴上，改为独占下一行、占满宽度，读起来才像个控件行 */\n    .wbm-scope-row .wbm-scope-label { display: none; }\n    .wbm-scope-row #world_info_sort_order {\n        flex: 1 1 100%;\n        width: auto;\n        max-width: none;\n    }\n    .wbm-chip-sm { height: 20px; padding: 0 6px; font-size: 10px; }\n}\n/* 行里的收藏星标：只切收藏，不触发跳转 */\n.wbm-star {\n    flex: 0 0 auto;\n    width: 28px;\n    height: 28px;\n    padding: 0;\n    border: none;\n    border-radius: 8px;\n    background: transparent;\n    color: inherit;\n    font-size: 15px;\n    line-height: 1;\n    opacity: .45;\n    cursor: pointer;\n}\n.wbm-star.on {\n    opacity: 1;\n    color: var(--SmartThemeQuoteColor, #c9a86a);\n}\n.wbm-star:active { background: rgba(128, 128, 128, .24); }\n\n/* 条目列表的「仅收藏 / 收藏置顶」小条：紧跟在条目列表上方的工具栏下面 */\n/* 筛选条：整个框按内容收窄、靠右对齐；「筛选」标注紧贴第一个键，不飘到最左边 */\n.wbm-entry-favbar {\n    display: flex;\n    flex-wrap: wrap;\n    align-items: center;\n    gap: 6px;\n    justify-content: flex-start;\n    width: fit-content;\n    max-width: 100%;\n    margin: 0 0 6px auto;\n    padding: 6px 8px;\n    border-radius: 9px;\n    border: 1px solid var(--SmartThemeBorderColor, rgba(128, 128, 128, .45));\n    background: rgba(128, 128, 128, .08);\n    background: color-mix(in srgb, var(--SmartThemeBodyColor, #ccc) 6%, transparent);\n}\n/* 标注：字号跟着主题字号走，颜色取主题正文色，只在右侧拉一道分隔线 */\n.wbm-favbar-label {\n    flex: 0 0 auto;\n    padding-right: 8px;\n    margin-right: 2px;\n    border-right: 1px solid var(--SmartThemeBorderColor, rgba(128, 128, 128, .45));\n    color: var(--SmartThemeBodyColor, inherit);\n    font-size: 13px;\n    font-weight: 600;\n    line-height: 1.2;\n    opacity: .9;\n    white-space: nowrap;\n}\n/* 收藏筛选：用 class 隐藏，不动 inline display，免得和酒馆自己的搜索过滤打架 */\n#world_popup_entries_list .wbm-fav-hidden { display: none !important; }\n/* 置顶：只借 flex order 排视觉顺序，DOM 顺序保持原生（拖拽/分页/搜索都不受影响） */\n#world_popup_entries_list.wbm-order-on {\n    display: flex;\n    flex-direction: column;\n}\n\n/* 五个操作收在一个容器里：桌面排一行（收藏、预览、移动/复制、删除），手机排三行 */\n.wbm-entry-actions {\n    display: flex;\n    align-items: center;\n    gap: 2px;\n    flex: 0 0 auto;\n}\n@media (max-width: 1000px) {\n    .wbm-entry-actions {\n        display: flex;\n        flex-wrap: nowrap;\n        gap: 6px;\n        align-items: center;\n        justify-content: flex-end;\n        margin-left: auto;\n    }\n    /* 手机上按钮放大到手指好按：五个键等宽等高，排成一行 */\n    .wbm-entry-actions > * {\n        flex: 0 0 auto;\n        min-width: 38px;\n        height: 34px;\n        display: inline-flex;\n        align-items: center;\n        justify-content: center;\n        padding: 0 !important;\n        margin: 0 !important;\n        font-size: 16px;\n        line-height: 1;\n    }\n}\n.wbm-fav-entry-btn,\n.wbm-preview-btn {\n    flex: 0 0 auto;\n    cursor: pointer;\n    font-style: normal;\n    line-height: 1;\n    padding: 2px 7px !important;\n    font-size: 13px;\n    margin: 0 !important;\n}\n.wbm-fav-entry-btn { opacity: .55; }\n.wbm-fav-entry-btn.on {\n    opacity: 1;\n    color: var(--SmartThemeQuoteColor, #c9a86a);\n    /* 酒馆原生按钮带 grayscale(.5)，收藏态要露出主题强调色就得把它撤掉 */\n    filter: none;\n}\n\n/* 只读预览浮层 */\n.wbm-prev-title {\n    flex: 1 1 auto;\n    min-width: 0;\n    overflow: hidden;\n    text-overflow: ellipsis;\n    white-space: nowrap;\n    font-size: 15px;\n    font-weight: 600;\n}\n.wbm-prev-body {\n    flex: 1 1 auto;\n    min-height: 0;\n    overflow-y: auto;\n    overscroll-behavior: contain;\n    padding: 4px 14px 14px;\n    -webkit-user-select: text;\n    user-select: text;\n}\n.wbm-prev-meta {\n    font-size: 12px;\n    opacity: .6;\n    margin-bottom: 8px;\n    overflow-wrap: anywhere;\n}\n.wbm-prev-keys {\n    display: flex;\n    flex-wrap: wrap;\n    gap: 6px;\n    margin-bottom: 10px;\n}\n.wbm-prev-key {\n    padding: 2px 9px;\n    border-radius: 999px;\n    border: 1px solid var(--SmartThemeBorderColor, rgba(128, 128, 128, .45));\n    background: rgba(128, 128, 128, .16);\n    background: color-mix(in srgb, var(--SmartThemeBodyColor, #ccc) 10%, transparent);\n    font-size: 12px;\n    line-height: 1.6;\n}\n/* 预览里的关键词分区：主要关键词 / 逻辑 / 可选过滤器，各自一行、标签在前 */\n.wbm-prev-kwlines {\n    margin-bottom: 4px;\n}\n.wbm-prev-kwline {\n    display: flex;\n    flex-wrap: wrap;\n    align-items: center;\n    gap: 6px;\n    margin-bottom: 8px;\n}\n.wbm-prev-kwlabel {\n    font-size: 12px;\n    font-weight: 600;\n    opacity: .65;\n    margin-right: 2px;\n    white-space: nowrap;\n}\n.wbm-prev-kwempty {\n    font-size: 12px;\n    opacity: .45;\n}\n.wbm-prev-kwvalue {\n    font-size: 12px;\n    opacity: .8;\n    overflow-wrap: anywhere;\n}\n.wbm-prev-text {\n    font-size: 14px;\n    line-height: 1.7;\n    white-space: pre-wrap;\n    overflow-wrap: anywhere;\n}\n\n\n/* ---------- 窄屏重排：标题行（标题＋触发策略）→ 字段网格 → 功能键 ---------- */\n@media (max-width: 1000px) {\n    /* 条目之间拉开距离并加分隔线，否则上下两条黏在一起分不清 */\n    #world_popup_entries_list .world_entry + .world_entry {\n        margin-top: 14px;\n        padding-top: 12px;\n        border-top: 1px solid var(--SmartThemeBorderColor, rgba(128, 128, 128, .35));\n    }\n    /* 折叠箭头、开关、拖动把手始终在条目头的同一条中线上：这里绝不能再改成 flex-start，\n       否则箭头和开关会飘到左上角，跟中间的 ☰ 错开（v2.4.0 的失误） */\n    #world_popup_entries_list .world_entry_thin_controls {\n        align-items: center;\n    }\n\n    /* 标题行：标题吃满剩下的宽度；触发策略（🔵/🟢/🔗）留在标题右边，\n       不再像之前那样被搬进字段网格、撑成一整条拉到满宽 */\n    #world_popup_entries_list .WIEntryTitleAndStatus {\n        flex: 1 1 100%;\n        width: 100%;\n        min-width: 0;\n        gap: 6px;\n    }\n    #world_popup_entries_list .WIEntryTitleAndStatus > .flex-container {\n        flex: 1 1 auto;\n        width: auto;\n        min-width: 0;\n    }\n    #world_popup_entries_list .WIEntryTitleAndStatus textarea[name=\"comment\"] {\n        width: 100% !important;\n    }\n    #world_popup_entries_list .WIEntryTitleAndStatus select[name=\"entryStateSelector\"] {\n        flex: 0 0 auto;\n        align-self: center;\n        width: auto !important;\n        min-width: 40px;\n        height: 32px;\n    }\n\n    /* 字段：标签小一号、控件撑满格子，四列宽度一致 */\n    #world_popup_entries_list .WIEnteryHeaderControls {\n        flex: 1 1 100%;\n        width: 100%;\n        display: grid;\n        grid-template-columns: repeat(2, minmax(0, 1fr));\n        gap: 8px 10px;\n        align-items: end;\n    }\n    #world_popup_entries_list .WIEnteryHeaderControls > * {\n        min-width: 0;\n    }\n    #world_popup_entries_list .WIEnteryHeaderControls .WIEntryHeaderTitleMobile {\n        display: block;\n        font-size: 12px;\n        line-height: 1.3;\n        opacity: .7;\n        margin: 0 0 2px;\n    }\n    #world_popup_entries_list .WIEnteryHeaderControls select,\n    #world_popup_entries_list .WIEnteryHeaderControls input {\n        width: 100% !important;\n        max-width: none !important;\n    }\n}\n\n/* 空间不够把五个键塞在标题行右边时（竖屏手机、横屏手机、平板）：整排锁在条目右下角，\n   标题与字段因此能用满整行。命中条件同上（窄屏 / 短边矮 / 触屏）。 */\n@media (max-width: 760px), (max-width: 1100px) and (max-height: 520px), (max-width: 1100px) and (pointer: coarse) {\n    #world_popup_entries_list .world_entry .inline-drawer-header {\n        position: relative;\n        padding-bottom: 42px;\n    }\n    #world_popup_entries_list .wbm-entry-actions {\n        position: absolute;\n        right: 0;\n        bottom: 0;\n        margin: 0;\n    }\n}\n\n/* 横屏手机 / 平板：空间够了，字段排三列 */\n@media (min-width: 641px) and (max-width: 1000px) {\n    #world_popup_entries_list .WIEnteryHeaderControls {\n        grid-template-columns: repeat(3, minmax(0, 1fr));\n    }\n}\n\n/* 再宽一些、而且不是触屏（鼠标操作的窄窗）：五个键回到标题行右侧、跟标题对齐靠上。\n   触屏和平板一律留在右下角，那里最好按。 */\n@media (min-width: 761px) and (max-width: 1000px) and (pointer: fine) {\n    #world_popup_entries_list .wbm-entry-actions {\n        align-self: flex-start;\n        margin-top: 2px;\n    }\n}\n\n@keyframes wbm-mask-in { from { opacity: 0; } to { opacity: 1; } }\n@keyframes wbm-mask-out { from { opacity: 1; } to { opacity: 0; } }\n@keyframes wbm-sheet-in { from { transform: translateY(14px); opacity: .6; } to { transform: none; opacity: 1; } }\n@keyframes wbm-sheet-out { from { transform: none; opacity: 1; } to { transform: translateY(14px); opacity: 0; } }\n\n/* 操作历史顶部的容量提示：与上面「最近 N 条操作…」同一条左边线（标题内边距左 12px） */\n.wbm-hist-usage {\n    opacity: .5;\n    font-size: 11px;\n    padding: 0 12px;\n    margin: -2px 0 6px;\n}\n\n/* 危险操作提示条（递归开关等） */\n.wbm-warn-row {\n    margin: 0 0 8px;\n    padding: 8px 10px;\n    border-radius: 8px;\n    border: 1px solid var(--SmartThemeBorderColor, rgba(128, 128, 128, .45));\n    background: rgba(128, 128, 128, .12);\n    background: color-mix(in srgb, var(--SmartThemeEmColor, #e1ecaa) 14%, transparent);\n    font-size: 12px;\n    line-height: 1.55;\n}\n\n/* 体检窗口：可展开的分类、条目行、正文摘录 */\n.wbm-health-cat {\n    display: flex;\n    flex-direction: column;\n    margin-bottom: 6px;\n}\n.wbm-health-head {\n    width: 100%;\n    text-align: left;\n    padding: 8px 10px;\n    border-radius: 8px;\n    border: 1px solid var(--SmartThemeBorderColor, rgba(128, 128, 128, .45));\n    background: rgba(128, 128, 128, .10);\n    background: color-mix(in srgb, var(--SmartThemeBodyColor, #ccc) 7%, transparent);\n    color: inherit;\n    font-family: inherit;\n    font-size: 13px;\n    line-height: 1.4;\n    cursor: pointer;\n}\n.wbm-health-head::before { content: '▸ '; opacity: .7; }\n.wbm-health-head.open::before { content: '▾ '; }\n.wbm-health-list {\n    display: flex;\n    flex-direction: column;\n    gap: 2px;\n    padding: 4px 0 6px 10px;\n}\n.wbm-health-linewrap { display: flex; flex-direction: column; }\n.wbm-health-item { display: flex; align-items: center; gap: 6px; padding: 2px 0; }\n.wbm-health-name {\n    flex: 1 1 auto;\n    min-width: 0;\n    text-align: left;\n    padding: 4px 6px;\n    border: none;\n    border-radius: 6px;\n    background: transparent;\n    color: var(--SmartThemeQuoteColor, #c9a86a);\n    font-family: inherit;\n    font-size: 12px;\n    line-height: 1.4;\n    cursor: pointer;\n    overflow: hidden;\n    text-overflow: ellipsis;\n    white-space: nowrap;\n}\n.wbm-health-act {\n    flex: 0 0 auto;\n    padding: 3px 8px;\n    border-radius: 999px;\n    border: 1px solid var(--SmartThemeBorderColor, rgba(128, 128, 128, .45));\n    background: transparent;\n    color: inherit;\n    font-family: inherit;\n    font-size: 11px;\n    line-height: 1.4;\n    opacity: .8;\n    cursor: pointer;\n}\n.wbm-health-excerpt { padding: 2px 6px 8px; }\n.wbm-health-body {\n    font-size: 12px;\n    line-height: 1.55;\n    white-space: pre-wrap;\n    opacity: .82;\n    max-height: 160px;\n    overflow-y: auto;\n}\n\n/* 体检：ⓘ 说明折叠 */\n.wbm-health-info {\n    align-self: flex-start;\n    margin: 0 0 6px;\n    padding: 5px 10px;\n    border-radius: 999px;\n    border: 1px solid var(--SmartThemeBorderColor, rgba(128, 128, 128, .45));\n    background: transparent;\n    color: var(--SmartThemeBodyColor, inherit);\n    font-family: inherit;\n    font-size: 12px;\n    line-height: 1.4;\n    opacity: .8;\n    cursor: pointer;\n}\n.wbm-health-info.open { opacity: 1; }\n.wbm-health-info-body {\n    margin: 0 0 8px;\n    padding: 8px 10px;\n    border-radius: 8px;\n    border: 1px solid var(--SmartThemeBorderColor, rgba(128, 128, 128, .35));\n    background: rgba(128, 128, 128, .08);\n    font-size: 12px;\n    line-height: 1.55;\n}\n.wbm-health-info-line { opacity: .85; }\n\n/* ---- 正文防误触：默认只读，双击进编辑，标题旁出「取消 / 保存」 ---- */\n.wbm-edit-actions {\n    display: inline-flex;\n    align-items: center;\n    gap: 6px;\n    margin-left: 8px;\n    vertical-align: middle;\n}\n.wbm-edit-actions[hidden] { display: none !important; }\n.wbm-edit-btn {\n    font: inherit;\n    font-size: 12px;\n    line-height: 1;\n    padding: 4px 11px;\n    border-radius: 999px;\n    cursor: pointer;\n    border: 1px solid var(--SmartThemeBorderColor, rgba(255, 255, 255, .28));\n    background: color-mix(in srgb, var(--SmartThemeBlurTintColor, #202020) 88%, transparent);\n    color: var(--SmartThemeBodyColor, #ddd);\n    transition: filter .12s ease, background .12s ease;\n}\n.wbm-edit-btn:hover { filter: brightness(1.18); }\n.wbm-edit-btn:active { filter: brightness(.92); }\n.wbm-edit-cancel { opacity: .85; }\n/* 确认键跟随酒馆主题：底色/描边取主题强调色（--SmartThemeQuoteColor），文字取正文色 */\n.wbm-edit-save {\n    font-weight: 700;\n    border-color: var(--SmartThemeQuoteColor, rgba(140, 190, 255, .85));\n    background: color-mix(in srgb, var(--SmartThemeQuoteColor, #8cbeff) 22%, transparent);\n    color: var(--SmartThemeBodyColor, #eee);\n}\n.wbm-edit-save:hover {\n    background: color-mix(in srgb, var(--SmartThemeQuoteColor, #8cbeff) 38%, transparent);\n    filter: none;\n}\n/* 字段级「取消 / 保存」：贴着被解锁的那个字段放 */\n.wbm-field-bar {\n    display: inline-flex;\n    align-items: center;\n    gap: 4px;\n    margin-left: 6px;\n    vertical-align: middle;\n}\n.wbm-field-bar[hidden] { display: none !important; }\n/* 正在编辑的那个字段加一圈强调色，别让人找不到 */\n.wbm-field-editing {\n    outline: 1px solid var(--SmartThemeQuoteColor, rgba(140, 190, 255, .8));\n    outline-offset: 1px;\n}\ntextarea.wbm-content-locked { cursor: pointer; }\ntextarea.wbm-content-editing {\n    outline: 1px solid var(--SmartThemeQuoteColor, rgba(120, 190, 255, .8));\n    outline-offset: 1px;\n}\n\n/* ---- 条目防误触锁：下拉/复选/关键词点不动，双击条目进编辑态 ---- */\n.wbm-inert {\n    pointer-events: none !important;\n}\n/* 被 select2 包一层的下拉（关键词、触发策略等）：锁住时连它那一层也点不动 */\n.world_entry[data-wbm-locked=\"1\"] .select2-container,\n.world_entry[data-wbm-locked=\"1\"] .select2-selection {\n    pointer-events: none !important;\n}\n.wbm-field-locked {\n    cursor: pointer;\n}\n/* 编辑态的条目：整块加一圈淡淡的强调色，让人一眼知道\"现在这条可以改\" */\n.world_entry[data-wbm-editing=\"1\"] {\n    outline: 1px solid var(--SmartThemeQuoteColor, rgba(120, 190, 255, .55));\n    outline-offset: -1px;\n}\n.wbm-edit-bar {\n    display: inline-flex;\n    align-items: center;\n    gap: 6px;\n    margin-right: 6px;\n}\n.wbm-edit-bar[hidden] { display: none !important; }\n/* 顶栏上的开关图标 */\n#wbm-lock-toggle {\n    cursor: pointer;\n}\n#wbm-lock-toggle.wbm-lock-on {\n    color: var(--SmartThemeQuoteColor, #7cc0ff);\n}\n\n/* ================= 消息编辑：右下角再挂一排原生按钮 ================= */\n\n/* 顶部那排（.mes_edit_buttons）原样保留，不动它。这里说的是编辑期间由 index.js\n   克隆到消息右下角的第二排（#wbm-bottom-editrow）：长消息点完铅笔不用再往上翻。\n   克隆体用的还是酒馆原生的类名（.mes_edit_done 等），所以配色、点击行为全部照旧，\n   下面只是把它摆到 .mes 的右下角，并按宿主原排的尺寸把外面那层容器量出来。 */\n#wbm-bottom-editrow {\n    position: absolute;\n    right: 8px;\n    bottom: 6px;\n    left: auto;\n    top: auto;\n    display: inline-flex;\n    flex-direction: row;\n    align-items: center;\n    gap: 5px;\n    padding: 0;\n    margin: 0;\n    z-index: 50;\n}\n\n/* 尺寸与透明度对齐宿主原生那排（.mes_edit_buttons .menu_button 的同一套数值），\n   落在容器外时宿主的规则选不到，这里补一份，避免克隆出来的按钮比上面那排更大更亮 */\n#wbm-bottom-editrow .menu_button {\n    opacity: 0.5;\n    padding: 0;\n    margin: 0;\n    font-size: 1rem;\n    height: 2rem;\n    aspect-ratio: 1 / 1;\n    display: flex;\n    justify-content: center;\n    align-items: center;\n    cursor: pointer;\n}\n\n#wbm-bottom-editrow .menu_button:hover {\n    opacity: 1;\n}\n\n/* 把正在编辑的正文顶起来，给下面那排按钮腾出位置：最后一行不会被按钮压住。\n   条件写成「这条消息里确实有那排克隆按钮」——关掉开关或总开关后按钮不生成，\n   这里也就不会白白多出一段空白。 */\n.mes:has(> #wbm-bottom-editrow) > .mes_block > .mes_text {\n    padding-bottom: calc(2rem + 14px);\n}\n\n/* 编辑期间让开这条消息的左右滑档箭头与滑档计数：它们也钉在消息右下角，\n   z-index(9999) 比按钮高，留着的下场是挡住最右边的取消键。只在有那排按钮时生效。 */\n.mes:has(> #wbm-bottom-editrow) > .swipeRightBlock,\n.mes:has(> #wbm-bottom-editrow) > .swipe_left,\n.mes:has(> #wbm-bottom-editrow) > .swipe_right {\n    display: none !important;\n}\n\n/* 页码被我们接管后钉在气泡正中下方（不再是 .swipeRightBlock 的孩子），上面那条选不到它，\n   它会和右下角那排按钮同一水平线、手机上图标直接叠在一起。编辑期间这条消息的页码一并让位；\n   .wbm-editing 是老 WebView 不认 :has() 时的兜底（由 main.js 的 syncBottomRow 加/删）。 */\n.mes:has(> #wbm-bottom-editrow) > .swipes-counter,\n.mes:has(> #wbm-bottom-editrow) .swipes-counter,\n.mes.wbm-editing .swipes-counter {\n    display: none !important;\n}\n\n/* ================= 扩展设置抽屉 ================= */\n\n/* 分组小标题：用主题引色，换主题时跟着变 */\n#wbm-settings .wbm-opt-group {\n    margin: 16px 0 8px;\n    padding-top: 10px;\n    border-top: 1px solid var(--SmartThemeBorderColor, rgba(255, 255, 255, .15));\n}\n\n#wbm-settings .wbm-opt-group > b {\n    color: var(--SmartThemeQuoteColor, inherit);\n    font-size: .95em;\n    letter-spacing: .3px;\n}\n\n/* 每个开关做成一张小卡片：左边一条主题色强调线 + 很淡的主题底色 + 卡与卡之间留白。\n   换主题时强调线与底色都跟着变（color-mix 前面垫 rgba 兜底，老浏览器也有底线）。 */\n#wbm-settings .wbm-opt-label {\n    display: flex;\n    align-items: flex-start;\n    gap: 8px;\n    margin: 0 0 10px;\n    padding: 8px 10px 9px;\n    border-left: 3px solid var(--SmartThemeQuoteColor, rgba(128, 128, 128, .6));\n    border-radius: 6px;\n    /* 底色取自正文色：深色主题是提亮、浅色主题是压暗，两边都看得出\"这是一张卡\"。\n       先写 rgba 兜底，再用 color-mix 跟主题走。 */\n    background: rgba(255, 255, 255, .05);\n    background: color-mix(in srgb, var(--SmartThemeBodyColor, rgba(255, 255, 255, .9)) 9%, transparent);\n}\n\n#wbm-settings .wbm-opt-label:hover {\n    background: rgba(255, 255, 255, .09);\n    background: color-mix(in srgb, var(--SmartThemeBodyColor, rgba(255, 255, 255, .9)) 15%, transparent);\n}\n\n/* 说明文字：放进开关的 label 里、和标题同一列，这样无论主题把复选框画多大，\n   说明都从标题的左边开始，不会吊在复选框底下 */\n#wbm-settings .wbm-opt-text {\n    display: flex;\n    flex-direction: column;\n    gap: 4px;\n    min-width: 0;\n}\n\n#wbm-settings .wbm-opt-title {\n    line-height: 1.4;\n}\n\n#wbm-settings .wbm-opt-note {\n    font-size: .85em;\n    line-height: 1.5;\n    opacity: .8;\n}\n\n/* 总开关关着时，下面几项就地变淡，提示\"现在没在生效\"，但仍然可以预先设置 */\n#wbm-settings .inline-drawer-content[data-wbm-idle=\"1\"] .wbm-opt-group,\n#wbm-settings .inline-drawer-content[data-wbm-idle=\"1\"] .wbm-opt-label {\n    opacity: .55;\n}\n\n#wbm-settings .inline-drawer-content[data-wbm-idle=\"1\"] #wbm-opt-enhance {\n    opacity: 1;\n}\n\n/* ================= 手机端：把世界书面板那几排控件压紧 ================= */\n\n/* 目标：不缩小按键（手指要能点中），只把\"折行\"消掉。\n   具体是——搜索区压成两排、世界书选择那排拆成\"选书 / 动书\"两排、\n   批量整理与筛选条各自横向滚动，不再折成三四行。\n   命中条件与上面两处相同：窄屏 / 短边矮（横屏手机）/ 触屏平板。 */\n@media (max-width: 760px), (max-width: 1100px) and (max-height: 520px), (max-width: 1100px) and (pointer: coarse) {\n    /* 搜索行：按实际宽度自然换行（不强行单行，否则尾部控件会被挤出屏幕外够不到）：\n       搜索框自己占一行，三枚范围键 + 排序挤在下一行，仍然是两行。 */\n    .wbm-scope-row {\n        flex-wrap: wrap;\n        align-items: center;\n        gap: 5px;\n    }\n    .wbm-scope-row .wbm-search-scope {\n        flex-wrap: nowrap;\n        flex: 0 1 auto;\n    }\n    .wbm-scope-row #world_info_search {\n        flex: 1 1 100%;\n        min-width: 4.5em;\n        order: 1;\n    }\n    .wbm-scope-row .wbm-search-scope { order: 2; }\n    .wbm-scope-row #world_info_sort_order {\n        flex: 1 1 auto;\n        width: auto;\n        max-width: none;\n        min-width: 5.5em;\n        order: 3;\n    }\n    /* 范围键放大到手指能点中（原来 20px 太矮），但仍排在同一行 */\n    .wbm-scope-row .wbm-chip-sm {\n        height: 28px;\n        padding: 0 8px;\n        font-size: 12px;\n    }\n\n    /* ---------- 世界书选择那一排：拆成两排 ---------- */\n    /* 第一排（挑一本书）：创建 · or · 选择以编辑 · 世界书分类\n       第二排（动这本书）：导入 · 导出 · 重命名 · 复制 · 删除 —— 五等分占满 */\n    .wbm-world-row {\n        flex-wrap: wrap;\n        align-items: center;\n        gap: 6px;\n    }\n    .wbm-world-row .wbm-rowbreak {\n        display: block;\n        flex: 0 0 100%;\n        width: 100%;\n        height: 0;\n        margin: 0;\n        padding: 0;\n        border: 0;\n    }\n    .wbm-world-row #world_create_button,\n    .wbm-world-row > small {\n        flex: 0 0 auto;\n    }\n    .wbm-world-row #world_create_button { height: 34px; }\n    /* 书名再长也不许把右边那枚分类图标挤走：\n       basis 取 0（不是 auto）——auto 会先按内容宽度撑开，长书名就把兄弟挤出行外；\n       min-width 归零 + overflow 兜底，按钮内部自己省略号截断。 */\n    .wbm-world-row .wbm-editor-wrap {\n        flex: 1 1 0;\n        min-width: 0;\n        max-width: 100%;\n        overflow: hidden;\n    }\n    .wbm-world-row .wbm-editor-btn {\n        display: block;\n        width: 100%;\n        min-width: 0;\n        max-width: 100%;\n        box-sizing: border-box;\n        white-space: nowrap;\n        overflow: hidden;\n        text-overflow: ellipsis;\n    }\n    .wbm-world-row .wbm-cat-btn {\n        flex: 0 0 34px;\n        width: 34px;\n        height: 34px;\n    }\n    .wbm-world-row #world_import_button,\n    .wbm-world-row #world_popup_export,\n    .wbm-world-row #world_popup_name_button,\n    .wbm-world-row #world_duplicate,\n    .wbm-world-row #world_popup_delete {\n        flex: 1 1 0;\n        min-width: 34px;\n        max-width: none;\n        height: 34px;\n        margin: 0 !important;\n        padding: 0;\n        display: inline-flex;\n        align-items: center;\n        justify-content: center;\n        font-size: 15px;\n        line-height: 1;\n    }\n\n    /* ---------- 横滑条：留一条 3px 细滚动条，滑得动看得出来 ---------- */\n    /* 批量整理 / 检查记录：一行，横向滚动，不再折行 */\n    .wbm-batch-bar {\n        flex-wrap: nowrap;\n        justify-content: flex-start;\n        overflow-x: auto;\n        overflow-y: hidden;\n        padding-bottom: 5px;\n        scrollbar-width: thin;\n        scrollbar-color: var(--SmartThemeQuoteColor, rgba(170, 170, 170, .6)) transparent;\n        /* 滚到边上别把整页带着动 */\n        overscroll-behavior-x: contain;\n    }\n    .wbm-batch-bar .wbm-tool-group {\n        flex: 0 0 auto;\n        flex-wrap: nowrap;\n    }\n\n    /* 条目筛选条同理：一行横向滚动 */\n    .wbm-entry-favbar {\n        flex-wrap: nowrap;\n        overflow-x: auto;\n        overflow-y: hidden;\n        padding-bottom: 5px;\n        scrollbar-width: thin;\n        scrollbar-color: var(--SmartThemeQuoteColor, rgba(170, 170, 170, .6)) transparent;\n        overscroll-behavior-x: contain;\n    }\n    .wbm-entry-favbar .wbm-chip,\n    .wbm-entry-favbar .menu_button {\n        flex: 0 0 auto;\n    }\n\n    /* 已启用列表头顶的 ★收藏 / 收藏置顶 同理 */\n    .wbm-favbar {\n        flex-wrap: nowrap;\n        overflow-x: auto;\n        overflow-y: hidden;\n        padding-bottom: 3px;\n        scrollbar-width: thin;\n        scrollbar-color: var(--SmartThemeQuoteColor, rgba(170, 170, 170, .6)) transparent;\n        overscroll-behavior-x: contain;\n    }\n\n    /* WebKit 的细滚动条（上面 scrollbar-width 对 Chrome 已生效，这里统一大小与取色） */\n    .wbm-batch-bar::-webkit-scrollbar,\n    .wbm-entry-favbar::-webkit-scrollbar,\n    .wbm-favbar::-webkit-scrollbar {\n        height: 3px;\n        background: transparent;\n    }\n    .wbm-batch-bar::-webkit-scrollbar-track,\n    .wbm-entry-favbar::-webkit-scrollbar-track,\n    .wbm-favbar::-webkit-scrollbar-track { background: transparent; }\n    .wbm-batch-bar::-webkit-scrollbar-thumb,\n    .wbm-entry-favbar::-webkit-scrollbar-thumb,\n    .wbm-favbar::-webkit-scrollbar-thumb {\n        border-radius: 2px;\n        background: var(--SmartThemeQuoteColor, rgba(170, 170, 170, .6));\n    }\n\n    /* 按键别缩得太小：手机上一律不低于 30px 高 */\n    #wbm-list .wbm-chip,\n    .wbm-entry-favbar .wbm-chip {\n        height: 30px;\n        font-size: 12px;\n        padding: 0 11px;\n    }\n\n    /* 「选择以编辑」按钮允许被压缩，避免把宿主那排图标挤到下一行 */\n    .wbm-editor-wrap { min-width: 0; }\n    .wbm-editor-btn { min-width: 0; }\n\n}\n\n/* 够宽（600px 以上：横屏手机、平板、电脑）：搜索区挤回一行，把高度还给条目列表。\n   手机竖屏（390 那档）不命中，那边仍然是\"搜索框独占一排 + 键与排序一排\"。 */\n@media (min-width: 600px) {\n    .wbm-scope-row { flex-wrap: nowrap; }\n    .wbm-scope-row #world_info_search {\n        flex: 1 1 6em;\n        min-width: 4em;\n    }\n    .wbm-scope-row .wbm-search-scope {\n        flex: 0 0 auto;\n        flex-wrap: nowrap;\n    }\n    .wbm-scope-row #world_info_sort_order {\n        flex: 0 0 auto;\n        width: 8.5em;\n        max-width: 8.5em;\n        min-width: 0;\n    }\n}\n\n/* ================= 备选回复页码接管 =================\n    目标：页码固定在消息气泡下方正中，手机上也要点得中。\n    原则：只动 .swipes-counter 这一个盒子，.swipe_right / .swipe_left 一根手指都不碰——\n    所以把箭头换成小兔子之类的美化照旧生效；地方不够时宁可让箭头压住页码，\n    也绝不把箭头挤开（master 2026-10-20 定的）。\n    2026-10-20 master 复测：左边/下面两档显示都错位，砍掉，只保留中间。 */\n\nbody.wbm-swipe-on #chat .mes .swipes-counter {\n    font-size: 14px !important;\n    line-height: 1.3 !important;\n    min-width: 46px !important;\n    height: auto !important;\n    padding: 3px 10px !important;\n    margin: 0 !important;\n    border-radius: 999px;\n    opacity: .55 !important;\n    pointer-events: auto !important;\n    transition: opacity .15s ease, background-color .15s ease;\n}\n\nbody.wbm-swipe-on #chat .mes .swipes-counter:hover,\nbody.wbm-swipe-on #chat .mes .swipes-counter:focus-visible {\n    opacity: .95 !important;\n    background-color: color-mix(in srgb, var(--SmartThemeBodyColor, #ffffff) 12%, transparent) !important;\n}\n\n/* 页码搬进 .mes 绝对居中，消息底部补一条等高空行（学双色盒子的做法） */\nbody.wbm-swipe-on #chat .mes {\n    position: relative;\n    padding-bottom: 26px !important;\n}\n\nbody.wbm-swipe-on #chat .mes .swipes-counter {\n    position: absolute !important;\n    left: 50% !important;\n    right: auto !important;\n    top: auto !important;\n    bottom: 3px !important;\n    transform: translateX(-50%) !important;\n    align-self: auto !important;\n    order: 0 !important;\n}\n\n/* 手机：字再大一号、点击区撑到 44pt 上下，但视觉上仍然只是一个数字 */\n@media (max-width: 760px), (max-width: 1100px) and (max-height: 520px), (max-width: 1100px) and (pointer: coarse) {\n    body.wbm-swipe-on #chat .mes .swipes-counter {\n        font-size: 15px !important;\n        min-width: 60px !important;\n        padding: 7px 14px !important;\n        bottom: 4px !important;\n    }\n\n    body.wbm-swipe-on #chat .mes {\n        padding-bottom: 36px !important;\n    }\n}\n\n/* 备选回复弹窗标题栏里的「批量删除」（三栏网格：标题左 / 按钮中 / 关闭右上）\n   以前用绝对定位居中，按钮比标题栏高，下沿压在了弹窗的分隔线上（master 2026-10-20 报的）。 */\n.wbm-swipe-header {\n    display: grid !important;\n    grid-template-columns: 1fr auto 1fr;\n    align-items: center;\n    column-gap: 8px;\n    padding: 6px 0 10px !important;\n    min-height: 44px;\n    row-gap: 0;\n}\n\n.wbm-swipe-header > h3,\n.wbm-swipe-header > .swipe_picker_title {\n    grid-column: 1;\n    justify-self: start;\n    margin: 0 !important;\n    min-width: 0;\n    overflow: hidden;\n    text-overflow: ellipsis;\n    white-space: nowrap;\n}\n\n.wbm-swipe-header .wbm-swipe-bulk {\n    grid-column: 2;\n    justify-self: center;\n}\n\n.wbm-swipe-header .wbm-swipe-right {\n    grid-column: 3;\n    justify-self: end;\n    display: inline-flex;\n    align-items: center;\n    gap: 10px;\n    min-width: 0;\n}\n\n.wbm-swipe-header .wbm-swipe-right .popup-button-close {\n    margin-left: 0 !important;\n}\n\n.wbm-swipe-header .wbm-swipe-tool {\n    cursor: pointer;\n    user-select: none;\n    padding: 2px 4px;\n    border-radius: 4px;\n    transition: background-color .12s ease, opacity .12s ease;\n}\n\n.wbm-swipe-header .wbm-swipe-tools {\n    display: inline-flex;\n    align-items: center;\n    gap: 12px;\n    flex: 0 0 auto;\n    white-space: nowrap;\n}\n\n.wbm-swipe-header .wbm-swipe-tool {\n    flex: 0 0 auto;\n    white-space: nowrap;\n}\n\n@media (max-width: 480px) {\n    .wbm-swipe-header .wbm-swipe-tools { gap: 10px; }\n    .wbm-swipe-header .wbm-swipe-right { gap: 8px; }\n}\n\n.wbm-swipe-header .wbm-swipe-tool:hover {\n    opacity: 1;\n    background-color: color-mix(in srgb, var(--SmartThemeBodyColor, #ffffff) 14%, transparent);\n}\n\n.wbm-swipe-bulk {\n    display: inline-flex;\n    align-items: center;\n    gap: 6px;\n    flex: 0 0 auto;\n    padding: 5px 12px;\n    border: 1px solid var(--SmartThemeBorderColor, rgba(255, 255, 255, .18));\n    border-radius: 8px;\n    font-size: 13px;\n    line-height: 1.2;\n    opacity: .8;\n    cursor: pointer;\n    user-select: none;\n    white-space: nowrap;\n    transition: opacity .15s ease, border-color .15s ease, background-color .15s ease;\n}\n\n.wbm-swipe-bulk:hover {\n    opacity: 1;\n    border-color: var(--SmartThemeEmColor, #9c7bd6);\n}\n\n.wbm-swipe-bulk.armed {\n    opacity: 1;\n    border-color: var(--SmartThemeEmColor, #d6747b);\n    background-color: color-mix(in srgb, var(--SmartThemeEmColor, #d6747b) 14%, transparent);\n}\n\n.wbm-swipe-bulk.wbm-busy {\n    opacity: .6;\n    pointer-events: none;\n}\n\n/* 选择模式：每条备选左侧一个勾选圈，点条目本身＝勾选，不再切换正文 */\n.wbm-swipe-pick {\n    flex: 0 0 auto;\n    align-self: center;\n    display: inline-flex;\n    align-items: center;\n    justify-content: center;\n    width: 22px;\n    height: 22px;\n    margin-right: 6px;\n    border: 1px solid var(--SmartThemeBorderColor, rgba(255, 255, 255, .35));\n    border-radius: 50%;\n    opacity: .7;\n    transition: opacity .12s ease, background-color .12s ease, border-color .12s ease;\n}\n\n.wbm-swipe-pick i {\n    font-size: 11px;\n    opacity: 0;\n    transition: opacity .12s ease;\n}\n\n.wbm-swipe-pick.checked {\n    opacity: 1;\n    border-color: var(--SmartThemeEmColor, #9c7bd6);\n    background-color: color-mix(in srgb, var(--SmartThemeEmColor, #9c7bd6) 26%, transparent);\n}\n\n.wbm-swipe-pick.checked i {\n    opacity: 1;\n}\n\n.swipe_picker_block.wbm-select-on {\n    cursor: pointer;\n}\n\n.swipe_picker_block.wbm-picked {\n    box-shadow: inset 3px 0 0 var(--SmartThemeEmColor, #9c7bd6);\n}\n\n/* 页码轻触反馈：点到了就能看出来，不用等弹窗 */\n.swipes-counter.wbm-tap-flash {\n    opacity: 1 !important;\n    background-color: color-mix(in srgb, var(--SmartThemeBodyColor, #ffffff) 22%, transparent) !important;\n}\n\n/* 分类面板：勾选框外面那层，44px 命中区（手机点得中） */\n.wbm-cat-pick {\n    flex: 0 0 auto;\n    display: inline-flex;\n    align-items: center;\n    justify-content: center;\n    width: 44px;\n    height: 44px;\n    margin: -10px -8px -10px 0;\n    cursor: pointer;\n}\n";
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
            if (host && root && host.getAttribute('data-wbm-ready') === '1') {
                watchdogTries = 0;
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
