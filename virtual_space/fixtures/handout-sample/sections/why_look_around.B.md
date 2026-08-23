---
section_id: why_look_around
version_id: B
title: Why a token looks around
learning_objective: >
  The student can say why the representation of a token must depend on the
  other tokens around it, and what goes wrong in a model where it does not.
approach: formal-first
generation:
  model: human
  prompt_template: formal_first_fixture_v1
  temperature: 0
  generated: 2026-08-23
---

Fix a sequence of tokens $x_1, \dots, x_n$. A **contextual representation** is
a map that sends position $i$ to a vector $h_i = f(x_1, \dots, x_n, i)$ — a
function of the whole sequence and of where in it we are standing. Contrast
this with a **static** embedding, $h_i = E(x_i)$, which depends on the token at
position $i$ and on nothing else.

The distinction is not cosmetic, and one example settles it. Suppose a token
$w$ occurs in two sequences with unrelated meanings. Under a static embedding
$h$ is the same vector in both, so any function computed downstream from $h$
alone must return the same answer in both — the model is *provably* unable to
distinguish them, whatever its depth. Under a contextual representation the two
occurrences receive different vectors and the obstruction disappears.

### Where the information has to come from

If $h_i$ is to differ between those two sequences, it must read something that
differs, and the only thing that differs is the other positions. So a
contextual representation is one that **mixes across positions**. Every
architecture that works on sequences is some choice about how that mixing is
done, and they differ chiefly in reach:

| Mixing | Reach of position $i$ |
|---|---|
| none (static) | itself |
| convolution, width $k$ | a fixed window around $i$ |
| recurrence | everything before $i$, through a fixed-size state |
| attention | every position, directly and weighted |

The last row is the one this handout is about. Its distinguishing property is
that the weights are not fixed by the architecture: they are computed from the
content at each pair of positions, which is what the next section defines.
