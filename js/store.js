/**
 * 数据存储：模型 CRUD、localStorage 自动保存、服务端 project.json 持久化
 */
(function (root) {
  'use strict';

  var LS_KEY = 'dw-workbench-project';

  var Store = {
    project: null,
    selectedId: null,
    serverOnline: false,
    listeners: [],

    onChange: function (fn) { this.listeners.push(fn); },
    emit: function () { this.listeners.forEach(function (fn) { fn(); }); },

    newId: function () { return 'm_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 7); },

    // ---------- 加载 ----------
    load: function (cb) {
      var self = this;
      fetch('/api/project').then(function (r) {
        if (r.status === 404) return null;
        if (!r.ok) throw new Error('http ' + r.status);
        return r.json();
      }).then(function (data) {
        self.serverOnline = true;
        if (data && data.models) { self.project = data; }
        else { self.project = self.fromLocal() || clone(root.SAMPLE); self.saveToServer(); }
        self.normalize();
        cb && cb('server');
      }).catch(function () {
        self.serverOnline = false;
        self.project = self.fromLocal() || clone(root.SAMPLE);
        self.normalize();
        cb && cb('local');
      });
    },

    // 归一化：确保自定义列配置存在
    normalize: function () {
      if (!this.project.customCols || typeof this.project.customCols !== 'object') this.project.customCols = { model: [], field: [] };
      if (!Array.isArray(this.project.customCols.model)) this.project.customCols.model = [];
      if (!Array.isArray(this.project.customCols.field)) this.project.customCols.field = [];
    },

    fromLocal: function () {
      try {
        var s = localStorage.getItem(LS_KEY);
        if (s) { var p = JSON.parse(s); if (p && p.models) return p; }
      } catch (e) { }
      return null;
    },

    // ---------- 保存 ----------
    autosave: function () {
      try { localStorage.setItem(LS_KEY, JSON.stringify(this.project)); } catch (e) { }
    },
    saveToServer: function () {
      var self = this;
      this.autosave();
      return fetch('/api/project', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(this.project, null, 2)
      }).then(function (r) {
        if (!r.ok) throw new Error('http ' + r.status);
        self.serverOnline = true;
        return 'ok';
      });
    },

    // ---------- 模型 CRUD ----------
    getModels: function () { return this.project.models; },
    // ---------- 自定义扩展列 ----------
    getCustomCols: function (scope) {
      this.normalize();
      return this.project.customCols[scope] || [];
    },
    addCustomCol: function (scope, label) {
      label = String(label || '').trim();
      if (!label) return null;
      this.normalize();
      var list = this.project.customCols[scope];
      if (list.some(function (c) { return c.label === label; })) return null; // 列名重复
      var key = 'x_' + label.toLowerCase().replace(/[^a-z0-9_\u4e00-\u9fa5]+/g, '_').replace(/^_+|_+$/g, '');
      if (key === 'x_') key = 'x_col';
      var base = key, n = 2;
      while (list.some(function (c) { return c.key === key; })) { key = base + '_' + n; n++; }
      var col = { key: key, label: label };
      list.push(col);
      this.touch();
      return col;
    },
    removeCustomCol: function (scope, key) {
      this.normalize();
      this.project.customCols[scope] = this.project.customCols[scope].filter(function (c) { return c.key !== key; });
      this.touch();
    },
    find: function (id) { return this.project.models.filter(function (m) { return m.id === id; })[0] || null; },
    findByName: function (name) { return this.project.models.filter(function (m) { return m.name === name; })[0] || null; },

    newModel: function (layer) {
      var m = {
        id: this.newId(), layer: layer || 'ods',
        name: '', cnName: '', desc: '', source: '', notes: '',
        fields: [], partition: [], sources: [], where: '', groupBy: ''
      };
      this.project.models.push(m);
      this.selectedId = m.id;
      this.touch(); return m;
    },
    deleteModel: function (id) {
      var i = this.project.models.findIndex(function (m) { return m.id === id; });
      if (i >= 0) {
        this.project.models.splice(i, 1);
        if (this.selectedId === id) this.selectedId = this.project.models.length ? this.project.models[0].id : null;
        this.touch();
      }
    },
    duplicateModel: function (id) {
      var m = this.find(id);
      if (!m) return;
      var copy = JSON.parse(JSON.stringify(m));
      copy.id = this.newId();
      copy.name = (m.name || 'new_table') + '_copy';
      copy.cnName = (m.cnName || '') + '（副本）';
      var idx = this.project.models.findIndex(function (x) { return x.id === id; });
      this.project.models.splice(idx + 1, 0, copy);
      this.selectedId = copy.id;
      this.touch(); return copy;
    },
    // 导入模型（SQL 反解析产物），返回 {created, replaced}
    importModel: function (model) {
      var exist = this.findByName(model.name);
      model.id = this.newId();
      model.createdAt = new Date().toISOString();
      if (exist) {
        var idx = this.project.models.findIndex(function (m) { return m.id === exist.id; });
        this.project.models[idx] = model;
        this.selectedId = model.id;
        this.touch();
        return { created: false, replaced: true };
      }
      this.project.models.push(model);
      this.selectedId = model.id;
      this.touch();
      return { created: true, replaced: false };
    },

    touch: function () {
      this.project.updatedAt = new Date().toISOString();
      this.autosave();
      this.emit();
    }
  };

  function clone(o) { return JSON.parse(JSON.stringify(o)); }

  root.Store = Store;
})(typeof globalThis !== 'undefined' ? globalThis : this);
