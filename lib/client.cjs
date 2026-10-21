/**
 * dsh-conversation-trash — browser half.
 *
 * Registers one `sidebar.workspaces.session.menu.item` row ("删除对话") and one
 * `shell.overlay` seat that owns the confirmation dialog and the undo toast.
 * All data work happens on the host through `/dsh-conversation-trash/*`; this file
 * only renders and posts.
 */
window.__ModuleLoader__.load({
	id: "dsh-conversation-trash",
	factory: (require) => {
		"use strict";
		var module = { exports: {} };
		var exports = module.exports;

		const reactNs = require("react");
		const React = reactNs.default ?? reactNs;
		const primitivesNs = require("@deepseek-ai/dsh-client-ui-primitives");
		const P = primitivesNs.default ?? primitivesNs;
		const pick = (name) => P[name] ?? primitivesNs[name] ?? primitivesNs.default?.[name];
		const MenuItemButton = pick("MenuItemButton");
		const Modal = pick("Modal");
		const Button = pick("Button");
		const Toast = pick("Toast");
		const IconTrashOutlineRegular = pick("IconTrashOutlineRegular");
		const h = React.createElement;

		const BASE = "/dsh-conversation-trash";
		const UNDO_HOLD_MS = 8000;
		const chinese = (navigator.language || "en").toLowerCase().startsWith("zh");

		/** One label table keeps both languages in this single file. */
		const TEXT = {
			zh: {
				menu: "删除对话",
				title: "删除此对话？",
				desc: "「{title}」将从列表中移除，并移入回收站。",
				descChildren: "同时会删除它们的 {count} 个子代理会话。",
				descRunning: "正在运行的工作会先被停止，删除后不会自动继续。",
				badgeRecycle: "可在 8 秒内撤销；之后可在回收站中恢复或彻底删除。",
				childrenLabel: "子代理会话",
				cancel: "取消",
				confirm: "移入回收站",
				deleting: "正在删除…",
				deleted: "已删除「{title}」",
				deferred: "已标记删除「{title}」，日志将在下次启动 DSH 时移走",
				restored: "已恢复「{title}」",
				undo: "撤销",
				failed: "删除失败",
				restoreFailed: "恢复失败",
				trashTitle: "回收站",
				trashEmpty: "回收站是空的",
				trashLoading: "正在读取回收站…",
				trashRestore: "恢复",
				trashPurge: "彻底删除",
				trashPurgeAll: "清空回收站",
				trashConfirmAll: "确认清空？",
				trashClose: "关闭",
				trashRestored: "已恢复「{title}」",
				trashPurged: "已彻底删除「{title}」",
				trashCount: "回收站里有 {count} 项",
				trashDeletedAt: "删除于 {when}",
				trashRestoreFailed: "恢复失败",
				trashPurgeFailed: "彻底删除失败",
				trashAria: "回收站，{count} 项"
			},
			en: {
				menu: "Delete conversation",
				title: "Delete this conversation?",
				desc: "\u201c{title}\u201d moves out of the list and into the trash.",
				descChildren: "Its {count} subagent sessions are deleted with it.",
				descRunning: "Running work is stopped first and does not resume afterwards.",
				badgeRecycle: "Undo within 8 seconds, or restore/purge it from the trash later.",
				childrenLabel: "Subagent sessions",
				cancel: "Cancel",
				confirm: "Move to trash",
				deleting: "Deleting…",
				deleted: "Deleted \u201c{title}\u201d",
				deferred: "Marked \u201c{title}\u201d for deletion; its logs move on the next DSH start",
				restored: "Restored \u201c{title}\u201d",
				undo: "Undo",
				failed: "Delete failed",
				restoreFailed: "Restore failed",
				trashTitle: "Recycle bin",
				trashEmpty: "The recycle bin is empty",
				trashLoading: "Reading the recycle bin…",
				trashRestore: "Restore",
				trashPurge: "Delete forever",
				trashPurgeAll: "Empty the bin",
				trashConfirmAll: "Confirm empty?",
				trashClose: "Close",
				trashRestored: "Restored \u201c{title}\u201d",
				trashPurged: "Deleted \u201c{title}\u201d forever",
				trashCount: "{count} item(s) in the bin",
				trashDeletedAt: "deleted {when}",
				trashRestoreFailed: "Restore failed",
				trashPurgeFailed: "Permanent delete failed",
				trashAria: "Recycle bin, {count} item(s)"
			}
		};

		function t(key, vars) {
			const table = chinese ? TEXT.zh : TEXT.en;
			const template = table[key] ?? key;
			return vars === undefined ? template : template.replace(/\{(\w+)\}/g, (_, name) => String(vars[name] ?? ""));
		}

		/* ------------------------------------------------------------------ */
		/* Store                                                              */
		/* ------------------------------------------------------------------ */

		const listeners = new Set();
		let state = { request: null, busy: false, error: null, toast: null, trash: { open: false, entries: [], loading: false, error: null, confirmAll: false } };

		function update(patch) {
			state = { ...state, ...patch };
			for (const listener of listeners) listener(state);
		}

		function subscribe(listener) {
			listeners.add(listener);
			listener(state);
			return () => {
				listeners.delete(listener);
			};
		}

		async function post(path, body) {
			const response = await fetch(`${BASE}${path}`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(body ?? {})
			});
			let payload;
			try {
				payload = await response.json();
			} catch {
				payload = {};
			}
			if (!response.ok) throw new Error(payload?.error ?? `HTTP ${String(response.status)}`);
			return payload;
		}

		/** Ask the host what a delete would touch, then open the dialog. */
		function requestDelete(sessionId, displayTitle) {
			update({ request: { sessionId, displayTitle, children: [], loading: true }, busy: false, error: null });
			post("/preview", { sessionId })
				.then((preview) => {
					if (state.request?.sessionId !== sessionId) return;
					update({
						request: {
							sessionId,
							displayTitle: preview?.title || displayTitle || "",
							children: Array.isArray(preview?.children) ? preview.children : [],
							loading: false
						}
					});
				})
				.catch(() => {
					if (state.request?.sessionId !== sessionId) return;
					update({ request: { sessionId, displayTitle, children: [], loading: false } });
				});
		}

		function closeDialog() {
			if (state.busy) return;
			update({ request: null, error: null });
		}

		async function confirmDelete() {
			const request = state.request;
			if (request === null || state.busy) return;
			update({ busy: true, error: null });
			try {
				const result = await post("/delete", { sessionId: request.sessionId, displayTitle: request.displayTitle });
				// `moved: false` means the host archived the row but could not move
				// the logs yet (locked file, missing directory). Say so instead of
				// claiming a clean delete -- the startup sweep finishes it later.
				const deferred = result?.moved === false;
				update({
					busy: false,
					request: null,
					toast: {
						id: request.sessionId,
						title: request.displayTitle,
						text: deferred
							? t("deferred", { title: request.displayTitle || request.sessionId })
							: t("deleted", { title: request.displayTitle || request.sessionId }),
						kind: "deleted"
					}
				});
			} catch (error) {
				update({ busy: false, error: `${t("failed")}：${error instanceof Error ? error.message : String(error)}` });
			}
		}

		async function undo(sessionId, title) {
			try {
				await post("/restore", { sessionId });
				update({ toast: { id: sessionId, title, text: t("restored", { title: title || sessionId }), kind: "restored" } });
			} catch (error) {
				update({ error: `${t("restoreFailed")}：${error instanceof Error ? error.message : String(error)}` });
			}
		}

		/* ------------------------------------------------------------------ */
		/* Recycle bin                                                        */
		/* ------------------------------------------------------------------ */

		function formatBytes(bytes) {
			const n = Number(bytes) || 0;
			if (n < 1024) return `${String(n)} B`;
			const kb = n / 1024;
			if (kb < 1024) return `${kb.toFixed(kb < 10 ? 1 : 0)} KB`;
			return `${(kb / 1024).toFixed(1)} MB`;
		}

		function formatWhen(ms) {
			try {
				return new Date(Number(ms) || Date.now()).toLocaleString();
			} catch {
				return "";
			}
		}

		async function loadTrash() {
			update({ trash: { ...state.trash, loading: true, error: null } });
			try {
				const response = await fetch(`${BASE}/list`);
				if (!response.ok) throw new Error(`HTTP ${String(response.status)}`);
				const payload = await response.json();
				update({
					trash: {
						...state.trash,
						loading: false,
						error: null,
						entries: Array.isArray(payload?.entries) ? payload.entries : []
					}
				});
			} catch (error) {
				update({ trash: { ...state.trash, loading: false, error: error instanceof Error ? error.message : String(error) } });
			}
		}

		function openTrash() {
			update({ trash: { ...state.trash, open: true, confirmAll: false } });
			loadTrash();
		}

		function closeTrash() {
			update({ trash: { ...state.trash, open: false, confirmAll: false } });
		}

		async function restoreFromTrash(entry) {
			try {
				await post("/restore", { sessionId: entry.id });
				update({
					trash: { ...state.trash, confirmAll: false },
					toast: { id: entry.id, title: entry.title, text: t("trashRestored", { title: entry.title || entry.id }), kind: "restored" }
				});
				await loadTrash();
			} catch (error) {
				update({ trash: { ...state.trash, error: error instanceof Error ? error.message : String(error) } });
			}
		}

		async function purgeFromTrash(entry) {
			try {
				await post("/purge", { sessionId: entry.id });
				update({
					trash: { ...state.trash, confirmAll: false },
					toast: { id: entry.id, title: entry.title, text: t("trashPurged", { title: entry.title || entry.id }), kind: "restored" }
				});
				await loadTrash();
			} catch (error) {
				update({ trash: { ...state.trash, error: error instanceof Error ? error.message : String(error) } });
			}
		}

		async function purgeAllTrash() {
			if (state.trash.confirmAll !== true) {
				update({ trash: { ...state.trash, confirmAll: true } });
				return;
			}
			try {
				await post("/purge-all", {});
				update({ trash: { ...state.trash, confirmAll: false } });
				await loadTrash();
			} catch (error) {
				update({ trash: { ...state.trash, confirmAll: false, error: error instanceof Error ? error.message : String(error) } });
			}
		}

		/* ------------------------------------------------------------------ */
		/* Menu row                                                           */
		/* ------------------------------------------------------------------ */

		function DeleteMenuItem(props) {
			const sessionId = props.sessionId;
			const displayTitle = props.displayTitle;
			let closeMenu;
			try {
				if (typeof props.useMenuOpenState === "function") closeMenu = props.useMenuOpenState()[1];
			} catch {
				closeMenu = undefined;
			}
			return h(
				MenuItemButton,
				{
					danger: true,
					icon: h(IconTrashOutlineRegular, { size: 14 }),
					onSelect: () => {
						if (typeof closeMenu === "function") closeMenu(false);
						requestDelete(sessionId, displayTitle);
					}
				},
				t("menu")
			);
		}

		/* ------------------------------------------------------------------ */
		/* Overlay: dialog + toast                                            */
		/* ------------------------------------------------------------------ */

		function Overlay() {
			const [snapshot, setSnapshot] = React.useState(state);
			React.useEffect(() => subscribe(setSnapshot), []);

			const request = snapshot.request;
			const toast = snapshot.toast;

			const dialog =
				request === null
					? null
					: h(
							Modal,
							{
								open: true,
								onClose: closeDialog,
								closeLabel: t("cancel"),
								title: t("title"),
								footer: h(
									"div",
									{ style: { display: "flex", justifyContent: "flex-end", gap: 8 } },
									h(Button, { variant: "outline", disabled: snapshot.busy, onClick: closeDialog }, t("cancel")),
									h(
										Button,
										{
											variant: "outline",
											disabled: snapshot.busy,
											style: { color: "var(--dsw-alias-state-error-primary, #d93025)" },
											onClick: confirmDelete
										},
										t("confirm")
									)
								)
							},
							h(
								"div",
								{ style: { display: "grid", gap: 12, minWidth: 320 } },
								h("p", { style: { margin: 0 } }, t("desc", { title: request.displayTitle || request.sessionId })),
								request.children.length > 0
									? h("p", { style: { margin: 0, opacity: 0.85 } }, t("descChildren", { count: request.children.length }))
									: null,
								h("p", { style: { margin: 0, opacity: 0.75 } }, t("descRunning")),
								h("p", { style: { margin: 0, opacity: 0.6, fontSize: 12 } }, t("badgeRecycle")),
								snapshot.busy ? h("p", { style: { margin: 0, opacity: 0.7 }, role: "status" }, t("deleting")) : null,
								snapshot.error !== null
									? h("p", { style: { margin: 0, color: "var(--dsw-alias-state-error-primary, #d93025)" }, role: "alert" }, snapshot.error)
									: null
							)
						);

			const undoToast =
				toast === null
					? null
					: h(Toast, {
							text: toast.text,
							tone: toast.kind === "deleted" ? "default" : "success",
							holdMs: UNDO_HOLD_MS,
							actions: toast.kind === "deleted" ? [{ label: t("undo"), onClick: () => undo(toast.id, toast.title) }] : [],
							onDone: () => {
								if (state.toast === toast) update({ toast: null });
							}
						});

			const trash = snapshot.trash;
			const trashPanel = !trash.open
				? null
				: h(
						Modal,
						{
							open: true,
							onClose: closeTrash,
							closeLabel: t("trashClose"),
							title: t("trashTitle"),
							footer: h(
								"div",
								{ style: { display: "flex", justifyContent: "space-between", gap: 8, width: "100%", alignItems: "center" } },
								h("span", { style: { opacity: 0.65, fontSize: 12 } }, t("trashCount", { count: trash.entries.length })),
								h(
									"div",
									{ style: { display: "flex", gap: 8 } },
									trash.entries.length > 0
										? h(
												Button,
												{
													variant: "outline",
													style: { color: "var(--dsw-alias-state-error-primary, #d93025)" },
													onClick: purgeAllTrash
												},
												t(trash.confirmAll ? "trashConfirmAll" : "trashPurgeAll")
											)
										: null,
									h(Button, { variant: "outline", onClick: closeTrash }, t("trashClose"))
								)
							)
						},
						h(
							"div",
							{ style: { display: "grid", gap: 2, minWidth: 380, maxHeight: 360, overflowY: "auto" } },
							trash.loading && trash.entries.length === 0
								? h("p", { style: { margin: 0, opacity: 0.7 }, role: "status" }, t("trashLoading"))
								: null,
							!trash.loading && trash.entries.length === 0
								? h("p", { style: { margin: 0, opacity: 0.7 } }, t("trashEmpty"))
								: null,
							trash.entries.map((entry) =>
								h(
									"div",
									{ key: entry.id, className: "dsh-ct-row" },
									h(
										"div",
										{ style: { minWidth: 0, flex: 1 } },
										h("div", { className: "dsh-ct-title", title: entry.id }, entry.title || entry.id),
										h("div", { className: "dsh-ct-meta" }, `${formatBytes(entry.size)} · ${t("trashDeletedAt", { when: formatWhen(entry.deletedAt) })}`)
									),
									h("button", { type: "button", className: "dsh-ct-action", onClick: () => restoreFromTrash(entry) }, t("trashRestore")),
									h("button", { type: "button", className: "dsh-ct-action dsh-ct-danger", onClick: () => purgeFromTrash(entry) }, t("trashPurge"))
								)
							),
							trash.error !== null
								? h("p", { style: { margin: 0, color: "var(--dsw-alias-state-error-primary, #d93025)" }, role: "alert" }, trash.error)
								: null
						)
					);

			return h(React.Fragment, null, dialog, trashPanel, undoToast);
		}

		/* ------------------------------------------------------------------ */
		/* Sidebar footer button                                              */
		/* ------------------------------------------------------------------ */

		const STYLE_ID = "dsh-conversation-trash";

		function ensureStyle() {
			if (typeof document === "undefined") return;
			if (document.querySelector(`style[data-plugin="${STYLE_ID}"]`) !== null) return;
			const tag = document.createElement("style");
			tag.dataset.plugin = STYLE_ID;
			tag.textContent = [
				".dsh-ct-footer{position:relative;display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;padding:0;border:0;border-radius:8px;background:transparent;color:inherit;cursor:pointer}",
				".dsh-ct-footer:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.16))}",
				".dsh-ct-badge{position:absolute;top:0;right:0;min-width:14px;height:14px;padding:0 3px;border-radius:7px;background:var(--dsw-alias-state-business-primary,#4d6bfe);color:#fff;font-size:10px;font-weight:600;line-height:14px;text-align:center}",
				".dsh-ct-row{display:flex;align-items:center;gap:8px;padding:8px 2px;border-bottom:1px solid var(--dsw-alias-separator,rgba(127,127,127,.2))}",
				".dsh-ct-row:last-of-type{border-bottom:0}",
				".dsh-ct-title{font-size:13px;line-height:18px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
				".dsh-ct-meta{font-size:11px;line-height:16px;opacity:.6}",
				".dsh-ct-action{border:1px solid var(--dsw-alias-separator,rgba(127,127,127,.3));background:transparent;color:inherit;border-radius:6px;padding:3px 8px;font-size:12px;line-height:16px;cursor:pointer;white-space:nowrap}",
				".dsh-ct-action:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.16))}",
				".dsh-ct-danger{color:var(--dsw-alias-state-error-primary,#d93025)}"
			].join("");
			document.head.appendChild(tag);
		}

		function TrashFooterAction() {
			const [snapshot, setSnapshot] = React.useState(state);
			React.useEffect(() => subscribe(setSnapshot), []);
			React.useEffect(() => {
				loadTrash();
			}, []);
			const count = snapshot.trash.entries.length;
			return h(
				"button",
				{
					type: "button",
					className: "dsh-ct-footer",
					title: t("trashTitle"),
					"aria-label": count > 0 ? t("trashAria", { count }) : t("trashTitle"),
					onClick: openTrash
				},
				h(IconTrashOutlineRegular, { size: 16 }),
				count > 0 ? h("span", { className: "dsh-ct-badge" }, count > 99 ? "99+" : String(count)) : null
			);
		}

		/* ------------------------------------------------------------------ */
		/* Plugin                                                             */
		/* ------------------------------------------------------------------ */

		const inject = ["slots"];

		function apply(ctx) {
			const slots = ctx.slots;
			if (slots === undefined) return;
			// Each seat is independent: a layout without one slot must not cost the other.
			try {
				ctx.slots.inject("sidebar.workspaces.session.menu.item", function* () {
					yield slots.register({ name: "sidebar.workspaces.session.menu.item", id: "trash-delete", order: 500 }, DeleteMenuItem);
				});
			} catch (error) {
				console.warn("[session-trash] session menu slot unavailable:", error);
			}
			try {
				ctx.slots.inject("shell.overlay", function* () {
					yield slots.register({ name: "shell.overlay", id: "session-trash-overlay" }, Overlay);
				});
			} catch (error) {
				console.warn("[session-trash] overlay slot unavailable:", error);
			}
			try {
				ensureStyle();
				ctx.slots.inject("sidebar.footer.action", function* () {
					yield slots.register({ name: "sidebar.footer.action", id: "conversation-trash", order: 100 }, TrashFooterAction);
				});
			} catch (error) {
				console.warn("[session-trash] sidebar footer slot unavailable:", error);
			}
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
