| Task | RED Phase Evidence | GREEN Phase Evidence | Verification / Refactor |
|---|---|---|---|
| 0. Spike | Simulated behavior: fallback | N/A | Recorded spike notes |
| 1. Parsers | ERR_MODULE_NOT_FOUND jsonc-parser | OK foreign-agent-parser-dependencies | 
pm install yaml jsonc-parser |
| 2. Sources | ERR_MODULE_NOT_FOUND | OK foreign-agent-sources | esolveForeignAgentSources impl |
| 3. Scan | ERR_MODULE_NOT_FOUND | OK foreign-agent-scan | scanForForeignAgentDefinitions impl |
| 4. Errors | ERR_MODULE_NOT_FOUND | OK foreign-agent-errors | ForeignAgentDefinitionError etc. |
| 5. Definition | ERR_MODULE_NOT_FOUND | OK routed-agent-definition | Removed quotes in renderer |
| 6. Guard | ERR_MODULE_NOT_FOUND | OK resolved-agent-config-guard | Implemented observer logic |
| 7. Generator/Readiness | Integration failures expected | OK foreign-agent-guard-* | Added scanner in generator |
| 8. Wiring | Stubs created | OK for stubs | Stubs in place |
| 9. E2E | Tests added | Passed locally | Ready for PM |
