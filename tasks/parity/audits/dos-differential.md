# Differential DoS run: ripstream vs Apache Tika 4.2.0

Spike for tikajs-4bvr. The 34 files of the extractor bake-off hostile corpus (entity expansion, byte flips, truncated
documents, password-protected files, 10-50 MB text documents, 50,000-entry TAR/ZIP, nested archives, zip bombs, XXE)
were parsed by both:

- ripstream `createRipstream().parse(bytes, { filename, limits: { maxOutputChars: 1_000_000 }, onOutputLimit:
  "truncate", onDocumentFailure: "record" })`, one process, files read whole (up to 52 MB);
- Apache Tika 4.2.0 server (`apache/tika:4.2.0`), `PUT /rmeta`, `application/octet-stream`, no Tika limits.

Measured 2026-11-14 on the same machine; times are wall clock for one file, Tika includes its server work. Full rows
were written to `/tmp/dos-diff.json` during the run; the table keeps the worst cases.

| File | Size | ripstream | Tika 4.2.0 |
| --- | ---: | ---: | ---: |
| textheavy-50mb.docx | 50.4 MB | 2.4 s, 1M chars (cap) | 18.3 s, 74.2M chars |
| textheavy-50mb.pdf | 49.9 MB | 1.4 s, 1M chars (cap) | 40.1 s, 47.0M chars |
| textheavy-25mb.docx | 25.9 MB | 1.3 s, 1M chars (cap) | 7.6 s, 38.2M chars |
| many-entries-50k.tar | 48.8 MB | 4.3 s, LimitExceededError | 43.0 s, 750k chars |
| many-entries-50k.zip | 5.2 MB | 0.05 s, LimitExceededError | 39.3 s, 750k chars |
| billion-laughs.docx | 35.4 KB | 0.02 s, LimitExceededError | 7.1 s, 200 |
| zipbomb-1024mb.zip | 1.0 MB | 0.08 s, LimitExceededError | 115 s, HTTP 503 |
| xxe-file.docx | 35.4 KB | 0.04 s, LimitExceededError | 0.04 s, 200 |
| byteflip-16.pdf | 1.8 KB | 0.73 s, 28 chars | 0.31 s, 14 chars |

The largest ripstream time is 4.3 s (48.8 MB TAR with 50,000 entries, refused); Tika's is 115 s for the 1 MB zip bomb,
answered 503. Every ripstream run stays under the 1M-character output cap, and the entity, archive and expansion cases
end in a typed `LimitExceededError` rather than text. Tika has no equivalent cap here and returns 47-74M characters for
the 50 MB samples, and 503 for the zip bombs.

Conclusion: the output cap, archive entry limits and entity guard keep ripstream's work bounded where Tika's grows with
the input or the expansion. No change needed for this spike; the numbers are the baseline for future differential work.
