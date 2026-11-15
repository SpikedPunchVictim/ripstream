"""Regenerates the inputs of the segments fixtures: python3 make.py (needs openpyxl, python-docx, python-pptx).

Every planted value is a unique PLANTED-* string at a known place; the fixtures assert the labels and location of the
segment that holds it.
"""
import datetime
import io
import json
import re
import zipfile

import docx
import openpyxl
from pptx import Presentation
from pptx.util import Inches

FIXED = datetime.datetime(2026, 1, 1)


def normalize_zip(path):
    """Rewrites a zip with fixed timestamps and a fixed entry order, so a rerun gives the same bytes."""
    with zipfile.ZipFile(path) as src:
        entries = [(info.filename, src.read(info.filename)) for info in src.infolist()]
    # openpyxl stamps the save time over the modified date it was given.
    stamp = re.compile(rb"(<dcterms:(?:created|modified)[^>]*>)[^<]*(</dcterms:)")
    entries = [(name, stamp.sub(rb"\g<1>2026-01-01T00:00:00Z\g<2>", data) if name == "docProps/core.xml" else data)
               for name, data in entries]
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        for name, data in entries:
            info = zipfile.ZipInfo(name, (2026, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            z.writestr(info, data)
    with open(path, "wb") as f:
        f.write(buf.getvalue())


# --- xlsx: sheet Vendors, header row 1, C7 planted; sheet Notes, A3 planted under a header A1 ---------------------------
wb = openpyxl.Workbook()
ws = wb.active
ws.title = "Vendors"
ws.append(["Name", "Country", "Tax ID"])
for i in range(2, 9):
    ws.append([f"Vendor {i}", "NL", f"TAX-{i:04d}"])
ws["C7"] = "PLANTED-XLSX-C7"
ws["D5"] = 42.5  # a cell past the header: no column header
notes = wb.create_sheet("Notes")
notes["A1"] = "Comment"
notes["A3"] = "PLANTED-XLSX-NOTES-A3"
wb.properties.created = FIXED
wb.properties.modified = FIXED
wb.save("vendors.xlsx")
normalize_zip("vendors.xlsx")

# --- docx: headings, paragraphs, a table with a header row --------------------------------------------------------------
d = docx.Document()
d.add_heading("Customers", level=1)
d.add_paragraph("An introduction paragraph.")
d.add_heading("Banking", level=2)
d.add_paragraph("Account holder PLANTED-DOCX-PARA is on file.")
table = d.add_table(rows=4, cols=2)
for col, text in enumerate(["Name", "IBAN"]):
    table.cell(0, col).text = text
table.cell(1, 0).text = "Ann"
table.cell(1, 1).text = "NL00BANK0000000001"
table.cell(2, 0).text = "Bob"
table.cell(2, 1).text = "PLANTED-DOCX-TABLE"
table.cell(3, 0).text = "Cy"
table.cell(3, 1).text = "NL00BANK0000000003"
d.add_paragraph("Closing paragraph.")
d.core_properties.created = FIXED
d.core_properties.modified = FIXED
d.save("customers.docx")
normalize_zip("customers.docx")

# --- pptx: three slides, slide 3 has a planted body value and planted notes ---------------------------------------------
p = Presentation()
for index, title in enumerate(["Intro", "Agenda", "Secrets"], start=1):
    slide = p.slides.add_slide(p.slide_layouts[1])
    slide.shapes.title.text = title
    slide.placeholders[1].text = "PLANTED-PPTX-BODY" if index == 3 else f"Body of slide {index}"
    if index == 3:
        slide.notes_slide.notes_text_frame.text = "PLANTED-PPTX-NOTES"
        box = slide.shapes.add_textbox(Inches(1), Inches(5), Inches(4), Inches(1))
        box.name = "Footer Box"
        box.text_frame.text = "PLANTED-PPTX-TEXTBOX"
p.core_properties.created = FIXED
p.core_properties.modified = FIXED
p.save("deck.pptx")
normalize_zip("deck.pptx")

# --- odt: a heading, a paragraph, a table with a header row (written by hand: no ODF library needed) --------------------
ODT_CONTENT = """<?xml version="1.0" encoding="UTF-8"?>
<office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0"
 xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0"
 office:version="1.2"><office:body><office:text>
<text:h text:outline-level="1">Suppliers</text:h>
<text:p>Contact PLANTED-ODT-PARA for details.</text:p>
<table:table table:name="Table1"><table:table-column table:number-columns-repeated="2"/>
<table:table-row><table:table-cell><text:p>Name</text:p></table:table-cell><table:table-cell><text:p>Phone</text:p></table:table-cell></table:table-row>
<table:table-row><table:table-cell><text:p>Dee</text:p></table:table-cell><table:table-cell><text:p>PLANTED-ODT-TABLE</text:p></table:table-cell></table:table-row>
</table:table>
</office:text></office:body></office:document-content>
"""
ODT_MANIFEST = """<?xml version="1.0" encoding="UTF-8"?>
<manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0" manifest:version="1.2">
 <manifest:file-entry manifest:full-path="/" manifest:media-type="application/vnd.oasis.opendocument.text"/>
 <manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml"/>
</manifest:manifest>
"""
with zipfile.ZipFile("suppliers.odt", "w") as z:
    z.writestr(zipfile.ZipInfo("mimetype", (2026, 1, 1, 0, 0, 0)), "application/vnd.oasis.opendocument.text")
    for name, data in [("content.xml", ODT_CONTENT), ("META-INF/manifest.xml", ODT_MANIFEST)]:
        info = zipfile.ZipInfo(name, (2026, 1, 1, 0, 0, 0))
        info.compress_type = zipfile.ZIP_DEFLATED
        z.writestr(info, data)

# --- text formats -------------------------------------------------------------------------------------------------------
def write(name, text):
    with open(name, "w", encoding="utf-8", newline="") as f:
        f.write(text)


# Enough rows that the CSV is read as a table (a short one is read as plain lines).
rows = ["name,country,tax_id"] + [f"Customer {i},NL,NL{i:05d}" for i in range(2, 31)]
rows[11] = 'Customer 12,"Big, Co",PLANTED-CSV-ROW12'
write("customers.csv", "\n".join(rows) + "\n")

write("vendors.tsv", "name\tcountry\ttax_id\nAcme\tNL\tNL1\nZed\tFR\tPLANTED-TSV-R3C3\n")

# Not named .json: the fixture loader reads every .json under fixtures/ as a fixture (the fixture names the file).
write("customers.json.txt", json.dumps({
    "customers": [
        {"name": "Ann", "tax_id": "NL1"},
        {"name": "Bob", "tax_id": "PLANTED-JSON-TAX"},
    ],
    "meta": {"count": 2, "tags": ["a", "PLANTED-JSON-TAG"]},
}, indent=2) + "\n")

write("notes.md", "# Runbook\n\nIntro paragraph.\n\n## Secrets\n\nThe key is\nPLANTED-MD-KEY on two lines.\n\n```\ncode block\n```\n\nLast line PLANTED-MD-LAST\n")

write("app.log", "".join(f"2026-01-01T00:00:{i:02d}Z INFO request {i} ok\n" for i in range(1, 120))
      + "2026-01-01T00:02:00Z WARN token=PLANTED-LOG-L120\n")

write("page.html", """<!DOCTYPE html>
<html><head><title>Accounts</title></head><body>
<h1>Accounts</h1>
<p>Welcome, <b>PLANTED-HTML-P</b>.</p>
<h2>Balances</h2>
<table><tr><th>Name</th><th>Account</th></tr><tr><td>Ann</td><td>PLANTED-HTML-TD</td></tr></table>
<div id="footer"><span>PLANTED-HTML-FOOTER</span></div>
</body></html>
""")
