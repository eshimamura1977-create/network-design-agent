"""Read-only QA of browser-generated Office files (not Office layout validation)."""
import io
import zipfile
from pathlib import Path
from xml.etree import ElementTree as ET
from docx import Document
from openpyxl import load_workbook

root = Path(__file__).resolve().parents[1] / 'data/offline-qa'
with zipfile.ZipFile(root / 'sample.zip') as outer:
    assert outer.testzip() is None
    for name in outer.namelist():
        if not name.endswith(('.docx', '.xlsx', '.vsdx')):
            continue
        raw = outer.read(name)
        with zipfile.ZipFile(io.BytesIO(raw)) as inner:
            assert inner.testzip() is None
            for part in inner.namelist():
                if part.endswith(('.xml', '.rels')):
                    ET.fromstring(inner.read(part))
        if name.endswith('.docx'):
            doc = Document(io.BytesIO(raw))
            assert any('要レビュー' in p.text for p in doc.paragraphs), name
            assert len(doc.paragraphs) > 5, name
        if name.endswith('.xlsx'):
            wb = load_workbook(io.BytesIO(raw))
            assert all(ws.freeze_panes == 'A2' for ws in wb.worksheets), name
            if name.startswith('03'):
                assert wb['機器台帳']['B2'].value == 'CTR-RT01'
                assert wb['機器台帳']['F2'].value == '10.0.99.11'
                assert len(wb.sheetnames) == 20
            if name.startswith('08'):
                assert wb.active['I2'].value == '未実施'
            wb.close()
        (root / name).write_bytes(raw)
        print('OK', name)
formula = load_workbook(root / 'formula.xlsx')
assert formula.active['A2'].data_type == 's'
assert formula.active['A2'].value.startswith('=HYPERLINK')
formula.close()
print('Office package/readback checks passed. Native Office visual QA is separate.')
