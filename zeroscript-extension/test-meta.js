// Quick Node smoke test for providers/meta.js (run: node test-meta.js).
// Not shipped.
//
// What this guards: the 2026-11 Meta AI mode-picker rework. Meta replaced the
// Instantané/Réflexion dropdown with an "Instant / Thinking" picker whose old
// option testid may be gone, and leaving it open wedged "Start session" - the
// open dialog hides the ZS bar (overlayBlocking) and blocks the composer, so
// the failure was completely silent. The fix matches the Thinking option by
// TEXT and always closes the picker; these cases pin that matching logic
// without a live meta.ai (none is reachable from CI).
const fs = require("fs");

// ── Stub DOM ────────────────────────────────────────────────────────────────
// el("div", {class, attrs, rect}, children) / txt("…"). Only the surface
// isHardModeText / findThinkingOption touch: document.querySelector(All),
// role attributes, closest, textContent, getBoundingClientRect, innerHeight.
// Anything else stays undefined on purpose so a future change that needs more
// DOM fails loudly here instead of silently passing.
function txt(v) {
  return { nodeType: 3, nodeValue: v, childNodes: [] };
}
let RECT = { width: 600, height: 400, top: 10, bottom: 410 };
function el(tag, opts, children) {
  const o = opts || {};
  const classes = (o.class || "").split(/\s+/).filter(Boolean);
  const attrs = o.attrs || {};
  const kids = (children || []).map((c) => (typeof c === "string" ? txt(c) : c));
  const node = {
    nodeType: 1,
    tagName: tag.toUpperCase(),
    childNodes: kids,
    classList: { contains: (c) => classes.includes(c) },
    getAttribute: (n) => (n in attrs ? attrs[n] : null),
    getBoundingClientRect: () => RECT,
    parent: null,
  };
  Object.defineProperty(node, "textContent", {
    get: () => kids.map((c) => (c.nodeType === 3 ? c.nodeValue : c.textContent)).join(""),
  });
  kids.forEach((c) => { if (c.nodeType === 1) c.parent = node; });
  return node;
}
// A tiny selector matcher: comma lists of #id / .class / [attr] / [attr="v"] /
// tag. Everything the tested code queries (plus #zs-root for closest()).
function matchesSel(node, sel) {
  if (!node || node.nodeType !== 1) return false;
  return String(sel).split(",").some((part) => {
    const s = part.trim();
    if (s.startsWith("#")) return node.getAttribute("id") === s.slice(1);
    if (s.startsWith(".")) return (node.getAttribute("class") || "").split(/\s+/).includes(s.slice(1));
    const attr = s.match(/^\[([\w-]+)(?:="([^"]*)")?\]$/);
    if (attr) return attr[2] === undefined ? node.getAttribute(attr[1]) !== null : node.getAttribute(attr[1]) === attr[2];
    return node.tagName === s.toUpperCase();
  });
}
function closest(node, sel) {
  for (let n = node; n; n = n.parent) if (matchesSel(n, sel)) return n;
  return null;
}
function queryAll(node, sel) {
  const out = [];
  const walk = (n) => {
    for (const c of n.childNodes) {
      if (c.nodeType === 1) {
        if (matchesSel(c, sel)) out.push(c);
        walk(c);
      }
    }
  };
  walk(node);
  return out;
}
// Wire the element methods (done after creation so helpers stay hoistable).
function arm(node) {
  node.matches = (sel) => matchesSel(node, sel);
  node.closest = (sel) => closest(node, sel);
  node.querySelectorAll = (sel) => queryAll(node, sel);
  node.childNodes.forEach((c) => { if (c.nodeType === 1) arm(c); });
  return node;
}
const E = (tag, opts, children) => arm(el(tag, opts, children));

// ── Load the provider against the stub globals ──────────────────────────────
let DOC = { querySelector: () => null, querySelectorAll: () => [] };
global.document = {
  querySelector: (sel) => DOC.querySelector(sel),
  querySelectorAll: (sel) => DOC.querySelectorAll(sel),
  addEventListener: () => {},
  dispatchEvent: () => {},
  documentElement: {},
  body: null,
};
global.window = { location: { pathname: "/" }, addEventListener: () => {} };
global.location = global.window.location;
global.innerHeight = 800;
const P = new Function(
  fs.readFileSync(__dirname + "/providers/meta.js", "utf8") + "; return ZSProvider;"
)();

const ok = (name, cond) => { console.log((cond ? "PASS" : "FAIL") + "  " + name); if (!cond) process.exitCode = 1; };
const within = (node, ancestor) => { for (let n = node; n; n = n.parent) if (n === ancestor) return true; return false; };

// ── isHardModeText: the label vocabulary across old + new UIs ───────────────
// The mode control / option must be recognised from its TEXT now that the
// testids are gone - and a container listing BOTH options must never count
// as an option (clicking it would toggle something random).
ok("Thinking is hard mode", P.isHardModeText("Thinking"));
ok("Réflexion is hard mode", P.isHardModeText("Réflexion"));
ok("Instant is fast mode", !P.isHardModeText("Instant"));
ok("Instantané is fast mode", !P.isHardModeText("Instantané"));
ok("new-UI Thinking card text is hard mode", P.isHardModeText("ThinkingReasons longer for better answers"));
ok("new-UI Instant card text is fast mode", !P.isHardModeText("InstantAnswers straight away"));
ok("a picker listing BOTH options is not an option", !P.isHardModeText("Take actionInstantAnswers straight awayThinkingReasons longer for better"));
ok("old option testid string is hard mode", P.isHardModeText("composer-mode-option-think_hard"));
ok("old button testid string is neither", !P.isHardModeText("composer-mode-dropdown-button"));
ok("empty / null is not hard mode", !P.isHardModeText("") && !P.isHardModeText(null));

// ── findThinkingOption: the old testid still wins when present ──────────────
const oldOpt = E("div", { attrs: { "data-testid": "composer-mode-option-think_hard", role: "menuitem" } }, ["Réflexion"]);
DOC = { querySelector: (sel) => (sel.indexOf("think_hard") !== -1 ? oldOpt : null), querySelectorAll: () => [] };
ok("old think_hard testid is found", P.findThinkingOption() === oldOpt);

// ── findThinkingOption: the new picker, matched by text ─────────────────────
// role="dialog" picker with two option cards; only the Thinking one (or a
// child of it) may be returned - never the Instant card, never the container.
const instantCard = E("div", { attrs: { role: "option" } }, ["Instant", E("span", {}, ["Answers straight away"])]);
const thinkingCard = E("div", { attrs: { role: "option" } }, ["Thinking", E("span", {}, ["Reasons longer for better"])]);
const picker = E("div", { attrs: { role: "dialog" } }, [instantCard, thinkingCard]);
DOC = { querySelector: () => null, querySelectorAll: (sel) => (sel.indexOf("dialog") !== -1 ? [picker] : []) };
let found = P.findThinkingOption();
ok("new-UI thinking option found by text", !!found && P.isHardModeText(found.textContent));
ok("found node belongs to the Thinking card", !!found && within(found, thinkingCard));
ok("found node is never the Instant card", found !== instantCard && found !== picker);

// ── visibility rules: a hidden / off-screen picker is not an option ─────────
RECT = { width: 0, height: 0, top: 0, bottom: 0 };
ok("an invisible picker yields no option", P.findThinkingOption() === null);
RECT = { width: 600, height: 400, top: 900, bottom: 1300 }; // fully below the fold
ok("an off-screen picker yields no option", P.findThinkingOption() === null);
RECT = { width: 600, height: 400, top: 10, bottom: 410 };

// ── an all-fast picker must not invent an option ────────────────────────────
const onlyFast = E("div", { attrs: { role: "menu" } }, [instantCard]);
DOC = { querySelector: () => null, querySelectorAll: (sel) => (sel.indexOf("menu") !== -1 ? [onlyFast] : []) };
ok("no hard option inside an all-Instant picker", P.findThinkingOption() === null);

// ── the extension's own root is never scanned ───────────────────────────────
// A zs-* dialog (e.g. the panel) must be ignored - clicking inside our own UI
// while hunting for a mode option would be a self-inflicted wedged state.
const ownDialog = E("div", { attrs: { id: "zs-root", role: "dialog" } }, [thinkingCard]);
DOC = { querySelector: () => null, querySelectorAll: (sel) => (sel.indexOf("dialog") !== -1 ? [ownDialog] : []) };
ok("overlays inside #zs-root are ignored", P.findThinkingOption() === null);

console.log(process.exitCode ? "SOME CASES FAILED" : "ALL PASS");
