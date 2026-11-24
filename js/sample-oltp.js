/**
 * OLTP 示例项目：电商业务库（实体 / ER 图 / 外键 / 索引 / 业务目录）
 * 与 OLAP 示例（sample.js）互补，展示业务库建模形态。
 * catalogIds 里的键在安装时由前端替换为服务端生成的真实节点 id。
 */
(function (root) {
  'use strict';

  var OLTP_SAMPLE = {
    name: '电商业务库（示例）',
    dialect: 'mysql',
    kind: 'oltp',
    // 目录树：L1 业务域 → L2 模块；实体通过 catalogKey 挂载（安装时映射）
    catalog: [
      { key: 'c_trade', level: 1, name: 'trade', cnName: '交易域' },
      { key: 'c_user', level: 1, name: 'user', cnName: '用户域' },
      { key: 'c_trade_order', parent: 'c_trade', level: 2, name: 'order', cnName: '订单模块' },
      { key: 'c_trade_sku', parent: 'c_trade', level: 2, name: 'sku', cnName: '商品模块' },
      { key: 'c_user_org', parent: 'c_user', level: 2, name: 'org', cnName: '组织模块' }
    ],
    models: [
      {
        id: 'e_dept', layer: 'entity', catalogKey: 'c_user_org',
        name: 'dept_info', cnName: '部门', desc: '组织架构部门',
        fields: [
          { name: 'id', type: 'bigint', comment: '部门ID', pk: true, nullable: false },
          { name: 'dept_name', type: 'varchar(64)', comment: '部门名称', nullable: false },
          { name: 'parent_id', type: 'bigint', comment: '上级部门（自关联）', fk: 'dept_info.id' },
          { name: 'status', type: 'tinyint', comment: '状态 1正常 0停用', default: '1', nullable: false }
        ],
        indexes: [{ name: 'idx_dept_parent', fields: ['parent_id'], unique: false }],
        sources: [], partition: []
      },
      {
        id: 'e_user', layer: 'entity', catalogKey: 'c_user_org',
        name: 'user_info', cnName: '用户', desc: 'C 端注册用户',
        fields: [
          { name: 'id', type: 'bigint', comment: '用户ID', pk: true, nullable: false },
          { name: 'dept_id', type: 'bigint', comment: '所属部门（内部员工运营账号）', fk: 'dept_info.id' },
          { name: 'username', type: 'varchar(32)', comment: '登录名', nullable: false },
          { name: 'email', type: 'varchar(128)', comment: '邮箱（唯一）', unique: true, nullable: false },
          { name: 'status', type: 'tinyint', comment: '状态', default: '1', nullable: false },
          { name: 'created_at', type: 'datetime', comment: '注册时间', default: 'CURRENT_TIMESTAMP', nullable: false }
        ],
        indexes: [{ name: 'idx_user_dept_status', fields: ['dept_id', 'status'], unique: false }],
        sources: [], partition: []
      },
      {
        id: 'e_sku', layer: 'entity', catalogKey: 'c_trade_sku',
        name: 'sku_info', cnName: '商品', desc: '在售商品 SKU',
        fields: [
          { name: 'id', type: 'bigint', comment: '商品ID', pk: true, nullable: false },
          { name: 'sku_name', type: 'varchar(128)', comment: '商品名称', nullable: false },
          { name: 'price', type: 'decimal(18,2)', comment: '售价', nullable: false },
          { name: 'stock', type: 'int', comment: '库存', default: '0', nullable: false }
        ],
        indexes: [{ name: 'uk_sku_name', fields: ['sku_name'], unique: true }],
        sources: [], partition: []
      },
      {
        id: 'e_order', layer: 'entity', catalogKey: 'c_trade_order',
        name: 'order_info', cnName: '订单', desc: '订单主表',
        fields: [
          { name: 'id', type: 'bigint', comment: '订单ID', pk: true, nullable: false },
          { name: 'user_id', type: 'bigint', comment: '下单用户', fk: 'user_info.id', nullable: false },
          { name: 'order_status', type: 'tinyint', comment: '订单状态', default: '0', nullable: false },
          { name: 'total_amount', type: 'decimal(18,2)', comment: '订单总额', nullable: false },
          { name: 'created_at', type: 'datetime', comment: '下单时间', default: 'CURRENT_TIMESTAMP', nullable: false }
        ],
        indexes: [{ name: 'idx_order_user_status', fields: ['user_id', 'order_status'], unique: false }],
        sources: [], partition: []
      },
      {
        id: 'e_order_item', layer: 'entity', catalogKey: 'c_trade_order',
        name: 'order_item', cnName: '订单明细', desc: '订单-商品关联（N:N 中间表）',
        fields: [
          { name: 'id', type: 'bigint', comment: '明细ID', pk: true, nullable: false },
          { name: 'order_id', type: 'bigint', comment: '所属订单', fk: 'order_info.id', nullable: false },
          { name: 'sku_id', type: 'bigint', comment: '商品', fk: 'sku_info.id', nullable: false },
          { name: 'quantity', type: 'int', comment: '数量', default: '1', nullable: false },
          { name: 'deal_price', type: 'decimal(18,2)', comment: '成交单价', nullable: false }
        ],
        indexes: [{ name: 'idx_item_order', fields: ['order_id'], unique: false }, { name: 'idx_item_sku', fields: ['sku_id'], unique: false }],
        sources: [], partition: []
      }
    ]
  };

  root.OLTP_SAMPLE = OLTP_SAMPLE;
})(typeof globalThis !== 'undefined' ? globalThis : this);
