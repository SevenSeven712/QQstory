/**
 * customer-data.js
 * 客户认证与数据管理模块
 * 
 * @description 管理电脑端/手机端用户账号、设备检测、登录验证及会话持久化
 * @author 你的团队
 * @version 2.0.0
 */

window.CUSTOMER_DATA = (function () {
  'use strict';

  // ================================================================
  // 1. 配置常量
  // ================================================================

  const CONFIG = {
    STORAGE_KEY: 'funloom_auth_session',
    LANDSCAPE_HEIGHT_THRESHOLD: 500,
    NARROW_SCREEN_WIDTH: 760,
    MINI_LANDSCAPE_HEIGHT: 450,
  };

  // ================================================================
  // 2. 用户数据（可扩展为从 API 获取）
  // ================================================================

  const USER_DATABASE = {
    desktop: [
      { username: 'DN',  password: 'DN666', displayName: '编辑模式', role: 'desktop-admin', phone: '13800000001' },
      { username: 'editor', password: 'editor456', displayName: '编辑者', role: 'desktop-editor', phone: '13800000002' },
      { username: 'viewer', password: 'viewer789', displayName: '查看者', role: 'desktop-viewer', phone: '13800000003' },
    ],
    mobile: [
      { username: 'SJ', password: 'SJ777', displayName: '编辑模式', role: 'mobile-user',   phone: '13900000001' },
    ],
  };

  // ================================================================
  // 3. 设备检测引擎
  // ================================================================

  const DeviceDetector = {
    /**
     * 判断是否为移动设备
     * @returns {boolean}
     */
    isMobile() {
      const { LANDSCAPE_HEIGHT_THRESHOLD, NARROW_SCREEN_WIDTH, MINI_LANDSCAPE_HEIGHT } = CONFIG;
      
      // UA 检测
      const ua = navigator.userAgent || '';
      if (/Android|iPhone|iPad|iPod|Windows Phone|BlackBerry|Mobile|Opera Mini/i.test(ua)) {
        return true;
      }

      // 触摸能力检测
      const hasTouch = 'ontouchstart' in window || navigator.maxTouchPoints > 0;
      const isCoarsePointer = window.matchMedia?.('(pointer: coarse)').matches || false;
      const hasTouchOrCoarse = hasTouch || isCoarsePointer;

      // 屏幕尺寸检测
      const isLandscape = window.innerWidth > window.innerHeight;
      const smallLandscape = isLandscape && window.innerHeight <= LANDSCAPE_HEIGHT_THRESHOLD;
      const miniLandscape = isLandscape && window.innerHeight <= MINI_LANDSCAPE_HEIGHT;
      const narrowScreen = window.innerWidth <= NARROW_SCREEN_WIDTH;

      // 综合判断
      if (hasTouchOrCoarse && (smallLandscape || narrowScreen)) return true;
      if (miniLandscape) return true;
      if (narrowScreen && isLandscape) return true;

      return false;
    },

    /**
     * 获取设备类型
     * @returns {'desktop' | 'mobile'}
     */
    getType() {
      return this.isMobile() ? 'mobile' : 'desktop';
    },

    /**
     * 设备变化监听（用于响应式适配）
     * @param {Function} callback - 设备变化时的回调函数
     * @returns {Function} 取消监听的函数
     */
    onDeviceChange(callback) {
      const handler = () => callback(this.getType());
      window.addEventListener('resize', handler);
      window.addEventListener('orientationchange', handler);
      return () => {
        window.removeEventListener('resize', handler);
        window.removeEventListener('orientationchange', handler);
      };
    },
  };

  // ================================================================
  // 4. 认证服务
  // ================================================================

  const AuthService = {
    /**
     * 获取当前设备对应的用户列表
     * @returns {Array}
     */
    getUsers() {
      const deviceType = DeviceDetector.getType();
      return USER_DATABASE[deviceType] || [];
    },

    /**
     * 在所有用户中查找（用于跨设备提示）
     * @param {string} username
     * @param {string} password
     * @returns {Object|null}
     */
    findUserInAllDevices(username, password) {
      const allUsers = [...USER_DATABASE.desktop, ...USER_DATABASE.mobile];
      return allUsers.find(u => u.username === username && u.password === password) || null;
    },

    /**
     * 用户登录
     * @param {string} username
     * @param {string} password
     * @returns {{ success: boolean, message: string, user: Object|null }}
     */
    login(username, password) {
      // 参数校验
      if (!username || !password) {
        return { success: false, message: '用户名和密码不能为空', user: null };
      }

      const deviceType = DeviceDetector.getType();
      const users = this.getUsers();

      // 在当前设备用户列表中查找
      const matchedUser = users.find(u => u.username === username && u.password === password);
      
      if (matchedUser) {
        return {
          success: true,
          message: '登录成功',
          user: {
            username: matchedUser.username,
            displayName: matchedUser.displayName,
            role: matchedUser.role,
            phone: matchedUser.phone,
            deviceType: deviceType,
            loginAt: Date.now(),
          },
        };
      }

      // 检查是否在其他设备类型的用户中
      const otherDeviceUser = this.findUserInAllDevices(username, password);
      if (otherDeviceUser) {
        const otherType = USER_DATABASE.desktop.includes(otherDeviceUser) ? '电脑端' : '手机端';
        return {
          success: false,
          message: `该账号为${otherType}账号，请在${otherType}设备上登录`,
          user: null,
        };
      }

      return { success: false, message: '用户名或密码错误', user: null };
    },

    /**
     * 验证码生成（模拟）
     * @param {string} phone - 手机号
     * @returns {string} 6位数字验证码
     */
    generateVerificationCode(phone) {
      // 实际项目中应调用后端 API
      const code = String(Math.floor(100000 + Math.random() * 900000));
      console.log(`[验证码] 发送到 ${phone}: ${code}`);
      return code;
    },
  };

  // ================================================================
  // 5. 会话管理
  // ================================================================

  const SessionManager = {
    /**
     * 保存登录会话
     * @param {Object} user
     */
    save(user) {
      try {
        localStorage.setItem(CONFIG.STORAGE_KEY, JSON.stringify(user));
        return true;
      } catch (e) {
        console.warn('[Session] 保存失败:', e);
        return false;
      }
    },

    /**
     * 读取登录会话
     * @returns {Object|null}
     */
    load() {
      try {
        const raw = localStorage.getItem(CONFIG.STORAGE_KEY);
        if (!raw) return null;

        const session = JSON.parse(raw);
        
        // 验证会话有效性
        if (session.deviceType && session.deviceType !== DeviceDetector.getType()) {
          this.clear();
          return null;
        }

        // 检查是否过期（可选，这里设定 7 天过期）
        const MAX_AGE = 7 * 24 * 60 * 60 * 1000;
        if (session.loginAt && Date.now() - session.loginAt > MAX_AGE) {
          this.clear();
          return null;
        }

        return session;
      } catch (e) {
        return null;
      }
    },

    /**
     * 清除登录会话
     */
    clear() {
      try {
        localStorage.removeItem(CONFIG.STORAGE_KEY);
        return true;
      } catch (e) {
        console.warn('[Session] 清除失败:', e);
        return false;
      }
    },

    /**
     * 检查是否已登录
     * @returns {boolean}
     */
    isLoggedIn() {
      return !!this.load();
    },

    /**
     * 获取当前用户信息
     * @returns {Object|null}
     */
    getCurrentUser() {
      return this.load();
    },
  };

  // ================================================================
  // 6. 公开 API
  // ================================================================

  return {
    // 原始数据（只读）
    get desktopUsers() { return USER_DATABASE.desktop; },
    get mobileUsers() { return USER_DATABASE.mobile; },

    // 设备检测
    isMobileDevice: DeviceDetector.isMobile.bind(DeviceDetector),
    getDeviceType: DeviceDetector.getType.bind(DeviceDetector),
    onDeviceChange: DeviceDetector.onDeviceChange.bind(DeviceDetector),

    // 认证
    login: AuthService.login.bind(AuthService),
    getUsers: AuthService.getUsers.bind(AuthService),
    generateVerificationCode: AuthService.generateVerificationCode.bind(AuthService),

    // 会话
    saveSession: SessionManager.save.bind(SessionManager),
    loadSession: SessionManager.load.bind(SessionManager),
    clearSession: SessionManager.clear.bind(SessionManager),
    isLoggedIn: SessionManager.isLoggedIn.bind(SessionManager),
    getCurrentUser: SessionManager.getCurrentUser.bind(SessionManager),
  };
})();