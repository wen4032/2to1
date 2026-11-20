(function () {
  'use strict';

  if (window.__TRACK_STORAGE_PREFIXED__) return;
  window.__TRACK_STORAGE_PREFIXED__ = true;
  document.documentElement.className += ' track-mode';

  var PREFIX = 'track_team__';
  var APP_KEY = /^(?:pe_|ws_did_v1$|ws_last_ping_v1$)/;
  var proto = window.Storage && window.Storage.prototype;
  if (!proto) return;

  var rawGet = proto.getItem;
  var rawSet = proto.setItem;
  var rawRemove = proto.removeItem;

  function scoped(key) {
    key = String(key);
    return APP_KEY.test(key) ? PREFIX + key : key;
  }

  proto.getItem = function (key) {
    return rawGet.call(this, scoped(key));
  };
  proto.setItem = function (key, value) {
    return rawSet.call(this, scoped(key), value);
  };
  proto.removeItem = function (key) {
    return rawRemove.call(this, scoped(key));
  };
})();
