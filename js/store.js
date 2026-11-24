/**
 * 数据存储：多项目管理、模型 CRUD、目录树缓存、localStorage 自动保存、服务端持久化
 */
(function (root) {
  'use strict';

  var LS_KEY = 'dw-workbench-project';
  var LS_PROJECT_ID_KEY = 'dw-workbench-project-id';

  var Store = {
    project: null,
    selectedId: null,
    serverOnline: false,
    projectId: 1,      // 当前项目 id（服务端多项目）
    projects: [],      // 项目列表缓存 [{id,name,dialect,updatedAt,modelCount}]
    catalog: [],       // 当前项目业务目录树（服务端组装）
    listeners: [],
    saveState: 'idle', // idle | saving | saved | error | local
    saveStateMsg: '',
    lastSavedAt: '',
    saveStateListeners: [],

    onChange: function (fn) { this.listeners.push(fn); },
    emit: function () { this.listeners.forEach(function (fn) { fn(); }); },
    onSaveState: function (fn) { this.saveStateListeners.push(fn); },

    newId: function () { return 'm_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 7); },

    // 当前项目是否 OLTP（业务库建模）：kind 缺省视为 olap（兼容旧项目）
    isOLTP: function () { return !!(this.project && this.project.kind === 'oltp'); },

    // 当前项目的查询串（/api/project、/api/import/excel 等使用）
    apiProjectId: function () { return '?projectId=' + this.projectId; },

    // ---------- 加载 ----------
    // load：拉项目列表 → 选定项目（localStorage 记忆 > 项目1 > 第一个）→ 加载项目与目录
    load: function (cb) {
      var self = this;
      fetch('/api/projects').then(function (r) { if (!r.ok) throw new Error('http ' + r.status); return r.json(); }).then(function (d) {
        self.serverOnline = true;
        self.projects = d.projects || [];
        var saved = null;
        try { saved = parseInt(localStorage.getItem(LS_PROJECT_ID_KEY), 10); } catch (e) { }
        var target = null;
        if (saved && self.projects.some(function (p) { return p.id === saved; })) target = saved;
        else if (self.projects.some(function (p) { return p.id === 1; })) target = 1;
        else if (self.projects.length) target = self.projects[0].id;
        else target = 1;
        self.loadProject(target, cb, 'server');
      }).catch(function () {
        self.serverOnline = false;
        self.project = self.fromLocal() || clone(root.SAMPLE);
        self.normalize();
        cb && cb('local');
      });
    },

    // loadProject：切换/加载指定项目（含目录树），projectId 记入 localStorage
    loadProject: function (id, cb, source) {
      var self = this;
      // 切换前清掉上一个项目的待写入定时器，避免用新数据覆盖旧项目
      if (this._saveTimer) { clearTimeout(this._saveTimer); this._saveTimer = null; }
      this.projectId = id;
      try { localStorage.setItem(LS_PROJECT_ID_KEY, String(id)); } catch (e) { }
      return fetch('/api/project?projectId=' + id).then(function (r) {
        if (r.status === 404) return null;
        if (!r.ok) throw new Error('http ' + r.status);
        return r.json();
      }).then(function (data) {
        self.serverOnline = true;
        if (data && data.models) { self.project = data; }
        else {
          // 404（项目行缺失，如已被删除）：用项目列表里的元信息给一个空项目，不再回退旧的单项目浏览器缓存
          var meta = null;
          self.projects.forEach(function (p) { if (p.id === id) meta = p; });
          self.project = { name: (meta && meta.name) || '未命名项目', dialect: (meta && meta.dialect) || 'hive', kind: (meta && meta.kind) || 'olap', models: [] };
        }
        self.normalize();
        self.selectedId = self.project.models.length ? self.project.models[0].id : null;
        return self.loadCatalog();
      }).then(function () {
        cb && cb(source || 'server');
      }).catch(function () {
        self.serverOnline = false;
        self.project = self.fromLocal() || clone(root.SAMPLE);
        self.normalize();
        self.loadCatalogQuiet();
        cb && cb('local');
      });
    },

    loadCatalog: function () {
      var self = this;
      return fetch('/api/catalog?projectId=' + this.projectId).then(function (r) { return r.json(); }).then(function (d) {
        self.catalog = d.nodes || [];
      }).catch(function () { self.catalog = []; });
    },
    loadCatalogQuiet: function () { this.catalog = []; },

    // 项目列表刷新（新建/改名/删除后）
    refreshProjects: function () {
      var self = this;
      return fetch('/api/projects').then(function (r) { return r.json(); }).then(function (d) {
        self.projects = d.projects || [];
      }).catch(function () { });
    },

    // ---------- 目录树辅助 ----------
    // 按 id 查找目录节点
    findCatalogNode: function (id, nodes) {
      nodes = nodes || this.catalog;
      for (var i = 0; i < nodes.length; i++) {
        if (nodes[i].id === id) return nodes[i];
        var hit = this.findCatalogNode(id, nodes[i].children || []);
        if (hit) return hit;
      }
      return null;
    },
    // 收集节点及其全部后代 id（含自身；删除子树前用于本地解绑模型）
    catalogSubtreeIds: function (id) {
      var out = [id];
      var node = this.findCatalogNode(id);
      (function walk(nodes) {
        (nodes || []).forEach(function (n) {
          out.push(n.id);
          walk(n.children || []);
        });
      })(node ? node.children : []);
      return out;
    },
    // L2/L3 节点扁平列表（路径形如 "财务域 / 应收 / 发票"），供业务归属下拉
    catalogFlat: function () {
      var out = [];
      (function walk(nodes, path) {
        (nodes || []).forEach(function (n) {
          var label = n.cnName || n.name;
          var p = path.concat(label);
          out.push({ id: n.id, level: n.level, name: n.name, cnName: n.cnName, path: p.join(' / ') });
          walk(n.children || [], p);
        });
      })(this.catalog, []);
      return out;
    },

    // ---------- 项目元信息 / 新建 ----------
    // 顶栏项目名 / 方言变更 → 同步服务端 projects 行
    updateProjectMeta: function (fields) {
      var self = this;
      return fetch('/api/projects/' + this.projectId, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(fields)
      }).then(function (r) {
        return r.json().then(function (d) {
          if (!r.ok) throw new Error(d && d.error || ('http ' + r.status));
          return d;
        });
      }).then(function (d) { self.refreshProjects(); return d; });
    },
    // 新建项目：POST 成功后刷新项目列表缓存，返回 {ok, project}（kind: 'oltp'|'olap'，缺省 olap）
    createProject: function (name, dialect, kind) {
      var self = this;
      return fetch('/api/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name, dialect: dialect, kind: kind || 'olap' })
      }).then(function (r) {
        return r.json().then(function (d) {
          if (!r.ok) throw new Error(d && d.error || ('http ' + r.status));
          return d;
        });
      }).then(function (d) { return self.refreshProjects().then(function () { return d; }); });
    },

    // 实体推送到数仓：把 oltp 实体转换为 ODS 贴源模型写入目标 olap 项目
    pushToOds: function (modelIds, targetProjectId, targetCatalogId) {
      return fetch('/api/push-to-ods', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          projectId: this.projectId,
          modelIds: modelIds,
          targetProjectId: targetProjectId,
          targetCatalogId: targetCatalogId || ''
        })
      }).then(function (r) {
        return r.json().then(function (d) {
          if (!r.ok) throw new Error(d && d.error || ('http ' + r.status));
          return d;
        });
      });
    },

    // ---------- 目录树 CRUD（服务端为准，改完重拉树并广播） ----------
    createCatalogNode: function (parentId, level, name, cnName) {
      var self = this;
      return fetch('/api/catalog', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId: this.projectId, parentId: parentId || '', level: level, name: name, cnName: cnName })
      }).then(function (r) {
        return r.json().then(function (d) {
          if (!r.ok) throw new Error(d && d.error || ('http ' + r.status));
          return d;
        });
      }).then(function (d) {
        return self.loadCatalog().then(function () { self.emit(); return d; });
      });
    },
    renameCatalogNode: function (id, name, cnName) {
      var self = this;
      return fetch('/api/catalog/' + encodeURIComponent(id), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name, cnName: cnName })
      }).then(function (r) {
        return r.json().then(function (d) {
          if (!r.ok) throw new Error(d && d.error || ('http ' + r.status));
          return d;
        });
      }).then(function (d) {
        return self.loadCatalog().then(function () { self.emit(); return d; });
      });
    },
    deleteCatalogNode: function (id) {
      var self = this;
      var ids = this.catalogSubtreeIds(id); // 含自身，先算好（删除后树里就找不到了）
      return fetch('/api/catalog/' + encodeURIComponent(id), { method: 'DELETE' }).then(function (r) {
        return r.json().then(function (d) {
          if (!r.ok) throw new Error(d && d.error || ('http ' + r.status));
          return d;
        });
      }).then(function (d) {
        // 服务端已把子树内模型的 catalog_id 置空，本地同步解绑（未保存的编辑不丢）
        self.project.models.forEach(function (m) {
          if (m.catalogId && ids.indexOf(String(m.catalogId)) >= 0) delete m.catalogId;
        });
        self.autosave();
        return self.loadCatalog().then(function () { self.emit(); return d; });
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
    // 所有编辑（字段、分层、业务域绑定、结构增删）都会落两处：
    //   1) localStorage 立即缓存（请求失败时也不丢当前会话）
    //   2) 服务端 SQLite：防抖 500ms 合并后 PUT /api/project
    // 历史 bug：编辑只写 localStorage，刷新时被服务端数据覆盖，表现为「绑定后又变回去」
    _persistLocal: function () {
      try { localStorage.setItem(LS_KEY, JSON.stringify(this.project)); } catch (e) { }
    },
    _setSaveState: function (state, msg) {
      this.saveState = state;
      this.saveStateMsg = msg || '';
      if (state === 'saved') {
        var d = new Date();
        var p2 = function (n) { return ('0' + n).slice(-2); };
        this.lastSavedAt = p2(d.getHours()) + ':' + p2(d.getMinutes()) + ':' + p2(d.getSeconds());
      }
      this.saveStateListeners.forEach(function (fn) { try { fn(state, msg); } catch (e) { } });
    },
    autosave: function () {
      this._persistLocal();
      this.scheduleSave();
    },
    // 防抖：连续输入合并成一次 PUT
    scheduleSave: function () {
      if (!this.serverOnline || !this.project) return;
      var self = this;
      if (this._saveTimer) clearTimeout(this._saveTimer);
      this._saveTimer = setTimeout(function () {
        self._saveTimer = null;
        self.flushSave().catch(function () { });
      }, 300);
    },
    // 立即落库：结构变更、业务域绑定、切换项目、手动保存时调用。串行执行，期间变更排队重发。
    flushSave: function () {
      var self = this;
      if (this._saveTimer) { clearTimeout(this._saveTimer); this._saveTimer = null; }
      if (!this.serverOnline || !this.project) { this._setSaveState('local'); return Promise.resolve('local'); }
      if (this._saving) { this._saveQueued = true; return this._saving; }
      var pid = this.projectId;
      var body = JSON.stringify(this.project, null, 2);
      this._setSaveState('saving');
      var req = fetch('/api/project?projectId=' + pid, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: body
      }).then(function (r) {
        if (!r.ok) throw new Error('http ' + r.status);
        self.serverOnline = true;
        self._setSaveState('saved');
        return 'ok';
      }, function (e) {
        self._setSaveState('error', e && e.message);
        throw e;
      });
      this._saving = req.then(function (v) {
        self._saving = null;
        if (self._saveQueued) { self._saveQueued = false; return self.flushSave(); }
        return v;
      }, function (e) {
        self._saving = null;
        if (self._saveQueued) { self._saveQueued = false; self.flushSave().catch(function () { }); }
        throw e;
      });
      return this._saving;
    },
    saveToServer: function () {
      this._persistLocal();
      return this.flushSave();
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
        id: this.newId(), layer: this.isOLTP() ? 'entity' : (layer || 'ods'),
        name: '', cnName: '', desc: '', source: '', notes: '',
        fields: [], partition: [], sources: [], where: '', groupBy: ''
      };
      if (this.isOLTP()) m.indexes = []; // oltp 实体：索引卡片
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

  // 页面刷新/关闭时若还有未发出的待写入改动，用 keepalive 请求抢救一次
  // （常规路径是 400ms 防抖 PUT；这里只覆盖「改完立即刷新」的窗口）
  if (typeof window !== 'undefined' && window.addEventListener) {
    window.addEventListener('pagehide', function () {
      if (!Store._saveTimer || !Store.project || !Store.serverOnline) return;
      clearTimeout(Store._saveTimer);
      Store._saveTimer = null;
      Store._persistLocal();
      try {
        fetch('/api/project?projectId=' + Store.projectId, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(Store.project),
          keepalive: true
        }).catch(function () { });
      } catch (e) { }
    });
  }

  root.Store = Store;
})(typeof globalThis !== 'undefined' ? globalThis : this);
