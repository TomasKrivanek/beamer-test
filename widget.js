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
  var _allPublished = [];   // all published docs from Firestore
  var _notifications = [];  // filtered + time-eligible
  var _readIds = new Set();
  var _db = null;
  var _knownIds = null;     // null = first load not yet processed
  var _refilterInterval = null;

  // ─── Public API ─────────────────────────────────────────────────────────────
  function init(userConfig) {
    _config = Object.assign({ userId: 'anonymous', role: null, buildingType: null }, userConfig || {});
    _loadReadState();
    _injectStyles();
    _loadFirebase(function () {
      _renderWidget();
      _subscribeToNotifications();
      // Re-check every 60s in case a scheduled notification becomes due
      _refilterInterval = setInterval(_applyFilters, 60000);
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

  // ─── Read State (localStorage) ──────────────────────────────────────────────
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

  // ─── New Notification Detection ─────────────────────────────────────────────
  function _checkForNew() {
    var currentIds = new Set(_notifications.map(function (n) { return n.id; }));

    if (_knownIds === null) {
      // First load: toast the first unread notification
      var firstUnread = _notifications.find(function (n) { return !_readIds.has(n.id); });
      if (firstUnread) setTimeout(function () { _showToast(firstUnread); }, 1200);
    } else {
      // Subsequent updates: toast genuinely new notifications
      _notifications.forEach(function (n) {
        if (!_knownIds.has(n.id) && !_readIds.has(n.id)) _showToast(n);
      });
    }
    _knownIds = currentIds;
  }

  // ─── Styles ─────────────────────────────────────────────────────────────────
  function _injectStyles() {
    if (document.getElementById('nw-styles')) return;
    var css = `
      /* Bell */
      #nw-bell {
        position: relative; background: none; border: none; cursor: pointer;
        padding: 6px; border-radius: 8px; display: inline-flex;
        align-items: center; justify-content: center;
        transition: background 0.2s; margin-left: 12px; vertical-align: middle;
      }
      #nw-bell:hover { background: rgba(255,255,255,0.18); }
      #nw-bell svg { width: 22px; height: 22px; fill: #fff; display: block; }
      #nw-badge {
        position: absolute; top: 1px; right: 1px;
        background: #e74c3c; color: #fff;
        font: bold 10px/16px -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
        min-width: 16px; height: 16px; border-radius: 8px;
        display: none; align-items: center; justify-content: center; padding: 0 3px;
      }

      /* Panel */
      #nw-panel {
        position: fixed; top: 62px; right: 16px; width: 360px;
        max-height: 500px; background: #fff; border-radius: 12px;
        box-shadow: 0 8px 32px rgba(0,0,0,0.16); z-index: 99998;
        display: none; flex-direction: column; overflow: hidden;
        font-family: -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
      }
      #nw-panel.nw-open { display: flex; }
      #nw-panel-hd {
        padding: 14px 18px; border-bottom: 1px solid #f0f0f0;
        display: flex; align-items: center; justify-content: space-between;
      }
      #nw-panel-hd h3 { margin: 0; font-size: 14px; font-weight: 700; color: #1a1a2e; }
      #nw-mark-all {
        background: none; border: none; cursor: pointer; font-size: 12px;
        color: #335075; font-weight: 500; padding: 4px 8px; border-radius: 4px;
        font-family: inherit;
      }
      #nw-mark-all:hover { background: #f0f4f8; }
      #nw-list { overflow-y: auto; flex: 1; }
      #nw-empty {
        padding: 36px 20px; text-align: center; color: #aaa; font-size: 13px;
        font-family: -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
      }

      /* Notification items */
      .nw-item {
        padding: 12px 18px; border-bottom: 1px solid #f5f5f5; cursor: pointer;
        display: flex; gap: 10px; align-items: flex-start; transition: background 0.12s;
      }
      .nw-item:last-child { border-bottom: none; }
      .nw-item:hover { background: #f8f9fb; }
      .nw-item.nw-unread { background: #f0f5ff; }
      .nw-item.nw-unread:hover { background: #e8f0fe; }
      .nw-dot {
        width: 8px; height: 8px; border-radius: 50%; background: #335075;
        margin-top: 5px; flex-shrink: 0; opacity: 0; transition: opacity 0.2s;
      }
      .nw-item.nw-unread .nw-dot { opacity: 1; }
      .nw-content { flex: 1; min-width: 0; }
      .nw-title {
        font-size: 13px; font-weight: 600; color: #1a1a2e; margin-bottom: 2px;
        white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
      }
      .nw-preview {
        font-size: 12px; color: #777;
        white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
      }
      .nw-time { font-size: 11px; color: #bbb; white-space: nowrap; flex-shrink: 0; }

      /* Modal */
      #nw-overlay {
        position: fixed; inset: 0; background: rgba(0,0,0,0.48);
        z-index: 99999; display: none; align-items: center; justify-content: center;
        font-family: -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
      }
      #nw-overlay.nw-open { display: flex; }
      #nw-modal {
        background: #fff; border-radius: 16px;
        max-width: 620px; width: calc(100% - 32px);
        max-height: calc(100vh - 64px); overflow-y: auto;
        box-shadow: 0 20px 60px rgba(0,0,0,0.22); display: flex; flex-direction: column;
      }
      #nw-modal-hd {
        padding: 20px 24px 16px; border-bottom: 1px solid #f0f0f0;
        display: flex; align-items: flex-start; gap: 12px;
      }
      #nw-modal-title { flex: 1; margin: 0; font-size: 18px; font-weight: 700; color: #1a1a2e; line-height: 1.3; }
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
      #nw-modal-time { padding: 0 24px 18px; font-size: 12px; color: #bbb; }

      /* Toast */
      #nw-toast {
        position: fixed; bottom: 24px; right: 24px; width: 320px;
        background: #fff; border-radius: 12px; box-shadow: 0 8px 28px rgba(0,0,0,0.14);
        z-index: 99999; padding: 14px 16px; border-left: 4px solid #335075;
        cursor: pointer; display: none; font-family: -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
      }
      #nw-toast.nw-show {
        display: block;
        animation: nw-slidein 0.28s cubic-bezier(0.22,1,0.36,1);
      }
      @keyframes nw-slidein {
        from { transform: translateY(16px); opacity: 0; }
        to   { transform: translateY(0);    opacity: 1; }
      }
      #nw-toast-close {
        position: absolute; top: 8px; right: 10px;
        background: none; border: none; cursor: pointer;
        font-size: 15px; color: #ccc; line-height: 1; padding: 0;
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

  // ─── Render Widget Shell ─────────────────────────────────────────────────────
  function _renderWidget() {
    // Find header — try common selectors
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
      header.style.position = 'relative';
      header.appendChild(bell);
    } else {
      // Fallback: fixed position top-right
      bell.style.cssText = 'position:fixed;top:12px;right:16px;z-index:9999;background:#335075;border-radius:8px;';
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

    // Modal overlay
    var overlay = document.createElement('div');
    overlay.id = 'nw-overlay';
    overlay.innerHTML =
      '<div id="nw-modal">' +
        '<div id="nw-modal-hd"><h2 id="nw-modal-title"></h2><button id="nw-modal-close">&#x2715;</button></div>' +
        '<div id="nw-modal-body"></div>' +
        '<div id="nw-modal-time"></div>' +
      '</div>';
    document.body.appendChild(overlay);

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

  // ─── Events ─────────────────────────────────────────────────────────────────
  function _bindEvents() {
    var bell   = document.getElementById('nw-bell');
    var panel  = document.getElementById('nw-panel');
    var overlay = document.getElementById('nw-overlay');
    var toast  = document.getElementById('nw-toast');

    bell.addEventListener('click', function (e) {
      e.stopPropagation();
      panel.classList.toggle('nw-open');
    });

    document.addEventListener('click', function (e) {
      if (!panel.contains(e.target) && e.target !== bell) {
        panel.classList.remove('nw-open');
      }
    });

    document.getElementById('nw-mark-all').addEventListener('click', function (e) {
      e.stopPropagation();
      _markAllAsRead();
    });

    document.getElementById('nw-modal-close').addEventListener('click', function () {
      overlay.classList.remove('nw-open');
    });
    overlay.addEventListener('click', function (e) {
      if (e.target === overlay) overlay.classList.remove('nw-open');
    });

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

  // ─── Render Notification List ────────────────────────────────────────────────
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

  function _openModal(n) {
    _markAsRead(n.id);
    document.getElementById('nw-panel').classList.remove('nw-open');
    document.getElementById('nw-modal-title').textContent = n.title || '';
    document.getElementById('nw-modal-body').innerHTML = n.body || '';
    document.getElementById('nw-modal-time').textContent = _absTime(n.scheduledFor);
    document.getElementById('nw-overlay').classList.add('nw-open');
  }

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

  // ─── Helpers ─────────────────────────────────────────────────────────────────
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

  // ─── Export ──────────────────────────────────────────────────────────────────
  window.NotifWidget = { init: init };

}(window, document));
