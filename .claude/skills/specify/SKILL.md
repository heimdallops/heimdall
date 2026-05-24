---
name: specify
description: >
  Create or update a feature specification from a natural language description. Use this skill
  whenever the user wants to write a spec, define a feature, capture requirements, or start a
  new planning workflow. Trigger on "spec out X", "write a spec for", "define the requirements
  for", or any request to document what a feature should do before implementation.
---

# Specify

Create a structured feature specification from a natural language description. Specs live in
`specs/<NNN>-<short-name>/spec.md`. This is the first step in the plan → tasks → implement
workflow.

## User Input

The text after `/specify` is the feature description. Never ask the user to repeat it.

## Execution Steps

### 1. Determine spec directory

- Scan `specs/` for existing directories to find the next sequential number (NNN = 001, 002, etc.).
  If `specs/` doesn't exist, create it and start at 001.
- Generate a 2–4 word short name from the description using action-noun format
  (e.g., "add user auth" → `user-auth`, "implement OAuth2 integration" → `oauth2-integration`).
- Create `specs/<NNN>-<short-name>/` and `specs/<NNN>-<short-name>/spec.md`.
- Write `specs/.feature.json` to record the active feature directory:
  ```json
  { "feature_directory": "specs/<NNN>-<short-name>" }
  ```
  This file is the authoritative pointer used by `/clarify`, `/plan`, `/tasks`, and `/analyze`
  to locate the active feature without relying on directory mtime or branch name heuristics.

### 2. Write the spec

Fill the spec using the structure below. Focus on **WHAT** and **WHY**, never HOW.
No technology choices, frameworks, or implementation details.

```markdown
# Feature Specification: [FEATURE NAME]

**Feature Directory**: `specs/<NNN>-<short-name>`
**Created**: [DATE]
**Status**: Draft

## User Scenarios & Testing

### User Story 1 - [Brief Title] (Priority: P1)

[Describe the user journey in plain language]

**Why this priority**: [Value and reasoning]

**Independent Test**: [How to test this story alone — what action + what value it delivers]

**Acceptance Scenarios**:

1. **Given** [initial state], **When** [action], **Then** [expected outcome]
2. **Given** [initial state], **When** [action], **Then** [expected outcome]

---

### User Story 2 - [Brief Title] (Priority: P2)

[Repeat pattern; add more stories as needed]

---

### Edge Cases

- What happens when [boundary condition]?
- How does the system handle [error scenario]?

## Requirements

### Functional Requirements

- **FR-001**: System MUST [specific capability]
- **FR-002**: System MUST [specific capability]
  [Add FR-### entries for each concrete requirement]

### Key Entities _(include if the feature involves data)_

- **[Entity]**: [What it represents, key attributes, relationships]

## Success Criteria

- **SC-001**: [Measurable outcome — time, rate, count, user goal]
- **SC-002**: [Another measurable, technology-agnostic outcome]

## Assumptions

- [Assumption about scope, users, or environment]
- [Any dependency on existing system or service]
```

**Rules when filling the spec**:

- Make informed guesses using context and industry standards; document them in Assumptions.
- Use `[NEEDS CLARIFICATION: <specific question>]` only for decisions that significantly impact
  scope or UX with no reasonable default. Limit to **3 markers maximum**.
- Every requirement must be testable and unambiguous.
- Success criteria must be measurable and technology-agnostic.

### 3. Resolve NEEDS CLARIFICATION markers

If any `[NEEDS CLARIFICATION]` markers remain, present them to the user with options:

```
## Question N: [Topic]

**Context**: [Quote the relevant spec section]
**Question**: [The specific decision needed]

| Option | Answer | Implications |
|--------|--------|--------------|
| A | [first answer] | [what it means] |
| B | [second answer] | [what it means] |
| Custom | Your own answer | — |

Your choice (A/B/Custom):
```

Present all questions at once. Wait for answers. Replace all markers with the resolved values.

### 4. Validate the spec

Check each item:

- [ ] No implementation details (frameworks, APIs, code structure)
- [ ] All functional requirements are testable
- [ ] Success criteria are measurable and technology-agnostic
- [ ] All acceptance scenarios are defined
- [ ] No `[NEEDS CLARIFICATION]` markers remain
- [ ] Scope is clearly bounded (in-scope and out-of-scope are clear)
- [ ] Assumptions are documented

Fix any failing items. Iterate up to 3 times.

### 5. Report

Output:

- Path to the spec file
- Summary of user stories and their priorities
- Any assumptions made
- Suggested next step: `/clarify` (to refine the spec) or `/plan` (to build the technical plan)

## Guidelines

- **Reasonable defaults** — don't ask about: data retention policies, standard error handling,
  authentication methods when only one makes sense, or performance targets unless they're
  unusually strict.
- **Prioritize clarifications by impact**: scope > security/privacy > user experience > technical.
- Think like a tester: if a requirement is vague, it fails the "testable and unambiguous" check.
- Each user story must be independently implementable and testable — a partial implementation
  delivers real value on its own.
