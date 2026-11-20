/**
 * 示例项目：电商交易数仓（ODS→DWD→DWS→ADS 全链路）
 */
(function (root) {
  'use strict';
  var SAMPLE = {
    name: '电商交易数仓（示例）',
    dialect: 'hive',
    customCols: {
      model: [{ key: 'x_owner', label: '责任人' }, { key: 'x_domain', label: '主题域' }],
      field: [{ key: 'x_sensitivity', label: '敏感等级' }]
    },
    models: [
      {
        id: 'm_ods_order', layer: 'ods', name: 'ods_order_info', cnName: '订单主表（贴源）',
        desc: '同步自业务库订单主表，保留原始字段，按天分区', source: 'mysql://shop.business/orders',
        notes: '每日凌晨全量+增量同步；不做任何清洗转换，字段与源系统一致。',
        fields: [
          { name: 'id', type: 'bigint', comment: '订单ID（源主键）', pk: true, expr: '' },
          { name: 'user_id', type: 'bigint', comment: '下单用户ID', pk: false, expr: '' },
          { name: 'shop_id', type: 'bigint', comment: '店铺ID', pk: false, expr: '' },
          { name: 'order_status', type: 'string', comment: '订单状态码', pk: false, expr: '' },
          { name: 'total_amount', type: 'decimal(16,2)', comment: '订单总金额', pk: false, expr: '' },
          { name: 'pay_amount', type: 'decimal(16,2)', comment: '实付金额', pk: false, expr: '' },
          { name: 'created_at', type: 'string', comment: '下单时间', pk: false, expr: '' },
          { name: 'updated_at', type: 'string', comment: '状态更新时间', pk: false, expr: '' }
        ],
        partition: [{ name: 'dt', type: 'string', comment: '同步日期（天）', expr: '' }],
        sources: [], where: '', groupBy: ''
      },
      {
        id: 'm_ods_detail', layer: 'ods', name: 'ods_order_detail', cnName: '订单商品明细（贴源）',
        desc: '同步自业务库订单明细表', source: 'mysql://shop.business/order_detail',
        notes: '',
        fields: [
          { name: 'id', type: 'bigint', comment: '明细ID', pk: true, expr: '' },
          { name: 'order_id', type: 'bigint', comment: '订单ID', pk: false, expr: '' },
          { name: 'sku_id', type: 'bigint', comment: '商品SKU ID', pk: false, expr: '' },
          { name: 'sku_name', type: 'string', comment: '商品名称（快照）', pk: false, expr: '' },
          { name: 'sale_price', type: 'decimal(16,2)', comment: '成交单价', pk: false, expr: '' },
          { name: 'quantity', type: 'int', comment: '购买数量', pk: false, expr: '' },
          { name: 'created_at', type: 'string', comment: '创建时间', pk: false, expr: '' }
        ],
        partition: [{ name: 'dt', type: 'string', comment: '同步日期（天）', expr: '' }],
        sources: [], where: '', groupBy: ''
      },
      {
        id: 'm_ods_sku', layer: 'ods', name: 'ods_sku_info', cnName: '商品信息表（贴源）',
        desc: '同步自商品中心', source: 'mysql://shop.goods/sku_info',
        notes: '',
        fields: [
          { name: 'id', type: 'bigint', comment: 'SKU ID', pk: true, expr: '' },
          { name: 'sku_name', type: 'string', comment: '商品名称', pk: false, expr: '' },
          { name: 'category1', type: 'string', comment: '一级类目', pk: false, expr: '' },
          { name: 'category2', type: 'string', comment: '二级类目', pk: false, expr: '' },
          { name: 'brand', type: 'string', comment: '品牌', pk: false, expr: '' },
          { name: 'price', type: 'decimal(16,2)', comment: '挂牌价', pk: false, expr: '' }
        ],
        partition: [{ name: 'dt', type: 'string', comment: '快照日期（天）', expr: '' }],
        sources: [], where: '', groupBy: ''
      },
      {
        id: 'm_ods_user', layer: 'ods', name: 'ods_user_info', cnName: '用户信息表（贴源）',
        desc: '同步自用户中心', source: 'mysql://shop.user/user_info',
        notes: '',
        x_owner: '王五', x_domain: '用户',
        fields: [
          { name: 'id', type: 'bigint', comment: '用户ID', pk: true, expr: '' },
          { name: 'user_name', type: 'string', comment: '用户名', pk: false, expr: '' },
          { name: 'phone', type: 'string', comment: '手机号（脱敏存储）', pk: false, expr: '', x_sensitivity: 'L4 高敏' },
          { name: 'gender', type: 'string', comment: '性别', pk: false, expr: '' },
          { name: 'city', type: 'string', comment: '所在城市', pk: false, expr: '' },
          { name: 'register_time', type: 'string', comment: '注册时间', pk: false, expr: '' }
        ],
        partition: [{ name: 'dt', type: 'string', comment: '快照日期（天）', expr: '' }],
        sources: [], where: '', groupBy: ''
      },
      {
        id: 'm_dim_user', layer: 'dim', name: 'dim_user', cnName: '用户维度表',
        desc: '一致性用户维度，拉通用户属性供明细与分析层复用', source: '',
        notes: '维度表统一从这里取用户属性，避免 ADS 各表重复关联 ODS。',
        fields: [
          { name: 'user_id', type: 'bigint', comment: '用户ID', pk: true, expr: 'ui.id' },
          { name: 'user_name', type: 'string', comment: '用户名', pk: false, expr: 'ui.user_name' },
          { name: 'gender', type: 'string', comment: '性别', pk: false, expr: 'ui.gender' },
          { name: 'city', type: 'string', comment: '所在城市', pk: false, expr: 'ui.city' },
          { name: 'register_time', type: 'string', comment: '注册时间', pk: false, expr: 'ui.register_time' }
        ],
        partition: [{ name: 'dt', type: 'string', comment: '快照日期（天）', expr: 'ui.dt' }],
        sources: [{ name: 'ods_user_info', alias: 'ui', on: '' }], where: '', groupBy: ''
      },
      {
        id: 'm_dwd_order', layer: 'dwd', name: 'dwd_order_info_di', cnName: '订单明细事实表（清洗）',
        desc: '过滤无效订单，统一状态口径，金额空值处理',
        notes: '清洗规则：\n1. 过滤已取消/测试订单\n2. pay_amount 空值补 0\n3. 时间字段统一为标准格式',
        fields: [
          { name: 'order_id', type: 'bigint', comment: '订单ID', pk: true, expr: 'o.id' },
          { name: 'user_id', type: 'bigint', comment: '用户ID', pk: false, expr: 'o.user_id' },
          { name: 'shop_id', type: 'bigint', comment: '店铺ID', pk: false, expr: 'o.shop_id' },
          { name: 'order_status', type: 'string', comment: '订单状态', pk: false, expr: 'o.order_status' },
          { name: 'total_amount', type: 'decimal(16,2)', comment: '订单总金额', pk: false, expr: 'o.total_amount' },
          { name: 'pay_amount', type: 'decimal(16,2)', comment: '实付金额（空补0）', pk: false, expr: "if(o.pay_amount is null, 0, o.pay_amount)" },
          { name: 'create_time', type: 'string', comment: '下单时间', pk: false, expr: 'o.created_at' }
        ],
        partition: [{ name: 'dt', type: 'string', comment: '统计日期', expr: 'o.dt' }],
        sources: [{ name: 'ods_order_info', alias: 'o', on: '' }],
        where: "o.order_status in ('01','02','03','05','06')", groupBy: ''
      },
      {
        id: 'm_dwd_detail', layer: 'dwd', name: 'dwd_order_detail_di', cnName: '订单商品明细细事实表',
        desc: '关联商品快照补齐类目维度，计算行金额',
        notes: '',
        fields: [
          { name: 'id', type: 'bigint', comment: '明细ID', pk: true, expr: 'od.id' },
          { name: 'order_id', type: 'bigint', comment: '订单ID', pk: false, expr: 'od.order_id' },
          { name: 'sku_id', type: 'bigint', comment: 'SKU ID', pk: false, expr: 'od.sku_id' },
          { name: 'sku_name', type: 'string', comment: '商品名称（优先商品中心）', pk: false, expr: 'coalesce(s.sku_name, od.sku_name)' },
          { name: 'category1', type: 'string', comment: '一级类目', pk: false, expr: 's.category1' },
          { name: 'category2', type: 'string', comment: '二级类目', pk: false, expr: 's.category2' },
          { name: 'brand', type: 'string', comment: '品牌', pk: false, expr: 's.brand' },
          { name: 'sale_price', type: 'decimal(16,2)', comment: '成交单价', pk: false, expr: 'od.sale_price' },
          { name: 'quantity', type: 'int', comment: '数量', pk: false, expr: 'od.quantity' },
          { name: 'sale_amount', type: 'decimal(16,2)', comment: '行成交金额', pk: false, expr: 'od.sale_price * od.quantity' }
        ],
        partition: [{ name: 'dt', type: 'string', comment: '统计日期', expr: 'od.dt' }],
        sources: [
          { name: 'ods_order_detail', alias: 'od', on: '' },
          { name: 'ods_sku_info', alias: 's', on: 'od.sku_id = s.id' }
        ],
        where: 'od.quantity > 0', groupBy: ''
      },
      {
        id: 'm_dws_shop', layer: 'dws', name: 'dws_trade_shop_order_1d', cnName: '店铺交易日汇总表',
        desc: '按店铺+日汇总订单数、用户数、销售额',
        notes: '轻度聚合：保留 shop_id + dt 粒度',
        fields: [
          { name: 'shop_id', type: 'bigint', comment: '店铺ID', pk: true, expr: 'oi.shop_id' },
          { name: 'order_count', type: 'bigint', comment: '订单数', pk: false, expr: 'count(distinct oi.order_id)' },
          { name: 'user_count', type: 'bigint', comment: '下单用户数', pk: false, expr: 'count(distinct oi.user_id)' },
          { name: 'sale_amount', type: 'decimal(18,2)', comment: '销售额', pk: false, expr: 'sum(de.sale_amount)' },
          { name: 'avg_pay_amount', type: 'decimal(18,2)', comment: '笔均实付', pk: false, expr: 'avg(oi.pay_amount)' }
        ],
        partition: [{ name: 'dt', type: 'string', comment: '统计日期', expr: 'oi.dt' }],
        sources: [
          { name: 'dwd_order_info_di', alias: 'oi', on: '' },
          { name: 'dwd_order_detail_di', alias: 'de', on: 'oi.order_id = de.order_id and oi.dt = de.dt' }
        ],
        where: '', groupBy: 'oi.shop_id, oi.dt'
      },
      {
        id: 'm_dws_user', layer: 'dws', name: 'dws_user_buy_1d', cnName: '用户购买日汇总表',
        desc: '按用户+日汇总购买行为',
        notes: '',
        fields: [
          { name: 'user_id', type: 'bigint', comment: '用户ID', pk: true, expr: 'oi.user_id' },
          { name: 'order_count', type: 'bigint', comment: '订单数', pk: false, expr: 'count(distinct oi.order_id)' },
          { name: 'pay_amount', type: 'decimal(18,2)', comment: '支付总额', pk: false, expr: 'sum(oi.pay_amount)' },
          { name: 'first_order_time', type: 'string', comment: '当日首单时间', pk: false, expr: 'min(oi.create_time)' }
        ],
        partition: [{ name: 'dt', type: 'string', comment: '统计日期', expr: 'oi.dt' }],
        sources: [{ name: 'dwd_order_info_di', alias: 'oi', on: '' }],
        where: '', groupBy: 'oi.user_id, oi.dt'
      },
      {
        id: 'm_ads_total', layer: 'ads', name: 'ads_trade_total_1d', cnName: '交易大盘日指标',
        desc: '面向报表/看板的交易总览指标',
        notes: '供 BI 看板直接消费',
        fields: [
          { name: 'order_count', type: 'bigint', comment: '总订单数', pk: false, expr: 'sum(t.order_count)' },
          { name: 'user_count', type: 'bigint', comment: '活跃店铺数', pk: false, expr: 'count(distinct t.shop_id)' },
          { name: 'sale_amount', type: 'decimal(18,2)', comment: '总销售额', pk: false, expr: 'sum(t.sale_amount)' }
        ],
        partition: [{ name: 'dt', type: 'string', comment: '统计日期', expr: 't.dt' }],
        sources: [{ name: 'dws_trade_shop_order_1d', alias: 't', on: '' }],
        where: '', groupBy: 't.dt'
      },
      {
        id: 'm_ads_user', layer: 'ads', name: 'ads_user_buy_stats', cnName: '用户购买统计（累积）',
        desc: '用户累计消费指标，供用户画像/营销使用',
        notes: '',
        fields: [
          { name: 'user_id', type: 'bigint', comment: '用户ID', pk: true, expr: 'u.user_id' },
          { name: 'total_order_count', type: 'bigint', comment: '累计订单数', pk: false, expr: 'sum(u.order_count)' },
          { name: 'total_pay_amount', type: 'decimal(18,2)', comment: '累计消费金额', pk: false, expr: 'sum(u.pay_amount)' },
          { name: 'city', type: 'string', comment: '用户城市（关联用户表）', pk: false, expr: 'ui.city' }
        ],
        partition: [{ name: 'dt', type: 'string', comment: '统计日期', expr: 'u.dt' }],
        sources: [
          { name: 'dws_user_buy_1d', alias: 'u', on: '' },
          { name: 'dim_user', alias: 'ui', on: 'u.user_id = ui.user_id' }
        ],
        where: '', groupBy: 'u.user_id, ui.city, u.dt'
      }
    ]
  };
  root.SAMPLE = SAMPLE;
})(typeof globalThis !== 'undefined' ? globalThis : this);
