# Global Working Agreements

## Agent Delegation

Delegate only when it materially improves throughput, coverage, or independent review quality. Do not delegate by default. Choose between Codex internal sub-agents and the local `external_agent` MCP deliberately.

### Decision Gates

Before delegating to any agent, verify that the task satisfies at least one condition:

- It can run safely in parallel with useful main-agent work.
- It is broad read-only exploration where a second search path reduces omission risk.
- It is an independent review, risk scan, or log summary with concrete evidence to return.
- It is a mechanical, scoped patch that can be verified deterministically and kept isolated.

Do not delegate when:

- The task requires handing off final architecture judgment, user-facing conclusions, or security-sensitive decisions.
- The main implementation depends on nuanced cross-file reasoning that must stay integrated in the main agent.
- A deterministic local tool can do the job faster or more reliably.
- The delegation would mostly shift work rather than reduce critical-path cost.

### Agent Choice

Prefer the main Codex agent when the task is small, tightly coupled, or requires integrated judgment.

Use Codex internal sub-agents when:

- The work should stay inside the Codex runtime, workspace, permissions, and tool ecosystem.
- The task can be split into concrete, bounded, independent subtasks.
- Parallel execution can reduce critical-path time while the main agent continues non-overlapping work.
- A coding patch can be isolated by disjoint file or module ownership and reviewed before integration.
- You need multiple agents to explore different repo areas, call paths, or implementation slices in parallel.

Use the local `external_agent` MCP when:

- A different model family or provider is useful for an independent second opinion.
- The task is read-only analysis, broad search, risk review, or log summarization that does not require tight Codex runtime integration.
- You need an external sandbox patch that must not touch the original workspace directly.
- You want adversarial review of a plan, patch, or conclusion before finalizing.

Do not use external agents as a substitute for Codex internal sub-agents when the work requires shared Codex context, active tool coordination, or direct integration with the current agent loop.

### Delegation Protocol

Keep ownership in the main Codex agent. When delegating:

- Give the delegated agent a narrow, self-contained task.
- State exact scope boundaries, files or directories of interest, and excluded areas.
- Ask for a structured final response with findings, evidence, changed files if any, uncertainty, and a recommended next step.
- For internal sub-agents, require concrete deliverables and disjoint write scopes for coding work.
- For `external_agent`, prefer `mode=analysis` for exploration and review.
- For `external_agent`, use `mode=sandbox_patch` only for isolated patches with a clear write set and deterministic verification.
- For `external_agent`, choose provider and model explicitly based on task difficulty.

### External Model Selection

Choose the external model deliberately; do not let the MCP server infer model policy.

- Use Cursor Composer 2.5 by default for simple or bounded tasks: targeted code search, dependency or config inventory, log summarization, straightforward call-path tracing, and small mechanical checks.
- Use Claude 4.8 for complex tasks: ambiguous architecture analysis, cross-file reasoning, multi-step implementation planning, security-sensitive review, subtle bug diagnosis, or synthesis where missing an edge case is costly.
- Prefer the cheaper/faster model when the task has a clear search space, deterministic evidence, and low integration risk.
- Escalate to the stronger model when the task requires judgment, abstraction, or reconciling conflicting evidence.
- If the configured model identifiers differ from these names, use the closest configured equivalent and state the intended tier in the delegation prompt.

### While Delegated Work Runs

- Do not wait by reflex. Continue local work that does not overlap with the delegated scope.
- If the next critical-path decision requires delegated results, wait once with a longer timeout instead of repeatedly stacking short waits.
- External read-only analysis over multiple files is expected to take time; prefer one patient wait when blocked.
- If the main path is not blocked, leave the delegated task running and continue useful local work, then review the result when it returns.
- Prefer spawning multiple independent internal sub-agents in the same round when the subtasks are truly independent and have non-overlapping scopes.

### Integration Rules

Treat delegated output as evidence, not authority.

- Verify important claims against the repository before acting.
- Review any delegated patch before applying, recreating, or integrating it.
- Do not copy broad recommendations without checking scope, assumptions, and failure modes.
- For security-sensitive review or cross-file reasoning, use delegated output as independent evidence only; the main Codex agent owns the final judgment.
- The main Codex agent owns the final plan, final implementation, and final response to the user.
