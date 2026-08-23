# Design Goal: Student Feedback Loop for Adaptive Handout Generation

## User Goal

The goal is to build a system that collects student feedback on AI-generated course handouts and later uses the collected data to improve the handout generation model.

The intended workflow:

1. An LLM generates teaching materials (handout sections).
2. Each student receives a version of the handout.
3. Students provide fine-grained feedback on each section.
4. The collected data is used to improve future handout generation.

The long-term goal is to support:

- Supervised fine-tuning (SFT)
- Preference optimization (DPO)
- Reward modeling
- RLHF / GRPO / PPO-style optimization


# Core Design Principle

The system should collect **human preference data**, not only simple ratings.

The key idea:

- Same learning objective / section ID
- Multiple generated versions
- Student feedback comparing quality

Each section should have a stable identifier.

Example:

```
section_id: gradient_descent_intro

Learning objective:
Students understand the intuition of gradient descent before learning the mathematical formulation.
```

Different versions:

```
Version A:
Uses real-world analogy first.

Version B:
Introduces mathematical formulation first.

Version C:
Uses coding examples first.
```

All versions share the same section ID but have different content.


# Feedback Collection

## 1. Absolute Rating (Reward Model)

Each student rates the section:

```
How helpful was this section?

1  2  3  4  5
```

This supports reward model training.

Input:

```
(course context, learning objective, generated section)
```

Output:

```
predicted quality score
```


## 2. Pairwise Preference (DPO)

DPO works best with preference pairs.

Collect:

```
Which explanation would you prefer for learning this topic?

Version A
Version B
No preference
```

This creates training examples:

```
Prompt:
Explain gradient descent intuition.

Chosen:
Version C

Rejected:
Version A
```

This directly supports DPO training.


## 3. Diagnostic Feedback

Collect structured feedback:

```
Why was this section good or bad?

[ ] Too difficult
[ ] Too simple
[ ] Unclear explanation
[ ] Too long
[ ] Missing examples
[ ] Good intuition
[ ] Good examples
```

Optional:

```
What would you improve?
```

These comments can support:

- Critique model training
- Reward decomposition
- SFT examples


# Recommended Data Schema

Example:

```json
{
  "student_id": "student_1",
  "section_id": "gradient_descent_intro",
  "version_id": "A",

  "rating": 4,

  "preference": {
    "preferred_version": "A",
    "compared_with": "B"
  },

  "feedback_tags": [
    "clear_example",
    "needs_more_intuition"
  ],

  "comment": "The analogy helped, but the transition to equations was abrupt."
}
```


# Supporting Different Training Methods

## Reward Model

Train:

```
(section + context) -> quality score
```

using student ratings.


## DPO

Construct:

```
(prompt, chosen section, rejected section)
```

from pairwise preferences.


## RLHF / GRPO / PPO

Pipeline:

```
LLM generates candidate handout sections

          ↓

Reward model evaluates candidates

          ↓

Optimization improves generation policy
```


# Experimental Design

Avoid:

```
3 students receive Version A
3 students receive Version B
```

because with only six students, student differences dominate.

Instead use a counterbalanced design.

Example:

Group 1:

```
Section 1 -> Version A
Section 2 -> Version B
Section 3 -> Version A
```

Group 2:

```
Section 1 -> Version B
Section 2 -> Version A
Section 3 -> Version B
```

This enables within-student comparisons.

The goal is not personalization only, but creating better preference data.


# Additional Recommendation

Student preference does not always equal learning effectiveness.

A student may prefer an easy explanation but still fail to understand the concept.

Collect additional signals:

- Short quizzes
- Confidence scores
- Learning gains before/after the handout

A future reward function could combine:

```
Reward =
student preference
+
learning outcome
+
instructor evaluation
```


# Summary

The proposed system:

```
LLM generates handout variants

        ↓

Students read and evaluate sections

        ↓

Collect:
- ratings
- pairwise preferences
- comments
- learning outcomes

        ↓

Train:
- reward models
- DPO models
- RLHF-style models

        ↓

Generate better teaching materials
```

The key implementation requirement:

**Maintain stable section IDs across different handout versions so that feedback from different versions can be compared.**



# The Proposed Design
# Design Proposal: LLM-Generated Adaptive Handout with Human Feedback Collection

## Goal

The goal is to build a human-in-the-loop system for improving LLM-generated course handouts.

The system is not initially designed to train a full RL/DPO model. Instead, the first goal is to create a high-quality evaluation and preference dataset that can later support:

- Reward modeling
- Direct Preference Optimization (DPO)
- RLHF / GRPO-style optimization
- Prompt and generation strategy improvement

The course itself becomes a small-scale environment for collecting human feedback on AI-generated educational materials.

---

# Core Design

Each handout consists of multiple sections.

Example:

```
Handout: Introduction to LLM Agents

Section 1: What is an Agent?
Section 2: Tool Calling
Section 3: Planning
Section 4: Memory
```

Each section has a stable identifier:

```yaml
section_id: agent_tool_calling

learning_objective:
  Students understand why and how LLM agents use external tools.
```

The section ID must remain stable across different versions so that feedback can be compared over time.

Do not use section titles as identifiers because titles may change.

---

# Multiple Versions per Section

The same learning objective can have multiple generated versions.

Example:

```
section_id: agent_tool_calling
```

Versions:

```
Version A:
- intuition-first explanation
- real-world analogy
- minimal technical details

Version B:
- formal definition first
- architecture diagram
- technical explanation

Version C:
- coding example first
- implementation-oriented explanation
```

Students should see different versions, but all versions correspond to the same learning objective.

---

# Student Feedback Collection

The feedback system should collect two types of data.

## 1. Section-Level Rating (all sections)

After each section, automatically insert a lightweight feedback widget.

Example:

```
How useful was this section?

👍 Helpful

😐 OK

👎 Confusing
```

If the student selects negative feedback:

```
What was the main issue?

[ ] Too abstract
[ ] Too difficult
[ ] Too long
[ ] Missing examples
[ ] Poor organization

Optional comment:
_____________
```

The goal is low friction. Students should be able to provide feedback while reading.

Avoid a 1-5 scale because with a small number of students it creates false precision.

---

## 2. Pairwise Preference (selected sections only)

For a small number of probe sections, collect explicit preference comparisons.

Example:

```
You previously read Version A.

Here is another explanation:

Version B.

Which explanation would you prefer for learning this topic?

( ) Version A
( ) Version B
```

This produces true preference data:

```
Prompt:
Explain agent tool calling.

Chosen:
Version B

Rejected:
Version A
```

These examples can directly support DPO training.

Do not require pairwise comparison for every section because it increases student burden.

---

# Data Provenance

Every generated version must store metadata.

Do not only store:

```
version_id: A
```

Instead:

```json
{
  "section_id": "agent_tool_calling",
  "version_id": "A",

  "generation": {
    "model": "GPT-5",
    "prompt_template": "example_first_v2",
    "temperature": 0.7,
    "timestamp": "2026-09-01"
  }
}
```

The purpose is to understand which generation strategy produces better educational materials.

---

# Student Identity and Privacy

Do not directly store student emails in feedback records.

Use:

```
student_hash = hash(email)
```

Store the mapping between hash and identity separately in an instructor-only location.

Benefits:

- Students may provide more honest feedback.
- Same student can be tracked across handouts.
- The dataset is closer to a research-quality human preference dataset.

---

# Assignment Strategy

Avoid splitting students into fixed groups:

```
3 students receive Version A
3 students receive Version B
```

because with a small class, individual student differences dominate.

Instead:

## General sections

Randomly assign versions.

Example:

```
Student 1 -> Version A
Student 2 -> Version B
Student 3 -> Version C
```

Collect overall preference signals.

## Probe sections

Use explicit A/B comparisons.

These produce DPO-style preference pairs.

---

# Instructor Dashboard

The instructor view should focus on actionable feedback, not statistical testing.

Example:

```
Section: Tool Calling

Average feedback:
👎 4 students

Common issues:
- Need more examples
- Too abstract

Comments:
"Would like a concrete API example."
```

The dashboard should help improve future handout generation prompts.

---

# Separation from TA Knowledge Base

The handout feedback system should be separate from the TA retrieval corpus.

Reason:

If the TA can access all generated variants, it may reveal experimental information or contaminate student comparisons.

The TA should only access the finalized teaching materials.

---

# Initial Implementation Scope (V1)

Do not start with automatic RL or automatic generation optimization.

Build:

1. Handout storage
2. Section IDs and version assignment
3. Student rendering interface
4. Section-level feedback widgets
5. Pairwise comparison probes
6. Instructor dashboard
7. JSONL export in training-data format

The first goal is to collect reliable human feedback.

---

# Future Research Direction

After collecting enough data:

## Reward Model

Train:

```
(handout context + section content)
        ->
quality score
```

using section ratings.

## DPO

Train:

```
(prompt, chosen explanation, rejected explanation)
```

using pairwise preferences.

## RLHF / GRPO

Use the reward model to optimize future handout generation.

---

# Summary

The system should be viewed as:

```
LLM generates multiple educational explanations

            ↓

Students evaluate sections

            ↓

Collect:
- ratings
- diagnostic feedback
- pairwise preferences
- generation metadata

            ↓

Build evaluation dataset

            ↓

Improve prompts and future LLM-based handout generation

            ↓

Eventually support DPO / RLHF training
```

The most important design requirements are:

1. Stable section IDs across versions.
2. Preserve generation provenance.
3. Collect explicit pairwise preferences for DPO.
4. Keep feedback lightweight enough that students actually provide it.
5. Treat the first version as a human evaluation system before attempting model training.
```
