The .eml files in files/ come from the test-document corpus of xberg (td/vendored/unstructured), which vendors the example documents
of the unstructured project (https://github.com/Unstructured-IO/unstructured), Apache License 2.0, copied unmodified.
The corpus itself is under xberg's MIT licence (Copyright (c) 2025-2026 Kreuzberg, Inc.). The files are the authors' own test e-mails
(addresses such as example.com or the project's own domain). The other mail fixtures are synthesised here from cases in xberg's Rust tests
(base64_tests.rs, issue_161_*, issue_169_*). Sizes in bytes:

  email-inline-content-disposition.eml           657  sha256 2ee5ba97fb108b4d86c1567c08e460d7ecce1ac45d00ea0401d964cf0336a6d8
  fake-email-b64.eml                             979  sha256 5d6dcc69d14ded42d93ccf44d9285b14350a08234813608688915ae5f3fc87a7
  fake-email-malformed-encoding.eml              898  sha256 9daab7352f342dc536e67034ace5332d70534287bf1713571bf8bce042845e32
  mime-html-only.eml                             640  sha256 ab005816f46beb4143de2e3b92b11d823401ce261e260584ccc5851cdbebec2c
  mime-multi-to-cc-bcc.eml                       350  sha256 bce43c971e34b478deba6ce30fedcbb3126b2c949c48380becf911af702d9612
  mime-word-encoded-subject.eml                  261  sha256 831d1ff2c5e1c6c1e1c3bf9f11e63642177983c6e782737102546cd336f37d30
  simple-rfc-822.eml                             679  sha256 0ff08681414e8196120045807af5231902a70e9f40f81dc8be42f0770f92c7c9
  test-invalid-date.eml                          161  sha256 fbc5b1306978ddde977a0e085fb0f5a4a4f02a8779328ccdda651012e6b3bd98
