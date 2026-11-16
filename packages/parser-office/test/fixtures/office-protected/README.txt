Encrypted OOXML fixtures from nolze/msoffcrypto-tool (MIT), tests/inputs/:
ecma376agile_sha1_password.xlsx, ecma376standard_password.docx, example_password.docx, example_password.xlsx.
Their password is "Password1234_" (the repository's test constant). They are used only to verify ECMA-376 standard/agile
decryption and are not modified.

standard_password.pptx (40,960 bytes) is not from msoffcrypto-tool and not written by Office: it is segments/files/deck.pptx of the parsers
fixtures encrypted with the standard scheme (AES-128, password "Password1234_") from MS-OFFCRYPTO with node:crypto, in an OLE2
container; make-pptx.ts regenerates it byte for byte. Tika 4.2.0 with no password: tk:encrypted=true, "EncryptedDocumentException:
Unable to process: document is encrypted" (tikajs-2gsr).
