/* 体测（国标）· 云端同步层
 *
 * 与田径队教练版共用同一个云端应用、同一个数据库，只是表不同（pe_class）。
 *
 * 三条原则（和田径队那边一致）：
 *   1. 本机优先 —— 录成绩永远先写本机，断网照常录。
 *   2. 只传变化 —— 一个班算一个指纹，没变的班不上传。
 *   3. 只标不删 —— 删除班级只把 del 置 true，云端永不物理删除。
 *
 * 首次接入（老师手机里已有旧数据）：
 *   云端空  → 本机所有班整体铺上去
 *   云端有  → 按班级名对接：同名的两班合成一班（学生按"学号→姓名"匹配，
 *             成绩取并集去重），两边都不丢；本机独有的班推上去。
 *
 * 冲突策略：
 *   本机那个班没改过 → 直接用云端的（删除才生效）
 *   本机那个班改过（还没推上去）→ 跟云端合并，绝不覆盖掉任何一条成绩
 */
(function (root) {
  'use strict';

  /* 允许 config.js 覆盖配置：本地沙盒会把 endpoint 指到不存在的地址，
     从而彻底切断云端，避免在预览时误操作线上真实数据。线上不覆盖，行为不变。 */
  var OV = root.WB_CLOUD_CONF || {};
  var CONF = {
    endpoint: OV.endpoint || 'https://coach-track-96873.app.workbuddy.host',
    oauthRelayBaseUrl: OV.oauthRelayBaseUrl || 'https://www.workbuddy.cn/v2/as/genie-baas/oauth',
    publishableKey: OV.publishableKey || 'wbpk_j0R8ZkmjTM8s3Dzwew2VJY_dCTiBrd5Wi8F8gkBoaWhymasKMWvNQON'
  };

  var TAB = 'pe_class';
  var K_META  = 'pe_sync_meta_v1';    // 班 id → { h: 上次同步的指纹, u: 云端版本时间 }
  var K_CUR   = 'pe_sync_cursor_v1';  // 增量拉取游标（服务器时间）
  var K_STAT  = 'pe_sync_stat_v1';    // 上次同步状态（给界面看）
  var K_DEV   = 'pe_sync_dev_v1';     // 本机设备号
  var K_TOMB  = 'pe_sync_tomb_v1';    // 本机删掉的班 id
  var K_SIG   = 'pe_sync_sig_v1';     // 上次同步用的权限范围签名

  var cloud = null, busy = false, applying = false, started = false, adopted = false;
  var hooks = { getDB: null, applyRemote: null, onStatus: null };
  var timer = null, debounce = null, clockDone = false;

  var st = { on: false, at: 0, msg: '本机', err: '', up: 0, down: 0 };

  /* ---------- 小工具 ---------- */

  function readJSON(k, dv) {
    try { var r = localStorage.getItem(k); return r ? JSON.parse(r) : dv; } catch (e) { return dv; }
  }
  function writeJSON(k, v) {
    try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {}
  }
  function isoNow() { return new Date().toISOString(); }
  function newer(a, b) {
    var ta = a ? Date.parse(a) : 0, tb = b ? Date.parse(b) : 0;
    return ta > tb ? a : b;
  }
  function errText(e) {
    if (!e) return '未知错误';
    if (typeof e === 'string') return e;
    var t = e.message || e.error_description || e.msg || JSON.stringify(e);
    return (e.code ? '[' + e.code + '] ' : '') + String(t).slice(0, 140);
  }
  function chunk(arr, n) {
    var out = [];
    for (var i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
    return out;
  }

  /** 键序稳定的序列化：同一份数据在两边算出来的指纹必须一样 */
  function stable(v) {
    if (v === null || typeof v !== 'object') return JSON.stringify(v);
    if (Array.isArray(v)) {
      var a = [];
      for (var i = 0; i < v.length; i++) a.push(stable(v[i]));
      return '[' + a.join(',') + ']';
    }
    var ks = Object.keys(v).sort(), b = [];
    for (var k = 0; k < ks.length; k++) b.push(JSON.stringify(ks[k]) + ':' + stable(v[ks[k]]));
    return '{' + b.join(',') + '}';
  }

  /** djb2 指纹：只用来判断"这个班变没变"，不要求抗碰撞 */
  function hash(obj) {
    var s = stable(obj) || '';
    var h = 5381, i = s.length;
    while (i) h = (h * 33) ^ s.charCodeAt(--i);
    return (h >>> 0).toString(36) + ':' + s.length;
  }

  /** 一个班"上云时的样子"：本地对象里别的字段（渲染缓存等）不参与比对 */
  function viewOf(c) {
    return {
      id: c.id, name: c.name || '班级', gender: c.gender === '女' ? '女' : '男',
      grade: c.grade || 2, students: c.students || [], proj: c.proj || {}
    };
  }

  function deviceId() {
    var d = readJSON(K_DEV, null);
    if (d && d.id) return d.id;
    d = { id: 'd' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7), at: isoNow() };
    writeJSON(K_DEV, d);
    return d.id;
  }

  function shortUA(ua) {
    var u = String(ua || '');
    var os = /iPhone/.test(u) ? 'iPhone' : /iPad/.test(u) ? 'iPad' : /Android/.test(u) ? 'Android'
      : /Windows/.test(u) ? 'Windows' : /Mac OS X/.test(u) ? 'Mac' : '其他';
    var br = /MicroMessenger/.test(u) ? '微信' : /EdgA?\/|Edg\//.test(u) ? 'Edge'
      : /CriOS|Chrome/.test(u) ? 'Chrome' : /Safari/.test(u) ? 'Safari' : '浏览器';
    return os + '·' + br;
  }

  /* ---------- 云端 ---------- */

  function client() {
    if (cloud) return cloud;
    if (!root.WorkBuddyCloud) throw new Error('云端组件没加载');
    cloud = root.WorkBuddyCloud.createWorkBuddyCloud(CONF);
    return cloud;
  }
  function T(name) { return client().database.from(name); }
  function q(p) {
    return Promise.resolve(p).then(function (r) {
      if (!r) throw new Error('云端无响应');
      if (r.error) throw r.error;
      return r;
    });
  }
  function rows(p) { return q(p).then(function (r) { return r.data || []; }); }

  /* ---------- 本地快照 ---------- */

  function meta() { return readJSON(K_META, {}) || {}; }
  function setMeta(id, h, u) {
    var m = meta();
    if (h == null) delete m[id]; else m[id] = { h: h, u: u || isoNow() };
    writeJSON(K_META, m);
  }
  function tombs() { return readJSON(K_TOMB, {}) || {}; }

  /** 从界面数据里取出"云端该存的样子" */
  function collect() {
    var db = hooks.getDB ? hooks.getDB() : null;
    var out = {};
    if (!db || !db.classes) return out;
    db.classes.forEach(function (c) {
      if (!c || !c.id) return;
      var data = viewOf(c);
      out[c.id] = { id: c.id, name: data.name, data: data, h: hash(data) };
    });
    return out;
  }

  /* ---------- 推送 ---------- */

  /* ---------- 班级权限（只同步自己名下的班） ---------- */

  var scopeC = { all: true, ids: [] };

  function inScopeClass(id) {
    if (!scopeC || scopeC.all) return true;
    return !!id && scopeC.ids.indexOf(id) >= 0;
  }

  /**
   * 每次同步前对齐权限。权限范围一变（管理员给谁加了个班）就清游标，
   * 强制全量重拉 —— 否则那个班早过了游标，永远补不下来。
   */
  function ensureScope() {
    if (root.Auth && root.Auth.classScope) scopeC = root.Auth.classScope();
    else scopeC = { all: true, ids: [] };

    var u = (root.Auth && root.Auth.user) ? root.Auth.user() : null;
    var sig = (u ? (u.id || '') : '') + '|' + (scopeC.all ? '*' : scopeC.ids.slice().sort().join(','));
    var prev = '';
    try { prev = localStorage.getItem(K_SIG) || ''; } catch (e) {}
    if (prev !== sig) {
      try {
        localStorage.removeItem(K_CUR);
        localStorage.removeItem(K_META);
        localStorage.setItem(K_SIG, sig);
      } catch (e) {}
    }
  }

  function push() {
    var cur = collect(), m = meta(), tomb = tombs(), up = [];
    Object.keys(cur).forEach(function (id) {
      if (tomb[id]) return;                                   // 已删的班别又推回来
      if (!(cur[id].data.students || []).length) return;      // 空班（还没导名单）不上云，免留垃圾
      if (!m[id] || m[id].h !== cur[id].h) up.push(cur[id]);
    });

    // 本机删掉的班 → 云端打删除标记（不物理删）
    var delIds = Object.keys(tomb).filter(function (id) {
      return !m[id] || m[id].h !== '__del__';
    });

    var stamp = isoNow();
    var n = 0;

    var chain = Promise.resolve();
    chunk(up, 3).forEach(function (part) {
      chain = chain.then(function () {
        var payload = part.map(function (c) {
          return { id: c.id, name: c.name, data: c.data, owner: deviceId(), del: false, updated_at: stamp };
        });
        return q(T(TAB).upsert(payload)).then(function () { n += payload.length; });
      });
    });

    delIds.forEach(function (id) {
      chain = chain.then(function () {
        return q(T(TAB).update({ del: true, owner: deviceId(), updated_at: isoNow() }).eq('id', id)).then(function () {
          var m2 = meta(); m2[id] = { h: '__del__', u: isoNow() }; writeJSON(K_META, m2);
        });
      });
    });

    return chain.then(function () {
      if (n) {
        var m2 = meta();
        up.forEach(function (c) { m2[c.id] = { h: c.h, u: stamp }; });
        writeJSON(K_META, m2);
      }
      st.up += n;
      return n;
    });
  }

  /* ---------- 合并（两边都不丢） ---------- */

  function stuKey(s) {
    var no = String((s && s.no) || '').trim();
    if (no) return 'no:' + no;
    return 'name:' + String((s && s.name) || '').trim();
  }

  function recKey(r) {
    return [r.v, r.round || 0, r.date || '', r.foul ? 1 : 0, r.order == null ? '' : r.order].join('|');
  }

  /** 把 b 班并进 a 班（a 为底），返回新对象 */
  function mergeClass(a, b) {
    if (!a) return b;
    if (!b) return a;
    var out = JSON.parse(JSON.stringify(a));
    var idx = {};
    (out.students || []).forEach(function (s) { idx[stuKey(s)] = s; });

    (b.students || []).forEach(function (s) {
      var k = stuKey(s), hit = idx[k];
      if (!hit) {
        out.students.push(JSON.parse(JSON.stringify(s)));
        idx[k] = out.students[out.students.length - 1];
        return;
      }
      // 补齐姓名/性别/学号（云端可能缺）
      if (!hit.name && s.name) hit.name = s.name;
      if (!hit.no && s.no) hit.no = s.no;
      if (!hit.gender && s.gender) hit.gender = s.gender;
      hit.scores = hit.scores || {};
      Object.keys(s.scores || {}).forEach(function (pid) {
        var dst = hit.scores[pid] = Array.isArray(hit.scores[pid]) ? hit.scores[pid] : [];
        var seen = {};
        dst.forEach(function (r) { seen[recKey(r)] = 1; });
        (s.scores[pid] || []).forEach(function (r) {
          var kk = recKey(r);
          if (!seen[kk]) { dst.push(JSON.parse(JSON.stringify(r))); seen[kk] = 1; }
        });
      });
    });

    // 班名：以 a（云端）为准，但本地名字更新更具体时保留 a，避免互改成"班级"
    if (!out.name && b.name) out.name = b.name;
    return out;
  }

  /* ---------- 拉取 ---------- */

  var pageSize = 200;

  function pull() {
    var cursor = readJSON(K_CUR, '') || '';
    var changed = false, maxTs = cursor;

    function step(offset) {
      var b = T(TAB).select('*');
      if (cursor) b = b.gt('updated_at', cursor);
      return rows(b.order('updated_at', { ascending: true }).range(offset, offset + pageSize - 1)).then(function (list) {
        if (!list.length) return;
        list.forEach(function (row) {
          maxTs = newer(maxTs, row.updated_at);
          if (applyRow(row)) changed = true;
        });
        if (list.length === pageSize) return step(offset + pageSize);
      });
    }

    return step(0).then(function () {
      if (maxTs && maxTs !== cursor) writeJSON(K_CUR, maxTs);
      return changed;
    });
  }

  /** 把云端一行写回本机；返回是否改了本机 */
  function applyRow(row) {
    var db = hooks.getDB ? hooks.getDB() : null;
    if (!db || !row || !row.id) return false;
    if (!inScopeClass(row.id)) return false;      // 不是自己名下的班，连拉都不拉

    var list = db.classes || [];
    var hit = null;
    for (var i = 0; i < list.length; i++) if (list[i].id === row.id) { hit = list[i]; break; }
    var mine = row.owner && row.owner === deviceId();
    var m = meta()[row.id];

    if (row.del) {
      if (!hit) { setMeta(row.id, '__del__'); return false; }
      var tomb = tombs(); tomb[row.id] = 1; writeJSON(K_TOMB, tomb);
      setMeta(row.id, '__del__');
      hooks.applyRemote({ dels: [row.id] });
      st.down++;
      return true;
    }

    // 自己刚推上去的、内容一致的，不用再套一遍
    if (mine && m && m.h === hash(row.data)) return false;

    if (!hit) {
      if (m && m.h === '__del__') return false;   // 本地已删，不复活
      hooks.applyRemote({ upserts: [{ id: row.id, data: row.data }] });
      setMeta(row.id, hash(row.data), row.updated_at);
      st.down++;
      return true;
    }

    // 本地这个班有没有未推送的改动？
    var localH = hash(viewOf(hit));
    var dirty = !m || m.h !== localH;
    var next = dirty ? mergeClass(row.data, hit) : row.data;
    var nextH = hash(next);

    if (nextH === localH) {                      // 合完一样，不必动界面
      setMeta(row.id, nextH, row.updated_at);
      return false;
    }

    hooks.applyRemote({ upserts: [{ id: row.id, data: next }] });
    // 合成过（本地有货）→ 指纹记成"还没推"的样子，下一轮会把它推上去
    setMeta(row.id, dirty ? null : nextH, row.updated_at);
    st.down++;
    return true;
  }

  /* ---------- 首次接入 ---------- */

  function adopt() {
    return rows(T(TAB).select('*')).then(function (list) {
      var d = collect();
      var localIds = Object.keys(d);
      var localN = 0;
      localIds.forEach(function (id) { localN += (d[id].data.students || []).length; });

      var alive = list.filter(function (r) { return !r.del; });

      // 云端空 → 本机整体铺上去
      if (!list.length) {
        adopted = true;
        if (!localN) return 0;
        return push().then(function (n) {
          writeJSON(K_CUR, isoNow());
          return n;
        });
      }

      // 云端有数据 → 逐行对接
      var used = {};        // 本机已对上云端的班 id
      var upserts = [];
      var pulls = [];
      var dropLocal = [];   // 本机那份被并进云端同一个班后，应该消失的本地班 id

      alive.forEach(function (row) {
        var local = d[row.id] || null;

        // 同 id 找不到 → 按班名找（老师们各自建的班 id 不同）
        if (!local) {
          localIds.forEach(function (lid) {
            if (used[lid]) return;
            if (!local && String(d[lid].name).trim() === String(row.name || '').trim()) local = d[lid];
          });
        }

        if (!local) {
          pulls.push({ id: row.id, data: row.data });
          setMeta(row.id, hash(row.data), row.updated_at);
          return;
        }

        used[local.id] = row.id;
        // 同名不同 id 的两个班：本机那份要退场，否则界面上会出现两个同名班
        if (local.id !== row.id) dropLocal.push(local.id);

        var merged = mergeClass(row.data, local.data);
        var hMerged = hash(merged);

        if (hMerged === hash(row.data)) {
          // 云端已包含本机全部内容 → 本机换成云端的（若有差异）
          if (hMerged !== local.h) pulls.push({ id: row.id, data: row.data });
          setMeta(row.id, hMerged, row.updated_at);
        } else {
          // 本机有云端没有的东西 → 合并后推上去
          upserts.push({ id: row.id, name: merged.name, data: merged, owner: deviceId(), del: false, updated_at: isoNow() });
          pulls.push({ id: row.id, data: merged });
          setMeta(row.id, hMerged, isoNow());
        }
      });

      // 本机独有的班 → 推上去
      localIds.forEach(function (lid) {
        if (used[lid]) return;
        var c = d[lid];
        if (!(c.data.students || []).length) return;   // 空班不推
        upserts.push({ id: c.id, name: c.name, data: c.data, owner: deviceId(), del: false, updated_at: isoNow() });
      });

      // 本机只有"刚装好那个空班"、而云端已经有真班级 → 空班让位，
      // 免得老师第一次打开看到「一班（空）」加一堆真班级。
      if (localIds.length === 1 && !(d[localIds[0]].data.students || []).length && alive.length
          && dropLocal.indexOf(localIds[0]) < 0) {
        dropLocal.push(localIds[0]);
      }

      var chain = Promise.resolve();
      chunk(upserts, 3).forEach(function (part) {
        chain = chain.then(function () { return q(T(TAB).upsert(part)).then(function () {}); });
      });

      return chain.then(function () {
        if (pulls.length || dropLocal.length) hooks.applyRemote({ upserts: pulls, dels: dropLocal });
        st.up += upserts.length; st.down += pulls.length;
        adopted = true;
        writeJSON(K_META, meta());
        var all = mergedMax(alive);
        writeJSON(K_CUR, all || isoNow());
        return upserts.length + pulls.length;
      });
    });
  }

  function mergedMax(list) {
    var mx = '';
    list.forEach(function (r) { mx = newer(mx, r.updated_at); });
    return mx;
  }

  /* ---------- 主循环 ---------- */

  function status(msg, err) {
    if (msg) st.msg = msg;
    st.err = err || '';
    st.at = Date.now();
    writeJSON(K_STAT, st);
    if (hooks.onStatus) { try { hooks.onStatus(st); } catch (e) {} }
  }

  function syncOnce() {
    ensureScope();
    if (busy || applying) return Promise.resolve(false);
    busy = true;
    applying = true;
    status('同步中…');

    var chain = Promise.resolve().then(function () {
      if (!root.WorkBuddyCloud) throw new Error('云端组件没加载');

      if (!adopted) {
        var m = meta();
        var hasSnap = Object.keys(m).length > 0;
        if (!hasSnap) return adopt().then(function () { return true; });
        adopted = true;
      }
      return push().then(function () { return pull(); }).then(function (ch) { return ch; });
    });

    return chain.then(function (ch) {
      st.on = true;
      status(ch ? '已同步' : '已是最新');
      busy = false; applying = false;
      if (pendingTouch) { pendingTouch = false; touch(); }
      return ch;
    }).catch(function (e) {
      st.on = false;
      status('离线（本机照常用）', errText(e));
      console.error('[pe-sync]', e && e.stack || e);
      busy = false; applying = false;
      if (pendingTouch) { pendingTouch = false; touch(); }
      return false;
    });
  }

  /* ---------- 对外 ---------- */

  var pendingTouch = false;

  function touch() {
    if (!started) return;
    if (applying) { pendingTouch = true; return; }   // 同步中来的改动，等这轮结束再排
    clearTimeout(debounce);
    debounce = setTimeout(function () { syncOnce(); }, 1500);
  }

  /** 界面删了班：记一笔，等下一轮通知云端 */
  function drop(id) {
    if (!id) return;
    var t = tombs(); t[id] = 1; writeJSON(K_TOMB, t);
    touch();
  }

  /** 一键清空：把云端所有还活着的班打删除标记（只标不删），本地记 tomb 防止被拉回 */
  function wipeCloud() {
    return rows(T(TAB).select('id,del')).then(function (list) {
      var ids = list.filter(function (r) { return !r.del && r.id; }).map(function (r) { return r.id; });
      if (!ids.length) return 0;
      var stamp = isoNow();
      var chain = Promise.resolve();
      chunk(ids, 50).forEach(function (part) {
        chain = chain.then(function () {
          return q(T(TAB).update({ del: true, updated_at: stamp }).in('id', part));
        });
      });
      return chain.then(function () {
        var t = tombs(), m = meta();
        ids.forEach(function (id) { t[id] = 1; delete m[id]; });
        writeJSON(K_TOMB, t); writeJSON(K_META, m);
        return ids.length;
      });
    });
  }

  /** 界面新建/改了班，立刻排一轮（同上） */
  function start(o) {
    if (started) return;
    hooks.getDB = o && o.getDB;
    hooks.applyRemote = o && o.applyRemote;
    hooks.onStatus = o && o.onStatus;
    started = true;
    deviceId();
    syncOnce();
    // 整库同步降频到 10 分钟：本地按键瞬间完成，云端只是后台兜底合并。
    timer = setInterval(function () {
      if (!document.hidden) syncOnce();
    }, 600000);
    document.addEventListener('visibilitychange', function () {
      syncOnce();                       // 切回来拉别人的；切走时把没传的推上去
    });
    window.addEventListener('online', function () { syncOnce(); });
    window.addEventListener('pagehide', function () { try { syncOnce(); } catch (e) {} });
    window.addEventListener('beforeunload', function () { try { syncOnce(); } catch (e) {} });
  }

  root.PeSync = {
    start: start, touch: touch, drop: drop, wipeCloud: wipeCloud, now: syncOnce,
    status: function () { return st; },
    device: deviceId, deviceLabel: shortUA,
    /** 仅测试用：强制从云端重铺 */
    _reset: function () {
      try {
        localStorage.removeItem(K_META); localStorage.removeItem(K_CUR); localStorage.removeItem(K_TOMB);
      } catch (e) {}
      adopted = false;
    },
    _adopt: function () { adopted = false; return syncOnce(); }
  };
})(typeof self !== 'undefined' ? self : this);
