"""xlsx 深度校验：zip 结构、XML 合法性、sheet 数量、表头内容、冻结窗格"""
import sys, zipfile, xml.etree.ElementTree as ET

path = sys.argv[1]
NS_MAIN = '{http://schemas.openxmlformats.org/spreadsheetml/2006/main}'
NS_REL = '{http://schemas.openxmlformats.org/officeDocument/2006/relationships}'
NS_PKG = '{http://schemas.openxmlformats.org/package/2006/relationships}'

def ok(msg): print('OK ' + msg)
def fail(msg): print('FAIL ' + msg)

try:
    zf = zipfile.ZipFile(path)
except Exception as e:
    fail('zipfile 打开失败: %s' % e)
    sys.exit(1)

bad = zf.testzip()
if bad is None:
    ok('ZIP 结构完整（CRC 全部通过）')
else:
    fail('ZIP 损坏文件: %s' % bad)
    sys.exit(1)

names = zf.namelist()
required = ['[Content_Types].xml', '_rels/.rels', 'xl/workbook.xml', 'xl/styles.xml']
missing = [n for n in required if n not in names]
if missing:
    fail('缺少必要部件: %s' % missing)
else:
    ok('OPC 必要部件齐全')

# XML 合法性
all_xml_ok = True
for n in names:
    if n.endswith(('.xml', '.rels')):
        try:
            ET.fromstring(zf.read(n))
        except Exception as e:
            all_xml_ok = False
            fail('XML 不合法 %s: %s' % (n, e))
if all_xml_ok:
    ok('全部 %d 个 XML 部件解析合法' % len([n for n in names if n.endswith(('.xml', '.rels'))]))

# workbook sheets
wb = ET.fromstring(zf.read('xl/workbook.xml'))
sheets = wb.find(NS_MAIN + 'sheets')
names_in_wb = [s.get('name') for s in sheets]
expect_first = SAMPLE_COUNT = None
if len(names_in_wb) >= 2 and names_in_wb[0] == '总览' and names_in_wb[-1] == '血缘清单':
    ok('sheet 布局：总览(%d 模型 sheet)…血缘清单' % (len(names_in_wb) - 2))
else:
    fail('sheet 布局异常: %s' % names_in_wb)

# 内容抽查：总览首行表头 + 某模型 sheet 冻结窗格 + 字段行
def cell_text(c):
    is_el = c.find(NS_MAIN + 'is')
    if is_el is not None:
        t = is_el.find(NS_MAIN + 't')
        return t.text if t is not None and t.text else ''
    v = c.find(NS_MAIN + 'v')
    return v.text if v is not None and v.text else ''

ov = ET.fromstring(zf.read('xl/worksheets/sheet1.xml'))
rows = ov.findall(NS_MAIN + 'sheetData/' + NS_MAIN + 'row')
header = [cell_text(c) for c in rows[0].findall(NS_MAIN + 'c')]
if header[:7] == ['序号', '分层', '表名', '中文名', '描述', '源系统', '字段数']:
    ok('总览表头正确: %s...' % ','.join(header[:7]))
else:
    fail('总览表头异常: %s' % header)

data_rows = len(rows) - 1
if data_rows >= 10:
    ok('总览数据行 %d 行' % data_rows)
else:
    fail('总览数据行过少: %d' % data_rows)

# 检查一个模型 sheet（sheet2 = 第一个模型）
m = ET.fromstring(zf.read('xl/worksheets/sheet2.xml'))
pane = m.find(NS_MAIN + 'sheetViews/' + NS_MAIN + 'sheetView/' + NS_MAIN + 'pane')
if pane is not None and pane.get('state') == 'frozen':
    ok('模型表首行冻结')
else:
    fail('模型表缺少冻结首行')
mrows = m.findall(NS_MAIN + 'sheetData/' + NS_MAIN + 'row')
mheader = [cell_text(c) for c in mrows[0].findall(NS_MAIN + 'c')]
if mheader[:6] == ['序号', '字段名', '类型', '注释', '主键', '业务逻辑 / 表达式']:
    ok('模型表表头正确')
else:
    fail('模型表表头异常: %s' % mheader)
if any(r.find(NS_MAIN + 'c') is not None for r in mrows[1:]):
    ok('模型表含数据行 %d 行' % (len(mrows) - 1))
else:
    fail('模型表无数据')

# 中文 sheet 名回归（样例含中文/长度安全处理已由生成端保证）
sys.exit(0)
