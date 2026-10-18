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

    const VERSION = '1.0.4';
    /* 构建标记：版本号不随小修变化（都写 1.0.3），只看版本号分不出新旧，
       所以另外标一个构建号，控制台里能直接看出页面跑的是哪一份。
       发布时与 manifest 里 js/css 的 ?ver 保持一致（构建脚本会校验）。 */
    const BUILD = '1.0.4';
    const ROOT_ID = 'wbm-list';
    const COLLAPSED_COUNT = 5;

    if (window.__worldbookEnhance === VERSION) {
        console.warn('[wbm] 已有一份 v' + VERSION + ' 在跑，这一份被跳过（多半是同目录里留了旧副本）：build=' + BUILD);
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

    function fireChange(node) {
        if (!node) return;
        if (window.jQuery) { window.jQuery(node).trigger('change'); return; }
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
        searchScope: SEARCH_SCOPE_VALUES.slice(),
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
                store.searchScope = normalizeSearchScope(cfg.searchScope, SEARCH_SCOPE_VALUES.slice());
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
            cfg.searchScope = normalizeSearchScope(store.searchScope, SEARCH_SCOPE_VALUES.slice());
            store.searchScope = cfg.searchScope.slice();
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

    function updateEditorButton() {
        const btn = document.querySelector('.wbm-editor-btn');
        if (!btn) return;
        const name = currentEditingName();
        btn.textContent = name ? '编辑中：' + name : EDITOR_PLACEHOLDER;
        btn.classList.toggle('active', !!name);
    }

    function fillEditorPickerList(list) {
        const sel = editorSelect();
        if (!sel) return;
        const current = String(sel.value || '');
        list.textContent = '';

        const none = el('div', 'wbm-picker-row wbm-picker-exit' + (current === '' ? ' active' : ''));
        none.dataset.role = 'picker-row';
        none.dataset.value = '';
        none.dataset.name = '--- 选择以编辑 ---';
        none.appendChild(el('span', 'wbm-picker-name', '--- 选择以编辑 ---'));
        none.appendChild(el('span', 'wbm-picker-radio'));
        list.appendChild(none);

        let count = 0;
        for (const opt of sel.options) {
            const value = String(opt.value || '');
            const name = String(opt.textContent || '').trim();
            if (value === '' || !name) continue;
            const row = el('div', 'wbm-picker-row' + (value === current ? ' active' : ''));
            row.dataset.role = 'picker-row';
            row.dataset.value = value;
            row.dataset.name = name;
            row.appendChild(el('span', 'wbm-picker-name', name));
            row.appendChild(el('span', 'wbm-picker-radio'));
            list.appendChild(row);
            count += 1;
        }
        if (count === 0) list.appendChild(el('div', 'wbm-none', '还没有世界书'));
    }

    function filterEditorPicker(query) {
        const mask = state.picker;
        if (!mask || !mask.isConnected) return;
        const q = String(query || '').trim().toLowerCase();
        let hits = 0;
        mask.querySelectorAll('.wbm-picker-row').forEach((row) => {
            const name = String(row.dataset.name || '').toLowerCase();
            const hit = !q || name.indexOf(q) !== -1;
            row.style.display = hit ? '' : 'none';
            if (hit && row.dataset.value !== '') hits += 1;
        });
        const empty = mask.querySelector('.wbm-picker-empty');
        if (empty) empty.style.display = (q && hits === 0) ? '' : 'none';
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
            fillEditorPickerList(list);
            const empty = el('div', 'wbm-picker-empty', '没有匹配的世界书');
            empty.style.display = 'none';
            list.appendChild(empty);

            sheet.appendChild(grip);
            sheet.appendChild(head);
            sheet.appendChild(list);

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
            const targets = allBooks().map((b) => b.name).filter((name) => name !== sourceWorld);
            targets.forEach((name) => {
                const row = el('div', 'wbm-picker-row');
                row.dataset.name = name;
                row.appendChild(el('span', 'wbm-picker-name', name));
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
                const clone = structuredClone(entry);
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
        const bookName = currentEditingName();
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
                const targets = allBooks().map((b) => b.name).filter((name) => name !== bookName);
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
                            row.appendChild(el('span', 'wbm-picker-name', name));
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
    };
    /* 这几个字段在酒馆数据里还有一份旧格式镜像，写回时要一起同步（撤销用） */
    const UNDO_FIELD_KEYS = {
        depth: 'extensions.depth',
        order: 'insertion_order',
        probability: 'extensions.probability',
        automationId: 'extensions.automation_id',
    };

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
        try {
            if (node.closest('.select2-container') && $) return;
            if (typeof node.showPicker === 'function') {
                node.showPicker();
                return;
            }
        } catch (err) { /* 落到下面的兜底 */ }
        /* 没有 showPicker 的浏览器：临时放开一下，让用户直接点 */
        node.classList.add('wbm-field-editing');
        node.removeAttribute('readonly');
        setTimeout(() => {
            node.classList.remove('wbm-field-editing');
            if (clickLockOn()) lockControl(node);
        }, 8000);
        toast('info', '这里已临时解锁，8 秒内可以直接选择');
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
            if (!node.matches('input, textarea, select')) return;
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
        return bar;
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
        /* 搜索范围的小键在搜索框那一行、和批量条无关，每次渲染都确认一遍（幂等）；
           宿主筛选接管也在第一次渲染时装上，别等到"点了筛选键"才装。 */
        ensureSearchScopeBar();
        ensureFilterPatch();
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

        /* 编辑保护是独立的一类，不和筛选混在一行：单独一个小框 */
        const lockGroup = el('div', 'wbm-tool-group');
        lockGroup.appendChild(el('span', 'wbm-favbar-label', '编辑保护'));
        const lockChip = el('button', 'menu_button wbm-chip wbm-batch-btn' + (clickLockOn() ? ' on' : ''), lockChipLabel());
        lockChip.type = 'button';
        lockChip.dataset.role = 'entry-clicklock';
        lockChip.title = clickLockOn()
            ? '单击编辑：已锁定 —— 条目里想改就双击那个字段；复选框与下拉双击才生效'
            : '单击编辑：已启用 —— 条目内容恢复成点一下就改';
        lockChip.addEventListener('click', (event) => {
            event.preventDefault();
            event.stopPropagation();
            const next = !clickLockOn();
            setClickLock(next);
            lockEntryContents();
            toast('info', next
                ? '单击编辑已锁定：字段双击才改，改完按「保存」；复选框与下拉双击即生效'
                : '单击编辑已启用：条目内容恢复成点一下就改');
        });
        lockGroup.appendChild(lockChip);

        bar.appendChild(dataGroup);
        bar.appendChild(checkGroup);
        bar.appendChild(lockGroup);
        entriesList.parentNode.insertBefore(bar, entriesList);
        if (!entriesList.parentNode.querySelector('.wbm-entry-favbar')) {
            entriesList.parentNode.insertBefore(buildEntryFavBar(), entriesList);
        }
    }

    /* 接管 ST 的「移动/复制条目」按钮（.move_entry_button）：捕获阶段拦下，
       原生那个只有下拉框、位置又怪的 Popup 就不再出现 */
    function bindMoveEntryHook() {
        document.addEventListener('click', (event) => {
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
        const sel = editorSelect();
        if (!sel || !sel.parentNode) return;
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
        if (!host) return;

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
            root.appendChild(favBar);
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

    function bindPanelWatcher() {
        const icon = document.getElementById('WIDrawerIcon');
        if (!icon || icon.dataset.wbmWatch === '1') return;
        icon.dataset.wbmWatch = '1';
        icon.addEventListener('click', () => {
            /* 抽屉有切换动画，等它落定后再判断是开还是关 */
            setTimeout(() => {
                if (panelVisible()) { verifyMount(); } else { resetPanelState(); }
            }, 420);
        });
    }

    /* 手势：完全交给浏览器原生滚动 + 原生链式滚动（overscroll-behavior: auto）。
       曾经试过用 JS 接管（到边界就手动写外层 scrollTop），结果是和原生链式叠加：
       撞顶那一下会跳、脱离边界后的速度也不对。人性化的做法是自己不插手。 */

    /* ---------------- 启动 ---------------- */

    let bootTries = 0;

    function boot() {
        const host = hostEl();
        if (!host) {
            bootTries += 1;
            if (bootTries <= 20) setTimeout(boot, 500);
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
        ensureBatchBar();
        bindPreviewHook();
        silenceMobileResizeHack();
        /* 收藏存在酒馆本地设置里：读回来之后再刷新一次界面，避免首帧空收藏 */
        loadStore().then(() => {
            state.signature = '';
            render();
            injectPreviewButtons();
            applyEntryFavFilter();
        });
        updateEditorButton();
        /* 预载 ST 的搬运函数；拿不到就不接管「移动/复制」，原生弹窗照旧（fail-safe） */
        loadMoveFn().then((fn) => {
            if (!fn) return;
            moveEntryFn = fn;
            bindMoveEntryHook();
            bindDeleteEntryHook();
        });
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
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', boot, { once: true });
    } else {
        boot();
    }
})();
