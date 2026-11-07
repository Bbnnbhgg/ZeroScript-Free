// SPDX-License-Identifier: GPL-3.0-or-later
// providers/chatgpt.js - the OpenAI ChatGPT (chatgpt.com) provider.
// Exports the same ZSProvider interface as providers/deepseek.js and
// providers/gemini.js; the core (core/main.js) is provider-agnostic. To DISABLE
// ChatGPT support, remove this file from manifest.json (and its URL from
// background.js PROVIDER_URLS + manifest host_permissions + popup.js
// SUPPORTED_HOSTS + main.js AI_SITES).
//
// ChatGPT DOM notes (re-validated live, 2026-08 - chatgpt.com, logged in, fr-FR):
//  - React app. One message = a turn element. BEFORE 2026-11 that was
//    <div data-message-author-role="user|assistant"> carrying a stable
//    data-message-id (a UUID); the 2026-11 build dropped data-message-author-
//    role entirely and tags the turn with data-turn-key (same UUID) instead,
//    moving the role onto a screen-reader heading INSIDE the turn
//    (<h4 class="sr-only" data-conversation-role="user|assistant">). There is no
//    <article> wrapper in either build. turnItems() + role() handle both.
//    anymore, so these elements alternate in DOM order and map 1:1 onto the
//    core's turn expectations. We treat each data-message-author-role div as one
//    "turn item". Long chats DO get virtualized, so every "is this a new reply"
//    test goes through the id (itemKey / lastAssistantId), never through counts.
//  - The reply markdown lives in <div class="markdown">. ChatGPT does NOT prefix
//    text with a screen-reader label (unlike Gemini), but textContent is still
//    NOT usable: code blocks are CodeMirror (.cm-line per line, zero "\n" text
//    nodes), so textContent returns the whole script on one line. Always read a
//    reply through textWithout() - see the note there; this was the single
//    biggest cause of failed tool calls (2026-08).
//    Reasoning (thinking models) renders OUTSIDE .markdown, so reading only the
//    .markdown naturally excludes drafts the model writes while reasoning.
//  - The composer is a ProseMirror contenteditable: <div id="prompt-textarea"
//    class="ProseMirror" contenteditable="true"> - BUT the id is GONE as of the
//    2026-10 build, where it is a bare <div class="ProseMirror"
//    contenteditable="true"> (the layout root there carries
//    data-composer-layout / ComposerLayoutInput-* classes). getEditor() must
//    therefore resolve it by ROLE, never by id - see the note there.
//    innerHTML assignment is unsafe; inject text via select-all +
//    document.execCommand("insertText") (validated
//    to update ProseMirror/React state and enable the send button).
//  - The send button is #composer-submit-button (data-testid="send-button"); it
//    appears only once the composer has text. While generating, a stop button
//    data-testid="stop-button" is present for the ENTIRE generation (including
//    any reasoning phase) - a reliable single signal, like Gemini's stop icon.
//  - Fenced code blocks render as ONE outer <pre> inside .markdown (holding the
//    language label + copy bar + the code). A FENCED ###LUA###…###END_LUA### /
//    JSON command block is therefore one atomic <pre>, and hiding it is simple.
//    But the model does not always fence it: seen live 2026-08, a 208-line
//    ###LUA### block written as plain prose was rendered as 68 SIBLING nodes
//    (<p> for the flush lines, <pre> for the indented ones), and only the first
//    carried the marker - so a per-element match hid the opener and left the
//    whole script on screen. findToolBlockSpot hides the marker-to-marker RANGE
//    for that shape; see there.
//  - Image upload: <input type="file" data-testid="upload-photos-input">.
//  - "Analyser" (Think) is a per-message toggle pill in the composer - a <button>
//    with aria-pressed, class __composer-pill. We deliberately do NOT drive it:
//    like the model picker, the reasoning mode is the user's choice. On the free
//    tier it is quota-capped ("l'analyse sont indisponibles jusqu'à la
//    réinitialisation de votre quota"), and when the quota is out the pill stays
//    pressed but the reply comes back non-reasoning - which is harmless here.
//  - NOT YET ESTABLISHED: whether a reasoning-mode reply renders its thinking in
//    a container outside .markdown, and what selects it. Every reply observed so
//    far (2026-08, free tier) had no such element, so `thinkingSel` is not
//    exported. If reasoning ever quotes a command block, the core's
//    "raw command still visible" probe could flap - that is the symptom to watch
//    for, and the fix is to export thinkingSel here (see deepseek.js).
//  - New chat: <a data-testid="create-new-chat-button" href="/">. A blank new
//    chat is exactly "/"; a conversation is /c/<id>.
//  - ChatGPT's free tier caps messages, and caps image/file input SEPARATELY, so
//    vision is disabled here (supportsVision: false) rather than working only
//    part of the day. ChatGPT announces the quota walls itself, in the thread.
// eslint-disable-next-line no-unused-vars
const ZSProvider = (() => {
  "use strict";
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  let diag = () => {}; // injected by core via init()

  const S = {
    msg: "[data-message-author-role]",
    userRole: "user",
    assistantRole: "assistant",
    reply: ".markdown",
    editor: "#prompt-textarea",
    // The ONE submit control; its data-testid says whether it is currently a
    // send or a stop button (see isStopBtn). Id first - it survives testid churn.
    // The composer-* / aria-label alternatives are APPENDED, never reordered:
    // querySelector returns the first match in document order, so they can only
    // ever win on a build where none of the first three matches anything - one
    // that is already broken. (2026-10 builds renamed the testids to composer-*;
    // the labelled buttons are what the logged-out form composes with.)
    submitBtn: "#composer-submit-button, button[data-testid='send-button'], button[data-testid='stop-button'], button[data-testid='composer-send-button'], button[data-testid='composer-stop-button'], button[aria-label='Send message'], button[aria-label='Send prompt']",
    // Kept for installSendHooks, which needs to recognise a click on the native
    // stop control wherever it lives.
    stopBtn: "button[data-testid='stop-button'], button[data-testid='composer-stop-button'], button[aria-label='Stop streaming']",
    codeWrap: "pre",
    // composer frame: the <form> that wraps the ProseMirror editor.
    errorSurfaces: '[role="alert"],[data-testid*="error"],[class*="error-message"]',
  };

  const RE = {
    contextLimit: new RegExp(
      [
        "conversation.{0,20}(too long|trop long)",
        "context.{0,20}(limit|exceeded|d\\u00e9pass\\u00e9)",
        "maximum.{0,20}(context|length)",
        "(token|context).{0,10}limit",
        "the message you submitted was too long",
        "le message.{0,30}trop long",
      ].join("|"),
      "i"
    ),
    tooLong: /conversation .{0,20}(too long|getting too long|trop longue)|message you submitted was too long/i,
    // ChatGPT errors / rate limits ("something went wrong", "you've reached our
    // limit of messages", quota walls). Kept SHORT-message-gated by the core.
    busy: /something went wrong|une erreur s.est produite|try again later|réessayer plus tard|reached.{0,20}limit of messages|limite de messages|usage cap|temporarily unavailable/i,
    // The native "Continue generating" affordance after a length truncation.
    continueBtn: /^(continue generating|continuer (?:à|a) générer|continue)$/i,
    // Quota wall / paused conversation. Seen live (fr): "Chat en pause jusqu'à la
    // réinitialisation du quota à 23:03 - Vous avez épuisé le quota de chats avec
    // fichiers ou images."
    paused: /chat en pause|conversation.{0,15}(en pause|paused)|quota de chats|r[ée]initialisation du quota|you.{0,3}ve (?:hit|reached).{0,20}limit|quota (?:reset|exceeded)|out of (?:messages|credits)/i,
  };

  // ChatGPT streams continuously with a hard stop-button signal for the WHOLE
  // generation (including reasoning), so windows can be tight like Gemini.
  const timings = {
    GEN_IDLE_MS: 1500,
    REASON_IDLE_MS: 12000,
    WARMUP_MS: 45000,
    REASON_NOREPLY_MS: 90000,
    STABLE_MS: 9000,
    RESPONSE_TIMEOUT_MS: 300000,
  };

  // ── Turn classification ───────────────────────────────────────────────────
  // 2026-11: the role attribute moved OFF the turn element. It now lives on a
  // screen-reader heading INSIDE the turn (<h4 class="sr-only" data-conversation-
  // role="user">), while the turn element itself carries data-turn-key. So read
  // the role from the turn's own descendant, falling back to the old attribute
  // for builds that still put it on the turn element.
  const ROLE_SEL = "[data-conversation-role]";
  const role = (item) => {
    if (!item || !item.getAttribute) return null;
    const own = item.getAttribute("data-message-author-role");
    if (own) return own;
    const mark = item.querySelector ? item.querySelector(ROLE_SEL) : null;
    return mark ? mark.getAttribute("data-conversation-role") : null;
  };
  const isUserItem = (item) => role(item) === S.userRole;
  const isAssistantItem = (item) => role(item) === S.assistantRole;

  // Text extraction that can skip our own chip (and any excluded subtree).
  //
  // CRITICAL: this must NOT be `textContent`. ChatGPT renders fenced code blocks
  // with CodeMirror - <div class="cm-content"> holding ONE <div class="cm-line">
  // per line - and there is not a single "\n" text node in the whole block.
  // textContent therefore returns the entire script glued onto ONE line:
  //   "###LUA###local total = 0local count = 1000for i = 1, count do…"
  // Measured live 2026-08 on a 479-line block: textContent 8917 chars with 0
  // newlines; joining the .cm-line children gave 9395 chars, both markers intact
  // (CodeMirror renders every line here - no viewport virtualization observed,
  // checked up to 479 lines). That collapse is what broke MOST tool calls in a
  // real session: the core's parser saw the opening marker fused to the first
  // statement and reported "Failed to parse command code / your code block was
  // empty", and on the runs that did execute, Roblox reported every error at
  // "AssistantCommand:1" because the whole script really was one line.
  // So: emit a newline for every cm-line (even an empty one - blank lines must
  // survive or reported line numbers shift), for <br>, and at block boundaries
  // (which also gives the unfenced-prose shape a usable line structure).
  //
  // Joining the .cm-line nodes is still not enough on its own: CodeMirror renders
  // LONG LINES only partially, so a big block's DOM text stops early (measured:
  // 2339 of 10040 chars, and a sibling block cut off mid-JSON). The real document
  // lives in CodeMirror's state, behind a page-world expando a content script
  // cannot see - providers/chatgpt-cm.js runs in the MAIN world and republishes it
  // into data-zs-cm. syncCM() asks for a refresh; the listener is synchronous, so
  // the attribute is current the moment dispatchEvent returns. If that script is
  // absent the attribute is too, and we fall back to the .cm-line join (which is
  // correct for anything under ~4000 chars).
  const BLOCK_TAGS = /^(?:P|DIV|PRE|LI|UL|OL|BLOCKQUOTE|H[1-6]|TABLE|TR|SECTION|ARTICLE|HR)$/;
  let _cmWarned = false;
  function syncCM(root) {
    if (!root || !root.querySelector || !root.querySelector(".cm-content")) return;
    try { document.dispatchEvent(new CustomEvent("zs-cm-sync")); } catch {}
  }
  function textWithout(root, excludeSel) {
    if (!root) return "";
    syncCM(root);
    let t = "";
    const breakLine = () => { if (t && !t.endsWith("\n")) t += "\n"; };
    const walk = (n) => {
      if (n.nodeType === 3) { t += n.nodeValue; return; }
      if (n.nodeType !== 1) return;
      if (excludeSel && n.matches && n.matches(excludeSel)) return;
      if (n.tagName === "BR") { t += "\n"; return; }
      // The editor's TRUE document, published by the MAIN-world tap. This is the
      // only complete source for a long block - take it and skip the subtree.
      if (n.classList && n.classList.contains("cm-content")) {
        const full = n.getAttribute("data-zs-cm");
        if (full !== null) {
          breakLine();
          t += full;
          breakLine();
          return;
        }
        if (!_cmWarned) {
          _cmWarned = true;
          diag("cm.noTap", { note: "chatgpt-cm.js not loaded; long code blocks may be truncated" });
        }
        // fall through to the .cm-line walk below
      }
      // One CodeMirror line = one source line, ALWAYS terminated - an empty
      // .cm-line is a blank line in the source and must not be swallowed.
      if (n.classList && n.classList.contains("cm-line")) {
        for (const c of n.childNodes) walk(c);
        t += "\n";
        return;
      }
      const isBlock = BLOCK_TAGS.test(n.tagName);
      if (isBlock) breakLine();
      for (const c of n.childNodes) walk(c);
      if (isBlock) breakLine();
    };
    walk(root);
    return t;
  }

  // The container(s) holding a turn's rendered reply. Historically .markdown;
  // on a build that renamed it, reading only .markdown yields an EMPTY reply -
  // so no command is ever detected and findToolBlockSpot hides nothing (the raw
  // JSON just sits on screen). Fall back to the turn element itself, which
  // always contains the text; the chip is excluded by the callers as usual.
  // Never falls back when .markdown exists, so older builds are untouched.
  function replyNodes(item) {
    if (!item) return [];
    const mds = [...item.querySelectorAll(S.reply)];
    return mds.length ? mds : [item];
  }

  // Non-reasoning reply text only: join the .markdown container(s). Reasoning
  // renders outside .markdown, so this never sees tool blocks the model merely
  // drafts while thinking.
  function itemText(item) {
    if (!item) return "";
    if (isAssistantItem(item)) {
      // textWithout, never textContent - see the CodeMirror note there.
      return replyNodes(item).map((m) => textWithout(m)).join("\n");
    }
    return textWithout(item);
  }

  function classifyText(item, excludeSel) {
    if (isAssistantItem(item)) {
      return replyNodes(item)
        .filter((m) => !(excludeSel && m.closest(excludeSel)))
        .map((m) => textWithout(m, excludeSel)).join("\n");
    }
    return textWithout(item, excludeSel);
  }

  // ── DOM primitives ────────────────────────────────────────────────────────
  // Turn detection is the single most load-bearing selector in the provider: the
  // camouflage sweep walks P.allItems() to find and hide the system prompt and
  // every command block, and turn counting / reply reading hang off it too. When
  // it matches nothing the agent is not degraded, it is INERT AND SILENT - the
  // bootstrap prompt stays on screen, no command is ever seen, and the bar
  // reports an empty chat inside a conversation that is plainly full. That was
  // unfixable from a screenshot; report what the page DOES have instead.
  const TURN_PROBES = [
    "[data-message-author-role]",  // builds up to 2026-09
    "[data-turn-key]",             // current build (2026-11)
    "[data-conversation-role]",
    "[data-message-id]",
    "[data-testid*='turn']",
    "[data-testid*='conversation']",
    "article",
    "[class*='agent-turn']",
    "[class*='conversation-turn']",
  ];
  let _turnMissAt = 0;
  function turnMissReport() {
    const counts = {};
    for (const sel of TURN_PROBES) {
      try { counts[sel] = document.querySelectorAll(sel).length; } catch { counts[sel] = "err"; }
    }
    // Anything on the page advertising itself as a message/turn, whatever the
    // current build calls it - this is the part a screenshot can answer.
    const samples = [];
    try {
      for (const el of document.querySelectorAll("*")) {
        if (samples.length >= 8) break;
        const attrs = [...el.attributes].filter((a) => /message|turn|author|role/i.test(a.name));
        if (attrs.length) {
          samples.push(el.tagName + "." + String(el.className || "").trim().split(/\s+/).slice(0, 3).join(".") +
            " {" + attrs.slice(0, 4).map((a) => a.name + "=" + String(a.value).slice(0, 20)).join(" ") + "}");
        }
      }
    } catch {}
    diag("turns.notFound", { counts, samples });
  }
  // 2026-11: turns are now tagged with data-turn-key (a UUID; the same value
  // shows up as data-chatgpt-search-message-ids inside), and data-message-
  // author-role no longer exists anywhere on the page. The legacy selector is
  // tried first so older builds keep working exactly as before.
  const TURN_SEL = "[data-turn-key]";
  const LEGACY_TURN_SEL = "[data-message-author-role]";

  // One node per turn. If a turn container ever holds BOTH roles (a question and
  // its answer under one key) it is a pair, not a turn - split it, because the
  // core would otherwise read the system prompt as model output, or vice versa.
  function turnItems() {
    const legacy = [...document.querySelectorAll(LEGACY_TURN_SEL)];
    if (legacy.length) return legacy;
    const keys = [...document.querySelectorAll(TURN_SEL)];
    if (!keys.length) return [];
    const out = [];
    for (const k of keys) {
      const marks = [...k.querySelectorAll(ROLE_SEL)];
      const roles = new Set(marks.map((m) => m.getAttribute("data-conversation-role")));
      if (roles.size <= 1) { out.push(k); continue; }
      // Split: each role keeps the top-level section of the pair that holds it.
      for (const m of marks) {
        let n = m;
        while (n.parentElement && n.parentElement !== k) n = n.parentElement;
        out.push(n);
      }
    }
    return out;
  }

  const allItems = () => {
    const items = turnItems();
    if (!items.length) {
      const now = Date.now();
      if (now - _turnMissAt > 10000) { _turnMissAt = now; turnMissReport(); } // rAF-hot: throttled
    }
    return items;
  };
  const assistantItems = () => allItems().filter(isAssistantItem);
  const assistantCount = () => assistantItems().length;
  const userCount = () => allItems().filter(isUserItem).length;
  // 2026-10: ChatGPT dropped the id from the composer. It is now a bare
  // <div class="ProseMirror" contenteditable="true"> (the same build also carries
  // ComposerLayoutInput-* classes and data-composer-layout on the layout root),
  // so resolving the editor by #prompt-textarea alone returned null - and EVERY
  // consumer down the chain reads a missing editor as "this is not a chat page":
  // barMount() bailed, the core's floating fallback found nothing to anchor to
  // and hid the bar, so "Start Roblox agent" stopped appearing altogether
  // (upstream #85, #100, #128), and scanError() reported "The input box
  // disappeared (session ended?)" on a perfectly healthy conversation.
  // Resolve the composer by ROLE instead of by id, trying the id FIRST so any
  // build that still carries it is byte-for-byte unaffected.
  //
  // Cached, because getEditor() is called from the bar and cover rAF loops - i.e.
  // once per frame. Re-running seven querySelectorAll plus an offsetParent read
  // (which forces a style/layout flush) that often is exactly the kind of
  // per-frame cost the core's stall detector exists to surface. The cache is
  // dropped only when the node leaves the DOM, which is precisely when React
  // swaps the composer, so a re-render is still picked up on the next call.
  const EDITOR_SELECTORS = [
    "#prompt-textarea",                             // builds up to 2026-09
    "form div.ProseMirror[contenteditable='true']",  // current build (2026-10+)
    "div.ProseMirror[contenteditable='true']",
    "[contenteditable='true'][role='textbox']",
    "textarea[name='prompt-textarea']",
    "textarea#mobile-composer-prompt",               // logged-out form composer
    "form div.ProseMirror",                          // last resort, composer-only
  ];
  let _edCache = null;
  let _edVia = null;
  // Absolute last resort, reached ONLY on a build where every selector above
  // missed - i.e. one that is already broken and showing no bar at all. A chat
  // page has exactly one thing you can type into, so if that is literally true
  // here, it is the composer. Two or more means we cannot tell them apart (a
  // conversation-rename field, a search box) and guessing wrong is far worse
  // than returning null: a wrong editor swallows every injected message.
  // Code blocks are excluded outright - CodeMirror marks .cm-content
  // contenteditable too, and adopting one would send our results into a
  // read-only code block instead of the composer.
  function soleEditable() {
    let vis;
    try {
      vis = [...document.querySelectorAll('[contenteditable="true"]')].filter(
        (el) =>
          el.offsetParent !== null &&
          !el.closest(".cm-editor, .cm-content, " + LEGACY_TURN_SEL + "," + TURN_SEL + ", .markdown") &&
          (el.getBoundingClientRect().width || 0) > 120
      );
    } catch { return null; }
    if (vis.length !== 1) return null;
    diag("editor.resolved", { via: "sole-visible-contenteditable" });
    return vis[0];
  }
  function findEditor() {
    for (const sel of EDITOR_SELECTORS) {
      for (const el of document.querySelectorAll(sel)) {
        if (el && el.offsetParent !== null) {
          if (_edVia !== sel) {
            _edVia = sel;
            // A resolution that had to fall past the id means ChatGPT moved the
            // composer again - the one breadcrumb worth leaving for the next
            // breakage, logged once per change rather than once per frame.
            if (sel !== EDITOR_SELECTORS[0]) diag("editor.resolved", { via: sel });
          }
          return el;
        }
      }
    }
    return soleEditable();
  }
  // When the composer cannot be found the extension is invisible and silent -
  // no bar, no error, nothing to report. Rather than make the user dig through
  // the console with a hand-written probe, say what IS on the page: one diag
  // line, throttled, because getEditor() runs from the bar's rAF loop every
  // frame and an unthrottled log would bury everything else.
  let _edMissAt = 0;
  function editorMissReport() {
    const counts = {};
    for (const sel of EDITOR_SELECTORS) {
      try { counts[sel] = document.querySelectorAll(sel).length; } catch { counts[sel] = "err"; }
    }
    let editables = [];
    try {
      editables = [...document.querySelectorAll('[contenteditable="true"]')]
        .filter((el) => el.offsetParent !== null &&
          !el.closest(".cm-editor, .cm-content, [data-message-author-role], .markdown"))
        .slice(0, 4)
        .map((el) => el.tagName + "." + String(el.className || "").trim().split(/\s+/).slice(0, 3).join(".") +
          (el.id ? "#" + el.id : "") + "@" + Math.round(el.getBoundingClientRect().width) + "px");
    } catch {}
    diag("editor.notFound", { counts, editables });
  }
  function getEditor() {
    if (_edCache && _edCache.isConnected) return _edCache;
    const ed = findEditor();
    if (ed) { _edCache = ed; _edMissAt = 0; return ed; }
    const now = Date.now();
    if (now - _edMissAt > 5000) { _edMissAt = now; editorMissReport(); }
    return null;
  }
  // A <textarea> composer (the logged-out / mobile form) keeps its text in
  // .value, not in child nodes - textContent is empty there, so every test that
  // reads this ("did the composer clear after the send?", "is the user mid
  // draft?") would have answered "empty" forever and the loop would have sat on
  // a message it believed had already gone out.
  const editorText = () => {
    const e = getEditor();
    if (!e) return "";
    return e.tagName === "TEXTAREA" ? e.value || "" : e.textContent || "";
  };

  const lastAssistant = () => {
    const it = assistantItems();
    return it.length ? it[it.length - 1] : null;
  };
  // Stable per-turn identity (a UUID assigned at message creation, present while
  // streaming). ChatGPT VIRTUALIZES long conversations - older turns are detached
  // from the DOM as you scroll - so assistantCount() goes flat/drops and a
  // count-based "new reply" test stalls until the user scrolls. Identity of the
  // LAST node is virtualization-proof: we never count detached siblings.
  // The core also uses itemKey to dedupe turns (turnKey) so a scrolled-back old
  // command can't collide with a current one on its list index. It is a UUID, not
  // a monotonic number, so the core's numeric "old id" shortcut simply doesn't
  // apply here (Number(uuid) is NaN and that guard is skipped) - the
  // settled-history guard covers the same case provider-agnostically.
  // data-turn-key is the 2026-11 name for the same UUID (it also appears as
  // data-chatgpt-search-message-ids inside the turn); data-message-id is kept
  // for older builds. Identity of the LAST turn is what makes "is this a new
  // reply?" virtualization-proof, so this must never come back empty.
  const itemKey = (item) => {
    if (!item || !item.getAttribute) return null;
    return item.getAttribute("data-message-id") || item.getAttribute("data-turn-key") || null;
  };
  const lastAssistantId = () => itemKey(lastAssistant());

  const chatIsEmpty = () => allItems().length === 0;
  // A genuinely fresh chat: the "/" route (a conversation is /c/<id>), composer
  // rendered, no turns. An existing conversation that is still loading has a
  // /c/<id> path, so it never gates.
  const isFreshChat = () =>
    chatIsEmpty() && location.pathname === "/" && !!getEditor();

  // The composer box the Start gate hides as one unit (the form around the editor).
  const composerFrame = () => {
    const ed = getEditor();
    return ed ? (ed.closest("form") || ed.parentElement) : null;
  };

  // The scrollable band that actually shows the typed text. The editor node
  // itself GROWS with its content (this box scrolls it, max ~245px), so sizing
  // the "Agent is working…" cover to the editor and clamping it left a strip of
  // raw result peeking above and below the cover on a big send. Covering this box
  // instead matches exactly what is visible. It is its own grid cell, so the "+"
  // button and the right-hand icons stay outside the cover and remain usable.
  const coverTarget = () => {
    const ed = getEditor();
    if (!ed) return null;
    return ed.closest("[class*='prosemirror-parent']") || ed;
  };

  // Where the ZeroScript bar lives: INSIDE the rounded composer surface (the
  // element carrying --composer-surface-primary), like DeepSeek - not floating
  // above it, which is narrower than the composer and covers the page's greeting.
  //
  // That surface lays its children out in a CSS grid. A child with no grid-area
  // gets auto-placed into a cell and steals the editor's column - validated live:
  // the input collapsed to zero width. So does a child naming an area the
  // template does NOT define, which is what ChatGPT's 2026-09 redesign caused:
  // the template went from
  //   "header header header" / "leading primary trailing" / ". footer ."
  // to the single-column
  //   "eyebrow" / "controls" / "body"
  // and our `grid-area: header` (overlay.css) suddenly named nothing, so the bar
  // was auto-placed into implicit tracks - a stray row at the bottom right of the
  // composer, editor back to zero width.
  // overlay.css now says `eyebrow`; topArea() re-derives the name from the LIVE
  // template so the next rename costs an inline style, not a broken composer.
  // Both templates put the full-width, empty-by-default row FIRST, which is the
  // slot we want.
  function topArea(box) {
    try {
      const t = getComputedStyle(box).gridTemplateAreas || "";
      const first = t.match(/"([^"]+)"/);
      // Only a first row that is ONE area edge to edge is safe to claim blindly
      // (spelled "eyebrow" today, "header header header" before) - a top row
      // genuinely split between several areas is not a banner slot, so leave the
      // CSS be rather than steal a column.
      if (first) {
        const names = first[1].trim().split(/\s+/);
        if (names[0] !== "." && names.every((n) => n === names[0])) return names[0];
      }
    } catch {}
    return null;
  }

  // A first row that belongs to the INPUT rather than to a banner strip must
  // never be claimed: mounting the bar into it seats bar and editor in the same
  // grid cell, the same "input collapsed to zero width" failure from the other
  // side. `body` is the current template's input row, `primary` the previous
  // one's.
  const INPUT_AREAS = /^(body|primary|input|editor|textarea|composer)$/;
  function bannerArea(box) {
    const a = topArea(box);
    return a && !INPUT_AREAS.test(a) ? a : null;
  }

  // The 2026-10 build dropped the `composer-surface` class as well, so the lookup
  // below found nothing and barMount() bailed - leaving the core to hide the bar
  // entirely (see getEditor). Walk up from the editor to the first ancestor that
  // opens with a full-width banner row instead: that shape is what "header
  // header header", "eyebrow" and the current template all share, so it survives
  // the next rename too. Bounded by the composer's own <form> so the walk can
  // never reach the app shell's grid and mount the bar outside the composer.
  function gridHost(ed) {
    const limit = ed.closest("form") || ed.parentElement;
    let n = ed.parentElement;
    while (n) {
      if (bannerArea(n)) return n;
      if (n === limit) break;
      n = n.parentElement;
    }
    return null;
  }

  function barMount() {
    const ed = getEditor();
    if (!ed) return null;
    // ONLY ever mount inline when a full-width banner row was positively
    // recognised. Anything else returns null on purpose: the core then falls
    // back to the floating bar above the composer, which cannot disturb the
    // site's layout at all. A wrong inline mount CAN (it collapses the input),
    // so "no mount" is always the safer answer - and a floating bar is still
    // infinitely better than the missing bar this used to produce.
    const surface = ed.closest("[class*='composer-surface']");
    const layout = ed.closest("[data-composer-layout]");
    const box = [surface, layout].find((c) => c && bannerArea(c)) || gridHost(ed);
    if (!box) return null;
    const area = bannerArea(box);
    if (area) {
      const bar = document.getElementById("zs-bar");
      if (bar && bar.style.gridArea !== area) bar.style.gridArea = area;
    }
    // Skip our own bar if already mounted, otherwise we'd insert it before itself.
    let before = box.firstElementChild;
    if (before && before.id === "zs-bar") before = before.nextElementSibling;
    return { parent: box, before, inside: true };
  }

  // ── Input lock ────────────────────────────────────────────────────────────
  // ProseMirror is a contenteditable: flipping contenteditable=false blocks the
  // user, but typeAndSend temporarily re-enables it so our own injection works.
  let _locked = false;
  function setInputLock(on) {
    _locked = on;
    const ed = getEditor();
    if (!ed) return;
    // contenteditable means nothing to a <textarea> composer; readOnly is the
    // equivalent there, and - unlike disabled - it still lets us write the
    // injected message ourselves.
    if (ed.tagName === "TEXTAREA") ed.readOnly = !!on;
    else ed.setAttribute("contenteditable", on ? "false" : "true");
    if (on) ed.setAttribute("data-zs-locked", "1");
    else ed.removeAttribute("data-zs-locked");
  }

  // ── Action buttons (send / stop) ──────────────────────────────────────────
  // ChatGPT's composer has ONE submit control, #composer-submit-button, that
  // FLIPS ROLE in place: data-testid="send-button" when idle,
  // data-testid="stop-button" (aria-label "Interrompre la réponse") while
  // generating. Validated live: the two selectors matched the SAME node. So the
  // send button must be tested by ROLE, never by presence - otherwise
  // sendButton() cheerfully returns the stop square and every guarded click is
  // refused. That is exactly what stranded a tool result in the composer and
  // raised "ChatGPT did not accept the injected message after 4 attempts".
  // Role, not just the 2026-08 testid: a renamed testid must never let a stop
  // control pass as a send button, because clicking it aborts a live generation.
  // The aria-label carries the role in every locale ChatGPT ships (en "Stop
  // streaming", fr "Interrompre la réponse").
  const isStopBtn = (b) => {
    if (!b) return false;
    const t = b.getAttribute("data-testid") || "";
    if (t === "stop-button" || t === "composer-stop-button") return true;
    return /stop|interrompre|arrêter/i.test(b.getAttribute("aria-label") || "");
  };
  const submitButton = () => {
    const b = document.querySelector(S.submitBtn);
    return b && b.offsetParent !== null ? b : null;
  };
  const sendButton = () => {
    const b = submitButton();
    return b && !isStopBtn(b) ? b : null;
  };
  const stopButton = () => {
    const b = submitButton();
    return b && isStopBtn(b) ? b : null;
  };

  // ── Generation detection ──────────────────────────────────────────────────
  // The stop button is present for the ENTIRE generation, so detection is simple.
  // Growth tracking covers the instants around start/end AND the wedged-stop case
  // - which DOES happen on ChatGPT (seen live: the reply had finished, yet the
  // submit control stayed in its "Interrompre la réponse" role, so every send was
  // refused and the tool result was stranded in the composer). See unwedgeStop.
  function streamText(item) {
    return item ? textWithout(item, ".zs-chip") : "";
  }
  const streamLen = (item) => streamText(item === undefined ? lastAssistant() : item).length;

  let _streamMax = -1, _streamAt = 0, _streamItem = null;
  function sampleStream() {
    const item = lastAssistant();
    const len = streamText(item).length;
    const now = Date.now();
    if (item !== _streamItem || len < _streamMax - 400) {
      _streamItem = item; _streamMax = len; _streamAt = now; return;
    }
    if (len > _streamMax) { _streamMax = len; _streamAt = now; }
  }
  const grewWithin = (ms) => _streamMax > 1 && Date.now() - _streamAt < ms;

  const WEDGE_MS = 10000;
  let _stopSince = 0;
  function genActive() {
    sampleStream();
    const stop = !!stopButton();
    const now = Date.now();
    if (stop) {
      if (!_stopSince) _stopSince = now;
      // Trust the stop button while the stream advances, or just after it
      // appeared (generation spinning up). Frozen past WEDGE_MS ⇒ treat as done.
      return (now - _streamAt < WEDGE_MS) || (now - _stopSince < 2000);
    }
    _stopSince = 0;
    return grewWithin(timings.GEN_IDLE_MS);
  }
  const isGenerating = genActive;
  const isBusyNow = genActive;
  const isHardGenerating = genActive;

  // Clicking the frozen stop returns the control to its send role, so the pending
  // injection can go out. Guarded by genActive so a genuinely live generation is
  // NEVER aborted - during a real stream every attempt below is refused.
  function unwedgeStop() {
    const stop = stopButton();
    if (stop && !genActive()) {
      diag("send.unwedge", {});
      try { stop.click(); } catch {}
      return true;
    }
    return false;
  }

  // One attempt is not enough: genActive() latches true for 2s from the FIRST
  // moment it sees a stop button (_stopSince), so an attempt made right after the
  // page or the turn came up is refused by that latch alone. Retry across the
  // window, then confirm the send role actually came back. (Same reasoning as
  // gemini.js, where a single attempt let the system prompt sit in the composer.)
  async function unwedgeStopPersistently(totalMs = 4000) {
    const t0 = Date.now();
    while (Date.now() - t0 < totalMs) {
      if (sendButton()) return true;
      if (unwedgeStop() && await waitFor(() => !!sendButton(), 1500)) return true;
      await sleep(250);
    }
    return !!sendButton();
  }

  // ChatGPT exposes no reliable per-turn "stopped" marker → never halted.
  const turnHalted = () => false;

  // ── Truncation "Continue generating" button ───────────────────────────────
  function findContinueBtn() {
    for (const b of document.querySelectorAll("button")) {
      if (b.offsetParent === null) continue;
      if (RE.continueBtn.test((b.innerText || "").trim())) return b;
    }
    return null;
  }
  function clickContinueBtn() {
    const b = findContinueBtn();
    if (!b) return false;
    try { b.click(); return true; } catch { return false; }
  }

  function snapshot() {
    try {
      const it = lastAssistant();
      if (!it) return { th: 0, rp: 0 };
      const md = it.querySelector(S.reply);
      return { th: 0, rp: md ? (md.textContent || "").length : 0 };
    } catch { return {}; }
  }

  function readAssistant() {
    const item = lastAssistant();
    if (!item) return { present: false, reply: "", thinking: "", item: null };
    const mds = replyNodes(item);
    return {
      present: true,
      reply: mds.map((m) => textWithout(m, ".zs-chip")).join("\n").trim(),
      thinking: "", // reasoning is gated by the stop button, not parsed as text
      item,
    };
  }

  async function waitFor(pred, timeout) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      if (pred()) return true;
      await sleep(120);
    }
    return false;
  }

  // ── Sending ───────────────────────────────────────────────────────────────
  // ProseMirror listens to the browser's native editing pipeline, so
  // document.execCommand("insertText") over a select-all reliably replaces the
  // content and fires the input events that enable the send button. Validated
  // live on chatgpt.com.
  // ChatGPT's ProseMirror has the same failure mode as Gemini's Quill: inserting
  // a large result is one uninterruptible synchronous burst on the main thread.
  // Measured live on chatgpt.com, 2026-08:
  //   - one insertText of a 1500-line / 60k-char string: tab frozen >45s, nothing
  //     clickable, no repaint, Stop button dead.
  //   - LINE COUNT is the entire cost, not size: a single 120 000-char line
  //     inserts in 13ms, because each line becomes its own ProseMirror block and
  //     every insert re-renders the document. So the char cap can stay generous
  //     and the line cap is the real lever.
  //   - line-by-line with a yield every N lines, 1200 lines: N=120 -> 11.9s total
  //     with a 4.4s worst freeze; N=25 -> 7.9s total with a 1.0s worst freeze.
  //   - a synthetic PASTE of the same 1200 lines is far faster (18ms), but it is
  //     UNUSABLE here: ChatGPT turns a pasted message into a file attachment on
  //     send. See pasteEditorText for the full story. Typing it is.
  // ChatGPT's own hard input cap, MEASURED live 2026-08-14 (not a guess, and not
  // the perf limit below): the composer's submit button silently goes `disabled`
  // once the editor holds more than ~139 300 characters - 139 300 sends, 139 500
  // does not, reproducible across repeats. It is a CLIENT-side gate, so an
  // oversized message is not rejected with a visible "too long" error, it simply
  // cannot be sent at all; nothing in the bundles exposes the constant, so the
  // boundary was bracketed by filling the editor and reading button.disabled.
  // 120 000 is kept as our cap: it is chosen for the freeze cost documented
  // above, and it happens to sit comfortably under the real ceiling, so a result
  // we are willing to send is always a result ChatGPT will accept.
  const SEND_HARD_CAP = 139300;  // measured; for reference and headroom checks
  const SEND_MAX_CHARS = 120000; // characters are essentially free (see above)
  const SEND_MAX_LINES = 600;    // the line count is what costs, and we type it
  const INSERT_CHUNK_LINES = 25; // measured sweet spot: 3.0s total, 0.4s worst freeze

  function truncateForSend(text) {
    if (!text) return text;
    const lines = String(text).split("\n");
    if (text.length <= SEND_MAX_CHARS && lines.length <= SEND_MAX_LINES) return text;
    const marker = (what) =>
      `\n\n[…ZeroScript: result truncated (${what}) so it can be pasted into ` +
      `ChatGPT's composer without freezing the page. Do NOT re-run the command; ` +
      `work with the head and tail shown here…]\n\n`;
    let out, note;
    if (lines.length > SEND_MAX_LINES) {
      const head = Math.floor(SEND_MAX_LINES * 0.85);
      const tail = SEND_MAX_LINES - head;
      note = `${lines.length - SEND_MAX_LINES} of ${lines.length} lines omitted`;
      out = lines.slice(0, head).join("\n") + marker(note) + lines.slice(lines.length - tail).join("\n");
    } else {
      out = text;
    }
    if (out.length > SEND_MAX_CHARS) {
      const budget = SEND_MAX_CHARS - 300;
      const head = Math.floor(budget * 0.85);
      note = `${out.length - budget} of ${out.length} characters omitted`;
      out = out.slice(0, head) + marker(note) + out.slice(out.length - (budget - head));
    }
    diag("send.truncated", { from: text.length, to: out.length, lines: lines.length });
    return out;
  }

  // Select the whole composer, so whatever we insert REPLACES its contents.
  function selectAll(ed) {
    ed.focus();
    const sel = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(ed);
    sel.removeAllRanges();
    sel.addRange(range);
  }

  // DO NOT USE for injected sends - kept only for reference/fallback.
  //
  // A synthetic paste is by far the fastest way to fill this composer (18ms for
  // 1200 lines vs 7.9s of typing) - but ChatGPT REMEMBERS that the content was
  // pasted and, on submit, materialises it as a "Texte collé.txt" / "Pasted
  // text.txt" DOCUMENT ATTACHMENT instead of an inline message. Seen live: the
  // system prompt went out as a file, which burns the free tier's SEPARATE
  // "chats with files or images" quota and then paused the whole conversation
  // ("Chat en pause jusqu'à la réinitialisation du quota").
  //
  // The conversion is not visible at paste time - the text really is in the
  // composer, and pasting up to 400 lines / 20k chars showed no attachment chip.
  // It happens at SEND. So there is nothing to detect and fall back from: the
  // only safe path is to never paste an injected message in the first place.
  async function pasteEditorText(ed, text) {
    selectAll(ed);
    const dt = new DataTransfer();
    dt.setData("text/plain", text);
    ed.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
    // ProseMirror applies the paste asynchronously; confirm it actually landed
    // before reporting success, so the caller can fall back if it did not.
    const want = text.trim();
    if (!want) return true;
    return await waitFor(() => (ed.textContent || "").trim().length > 0, 3000);
  }

  // Fallback: type it. Yielding does not make this faster - it keeps the page
  // alive while it happens, so the user can still click (and Stop still works).
  async function typeEditorText(ed, text) {
    selectAll(ed);
    const lines = String(text).split("\n");
    const t0 = Date.now();
    for (let i = 0; i < lines.length; i++) {
      if (lines[i]) document.execCommand("insertText", false, lines[i]);
      // insertLineBreak, never a synthetic Enter: Enter is what SENDS on ChatGPT.
      if (i < lines.length - 1) document.execCommand("insertLineBreak");
      if (i && i % INSERT_CHUNK_LINES === 0) await sleep(0);
    }
    if (lines.length > INSERT_CHUNK_LINES) diag("send.insertDone", { lines: lines.length, ms: Date.now() - t0 });
  }

  // A <textarea> composer (the logged-out / mobile form) has NO child nodes to
  // select and no editable region for execCommand to write into, so
  // typeEditorText inserts nothing at all there - the send button never enables
  // and the message sits in the box. Write .value through the prototype's native
  // setter instead: assigning `ed.value = x` directly is invisible to React (it
  // keeps its own copy of the node's value), which is why the input event below
  // is not optional - it is what makes the site actually see the new text.
  function setTextareaValue(ed, text) {
    try {
      const proto = window.HTMLTextAreaElement && window.HTMLTextAreaElement.prototype;
      const setter = proto && Object.getOwnPropertyDescriptor(proto, "value");
      if (setter && setter.set) setter.set.call(ed, text);
      else ed.value = text;
    } catch { ed.value = text; }
    ed.dispatchEvent(new Event("input", { bubbles: true }));
  }

  // Typing is the ONLY path for injected sends on the ProseMirror composer: it
  // is slower, but it produces a real inline message instead of a file
  // attachment (see pasteEditorText). A <textarea> composer needs the value path.
  async function setEditorText(ed, text) {
    if (ed.tagName === "TEXTAREA") {
      setTextareaValue(ed, text);
      return;
    }
    await typeEditorText(ed, text);
  }

  async function typeAndSend(text, images) {
    const ed = getEditor();
    if (!ed) throw new Error("ChatGPT input box not found");
    text = truncateForSend(text);
    const relock = _locked;
    // injection needs the composer editable again (a textarea is unlocked by
    // setTextareaValue's direct write, not by this attribute).
    if (relock && ed.tagName !== "TEXTAREA") ed.setAttribute("contenteditable", "true");
    try {
      await setEditorText(ed, text);
      // Attach images LAST, right before the send click - see gemini.js/deepseek.js
      // typeAndSend for why (attaching first and then retyping the text can sever
      // the site's binding between the pending upload and the message sent).
      if (images && images.length) {
        try { await attachImages(images); } catch {}
        // ChatGPT disables the send button while an upload is still in flight, so
        // poll the click instead of gating on a specific "upload done" node.
        const t0 = Date.now();
        while (Date.now() - t0 < 25000) {
          const b = sendButton();
          if (b && !b.disabled) { try { b.click(); } catch {} }
          if (await waitFor(() => editorText().trim() === "" || !!stopButton(), 1200)) return;
        }
        return;
      }
      // Wait for the control to be in its SEND role (proof ProseMirror registered
      // the text, and that no generation is in flight).
      await waitFor(() => !!sendButton(), 1500);
      // Still not a send button? Either a generation really is running (in which
      // case unwedge refuses and we fall through), or the control is stuck in its
      // stop role with nothing generating - the case that stranded the result.
      if (!sendButton()) await unwedgeStopPersistently();
      const btn = sendButton();
      // Disabled send = a quota wall, not a wedge. Clicking it does nothing and
      // Enter is refused too, so return now and let scanError surface the reason
      // instead of burning the caller's retries in silence.
      if (btn && btn.disabled) { diag("send.disabled", {}); return; }
      if (btn) { btn.click(); return; }
      // Fallback: Enter sends in ChatGPT's composer.
      const o = { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true, cancelable: true };
      ed.dispatchEvent(new KeyboardEvent("keydown", o));
      ed.dispatchEvent(new KeyboardEvent("keyup", o));
    } finally {
      if (relock) { const e2 = getEditor(); if (e2 && e2.tagName !== "TEXTAREA") e2.setAttribute("contenteditable", "false"); }
    }
  }

  function stopGeneration() {
    const b = stopButton();
    if (b) try { b.click(); } catch {}
  }

  // No site modes to enforce on ChatGPT (model picker is left to the user).
  function enforceComposer() { return { ready: true }; }
  async function ensureComposerReady(reason) {
    diag("mode_ready", { reason, provider: "chatgpt" });
    return { ready: !!getEditor() };
  }

  // ── Error / limit detection (site chrome only) ────────────────────────────
  // A quota wall does NOT surface as an error banner: ChatGPT simply DISABLES the
  // send button (disabled=true, opacity .35, still in its send role) and prints a
  // "Chat en pause jusqu'à la réinitialisation du quota" notice. Nothing throws,
  // so without this the loop keeps re-typing into a composer that can never be
  // submitted and the bar sits on "running" forever - which is exactly what has
  // to be avoided. Reported as a normal site error so the core can end the turn
  // and tell the user.
  const sendIsDisabled = () => {
    const b = submitButton();
    return !!b && !isStopBtn(b) && b.disabled;
  };
  // The nastier variant: the control is stuck in its STOP role AND disabled,
  // while nothing is generating. unwedgeStop() cannot help - clicking a disabled
  // button does nothing - and neither does any DOM-side nudge: an input event,
  // blur+focus and a real edit were all tried live and left it at
  // "stop-button (disabled)". Only reloading the page clears it, so the honest
  // move is to say so instead of silently retrying forever.
  const composerWedged = () => {
    const b = submitButton();
    return !!b && isStopBtn(b) && b.disabled && !genActive();
  };
  function pausedNotice() {
    // Only walk the DOM once the cheap signal (a disabled send) already says
    // something is wrong.
    for (const el of document.querySelectorAll("div,p,section")) {
      if (el.offsetParent === null || el.children.length > 6) continue;
      const t = (el.innerText || "").trim();
      if (t.length > 12 && t.length < 400 && RE.paused.test(t)) return t.slice(0, 240);
    }
    return null;
  }
  function scanError() {
    try {
      for (const el of document.querySelectorAll(S.errorSurfaces)) {
        if (el.offsetParent === null) continue;
        if (el.closest(LEGACY_TURN_SEL + "," + TURN_SEL)) continue; // model content, not UI chrome
        const t = (el.innerText || "").trim();
        if (t.length > 8 && t.length < 600 && RE.contextLimit.test(t)) return t.slice(0, 240);
      }
      // Composer has our text but ChatGPT refuses to accept it.
      if (editorText().trim() !== "") {
        if (composerWedged()) {
          return "ChatGPT's composer is stuck on \"stop\" and won't send - reload the page to recover this conversation.";
        }
        if (sendIsDisabled()) {
          return pausedNotice() ||
            "ChatGPT will not accept the message - its send button is disabled (quota reached, or the chat is paused).";
        }
      }
    } catch {}
    if (!getEditor()) return "The input box disappeared (session ended?).";
    return null;
  }
  const isTooLongMsg = (text) => RE.tooLong.test(text);
  const isBusyMsg = (text) => RE.busy.test(text);

  // ── Image attachment (best effort: paste + hidden file input) ─────────────
  function fileFromImage(img, i) {
    const mime = img.mimeType || "image/jpeg";
    const bin = atob(img.data);
    const arr = new Uint8Array(bin.length);
    for (let j = 0; j < bin.length; j++) arr[j] = bin.charCodeAt(j);
    const ext = mime.includes("png") ? "png" : "jpg";
    return new File([arr], `zeroscript_${Date.now()}_${i}.${ext}`, { type: mime });
  }
  async function attachImages(images) {
    const ed = getEditor();
    if (!ed || !images || !images.length) return false;
    const dt = new DataTransfer();
    images.forEach((img, i) => { try { dt.items.add(fileFromImage(img, i)); } catch {} });
    if (!dt.items.length) return false;
    ed.focus();
    ed.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
    // The real upload input (validated live 2026-08); the generic selector is a
    // fallback in case the testid is renamed.
    const fileInput = document.querySelector('input[data-testid="upload-photos-input"]') ||
      document.querySelector('input[type="file"]');
    if (fileInput) {
      try { fileInput.files = dt.files; fileInput.dispatchEvent(new Event("change", { bubbles: true })); } catch {}
    }
    // An upload preview appearing near the composer is the success signal.
    return await waitFor(() => {
      const box = composerFrame();
      return !!(box && box.querySelector("img, [class*='preview'], [class*='thumbnail']"));
    }, 15000);
  }
  function clearAttachments() {
    try {
      const box = composerFrame();
      if (!box) return;
      box.querySelectorAll("[aria-label*='upprimer'], [aria-label*='emove'], [aria-label*='Remove'], [class*='delete'], [class*='remove']")
        .forEach((d) => { try { d.click(); } catch {} });
    } catch {}
  }

  // ── New chat navigation ───────────────────────────────────────────────────
  function findNewChatButton() {
    return document.querySelector('a[data-testid="create-new-chat-button"]') ||
      [...document.querySelectorAll('a[href="/"], button')].find(
        (a) => a.offsetParent !== null && /new chat|nouvelle discussion|nouveau chat/i.test(a.getAttribute("aria-label") || a.textContent || "")
      ) || null;
  }
  async function openNewChat() {
    const btn = findNewChatButton();
    if (!btn) return false;
    const prevPath = location.pathname;
    try { btn.click(); } catch {}
    await waitFor(() => location.pathname !== prevPath && chatIsEmpty() && !!getEditor(), 6000);
    await waitFor(() => chatIsEmpty() && !!getEditor(), 2000);
    return true;
  }

  // "/" = a fresh chat whose conversation id is not assigned yet → "" (transient)
  // so the core never persists it as "started"; /c/<id> = a real conversation.
  const conversationKey = () => (/^\/c\//.test(location.pathname) ? location.pathname : "");

  // ── ChatGPT-only system-prompt rules ──────────────────────────────────────
  // Appended to the shared system prompt via core/config.js's `providerNotes`
  // hook, so no other provider sees a word of this.
  //
  // Why ChatGPT needs the image rule and the others don't: ChatGPT reaches for
  // its own image GENERATION on any turn that carries an image, and answers by
  // producing a new picture instead of doing the Roblox work the image was
  // meant to illustrate. Its native image tool also runs in the sandbox that
  // cannot touch the user's project, so a generated image is a dead end here.
  const PROMPT_EXTRA = `- WHEN THE USER SENDS AN IMAGE: by default it is REFERENCE MATERIAL for the work they want done in their project - a screenshot of a bug, a mockup of the UI they want, a photo of the thing to build, a picture of what is wrong in Studio. Look at it, use it to understand what they want, and then do that work with the ZeroScript commands. Do NOT generate a new image from it, and do NOT treat it as an image-editing request. Only generate an image when the user EXPLICITLY asks you to create, generate, draw or edit one ("make me an image of...", "generate a texture", "edit this picture"). If what they want from the image is genuinely unclear, ask them in one short sentence rather than guessing - and never guess "they want a picture".`;

  // ── User-send interception ────────────────────────────────────────────────
  function installSendHooks(handlers) {
    document.addEventListener(
      "keydown",
      (e) => {
        if (e.key !== "Enter" || e.shiftKey || e.isComposing) return;
        const ed = getEditor();
        if (!ed || !ed.contains(e.target)) return;
        if (editorText().trim() === "") return;
        if (handlers.isBlocked()) return;
        // No session yet → nudge toward Start, but NEVER block the send. The
        // user is entitled to just chat with ChatGPT; the extension is opt-in.
        // This used to preventDefault + stopImmediatePropagation (ported from an
        // older, stricter pattern), which made a blank ChatGPT tab impossible to
        // type in until an agent was started - a regression against every other
        // provider. Matches deepseek.js: "nudge only; never block plain chat".
        if (!handlers.isStarted()) {
          if (!chatIsEmpty()) return; // existing conversation → not ours to gate
          handlers.onBlockedAttempt();
          return;
        }
        handlers.onUserMessage(assistantCount());
      },
      true
    );

    document.addEventListener(
      "click",
      (e) => {
        if (!getEditor()) return;
        const t = e.target;
        // Native "Continue generating" = a clear intent to RESUME after truncation.
        const cont = t && t.closest && t.closest("button");
        if (cont && RE.continueBtn.test((cont.innerText || "").trim())) {
          handlers.onNativeContinue();
          return;
        }
        // Stop is tested FIRST: it is the same node as send, just in its other
        // role, so a stop click would otherwise read as a user send.
        const stop = t && t.closest && t.closest(S.stopBtn);
        if (stop) { handlers.onNativeStop(); return; }
        const btn = t && t.closest && t.closest(S.submitBtn);
        if (!btn || isStopBtn(btn)) return;
        if (handlers.isBlocked()) return;
        // Same as the keydown path: nudge, never block (see the comment there).
        if (!handlers.isStarted()) {
          if (!chatIsEmpty()) return;
          handlers.onBlockedAttempt();
          return;
        }
        handlers.onUserMessage(assistantCount());
      },
      true
    );
  }

  // ── Tool-block location for camouflage ────────────────────────────────────
  // ChatGPT wraps each fenced code block in ONE <pre> inside .markdown (markers
  // and JSON survive intact in textContent), so a whole ###LUA###…###END_LUA###
  // or JSON command block is one atomic <pre>. Hide every <pre> in the reply
  // whose text carries a command shape, plus any bare top-level paragraph that
  // holds an inline command (the model is told to use code blocks, but this
  // catches a stray inline one). React re-creates these nodes on every token, so
  // - like Gemini - we also mark the .markdown container with .zs-cmd-mask; the
  // overlay.css rule keeps every recreated <pre> hidden with no flash.
  const CMD_SHAPE = /"(?:command|tool)"\s*:\s*"|###\s*lua|###mcp_tool###/i;
  // Marker pair, for the UNFENCED case below. Kept separate from CMD_SHAPE so the
  // opener test can't also match the closer.
  const CMD_OPEN = /###\s*(?:LUA|MCP_TOOL)\s*###/i;
  const CMD_CLOSE = /###\s*END_(?:LUA|MCP_TOOL)\s*###/i;

  function findToolBlockSpot(item /*, chip */) {
    const replies = replyNodes(item);
    let hidAny = null;
    const hide = (el, mc) => {
      el.classList.add("zs-tool-hide");
      if (mc) mc.classList.add("zs-cmd-mask");
      hidAny = hidAny || { parent: el.parentElement, ref: el };
    };
    for (const mc of replies) {
      // 1. Fenced code blocks carrying a command.
      mc.querySelectorAll(S.codeWrap).forEach((pre) => {
        if (pre.closest(".zs-chip")) return;
        if (CMD_SHAPE.test(pre.textContent || "")) hide(pre, mc);
      });
      // 2. Bare top-level blocks with an inline command (no <pre> inside).
      const kids = [...mc.children];
      kids.forEach((el) => {
        if (el.classList.contains("zs-chip") || el.querySelector(S.codeWrap)) return;
        const t = el.textContent || "";
        if (t.length < 600 && CMD_SHAPE.test(t)) hide(el, null);
      });
      // 3. UNFENCED command block spanning MANY siblings. Seen live 2026-08: the
      // model wrote ###LUA###…###END_LUA### as plain prose instead of a fenced
      // block, so ChatGPT's markdown renderer split a 208-line payload into 68
      // sibling <p>/<pre> nodes. Only the first one carries the marker, so the
      // per-element tests above hid the opener and left the whole script on
      // screen. Hide the RANGE: from the opener to the sibling holding the
      // closer (inclusive). Un-closed (still streaming) ⇒ hide to the end, so
      // there is no flash of raw code while it types.
      let ranged = 0;
      for (let i = 0; i < kids.length; i++) {
        const el = kids[i];
        if (el.classList.contains("zs-chip")) continue;
        const t = el.textContent || "";
        if (!CMD_OPEN.test(t)) continue;
        if (CMD_CLOSE.test(t)) { hide(el, mc); ranged++; continue; } // all in one node
        for (let j = i; j < kids.length; j++) {
          const k = kids[j];
          if (k.classList.contains("zs-chip")) continue;
          hide(k, mc); ranged++;
          if (CMD_CLOSE.test(k.textContent || "")) { i = j; break; }
        }
      }
      // Anti-reflash for the ranged case. .zs-cmd-mask only re-hides recreated
      // <pre>; the <p> siblings of an unfenced block carry nothing but their
      // per-element class, which React wipes on every token. When the range
      // covers the WHOLE reply (the observed shape - the message IS the command),
      // mark the container so every child stays hidden through re-renders. If any
      // real prose sits outside the range, we do NOT: hiding it would eat the
      // model's actual answer, and a per-token flash is the lesser evil.
      if (ranged) {
        const body = kids.filter((k) => !k.classList.contains("zs-chip"));
        if (body.length && body.every((k) => k.classList.contains("zs-tool-hide"))) {
          mc.classList.add("zs-cmd-mask-all");
        }
      }
    }
    return hidAny;
  }

  return {
    id: "chatgpt",
    displayName: "ChatGPT",
    timings,
    // Exported for test-chatgpt.js (the Node smoke test drives it against a stub
    // DOM). The core reads replies through itemText/classifyText, not this.
    textWithout,
    // Vision OFF, like DeepSeek's text-only Expert tab. ChatGPT's free tier caps
    // image/file input separately from messages ("les fichiers, les images et
    // l'analyse sont indisponibles jusqu'à la réinitialisation de votre quota"),
    // so screen_capture would work sometimes and fail the rest of the time - the
    // worst kind of behaviour to hand a model. The core blocks the vision tools
    // outright instead (see main.js VISION_TOOLS).
    supportsVision: false,
    // No coverOffsetY: the cover is centred on coverTarget(), the scrolling text
    // band, whose rect centre already lines up with the composer's icons. (Sizing
    // it to the EDITOR needed a -paddingBottom/2 nudge, because that node carries
    // bottom padding as growth headroom - covering the band removes the need.)
    // React re-renders a turn's content subtree on every token, wiping any chip
    // placed inside it. Anchor chips at the turn-element level (the stable
    // data-message-author-role div), where they survive those re-renders.
    chipAtItemLevel: true,
    // ChatGPT's turn elements are semantic (data-message-author-role) and carry
    // a stable id, so the core's "has THIS send produced its reply turn yet?"
    // gate is trustworthy here - it keys off lastAssistantId, which survives the
    // list virtualization that would break a count-based test.
    reliableCounts: true,
    // No unstableWarning: the free-tier caps are real, but the pill it renders is
    // a permanently-visible floating element and it sat ON TOP of ChatGPT's own
    // Settings dialog (seen live). ChatGPT already says so itself, in the thread,
    // when a quota runs out - that is a better place for the message than a badge
    // that outranks the site's modals.
    init({ diag: d } = {}) {
      if (d) diag = d;
      // Version beacon: stamp the loaded build onto <html> so a reload can be
      // confirmed from the page (read document.documentElement.dataset.zsGptVer).
      try { document.documentElement.setAttribute("data-zs-gpt-ver", "2026-08-13_cmtap+toolkey"); } catch {}
    },
    // turns
    allItems, isUserItem, isAssistantItem, itemText, classifyText,
    assistantCount, userCount, lastAssistant, lastAssistantId, itemKey, readAssistant,
    streamLen, snapshot,
    // composer / state
    getEditor, editorText, chatIsEmpty, isFreshChat, composerFrame, barMount,
    // Cover the scrolling text band, and lift the core's 200px clamp past that
    // band's own ~245px ceiling so a full composer is covered edge to edge.
    coverTarget,
    coverMaxH: 280,
    setInputLock, typeAndSend, stopGeneration,
    isGenerating, isBusyNow, isHardGenerating,
    enforceComposer, ensureComposerReady,
    turnHalted, findContinueBtn, clickContinueBtn,
    scanError, isTooLongMsg, isBusyMsg,
    // actions
    attachImages, clearAttachments, openNewChat, conversationKey,
    installSendHooks, findToolBlockSpot,
    promptExtra: PROMPT_EXTRA,
    // ChatGPT summarises its own context aggressively and loses the "an
    // extension executes this" part, then refuses to call commands at all. No
    // other provider has shown this, so no other provider sets these - they
    // stay on the single bootstrap prompt.
    resendSystemEvery: 6,   // user turns between re-statements
    // Ceiling for "result + system-prompt rider". Measured against the real cap
    // (SEND_HARD_CAP) rather than our 120k perf cap: the rider is added AFTER
    // truncateForSend, so budgeting at 120k would needlessly defer the rider for
    // every result over ~109k even though ChatGPT would accept the pair fine.
    // The margin absorbs the rider growing with a long user custom prompt.
    sendCharBudget: SEND_HARD_CAP - 4000,
  };
})();
