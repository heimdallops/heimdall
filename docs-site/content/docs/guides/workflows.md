---
title: Workflow examples
description: Illustrative YAML workflows showing nodes, approval gates, and iteration loops.
icon: account_tree
weight: 310
toc: true
---

The examples below are **illustrative previews** of how Heimdall workflows look. They demonstrate the schema — nodes, approval gates, and loops — but are not connected to a running engine yet.

## Collect user input

A two-node workflow: an agent collects input, a bash node verifies the result.

```yaml
name: collect-user-input
description: Prompt for text and save it to a file in the worktree.

nodes:
  - id: collect
    agent: input-collector
    instructions: |
      Ask the user what they want to save, then write their response
      to output/user-notes.md in the worktree.

  - id: verify
    depends_on: [collect]
    bash: test -f output/user-notes.md
```

## Human approval gate

Draft content with an agent, pause for human review, then commit on approval:

```yaml
name: save-content
description: Draft content with an agent, get human approval, then commit.

nodes:
  - id: draft
    agent: content-writer
    instructions: Write a concise summary to output/draft.md.

  - id: approve
    depends_on: [draft]
    approval:
      message: "Review output/draft.md before finalizing. Approve to commit."
      exit_on_no: true

  - id: commit
    depends_on: [approve]
    bash: git add output/draft.md && git commit -m "docs: add draft content"
```

## TDD loop

Stub tests first, then iterate implement → test until the suite passes:

```yaml
name: tdd-cycle
description: Write a spec, stub tests, then iterate until tests pass.

nodes:
  - id: spec
    agent: spec-writer

  - id: stub
    depends_on: [spec]
    agent: ts-stub-writer

  - id: tdd_loop
    depends_on: [stub]
    loop:
      max_iterations: 5
      until: 'scope.nodes.test.output == "pass"'
      nodes:
        - id: implement
          agent: ts-engineer

        - id: test
          depends_on: [implement]
          bash: |
            if npm run test:unit; then
              echo "pass" > $HEIMDALL_OUTPUT
            else
              echo "fail" > $HEIMDALL_OUTPUT
            fi

  - id: review
    depends_on: [tdd_loop]
    agent: ts-test-reviewer
```

The `loop` runs up to five iterations. Each pass the agent implements, the bash node writes `pass` or `fail` to `$HEIMDALL_OUTPUT`, and the `until` expression reads `scope.nodes.test.output`. When the value is `"pass"` the loop exits and `review` runs.

## Parallel runs

Because each run uses an isolated worktree, you can fix multiple issues concurrently:

```bash
heimdall workflow run fix-issue --issue 12 &
heimdall workflow run fix-issue --issue 34 &
wait
```

Worktrees are created under `.heimdall/worktrees/` and cleaned up when runs complete or are cancelled.

## See also

- [About Heimdall](/docs/about/) — product overview and architecture
- [Getting started](/docs/getting-started/) — install and first run (preview)
