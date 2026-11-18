# Home memory

Open **Memory** in Home to manage notes private to you and that agent, including
when other people use the same shared agent. **Learn from Home** is the default:
it uses your Home model to extract useful lasting preferences, facts, confirmed
answers, and settled decisions from human Home exchanges after a short idle period
or a batch of exchanges. These background model calls may incur provider usage.
**Remember when asked** disables automatic background learning while keeping
explicit saves, edits, and recall active. **Off** stops recall without deleting
notes. Task reports, scheduled notices, and collaboration results are not
automatic sources.

Home memory uses [OpenMausBot](https://github.com/milind-soni/OpenMausBot)'s
core-notebook and topic-note structure, scoped to your private Home conversation,
and renders notes and topics as clean Markdown in the prompt.

**Core** notes load before every human Home reply, without a tool call, within
**200 lines / 24,000 UTF-8 bytes** of rendered Markdown bullets. They hold who you
are, your lasting preferences and constraints, and standing decisions. Pinned notes
and health/diet constraints take priority within the notebook. When core fills,
older unpinned core notes move automatically to topics so new core facts fit;
saved notes are not deleted. Smaller model context windows can show less.

**Topics** group details about a project, person, trip, place, or domain under a
scope. Each can have aliases, such as **food → dinner, restaurants, cuisine**.
A compact Markdown topic index (up to 40 topics / 2,000 characters) is supplied
alongside core, so Home knows which subjects it remembers. Relevant passages from
up to four topics, up to four matching excerpts from earlier conversations and
tasks, and a 48-hour recent-work brief across your tasks and sessions load
automatically before the reply within the recall budget. Home can search or read
for the full notes when it needs more detail. Topic notes support a title and up
to 20,000 characters.

Home exposes one tool set: `memory_search`, `memory_read`, `memory_save`,
`memory_edit`, and `memory_forget`. Save, edit, and forget work in a single step:
`memory_save` accepts `until` (`YYYY-MM-DD`) and `replaces` to supersede an older
note directly; `memory_edit` and `memory_read` match by `query` or `id`; and
`memory_forget` can forget matching notes across core and topics by `query` phrase
or `id`. `session_search` also supports `since` and `until` time ranges alongside
stop-word-filtered keyword, stem, and CJK matching. No memory tools are exposed
to plain sessions or task runs.

Open **Search and indexing** to enable a private index, select acceleration, and
refresh keyword indexes, build embeddings, or prepare deep hybrid search. The
model and runner configuration is shared with [Knowledge](knowledge.md), while
index files and source mounts are separated by user and agent. Knowledge can
remain disabled. Model downloads require the agent's web access permission.

Automatic topic recall uses semantic matches when available and falls back to
keyword and alias matching. Core notes always load independently of indexing.
Automatic retrieval has a short deadline so an unavailable embedding model does
not hold up Home replies. Background maintenance refreshes enabled indexes and
updates embeddings after the initial build; it runs offline.

The panel shows **Default context**, its line and byte usage, **Topics**, and
**Shared across agents**. Use **Use as core**, **Move to topics**, **Tidy**, or
the editor to control placement, aliases, and whether a durable personal fact is
shared across your agents (`aboutUser`). **Tidy** removes expired notes, merges
duplicates (preserving signs and symbols), coalesces fragmented automatic topic
notes, moves subject-specific or finished work-log entries from core to topics,
resolve contradictions (preserving still-true remainder clauses), and consolidates
cross-conversation patterns and automation ideas across your recent sessions.
Automatic learning protects your manual edits and pinned notes. Existing unpinned
notes start as topics; learning can reclassify supported lasting facts during a
later capture. Turning on learning does not scan old conversations.

Learning requires evidence from your own words and rejects uncertain facts,
one-task instructions, greetings, daily chatter, and inferred traits. Confirmed
dated facts can be saved with expiry; a learned end date is inclusive through
that UTC date. Lasting facts have no expiry. Capture accepts at most eight new
candidates per batch and keeps the existing daily limit on background calls.

Ordinary sessions, task runs, background notices, and other users do not receive
these notes or the topic index. Starting **New context** keeps Home memory.

Learning asks the model for one `home_memory_capture` tool call instead of
free-form JSON. A reply in text is asked again with the tool forced; only a
provider that refuses that falls back to reading the reply. It salvages every
usable candidate from a batch and only fails when the model returns nothing
usable; a malformed entry no longer discards its siblings.

Capture sees the topic index and a compact inventory of note IDs, revisions,
fact slots, and summaries across message batches. Relevant passages use semantic
retrieval when available and keyword matching otherwise. Long notes are excerpted
within the learning context budget, so they cannot consume the whole budget and
hide shorter facts. Corrections reuse the existing note and slot; automatic
learning protects manual and pinned notes. Editing or truncating a message retires
only that message's pending capture, so an edit no longer discards unrelated
learning, and an explicit save leaves the queue armed.

The panel shows a last-check line with the outcome and whether it came from a
tool call or reply text. Failures name the rejected field there too, and the
last call's route, model, stop reason, token usage, and rejected candidates are
kept in `home_memory_settings.last_capture` for troubleshooting.

Automatic notes show their supporting quote and message link. Review new notes
from the quiet **Remembered** notice, or undo the change. Edit history supports
restoring earlier revisions. **Forget** removes a note and its revision history
from memory and search and prevents automatic relearning through matching fact
fingerprints and stable slots. The restriction retains no note text. An explicit
request to remember the fact again, or adding it in the panel, clears its matching
restriction. **Delete note** removes only the saved copy and allows future learning.
Neither action deletes the original conversation. Expired
notes remain inspectable but are excluded from recall.

The Home database is canonical. Derived Markdown and qmd indexes live under
`CARMEL_AGENT_DATA_DIR/home-memory/<hashed-user-agent>/`. Forgetting a memory
purges that Home's derived index generations; rebuilding does not affect another
user's index or the shared model cache.
