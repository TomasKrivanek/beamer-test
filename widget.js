/**
 * Notification Widget
 * Embed on any page with:
 *
 *   <script src="https://tomaskrivanek.github.io/beamer-test/widget.js"></script>
 *   <script>
 *     NotifWidget.init({
 *       userId: 'user-123',        // unique ID for this user (for read tracking)
 *       role: 'admin',             // optional: user role for targeting
 *       buildingType: 'hotel'      // optional: building type for targeting
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

  // ─── State ──────────────────────────────────────────────────────────────────
  var _config = {};
  var _allPublished = [];
  var _notifications = [];
  var _readIds = new Set();
  var _db = null;
  var _knownIds = null;

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
    s.src = src;
    s.onload = cb;
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
      }, function (err) {
        console.error('[NotifWidget] Firestore error:', err);
      });
  }

  function _applyFilters() {
    var now = new Date();
    var filtered = _allPublished.filter(function (n) {
      var t = n.scheduledFor && n.scheduledFor.toDate ? n.scheduledFor.toDate() : new Date(n.scheduledFor || 0);
      return t <= now && _matchesUser(n);
    });
    filtered.sort(function (a, b) {
      var ta = a.scheduledFor && a.scheduledFor.toDate ? a.scheduledFor.toDate() : new Date(a.scheduledFor || 0);
      var tb = b.scheduledFor && b.scheduledFor.toDate ? b.scheduledFor.toDate() : new Date(b.scheduledFor || 0);
      return tb - ta;
    });
    _notifications = filtered;
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
    _updateBadge();
    _renderNotifications();
  }

  function _markAllAsRead() {
    _notifications.forEach(function (n) { _readIds.add(n.id); });
    _saveReadState();
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
      // First load: show first unread notification according to its display mode
      var firstUnread = _notifications.find(function (n) { return !_readIds.has(n.id); });
      if (firstUnread) {
        setTimeout(function () { _triggerDisplay(firstUnread); }, 1200);
      }
    } else {
      _notifications.forEach(function (n) {
        if (!_knownIds.has(n.id) && !_readIds.has(n.id)) _triggerDisplay(n);
      });
    }
    _knownIds = currentIds;
  }

  /**
   * Trigger the display mode for a notification:
   *   badge      → silent, just the badge number
   *   toast      → bottom-right slide-in toast (default)
   *   fullscreen → full-screen overlay shown immediately
   */
  function _triggerDisplay(n) {
    var mode = n.displayMode || 'toast';
    if (mode === 'badge') {
      // Nothing extra — badge already updated
    } else if (mode === 'fullscreen') {
      _showFullscreen(n);
    } else {
      _showToast(n);
    }
  }

  // ─── Styles ──────────────────────────────────────────────────────────────────
  function _injectStyles() {
    if (document.getElementById('nw-styles')) return;
    var css = `
      /* ── Bell ── */
      #nw-bell {
        position: relative;
        background: #335075;
        border: none;
        cursor: pointer;
        padding: 8px 10px;
        border-radius: 8px;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        transition: background 0.2s;
        margin-left: 12px;
        vertical-align: middle;
        box-shadow: 0 2px 6px rgba(0,0,0,0.18);
      }
      #nw-bell:hover { background: #2a4163; }
      #nw-bell svg { width: 20px; height: 20px; fill: #ffffff; display: block; }
      #nw-badge {
        position: absolute;
        top: -5px;
        right: -5px;
        background: #e74c3c;
        color: #fff;
        font: bold 10px/16px -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
        min-width: 16px;
        height: 16px;
        border-radius: 8px;
        display: none;
        align-items: center;
        justify-content: center;
        padding: 0 3px;
        border: 2px solid #fff;
        box-sizing: content-box;
      }

      /* ── Notification panel ── */
      #nw-panel {
        position: fixed;
        top: 62px;
        right: 16px;
        width: 360px;
        max-height: 500px;
        background: #fff;
        border-radius: 12px;
        box-shadow: 0 8px 32px rgba(0,0,0,0.16);
        z-index: 99998;
        display: none;
        flex-direction: column;
        overflow: hidden;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
        border: 1px solid rgba(0,0,0,0.08);
      }
      #nw-panel.nw-open { display: flex; }
      #nw-panel-hd {
        padding: 14px 18px;
        border-bottom: 1px solid #f0f0f0;
        display: flex;
        align-items: center;
        justify-content: space-between;
        background: #fafafa;
      }
      #nw-panel-hd h3 { margin: 0; font-size: 14px; font-weight: 700; color: #1a1a2e; }
      #nw-mark-all {
        background: none;
        border: none;
        cursor: pointer;
        font-size: 12px;
        color: #335075;
        font-weight: 500;
        padding: 4px 8px;
        border-radius: 4px;
        font-family: inherit;
      }
      #nw-mark-all:hover { background: #eef2f7; }
      #nw-list { overflow-y: auto; flex: 1; }
      #nw-empty {
        padding: 36px 20px;
        text-align: center;
        color: #bbb;
        font-size: 13px;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      }

      /* ── Notification items ── */
      .nw-item {
        padding: 12px 18px;
        border-bottom: 1px solid #f5f5f5;
        cursor: pointer;
        display: flex;
        gap: 10px;
        align-items: flex-start;
        transition: background 0.12s;
      }
      .nw-item:last-child { border-bottom: none; }
      .nw-item:hover { background: #f8f9fb; }
      .nw-item.nw-unread { background: #f0f5ff; }
      .nw-item.nw-unread:hover { background: #e8f0fe; }
      .nw-dot {
        width: 8px;
        height: 8px;
        border-radius: 50%;
        background: #335075;
        margin-top: 5px;
        flex-shrink: 0;
        opacity: 0;
      }
      .nw-item.nw-unread .nw-dot { opacity: 1; }
      .nw-content { flex: 1; min-width: 0; }
      .nw-title {
        font-size: 13px;
        font-weight: 600;
        color: #1a1a2e;
        margin-bottom: 2px;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .nw-preview {
        font-size: 12px;
        color: #777;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .nw-time { font-size: 11px; color: #bbb; white-space: nowrap; flex-shrink: 0; }

      /* ── Reading modal (opened from list) ── */
      #nw-overlay {
        position: fixed;
        inset: 0;
        background: rgba(0,0,0,0.48);
        z-index: 99999;
        display: none;
        align-items: center;
        justify-content: center;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      }
      #nw-overlay.nw-open { display: flex; }
      #nw-modal {
        background: #fff;
        border-radius: 16px;
        max-width: 620px;
        width: calc(100% - 32px);
        max-height: calc(100vh - 64px);
        overflow-y: auto;
        box-shadow: 0 20px 60px rgba(0,0,0,0.22);
        display: flex;
        flex-direction: column;
      }
      #nw-modal-hd {
        padding: 20px 24px 16px;
        border-bottom: 1px solid #f0f0f0;
        display: flex;
        align-items: flex-start;
        gap: 12px;
      }
      #nw-modal-title {
        flex: 1;
        margin: 0;
        font-size: 18px;
        font-weight: 700;
        color: #1a1a2e;
        line-height: 1.3;
      }
      #nw-modal-close {
        background: none;
        border: none;
        cursor: pointer;
        font-size: 18px;
        color: #bbb;
        padding: 2px;
        line-height: 1;
        flex-shrink: 0;
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

      /* ── Fullscreen announcement overlay ── */
      #nw-fullscreen {
        position: fixed;
        inset: 0;
        background: rgba(26, 26, 46, 0.88);
        backdrop-filter: blur(6px);
        -webkit-backdrop-filter: blur(6px);
        z-index: 100000;
        display: none;
        align-items: center;
        justify-content: center;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
        padding: 20px;
      }
      #nw-fullscreen.nw-open { display: flex; }
      #nw-fullscreen-card {
        background: #fff;
        border-radius: 20px;
        max-width: 660px;
        width: 100%;
        max-height: calc(100vh - 60px);
        overflow-y: auto;
        box-shadow: 0 32px 80px rgba(0,0,0,0.35);
        display: flex;
        flex-direction: column;
      }
      #nw-fullscreen-top {
        background: linear-gradient(135deg, #335075 0%, #1a1a2e 100%);
        padding: 28px 32px 24px;
        border-radius: 20px 20px 0 0;
        position: relative;
      }
      #nw-fullscreen-label {
        display: inline-block;
        background: rgba(255,255,255,0.2);
        color: #fff;
        font-size: 11px;
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: 1px;
        padding: 4px 10px;
        border-radius: 20px;
        margin-bottom: 12px;
      }
      #nw-fullscreen-title {
        margin: 0;
        font-size: 22px;
        font-weight: 700;
        color: #fff;
        line-height: 1.3;
        padding-right: 36px;
      }
      #nw-fullscreen-close {
        position: absolute;
        top: 16px;
        right: 16px;
        background: rgba(255,255,255,0.15);
        border: none;
        border-radius: 50%;
        width: 32px;
        height: 32px;
        cursor: pointer;
        font-size: 16px;
        color: #fff;
        display: flex;
        align-items: center;
        justify-content: center;
        transition: background 0.2s;
      }
      #nw-fullscreen-close:hover { background: rgba(255,255,255,0.28); }
      #nw-fullscreen-body {
        padding: 24px 32px;
        color: #333;
        font-size: 15px;
        line-height: 1.7;
        flex: 1;
      }
      #nw-fullscreen-body img { max-width: 100%; border-radius: 8px; margin: 8px 0; display: block; }
      #nw-fullscreen-body a { color: #335075; }
      #nw-fullscreen-body p { margin: 0 0 12px; }
      #nw-fullscreen-body h1, #nw-fullscreen-body h2, #nw-fullscreen-body h3 { margin: 16px 0 8px; color: #1a1a2e; }
      #nw-fullscreen-body ul, #nw-fullscreen-body ol { margin: 0 0 12px; padding-left: 20px; }
      #nw-fullscreen-footer {
        padding: 8px 32px 28px;
        display: flex;
        align-items: center;
        gap: 12px;
        flex-wrap: wrap;
      }
      #nw-fullscreen-time { font-size: 12px; color: #bbb; flex: 1; }

      /* ── CTA button (used in both modal and fullscreen) ── */
      .nw-cta-btn {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        background: #335075;
        color: #fff !important;
        font-size: 14px;
        font-weight: 600;
        padding: 10px 22px;
        border-radius: 8px;
        text-decoration: none !important;
        transition: background 0.15s;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
        cursor: pointer;
        border: none;
      }
      .nw-cta-btn:hover { background: #2a4163; }

      /* ── Toast ── */
      #nw-toast {
        position: fixed;
        bottom: 24px;
        right: 24px;
        width: 320px;
        background: #fff;
        border-radius: 12px;
        box-shadow: 0 8px 28px rgba(0,0,0,0.14);
        z-index: 99999;
        padding: 14px 16px;
        border-left: 4px solid #335075;
        cursor: pointer;
        display: none;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      }
      #nw-toast.nw-show {
        display: block;
        animation: nw-slidein 0.28s cubic-bezier(0.22, 1, 0.36, 1);
      }
      @keyframes nw-slidein {
        from { transform: translateY(16px); opacity: 0; }
        to   { transform: translateY(0);    opacity: 1; }
      }
      #nw-toast-close {
        position: absolute;
        top: 8px;
        right: 10px;
        background: none;
        border: none;
        cursor: pointer;
        font-size: 15px;
        color: #ccc;
        line-height: 1;
        padding: 0;
      }
      #nw-toast-close:hover { color: #888; }
      #nw-toast-title { font-size: 13px; font-weight: 600; color: #1a1a2e; margin-bottom: 3px; padding-right: 18px; }
      #nw-toast-preview { font-size: 12px; color: #777; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
      #nw-toast-cta { margin-top: 8px; font-size: 11px; color: #335075; font-weight: 500; }
    `;
    var el = document.createElement('style');
    el.id = 'nw-styles';
    el.textContent = css;
    document.head.appendChild(el);
  }

  // ─── Render Widget Shell ──────────────────────────────────────────────────────
  function _renderWidget() {
    var header = document.querySelector('.dashboard-header')
      || document.querySelector('.header')
      || document.querySelector('header');

    // Bell button
    var bell = document.createElement('button');
    bell.id = 'nw-bell';
    bell.title = 'Notifications';
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
      '<div id="nw-panel-hd">' +
        '<h3>What\'s new</h3>' +
        '<button id="nw-mark-all">Mark all read</button>' +
      '</div>' +
      '<div id="nw-list"><div id="nw-empty">No notifications yet</div></div>';
    document.body.appendChild(panel);

    // Reading modal (opened from notification list)
    var overlay = document.createElement('div');
    overlay.id = 'nw-overlay';
    overlay.innerHTML =
      '<div id="nw-modal">' +
        '<div id="nw-modal-hd"><h2 id="nw-modal-title"></h2><button id="nw-modal-close">&#x2715;</button></div>' +
        '<div id="nw-modal-body"></div>' +
        '<div id="nw-modal-footer"><span id="nw-modal-time"></span></div>' +
      '</div>';
    document.body.appendChild(overlay);

    // Fullscreen announcement overlay
    var fullscreen = document.createElement('div');
    fullscreen.id = 'nw-fullscreen';
    fullscreen.innerHTML =
      '<div id="nw-fullscreen-card">' +
        '<div id="nw-fullscreen-top">' +
          '<div id="nw-fullscreen-label">What\'s new</div>' +
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
      '<div id="nw-toast-title"></div>' +
      '<div id="nw-toast-preview"></div>' +
      '<div id="nw-toast-cta">Click to read &rarr;</div>';
    document.body.appendChild(toast);

    _bindEvents();
  }

  // ─── Events ──────────────────────────────────────────────────────────────────
  function _bindEvents() {
    var bell      = document.getElementById('nw-bell');
    var panel     = document.getElementById('nw-panel');
    var overlay   = document.getElementById('nw-overlay');
    var fullscreen = document.getElementById('nw-fullscreen');
    var toast     = document.getElementById('nw-toast');

    // Bell toggle
    bell.addEventListener('click', function (e) {
      e.stopPropagation();
      panel.classList.toggle('nw-open');
    });
    document.addEventListener('click', function (e) {
      if (!panel.contains(e.target) && e.target !== bell) panel.classList.remove('nw-open');
    });

    // Mark all read
    document.getElementById('nw-mark-all').addEventListener('click', function (e) {
      e.stopPropagation();
      _markAllAsRead();
    });

    // Reading modal close
    document.getElementById('nw-modal-close').addEventListener('click', function () {
      overlay.classList.remove('nw-open');
    });
    overlay.addEventListener('click', function (e) {
      if (e.target === overlay) overlay.classList.remove('nw-open');
    });

    // Fullscreen close
    document.getElementById('nw-fullscreen-close').addEventListener('click', function () {
      fullscreen.classList.remove('nw-open');
    });
    fullscreen.addEventListener('click', function (e) {
      if (e.target === fullscreen) fullscreen.classList.remove('nw-open');
    });

    // Toast
    document.getElementById('nw-toast-close').addEventListener('click', function (e) {
      e.stopPropagation();
      toast.classList.remove('nw-show');
    });
    toast.addEventListener('click', function () {
      var id = toast.dataset.nwId;
      var n = _notifications.find(function (x) { return x.id === id; });
      if (n) { toast.classList.remove('nw-show'); _openModal(n); }
    });
  }

  // ─── Render Notification List ─────────────────────────────────────────────────
  function _renderNotifications() {
    var list = document.getElementById('nw-list');
    if (!list) return;

    if (_notifications.length === 0) {
      list.innerHTML = '<div id="nw-empty">No notifications yet</div>';
      return;
    }

    list.innerHTML = _notifications.map(function (n) {
      var unread = !_readIds.has(n.id);
      var preview = _strip(n.body || '').slice(0, 90);
      return (
        '<div class="nw-item' + (unread ? ' nw-unread' : '') + '" data-id="' + n.id + '">' +
          '<div class="nw-dot"></div>' +
          '<div class="nw-content">' +
            '<div class="nw-title">' + _esc(n.title || 'Notification') + '</div>' +
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

    document.getElementById('nw-modal-title').textContent = n.title || '';
    document.getElementById('nw-modal-body').innerHTML = n.body || '';
    document.getElementById('nw-modal-time').textContent = _absTime(n.scheduledFor);

    // CTA button
    var footer = document.getElementById('nw-modal-footer');
    var existing = footer.querySelector('.nw-cta-btn');
    if (existing) existing.remove();
    if (n.ctaText && n.ctaUrl) {
      var btn = document.createElement('a');
      btn.className = 'nw-cta-btn';
      btn.href = n.ctaUrl;
      btn.target = '_blank';
      btn.rel = 'noopener noreferrer';
      btn.textContent = n.ctaText;
      footer.appendChild(btn);
    }

    document.getElementById('nw-overlay').classList.add('nw-open');
  }

  // ─── Fullscreen Overlay ───────────────────────────────────────────────────────
  function _showFullscreen(n) {
    _markAsRead(n.id);

    document.getElementById('nw-fullscreen-title').textContent = n.title || '';
    document.getElementById('nw-fullscreen-body').innerHTML = n.body || '';
    document.getElementById('nw-fullscreen-time').textContent = _absTime(n.scheduledFor);

    // CTA button
    var footer = document.getElementById('nw-fullscreen-footer');
    var existing = footer.querySelector('.nw-cta-btn');
    if (existing) existing.remove();
    if (n.ctaText && n.ctaUrl) {
      var btn = document.createElement('a');
      btn.className = 'nw-cta-btn';
      btn.href = n.ctaUrl;
      btn.target = '_blank';
      btn.rel = 'noopener noreferrer';
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
    document.getElementById('nw-toast-title').textContent = n.title || 'New notification';
    document.getElementById('nw-toast-preview').textContent = _strip(n.body || '').slice(0, 100);
    toast.classList.add('nw-show');
    setTimeout(function () { toast.classList.remove('nw-show'); }, 9000);
  }

  function _updateBadge() {
    var badge = document.getElementById('nw-badge');
    if (!badge) return;
    var c = _unreadCount();
    badge.textContent = c > 9 ? '9+' : String(c);
    badge.style.display = c > 0 ? 'flex' : 'none';
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────────
  function _strip(html) {
    var d = document.createElement('div');
    d.innerHTML = html;
    return d.textContent || d.innerText || '';
  }

  function _esc(str) {
    var d = document.createElement('div');
    d.appendChild(document.createTextNode(str));
    return d.innerHTML;
  }

  function _toDate(ts) {
    if (!ts) return new Date(0);
    return ts.toDate ? ts.toDate() : new Date(ts);
  }

  function _relTime(ts) {
    var d = _toDate(ts), now = new Date(), diff = now - d;
    if (diff < 60000) return 'Just now';
    if (diff < 3600000) return Math.floor(diff / 60000) + 'm ago';
    if (diff < 86400000) return Math.floor(diff / 3600000) + 'h ago';
    if (diff < 604800000) return Math.floor(diff / 86400000) + 'd ago';
    return d.toLocaleDateString();
  }

  function _absTime(ts) {
    var d = _toDate(ts);
    return d.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  }

  // ─── Export ───────────────────────────────────────────────────────────────────
  window.NotifWidget = { init: init };

}(window, document));
