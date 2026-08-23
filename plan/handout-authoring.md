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
exists in **six versions** — one per student — that teach the *same objective* by a *different
route*.

```
nanogpt-attention/
├── handout.json
├── prompts.md                    ← what each prompt_template actually said
└── sections/
    ├── tokenization.A.md
    ├── tokenization.B.md
    ├── …                         ← .C .D .E .F
    ├── tokenization.F.md
    ├── self_attention.A.md
    ├── …                         ← every section × every version
    └── residual_layernorm.F.md
```

Four sections × six versions is 24 files. That is the real cost of exploring six approaches at
once, and it is mostly generation rather than writing — but the checks in §4 apply to all 24.

The filename is `<section_id>.<version_id>.md` and nothing else. The app reads the ids from the
front-matter, not from the filename, but the validator will refuse a file whose name and
front-matter disagree — a mismatch there is the kind of mistake that produces a clean-looking
dataset labelled wrong.

### Why six versions

You have six students, so six versions means every student reads a different route through the
same material. Within any one section the six students hold the six versions between them — an
exact Latin square — so across the handout no version is tied to any one reader, which is what
keeps "version C did well" separable from "that student grades generously".

The cost is replication: each (section, version) cell holds **exactly one** judgement. Nothing is
averaged, so no single grade is a measurement. What you are buying is breadth — six approaches
sampled and six considered comments per section instead of three readers agreeing about two.

That is the right trade **while exploring**. Once you know which two or three routes land, narrow
`versions` to those and you get replication back with no change to the app: three readers per
version at two versions, two at three. Same rotation, same files, fewer of them.

### What the student is asked

The handout appears as a link in a **📝 Handouts** panel in their own office, and opens in its own
tab. After each section, a **1–5 grade** and a comment box. A grade of 3 or below also offers a
short tag list — *too abstract, too difficult, too simple, too long, missing examples, poor
organization, unclear notation*; raising the grade above 3 clears any tags rather than hiding
them. Clicking the chosen grade again clears it.

**Nothing is required, including the grade.** There is no submit button and answers save as they
are given, so a comment left without a grade is kept — it is usually the most useful thing on the
page. A record with no grade exports, and is skipped when preference pairs are derived.

There is no comparison step: a student never sees a second version of anything. Write each version
as if it were the only one.

---

## 2. `handout.json`

```json
{
  "handout_id": "nanogpt-attention",
  "title": "Attention and the Transformer Block",
  "chapter": "GPT",
  "term": "2026F",
  "versions": ["A", "B", "C", "D", "E", "F"],
  "sections": [
    "tokenization",
    "self_attention",
    "multi_head",
    "residual_layernorm"
  ]
}
```

| Field | Rule |
|---|---|
| `handout_id` | lowercase, hyphens, unique **forever**. It is the join key in the dataset. Never reuse one for different material, never rename one that has collected data. |
| `title` | what the student sees at the top of the page. |
| `chapter` | free text, matching your agenda's Topic column (`VC`, `GPT`, `Agent`). Lets you group results by chapter later. |
| `term` | `2026F`. Present so a second run of the course is a separate stratum rather than more of the same. |
| `versions` | the version ids, in order. Six entries while exploring; two or three once you narrow. Order matters — it is what the rotation counts through. |
| `sections` | **display order**, and the order the rotation counts from. Reordering this after data exists changes who would have seen what — don't. |

There is no `probes` field and no side-by-side comparison. Students grade what they read and
nothing else; preference pairs are derived afterwards from the grades. See
[`app-changes.md`](./app-changes.md), decision 6.

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
| `section_id` | lowercase, underscores. **Stable forever.** It is what makes any two versions comparable and what makes this week's data comparable to next term's. Never rename one. If the content changes enough that comparison would be dishonest, mint a new id. |
| `version_id` | one of the ids in `handout.json` — `A` through `F`. Must match the filename. |
| `title` | **identical across all versions of a section.** The validator enforces this. A student must not be able to tell which version they got, and a title is the easiest place to leak it. |
| `learning_objective` | one or two sentences, **byte-identical across all six versions**. This is the "prompt" half of every preference pair derived from the grades — if it drifts between two versions, the pair compares two different questions and the record is unusable. Copy it; do not let a model rewrite it. |
| `approach` | short slug naming the route this version takes — `analogy-first`, `formal-first`, `code-first`, `worked-example`, `question-led`, `instructor-written`. This is what you are actually testing, and it should be the same six slugs across handouts. |
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
that. Keep what each template actually said in `prompts.md` next to `handout.json`: a template
name with no text behind it is a result you cannot act on.

If you write a section by hand rather than generating it, say so:
`generation: { model: human, prompt_template: instructor_written, generated: … }`. A
human-written control is a useful arm and needs the same bookkeeping.

---

## 4. Rules that make the data usable

These are not style preferences. Each one, broken, produces records that look fine and are not.

1. **Versions differ in approach, never in coverage.** If A explains three ideas and B explains
   two, the student with A grades it higher because it taught them more, and you learn nothing
   about the approach. Same ground, different route — across all six.

2. **All six versions are within ~20% of each other in length.** Length is a confound and a strong
   one: longer reads as more thorough, shorter reads as clearer. Aim 250–600 words a section and
   pick a target word count *before* generating, then hold every version to it. Holding a spread
   across six files is harder than across two and is the check most likely to slip.

3. **No meta.** The prose never says "in this version", "the other explanation", "Version A", or
   anything about the study. The student is reading a handout, not participating in an experiment
   they can see the edges of.

4. **No headings above `###`.** The app supplies the section heading from `title`. Inside a
   section, `###` and `####` are yours.

5. **Same objective, word-for-word.** Not "where you can" — copy it into all six files. It is the
   prompt half of every derived preference pair, and a model asked to write the section will
   happily improve the objective while it is there.

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

Fill the bracketed slots. Run it **six times**, changing only the **Approach** line. Then
paste each body under front-matter you write yourself — models are unreliable at YAML, and
front-matter you control is the cheap guarantee that `title` and `learning_objective` come out
byte-identical across all six. The validator catches the rest.

Six approaches worth trying, as a starting set: analogy-first, formal-first, code-first,
worked-example, question-led (open with the problem the idea solves), and one written by hand as
a control.

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
- Exactly [400] words, give or take 10%.
- Cover exactly the learning objective. Do not add adjacent topics.
- Do not use headings above ###. The section title is supplied separately.
- Never refer to other versions of this section, to this being one of several
  explanations, or to the reader being in a study.
- Markdown only: ###/#### headings, lists, GFM tables, fenced code with a
  language tag, and LaTeX in $…$ or $$…$$.
- Write prose a student reads, not an outline. No "In this section we will".

Output the section body only, with no front-matter and no surrounding commentary.
```

Record each filled-in version in `prompts.md`, keyed by its `prompt_template` name. The template
is the unit of the experiment; the handout is only where it gets tested.

---

## 7. Validate and bundle

From `virtual_space/`:

```bash
npm run bundle:handout ~/STAT689-handouts/nanogpt-attention
```

It refuses, rather than warns, on:

- a `section_id` in `handout.json` with no file, or a file with no entry in `handout.json`;
- a section missing any declared version, or carrying one not in `versions`;
- `title` or `learning_objective` differing between versions of a section;
- a missing or incomplete `generation` block;
- a duplicate `section_id`;
- front-matter that disagrees with the filename.

It warns, and continues, on a spread over 20% between the shortest and longest version of a
section — that one is a judgement call, not an error. Read the warnings; at six versions this is
the check that slips.

Output is `nanogpt-attention.handout.json` next to the folder. Upload it from the **📝 Handouts**
box in the admin panel; the server validates it a second time, so a bundle hand-edited after
bundling is refused too.

Re-uploading the same `handout_id` replaces the content and leaves existing responses in place —
that is how a typo gets fixed. It is also exactly why the content hash matters: a record made
against the old text keeps its own hash, so the feedback dashboard marks it *edited since graded*
and the derived-pairs export drops it. An edit **splits** the dataset rather than rewriting it,
which is the honest outcome but still a smaller dataset than you were expecting.

---

## 8. Before you generate the first one

- Decide the **six approaches** and keep them fixed across the first few handouts. Six approaches
  held steady over three handouts is a readable result. A different six each week is eighteen
  anecdotes.
- Write the six prompt templates once, name them, version them, and record them in `prompts.md`.
- Generate one handout and read all six versions of at least one section yourself. If you can
  already rank them, you have not written six approaches — you have written one good one and five
  weaker ones, and the students will only confirm what you knew.
- Remember what one judgement per cell means: a section's grade is one person's, and the comment
  is the evidence. Read the comments; use the grades to decide which comment to read first.

---

## 9. Checklist

- [ ] `handout_id` new and never used
- [ ] four to six sections
- [ ] every section has all six versions
- [ ] `title` and `learning_objective` byte-identical across all six
- [ ] all six within ~20% on length
- [ ] no meta, no headings above `###`
- [ ] `generation` complete on every file, `prompt_template` versioned
- [ ] `prompts.md` records what each template said
- [ ] `npm run bundle:handout` passes clean, warnings read
- [ ] you read all six of one section and could not rank them in advance
