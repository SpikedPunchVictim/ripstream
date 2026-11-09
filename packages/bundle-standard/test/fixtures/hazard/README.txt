A miniature workspace for hazard-audit.test.ts: packages/<name>/src plus package.json, shaped like the real one.
The audit's scanner is run against this tree to prove it flags what the real tree has no example of, and leaves
alone what is clean. Nothing here is ever executed: modules are imported (so classes can be inspected) but no
method is called, so the lazy imports of hazard libraries below never resolve. Not type-checked, not published.

  base      HazardParser (reaches a hazard library), a subclass that inherits getSupportedTypes, and a class
            exported under a different name than it is declared
  wrapper   cross-package: wraps HazardParser, subclasses it, and derives it through a factory (no `class` text)
  clean     CleanParser and a subclass of it, importing a clean package: must NOT be flagged
  util      a clean package imported by `clean`
