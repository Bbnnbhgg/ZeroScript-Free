// SPDX-License-Identifier: GPL-3.0-or-later
// providers/meta.js - the Meta AI (www.meta.ai) provider.
// Exports the same ZSProvider interface as providers/deepseek.js; the core
// (core/main.js) is provider-agnostic. To DISABLE Meta AI support, remove this
// file from manifest.json (and its URL from background.js PROVIDER_URLS).
//
// Meta AI DOM notes (validated live, 2026-07-13):
//  - React app. The message list is a <div class="flex flex-col"> whose direct
//    children are the turns (each a <div> with `starting:opacity-0` animate-in
//    classes). A leading `pointer-events-none absolute h-px w-px` spacer child
//    is NOT a turn (skipped: no text, no assistant-message).
//  - An ASSISTANT turn contains a <div data-testid="assistant-message">; a USER
//    turn does not (and carries plain text). Reasoning ("Réflexion" mode) renders
//    INSIDE the assistant-message as [data-testid="thinking-status"] +
//    [data-testid="subagent-cot-list"] - both are excluded from the read text so
//    a chain-of-thought never counts as model output or a command.
//  - Composer = real <textarea data-testid="composer-input"> (native value setter
//    + input event, like Arena/DeepSeek). Send = [data-testid="composer-send-button"]
//    (aria "Envoyer"); DURING generation it is replaced by
//    [data-testid="composer-stop-button"] (aria "Arrêter") and the send testid
//    disappears - that stop button present = generation active.
//  - New chat = [data-testid="new-chat-button"] → path "/". A conversation is
//    /prompt/<uuid>.
//  - TWO code-rendering traps (both handled here):
//    (a) a ```json fenced block renders as a custom INTERACTIVE JSON VIEWER
//        (.ur-code-block with a JSON/Tree/Raw toolbar). Its visible text is
//        "JSONTreeRaw▶{...}"; the {...} braces stay intact and the prefix has no
//        braces, so the parser's brace-matched extractToolAnywhere reads a JSON
//        command with NO special handling.
//    (b) a plain ``` fenced block (used for the ###LUA### execute_luau form) is a
//        real <pre><code> whose lines are separate <span class="block …counter…">
//        with NO newline text nodes → textContent COLLAPSES onto one line, which
//        would break multi-line Lua. textWithout() special-cases <pre> and joins
//        its line spans with "\n" to rebuild the source (same fix class as GLM's
//        .cm-line / Qwen's Monaco).
//  - IMPORTANT (viability): Meta AI's guardrail REFUSES to emit command JSON when
//    the framing is thin; the FULL ZeroScript system prompt (with the "commands
//    are NOT function calls, just TYPE the JSON" reassurance) defuses it and it
//    complies. Nothing to do in code - just never bootstrap with a stripped prompt.
//  - 2026-11-06 (user report, English locale): Meta reworked the response-mode
//    picker. The old "Instantané/Réflexion" dropdown contents became "Instant /
//    Answers straight away" and "Thinking / Reasons longer for better", the
//    old option testid may be gone, and the picker renders as a DIALOG-class
//    overlay. Critically, leaving it open hides the ZS bar (overlayBlocking)
//    and blocks the composer, which wedged "Start session" silently (bar gone,
//    nothing typed, no error visible - the banner renders inside the hidden
//    bar). ensureThinkMode now matches the option by text, clicks it with real
//    pointer events, and ALWAYS closes the picker before returning; the
//    composer write is verified with direct-editor fallbacks (writeComposerText).
// eslint-disable-next-line no-unused-vars
const ZSProvider = (() => {
  "use strict";
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  let diag = () => {}; // injected by core via init()
  // Identity of the last image set STAGED into the composer. The core reuses the
  // same array reference across submitAndGetBase's typeAndSend retries, so keying
  // on it makes the attach idempotent; a new capture is a new array.
  let _attachedImages = null;
  // Whether the composer is locked (agent working). React re-renders the composer
  // and restores the placeholder/contenteditable, so setInputLock's effects must
  // be RE-ASSERTED every sweep (enforceComposer) while this is true.
  let _locked = false;

  const S = {
    asst: '[data-testid="assistant-message"]',
    // The composer SWAPS element when media is attached: text-only it is a
    // <textarea data-testid="composer-input">; once an image is staged Meta hides
    // that textarea and shows a Lexical contenteditable <div data-testid=
    // "composer-input"> with the image inline. So key on the testid (not the tag)
    // and pick the visible one - see getEditor().
    input: '[data-testid="composer-input"]',
    sendBtn: '[data-testid="composer-send-button"]',
    stopBtn: '[data-testid="composer-stop-button"]',
    newChat: '[data-testid="new-chat-button"]',
    // Response-mode dropdown. OLD UI: the button shows the current mode
    // ("Instantané" / "Réflexion"); its menu options are think_fast (Instantané)
    // and think_hard (Réflexion). NEW UI (2026-11): the picker offers
    // "Instant / Answers straight away" and "Thinking / Reasons longer for
    // better", with no confirmed testids. We always force the hard/thinking
    // mode - Instant gives markedly worse replies - but never at the cost of
    // leaving the picker open (see ensureThinkMode).
    modeBtn: '[data-testid="composer-mode-dropdown-button"]',
    modeOptHard: '[data-testid="composer-mode-option-think_hard"]',
    reasoning: '[data-testid="thinking-status"],[data-testid="subagent-cot-list"]',
    codeWrap: ".ur-code-block",  // wraps both the JSON viewer and plain <pre> code
    errorSurfaces:
      '[role="alert"],[class*="toast"],[class*="error"],[class*="alert"]',
  };

  const RE = {
    contextLimit: new RegExp(
      [
        "conversation.{0,20}(too long|trop long)",
        "context.{0,20}(limit|exceeded|d\\u00e9pass\\u00e9)",
        "please.{0,30}(start|cr\\u00e9er).{0,20}(new|nouveau).{0,20}(chat|conversation)",
        "(token|context).{0,10}limit",
        "maximum.{0,20}context",
        "this conversation has reached",
      ].join("|"),
      "i"
    ),
    tooLong: /conversation .{0,20}(too long|getting too long|trop longue)/i,
    busy: /something went wrong|une erreur s.est produite|try again later|réessayer plus tard|rate limit|too many requests|trop de requ[êe]tes/i,
  };

  // Meta streams with a hard stop-button signal for the WHOLE generation (incl.
  // the "Réflexion" reasoning phase), so idle windows can be tight (like Gemini).
  const timings = {
    GEN_IDLE_MS: 1500,
    REASON_IDLE_MS: 12000,
    WARMUP_MS: 45000,
    REASON_NOREPLY_MS: 90000,
    STABLE_MS: 9000,
    RESPONSE_TIMEOUT_MS: 300000,
  };

  // ── Turn list ──────────────────────────────────────────────────────────────
  // The message list is the <div class="flex flex-col"> that holds an
  // assistant-message and >1 child turn. Climb from any assistant-message to it;
  // fall back to the nearest such container. Returns null on a fresh/empty chat.
  function listEl() {
    const any = document.querySelector(S.asst);
    if (!any) return null;
    let n = any.parentElement;
    for (let i = 0; i < 12 && n; i++, n = n.parentElement) {
      if (
        n.classList.contains("flex") &&
        n.classList.contains("flex-col") &&
        n.children.length >= 2 &&
        n.querySelector(S.asst)
      ) {
        return n;
      }
    }
    return null;
  }

  // A real turn child (excludes the tiny `pointer-events-none absolute h-px w-px`
  // scroll spacer, which has no text and no assistant-message).
  // Use textContent, NOT innerText: the core hides a whole injected turn (the
  // bootstrap system prompt and every "Output of '…'" result) with display:none,
  // and innerText returns "" for a display:none node - which dropped those turns
  // from allItems() so classify() never built their sys / "· result" chips (the
  // result box rendered as literally nothing). textContent ignores CSS, so the
  // hidden turns stay enumerated and get decorated.
  function isTurnChild(c) {
    if (!c) return false;
    if (c.classList.contains("pointer-events-none") && c.classList.contains("absolute")) return false;
    return !!c.querySelector(S.asst) || (c.textContent || "").trim().length > 0;
  }
  function domTurns() {
    const list = listEl();
    if (!list) return [];
    return [...list.children].filter(isTurnChild);
  }

  const isAssistantItem = (item) => !!item && !!item.querySelector(S.asst);
  const isUserItem = (item) => !!item && !isAssistantItem(item);

  // The assistant-message body element inside an assistant turn (reasoning still
  // nested; excluded when we read it). For a user turn it is the turn itself.
  function bodyOf(item) {
    if (!item) return null;
    return isAssistantItem(item) ? item.querySelector(S.asst) : item;
  }

  const allItems = () => domTurns();
  const assistantItems = () => allItems().filter(isAssistantItem);
  const assistantCount = () => assistantItems().length;
  const userCount = () => allItems().filter(isUserItem).length;
  const lastAssistant = () => {
    const it = assistantItems();
    return it.length ? it[it.length - 1] : null;
  };

  // Stable per-NODE id for the latest assistant turn (the core prefers this over
  // count-based detection). A WeakMap assigns each turn a monotonic id on first
  // sight, so a genuinely new reply node yields a new id immediately.
  const _idMap = new WeakMap();
  let _idSeq = 0;
  function lastAssistantId() {
    const it = lastAssistant();
    if (!it) return null;
    let id = _idMap.get(it);
    if (!id) { id = ++_idSeq; _idMap.set(it, id); }
    return id;
  }

  const chatIsEmpty = () => allItems().length === 0;

  // ── Text extraction ─────────────────────────────────────────────────────────
  // Walk the tree skipping the core's chip, the reasoning blocks, and any extra
  // excluded subtree. A <pre> is special-cased: Meta renders each code line as a
  // block <span> with NO newline text node, so plain textContent collapses the
  // block onto one line (breaks multi-line Lua). Rebuild it by joining the code
  // element's line children with "\n".
  function textWithout(root, excludeSel) {
    if (!root) return "";
    const skip = ".zs-chip, " + S.reasoning + (excludeSel ? ", " + excludeSel : "");
    let t = "";
    const walk = (n) => {
      if (n.nodeType === 3) { t += n.nodeValue; return; }
      if (n.nodeType !== 1) return;
      if (n.matches && n.matches(skip)) return;
      // A ```json fence renders as the INTERACTIVE JSON-VIEWER widget (a
      // .ur-code-block with a JSON/Tree/Raw toolbar and a collapsible tree), NOT
      // a <pre>. In its Tree view it injects a ▶/▼ expander glyph BEFORE every
      // nested object/array key - and those glyphs land INSIDE the braces, e.g.
      // `{"command":"get_studio_state",▶"params":{}}`. That corrupted JSON made
      // JSON.parse fail → a "bad JSON" parse_error every time the model emitted a
      // command with a nested object, then it retried, re-rendered, and failed
      // again (the reported spam). Detect the viewer (a .ur-code-block with no
      // <pre>) and hand the parser the cleaned JSON instead of the raw tree text.
      if (n.matches && n.matches(S.codeWrap) && !n.querySelector("pre")) {
        // The viewer's Tree view does not just decorate the JSON, it ABRIDGES it:
        // a large array/object is rendered as a summary placeholder instead of its
        // contents, e.g. `…,"edits":[1 item]}}` for a 19k-char multi_edit payload
        // (reproduced live 2026-08-13 - that is the "bad JSON" parse_error on any
        // big command). The full source only exists in the viewer's Raw tab. Flip
        // command-shaped viewers to Raw; the widget then renders a real <pre> and
        // the branch below reads the complete JSON.
        ensureRawView(n);
        t += cleanJsonViewer(n.textContent || "");
        return;
      }
      if (n.tagName === "PRE") { t += preText(n); return; }
      for (const c of n.childNodes) walk(c);
    };
    walk(root);
    return t;
  }
  // Switch a JSON-viewer widget from its Tree view to Raw, once. Tree ABRIDGES
  // long values ("[1 item]") and interleaves ▶ glyphs; Raw is the verbatim source
  // inside a real <pre>. Only touched for command-shaped blocks so a viewer the
  // user is reading for their own sake is left alone. React may not have rendered
  // the Raw <pre> by the time this call returns - that is fine: the core re-reads
  // the reply every sweep, so the following read picks up the complete text (a
  // partial read just looks like one more streaming tick).
  const _rawSwitched = new WeakSet();
  function ensureRawView(wrap) {
    try {
      if (_rawSwitched.has(wrap)) return;
      const txt = wrap.textContent || "";
      if (!/"(?:command|tool)"\s*:/.test(txt)) return;
      const btn = [...wrap.querySelectorAll('button,[role="tab"]')].find(
        (b) => (b.textContent || "").trim().toLowerCase() === "raw"
      );
      if (!btn) return;
      _rawSwitched.add(wrap);
      btn.click();
      diag("meta.jsonviewer.raw", { len: txt.length });
    } catch {}
  }
  // Strip the JSON-viewer widget's chrome so only the JSON object is left:
  // remove the tree-expander triangles (▶ ▼ ► ◀ ▲ ▾ …) that Meta interleaves
  // between JSON tokens, then drop the leading "JSONTreeRaw" toolbar text that
  // precedes the first "{". Trailing toolbar/Copy chrome after the JSON is
  // harmless - the core's brace-matched extractor stops at the closing brace.
  function cleanJsonViewer(text) {
    const t = text.replace(/[▲▴▶▸►▼▾◀◂]/g, "");
    const i = t.indexOf("{");
    return i > 0 ? t.slice(i) : t;
  }
  // Rebuild a <pre>'s source: join the code element's per-line block children
  // with "\n". A single-line block (no element children) falls back to textContent.
  function preText(pre) {
    const code = pre.querySelector("code") || pre;
    const lines = [...code.children].filter((c) => c.nodeType === 1);
    if (lines.length) return lines.map((l) => l.textContent).join("\n");
    return code.textContent || "";
  }

  function itemText(item) {
    const b = bodyOf(item);
    return b ? textWithout(b) : "";
  }
  function classifyText(item, excludeSel) {
    const b = bodyOf(item);
    if (!b) return "";
    return textWithout(b, excludeSel);
  }

  // ── Chip anchor ─────────────────────────────────────────────────────────────
  // Anchor the chip inside the assistant-message body so it sits under the reply.
  // React reconciles the turn subtree on stream updates; ensureOwnedChip rebuilds
  // the chip after each wipe (same as the other providers).
  function chipAnchor(item) {
    const body = bodyOf(item);
    if (!body) return item;
    // Anchor into the reply's CENTERED content column (mx-auto max-w-3xl flex-col),
    // not the full-width assistant-message: the latter stretched the chip across
    // the whole turn and dropped it BELOW the like/copy action bar. This column
    // caps the chip to the text width, left-aligns it (with align-self:flex-start
    // in overlay.css), and sits before the actions group so the chip reads right
    // under the reply text.
    const col = [...body.querySelectorAll("div")].find((e) => {
      const c = e.className || "";
      return /mx-auto/.test(c) && /max-w-/.test(c) && /flex-col/.test(c) && !/actions/.test(c);
    });
    return col || body;
  }

  // ── Composer ────────────────────────────────────────────────────────────────
  // Meta's composer is a Lexical contenteditable <div data-testid="composer-input">,
  // MIRRORED by a hidden <textarea data-testid="composer-input"> that acts as the
  // controlled input: writing to that textarea via the native value setter drives
  // the visible editor (text appears, send enables) and clears it cleanly - even
  // with an image staged inline (validated live 2026-07-13). So we treat the
  // textarea as the source of truth for READ/WRITE, and the visible div for
  // geometry (barAnchor) and user-event targeting (installSendHooks).
  const editorEls = () => [...document.querySelectorAll(S.input)].filter((e) => !e.closest("#zs-root"));
  const isTextareaEditor = (e) => !!e && e.tagName === "TEXTAREA";
  // getEditor() = the ON-SCREEN editor (the Lexical div). The core anchors the
  // "Agent is working…" cover and the .zs-typing mask to P.getEditor(), so it MUST
  // be the visible node (the hidden mirror textarea has a 0x0 rect and put the
  // cover off-screen). Layout (barAnchor) and event targeting use this too.
  const getEditor = () => {
    const all = editorEls();
    return all.find((e) => !isTextareaEditor(e) && e.offsetParent !== null) ||
           all.find((e) => e.offsetParent !== null) || all[0] || null;
  };
  const visibleEditor = getEditor; // alias (kept for call-site clarity)
  // writeEl() = the controlled mirror textarea we WRITE to: setting its value via
  // the native setter drives the visible Lexical editor and clears it cleanly.
  // Falls back to the on-screen editor if Meta ever drops the textarea.
  const writeEl = () => editorEls().find(isTextareaEditor) || getEditor();
  const editorText = () => {
    // Read the EFFECTIVE editor. The write path may fall back to the on-screen
    // node when the mirror textarea is gone or dead (2026-11 composer changes),
    // and reading a stale mirror would fake an "empty" box - the send
    // confirmation ("cleared") and the user-send gate both rely on this text.
    const ve = getEditor();
    if (ve && !isTextareaEditor(ve) && ve !== writeEl()) return ve.textContent || "";
    const e = writeEl();
    if (!e) return "";
    return isTextareaEditor(e) ? (e.value || "") : (e.textContent || "");
  };
  // No <form> around the composer; the rounded card is the closest stable frame.
  const composerFrame = () => barAnchor() || (visibleEditor() && visibleEditor().parentElement) || null;

  // A fresh chat: root path "/" with the composer present and no turns.
  const isFreshChat = () => chatIsEmpty() && location.pathname === "/" && !!getEditor();

  // Meta is a React app that reconciles the composer subtree, so we do NOT insert
  // #zs-bar into it. barAnchor() returns the rounded composer card; the core
  // keeps the bar in #zs-root and hugs the card's top edge.
  function barAnchor() {
    const ed = visibleEditor();
    if (!ed) return null;
    let n = ed;
    for (let i = 0; i < 10 && n; i++, n = n.parentElement) {
      if ([...n.classList].some((c) => c.startsWith("rounded"))) return n;
    }
    return (ed && ed.parentElement) || null;
  }

  // The element the "Agent is working…" cover is sized to: the text-entry band
  // ONLY, never the controls row. The rounded composer card has two children -
  // [0] the scroller band that holds the editor, [1] the controls row (attach /
  // Réflexion-Instantané mode toggle / send). Return band [0] (the card child that
  // contains the editor) so the cover leaves the controls - and the ZS bar above -
  // uncovered and usable. Falls back to the editor if the structure changes.
  function coverTarget() {
    const card = barAnchor();
    const ed = getEditor();
    if (!card || !ed) return ed;
    let n = ed;
    while (n && n.parentElement && n.parentElement !== card) n = n.parentElement;
    return (n && n.parentElement === card) ? n : ed;
  }

  // ── Input lock ──────────────────────────────────────────────────────────────
  // Block the user from typing while the agent works. We drive the composer via
  // the mirror textarea, so locking the on-screen Lexical div's `contenteditable`
  // stops user edits without affecting our own writes. Also mark the textarea
  // readonly as a belt-and-braces (the native setter ignores readonly).
  function setInputLock(on) {
    _locked = on;
    applyLock();
  }
  // Apply the lock state to the live composer nodes. Called by setInputLock AND
  // re-asserted every sweep (enforceComposer) because Meta's React re-renders the
  // composer and would otherwise restore the placeholder / editability mid-lock.
  function applyLock() {
    const div = getEditor();
    if (div && !isTextareaEditor(div)) div.setAttribute("contenteditable", _locked ? "false" : "true");
    const ta = writeEl();
    if (ta && isTextareaEditor(ta)) { if (_locked) ta.setAttribute("readonly", ""); else ta.removeAttribute("readonly"); }
    // Hide Meta's own composer placeholder ("Demandez à Meta AI…") while locked:
    // it is an absolute, pointer-events-none sibling overlapping the editor and
    // would otherwise show THROUGH the core's "Agent is working…" cover (double
    // text).
    const ph = placeholderEl();
    if (ph) ph.style.visibility = _locked ? "hidden" : "";
  }
  // Meta's Lexical placeholder = a `div.pointer-events-none.absolute` inside the
  // editor's nearest `.relative` container.
  function placeholderEl() {
    const div = getEditor();
    const rel = div && div.closest && div.closest(".relative");
    return rel ? rel.querySelector("div.pointer-events-none.absolute") : null;
  }

  // ── Buttons / generation detection ──────────────────────────────────────────
  // Send/stop discovery: the 2026-07 testids first; if the composer redesign
  // renamed them, fall back to an aria-label/testid text match on buttons in
  // the composer card. A wrong guess here is harmless (the button must still
  // be enabled and the send is confirmed by the composer clearing).
  function findControlButton(kind) {
    const byId = document.querySelector(kind === "send" ? S.sendBtn : S.stopBtn);
    if (byId && byId.offsetParent !== null) return byId;
    const card = barAnchor();
    const scope = card && card.isConnected ? card : document;
    const re = kind === "send"
      ? /send|envoyer|envoi|submit|paper/i
      : /stop|arr[êe]ter|halt/i;
    for (const btn of scope.querySelectorAll("button")) {
      if (btn.closest("#zs-root") || btn.offsetParent === null) continue;
      if (btn.disabled || btn.getAttribute("aria-disabled") === "true") continue;
      const label = ((btn.getAttribute("aria-label") || "") + " " +
                     (btn.getAttribute("data-testid") || "")).toLowerCase();
      if (re.test(label)) return btn;
    }
    return null;
  }
  const sendButton = () => findControlButton("send");
  const stopButton = () => findControlButton("stop");

  function streamText(item) {
    const b = bodyOf(item);
    return b ? textWithout(b, ".zs-chip") : "";
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

  function genActive() {
    sampleStream();
    // The stop button is Meta's authoritative "still working" signal and stays up
    // through the ENTIRE Réflexion reasoning phase (which can run minutes, sometimes
    // with a stray reply fragment emitted BEFORE the reasoning even starts). Trust it
    // outright: present = generating, no timer cap. When it is gone, fall back to the
    // stream-growth idle window. Previously genActive only trusted the button for a
    // 10s growth window, so a long reasoning phase read as "generation ended" ~40s
    // early, the loop abandoned the turn, lastGenAt went stale, and the eventual
    // command landed orphaned ("not run").
    if (stopButton()) return true;
    return grewWithin(timings.GEN_IDLE_MS);
  }
  const isGenerating = genActive;
  const isBusyNow = genActive;
  const isHardGenerating = () => !!stopButton();

  // Meta exposes no per-turn "stopped"/"continue" markers.
  const turnHalted = () => false;
  const findContinueBtn = () => null;
  const clickContinueBtn = () => false;

  function snapshot() {
    try {
      const b = bodyOf(lastAssistant());
      return { th: 0, rp: b ? textWithout(b).length : 0 };
    } catch { return {}; }
  }

  function readAssistant() {
    const item = lastAssistant();
    if (!item) return { present: false, reply: "", thinking: "", item: null };
    const b = bodyOf(item);
    return { present: true, reply: b ? textWithout(b, ".zs-chip").trim() : "", thinking: "", item };
  }

  async function waitFor(pred, timeout) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      if (pred()) return true;
      await sleep(120);
    }
    return false;
  }

  // ── Image attachment (validated live 2026-07-13) ────────────────────────────
  // Meta's composer holds ONE hidden multi-file input[type=file] (accepts image
  // png/jpeg/webp/gif …). Setting its .files + dispatching `change` stages the
  // image: the composer SWAPS to a Lexical contenteditable and the image mounts
  // inline as <span class="inline-image-node"> … <img alt="<filename>">, with a
  // per-image button[aria-label="Remove image"]. Meta keeps a local blob preview
  // and only uploads on SEND (like Arena), so "attach done" = the preview img is
  // present. NOTE: the end-to-end send-with-image path is wired from the DOM
  // contract but not yet exercised live (the test account's message quota was
  // exhausted) - verify with a real screen_capture round-trip.
  function fileFromImage(img, i) {
    const mime = img.mimeType || "image/jpeg";
    const bin = atob(img.data);
    const arr = new Uint8Array(bin.length);
    for (let j = 0; j < bin.length; j++) arr[j] = bin.charCodeAt(j);
    const ext = mime.includes("png") ? "png" : mime.includes("webp") ? "webp" : mime.includes("gif") ? "gif" : "jpg";
    return new File([arr], `zeroscript_${Date.now()}_${i}.${ext}`, { type: mime });
  }
  const fileInputEl = () => {
    for (const inp of document.querySelectorAll('input[type="file"]')) {
      if (!inp.closest("#zs-root")) return inp;
    }
    return null;
  };
  // The staged preview is an <img> INSIDE a composer-input (the contenteditable).
  // A SENT image lands in the chat turn instead, so scoping to composer-input
  // naturally excludes history.
  const pendingPreview = () => {
    for (const ci of document.querySelectorAll(S.input)) {
      const img = ci.querySelector("img");
      if (img) return img;
    }
    return null;
  };
  const hasPendingAttachment = () => !!pendingPreview();
  let _imgSeq = 0;
  function tagImages(images) {
    if (images && images.__zsId == null) {
      try { Object.defineProperty(images, "__zsId", { value: ++_imgSeq, enumerable: false }); }
      catch { images.__zsId = ++_imgSeq; }
    }
    return images;
  }
  async function attachImages(images) {
    const inp = fileInputEl();
    if (!inp || !images || !images.length) return false;
    tagImages(images);
    const dt = new DataTransfer();
    images.forEach((img, i) => { try { dt.items.add(fileFromImage(img, i)); } catch {} });
    if (!dt.items.length) return false;
    try {
      inp.files = dt.files;
      inp.dispatchEvent(new Event("change", { bubbles: true }));
    } catch { return false; }
    const ok = await waitFor(hasPendingAttachment, 15000);
    diag("meta.attach.preview", { ok });
    return ok;
  }
  function clearAttachments() {
    try {
      document.querySelectorAll('button[aria-label="Remove image"]').forEach((b) => { try { b.click(); } catch {} });
    } catch {}
    _attachedImages = null;
  }

  // ── Sending ─────────────────────────────────────────────────────────────────
  function setTextareaValue(el, v) {
    const proto = window.HTMLTextAreaElement && window.HTMLTextAreaElement.prototype;
    const setter = proto && Object.getOwnPropertyDescriptor(proto, "value");
    if (setter && setter.set) setter.set.call(el, v);
    else el.value = v;
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }

  // Whitespace-insensitive equality: rich editors render paragraphs as
  // elements with no newline text nodes, so a multi-line write can never be
  // compared byte-for-byte against the visible editor's textContent. Stripping
  // ALL whitespace still proves "the text landed" without accepting a partial.
  const normEq = (a, b) =>
    (a || "").replace(/\s+/g, "") === (b || "").replace(/\s+/g, "");

  // Type `text` into the composer, VERIFIED. Path 1 is the 2026-07 contract
  // (hidden mirror textarea drives the visible editor). Paths 2-4 cover a
  // composer where that mirror is gone or no longer drives anything (the
  // 2026-11 report): they write the VISIBLE editor directly - a synthetic
  // paste (Lexical-class editors insert multi-line clipboard text properly),
  // then line-by-line execCommand (plain contenteditables), then a raw
  // textContent swap with an input event. Each step is verified before use.
  async function writeComposerText(text) {
    const ta = editorEls().find(isTextareaEditor);
    if (ta) {
      setTextareaValue(ta, text);
      await sleep(250);
      const ve = getEditor();
      if (ve === ta) return normEq(ta.value, text); // the textarea IS the editor
      if (ve && normEq(ve.textContent, text)) return true; // mirror drove Lexical
      // Mirror is dead: fall through and write the visible editor directly.
    }
    const ed = getEditor();
    if (!ed) return false;
    if (isTextareaEditor(ed)) {
      setTextareaValue(ed, text);
      await sleep(150);
      return normEq(ed.value, text);
    }
    ed.focus();
    // Select existing content so the first insert REPLACES it (never append).
    try {
      const sel = window.getSelection();
      const rng = document.createRange();
      rng.selectNodeContents(ed);
      sel.removeAllRanges(); sel.addRange(rng);
    } catch {}
    // (a) Synthetic paste - the editor's own clipboard handler does the insert.
    try {
      const dt = new DataTransfer();
      dt.setData("text/plain", text);
      ed.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: dt }));
    } catch {}
    await sleep(250);
    if (normEq(ed.textContent, text)) return true;
    // (b) Line-by-line execCommand - the classic contenteditable write; one
    // insertLineBreak per newline keeps multi-line payloads (###LUA###) intact.
    try {
      const sel = window.getSelection();
      const rng = document.createRange();
      rng.selectNodeContents(ed);
      sel.removeAllRanges(); sel.addRange(rng);
    } catch {}
    const lines = String(text).split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (lines[i]) { try { document.execCommand("insertText", false, lines[i]); } catch {} }
      if (i < lines.length - 1) { try { document.execCommand("insertLineBreak"); } catch {} }
    }
    await sleep(200);
    if (normEq(ed.textContent, text)) return true;
    // (c) Last resort: swap the content and notify React.
    if (!normEq(ed.textContent, text)) {
      ed.textContent = text;
      ed.dispatchEvent(new InputEvent("input", { bubbles: true, cancelable: true, inputType: "insertText", data: text }));
      await sleep(150);
    }
    return normEq(ed.textContent, text);
  }

  async function typeAndSend(text, images) {
    // Images FIRST: staging swaps in the inline image; the mirror textarea still
    // drives the composed text alongside it. Idempotent across the core's up-to-4
    // retries via the _attachedImages identity guard.
    if (images && images.length && images !== _attachedImages) {
      if (hasPendingAttachment()) clearAttachments();
      try {
        const ok = await attachImages(images);
        if (ok) _attachedImages = images;
        diag("meta.tas.attached", { ok, imgId: images.__zsId });
      } catch (e) { diag("meta.tas.attachErr", { msg: String((e && e.message) || e) }); }
    }
    // Write the text (verified, with direct-editor fallbacks for a composer the
    // mirror textarea no longer drives), then send.
    const editor = writeEl();
    if (!editor) throw new Error("Meta AI input box not found");
    editor.focus();
    const wrote = await writeComposerText(text);
    diag("meta.tas.write", { ok: wrote, len: text.length });
    const sendReady = () => {
      const b = sendButton();
      return !!b && !b.disabled && b.getAttribute("aria-disabled") !== "true";
    };
    await waitFor(sendReady, 30000);
    // Click and CONFIRM the send took (the composer clears - text AND any staged
    // image - the instant Meta accepts it). Re-click / fall back to Enter until it
    // clears so a swallowed click can't strand the message.
    let sent = false;
    for (let i = 0; i < 6 && !sent; i++) {
      if (sendReady()) {
        try { sendButton().click(); } catch {}
      } else if (!isHardGenerating()) {
        // Fallback: Enter on the on-screen editor (the send button click is the
        // primary path; this only covers a swallowed click).
        const target = visibleEditor() || editor;
        const o = { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true, cancelable: true };
        target.dispatchEvent(new KeyboardEvent("keydown", o));
        target.dispatchEvent(new KeyboardEvent("keyup", o));
      }
      sent = await waitFor(() => editorText().trim() === "" && !hasPendingAttachment(), 700);
    }
    if (sent) _attachedImages = null;
    diag("meta.tas.sent", { sent, editorLen: editorText().length });
  }

  function stopGeneration() {
    const b = stopButton();
    if (b) { try { b.click(); } catch {} }
  }

  // ── Response mode (Instant vs Thinking / Réflexion) ────────────────────────
  // A fresh account defaults to the fast mode ("Instantané" / "Instant" /
  // think_fast), which gives markedly worse replies; the hard mode
  // ("Réflexion" / "Thinking" / think_hard) reasons before answering. Meta
  // REMEMBERS the last-used mode across chats, so we only need to flip it once.
  //
  // 2026-11 rework: Meta replaced the picker's contents ("Instant / Answers
  // straight away" vs "Thinking / Reasons longer for better") and it renders as
  // a DIALOG-class overlay. The old code (a) only recognised the old option
  // testid, so it opened the picker and clicked nothing, and (b) its Escape
  // fallback no longer closes the new picker - leaving it open HIDES the ZS
  // bar (overlayBlocking) and blocks the composer, which wedged "Start
  // session" with no visible error (banner renders inside the hidden bar).
  // The rewrite below matches controls by text, clicks with real pointer
  // events, and ALWAYS closes whatever it opened before returning.
  const MODE_FAST_TEXT = /instantan[ée]|instant|straight away|answers? straight/i;
  const MODE_HARD_TEXT = /thinking|r[ée]flexion|think.?hard|reasons? longer/i;
  const isHardModeText = (t) => !!t && MODE_HARD_TEXT.test(t) && !MODE_FAST_TEXT.test(t);

  // The mode toggle: the old testid, else a short chip inside the composer
  // card labelled Instant / Thinking / Instantané / Réflexion. Scoped to the
  // card so the OPEN picker's own "Instant" card is never mistaken for it.
  function findModeControl() {
    const byId = document.querySelector(S.modeBtn);
    if (byId && byId.offsetParent !== null) return byId;
    const card = barAnchor();
    if (!card) return null;
    for (const c of card.querySelectorAll("button,[role=\"button\"]")) {
      if (c.closest("#zs-root") || c.offsetParent === null) continue;
      if (c.querySelector("button,[role=\"button\"]")) continue; // a row, not the control
      const t = (c.textContent || "").trim();
      if (t.length <= 24 && /^(instant|thinking|instantan[ée]|r[ée]flexion)$/i.test(t)) return c;
    }
    return null;
  }
  const isReflexionEl = (b) =>
    !!b && isHardModeText(
      (b.textContent || "") + " " + (b.getAttribute("data-testid") || "") +
      " " + (b.getAttribute("data-mode") || ""));
  const isReflexion = () => isReflexionEl(findModeControl());

  // Dialog/menu/listbox overlays that are on screen and big enough to matter
  // (same visibility rules as overlayBlocking - rect-based, because fixed-
  // position portals report offsetParent === null).
  const visibleOverlays = () =>
    [...document.querySelectorAll('[role="dialog"],[role="menu"],[role="listbox"]')].filter((d) => {
      if (d.closest("#zs-root")) return false;
      const r = d.getBoundingClientRect();
      return r.width > 40 && r.height > 40 && r.top < innerHeight && r.bottom > 0;
    });
  const looksLikeModePicker = (d) => {
    const t = d.textContent || "";
    return t.length < 600 && MODE_FAST_TEXT.test(t) && MODE_HARD_TEXT.test(t);
  };

  // The Thinking option inside an open picker: the old testid first, else the
  // smallest visible clickable row whose text says Thinking/Réflexion without
  // saying Instant (a row holding BOTH options is a container - excluded).
  function findThinkingOption() {
    const byId = document.querySelector(S.modeOptHard);
    if (byId) return byId;
    const SEL = 'button,[role="menuitem"],[role="menuitemradio"],[role="option"],[role="radio"],[role="button"],li,div';
    let best = null;
    for (const sc of visibleOverlays()) {
      for (const el of [sc, ...sc.querySelectorAll(SEL)]) {
        if (el.closest("#zs-root")) continue;
        const r = el.getBoundingClientRect();
        if (!r.width || !r.height) continue;
        const t = (el.textContent || "").trim();
        if (!t || t.length > 200) continue;
        if (!isHardModeText(t)) continue;
        if (!best || t.length < (best.textContent || "").trim().length) best = el;
      }
    }
    return best;
  }

  // Close every overlay WE opened (plus any visible mode picker, even a
  // pre-existing one - the composer stays blocked until it is dismissed).
  // Escape on the layer and the document, then an outside pointer press
  // (pointerdown/up only, never a click, so no page control activates), then
  // an explicit close affordance. Verified between attempts.
  async function closeOpenedOverlays(before) {
    const ours = () => visibleOverlays().filter((d) => !before.has(d) || looksLikeModePicker(d));
    for (let i = 0; i < 3 && ours().length; i++) {
      const d = ours()[0];
      for (const t of [d, document]) {
        for (const type of ["keydown", "keyup"]) {
          try {
            t.dispatchEvent(new KeyboardEvent(type, {
              key: "Escape", code: "Escape", keyCode: 27, which: 27,
              bubbles: true, cancelable: true,
            }));
          } catch {}
        }
      }
      await sleep(300);
      if (!ours().length) break;
      try {
        const o = document.documentElement;
        o.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, pointerId: 1, pointerType: "mouse", button: 0, clientX: 4, clientY: 4 }));
        o.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, cancelable: true, pointerId: 1, pointerType: "mouse", button: 0, clientX: 4, clientY: 4 }));
      } catch {}
      await sleep(300);
      if (!ours().length) break;
      const d2 = ours()[0];
      const x = [...d2.querySelectorAll("button,[aria-label]")].find((b) =>
        /close|fermer|dismiss|✕|✖|×/i.test((b.getAttribute("aria-label") || "") + " " + (b.textContent || "").trim()));
      if (x) { try { x.click(); } catch {} }
      await sleep(300);
    }
    return ours().length === 0;
  }

  let _modeInFlight = false;
  async function ensureThinkMode() {
    if (_modeInFlight) return;
    const b = findModeControl();
    if (!b || isReflexionEl(b)) return; // absent or already Thinking → nothing to do
    _modeInFlight = true;
    const before = new Set(visibleOverlays());
    try {
      const fire = (el, t) =>
        el.dispatchEvent(new PointerEvent(t, { bubbles: true, cancelable: true, pointerId: 1, pointerType: "mouse", button: 0 }));
      fire(b, "pointerdown"); fire(b, "pointerup"); try { b.click(); } catch {}
      // NOTE: waitFor returns a BOOLEAN (the provider's own helper), so the
      // option element is re-queried after the wait, like the old code did.
      const opened = await waitFor(() => !!findThinkingOption(), 2500);
      if (opened) {
        const opt = findThinkingOption();
        // The new picker's rows ignore a bare .click() like the old Radix
        // menu did - fire real pointer events, then the click.
        if (opt) { fire(opt, "pointerdown"); fire(opt, "pointerup"); try { opt.click(); } catch {} }
        await waitFor(() => { const c = findModeControl(); return !c || isReflexionEl(c); }, 2000);
      }
      diag("meta.mode.set", { reflexion: isReflexion(), picked: !!opt });
    } catch (e) {
      diag("meta.mode.err", { msg: String((e && e.message) || e) });
    } finally {
      // ALWAYS dismiss the picker before returning - an open mode dialog
      // hides the ZS bar and blocks the composer (the silent Start wedge).
      const closed = await closeOpenedOverlays(before);
      if (!closed) diag("meta.mode.stuckOpen", {});
      _modeInFlight = false;
    }
  }

  // ── Composer readiness ──────────────────────────────────────────────────────
  function enforceComposer() { if (_locked) applyLock(); return { ready: true }; }
  async function ensureComposerReady(reason) {
    // Force Thinking/Réflexion before the session types. AWAITED, not fire-and-
    // forget: ensureThinkMode now guarantees the picker is closed when it
    // returns, so the bootstrap never types against an open modal (the old
    // fire-and-forget is what let a stuck-open picker wedge the whole start).
    try { await ensureThinkMode(); } catch {}
    diag("mode_ready", { reason, provider: "meta", ready: !!getEditor() });
    return { ready: !!getEditor() };
  }
  const modeWarning = () => "";
  const captchaPresent = () => false;
  function overlayBlocking() {
    for (const d of document.querySelectorAll('[role="dialog"]')) {
      if (d.closest("#zs-root")) continue;
      const r = d.getBoundingClientRect();
      if (r.width > 40 && r.height > 40 && r.top < innerHeight && r.bottom > 0) return true;
    }
    return false;
  }

  // ── Error / limit detection (site chrome only, never model output) ───────────
  function scanError() {
    try {
      const list = listEl();
      for (const el of document.querySelectorAll(S.errorSurfaces)) {
        if (el.offsetParent === null) continue;
        if (list && list.contains(el)) continue; // inside a chat turn ⇒ model content
        const t = (el.innerText || "").trim();
        if (t.length > 8 && t.length < 600 && RE.contextLimit.test(t)) return t.slice(0, 240);
      }
    } catch {}
    if (!getEditor()) return "The input box disappeared (session ended?).";
    return null;
  }
  const isTooLongMsg = (text) => RE.tooLong.test(text);
  const isBusyMsg = (text) => RE.busy.test(text);

  // /  = a fresh chat with no conversation id yet → "" (never persisted as
  // "started"). A real conversation is /prompt/<uuid>.
  const conversationKey = () => (location.pathname === "/" ? "" : location.pathname);

  // ── User-send interception ──────────────────────────────────────────────────
  function installSendHooks(handlers) {
    document.addEventListener(
      "keydown",
      (e) => {
        if (e.key !== "Enter" || e.shiftKey || e.isComposing) return;
        // The user types in the on-screen Lexical div, so match the event target
        // against THAT (getEditor() is the hidden mirror textarea).
        const editor = visibleEditor();
        if (!editor || !editor.contains(e.target)) return;
        if (editorText().trim() === "") return;
        if (handlers.isBlocked()) return;
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
        const btn = e.target && e.target.closest && e.target.closest("button");
        if (!btn) return;
        if (btn.closest(S.stopBtn) || btn.matches(S.stopBtn) || btn === stopButton()) { handlers.onNativeStop(); return; }
        if (!(btn.closest(S.sendBtn) || btn.matches(S.sendBtn) || btn === sendButton())) return;
        if (btn.disabled || btn.getAttribute("aria-disabled") === "true") return;
        if (handlers.isBlocked()) return;
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

  // ── Tool-block location for camouflage ───────────────────────────────────────
  // Meta renders a command block as a .ur-code-block (the JSON viewer widget OR a
  // plain <pre>). Hide every such wrapper carrying a command shape, plus any bare
  // top-level block holding an inline command. React recreates the rendered
  // subtree on stream settle and on the next send, so also mark the assistant body
  // (its identity survives) with .zs-cmd-mask; the overlay.css rule keeps recreated
  // code wrappers hidden.
  const CMD_SHAPE = /"(?:command|tool)"\s*:\s*"|###\s*lua|###mcp_tool###/i;
  function findToolBlockSpot(item /*, chip */) {
    const b = bodyOf(item);
    if (!b) return null;
    let hidAny = null;
    // 1. Code wrappers (JSON viewer or <pre>) carrying a command.
    b.querySelectorAll(S.codeWrap).forEach((cw) => {
      if (cw.closest(".zs-chip")) return;
      if (CMD_SHAPE.test(cw.textContent || "")) {
        cw.classList.add("zs-tool-hide");
        b.classList.add("zs-cmd-mask");
        hidAny = hidAny || { parent: cw.parentElement, ref: cw };
      }
    });
    // 2. Bare blocks with an inline command (no code wrapper). In long
    // conversations Meta stops fencing the emitted JSON, so the raw
    // {"command": …} renders as a plain paragraph - seen live 2026-07-16.
    // The command may sit a level or two below the body, so walk p/div
    // descendants and hide the TOPMOST matching block (document order puts
    // parents first; skip anything under an already-hidden ancestor).
    b.querySelectorAll("p, div").forEach((el) => {
      if (el.closest(".zs-chip, .zs-tool-hide, " + S.codeWrap)) return;
      if (el.querySelector(S.codeWrap)) return;
      const t = (el.textContent || "").trim();
      // A block that STARTS with the command JSON / marker is a command no
      // matter its size (execute_luau payloads run thousands of chars); the
      // 600-char cap only guards blocks where the shape appears mid-text.
      const t0 = t.replace(/^json\s*/i, "");
      const startsAsCmd = /^\{\s*"(?:command|tool)"\s*:/.test(t0) || /^###\s*(?:lua|mcp_tool)/i.test(t0);
      if ((startsAsCmd || t.length < 600) && CMD_SHAPE.test(t) && /^[{#]/.test(t0)) {
        el.classList.add("zs-tool-hide");
        hidAny = hidAny || { parent: el.parentElement, ref: el };
      }
    });
    return hidAny;
  }

  return {
    id: "meta",
    displayName: "Meta AI",
    // Meta's composer accepts image uploads (hidden multi-file input → inline
    // Lexical preview → uploaded on send; see attachImages). Vision-capable, so
    // screen_capture is exposed (main.js BLOCKED_TOOLS gate). The send-with-image
    // path is wired from the live DOM contract but not yet exercised end-to-end.
    supportsVision: true,
    timings,
    // React reconciles a turn's content subtree on every update, wiping a chip
    // placed inside it. Anchor chips at the turn-element level instead.
    chipAtItemLevel: true,
    chipAnchor,
    chipAppend: true,
    // Turn elements are not virtualized away, so assistantCount() reliably
    // increases for every reply - the core's watcher uses this.
    reliableCounts: true,
    init({ diag: d } = {}) { if (d) diag = d; },
    // turns
    allItems, isUserItem, isAssistantItem, itemText, classifyText,
    assistantCount, userCount, lastAssistant, lastAssistantId, readAssistant,
    streamLen, snapshot,
    // composer / state
    getEditor, editorText, chatIsEmpty, isFreshChat, composerFrame, barAnchor,
    // The "Agent is working…" cover is sized to coverTarget() so it blankets the
    // whole text-entry band (blocking clicks that would otherwise focus the editor
    // and let the user type behind it) WITHOUT covering the controls row - the
    // attach button, the Réflexion/Instantané mode toggle, and the send button must
    // stay visible & usable - nor the ZS bar anchored above. coverMaxH lifts the
    // core's 200px clamp so a grown (multi-line, up to the zs-typing 140px cap)
    // band is still fully covered.
    coverTarget,
    coverMaxH: 260,
    setInputLock, typeAndSend, stopGeneration,
    isGenerating, isBusyNow, isHardGenerating,
    enforceComposer, ensureComposerReady, modeWarning, captchaPresent, overlayBlocking,
    turnHalted, findContinueBtn, clickContinueBtn,
    scanError, isTooLongMsg, isBusyMsg,
    // actions
    attachImages, clearAttachments, conversationKey, installSendHooks, findToolBlockSpot,
    // Smoke-test hooks (test-meta.js) - not part of the ZSProvider contract,
    // same as chatgpt.js exporting textWithout for test-chatgpt.js.
    isHardModeText, findThinkingOption,
  };
})();
