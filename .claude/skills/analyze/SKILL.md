---
name: analyze
description: >
  Perform a cross-artifact consistency and quality analysis across spec.md, plan.md, and
  tasks.md after task generation. Use this skill to catch gaps, conflicts, and coverage holes
  before implementation begins. Trigger on "analyze the spec", "check consistency", "validate
  the artifacts", or any request to audit the planning documents for quality issues.
---

# Analyze

Read-only cross-artifact consistency analysis across `spec.md`, `plan.md`, and `tasks.md`.
Identifies gaps, conflicts, ambiguities, and coverage holes. **Never modifies any files.**

Run this after `/tasks` and before starting implementation.

## Execution Steps

### 1. Locate artifacts

Resolve the active feature directory using this priority order:

1. **User-specified**: If the user named a specific feature or NNN number in their message, use
   `specs/<matching-dir>/`.
2. **`specs/.feature.json`**: If the file exists, read `feature_directory` from it and use that
   path. This is the normal case after running `/specify`.
3. **Fallback**: If neither applies, scan `specs/` and use the directory with the highest NNN
   prefix. Warn the user that `.feature.json` is missing and suggest running `/specify` to set it.

Load:

- **Required**: `spec.md`, `plan.md`, `tasks.md`
- **Optional**: `data-model.md`, `contracts/`, `research.md`
- **Always**: `CLAUDE.md` for project principles

If any required file is missing, abort and instruct the user to run the missing prerequisite
command (`/specify`, `/plan`, or `/tasks`).

### 2. Build semantic models

Do not dump raw file content into the analysis. Build internal representations:

**Requirements inventory**: For each `FR-###` and `SC-###` in spec.md, record:

- ID, summary phrase, category (functional / success criterion)
- Exclude post-launch business KPIs from coverage tracking

**User story inventory**: For each user story, record:

- Priority (P1/P2/...), title, acceptance criteria count, independent test description

**Task coverage map**: For each task in tasks.md, infer which requirement(s) or user story it covers
(by keyword match, explicit ID reference, or file path → module → feature mapping).

**CLAUDE.md rule set**: Extract MUST/SHOULD principles for constitution alignment check.

### 3. Run detection passes

Limit total findings to **50**; summarize overflow.

#### A. Duplication

- Near-duplicate requirements in spec.md
- Overlapping task descriptions that likely touch the same file

#### B. Ambiguity

- Vague adjectives without measurable criteria (fast, robust, intuitive, scalable)
- Unresolved placeholders (`TODO`, `NEEDS CLARIFICATION`, `???`, `[placeholder]`)

#### C. Underspecification

- Requirements with verbs but no measurable outcome
- User stories missing acceptance criteria
- Tasks referencing files or components not defined in plan.md

#### D. CLAUDE.md Alignment

- Any requirement or plan element conflicting with a MUST principle
- Missing mandatory architecture patterns (CliError, Printer, command structure)

#### E. Coverage Gaps

- FR-### or SC-### with zero associated tasks
- Tasks with no mapped requirement or user story
- User stories from spec.md with no tasks in tasks.md

#### F. Inconsistency

- Terminology drift (same concept named differently across files)
- Entities referenced in plan.md but absent from spec.md (or vice versa)
- Task ordering that contradicts stated dependencies (e.g., integration before foundation)
- Conflicting technical choices across documents

### 4. Assign severity

| Severity | Criteria                                                                                                          |
| -------- | ----------------------------------------------------------------------------------------------------------------- |
| CRITICAL | Violates CLAUDE.md MUST, missing core artifact, requirement with zero coverage that blocks baseline functionality |
| HIGH     | Duplicate or conflicting requirement, untestable acceptance criterion, ambiguous security/performance attribute   |
| MEDIUM   | Terminology drift, missing non-functional task coverage, underspecified edge case                                 |
| LOW      | Style/wording improvements, minor redundancy not affecting execution                                              |

### 5. Produce analysis report

Output Markdown (do not write to any file):

```markdown
## Specification Analysis Report

### Findings

| ID  | Category    | Severity | Location               | Summary                     | Recommendation              |
| --- | ----------- | -------- | ---------------------- | --------------------------- | --------------------------- |
| A1  | Duplication | HIGH     | spec.md FR-003, FR-007 | Two similar requirements... | Merge; keep FR-003 phrasing |

### Coverage Summary

| Requirement | Has Task? | Task IDs   | Notes                         |
| ----------- | --------- | ---------- | ----------------------------- |
| FR-001      | ✅        | T004, T007 |                               |
| FR-002      | ❌        | —          | No task covers password reset |

### CLAUDE.md Alignment Issues

[List any principle violations, or "None found."]

### Unmapped Tasks

[Tasks with no traceable requirement/story, or "None found."]

### Metrics

- Total requirements: N
- Total tasks: N
- Coverage: N% (requirements with ≥1 task)
- Critical issues: N
- High issues: N
- Ambiguities: N
- Duplicates: N
```

### 6. Provide next actions

After the report:

- If **CRITICAL** issues: "Resolve before starting implementation. Suggested commands: ..."
- If only **LOW/MEDIUM** issues: "Safe to proceed. Consider these improvements: ..."
- If **no issues**: "All artifacts consistent. Ready to implement."

Always list concrete next steps (e.g., "Edit spec.md FR-002 to add missing acceptance criteria",
"Add T### to tasks.md to cover SC-003 load test setup").

### 7. Offer remediation

Ask: "Would you like concrete edit suggestions for the top N issues?"

Do NOT apply fixes automatically. Wait for user confirmation before making any changes.

## Operating Principles

- **Strictly read-only**: Do not modify any files.
- **Never hallucinate missing sections**: If a section is absent, report it accurately.
- **Constitution violations are always CRITICAL**: CLAUDE.md MUST principles are non-negotiable.
- **Cite specific instances**: Reference file locations and IDs, not generic patterns.
- **Zero issues is valid**: Emit a clean success report with coverage statistics.
- **Token-efficient**: Load minimal context per artifact; don't dump entire files into analysis.
