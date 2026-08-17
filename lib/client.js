window.__ModuleLoader__.load({
  id: "dsh-session-delete",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    var React = require("react");

    // 垃圾桶图标（与产品内置 IconTrashOutline16 相同路径）
    const TRASH_PATH = "M14.4782 4.84067L14.2138 10.1152C14.1102 12.1872 14.067 13.0115 13.3866 13.9607C13.1044 14.3546 12.7498 14.6912 12.3424 14.9535C11.8239 15.2872 11.2415 15.4316 10.5585 15.4998C9.88727 15.5668 9.04946 15.5656 7.99998 15.5656C6.95051 15.5656 6.1127 15.5668 5.44142 15.4998C4.75851 15.4316 4.17602 15.2872 3.65753 14.9535C3.25012 14.6912 2.89559 14.3546 2.61332 13.9607C1.93296 13.0115 1.88979 12.1872 1.78619 10.1152L1.52179 4.84067L2.89006 4.77277L3.15343 10.0463C3.26221 12.2218 3.32452 12.6015 3.72646 13.1624C3.90825 13.4161 4.13686 13.6334 4.39927 13.8023C4.66204 13.9714 5.00263 14.0792 5.57825 14.1367C6.16562 14.1953 6.92298 14.1963 7.99998 14.1963C9.07699 14.1963 9.83434 14.1953 10.4217 14.1367C10.9973 14.0792 11.3379 13.9714 11.6007 13.8023C11.8631 13.6334 12.0917 13.4161 12.2735 13.1624C12.6755 12.6015 12.7378 12.2218 12.8465 10.0463L13.1099 4.77277L14.4782 4.84067ZM5.43011 6.22849H6.7994V11.3909H5.43011V6.22849ZM9.20056 6.22849H10.5699V11.3909H9.20056V6.22849ZM8.53597 0.434431C9.17976 0.434431 9.6522 0.426926 10.0966 0.571258C10.2357 0.616451 10.3717 0.672554 10.502 0.738948C10.9182 0.951107 11.2464 1.29099 11.7015 1.74612L12.4978 2.54136H15.3742V3.91169H0.625732V2.54136H3.50218L4.29845 1.74612C4.75358 1.29099 5.08174 0.951107 5.49801 0.738948C5.62831 0.672554 5.76425 0.616451 5.90334 0.571258C6.34776 0.426926 6.82021 0.434431 7.46399 0.434431H8.53597ZM7.46399 1.80476C6.73208 1.80476 6.51641 1.81187 6.32617 1.87369C6.25545 1.89667 6.18668 1.92533 6.12041 1.95907C5.96398 2.03878 5.82348 2.16253 5.44142 2.54136H10.5585C10.1765 2.16253 10.036 2.03878 9.87955 1.95907C9.81329 1.92533 9.74452 1.89667 9.6738 1.87369C9.48356 1.81187 9.26789 1.80476 8.53597 1.80476H7.46399Z";

    const NS = "session-delete";

    const zh = {
      deleteSession: "删除会话",
      confirmTitle: "删除会话",
      confirmBody: "确定要删除这个会话吗？删除后它将从列表中移除，此操作无法撤销。",
      cancel: "取消",
      confirm: "删除",
      deleting: "正在删除…",
      errorUnknown: "删除失败",
    };
    const en = {
      deleteSession: "Delete session",
      confirmTitle: "Delete session",
      confirmBody: "Delete this session? It will be removed from the list. This cannot be undone.",
      cancel: "Cancel",
      confirm: "Delete",
      deleting: "Deleting…",
      errorUnknown: "Delete failed",
    };

    const CSS = `
.dsd-wrap{display:inline-flex;align-items:center}
.dsd-trigger{width:28px;height:28px;color:var(--dsw-alias-state-error-primary);background:transparent;border:none;border-radius:50%;display:inline-flex;align-items:center;justify-content:center;padding:0;cursor:pointer;opacity:.45;transition:opacity .15s ease,background .15s ease}
.dsd-trigger:hover,.dsd-trigger:focus-visible{opacity:1;background:var(--dsw-alias-interactive-bg-hover)}
.dsd-mask{position:fixed;inset:0;z-index:1000;background:rgba(0,0,0,.35);display:flex;align-items:center;justify-content:center}
.dsd-dialog{box-sizing:border-box;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l2);border-radius:12px;box-shadow:var(--dsw-shadow-lv2);width:360px;max-width:90vw;padding:20px}
.dsd-title{margin:0 0 8px;color:var(--dsw-alias-label-primary);font-size:16px;font-weight:600;line-height:24px}
.dsd-body{margin:0;color:var(--dsw-alias-label-secondary);font-size:13px;line-height:20px}
.dsd-error{color:var(--dsw-alias-state-error-primary);margin:10px 0 0;font-size:12px;line-height:18px}
.dsd-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:16px}
.dsd-cancel,.dsd-confirm{height:32px;border-radius:8px;padding:0 14px;font-size:13px;font-weight:500;line-height:20px;cursor:pointer;font-family:inherit}
.dsd-cancel{color:var(--dsw-alias-label-primary);background:transparent;border:1px solid var(--dsw-alias-border-l2)}
.dsd-cancel:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.dsd-confirm{color:#fff;background:var(--dsw-alias-state-error-primary);border:none}
.dsd-confirm:hover:not(:disabled){filter:brightness(.92)}
.dsd-cancel:disabled,.dsd-confirm:disabled{opacity:.6;cursor:default}
`;
    const CSS_TAG = "dsh-session-delete/session-delete.css";
    if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(CSS_TAG) + "]") === null) {
      const tag = document.createElement("style");
      tag.dataset.plugin = "dsh-session-delete";
      tag.dataset.pluginCss = CSS_TAG;
      tag.textContent = CSS;
      document.head.appendChild(tag);
    }

    const inject = ["slots", "locale", "workspaces"];

    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), "dsh-session-delete: dictionaries");

      function SessionDeleteAction({ sessionId, t }) {
        const [open, setOpen] = React.useState(false);
        const [busy, setBusy] = React.useState(false);
        const [error, setError] = React.useState(null);

        const run = async () => {
          if (busy) return;
          setBusy(true);
          setError(null);
          try {
            await ctx.workspaces.archiveSession(sessionId);
            setOpen(false);
          } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
          } finally {
            setBusy(false);
          }
        };

        const close = () => {
          if (!busy) setOpen(false);
        };

        return React.createElement("span", { className: "dsd-wrap" },
          React.createElement("button", {
            type: "button",
            className: "dsd-trigger",
            "aria-label": t("deleteSession"),
            title: t("deleteSession"),
            onClick: () => setOpen(true),
          },
            React.createElement("svg", { width: 16, height: 16, viewBox: "0 0 16 16", fill: "none", "aria-hidden": "true" },
              React.createElement("path", { d: TRASH_PATH, fill: "currentColor" }))),
          open && React.createElement("div", { className: "dsd-mask", onClick: close },
            React.createElement("div", {
              className: "dsd-dialog",
              role: "dialog",
              "aria-modal": "true",
              "aria-label": t("confirmTitle"),
              onClick: (e) => e.stopPropagation(),
              onKeyDown: (e) => { if (e.key === "Escape") close(); },
            },
              React.createElement("h3", { className: "dsd-title" }, t("confirmTitle")),
              React.createElement("p", { className: "dsd-body" }, t("confirmBody")),
              error !== null && React.createElement("p", { className: "dsd-error", role: "alert" }, error),
              React.createElement("div", { className: "dsd-actions" },
                React.createElement("button", {
                  type: "button",
                  className: "dsd-cancel",
                  disabled: busy,
                  onClick: close,
                }, t("cancel")),
                React.createElement("button", {
                  type: "button",
                  className: "dsd-confirm",
                  disabled: busy,
                  onClick: run,
                }, busy ? t("deleting") : t("confirm"))))));
      }

      ctx.slots.inject("conversation.session.header.utilities", () => ctx.slots.register({
        name: "conversation.session.header.utilities",
        id: "session-delete",
        order: 100,
        locale: NS,
      }, SessionDeleteAction));
    }

    exports.inject = inject;
    exports.apply = apply;
    return module.exports;
  },
});
