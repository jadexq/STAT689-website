---
section_id: why_look_around
version_id: C
title: Why a token looks around
learning_objective: >
  The student can say why the representation of a token must depend on the
  other tokens around it, and what goes wrong in a model where it does not.
approach: code-first
generation:
  model: human
  prompt_template: code_first_fixture_v1
  temperature: 0
  generated: 2026-08-23
---

Start with the version that cannot look around, so the failure is concrete:

```python
import torch, torch.nn as nn

emb = nn.Embedding(vocab, d)      # one fixed vector per token id
h = emb(ids)                      # (batch, n, d)
```

`h[0, 4]` depends on `ids[0, 4]` and on nothing else. Two sentences that share
a word at position four get **byte-identical** vectors there:

```python
a = emb(tok("the bank was steep and muddy"))
b = emb(tok("the bank approved the loan"))
torch.equal(a[1], b[1])           # True — same token, same vector
```

Whatever you stack on top, those two positions stay indistinguishable. No
number of layers repairs it, because the layers are all fed the same input.

### Making the vector depend on the sequence

The smallest repair is to replace each position with a weighted combination of
every position:

```python
w = torch.softmax(scores, dim=-1) # (n, n), rows sum to 1
h = w @ h                         # each row is now a blend of all rows
```

Run the comparison again and `torch.equal` returns `False`: position four now
carries some of *steep* and *muddy* in one sentence and some of *loan* in the
other. That is the whole idea, and everything that follows is about one
question — where `scores` comes from.

Two things worth noticing about that snippet. The parameter count did not
change; `w` is computed, not stored, so context costs no weights. And `w` is an
ordinary tensor you can print, so which positions were consulted is
inspectable rather than inferred. The next section computes it.
