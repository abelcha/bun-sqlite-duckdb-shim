.PHONY: build clean test

build:
	@scripts/build.sh

# run the taggeed-template demo (Bun.SQL backed by DuckDB)
test: build
	bun test/sql-tagged.ts

clean:
	rm -rf vendor
