/**
 * auth-gate.js
 * 认证门控系统 —— 验证码 + 登录
 *
 * 流程:
 * 1. 检查是否已有登录会话 → 有则直接进入应用
 * 2. 无会话 → 显示验证码界面（输入手机号 → 获取验证码 → 输入验证码）
 * 3. 验证码通过 → 显示登录界面（用户名 + 密码）
 * 4. 登录成功 → 保存会话 → 进入应用
 * 5. 应用内: 设置面板注入"账户"分区，可退登
 * 6. 应用内: 右上角账户指示器
 */

(function () {
  'use strict';

  var CD = window.CUSTOMER_DATA;
  if (!CD) {
    console.error('[AuthGate] customer-data.js 未加载，认证系统无法启动');
    return;
  }

  // ==================== 样式 ====================

  var STYLE_ID = 'auth-gate-styles';

  function injectStyles() {
    if (document.getElementById(STYLE_ID)) return;
    var style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = [
      /* ===== 认证门控遮罩 ===== */
      '#auth-gate-overlay{',
      'position:fixed;inset:0;z-index:999999;',
      'display:flex;align-items:center;justify-content:center;',
      'background:linear-gradient(135deg,#0d1018 0%,#161024 50%,#0e1525 100%);',
      'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","Noto Sans SC",sans-serif;',
      'color:#e2e4e9;',
      'animation:authFadeIn .3s ease;',
      '}',
      '@keyframes authFadeIn{from{opacity:0}to{opacity:1}}',
      '@keyframes authSlideUp{from{transform:translateY(20px);opacity:0}to{transform:translateY(0);opacity:1}}',
      '@keyframes authSpin{to{transform:rotate(360deg)}}',

      /* ===== 认证卡片 ===== */
      '.auth-card{',
      'width:100%;max-width:380px;margin:16px;',
      'background:rgba(26,29,46,.95);',
      'border:1px solid rgba(255,77,120,.2);',
      'border-radius:16px;padding:32px 28px;',
      'box-shadow:0 24px 80px rgba(0,0,0,.5),inset 0 1px 0 rgba(255,255,255,.05);',
      'animation:authSlideUp .4s ease;',
      '}',
      '.auth-logo{',
      'text-align:center;margin-bottom:24px;',
      '}',
      '.auth-logo-icon{',
      'width:56px;height:56px;margin:0 auto 12px;',
      'border-radius:14px;',
      'background:linear-gradient(135deg,#d90b46,#ff4d78);',
      'display:flex;align-items:center;justify-content:center;',
      'font-size:28px;',
      'box-shadow:0 8px 24px rgba(217,11,70,.3);',
      '}',
      '.auth-logo-title{',
      'font-size:22px;font-weight:700;color:#fff7fb;',
      '}',
      '.auth-logo-subtitle{',
      'font-size:13px;color:#8b92a8;margin-top:4px;',
      '}',

      /* ===== 表单 ===== */
      '.auth-field{margin-bottom:16px;}',
      '.auth-label{',
      'display:block;font-size:13px;color:#c9c3d8;margin-bottom:6px;font-weight:500;',
      '}',
      '.auth-input-wrap{position:relative;}',
      '.auth-input{',
      'width:100%;height:44px;',
      'background:rgba(15,17,24,.6);',
      'border:1px solid rgba(201,195,216,.15);',
      'border-radius:10px;',
      'color:#e2e4e9;font-size:14px;',
      'padding:0 14px;font-family:inherit;',
      'transition:border-color .2s,box-shadow .2s;',
      'box-sizing:border-box;',
      '}',
      '.auth-input:focus{',
      'outline:none;',
      'border-color:#ff4d7859;',
      'box-shadow:0 0 0 3px rgba(255,77,120,.12);',
      '}',
      '.auth-input::placeholder{color:#4a4f63;}',

      /* ===== 主按钮 ===== */
      '.auth-btn{',
      'width:100%;height:46px;',
      'border:none;border-radius:10px;',
      'background:linear-gradient(135deg,#d90b46,#ff4d78);',
      'color:#fff;font-size:15px;font-weight:600;',
      'cursor:pointer;font-family:inherit;',
      'transition:transform .15s,box-shadow .2s;',
      'display:flex;align-items:center;justify-content:center;gap:8px;',
      '}',
      '.auth-btn:hover:not(:disabled){transform:translateY(-1px);box-shadow:0 6px 20px rgba(217,11,70,.35);}',
      '.auth-btn:active:not(:disabled){transform:translateY(0);}',
      '.auth-btn:disabled{opacity:.6;cursor:not-allowed;}',
      '.auth-btn-secondary{',
      'background:rgba(201,195,216,.08);color:#c9c3d8;',
      '}',
      '.auth-btn-secondary:hover:not(:disabled){background:rgba(201,195,216,.14);box-shadow:none;}',

      /* ===== 消息提示 ===== */
      '.auth-msg{',
      'min-height:20px;font-size:12px;margin-top:8px;',
      'transition:opacity .2s;',
      '}',
      '.auth-msg.error{color:#f87171;}',
      '.auth-msg.success{color:#4ade80;}',
      '.auth-msg.info{color:#8b92a8;}',

      /* ===== 设备标签 ===== */
      '.auth-device-tag{',
      'display:inline-flex;align-items:center;gap:5px;',
      'padding:4px 10px;border-radius:999px;',
      'font-size:11px;font-weight:600;',
      'margin-bottom:20px;',
      '}',
      '.auth-device-tag.desktop{background:rgba(91,140,255,.12);color:#5b8cff;}',
      '.auth-device-tag.mobile{background:rgba(167,139,250,.12);color:#a78bfa;}',

      /* ===== 账户指示器（应用内） ===== */
      '.auth-account-indicator{',
      'position:fixed;top:8px;right:8px;z-index:9000;',
      'display:flex;align-items:center;gap:8px;',
      'padding:6px 12px 6px 6px;',
      'background:rgba(26,29,46,.9);',
      'border:1px solid rgba(255,77,120,.2);',
      'border-radius:999px;',
      'backdrop-filter:blur(8px);',
      'cursor:pointer;',
      'transition:border-color .2s,box-shadow .2s;',
      'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","Noto Sans SC",sans-serif;',
      '}',
      '.auth-account-indicator:hover{border-color:rgba(255,77,120,.4);box-shadow:0 4px 16px rgba(0,0,0,.3);}',
      '.auth-account-avatar{',
      'width:28px;height:28px;border-radius:50%;',
      'background:linear-gradient(135deg,#d90b46,#ff4d78);',
      'display:flex;align-items:center;justify-content:center;',
      'font-size:13px;font-weight:700;color:#fff;flex-shrink:0;',
      '}',
      '.auth-account-info{display:flex;flex-direction:column;line-height:1.2;}',
      '.auth-account-name{font-size:12px;font-weight:600;color:#fff7fb;}',
      '.auth-account-type{font-size:10px;color:#8b92a8;}',
      '.auth-account-badge{',
      'font-size:9px;padding:1px 6px;border-radius:999px;',
      'background:rgba(91,140,255,.15);color:#5b8cff;',
      '}',
      '.auth-account-badge.mobile{background:rgba(167,139,250,.15);color:#a78bfa;}',

      /* ===== 退登确认弹窗 ===== */
      '.auth-logout-backdrop{',
      'position:fixed;inset:0;z-index:999998;',
      'display:flex;align-items:center;justify-content:center;',
      'background:rgba(0,0,0,.5);backdrop-filter:blur(2px);',
      'animation:authFadeIn .2s ease;',
      '}',
      '.auth-logout-dialog{',
      'width:100%;max-width:340px;margin:16px;',
      'background:#1a1d2e;border:1px solid rgba(201,195,216,.15);',
      'border-radius:14px;padding:24px;',
      'box-shadow:0 20px 60px rgba(0,0,0,.5);',
      'animation:authSlideUp .25s ease;',
      'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","Noto Sans SC",sans-serif;',
      '}',
      '.auth-logout-dialog h3{color:#fff7fb;font-size:16px;margin:0 0 8px;}',
      '.auth-logout-dialog p{color:#8b92a8;font-size:13px;margin:0 0 20px;line-height:1.5;}',
      '.auth-logout-dialog .auth-logout-actions{display:flex;gap:10px;}',
      '.auth-logout-dialog .auth-btn{flex:1;}',

      /* ===== 手机横屏适配 ===== */
      '@media (max-height:500px) and (orientation:landscape){',
      '#auth-gate-overlay{align-items:flex-start;padding-top:20px;}',
      '.auth-card{max-width:440px;padding:20px 24px;}',
      '.auth-logo{margin-bottom:12px;}',
      '.auth-logo-icon{width:40px;height:40px;font-size:20px;}',
      '.auth-logo-title{font-size:17px;}',
      '.auth-logo-subtitle{font-size:11px;}',
      '.auth-field{margin-bottom:12px;}',
      '.auth-label{font-size:12px;margin-bottom:4px;}',
      '.auth-input{height:38px;font-size:13px;}',
      '.auth-btn{height:40px;font-size:14px;}',
      '.auth-msg{font-size:11px;min-height:16px;margin-top:6px;}',
      '}',
      '@media (max-height:400px) and (orientation:landscape){',
      '.auth-card{max-width:480px;padding:16px 20px;}',
      '.auth-logo{margin-bottom:8px;}',
      '.auth-logo-icon{width:36px;height:36px;font-size:18px;}',
      '.auth-logo-title{font-size:16px;}',
      '.auth-logo-subtitle{display:none;}',
      '.auth-field{margin-bottom:10px;}',
      '.auth-input{height:36px;}',
      '.auth-btn{height:38px;}',
      '}',
      '@media (max-width:760px) and (orientation:landscape){',
      '.auth-account-indicator{top:4px;right:4px;padding:4px 8px 4px 4px;}',
      '.auth-account-avatar{width:22px;height:22px;font-size:11px;}',
      '.auth-account-name{font-size:11px;}',
      '.auth-account-type{display:none;}',
      '}',

      /* ===== 加载中 ===== */
      '.auth-loading{',
      'display:flex;flex-direction:column;align-items:center;gap:12px;',
      'color:#8b92a8;font-size:14px;',
      '}',
      '.auth-loading-spinner{',
      'width:28px;height:28px;',
      'border:3px solid rgba(255,77,120,.15);',
      'border-top-color:#ff4d78;',
      'border-radius:50%;',
      'animation:authSpin .8s linear infinite;',
      '}',
      ''
    ].join('\n');
    document.head.appendChild(style);
  }

  // ==================== DOM 构建 ====================

  function createOverlay() {
    var existing = document.getElementById('auth-gate-overlay');
    if (existing) return existing;

    var overlay = document.createElement('div');
    overlay.id = 'auth-gate-overlay';
    document.body.appendChild(overlay);
    return overlay;
  }

  function removeOverlay() {
    var overlay = document.getElementById('auth-gate-overlay');
    if (overlay) overlay.remove();
  }

  function getDeviceTag() {
    var isMobile = CD.isMobileDevice();
    var type = CD.getDeviceType();
    var label = isMobile ? '手机端' : '电脑端';
    var icon = isMobile ? '\u{1F4F1}' : '\u{1F4BB}';
    return '<div class="auth-device-tag ' + type + '">' + icon + ' ' + label + '用户</div>';
  }

  // ==================== 登录界面 ====================

  function renderLoginStep(overlay) {
    overlay.innerHTML = [
      '<div class="auth-card">',
      '<div class="auth-logo">',
      '<div class="auth-logo-icon">\u{1F3AD}</div>',
      '<div class="auth-logo-title">七七剧本杀</div>',
      '<div class="auth-logo-subtitle">请登录您的账号</div>',
      '</div>',
      getDeviceTag(),
      '<div class="auth-field">',
      '<label class="auth-label">用户名</label>',
      '<div class="auth-input-wrap">',
      '<input class="auth-input" id="auth-username-input" type="text" placeholder="请输入用户名" autocomplete="off" />',
      '</div>',
      '</div>',
      '<div class="auth-field">',
      '<label class="auth-label">密码</label>',
      '<div class="auth-input-wrap">',
      '<input class="auth-input" id="auth-password-input" type="password" placeholder="请输入密码" autocomplete="off" />',
      '</div>',
      '</div>',
      '<div class="auth-msg info" id="auth-msg"></div>',
      '<button class="auth-btn" id="auth-login-btn">登 录</button>',
      '</div>'
    ].join('');

    var usernameInput = document.getElementById('auth-username-input');
    var passwordInput = document.getElementById('auth-password-input');
    var loginBtn = document.getElementById('auth-login-btn');
    var msgEl = document.getElementById('auth-msg');

    function setMsg(text, type) {
      msgEl.textContent = text || '';
      msgEl.className = 'auth-msg ' + (type || 'info');
    }

    function doLogin() {
      var username = usernameInput.value.trim();
      var password = passwordInput.value.trim();
      if (!username) { setMsg('请输入用户名', 'error'); return; }
      if (!password) { setMsg('请输入密码', 'error'); return; }

      loginBtn.disabled = true;
      loginBtn.innerHTML = '<span class="auth-loading-spinner" style="width:18px;height:18px;border-width:2px;"></span> 登录中...';

      setTimeout(function () {
        var result = CD.login(username, password);
        if (result.success) {
          CD.saveSession(result.user);
          // 自动通过原应用的内测码门控
          try { localStorage.setItem('sevenSevenAuthorized', '1'); } catch(e) {}
          var appAuthOverlay = document.getElementById('auth-overlay');
          if (appAuthOverlay) appAuthOverlay.style.display = 'none';
          setMsg('登录成功，正在进入...', 'success');
          setTimeout(function () {
            removeOverlay();
            initAppIntegration(result.user);
          }, 500);
        } else {
          setMsg(result.message, 'error');
          loginBtn.disabled = false;
          loginBtn.textContent = '登 录';
        }
      }, 400);
    }

    loginBtn.addEventListener('click', doLogin);
    passwordInput.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') doLogin();
    });

    usernameInput.focus();
  }

  // ==================== 应用内集成 ====================

  function initAppIntegration(user) {
    injectAccountIndicator(user);
    injectSettingsLogout();
  }

  // 账户指示器（右上角）
  function injectAccountIndicator(user) {
    var existing = document.getElementById('auth-account-indicator');
    if (existing) existing.remove();

    var indicator = document.createElement('div');
    indicator.id = 'auth-account-indicator';
    indicator.className = 'auth-account-indicator';
    indicator.title = '点击退登';

    var initial = (user.displayName || user.username || '?').charAt(0).toUpperCase();
    var typeLabel = user.deviceType === 'mobile' ? '手机端' : '电脑端';
    var badgeClass = user.deviceType === 'mobile' ? 'mobile' : '';

    indicator.innerHTML = [
      '<div class="auth-account-avatar">' + escapeHtml(initial) + '</div>',
      '<div class="auth-account-info">',
      '<span class="auth-account-name">' + escapeHtml(user.displayName || user.username) + '</span>',
      '<span class="auth-account-type"><span class="auth-account-badge ' + badgeClass + '">' + typeLabel + '</span></span>',
      '</div>'
    ].join('');

    indicator.addEventListener('click', function (e) {
      e.stopPropagation();
      showLogoutDialog(user);
    });

    document.body.appendChild(indicator);
  }

  // 退登确认弹窗
  function showLogoutDialog(user) {
    var existing = document.getElementById('auth-logout-backdrop');
    if (existing) existing.remove();

    var backdrop = document.createElement('div');
    backdrop.id = 'auth-logout-backdrop';
    backdrop.className = 'auth-logout-backdrop';

    backdrop.innerHTML = [
      '<div class="auth-logout-dialog">',
      '<h3>确认退出登录？</h3>',
      '<p>当前账号: <strong style="color:#fff7fb;">' + escapeHtml(user.displayName || user.username) + '</strong><br/>退出后需要重新登录才能使用编辑器。</p>',
      '<div class="auth-logout-actions">',
      '<button class="auth-btn auth-btn-secondary" id="auth-logout-cancel">取消</button>',
      '<button class="auth-btn" id="auth-logout-confirm">退出登录</button>',
      '</div>',
      '</div>'
    ].join('');

    document.body.appendChild(backdrop);

    document.getElementById('auth-logout-cancel').addEventListener('click', function () {
      backdrop.remove();
    });
    document.getElementById('auth-logout-confirm').addEventListener('click', function () {
      CD.clearSession();
      // 同时清除原应用的内测码授权
      try { localStorage.removeItem('sevenSevenAuthorized'); } catch(e) {}
      backdrop.remove();
      var indicator = document.getElementById('auth-account-indicator');
      if (indicator) indicator.remove();
      // 重新显示认证门控
      startAuthGate();
    });

    // 点击遮罩关闭
    backdrop.addEventListener('click', function (e) {
      if (e.target === backdrop) backdrop.remove();
    });
  }

  // 设置面板注入退登按钮
  var settingsObserver = null;
  function injectSettingsLogout() {
    if (settingsObserver) settingsObserver.disconnect();

    settingsObserver = new MutationObserver(function (mutations) {
      for (var i = 0; i < mutations.length; i++) {
        var added = mutations[i].addedNodes;
        for (var j = 0; j < added.length; j++) {
          var node = added[j];
          if (node.nodeType !== 1) continue;
          var dialog = node.querySelector ? (node.querySelector('.settings-dialog') || (node.classList && node.classList.contains('settings-dialog') ? node : null)) : null;
          if (dialog) {
            injectLogoutIntoSettings(dialog);
          }
        }
      }
    });

    settingsObserver.observe(document.body, { childList: true, subtree: true });
  }

  function injectLogoutIntoSettings(dialog) {
    // 避免重复注入
    if (dialog.querySelector('#auth-settings-section')) return;

    var content = dialog.querySelector('.settings-dialog-content');
    if (!content) {
      // settings-dialog-content 可能还没渲染，延迟重试
      setTimeout(function () {
        content = dialog.querySelector('.settings-dialog-content');
        if (content && !dialog.querySelector('#auth-settings-section')) {
          doInject(content);
        }
      }, 100);
      return;
    }
    doInject(content);
  }

  function doInject(content) {
    var user = CD.loadSession();
    if (!user) return;

    var section = document.createElement('section');
    section.id = 'auth-settings-section';
    section.className = 'settings-section';
    section.style.cssText = 'border-top:1px solid rgba(201,195,216,.15);padding-top:20px;margin-top:8px;';

    var typeLabel = user.deviceType === 'mobile' ? '手机端' : '电脑端';
    var initial = (user.displayName || user.username || '?').charAt(0).toUpperCase();

    section.innerHTML = [
      '<h2>账户</h2>',
      '<div class="settings-row" style="align-items:center;">',
      '<div style="display:flex;align-items:center;gap:12px;">',
      '<div style="width:40px;height:40px;border-radius:50%;background:linear-gradient(135deg,#d90b46,#ff4d78);display:flex;align-items:center;justify-content:center;font-size:18px;font-weight:700;color:#fff;flex-shrink:0;">' + escapeHtml(initial) + '</div>',
      '<div>',
      '<strong style="color:var(--text-main);font-size:14px;display:block;margin-bottom:3px;">' + escapeHtml(user.displayName || user.username) + '</strong>',
      '<p style="color:var(--text-muted);margin:0;font-size:12px;">' + escapeHtml(user.username) + ' · ' + typeLabel + '用户</p>',
      '</div>',
      '</div>',
      '<button id="auth-settings-logout-btn" style="height:38px;padding:0 18px;border:1px solid rgba(248,113,113,.3);border-radius:8px;background:rgba(248,113,113,.08);color:#f87171;font-size:13px;font-weight:600;cursor:pointer;font-family:inherit;transition:background .2s;">退出登录</button>',
      '</div>'
    ].join('');

    content.appendChild(section);

    var logoutBtn = section.querySelector('#auth-settings-logout-btn');
    logoutBtn.addEventListener('click', function () {
      showLogoutDialog(user);
    });
  }

  // ==================== 工具函数 ====================

  function escapeHtml(text) {
    if (typeof text !== 'string') text = String(text || '');
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // ==================== 启动 ====================

  function startAuthGate() {
    injectStyles();

    // 隐藏原应用的内测码门控（由本系统接管认证）
    var appAuthOverlay = document.getElementById('auth-overlay');
    if (appAuthOverlay) appAuthOverlay.style.display = 'none';

    // 检查已有会话
    var session = CD.loadSession();
    if (session) {
      // 已登录，确保内测码已通过，直接进入应用
      try { localStorage.setItem('sevenSevenAuthorized', '1'); } catch(e) {}
      // 延迟初始化应用内集成，等待 React 渲染完成
      setTimeout(function () {
        initAppIntegration(session);
      }, 500);
      return;
    }

    // 未登录，清除内测码授权
    try { localStorage.removeItem('sevenSevenAuthorized'); } catch(e) {}

    // 创建遮罩
    var overlay = createOverlay();
    renderLoginStep(overlay);
  }

  // DOM ready 后启动
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', startAuthGate);
  } else {
    startAuthGate();
  }

  // 暴露 API
  window.AuthGate = {
    logout: function () {
      var user = CD.loadSession();
      if (user) showLogoutDialog(user);
    },
    getCurrentUser: function () {
      return CD.loadSession();
    },
    showLogin: startAuthGate
  };

})();
