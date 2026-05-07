.DEFAULT_GOAL := quality

%:
	npm run $(subst -,:,$@)
