window.__ModuleLoader__.load({ id: "dsh-session-delete", factory: (require) => {
	"use strict";

	/* ------------------------------------------------------------------ *
	 * dsh-session-delete — client half
	 *
	 * Where the entry lives, and why
	 * ------------------------------
	 * It used to sit in `conversation.session.header.utilities`, because the
	 * sidebar Session row was believed to have no plugin seat. That belief is
	 * out of date: the current host declares a dedicated list slot for the
	 * rows of one Session's "…" menu,
	 *
	 *   sidebar.workspaces.session.menu.item
	 *
	 * whose ownerProps hand every occurrence the row's `sessionId` AND its
	 * `displayTitle`, and whose occupants are the shipped pin(100) /
	 * rename(200) / fork(300) / archive(400). This entry registers at 500, so
	 * it lands after them, under its own package-namespaced id. Reusing a
	 * shipped id would REPLACE that row instead of joining it.
	 *
	 * Two registrations, one feature
	 * ------------------------------
	 *   1. sidebar.workspaces.session.menu.item — the "删除会话…" row
	 *   2. shell.overlay                        — the confirmation dialog
	 *
	 * They are separated on purpose: a dialog rendered inside a menu row would
	 * be unmounted with the menu. They talk through the tiny store below, which
	 * is module-scoped, so both halves are the same instance.
	 *
	 * There is NO trash screen. Deleting hands the log to the OPERATING SYSTEM's
	 * recycle bin, so the restore flow is the one the user already has; an
	 * earlier revision built a second, private bin inside DSH and that was the
	 * wrong shape.
	 *
	 * The Host half owns the whole sequence (stop, recycle, detach, unarchive),
	 * reached over its HTTP carrier — see lib/index.js for that order and for
	 * why `host.call` is not the channel for a packaged plugin.
	 * ------------------------------------------------------------------ */

	var module = { exports: {} };
	var exports = module.exports;

	/** React, from the loader's module table, then from the injected global. */
	var React = (function () {
		try {
			var required = require("react");
			if (required && typeof required.createElement === "function") return required;
		} catch (error) { /* falls through to the injected global */ }
		var injected = globalThis.React;
		if (injected && typeof injected.createElement === "function") return injected;
		return null;
	})();

	/**
	 * Optional ui-primitives, for the shipped menu-row look.
	 *
	 * Resolved defensively: the module is host-injected, so a host that does
	 * not carry `MenuItemButton` must cost this plugin its styling, not its
	 * boot. The fallback below renders the same `role="menuitem"` button, and
	 * the menu's keyboard walk reads the DOM, so it joins either way.
	 */
	var primitives = (function () {
		try {
			return require("@deepseek-ai/dsh-client-ui-primitives");
		} catch (error) {
			return null;
		}
	})();

	var NS = "session-delete";

	var zh = {
		deleteSession: "删除会话…",
		confirmTitle: "删除会话",
		confirmBody: "「{0}」的日志与投影缓存会被移到系统回收站，并从列表移除。",
		delete: "删除",
		cancel: "取消",
		confirm: "确认",
		close: "关闭",
		working: "处理中…",
		deleted: "已删除：日志已移入系统回收站。",
		liveNotice: "这个会话在本次运行中被加载过，侧栏里那一行会一直留到 DSH 重启为止（内存中的会话只有它的属主能卸载，插件无权）。",
		removedOnly: "磁盘上没有日志可回收（可能此前已被删过），已把它从列表里移除。",
		deletedWithNotes: "已移入系统回收站，但列表清理未完全成功：{0}",
		sessionLogMissing: "这个会话既不在磁盘上、也不在列表登记里，未做任何改动。",
		platformUnsupported: "当前系统没有本插件可用的回收站，未做任何改动（目前只实现了 Windows）。",
		errorUnknown: "操作失败",
	};

	var en = {
		deleteSession: "Delete session…",
		confirmTitle: "Delete session",
		confirmBody: "The log and projection cache of \u201c{0}\u201d will move to the system recycle bin and leave the list.",
		delete: "Delete",
		cancel: "Cancel",
		confirm: "OK",
		close: "Close",
		working: "Working…",
		deleted: "Deleted: the log is in the system recycle bin.",
		liveNotice: "This Session was loaded in this run, so its sidebar row stays until DSH is restarted (a Session loaded in memory can only be unloaded by its owner, which a plugin is not).",
		removedOnly: "There was no log left to recycle (it may already have been deleted), so the row was removed from the list.",
		deletedWithNotes: "Moved to the recycle bin, but cleaning up the list was incomplete: {0}",
		sessionLogMissing: "This Session is neither on disk nor in the registry, so nothing was changed.",
		platformUnsupported: "This system has no recycle bin this plugin can use, so nothing was changed (Windows only for now).",
		errorUnknown: "The operation failed",
	};

	var CSS = [
		".dsd-menuitem{display:flex;align-items:center;gap:8px;width:100%;box-sizing:border-box;padding:0 10px;height:32px;border:none;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:20px;text-align:left;border-radius:6px;cursor:pointer}",
		".dsd-menuitem:hover,.dsd-menuitem:focus-visible{background:var(--dsw-alias-interactive-bg-hover);outline:none}",
		".dsd-menuitem .dsd-icon{display:inline-flex;flex:none}",
		// shell.overlay is click-through ON PURPOSE — its catalog says "the layer
		// itself is click-through — entries opt back into pointer events". Without
		// this the mask paints and every click falls through to the page: a
		// dialog that looks alive and is not.
		".dsd-mask{position:fixed;inset:0;z-index:1000;pointer-events:auto;background:rgba(0,0,0,.35);display:flex;align-items:center;justify-content:center}",
		// Every token carries a literal fallback — the house style in the market's
		// own stylesheet. The alias tier is not identical across hosts, and a
		// missing token drops the declaration silently. `--dsw-alias-interactive-
		// bg-hover` is exactly that case: it is not in the documented token list.
		".dsd-dialog{box-sizing:border-box;background:var(--dsw-alias-bg-layer-2,#f7f8fa);border:1px solid var(--dsw-alias-border-l2,#e5e7eb);border-radius:12px;box-shadow:var(--dsw-shadow-lv2,0 8px 24px rgba(31,35,40,.16));width:400px;max-width:92vw;max-height:86vh;overflow:auto;padding:20px}",
		".dsd-title{margin:0 0 6px;color:var(--dsw-alias-label-primary,#1f2328);font-size:16px;font-weight:600;line-height:24px}",
		".dsd-body{margin:0 0 14px;color:var(--dsw-alias-label-secondary,#6b7280);font-size:13px;line-height:20px;word-break:break-word}",
		".dsd-choices{display:flex;flex-direction:column;gap:8px;margin:0 0 14px}",
		".dsd-choice{display:block;width:100%;box-sizing:border-box;text-align:left;padding:10px 12px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2,#e5e7eb);background:transparent;color:var(--dsw-alias-label-primary,#1f2328);font:inherit;font-size:13px;line-height:20px;cursor:pointer}",
		".dsd-choice:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(31,35,40,.06))}",
		".dsd-choice strong{display:block;font-weight:600;margin-bottom:2px}",
		".dsd-choice span{color:var(--dsw-alias-label-secondary,#6b7280);font-size:12px;line-height:18px}",
		".dsd-choice-danger strong{color:var(--dsw-alias-state-error-primary,#dc2626)}",
		".dsd-error{color:var(--dsw-alias-state-error-primary,#dc2626);margin:10px 0 0;font-size:12px;line-height:18px;word-break:break-word}",
		".dsd-note{margin:10px 0 0;color:var(--dsw-alias-label-secondary,#6b7280);font-size:12px;line-height:18px}",
		".dsd-warn{margin:10px 0 0;color:var(--dsw-alias-state-warn-primary,#b45309);font-size:12px;line-height:18px}",
		".dsd-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:16px}",
		".dsd-cancel{height:32px;border-radius:8px;padding:0 14px;font:inherit;font-size:13px;font-weight:500;color:var(--dsw-alias-label-primary,#1f2328);background:transparent;border:1px solid var(--dsw-alias-border-l2,#e5e7eb);cursor:pointer}",
		".dsd-cancel:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(31,35,40,.06))}",
		".dsd-cancel:disabled{opacity:.6;cursor:default}",
		// The end state's acknowledgement — and, when a row is expected to linger,
		// the control that reloads the page and re-reads the list.
		".dsd-primary{height:32px;border-radius:8px;padding:0 14px;font:inherit;font-size:13px;font-weight:500;color:#fff;background:var(--dsw-alias-brand-primary,#4f6ef7);border:none;cursor:pointer}",
		".dsd-primary:hover:not(:disabled){filter:brightness(1.08)}",
		".dsd-primary:disabled{opacity:.6;cursor:default}",
	].join("\n");

	/**
	 * Stylesheet, through the host's own insertion seam when it exists.
	 *
	 * `styles.insert` is the injected builtin whose tag the host unwinds with
	 * the client run. The `<style data-plugin-css>` fallback below is the same
	 * one the previous version shipped, kept so an older host still renders.
	 */
	function installStyles() {
		try {
			if (typeof styles !== "undefined" && styles && typeof styles.insert === "function") {
				styles.insert(CSS);
				return;
			}
		} catch (error) { /* fall through */ }
		if (typeof document === "undefined") return;
		var marker = "dsh-session-delete/session-delete.css";
		if (document.querySelector("style[data-plugin-css=" + JSON.stringify(marker) + "]") !== null) return;
		var tag = document.createElement("style");
		tag.setAttribute("data-plugin", "dsh-session-delete");
		tag.setAttribute("data-plugin-css", marker);
		tag.textContent = CSS;
		document.head.appendChild(tag);
	}

	/* ---------------------------- translation --------------------------- */

	var dictionaries = { zh: zh, en: en };
	var boundTranslate = null;

	/**
	 * The client context, captured by `apply`.
	 *
	 * Module scope because the helpers below outlive the apply() call frame:
	 * a label thunk, a component, and an event handler all run later, and
	 * none of them can see apply's parameter.
	 */
	var hostCtx = null;

	function activeLanguage() {
		try {
			var snapshot = hostCtx.locale.getSnapshot();
			var active = snapshot && typeof snapshot.active === "string" ? snapshot.active : "en";
			return active.toLowerCase().indexOf("zh") === 0 ? "zh" : "en";
		} catch (error) {
			return "en";
		}
	}

	function format(text, args) {
		return String(text).replace(/\{(\d+)\}/g, function (whole, index) {
			var value = args[Number(index)];
			return value === undefined || value === null ? "" : String(value);
		});
	}

	/**
	 * `t("key", arg0, …)`.
	 *
	 * The bound translator from the locale service is preferred (it is what
	 * `locale: NS` gives an entry), with the module's own dictionaries behind
	 * it so a missing key renders readable text rather than the raw key.
	 */
	function translate(key) {
		var args = Array.prototype.slice.call(arguments, 1);
		if (boundTranslate !== null) {
			try {
				var bound = boundTranslate(key);
				if (typeof bound === "string" && bound !== "" && bound !== key) return format(bound, args);
			} catch (error) { /* fall back to the local dictionary */ }
		}
		var language = activeLanguage();
		var dictionary = dictionaries[language] || en;
		var text = dictionary[key] !== undefined ? dictionary[key] : (en[key] !== undefined ? en[key] : key);
		return format(text, args);
	}

	/* ------------------------------- host ------------------------------- */

	/**
	 * Resolve a Host path against the page the UI is served from.
	 *
	 * Root-absolute URLs break behind a reverse proxy that mounts dsh under a
	 * prefix, so the base directory comes from `document.baseURI` — the same
	 * rule the market's own client follows.
	 */
	function api(path) {
		var relative = String(path).replace(/^\/+/, "");
		if (typeof document === "undefined") return "/" + relative;
		try {
			return new URL(relative, document.baseURI).pathname;
		} catch (error) {
			return "/" + relative;
		}
	}

	async function rpc(method, path, body) {
		var init = { method: method, headers: { accept: "application/json" } };
		if (body !== undefined) {
			init.headers["content-type"] = "application/json";
			init.body = JSON.stringify(body);
		}
		var response = await fetch(api(path), init);
		var text = await response.text();
		var data = null;
		try {
			data = text === "" ? null : JSON.parse(text);
		} catch (error) {
			data = null;
		}
		if (!response.ok) {
			// The status rides along. The trash flow treats a definite 404 from the
			// locator ("the Host looked and the log is not there") differently from
			// a locator that could not answer at all.
			var failure = new Error(data && data.error ? String(data.error) : "HTTP " + String(response.status));
			failure.status = response.status;
			failure.body = data;
			throw failure;
		}
		return data;
	}

	var deleteOnHost = (sessionId) => rpc("POST", "/dsh-session-delete/delete", { sessionId: sessionId });

	/**
	 * Delete one Session — one request, and the Host owns the order.
	 *
	 * The Host half locates first and only then decides what to do: stop the
	 * Session, move its log and projection cache to the OPERATING SYSTEM's
	 * recycle bin, then detach it from the workspace registry and clear the
	 * archive entry it made to stop it. Because that order is enforced next to
	 * the mutations, this half does NOT pre-check: a browser-side probe would
	 * only add a round trip and a second place for the halves to disagree — and
	 * it would have BLOCKED the one case that needs a delete with no log to move
	 * (a row left behind by an earlier revision, whose bytes are already gone).
	 *
	 * `ui` is `{ busy, error, done }` — plain callbacks, so this sequence is
	 * drivable from a test without a React renderer.
	 */
	async function deleteSessionFlow(sessionId, ui) {
		ui.busy(true);
		ui.error(null);
		try {
			const result = await deleteOnHost(sessionId);
			// Nothing to recycle is still a success: the row was removed.
			if (result && result.removedOnly === true) {
				ui.done(translate("removedOnly"));
				return;
			}
			// The bytes are gone by now, so a registry note is a warning, never a
			// failure report: say exactly what did not happen rather than implying
			// the delete did not.
			const notes = (result && Array.isArray(result.notes) ? result.notes : [])
				.map((note) => String(note))
				.filter((note) => note.indexOf("failed") !== -1 || note.indexOf("did not report") !== -1 || note.indexOf("no workspace registry") !== -1);
			if (notes.length > 0) ui.error(translate("deletedWithNotes", notes.join("; ")));
			else {
				// A row that will linger gets its own notice instead of being folded
				// into the success line: the delete DID succeed, and the one thing
				// left to say is when the row goes away. A page reload does NOT
				// clear it — measured: the row lives in the Host's in-memory session
				// store, which is rebuilt from disk only at startup.
				if (result && result.wasLive === true && typeof ui.live === "function") ui.live(true);
				ui.done(translate("deleted"));
			}
		} catch (failure) {
			if (failure && failure.status === 501) ui.error(translate("platformUnsupported"));
			else if (failure && failure.status === 404) ui.error(translate("sessionLogMissing"));
			else ui.error(String(failure && failure.message ? failure.message : failure) || translate("errorUnknown"));
		} finally {
			ui.busy(false);
		}
	}

	/* ------------------------------- store ------------------------------- */

	/**
	 * The dialog request, shared by the menu row and the overlay host.
	 *
	 * Module scope, not React context: both entries come from this one module
	 * instance, and a context provider would need a seat in the tree above
	 * both — which is exactly what a menu row and a frame-wide overlay do not
	 * share.
	 */
	var pending = null;
	var subscribers = new Set();

	function setPending(next) {
		pending = next;
		subscribers.forEach(function (notify) {
			try {
				notify();
			} catch (error) { /* one bad subscriber must not stop the rest */ }
		});
	}

	function usePending() {
		var pair = React.useState(pending);
		var value = pair[0];
		var setValue = pair[1];
		React.useEffect(function () {
			var notify = function () {
				setValue(pending);
			};
			subscribers.add(notify);
			notify();
			return function () {
				subscribers.delete(notify);
			};
		}, []);
		return value;
	}

	/* ------------------------------ actions ------------------------------ */

	/* ---------------------------- menu row ---------------------------- */

	/**
	 * The official trash glyph, resolved the way the market resolves icons.
	 *
	 * 0.1.7 renamed the size-suffixed icon exports to weight names with no alias,
	 * so a host carries one spelling or the other. Regular first (the product's
	 * default stroke), then Medium, then the pre-0.1.7 `16`. The inline artwork
	 * is the floor, so the row has a trash can on any host — it is the same
	 * `IconTrashOutline16` path the first version of this plugin hard-coded.
	 */
	var INLINE_TRASH_PATH = "M14.4782 4.84067L14.2138 10.1152C14.1102 12.1872 14.067 13.0115 13.3866 13.9607C13.1044 14.3546 12.7498 14.6912 12.3424 14.9535C11.8239 15.2872 11.2415 15.4316 10.5585 15.4998C9.88727 15.5668 9.04946 15.5656 7.99998 15.5656C6.95051 15.5656 6.1127 15.5668 5.44142 15.4998C4.75851 15.4316 4.17602 15.2872 3.65753 14.9535C3.25012 14.6912 2.89559 14.3546 2.61332 13.9607C1.93296 13.0115 1.88979 12.1872 1.78619 10.1152L1.52179 4.84067L2.89006 4.77277L3.15343 10.0463C3.26221 12.2218 3.32452 12.6015 3.72646 13.1624C3.90825 13.4161 4.13686 13.6334 4.39927 13.8023C4.66204 13.9714 5.00263 14.0792 5.57825 14.1367C6.16562 14.1953 6.92298 14.1963 7.99998 14.1963C9.07699 14.1963 9.83434 14.1953 10.4217 14.1367C10.9973 14.0792 11.3379 13.9714 11.6007 13.8023C11.8631 13.6334 12.0917 13.4161 12.2735 13.1624C12.6755 12.6015 12.7378 12.2218 12.8465 10.0463L13.1099 4.77277L14.4782 4.84067ZM5.43011 6.22849H6.7994V11.3909H5.43011V6.22849ZM9.20056 6.22849H10.5699V11.3909H9.20056V6.22849ZM8.53597 0.434431C9.17976 0.434431 9.6522 0.426926 10.0966 0.571258C10.2357 0.616451 10.3717 0.672554 10.502 0.738948C10.9182 0.951107 11.2464 1.29099 11.7015 1.74612L12.4978 2.54136H15.3742V3.91169H0.625732V2.54136H3.50218L4.29845 1.74612C4.75358 1.29099 5.08174 0.951107 5.49801 0.738948C5.62831 0.672554 5.76425 0.616451 5.90334 0.571258C6.34776 0.426926 6.82021 0.434431 7.46399 0.434431H8.53597ZM7.46399 1.80476C6.73208 1.80476 6.51641 1.81187 6.32617 1.87369C6.25545 1.89667 6.18668 1.92533 6.12041 1.95907C5.96398 2.03878 5.82348 2.16253 5.44142 2.54136H10.5585C10.1765 2.16253 10.036 2.03878 9.87955 1.95907C9.81329 1.92533 9.74452 1.89667 9.6738 1.87369C9.48356 1.81187 9.26789 1.80476 8.53597 1.80476H7.46399Z";

	function InlineTrashIcon(props) {
		var size = props && typeof props.size === "number" ? props.size : 16;
		return React.createElement("svg", {
			width: size,
			height: size,
			viewBox: "0 0 16 16",
			fill: "none",
			"aria-hidden": "true",
		}, React.createElement("path", { d: INLINE_TRASH_PATH, fill: "currentColor" }));
	}

	var trashIcon = (function () {
		var names = ["IconTrashOutlineRegular", "IconTrashOutlineMedium", "IconTrashOutline16"];
		for (var i = 0; i < names.length; i += 1) {
			var candidate = primitives && primitives[names[i]];
			if (typeof candidate === "function") return candidate;
		}
		return InlineTrashIcon;
	})();

	function SessionDeleteMenuItem(props) {
		var t = typeof props.t === "function" ? props.t : translate;

		// Hooks first, before any early return: the owner unmounts this row with
		// the menu, and a conditional call would desynchronise the order React
		// relies on. `useMenuOpenState` is the hook the SLOT injects — ui-workspace
		// declares `MenuOpenState = readonly [open, setOpen]`.
		var setMenuOpen = null;
		try {
			if (typeof props.useMenuOpenState === "function") {
				var menuState = props.useMenuOpenState();
				if (Array.isArray(menuState) && typeof menuState[1] === "function") setMenuOpen = menuState[1];
			}
		} catch (error) {
			setMenuOpen = null;
		}

		var sessionId = props.sessionId;
		var title = typeof props.displayTitle === "string" && props.displayTitle !== "" ? props.displayTitle : sessionId;
		if (React === null) return null;
		// A row without a Session id cannot be acted on. Rendering nothing is the
		// documented behaviour for an entry whose action does not apply.
		if (typeof sessionId !== "string" || sessionId === "") return null;

		/**
		 * The official row shape, copied from ui-workspace's own
		 * `ArchiveSessionMenuItem`: dismiss the menu this row sits in, then act.
		 * Closing is the ENTRY's job — the owner cannot know a component row was
		 * selected, which is exactly why the slot injects the hook.
		 */
		var select = function () {
			if (setMenuOpen !== null) {
				try {
					setMenuOpen(false);
				} catch (error) { /* the menu may already be gone */ }
			}
			setPending({ sessionId: sessionId, title: String(title) });
		};

		var icon = React.createElement(trashIcon, { size: 14 });
		var label = t("deleteSession");
		var MenuItemButton = primitives && typeof primitives.MenuItemButton === "function" ? primitives.MenuItemButton : null;
		if (MenuItemButton !== null) {
			// `onSelect` — NOT `onClick`. MenuItemButton's contract is
			// { children, shortcut, icon, disabled, danger, separatorBefore, onSelect };
			// an onClick here renders a row that looks right and never fires, which
			// is precisely the bug this line replaced. No `danger`, so the row keeps
			// the shipped rows' colors — set it true for the destructive palette.
			return React.createElement(MenuItemButton, {
				icon: icon,
				separatorBefore: true,
				onSelect: select,
				children: label,
			});
		}
		// Fallback for a host without the primitives: the same role="menuitem"
		// button the list's keyboard walk reads out of the DOM.
		return React.createElement("button", {
			type: "button",
			role: "menuitem",
			className: "dsd-menuitem",
			onClick: select,
		}, React.createElement("span", { className: "dsd-icon", "aria-hidden": "true" }, icon), React.createElement("span", null, label));
	}

	/* ---------------------------- the dialog ---------------------------- */

	function ConfirmDialog() {
		var request = usePending();
		var busyPair = React.useState(false);
		var busy = busyPair[0];
		var setBusy = busyPair[1];
		var errorPair = React.useState(null);
		var error = errorPair[0];
		var setError = errorPair[1];
		var donePair = React.useState(null);
		var done = donePair[0];
		var setDone = donePair[1];
		// Whether the Host reported this Session as loaded in the running process.
		// That is the case whose sidebar row is expected to linger, and the case
		// where the acknowledgement offers a reload.
		var livePair = React.useState(false);
		var wasLive = livePair[0];
		var setWasLive = livePair[1];
		var ref = React.useRef(null);

		React.useEffect(function () {
			var node = ref.current;
			if (node && typeof node.focus === "function") node.focus();
		}, [request === null ? "" : request.sessionId]);

		if (request === null) return null;

		var close = function () {
			if (busy) return;
			setPending(null);
			setError(null);
			setDone(null);
			setWasLive(false);
		};

		/**
		 * The END state's button: acknowledge and close.
		 *
		 * One release tried reloading the page here to shake off the row a
		 * deleted-but-still-loaded Session leaves in the sidebar. Measured: it
		 * does not work — that row lives in the HOST's in-memory session store,
		 * which is rebuilt from disk only at startup — so the reload is gone and
		 * the notice below says when the row actually goes away. A button that
		 * reloads the page and fixes nothing is worse than no button.
		 */
		var finish = function () {
			if (busy) return;
			close();
		};

		// A confirmation, not a menu. "Archive" is the shipped Session-row
		// action's job — the workspace "more" menu already lists archived
		// Sessions — so this dialog offers the one action it owns.
		var runDelete = function () {
			if (busy) return;
			void deleteSessionFlow(request.sessionId, {
				busy: setBusy,
				error: setError,
				done: setDone,
				live: setWasLive,
			});
		};

		// Before the delete: a real "Cancel". After it: a plain acknowledgement.
		// On an error: just "Close".
		var dismissLabel = busy
			? translate("working")
			: done !== null
				? translate("confirm")
				: (error !== null ? translate("close") : translate("cancel"));

		var title = request.title === "" ? request.sessionId : request.title;
		var choices = done === null
			? [
				React.createElement("button", {
					key: "delete",
					type: "button",
					className: "dsd-choice dsd-choice-danger",
					disabled: busy,
					onClick: runDelete,
				},
					React.createElement("strong", null, translate("delete")),
					React.createElement("span", null, translate("confirmBody", title))),
			]
			: null;

		return React.createElement("div", { className: "dsd-mask", onClick: close },
			React.createElement("div", {
				className: "dsd-dialog",
				role: "dialog",
				"aria-modal": "true",
				"aria-label": translate("confirmTitle"),
				tabIndex: -1,
				ref: ref,
				onClick: function (event) { event.stopPropagation(); },
				onKeyDown: function (event) {
					if (event.key === "Escape") close();
				},
			},
				React.createElement("h3", { className: "dsd-title" }, translate("confirmTitle")),
				// The question belongs to the asking state only; after the delete
				// the result paragraph is the whole message.
				done === null && error === null
					&& React.createElement("p", { className: "dsd-body" }, translate("confirmBody", title)),
				choices,
				done !== null && React.createElement("p", { className: "dsd-note", role: "status" }, done),
				// The one thing a successful delete cannot fix: a row the Host is
				// still holding. Announce it plainly instead of offering a button
				// that cannot deliver.
				done !== null && wasLive === true
					&& React.createElement("p", { className: "dsd-warn", role: "status" }, translate("liveNotice")),
				error !== null && React.createElement("p", { className: "dsd-error", role: "alert" }, error),
				React.createElement("div", { className: "dsd-actions" },
					React.createElement("button", {
						type: "button",
						className: done !== null ? "dsd-primary" : "dsd-cancel",
						disabled: busy,
						onClick: finish,
					}, dismissLabel))));
	}

	function ConfirmHost() {
		if (React === null) return null;
		return React.createElement(ConfirmDialog, null);
	}

	/* ------------------------------- apply ------------------------------- */

	// `workspaces` is deliberately absent: this half no longer calls it. The Host
	// half owns the registry work (stop, detach, unarchive) now that the delete
	// is one request, so the browser half only needs the slot system and copy.
	var inject = ["slots", "locale"];

	function apply(ctx) {
		hostCtx = ctx;
		if (React === null) {
			// Without React nothing here can render. Say so once and leave the
			// rest of the host untouched — a thrown error here would be a boot
			// failure for a cosmetic feature.
			try {
				console.error("[dsh-session-delete] React is unavailable; the plugin is inert");
			} catch (error) { /* console may itself be tagged */ }
			return;
		}

		ctx.effect(function () {
			return ctx.locale.register(NS, { zh: zh, en: en });
		}, "dsh-session-delete: dictionaries");

		try {
			boundTranslate = ctx.locale.bind(NS);
		} catch (error) {
			boundTranslate = null;
		}

		installStyles();

		// 1. The menu row. `order: 500` sits after the shipped pin(100) /
		//    rename(200) / fork(300) / archive(400); the package-namespaced id
		//    keeps it beside them instead of replacing one.
		ctx.slots.inject("sidebar.workspaces.session.menu.item", function () {
			return ctx.slots.register({
				name: "sidebar.workspaces.session.menu.item",
				id: "dsh-session-delete",
				order: 500,
				label: function () { return translate("deleteSession"); },
				locale: NS,
				inject: function () { return { t: translate }; },
			}, SessionDeleteMenuItem);
		});

		// 2. The dialog, in the frame-wide overlay rather than inside the menu
		//    row (which unmounts with the menu).
		ctx.slots.inject("shell.overlay", function () {
			return ctx.slots.register({
				name: "shell.overlay",
				id: "dsh-session-delete-confirm",
			}, ConfirmHost);
		});
	}

	exports.name = "dsh-session-delete";
	exports.inject = inject;
	exports.apply = apply;
	/**
	 * Test seam, not plugin surface: the ordered delete sequence with its UI
	 * callbacks injected, so `tools/dry-run.mjs` can drive "probe, then delete"
	 * without a React renderer. Nothing else reads it.
	 */
	exports.__internal = { deleteSessionFlow: deleteSessionFlow };
	return module.exports;
}
});
