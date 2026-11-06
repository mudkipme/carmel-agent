# Home memory

Open **Memory** in Home to manage notes private to you and that agent, including
when other people use the same shared agent. **Remember when asked** is the
default: ask Home to remember, correct, or forget a detail, or edit notes in the
panel. **Off** stops recall without deleting notes. **Learn from Home** also
uses your Home model to extract useful lasting preferences, facts, and decisions
from future human messages after a short idle period or a batch of exchanges.
These background model calls may incur provider usage. Task reports, scheduled
notices, attachments, and collaboration results are not automatic sources.

Home memory uses [OpenMausBot](https://github.com/milind-soni/OpenMausBot)'s
core-notebook and topic-note structure, scoped to your private Home conversation.

**Core** notes load before every human Home reply, without a tool call, within
**200 lines / 24,000 UTF-8 bytes** of rendered notes. They hold who you are, your
lasting preferences and constraints, and standing decisions. Pinned notes take
priority within the same notebook. When it fills, new automatic notes go to
topics; saved notes are not deleted. Smaller model context windows can show less.

**Topics** group details about a project, person, trip, place, or domain under a
scope. Each can have aliases, such as **food → dinner, restaurants, cuisine**.
A compact topic index (up to 40 topics / 2,000 characters) is supplied alongside
core, so Home knows which subjects it remembers. Relevant passages from up to
four topics load automatically before the reply, within 6,000 characters, with
up to 600 characters of content per topic. Home can search for the full notes
when it needs more detail. Alias and word matching can still miss paraphrases.

The panel shows **Default context**, its line and byte usage, and **Topics**.
Use **Use as core**, **Move to topics**, or the editor to control placement and
aliases. Automatic learning can organize its own notes by subject, but protects
your edits and placement choices. Existing unpinned notes start as topics;
learning can reclassify supported lasting facts during a later capture. Turning
on learning does not scan old conversations.

Learning requires evidence from your own words and rejects uncertain facts,
one-task instructions, greetings, daily chatter, and inferred traits. Confirmed
dated facts can be saved with expiry; a learned end date is inclusive through
that UTC date. Lasting facts have no expiry. Capture accepts at most eight new
candidates per batch and keeps the existing daily limit on background calls.

Ordinary sessions, task runs, background notices, and other users do not receive
these notes or the topic index. Starting **New context** keeps Home memory.

Learning asks the model for one `home_memory_capture` tool call instead of
free-form JSON, and falls back to reading the reply when a provider ignores
tools. It salvages every usable candidate from a batch and only fails when the
model returns nothing usable; a malformed entry no longer discards its
siblings. Failures name the rejected field in the panel, and the last call's
route, model, stop reason, token usage, and rejected candidates are kept in
`home_memory_settings.last_capture` for troubleshooting.

Automatic notes show their supporting quote and message link. Review new notes
from the quiet **Remembered** notice, or undo the change. Edit history supports
restoring earlier revisions. **Forget** removes a note and its revision history
from memory and search; it does not delete the original conversation. Expired
notes remain inspectable but are excluded from recall.

This is separate from the agent's [Knowledge](knowledge.md) page, whose saved notes may be
shared with everyone using the agent.
