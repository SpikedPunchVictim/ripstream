Tika 4.2.0 oracle fixtures (bead tikajs-qw7f, second batch). Each fixture's expected Content-Type and text come from the Tika 4.2.0 server (container apache/tika:4.2.0,
PUT /rmeta/body with the file name as Content-Disposition; the same text as /tika/text), not from ripstream's output.
Inputs are copied unmodified from the xberg test corpus (https://github.com/xberg-io/xberg, test_documents), from its vendored subsets only, whose licences are permissive:
  docling: MIT, Copyright (c) 2024 International Business Machines (https://github.com/DS4SD/docling)
  unstructured: Apache License 2.0 (https://github.com/Unstructured-IO/unstructured)
  markitdown: MIT, Copyright (c) Microsoft Corporation (https://github.com/microsoft/markitdown)
  myst-nb: BSD 3-Clause, Copyright (c) 2020 ExecutableBookProject (https://github.com/executablebooks/MyST-NB)
Inputs the oracle answers with more than one record (an e-mail with attachments) are not here: ripstream's parse() text inlines embedded documents, Tika's /rmeta/body does not.
Suggested NOTICE entry: 'Test inputs adapted from xberg (MIT, Kreuzberg, Inc.), docling (MIT, IBM), unstructured (Apache-2.0), markitdown (MIT, Microsoft) and MyST-NB (BSD-3-Clause).' This file does not change NOTICE.

A JSON input is stored with the extension .input, because the fixture walker validates every .json file under its root; the fixture's filename field still names it as it was.
Files under files/ (source path in test_documents, size in bytes, sha256):
  docling-unit_test_01.html  <- test_documents/vendored/docling/html/unit_test_01.html  201  37f7fdd745e2c39db948bf083daa60d3927f28157b2679374571ffecb291264c
  docling-example_02.html  <- test_documents/vendored/docling/html/example_02.html  401  a68dda4301db0e2bdc513b365bd0db11def7b99298568ff5a3d6a48f477d82d0
  docling-example_05.html  <- test_documents/vendored/docling/html/example_05.html  417  23b3d0c03a2cd6a5af2d2ff9bb82ac3fcb0f4b27588efb6a06c9b3315f85d09f
  docling-table_with_heading_01.html  <- test_documents/vendored/docling/html/table_with_heading_01.html  484  e1e0972d3a56b79ae12196c0a23cc4468224eacdc32e03babf7bd4d9918ea5ed
  docling-example_06.html  <- test_documents/vendored/docling/html/example_06.html  492  d62119453397f6563bc204a3c962c4eaeb51a6af4c7e7f669060d90559696639
  docling-table_01.html  <- test_documents/vendored/docling/html/table_01.html  503  235d98da830635ee6f9ebb75e15af0e3038cf80f560058400f46d1b6a044c721
  docling-example_04.html  <- test_documents/vendored/docling/html/example_04.html  540  e647ee4aa13ff1c3720ae93db251ef5f6b19b9c3dcbdca218b8bb8c8b8c8eb52
  docling-table_02.html  <- test_documents/vendored/docling/html/table_02.html  557  57330f1ddfbb8363bc198fd0c23edd2dd842b777a912cbc24f2c1c7ecd5c1abc
  docling-example_01.html  <- test_documents/vendored/docling/html/example_01.html  597  86e5fe870f7f735774f94ecf3f1ec99eb846621557e68a3161c7b1d6ea686672
  docling-table_04.html  <- test_documents/vendored/docling/html/table_04.html  668  dfe67e48fbb8bf2e4ba5e7ba09bc2562b393fd0041043c6a6d2f79bb066a91b3
  docling-table_05.html  <- test_documents/vendored/docling/html/table_05.html  771  4f01b4c5bec82170ebf4221ae56107fd6221a355666c0bf4fd4afd41ec529be0
  docling-example_07.html  <- test_documents/vendored/docling/html/example_07.html  865  e6b3ab094c92b830153b530c3e83db27bfd4e3968883c27fa8e6192c57df0bce
  docling-hyperlink_05.html  <- test_documents/vendored/docling/html/hyperlink_05.html  1347  5f98f94721de603c1a716a28038d911a9d6ba9c3a7442468867aed930d4a60fd
  docling-hyperlink_03.html  <- test_documents/vendored/docling/html/hyperlink_03.html  1372  ed4ceb92d9d56720b469f5fa12e203f4fa55a5d304656ce6897ae1cc033561c1
  docling-example_03.html  <- test_documents/vendored/docling/html/example_03.html  1556  1e925e57e07c36a296903ebf8dc3d45fb918cfb2759fa2f5452381b1039729c7
  docling-example_08.html  <- test_documents/vendored/docling/html/example_08.html  2477  c9fe77799cbd316098140f77d8dbd08cfbaf15ae40c06902018f404f8fe52c4e
  docling-word_tables.docx.html  <- test_documents/vendored/docling/html/word_tables.docx.html  6611  e41dc3f1030281ee93f2016ba1a01858af2cf56179a2f7632e024703a77af092
  unstructured-fake-email-utf-16.eml  <- test_documents/vendored/unstructured/eml/fake-email-utf-16.eml  1616  69ab0b60efdd23c6899eaed0ed8536fa6410d80f4df952d115067015841f2c6b
  docling-hyperlink_02.html.md  <- test_documents/vendored/docling/md/hyperlink_02.html.md  22  475f7a17377e465cdcef34d0a03ac97d85e9a4d2a83d7d7b6725d7feb0f8fd69
  docling-fake_memo.md  <- test_documents/vendored/docling/md/fake_memo.md  203  05e22fe72e4490ebfa0acee4b89af45ce0fe41ef5608258d81b36e392c9e6200
  docling-right_to_left_02.md  <- test_documents/vendored/docling/md/right_to_left_02.md  1994  5423469f5da1d3e9a420127b8c313977d4583e09b273e9f790577c2c6dda308e
  docling-wiki.md.md  <- test_documents/vendored/docling/md/wiki.md.md  4790  6195c781ebcac5d51da010235d7bb309ed02d93d934cb75d3bf76106801540c4
  docling-mixed_without_h1.md.yaml  <- test_documents/vendored/docling/yaml/mixed_without_h1.md.yaml  2551  ed62979a5e22e6a1e3421c44920e068369cac24f8c80955970784ae680eb6076
  docling-inline_and_formatting.md.yaml  <- test_documents/vendored/docling/yaml/inline_and_formatting.md.yaml  19528  a7e11924a907a5e9616aaa2b525fd150a3c26354a8947eb28e6b1f1c2a7fd21d
  docling-right_to_left_02.doctags.txt  <- test_documents/vendored/docling/txt/right_to_left_02.doctags.txt  2235  b7a59d62c9d45db114c06a402ed2d714b4a8051508610d7160e7f8934b2cdc92
  docling-right_to_left_01.doctags.txt  <- test_documents/vendored/docling/txt/right_to_left_01.doctags.txt  2658  8f2fa42388470f71bc6994638b634fb6a3cd66a42cfe8b967aaf85921ab68f05
  docling-right_to_left_03.doctags.txt  <- test_documents/vendored/docling/txt/right_to_left_03.doctags.txt  3199  4c25ffcfad19edc8898464d5d650c5ff8d69bf67aca52e7fe6af80ca02b300ea
  docling-2305.03393v1-pg9.doctags.txt  <- test_documents/vendored/docling/txt/2305.03393v1-pg9.doctags.txt  3210  2b529e5e04e56817b17c6ae851e693b939362e1436fba4ff963798cb15e1b8e9
  docling-picture_classification.doctags.txt  <- test_documents/vendored/docling/txt/picture_classification.doctags.txt  4075  8840fc79b197fec9fce9e5212bb017d3458a06da15bdbf68fd636930efcabcec
  docling-amt_handbook_sample.doctags.txt  <- test_documents/vendored/docling/txt/amt_handbook_sample.doctags.txt  4597  1e73edfe7558b91fceca39577547bf550a7747771ab900dfaa7a2c6524da96c9
  docling-code_and_formula.doctags.txt  <- test_documents/vendored/docling/txt/code_and_formula.doctags.txt  6418  83d7ff7e26d0342de1e6a1ba26347c8a7268eb749e5f4baea40afde8477faac8
  docling-multi_page.doctags.txt  <- test_documents/vendored/docling/txt/multi_page.doctags.txt  12778  a7b7aa7194ef6735e90f05d5e157c07d8b30f991691ae86c10d1d179fb3f6e8d
  docling-2305.03393v1.doctags.txt  <- test_documents/vendored/docling/txt/2305.03393v1.doctags.txt  39960  496081ddb5c445fef16a4673f8d719194096248af8717f243cd5db545a47a165
  docling-redp5110_sampled.doctags.txt  <- test_documents/vendored/docling/txt/redp5110_sampled.doctags.txt  44745  936a772b2cd4340cf007152a1cd8361f898ddf4a15e942bd98b68af106ab4c9b
  docling-2206.01062.doctags.txt  <- test_documents/vendored/docling/txt/2206.01062.doctags.txt  55990  46f1cfcdb23b79a713f4205d62e473a2d5c024ed12bbf78cb23a48d5f7303cea
  docling-2203.01017v2.doctags.txt  <- test_documents/vendored/docling/txt/2203.01017v2.doctags.txt  66446  419e9c1ed71901032f7056e25cdae4e873391cbe7c1f224ffddd9f34416e5747
  markitdown-test_mskanji.txt  <- test_documents/vendored/markitdown/csv/test_mskanji.txt  90  560b7b14e789c3d85da2e78fb10c0dd07397c39642facaf16e2687677cd9baaf
  markitdown-test.json  <- test_documents/vendored/markitdown/json/test.json  197  8c0097a909d10b836b8d51a13246458c9a1eb316003391b2a0a7ebc9387ca50f
  markitdown-test_notebook.ipynb  <- test_documents/vendored/markitdown/ipynb/test_notebook.ipynb  1408  60bc053abcbdb10588c9bdc7d59436a8b09604b1e7d5e57a093ba31e555e1505
  myst-nb-hide_cell_content.ipynb  <- test_documents/vendored/executablebooks-myst-nb/hide_cell_content.ipynb  2030  d5bceb4f80ca0d2f345d6b6b3dc4a369b24e8efb6fe79200895805799032dd6c
  docling-right_to_left_01.pages.meta.json  <- test_documents/vendored/docling/json/right_to_left_01.pages.meta.json  32  0ed463e3ae5c7b476e22aaa436b59cbdbbaa79061cdb3b4c747ab6b2180dcc90
  docling-picture_classification.pages.meta.json  <- test_documents/vendored/docling/json/picture_classification.pages.meta.json  61  c55113fd22bda0c346c59a543db95b507f4bcfa0307f3e753992f71a76b249f9
  docling-hyperlink_04.html.json  <- test_documents/vendored/docling/json/hyperlink_04.html.json  980  5ac663b0439b341ce1d14727d63091d784684eb3d77f231598201713bb311ef5
  docling-list_after_num_headers.docx.json  <- test_documents/vendored/docling/json/list_after_num_headers.docx.json  3681  af3ff8be271f9935954e9eeca5e97b239865840d2dc1eb7f4f4d0c9d7114d6a1
  docling-word_comments.json  <- test_documents/vendored/docling/json/word_comments.json  5686  3509ee38441d8d747ec563b9d199fbb03163a3a64555c2f4c9ebe43291746486
  docling-example_07.html.json  <- test_documents/vendored/docling/json/example_07.html.json  7263  9b86901289a1cd0b9a1130de3fdddc540e36c4fcf429ec6e6e66a4f23d801372
  docling-deepseek_simple.md.json  <- test_documents/vendored/docling/json/deepseek_simple.md.json  10192  cf5679a208eef080a6ec25829c37cefea6949afd0f4f34f7245ebc73084d9641
  docling-picture_classification.json  <- test_documents/vendored/docling/json/picture_classification.json  13823  1e667b08f11d8af8c6da0f37a625db2f21f8c0d07a16d05a2e5313668be8920c
  docling-csv-inconsistent-header.csv.json  <- test_documents/vendored/docling/json/csv-inconsistent-header.csv.json  16927  e69d718472ec979fe0e4c79181c165be56969dd874b9af5b79f6b61250196605
  docling-escaped_characters.md.json  <- test_documents/vendored/docling/json/escaped_characters.md.json  19472  3b72e0282b8358ea872f30fd49d50beefebe528e82215cddaa96c2bc9d9c4a30
  docling-table_06.html.json  <- test_documents/vendored/docling/json/table_06.html.json  22830  3e3147960fa6980747486ee33033f33ae0e20a3d4dbd242a7c1cd6a4c09c9cce
  docling-multi_page.json  <- test_documents/vendored/docling/json/multi_page.json  51585  fd4b46e140cf02244ebceecb3b79ed3877e574203cd081421e3ba364da0b8aca
  docling-csv-comma.csv.json  <- test_documents/vendored/docling/json/csv-comma.csv.json  60861  a0df8bb1ff8758cbcdf89eb12ba02cb545fdf73b1474607d99ec9530f2df0a70
  docling-deepseek_example.md.json  <- test_documents/vendored/docling/json/deepseek_example.md.json  71557  31ad946f2ecac8743231529e07a0798979ef7041c9263fd577949fe5e3e5b55e
  docling-gt-2305.03393v1-pg9.pages.meta.json  <- test_documents/vendored/docling/groundtruth/docling_v2/2305.03393v1-pg9.pages.meta.json  33  3fb09d99e3b9bc0f6bd74cceae86a7ac949524d30ed8cfef736ab938009589ba
  docling-gt-powerpoint_with_image.pptx.md  <- test_documents/vendored/docling/groundtruth/docling_v2/powerpoint_with_image.pptx.md  60  bbdc8c6677f87cf912f7a23804730f0b4e1f5129712a2526ad10b502ee5f4c84
  docling-gt-example_06.html.md  <- test_documents/vendored/docling/groundtruth/docling_v2/example_06.html.md  245  8dd76a31879012973164b4dd24e4aad69b7c8e628a2c4e655c151eb2d709bd4b
  docling-gt-unit_test_headers_numbered.docx.md  <- test_documents/vendored/docling/groundtruth/docling_v2/unit_test_headers_numbered.docx.md  401  315503b667afd560e8b50ee72f8739cfb66f21fc246e16fb0e278dc2ecb42f09
  docling-gt-redp5110_sampled.pages.meta.json  <- test_documents/vendored/docling/groundtruth/docling_v2/redp5110_sampled.pages.meta.json  524  5459405d0a58a02b3a63b51d1613a4cdadb42afe5d229ad50e3c4a5ebe356c56
  docling-gt-hyperlink_01.html.json  <- test_documents/vendored/docling/groundtruth/docling_v2/hyperlink_01.html.json  2131  247ea338b3577cd440dba91a6ed8a30ce5cdcda83935f385a47f750679a5d08a
  docling-gt-lorem_ipsum.docx.md  <- test_documents/vendored/docling/groundtruth/docling_v2/lorem_ipsum.docx.md  3487  45a787758f410573e4adb051cf263a4f85f0557f821c6ea59b0d28e93afe1cd1
  docling-gt-table_01.html.json  <- test_documents/vendored/docling/groundtruth/docling_v2/table_01.html.json  5307  b4c125bd8d5153edd0c7c49eb5c76840b231964ebff65674ab18207bdbf3b64e
  docling-gt-example_01.html.json  <- test_documents/vendored/docling/groundtruth/docling_v2/example_01.html.json  5851  1f4b7681794f41d0f6590de5b0cc1af4a46c9ae5b0d5a031cdcd377d2369e548
  docling-gt-hyperlink_03.html.json  <- test_documents/vendored/docling/groundtruth/docling_v2/hyperlink_03.html.json  6996  29c239bb2fc7c5ac50c4dfbb5cf427fa69cd7718dd9e80b594240d26de0646ac
  docling-gt-webvtt_example_04.vtt.json  <- test_documents/vendored/docling/groundtruth/docling_v2/webvtt_example_04.vtt.json  7779  cf06b3e66e3d59a2610ea4754196f53521aa6dccf970bed0372059b90f5ff50f
  docling-gt-tablecell.docx.json  <- test_documents/vendored/docling/groundtruth/docling_v2/tablecell.docx.json  11513  57431afd45a5b64c3a03be9e3df12663e3a308fe888402556b418c48f8a70248
  docling-gt-html_code_snippets.html.json  <- test_documents/vendored/docling/groundtruth/docling_v2/html_code_snippets.html.json  14947  a331441048353ee35f24bf919514d1afa01b48f1c7d7978d3f93af32c208b7e9
  docling-gt-deepseek_title.md.json  <- test_documents/vendored/docling/groundtruth/docling_v2/deepseek_title.md.json  19247  50d9f4dd288c737822c67bd102cce3683676617b7598e9cf22780e3d870db176
  docling-gt-code_and_formula.json  <- test_documents/vendored/docling/groundtruth/docling_v2/code_and_formula.json  20502  9a77989d96f0d895951b18626c42d33c2bd4c7a9cdb47a61d4f4ec087e8415d6
  docling-gt-amt_handbook_sample.json  <- test_documents/vendored/docling/groundtruth/docling_v2/amt_handbook_sample.json  23908  6bb9b17ae2c78dba8cb4977feb18e10c7deabc37d1a1e45f1356effcd7674ef5
  docling-gt-right_to_left_03.json  <- test_documents/vendored/docling/groundtruth/docling_v2/right_to_left_03.json  25988  6d4a634a948c4ec54d6b231cb5986db170f60d6c6d8437c2b746a995c0b6b9d4
  docling-gt-csv-tab.csv.json  <- test_documents/vendored/docling/groundtruth/docling_v2/csv-tab.csv.json  60850  9eab37f58b59070f4a6f9c41428f9f89a17ac990937fa376e0872cc0a50f2116
  docling-gt-example_08.html.json  <- test_documents/vendored/docling/groundtruth/docling_v2/example_08.html.json  64838  db2172f33b86bce86498f16d26699beb5d70e025118571b5e5bc0e18f8c28b0b
  docling-gt-right_to_left_03.md  <- test_documents/vendored/docling/groundtruth/docling_v1/right_to_left_03.md  1243  f839194abcc352fe400e9858d7fe80dcdc1686a0a68c7c9662a245de937e4d39
  docling-gt-right_to_left_01.md  <- test_documents/vendored/docling/groundtruth/docling_v1/right_to_left_01.md  2513  bfde3278acb833e1c87a4abe6a0e8da1ba36efadf17322312c978b1df08393dd
  docling-gt-right_to_left_01.doctags.txt  <- test_documents/vendored/docling/groundtruth/docling_v1/right_to_left_01.doctags.txt  3133  ea99f207a622b556c4156d33bf50550cbeefaec63633b27a87cf868f22e2cf98
  docling-gt-right_to_left_03.doctags.txt  <- test_documents/vendored/docling/groundtruth/docling_v1/right_to_left_03.doctags.txt  3607  f9a331775b79571f869a7bc1c0b24c79c63eb6916fca1c03ce98eb435393a130
  docling-gt-2305.03393v1-pg9.doctags.txt  <- test_documents/vendored/docling/groundtruth/docling_v1/2305.03393v1-pg9.doctags.txt  4595  69f109e9529bcd5e41a2d70ce3031f6acbd9299534e7ef2cf3772b7e93467872
  docling-gt-code_and_formula.doctags.txt  <- test_documents/vendored/docling/groundtruth/docling_v1/code_and_formula.doctags.txt  6621  14c6f6cd6b20235072cb54f84c5b7a9e95733f17eb1c6a18c95be322662543db
  docling-gt-right_to_left_02.json  <- test_documents/vendored/docling/groundtruth/docling_v1/right_to_left_02.json  10186  683f11abd87e89a1c7963aa3af48979466af61fc3a2068f4c822e2ca6f41e8b0
  docling-gt-amt_handbook_sample.json  <- test_documents/vendored/docling/groundtruth/docling_v1/amt_handbook_sample.json  10535  d6f18798f0cee86ad9758d858a09db207a457106a998fa1906b88fe963bd6418
  docling-gt-right_to_left_03.json  <- test_documents/vendored/docling/groundtruth/docling_v1/right_to_left_03.json  15443  3ed5b9e7edc57758d5845ccbb0e29a6d4a4d4b6d682b28adcc78cdd509e200b7
  docling-gt-2305.03393v1.doctags.txt  <- test_documents/vendored/docling/groundtruth/docling_v1/2305.03393v1.doctags.txt  44908  07ec7eabed50179429d340e7d922338483c88742f4014fc2d6ff1eb6279aa3ec
