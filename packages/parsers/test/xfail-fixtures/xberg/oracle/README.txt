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
  unstructured-fake-email-utf-16-be.eml  <- test_documents/vendored/unstructured/eml/fake-email-utf-16-be.eml  1614  4a32768db09f17c22b0a6f8eb0d620065e176103f75d2eeadcb6dc07f0c7e5f0  eml-utf16
  unstructured-fake-email-utf-16-le.eml  <- test_documents/vendored/unstructured/eml/fake-email-utf-16-le.eml  1614  6b44e55a96d15e7d7a53f0146a23d06d43bf8a7fe631a9de2c30efcfe8e6ce14  eml-utf16
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
