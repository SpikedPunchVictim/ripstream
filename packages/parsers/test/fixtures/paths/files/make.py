"""Regenerates the binary inputs of the paths fixtures: python3 make.py (standard library only)."""
import io
import struct
import tarfile
import zipfile
import zlib

FIXED = (2026, 1, 1, 0, 0, 0)


def zip_bytes(entries):
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        for name, data in entries:
            info = zipfile.ZipInfo(name, FIXED)
            info.compress_type = zipfile.ZIP_DEFLATED
            z.writestr(info, data)
    return buf.getvalue()


def png():
    def chunk(kind, data):
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)
    header = struct.pack(">IIBBBBB", 1, 1, 8, 2, 0, 0, 0)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", header) + chunk(b"IDAT", zlib.compress(b"\x00\xff\x00\x00")) + chunk(b"IEND", b"")


RELS = "http://schemas.openxmlformats.org/package/2006/relationships"
OFFICE = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"


def docx_with_image():
    document = (
        f'<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="{W}" xmlns:r="{OFFICE}"'
        ' xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"'
        ' xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"'
        ' xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><w:body>'
        "<w:p><w:r><w:t>Report with a picture</w:t></w:r></w:p>"
        '<w:p><w:r><w:drawing><wp:inline><wp:extent cx="12700" cy="12700"/><wp:docPr id="1" name="Picture 1"/>'
        '<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic>'
        '<pic:nvPicPr><pic:cNvPr id="0" name="pixel.png"/><pic:cNvPicPr/></pic:nvPicPr>'
        '<pic:blipFill><a:blip r:embed="rId1"/></pic:blipFill><pic:spPr/></pic:pic></a:graphicData></a:graphic>'
        "</wp:inline></w:drawing></w:r></w:p></w:body></w:document>"
    )
    return zip_bytes([
        ("[Content_Types].xml",
         '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
         '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
         '<Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/>'
         '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
         "</Types>"),
        ("_rels/.rels", f'<?xml version="1.0"?><Relationships xmlns="{RELS}"><Relationship Id="rId1" Type="{OFFICE}/officeDocument" Target="word/document.xml"/></Relationships>'),
        ("word/document.xml", document),
        ("word/_rels/document.xml.rels", f'<?xml version="1.0"?><Relationships xmlns="{RELS}"><Relationship Id="rId1" Type="{OFFICE}/image" Target="media/image1.png"/></Relationships>'),
        ("word/media/image1.png", png()),
    ])


inner = zip_bytes([("data/export-0.csv", b"name,tax_id\nann,PLANTED-INNER-0002\n")])
with open("zip-000.zip", "wb") as f:
    f.write(zip_bytes([("data/export-0.csv", b"name,tax_id\nbob,PLANTED-ZIP-0001\n"), ("nested/inner.zip", inner)]))

buf = io.BytesIO()
with tarfile.open(fileobj=buf, mode="w", format=tarfile.USTAR_FORMAT) as tar:
    data = b"name,tax_id\ncy,PLANTED-TAR-0003\n"
    info = tarfile.TarInfo("data/export-0.csv")
    info.size, info.mtime, info.mode = len(data), 1767225600, 0o644
    tar.addfile(info, io.BytesIO(data))
with open("tar-000.tar", "wb") as f:
    f.write(buf.getvalue())

with open("bundle-docx.zip", "wb") as f:
    f.write(zip_bytes([("docs/report.docx", docx_with_image())]))
