(function (root) {
  'use strict';

  var LIST = [
    { id: 'sprint50', name: '50米', short: '50米', kind: 'timed', unit: '秒', dir: 'lower', digits: 2, placeholder: '7.85' },
    { id: 'sprint60', name: '60米', short: '60米', kind: 'timed', unit: '秒', dir: 'lower', digits: 2, placeholder: '9.50' },
    { id: 'sprint100', name: '100米', short: '100米', kind: 'timed', unit: '秒', dir: 'lower', digits: 2, placeholder: '15.20' },
    { id: 'sprint200', name: '200米', short: '200米', kind: 'timed', unit: '秒', dir: 'lower', digits: 2, placeholder: '32.50' },
    { id: 'sprint400', name: '400米', short: '400米', kind: 'timed', unit: '秒', dir: 'lower', digits: 2, clock: true },
    { id: 'run800', name: '800米', short: '800米', kind: 'timed', unit: '秒', dir: 'lower', digits: 2, clock: true },
    { id: 'run1500', name: '1500米', short: '1500米', kind: 'timed', unit: '秒', dir: 'lower', digits: 2, clock: true },
    { id: 'longjump', name: '立定跳远', short: '跳远', kind: 'measure', unit: '厘米', dir: 'higher', digits: 0, step: 1, min: 0, max: 350, placeholder: '185' },
    { id: 'pullup', name: '引体向上', short: '引体', kind: 'count', unit: '个', dir: 'higher', digits: 0, step: 1, min: 0, max: 100, placeholder: '8' },
    { id: 'plank', name: '平板支撑', short: '平板', kind: 'timed', unit: '秒', dir: 'higher', digits: 2, clock: true }
  ];

  var BY_ID = {};
  LIST.forEach(function (project) { BY_ID[project.id] = project; });

  var IDS = LIST.map(function (project) { return project.id; });

  function get(id) { return BY_ID[id] || LIST[0]; }
  function digitsOf(id) { return get(id).digits || 0; }

  function fmt(id, value) {
    var project = get(id);
    if (value == null || typeof value !== 'number' || !isFinite(value)) return '—';
    if (project.clock) {
      var total = Math.round(value * 100) / 100;
      var minutes = Math.floor(total / 60);
      var seconds = total - minutes * 60;
      return minutes + "'" + seconds.toFixed(2).padStart(5, '0') + '"';
    }
    return Number(value).toFixed(digitsOf(id));
  }

  function fmtUnit(id, value) {
    var project = get(id);
    if (value == null) return '—';
    return fmt(id, value) + (project.clock || !project.unit ? '' : ' ' + project.unit);
  }

  function better(id, a, b) {
    if (a == null || !isFinite(a)) return false;
    if (b == null || !isFinite(b)) return true;
    return get(id).dir === 'lower' ? a < b : a > b;
  }

  function bestOf(id, records) {
    var best = null;
    (records || []).forEach(function (record) {
      if (record && !record.foul && typeof record.v === 'number' && isFinite(record.v)) {
        if (best == null || better(id, record.v, best)) best = record.v;
      }
    });
    return best;
  }

  function lastOf(id, records) {
    var list = records || [];
    for (var i = list.length - 1; i >= 0; i--) {
      var record = list[i];
      if (record && !record.foul && typeof record.v === 'number' && isFinite(record.v)) return record.v;
    }
    return null;
  }

  function rankRows(id, rows) {
    var lower = get(id).dir === 'lower';
    var valid = (rows || []).filter(function (row) {
      return row && row.v != null && !row.foul && isFinite(row.v);
    }).sort(function (a, b) { return lower ? a.v - b.v : b.v - a.v; });

    var rank = 0;
    var lastValue = null;
    valid.forEach(function (row, index) {
      if (lastValue == null || Math.abs(row.v - lastValue) > 1e-9) {
        rank = index + 1;
        lastValue = row.v;
      }
      row.rank = rank;
    });

    (rows || []).forEach(function (row) {
      if (!valid.some(function (hit) { return hit === row; })) row.rank = null;
    });

    return valid.concat((rows || []).filter(function (row) {
      return row.v == null || row.foul || !isFinite(row.v);
    }));
  }

  function rankByGender(id, rows) {
    var out = [];
    ['男', '女'].forEach(function (gender) {
      var part = (rows || []).filter(function (row) {
        return (row.gender === '女' ? '女' : '男') === gender;
      });
      if (part.length) out = out.concat(rankRows(id, part));
    });
    return out;
  }

  function gradeIndex(grade) {
    var value = parseInt(grade, 10);
    return value === 1 || value === 2 || value === 3 ? value : 2;
  }

  root.Projects = {
    LIST: LIST,
    IDS: IDS,
    get: get,
    has: function (id) { return !!BY_ID[id]; },
    isTimed: function (id) { return get(id).kind === 'timed'; },
    digitsOf: digitsOf,
    unitOf: function (id) { return get(id).unit || ''; },
    kindLabel: function (id) {
      var kind = get(id).kind;
      return kind === 'timed' ? '计时' : kind === 'measure' ? '测量' : '计数';
    },
    fmt: fmt,
    fmtUnit: fmtUnit,
    better: better,
    bestOf: bestOf,
    lastOf: lastOf,
    rankRows: rankRows,
    rankByGender: rankByGender,
    scoreOf: function () { return null; },
    scored: function () { return false; },
    weightOf: function () { return 0; },
    totalOf: function () { return null; },
    levelOf: function () { return null; },
    gradeIndex: gradeIndex,
    GB: {},
    GB_WEIGHT: {}
  };
})(typeof self !== 'undefined' ? self : this);
