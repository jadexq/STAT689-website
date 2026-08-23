---
section_id: qkv
version_id: A
title: Query, key and value
learning_objective: >
  The student can name what each of the three projections is for, and read
  the scaled dot-product expression without decoding it symbol by symbol.
approach: analogy-first
generation:
  model: human
  prompt_template: analogy_first_fixture_v1
  temperature: 0
  generated: 2026-08-23
---

Think about looking something up in a library that has no catalogue, only
shelves of books with spines facing out. You arrive with a question in your
head. You walk the aisles reading spines. When a spine looks relevant you pull
the book down and read some of it.

Three different things are going on there, and attention gives each one its own
vector.

The **query** is the question you arrived with — what this position is looking
for. The **key** is the spine: a short advertisement of what a position has to
offer, written so that it can be compared against a question cheaply. The
**value** is what is actually inside the book: the content you take away once
you have decided the book is worth opening.

The reason these are three vectors and not one is that the three jobs pull in
different directions. What makes a passage easy to *find* is not the same as
what makes it worth *reading*, and a single vector would have to serve both.
Splitting them lets a position advertise itself one way and deliver something
else.

### Comparing a question to a spine

Comparison is a dot product: large when two vectors point the same way, small
when they do not. Position $i$ compares its query against every key and
normalises the results into weights that sum to one, then takes that weighted
blend of the values:

$$\mathrm{Attention}(Q,K,V) = \mathrm{softmax}\!\left(\frac{QK^\top}{\sqrt{d_k}}\right)V$$

The $\sqrt{d_k}$ is bookkeeping rather than an idea. Dot products of longer
vectors are bigger on average, and a softmax fed very large numbers puts
essentially all its weight on one entry — the reader who only ever opens one
book. Dividing keeps the comparison in a range where several shelves can stay
in play.
