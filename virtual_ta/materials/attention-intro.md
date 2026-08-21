# A Gentle Introduction to Attention and Transformers

*Sample assigned reading — replace with real course material and list it in `manifest.json`.*

## Why attention was invented

Early sequence models (RNNs, LSTMs) read a sentence one token at a time and squeezed
everything they had seen into a single fixed-size hidden state. For long inputs this
became a bottleneck: by the time the model reached the end of a paragraph, information
from the beginning had been diluted through many update steps. Translation models
suffered visibly — quality dropped as sentences grew.

Attention removes the bottleneck by letting the model **look back at every input
position directly** when producing each output. Instead of one compressed summary,
the model computes, for each output step, a set of *weights* over all input tokens —
"how relevant is each input token to what I am producing right now?" — and takes a
weighted average of their representations.

## Queries, keys, and values

The mechanism is usually described with three learned projections of each token:

- **Query (Q):** what the current position is looking for.
- **Key (K):** what each position offers to be matched against.
- **Value (V):** the actual content that gets mixed together.

The attention weight between position *i* and position *j* is the scaled dot product
of Q_i and K_j, passed through a softmax so the weights over all *j* sum to 1:

```
Attention(Q, K, V) = softmax(Q · Kᵀ / √d_k) · V
```

The scaling by √d_k keeps the dot products from growing so large that the softmax
saturates. Intuitively: each token asks a question (query), every token advertises
what it contains (key), and the answer is a blend of contents (values) weighted by
how well the advertisement matches the question.

## Self-attention and multi-head attention

In **self-attention**, Q, K, and V all come from the same sequence — every token
attends to every other token, so relationships like subject–verb agreement or
pronoun reference can be captured in one step, regardless of distance.

A single attention pattern is limiting, so Transformers run several attention
"heads" in parallel (**multi-head attention**), each with its own Q/K/V projections.
Different heads learn different relations — one may track syntax, another
coreference, another positional locality. Their outputs are concatenated and
projected back down.

## The Transformer block

The 2017 "Attention Is All You Need" architecture stacks identical blocks, each
containing:

1. Multi-head self-attention,
2. A position-wise feed-forward network (the same small MLP applied to every token),
3. Residual connections and layer normalization around both.

Because attention itself is order-blind, **positional encodings** (fixed sinusoids
or learned vectors) are added to the token embeddings so the model knows token order.
Dropping recurrence entirely means every position is processed in parallel, which is
why Transformers train dramatically faster than RNNs on modern hardware.

## Cost and consequences

Self-attention compares every pair of tokens, so compute and memory grow
**quadratically** with sequence length — the price of unlimited direct access.
Much later work (sparse attention, sliding windows, linear attention) attacks
exactly this cost.

## Key takeaways

- Attention replaces a compressed sequential memory with direct, weighted access to all positions.
- Q/K/V and the scaled dot-product softmax are the whole core mechanism.
- Multiple heads let the model learn several relation types at once.
- The Transformer = attention + feed-forward + residuals/normalization + positional encodings, fully parallel.
- The quadratic cost in sequence length is the central engineering trade-off.
