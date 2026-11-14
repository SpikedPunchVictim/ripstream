The binary files in files/ are small test documents committed in the xberg repository (tests/fixtures/office/ and tests/fixtures/ppt/),
copied unmodified:
xberg (https://github.com/xberg-io/xberg), MIT License, Copyright (c) 2025-2026 Kreuzberg, Inc.
The MIT permission notice ships with xberg's LICENSE file: permission is granted, free of charge, to use, copy, modify, merge, publish,
distribute, sublicense and/or sell copies, provided the copyright notice and permission notice are included in all copies or substantial portions.
xberg does not record where each file originally came from (several were generated with python-docx, openpyxl or LibreOffice);
they are used here under xberg's MIT licence. Expectations in the matching *.json fixtures follow xberg's test assertions
(doc_cjk_text.rs, doc_subdocuments.rs, doc_floating_picture.rs, docx_word_footnote_ids.rs, docx_merged_cells.rs, pptx_merged_cells.rs,
xlsx_merged_cells.rs, xlsx_date_time_cells.rs, issue_1660_ppt_embedded_ole_objects.rs), reduced to text-level checks.
All other fixtures in this directory (docx, pptx, odt) are synthesised by this repository's authors from the cases in xberg's Rust tests;
they contain no xberg bytes. Sizes in bytes:

  date_time_cells.xlsx                          5088  sha256 97fa11191353a0b9721e5a9339daeb26bfcb358cef2dbad6aaab2b72d4be1466
  doc_cjk_text.doc                              9216  sha256 1defaab1a19b67c5b8d984c888f2cb6e7a62d117b399399f6ce46871b9107217
  doc_floating_picture.doc                     54784  sha256 4f513c8a4cb562880efbc8c5db6da3c4c73a6c056b6c876302490728c9f121c4
  doc_subdocuments.doc                         11776  sha256 31acdead2d9be471024d4d9ea25f8da76007e719c63bab7f340875425a2de4f4
  embedded_word_object.ppt                     36864  sha256 420b98721675ea66626fe4a5f598675ee0f1074101de2a33f31a1f94eb5406f1
  merged_cells.docx                            36764  sha256 16b9fc3722f88ca322b7c435ef50c510e0f91d4adb55375da618d93de4c29ed5
  merged_header.xlsx                            4923  sha256 6a7511ae22d4cc1f5e5b715e7d516edb81b3673923e28eed71f51150b582fe98
  merged_table.pptx                            28455  sha256 3e050ca72b82c3b7256a8f05f1c866719d155215a7212356e4e04448a7cb9e75
  native_tables.ppt                            18432  sha256 0ddf0e4690b947b3eebf9bef8c1371873961ffc78f47a676ef8f71a07814061f
  word_footnote_ids.docx                       37305  sha256 7151aaa977ba7fcb36d5767b30e2886b2667c358d42b8f587c56fe9ba3d26ec5
