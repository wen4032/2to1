(function () {
  'use strict';

  var html = document.documentElement;
  html.className += ' track-mode';

  document.addEventListener('gesturestart', function (event) {
    event.preventDefault();
  }, { passive: false });

  document.addEventListener('dblclick', function (event) {
    if (event.target && event.target.closest && event.target.closest('#view-test')) {
      event.preventDefault();
    }
  }, { passive: false });

  function byId(id) { return document.getElementById(id); }

  function toast(message) {
    var el = byId('toast');
    if (!el) return;
    el.textContent = message;
    el.classList.add('on');
    clearTimeout(el._trackTimer);
    el._trackTimer = setTimeout(function () { el.classList.remove('on'); }, 1900);
  }

  function currentState() {
    if (!window.PeApp || !window.Projects) return null;
    var db = window.PeApp.getDB();
    if (!db) return null;
    var cls = (db.classes || []).filter(function (item) { return item.id === db.activeId; })[0] || (db.classes || [])[0];
    var projectId = db.activeProject;
    if (!cls || !projectId) return null;
    return {
      db: db,
      cls: cls,
      projectId: projectId,
      project: window.Projects.get(projectId),
      round: ((cls.proj || {})[projectId] || {}).round || 1
    };
  }

  function roundRows(state) {
    var rows = [];
    (state.cls.students || []).forEach(function (student) {
      (student.scores && student.scores[state.projectId] || []).forEach(function (record) {
        if (record.round !== state.round) return;
        rows.push({
          sid: student.id,
          no: student.no || '',
          name: student.name || '',
          gender: student.gender === '女' ? '女' : '男',
          v: record.v,
          foul: !!record.foul
        });
      });
    });
    return rows;
  }

  function bestRows(state) {
    var rows = [];
    (state.cls.students || []).forEach(function (student) {
      var value = window.Projects.bestOf(state.projectId, (student.scores || {})[state.projectId] || []);
      if (value == null) return;
      rows.push({
        sid: student.id,
        no: student.no || '',
        name: student.name || '',
        gender: student.gender === '女' ? '女' : '男',
        v: value,
        foul: false
      });
    });
    return rows;
  }

  function csvCell(value) {
    var text = String(value == null ? '' : value);
    return /[",\r\n]/.test(text) ? '"' + text.replace(/"/g, '""') + '"' : text;
  }

  function dateText() {
    var date = new Date();
    function two(value) { return String(value).padStart(2, '0'); }
    return date.getFullYear() + '-' + two(date.getMonth() + 1) + '-' + two(date.getDate());
  }

  function download(name, text) {
    var blob = new Blob(['\ufeff' + text], { type: 'text/csv;charset=utf-8' });
    var link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = name;
    document.body.appendChild(link);
    link.click();
    setTimeout(function () {
      try { URL.revokeObjectURL(link.href); link.remove(); } catch (error) {}
    }, 1500);
  }

  function exportCurrentRank() {
    var state = currentState();
    if (!state) return toast('还没有可导出的成绩');
    var rows = roundRows(state);
    var label = '第' + state.round + '轮';
    if (!rows.length) {
      rows = bestRows(state);
      label = '最好成绩';
    }
    if (!rows.length) return toast('还没有可导出的成绩');

    rows = window.Projects.rankRows(state.projectId, rows);
    var lines = ['名次,学号,姓名,性别,' + csvCell(state.project.name) + ',备注'];
    rows.forEach(function (row) {
      lines.push([
        row.rank || '',
        csvCell(row.no),
        csvCell(row.name),
        row.gender,
        row.foul ? '' : csvCell(window.Projects.fmt(state.projectId, row.v)),
        row.foul ? '犯规' : ''
      ].join(','));
    });
    download('田径队_' + state.project.name + '_' + state.cls.name + '_' + label + '_' + dateText() + '.csv', lines.join('\r\n'));
    toast('已导出');
  }

  function exportAll(share) {
    var state = currentState();
    if (!state) return toast('这个班的名单是空的');
    var list = window.Projects.LIST;
    var header = ['姓名', '性别', '学号'].concat(list.map(function (project) { return project.name; }));
    var lines = [header.map(csvCell).join(',')];
    var students = (state.cls.students || []).slice().sort(function (a, b) {
      if (a.gender !== b.gender) return a.gender === '男' ? -1 : 1;
      return String(a.no || '').localeCompare(String(b.no || ''), 'zh', { numeric: true });
    });
    if (!students.length) return toast('这个班的名单是空的');

    students.forEach(function (student) {
      var line = [student.name || '', student.gender === '女' ? '女' : '男', student.no || ''];
      list.forEach(function (project) {
        var best = window.Projects.bestOf(project.id, (student.scores || {})[project.id] || []);
        line.push(best == null ? '' : window.Projects.fmt(project.id, best));
      });
      lines.push(line.map(csvCell).join(','));
    });

    var text = lines.join('\r\n');
    var name = '田径队总表_' + state.cls.name + '_' + dateText() + '.csv';
    if (share && navigator.share) {
      try {
        var file = new File([new Blob(['\ufeff' + text], { type: 'text/csv' })], name, { type: 'text/csv' });
        if (navigator.canShare && navigator.canShare({ files: [file] })) {
          navigator.share({ files: [file], title: '田径队总表' }).then(function () {
            toast('已发送');
          }).catch(function () {
            download(name, text);
          });
          return;
        }
      } catch (error) {}
    }
    download(name, text);
    toast(share ? '已下载，可手动发到微信' : '总表已导出');
  }

  function intercept(id, handler) {
    document.addEventListener('click', function (event) {
      var button = event.target && event.target.closest && event.target.closest('#' + id);
      if (!button) return;
      if (!window.PeApp || !window.Projects) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      handler();
    }, true);
  }

  function patchExports() {
    intercept('btnExport', exportCurrentRank);
    intercept('btnExportAll', function () { exportAll(false); });
    intercept('btnShareAll', function () { exportAll(true); });
  }

  function patchSwitchLinks() {
    var config = window.APP_SWITCH || {};
    var guobiao = document.querySelector('[data-switch-guobiao]');
    var tianjing = document.querySelector('[data-switch-tianjing]');
    if (guobiao) guobiao.setAttribute('href', config.guobiao || '../国标体测/index.html');
    if (tianjing) tianjing.setAttribute('href', config.tianjing || './index.html');
  }

  function patchWipeDialog() {
    var modal = byId('modal');
    var title = byId('modalTitle');
    var body = byId('modalBody');
    if (!modal || !title || !body) return;

    var rewrite = function () {
      if (title.textContent.indexOf('另一个软件') < 0 && body.textContent.indexOf('国标体测') < 0) return;
      title.textContent = '清空完成';
      body.textContent = '田径队名单和成绩已清空，清空前备份已下载。';
      modal.dataset.trackWipe = '1';
      var alt = byId('modalAlt');
      var cancel = byId('modalCancel');
      if (alt) alt.hidden = true;
      if (cancel) cancel.textContent = '关闭';
    };

    new MutationObserver(rewrite).observe(modal, { childList: true, subtree: true, characterData: true, attributes: true });

    document.addEventListener('click', function (event) {
      var ok = event.target && event.target.closest && event.target.closest('#modalOk');
      if (!ok || modal.dataset.trackWipe !== '1') return;
      event.preventDefault();
      event.stopImmediatePropagation();
      modal.hidden = true;
      delete modal.dataset.trackWipe;
    }, true);
  }

  var plankFixing = false;
  function patchPlankWording() {
    if (!window.PeApp || !window.Projects) return;
    var state = currentState();
    if (!state || state.projectId !== 'plank') return;
    var nodes = [byId('hint'), byId('dmSub'), byId('testTip')];
    nodes.forEach(function (node) {
      if (!node || !node.textContent) return;
      var next = node.textContent
        .replace(/冲过一人/g, '一人结束时')
        .replace(/每冲过一人/g, '一人结束时')
        .replace(/全冲完后/g, '全部结束后')
        .replace(/全冲完/g, '全部结束')
        .replace(/冲线就按这里/g, '结束时按这里')
        .replace(/按冲线顺序/g, '按结束顺序')
        .replace(/冲线时间/g, '计时时间')
        .replace(/冲线/g, '结束')
        .replace(/再跑一次/g, '再来一次');
      if (next !== node.textContent) {
        plankFixing = true;
        node.textContent = next;
        setTimeout(function () { plankFixing = false; }, 0);
      }
    });
  }

  function start() {
    patchSwitchLinks();
    patchExports();
    patchWipeDialog();
    var watched = [byId('hint'), byId('dmSub'), byId('testTip')].filter(Boolean);
    var observer = new MutationObserver(function () {
      if (!plankFixing) setTimeout(patchPlankWording, 0);
    });
    watched.forEach(function (node) {
      observer.observe(node, { childList: true, subtree: true, characterData: true });
    });
    setInterval(patchPlankWording, 1000);
    setTimeout(patchPlankWording, 400);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { setTimeout(start, 350); });
  } else {
    setTimeout(start, 350);
  }
})();
