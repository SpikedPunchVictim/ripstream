Tika 4.2.0 oracle fixtures (bead tikajs-qw7f, second batch). Each fixture's expected Content-Type and text come from the Tika 4.2.0 server (container apache/tika:4.2.0,
PUT /rmeta/body with the file name as Content-Disposition; the same text as /tika/text), not from ripstream's output.
These fixtures fail today: ripstream differs from the oracle. Their description names the bead; move one to ../../../fixtures/xberg/oracle/<fmt>/ when it is fixed.
Inputs are copied unmodified from the xberg test corpus (https://github.com/xberg-io/xberg, test_documents), from its vendored subsets only, whose licences are permissive:
  docling: MIT, Copyright (c) 2024 International Business Machines (https://github.com/DS4SD/docling)
  unstructured: Apache License 2.0 (https://github.com/Unstructured-IO/unstructured)
  markitdown: MIT, Copyright (c) Microsoft Corporation (https://github.com/microsoft/markitdown)
  myst-nb: BSD 3-Clause, Copyright (c) 2020 ExecutableBookProject (https://github.com/executablebooks/MyST-NB)
Inputs the oracle answers with more than one record (an e-mail with attachments) are not here: ripstream's parse() text inlines embedded documents, Tika's /rmeta/body does not.
Suggested NOTICE entry: 'Test inputs adapted from xberg (MIT, Kreuzberg, Inc.), docling (MIT, IBM), unstructured (Apache-2.0), markitdown (MIT, Microsoft) and MyST-NB (BSD-3-Clause).' This file does not change NOTICE.

A JSON input is stored with the extension .input, because the fixture walker validates every .json file under its root; the fixture's filename field still names it as it was.
Files under files/ (source path in test_documents, size in bytes, sha256, cause):
  unstructured-test-iso-8601-date.eml  <- test_documents/vendored/unstructured/eml/test-iso-8601-date.eml  135  075625d098b578456bbf35d1f603ed11518fd531f403cc9105a432907ea5e24c  eml-trailing
  unstructured-test-rfc2822-date.eml  <- test_documents/vendored/unstructured/eml/test-rfc2822-date.eml  151  6756207d8ad2a459ed9ccd0e8335a9be1ca8e9a51ca6976b07cc53ab65be75c1  eml-trailing
  unstructured-mime-no-subject.eml  <- test_documents/vendored/unstructured/eml/mime-no-subject.eml  162  0fa470bf3467d0f561a402447640d7f7ff9526aa3b39d9e4f8a1aeee87e2e6c1  eml-trailing
  unstructured-rfc822-no-date.eml  <- test_documents/vendored/unstructured/eml/rfc822-no-date.eml  232  abece92894e91278391f6b8e96f0e2817cdca030076b8ebf8ed3a62cdd517d4c  eml-trailing
  unstructured-mime-no-to.eml  <- test_documents/vendored/unstructured/eml/mime-no-to.eml  264  adc994f48937a8c71b8ad7f7686bc6a4c68c3fef7af21c0f844f7d8ce01f14e5  eml-trailing
  unstructured-mime-simple.eml  <- test_documents/vendored/unstructured/eml/mime-simple.eml  452  990c658aa64b6fbd5c482b8424ca65bde764f380194050e58ffaebe09f2dad93  eml-trailing
  unstructured-fake-email.eml  <- test_documents/vendored/unstructured/eml/fake-email.eml  807  1c1c433ff5d0f5439f23336bb53c690b445095ed601523c6bf52162e91d6a9cb  eml-trailing
  unstructured-fake-email-header.eml  <- test_documents/vendored/unstructured/eml/fake-email-header.eml  1207  7e6d1f9998e690d58eff63754259a4a0d0d04bf33e26dab5a73cab322eb4aa97  eml-trailing
  unstructured-family-day.eml  <- test_documents/vendored/unstructured/eml/family-day.eml  1291  9766c9026f78e3f8f645a9fd541a4e5e1d5143048801641c5ebf1456a6d52730  eml-trailing
  unstructured-mime-different-plain-html.eml  <- test_documents/vendored/unstructured/eml/mime-different-plain-html.eml  1397  83794f939640428956fceae2a5ff2b0f7910869881fe8b990a491d326399be25  eml-trailing
  unstructured-fake-email-utf-16-be.eml  <- test_documents/vendored/unstructured/eml/fake-email-utf-16-be.eml  1614  4a32768db09f17c22b0a6f8eb0d620065e176103f75d2eeadcb6dc07f0c7e5f0  eml-utf16
  unstructured-fake-email-utf-16-le.eml  <- test_documents/vendored/unstructured/eml/fake-email-utf-16-le.eml  1614  6b44e55a96d15e7d7a53f0146a23d06d43bf8a7fe631a9de2c30efcfe8e6ce14  eml-utf16
  unstructured-email-no-html-content-1.eml  <- test_documents/vendored/unstructured/eml/email-no-html-content-1.eml  7721  2bf98c517395831e6d9ae25b43d8cd4946697fccc18ce304c42189d182b43399  eml-trailing
  unstructured-email-replace-mime-encodings-error-5.eml  <- test_documents/vendored/unstructured/eml/email-replace-mime-encodings-error-5.eml  14567  9a67b5b6b8f46a62d7e081dd9258c7eba15257780fa6f87b438c977eeb831878  eml-trailing
  unstructured-email-replace-mime-encodings-error-1.eml  <- test_documents/vendored/unstructured/eml/email-replace-mime-encodings-error-1.eml  16085  3ba135c81bfdcb41c7f7342ff7dc337de194386d4c9607c56c835a3ad12c8406  eml-trailing
  unstructured-email-replace-mime-encodings-error-4.eml  <- test_documents/vendored/unstructured/eml/email-replace-mime-encodings-error-4.eml  34433  7cb01667ff0bae89d9f4cf4c9c49d039113d9591433ad8064746640b9f933a8c  eml-trailing
  unstructured-email-replace-mime-encodings-error-3.eml  <- test_documents/vendored/unstructured/eml/email-replace-mime-encodings-error-3.eml  56028  fa25ebbac36b7add83bdd209f2e309ef274f0808b43e019d6ac5b34ecf132fa8  eml-trailing
  docling-table_with_heading_01.html.md  <- test_documents/vendored/docling/md/table_with_heading_01.html.md  83  0898a5e28e1f6a60ed6d245b28fd0b126a5c30bf5b49bf7e423c46d1140e0fe6  md-table
  docling-table_with_heading_02.html.md  <- test_documents/vendored/docling/md/table_with_heading_02.html.md  130  4e889d69beb8b81f41b23b12f37ad06ca3e7ec2ae345b86a36b3cb25bbfd571f  md-table
  docling-csv-comma-in-cell.csv.md  <- test_documents/vendored/docling/md/csv-comma-in-cell.csv.md  156  9409caf611bdd76600ca23b5c2523eca060bc7943e1914a07ba72eaf5f9dda39  md-table
  docling-example_02.html.md  <- test_documents/vendored/docling/md/example_02.html.md  241  32efc6ad979f30126e899a81bd0c4ef9ef899fe919d3e675c3c391b599ece2af  md-list
  docling-hyperlink_03.html.md  <- test_documents/vendored/docling/md/hyperlink_03.html.md  277  6488ddda0ac5a5b5ab3c34cfb870edad0343e3f3a95614b28d6e5a19127e9a51  md-list
  docling-test_01.asciidoc.md  <- test_documents/vendored/docling/md/test_01.asciidoc.md  360  3ff4cbb9db64642dea034ff8ebc2adcbd49d03ef11c706fc9a3c04bc0104a926  md-list
  docling-ending_with_table.md.md  <- test_documents/vendored/docling/md/ending_with_table.md.md  438  fb40f6194622028a9285de92cf7fbbeceaeeb2e3e329167144137ced3de2ae79  md-table
  docling-unit_test_lists.docx.md  <- test_documents/vendored/docling/md/unit_test_lists.docx.md  538  66abb6d10ccdf8995ca192d3251da3bd08aaa96357e8e0b3c71a7fb3a608fb3a  md-list
  docling-escaped_characters.md.md  <- test_documents/vendored/docling/md/escaped_characters.md.md  729  a26bd4f0f564c2f397a349af191b6d7e69c4e557cd36af2502b87b674ee47731  md-entities
  docling-duck.md.md  <- test_documents/vendored/docling/md/duck.md.md  1031  85fd2234adc16377447825c981d287edbb6550f5acb28774a8548c5ea1d213a3  md-list
  docling-right_to_left_03.md  <- test_documents/vendored/docling/md/right_to_left_03.md  1338  6fe91f56b5cc6cbd8b2850cf6e2b61596d9f63a7fa4fa4b0b3f14e1616744111  md-list
  docling-csv-semicolon.csv.md  <- test_documents/vendored/docling/md/csv-semicolon.csv.md  1848  647080d86911d1cad3ea02038f2867c41dfeca2765d4035ba28f24f864038f3c  md-table
  docling-embedded_images_tables.md  <- test_documents/vendored/docling/md/embedded_images_tables.md  2275  c5590b5763b2240a45e3a4888d589b33e9ed5e35e0f687de79a53490f9c39e87  md-charset
  docling-deepseek_example.md.md  <- test_documents/vendored/docling/md/deepseek_example.md.md  2918  b118997a37f3415f08e015938090d7c376ee02691177417829e975dd226738c2  md-entities
  docling-docling.md  <- test_documents/vendored/docling/md/docling.md  29179  be856fa92b35923738bc103e16cdc1ef1e89ed2d27c320cd6a1c1b69f0cac95c  md-list
  docling-2203.01017v2.md  <- test_documents/vendored/docling/md/2203.01017v2.md  54005  e7de19a6ef829041d3ded1cefcddc3f847c0375925e9d0aa60b30b77f63282ee  md-heading-number
  docling-csv-too-few-columns.csv  <- test_documents/vendored/docling/csv/csv-too-few-columns.csv  44  192be2a77124929ac1dc560b1dd178627ce681aad7fc3c10384d14ff967aabab  csv-crlf
  docling-csv-too-many-columns.csv  <- test_documents/vendored/docling/csv/csv-too-many-columns.csv  46  f87b302f0905323f6660e2deec90af183d77dfa8c45e05026f028b71e1dd2e1f  csv-crlf
  docling-csv-semicolon.csv  <- test_documents/vendored/docling/csv/csv-semicolon.csv  997  26912eaca8f5a50fb8c3e8f17c081e280f121759fae6e0c1e8ae1cfb5045c689  csv-crlf
  docling-csv-tab.csv  <- test_documents/vendored/docling/csv/csv-tab.csv  997  8071cda34f80e7690b00f4bbef6af7a96a86175c4d4ba1fb7f8d0f28593c3487  csv-crlf
  docling-csv-comma.csv  <- test_documents/vendored/docling/csv/csv-comma.csv  1005  0f3643115a0a1d4b748b93ad9ab2a02ad1fde6a7a9506ce90422792e17244824  csv-crlf
  markitdown-test_mskanji.csv  <- test_documents/vendored/markitdown/csv/test_mskanji.csv  70  184c3dbe4c92d80c0ffef7141dc2401d6ed2fed2e001d444dffb3c3414ce5ff9  sjis-detect
  markitdown-test_blog.html  <- test_documents/vendored/markitdown/html/test_blog.html  41310  6a52707b7faa4b15e151a89dca68f74885c3356d99ff58705f827dc3bfce7f2f  html-head-newlines
  myst-nb-basic_unrun.md  <- test_documents/vendored/executablebooks-myst-nb/basic_unrun.md  248  b03b173651637a8078447b35f96256c06f2d709854e5af4541753b5ff10c5cb4  md-frontmatter
  myst-nb-with_eval.md  <- test_documents/vendored/executablebooks-myst-nb/with_eval.md  1967  84d12b04fbe3d9c50a885c91e000860ed948cde55e72c503c887b6a04f86ff7a  md-frontmatter
  unstructured-factbook-utf-16.xml  <- test_documents/vendored/unstructured/xml/factbook-utf-16.xml  1341  ab617a7f7cc2790c77872651f993892233700cf0ac95a1f6b879f31a94c1cca0  xml-utf16-decl
  docling-gt-table_01.html.md  <- test_documents/vendored/docling/groundtruth/docling_v2/table_01.html.md  101  adc446310555ee02e35ce1bc075b98c726882c7f3417a31d6fc2f4407fb858bc  md-table
  docling-gt-tablecell.docx.md  <- test_documents/vendored/docling/groundtruth/docling_v2/tablecell.docx.md  152  65e8a8d68fc0ae88c7f15adb1d4567b9e71a73e9c5920434cb282005e3316f79  md-table
  docling-gt-list_after_num_headers.docx.md  <- test_documents/vendored/docling/groundtruth/docling_v2/list_after_num_headers.docx.md  164  08cd8f390d4a80299c5bb607182bde5efe3d0939ed47916726cdec0b763c1793  md-list
  docling-gt-table_02.html.md  <- test_documents/vendored/docling/groundtruth/docling_v2/table_02.html.md  233  2b03db5f9a6ebd17ebc581a1546de80d694334b019403d24f630c581167f1351  md-table
  docling-gt-example_01_images.html.md  <- test_documents/vendored/docling/groundtruth/docling_v2/example_01_images.html.md  356  4977decde05176e4d97d486e00df2845b6c4caf2244c7ed6f5ccfb08c182796c  md-list
  docling-gt-example_05.html.md  <- test_documents/vendored/docling/groundtruth/docling_v2/example_05.html.md  475  60f77560461c16cad9c5e368fdb023dc8ef0cd0324d03fab96056f0d6454c778  md-table
  docling-gt-powerpoint_issue_2663.pptx.md  <- test_documents/vendored/docling/groundtruth/docling_v2/powerpoint_issue_2663.pptx.md  635  a5a867b9b65302ac04a524ad9d8b9dd2e79b1707421780fa9e203c9677c3635a  md-list
  docling-gt-test_02.asciidoc.md  <- test_documents/vendored/docling/groundtruth/docling_v2/test_02.asciidoc.md  1885  235e8a5c1558c913a300816ecbb391689b8a7b31e141a14310b8ca17e130c721  md-list
  docling-gt-html_rich_table_cells.html.md  <- test_documents/vendored/docling/groundtruth/docling_v2/html_rich_table_cells.html.md  2867  4873653a362339f8888468ccc4c1e1c80f6717f93cfdaba20ebb0fe4629073f6  md-table
  docling-gt-2305.03393v1.md  <- test_documents/vendored/docling/groundtruth/docling_v2/2305.03393v1.md  32027  ac3d5d76685a3ba017bab241a8691af0230c871cd52b7a11e511ddf5a1605634  md-entities
  docling-gt-2206.01062.md  <- test_documents/vendored/docling/groundtruth/docling_v2/2206.01062.md  50911  876bc74fe0472ac13abe571a6e952754cc988ba6cdc36ed4392ba83d5a9057c6  md-list
  docling-gt-pone.0234687.nxml.md  <- test_documents/vendored/docling/groundtruth/docling_v2/pone.0234687.nxml.md  69414  d2032ba6bb3a8a3cedf3dabcedb346c257ba26e53276b5793e0827c65b343491  md-table
  docling-gt-elife-56337.nxml.md  <- test_documents/vendored/docling/groundtruth/docling_v2/elife-56337.nxml.md  77682  30b988d339def601c70106da8c6f474f9d41b267e3f4d43c6fe63de9f1c833fd  md-entities
  docling-gt-redp5110_sampled.md  <- test_documents/vendored/docling/groundtruth/docling_v1/redp5110_sampled.md  31596  ee5082f07c23b194c423be5bc7aa4a5ed704612be7a75c0bb7af2b047a4f2a2a  md-entities
  docling-gt-2203.01017v2.md  <- test_documents/vendored/docling/groundtruth/docling_v1/2203.01017v2.md  56943  385f4cae40cedc73f9b28b7bd6361b84b94afa27715a5f55914f781bee1c3303  md-heading-number
