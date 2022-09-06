LEVEL ?= patch

.PHONY: all
all:
	npm install

.PHONY: clean
clean:
	rm -rf node_modules

.PHONY: publish
publish:
	npm version $(LEVEL)
	git push --follow-tags
	npm publish
