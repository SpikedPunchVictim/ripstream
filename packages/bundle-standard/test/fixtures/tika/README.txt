test_recursive_embedded.docx is a test document of Apache Tika 4.2.0, which is licensed under the Apache License 2.0
(release-tools/uat/test-files/ in the 4.2.0 source release). It is here because Tika's own DigestConfigTest asserts the
digests of this exact file, so the bundle's digest tests can compare with values Tika produced and did not take from
ripstream. It is not modified.
