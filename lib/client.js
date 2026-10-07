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
	 * Three registrations, one feature
	 * --------------------------------
	 *   1. sidebar.workspaces.session.menu.item — the "删除会话…" row
	 *   2. shell.overlay                        — the confirmation dialog
	 *   3. settings.section                     — the trash (回收站) page
	 *
	 * (1) and (2) are separated on purpose: a dialog rendered inside a menu
	 * row would be unmounted with the menu. They talk through the tiny store
	 * below, which is module-scoped, so both halves are the same instance.
	 *
	 * The Host half does the file work, reached over its HTTP carrier — see
	 * lib/index.js for why `host.call` is not the channel for a packaged
	 * plugin.
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
		confirmBody: "「{0}」要怎么处理？",
		archive: "归档（隐藏）",
		archiveNote: "等同于菜单里的「归档」：从列表移除，日志仍保留在磁盘上。",
		trash: "移入回收站",
		trashNote: "日志与投影缓存一起移到回收站，可从「设置 → 回收站」还原。",
		cancel: "取消",
		working: "处理中…",
		archived: "已归档（隐藏）。",
		trashed: "已移入回收站。",
		archivedButNotTrashed: "已归档，但没能移入回收站：{0}",
		errorUnknown: "操作失败",
		trashNav: "回收站",
		trashTitle: "会话回收站",
		trashHint: "回收站里的会话不再出现在侧栏，但日志还在磁盘上。还原会把它们放回原来的位置。",
		trashPath: "位置：{0}",
		trashEmpty: "回收站是空的。",
		trashLoading: "正在读取…",
		trashFailed: "读取回收站失败：{0}",
		restore: "还原",
		purge: "彻底清除",
		purgeAll: "清空回收站",
		purgeConfirm: "再点一次确认清空",
		purgePurgeConfirm: "再点一次确认清除",
		purgeNote: "彻底清除是唯一不可撤销的一步：文件会被真正删除。",
		restored: "已还原：{0}",
		purged: "已清除 {0} 项。",
		needHostHalf: "宿主半体不可用（没有 HTTP 载体），无法移入回收站。",
		needArchiveApi: "官方归档接口不可用，无法归档。",
		refresh: "刷新",
	};

	var en = {
		deleteSession: "Delete session…",
		confirmTitle: "Delete session",
		confirmBody: "What should happen to \u201c{0}\u201d?",
		archive: "Archive (hide)",
		archiveNote: "Same as “Archive” in the menu: gone from the list, log still on disk.",
		trash: "Move to trash",
		trashNote: "Log and projection cache move to the trash; restore from Settings → Trash.",
		cancel: "Cancel",
		working: "Working…",
		archived: "Archived (hidden).",
		trashed: "Moved to the trash.",
		archivedButNotTrashed: "Archived, but moving to the trash failed: {0}",
		errorUnknown: "The operation failed",
		trashNav: "Trash",
		trashTitle: "Session trash",
		trashHint: "Trashed sessions no longer appear in the sidebar, but their logs are still on disk. Restore puts them back where they were.",
		trashPath: "Location: {0}",
		trashEmpty: "The trash is empty.",
		trashLoading: "Loading…",
		trashFailed: "Could not read the trash: {0}",
		restore: "Restore",
		purge: "Delete permanently",
		purgeAll: "Empty the trash",
		purgeConfirm: "Click again to empty",
		purgePurgeConfirm: "Click again to delete",
		purgeNote: "Deleting permanently is the one step that cannot be undone: the bytes are unlinked.",
		restored: "Restored: {0}",
		purged: "Removed {0} item(s).",
		needHostHalf: "The Host half is unavailable (no HTTP carrier), so nothing can be moved to the trash.",
		needArchiveApi: "The official archive API is unavailable, so the session cannot be archived.",
		refresh: "Refresh",
	};

	var CSS = [
		".dsd-menuitem{display:flex;align-items:center;gap:8px;width:100%;box-sizing:border-box;padding:0 10px;height:32px;border:none;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:20px;text-align:left;border-radius:6px;cursor:pointer}",
		".dsd-menuitem:hover,.dsd-menuitem:focus-visible{background:var(--dsw-alias-interactive-bg-hover);outline:none}",
		".dsd-menuitem .dsd-dot{width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-state-error-primary);opacity:.85;flex:none}",
		".dsd-mask{position:fixed;inset:0;z-index:1000;background:rgba(0,0,0,.35);display:flex;align-items:center;justify-content:center}",
		".dsd-dialog{box-sizing:border-box;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l2);border-radius:12px;box-shadow:var(--dsw-shadow-lv2);width:400px;max-width:92vw;max-height:86vh;overflow:auto;padding:20px}",
		".dsd-title{margin:0 0 6px;color:var(--dsw-alias-label-primary);font-size:16px;font-weight:600;line-height:24px}",
		".dsd-body{margin:0 0 14px;color:var(--dsw-alias-label-secondary);font-size:13px;line-height:20px;word-break:break-word}",
		".dsd-choices{display:flex;flex-direction:column;gap:8px;margin:0 0 14px}",
		".dsd-choice{display:block;width:100%;box-sizing:border-box;text-align:left;padding:10px 12px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:20px;cursor:pointer}",
		".dsd-choice:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}",
		".dsd-choice strong{display:block;font-weight:600;margin-bottom:2px}",
		".dsd-choice span{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}",
		".dsd-choice-danger strong{color:var(--dsw-alias-state-error-primary)}",
		".dsd-error{color:var(--dsw-alias-state-error-primary);margin:10px 0 0;font-size:12px;line-height:18px;word-break:break-word}",
		".dsd-note{margin:10px 0 0;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}",
		".dsd-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:16px}",
		".dsd-cancel{height:32px;border-radius:8px;padding:0 14px;font:inherit;font-size:13px;font-weight:500;color:var(--dsw-alias-label-primary);background:transparent;border:1px solid var(--dsw-alias-border-l2);cursor:pointer}",
		".dsd-cancel:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}",
		".dsd-cancel:disabled{opacity:.6;cursor:default}",
		".dsd-page{display:flex;flex-direction:column;gap:12px;padding:4px 0}",
		".dsd-row{display:flex;align-items:center;gap:10px;justify-content:space-between;padding:10px 12px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px}",
		".dsd-row-main{min-width:0}",
		".dsd-row-id{margin:0;color:var(--dsw-alias-label-primary);font-size:13px;line-height:20px;word-break:break-all}",
		".dsd-row-meta{margin:2px 0 0;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}",
		".dsd-row-actions{display:flex;gap:6px;flex:none}",
		".dsd-small{height:28px;border-radius:6px;padding:0 10px;font:inherit;font-size:12px;font-weight:500;color:var(--dsw-alias-label-primary);background:transparent;border:1px solid var(--dsw-alias-border-l2);cursor:pointer}",
		".dsd-small:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}",
		".dsd-small-danger{color:var(--dsw-alias-state-error-primary)}",
		".dsd-small:disabled{opacity:.6;cursor:default}",
		".dsd-toolbar{display:flex;justify-content:space-between;align-items:center;gap:8px}",
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
			throw new Error(data && data.error ? String(data.error) : "HTTP " + String(response.status));
		}
		return data;
	}

	var withHost = (payload) => rpc("POST", "/dsh-session-delete/trash", payload);
	var listTrash = () => rpc("GET", "/dsh-session-delete/trash");
	var restoreFromTrash = (entry) => rpc("POST", "/dsh-session-delete/trash/restore", { entry: entry });
	var purgeTrash = (entry) => rpc("POST", "/dsh-session-delete/trash/purge", entry === undefined ? { confirm: true } : { confirm: true, entry: entry });

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

	/** The official archive call, with the option that stops a live agent. */
	function archiveSession(sessionId) {
		var workspaces = hostCtx === null ? null : hostCtx.workspaces;
		if (workspaces === undefined || workspaces === null || typeof workspaces.archiveSession !== "function") {
			throw new Error(translate("needArchiveApi"));
		}
		return workspaces.archiveSession(sessionId, { stopActivity: true });
	}

	function unarchiveSession(sessionId) {
		try {
			var workspaces = hostCtx === null ? null : hostCtx.workspaces;
			if (workspaces && typeof workspaces.unarchiveSession === "function") return workspaces.unarchiveSession(sessionId);
		} catch (error) { /* the registry entry is the host's business */ }
		return Promise.resolve();
	}

	/* ---------------------------- menu row ---------------------------- */

	function SessionDeleteMenuItem(props) {
		var t = typeof props.t === "function" ? props.t : translate;
		var sessionId = props.sessionId;
		var title = typeof props.displayTitle === "string" && props.displayTitle !== "" ? props.displayTitle : sessionId;

		// A row without a Session id cannot be acted on. Rendering nothing is
		// the documented behaviour for an entry whose action does not apply.
		if (typeof sessionId !== "string" || sessionId === "") return null;
		if (React === null) return null;

		var open = function (event) {
			if (event && typeof event.stopPropagation === "function") event.stopPropagation();
			setPending({ sessionId: sessionId, title: String(title) });
		};

		var MenuItemButton = primitives && typeof primitives.MenuItemButton === "function" ? primitives.MenuItemButton : null;
		var label = t("deleteSession");
		if (MenuItemButton !== null) {
			return React.createElement(MenuItemButton, {
				role: "menuitem",
				separatorBefore: true,
				className: "dsd-menuitem",
				onClick: open,
			}, label);
		}
		return React.createElement("button", {
			type: "button",
			role: "menuitem",
			className: "dsd-menuitem",
			onClick: open,
		}, React.createElement("span", { className: "dsd-dot", "aria-hidden": "true" }), React.createElement("span", null, label));
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
		};

		var run = async function (action) {
			if (busy) return;
			setBusy(true);
			setError(null);
			try {
				if (action === "archive") {
					await archiveSession(request.sessionId);
					setDone(translate("archived"));
					return;
				}
				await archiveSession(request.sessionId);
				try {
					await withHost({ sessionId: request.sessionId });
					setDone(translate("trashed"));
				} catch (trashError) {
					// The archive half already took effect, so say exactly that
					// rather than reporting a failure that did not happen.
					setError(translate("archivedButNotTrashed", String(trashError && trashError.message ? trashError.message : trashError)));
				}
			} catch (failure) {
				setError(String(failure && failure.message ? failure.message : failure) || translate("errorUnknown"));
			} finally {
				setBusy(false);
			}
		};

		var title = request.title === "" ? request.sessionId : request.title;
		var choices = done === null
			? [
				React.createElement("button", {
					key: "archive",
					type: "button",
					className: "dsd-choice",
					disabled: busy,
					onClick: function () { void run("archive"); },
				},
					React.createElement("strong", null, translate("archive")),
					React.createElement("span", null, translate("archiveNote"))),
				React.createElement("button", {
					key: "trash",
					type: "button",
					className: "dsd-choice dsd-choice-danger",
					disabled: busy,
					onClick: function () { void run("trash"); },
				},
					React.createElement("strong", null, translate("trash")),
					React.createElement("span", null, translate("trashNote"))),
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
				React.createElement("p", { className: "dsd-body" }, translate("confirmBody", title)),
				choices,
				done !== null && React.createElement("p", { className: "dsd-note", role: "status" }, done),
				error !== null && React.createElement("p", { className: "dsd-error", role: "alert" }, error),
				React.createElement("div", { className: "dsd-actions" },
					React.createElement("button", {
						type: "button",
						className: "dsd-cancel",
						disabled: busy,
						onClick: close,
					}, busy ? translate("working") : translate("cancel")))));
	}

	function ConfirmHost() {
		if (React === null) return null;
		return React.createElement(ConfirmDialog, null);
	}

	/* ---------------------------- trash page ---------------------------- */

	/**
	 * The 回收站 page.
	 *
	 * Reading is a plain GET; restoring re-registers the Session through the
	 * official unarchive call so the sidebar row comes back; the only
	 * irreversible button is the one that asks twice.
	 */
	function TrashSettingsPage(props) {
		var t = typeof props.t === "function" ? props.t : translate;
		var entriesPair = React.useState(null);
		var entries = entriesPair[0];
		var setEntries = entriesPair[1];
		var rootPair = React.useState("");
		var root = rootPair[0];
		var setRoot = rootPair[1];
		var errorPair = React.useState(null);
		var error = errorPair[0];
		var setError = errorPair[1];
		var notePair = React.useState(null);
		var note = notePair[0];
		var setNote = notePair[1];
		var armedPair = React.useState(null);
		var armed = armedPair[0];
		var setArmed = armedPair[1];
		var busyPair = React.useState(false);
		var busy = busyPair[0];
		var setBusy = busyPair[1];

		var load = React.useCallback(function () {
			setError(null);
			return listTrash().then(function (data) {
				setEntries(Array.isArray(data && data.entries) ? data.entries : []);
				setRoot(data && typeof data.root === "string" ? data.root : "");
			}).catch(function (failure) {
				setEntries([]);
				setError(String(failure && failure.message ? failure.message : failure));
			});
		}, []);

		React.useEffect(function () {
			void load();
		}, [load]);

		var act = function (work) {
			if (busy) return;
			setBusy(true);
			setError(null);
			Promise.resolve().then(work).catch(function (failure) {
				setError(String(failure && failure.message ? failure.message : failure));
			}).then(function () {
				setBusy(false);
				setArmed(null);
				return load();
			});
		};

		var body = [];
		body.push(React.createElement("p", { className: "dsd-body", key: "hint" }, t("trashHint")));
		if (root !== "") body.push(React.createElement("p", { className: "dsd-note", key: "path" }, t("trashPath", root)));
		if (error !== null) body.push(React.createElement("p", { className: "dsd-error", key: "error", role: "alert" }, t("trashFailed", error)));
		if (note !== null) body.push(React.createElement("p", { className: "dsd-note", key: "note", role: "status" }, note));

		if (entries === null) {
			body.push(React.createElement("p", { className: "dsd-note", key: "loading" }, t("trashLoading")));
		} else if (entries.length === 0) {
			body.push(React.createElement("p", { className: "dsd-note", key: "empty" }, t("trashEmpty")));
		} else {
			entries.forEach(function (item) {
				var id = String(item.sessionId || item.entry);
				var meta = [];
				if (item.movedAt) meta.push(String(item.movedAt));
				if (item.project) meta.push(String(item.project));
				body.push(React.createElement("div", { className: "dsd-row", key: item.entry },
					React.createElement("div", { className: "dsd-row-main" },
						React.createElement("p", { className: "dsd-row-id" }, id),
						meta.length > 0 && React.createElement("p", { className: "dsd-row-meta" }, meta.join(" · "))),
					React.createElement("div", { className: "dsd-row-actions" },
						React.createElement("button", {
							type: "button",
							className: "dsd-small",
							disabled: busy,
							onClick: function () {
								act(async function () {
									await restoreFromTrash(item.entry);
									await unarchiveSession(id);
									setNote(t("restored", id));
								});
							},
						}, t("restore")),
						React.createElement("button", {
							type: "button",
							className: "dsd-small dsd-small-danger",
							disabled: busy,
							onClick: function () {
								if (armed !== item.entry) {
									setArmed(item.entry);
									return;
								}
								act(async function () {
									var result = await purgeTrash(item.entry);
									setNote(t("purged", String(result && result.removed !== undefined ? result.removed : 1)));
								});
							},
						}, armed === item.entry ? t("purgePurgeConfirm") : t("purge")))));
			});
		}

		body.push(React.createElement("div", { className: "dsd-toolbar", key: "toolbar" },
			React.createElement("button", {
				type: "button",
				className: "dsd-small",
				disabled: busy,
				onClick: function () { void load(); },
			}, t("refresh")),
			React.createElement("button", {
				type: "button",
				className: "dsd-small dsd-small-danger",
				disabled: busy || entries === null || entries.length === 0,
				onClick: function () {
					if (armed !== "*") {
						setArmed("*");
						return;
					}
					act(async function () {
						var result = await purgeTrash(undefined);
						setNote(t("purged", String(result && result.removed !== undefined ? result.removed : 0)));
					});
				},
			}, armed === "*" ? t("purgeConfirm") : t("purgeAll"))));
		body.push(React.createElement("p", { className: "dsd-note", key: "purgeNote" }, t("purgeNote")));

		return React.createElement("div", { className: "dsd-page" },
			React.createElement("h3", { className: "dsd-title" }, t("trashTitle")),
			body);
	}

	/* ------------------------------- apply ------------------------------- */

	var inject = ["slots", "locale", "workspaces"];

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

		// 3. The trash page, as its own settings section.
		ctx.slots.inject("settings.section", function () {
			return ctx.slots.register({
				name: "settings.section",
				id: "dsh-session-delete",
				order: 60,
				label: function () { return translate("trashNav"); },
				locale: NS,
				inject: function () { return { t: translate }; },
			}, TrashSettingsPage);
		});
	}

	exports.name = "dsh-session-delete";
	exports.inject = inject;
	exports.apply = apply;
	return module.exports;
}
});
