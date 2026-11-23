# What CI's verify job runs (.github/workflows/ci.yml).
.PHONY: verify
verify:
	npm ci
	npm run verify
