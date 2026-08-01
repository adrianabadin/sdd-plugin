# cfg.agent Merged-Shape Spike Notes

**Date:** 2026-07-31
**OpenCode Version:** 1.18.9
**Branch Selection:** observed-field projection fallback

## Findings
- \cfg.agent\ map is populated.
- \hidden: true\ survives because \AgentConfig\ has \[key: string]: unknown\.
- \permission.task\ is stripped or unobservable because the \permission\ object lacks an index signature in Zod and drops unknown keys.
- \
ame\ (as map key) is preserved.
- \mode\, \model\, and \description\ survive.

## Conclusion
We must implement the **observed-field projection fallback** branch of design 7.0, verifying exact matches on the surviving fields (\hidden\, \mode\, \model\, \description\) and ignoring \permission.task\ since it is unobservable.
