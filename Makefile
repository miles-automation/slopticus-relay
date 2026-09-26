.PHONY: install dev build check test lint format
install:
	npm ci
dev:
	npm run build && npm run dev
build:
	npm run build
check:
	npm run check
test:
	npm test
lint:
	npm run lint
format:
	npm run format
