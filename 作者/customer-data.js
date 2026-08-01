/**
 * customer-data.js
 * 客户数据存储 —— 存放电脑端用户和手机端用户账号
 *
 * 说明：
 * - desktopUsers: 电脑端用户账号（在 PC / 大屏浏览器登录时使用）
 * - mobileUsers:  手机端用户账号（在手机横屏 / 移动端浏览器登录时使用）
 * - 系统会根据设备类型自动选择对应的用户列表进行验证
 * - 每个用户包含: username(账号), password(密码), displayName(显示名), role(角色)
 * - verificationCodes: 动态生成的验证码缓存，由 sendVerifyCode() 生成
 */

window.CUSTOMER_DATA = (function () {
  'use strict';

  // ==================== 用户数据 ====================

  // 电脑端用户
  var desktopUsers = [
    {
      username: 'admin',
      password: 'admin123',
      displayName: '管理员',
      role: 'desktop-admin',
      phone: '13800000001'
    },
    {
      username: 'editor',
      password: 'editor456',
      displayName: '编辑者',
      role: 'desktop-editor',
      phone: '13800000002'
    },
    {
      username: 'viewer',
      password: 'viewer789',
      displayName: '查看者',
      role: 'desktop-viewer',
      phone: '13800000003'
    }
  ];

  // 手机端用户
  var mobileUsers = [
    {
      username: 'mobile',
      password: 'mobile123',
      displayName: '移动用户',
      role: 'mobile-user',
      phone: '13900000001'
    },
    {
      username: 'phone',
      password: 'phone456',
      displayName: '手机编辑',
      role: 'mobile-editor',
      phone: '13900000002'
    },
    {
      username: 'guest',
      password: 'guest789',
      displayName: '访客',
      role: 'mobile-guest',
      phone: '13900000003'
    }
  ];

  // ==================== 设备检测 ====================
  /**
   * 检测当前设备是否为手机端
   * 综合判断: 屏幕宽度、UA、触摸能力
   */
  function isMobileDevice() {
    var ua = navigator.userAgent || '';
    var isMobileUA = /Android|iPhone|iPad|iPod|Windows Phone|BlackBerry|Mobile|Opera Mini/i.test(ua);
    var hasTouch = 'ontouchstart' in window || navigator.maxTouchPoints > 0;
    var isCoarsePointer = window.matchMedia && window.matchMedia('(pointer: coarse)').matches;
    var hasTouchOrCoarse = hasTouch || isCoarsePointer;
    var isLandscape = window.innerWidth > window.innerHeight;
    var smallLandscape = isLandscape && window.innerHeight <= 500;
    var verySmallLandscape = isLandscape && window.innerHeight <= 450;
    var narrowScreen = window.innerWidth <= 760;

    // 移动端 UA 直接判定
    if (isMobileUA) return true;
    // 有触摸能力 + 小屏 = 手机
    if (hasTouchOrCoarse && smallLandscape) return true;
    if (hasTouchOrCoarse && narrowScreen) return true;
    // 极小横屏高度（即使无触摸也判定为手机，兼容浏览器窗口缩小）
    if (verySmallLandscape) return true;
    // 窄屏 + 横屏 = 手机
    if (narrowScreen && isLandscape) return true;

    return false;
  }

  /**
   * 获取当前设备类型: 'desktop' 或 'mobile'
   */
  function getDeviceType() {
    return isMobileDevice() ? 'mobile' : 'desktop';
  }

  // ==================== 登录逻辑 ====================

  /**
   * 根据设备类型获取用户列表
   */
  function getUsers() {
    return isMobileDevice() ? mobileUsers : desktopUsers;
  }

  /**
   * 用户登录
   * @param {string} username - 用户名
   * @param {string} password - 密码
   * @returns {{ success: boolean, message: string, user: object|null }}
   */
  function login(username, password) {
    var users = getUsers();
    var deviceType = getDeviceType();

    // 在对应设备类型的用户列表中查找
    for (var i = 0; i < users.length; i++) {
      if (users[i].username === username && users[i].password === password) {
        var user = {
          username: users[i].username,
          displayName: users[i].displayName,
          role: users[i].role,
          phone: users[i].phone,
          deviceType: deviceType,
          loginAt: Date.now()
        };
        return { success: true, message: '登录成功', user: user };
      }
    }

    // 也在另一类型的用户列表中查找，给出更友好的提示
    var otherUsers = isMobileDevice() ? desktopUsers : mobileUsers;
    var otherType = isMobileDevice() ? '电脑端' : '手机端';
    for (var j = 0; j < otherUsers.length; j++) {
      if (otherUsers[j].username === username && otherUsers[j].password === password) {
        return {
          success: false,
          message: '该账号为' + otherType + '账号，请在' + otherType + '设备上登录',
          user: null
        };
      }
    }

    return { success: false, message: '用户名或密码错误', user: null };
  }

  // ==================== 持久化 ====================

  var STORAGE_KEY = 'funloom_auth_session';

  /**
   * 保存登录会话
   */
  function saveSession(user) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(user));
    } catch (e) {
      console.warn('[Auth] 无法保存会话', e);
    }
  }

  /**
   * 读取登录会话
   * @returns {object|null}
   */
  function loadSession() {
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      var session = JSON.parse(raw);
      // 检查设备类型是否匹配
      if (session.deviceType && session.deviceType !== getDeviceType()) {
        // 设备类型不匹配，清除会话
        clearSession();
        return null;
      }
      return session;
    } catch (e) {
      return null;
    }
  }

  /**
   * 清除登录会话（退登）
   */
  function clearSession() {
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch (e) {
      console.warn('[Auth] 无法清除会话', e);
    }
  }

  // ==================== 公开 API ====================

  return {
    desktopUsers: desktopUsers,
    mobileUsers: mobileUsers,
    isMobileDevice: isMobileDevice,
    getDeviceType: getDeviceType,
    login: login,
    getUsers: getUsers,
    saveSession: saveSession,
    loadSession: loadSession,
    clearSession: clearSession
  };
})();
