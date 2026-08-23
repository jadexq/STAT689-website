---
section_id: qkv
version_id: C
title: Query, key and value
learning_objective: >
  The student can name what each of the three projections is for, and read
  the scaled dot-product expression without decoding it symbol by symbol.
approach: code-first
generation:
  model: human
  prompt_template: code_first_fixture_v1
  temperature: 0
  generated: 2026-08-23
---

Nine lines, and every symbol in the formula appears in one of them:

```python
import torch, torch.nn.functional as F

q = x @ Wq                        # (n, dk)  what each position wants
k = x @ Wk                        # (n, dk)  what each position offers
v = x @ Wv                        # (n, dv)  what each position carries

scores = q @ k.T / dk**0.5        # (n, n)   every position against every other
w = F.softmax(scores, dim=-1)     # (n, n)   rows are distributions
out = w @ v                       # (n, dv)  each row a blend of values
```

Line by line. The first three are three different linear views of the same
input: the **query** is what a position is looking for, the **key** is what it
advertises, the **value** is what it hands over if chosen. They are separate
matrices because being easy to find and being worth reading are different
properties.

`scores` is one number per ordered pair of positions — `scores[i, j]` is how
much `i` should listen to `j`. The `/ dk**0.5` is not decoration: drop it and
watch the largest entry of `w` climb toward `1.0` as `dk` grows, at which point
the softmax is a hard argmax and its gradient is nearly zero.

The softmax normalises each row to sum to one, and the last matmul does the
blending. Written out for one row it is a plain weighted average:

$$\text{out}_i = \sum_j w_{ij} v_j$$

### One thing to check yourself

Print `w[0].sum()` and confirm it is `1.0`, then print `w.argmax(dim=-1)` and
see which position each one chose. Those two lines are how you debug attention
in practice.
