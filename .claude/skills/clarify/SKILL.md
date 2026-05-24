---
name: clarify
description: >
  Identify underspecified areas in an existing feature spec and resolve them through targeted
  questions. Use this skill after /specify and before /plan when the spec has gaps, vague
  requirements, or unresolved decisions. Trigger on "clarify the spec", "refine requirements",
  "answer questions about the spec", or any request to tighten up an existing specification.
---

# Clarify

Reduce ambiguity in the active feature spec by asking up to 5 targeted questions and encoding
the answers back into the spec file. Run this after `/specify` and before `/plan`.

## Execution Steps

### 1. Locate the spec

Resolve the active feature directory using this priority order:

1. **User-specified**: If the user named a specific feature or NNN number in their message, use
   `specs/<matching-dir>/`.
2. **`specs/.feature.json`**: If the file exists, read `feature_directory` from it and use that
   path. This is the normal case after running `/specify`.
3. **Fallback**: If neither applies, scan `specs/` and use the directory with the highest NNN
   prefix. Warn the user that `.feature.json` is missing and suggest running `/specify` to set it.

Load `specs/<feature-dir>/spec.md`. If it doesn't exist, tell the user to run `/specify` first.

### 2. Scan for ambiguities

Analyze the spec against this taxonomy. For each category, mark: **Clear** / **Partial** / **Missing**.

| Category           | What to check                                                   |
| ------------------ | --------------------------------------------------------------- |
| Functional Scope   | Core user goals, explicit out-of-scope declarations, user roles |
| Domain & Data      | Entities, attributes, relationships, state transitions, scale   |
| Interaction & UX   | Critical user journeys, error/empty/loading states              |
| Performance        | Latency, throughput, scalability targets                        |
| Reliability        | Uptime, recovery, failure modes                                 |
| Security & Privacy | AuthN/Z, data protection, threat assumptions                    |
| Integration        | External services, failure modes, protocol assumptions          |
| Edge Cases         | Negative scenarios, rate limiting, conflict resolution          |
| Constraints        | Technical constraints, explicit tradeoffs                       |
| Terminology        | Canonical glossary, avoided synonyms                            |
| Acceptance         | Testability of acceptance criteria, measurable DoD indicators   |
| Placeholders       | TODO markers, vague adjectives without quantification           |

Build an internal priority queue of candidate questions. Only ask questions that:

- Materially impact architecture, data modeling, task decomposition, or compliance
- Are NOT already answered in the spec or by reasonable default
- Represent the highest (Impact × Uncertainty) categories

**Maximum 5 questions total across the session.**

### 3. Ask questions one at a time

Present exactly **one question at a time**. Never reveal future questions.

For multiple-choice questions:

- Analyze options and recommend the best one based on context and best practices.
- Format:

```
**Recommended:** Option [X] — [1-2 sentence reasoning]

| Option | Description |
|--------|-------------|
| A | [description] |
| B | [description] |
| C | [description] |

Reply with the option letter, "yes" to accept the recommendation, or a short custom answer (≤5 words).
```

For short-answer questions:

```
**Suggested:** [your proposed answer] — [brief reasoning]

Format: Short answer (≤5 words). Reply "yes" to accept, or provide your own.
```

After each answer:

- If "yes" / "recommended" / "suggested" → use your previously stated recommendation.
- Otherwise, validate the answer. If ambiguous, ask for disambiguation (doesn't count as a new question).
- Record the answer in memory and move to the next question.

Stop when:

- All critical ambiguities are resolved
- The user says "done", "good", or "no more"
- 5 questions have been asked

### 4. Integrate answers into the spec

After each accepted answer, update the spec immediately (don't batch):

1. Ensure a `## Clarifications` section exists (add after the first major section if missing).
2. Under it, ensure a `### Session YYYY-MM-DD` subheading exists for today.
3. Append: `- Q: <question> → A: <answer>`
4. Apply the clarification to the most appropriate section:
   - Functional ambiguity → update Functional Requirements
   - User roles / flows → update User Stories
   - Data shape → update Key Entities
   - Non-functional constraint → update Success Criteria with measurable target
   - Edge case → add to Edge Cases section
   - Terminology → normalize term throughout the spec
5. Replace or remove any vague/contradictory text the clarification resolves.
6. Save the file after each update.

### 5. Report

After the questioning loop ends:

- Number of questions asked and answered
- Path to the updated spec
- Sections touched
- Coverage summary table (Resolved / Deferred / Clear / Outstanding per category)
- Any Outstanding or Deferred items — explain why they were skipped
- Suggested next step: `/plan` or run `/clarify` again after planning

## Behavior Rules

- If no meaningful ambiguities exist, say so and suggest proceeding to `/plan`.
- If spec is missing, instruct the user to run `/specify` first.
- Never modify sections unrelated to the clarification being integrated.
- Keep each inserted clarification minimal and testable — avoid narrative drift.
- If more than 5 categories remain unresolved after the quota, flag them explicitly as Deferred.
