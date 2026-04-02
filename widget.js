/**
 * Notification Widget
 * Embed on any page with:
 *
 *   <script src="https://tomaskrivanek.github.io/beamer-test/widget.js"></script>
 *   <script>
 *     NotifWidget.init({
 *       userId: 'user-123',
 *       role: 'admin',
 *       buildingType: 'hotel'
 *     });
 *   </script>
 */
(function (window, document) {
  'use strict';

  // ─── Firebase Config ────────────────────────────────────────────────────────
  var FIREBASE_CONFIG = {
    apiKey: "AIzaSyCgHb1-BU3CGFXYlK0pAfRJ5Qg6vl0QIEk",
    authDomain: "notification-poc-10791.firebaseapp.com",
    projectId: "notification-poc-10791",
    storageBucket: "notification-poc-10791.firebasestorage.app",
    messagingSenderId: "708608682639",
    appId: "1:708608682639:web:ec254b9906fccc0a7fdefa"
  };

  var FIREBASE_VER = '10.11.0';

  // ─── Category definitions ────────────────────────────────────────────────────
  var CATEGORIES = {
    'new-feature':  { label: 'New feature',  color: '#0d6eaa' },
    'announcement': { label: 'Announcement', color: '#8b5cf6' },
    'tip':          { label: 'Tip',          color: '#10b981' },
    'maintenance':  { label: 'Maintenance',  color: '#f59e0b' },
    'update':       { label: 'Update',       color: '#06b6d4' }
  };

  // ─── State ──────────────────────────────────────────────────────────────────
  var _config        = {};
  var _allPublished  = [];   // raw Firestore docs
  var _notifications = [];   // filtered by time, expiry, user — max 30
  var _readIds       = new Set();
  var _db            = null;
  var _knownIds      = null;
  var _activeCategory = 'all';

  // ─── Public API ─────────────────────────────────────────────────────────────
  function init(userConfig) {
    _config = Object.assign({ userId: 'anonymous', role: null, buildingType: null }, userConfig || {});
    _loadReadState();
    _injectStyles();
    _loadFirebase(function () {
      _renderWidget();
      _subscribeToNotifications();
      setInterval(_applyFilters, 60000);
    });
  }

  // ─── Firebase ───────────────────────────────────────────────────────────────
  function _loadFirebase(callback) {
    if (window.firebase && window.firebase.firestore) {
      _db = firebase.firestore();
      return callback();
    }
    var base = 'https://www.gstatic.com/firebasejs/' + FIREBASE_VER;
    _loadScript(base + '/firebase-app-compat.js', function () {
      _loadScript(base + '/firebase-firestore-compat.js', function () {
        firebase.initializeApp(FIREBASE_CONFIG);
        _db = firebase.firestore();
        callback();
      });
    });
  }

  function _loadScript(src, cb) {
    var s = document.createElement('script');
    s.src = src; s.onload = cb;
    document.head.appendChild(s);
  }

  function _subscribeToNotifications() {
    _db.collection('notifications')
      .where('status', '==', 'published')
      .onSnapshot(function (snapshot) {
        _allPublished = snapshot.docs.map(function (doc) {
          return Object.assign({ id: doc.id }, doc.data());
        });
        _applyFilters();
      }, function (err) { console.error('[NotifWidget]', err); });
  }

  function _applyFilters() {
    var now = new Date();
    var filtered = _allPublished.filter(function (n) {
      // Must be scheduled for now or earlier
      var t = n.scheduledFor && n.scheduledFor.toDate ? n.scheduledFor.toDate() : new Date(n.scheduledFor || 0);
      if (t > now) return false;
      // Must not be expired
      if (n.expiresAt) {
        var exp = n.expiresAt.toDate ? n.expiresAt.toDate() : new Date(n.expiresAt);
        if (exp < now) return false;
      }
      return _matchesUser(n);
    });

    filtered.sort(function (a, b) {
      var ta = a.scheduledFor && a.scheduledFor.toDate ? a.scheduledFor.toDate() : new Date(a.scheduledFor || 0);
      var tb = b.scheduledFor && b.scheduledFor.toDate ? b.scheduledFor.toDate() : new Date(b.scheduledFor || 0);
      return tb - ta;
    });

    // Limit to 30 most recent
    _notifications = filtered.slice(0, 30);

    _renderCategoryFilter();
    _renderNotifications();
    _updateBadge();
    _checkForNew();
  }

  function _matchesUser(n) {
    var roles = n.targetRoles || [];
    var types = n.targetBuildingTypes || [];
    if (roles.length > 0 && _config.role && roles.indexOf(_config.role) === -1) return false;
    if (types.length > 0 && _config.buildingType && types.indexOf(_config.buildingType) === -1) return false;
    return true;
  }

  // ─── Read State ──────────────────────────────────────────────────────────────
  function _loadReadState() {
    try {
      var raw = localStorage.getItem('notif_read_' + _config.userId);
      _readIds = new Set(raw ? JSON.parse(raw) : []);
    } catch (e) { _readIds = new Set(); }
  }

  function _saveReadState() {
    try {
      localStorage.setItem('notif_read_' + _config.userId, JSON.stringify(Array.from(_readIds)));
    } catch (e) {}
  }

  function _markAsRead(id) {
    if (_readIds.has(id)) return;
    _readIds.add(id);
    _saveReadState();
    // Write to Firestore for read receipt analytics
    if (_db) {
      _db.collection('reads').doc(id + '_' + _config.userId).set({
        notifId: id,
        userId: _config.userId,
        readAt: firebase.firestore.FieldValue.serverTimestamp()
      }).catch(function (err) { console.error('[NotifWidget] Read receipt failed:', err.message); });
    }
    _updateBadge();
    _renderNotifications();
  }

  function _markAllAsRead() {
    _notifications.forEach(function (n) { _readIds.add(n.id); });
    _saveReadState();
    if (_db) {
      _notifications.forEach(function (n) {
        _db.collection('reads').doc(n.id + '_' + _config.userId).set({
          notifId: n.id,
          userId: _config.userId,
          readAt: firebase.firestore.FieldValue.serverTimestamp()
        }).catch(function () {});
      });
    }
    _updateBadge();
    _renderNotifications();
  }

  function _unreadCount() {
    return _notifications.filter(function (n) { return !_readIds.has(n.id); }).length;
  }

  // ─── New Notification Detection ──────────────────────────────────────────────
  function _checkForNew() {
    var currentIds = new Set(_notifications.map(function (n) { return n.id; }));

    if (_knownIds === null) {
      var firstUnread = _notifications.find(function (n) { return !_readIds.has(n.id); });
      if (firstUnread) setTimeout(function () { _triggerDisplay(firstUnread); }, 1200);
    } else {
      _notifications.forEach(function (n) {
        if (!_knownIds.has(n.id) && !_readIds.has(n.id)) {
          _pulseBell();
          _triggerDisplay(n);
        }
      });
    }
    _knownIds = currentIds;
  }

  function _triggerDisplay(n) {
    var mode = n.displayMode || 'toast';
    if (mode === 'fullscreen') _showFullscreen(n);
    else if (mode === 'toast')  _showToast(n);
    // badge: do nothing extra
  }

  function _pulseBell() {
    var bell = document.getElementById('nw-bell');
    if (!bell) return;
    bell.classList.remove('nw-pulse');
    void bell.offsetWidth; // force reflow to restart animation
    bell.classList.add('nw-pulse');
  }

  // ─── Styles ──────────────────────────────────────────────────────────────────
  function _injectStyles() {
    if (document.getElementById('nw-styles')) return;
    var css = `
      /* ── Bell ── */
      #nw-bell {
        position: relative !important;
        background: #335075 !important;
        border: none !important;
        cursor: pointer !important;
        padding: 8px 10px !important;
        border-radius: 8px !important;
        display: inline-flex !important;
        align-items: center !important;
        justify-content: center !important;
        transition: background 0.2s !important;
        margin-left: 12px !important;
        vertical-align: middle !important;
        box-shadow: 0 2px 6px rgba(0,0,0,0.18) !important;
      }
      #nw-bell:hover { background: #2a4163 !important; }
      #nw-bell svg { width: 20px !important; height: 20px !important; fill: #fff !important; display: block !important; }
      #nw-badge {
        position: absolute; top: -5px; right: -5px;
        background: #e74c3c; color: #fff;
        font: bold 10px/16px -apple-system, sans-serif;
        min-width: 16px; height: 16px; border-radius: 8px;
        display: none; align-items: center; justify-content: center;
        padding: 0 3px; border: 2px solid #fff; box-sizing: content-box;
      }
      @keyframes nw-bell-pulse {
        0%   { transform: scale(1); }
        20%  { transform: scale(1.22); }
        40%  { transform: scale(1); }
        65%  { transform: scale(1.14); }
        100% { transform: scale(1); }
      }
      #nw-bell.nw-pulse { animation: nw-bell-pulse 0.6s ease 3 !important; }

      /* ── Panel ── */
      #nw-panel {
        position: fixed; top: 62px; right: 16px; width: 360px;
        max-height: 540px; background: #fff; border-radius: 12px;
        box-shadow: 0 8px 32px rgba(0,0,0,0.16); z-index: 99998;
        display: none; flex-direction: column; overflow: hidden;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
        border: 1px solid rgba(0,0,0,0.08);
      }
      #nw-panel.nw-open { display: flex; }
      #nw-panel-hd {
        padding: 14px 18px 10px; border-bottom: 1px solid #f0f0f0;
        display: flex; align-items: center; justify-content: space-between;
        background: #fafafa; flex-shrink: 0;
      }
      #nw-panel-hd h3 { margin: 0; font-size: 14px; font-weight: 700; color: #1a1a2e; }
      #nw-mark-all {
        background: none; border: none; cursor: pointer; font-size: 12px;
        color: #335075; font-weight: 500; padding: 4px 8px; border-radius: 4px; font-family: inherit;
      }
      #nw-mark-all:hover { background: #eef2f7; }

      /* ── Category filter ── */
      #nw-cat-filter {
        display: flex; gap: 6px; padding: 10px 14px 8px; flex-wrap: wrap;
        border-bottom: 1px solid #f0f0f0; flex-shrink: 0; background: #fff;
      }
      .nw-cat-chip {
        display: inline-flex; align-items: center; gap: 4px;
        padding: 3px 10px; border-radius: 20px; font-size: 11px; font-weight: 600;
        cursor: pointer; border: 1.5px solid #e5e7eb; color: #6b7280;
        background: #fff; transition: all 0.12s; font-family: inherit;
        white-space: nowrap;
      }
      .nw-cat-chip:hover { border-color: #9ca3af; color: #374151; }
      .nw-cat-chip.nw-active { color: #fff; border-color: transparent; }

      /* ── Notification list ── */
      #nw-list { overflow-y: auto; flex: 1; }

      /* ── Empty state ── */
      #nw-empty {
        padding: 40px 20px; text-align: center;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      }
      #nw-empty svg { width: 56px; height: 56px; margin: 0 auto 12px; display: block; opacity: 0.2; }
      #nw-empty-title { font-size: 14px; font-weight: 600; color: #374151; margin-bottom: 4px; }
      #nw-empty-sub   { font-size: 12px; color: #9ca3af; }

      /* ── Notification items ── */
      .nw-item {
        padding: 12px 16px; border-bottom: 1px solid #f5f5f5; cursor: pointer;
        display: flex; gap: 10px; align-items: flex-start; transition: background 0.12s;
      }
      .nw-item:last-child { border-bottom: none; }
      .nw-item:hover { background: #f8f9fb; }
      .nw-item.nw-unread { background: #f0f5ff; }
      .nw-item.nw-unread:hover { background: #e8f0fe; }
      .nw-dot {
        width: 8px; height: 8px; border-radius: 50%; background: #335075;
        margin-top: 5px; flex-shrink: 0; opacity: 0;
      }
      .nw-item.nw-unread .nw-dot { opacity: 1; }
      .nw-content { flex: 1; min-width: 0; }
      .nw-item-top { display: flex; align-items: center; gap: 6px; margin-bottom: 2px; }
      .nw-title {
        font-size: 13px; font-weight: 600; color: #1a1a2e;
        white-space: nowrap; overflow: hidden; text-overflow: ellipsis; flex: 1;
      }
      .nw-new-badge {
        flex-shrink: 0; background: #ef4444; color: #fff;
        font-size: 9px; font-weight: 700; padding: 1px 5px;
        border-radius: 4px; letter-spacing: 0.5px; text-transform: uppercase;
      }
      .nw-cat-label {
        display: inline-block; font-size: 10px; font-weight: 600;
        padding: 1px 6px; border-radius: 4px; margin-bottom: 3px;
        color: #fff; opacity: 0.9;
      }
      .nw-preview {
        font-size: 12px; color: #777;
        white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
      }
      .nw-time { font-size: 11px; color: #bbb; white-space: nowrap; flex-shrink: 0; }

      /* ── Reading modal ── */
      #nw-overlay {
        position: fixed; inset: 0; background: rgba(0,0,0,0.48);
        z-index: 99999; display: none; align-items: center; justify-content: center;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      }
      #nw-overlay.nw-open { display: flex; }
      #nw-modal {
        background: #fff; border-radius: 16px; max-width: 620px;
        width: calc(100% - 32px); max-height: calc(100vh - 64px);
        overflow-y: auto; box-shadow: 0 20px 60px rgba(0,0,0,0.22); display: flex; flex-direction: column;
      }
      #nw-modal-hd {
        padding: 20px 24px 16px; border-bottom: 1px solid #f0f0f0;
        display: flex; align-items: flex-start; gap: 12px;
      }
      #nw-modal-hd-left { flex: 1; min-width: 0; }
      #nw-modal-cat { display: inline-block; font-size: 11px; font-weight: 600; padding: 2px 8px; border-radius: 4px; margin-bottom: 6px; color: #fff; }
      #nw-modal-title { margin: 0; font-size: 18px; font-weight: 700; color: #1a1a2e; line-height: 1.3; }
      #nw-modal-close {
        background: none; border: none; cursor: pointer;
        font-size: 18px; color: #bbb; padding: 2px; line-height: 1; flex-shrink: 0;
      }
      #nw-modal-close:hover { color: #555; }
      #nw-modal-body { padding: 20px 24px; color: #333; font-size: 15px; line-height: 1.65; }
      #nw-modal-body img { max-width: 100%; border-radius: 8px; margin: 8px 0; display: block; }
      #nw-modal-body a { color: #335075; }
      #nw-modal-body p { margin: 0 0 12px; }
      #nw-modal-body h1, #nw-modal-body h2, #nw-modal-body h3 { margin: 16px 0 8px; color: #1a1a2e; }
      #nw-modal-body ul, #nw-modal-body ol { margin: 0 0 12px; padding-left: 20px; }
      #nw-modal-footer { padding: 0 24px 24px; display: flex; align-items: center; gap: 16px; flex-wrap: wrap; }
      #nw-modal-time { font-size: 12px; color: #bbb; flex: 1; }

      /* ── Fullscreen overlay ── */
      #nw-fullscreen {
        position: fixed; inset: 0; background: rgba(26,26,46,0.88);
        backdrop-filter: blur(6px); -webkit-backdrop-filter: blur(6px);
        z-index: 100000; display: none; align-items: center; justify-content: center;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; padding: 20px;
      }
      #nw-fullscreen.nw-open { display: flex; }
      #nw-fullscreen-card {
        background: #fff; border-radius: 20px; max-width: 660px; width: 100%;
        max-height: calc(100vh - 60px); overflow-y: auto;
        box-shadow: 0 32px 80px rgba(0,0,0,0.35); display: flex; flex-direction: column;
      }
      #nw-fullscreen-top {
        background: linear-gradient(135deg, #335075 0%, #1a1a2e 100%);
        padding: 28px 32px 24px; border-radius: 20px 20px 0 0; position: relative;
      }
      #nw-fullscreen-cat {
        display: inline-block; background: rgba(255,255,255,0.2); color: #fff;
        font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 1px;
        padding: 4px 10px; border-radius: 20px; margin-bottom: 12px;
      }
      #nw-fullscreen-title { margin: 0; font-size: 22px; font-weight: 700; color: #fff; line-height: 1.3; padding-right: 36px; }
      #nw-fullscreen-close {
        position: absolute; top: 16px; right: 16px;
        background: rgba(255,255,255,0.15); border: none; border-radius: 50%;
        width: 32px; height: 32px; cursor: pointer; font-size: 16px; color: #fff;
        display: flex; align-items: center; justify-content: center; transition: background 0.2s;
      }
      #nw-fullscreen-close:hover { background: rgba(255,255,255,0.28); }
      #nw-fullscreen-body { padding: 24px 32px; color: #333; font-size: 15px; line-height: 1.7; flex: 1; }
      #nw-fullscreen-body img { max-width: 100%; border-radius: 8px; margin: 8px 0; display: block; }
      #nw-fullscreen-body a { color: #335075; }
      #nw-fullscreen-body p { margin: 0 0 12px; }
      #nw-fullscreen-body h1, #nw-fullscreen-body h2, #nw-fullscreen-body h3 { margin: 16px 0 8px; color: #1a1a2e; }
      #nw-fullscreen-body ul, #nw-fullscreen-body ol { margin: 0 0 12px; padding-left: 20px; }
      #nw-fullscreen-footer { padding: 8px 32px 28px; display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
      #nw-fullscreen-time { font-size: 12px; color: #bbb; flex: 1; }

      /* ── CTA button ── */
      .nw-cta-btn {
        display: inline-flex; align-items: center; justify-content: center;
        background: #335075; color: #fff !important; font-size: 14px; font-weight: 600;
        padding: 10px 22px; border-radius: 8px; text-decoration: none !important;
        transition: background 0.15s; font-family: -apple-system, sans-serif; cursor: pointer; border: none;
      }
      .nw-cta-btn:hover { background: #2a4163; }

      /* ── Toast ── */
      #nw-toast {
        position: fixed; bottom: 28px; right: 28px; width: 380px;
        background: #fff; border-radius: 14px; box-shadow: 0 12px 36px rgba(0,0,0,0.16);
        z-index: 99999; padding: 20px 20px 18px; border-left: 5px solid #335075;
        cursor: pointer; display: none;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      }
      #nw-toast.nw-show { display: block; animation: nw-slidein 0.32s cubic-bezier(0.22,1,0.36,1); }
      @keyframes nw-slidein {
        from { transform: translateY(20px); opacity: 0; }
        to   { transform: translateY(0);    opacity: 1; }
      }
      #nw-toast-close {
        position: absolute; top: 12px; right: 14px;
        background: #f3f4f6; border: none; border-radius: 50%; cursor: pointer;
        font-size: 14px; color: #6b7280; width: 26px; height: 26px;
        display: flex; align-items: center; justify-content: center; padding: 0;
      }
      #nw-toast-close:hover { background: #e5e7eb; color: #374151; }
      #nw-toast-label {
        font-size: 11px; font-weight: 700; text-transform: uppercase;
        letter-spacing: 0.8px; color: #335075; margin-bottom: 8px; padding-right: 32px;
      }
      #nw-toast-cat {
        display: inline-block; font-size: 10px; font-weight: 700; padding: 2px 7px;
        border-radius: 4px; color: #fff; margin-bottom: 6px; text-transform: uppercase; letter-spacing: 0.3px;
      }
      #nw-toast-title { font-size: 15px; font-weight: 700; color: #1a1a2e; margin-bottom: 6px; padding-right: 32px; line-height: 1.3; }
      #nw-toast-preview { font-size: 13px; color: #6b7280; line-height: 1.5; display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
      #nw-toast-cta { margin-top: 14px; font-size: 13px; color: #335075; font-weight: 600; }
    `;
    var el = document.createElement('style');
    el.id = 'nw-styles'; el.textContent = css;
    document.head.appendChild(el);
  }

  // ─── Render Widget Shell ──────────────────────────────────────────────────────
  function _renderWidget() {
    var header = document.querySelector('.dashboard-header')
      || document.querySelector('.header')
      || document.querySelector('header');

    var bell = document.createElement('button');
    bell.id = 'nw-bell'; bell.title = 'Notifications';
    bell.innerHTML =
      '<svg viewBox="0 0 24 24"><path d="M12 22a2 2 0 0 0 2-2h-4a2 2 0 0 0 2 2zm6-6v-5c0-3.07-1.64-5.64-4.5-6.32V4a1.5 1.5 0 0 0-3 0v.68C7.63 5.36 6 7.92 6 11v5l-2 2v1h16v-1l-2-2z"/></svg>' +
      '<span id="nw-badge"></span>';

    if (header) {
      header.appendChild(bell);
    } else {
      bell.style.cssText = 'position:fixed;top:12px;right:16px;z-index:9999;';
      document.body.appendChild(bell);
    }

    // Panel
    var panel = document.createElement('div');
    panel.id = 'nw-panel';
    panel.innerHTML =
      '<div id="nw-panel-hd"><h3>What\'s new</h3><button id="nw-mark-all">Mark all read</button></div>' +
      '<div id="nw-cat-filter"></div>' +
      '<div id="nw-list"></div>';
    document.body.appendChild(panel);

    // Reading modal
    var overlay = document.createElement('div');
    overlay.id = 'nw-overlay';
    overlay.innerHTML =
      '<div id="nw-modal">' +
        '<div id="nw-modal-hd">' +
          '<div id="nw-modal-hd-left"><div id="nw-modal-cat"></div><h2 id="nw-modal-title"></h2></div>' +
          '<button id="nw-modal-close">&#x2715;</button>' +
        '</div>' +
        '<div id="nw-modal-body"></div>' +
        '<div id="nw-modal-footer"><span id="nw-modal-time"></span></div>' +
      '</div>';
    document.body.appendChild(overlay);

    // Fullscreen overlay
    var fullscreen = document.createElement('div');
    fullscreen.id = 'nw-fullscreen';
    fullscreen.innerHTML =
      '<div id="nw-fullscreen-card">' +
        '<div id="nw-fullscreen-top">' +
          '<div id="nw-fullscreen-cat"></div>' +
          '<h2 id="nw-fullscreen-title"></h2>' +
          '<button id="nw-fullscreen-close">&#x2715;</button>' +
        '</div>' +
        '<div id="nw-fullscreen-body"></div>' +
        '<div id="nw-fullscreen-footer"><span id="nw-fullscreen-time"></span></div>' +
      '</div>';
    document.body.appendChild(fullscreen);

    // Toast
    var toast = document.createElement('div');
    toast.id = 'nw-toast';
    toast.innerHTML =
      '<button id="nw-toast-close">&#x2715;</button>' +
      '<div id="nw-toast-label">What\'s new</div>' +
      '<div id="nw-toast-cat" style="display:none"></div>' +
      '<div id="nw-toast-title"></div>' +
      '<div id="nw-toast-preview"></div>' +
      '<div id="nw-toast-cta">Click to read &rarr;</div>';
    document.body.appendChild(toast);

    _bindEvents();
  }

  // ─── Events ──────────────────────────────────────────────────────────────────
  function _bindEvents() {
    var bell       = document.getElementById('nw-bell');
    var panel      = document.getElementById('nw-panel');
    var overlay    = document.getElementById('nw-overlay');
    var fullscreen = document.getElementById('nw-fullscreen');
    var toast      = document.getElementById('nw-toast');

    bell.addEventListener('click', function (e) { e.stopPropagation(); panel.classList.toggle('nw-open'); });
    document.addEventListener('click', function (e) {
      if (!panel.contains(e.target) && e.target !== bell) panel.classList.remove('nw-open');
    });
    document.getElementById('nw-mark-all').addEventListener('click', function (e) { e.stopPropagation(); _markAllAsRead(); });
    document.getElementById('nw-modal-close').addEventListener('click', function () { overlay.classList.remove('nw-open'); });
    overlay.addEventListener('click', function (e) { if (e.target === overlay) overlay.classList.remove('nw-open'); });
    document.getElementById('nw-fullscreen-close').addEventListener('click', function () { fullscreen.classList.remove('nw-open'); });
    fullscreen.addEventListener('click', function (e) { if (e.target === fullscreen) fullscreen.classList.remove('nw-open'); });
    document.getElementById('nw-toast-close').addEventListener('click', function (e) { e.stopPropagation(); toast.classList.remove('nw-show'); });
    toast.addEventListener('click', function () {
      var id = toast.dataset.nwId;
      var n = _notifications.find(function (x) { return x.id === id; });
      if (n) { toast.classList.remove('nw-show'); _openModal(n); }
    });
  }

  // ─── Category Filter ──────────────────────────────────────────────────────────
  function _renderCategoryFilter() {
    var wrap = document.getElementById('nw-cat-filter');
    if (!wrap) return;

    // Find which categories actually appear in current notifications
    var usedCats = {};
    _notifications.forEach(function (n) { if (n.category) usedCats[n.category] = true; });
    var cats = Object.keys(usedCats);

    if (cats.length === 0) { wrap.style.display = 'none'; return; }
    wrap.style.display = 'flex';

    var html = '<button class="nw-cat-chip' + (_activeCategory === 'all' ? ' nw-active' : '') +
      '" data-cat="all" style="' + (_activeCategory === 'all' ? 'background:#335075;border-color:#335075;' : '') + '">All</button>';

    cats.forEach(function (cat) {
      var def = CATEGORIES[cat] || { label: cat, color: '#6b7280' };
      var isActive = _activeCategory === cat;
      html += '<button class="nw-cat-chip' + (isActive ? ' nw-active' : '') + '" data-cat="' + cat + '" ' +
        'style="' + (isActive ? 'background:' + def.color + ';border-color:' + def.color + ';' : '') + '">' +
        def.label + '</button>';
    });

    wrap.innerHTML = html;
    wrap.querySelectorAll('.nw-cat-chip').forEach(function (btn) {
      btn.addEventListener('click', function (e) {
        e.stopPropagation();
        _activeCategory = btn.dataset.cat;
        _renderCategoryFilter();
        _renderNotifications();
      });
    });
  }

  // ─── Render Notification List ─────────────────────────────────────────────────
  function _renderNotifications() {
    var list = document.getElementById('nw-list');
    if (!list) return;

    var visible = _activeCategory === 'all'
      ? _notifications
      : _notifications.filter(function (n) { return n.category === _activeCategory; });

    if (visible.length === 0) {
      var isFiltered = _activeCategory !== 'all';
      list.innerHTML =
        '<div id="nw-empty">' +
          '<svg viewBox="0 0 24 24" fill="#1a1a2e"><path d="M12 22a2 2 0 0 0 2-2h-4a2 2 0 0 0 2 2zm6-6v-5c0-3.07-1.64-5.64-4.5-6.32V4a1.5 1.5 0 0 0-3 0v.68C7.63 5.36 6 7.92 6 11v5l-2 2v1h16v-1l-2-2z"/></svg>' +
          '<div id="nw-empty-title">' + (isFiltered ? 'No notifications here' : 'You\'re all caught up!') + '</div>' +
          '<div id="nw-empty-sub">' + (isFiltered ? 'Try a different category' : 'New updates will appear here') + '</div>' +
        '</div>';
      return;
    }

    var now = new Date();
    list.innerHTML = visible.map(function (n) {
      var unread   = !_readIds.has(n.id);
      var preview  = _strip(n.body || '').slice(0, 90);
      var catDef   = n.category && CATEGORIES[n.category];
      var isNew    = unread && n.scheduledFor && (now - _toDate(n.scheduledFor)) < 48 * 3600000;

      var catHtml = catDef
        ? '<div class="nw-cat-label" style="background:' + catDef.color + '">' + catDef.label + '</div>'
        : '';
      var newHtml = isNew ? '<span class="nw-new-badge">NEW</span>' : '';

      return (
        '<div class="nw-item' + (unread ? ' nw-unread' : '') + '" data-id="' + n.id + '">' +
          '<div class="nw-dot"></div>' +
          '<div class="nw-content">' +
            catHtml +
            '<div class="nw-item-top"><div class="nw-title">' + _esc(n.title || 'Notification') + '</div>' + newHtml + '</div>' +
            '<div class="nw-preview">' + _esc(preview) + '</div>' +
          '</div>' +
          '<div class="nw-time">' + _relTime(n.scheduledFor) + '</div>' +
        '</div>'
      );
    }).join('');

    list.querySelectorAll('.nw-item').forEach(function (el) {
      el.addEventListener('click', function () {
        var n = _notifications.find(function (x) { return x.id === el.dataset.id; });
        if (n) _openModal(n);
      });
    });
  }

  // ─── Open Reading Modal ───────────────────────────────────────────────────────
  function _openModal(n) {
    _markAsRead(n.id);
    document.getElementById('nw-panel').classList.remove('nw-open');

    var catDef = n.category && CATEGORIES[n.category];
    var catEl  = document.getElementById('nw-modal-cat');
    if (catDef) {
      catEl.textContent = catDef.label;
      catEl.style.cssText = 'display:inline-block;background:' + catDef.color + ';color:#fff;font-size:11px;font-weight:600;padding:2px 8px;border-radius:4px;margin-bottom:6px;';
    } else {
      catEl.style.display = 'none';
    }

    document.getElementById('nw-modal-title').textContent = n.title || '';
    document.getElementById('nw-modal-body').innerHTML = n.body || '';
    document.getElementById('nw-modal-time').textContent = _absTime(n.scheduledFor);

    var footer = document.getElementById('nw-modal-footer');
    var existing = footer.querySelector('.nw-cta-btn');
    if (existing) existing.remove();
    if (n.ctaText && n.ctaUrl) {
      var btn = document.createElement('a');
      btn.className = 'nw-cta-btn'; btn.href = n.ctaUrl;
      btn.target = '_blank'; btn.rel = 'noopener noreferrer';
      btn.textContent = n.ctaText;
      footer.appendChild(btn);
    }

    document.getElementById('nw-overlay').classList.add('nw-open');
  }

  // ─── Fullscreen ───────────────────────────────────────────────────────────────
  function _showFullscreen(n) {
    _markAsRead(n.id);

    var catDef = n.category && CATEGORIES[n.category];
    var catEl  = document.getElementById('nw-fullscreen-cat');
    catEl.textContent = catDef ? catDef.label : 'What\'s new';

    document.getElementById('nw-fullscreen-title').textContent = n.title || '';
    document.getElementById('nw-fullscreen-body').innerHTML = n.body || '';
    document.getElementById('nw-fullscreen-time').textContent = _absTime(n.scheduledFor);

    var footer = document.getElementById('nw-fullscreen-footer');
    var existing = footer.querySelector('.nw-cta-btn');
    if (existing) existing.remove();
    if (n.ctaText && n.ctaUrl) {
      var btn = document.createElement('a');
      btn.className = 'nw-cta-btn'; btn.href = n.ctaUrl;
      btn.target = '_blank'; btn.rel = 'noopener noreferrer';
      btn.textContent = n.ctaText;
      footer.appendChild(btn);
    }

    document.getElementById('nw-fullscreen').classList.add('nw-open');
  }

  // ─── Toast ────────────────────────────────────────────────────────────────────
  function _showToast(n) {
    var toast = document.getElementById('nw-toast');
    if (!toast) return;
    toast.dataset.nwId = n.id;

    var catDef = n.category && CATEGORIES[n.category];
    var catEl  = document.getElementById('nw-toast-cat');
    if (catDef) {
      catEl.textContent = catDef.label;
      catEl.style.cssText = 'display:inline-block;background:' + catDef.color + ';';
    } else {
      catEl.style.display = 'none';
    }

    document.getElementById('nw-toast-title').textContent = n.title || 'New notification';
    document.getElementById('nw-toast-preview').textContent = _strip(n.body || '').slice(0, 100);
    toast.classList.add('nw-show');
  }

  function _updateBadge() {
    var badge = document.getElementById('nw-badge');
    if (!badge) return;
    var c = _unreadCount();
    badge.textContent = c > 9 ? '9+' : String(c);
    badge.style.display = c > 0 ? 'flex' : 'none';
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────────
  function _strip(html) { var d = document.createElement('div'); d.innerHTML = html; return d.textContent || d.innerText || ''; }
  function _esc(str) { var d = document.createElement('div'); d.appendChild(document.createTextNode(str)); return d.innerHTML; }
  function _toDate(ts) { if (!ts) return new Date(0); return ts.toDate ? ts.toDate() : new Date(ts); }
  function _relTime(ts) {
    var d = _toDate(ts), now = new Date(), diff = now - d;
    if (diff < 60000) return 'Just now';
    if (diff < 3600000) return Math.floor(diff / 60000) + 'm ago';
    if (diff < 86400000) return Math.floor(diff / 3600000) + 'h ago';
    if (diff < 604800000) return Math.floor(diff / 86400000) + 'd ago';
    return d.toLocaleDateString();
  }
  function _absTime(ts) {
    return _toDate(ts).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  }

  // ─── Export ───────────────────────────────────────────────────────────────────
  window.NotifWidget = { init: init };

}(window, document));
