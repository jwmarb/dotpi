---
status: superseded by ADR-0023
---

# Done means accepted by the user, not finished by the agent

> **Superseded by [0023](./0023-review-routes-per-plan-item.md).** `done` still means **Accepted**, but acceptance now means *the Item's **Review Route** was satisfied* — which for an `oracle` or `skip` route does not involve the user at all. The reasoning below is preserved because 0023's rejected options are largely this ADR's accepted ones.

A **Plan Item** an agent believes it has completed moves to `review`, not `done`. Only the user moves `review` → `done`. `done` therefore means **Accepted**. The self-archive rule is left exactly as it was — a plan archives when every item is `done`, `failed` or `dropped` — which means a plan cannot archive until the user has cleared the review column.

**Considered.** *Dropping the review column* keeps `done` meaning what it meant and keeps archiving hands-off; rejected because the **Board** then has no inbox and nothing distinguishes "the agent stopped" from "this is right". *A reviewer subagent's verdict moving the card* automates the column and fits the existing `reviewer` agent, but it makes `done` mean "another model approved it", which is a weaker claim than it looks. *Treating review as terminal for archiving* was rejected precisely because it would archive work nobody accepted, defeating the column.

**Consequences.** Plans no longer archive on their own in practice — they wait on the user, and a session that never accepts anything accumulates plans. The footer's progress count now measures acceptance, not effort, so it will sit at less than complete while work is genuinely finished but unreviewed. Agents must be told, in the prompt guidelines, that `done` is not theirs to set; an agent that marks its own work `done` is now making a claim it has no standing to make.
