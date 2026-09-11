window.__ModuleLoader__.load({
	id: "dsh-workboard",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		var React = require("react");
		var jsxRuntime = require("react/jsx-runtime");
		var jsx = jsxRuntime.jsx;
		var jsxs = jsxRuntime.jsxs;
		var Fragment = jsxRuntime.Fragment;

		//#region data plane
		/**
		 * Every source is served by this plugin's own host half as same-origin
		 * JSON under /workboard/*. The browser never talks to GitHub, Jira,
		 * Google, or git directly — see index.js for the data plane.
		 *
		 * Each source answers with an `unavailable` string when it could not be
		 * read. That is rendered as an explicit message inside the card, never as
		 * a silently empty list.
		 */
		var BASE = "/workboard";
		var FETCH_TIMEOUT_MS = 25000;
		var AUTO_REFRESH_MS = 5 * 60 * 1000;
		var SOURCES = ["github", "jira", "calendar", "git"];

		/** Load one source, converting transport failures into an `unavailable` marker. */
		async function loadSource(key) {
			var controller = new AbortController();
			var timer = setTimeout(function () { controller.abort(); }, FETCH_TIMEOUT_MS);
			try {
				var response = await fetch(BASE + "/" + key, {
					headers: { accept: "application/json" },
					signal: controller.signal,
					credentials: "same-origin"
				});
				if (!response.ok) return { key: key, data: null, unavailable: "HTTP " + response.status };
				return { key: key, data: await response.json(), unavailable: null };
			} catch (error) {
				var aborted = error instanceof Error && error.name === "AbortError";
				return { key: key, data: null, unavailable: aborted ? "request timed out" : String((error && error.message) || error) };
			} finally {
				clearTimeout(timer);
			}
		}

		/** Shared board state: one refresh fans out to every source. */
		function useWorkboard() {
			var state = React.useState(null);
			var sources = state[0];
			var setSources = state[1];
			var loadingState = React.useState(true);
			var loading = loadingState[0];
			var setLoading = loadingState[1];
			var stampState = React.useState(null);
			var fetchedAt = stampState[0];
			var setFetchedAt = stampState[1];

			var refresh = React.useCallback(function () {
				setLoading(true);
				return Promise.all(SOURCES.map(loadSource)).then(function (results) {
					var next = {};
					results.forEach(function (result) { next[result.key] = result; });
					setSources(next);
					setFetchedAt(Date.now());
					setLoading(false);
				});
			}, []);

			React.useEffect(function () {
				refresh();
				var timer = setInterval(refresh, AUTO_REFRESH_MS);
				return function () { clearInterval(timer); };
			}, [refresh]);

			return { sources: sources, loading: loading, fetchedAt: fetchedAt, refresh: refresh };
		}

		/** Read a payload field with a safe default. */
		function dataOf(sources, key, field, fallback) {
			var source = sources && sources[key];
			if (!source || !source.data) return fallback;
			var value = source.data[field];
			return value === undefined || value === null ? fallback : value;
		}

		/** The source's failure message, or null when it is healthy. */
		function unavailableOf(sources, key) {
			var source = sources && sources[key];
			if (!source) return null;
			if (source.unavailable) return source.unavailable;
			return (source.data && source.data.unavailable) || null;
		}
		//#endregion

		//#region styles
		var CSS = [
			/* floating affordance: a round icon button. Its `bottom` is set from
			   the measured composer rect at runtime, so it steps out of the way
			   instead of covering the input card at narrow widths. */
			".dswb-fab{position:fixed;right:20px;bottom:20px;z-index:60;pointer-events:auto;display:inline-flex;align-items:center;justify-content:center;width:44px;height:44px;padding:0;border:none;border-radius:50%;cursor:pointer;font:inherit;font-size:19px;line-height:1;color:#fff;background:var(--dsw-alias-state-business-primary,#4b6bfb);box-shadow:0 4px 16px rgba(0,0,0,.26);transition:transform .15s ease,box-shadow .15s ease,bottom .18s ease}",
			".dswb-fab:hover{transform:translateY(-1px) scale(1.04);box-shadow:0 6px 20px rgba(0,0,0,.32)}",
			".dswb-fab:focus-visible{outline:2px solid #fff;outline-offset:2px}",
			".dswb-fab[data-attention=true]{background:#cf222e}",
			/* Badge rides the circle's corner, so the button itself stays round. */
			".dswb-fab-count{position:absolute;top:-3px;right:-3px;min-width:18px;height:18px;padding:0 4px;border-radius:999px;background:#cf222e;color:#fff;border:2px solid var(--dsw-alias-bg-base,#fff);font-size:10px;font-weight:600;line-height:14px;text-align:center;box-sizing:content-box}",
			".dswb-fab[data-attention=true] .dswb-fab-count{background:#1f2329;border-color:#fff}",
			/* compact panel */
			".dswb-panel{position:fixed;right:20px;bottom:76px;z-index:60;pointer-events:auto;width:min(430px,calc(100vw - 32px));max-height:min(74vh,720px);display:flex;flex-direction:column;background:var(--dsw-alias-bg-base,#fff);color:var(--dsw-alias-label-primary,#1f2329);border:1px solid var(--dsw-alias-border-l2,rgba(31,35,41,.12));border-radius:14px;box-shadow:0 12px 40px rgba(0,0,0,.28);overflow:hidden;font-size:13px;line-height:1.45}",
			/* Home board.
			   Deliberately NOT a full-viewport overlay: on a new conversation the
			   board sits in the page's own centre column, matching the composer's
			   width and starting below it, so the sidebar, the composer, and
			   everything else stay visible and usable. The fixed wrapper is
			   click-through; only the board surface itself takes pointer events. */
			".dswb-home{position:fixed;left:0;right:0;pointer-events:none;z-index:55}",
			".dswb-board{pointer-events:auto;display:flex;flex-direction:column;min-width:0;background:var(--dsw-alias-bg-base,#fff);color:var(--dsw-alias-label-primary,#1f2329);border:1px solid var(--dsw-alias-border-l2,rgba(31,35,41,.12));border-radius:14px;box-shadow:0 10px 30px rgba(0,0,0,.10);overflow:hidden;font-size:13px;line-height:1.45}",
			".dswb-board-head{flex:none;display:flex;align-items:center;gap:8px;padding:10px 14px;border-bottom:1px solid rgba(31,35,41,.08)}",
			".dswb-board-title{font-size:13.5px;font-weight:600;display:inline-flex;align-items:center;gap:7px}",
			".dswb-board-sub{color:#8f959e;font-size:11.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
			".dswb-board-head .dswb-actions{margin-left:auto}",
			".dswb-board-body{overflow-y:auto;overscroll-behavior:contain;min-height:0;padding:2px 0}",
			/* One section inside the board: flat rows divided by hairlines, so the
			   whole thing reads as one page block rather than four floating cards. */
			".dswb-sec{border-top:1px solid rgba(31,35,41,.07)}",
			".dswb-sec:first-child{border-top:none}",
			".dswb-sec-head{display:flex;align-items:center;gap:8px;padding:8px 14px 6px;font-weight:600;font-size:12.5px}",
			".dswb-sec-head .dswb-chip:last-child{margin-left:auto}",
			".dswb-sec-body{display:flex;flex-direction:column}",
			".dswb-sec[data-folded=true] .dswb-sec-head{padding-bottom:8px}",
			".dswb-mark{display:inline-flex;align-items:center;justify-content:center;width:16px;height:16px;flex:none;color:#8f959e}",
			".dswb-mark svg{display:block}",
			/* surfaces */
			".dswb-header{flex:none;display:flex;align-items:center;gap:8px;padding:10px 12px;border-bottom:1px solid rgba(31,35,41,.1)}",
			".dswb-title{font-size:14px;font-weight:600;flex:1;min-width:0}",
			".dswb-actions{display:inline-flex;align-items:center;gap:4px}",
			".dswb-iconbtn{width:26px;height:26px;display:inline-flex;align-items:center;justify-content:center;border:none;border-radius:8px;background:transparent;color:#8f959e;cursor:pointer;font-size:13px;line-height:1}",
			".dswb-iconbtn:hover{background:rgba(31,35,41,.06);color:var(--dsw-alias-label-primary,#1f2329)}",
			".dswb-iconbtn[data-spinning=true] svg{animation:dswb-spin .9s linear infinite}",
			"@keyframes dswb-spin{to{transform:rotate(360deg)}}",
			".dswb-body{flex:1;min-height:0;overflow-y:auto;padding:10px 12px;display:flex;flex-direction:column;gap:10px}",
			/* cards */
			/* `flex:none` is load-bearing in the panel: without it a card is a
			   shrinking flex item of the fixed-height `.dswb-body`, so the deck
			   gets squeezed into 70px strips instead of the body scrolling. Cards
			   keep their natural (capped) height and the body provides the
			   overall scrollbar. */
			".dswb-card{border:1px solid rgba(31,35,41,.1);border-radius:10px;background:var(--dsw-alias-bg-base,#fff);overflow:hidden;display:flex;flex-direction:column;min-width:0;flex:none}",
			".dswb-card-head{display:flex;align-items:center;gap:6px;padding:9px 11px;border-bottom:1px solid rgba(31,35,41,.08);font-weight:600;font-size:12.5px;flex:none}",
			/* Section fold control: a bare chevron that owns no width of its own,
			   so the header reads the same as before when nothing is collapsed. */
			".dswb-fold{flex:none;width:18px;height:18px;margin-left:-3px;display:inline-flex;align-items:center;justify-content:center;border:none;border-radius:5px;background:transparent;color:#8f959e;cursor:pointer;font-size:10px;line-height:1;padding:0}",
			".dswb-fold:hover{background:rgba(31,35,41,.07);color:var(--dsw-alias-label-primary,#1f2329)}",
			".dswb-fold:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary,#4b6bfb);outline-offset:1px}",
			/* A folded section keeps its header (and therefore its count badge) so the
			   deck stays a readable summary instead of a stack of blank bars. */
			".dswb-card[data-folded=true] .dswb-card-head{border-bottom:none}",
			".dswb-folded-hint{padding:0 11px 9px;color:#8f959e;font-size:11.5px}",
			".dswb-chip{flex:none;font-size:10px;font-weight:500;padding:0 6px;border-radius:999px;line-height:16px;color:#8f959e;border:1px solid rgba(31,35,41,.16);white-space:nowrap}",
			".dswb-chip[data-kind=ok]{color:#2da44e;border-color:currentColor}",
			".dswb-chip[data-kind=warn]{color:#b26a00;border-color:currentColor}",
			".dswb-card-head .dswb-chip:last-child{margin-left:auto}",
			".dswb-rows{display:flex;flex-direction:column}",
			".dswb-row{display:flex;align-items:flex-start;gap:8px;padding:7px 11px;min-width:0}",
			".dswb-row+.dswb-row{border-top:1px solid rgba(31,35,41,.05)}",
			".dswb-row-main{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px}",
			".dswb-row-title{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
			".dswb-row-sub{color:#8f959e;font-size:11.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
			".dswb-meta{flex:none;display:inline-flex;gap:7px;align-items:center;color:#8f959e;font-size:11.5px;white-space:nowrap;padding-top:1px}",
			".dswb-empty{padding:11px;color:#8f959e;font-size:12px}",
			".dswb-note{margin:0;padding:8px 11px;font-size:11.5px;color:#b26a00;background:rgba(178,106,0,.09);border-bottom:1px solid rgba(178,106,0,.22);word-break:break-word;flex:none}",
			/* Per-section scroll: a long PR/Jira list scrolls inside its own card
			   instead of stretching the board, so the deck stays scannable. No
			   `overscroll-behavior:contain` here on purpose — when a section hits
			   its end the wheel should carry on into the panel's own scroll
			   instead of feeling stuck. */
			".dswb-card-body{overflow-y:auto;-webkit-overflow-scrolling:touch;max-height:min(46vh,440px);min-height:0;display:flex;flex-direction:column}",
			".dswb-note a{color:inherit;font-weight:600}",
			".dswb-pill{flex:none;font-size:10.5px;font-weight:600;padding:0 7px;border-radius:999px;line-height:17px;white-space:nowrap}",
			".dswb-pill[data-tone=accent]{color:#4b6bfb;background:rgba(75,107,251,.13)}",
			".dswb-pill[data-tone=warn]{color:#b26a00;background:rgba(178,106,0,.14)}",
			".dswb-pill[data-tone=ok]{color:#2da44e;background:rgba(45,164,78,.14)}",
			".dswb-pill[data-tone=muted]{color:#8f959e;background:rgba(31,35,41,.07)}",
			".dswb-dot{flex:none;width:8px;height:8px;border-radius:50%;margin-top:6px}",
			".dswb-dot[data-tone=success]{background:#2da44e}",
			".dswb-dot[data-tone=pending]{background:#bf8700}",
			".dswb-dot[data-tone=failure]{background:#cf222e}",
			".dswb-dot[data-tone=none],.dswb-dot[data-tone=unknown]{background:rgba(31,35,41,.2)}",
			".dswb-group{padding:7px 11px 3px;font-size:10.5px;font-weight:600;letter-spacing:.05em;text-transform:uppercase;color:#8f959e;display:flex;gap:6px;align-items:center}",
			".dswb-link{color:inherit;text-decoration:none}",
			/* Row title as the add-to-composer control: a button that reads as text. */
			".dswb-add{display:block;width:100%;text-align:left;border:none;background:transparent;padding:0;font:inherit;color:inherit;cursor:pointer;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
			".dswb-add:hover{color:#4b6bfb;text-decoration:underline}",
			".dswb-add:focus-visible{outline:2px solid #4b6bfb;outline-offset:2px;border-radius:3px}",
			".dswb-open{flex:none;color:#8f959e;text-decoration:none;font-size:13px;line-height:1}",
			".dswb-open:hover{color:#4b6bfb}",
			".dswb-added{flex:none;font-size:11px;font-weight:600;color:#2da44e;white-space:nowrap}",
			".dswb-added[data-kind=warn]{color:#b26a00}",
			".dswb-link:hover{color:#4b6bfb;text-decoration:underline}",
			".dswb-now{background:rgba(75,107,251,.07)}",
			".dswb-branch{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}",
			".dswb-btn{border:1px solid rgba(31,35,41,.16);background:transparent;color:inherit;border-radius:8px;padding:4px 10px;font:inherit;font-size:12px;cursor:pointer;text-decoration:none;display:inline-flex;align-items:center;gap:5px}",
			".dswb-btn:hover{background:rgba(31,35,41,.05)}",
			"@media (max-width:560px){.dswb-panel{right:12px;bottom:60px;width:calc(100vw - 24px);max-height:70vh}.dswb-fab{right:12px;bottom:12px}}"
		].join("\n");
		//#endregion

		//#region glyphs
		/**
		 * Inline SVG marks, because an out-of-tree plugin can only `require` the
		 * shell's baseline words — there is no icon package to import.
		 *
		 * The GitHub and Jira marks are the official ones, taken verbatim from the
		 * Desk project's own `/icons/*.svg` assets rather than redrawn here. The
		 * calendar and git marks are purpose-drawn glyphs in the same visual
		 * weight; they are not official brand logos.
		 */
		var GITHUB_MARK = '<svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor" aria-hidden="true"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8z"/></svg>';
		var JIRA_MARK = '<svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><path fill="#1868db" fill-rule="evenodd" d="M12 1.5 22.5 12 12 22.5 1.5 12 12 1.5Zm0 6.6L8.1 12l3.9 3.9 3.9-3.9L12 8.1Z"/><path fill="#0c66e4" d="M12 1.5 6.75 6.75 10.05 10.05 12 8.1 15.9 12l3.3-3.3L12 1.5Z"/><path fill="#4688f4" d="m12 22.5 5.25-5.25-3.3-3.3L12 15.9 8.1 12l-3.3 3.3L12 22.5Z"/></svg>';
		var CALENDAR_MARK = '<svg viewBox="0 0 20 20" width="15" height="15" aria-hidden="true"><rect x="2.2" y="3.7" width="15.6" height="13.9" rx="2.7" fill="#4285f4" fill-opacity=".14"/><rect x="2.2" y="3.7" width="15.6" height="13.9" rx="2.7" fill="none" stroke="#4285f4" stroke-width="1.5"/><path d="M2.2 8.3h15.6" stroke="#4285f4" stroke-width="1.5"/><path d="M6.4 2.3v2.9M13.6 2.3v2.9" stroke="#4285f4" stroke-width="1.7" stroke-linecap="round"/><circle cx="7.3" cy="12.1" r="1.05" fill="#34a853"/><circle cx="10" cy="12.1" r="1.05" fill="#fbbc04"/><circle cx="12.7" cy="12.1" r="1.05" fill="#ea4335"/></svg>';
		var GIT_MARK = '<svg viewBox="0 0 16 16" width="15" height="15" fill="currentColor" aria-hidden="true"><path d="M9.5 3.25a2.25 2.25 0 1 1 3 2.122V6A2.5 2.5 0 0 1 10 8.5H6a1 1 0 0 0-1 1v1.128a2.251 2.251 0 1 1-1.5 0V5.372a2.25 2.25 0 1 1 1.5 0v1.836A2.5 2.5 0 0 1 6 7h4a1 1 0 0 0 1-1v-.628A2.25 2.25 0 0 1 9.5 3.25Zm-4.25 8a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm6.5-9a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm-6.5 0a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Z"/></svg>';
		/** The button's own mark: a board, not an emoji. */
		var BOARD_MARK = '<svg viewBox="0 0 20 20" width="21" height="21" fill="currentColor" aria-hidden="true"><rect x="2.5" y="3.1" width="4.2" height="13.8" rx="1.6"/><rect x="7.9" y="3.1" width="4.2" height="8.7" rx="1.6"/><rect x="13.3" y="3.1" width="4.2" height="11.3" rx="1.6"/></svg>';

		/** Render one inline mark; the markup is authored above, never user data. */
		function Mark(props) {
			return jsx("span", {
				className: "dswb-mark",
				title: props.title,
				dangerouslySetInnerHTML: { __html: props.svg }
			});
		}
		//#endregion

		//#region composer bridge
		/** Heading that groups everything this board has contributed to the draft. */
		var CONTEXT_HEADER = "Context from my workboard:";

		/** The composer's editable element — the only textarea in the shell. */
		function composerField() {
			if (typeof document === "undefined") return null;
			return document.querySelector("textarea") || document.querySelector('[contenteditable="true"]');
		}

		/** Read the composer's current draft, or null when there is no composer. */
		function readDraft(field) {
			if (field === null) return null;
			return field.tagName === "TEXTAREA" ? field.value : field.textContent;
		}

		/**
		 * Write a full draft back into the composer.
		 *
		 * There is no public API for this. `InputActions.setDraft` is composed only
		 * into the conversation package's own components — no slot registrant
		 * receives it — and `ctx.conversation` is scope-addressed, so a root-scoped
		 * plugin cannot reach a session's input facade either. (`ctx.inputTriggers`
		 * can insert a reference, but only through a per-session controller resolved
		 * from a session-scope ctx, which a root-scoped board does not have.)
		 *
		 * So the write goes through the field's own `input` event — the same path a
		 * keystroke takes. The shell's input machine, its trigger pipeline, and the
		 * draft persistence mirror all update normally, and the native prototype
		 * setter is used because a plain `.value =` assignment is swallowed by
		 * React's controlled-component value tracking.
		 * @param {string} text - the complete next draft.
		 * @returns {boolean} whether the write was dispatched.
		 */
		function writeDraft(text) {
			var field = composerField();
			if (field === null) return false;
			if (field.tagName === "TEXTAREA") {
				var setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value");
				if (setter === undefined || setter.set === undefined) return false;
				setter.set.call(field, text);
			} else {
				field.textContent = text;
			}
			field.dispatchEvent(new Event("input", { bubbles: true }));
			return true;
		}

		/**
		 * Fold one reference line into the draft, under a single heading.
		 * @param {string} draft - current draft.
		 * @param {string} line - the reference line to add.
		 * @returns {string} the next draft, unchanged when the line is already there.
		 */
		function mergeContext(draft, line) {
			var text = String(draft || "").replace(/\s+$/u, "");
			if (text.indexOf(line) >= 0) return draft;
			if (text === "") return CONTEXT_HEADER + "\n" + line + "\n";
			if (text.indexOf(CONTEXT_HEADER) >= 0) return text + "\n" + line + "\n";
			return text + "\n\n" + CONTEXT_HEADER + "\n" + line + "\n";
		}

		/**
		 * Add one line of board context to the composer draft.
		 * @param {string} line - the reference line.
		 * @returns {'added'|'duplicate'|'unavailable'} the outcome, surfaced in the UI.
		 */
		function addContextToComposer(line) {
			var field = composerField();
			var current = readDraft(field);
			if (current === null) return "unavailable";
			var next = mergeContext(current, line);
			if (next === current) return "duplicate";
			if (!writeDraft(next)) return "unavailable";
			// Leave the caret after the inserted text so typing continues naturally.
			try {
				field.focus();
				if (typeof field.setSelectionRange === "function") field.setSelectionRange(next.length, next.length);
			} catch (_error) {
				/* focus is a nicety, never a failure */
			}
			return "added";
		}

		/** Reference line for a GitHub pull request. */
		function prContextLine(pr) {
			return "- PR " + (pr.repo || "?") + "#" + String(pr.number) + " — " + (pr.title || "") + (pr.url ? " — " + pr.url : "");
		}
		/** Reference line for a Jira issue. */
		function jiraContextLine(issue) {
			return "- JIRA " + issue.key + (issue.status ? " [" + issue.status + "]" : "") + " — " + (issue.summary || "") + (issue.url ? " — " + issue.url : "");
		}
		/** Reference line for a calendar event. */
		function eventContextLine(event) {
			var when = event.allDay ? "all day" : formatTime(event.start) + (event.end ? "–" + formatTime(event.end) : "");
			return "- Meeting " + when + " — " + (event.title || "") + (event.location ? " @ " + event.location : "") + (event.meetingUrl ? " — " + event.meetingUrl : "");
		}
		/** Reference line for a workspace and its branch. */
		function workspaceContextLine(workspace) {
			return "- Workspace " + workspace.name + " (" + (workspace.branch || "no branch") + ") — " + workspace.path;
		}
		//#endregion

		//#region composer-aware placement
		/**
		 * Locate the composer card in the live DOM.
		 *
		 * The shell's class names are content-hashed (`uV2eYG_card`), so they are
		 * useless as a stable hook. The textarea inside the composer is not: it is
		 * the only one in the shell. The card is then the nearest ancestor that
		 * actually paints a surface — a non-transparent background plus rounded
		 * corners — which is what distinguishes it from the plain layout wrappers
		 * between the input and the card.
		 * @returns {DOMRect | null} the composer's painted box, when present.
		 */
		function composerRect() {
			if (typeof document === "undefined") return null;
			var input = document.querySelector("textarea")
				|| document.querySelector('[contenteditable="true"]');
			if (input === null) return null;
			var node = input;
			for (var depth = 0; depth < 8 && node !== null && node !== document.body; depth += 1) {
				var style = window.getComputedStyle(node);
				var painted = style.backgroundColor !== "rgba(0, 0, 0, 0)" && style.backgroundColor !== "transparent";
				// A rounded, painted ancestor is the card (or the hero stack around it).
				if (painted && parseFloat(style.borderTopLeftRadius) > 0) return node.getBoundingClientRect();
				node = node.parentElement;
			}
			return null;
		}

		/**
		 * Track where the composer is, and derive the two placements that depend on
		 * it: how far the round button must sit from the bottom to clear the input
		 * card, and how far the homepage board must start below it.
		 *
		 * Re-measured on resize and on a slow tick rather than once, because the
		 * composer moves between the centred (blank session) and bottom (active
		 * session) layouts without any event this plugin can subscribe to.
		 * @returns {{fabBottom: number, boardTop: number | null}} resolved offsets in px.
		 */
		function useComposerLayout() {
			var state = React.useState({ fabBottom: 20, boardTop: null, boardWidth: null, boardLeft: null, boardMaxHeight: null });
			var layout = state[0];
			var setLayout = state[1];
			React.useEffect(function () {
				var fabSize = 44;
				var margin = 20;
				var measure = function () {
					var rect = composerRect();
					var next = { fabBottom: margin, boardTop: null, boardWidth: null, boardLeft: null, boardMaxHeight: null };
					if (rect !== null) {
						var fabLeft = window.innerWidth - margin - fabSize;
						var fabTop = window.innerHeight - margin - fabSize;
						var collides = fabLeft < rect.right && fabLeft + fabSize > rect.left
							&& fabTop < rect.bottom && fabTop + fabSize > rect.top;
						if (collides) {
							// Sit just above the card, never higher than the top margin allows.
							next.fabBottom = Math.min(
								Math.max(margin, window.innerHeight - rect.top + 12),
								Math.max(margin, window.innerHeight - fabSize - margin)
							);
						}
						// The board starts below the composer so the input stays usable,
						// and never grows past the bottom of the viewport.
						next.boardTop = Math.round(rect.bottom) + 12;
						next.boardWidth = Math.round(rect.width);
						next.boardLeft = Math.round(rect.left);
						next.boardMaxHeight = Math.max(120, Math.round(window.innerHeight - next.boardTop - 28));
					}
					setLayout(function (previous) {
						return previous.fabBottom === next.fabBottom
							&& previous.boardTop === next.boardTop
							&& previous.boardWidth === next.boardWidth
							&& previous.boardLeft === next.boardLeft
							&& previous.boardMaxHeight === next.boardMaxHeight
							? previous
							: next;
					});
				};
				measure();
				window.addEventListener("resize", measure);
				var timer = setInterval(measure, 700);
				return function () {
					window.removeEventListener("resize", measure);
					clearInterval(timer);
				};
			}, []);
			return layout;
		}
		//#endregion

		//#region formatting helpers
		function formatTime(iso) {
			if (typeof iso !== "string" || iso === "") return "";
			try {
				return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
			} catch (_error) {
				return "";
			}
		}
		function formatRelative(iso) {
			if (typeof iso !== "string" || iso === "") return "";
			var delta = Date.now() - new Date(iso).getTime();
			if (!isFinite(delta)) return "";
			var minutes = Math.round(delta / 60000);
			if (minutes < 1) return "just now";
			if (minutes < 60) return minutes + "m ago";
			var hours = Math.round(minutes / 60);
			if (hours < 24) return hours + "h ago";
			return Math.round(hours / 24) + "d ago";
		}
		/** Only http(s) URLs become links; anything else is dropped. */
		function safeUrl(url) {
			return typeof url === "string" && /^https?:\/\//.test(url) ? url : null;
		}
		/** True while [start, end) contains now. */
		function isNow(event) {
			if (!event || !event.start || !event.end || event.allDay) return false;
			var start = new Date(event.start).getTime();
			var end = new Date(event.end).getTime();
			if (!isFinite(start) || !isFinite(end)) return false;
			var now = Date.now();
			return now >= start && now < end;
		}
		/** Jira priority name → pill tone. */
		function priorityTone(priority) {
			var value = String(priority || "").toLowerCase();
			if (value.indexOf("highest") >= 0 || value === "blocker" || value === "critical") return "warn";
			if (value.indexOf("high") >= 0 || value === "major") return "accent";
			return "muted";
		}
		//#endregion

		//#region shared parts
		function SourceChip(props) {
			return jsx("span", {
				className: "dswb-chip",
				"data-kind": props.unavailable ? "warn" : "ok",
				title: props.unavailable || "Live from " + BASE + "/" + props.sourceKey,
				children: props.unavailable ? "unavailable" : "live"
			});
		}
		/** The fold chevron both shells share, so the control never diverges. */
		function FoldButton(props) {
			return jsx("button", {
				type: "button",
				className: "dswb-fold",
				"aria-expanded": props.folded ? "false" : "true",
				"aria-label": (props.folded ? "Expand " : "Collapse ") + props.title,
				title: props.folded ? "Expand" : "Collapse",
				onClick: props.onToggle,
				children: props.folded ? "▶" : "▼"
			});
		}

		/** Header contents, identical in both shells. */
		function shellHeader(props) {
			return [
				jsx(FoldButton, { folded: props.folded, title: props.title, onToggle: props.onToggle }, "fold"),
				props.mark ? jsx(Mark, { svg: props.mark }, "mark") : null,
				jsx("span", { children: props.title }, "title"),
				props.count === undefined || props.count === null
					? null
					: jsx("span", { className: "dswb-chip", children: String(props.count) }, "count"),
				props.chip
			];
		}

		/** Floating-panel shell: a bordered, independently scrolling card. */
		function Card(props) {
			var folded = props.folded === true;
			return jsxs("section", {
				className: "dswb-card",
				"data-folded": folded ? "true" : "false",
				children: [
					jsx("header", { className: "dswb-card-head", children: shellHeader({ ...props, folded: folded }) }),
					// A folded section keeps its header and count, so the deck still
					// reads as a summary of everything rather than a stack of bars.
					folded ? null : props.note === null || props.note === undefined ? null : jsx("p", { className: "dswb-note", children: props.note }),
					folded
						? jsx("div", { className: "dswb-folded-hint", children: props.foldedHint || "collapsed" })
						: jsx("div", { className: "dswb-card-body", children: props.children })
				]
			});
		}

		/** Home-board shell: a flat section inside one shared surface. */
		function Section(props) {
			var folded = props.folded === true;
			return jsxs("section", {
				className: "dswb-sec",
				"data-folded": folded ? "true" : "false",
				children: [
					jsx("header", { className: "dswb-sec-head", children: shellHeader({ ...props, folded: folded }) }),
					folded ? null : props.note === null || props.note === undefined ? null : jsx("p", { className: "dswb-note", children: props.note }),
					folded ? null : jsx("div", { className: "dswb-sec-body", children: props.children })
				]
			});
		}

		/** Pick the shell for the surface the deck is rendering into. */
		function shellFor(props) {
			return props.shell === "section" ? Section : Card;
		}

		function EmptyRow(props) {
			return jsx("div", { className: "dswb-empty", children: props.children });
		}
		/**
		 * One deck row.
		 *
		 * With `onAdd` the title becomes the add-to-composer control and the row keeps
		 * a separate small link for opening the source — so pulling something into the
		 * conversation never costs the reader the ability to go look at it.
		 */
		function Row(props) {
			var title = props.title;
			var titleNode;
			if (props.onAdd) {
				titleNode = jsx("button", {
					type: "button",
					className: "dswb-row-title dswb-add",
					title: "Add to the composer as context",
					onClick: props.onAdd,
					children: title
				});
			} else if (props.url) {
				titleNode = jsx("a", { className: "dswb-row-title dswb-link", href: props.url, target: "_blank", rel: "noreferrer", title: title, children: title });
			} else {
				titleNode = jsx("span", { className: "dswb-row-title", title: title, children: title });
			}
			var meta = [];
			if (props.meta !== undefined) meta.push(props.meta);
			if (props.addState === "added") meta.push(jsx("span", { className: "dswb-added", children: "✓ added" }));
			if (props.addState === "duplicate") meta.push(jsx("span", { className: "dswb-added", children: "already added" }));
			if (props.addState === "unavailable") meta.push(jsx("span", { className: "dswb-added", "data-kind": "warn", children: "no composer" }));
			if (props.onAdd && props.url) {
				meta.push(jsx("a", {
					className: "dswb-open",
					href: props.url,
					target: "_blank",
					rel: "noreferrer",
					title: "Open the source",
					children: "↗"
				}));
			}
			return jsxs("div", {
				className: "dswb-row" + (props.highlight ? " dswb-now" : ""),
				children: [
					props.leading === undefined ? null : props.leading,
					jsxs("div", {
						className: "dswb-row-main",
						children: [
							titleNode,
							props.sub === undefined || props.sub === null ? null : jsx("span", { className: "dswb-row-sub", children: props.sub })
						]
					}),
					jsx("span", { className: "dswb-meta", children: meta })
				]
			});
		}

		function Pill(props) {
			return jsx("span", { className: "dswb-pill", "data-tone": props.tone || "muted", children: props.children });
		}
		function CiDot(props) {
			var tone = props.ci || "none";
			var label = {
				success: "CI passing", failure: "CI failing", pending: "CI running",
				none: "no CI checks", unknown: "CI status unknown"
			}[tone] || tone;
			return jsx("span", { className: "dswb-dot", "data-tone": tone, title: label, "aria-label": label });
		}
		function RefreshIcon() {
			return jsx("svg", {
				width: 14, height: 14, viewBox: "0 0 16 16", fill: "none",
				stroke: "currentColor", strokeWidth: 1.6, strokeLinecap: "round", strokeLinejoin: "round",
				children: jsx("path", { d: "M13.5 8a5.5 5.5 0 1 1-1.6-3.9M13.5 2v3.2h-3.2" })
			});
		}
		//#endregion

		//#region cards
		/** PRs awaiting my review first, then my own open PRs — each with CI and discussion state. */
		function GithubCard(props) {
			var sources = props.sources;
			var prs = dataOf(sources, "github", "prs", []);
			var unavailable = unavailableOf(sources, "github");
			var review = prs.filter(function (pr) { return pr.role === "review-requested"; });
			var authored = prs.filter(function (pr) { return pr.role !== "review-requested"; });
			var failing = prs.filter(function (pr) { return pr.ci === "failure"; }).length;

			function group(label, rows) {
				if (rows.length === 0) return null;
				return jsxs(Fragment, {
					children: [
						jsx("div", { className: "dswb-group", children: label }),
						jsx("div", {
							className: "dswb-rows",
							children: rows.map(function (pr) {
								var notes = [];
								if (pr.draft) notes.push("draft");
								if (pr.reviewDecision === "APPROVED") notes.push("approved");
								if (pr.reviewDecision === "CHANGES_REQUESTED") notes.push("changes requested");
								if (pr.reviewDecision === "REVIEW_REQUIRED") notes.push("review required");
								if (pr.mergeable === "CONFLICTING") notes.push("conflicts");
								if (pr.updatedAt) notes.push(formatRelative(pr.updatedAt));
								return jsx(Row, {
									key: pr.id,
									title: pr.title || "(untitled)",
									url: safeUrl(pr.url),
									onAdd: function () { props.onAdd(pr.id, prContextLine(pr)); },
									addState: props.addState[pr.id],
									leading: jsx(CiDot, { ci: pr.ci }),
									sub: (pr.repo || "?") + " #" + pr.number + (notes.length ? " · " + notes.join(" · ") : ""),
									meta: jsxs(Fragment, {
										children: [
											jsx("span", { title: "review comments", children: "💬 " + String(pr.comments || 0) }),
											jsx("span", { title: "submitted reviews", children: "✓ " + String(pr.reviews || 0) })
										]
									})
								});
							})
						})
					]
				});
			}

			var Shell = shellFor(props);
			return jsxs(Shell, {
				shell: props.shell,
				mark: GITHUB_MARK,
				title: "GitHub pull requests",
				folded: props.folded,
				onToggle: props.onToggle,
				count: prs.length,
				chip: jsx(SourceChip, { sourceKey: "github", unavailable: unavailable }),
				note: unavailable,
				children: [
					prs.length === 0 && !unavailable ? jsx(EmptyRow, { children: "No open pull requests need you right now." }) : null,
					group("Waiting on my review", review),
					group("My open pull requests", authored),
					failing > 0 ? jsx("div", { className: "dswb-empty", children: "⚠︎ " + String(failing) + " pull request(s) have failing CI." }) : null
				]
			});
		}

		/** Jira: unresolved issues assigned to me, grouped by project. */
		function JiraCard(props) {
			var sources = props.sources;
			var projects = dataOf(sources, "jira", "projects", []);
			var unavailable = unavailableOf(sources, "jira");
			var total = projects.reduce(function (sum, project) { return sum + (project.issues || []).length; }, 0);
			var Shell = shellFor(props);
			return jsxs(Shell, {
				shell: props.shell,
				mark: JIRA_MARK,
				title: "Jira assigned to me",
				folded: props.folded,
				onToggle: props.onToggle,
				count: total,
				chip: jsx(SourceChip, { sourceKey: "jira", unavailable: unavailable }),
				note: unavailable,
				children: [
					total === 0 && !unavailable ? jsx(EmptyRow, { children: "Nothing assigned to you." }) : null,
					projects.map(function (project) {
						return jsxs(Fragment, {
							key: String(project.key || project.name),
							children: [
								jsxs("div", {
									className: "dswb-group",
									children: [
										jsx("span", { children: project.key ? project.key + " · " + project.name : project.name }),
										jsx("span", { className: "dswb-chip", children: String((project.issues || []).length) })
									]
								}),
								jsx("div", {
									className: "dswb-rows",
									children: (project.issues || []).map(function (issue) {
										return jsx(Row, {
											key: issue.key,
											title: issue.summary || issue.key,
											url: safeUrl(issue.url),
											onAdd: function () { props.onAdd(issue.key, jiraContextLine(issue)); },
											addState: props.addState[issue.key],
											sub: issue.key + (issue.type ? " · " + issue.type : "") + (issue.status ? " · " + issue.status : ""),
											meta: issue.priority ? jsx(Pill, { tone: priorityTone(issue.priority), children: issue.priority }) : null
										});
									})
								})
							]
						});
					})
				]
			});
		}

		/** Today's agenda; when the token is missing the card offers the connect flow. */
		function CalendarCard(props) {
			var sources = props.sources;
			// All-day entries (holidays, "Office", birthdays) are noise on a work
			// board — only timed meetings are actionable. Dropping them here rather
			// than in the data plane keeps the route a faithful Calendar read.
			var events = dataOf(sources, "calendar", "events", []).filter(function (event) { return !event.allDay; });
			var unavailable = unavailableOf(sources, "calendar");
			var source = sources && sources.calendar;
			var connectUrl = source && source.data ? source.data.connectUrl : null;
			var date = dataOf(sources, "calendar", "date", "");
			var note = null;
			if (unavailable) {
				note = connectUrl
					? jsxs(Fragment, {
						children: [
							unavailable, " ",
							jsx("a", { href: connectUrl, target: "_blank", rel: "noreferrer", children: "Connect Google Calendar →" })
						]
					})
					: unavailable;
			}
			var Shell = shellFor(props);
			return jsxs(Shell, {
				shell: props.shell,
				mark: CALENDAR_MARK,
				title: "Today's calendar",
				folded: props.folded,
				onToggle: props.onToggle,
				count: events.length,
				chip: jsx(SourceChip, { sourceKey: "calendar", unavailable: unavailable }),
				note: note,
				children: [
					events.length === 0 && !unavailable
						? jsx(EmptyRow, { children: "Nothing on the calendar" + (date ? " for " + date : "") + "." })
						: null,
					jsx("div", {
						className: "dswb-rows",
						children: events.map(function (event) {
							var when = event.allDay
								? "all day"
								: formatTime(event.start) + (event.end ? "–" + formatTime(event.end) : "");
							var live = isNow(event);
							return jsx(Row, {
								key: event.id,
								highlight: live,
								title: event.title,
								url: safeUrl(event.meetingUrl),
								onAdd: function () { props.onAdd(event.id, eventContextLine(event)); },
								addState: props.addState[event.id],
								sub: when + (event.location ? " · " + event.location : ""),
								meta: live
									? jsx(Pill, { tone: "accent", children: "now" })
									: (event.meetingUrl ? jsx(Pill, { tone: "muted", children: "join" }) : null)
							});
						})
					})
				]
			});
		}

		/** Local git state for every registered DSH Workspace. */
		function WorkspacesCard(props) {
			var sources = props.sources;
			var workspaces = dataOf(sources, "git", "workspaces", []);
			var unavailable = unavailableOf(sources, "git");
			var dirty = workspaces.filter(function (workspace) { return workspace.dirty > 0; }).length;
			var Shell = shellFor(props);
			return jsxs(Shell, {
				shell: props.shell,
				mark: GIT_MARK,
				title: "Workspace git status",
				folded: props.folded,
				onToggle: props.onToggle,
				count: workspaces.length,
				chip: jsx(SourceChip, { sourceKey: "git", unavailable: unavailable }),
				note: unavailable,
				children: [
					workspaces.length === 0 && !unavailable ? jsx(EmptyRow, { children: "No workspaces registered." }) : null,
					jsx("div", {
						className: "dswb-rows",
						children: workspaces.map(function (workspace) {
							var chips = [];
							if (workspace.error) chips.push(jsx(Pill, { key: "err", tone: "warn", children: workspace.error }));
							if (workspace.dirty > 0) chips.push(jsx(Pill, { key: "dirty", tone: "warn", children: workspace.dirty + " dirty" }));
							if (workspace.ahead > 0) chips.push(jsx(Pill, { key: "ahead", tone: "accent", children: "↑" + workspace.ahead }));
							if (workspace.behind > 0) chips.push(jsx(Pill, { key: "behind", tone: "accent", children: "↓" + workspace.behind }));
							if (workspace.stash > 0) chips.push(jsx(Pill, { key: "stash", tone: "muted", children: workspace.stash + " stash" }));
							if (chips.length === 0) chips.push(jsx(Pill, { key: "clean", tone: "ok", children: "clean" }));
							return jsx(Row, {
								key: workspace.path,
								title: workspace.name,
								sub: workspace.branch || "—",
								onAdd: function () { props.onAdd(workspace.path, workspaceContextLine(workspace)); },
								addState: props.addState[workspace.path],
								meta: chips
							});
						})
					}),
					dirty > 0 ? jsx("div", { className: "dswb-empty", children: String(dirty) + " workspace(s) have uncommitted changes." }) : null
				]
			});
		}

		/** Every section id the deck can fold, in render order. */
		var SECTION_IDS = ["github", "jira", "calendar", "workspaces"];

		/** The deck, ordered by what needs the reader first. */
		function BoardCards(props) {
			var section = function (id, Component) {
				return jsx(Component, {
					sources: props.sources,
					shell: props.shell,
					folded: props.folded[id] === true,
					onToggle: function () { props.onToggle(id); },
					onAdd: props.onAdd,
					addState: props.addState
				}, id);
			};
			return jsxs(Fragment, {
				children: [
					section("github", GithubCard),
					section("jira", JiraCard),
					section("calendar", CalendarCard),
					section("workspaces", WorkspacesCard)
				]
			});
		}

		/** Fold state for the whole deck, shared by the board and the panel. */
		function useSectionFold() {
			var state = React.useState({});
			var folded = state[0];
			var setFolded = state[1];
			var toggle = React.useCallback(function (id) {
				setFolded(function (previous) {
					var next = Object.assign({}, previous);
					next[id] = previous[id] !== true;
					return next;
				});
			}, []);
			return { folded: folded, toggle: toggle };
		}
		//#endregion

		//#region surfaces
		/** Count driving the floating badge: review requests plus failing CI. */
		function attentionOf(sources) {
			var prs = dataOf(sources, "github", "prs", []);
			var count = 0;
			for (var index = 0; index < prs.length; index += 1) {
				if (prs[index].role === "review-requested" || prs[index].ci === "failure") count += 1;
			}
			return count;
		}

		function RefreshButton(props) {
			return jsx("button", {
				type: "button",
				className: "dswb-iconbtn",
				title: "Refresh every source",
				"data-spinning": props.loading ? "true" : "false",
				onClick: props.onRefresh,
				children: jsx(RefreshIcon, {})
			});
		}

		/**
		 * The home board, shown on the no-session and new-conversation screens.
		 *
		 * Sized and placed from the measured composer: same left edge, same width,
		 * starting just below it, and capped so it never grows past the viewport.
		 * Aligning to the composer's x rather than centring on the viewport matters
		 * — the composer is centred inside the centre column, which begins after
		 * the sidebar, so viewport centring lands half a sidebar off. That
		 * alignment is what keeps this a page block instead of an overlay: the
		 * sidebar, the composer, and everything else stay on screen and clickable.
		 */
		function HomeBoard(props) {
			var attention = attentionOf(props.data.sources);
			var status = props.data.loading && props.data.sources === null
				? "loading…"
				: [
					props.data.fetchedAt ? "updated " + formatRelative(new Date(props.data.fetchedAt).toISOString()) : "",
					attention > 0 ? String(attention) + " need attention" : ""
				].filter(Boolean).join(" · ");
			return jsx("div", {
				className: "dswb-home",
				style: {
					top: props.top === null || props.top === undefined ? undefined : String(props.top) + "px",
					left: props.left === null || props.left === undefined ? undefined : String(props.left) + "px"
				},
				children: jsxs("div", {
					className: "dswb-board",
					style: {
						width: props.width === null || props.width === undefined ? undefined : String(props.width) + "px",
						maxHeight: props.maxHeight === null || props.maxHeight === undefined ? undefined : String(props.maxHeight) + "px"
					},
					children: [
						jsxs("header", {
							className: "dswb-board-head",
							children: [
								jsxs("span", {
									className: "dswb-board-title",
									children: [jsx(Mark, { svg: BOARD_MARK }), "My work today"]
								}),
								jsx("span", { className: "dswb-board-sub", children: status }),
								jsxs("span", {
									className: "dswb-actions",
									children: [
										jsx(RefreshButton, { loading: props.data.loading, onRefresh: props.data.refresh }),
										jsx("button", {
											type: "button",
											className: "dswb-iconbtn",
											title: "Hide board",
											onClick: props.onDismiss,
											children: "✕"
										})
									]
								})
							]
						}),
						jsx("div", {
							className: "dswb-board-body",
							children: props.data.sources === null
								? jsx(EmptyRow, { children: "Loading your work…" })
								: jsx(BoardCards, {
									sources: props.data.sources,
									shell: "section",
									folded: props.folded,
									onToggle: props.onToggle,
									onAdd: props.onAdd,
									addState: props.addState
								})
						})
					]
				})
			});
		}

		/** The compact panel, reachable from every screen. */
		function Panel(props) {
			React.useEffect(function () {
				var onKey = function (event) { if (event.key === "Escape") props.onClose(); };
				window.addEventListener("keydown", onKey);
				return function () { window.removeEventListener("keydown", onKey); };
			}, [props.onClose]);
			return jsxs("div", {
				className: "dswb-panel",
				// Track the button: when it steps up to clear the composer, the
				// panel must come with it instead of overlapping it.
				style: props.bottom === null || props.bottom === undefined
					? undefined
					: { bottom: String(props.bottom + 56) + "px" },
				children: [
					jsxs("header", {
						className: "dswb-header",
						children: [
							jsx("span", { className: "dswb-title", children: "Workboard" }),
							jsxs("span", {
								className: "dswb-actions",
								children: [
									jsx(RefreshButton, { loading: props.data.loading, onRefresh: props.data.refresh }),
									jsx("button", { type: "button", className: "dswb-iconbtn", title: "Close", onClick: props.onClose, children: "✕" })
								]
							})
						]
					}),
					jsx("div", {
						className: "dswb-body",
						children: props.data.sources === null
							? jsx(EmptyRow, { children: "Loading your work…" })
							: jsx(BoardCards, {
								sources: props.data.sources,
								folded: props.folded,
								onToggle: props.onToggle,
								onAdd: props.onAdd,
								addState: props.addState
							})
					})
				]
			});
		}

		/**
		 * Entry component for the `shell.overlay` list slot.
		 *
		 * Root-scoped slots receive the framework's global standard props, so
		 * `useSessions` arrives here and the board's home screens are readable
		 * without any session-scoped API.
		 */
		function WorkboardRoot(props) {
			var openState = React.useState(false);
			var open = openState[0];
			var setOpen = openState[1];
			var dismissedState = React.useState(false);
			var dismissed = dismissedState[0];
			var setDismissed = dismissedState[1];
			var data = useWorkboard();
			var fold = useSectionFold();
			var layout = useComposerLayout();
			var addState = React.useState({});
			var added = addState[0];
			var setAdded = addState[1];
			var timers = React.useRef({});
			/**
			 * Push one board row into the composer as context, then show the outcome
			 * on that row for a moment. Feedback is per row and always reports what
			 * actually happened — "no composer" is shown rather than swallowed.
			 */
			var addContext = React.useCallback(function (id, line) {
				var outcome = addContextToComposer(line);
				setAdded(function (previous) {
					var next = Object.assign({}, previous);
					next[id] = outcome;
					return next;
				});
				if (timers.current[id] !== undefined) clearTimeout(timers.current[id]);
				timers.current[id] = setTimeout(function () {
					delete timers.current[id];
					setAdded(function (previous) {
						if (previous[id] === undefined) return previous;
						var next = Object.assign({}, previous);
						delete next[id];
						return next;
					});
				}, outcome === "added" ? 1800 : 2600);
			}, []);
			React.useEffect(function () {
				var pending = timers.current;
				return function () {
					Object.keys(pending).forEach(function (id) { clearTimeout(pending[id]); });
				};
			}, []);
			/**
			 * The board's two home screens, both keyed on the session list's SETTLED
			 * phase:
			 *   - `current === undefined` — the New Session view with no session at all.
			 *   - `current.blank` — a conversation that was just opened and has no
			 *     turns yet. New Session opens a real (blank) session rather than
			 *     clearing the selection, so this arm is what makes the board appear
			 *     when a new conversation is opened.
			 * The phase gate matters because `current === undefined` is ALSO the
			 * pre-pull state, which made the board flash on every page load.
			 */
			var atHome = props.useSessions(function (state) {
				if (state.phase !== "ready") return false;
				if (state.current === undefined) return true;
				var row = state.byId ? state.byId[state.current] : undefined;
				return row !== undefined && row !== null && row.blank === true;
			});
			var closePanel = React.useCallback(function () { setOpen(false); }, []);

			// Leaving the home screens and coming back re-arms the board.
			React.useEffect(function () {
				if (!atHome) setDismissed(false);
			}, [atHome]);

			var attention = attentionOf(data.sources);
			var showBoard = atHome && !dismissed && !open;

			return jsxs(Fragment, {
				children: [
					showBoard
						? jsx(HomeBoard, {
							data: data,
							top: layout.boardTop,
							left: layout.boardLeft,
							width: layout.boardWidth,
							maxHeight: layout.boardMaxHeight,
							folded: fold.folded,
							onToggle: fold.toggle,
							onAdd: addContext,
							addState: added,
							onDismiss: function () { setDismissed(true); }
						})
						: null,
					open
						? jsx(Panel, {
							data: data,
							bottom: layout.fabBottom,
							folded: fold.folded,
							onToggle: fold.toggle,
							onAdd: addContext,
							addState: added,
							onClose: closePanel
						})
						: null,
					jsxs("button", {
						type: "button",
						className: "dswb-fab",
						style: { bottom: String(layout.fabBottom) + "px" },
						title: (open ? "Hide workboard" : "Show workboard")
							+ (attention > 0 ? " — " + String(attention) + " need attention" : ""),
						"aria-expanded": open,
						"aria-label": "Workboard",
						"data-attention": attention > 0 ? "true" : "false",
						onClick: function () { setOpen(!open); },
						children: [
							jsx(Mark, { svg: BOARD_MARK, title: null }),
							attention > 0 ? jsx("span", { className: "dswb-fab-count", children: String(attention) }) : null
						]
					})
				]
			});
		}
		//#endregion

		//#region plugin
		/** Stable plugin name. */
		var name = "dsh-workboard";
		/**
		 * Required client services: the slot registry. Declaring it parks this
		 * fiber until the runtime provides `slots`, which is also what unlocks
		 * `ctx.slots` on the sandboxed dynamic context.
		 */
		var inject = ["slots"];

		/**
		 * Client plugin body: inject this package's stylesheet and register the
		 * dashboard into the additive, root-scoped `shell.overlay` list slot.
		 * That layer is click-through by design, so the hero board, the panel,
		 * and the floating button each opt back into pointer events in their CSS.
		 * @param ctx - client root context.
		 */
		function apply(ctx) {
			ctx.effect(function () {
				if (typeof document === "undefined") return undefined;
				var tag = document.createElement("style");
				tag.dataset.plugin = "dsh-workboard";
				tag.dataset.pluginCss = "dsh-workboard/workboard.css";
				tag.textContent = CSS;
				document.head.appendChild(tag);
				return function () { tag.remove(); };
			}, "dsh-workboard: styles");
			ctx.slots.inject("shell.overlay", function () {
				return ctx.slots.register(
					{ name: "shell.overlay", id: "workboard", order: 100, label: "Workboard" },
					WorkboardRoot
				);
			});
		}
		//#endregion

		exports.apply = apply;
		exports.inject = inject;
		exports.name = name;
		return module.exports;
	}
});
