(function() {
  'use strict';

  const DB_NAME = 'funloom_engine_local_repository';
  const STORE_STORIES = 'stories';
  const STORE_MEDIA = 'media';

  // ==================== IndexedDB 操作 ====================

  function openDB() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(new Error('无法打开 IndexedDB'));
      request.onblocked = () => reject(new Error('IndexedDB 被阻塞'));
    });
  }

  function getAllStories(db) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_STORIES, 'readonly');
      const store = tx.objectStore(STORE_STORIES);
      const req = store.getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(new Error('读取项目列表失败'));
    });
  }

  function getMediaById(db, mediaId) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_MEDIA, 'readonly');
      const store = tx.objectStore(STORE_MEDIA);
      const req = store.get(mediaId);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(new Error('读取媒体失败: ' + mediaId));
    });
  }

  function putStory(db, story) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_STORIES, 'readwrite');
      const store = tx.objectStore(STORE_STORIES);
      const req = store.put(story);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(new Error('保存项目失败'));
    });
  }

  // ==================== 工具函数 ====================

  function blobToBase64(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onloadend = () => resolve(reader.result);
      reader.onerror = () => reject(new Error('Blob 转 base64 失败'));
      reader.readAsDataURL(blob);
    });
  }

  // ==================== 自动抠图（已移除） ====================

  function escapeHtml(text) {
    if (typeof text !== 'string') return text || '';
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function nl2br(text) {
    return escapeHtml(text).replace(/\n/g, '<br>');
  }

  // 安全地将 JSON 嵌入 <script> 标签
  // 只需转义 < 为 \u003c（有效的 JSON Unicode 转义），防止 </script> 关闭标签
  // 不要使用 HTML 实体编码，因为 <script> 的 textContent 不会解码实体
  function safeJsonForScript(jsonString) {
    return jsonString.replace(/</g, '\\u003c');
  }

  // ==================== 收集媒体引用 ====================

  function collectMediaRefs(project) {
    const refs = new Map();

    function addRef(mediaObj) {
      if (!mediaObj || typeof mediaObj !== 'object') return;
      if (mediaObj.source === 'local' && mediaObj.mediaId) {
        refs.set(mediaObj.mediaId, mediaObj);
      }
    }

    const allNodes = [
      ...(project.nodes || []),
      ...(project.scripts?.flatMap(s => s.nodes || []) || []),
      ...(project.projectFlow?.nodes || [])
    ];

    allNodes.forEach(node => {
      const data = node.data || {};
      addRef(data.video);
      (data.videoSequence?.segments || []).forEach(seg => addRef(seg.video));
      (data.storyboardVersions || []).forEach(ver => {
        addRef(ver.video);
        addRef(ver.pendingVideo);
        addRef(ver.storyboard?.videoJob?.video);
        (ver.videoSequence?.segments || []).forEach(seg => addRef(seg.video));
        (ver.pendingVideoSequence?.segments || []).forEach(seg => addRef(seg.video));
      });
      // 收集节点背景图片
      if (data.backgroundImage && data.backgroundImage.type === 'local' && data.backgroundImage.mediaId) {
        refs.set(data.backgroundImage.mediaId, data.backgroundImage);
      }
    });

    (project.assets?.characters || []).forEach(char => {
      addRef(char.portrait);
      (char.referenceImages || []).forEach(addRef);
      (char.variants || []).forEach(v => {
        addRef(v.image);
        (v.referenceImages || []).forEach(addRef);
      });
    });

    (project.assets?.scenes || []).forEach(scene => {
      addRef(scene.background);
      (scene.referenceImages || []).forEach(addRef);
      (scene.variants || []).forEach(v => {
        addRef(v.image);
        (v.referenceImages || []).forEach(addRef);
      });
    });

    (project.assets?.videos || []).forEach(addRef);

    return refs;
  }

  // ==================== 图片 URL 解析 ====================

  function resolveImageUrl(mediaObj, mediaMap) {
    if (!mediaObj || typeof mediaObj !== 'object') return null;

    if (mediaObj.absoluteUrl) return mediaObj.absoluteUrl;
    if (mediaObj.url && !mediaObj.url.startsWith('blob:')) return mediaObj.url;

    if (mediaObj.source === 'local' && mediaObj.mediaId && mediaMap.has(mediaObj.mediaId)) {
      return mediaMap.get(mediaObj.mediaId);
    }

    return null;
  }

  // ==================== 主题定义 ====================

  const THEMES = {
    dark: {
      '--bg': '#0f1115',
      '--card': '#1a1d24',
      '--border': '#2a2e38',
      '--text': '#e2e4e9',
      '--text-dim': '#8b92a8',
      '--accent': '#5b8cff',
      '--accent-dim': '#3d5a99',
      '--plot': '#4ade80',
      '--option': '#fbbf24',
      '--ending': '#f87171',
      '--minigame': '#a78bfa'
    },
    light: {
      '--bg': '#f5f5f5',
      '--card': '#ffffff',
      '--border': '#e0e0e0',
      '--text': '#333333',
      '--text-dim': '#888888',
      '--accent': '#2563eb',
      '--accent-dim': '#93c5fd',
      '--plot': '#16a34a',
      '--option': '#d97706',
      '--ending': '#dc2626',
      '--minigame': '#7c3aed'
    }
  };

  function buildThemeCss(themeName) {
    const vars = THEMES[themeName] || THEMES.dark;
    const entries = Object.entries(vars).map(([k, v]) => `${k}:${v}`).join(';');
    return `:root{${entries}}`;
  }

  // ==================== HTML 生成（可交互播放器） ====================

  function generateHTML(project, mediaMap, themeName, options) {
    var opts = options || {};
    var isPreview = !!opts.isPreview;
    var allowThemeToggle = isPreview; // 下载后不能改主题颜色，预览时可以
    var endingSettings = opts.endingSettings || {};
    // 结局设置默认值
    var showLockedEndings = endingSettings.showLockedEndings !== false; // 默认显示未解锁结局
    var hideLockedEndingNames = !!endingSettings.hideLockedEndingNames; // 默认不隐藏
    var endingClues = endingSettings.endingClues || {}; // { endingNodeId: '线索文字' }
    // 发布设置：隐藏部分UI功能
    var publishSettings = endingSettings.publishSettings || {};
    var hideEndingGallery = !!publishSettings.hideEndingGallery; // 隐藏结局查询
    var hideVarsPanel = !!publishSettings.hideVarsPanel; // 隐藏变量面板
    var hideRestartBtn = !!publishSettings.hideRestartBtn; // 隐藏重新开始按钮
    var hideTitleScreen = !!publishSettings.hideTitleScreen; // 隐藏标题页直接开始
    var hiddenVariables = publishSettings.hiddenVariables || []; // 隐藏的变量ID列表
    var hiddenEndings = publishSettings.hiddenEndings || []; // 隐藏的结局ID列表

    const outline = project.outline || {};
    const title = outline.projectTitle || '未命名剧本';
    const theme = themeName || 'dark';
    // 导出文件名（含前缀），用于下载页面按钮
    var exportFileName = endingSettings.exportFileName || title;

    // 预处理：构建媒体 URL 映射表（把 mediaId -> 可用 URL）
    const mediaUrlMap = {};
    for (const [mediaId, base64] of mediaMap) {
      mediaUrlMap[mediaId] = base64;
    }

    // 预处理：遍历项目中的所有媒体对象，解析出可用 URL
    function resolveAllMedia(obj) {
      if (!obj || typeof obj !== 'object') return obj;
      if (Array.isArray(obj)) return obj.map(resolveAllMedia);
      const result = { ...obj };
      if (obj.source === 'local' && obj.mediaId) {
        if (mediaUrlMap[obj.mediaId]) {
          result._resolvedUrl = mediaUrlMap[obj.mediaId];
        }
      }
      if (obj.absoluteUrl) result._resolvedUrl = obj.absoluteUrl;
      else if (obj.url && typeof obj.url === 'string' && !obj.url.startsWith('blob:')) {
        result._resolvedUrl = obj.url;
      }
      for (const key of Object.keys(result)) {
        if (typeof result[key] === 'object' && result[key] !== null) {
          result[key] = resolveAllMedia(result[key]);
        }
      }
      return result;
    }

    const projectData = resolveAllMedia(project);

    // 将项目数据序列化为 JSON，并安全转义
    const projectJson = safeJsonForScript(JSON.stringify(projectData));

    const themeCss = buildThemeCss(theme);

    let html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="mobile-web-app-capable" content="yes">
<title>${escapeHtml(title)}</title>
<style>
${themeCss}
*{box-sizing:border-box;margin:0;padding:0;-webkit-tap-highlight-color:transparent;-webkit-touch-callout:none}
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;background:var(--bg);color:var(--text);line-height:1.7;min-height:100vh;display:flex;flex-direction:column;transition:background .3s,color .3s;-webkit-user-select:none;user-select:none;-webkit-text-size-adjust:100%;text-size-adjust:100%;overflow-x:hidden;touch-action:manipulation}
#game-root{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:24px;max-width:720px;margin:0 auto;width:100%;padding-top:max(24px,env(safe-area-inset-top));padding-bottom:max(24px,env(safe-area-inset-bottom));padding-left:max(24px,env(safe-area-inset-left));padding-right:max(24px,env(safe-area-inset-right))}
.game-title{font-size:1.8rem;color:var(--text);margin-bottom:8px;text-align:center}
.game-subtitle{color:var(--text-dim);font-size:0.95rem;margin-bottom:24px;text-align:center}
.node-card{background:var(--card);border:1px solid var(--border);border-radius:16px;padding:28px;width:100%;margin-bottom:16px;position:relative;overflow:hidden;animation:fadeIn .4s ease}
.node-card.with-bg{background-size:cover;background-position:center;background-blend-mode:overlay}
.node-card.with-bg::before{content:"";position:absolute;inset:0;background:rgba(0,0,0,.45);z-index:0}
.node-card.with-bg.light-bg::before{background:rgba(255,255,255,.55)}
.node-card.with-bg>*{position:relative;z-index:1}
@keyframes fadeIn{from{opacity:0;transform:translateY(12px)}to{opacity:1;transform:translateY(0)}}
.node-card.ending{border-color:rgba(248,113,113,.3)}
.node-card.minigame{border-color:rgba(167,139,250,.3)}
.node-type-badge{display:inline-block;font-size:0.7rem;font-weight:700;text-transform:uppercase;padding:3px 12px;border-radius:6px;margin-bottom:12px;background:rgba(90,222,128,.15);color:var(--plot)}
.node-type-badge.ending{background:rgba(248,113,113,.15);color:var(--ending)}
.node-type-badge.minigame{background:rgba(167,139,250,.15);color:var(--minigame)}
.node-title{font-size:1.3rem;font-weight:600;margin-bottom:12px;color:var(--text)}
.node-body{color:var(--text);white-space:pre-wrap;margin-bottom:16px;font-size:1rem;-webkit-user-select:text;user-select:text}
.node-media{width:100%;border-radius:12px;margin-bottom:16px;max-height:400px;object-fit:contain;background:#000}
.node-video{width:100%;border-radius:12px;margin-bottom:16px;max-height:400px;background:#000}
/* 视觉小说式对话框 */
.vn-dialogue-area{position:relative;margin-bottom:16px;min-height:60px}
.vn-character-portrait{position:absolute;bottom:0;left:0;width:120px;height:160px;object-fit:contain;z-index:2;pointer-events:none;filter:drop-shadow(2px 4px 8px rgba(0,0,0,.4))}
.vn-character-portrait.right{left:auto;right:0}
.vn-dialogue-box{background:rgba(0,0,0,.65);border-radius:12px;padding:16px 20px;margin-left:0;position:relative;cursor:pointer;transition:background .2s;min-height:50px;display:flex;flex-direction:column;justify-content:center}
.vn-dialogue-box.light-bg{background:rgba(255,255,255,.75);color:#1a1a2e}
.vn-dialogue-box:hover{background:rgba(0,0,0,.72)}
.vn-dialogue-box.light-bg:hover{background:rgba(255,255,255,.82)}
.vn-dialogue-box.with-portrait-left{margin-left:130px}
.vn-dialogue-box.with-portrait-right{margin-right:130px}
.vn-speaker-name{font-size:0.9rem;font-weight:700;color:#a78bfa;margin-bottom:6px;display:flex;align-items:center;gap:6px}
.vn-speaker-name::before{content:"";display:inline-block;width:3px;height:14px;background:#a78bfa;border-radius:2px}
.vn-dialogue-box.light-bg .vn-speaker-name{color:#6d28d9}
.vn-dialogue-box.light-bg .vn-speaker-name::before{background:#6d28d9}
.vn-dialogue-text{font-size:1rem;line-height:1.8;white-space:pre-wrap;-webkit-user-select:text;user-select:text}
.vn-dialogue-text.fade-in{animation:vnTextFade .35s ease}
@keyframes vnTextFade{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:translateY(0)}}
.vn-advance-hint{text-align:right;font-size:0.75rem;color:rgba(255,255,255,.4);margin-top:6px;animation:vnBlink 1.2s infinite}
.vn-dialogue-box.light-bg .vn-advance-hint{color:rgba(0,0,0,.35)}
.mg-embed-wrap{position:relative;width:100%;margin-top:12px;touch-action:auto}
.mg-iframe{width:100%;height:60vh;min-height:300px;max-height:600px;border:1px solid var(--border);border-radius:12px;background:#000;transition:opacity .3s ease;touch-action:auto}
.mg-iframe.mg-done{opacity:.4;pointer-events:none}
.mg-loading{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;background:var(--card);border-radius:12px;color:var(--text-dim);font-size:.9rem}
.mg-feedback{animation:mgPopIn .4s ease;text-align:center;padding:20px;border-radius:12px;font-size:1rem}
@keyframes mgPopIn{from{opacity:0;transform:scale(.9)}to{opacity:1;transform:scale(1)}}
.mg-feedback .mg-fb-icon{font-size:2.5rem;margin-bottom:8px}
.mg-feedback .mg-fb-title{font-size:1.4rem;font-weight:700}
.mg-feedback .mg-fb-sub{font-size:.85rem;color:var(--text-dim);margin-top:6px}
@keyframes vnBlink{0%,100%{opacity:.3}50%{opacity:.8}}
.vn-paragraphs-done{opacity:.5;transition:opacity .3s}
.options-list{display:flex;flex-direction:column;gap:10px;margin-top:16px}
.option-btn{display:block;width:100%;text-align:left;padding:14px 18px;border-radius:12px;border:1px solid var(--border);background:rgba(251,191,36,.06);color:var(--text);cursor:pointer;font-size:1rem;transition:all .2s;font-family:inherit;min-height:48px}
.option-btn:hover{background:rgba(251,191,36,.12);border-color:var(--option);transform:translateX(4px)}
.option-btn:active{transform:translateX(2px) scale(.99);background:rgba(251,191,36,.18)}
.option-btn.disabled{opacity:.4;cursor:not-allowed;pointer-events:none}
.option-title{font-weight:600;margin-bottom:2px}
.option-body{color:var(--text-dim);font-size:0.9rem}
.option-condition{font-size:0.75rem;color:var(--text-dim);margin-top:4px;font-style:italic}
.no-options{color:var(--text-dim);text-align:center;padding:20px;font-style:italic}
.ending-card{text-align:center;padding:40px 28px}
.ending-card .node-title{font-size:1.6rem}
.restart-btn{margin-top:24px;padding:14px 32px;border-radius:10px;border:1px solid var(--accent-dim);background:rgba(91,140,255,.1);color:var(--accent);cursor:pointer;font-size:1rem;transition:all .2s;font-family:inherit;min-height:48px}
.restart-btn:hover{background:rgba(91,140,255,.2);border-color:var(--accent)}
.restart-btn:active{background:rgba(91,140,255,.3);transform:scale(.98)}
.history-bar{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:16px;justify-content:center}
.history-dot{width:8px;height:8px;border-radius:50%;background:var(--border);transition:background .3s}
.history-dot.visited{background:var(--accent)}
.vars-panel{position:fixed;top:16px;right:16px;background:var(--card);border:1px solid var(--border);border-radius:10px;padding:12px 16px;font-size:0.8rem;color:var(--text-dim);z-index:100;max-width:200px;display:none}
.vars-panel.visible{display:block}
.vars-panel .var-item{display:flex;justify-content:space-between;gap:12px;margin-bottom:4px}
.vars-panel .var-name{color:var(--text)}
.vars-panel .var-value{color:var(--accent)}
.footer{text-align:center;padding:20px;color:var(--text-dim);font-size:0.8rem;border-top:1px solid var(--border)}
.loading{color:var(--text-dim);text-align:center;padding:40px}
.theme-toggle{position:fixed;top:max(16px,env(safe-area-inset-top));left:max(16px,env(safe-area-inset-left));z-index:100;padding:8px 14px;border-radius:8px;border:1px solid var(--border);background:var(--card);color:var(--text);cursor:pointer;font-size:0.8rem;font-family:inherit;transition:all .2s;min-height:40px}
.theme-toggle:hover{border-color:var(--accent)}
.theme-toggle:active{transform:scale(.95)}
.download-btn{position:fixed;top:max(16px,env(safe-area-inset-top));left:calc(110px + env(safe-area-inset-left));z-index:100;padding:8px 14px;border-radius:8px;border:1px solid var(--border);background:var(--card);color:var(--accent);cursor:pointer;font-size:0.8rem;font-family:inherit;transition:all .2s;min-height:40px}
.download-btn:hover{border-color:var(--accent);background:rgba(91,140,255,.1)}
.download-btn:active{transform:scale(.95)}
@media(max-width:640px){
  #game-root{padding:12px;padding-top:max(12px,env(safe-area-inset-top));padding-bottom:max(12px,env(safe-area-inset-bottom));padding-left:max(12px,env(safe-area-inset-left));padding-right:max(12px,env(safe-area-inset-right))}
  .node-card{padding:18px;border-radius:14px;margin-bottom:12px}
  .game-title{font-size:1.4rem;margin-bottom:6px}
  .game-subtitle{font-size:0.85rem;margin-bottom:18px}
  .node-title{font-size:1.15rem;margin-bottom:10px}
  .node-body{font-size:0.95rem;margin-bottom:14px}
  .node-media,.node-video{max-height:260px;border-radius:10px;margin-bottom:14px}
  .vn-dialogue-box{padding:14px 16px;border-radius:10px;min-height:48px}
  .vn-dialogue-text{font-size:0.95rem;line-height:1.75}
  .vn-speaker-name{font-size:0.85rem;margin-bottom:4px}
  .vn-character-portrait{width:72px;height:100px}
  .vn-dialogue-box.with-portrait-left{margin-left:82px}
  .vn-dialogue-box.with-portrait-right{margin-right:82px}
  .mg-iframe{height:55vh;min-height:280px;max-height:500px;border-radius:10px}
  .mg-feedback{padding:16px}
  .mg-feedback .mg-fb-icon{font-size:2rem}
  .mg-feedback .mg-fb-title{font-size:1.2rem}
  .options-list{gap:8px;margin-top:14px}
  .option-btn{padding:12px 16px;font-size:0.95rem;min-height:44px;border-radius:10px}
  .option-btn:hover{transform:none}
  .option-btn:active{transform:scale(.98)}
  .ending-card{padding:28px 18px}
  .ending-card .node-title{font-size:1.35rem}
  .restart-btn{padding:12px 28px;font-size:0.95rem;margin-top:18px}
  .vars-panel{top:max(8px,env(safe-area-inset-top));right:max(8px,env(safe-area-inset-right));max-width:150px;font-size:0.7rem;padding:8px 10px}
  .theme-toggle{top:max(8px,env(safe-area-inset-top));left:max(8px,env(safe-area-inset-left));padding:6px 12px;font-size:0.75rem;min-height:36px}
  .download-btn{top:max(8px,env(safe-area-inset-top));left:calc(88px + env(safe-area-inset-left));padding:6px 12px;font-size:0.75rem;min-height:36px}
  .footer{padding:14px;font-size:0.72rem}
  .history-dot{width:6px;height:6px}
}
@media(max-width:380px){
  #game-root{padding:8px;padding-top:max(8px,env(safe-area-inset-top));padding-bottom:max(8px,env(safe-area-inset-bottom))}
  .node-card{padding:14px;border-radius:12px}
  .game-title{font-size:1.2rem}
  .node-title{font-size:1.05rem}
  .vn-dialogue-text{font-size:0.9rem}
  .mg-iframe{height:50vh;min-height:240px;border-radius:8px}
  .vn-character-portrait{width:60px;height:84px}
  .vn-dialogue-box.with-portrait-left{margin-left:68px}
  .vn-dialogue-box.with-portrait-right{margin-right:68px}
  .vars-panel{display:none!important}
}
@media(orientation:landscape) and (max-height:500px){
  #game-root{justify-content:flex-start;padding-top:max(8px,env(safe-area-inset-top))}
  .mg-iframe{height:calc(100vh - 140px);min-height:200px;max-height:none}
  .node-card{padding:14px 18px}
  .game-title{font-size:1.1rem;margin-bottom:4px}
  .game-subtitle{font-size:0.8rem;margin-bottom:10px}
}
</style>
</head>
<body>
<div id="game-root"></div>
<div id="vars-panel" class="vars-panel"></div>
<button class="theme-toggle" id="theme-toggle" onclick="toggleTheme()" ${allowThemeToggle ? '' : 'style="display:none"'}>切换主题</button>
${isPreview ? '<button class="download-btn" id="download-btn" onclick="downloadPage()">下载页面</button>' : ''}
<script id="project-data" type="application/json">${projectJson}</script>
<script>
(function(){
  'use strict';

  var ENDING_SETTINGS = {
    showLockedEndings: ${showLockedEndings ? 'true' : 'false'},
    hideLockedEndingNames: ${hideLockedEndingNames ? 'true' : 'false'},
    endingClues: ${JSON.stringify(endingClues).replace(/</g, '\\u003c')},
    publishSettings: {
      hideEndingGallery: ${hideEndingGallery ? 'true' : 'false'},
      hideVarsPanel: ${hideVarsPanel ? 'true' : 'false'},
      hideRestartBtn: ${hideRestartBtn ? 'true' : 'false'},
      hideTitleScreen: ${hideTitleScreen ? 'true' : 'false'},
      hiddenVariables: ${JSON.stringify(hiddenVariables).replace(/</g, '\\u003c')},
      hiddenEndings: ${JSON.stringify(hiddenEndings).replace(/</g, '\\u003c')}
    }
  };
  var EXPORT_FILE_NAME = ${JSON.stringify(exportFileName).replace(/</g, '\\u003c')};
  var reachedEndings = {}; // 记录已达成的结局
  var ALL_ENDINGS = []; // 收集所有结局节点

  // 导出的 HTML 中 project 参数不存在，只从 #project-data 读取
  var domProject = null;
  try {
    var domEl = document.getElementById('project-data');
    if (domEl) domProject = JSON.parse(domEl.textContent);
  } catch(e) { console.error('[generateHTML] 解析 project-data 失败:', e); }
  var PROJECT = domProject || {};
  console.log('[generateHTML] 使用项目数据, 标题:', 
    (PROJECT.outline && PROJECT.outline.projectTitle) || '(无)',
    '小游戏资产:', (PROJECT.assets && PROJECT.assets.minigames) ? PROJECT.assets.minigames.length : 0);

  // 收集所有节点和边（可能在顶层、scripts 或 projectFlow 中）
  var nodes = [];
  var edges = [];
  // 从所有来源收集并合并变量数据
  // 深度递归搜索：遍历整个项目数据树，查找所有看起来像变量的对象
  var varMap = {};
  function mergeVar(v) {
    if (!v || !v.id || typeof v !== 'object') return;
    // 必须看起来像变量对象：有 id 且有 type 或 initialValue 或 name
    if (!('type' in v) && !('initialValue' in v) && !('name' in v)) return;
    var existing = varMap[v.id];
    if (!existing) {
      varMap[v.id] = Object.assign({}, v);
    } else {
      // 合并：优先取非 undefined/null 的值
      Object.keys(v).forEach(function(key) {
        var newVal = v[key];
        if (newVal !== undefined && newVal !== null) {
          var oldVal = existing[key];
          if (oldVal === undefined || oldVal === null) {
            existing[key] = newVal;
          } else if (key === 'initialValue') {
            // 对于 initialValue：取非零的有效值
            var oldNum = Number(oldVal);
            var newNum = Number(newVal);
            var oldValid = !isNaN(oldNum) && oldNum !== 0;
            var newValid = !isNaN(newNum) && newNum !== 0;
            // 如果旧值无效（0/空/NaN）而新值有效，用新值
            if (!oldValid && newValid) {
              existing[key] = newVal;
            }
            // 如果两个都有效，取绝对值更大的（通常是用户设置的值）
            else if (oldValid && newValid && Math.abs(newNum) > Math.abs(oldNum)) {
              existing[key] = newVal;
            }
            // 字符串类型的非零值优先
            else if (typeof newVal === 'string' && newVal.trim() !== '' && newVal.trim() !== '0') {
              if (typeof oldVal !== 'string' || oldVal.trim() === '' || oldVal.trim() === '0') {
                existing[key] = newVal;
              }
            }
          }
        }
      });
    }
  }

  // 深度递归搜索项目数据中的所有变量
  function deepCollectVariables(obj, depth) {
    if (!obj || typeof obj !== 'object' || depth > 10) return;
    if (Array.isArray(obj)) {
      obj.forEach(function(item) { deepCollectVariables(item, depth + 1); });
      return;
    }
    // 检查是否是变量对象
    if (obj.id && (obj.type === 'int' || obj.type === 'bool' || obj.type === 'enum') &&
        ('initialValue' in obj || 'name' in obj)) {
      mergeVar(obj);
    }
    // 递归搜索子属性
    for (var key in obj) {
      if (obj.hasOwnProperty(key) && typeof obj[key] === 'object' && obj[key] !== null) {
        deepCollectVariables(obj[key], depth + 1);
      }
    }
  }

  // 1. 先从已知位置收集
  (PROJECT.variables || []).forEach(mergeVar);
  if (PROJECT.scripts) {
    PROJECT.scripts.forEach(function(s) {
      (s.variables || []).forEach(mergeVar);
    });
  }
  if (PROJECT.outline && PROJECT.outline.variables) {
    PROJECT.outline.variables.forEach(mergeVar);
  }
  // 2. 深度递归搜索整个项目数据，确保不遗漏任何位置的变量
  deepCollectVariables(PROJECT, 0);

  var variables = Object.keys(varMap).map(function(k) { return varMap[k]; });

  // 调试日志：帮助诊断变量同步问题
  console.log('[变量同步诊断] 收集到变量:', variables.length, '个');
  variables.forEach(function(v) {
    console.log('[变量]', v.name, '(', v.id, ')', 'type:', v.type, 'initialValue:', v.initialValue);
  });
  var entryNodeId = PROJECT.entryNodeId;

  // 顶层
  if (PROJECT.nodes) nodes = nodes.concat(PROJECT.nodes);
  if (PROJECT.edges) edges = edges.concat(PROJECT.edges);

  // scripts 中的节点和边
  if (PROJECT.scripts) {
    PROJECT.scripts.forEach(function(s) {
      if (s.nodes) nodes = nodes.concat(s.nodes);
      if (s.edges) edges = edges.concat(s.edges);
      if (s.entryNodeId && !entryNodeId) entryNodeId = s.entryNodeId;
    });
  }

  // projectFlow 中的节点和边
  if (PROJECT.projectFlow) {
    if (PROJECT.projectFlow.nodes) nodes = nodes.concat(PROJECT.projectFlow.nodes);
    if (PROJECT.projectFlow.edges) edges = edges.concat(PROJECT.projectFlow.edges);
  }

  // 去重（按 id）
  var seenNodeIds = {};
  nodes = nodes.filter(function(n) {
    if (seenNodeIds[n.id]) return false;
    seenNodeIds[n.id] = true;
    return true;
  });
  var seenEdgeIds = {};
  edges = edges.filter(function(e) {
    if (seenEdgeIds[e.id]) return false;
    seenEdgeIds[e.id] = true;
    return true;
  });

  // 构建节点映射
  var nodeMap = {};
  nodes.forEach(function(n){ nodeMap[n.id] = n; });

  // 构建小游戏资产映射（minigameAssetId -> 资产对象）
  var minigameAssetMap = {};
  if (PROJECT.assets && PROJECT.assets.minigames) {
    PROJECT.assets.minigames.forEach(function(mg) {
      if (mg && mg.minigameId) minigameAssetMap[mg.minigameId] = mg;
    });
  }
  console.log('[小游戏资产] 共加载', Object.keys(minigameAssetMap).length, '个小游戏资产');

  //从小游戏资产文件构建内联HTML（与主应用 tm() 函数逻辑一致）
  function buildMinigameHtmlFromAsset(asset) {
    if (!asset || !asset.files || !Array.isArray(asset.files)) return '';
    // 查找 index.html
    var entryFile = null;
    for (var i = 0; i < asset.files.length; i++) {
      if (asset.files[i].path === 'index.html') {
        entryFile = asset.files[i];
        break;
      }
    }
    if (!entryFile) {
      console.warn('[小游戏资产] 未找到 index.html');
      return '';
    }
    // 解码 index.html 内容
    var htmlContent = '';
    try {
      var binary = atob(entryFile.dataBase64 || '');
      var bytes = new Uint8Array(binary.length);
      for (var j = 0; j < binary.length; j++) bytes[j] = binary.charCodeAt(j);
      htmlContent = new TextDecoder('utf-8').decode(bytes);
    } catch(e) {
      console.error('[小游戏资产] 解码 index.html 失败:', e);
      return '';
    }
    // 构建文件路径 -> data URI 映射
    var fileMap = {};
    asset.files.forEach(function(f) {
      if (f.path && f.dataBase64) {
        fileMap[f.path] = 'data:' + (f.mimeType || 'application/octet-stream') + ';base64,' + f.dataBase64;
      }
    });
    // 路径规范化函数
    function normalizePath(p) {
      var t = p.replace(/\\\\/g, '/').replace(/^\\.\\/+/, '').trim();
      if (!t || t.endsWith('/') || t.startsWith('/') || /^[a-z]:\\//i.test(t)) return null;
      var parts = t.split('/').filter(Boolean);
      if (parts.length === 0 || parts.some(function(p) { return p === '.' || p === '..' || p.indexOf(String.fromCharCode(0)) >= 0; })) return null;
      return parts.join('/');
    }
    // 判断是否为绝对URL
    function isAbsoluteUrl(s) {
      return /^(?:[a-z][a-z0-9+.-]*:|\\/\\/|#)/i.test(s) || s.startsWith('data:') || s.startsWith('blob:');
    }
    // 分离路径和后缀（query+hash）
    function splitPath(url) {
      var m = url.match(/^([^?#]*)(.*)$/);
      return { path: m ? m[1] : url, suffix: m ? m[2] : '' };
    }
    // 替换函数：将相对路径替换为 data URI
    function replaceUrl(urlStr) {
      var s = urlStr.trim();
      if (!s || isAbsoluteUrl(s)) return urlStr;
      var parts = splitPath(s);
      var normalized = normalizePath(parts.path);
      if (!normalized) return urlStr;
      var dataUri = fileMap[normalized];
      return dataUri ? (dataUri + parts.suffix) : urlStr;
    }
    // 替换 src="..." 和 href="..."
    htmlContent = htmlContent.replace(/\\b(src|href)=("([^"]*)"|'([^']*)')/gi, function(match, attr, quoted, dq, sq) {
      var quote = quoted.startsWith("'") ? "'" : '"';
      return attr + '=' + quote + replaceUrl(dq || sq || '') + quote;
    });
    // 替换 url(...)
    htmlContent = htmlContent.replace(/url\\((["']?)([^"')]+)\\1\\)/gi, function(match, quote, url) {
      return 'url(' + quote + replaceUrl(url) + quote + ')';
    });
    console.log('[小游戏资产] HTML构建完成，长度:', htmlContent.length);
    return htmlContent;
  }

  // 收集所有结局节点
  nodes.forEach(function(n){
    var kind = (n.data && n.data.kind) || n.type || '';
    if(kind === 'ending'){
      var endingData = n.data || {};
      ALL_ENDINGS.push({
        id: n.id,
        title: endingData.title || endingData.name || '未知结局',
        body: endingData.body || endingData.description || '',
        clue: ENDING_SETTINGS.endingClues[n.id] || ''
      });
    }
  });

  // 构建出边映射：source -> [edges]
  var outgoingMap = {};
  edges.forEach(function(e){
    if(!outgoingMap[e.source]) outgoingMap[e.source] = [];
    outgoingMap[e.source].push(e);
  });

  // 初始化变量状态
  // 编辑器使用 initialValue 字段，兼容 defaultValue / value / defaultVal
  function getVarDefault(v){
    // 优先使用 initialValue（编辑器实际使用的字段）
    if(v.initialValue !== undefined && v.initialValue !== null && v.initialValue !== '') return v.initialValue;
    // 兼容其他可能的字段名
    if(v.defaultValue !== undefined && v.defaultValue !== null && v.defaultValue !== '') return v.defaultValue;
    if(v.value !== undefined && v.value !== null && v.value !== '') return v.value;
    if(v.defaultVal !== undefined && v.defaultVal !== null && v.defaultVal !== '') return v.defaultVal;
    // 类型默认值
    if(v.type === 'int') return 0;
    if(v.type === 'bool') return false;
    if(v.type === 'enum') return (v.enumOptions && v.enumOptions[0] && v.enumOptions[0].value) || '';
    return '';
  }
  var variableState = {};
  variables.forEach(function(v){
    var val = getVarDefault(v);
    if(v.type === 'int'){
      val = Number(val);
      if(isNaN(val)) val = 0;
    }
    else if(v.type === 'bool') val = val === true || val === 'true' || val === '1' || val === 1;
    else if(v.type === 'enum') val = String(val || '');
    variableState[v.id] = val;
  });

  var variableDefs = {};
  variables.forEach(function(v){ variableDefs[v.id] = v; });

  // 播放历史
  var history = [];
  var root = document.getElementById('game-root');
  var varsPanel = document.getElementById('vars-panel');

  // ==================== 媒体 URL 解析 ====================
  function resolveMediaUrl(mediaObj){
    if(!mediaObj || typeof mediaObj !== 'object') return null;
    if(mediaObj._resolvedUrl) return mediaObj._resolvedUrl;
    if(mediaObj.absoluteUrl) return mediaObj.absoluteUrl;
    if(mediaObj.url && typeof mediaObj.url === 'string' && mediaObj.url.indexOf('blob:') !== 0) return mediaObj.url;
    return null;
  }

  // ==================== 背景图片解析 ====================
  function resolveBackgroundImage(node){
    var data = node.data || {};
    var bg = data.backgroundImage;
    if(!bg) return null;
    var url = null;
    if(bg.type === 'url' && bg.url) url = bg.url;
    else if(bg.type === 'base64' && bg.data) url = bg.data;
    else if(bg.type === 'local' && bg.mediaId){
      if(bg._resolvedUrl) url = bg._resolvedUrl;
      else if(bg.absoluteUrl) url = bg.absoluteUrl;
    }
    else if(typeof bg === 'string') url = bg;
    if(!url) return null;
    // 返回 URL 和调整参数
    return { url: url, adjust: bg.adjust || null };
  }

  // ==================== 人物肖像解析 ====================
  function resolveCharacterPortrait(node){
    var data = node.data || {};
    var charIds = data.characterIds || [];
    if(charIds.length === 0) return null;
    var characters = PROJECT.assets && PROJECT.assets.characters || [];
    var charId = charIds[0];
    var character = characters.find(function(c){ return c.id === charId; });
    if(!character) return null;
    var portrait = character.portrait;
    var portraitUrl = null;
    if(portrait){
      if(typeof portrait === 'string'){
        portraitUrl = portrait;
      } else {
        portraitUrl = resolveMediaUrl(portrait);
        if(!portraitUrl && portrait.data) portraitUrl = portrait.data;
        if(!portraitUrl && portrait.base64) portraitUrl = portrait.base64;
        if(!portraitUrl && portrait.thumbnail) portraitUrl = portrait.thumbnail;
      }
    }
    return {
      name: character.name || character.title || '未知人物',
      portrait: portraitUrl,
      id: charId
    };
  }

  // ==================== 变量条件判断 ====================
  function checkConditions(conditions){
    if(!conditions || conditions.length === 0) return true;
    return conditions.every(function(cond){
      var def = variableDefs[cond.variableId];
      var val = variableState[cond.variableId];
      if(!def || val === undefined) return false;
      if(def.type === 'bool'){
        return cond.operator === 'false' ? !val : !!val;
      }
      if(def.type === 'enum'){
        var cur = String(val || '');
        var target = String(cond.value || '');
        return cond.operator === 'not' ? cur !== target : cur === target;
      }
      var numVal = Number(val) || 0;
      var numTarget = Number(cond.value) || 0;
      switch(cond.operator){
        case 'eq': return numVal === numTarget;
        case 'ne': return numVal !== numTarget;
        case 'gt': return numVal > numTarget;
        case 'lt': return numVal < numTarget;
        case 'gte': return numVal >= numTarget;
        case 'lte': return numVal <= numTarget;
        default: return true;
      }
    });
  }

  // ==================== 应用变量变更 ====================
  function applyMutations(mutations){
    if(!mutations || mutations.length === 0) return;
    mutations.forEach(function(mut){
      var def = variableDefs[mut.variableId];
      if(!def) return;
      var mode = mut.mode;
      if(def.type === 'bool' || def.type === 'enum') mode = 'set';
      if(mode !== 'add' && mode !== 'sub' && mode !== 'set') mode = 'set';

      if(def.type === 'int'){
        var cur = Number(variableState[mut.variableId]) || 0;
        var val = Number(mut.value) || 0;
        if(mode === 'add') variableState[mut.variableId] = cur + val;
        else if(mode === 'sub') variableState[mut.variableId] = cur - val;
        else variableState[mut.variableId] = val;
      } else if(def.type === 'bool'){
        variableState[mut.variableId] = mut.value === true || mut.value === 'true' || mut.value === '1' || mut.value === 1;
      } else {
        variableState[mut.variableId] = String(mut.value || '');
      }
    });
    updateVarsPanel();
  }

  // ==================== 查找选项的目标节点 ====================
  // 从 edge 中提取 sourceOptionId，兼容多种存储格式
  function getEdgeSourceOptionId(e){
    // 格式1: e.data.sourceOptionId (React Flow 格式)
    if(e.data && e.data.sourceOptionId) return e.data.sourceOptionId;
    // 格式2: e.sourceOptionId (存储格式)
    if(e.sourceOptionId) return e.sourceOptionId;
    // 格式3: e.sourceHandle = "option:<id>"
    if(e.sourceHandle && typeof e.sourceHandle === 'string' && e.sourceHandle.indexOf('option:') === 0){
      return e.sourceHandle.slice(7);
    }
    return null;
  }

  // 从 edge 中提取 sourceEndId，兼容多种存储格式
  function getEdgeSourceEndId(e){
    if(e.data && e.data.sourceEndId) return e.data.sourceEndId;
    if(e.sourceEndId) return e.sourceEndId;
    if(e.sourceHandle && typeof e.sourceHandle === 'string'){
      if(e.sourceHandle.indexOf('script-end:') === 0) return e.sourceHandle.slice(12);
      if(e.sourceHandle.indexOf('minigame-end:') === 0) return e.sourceHandle.slice(13);
    }
    return null;
  }

  function findOptionTarget(node, optionId, optIdx){
    var outEdges = outgoingMap[node.id] || [];

    // 策略1: 精确匹配 sourceOptionId
    var edge = outEdges.find(function(e){
      return getEdgeSourceOptionId(e) === optionId;
    });

    // 策略2: 匹配 sourceEndId
    if(!edge){
      edge = outEdges.find(function(e){
        return getEdgeSourceEndId(e) === optionId;
      });
    }

    // 策略3: 如果 optionId 是 "option-<idx>" 格式，解析索引并匹配
    if(!edge && typeof optionId === 'string'){
      var match = optionId.match(/option-(\d+)/);
      if(match){
        var idx = parseInt(match[1], 10);
        var options = node.data && node.data.options || [];
        if(options[idx]){
          edge = outEdges.find(function(e){
            return getEdgeSourceOptionId(e) === options[idx].id || getEdgeSourceEndId(e) === options[idx].id;
          });
        }
      }
    }

    // 策略4: 按选项索引匹配边（第 N 个有 optionId 的边对应第 N 个选项）
    if(!edge && optIdx !== undefined && optIdx !== null){
      var optionEdges = outEdges.filter(function(e){
        return getEdgeSourceOptionId(e) !== null;
      });
      if(optionEdges.length > optIdx){
        edge = optionEdges[optIdx];
      }
    }

    return edge ? nodeMap[edge.target] : null;
  }

  // ==================== 查找节点的直接后续 ====================
  function findNextNode(node){
    var outEdges = outgoingMap[node.id] || [];
    var edge = outEdges.find(function(e){
      return getEdgeSourceOptionId(e) === null && getEdgeSourceEndId(e) === null;
    });
    if(!edge) edge = outEdges[0];
    return edge ? nodeMap[edge.target] : null;
  }

  // ==================== 渲染变量面板 ====================
  var _hiddenVarSet = {};
  (ENDING_SETTINGS.publishSettings.hiddenVariables || []).forEach(function(vid){ _hiddenVarSet[vid] = true; });

  function updateVarsPanel(){
    if(ENDING_SETTINGS.publishSettings.hideVarsPanel || variables.length === 0){ varsPanel.classList.remove('visible'); return; }
    var visibleVars = variables.filter(function(v){ return !_hiddenVarSet[v.id]; });
    if(visibleVars.length === 0){ varsPanel.classList.remove('visible'); return; }
    varsPanel.classList.add('visible');
    var html = visibleVars.map(function(v){
      var val = variableState[v.id];
      if(v.type === 'int') val = Number(val) || 0;
      return '<div class="var-item"><span class="var-name">' + escapeText(v.name || v.id) + '</span><span class="var-value">' + escapeText(String(val)) + '</span></div>';
    }).join('');
    varsPanel.innerHTML = html;
  }

  function escapeText(s){
    if(typeof s !== 'string') s = String(s || '');
    return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  // ==================== 渲染节点 ====================
  function renderNode(node){
    if(!node){ renderEnd(); return; }

    var data = node.data || {};
    var kind = data.kind || node.type || 'plot';
    var isEnding = kind === 'ending';
    var isMinigame = kind === 'minigame';

    history.push(node.id);

    var card = document.createElement('div');
    card.className = 'node-card' + (isEnding ? ' ending' : '') + (isMinigame ? ' minigame' : '');

    // 应用背景图片
    var bgInfo = resolveBackgroundImage(node);
    var isLightBg = false;
    if(bgInfo && bgInfo.url){
      card.classList.add('with-bg');
      card.style.backgroundImage = 'url(' + bgInfo.url + ')';
      // 判断背景是否为亮色
      if(data.backgroundImage && data.backgroundImage.bgTheme === 'light'){
        card.classList.add('light-bg');
        isLightBg = true;
      }
      // 应用可视化调整参数（缩放、偏移、裁剪）
      var adj = bgInfo.adjust;
      if(adj){
        var bgSizeW = (adj.scale || 100) * 100 / (adj.cropW || 100);
        var posX = 50;
        var posY = 50;
        // 裁剪位置映射
        if((adj.cropW || 100) < 100){
          posX = (adj.cropX || 0) * 100 / (100 - (adj.cropW || 100));
        }
        if((adj.cropH || 100) < 100){
          posY = (adj.cropY || 0) * 100 / (100 - (adj.cropH || 100));
        }
        // 偏移调整
        posX += (adj.offsetX || 0) / 2;
        posY += (adj.offsetY || 0) / 2;
        // 钳制范围
        posX = Math.max(0, Math.min(100, posX));
        posY = Math.max(0, Math.min(100, posY));
        card.style.backgroundSize = bgSizeW + '% auto';
        card.style.backgroundPosition = posX + '% ' + posY + '%';
        card.style.backgroundRepeat = 'no-repeat';
      }
    }

    var typeLabel = '剧情';
    if(isEnding) typeLabel = '结局';
    else if(isMinigame) typeLabel = '小游戏';

    var html = '<span class="node-type-badge' + (isEnding ? ' ending' : '') + (isMinigame ? ' minigame' : '') + '">' + typeLabel + '</span>';

    if(data.title){
      html += '<div class="node-title">' + escapeText(data.title) + '</div>';
    }

    // 媒体展示（视频/图片）
    var video = data.video || (data.storyboard && data.storyboard.videoJob ? data.storyboard.videoJob.video : null);
    var mediaUrl = resolveMediaUrl(video);
    if(mediaUrl){
      var ext = mediaUrl.split('.').pop().toLowerCase().split('?')[0];
      if(ext === 'mp4' || ext === 'webm' || ext === 'mov' || mediaUrl.indexOf('video') !== -1 || (mediaUrl.indexOf('data:video') === 0)){
        html += '<video class="node-video" src="' + escapeText(mediaUrl) + '" controls autoplay playsinline></video>';
      } else {
        html += '<img class="node-media" src="' + escapeText(mediaUrl) + '" alt="">';
      }
    }

    if(data.body){
      // 视觉小说式分段展示：按换行符分割，点击切换下一段
      var paragraphs = data.body.split(/\\r?\\n/).filter(function(p){ return p.trim().length > 0; });
      if(paragraphs.length === 0) paragraphs = [data.body];

      // 解析人物肖像
      var charInfo = resolveCharacterPortrait(node);
      var portraitSide = 'left';
      var portraitHtml = '';
      var boxClass = '';

      if(charInfo && charInfo.portrait){
        portraitHtml = '<img class="vn-character-portrait" src="' + escapeText(charInfo.portrait) + '" alt="' + escapeText(charInfo.name) + '">';
        boxClass = ' with-portrait-' + portraitSide;
      }

      var dialogueClass = isLightBg ? ' light-bg' : '';
      html += '<div class="vn-dialogue-area">';
      html += portraitHtml;
      html += '<div class="vn-dialogue-box' + boxClass + dialogueClass + '" id="vn-dialogue-' + node.id + '">';
      if(charInfo && charInfo.name){
        html += '<div class="vn-speaker-name">' + escapeText(charInfo.name) + '</div>';
      }
      html += '<div class="vn-dialogue-text" id="vn-text-' + node.id + '"></div>';
      html += '<div class="vn-advance-hint" id="vn-hint-' + node.id + '">/ 点击继续</div>';
      html += '</div>';
      html += '</div>';
    }

    if(isEnding){
      // 记录已达成的结局
      reachedEndings[node.id] = true;

      html += '</div>';
      card.innerHTML = html;
      card.classList.add('ending-card');
      root.innerHTML = '';
      root.appendChild(card);

      // 结局也需要显示正文
      var endTextEl = card.querySelector('#vn-text-' + node.id);
      var endHintEl = card.querySelector('#vn-hint-' + node.id);
      var endDialogueBox = card.querySelector('#vn-dialogue-' + node.id);
      var endParagraphs = [];
      if(data.body){
        endParagraphs = data.body.split(/\\r?\\n/).filter(function(p){ return p.trim().length > 0; });
        if(endParagraphs.length === 0) endParagraphs = [data.body];
      }

      if(endTextEl && endParagraphs.length > 0){
        var endParaIdx = 0;
        var endDone = false;

        function showEndingParagraph(){
          if(endParaIdx >= endParagraphs.length){
            if(!endDone){
              endDone = true;
              if(endHintEl) endHintEl.style.display = 'none';
              showEndingButtons();
            }
            return;
          }
          var para = endParagraphs[endParaIdx];
          endTextEl.classList.remove('fade-in');
          endTextEl.textContent = para;
          void endTextEl.offsetWidth;
          endTextEl.classList.add('fade-in');
          endParaIdx++;
          if(endParaIdx >= endParagraphs.length){
            if(endParagraphs.length <= 1){
              endDone = true;
              if(endHintEl) endHintEl.style.display = 'none';
              showEndingButtons();
              return;
            }
            if(endHintEl) endHintEl.textContent = '/ 点击继续';
          } else {
            if(endHintEl) endHintEl.textContent = '/ 点击继续 (' + endParaIdx + '/' + endParagraphs.length + ')';
          }
        }

        showEndingParagraph();
        if(endDialogueBox){
          endDialogueBox.addEventListener('click', function(){
            if(endDone) return;
            showEndingParagraph();
          });
        }
      } else {
        // 没有正文，直接显示按钮
        if(endHintEl) endHintEl.style.display = 'none';
        showEndingButtons();
      }

      function showEndingButtons(){
        if(!ENDING_SETTINGS.publishSettings.hideRestartBtn){
          var restart = document.createElement('button');
          restart.className = 'restart-btn';
          restart.textContent = '重新开始';
          restart.onclick = function(){ startGame(); };
          root.appendChild(restart);
        }

        if(!ENDING_SETTINGS.publishSettings.hideEndingGallery){
          var endingBtn = document.createElement('button');
          endingBtn.className = 'restart-btn';
          endingBtn.style.marginTop = '8px';
          endingBtn.textContent = '结局查询';
          endingBtn.onclick = function(){ showEndingGallery(); };
          root.appendChild(endingBtn);
        }
      }
      return;
    }

    // 选项渲染（初始隐藏，等段落读完再显示）
    var hasOptions = false;
    if(kind === 'plot' && data.options && data.options.length > 0){
      hasOptions = true;
      html += '<div class="options-list vn-options" style="display:none">';
      data.options.forEach(function(opt, idx){
        var condMet = checkConditions(opt.conditions);
        var optId = opt.id || ('option-' + idx);
        html += '<button class="option-btn' + (condMet ? '' : ' disabled') + '" data-opt-id="' + escapeText(optId) + '" data-opt-idx="' + idx + '"' + (condMet ? '' : ' disabled') + '>';
        html += '<div class="option-title">' + escapeText(opt.title || ('选项 ' + (idx + 1))) + '</div>';
        if(opt.body) html += '<div class="option-body">' + escapeText(opt.body) + '</div>';
        if(opt.conditions && opt.conditions.length > 0 && !condMet) html += '<div class="option-condition">条件未满足</div>';
        html += '</button>';
      });
      html += '</div>';
    } else if(kind === 'minigame'){
      // 小游戏嵌入渲染
      var mgEmbedType = data.minigameEmbedType || '';
      var mgHtmlCode = data.minigameHtmlCode || '';
      var mgGameUrl = data.minigameUrl || '';

      // 检查是否使用资产面板的小游戏资源（minigameAssetId）
      var mgAssetId = data.minigameAssetId || '';
      var mgAsset = mgAssetId ? minigameAssetMap[mgAssetId] : null;
      if(mgAsset){
        // 从资产构建内联HTML
        var assetHtml = buildMinigameHtmlFromAsset(mgAsset);
        if(assetHtml){
          mgEmbedType = 'html';
          mgHtmlCode = assetHtml;
          console.log('[小游戏诊断] 节点', node.id, '使用资产', mgAssetId, '(', mgAsset.name, ')，HTML长度:', assetHtml.length);
        } else {
          console.warn('[小游戏诊断] 节点', node.id, '资产', mgAssetId, '构建HTML失败');
        }
      }

      var hasEmbed = (mgEmbedType === 'html' && mgHtmlCode) || (mgEmbedType === 'url' && mgGameUrl);

      // 诊断日志：帮助排查小游戏嵌入问题
      console.log('[小游戏诊断] 节点', node.id, {
        kind: kind,
        minigameEmbedType: mgEmbedType,
        hasHtmlCode: !!mgHtmlCode,
        htmlCodeLength: mgHtmlCode ? mgHtmlCode.length : 0,
        hasUrl: !!mgGameUrl,
        url: mgGameUrl,
        hasEmbed: !!hasEmbed,
        dataKeys: Object.keys(data)
      });

      if(hasEmbed){
        // 嵌入型小游戏：渲染iframe容器（玩家直接看到游戏，不需要选择）
        hasOptions = true;
        html += '<div class="mg-embed-wrap vn-options" style="display:none">';
        html += '<div class="mg-loading">小游戏加载中...</div>';
        if(mgEmbedType === 'html'){
          // HTML代码模式：用Blob URL确保内容完整渲染
          html += '<iframe class="mg-iframe" data-mg-mode="html" data-mg-code="' + escapeText(mgHtmlCode) + '" style="display:none;" allow="autoplay; fullscreen; microphone; camera"></iframe>';
        } else {
          // URL模式：直接加载URL
          html += '<iframe class="mg-iframe" data-mg-mode="url" src="' + escapeText(mgGameUrl) + '" style="display:none;" allow="autoplay; fullscreen; microphone; camera"></iframe>';
        }
        html += '<div class="mg-feedback" style="display:none;margin-top:12px;"></div>';
        html += '</div>';
      } else {
        // 无嵌入内容：显示提示信息，不显示选择按钮
        // 结果定义仅用于作者端配置连线，玩家不应看到选择按钮
        hasOptions = true;
        var results = data.minigameResults || [{ id: 'success', label: '成功' }, { id: 'failure', label: '失败' }];
        html += '<div class="mg-embed-wrap vn-options" style="display:none">';
        html += '<div style="padding:40px 20px;text-align:center;color:var(--text-dim);background:rgba(167,139,250,.08);border-radius:12px;border:1px dashed rgba(167,139,250,.3);">';
        html += '<div style="font-size:2rem;margin-bottom:8px;">🎮</div>';
        html += '<div style="font-size:1rem;margin-bottom:12px;">小游戏未配置嵌入内容</div>';
        html += '<div style="font-size:0.85rem;">请在编辑器中配置小游戏嵌入（HTML代码或URL）</div>';
        html += '</div>';
        // 仍保留隐藏的结果按钮供测试用（不可见但可点击）
        results.forEach(function(r){
          html += '<button class="option-btn" data-result-id="' + escapeText(r.id) + '" style="display:none;">';
          html += '<div class="option-title">' + escapeText(r.label || r.id) + '</div>';
          html += '</button>';
        });
        html += '</div>';
      }
    } else {
      var nextNode = findNextNode(node);
      html += '<div class="no-options vn-options" style="display:none">';
      if(nextNode){
        html += '（继续...）';
      } else {
        html += '没有后续剧情了';
      }
      html += '</div>';
    }

    html += '</div>';
    card.innerHTML = html;
    root.innerHTML = '';
    root.appendChild(card);

    // ===== 视觉小说式段落渐进展示 =====
    var dialogueBox = card.querySelector('#vn-dialogue-' + node.id);
    var textEl = card.querySelector('#vn-text-' + node.id);
    var hintEl = card.querySelector('#vn-hint-' + node.id);
    var optionsEl = card.querySelector('.vn-options');
    var paraIdx = 0;
    var allParagraphsShown = false;

    function showOptions(){
      if(optionsEl){
        optionsEl.style.display = '';
        optionsEl.classList.add('vn-paragraphs-done');
      }
      if(hintEl) hintEl.style.display = 'none';
      allParagraphsShown = true;

      // 如果没有选项且有下一个节点，自动跳转
      if(!hasOptions){
        var autoNext = findNextNode(node);
        if(autoNext){
          setTimeout(function(){ renderNode(autoNext); }, 800);
        }
      }
    }

    function showNextParagraph(){
      if(!textEl || !paragraphs || paraIdx >= paragraphs.length){
        if(!allParagraphsShown) showOptions();
        return;
      }
      var para = paragraphs[paraIdx];
      // 文字切换动画：先移除动画类，设置文字，再触发动画
      textEl.classList.remove('fade-in');
      textEl.textContent = para;
      // 强制 reflow 以重新触发动画
      void textEl.offsetWidth;
      textEl.classList.add('fade-in');
      paraIdx++;
      if(paraIdx >= paragraphs.length){
        // 如果只有一个段落，直接显示选项，不需要再点"继续"
        if(paragraphs.length <= 1){
          showOptions();
          return;
        }
        if(hintEl) hintEl.textContent = '/ 点击继续';
        // 延迟显示选项，让用户读完最后一段
        if(dialogueBox){
          dialogueBox.addEventListener('click', function(){
            if(!allParagraphsShown) showOptions();
          }, { once: true });
        }
      } else {
        if(hintEl) hintEl.textContent = '/ 点击继续 (' + paraIdx + '/' + paragraphs.length + ')';
      }
    }

    // 嵌入型小游戏：直接显示游戏iframe，跳过文字展示
    var isEmbeddedMinigame = kind === 'minigame' && hasEmbed;

    if(isEmbeddedMinigame){
      // 隐藏对话区域，直接显示游戏
      if(dialogueBox) dialogueBox.style.display = 'none';
      if(hintEl) hintEl.style.display = 'none';
      showOptions();
      // 嵌入型小游戏不需要半透明效果，移除 vn-paragraphs-done 类
      if(optionsEl) optionsEl.classList.remove('vn-paragraphs-done');

      // 初始化iframe：三级降级加载（Blob URL → data URI → srcdoc → 降级按钮）
      var mgIframe = card.querySelector('.mg-iframe');
      var mgLoading = card.querySelector('.mg-loading');
      var mgEmbedWrap = card.querySelector('.mg-embed-wrap');

      // 降级按钮：所有加载方式失败时显示，让玩家跳过小游戏
      function showFallbackButton(){
        console.log('[小游戏] 所有加载方式失败，显示降级按钮');
        if(mgIframe) mgIframe.style.display = 'none';
        if(mgLoading) mgLoading.style.display = 'none';

        // 查找 success 边指向的节点
        var outEdges = outgoingMap[node.id] || [];
        var successEdge = null;
        for(var i = 0; i < outEdges.length; i++){
          if(getEdgeSourceEndId(outEdges[i]) === 'success'){ successEdge = outEdges[i]; break; }
        }
        if(!successEdge){
          for(var j = 0; j < outEdges.length; j++){
            if(getEdgeSourceEndId(outEdges[j]) === null && getEdgeSourceOptionId(outEdges[j]) === null){ successEdge = outEdges[j]; break; }
          }
        }
        if(!successEdge && outEdges.length > 0) successEdge = outEdges[0];
        var fallbackNode = successEdge ? nodeMap[successEdge.target] : null;

        var fallbackDiv = document.createElement('div');
        fallbackDiv.className = 'mg-fallback';
        fallbackDiv.style.cssText = 'padding:40px 20px;text-align:center;background:rgba(167,139,250,.08);border:1px solid rgba(167,139,250,.3);border-radius:12px;cursor:pointer;transition:background .2s;';
        fallbackDiv.innerHTML = '<div style="font-size:2rem;margin-bottom:8px;">🎮</div>' +
          '<div style="font-size:1rem;font-weight:600;color:var(--minigame,#a78bfa);margin-bottom:4px;">小游戏无法加载</div>' +
          '<div style="font-size:0.85rem;color:var(--text-dim,#8b92a8);margin-bottom:16px;">点击此处跳过小游戏，继续剧情</div>' +
          '<button style="padding:10px 24px;border-radius:8px;border:1px solid var(--minigame,#a78bfa);background:transparent;color:var(--minigame,#a78bfa);font-size:14px;font-weight:600;cursor:pointer;font-family:inherit;">点击此处继续剧情</button>';

        fallbackDiv.addEventListener('click', function(){
          if(mgFinished) return;
          mgFinished = true;

          // 显示反馈
          var fbEl = card.querySelector('.mg-feedback');
          if(fbEl){
            fbEl.style.display = '';
            fbEl.style.background = 'rgba(167,139,250,.12)';
            fbEl.style.border = '1px solid rgba(167,139,250,.3)';
            fbEl.innerHTML = '<div class="mg-fb-icon">⏭️</div>' +
              '<div class="mg-fb-title" style="color:var(--minigame,#a78bfa)">已跳过小游戏</div>' +
              '<div class="mg-fb-sub">即将继续剧情...</div>';
          }

          // 清理 postMessage 监听器
          if(window._vnMgHandler){
            window.removeEventListener('message', window._vnMgHandler);
            window._vnMgHandler = null;
          }

          // 跳转到后续节点
          setTimeout(function(){
            if(fallbackNode){
              renderNode(fallbackNode);
            } else {
              renderEnd();
            }
          }, 1500);
        });

        if(mgEmbedWrap){
          mgEmbedWrap.appendChild(fallbackDiv);
        } else {
          card.appendChild(fallbackDiv);
        }
      }

      if(mgIframe && mgIframe.getAttribute('data-mg-mode') === 'html'){
        // HTML代码模式：三级降级加载
        var rawCode = mgIframe.getAttribute('data-mg-code') || '';
        console.log('[小游戏iframe] HTML模式，代码长度:', rawCode.length);
        var mgLoadSuccess = false;
        var mgLoadTimer = null;

        // 方法1: Blob URL（兼容安卓）
        function tryBlobUrl(){
          console.log('[小游戏] 尝试 Blob URL 加载');
          try {
            var blob = new Blob([rawCode], { type: 'text/html;charset=utf-8' });
            var blobUrl = URL.createObjectURL(blob);
            mgLoadSuccess = false;
            mgIframe.onload = function(){
              mgLoadSuccess = true;
              if(mgLoadTimer) clearTimeout(mgLoadTimer);
              console.log('[小游戏] Blob URL 加载成功');
            };
            mgIframe.src = blobUrl;
            mgIframe.style.display = '';
            if(mgLoading) mgLoading.style.display = 'none';

            // 2秒后检测是否加载成功
            mgLoadTimer = setTimeout(function(){
              if(!mgLoadSuccess){
                console.log('[小游戏] Blob URL 2秒未加载成功，降级为 data URI');
                try { URL.revokeObjectURL(blobUrl); } catch(e) {}
                tryDataUri();
              }
            }, 2000);
          } catch(err) {
            console.log('[小游戏] Blob URL 创建失败，降级为 data URI', err);
            tryDataUri();
          }
        }

        // 方法2: data:text/html URI（兼容 iOS）
        function tryDataUri(){
          console.log('[小游戏] 尝试 data URI 加载');
          mgLoadSuccess = false;
          try {
            var dataUri = 'data:text/html;charset=utf-8,' + encodeURIComponent(rawCode);
            mgIframe.onload = function(){
              mgLoadSuccess = true;
              if(mgLoadTimer) clearTimeout(mgLoadTimer);
              console.log('[小游戏] data URI 加载成功');
            };
            mgIframe.src = dataUri;
            mgIframe.style.display = '';

            mgLoadTimer = setTimeout(function(){
              if(!mgLoadSuccess){
                console.log('[小游戏] data URI 2秒未加载成功，降级为 srcdoc');
                trySrcdoc();
              }
            }, 2000);
          } catch(err) {
            console.log('[小游戏] data URI 创建失败，降级为 srcdoc', err);
            trySrcdoc();
          }
        }

        // 方法3: srcdoc + sandbox（最终降级）
        function trySrcdoc(){
          console.log('[小游戏] 尝试 srcdoc + sandbox 加载');
          mgLoadSuccess = false;
          try {
            mgIframe.removeAttribute('src');
            mgIframe.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms allow-pointer-lock');
            mgIframe.setAttribute('srcdoc', rawCode);
            mgIframe.style.display = '';

            // srcdoc 可能不触发 onload，1秒后假定成功
            mgLoadTimer = setTimeout(function(){
              console.log('[小游戏] srcdoc 已设置');
              mgLoadSuccess = true;
            }, 1000);

            // 额外5秒检测：如果仍未收到 postMessage 响应，显示降级按钮
            setTimeout(function(){
              if(!mgFinished){
                console.log('[小游戏] srcdoc 加载后无响应，显示降级按钮');
                showFallbackButton();
              }
            }, 5000);
          } catch(err) {
            console.log('[小游戏] srcdoc 设置失败，显示降级按钮', err);
            showFallbackButton();
          }
        }

        // 启动加载流程
        tryBlobUrl();

      } else if(mgIframe) {
        // URL模式：iframe已有src，直接显示
        console.log('[小游戏iframe] URL模式，src:', mgIframe.src);
        mgIframe.style.display = '';
        if(mgLoading) mgLoading.style.display = 'none';
        // URL模式加载超时
        var urlLoadTimer = setTimeout(function(){
          if(mgLoading){
            mgLoading.textContent = '小游戏加载较慢，请稍候...';
          }
        }, 8000);
        mgIframe.onload = function(){
          clearTimeout(urlLoadTimer);
          if(mgLoading) mgLoading.style.display = 'none';
          console.log('[小游戏iframe] URL模式加载完成');
        };
        // URL模式也加超时降级：10秒后无响应显示降级按钮
        setTimeout(function(){
          if(!mgFinished){
            console.log('[小游戏] URL模式 10秒无响应，显示降级按钮');
            showFallbackButton();
          }
        }, 10000);
      } else {
        console.error('[小游戏iframe] 未找到iframe元素！');
        showFallbackButton();
      }
    } else if(kind === 'minigame' && !hasEmbed){
      // 非嵌入型小游戏：显示提示后自动跳转到第一个连接的节点
      showOptions();
      if(optionsEl) optionsEl.classList.remove('vn-paragraphs-done');
      // 自动跳转到第一个连接的节点（3秒后）
      var mgAutoNext = findNextNode(node);
      if(mgAutoNext){
        // 添加倒计时提示
        var countdownEl = document.createElement('div');
        countdownEl.style.cssText = 'text-align:center;margin-top:12px;color:var(--text-dim);font-size:0.85rem;';
        countdownEl.textContent = '3秒后自动继续...';
        if(optionsEl) optionsEl.appendChild(countdownEl);
        var mgCountdown = 3;
        var mgTimer = setInterval(function(){
          mgCountdown--;
          if(countdownEl){
            countdownEl.textContent = mgCountdown + '秒后自动继续...';
          }
          if(mgCountdown <= 0){
            clearInterval(mgTimer);
            renderNode(mgAutoNext);
          }
        }, 1000);
      }
    } else if(textEl && paragraphs && paragraphs.length > 0){
      showNextParagraph();
      if(dialogueBox){
        dialogueBox.addEventListener('click', function(){
          if(allParagraphsShown) return;
          showNextParagraph();
        });
      }
      // 键盘支持：按斜杠/、回车或空格切换（使用全局handler避免累积监听器）
      if(window._vnKeyHandler){
        document.removeEventListener('keydown', window._vnKeyHandler);
      }
      window._vnKeyHandler = function(e){
        if(e.key === '/' || e.key === 'Enter' || e.key === ' '){
          if(!allParagraphsShown){
            e.preventDefault();
            showNextParagraph();
          }
        }
      };
      document.addEventListener('keydown', window._vnKeyHandler);
    } else {
      // 没有正文，直接显示选项
      showOptions();
    }

    // 绑定选项点击事件
    var btns = card.querySelectorAll('.option-btn');
    btns.forEach(function(btn){
      btn.addEventListener('click', function(){
        if(btn.disabled) return;

        var optId = btn.getAttribute('data-opt-id');
        var optIdx = parseInt(btn.getAttribute('data-opt-idx'), 10);
        var resultId = btn.getAttribute('data-result-id');

        if(resultId){
          var mgNode = node;
          var muts = mgNode.data.minigameResultMutations && mgNode.data.minigameResultMutations[resultId];
          if(!muts){
            if(resultId === 'success') muts = mgNode.data.successMutations || [];
            else if(resultId === 'failure') muts = mgNode.data.failureMutations || [];
            else muts = [];
          }
          applyMutations(muts);

          var outEdges = outgoingMap[node.id] || [];
          var edge = outEdges.find(function(e){
            return getEdgeSourceEndId(e) === resultId;
          });
          if(!edge) edge = outEdges.find(function(e){ return getEdgeSourceOptionId(e) === null && getEdgeSourceEndId(e) === null; });
          if(!edge) edge = outEdges[0];

          var nextN = edge ? nodeMap[edge.target] : null;
          if(nextN){
            renderNode(nextN);
          } else {
            renderEnd();
          }
          return;
        }

        var options = data.options || [];
        var option = options[optIdx] || options.find(function(o){ return o.id === optId; });
        if(option){
          applyMutations(option.mutations);
          var target = findOptionTarget(node, optId, optIdx);
          if(!target) target = findNextNode(node);
          if(target){
            renderNode(target);
          } else {
            renderEnd();
          }
        }
      });
    });

    // ===== 小游戏 postMessage 监听（完全重写） =====
    // 清理之前的监听器
    if(window._vnMgHandler){
      window.removeEventListener('message', window._vnMgHandler);
      window._vnMgHandler = null;
    }

    // 嵌入型小游戏：设置 postMessage 监听
    if(isEmbeddedMinigame){
      var mgFbEl = card.querySelector('.mg-feedback');
      var mgIframeEl2 = card.querySelector('.mg-iframe');
      var mgNodeRef2 = node;
      var mgFinished = false;

      // 获取自定义返回状态列表
      var mgResultDefs = data.minigameResults || [{ id: 'success', label: '成功' }, { id: 'failure', label: '失败' }];

      // 根据返回值匹配结果定义
      function matchResultDef(val){
        if(!val) return null;
        var s = String(val);
        // 1. 精确匹配 id
        var m = mgResultDefs.find(function(r){ return r.id === s; });
        if(m) return m;
        // 2. 匹配 label
        m = mgResultDefs.find(function(r){ return r.label === s; });
        if(m) return m;
        // 3. 大小写不敏感匹配 id
        m = mgResultDefs.find(function(r){ return String(r.id).toLowerCase() === s.toLowerCase(); });
        if(m) return m;
        // 4. 大小写不敏感匹配 label
        m = mgResultDefs.find(function(r){ return String(r.label || '').toLowerCase() === s.toLowerCase(); });
        if(m) return m;
        return null;
      }

      // 从消息中提取结果值，支持多种格式
      function extractResult(msgData){
        if(typeof msgData === 'string'){
          // 纯字符串消息
          return msgData;
        }
        if(!msgData || typeof msgData !== 'object') return null;
        // 标准格式: {type: "funloom:minigame:complete", result: "..."}
        if(msgData.type === 'funloom:minigame:complete' || msgData.type === 'minigame:complete' || msgData.type === 'minigameComplete'){
          return msgData.result || msgData.resultId || msgData.value || 'success';
        }
        // 简化格式: {result: "..."}
        if(msgData.result) return msgData.result;
        if(msgData.resultId) return msgData.resultId;
        // 布尔格式: {success: true/false}
        if(typeof msgData.success === 'boolean') return msgData.success ? 'success' : 'failure';
        if(typeof msgData.win === 'boolean') return msgData.win ? 'success' : 'failure';
        // action 格式: {action: "complete", result: "..."}
        if(msgData.action === 'complete' || msgData.action === 'end'){
          return msgData.result || msgData.resultId || 'success';
        }
        return null;
      }

      window._vnMgHandler = function(e){
        if(mgFinished) return;

        var resultVal = extractResult(e.data);
        if(resultVal === null) return;

        mgFinished = true;

        // 诊断日志：打印收到的消息和提取的结果
        console.log('[小游戏postMessage] 收到消息:', e.data);
        console.log('[小游戏postMessage] 提取结果值:', resultVal);

        // 匹配结果定义
        var matched = matchResultDef(resultVal);
        var resultId = matched ? matched.id : resultVal;
        var resultLabel = matched ? (matched.label || matched.id) : resultVal;

        console.log('[小游戏postMessage] 匹配结果定义:', matched ? matched.id : '(无匹配)', '-> resultId:', resultId);

        // 分配样式
        var fbIcon, fbColor, fbBg, fbBorder;
        if(resultId === 'perfect'){
          fbIcon = '🏆'; fbColor = 'var(--minigame)';
          fbBg = 'linear-gradient(135deg, rgba(167,139,250,.18), rgba(251,191,36,.12))';
          fbBorder = '1px solid rgba(167,139,250,.4)';
        } else if(resultId === 'success'){
          fbIcon = '✅'; fbColor = 'var(--plot)';
          fbBg = 'rgba(74,222,128,.12)';
          fbBorder = '1px solid rgba(74,222,128,.3)';
        } else if(resultId === 'failure' || resultId === 'fail'){
          fbIcon = '❌'; fbColor = 'var(--ending)';
          fbBg = 'rgba(248,113,113,.12)';
          fbBorder = '1px solid rgba(248,113,113,.3)';
        } else {
          fbIcon = '🎮'; fbColor = 'var(--accent)';
          fbBg = 'rgba(91,140,255,.12)';
          fbBorder = '1px solid rgba(91,140,255,.3)';
        }

        // 显示反馈
        if(mgFbEl){
          mgFbEl.style.display = '';
          mgFbEl.style.background = fbBg;
          mgFbEl.style.border = fbBorder;
          mgFbEl.innerHTML = '<div class="mg-fb-icon">' + fbIcon + '</div>' +
            '<div class="mg-fb-title" style="color:' + fbColor + '">' + escapeText(resultLabel) + '</div>' +
            '<div class="mg-fb-sub">即将继续剧情...</div>';
        }

        // 半透明化iframe
        if(mgIframeEl2) mgIframeEl2.classList.add('mg-done');

        // 应用变异
        var muts = mgNodeRef2.data.minigameResultMutations && mgNodeRef2.data.minigameResultMutations[resultId];
        if(!muts){
          if(resultId === 'success' || resultId === 'perfect') muts = mgNodeRef2.data.successMutations || [];
          else if(resultId === 'failure' || resultId === 'fail') muts = mgNodeRef2.data.failureMutations || [];
          else muts = [];
        }
        applyMutations(muts);

        // 查找对应的边并跳转
        var outEdges = outgoingMap[node.id] || [];
        var targetEdge = null;

        // 诊断日志：打印出边信息
        console.log('[小游戏postMessage] 节点', node.id, '的出边:', outEdges.length, '条');
        outEdges.forEach(function(ed, i) {
          console.log('[小游戏postMessage] 边[' + i + ']', 'sourceHandle:', ed.sourceHandle, 'sourceEndId:', getEdgeSourceEndId(ed), 'target:', ed.target);
        });

        // 1. 精确匹配 resultId
        targetEdge = outEdges.find(function(ed){ return getEdgeSourceEndId(ed) === resultId; });
        // 2. 匹配原始返回值
        if(!targetEdge) targetEdge = outEdges.find(function(ed){ return getEdgeSourceEndId(ed) === resultVal; });
        // 3. 匹配 label
        if(!targetEdge && matched) targetEdge = outEdges.find(function(ed){ return getEdgeSourceEndId(ed) === matched.label; });
        // 4. 大小写不敏感匹配
        if(!targetEdge){
          var lowerRid = String(resultId).toLowerCase();
          targetEdge = outEdges.find(function(ed){
            var eid = getEdgeSourceEndId(ed);
            return eid && String(eid).toLowerCase() === lowerRid;
          });
        }
        // 5. 无标记的默认边
        if(!targetEdge) targetEdge = outEdges.find(function(ed){ return getEdgeSourceOptionId(ed) === null && getEdgeSourceEndId(ed) === null; });
        // 6. 第一条边
        if(!targetEdge) targetEdge = outEdges[0];

        var nextNode = targetEdge ? nodeMap[targetEdge.target] : null;

        console.log('[小游戏postMessage] 最终匹配边:', targetEdge ? targetEdge.id : '(无)', '-> 目标节点:', nextNode ? nextNode.id : '(无)');

        // 延迟跳转
        setTimeout(function(){
          if(window._vnMgHandler){
            window.removeEventListener('message', window._vnMgHandler);
            window._vnMgHandler = null;
          }
          if(nextNode){
            renderNode(nextNode);
          } else {
            renderEnd();
          }
        }, 2000);
      };

      window.addEventListener('message', window._vnMgHandler);
    }

    // 无选项节点自动跳转已由段落渐进系统处理（showOptions 函数中）

    updateVarsPanel();
  }

  function renderEnd(){
    root.innerHTML = '<div class="node-card ending-card"><div class="node-title">剧情已结束</div><div class="node-body">当前路线没有后续剧情节点了。</div></div>';
    if(!ENDING_SETTINGS.publishSettings.hideRestartBtn){
      var restart = document.createElement('button');
      restart.className = 'restart-btn';
      restart.textContent = '重新开始';
      restart.onclick = function(){ startGame(); };
      root.appendChild(restart);
    }
  }

  // ==================== 启动游戏 ====================
  function startGame(){
    history = [];
    variables.forEach(function(v){
      var val = getVarDefault(v);
      if(v.type === 'int'){
        val = Number(val);
        if(isNaN(val)) val = 0;
      }
      else if(v.type === 'bool') val = val === true || val === 'true' || val === '1' || val === 1;
      else if(v.type === 'enum') val = String(val || '');
      variableState[v.id] = val;
    });

    root.innerHTML = '<div class="loading">正在加载...</div>';

    if(entryNodeId && nodeMap[entryNodeId]){
      renderNode(nodeMap[entryNodeId]);
    } else {
      var firstNode = nodes.find(function(n){ return (n.data && (n.data.kind === 'plot' || n.type === 'plot')) || n.type === 'plot'; });
      if(firstNode){
        renderNode(firstNode);
      } else if(nodes.length > 0){
        renderNode(nodes[0]);
      } else {
        root.innerHTML = '<div class="node-card"><div class="node-body">没有找到任何剧情节点。</div></div>';
      }
    }
  }

  // 显示标题页
  function showTitleScreen(){
    // 如果设置了隐藏标题页，直接开始游戏
    if(ENDING_SETTINGS.publishSettings.hideTitleScreen){
      startGame();
      return;
    }
    var outline = PROJECT.outline || {};
    var titleEl = document.createElement('div');
    titleEl.style.textAlign = 'center';
    titleEl.innerHTML = '<h1 class="game-title">' + escapeText(outline.projectTitle || '未命名剧本') + '</h1>' +
      (outline.tone ? '<p class="game-subtitle">' + escapeText(outline.tone) + '</p>' : '') +
      (outline.opening ? '<p class="game-subtitle">' + escapeText(outline.opening) + '</p>' : '') +
      (outline.world ? '<div class="node-card" style="margin-top:24px;text-align:left"><div class="node-body">' + escapeText(outline.world).replace(/\\n/g,'<br>') + '</div></div>' : '');
    var startBtn = document.createElement('button');
    startBtn.className = 'restart-btn';
    startBtn.textContent = '开始游戏';
    startBtn.style.marginTop = '24px';
    startBtn.onclick = function(){ startGame(); };
    root.innerHTML = '';
    root.appendChild(titleEl);
    root.appendChild(startBtn);

    // 在开始游戏下方添加结局查询按钮
    if(!ENDING_SETTINGS.publishSettings.hideEndingGallery){
      var endingGalleryBtn = document.createElement('button');
      endingGalleryBtn.className = 'restart-btn';
      endingGalleryBtn.textContent = '结局查询';
      endingGalleryBtn.style.marginTop = '8px';
      endingGalleryBtn.onclick = function(){ showEndingGallery(); };
      root.appendChild(endingGalleryBtn);
    }
  }

  // ==================== 结局查询面板 ====================
  var _hiddenEndingSet = {};
  (ENDING_SETTINGS.publishSettings.hiddenEndings || []).forEach(function(eid){ _hiddenEndingSet[eid] = true; });

  function showEndingGallery(){
    root.innerHTML = '';
    var card = document.createElement('div');
    card.className = 'node-card';
    card.style.maxWidth = '600px';

    var html = '<span class="node-type-badge ending">结局图鉴</span>';
    html += '<div class="node-title">结局查询</div>';

    var visibleEndings = ALL_ENDINGS.filter(function(e){ return !_hiddenEndingSet[e.id]; });

    if(visibleEndings.length === 0){
      html += '<div class="node-body">本剧本暂无结局节点。</div>';
    } else {
      var reachedCount = visibleEndings.filter(function(e){ return reachedEndings[e.id]; }).length;
      html += '<div style="margin-bottom:12px;color:var(--text-dim);font-size:0.85rem">已达成 ' + reachedCount + '/' + visibleEndings.length + ' 个结局</div>';
      visibleEndings.forEach(function(ending, idx){
        var reached = reachedEndings[ending.id];
        var showThis = reached || ENDING_SETTINGS.showLockedEndings;
        if(!showThis) return;

        var displayTitle = reached ? ending.title : '???';
        if(!reached && ENDING_SETTINGS.hideLockedEndingNames) displayTitle = '???';
        var displayClue = reached ? (ending.body || '') : (ending.clue || '???');

        html += '<div class="ending-gallery-item" style="border:1px solid var(--border);border-radius:12px;padding:16px;margin-bottom:12px;' + (reached ? '' : 'opacity:0.6') + '">';
        html += '<div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">';
        html += '<span style="font-size:1.2rem">' + (reached ? '✅' : '🔒') + '</span>';
        html += '<strong style="font-size:1.1rem;color:' + (reached ? 'var(--ending)' : 'var(--text-dim)') + '">' + escapeText(displayTitle) + '</strong>';
        html += '</div>';
        if(displayClue && displayClue !== '???'){
          html += '<div style="color:var(--text-dim);font-size:0.9rem;line-height:1.6">' + escapeText(displayClue).replace(/\\n/g, '<br>') + '</div>';
        } else {
          html += '<div style="color:var(--text-dim);font-size:0.9rem;font-style:italic">???</div>';
        }
        html += '</div>';
      });
    }

    html += '<div style="margin-top:16px">';
    html += '<button class="restart-btn" id="back-to-title">返回标题</button>';
    html += '</div>';

    card.innerHTML = html;
    root.appendChild(card);

    var backBtn = document.getElementById('back-to-title');
    if(backBtn){
      backBtn.onclick = function(){ showTitleScreen(); };
    }
  }

  showTitleScreen();
})();

// ==================== 主题切换功能 ====================
var _allowThemeToggle = ${allowThemeToggle ? 'true' : 'false'};
function toggleTheme(){
  if(!_allowThemeToggle) return;
  var root = document.documentElement;
  var current = root.getAttribute('data-theme') || 'dark';
  var next = current === 'dark' ? 'light' : 'dark';
  root.setAttribute('data-theme', next);

  var themes = {
    dark: {'--bg':'#0f1115','--card':'#1a1d24','--border':'#2a2e38','--text':'#e2e4e9','--text-dim':'#8b92a8','--accent':'#5b8cff','--accent-dim':'#3d5a99','--plot':'#4ade80','--option':'#fbbf24','--ending':'#f87171','--minigame':'#a78bfa'},
    light: {'--bg':'#f5f5f5','--card':'#ffffff','--border':'#e0e0e0','--text':'#333333','--text-dim':'#888888','--accent':'#2563eb','--accent-dim':'#93c5fd','--plot':'#16a34a','--option':'#d97706','--ending':'#dc2626','--minigame':'#7c3aed'}
  };
  var vars = themes[next];
  for(var k in vars){ root.style.setProperty(k, vars[k]); }
}
function downloadPage(){
  var html = document.documentElement.outerHTML;
  var blob = new Blob([html], {type:'text/html;charset=utf-8'});
  var url = URL.createObjectURL(blob);
  var a = document.createElement('a');
  a.href = url;
  a.download = EXPORT_FILE_NAME + '.html';
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
</script>
<footer class="footer">由 七七剧本杀 导出</footer>
</body>
</html>`;

    return html;
  }

  // ==================== 主题选择弹窗 ====================

  function showThemePicker() {
    return new Promise((resolve) => {
      const backdrop = document.createElement('div');
      backdrop.style.cssText = 'position:fixed;inset:0;z-index:100001;background:rgba(0,0,0,.8);display:flex;align-items:center;justify-content:center;';

      const modal = document.createElement('div');
      modal.style.cssText = 'background:#1a1d24;border:1px solid #2a2e38;border-radius:16px;padding:32px;width:90%;max-width:400px;text-align:center;color:#e2e4e9;';

      const title = document.createElement('h3');
      title.textContent = '选择导出主题';
      title.style.cssText = 'margin:0 0 8px;font-size:1.3rem;';
      modal.appendChild(title);

      const subtitle = document.createElement('p');
      subtitle.textContent = '选择导出 HTML 的背景颜色主题';
      subtitle.style.cssText = 'color:#8b92a8;font-size:0.9rem;margin:0 0 24px;';
      modal.appendChild(subtitle);

      const btnContainer = document.createElement('div');
      btnContainer.style.cssText = 'display:flex;gap:12px;justify-content:center;';

      // 暗色主题
      const darkBtn = document.createElement('button');
      darkBtn.style.cssText = 'flex:1;padding:20px;border-radius:12px;border:2px solid #2a2e38;background:#0f1115;color:#e2e4e9;cursor:pointer;font-size:1rem;transition:all .2s;font-family:inherit;';
      darkBtn.innerHTML = '<div style="font-size:2rem;margin-bottom:8px">🌙</div><div style="font-weight:600">暗色主题</div><div style="color:#8b92a8;font-size:0.8rem;margin-top:4px">深色背景</div>';
      darkBtn.addEventListener('mouseenter', () => darkBtn.style.borderColor = '#5b8cff');
      darkBtn.addEventListener('mouseleave', () => darkBtn.style.borderColor = '#2a2e38');
      darkBtn.addEventListener('click', () => {
        document.body.removeChild(backdrop);
        resolve('dark');
      });
      btnContainer.appendChild(darkBtn);

      // 亮色主题
      const lightBtn = document.createElement('button');
      lightBtn.style.cssText = 'flex:1;padding:20px;border-radius:12px;border:2px solid #2a2e38;background:#f5f5f5;color:#333;cursor:pointer;font-size:1rem;transition:all .2s;font-family:inherit;';
      lightBtn.innerHTML = '<div style="font-size:2rem;margin-bottom:8px">☀️</div><div style="font-weight:600">亮色主题</div><div style="color:#888;font-size:0.8rem;margin-top:4px">浅色背景</div>';
      lightBtn.addEventListener('mouseenter', () => lightBtn.style.borderColor = '#5b8cff');
      lightBtn.addEventListener('mouseleave', () => lightBtn.style.borderColor = '#2a2e38');
      lightBtn.addEventListener('click', () => {
        document.body.removeChild(backdrop);
        resolve('light');
      });
      btnContainer.appendChild(lightBtn);

      modal.appendChild(btnContainer);

      const cancel = document.createElement('button');
      cancel.textContent = '取消';
      cancel.style.cssText = 'width:100%;padding:10px;margin-top:16px;border-radius:10px;border:1px solid #2a2e38;background:transparent;color:#8b92a8;cursor:pointer;font-family:inherit;';
      cancel.addEventListener('click', () => {
        document.body.removeChild(backdrop);
        resolve(null);
      });
      modal.appendChild(cancel);

      backdrop.appendChild(modal);
      document.body.appendChild(backdrop);
    });
  }

  // ==================== 项目选择弹窗 ====================

  function showProjectPicker(projects) {
    return new Promise((resolve) => {
      const backdrop = document.createElement('div');
      backdrop.style.cssText = 'position:fixed;inset:0;z-index:100000;background:rgba(0,0,0,.7);display:flex;align-items:center;justify-content:center;';

      const modal = document.createElement('div');
      modal.style.cssText = 'background:#1a1d24;border:1px solid #2a2e38;border-radius:16px;padding:24px;width:90%;max-width:480px;max-height:80vh;overflow:auto;color:#e2e4e9;';

      const title = document.createElement('h3');
      title.textContent = '选择要导出的剧本';
      title.style.cssText = 'margin:0 0 16px;font-size:1.2rem;';
      modal.appendChild(title);

      projects.forEach(p => {
        const item = document.createElement('button');
        item.style.cssText = 'width:100%;text-align:left;padding:12px 16px;margin-bottom:8px;border-radius:10px;border:1px solid #2a2e38;background:#0f1115;color:#e2e4e9;cursor:pointer;transition:border-color .2s;font-family:inherit;';
        item.innerHTML = `<strong>${escapeHtml(p.outline?.projectTitle || p.title || '未命名')}</strong><br><span style="color:#8b92a8;font-size:.85rem">${escapeHtml(p.updatedAt ? new Date(p.updatedAt).toLocaleString('zh-CN') : '')}</span>`;
        item.addEventListener('mouseenter', () => item.style.borderColor = '#5b8cff');
        item.addEventListener('mouseleave', () => item.style.borderColor = '#2a2e38');
        item.addEventListener('click', () => {
          document.body.removeChild(backdrop);
          resolve(p);
        });
        modal.appendChild(item);
      });

      const cancel = document.createElement('button');
      cancel.textContent = '取消';
      cancel.style.cssText = 'width:100%;padding:10px;margin-top:8px;border-radius:10px;border:1px solid #2a2e38;background:transparent;color:#8b92a8;cursor:pointer;font-family:inherit;';
      cancel.addEventListener('click', () => {
        document.body.removeChild(backdrop);
        resolve(null);
      });
      modal.appendChild(cancel);

      backdrop.appendChild(modal);
      document.body.appendChild(backdrop);
    });
  }

  // ==================== 进度提示 ====================

  function showProgress(text) {
    const el = document.createElement('div');
    el.id = 'funloom-export-progress';
    el.style.cssText = 'position:fixed;bottom:20px;right:20px;z-index:99999;padding:10px 16px;border-radius:8px;background:#1a1d24;border:1px solid #2a2e38;color:#e2e4e9;font-size:13px;';
    el.textContent = text;
    document.body.appendChild(el);
    return el;
  }

  function updateProgress(el, text) {
    if (el) el.textContent = text;
  }

  function removeProgress() {
    const el = document.getElementById('funloom-export-progress');
    if (el) el.remove();
  }

  // ==================== 从 React Fiber 读取当前项目状态 ====================

  // 通过遍历 React Fiber 树获取当前编辑器中的项目数据
  // 这确保导出时使用最新的变量值，避免 IndexedDB 中的数据过期
  function getReactCurrentProject() {
    try {
      var rootEl = document.getElementById('root');
      if (!rootEl) rootEl = document.getElementById('app');
      if (!rootEl) return null;

      // React 18: 根元素上有 __reactContainer$，子元素上有 __reactFiber$
      // React 16/17: 根元素上有 __reactInternalInstance$
      var fiberKey = Object.keys(rootEl).find(function(k) {
        return k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$');
      });
      var fiber;
      if (fiberKey) {
        fiber = rootEl[fiberKey];
      } else {
        // React 18: 查找 __reactContainer$ 并通过 .current 获取 fiber
        var containerKey = Object.keys(rootEl).find(function(k) {
          return k.startsWith('__reactContainer$');
        });
        if (containerKey) {
          var container = rootEl[containerKey];
          fiber = container ? (container.current || container) : null;
        }
      }
      // 如果根元素上没找到，尝试第一个子元素
      if (!fiber && rootEl.firstElementChild) {
        var childFiberKey = Object.keys(rootEl.firstElementChild).find(function(k) {
          return k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$');
        });
        if (childFiberKey) {
          fiber = rootEl.firstElementChild[childFiberKey];
        }
      }
      if (!fiber) {
        console.warn('[React状态] 未找到 React Fiber，无法读取当前状态');
        return null;
      }
      var found = null;
      var foundNodes = null;
      // 收集所有包含节点数据的 props（用于补充 memoizedState 的遗漏）
      var propNodeMap = {};
      // 捕获完整的 currentProject 对象（用于补充 outline、assets 等字段）
      var fullProjectFromProps = null;

      // 检查一个值是否像 nodes 数组
      function looksLikeNodes(val) {
        return Array.isArray(val) && val.length > 0 && val[0] && val[0].data && val[0].id;
      }
      // 检查一个值是否像 variables 数组
      function looksLikeVariables(val) {
        return Array.isArray(val) && val.length > 0 && val[0] && val[0].type === 'int' && 'initialValue' in val[0];
      }

      // 遍历 Fiber 树，查找包含 variables 和 nodes 的状态
      function walk(node, depth) {
        if (!node || depth > 40 || (found && foundNodes && fullProjectFromProps && Object.keys(propNodeMap).length > 0)) return;

        // 0. 优先检查 memoizedProps 中的 currentProject（最新、最完整的项目数据）
        var props = node.memoizedProps;
        if (props && typeof props === 'object') {
          if (props.currentProject && props.currentProject.variables &&
              Array.isArray(props.currentProject.variables) &&
              (props.currentProject.outline || props.currentProject.nodes)) {
            if (!found) {
              found = props.currentProject;
            } else if (props.currentProject.nodes && found.nodes &&
                       props.currentProject.nodes.length > found.nodes.length) {
              // 如果 currentProject 的节点数更多，说明它更新
              found = props.currentProject;
            }
          }
          // 捕获完整的 currentProject 对象（即使没有 variables 也需要 outline/assets）
          if (props.currentProject && (props.currentProject.outline || props.currentProject.assets || props.currentProject.entryNodeId)) {
            if (!fullProjectFromProps) {
              fullProjectFromProps = props.currentProject;
            }
          }
          if (props.currentProject && props.currentProject.nodes && looksLikeNodes(props.currentProject.nodes)) {
            if (!foundNodes || (foundNodes.nodes && props.currentProject.nodes.length > foundNodes.nodes.length)) {
              foundNodes = props.currentProject;
            }
          }
        }

        // 1. 检查 memoizedState 链
        var state = node.memoizedState;
        while (state && !(found && foundNodes)) {
          if (state.memoizedState) {
            var val = state.memoizedState;
            if (val && typeof val === 'object' && !Array.isArray(val)) {
              // 匹配完整项目对象（有 variables + outline 或 nodes）
              if (!found && val.variables && Array.isArray(val.variables) && (val.outline || val.nodes)) {
                found = val;
              }
              // 匹配包含 nodes 的对象
              if (!foundNodes && val.nodes && looksLikeNodes(val.nodes)) {
                foundNodes = val;
              }
            }
            if (looksLikeVariables(val)) {
              if (!found) found = { variables: val };
            }
            if (looksLikeNodes(val)) {
              if (!foundNodes) foundNodes = { nodes: val };
            }
          }
          state = state.next;
        }

        // 2. 检查 memoizedProps（很多组件通过 props 传递节点数据）
        if (props && typeof props === 'object') {
          // props.node: 单个节点（inspector 编辑器组件）
          if (props.node && props.node.id && props.node.data) {
            propNodeMap[props.node.id] = props.node;
          }
          // props.nodes: 节点数组
          if (looksLikeNodes(props.nodes)) {
            if (!foundNodes) foundNodes = { nodes: props.nodes };
            props.nodes.forEach(function(n) {
              if (n && n.id) propNodeMap[n.id] = n;
            });
          }
          // props.project / props.script / props.currentProject: 包含 nodes 的项目对象
          if (!foundNodes) {
            var projCandidates = [props.currentProject, props.project, props.script, props.flow, props.projectFlow];
            for (var i = 0; i < projCandidates.length; i++) {
              var pc = projCandidates[i];
              if (pc && pc.nodes && looksLikeNodes(pc.nodes)) {
                foundNodes = pc;
                break;
              }
            }
          }
        }

        // 递归子节点
        if (node.child) walk(node.child, depth + 1);
        if (node.sibling) walk(node.sibling, depth + 1);
      }

      walk(fiber, 0);

      // 如果 memoizedState 没找到 nodes，但 props 中收集到了节点，用 props 的节点
      if ((!foundNodes || !foundNodes.nodes) && Object.keys(propNodeMap).length > 0) {
        var propNodes = Object.keys(propNodeMap).map(function(k) { return propNodeMap[k]; });
        if (!foundNodes) foundNodes = {};
        if (!foundNodes.nodes || foundNodes.nodes.length < propNodes.length) {
          foundNodes.nodes = propNodes;
          console.log('[React状态] 从props补充了', propNodes.length, '个节点');
        }
      }

      // 合并 found 和 foundNodes
      var result = found || {};
      if (foundNodes && foundNodes.nodes) {
        result.nodes = foundNodes.nodes;
      }
      if (foundNodes && foundNodes.scripts) {
        result.scripts = foundNodes.scripts;
      }
      // 从 fullProjectFromProps 补充 outline、assets、entryNodeId 等字段
      if (fullProjectFromProps) {
        if (!result.outline && fullProjectFromProps.outline) result.outline = fullProjectFromProps.outline;
        if (!result.assets && fullProjectFromProps.assets) result.assets = fullProjectFromProps.assets;
        if (!result.entryNodeId && fullProjectFromProps.entryNodeId) result.entryNodeId = fullProjectFromProps.entryNodeId;
        if (!result.variables && fullProjectFromProps.variables) result.variables = fullProjectFromProps.variables;
        if (!result.projectFlow && fullProjectFromProps.projectFlow) result.projectFlow = fullProjectFromProps.projectFlow;
        console.log('[React状态] 从 currentProject 补充了 outline/assets 等字段, projectTitle:',
          (result.outline && result.outline.projectTitle) || '(无)');
      }

      if (found && found.variables) {
        console.log('[React状态] 找到当前变量数据:', found.variables.length, '个变量');
      }
      if (result.nodes) {
        console.log('[React状态] 找到节点数据:', result.nodes.length, '个节点');
      } else {
        console.warn('[React状态] 未找到节点数据');
      }

      return (found || foundNodes || fullProjectFromProps) ? result : null;
    } catch(e) {
      console.warn('[React状态] 读取失败:', e);
      return null;
    }
  }

  // 将 React 当前状态的变量数据合并到项目数据中
  function mergeReactVariables(projectData) {
    var reactProject = getReactCurrentProject();
    if (!reactProject || !reactProject.variables) return projectData;

    // 创建变量 ID 到 initialValue 的映射
    var reactVarMap = {};
    reactProject.variables.forEach(function(v) {
      if (v.id) {
        reactVarMap[v.id] = v;
      }
    });

    // 递归更新项目数据中的变量
    function updateVariablesInObj(obj) {
      if (!obj || typeof obj !== 'object') return;
      if (Array.isArray(obj)) {
        obj.forEach(updateVariablesInObj);
        return;
      }
      // 如果是变量对象，用 React 状态中的值更新
      if (obj.id && obj.type && reactVarMap[obj.id]) {
        var reactVar = reactVarMap[obj.id];
        // 只有当 React 状态中的值更有效时才更新
        if ('initialValue' in reactVar) {
          var reactVal = reactVar.initialValue;
          var currentVal = obj.initialValue;
          // 如果当前值是 0/空/undefined 而 React 值非零，用 React 值
          if (reactVal !== undefined && reactVal !== null && reactVal !== '') {
            var reactNum = Number(reactVal);
            var currentNum = Number(currentVal);
            if (!isNaN(reactNum) && reactNum !== 0) {
              if (currentVal === undefined || currentVal === null || currentVal === '' ||
                  currentNum === 0 || isNaN(currentNum)) {
                obj.initialValue = reactVal;
                console.log('[变量同步] 更新', obj.name, ':', currentVal, '->', reactVal);
              }
            }
          }
        }
      }
      // 递归子属性
      for (var key in obj) {
        if (obj.hasOwnProperty(key) && typeof obj[key] === 'object' && obj[key] !== null) {
          updateVariablesInObj(obj[key]);
        }
      }
    }

    updateVariablesInObj(projectData);

    // 如果项目数据没有顶层 variables 但 React 有，添加上去
    if ((!projectData.variables || projectData.variables.length === 0) && reactProject.variables.length > 0) {
      projectData.variables = reactProject.variables.map(function(v) { return Object.assign({}, v); });
      console.log('[变量同步] 从 React 状态补充了', projectData.variables.length, '个变量到顶层');
    }

    return projectData;
  }

  // 将 React 当前状态的节点数据合并到项目数据中
  // 确保最新的节点修改（如小游戏嵌入设置）被同步到导出数据
  function mergeReactNodeData(projectData) {
    var reactProject = getReactCurrentProject();
    if (!reactProject) return projectData;

    // 收集 React 状态中所有节点
    var reactNodeMap = {};
    function collectReactNodes(nodes) {
      if (!Array.isArray(nodes)) return;
      nodes.forEach(function(n) {
        if (n && n.id) reactNodeMap[n.id] = n;
      });
    }
    if (reactProject.nodes) collectReactNodes(reactProject.nodes);
    if (reactProject.scripts) {
      reactProject.scripts.forEach(function(s) {
        if (s.nodes) collectReactNodes(s.nodes);
      });
    }
    // 也检查 projectFlow.nodes
    if (reactProject.projectFlow && reactProject.projectFlow.nodes) {
      collectReactNodes(reactProject.projectFlow.nodes);
    }

    // 合并到 projectData 中的节点
    function mergeNodes(nodes) {
      if (!Array.isArray(nodes)) return;
      nodes.forEach(function(n) {
        if (!n || !n.id) return;
        var reactNode = reactNodeMap[n.id];
        if (!reactNode || !reactNode.data) return;
        // 合并小游戏嵌入相关字段
        var fields = ['minigameEmbedType', 'minigameHtmlCode', 'minigameUrl',
                       'minigameResults', 'minigameResultMutations',
                       'successMutations', 'failureMutations', 'minigameAssetId'];
        if (!n.data) n.data = {};
        var changed = false;
        fields.forEach(function(f) {
          // 强制同步：只要 React 状态中有该字段就覆盖
          if (f in reactNode.data) {
            n.data[f] = reactNode.data[f];
            changed = true;
          }
        });
        if (changed) {
          console.log('[节点同步] 节点', n.id, '的小游戏数据已从React状态同步');
        }
      });
    }

    if (projectData.nodes) mergeNodes(projectData.nodes);
    if (projectData.scripts) {
      projectData.scripts.forEach(function(s) {
        if (s.nodes) mergeNodes(s.nodes);
      });
    }
    if (projectData.projectFlow && projectData.projectFlow.nodes) {
      mergeNodes(projectData.projectFlow.nodes);
    }

    return projectData;
  }

  // ==================== 导出核心逻辑（复用） ====================

  async function generateExportHTML(themeName, onProgress, options) {
    var opts = options || {};
    var projectData = opts.projectData;

    // 优先从 React 状态读取项目数据（最可靠，因为编辑器的数据可能尚未保存到 IndexedDB）
    if (!projectData) {
      if (onProgress) onProgress('正在读取项目数据...');
      var reactProject = getReactCurrentProject();
      if (reactProject && (reactProject.nodes || (reactProject.scripts && reactProject.scripts.length > 0))) {
        // 深拷贝 React 状态中的项目数据，避免修改原始状态
        projectData = JSON.parse(JSON.stringify(reactProject));
        console.log('[导出] 从 React 状态读取项目数据成功，节点数:',
          (projectData.nodes ? projectData.nodes.length : 0) +
          (projectData.scripts ? projectData.scripts.reduce(function(sum, s) { return sum + (s.nodes ? s.nodes.length : 0); }, 0) : 0));
      }
    }

    // 如果 React 状态没有完整数据，回退到 IndexedDB
    if (!projectData) {
      var db = await openDB();
      var projects = await getAllStories(db);

      if (!projects || projects.length === 0) {
        throw new Error('未找到本地项目。请先创建或保存一个剧本。');
      }

      var project = projects[0];
      if (projects.length > 1) {
        project = await showProjectPicker(projects);
        if (!project) return null;
      }
      projectData = project.project || project;
    }

    // 从 React Fiber 读取当前状态并合并变量数据
    if (onProgress) onProgress('正在同步变量数据...');
    mergeReactVariables(projectData);
    // 同步最新的节点数据（小游戏嵌入设置等）
    mergeReactNodeData(projectData);

    // 从全局缓存合并小游戏嵌入设置（最可靠的同步方式）
    if (window._funloomMinigameSettings) {
      var mgCache = window._funloomMinigameSettings;
      var cacheMerged = 0;
      var allCacheFields = ['minigameEmbedType', 'minigameHtmlCode', 'minigameUrl',
                            'minigameResults', 'minigameResultMutations',
                            'successMutations', 'failureMutations', 'minigameAssetId'];
      function mergeFromCache(nodes) {
        if (!Array.isArray(nodes)) return;
        nodes.forEach(function(n) {
          if (!n || !n.id) return;
          var cached = mgCache[n.id];
          if (!cached) return;
          if (!n.data) n.data = {};
          var changed = false;
          allCacheFields.forEach(function(f) {
            if (cached[f] !== undefined && cached[f] !== null) {
              // 强制覆盖：全局缓存是最新的用户输入
              n.data[f] = cached[f];
              changed = true;
            }
          });
          if (changed) {
            cacheMerged++;
            console.log('[全局缓存同步] 节点', n.id, '的小游戏设置已从全局缓存强制合并',
              'embedType:', n.data.minigameEmbedType,
              'htmlLen:', n.data.minigameHtmlCode ? n.data.minigameHtmlCode.length : 0);
          }
        });
      }
      if (projectData.nodes) mergeFromCache(projectData.nodes);
      if (projectData.scripts) {
        projectData.scripts.forEach(function(s) {
          if (s.nodes) mergeFromCache(s.nodes);
        });
      }
      if (projectData.projectFlow && projectData.projectFlow.nodes) {
        mergeFromCache(projectData.projectFlow.nodes);
      }
      console.log('[全局缓存同步] 共合并', cacheMerged, '个节点的小游戏设置');
    }

    // 诊断：打印所有小游戏节点的嵌入设置，帮助排查问题
    (function() {
      var allNodes = [];
      if (projectData.nodes) allNodes = allNodes.concat(projectData.nodes);
      if (projectData.scripts) {
        projectData.scripts.forEach(function(s) {
          if (s.nodes) allNodes = allNodes.concat(s.nodes);
        });
      }
      var mgNodes = allNodes.filter(function(n) {
        return n && n.data && ((n.data.kind || n.type) === 'minigame');
      });
      console.log('[导出诊断] 找到', mgNodes.length, '个小游戏节点:');
      mgNodes.forEach(function(n) {
        console.log('[导出诊断] 节点', n.id, {
          minigameEmbedType: n.data.minigameEmbedType || '(空)',
          hasHtmlCode: !!(n.data.minigameHtmlCode),
          htmlCodeLength: (n.data.minigameHtmlCode || '').length,
          hasUrl: !!(n.data.minigameUrl),
          url: n.data.minigameUrl || '(空)',
          allDataKeys: Object.keys(n.data)
        });
      });
    })();

    if (onProgress) onProgress('正在收集媒体资源...');
    const mediaRefs = collectMediaRefs(projectData);
    const mediaMap = new Map();

    var db2;
    try { db2 = await openDB(); } catch(e) { db2 = null; }

    let loaded = 0;
    const total = mediaRefs.size;
    for (const [mediaId] of mediaRefs) {
      try {
        const record = db2 ? await getMediaById(db2, mediaId) : null;
        if (record && record.blob) {
          const base64 = await blobToBase64(record.blob);
          mediaMap.set(mediaId, base64);
        }
      } catch (e) {
        console.warn('读取媒体失败:', mediaId, e);
      }
      loaded++;
      if (onProgress) onProgress(`正在转换图片 (${loaded}/${total})...`);
    }

    if (onProgress) onProgress('正在生成 HTML...');
    const html = generateHTML(projectData, mediaMap, themeName, opts);
    return { html, projectData };
  }

  // ==================== 导出主流程 ====================

  let isExporting = false;

  async function handleExport() {
    if (isExporting) return;
    isExporting = true;

    let progressEl = null;

    try {
      const theme = await showThemePicker();
      if (!theme) {
        isExporting = false;
        return;
      }

      // 先读取项目数据以获取结局列表
      progressEl = showProgress('正在读取项目数据...');
      // 优先从 React 状态读取（编辑器数据可能尚未保存到 IndexedDB）
      let projectData = null;
      var reactProj = getReactCurrentProject();
      if (reactProj && (reactProj.nodes || (reactProj.scripts && reactProj.scripts.length > 0))) {
        projectData = JSON.parse(JSON.stringify(reactProj));
        console.log('[导出] handleExport 从 React 状态读取项目数据成功');
      }
      if (!projectData) {
        const db = await openDB();
        const projects = await getAllStories(db);
        if (!projects || projects.length === 0) {
          throw new Error('未找到本地项目。请先创建或保存一个剧本。');
        }
        let selectedProject = projects[0];
        if (projects.length > 1) {
          removeProgress();
          selectedProject = await showProjectPicker(projects);
          if (!selectedProject) {
            isExporting = false;
            return;
          }
        }
        projectData = selectedProject.project || selectedProject;
      }
      removeProgress();

      // 显示发布设置弹窗（预填充缓存的设置）
      const endingSettings = await showEndingSettingsDialog(projectData, window._funloomCachedPublishSettings);
      if (!endingSettings) {
        isExporting = false;
        return;
      }

      progressEl = showProgress('正在连接本地数据库...');

      const result = await generateExportHTML(theme, function(msg) {
        updateProgress(progressEl, msg);
      }, { isPreview: false, endingSettings: endingSettings, projectData: projectData });

      if (!result) {
        removeProgress();
        isExporting = false;
        return;
      }

      const blob = new Blob([result.html], { type: 'text/html;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      // 使用发布设置中自定义的文件名
      a.download = (endingSettings.exportFileName || (result.projectData.outline?.projectTitle || '剧本')) + '.html';
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);

      removeProgress();
    } catch (err) {
      console.error('导出失败:', err);
      removeProgress();
      alert('导出失败: ' + (err.message || String(err)));
    } finally {
      isExporting = false;
    }
  }

  // ==================== 结局设置弹窗 ====================

  function collectEndingsFromProject(projectData) {
    var endings = [];
    var allNodes = [];
    if (projectData.nodes) allNodes = allNodes.concat(projectData.nodes);
    if (projectData.scripts) {
      projectData.scripts.forEach(function(s) {
        if (s.nodes) allNodes = allNodes.concat(s.nodes);
      });
    }
    if (projectData.projectFlow && projectData.projectFlow.nodes) {
      allNodes = allNodes.concat(projectData.projectFlow.nodes);
    }
    var seen = {};
    allNodes.forEach(function(n) {
      if (seen[n.id]) return;
      seen[n.id] = true;
      var kind = (n.data && n.data.kind) || n.type || '';
      if (kind === 'ending') {
        var endingData = n.data || {};
        endings.push({
          id: n.id,
          title: endingData.title || endingData.name || '未知结局',
          body: endingData.body || endingData.description || ''
        });
      }
    });
    return endings;
  }

  function collectVariablesFromProject(projectData) {
    var vars = [];
    var seen = {};
    function addVar(v) {
      if (!v || !v.id || seen[v.id]) return;
      seen[v.id] = true;
      vars.push({ id: v.id, name: v.name || v.id, type: v.type || 'string' });
    }
    if (projectData.variables) projectData.variables.forEach(addVar);
    if (projectData.outline && projectData.outline.variables) projectData.outline.variables.forEach(addVar);
    if (projectData.scripts) {
      projectData.scripts.forEach(function(s) {
        if (s.variables) s.variables.forEach(addVar);
      });
    }
    return vars;
  }

  function showEndingSettingsDialog(projectData, cachedSettings) {
    return new Promise(function(resolve) {
      var endings = collectEndingsFromProject(projectData);
      var allVars = collectVariablesFromProject(projectData);
      var projectTitle = (projectData.outline && projectData.outline.projectTitle) || '剧本';
      var cs = cachedSettings || {};

      var backdrop = document.createElement('div');
      backdrop.className = 'seven-bg-adjust-overlay';
      backdrop.style.zIndex = '100005';

      var modal = document.createElement('div');
      modal.className = 'seven-cutout-modal';
      modal.style.maxWidth = '600px';
      modal.style.maxHeight = '80vh';
      modal.style.overflow = 'auto';

      var title = document.createElement('h3');
      title.textContent = '发布设置';
      title.style.cssText = 'margin:0 0 8px;font-size:1.2rem;color:#e2e4e9;';
      modal.appendChild(title);

      var subtitle = document.createElement('p');
      subtitle.textContent = '配置导出文件的名称和游戏内功能显示';
      subtitle.style.cssText = 'color:#8b92a8;font-size:0.85rem;margin:0 0 20px;';
      modal.appendChild(subtitle);

      // ===== 导出文件名设置 =====
      var nameSection = document.createElement('div');
      nameSection.style.cssText = 'margin-bottom:20px;padding:16px;border:1px solid #2a2e38;border-radius:10px;background:#0f1115;';

      var nameTitle = document.createElement('div');
      nameTitle.textContent = '导出文件名';
      nameTitle.style.cssText = 'color:#e2e4e9;font-size:0.95rem;font-weight:600;margin-bottom:12px;';
      nameSection.appendChild(nameTitle);

      var prefixLabel = document.createElement('div');
      prefixLabel.style.cssText = 'color:#8b92a8;font-size:0.8rem;margin-bottom:4px;';
      prefixLabel.textContent = '前缀（自动添加到文件名前）';
      nameSection.appendChild(prefixLabel);

      var prefixInput = document.createElement('input');
      prefixInput.type = 'text';
      prefixInput.value = '【七七剧本杀·出品】';
      prefixInput.placeholder = '如：【七七剧本杀·出品】';
      prefixInput.style.cssText = 'width:100%;padding:8px 10px;border-radius:6px;border:1px solid #2a2e38;background:#1a1d24;color:#e2e4e9;font-size:0.85rem;outline:none;font-family:inherit;margin-bottom:12px;';
      prefixInput.onfocus = function() { prefixInput.style.borderColor = '#5b8cff'; };
      prefixInput.onblur = function() { prefixInput.style.borderColor = '#2a2e38'; };
      nameSection.appendChild(prefixInput);

      var customNameLabel = document.createElement('div');
      customNameLabel.style.cssText = 'color:#8b92a8;font-size:0.8rem;margin-bottom:4px;';
      customNameLabel.textContent = '文件名（不填则使用项目标题）';
      nameSection.appendChild(customNameLabel);

      var customNameInput = document.createElement('input');
      customNameInput.type = 'text';
      customNameInput.value = projectTitle;
      customNameInput.placeholder = '输入文件名...';
      customNameInput.style.cssText = 'width:100%;padding:8px 10px;border-radius:6px;border:1px solid #2a2e38;background:#1a1d24;color:#e2e4e9;font-size:0.85rem;outline:none;font-family:inherit;';
      customNameInput.onfocus = function() { customNameInput.style.borderColor = '#5b8cff'; };
      customNameInput.onblur = function() { customNameInput.style.borderColor = '#2a2e38'; };
      nameSection.appendChild(customNameInput);

      var previewName = document.createElement('div');
      previewName.style.cssText = 'color:#8b92a8;font-size:0.78rem;margin-top:8px;';
      function updatePreview(){
        var fname = (prefixInput.value || '') + (customNameInput.value.trim() || projectTitle) + '.html';
        previewName.textContent = '预览: ' + fname;
      }
      prefixInput.addEventListener('input', updatePreview);
      customNameInput.addEventListener('input', updatePreview);
      updatePreview();
      nameSection.appendChild(previewName);

      modal.appendChild(nameSection);

      // ===== 功能隐藏设置 =====
      var hideSection = document.createElement('div');
      hideSection.style.cssText = 'margin-bottom:20px;padding:16px;border:1px solid #2a2e38;border-radius:10px;background:#0f1115;';

      var hideTitle = document.createElement('div');
      hideTitle.textContent = '隐藏部分功能';
      hideTitle.style.cssText = 'color:#e2e4e9;font-size:0.95rem;font-weight:600;margin-bottom:12px;';
      hideSection.appendChild(hideTitle);

      var hideOpts = [
        { key: 'hideTitleScreen', label: '隐藏标题页（直接进入游戏）' },
        { key: 'hideEndingGallery', label: '隐藏结局查询按钮' },
        { key: 'hideRestartBtn', label: '隐藏重新开始按钮' },
        { key: 'hideVarsPanel', label: '隐藏变量面板' }
      ];
      var hideCheckboxes = {};
      hideOpts.forEach(function(opt) {
        var lbl = document.createElement('label');
        lbl.style.cssText = 'display:flex;align-items:center;gap:8px;color:#e2e4e9;font-size:0.9rem;cursor:pointer;margin-bottom:10px;';
        var cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = false;
        cb.style.accentColor = '#5b8cff';
        lbl.appendChild(cb);
        lbl.appendChild(document.createTextNode(opt.label));
        hideSection.appendChild(lbl);
        hideCheckboxes[opt.key] = cb;
      });

      modal.appendChild(hideSection);

      // ===== 隐藏部分变量 =====
      var hiddenVarCheckboxes = {};
      if (allVars.length > 0) {
        var varHideSection = document.createElement('div');
        varHideSection.style.cssText = 'margin-bottom:20px;padding:16px;border:1px solid #2a2e38;border-radius:10px;background:#0f1115;';

        var varHideTitle = document.createElement('div');
        varHideTitle.style.cssText = 'display:flex;align-items:center;justify-content:space-between;margin-bottom:12px;';
        var varHideLabel = document.createElement('span');
        varHideLabel.textContent = '隐藏部分变量';
        varHideLabel.style.cssText = 'color:#e2e4e9;font-size:0.95rem;font-weight:600;';
        var varHideHint = document.createElement('span');
        varHideHint.textContent = '勾选后该变量在面板中不显示';
        varHideHint.style.cssText = 'color:#8b92a8;font-size:0.75rem;';
        varHideTitle.appendChild(varHideLabel);
        varHideTitle.appendChild(varHideHint);
        varHideSection.appendChild(varHideTitle);

        // 全选/取消全选
        var varSelectAllRow = document.createElement('div');
        varSelectAllRow.style.cssText = 'margin-bottom:8px;';
        var varSelectAllLbl = document.createElement('label');
        varSelectAllLbl.style.cssText = 'display:flex;align-items:center;gap:8px;color:#8b92a8;font-size:0.8rem;cursor:pointer;';
        var varSelectAllCb = document.createElement('input');
        varSelectAllCb.type = 'checkbox';
        varSelectAllCb.style.accentColor = '#5b8cff';
        varSelectAllLbl.appendChild(varSelectAllCb);
        varSelectAllLbl.appendChild(document.createTextNode('全选/取消'));
        varSelectAllRow.appendChild(varSelectAllLbl);
        varHideSection.appendChild(varSelectAllRow);

        var varList = document.createElement('div');
        varList.style.cssText = 'max-height:160px;overflow-y:auto;';
        allVars.forEach(function(v) {
          var row = document.createElement('label');
          row.style.cssText = 'display:flex;align-items:center;gap:8px;color:#e2e4e9;font-size:0.85rem;cursor:pointer;margin-bottom:6px;';
          var cb = document.createElement('input');
          cb.type = 'checkbox';
          cb.checked = false;
          cb.style.accentColor = '#5b8cff';
          row.appendChild(cb);
          var typeTag = document.createElement('span');
          typeTag.style.cssText = 'font-size:0.7rem;color:#8b92a8;background:#1a1d24;padding:1px 6px;border-radius:8px;';
          typeTag.textContent = v.type;
          row.appendChild(typeTag);
          row.appendChild(document.createTextNode(v.name));
          varList.appendChild(row);
          hiddenVarCheckboxes[v.id] = cb;
        });
        varHideSection.appendChild(varList);

        varSelectAllCb.onchange = function() {
          var checked = varSelectAllCb.checked;
          Object.keys(hiddenVarCheckboxes).forEach(function(vid) {
            hiddenVarCheckboxes[vid].checked = checked;
          });
        };

        modal.appendChild(varHideSection);
      }

      // ===== 隐藏部分结局 =====
      var hiddenEndingCheckboxes = {};
      if (endings.length > 0) {
        var endingHideSection = document.createElement('div');
        endingHideSection.style.cssText = 'margin-bottom:20px;padding:16px;border:1px solid #2a2e38;border-radius:10px;background:#0f1115;';

        var endingHideTitle = document.createElement('div');
        endingHideTitle.style.cssText = 'display:flex;align-items:center;justify-content:space-between;margin-bottom:12px;';
        var endingHideLabel = document.createElement('span');
        endingHideLabel.textContent = '隐藏部分结局';
        endingHideLabel.style.cssText = 'color:#e2e4e9;font-size:0.95rem;font-weight:600;';
        var endingHideHint = document.createElement('span');
        endingHideHint.textContent = '勾选后该结局在图鉴中不显示';
        endingHideHint.style.cssText = 'color:#8b92a8;font-size:0.75rem;';
        endingHideTitle.appendChild(endingHideLabel);
        endingHideTitle.appendChild(endingHideHint);
        endingHideSection.appendChild(endingHideTitle);

        var endingSelectAllRow = document.createElement('div');
        endingSelectAllRow.style.cssText = 'margin-bottom:8px;';
        var endingSelectAllLbl = document.createElement('label');
        endingSelectAllLbl.style.cssText = 'display:flex;align-items:center;gap:8px;color:#8b92a8;font-size:0.8rem;cursor:pointer;';
        var endingSelectAllCb = document.createElement('input');
        endingSelectAllCb.type = 'checkbox';
        endingSelectAllCb.style.accentColor = '#5b8cff';
        endingSelectAllLbl.appendChild(endingSelectAllCb);
        endingSelectAllLbl.appendChild(document.createTextNode('全选/取消'));
        endingSelectAllRow.appendChild(endingSelectAllLbl);
        endingHideSection.appendChild(endingSelectAllRow);

        var endingList = document.createElement('div');
        endingList.style.cssText = 'max-height:160px;overflow-y:auto;';
        endings.forEach(function(ending) {
          var row = document.createElement('label');
          row.style.cssText = 'display:flex;align-items:center;gap:8px;color:#e2e4e9;font-size:0.85rem;cursor:pointer;margin-bottom:6px;';
          var cb = document.createElement('input');
          cb.type = 'checkbox';
          cb.checked = false;
          cb.style.accentColor = '#5b8cff';
          row.appendChild(cb);
          row.appendChild(document.createTextNode(ending.title));
          endingList.appendChild(row);
          hiddenEndingCheckboxes[ending.id] = cb;
        });
        endingHideSection.appendChild(endingList);

        endingSelectAllCb.onchange = function() {
          var checked = endingSelectAllCb.checked;
          Object.keys(hiddenEndingCheckboxes).forEach(function(eid) {
            hiddenEndingCheckboxes[eid].checked = checked;
          });
        };

        modal.appendChild(endingHideSection);
      }

      // ===== 结局设置 =====
      if (endings.length === 0) {
        var empty = document.createElement('p');
        empty.textContent = '当前剧本没有结局节点。';
        empty.style.cssText = 'color:#8b92a8;text-align:center;padding:20px;';
        modal.appendChild(empty);
      } else {
        var settingsDiv = document.createElement('div');
        settingsDiv.style.cssText = 'margin-bottom:20px;padding:16px;border:1px solid #2a2e38;border-radius:10px;background:#0f1115;';

        var endingTitle = document.createElement('div');
        endingTitle.textContent = '结局显示设置';
        endingTitle.style.cssText = 'color:#e2e4e9;font-size:0.95rem;font-weight:600;margin-bottom:12px;';
        settingsDiv.appendChild(endingTitle);

        var visLabel = document.createElement('label');
        visLabel.style.cssText = 'display:flex;align-items:center;gap:8px;color:#e2e4e9;font-size:0.9rem;cursor:pointer;margin-bottom:12px;';
        var visCheckbox = document.createElement('input');
        visCheckbox.type = 'checkbox';
        visCheckbox.checked = true;
        visCheckbox.style.accentColor = '#5b8cff';
        visLabel.appendChild(visCheckbox);
        visLabel.appendChild(document.createTextNode('未解锁结局可见（取消则隐藏未达成的结局）'));
        settingsDiv.appendChild(visLabel);

        var hideNameLabel = document.createElement('label');
        hideNameLabel.style.cssText = 'display:flex;align-items:center;gap:8px;color:#e2e4e9;font-size:0.9rem;cursor:pointer;';
        var hideNameCheckbox = document.createElement('input');
        hideNameCheckbox.type = 'checkbox';
        hideNameCheckbox.checked = false;
        hideNameCheckbox.style.accentColor = '#5b8cff';
        hideNameLabel.appendChild(hideNameCheckbox);
        hideNameLabel.appendChild(document.createTextNode('隐藏未解锁结局名称（显示为 ???）'));
        settingsDiv.appendChild(hideNameLabel);

        modal.appendChild(settingsDiv);

        var listTitle = document.createElement('div');
        listTitle.textContent = '结局达成线索（不填则默认显示 ???）';
        listTitle.style.cssText = 'color:#e2e4e9;font-size:0.95rem;font-weight:600;margin-bottom:12px;';
        modal.appendChild(listTitle);

        var clueInputs = {};
        endings.forEach(function(ending) {
          var item = document.createElement('div');
          item.style.cssText = 'margin-bottom:12px;padding:12px;border:1px solid #2a2e38;border-radius:8px;background:#0f1115;';

          var nameDiv = document.createElement('div');
          nameDiv.style.cssText = 'color:#e2e4e9;font-weight:600;font-size:0.9rem;margin-bottom:6px;';
          nameDiv.textContent = ending.title;
          item.appendChild(nameDiv);

          var input = document.createElement('input');
          input.type = 'text';
          input.placeholder = '输入达成线索...';
          input.style.cssText = 'width:100%;padding:8px 10px;border-radius:6px;border:1px solid #2a2e38;background:#1a1d24;color:#e2e4e9;font-size:0.85rem;outline:none;font-family:inherit;';
          input.onfocus = function() { input.style.borderColor = '#5b8cff'; };
          input.onblur = function() { input.style.borderColor = '#2a2e38'; };
          item.appendChild(input);

          clueInputs[ending.id] = input;
          modal.appendChild(item);
        });
      }

      // ===== 预填充缓存的设置 =====
      if (cachedSettings) {
        // 预填充文件名设置
        if (cs.prefix !== undefined) prefixInput.value = cs.prefix;
        if (cs.customName) customNameInput.value = cs.customName;
        updatePreview();
        // 预填充功能隐藏设置
        if (cs.publishSettings) {
          Object.keys(hideCheckboxes).forEach(function(key) {
            if (cs.publishSettings[key] !== undefined) {
              hideCheckboxes[key].checked = cs.publishSettings[key];
            }
          });
          // 预填充隐藏的变量
          if (Array.isArray(cs.publishSettings.hiddenVariables)) {
            cs.publishSettings.hiddenVariables.forEach(function(vid) {
              if (hiddenVarCheckboxes[vid]) hiddenVarCheckboxes[vid].checked = true;
            });
          }
          // 预填充隐藏的结局
          if (Array.isArray(cs.publishSettings.hiddenEndings)) {
            cs.publishSettings.hiddenEndings.forEach(function(eid) {
              if (hiddenEndingCheckboxes[eid]) hiddenEndingCheckboxes[eid].checked = true;
            });
          }
        }
        // 预填充结局显示设置
        if (typeof visCheckbox !== 'undefined' && cs.showLockedEndings !== undefined) {
          visCheckbox.checked = cs.showLockedEndings;
        }
        if (typeof hideNameCheckbox !== 'undefined' && cs.hideLockedEndingNames !== undefined) {
          hideNameCheckbox.checked = cs.hideLockedEndingNames;
        }
        // 预填充线索输入
        if (cs.endingClues && typeof clueInputs !== 'undefined') {
          Object.keys(clueInputs).forEach(function(eid) {
            if (cs.endingClues[eid]) clueInputs[eid].value = cs.endingClues[eid];
          });
        }
        console.log('[发布设置] 已预填充缓存的设置');
      }

      // 操作按钮
      var actions = document.createElement('div');
      actions.className = 'seven-cutout-actions';

      var cancelBtn = document.createElement('button');
      cancelBtn.textContent = '取消';
      cancelBtn.onclick = function() {
        document.body.removeChild(backdrop);
        resolve(null);
      };
      actions.appendChild(cancelBtn);

      var saveBtn = document.createElement('button');
      saveBtn.className = 'primary';
      saveBtn.textContent = '确认并继续';
      saveBtn.onclick = function() {
        var endingClues = {};
        if (endings.length > 0) {
          endings.forEach(function(ending) {
            var val = clueInputs[ending.id] ? clueInputs[ending.id].value.trim() : '';
            if (val) endingClues[ending.id] = val;
          });
        }
        // 收集隐藏设置
        var publishSettings = {};
        Object.keys(hideCheckboxes).forEach(function(key) {
          publishSettings[key] = hideCheckboxes[key].checked;
        });
        // 收集隐藏的变量ID
        var hiddenVariables = [];
        Object.keys(hiddenVarCheckboxes).forEach(function(vid) {
          if (hiddenVarCheckboxes[vid].checked) hiddenVariables.push(vid);
        });
        publishSettings.hiddenVariables = hiddenVariables;
        // 收集隐藏的结局ID
        var hiddenEndings = [];
        Object.keys(hiddenEndingCheckboxes).forEach(function(eid) {
          if (hiddenEndingCheckboxes[eid].checked) hiddenEndings.push(eid);
        });
        publishSettings.hiddenEndings = hiddenEndings;
        var settings = {
          showLockedEndings: endings.length === 0 ? true : visCheckbox.checked,
          hideLockedEndingNames: endings.length === 0 ? false : hideNameCheckbox.checked,
          endingClues: endingClues,
          publishSettings: publishSettings,
          exportFileName: (prefixInput.value || '') + (customNameInput.value.trim() || projectTitle),
          prefix: prefixInput.value || '',
          customName: customNameInput.value.trim() || ''
        };
        // 缓存发布设置，供预览模式使用
        window._funloomCachedPublishSettings = settings;
        console.log('[发布设置] 已缓存，供预览使用');
        document.body.removeChild(backdrop);
        resolve(settings);
      };
      actions.appendChild(saveBtn);

      modal.appendChild(actions);
      backdrop.appendChild(modal);
      document.body.appendChild(backdrop);
    });
  }

  // ==================== 拦截原导出按钮 ====================

  function isImportButton(btn) {
    if (!btn || btn.tagName !== 'BUTTON') return false;
    const text = (btn.textContent || '').trim();
    const title = btn.getAttribute('title') || '';
    const ariaLabel = btn.getAttribute('aria-label') || '';
    return text.includes('导入') || title.includes('导入') || ariaLabel.includes('导入');
  }

  function isExportButton(btn) {
    if (!btn || btn.tagName !== 'BUTTON') return false;
    if (isImportButton(btn)) return false;

    const cls = btn.className || '';
    if (typeof cls === 'string' && cls.includes('export-button')) return true;

    const text = (btn.textContent || '').trim();
    if (text.includes('导出项目包') || text.includes('打包中')) return true;

    const title = btn.getAttribute('title') || '';
    const ariaLabel = btn.getAttribute('aria-label') || '';
    const label = title || ariaLabel;
    if (label.includes('导出')) return true;

    return false;
  }

  function interceptClick(e) {
    const btn = e.target.closest('button');
    if (!btn || !isExportButton(btn)) return;

    // 排除工作台托盘/资产面板内的按钮，避免误拦截
    const inTray = btn.closest('.workbench-tray, .workbench-tray-content, .content-browser-panel, [class*="tray-panel"]');
    if (inTray) return;

    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();

    if (!isExporting) {
      handleExport();
    }
  }

  // ==================== 移除AI功能 & 资产本地上传 ====================

  function injectAIRemovalStyles() {
    if (document.getElementById('seven-ai-removal-styles')) return;
    var style = document.createElement('style');
    style.id = 'seven-ai-removal-styles';
    // 只隐藏确切的AI相关元素，避免误伤正常UI
    style.textContent = [
      // AI生成按钮（精确class匹配）
      '.ai-generate-plot, .ai-generate-choices, .ai-generate-scene, .ai-generate-portrait { display: none !important; }',
      // Seedance相关
      '.seedance-status-button, .seedance-queue, .seedance-popover { display: none !important; }',
      // 积分显示（精确class）
      '.workbench-points, .points-inline, .workbench-points-refresh { display: none !important; }',
      // 云端上传按钮（精确class）
      '.upload-cloud-button, .cloud-upload-button { display: none !important; }',
      // AI润色
      '.ai-polish-button, .polish-ai-button { display: none !important; }',
      // AI创建
      '.ai-create-button { display: none !important; }',
      // 七七Token
      '.qiqi-token, .token-input { display: none !important; }',
      // API配置
      '.api-config, .api-setting { display: none !important; }',
      // 新建项目AI选项
      '.idea-create, .document-parse, .txt-import { display: none !important; }',
      // 分镜生成
      '.storyboard-generate, .video-generate, .render-segment { display: none !important; }',
      // AI模型选择
      '.nano-banana, .ai-model-select { display: none !important; }',
      // 清晰度选择（AI专用）
      '.ai-resolution-select { display: none !important; }',
      // 云端tab
      '.cloud-tab, .tray-cloud { display: none !important; }',
      // AI导演
      '.director-storyboard, .ai-director { display: none !important; }',
      // 生成订单与进度按钮
      '.seedance-status-button { display: none !important; }'
    ].join('\n');
    document.head.appendChild(style);
  }

  // 动态隐藏AI元素 - 仅精确匹配，不做宽泛关键词搜索
  function hideAIElements() {
    // 1. 隐藏"上传到七七云端"按钮（精确文本匹配）
    var allBtns = document.querySelectorAll('button, a, [role="button"]');
    allBtns.forEach(function(btn) {
      var text = (btn.textContent || '').trim();
      // 只隐藏完全匹配的AI按钮
      if (text === '上传到七七云端' ||
          text === '拉取云端' ||
          text === '云端剧本' ||
          text === '生成订单与进度' ||
          text === '当前积分' ||
          text === '七七Token' || text === '七七 Token' ||
          text === 'AI润色' || text === 'AI创建' || text === 'AI导演' ||
          text === '一句话生成' || text === '解析文档' ||
          text === '生成选项' || text === '生成剧情' ||
          text === '生成分镜' || text === '生成立绘' || text === '生成场景' ||
          text === 'AI文档解析' || text === 'AI一句话' ||
          text === '剧本书生成' || text === 'AI生成') {
        btn.style.display = 'none';
      }
    });

    // 2. 隐藏"当前积分"文本
    var spans = document.querySelectorAll('span, div, p');
    spans.forEach(function(el) {
      var text = (el.textContent || '').trim();
      if (el.children.length === 0) {
        if (text === '当前积分' || text === '七七 Token' || text === '七七Token' || text === '生成订单与进度') {
          el.style.display = 'none';
        }
      }
    });

    // 3. 隐藏工作台托盘中的"云端"tab（精确匹配）
    var trayTabBtns = document.querySelectorAll('.workbench-tray-tab:not(.workbench-tray-tabs)');
    trayTabBtns.forEach(function(tab) {
      var tabText = '';
      tab.childNodes.forEach(function(node) {
        if (node.nodeType === 3) tabText += node.textContent;
      });
      tabText = tabText.trim();
      if (tabText === '云端') {
        tab.style.display = 'none';
      }
    });

    // 4. 隐藏"七七配置"按钮（精确匹配）
    var configBtns = document.querySelectorAll('button');
    configBtns.forEach(function(btn) {
      var text = (btn.textContent || '').trim();
      var title = btn.getAttribute('title') || '';
      var ariaLabel = btn.getAttribute('aria-label') || '';
      if (text === '七七配置' || title === '七七配置' || ariaLabel === '七七配置' ||
          text === '打开 七七配置' || title === '打开 七七配置' || ariaLabel === '打开 七七配置') {
        btn.style.display = 'none';
      }
    });
  }

  // 拦截AI功能调用 - 仅拦截确切的AI API端点
  function interceptAICalls() {
    var originalFetch = window.fetch;
    var aiUrlPatterns = [
      'screenwriter', 'generate-choices', 'generate-plot',
      'generate-from-idea', '/ai/', 'seedance', 'nano-banana',
      'generate-portrait', 'generate-scene', 'generate-character',
      'funloom.io/api', '/v1/generate',
      'render-video', 'generate-video', 'text-to-speech'
    ];
    window.fetch = function(url, options) {
      var urlStr = typeof url === 'string' ? url : (url && url.url) || '';
      for (var i = 0; i < aiUrlPatterns.length; i++) {
        if (urlStr.indexOf(aiUrlPatterns[i]) >= 0) {
          console.log('[已拦截AI请求]:', urlStr);
          return Promise.reject(new Error('AI功能已禁用'));
        }
      }
      return originalFetch.apply(this, arguments);
    };

    // 仅拦截确切的AI按钮点击（不做宽泛关键词匹配）
    var aiClickTexts = [
      'AI润色', 'AI创建', 'AI导演', '一句话生成', '解析文档',
      '生成选项', '生成剧情', '生成分镜', '生成立绘', '生成场景',
      '上传到七七云端', '拉取云端', '云端剧本', '剧本书生成',
      'AI文档解析', 'AI一句话', 'AI生成'
    ];
    document.addEventListener('click', function(e) {
      var target = e.target;
      var btn = target.closest('button, a, [role="button"]');
      if (!btn) return;
      var text = (btn.textContent || '').trim();
      var cls = btn.className || '';
      if (typeof cls !== 'string') cls = '';

      // 精确文本匹配
      for (var i = 0; i < aiClickTexts.length; i++) {
        if (text === aiClickTexts[i]) {
          e.preventDefault();
          e.stopPropagation();
          e.stopImmediatePropagation();
          break;
        }
      }
      // 精确class匹配
      if (cls.indexOf('ai-generate') >= 0 || cls.indexOf('seedance') >= 0) {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
      }
    }, true);
  }

  // 确保资产图片使用本地上传 - 仅隐藏确切的AI生成区域
  function enforceLocalUpload() {
    var observer = new MutationObserver(function(mutations) {
      mutations.forEach(function(m) {
        m.addedNodes.forEach(function(node) {
          if (node.nodeType !== 1) return;

          // 仅隐藏确切的AI生成相关class（不做宽泛匹配）
          var aiSelectors = [
            '.ai-generate-plot', '.ai-generate-choices', '.ai-generate-scene',
            '.ai-generate-portrait', '.ai-polish-button', '.ai-create-button',
            '.seedance-status-button', '.seedance-queue', '.seedance-popover',
            '.storyboard-generate', '.video-generate', '.render-segment',
            '.nano-banana', '.ai-model-select', '.ai-resolution-select',
            '.cloud-tab', '.tray-cloud', '.director-storyboard', '.ai-director',
            '.qiqi-token', '.token-input', '.api-config', '.api-setting',
            '.idea-create', '.document-parse', '.txt-import'
          ];

          if (node.querySelectorAll) {
            aiSelectors.forEach(function(sel) {
              var els = node.querySelectorAll(sel);
              els.forEach(function(el) { el.style.display = 'none'; });
            });

            // 仅隐藏精确匹配AI文本的按钮
            var genBtns = node.querySelectorAll('button, a, [role="button"]');
            genBtns.forEach(function(btn) {
              var t = (btn.textContent || '').trim();
              if (t === '生成选项' || t === '生成剧情' || t === '生成分镜' ||
                  t === '生成立绘' || t === '生成场景' || t === 'AI润色' ||
                  t === 'AI创建' || t === 'AI导演' || t === '一句话生成' ||
                  t === '上传到七七云端' || t === '拉取云端' || t === '云端剧本' ||
                  t === '剧书籍生成' || t === 'AI生成' || t === '解析文档') {
                btn.style.display = 'none';
              }
            });
          }
        });
      });
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  // 初始化AI移除
  function setupAIRemoval() {
    injectAIRemovalStyles();
    interceptAICalls();
    enforceLocalUpload();
    hideAIElements();
    setTimeout(hideAIElements, 500);
    setTimeout(hideAIElements, 2000);
    setTimeout(hideAIElements, 5000);
    setInterval(hideAIElements, 3000);
  }

  // ==================== 检查器面板背景图片注入 ====================

  // 注入自定义样式
  function injectBgStyles() {
    if (document.getElementById('seven-bg-inspector-styles')) return;
    const style = document.createElement('style');
    style.id = 'seven-bg-inspector-styles';
    style.textContent = `
      .seven-bg-section{margin-top:0}
      .seven-bg-section .config-field select{
        width:100%;padding:12px 14px;border-radius:14px;
        border:1px solid var(--line);background:var(--field-bg);
        color:var(--text-main);font-size:14px;font-family:inherit;
        outline:none;cursor:pointer;appearance:auto;
      }
      .seven-bg-upload-row{display:flex;align-items:center;gap:8px;margin-top:8px}
      .seven-bg-upload-btn{
        display:inline-flex;align-items:center;gap:4px;
        padding:8px 14px;border-radius:10px;
        border:1px solid var(--line);background:var(--field-bg);
        color:var(--text-subtle);cursor:pointer;font-size:13px;
        font-family:inherit;transition:border-color .2s;white-space:nowrap;
      }
      .seven-bg-upload-btn:hover{border-color:var(--accent-border)}
      .seven-bg-upload-btn input{display:none}
      .seven-bg-file-name{color:var(--text-subtle);font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .seven-bg-preview{margin-top:10px;border-radius:10px;overflow:hidden;border:1px solid var(--line);max-width:100%}
      .seven-bg-preview img{display:block;width:100%;max-height:140px;object-fit:cover}
      .seven-bg-clear-btn{
        display:block;margin-top:8px;padding:6px 12px;
        border-radius:8px;border:1px solid var(--line);
        background:transparent;color:var(--danger);
        cursor:pointer;font-size:12px;font-family:inherit;
        transition:background .2s;
      }
      .seven-bg-clear-btn:hover{background:var(--danger-soft)}
      .seven-bg-status{font-size:11px;color:var(--text-subtle);margin-top:4px;font-style:italic}
      .seven-bg-adjust-btn{
        display:block;margin-top:8px;padding:8px 14px;
        border-radius:10px;border:1px solid var(--line);
        background:var(--field-bg);color:var(--text-main);
        cursor:pointer;font-size:13px;font-family:inherit;
        transition:border-color .2s;width:100%;text-align:center;
      }
      .seven-bg-adjust-btn:hover{border-color:var(--accent-border)}
      .seven-bg-adjust-overlay{
        position:fixed;inset:0;z-index:100003;
        background:rgba(0,0,0,.85);display:flex;
        align-items:center;justify-content:center;
      }
      .seven-bg-adjust-modal{
        background:#1a1d24;border:1px solid #2a2e38;
        border-radius:16px;padding:24px;width:90%;max-width:560px;
        color:#e2e4e9;
      }
      .seven-bg-adjust-title{font-size:1.1rem;margin-bottom:16px;text-align:center}
      .seven-bg-canvas-container{
        position:relative;width:100%;height:300px;
        background:#0f1115;border:1px solid #2a2e38;
        border-radius:12px;overflow:hidden;cursor:move;
        margin-bottom:16px;background-image:
          linear-gradient(45deg,#1a1d24 25%,transparent 25%),
          linear-gradient(-45deg,#1a1d24 25%,transparent 25%),
          linear-gradient(45deg,transparent 75%,#1a1d24 75%),
          linear-gradient(-45deg,transparent 75%,#1a1d24 75%);
        background-size:20px 20px;
        background-position:0 0,0 10px,10px -10px,-10px 0;
      }
      .seven-bg-canvas-container canvas{
        position:absolute;top:0;left:0;
        pointer-events:none;
      }
      .seven-bg-crop-overlay{
        position:absolute;border:2px dashed #5b8cff;
        pointer-events:none;box-shadow:0 0 0 9999px rgba(0,0,0,.5);
      }
      .seven-bg-slider-row{display:flex;align-items:center;gap:8px;margin-bottom:10px}
      .seven-bg-slider-label{font-size:13px;color:#8b92a8;min-width:70px;white-space:nowrap}
      .seven-bg-slider{flex:1;-webkit-appearance:none;height:4px;border-radius:2px;background:#2a2e38;outline:none}
      .seven-bg-slider::-webkit-slider-thumb{-webkit-appearance:none;width:16px;height:16px;border-radius:50%;background:#5b8cff;cursor:pointer}
      .seven-bg-slider::-moz-range-thumb{width:16px;height:16px;border-radius:50%;background:#5b8cff;cursor:pointer;border:none}
      .seven-bg-slider-value{font-size:12px;color:#e2e4e9;min-width:40px;text-align:right}
      .seven-bg-adjust-actions{display:flex;gap:10px;margin-top:16px}
      .seven-bg-adjust-actions button{
        flex:1;padding:10px;border-radius:10px;
        border:1px solid #2a2e38;background:transparent;
        color:#8b92a8;cursor:pointer;font-size:14px;font-family:inherit;
        transition:all .2s;
      }
      .seven-bg-adjust-actions .primary{
        background:#5b8cff;border-color:#5b8cff;color:#fff;
      }
      .seven-bg-adjust-actions .primary:hover{background:#4a7aef}
      .seven-bg-adjust-actions .secondary:hover{border-color:#3a3e48}
      .seven-bg-preset-row{display:flex;gap:6px;margin-bottom:10px;flex-wrap:wrap}
      .seven-bg-preset-btn{
        padding:4px 10px;border-radius:6px;border:1px solid #2a2e38;
        background:transparent;color:#8b92a8;cursor:pointer;
        font-size:11px;font-family:inherit;transition:all .2s;
      }
      .seven-bg-preset-btn:hover{border-color:#5b8cff;color:#5b8cff}
    `;
    document.head.appendChild(style);
  }

  // 通过 React Fiber 获取检查器中的节点数据和更新回调
  function getInspectorNodeData(el) {
    if (!el) return null;
    const fiberKey = Object.keys(el).find(
      k => k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$')
    );
    if (!fiberKey) return null;

    let fiber = el[fiberKey];
    let depth = 0;
    while (fiber && depth < 60) {
      const props = fiber.memoizedProps;
      if (props && props.node && props.node.id && props.node.data) {
        return {
          node: props.node,
          onUpdateNode: props.onUpdateNode || null
        };
      }
      fiber = fiber.return;
      depth++;
    }
    return null;
  }

  // 当前注入状态跟踪
  let lastInjectedNodeId = null;
  let lastMinigameNodeId = null;

  // 创建背景图片设置区块
  function createBgSection(node, onUpdateNode) {
    const bg = node.data.backgroundImage || {};
    const currentUrl = bg.type === 'url' ? (bg.url || '') : '';
    const currentBase64 = bg.type === 'base64' ? (bg.data || '') : '';
    const currentBgTheme = bg.bgTheme || 'dark';
    const hasBg = !!(currentUrl || currentBase64);

    const section = document.createElement('section');
    section.className = 'inspector-section seven-bg-section';

    // 标题
    const titleDiv = document.createElement('div');
    titleDiv.className = 'inspector-section-title';
    titleDiv.innerHTML = '<strong>背景图片</strong>';
    section.appendChild(titleDiv);

    // URL 输入
    const urlField = document.createElement('label');
    urlField.className = 'config-field';
    urlField.innerHTML = '<span>图片链接</span>';
    const urlInput = document.createElement('input');
    urlInput.type = 'text';
    urlInput.placeholder = '输入图片 URL...';
    urlInput.value = currentUrl;
    urlInput.dataset.role = 'bg-url';
    urlField.appendChild(urlInput);
    section.appendChild(urlField);

    // 文件上传行
    const uploadRow = document.createElement('div');
    uploadRow.className = 'seven-bg-upload-row';
    const uploadLabel = document.createElement('label');
    uploadLabel.className = 'seven-bg-upload-btn';
    uploadLabel.textContent = '📎 上传本地图片';
    const fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.accept = 'image/*';
    fileInput.dataset.role = 'bg-file';
    uploadLabel.appendChild(fileInput);
    const fileName = document.createElement('span');
    fileName.className = 'seven-bg-file-name';
    fileName.dataset.role = 'bg-file-name';
    if (currentBase64) fileName.textContent = '已设置本地图片';
    uploadRow.appendChild(uploadLabel);
    uploadRow.appendChild(fileName);
    section.appendChild(uploadRow);

    // 遮罩选择
    const maskField = document.createElement('label');
    maskField.className = 'config-field';
    maskField.innerHTML = '<span>背景遮罩</span>';
    const maskSelect = document.createElement('select');
    maskSelect.dataset.role = 'bg-mask';
    const darkOpt = document.createElement('option');
    darkOpt.value = 'dark';
    darkOpt.textContent = '暗色遮罩';
    const lightOpt = document.createElement('option');
    lightOpt.value = 'light';
    lightOpt.textContent = '亮色遮罩';
    maskSelect.appendChild(darkOpt);
    maskSelect.appendChild(lightOpt);
    maskSelect.value = currentBgTheme;
    maskField.appendChild(maskSelect);
    section.appendChild(maskField);

    // 预览
    const previewDiv = document.createElement('div');
    previewDiv.className = 'seven-bg-preview';
    previewDiv.dataset.role = 'bg-preview';
    if (hasBg) {
      const img = document.createElement('img');
      img.src = currentUrl || currentBase64;
      previewDiv.appendChild(img);
    } else {
      previewDiv.style.display = 'none';
    }
    section.appendChild(previewDiv);

    // 状态提示
    const statusDiv = document.createElement('div');
    statusDiv.className = 'seven-bg-status';
    statusDiv.dataset.role = 'bg-status';
    statusDiv.textContent = hasBg ? '已设置背景图片' : '未设置背景图片';
    section.appendChild(statusDiv);

    // 清除按钮
    const clearBtn = document.createElement('button');
    clearBtn.className = 'seven-bg-clear-btn';
    clearBtn.textContent = '清除背景';
    clearBtn.dataset.role = 'bg-clear';
    if (!hasBg) clearBtn.style.display = 'none';
    section.appendChild(clearBtn);

    // 调整背景按钮（可视化调整大小和展示区域）
    const adjustBtn = document.createElement('button');
    adjustBtn.className = 'seven-bg-adjust-btn';
    adjustBtn.textContent = '调整背景（大小/位置/裁剪）';
    adjustBtn.dataset.role = 'bg-adjust';
    if (!hasBg) adjustBtn.style.display = 'none';
    section.appendChild(adjustBtn);

    // ===== 事件处理 =====

    // 保存背景到节点
    function saveBackground(bgData) {
      if (onUpdateNode) {
        onUpdateNode(node.id, { backgroundImage: bgData });
      } else {
        // 降级：直接写 IndexedDB
        saveBackgroundViaIDB(node.id, bgData);
      }
      updatePreview(bgData);
    }

    function updatePreview(bgData) {
      const url = bgData && bgData.type === 'url' ? bgData.url : '';
      const b64 = bgData && bgData.type === 'base64' ? bgData.data : '';
      const has = !!(url || b64);
      if (has) {
        previewDiv.style.display = '';
        let img = previewDiv.querySelector('img');
        if (!img) {
          img = document.createElement('img');
          previewDiv.appendChild(img);
        }
        img.src = url || b64;
        statusDiv.textContent = '已设置背景图片';
        clearBtn.style.display = '';
        adjustBtn.style.display = '';
      } else {
        previewDiv.style.display = 'none';
        statusDiv.textContent = '未设置背景图片';
        clearBtn.style.display = 'none';
        adjustBtn.style.display = 'none';
      }
    }

    // URL 输入防抖
    let urlTimer = null;
    urlInput.addEventListener('input', function() {
      clearTimeout(urlTimer);
      urlTimer = setTimeout(function() {
        const url = urlInput.value.trim();
        const mask = maskSelect.value;
        if (url) {
          fileName.textContent = '';
          saveBackground({ type: 'url', url: url, bgTheme: mask });
        } else if (!fileName.dataset.base64) {
          saveBackground(undefined);
        }
      }, 500);
    });

    // 文件上传
    fileInput.addEventListener('change', function(e) {
      const file = e.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = function() {
        urlInput.value = '';
        fileName.textContent = '已上传: ' + file.name;
        fileName.dataset.base64 = '1';
        saveBackground({ type: 'base64', data: reader.result, bgTheme: maskSelect.value });
      };
      reader.readAsDataURL(file);
      fileInput.value = '';
    });

    // 遮罩切换
    maskSelect.addEventListener('change', function() {
      var url = urlInput.value.trim();
      var b64 = fileName.dataset.base64;
      var mask = maskSelect.value;
      // 从 DOM 重新获取最新节点数据
      var editorEl = section.closest('.inspector-node-editor') || document.querySelector('.inspector-node-editor');
      var freshBg = null;
      if (editorEl) {
        var fKey = Object.keys(editorEl).find(function(k) { return k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$'); });
        if (fKey) {
          var fiber = editorEl[fKey];
          var cur = fiber;
          while (cur) {
            if (cur.memoizedProps && cur.memoizedProps.node) { freshBg = cur.memoizedProps.node.data?.backgroundImage; break; }
            cur = cur.return;
          }
        }
      }
      var existingBg = freshBg || node.data.backgroundImage;
      if (b64) {
        if (existingBg && existingBg.data) {
          saveBackground({ type: 'base64', data: existingBg.data, bgTheme: mask });
        }
      } else if (url) {
        saveBackground({ type: 'url', url: url, bgTheme: mask });
      } else {
        if (existingBg) {
          saveBackground(Object.assign({}, existingBg, { bgTheme: mask }));
        }
      }
    });

    // 清除
    clearBtn.addEventListener('click', function() {
      urlInput.value = '';
      fileName.textContent = '';
      delete fileName.dataset.base64;
      maskSelect.value = 'dark';
      saveBackground(undefined);
    });

    // 调整背景（可视化编辑器）—— 每次点击时重新从 DOM 读取最新节点数据
    adjustBtn.addEventListener('click', function() {
      // 从检查器 DOM 重新获取最新的节点数据（避免闭包中 node 过期）
      var editorEl = section.closest('.inspector-node-editor') || document.querySelector('.inspector-node-editor');
      var freshNode = null;
      if (editorEl) {
        var fKey = Object.keys(editorEl).find(function(k) { return k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$'); });
        if (fKey) {
          var fiber = editorEl[fKey];
          var cur = fiber;
          while (cur) {
            if (cur.memoizedProps && cur.memoizedProps.node) { freshNode = cur.memoizedProps.node; break; }
            cur = cur.return;
          }
        }
      }
      var bgData = (freshNode ? freshNode.data : node.data) || {};
      var existingBg = bgData.backgroundImage || {};
      var bgSrc = existingBg.type === 'url' ? existingBg.url : (existingBg.type === 'base64' ? existingBg.data : '');
      if (!bgSrc) {
        // 如果节点数据中没有，尝试从输入框读取
        var inputUrl = urlInput.value.trim();
        if (inputUrl) {
          bgSrc = inputUrl;
          existingBg = { type: 'url', url: inputUrl, bgTheme: maskSelect.value };
        } else {
          return;
        }
      }

      // 获取当前调整参数（如有）
      var adj = existingBg.adjust || { scale: 100, offsetX: 0, offsetY: 0, cropX: 0, cropY: 0, cropW: 100, cropH: 100 };

      showBgAdjustEditor(bgSrc, adj, function(newAdj) {
        // 保存调整参数到背景数据
        var updatedBg = Object.assign({}, existingBg, { adjust: newAdj });
        saveBackground(updatedBg);
      });
    });

    return section;
  }

  // 可视化背景调整编辑器
  function showBgAdjustEditor(bgSrc, initialAdj, onSave) {
    const backdrop = document.createElement('div');
    backdrop.className = 'seven-bg-adjust-overlay';

    const modal = document.createElement('div');
    modal.className = 'seven-bg-adjust-modal';

    const title = document.createElement('div');
    title.className = 'seven-bg-adjust-title';
    title.textContent = '调整背景图片';
    modal.appendChild(title);

    // 画布容器
    const canvasContainer = document.createElement('div');
    canvasContainer.className = 'seven-bg-canvas-container';

    const canvas = document.createElement('canvas');
    canvasContainer.appendChild(canvas);

    const cropOverlay = document.createElement('div');
    cropOverlay.className = 'seven-bg-crop-overlay';
    canvasContainer.appendChild(cropOverlay);

    modal.appendChild(canvasContainer);

    // 预设按钮行
    const presetRow = document.createElement('div');
    presetRow.className = 'seven-bg-preset-row';
    const presets = [
      { label: '居中', adj: { scale: 100, offsetX: 0, offsetY: 0, cropX: 0, cropY: 0, cropW: 100, cropH: 100 } },
      { label: '铺满', adj: { scale: 130, offsetX: 0, offsetY: 0, cropX: 0, cropY: 0, cropW: 100, cropH: 100 } },
      { label: '放大', adj: { scale: 200, offsetX: 0, offsetY: 0, cropX: 0, cropY: 0, cropW: 100, cropH: 100 } },
      { label: '上部裁剪', adj: { scale: 100, offsetX: 0, offsetY: 0, cropX: 0, cropY: 0, cropW: 100, cropH: 60 } },
      { label: '中部裁剪', adj: { scale: 100, offsetX: 0, offsetY: 0, cropX: 0, cropY: 20, cropW: 100, cropH: 60 } },
    ];
    presets.forEach(function(p) {
      const btn = document.createElement('button');
      btn.className = 'seven-bg-preset-btn';
      btn.textContent = p.label;
      btn.onclick = function() {
        scaleSlider.value = p.adj.scale;
        offsetXSlider.value = p.adj.offsetX;
        offsetYSlider.value = p.adj.offsetY;
        cropXSlider.value = p.adj.cropX;
        cropYSlider.value = p.adj.cropY;
        cropWSlider.value = p.adj.cropW;
        cropHSlider.value = p.adj.cropH;
        updateAllDisplays();
        renderPreview();
      };
      presetRow.appendChild(btn);
    });
    modal.appendChild(presetRow);

    // 当前调整状态
    let adj = { ...initialAdj };
    if (!adj.scale) adj.scale = 100;
    if (adj.offsetX === undefined) adj.offsetX = 0;
    if (adj.offsetY === undefined) adj.offsetY = 0;
    if (adj.cropX === undefined) adj.cropX = 0;
    if (adj.cropY === undefined) adj.cropY = 0;
    if (adj.cropW === undefined) adj.cropW = 100;
    if (adj.cropH === undefined) adj.cropH = 100;

    // 滑块创建辅助函数
    function createSlider(label, min, max, value, suffix) {
      const row = document.createElement('div');
      row.className = 'seven-bg-slider-row';
      const labelEl = document.createElement('div');
      labelEl.className = 'seven-bg-slider-label';
      labelEl.textContent = label;
      row.appendChild(labelEl);
      const slider = document.createElement('input');
      slider.type = 'range';
      slider.className = 'seven-bg-slider';
      slider.min = min;
      slider.max = max;
      slider.value = value;
      row.appendChild(slider);
      const valueEl = document.createElement('div');
      valueEl.className = 'seven-bg-slider-value';
      valueEl.textContent = value + (suffix || '');
      row.appendChild(valueEl);
      slider.addEventListener('input', function() {
        valueEl.textContent = slider.value + (suffix || '');
        renderPreview();
      });
      modal.appendChild(row);
      return { slider: slider, valueEl: valueEl };
    }

    const scaleS = createSlider('缩放比例', 10, 400, adj.scale, '%');
    const offsetXS = createSlider('水平偏移', -100, 100, adj.offsetX, '%');
    const offsetYS = createSlider('垂直偏移', -100, 100, adj.offsetY, '%');
    const cropXS = createSlider('裁剪左', 0, 90, adj.cropX, '%');
    const cropYS = createSlider('裁剪上', 0, 90, adj.cropY, '%');
    const cropWS = createSlider('裁剪宽度', 10, 100, adj.cropW, '%');
    const cropHS = createSlider('裁剪高度', 10, 100, adj.cropH, '%');

    var scaleSlider = scaleS.slider;
    var offsetXSlider = offsetXS.slider;
    var offsetYSlider = offsetYS.slider;
    var cropXSlider = cropXS.slider;
    var cropYSlider = cropYS.slider;
    var cropWSlider = cropWS.slider;
    var cropHSlider = cropHS.slider;

    function updateAllDisplays() {
      scaleS.valueEl.textContent = scaleSlider.value + '%';
      offsetXS.valueEl.textContent = offsetXSlider.value + '%';
      offsetYS.valueEl.textContent = offsetYSlider.value + '%';
      cropXS.valueEl.textContent = cropXSlider.value + '%';
      cropYS.valueEl.textContent = cropYSlider.value + '%';
      cropWS.valueEl.textContent = cropWSlider.value + '%';
      cropHS.valueEl.textContent = cropHSlider.value + '%';
    }

    // 加载图片并渲染预览
    let bgImg = null;
    const containerW = 520;
    const containerH = 300;

    function renderPreview() {
      if (!bgImg) return;
      canvas.width = containerW;
      canvas.height = containerH;
      const ctx = canvas.getContext('2d');
      ctx.clearRect(0, 0, containerW, containerH);

      const scale = parseInt(scaleSlider.value) / 100;
      const offsetX = parseInt(offsetXSlider.value) / 100;
      const offsetY = parseInt(offsetYSlider.value) / 100;
      const cropX = parseInt(cropXSlider.value) / 100;
      const cropY = parseInt(cropYSlider.value) / 100;
      const cropW = parseInt(cropWSlider.value) / 100;
      const cropH = parseInt(cropHSlider.value) / 100;

      // 源图裁剪区域
      const srcX = bgImg.naturalWidth * cropX;
      const srcY = bgImg.naturalHeight * cropY;
      const srcW = bgImg.naturalWidth * cropW;
      const srcH = bgImg.naturalHeight * cropH;

      // 目标绘制区域（按容器比例）
      const containerRatio = containerW / containerH;
      const srcRatio = srcW / srcH;

      let drawW, drawH;
      if (srcRatio > containerRatio) {
        drawH = containerH * scale;
        drawW = drawH * srcRatio;
      } else {
        drawW = containerW * scale;
        drawH = drawW / srcRatio;
      }

      const drawX = (containerW - drawW) / 2 + offsetX * containerW;
      const drawY = (containerH - drawH) / 2 + offsetY * containerH;

      ctx.drawImage(bgImg, srcX, srcY, srcW, srcH, drawX, drawY, drawW, drawH);

      // 更新裁剪覆盖层
      cropOverlay.style.left = (cropX * 100) + '%';
      cropOverlay.style.top = (cropY * 100) + '%';
      cropOverlay.style.width = (cropW * 100) + '%';
      cropOverlay.style.height = (cropH * 100) + '%';
    }

    // 拖拽调整位置
    let isDragging = false;
    let dragStartX = 0, dragStartY = 0;
    let dragStartOffsetX = 0, dragStartOffsetY = 0;

    canvasContainer.addEventListener('mousedown', function(e) {
      isDragging = true;
      dragStartX = e.clientX;
      dragStartY = e.clientY;
      dragStartOffsetX = parseInt(offsetXSlider.value);
      dragStartOffsetY = parseInt(offsetYSlider.value);
      canvasContainer.style.cursor = 'grabbing';
    });

    document.addEventListener('mousemove', function(e) {
      if (!isDragging) return;
      const dx = e.clientX - dragStartX;
      const dy = e.clientY - dragStartY;
      const newOffsetX = Math.max(-100, Math.min(100, dragStartOffsetX + Math.round(dx / containerW * 100)));
      const newOffsetY = Math.max(-100, Math.min(100, dragStartOffsetY + Math.round(dy / containerH * 100)));
      offsetXSlider.value = newOffsetX;
      offsetYSlider.value = newOffsetY;
      offsetXS.valueEl.textContent = newOffsetX + '%';
      offsetYS.valueEl.textContent = newOffsetY + '%';
      renderPreview();
    });

    document.addEventListener('mouseup', function() {
      if (isDragging) {
        isDragging = false;
        canvasContainer.style.cursor = 'move';
      }
    });

    // 滚轮缩放
    canvasContainer.addEventListener('wheel', function(e) {
      e.preventDefault();
      const delta = e.deltaY > 0 ? -5 : 5;
      const newScale = Math.max(10, Math.min(400, parseInt(scaleSlider.value) + delta));
      scaleSlider.value = newScale;
      scaleS.valueEl.textContent = newScale + '%';
      renderPreview();
    });

    // 加载图片
    const testImg = new Image();
    testImg.crossOrigin = 'anonymous';
    testImg.onload = function() {
      bgImg = testImg;
      renderPreview();
    };
    testImg.onerror = function() {
      // 如果跨域失败，不使用 crossOrigin 重试
      const fallbackImg = new Image();
      fallbackImg.onload = function() {
        bgImg = fallbackImg;
        renderPreview();
      };
      fallbackImg.src = bgSrc;
    };
    testImg.src = bgSrc;

    // 操作按钮
    const actions = document.createElement('div');
    actions.className = 'seven-bg-adjust-actions';

    const resetBtn = document.createElement('button');
    resetBtn.className = 'secondary';
    resetBtn.textContent = '重置';
    resetBtn.onclick = function() {
      scaleSlider.value = 100;
      offsetXSlider.value = 0;
      offsetYSlider.value = 0;
      cropXSlider.value = 0;
      cropYSlider.value = 0;
      cropWSlider.value = 100;
      cropHSlider.value = 100;
      updateAllDisplays();
      renderPreview();
    };
    actions.appendChild(resetBtn);

    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'secondary';
    cancelBtn.textContent = '取消';
    cancelBtn.onclick = function() { backdrop.remove(); };
    actions.appendChild(cancelBtn);

    const saveBtn = document.createElement('button');
    saveBtn.className = 'primary';
    saveBtn.textContent = '保存';
    saveBtn.onclick = function() {
      const result = {
        scale: parseInt(scaleSlider.value),
        offsetX: parseInt(offsetXSlider.value),
        offsetY: parseInt(offsetYSlider.value),
        cropX: parseInt(cropXSlider.value),
        cropY: parseInt(cropYSlider.value),
        cropW: parseInt(cropWSlider.value),
        cropH: parseInt(cropHSlider.value),
      };
      onSave(result);
      backdrop.remove();
    };
    actions.appendChild(saveBtn);

    modal.appendChild(actions);
    backdrop.appendChild(modal);
    document.body.appendChild(backdrop);
  }

  // 降级方案：直接写 IndexedDB
  async function saveBackgroundViaIDB(nodeId, bgData) {
    try {
      const db = await openDB();
      const projects = await getAllStories(db);
      if (!projects || projects.length === 0) return;
      const story = projects[0];
      const projectData = story.project || story;
      const node = (projectData.nodes || []).find(n => n.id === nodeId);
      if (!node) return;
      if (bgData) {
        node.data.backgroundImage = bgData;
      } else {
        delete node.data.backgroundImage;
      }
      await putStory(db, story);
    } catch (e) {
      console.warn('降级保存背景失败:', e);
    }
  }

  // 检查并注入背景图片区块
  function checkAndInjectBgSection() {
    const editor = document.querySelector('.inspector-node-editor');
    if (!editor) {
      lastInjectedNodeId = null;
      return;
    }

    const data = getInspectorNodeData(editor);
    if (!data || !data.node) {
      lastInjectedNodeId = null;
      return;
    }

    const node = data.node;
    const kind = node.data && node.data.kind;

    // ===== 注入「删除关联节点」按钮 =====
    injectDeleteRelatedBtn(editor, node, data);

    // 只对剧情和结局节点注入背景设置
    if (kind !== 'plot' && kind !== 'ending') {
      // 移除已注入的背景区块
      const existing = editor.querySelector('.seven-bg-section');
      if (existing) existing.remove();
      lastInjectedNodeId = null;

      // 对小游戏节点注入小游戏嵌入设置
      if (kind === 'minigame') {
        injectMinigameEmbedSection(editor, node, data.onUpdateNode);
      } else {
        const existingMg = editor.querySelector('.seven-mg-section');
        if (existingMg) existingMg.remove();
        lastMinigameNodeId = null;
      }
      return;
    }

    // 如果已经为当前节点注入过，跳过
    const existing = editor.querySelector('.seven-bg-section');
    if (existing && lastInjectedNodeId === node.id) return;

    // 移除旧区块
    if (existing) existing.remove();

    // 移除小游戏区块（如果存在）
    const existingMg = editor.querySelector('.seven-mg-section');
    if (existingMg) existingMg.remove();
    lastMinigameNodeId = null;

    // 找到插入位置：场景绑定面板之后，或媒体管理面板之后
    const assetPanel = editor.querySelector('.inspector-asset-binding-panel');
    const mediaPanel = editor.querySelector('.inspector-media-panel');
    const insertAfter = assetPanel || mediaPanel;
    if (!insertAfter) {
      // 如果都没找到，插入到检查器末尾
      const section = createBgSection(node, data.onUpdateNode);
      editor.appendChild(section);
    } else {
      const section = createBgSection(node, data.onUpdateNode);
      insertAfter.after(section);
    }

    lastInjectedNodeId = node.id;
  }

  // ==================== 小游戏嵌入设置注入（完全重写） ====================

  function injectMinigameEmbedSection(editor, node, onUpdateNode) {
    // 检查是否已注入且节点未变
    const existing = editor.querySelector('.seven-mg-section');
    if (existing && lastMinigameNodeId === node.id) return;
    if (existing) existing.remove();

    lastMinigameNodeId = node.id;

    var mgData = node.data || {};
    var curType = mgData.minigameEmbedType || '';
    var curHtml = mgData.minigameHtmlCode || '';
    var curUrl = mgData.minigameUrl || '';

    // 创建容器
    var section = document.createElement('section');
    section.className = 'inspector-section seven-mg-section';
    section.style.cssText = 'margin-top:16px;';

    // 标题
    var title = document.createElement('div');
    title.className = 'inspector-section-title';
    title.style.cssText = 'display:flex;align-items:center;gap:6px;margin-bottom:12px;';
    title.innerHTML = '<strong>小游戏嵌入</strong><span style="font-size:11px;color:var(--text-dim);background:rgba(167,139,250,.15);padding:2px 8px;border-radius:10px;">嵌入式</span>';
    section.appendChild(title);

    // 说明
    var info = document.createElement('div');
    info.style.cssText = 'padding:10px 12px;border-radius:8px;background:rgba(91,140,255,.08);border:1px solid rgba(91,140,255,.2);font-size:12px;color:var(--text-dim);line-height:1.6;margin-bottom:12px;';
    info.innerHTML = '<div style="font-weight:600;color:var(--text);margin-bottom:4px;">使用说明</div>' +
      '选择嵌入方式后，玩家进入此节点将直接游玩嵌入的小游戏。<br>' +
      '游戏结束时代码需发送结果：<br>' +
      '<code style="display:block;margin-top:4px;padding:6px 8px;border-radius:6px;background:var(--bg);font-size:11px;color:var(--accent);white-space:pre-wrap;word-break:break-all;">function postResult(r){\n  try{parent.postMessage({type:"funloom:minigame:complete",result:r},window.parent.location.origin)}\n  catch(e){parent.postMessage({type:"funloom:minigame:complete",result:r},"*")}\n}\n// 调用示例: postResult("success")</code>' +
      '<div style="margin-top:6px;">result 可为：success / failure / perfect / 自定义值</div>' +
      '<div style="margin-top:4px;font-size:11px;color:var(--text-dim);">优先使用 parent.origin（安全），跨域时自动降级为 *</div>';
    section.appendChild(info);

    // 嵌入方式选择
    var modeWrap = document.createElement('div');
    modeWrap.className = 'config-field';
    modeWrap.style.cssText = 'margin-bottom:12px;';

    var modeLabel = document.createElement('div');
    modeLabel.style.cssText = 'font-size:13px;color:var(--text);margin-bottom:6px;font-weight:500;';
    modeLabel.textContent = '嵌入方式';
    modeWrap.appendChild(modeLabel);

    var modeBtnGroup = document.createElement('div');
    modeBtnGroup.style.cssText = 'display:flex;gap:8px;';

    function createModeBtn(val, label) {
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.dataset.mgMode = val;
      btn.textContent = label;
      btn.style.cssText = 'flex:1;padding:8px 12px;border-radius:8px;border:1px solid var(--line);background:var(--bg);color:var(--text-dim);font-size:13px;cursor:pointer;font-family:inherit;transition:all .2s;';
      if (curType === val) {
        btn.style.borderColor = 'var(--accent)';
        btn.style.background = 'rgba(91,140,255,.1)';
        btn.style.color = 'var(--accent)';
      }
      return btn;
    }

    var btnNone = createModeBtn('', '手动按钮');
    var btnHtml = createModeBtn('html', 'HTML代码');
    var btnUrl = createModeBtn('url', '网站URL');
    modeBtnGroup.appendChild(btnNone);
    modeBtnGroup.appendChild(btnHtml);
    modeBtnGroup.appendChild(btnUrl);
    modeWrap.appendChild(modeBtnGroup);
    section.appendChild(modeWrap);

    // HTML代码输入区
    var htmlArea = document.createElement('div');
    htmlArea.style.cssText = 'display:none;margin-bottom:12px;';

    var htmlLabel = document.createElement('div');
    htmlLabel.style.cssText = 'font-size:13px;color:var(--text);margin-bottom:6px;font-weight:500;';
    htmlLabel.textContent = 'HTML代码';
    htmlArea.appendChild(htmlLabel);

    // 文件上传按钮
    var fileRow = document.createElement('div');
    fileRow.style.cssText = 'display:flex;gap:8px;margin-bottom:8px;';

    var fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.accept = '.html,.htm,text/html';
    fileInput.style.cssText = 'display:none;';

    var fileBtn = document.createElement('button');
    fileBtn.type = 'button';
    fileBtn.textContent = '选择HTML文件';
    fileBtn.style.cssText = 'padding:6px 12px;border-radius:6px;border:1px solid var(--line);background:var(--bg);color:var(--text);font-size:12px;cursor:pointer;font-family:inherit;';
    fileBtn.onclick = function() { fileInput.click(); };

    fileInput.onchange = function(ev) {
      var file = ev.target.files[0];
      if (!file) return;
      var reader = new FileReader();
      reader.onload = function() {
        htmlTextarea.value = reader.result || '';
        autoSave();
      };
      reader.readAsText(file);
    };

    var clearBtn = document.createElement('button');
    clearBtn.type = 'button';
    clearBtn.textContent = '清空';
    clearBtn.style.cssText = 'padding:6px 12px;border-radius:6px;border:1px solid var(--line);background:var(--bg);color:var(--text-dim);font-size:12px;cursor:pointer;font-family:inherit;';
    clearBtn.onclick = function() {
      htmlTextarea.value = '';
      autoSave();
    };

    fileRow.appendChild(fileBtn);
    fileRow.appendChild(clearBtn);
    fileRow.appendChild(fileInput);
    htmlArea.appendChild(fileRow);

    var htmlTextarea = document.createElement('textarea');
    htmlTextarea.placeholder = '粘贴完整的HTML代码，或点击上方按钮选择文件...';
    htmlTextarea.style.cssText = 'width:100%;min-height:140px;padding:10px;border-radius:8px;border:1px solid var(--line);background:var(--bg);color:var(--text);font-size:12px;font-family:monospace;outline:none;resize:vertical;line-height:1.5;';
    htmlTextarea.value = curHtml;
    htmlArea.appendChild(htmlTextarea);

    section.appendChild(htmlArea);

    // URL输入区
    var urlArea = document.createElement('div');
    urlArea.style.cssText = 'display:none;margin-bottom:12px;';

    var urlLabel = document.createElement('div');
    urlLabel.style.cssText = 'font-size:13px;color:var(--text);margin-bottom:6px;font-weight:500;';
    urlLabel.textContent = '网站URL';
    urlArea.appendChild(urlLabel);

    var urlInput = document.createElement('input');
    urlInput.type = 'text';
    urlInput.placeholder = 'https://example.com/game';
    urlInput.style.cssText = 'width:100%;padding:8px 12px;border-radius:8px;border:1px solid var(--line);background:var(--bg);color:var(--text);font-size:14px;font-family:inherit;outline:none;';
    urlInput.value = curUrl;
    urlArea.appendChild(urlInput);

    section.appendChild(urlArea);

    // 当前模式
    var currentMode = curType;

    // 切换模式显示
    function switchMode(newMode) {
      currentMode = newMode;
      // 更新按钮样式
      [btnNone, btnHtml, btnUrl].forEach(function(b) {
        if (b.dataset.mgMode === newMode) {
          b.style.borderColor = 'var(--accent)';
          b.style.background = 'rgba(91,140,255,.1)';
          b.style.color = 'var(--accent)';
        } else {
          b.style.borderColor = 'var(--line)';
          b.style.background = 'var(--bg)';
          b.style.color = 'var(--text-dim)';
        }
      });
      // 显示/隐藏对应输入区
      htmlArea.style.display = (newMode === 'html') ? 'block' : 'none';
      urlArea.style.display = (newMode === 'url') ? 'block' : 'none';
    }

    btnNone.onclick = function() { switchMode(''); autoSave(); };
    btnHtml.onclick = function() { switchMode('html'); autoSave(); };
    btnUrl.onclick = function() { switchMode('url'); autoSave(); };
    switchMode(curType);

    // 状态提示
    var statusEl = document.createElement('div');
    statusEl.style.cssText = 'text-align:center;font-size:12px;color:var(--text-dim);padding:4px;min-height:20px;';
    section.appendChild(statusEl);

    // 自动保存（防抖）
    var saveTimer = null;
    function autoSave() {
      if (saveTimer) clearTimeout(saveTimer);
      statusEl.textContent = '保存中...';
      statusEl.style.color = 'var(--text-dim)';
      saveTimer = setTimeout(function() {
        var patch = {
          minigameEmbedType: currentMode,
          minigameHtmlCode: htmlTextarea.value,
          minigameUrl: urlInput.value,
          minigameResults: mgData.minigameResults || [{ id: 'success', label: '成功' }, { id: 'failure', label: '失败' }],
          minigameResultMutations: mgData.minigameResultMutations || {}
        };
        // 1. 更新 React 状态
        if (onUpdateNode) {
          onUpdateNode(node.id, patch);
        }
        // 2. 写入全局缓存（最可靠，导出时直接读取）
        if (!window._funloomMinigameSettings) window._funloomMinigameSettings = {};
        // 合并已有缓存，确保不丢失之前保存的字段
        var existingCache = window._funloomMinigameSettings[node.id] || {};
        window._funloomMinigameSettings[node.id] = Object.assign({}, existingCache, patch);
        console.log('[小游戏保存] 全局缓存已更新:', node.id, 'mode:', patch.minigameEmbedType,
          'htmlLen:', patch.minigameHtmlCode ? patch.minigameHtmlCode.length : 0,
          'url:', patch.minigameUrl);
        // 3. 直接持久化到 IndexedDB，确保导出时数据完整
        saveMinigameToIndexedDB(node.id, patch);
        statusEl.textContent = '已自动保存';
        statusEl.style.color = 'var(--plot)';
        setTimeout(function() {
          if (statusEl.textContent === '已自动保存') {
            statusEl.textContent = '';
          }
        }, 2000);
      }, 500);
    }

    // 直接将小游戏设置保存到 IndexedDB 中的项目数据
    function saveMinigameToIndexedDB(nodeId, patch) {
      openDB().then(function(db) {
        return getAllStories(db).then(function(stories) {
          if (!stories || stories.length === 0) return;
          var saved = false;
          stories.forEach(function(story) {
            var proj = story.project || story;
            var changed = false;
            // 在所有可能的位置查找并更新节点
            function updateNodesInArr(arr) {
              if (!Array.isArray(arr)) return;
              arr.forEach(function(n) {
                if (n && n.id === nodeId) {
                  if (!n.data) n.data = {};
                  Object.keys(patch).forEach(function(k) {
                    n.data[k] = patch[k];
                  });
                  changed = true;
                }
              });
            }
            if (proj.nodes) updateNodesInArr(proj.nodes);
            if (proj.scripts) {
              proj.scripts.forEach(function(s) {
                if (s.nodes) updateNodesInArr(s.nodes);
              });
            }
            if (proj.projectFlow && proj.projectFlow.nodes) {
              updateNodesInArr(proj.projectFlow.nodes);
            }
            if (changed) {
              saved = true;
              putStory(db, story);
            }
          });
          if (saved) {
            console.log('[小游戏保存] 节点', nodeId, '的小游戏设置已保存到IndexedDB');
          } else {
            console.warn('[小游戏保存] 未在IndexedDB中找到节点', nodeId);
          }
        });
      }).catch(function(e) {
        console.warn('[小游戏保存] 保存到IndexedDB失败:', e);
      });
    }

    // 输入时自动保存
    htmlTextarea.addEventListener('input', autoSave);
    urlInput.addEventListener('input', autoSave);

    // 找到插入位置
    const assetPanel = editor.querySelector('.inspector-asset-binding-panel');
    const mediaPanel = editor.querySelector('.inspector-media-panel');
    const insertAfter = assetPanel || mediaPanel;
    if (insertAfter) {
      insertAfter.after(section);
    } else {
      editor.appendChild(section);
    }
  }
  let lastDeleteBtnNodeId = null;

  // 注入「删除关联节点」按钮
  function injectDeleteRelatedBtn(editor, node, data) {
    // 找到现有的「删除当前节点」按钮
    const existingDeleteBtns = editor.querySelectorAll('button');
    let deleteBtn = null;
    existingDeleteBtns.forEach(function(btn) {
      var text = (btn.textContent || '').trim();
      if (text === '删除当前节点' || text === '删除节点') {
        deleteBtn = btn;
      }
    });

    // 如果已有删除关联节点按钮且节点未变，跳过
    const existingRelBtn = editor.querySelector('.seven-delete-related-btn');
    if (existingRelBtn && lastDeleteBtnNodeId === node.id) return;
    if (existingRelBtn) existingRelBtn.remove();

    if (!deleteBtn) {
      lastDeleteBtnNodeId = null;
      return;
    }

    lastDeleteBtnNodeId = node.id;

    // 创建「删除关联节点」按钮
    const relBtn = document.createElement('button');
    relBtn.className = 'seven-delete-related-btn';
    relBtn.textContent = '删除关联节点';
    relBtn.style.cssText = 'display:block;width:100%;margin-top:8px;padding:10px 14px;border-radius:10px;border:1px solid var(--line);background:transparent;color:var(--danger);cursor:pointer;font-size:14px;font-family:inherit;transition:background .2s;';
    relBtn.onmouseenter = function() { relBtn.style.background = 'var(--danger-soft)'; };
    relBtn.onmouseleave = function() { relBtn.style.background = 'transparent'; };

    relBtn.addEventListener('click', function(e) {
      e.preventDefault();
      e.stopPropagation();
      if (!confirm('确定要删除此节点及其所有关联的下游节点吗？此操作不可撤销。')) return;
      deleteRelatedNodes(node, data);
    });

    // 插入到「删除当前节点」按钮之后
    deleteBtn.after(relBtn);
  }

  // 删除关联节点：当前节点 + 所有下游连通的节点
  async function deleteRelatedNodes(node, data) {
    try {
      const db = await openDB();
      const projects = await getAllStories(db);
      if (!projects || projects.length === 0) return;
      const story = projects[0];
      const projectData = story.project || story;

      // 收集所有脚本中的节点和边
      var allNodes = [];
      var allEdges = [];
      if (projectData.nodes) allNodes = allNodes.concat(projectData.nodes);
      if (projectData.edges) allEdges = allEdges.concat(projectData.edges);
      if (projectData.scripts) {
        projectData.scripts.forEach(function(s) {
          if (s.nodes) allNodes = allNodes.concat(s.nodes);
          if (s.edges) allEdges = allEdges.concat(s.edges);
        });
      }

      // BFS 遍历下游节点
      var outgoingMap = {};
      allEdges.forEach(function(e) {
        if (!outgoingMap[e.source]) outgoingMap[e.source] = [];
        outgoingMap[e.source].push(e.target);
      });

      var toDelete = new Set([node.id]);
      var queue = [node.id];
      while (queue.length > 0) {
        var cur = queue.shift();
        var targets = outgoingMap[cur] || [];
        targets.forEach(function(t) {
          if (!toDelete.has(t)) {
            toDelete.add(t);
            queue.push(t);
          }
        });
      }

      // 从所有脚本中移除这些节点和关联的边
      var removedCount = 0;
      function removeFromArray(arr, filterFn) {
        if (!arr) return;
        var before = arr.length;
        for (var i = arr.length - 1; i >= 0; i--) {
          if (filterFn(arr[i])) arr.splice(i, 1);
        }
        return arr.length - before > 0;
      }

      if (projectData.nodes) {
        var before = projectData.nodes.length;
        projectData.nodes = projectData.nodes.filter(function(n) { return !toDelete.has(n.id); });
        removedCount += before - projectData.nodes.length;
      }
      if (projectData.edges) {
        projectData.edges = projectData.edges.filter(function(e) {
          return !toDelete.has(e.source) && !toDelete.has(e.target);
        });
      }
      if (projectData.scripts) {
        projectData.scripts.forEach(function(s) {
          if (s.nodes) {
            var before2 = s.nodes.length;
            s.nodes = s.nodes.filter(function(n) { return !toDelete.has(n.id); });
            removedCount += before2 - s.nodes.length;
          }
          if (s.edges) {
            s.edges = s.edges.filter(function(e) {
              return !toDelete.has(e.source) && !toDelete.has(e.target);
            });
          }
        });
      }

      await putStory(db, story);

      // 通过 React 回调刷新 UI
      if (data.onUpdateNode) {
        // 尝试触发 React 状态更新
        try {
          // 找到 React fiber 中的删除节点回调
          var fiberKey = Object.keys(document.querySelector('.inspector-node-editor')).find(function(k) {
            return k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$');
          });
          if (fiberKey) {
            var fiber = document.querySelector('.inspector-node-editor')[fiberKey];
            var depth = 0;
            while (fiber && depth < 80) {
              var props = fiber.memoizedProps;
              if (props) {
                // 尝试找到 onDeleteNode 或类似回调
                for (var key in props) {
                  if (typeof props[key] === 'function' && key.toLowerCase().includes('delete')) {
                    toDelete.forEach(function(id) { props[key](id); });
                    break;
                  }
                }
              }
              fiber = fiber.return;
              depth++;
            }
          }
        } catch (e) {
          console.warn('React 回调刷新失败:', e);
        }
      }

      // 刷新页面
      setTimeout(function() { window.location.reload(); }, 300);
    } catch (e) {
      console.error('删除关联节点失败:', e);
      alert('删除关联节点失败: ' + (e.message || String(e)));
    }
  }

  // 设置 MutationObserver 监听检查器面板变化
  function setupInspectorObserver() {
    injectBgStyles();

    let debounceTimer = null;
    function debouncedCheck() {
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(checkAndInjectBgSection, 100);
    }

    const observer = new MutationObserver(function(mutations) {
      // 检查是否有 inspector 相关的 DOM 变化
      for (const mutation of mutations) {
        if (mutation.type === 'childList') {
          for (const node of mutation.addedNodes) {
            if (node.nodeType !== 1) continue;
            // 检查是否是检查器或其子元素
            if (
              (node.classList && node.classList.contains('inspector-node-editor')) ||
              (node.classList && node.classList.contains('inspector')) ||
              (node.querySelector && node.querySelector('.inspector-node-editor')) ||
              (node.classList && node.classList.contains('inspector-section'))
            ) {
              debouncedCheck();
              return;
            }
          }
          // 检查移除的节点（可能是切换节点时旧内容被移除）
          for (const node of mutation.removedNodes) {
            if (node.nodeType !== 1) continue;
            if (node.classList && (node.classList.contains('inspector-node-editor') || node.classList.contains('seven-bg-section'))) {
              debouncedCheck();
              return;
            }
          }
        }
      }
    });

    observer.observe(document.body, { childList: true, subtree: true });

    // 初始检查
    setTimeout(checkAndInjectBgSection, 500);
  }

  // ==================== 资产面板人物/场景注入 ====================

  function injectAssetPanelStyles() {
    if (document.getElementById('seven-asset-panel-styles')) return;
    const style = document.createElement('style');
    style.id = 'seven-asset-panel-styles';
    style.textContent = `
      .seven-char-import-btn,.seven-scene-import-btn{background:#5b8cff;border:none;color:#fff;padding:8px 16px;border-radius:8px;cursor:pointer;font-size:13px;font-family:inherit;margin-left:8px;transition:background .2s}
      .seven-char-import-btn:hover,.seven-scene-import-btn:hover{background:#4a7aef}
      .seven-cutout-modal{background:#1a1d24;border:1px solid #2a2e38;border-radius:16px;padding:24px;width:90%;max-width:600px;color:#e2e4e9;max-height:90vh;overflow:auto}
      .seven-cutout-modal h3{margin:0 0 16px;font-size:1.2rem}
      .seven-cutout-preview{width:100%;height:200px;background:#0f1115;border-radius:12px;display:flex;align-items:center;justify-content:center;margin:12px 0;overflow:hidden;border:1px solid #2a2e38}
      .seven-cutout-preview img{max-width:100%;max-height:100%;object-fit:contain}
      .seven-cutout-preview canvas{max-width:100%;max-height:100%}
      .seven-cutout-actions{display:flex;gap:10px;margin-top:16px;flex-wrap:wrap}
      .seven-cutout-actions button{flex:1;padding:10px;border-radius:10px;border:1px solid #2a2e38;background:transparent;color:#8b92a8;cursor:pointer;font-size:14px;font-family:inherit;transition:all .2s}
      .seven-cutout-actions .primary{background:#5b8cff;border-color:#5b8cff;color:#fff}
      .seven-cutout-actions .primary:hover{background:#4a7aef}
      .seven-cutout-tabs{display:flex;gap:4px;margin-bottom:12px}
      .seven-cutout-tab{padding:6px 14px;border-radius:8px;border:1px solid #2a2e38;background:transparent;color:#8b92a8;cursor:pointer;font-size:13px}
      .seven-cutout-tab.active{background:#5b8cff;color:#fff;border-color:#5b8cff}
      .seven-cutout-field{margin-bottom:12px}
      .seven-cutout-field label{display:block;color:#8b92a8;font-size:12px;margin-bottom:4px}
      .seven-cutout-field input[type="text"],.seven-cutout-field input[type="number"]{width:100%;padding:8px 12px;border-radius:8px;border:1px solid #2a2e38;background:#0f1115;color:#e2e4e9;font-family:inherit}
      .seven-cutout-field input[type="range"]{width:100%}
      .seven-color-preview{width:24px;height:24px;border-radius:4px;border:1px solid #2a2e38;display:inline-block;vertical-align:middle;margin-left:8px}
      .seven-scene-adjust-btn{background:transparent;border:1px solid #2a2e38;color:#8b92a8;padding:6px 12px;border-radius:8px;cursor:pointer;font-size:12px;margin-left:8px}
      .seven-scene-adjust-btn:hover{border-color:#5b8cff;color:#5b8cff}
    `;
    document.head.appendChild(style);
  }

  // 保存资产数据到 IndexedDB
  async function saveAssetToProject(assetType, assetData) {
    try {
      const db = await openDB();
      const projects = await getAllStories(db);
      if (!projects || projects.length === 0) return false;
      const story = projects[0];
      const projectData = story.project || story;
      if (!projectData.assets) projectData.assets = {};
      if (!projectData.assets[assetType]) projectData.assets[assetType] = [];
      const list = projectData.assets[assetType];
      const idx = list.findIndex(function(a) { return a.id === assetData.id; });
      if (idx >= 0) {
        list[idx] = assetData;
      } else {
        list.push(assetData);
      }
      await putStory(db, story);
      return true;
    } catch (e) {
      console.warn('保存资产失败:', e);
      return false;
    }
  }

  // 生成唯一ID
  function generateId(prefix) {
    return prefix + '-' + Date.now() + '-' + Math.random().toString(36).substr(2, 9);
  }

  // ==================== 人物导入与抠图 ====================

  function showCharacterImportModal() {
    const backdrop = document.createElement('div');
    backdrop.className = 'seven-bg-adjust-overlay';
    backdrop.style.zIndex = '100004';

    const modal = document.createElement('div');
    modal.className = 'seven-cutout-modal';

    const title = document.createElement('h3');
    title.textContent = '导入人物';
    modal.appendChild(title);

    // 名称输入
    const nameField = document.createElement('div');
    nameField.className = 'seven-cutout-field';
    nameField.innerHTML = '<label>人物名称</label>';
    const nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.placeholder = '输入人物名称...';
    nameField.appendChild(nameInput);
    modal.appendChild(nameField);

    // 文件选择
    const fileField = document.createElement('div');
    fileField.className = 'seven-cutout-field';
    const fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.accept = 'image/*';
    fileField.appendChild(fileInput);
    modal.appendChild(fileField);

    // 抠图方式标签
    const tabs = document.createElement('div');
    tabs.className = 'seven-cutout-tabs';
    const tabNames = ['自动抠图', '去色抠图'];
    const tabValues = ['auto', 'color'];
    let activeTab = 'auto';
    const tabEls = [];
    tabValues.forEach(function(val, idx) {
      const tab = document.createElement('button');
      tab.className = 'seven-cutout-tab' + (val === activeTab ? ' active' : '');
      tab.textContent = tabNames[idx];
      tab.onclick = function() {
        activeTab = val;
        tabEls.forEach(function(t, i) {
          t.classList.toggle('active', tabValues[i] === val);
        });
        updateCutoutUI();
      };
      tabs.appendChild(tab);
      tabEls.push(tab);
    });
    modal.appendChild(tabs);

    // 去色抠图参数
    const colorParams = document.createElement('div');
    colorParams.style.display = activeTab === 'color' ? '' : 'none';
    colorParams.innerHTML = '<label>点击预览图选择要移除的颜色</label>';
    const toleranceField = document.createElement('div');
    toleranceField.className = 'seven-cutout-field';
    toleranceField.innerHTML = '<label>颜色容差: <span id="tol-val">30</span></label>';
    const toleranceSlider = document.createElement('input');
    toleranceSlider.type = 'range';
    toleranceSlider.min = '5';
    toleranceSlider.max = '100';
    toleranceSlider.value = '30';
    toleranceSlider.oninput = function() {
      document.getElementById('tol-val').textContent = toleranceSlider.value;
      if (sourceImg) applyColorRemove();
    };
    toleranceField.appendChild(toleranceSlider);
    colorParams.appendChild(toleranceField);
    modal.appendChild(colorParams);

    // 预览区域
    const previewDiv = document.createElement('div');
    previewDiv.className = 'seven-cutout-preview';
    previewDiv.innerHTML = '<span style="color:#8b92a8">请选择图片</span>';
    modal.appendChild(previewDiv);

    let sourceImg = null;
    let sourceCanvas = null;
    let resultCanvas = null;
    let targetColor = null;

    function updateCutoutUI() {
      colorParams.style.display = activeTab === 'color' ? '' : 'none';
      if (sourceImg && activeTab === 'auto') applyAutoCutout();
      if (sourceImg && activeTab === 'color' && targetColor) applyColorRemove();
    }

    function applyAutoCutout() {
      if (!sourceImg) return;
      const canvas = document.createElement('canvas');
      canvas.width = sourceImg.naturalWidth;
      canvas.height = sourceImg.naturalHeight;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(sourceImg, 0, 0);
      const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const data = imgData.data;
      // 简单的自动抠图：检测边缘并移除背景
      // 使用亮度差异检测前景
      const w = canvas.width;
      const h = canvas.height;
      const threshold = 15;
      // 采样四个角的颜色作为背景参考
      const corners = [
        [0, 0], [w - 1, 0], [0, h - 1], [w - 1, h - 1]
      ];
      let bgR = 0, bgG = 0, bgB = 0;
      corners.forEach(function(c) {
        const idx = (c[1] * w + c[0]) * 4;
        bgR += data[idx];
        bgG += data[idx + 1];
        bgB += data[idx + 2];
      });
      bgR /= 4; bgG /= 4; bgB /= 4;
      for (let i = 0; i < data.length; i += 4) {
        const r = data[i], g = data[i + 1], b = data[i + 2];
        const diff = Math.abs(r - bgR) + Math.abs(g - bgG) + Math.abs(b - bgB);
        if (diff < threshold * 3) {
          data[i + 3] = 0;
        }
      }
      ctx.putImageData(imgData, 0, 0);
      resultCanvas = canvas;
      showPreview(canvas);
    }

    function applyColorRemove() {
      if (!sourceImg || !targetColor) return;
      const canvas = document.createElement('canvas');
      canvas.width = sourceImg.naturalWidth;
      canvas.height = sourceImg.naturalHeight;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(sourceImg, 0, 0);
      const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const data = imgData.data;
      const tolerance = parseInt(toleranceSlider.value);
      const tr = targetColor[0], tg = targetColor[1], tb = targetColor[2];
      for (let i = 0; i < data.length; i += 4) {
        const r = data[i], g = data[i + 1], b = data[i + 2];
        const diff = Math.abs(r - tr) + Math.abs(g - tg) + Math.abs(b - tb);
        if (diff < tolerance * 3) {
          data[i + 3] = 0;
        }
      }
      ctx.putImageData(imgData, 0, 0);
      resultCanvas = canvas;
      showPreview(canvas);
    }

    function showPreview(canvasOrImg) {
      previewDiv.innerHTML = '';
      if (canvasOrImg.tagName === 'CANVAS') {
        previewDiv.appendChild(canvasOrImg);
      } else {
        const img = document.createElement('img');
        img.src = canvasOrImg.src || canvasOrImg;
        previewDiv.appendChild(img);
      }
    }

    // 点击预览选择颜色
    previewDiv.addEventListener('click', function(e) {
      if (activeTab !== 'color' || !sourceImg) return;
      const rect = previewDiv.getBoundingClientRect();
      const x = (e.clientX - rect.left) / rect.width;
      const y = (e.clientY - rect.top) / rect.height;
      const canvas = document.createElement('canvas');
      canvas.width = sourceImg.naturalWidth;
      canvas.height = sourceImg.naturalHeight;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(sourceImg, 0, 0);
      const px = Math.floor(x * sourceImg.naturalWidth);
      const py = Math.floor(y * sourceImg.naturalHeight);
      const imgData = ctx.getImageData(px, py, 1, 1);
      targetColor = [imgData.data[0], imgData.data[1], imgData.data[2]];
      // 显示选中的颜色
      const colorBox = document.createElement('span');
      colorBox.className = 'seven-color-preview';
      colorBox.style.backgroundColor = 'rgb(' + targetColor.join(',') + ')';
      const existing = colorParams.querySelector('.seven-color-preview');
      if (existing) existing.remove();
      colorParams.appendChild(colorBox);
      applyColorRemove();
    });

    fileInput.addEventListener('change', function(e) {
      const file = e.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = function() {
        const img = new Image();
        img.onload = function() {
          sourceImg = img;
          showPreview(img);
          if (activeTab === 'auto') applyAutoCutout();
        };
        img.src = reader.result;
      };
      reader.readAsDataURL(file);
    });

    // 操作按钮
    const actions = document.createElement('div');
    actions.className = 'seven-cutout-actions';

    const cancelBtn = document.createElement('button');
    cancelBtn.textContent = '取消';
    cancelBtn.onclick = function() { backdrop.remove(); };
    actions.appendChild(cancelBtn);

    const saveBtn = document.createElement('button');
    saveBtn.className = 'primary';
    saveBtn.textContent = '保存人物';
    saveBtn.onclick = async function() {
      const name = nameInput.value.trim();
      if (!name) { alert('请输入人物名称'); return; }
      if (!resultCanvas && !sourceImg) { alert('请先选择图片'); return; }

      const canvas = resultCanvas || sourceCanvas;
      const dataUrl = canvas ? canvas.toDataURL('image/png') : sourceImg.src;
      const charId = generateId('char');
      const charData = {
        id: charId,
        name: name,
        portrait: { type: 'base64', data: dataUrl },
        variants: [],
        referenceImages: []
      };
      const ok = await saveAssetToProject('characters', charData);
      if (ok) {
        alert('人物保存成功！');
        backdrop.remove();
        // 刷新资产面板
        const refreshBtn = document.querySelector('[title="刷新"]');
        if (refreshBtn) refreshBtn.click();
      } else {
        alert('保存失败');
      }
    };
    actions.appendChild(saveBtn);

    modal.appendChild(actions);
    backdrop.appendChild(modal);
    document.body.appendChild(backdrop);
  }

  // ==================== 场景微调 ====================

  function showSceneImportModal() {
    const backdrop = document.createElement('div');
    backdrop.className = 'seven-bg-adjust-overlay';
    backdrop.style.zIndex = '100004';

    const modal = document.createElement('div');
    modal.className = 'seven-cutout-modal';
    modal.style.maxWidth = '700px';

    const title = document.createElement('h3');
    title.textContent = '导入并微调场景';
    modal.appendChild(title);

    const nameField = document.createElement('div');
    nameField.className = 'seven-cutout-field';
    nameField.innerHTML = '<label>场景名称</label>';
    const nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.placeholder = '输入场景名称...';
    nameField.appendChild(nameInput);
    modal.appendChild(nameField);

    const fileField = document.createElement('div');
    fileField.className = 'seven-cutout-field';
    const fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.accept = 'image/*';
    fileField.appendChild(fileInput);
    modal.appendChild(fileField);

    let sourceImg = null;
    let currentAdj = { scale: 100, offsetX: 0, offsetY: 0, cropX: 0, cropY: 0, cropW: 100, cropH: 100 };

    fileInput.addEventListener('change', function(e) {
      const file = e.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = function() {
        const img = new Image();
        img.onload = function() {
          sourceImg = img;
          showBgAdjustEditor(img.src, currentAdj, function(adj) {
            currentAdj = adj;
          });
        };
        img.src = reader.result;
      };
      reader.readAsDataURL(file);
    });

    const actions = document.createElement('div');
    actions.className = 'seven-cutout-actions';

    const cancelBtn = document.createElement('button');
    cancelBtn.textContent = '取消';
    cancelBtn.onclick = function() { backdrop.remove(); };
    actions.appendChild(cancelBtn);

    const saveBtn = document.createElement('button');
    saveBtn.className = 'primary';
    saveBtn.textContent = '保存场景';
    saveBtn.onclick = async function() {
      const name = nameInput.value.trim();
      if (!name) { alert('请输入场景名称'); return; }
      if (!sourceImg) { alert('请先选择图片'); return; }

      const sceneId = generateId('scene');
      const sceneData = {
        id: sceneId,
        name: name,
        background: { type: 'base64', data: sourceImg.src, adjust: currentAdj },
        variants: [],
        referenceImages: []
      };
      const ok = await saveAssetToProject('scenes', sceneData);
      if (ok) {
        alert('场景保存成功！');
        backdrop.remove();
        const refreshBtn = document.querySelector('[title="刷新"]');
        if (refreshBtn) refreshBtn.click();
      } else {
        alert('保存失败');
      }
    };
    actions.appendChild(saveBtn);

    modal.appendChild(actions);
    backdrop.appendChild(modal);
    document.body.appendChild(backdrop);
  }

  // 检查并注入资产面板UI
  let lastAssetPanelPath = null;
  function checkAndInjectAssetPanel() {
    const panel = document.querySelector('.content-browser-panel');
    if (!panel) {
      lastAssetPanelPath = null;
      return;
    }
    // 读取面包屑判断当前路径
    const breadcrumbs = panel.querySelectorAll('.content-breadcrumb-link');
    let path = '';
    breadcrumbs.forEach(function(b) { path += b.textContent.trim() + '/'; });
    if (path === lastAssetPanelPath) return;
    lastAssetPanelPath = path;

    // 切换页面时清除旧的自定义按钮
    const toolbar = panel.querySelector('.content-toolbar-actions') || panel.querySelector('.content-browser-toolbar');
    if (toolbar) {
      toolbar.querySelectorAll('.seven-char-import-btn, .seven-scene-import-btn').forEach(function(btn) {
        btn.remove();
      });
    }

    // 在人物页面注入导入按钮
    if (path.includes('人物') && toolbar && !toolbar.querySelector('.seven-char-import-btn')) {
      const btn = document.createElement('button');
      btn.className = 'seven-char-import-btn content-toolbar-button accent';
      btn.textContent = '导入人物（抠图）';
      btn.onclick = function(e) {
        e.stopPropagation();
        e.preventDefault();
        showCharacterImportModal();
      };
      toolbar.appendChild(btn);
    }

    // 在场景页面注入导入按钮
    if (path.includes('场景') && toolbar && !toolbar.querySelector('.seven-scene-import-btn')) {
      const btn = document.createElement('button');
      btn.className = 'seven-scene-import-btn content-toolbar-button accent';
      btn.textContent = '导入场景（微调）';
      btn.onclick = function(e) {
        e.stopPropagation();
        e.preventDefault();
        showSceneImportModal();
      };
      toolbar.appendChild(btn);
    }
  }

  function setupAssetPanelObserver() {
    injectAssetPanelStyles();
    let debounceTimer = null;
    function debouncedCheck() {
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(checkAndInjectAssetPanel, 200);
    }
    const observer = new MutationObserver(function(mutations) {
      for (const m of mutations) {
        if (m.type === 'childList') {
          for (const node of m.addedNodes) {
            if (node.nodeType === 1 && (
              node.classList && (node.classList.contains('content-browser-panel') ||
                node.classList.contains('content-browser-toolbar') ||
                node.classList.contains('content-toolbar-actions') ||
                node.classList.contains('content-breadcrumb') ||
                node.classList.contains('content-breadcrumb-link')) ||
              node.querySelector && (node.querySelector('.content-browser-panel') ||
                node.querySelector('.content-toolbar-actions') ||
                node.querySelector('.content-breadcrumb'))
            )) {
              debouncedCheck();
              return;
            }
          }
        }
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
    setTimeout(checkAndInjectAssetPanel, 500);
    // 定期检查，以防 MutationObserver 漏掉某些变化
    setInterval(checkAndInjectAssetPanel, 2000);
  }

  // ==================== 播放器预览 ====================

  async function handlePreviewExport() {
    if (isExporting) return;
    let progressEl = null;
    try {
      // 始终弹出发布设置对话框，让用户可以修改设置（预填充缓存的设置）
      var cachedSettings = window._funloomCachedPublishSettings;
      // 读取项目数据用于设置对话框
      var reactProjForSettings = getReactCurrentProject();
      var projectDataForSettings = null;
      if (reactProjForSettings && (reactProjForSettings.nodes || (reactProjForSettings.scripts && reactProjForSettings.scripts.length > 0))) {
        projectDataForSettings = JSON.parse(JSON.stringify(reactProjForSettings));
      }
      if (!projectDataForSettings) {
        var db = await openDB();
        var projects = await getAllStories(db);
        if (projects && projects.length > 0) {
          projectDataForSettings = projects[0].project || projects[0];
        }
      }
      var endingSettings = null;
      if (projectDataForSettings) {
        // 传入缓存的设置作为默认值，用户可以修改后确认
        endingSettings = await showEndingSettingsDialog(projectDataForSettings, cachedSettings);
        if (!endingSettings) return; // 用户取消了
      }

      progressEl = showProgress('正在生成预览...');

      // 读取项目数据（确保标题等正确传递）
      var previewProjectData = null;
      var reactProj = getReactCurrentProject();
      if (reactProj && (reactProj.nodes || (reactProj.scripts && reactProj.scripts.length > 0))) {
        previewProjectData = JSON.parse(JSON.stringify(reactProj));
        console.log('[预览] 从 React 状态读取项目数据成功，标题:',
          (previewProjectData.outline && previewProjectData.outline.projectTitle) || '(无)');
      }

      const result = await generateExportHTML('dark', function(msg) {
        updateProgress(progressEl, msg);
      }, { isPreview: true, projectData: previewProjectData, endingSettings: endingSettings });
      if (!result) {
        removeProgress();
        return;
      }
      // 在新窗口中打开预览
      const blob = new Blob([result.html], { type: 'text/html;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const previewWindow = window.open(url, '_blank');
      if (!previewWindow) {
        alert('请允许弹出窗口以查看预览');
      }
      removeProgress();
    } catch (err) {
      console.error('预览失败:', err);
      removeProgress();
      alert('预览失败: ' + (err.message || String(err)));
    }
  }

  function interceptPlayerClick(e) {
    const btn = e.target.closest('button');
    if (!btn) return;
    const text = (btn.textContent || '').trim();
    const title = btn.getAttribute('title') || '';
    const ariaLabel = btn.getAttribute('aria-label') || '';
    const isPlayer = text.includes('播放器') || title.includes('播放器') || ariaLabel.includes('播放器');
    const isPlay = text.includes('试玩') || title.includes('试玩') || ariaLabel.includes('试玩');
    if (!isPlayer && !isPlay) return;
    // 只拦截播放器开关和试玩按钮，让它们打开预览页面
    if (btn.tagName === 'BUTTON' && (isPlayer || isPlay)) {
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      handlePreviewExport();
    }
  }

  // ==================== 初始化 ====================

  function init() {
    document.addEventListener('click', interceptClick, true);
    document.addEventListener('click', interceptPlayerClick, true);
    setupInspectorObserver();
    setupAssetPanelObserver();
    // 移除AI功能，确保资产使用本地上传
    setupAIRemoval();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
