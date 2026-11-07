.PHONY: all build test clean dist

all: build

build:
	./scripts/build.sh

test:
	node test/test-applets.js
	node test/test-ash.js
	node examples/host-reference.js

clean:
	rm -rf build dist bin/busybox.wasm

dist: build
	mkdir -p dist
	tar -czf dist/busybox-wasi-1.38.0.tar.gz -C . bin/busybox.wasm bin/cli.js src/host.js package.json README.md SPEC.md docs examples
	npm pack --pack-destination dist/
