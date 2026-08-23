---
section_id: qkv
version_id: B
title: Query, key and value
learning_objective: >
  The student can name what each of the three projections is for, and read
  the scaled dot-product expression without decoding it symbol by symbol.
approach: formal-first
generation:
  model: human
  prompt_template: formal_first_fixture_v1
  temperature: 0
  generated: 2026-08-23
---

Let $X \in \mathbb{R}^{n \times d}$ hold the current representations, one row
per position. Attention is defined by three learned projections and one
formula:

$$Q = XW_Q, \quad K = XW_K, \quad V = XW_V$$

$$\mathrm{Attention}(Q,K,V) = \mathrm{softmax}\!\left(\frac{QK^\top}{\sqrt{d_k}}\right)V$$

with $W_Q, W_K \in \mathbb{R}^{d \times d_k}$ and $W_V \in \mathbb{R}^{d \times d_v}$.

Read it from the inside out. $QK^\top$ is $n \times n$; its $(i,j)$ entry is
$\langle q_i, k_j \rangle$, a single number scoring how much position $i$ should
attend to position $j$. Dividing by $\sqrt{d_k}$ controls the scale: if the
entries of $q$ and $k$ are roughly independent with unit variance, the dot
product has variance $d_k$, so without the division the softmax saturates as
$d_k$ grows and its gradient vanishes. The row-wise softmax turns each row into
a probability distribution over positions. Multiplying by $V$ replaces row $i$
with the corresponding convex combination of value vectors.

### What each projection is for

| Symbol | Shape | Role |
|---|---|---|
| $q_i$ | $d_k$ | what position $i$ is looking for |
| $k_j$ | $d_k$ | what position $j$ offers, in comparable coordinates |
| $v_j$ | $d_v$ | what is actually carried away from position $j$ |

$Q$ and $K$ must share a dimension because they meet in an inner product; $V$
need not, because it is only ever averaged. The separation of $K$ from $V$ is
the substantive choice: it lets the criterion by which a position is *selected*
differ from the content it *contributes*.
