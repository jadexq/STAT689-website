---
section_id: why_look_around
version_id: A
title: Why a token looks around
learning_objective: >
  The student can say why the representation of a token must depend on the
  other tokens around it, and what goes wrong in a model where it does not.
approach: analogy-first
generation:
  model: human
  prompt_template: analogy_first_fixture_v1
  temperature: 0
  generated: 2026-08-23
---

Read the sentence *the bank was steep and muddy* and stop at the fourth word.
On its own, **bank** is two words wearing one spelling: a place that holds
money, and the edge of a river. Nothing about the letters decides between them.
What decides is *steep and muddy*, three words further on.

Now imagine a reader who is only allowed to look at one word at a time, with
the rest of the page covered. That reader has to commit to a meaning for
**bank** before seeing the evidence, and whatever they commit to is a guess.
They will be right about half the time, and they will have no way of noticing
when they were wrong, because the covering never comes off.

That reader is a model whose representation of a token depends only on the
token. It is not a bad model of spelling. It is simply not a model of meaning
at all, because meaning in natural language is a property of the arrangement
and not of the pieces.

### What "looking around" buys

The fix is to let the representation of each position be assembled from the
whole sequence rather than from one slot in it. After that step the vector
sitting at position four is no longer *the* vector for **bank**; it is the
vector for **bank in this sentence**, and the same word in a different sentence
gets a different one.

Two consequences follow immediately, and both matter more than they look:

- The same token can have as many representations as there are contexts, at no
  cost in parameters — the parameters describe *how* to look around, not what
  every context means.
- Which other positions mattered is a quantity the model computes, so it is a
  quantity you can inspect afterwards.

The next section is about the machinery that does the looking.
