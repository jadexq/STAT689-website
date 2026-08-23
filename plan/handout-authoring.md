# How to write a feedback handout

**Who this is for:** the instructor, generating handouts outside the app. The app never writes
handouts — it renders them, assigns versions, and collects judgements. See
[`app-changes.md`](./app-changes.md), the 2026-08-23 entry, for what it does with what you make.

**What you produce:** a folder of markdown files, one per (section × version), plus one small
`handout.json`. You run one command over the folder; it validates and emits a single bundle file;
you upload that through the admin panel.

> **These files are not tracked in this repo.** Keep them wherever you like — a private repo, a
> folder in your home directory. They contain no student data, but they do contain the answer to
> which version is which, and the app is the only thing that should be handing versions out.

---

## 1. The shape of a handout

A handout is **one topic, four to six sections**, about fifteen minutes of reading. Every section
exists in **two versions** that teach the *same objective* by a *different route*.

```
nanogpt-attention/
├── handout.json
└── sections/
    ├── tokenization.A.md
    ├── tokenization.B.md
    ├── self_attention.A.md
    ├── self_attention.B.md
    ├── multi_head.A.md
    ├── multi_head.B.md
    ├── residual_layernorm.A.md
    └── residual_layernorm.B.md
```

The filename is `<section_id>.<version_id>.md` and nothing else. The app reads the ids from the
front-matter, not from the filename, but the validator will refuse a file whose name and
front-matter disagree — a mismatch there is the kind of mistake that produces a clean-looking
dataset labelled wrong.

### Why two versions and not three

You have six students. Two versions gives you three judgements per (section, version) and an
exact rotation: three students read A/B/A/B, three read B/A/B/A. Three versions gives you two
judgements per cell and a rotation that only balances if the section count is a multiple of
three. Start with two. Three is supported when you want it.

---

## 2. `handout.json`

```json
{
  "handout_id": "nanogpt-attention",
  "title": "Attention and the Transformer Block",
  "chapter": "GPT",
  "term": "2026F",
  "versions": ["A", "B"],
  "sections": [
    "tokenization",
    "self_attention",
    "multi_head",
    "residual_layernorm"
  ],
  "probes": ["self_attention"]
}
```

| Field | Rule |
|---|---|
| `handout_id` | lowercase, hyphens, unique **forever**. It is the join key in the dataset. Never reuse one for different material, never rename one that has collected data. |
| `title` | what the student sees at the top of the page. |
| `chapter` | free text, matching your agenda's Topic column (`VC`, `GPT`, `Agent`). Lets you group results by chapter later. |
| `term` | `2026F`. Present so a second run of the course is a separate stratum rather than more of the same. |
| `versions` | the version ids, in order. Two entries. |
| `sections` | **display order**, and the order the rotation counts from. Reordering this after data exists changes who would have seen what — don't. |
| `probes` | which sections get the end-of-handout comparison. **One or two per handout**, no more. Each probe costs the student an extra short read. |

Pick as probes the sections where you genuinely do not know which approach is better. A probe on
a section where one version is obviously the good one tells you nothing you did not already know
and spends the student's attention doing it.

---

## 3. A section file

Front-matter, then prose. Nothing above the front-matter.

```markdown
---
section_id: self_attention
version_id: A
title: Self-attention
learning_objective: >
  The student can say why a token needs to look at other tokens, and what
  query, key and value each do, before meeting the matrix form.
approach: analogy-first
generation:
  model: gpt-5
  prompt_template: analogy_first_v1
  temperature: 0.7
  generated: 2026-09-01
---

Imagine reading a sentence where one word is ambiguous...
```

| Field | Rule |
|---|---|
| `section_id` | lowercase, underscores. **Stable forever.** It is what makes two versions comparable and what makes this week's data comparable to next term's. Never rename one. If the content changes enough that comparison would be dishonest, mint a new id. |
| `version_id` | `A` or `B`. Must match the filename. |
| `title` | **identical across all versions of a section.** The validator enforces this. A student must not be able to tell which version they got, and a title is the easiest place to leak it. |
| `learning_objective` | one or two sentences, **identical in meaning across versions**. This is the "prompt" half of every preference pair you will export — if it differs between A and B, the pair is comparing two different questions and the record is unusable. |
| `approach` | short slug naming the route this version takes: `analogy-first`, `formal-first`, `code-first`, `worked-example`. This is what you are actually testing. |
| `generation` | provenance. See below — this is the field it is easiest to skip and impossible to reconstruct. |

### The `generation` block

| Field | Why |
|---|---|
| `model` | which model wrote it. |
| `prompt_template` | a name **you** control, versioned: `analogy_first_v1`, `analogy_first_v2`. Bump it whenever you change the prompt. |
| `temperature` | as used. |
| `generated` | date. |

A term from now, `version_id: A` will mean nothing. The whole point of the exercise is to learn
which *generation strategy* students prefer, and `prompt_template` is the only field that carries
that. Keep a note of what each template name actually said — the templates themselves are worth a
file of their own next to `handout.json`.

If you write a section by hand rather than generating it, say so:
`generation: { model: human, prompt_template: instructor_written, generated: … }`. A
human-written control is a useful arm and needs the same bookkeeping.

---

## 4. Rules that make the data usable

These are not style preferences. Each one, broken, produces records that look fine and are not.

1. **Versions differ in approach, never in coverage.** If A explains three ideas and B explains
   two, students prefer A because it taught them more, and you learn nothing about the approach.
   Same ground, different route.

2. **Versions are within ~20% of each other in length.** Length is a confound and a strong one:
   longer reads as more thorough, shorter reads as clearer. Aim 250–600 words a section and keep
   the pair close.

3. **No meta.** The prose never says "in this version", "the other explanation", "Version A", or
   anything about the study. The student is reading a handout, not participating in an experiment
   they can see the edges of.

4. **No headings above `###`.** The app supplies the section heading from `title`. Inside a
   section, `###` and `####` are yours.

5. **Same objective, word-for-word where you can.** Copy it between the two files rather than
   letting the model rephrase it.

6. **Don't edit a section after students have read it.** If you must, bump `prompt_template` or
   mint a new `section_id`. The app stamps a hash of the text on every record, so an edit does not
   silently corrupt the dataset — but it does split it, and you will have fewer usable pairs than
   you think.

---

## 5. What markdown you can use

Rendered server-side with `marked` (GFM) and KaTeX.

| Works | Notes |
|---|---|
| `###`/`####` headings, bold, italic, links | |
| bullet and numbered lists | |
| fenced code blocks with a language tag | ` ```python ` |
| tables | GFM pipe tables |
| blockquotes | |
| inline math `$…$`, display math `$$…$$` | KaTeX. Check anything unusual renders before you ship it. |
| images | must be a URL the browser can reach; there is no asset upload for handouts |

Raw HTML passes through unsanitised, same as a course reading. That is fine for your own files
and is worth remembering if you ever paste in something you did not write.

---

## 6. A prompt you can paste

Fill the four bracketed slots. Run it twice, once per approach, changing only the **Approach**
line. Then check the front-matter by hand — models are unreliable at YAML, and the validator will
catch the rest.

```
You are writing one section of a course handout for a graduate class on AI and
large language model agents. The students are statistics graduate students:
comfortable with probability and linear algebra, mostly new to deep learning
systems and to writing agentic code.

Section id: [self_attention]
Title: [Self-attention]
Learning objective: [The student can say why a token needs to look at other
  tokens, and what query, key and value each do, before meeting the matrix form.]
Approach: [analogy-first — open with a concrete real-world analogy, build the
  intuition fully, and only then connect it to notation.]

Rules:
- 250 to 600 words.
- Cover exactly the learning objective. Do not add adjacent topics.
- Do not use headings above ###. The section title is supplied separately.
- Never refer to other versions of this section, to this being one of several
  explanations, or to the reader being in a study.
- Markdown only: ###/#### headings, lists, GFM tables, fenced code with a
  language tag, and LaTeX in $…$ or $$…$$.
- Write prose a student reads, not an outline. No "In this section we will".

Output the section body only, with no front-matter and no surrounding commentary.
```

Then paste the body under front-matter you write yourself. Keeping the front-matter out of the
model's hands is the cheap way to guarantee that `title`, `learning_objective` and `section_id`
are byte-identical across the two versions — which is rule 5, and the one most likely to be
broken by a model being helpful.

---

## 7. Validate and bundle

From `virtual_space/`:

```bash
npm run bundle:handout ~/STAT689-handouts/nanogpt-attention
```

It refuses, rather than warns, on:

- a `section_id` in `handout.json` with no file, or a file with no entry in `handout.json`;
- a section missing a version, or carrying one not in `versions`;
- `title` or `learning_objective` differing between versions of a section;
- a `probes` entry naming a section that does not exist;
- a missing or incomplete `generation` block;
- a duplicate `section_id`;
- front-matter that disagrees with the filename.

It warns, and continues, on a length difference over 20% between versions — that one is a
judgement call, not an error.

Output is `nanogpt-attention.handout.json` next to the folder. Upload it from the admin panel.
Re-uploading the same `handout_id` replaces the content and leaves existing responses in place,
which is why the content hash matters.

---

## 8. Before you generate the first one

- Decide the **two approaches** you actually want to compare, and keep them fixed across several
  handouts. Comparing "analogy-first vs formal-first" over four handouts gives you an answer.
  Comparing a different pair each week gives you four anecdotes.
- Write the two prompt templates once, name them, and reuse them. The template is the unit of
  the experiment; the handout is just where it gets tested.
- Generate one handout, read both versions of every section yourself, and check you cannot tell
  which is "the good one". If you can, the comparison is already decided and the students are
  being asked to confirm it.

---

## 9. Checklist

- [ ] `handout_id` new and never used
- [ ] four to six sections, one or two probes
- [ ] every section has both versions
- [ ] `title` and `learning_objective` identical across versions
- [ ] versions within ~20% on length
- [ ] no meta, no headings above `###`
- [ ] `generation` complete on every file, `prompt_template` versioned
- [ ] `npm run bundle:handout` passes clean
- [ ] you read both versions and could not pick the winner in advance
