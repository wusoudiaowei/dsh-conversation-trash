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
				restoreFailed: "恢复失败"
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
				restoreFailed: "Restore failed"
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
		let state = { request: null, busy: false, error: null, toast: null };

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

			return h(React.Fragment, null, dialog, undoToast);
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
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
