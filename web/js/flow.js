import { el, icon } from "./util.js";
import { t } from "./i18n.js";
import { byId } from "./catalog.js";

function stageCard({ number, title, copy, status, planned, action }) {
  return el("article", { class: `flow-stage${planned ? " planned" : ""}` },
    el("div", { class: "flow-stage-top" },
      el("span", { class: "flow-step" }, String(number).padStart(2, "0")),
      status ? el("span", { class: `tag${planned ? " dark" : ""}` }, status) : null),
    el("h2", {}, title),
    el("p", {}, copy),
    action || null);
}

export function flowView() {
  const create = byId.get("h3-reference-sglang");
  const extend = byId.get("h3-extend-sglang");
  const upscale = byId.get("h3-regenerate-2k-ic");

  const createAction = create
    ? el("a", { class: "btn lime small", href: `#/app/${create.id}` }, icon("spark"), t("flow.open.create"))
    : el("span", { class: "flow-disabled" }, t("flow.unavailable"));
  const extendAction = extend
    ? el("a", { class: "btn ghost small", href: `#/app/${extend.id}` }, icon("redo"), t("flow.open.extend"))
    : el("span", { class: "flow-disabled" }, t("flow.pending.image"));
  const upscaleAction = upscale
    ? el("a", { class: "btn ghost small", href: `#/app/${upscale.id}` }, icon("layers"), t("flow.open.upscale"))
    : el("span", { class: "flow-disabled" }, t("flow.pending.image"));

  const next = el("aside", { class: "flow-side" },
    el("span", { class: "tag ghost" }, t("flow.next")),
    el("h2", { class: "display" }, t("flow.next.title")),
    el("p", {}, t("flow.next.copy")),
    createAction,
    el("div", { class: "flow-rule" }),
    el("h3", {}, t("flow.keep.title")),
    el("ul", {},
      el("li", {}, t("flow.keep.one")),
      el("li", {}, t("flow.keep.two")),
      el("li", {}, t("flow.keep.three"))),
    el("p", { class: "help" }, t("flow.keep.note")));

  const rail = el("ol", { class: "flow-rail" },
    el("li", {}, stageCard({
      number: 1,
      title: t("flow.stage.create.title"),
      copy: t("flow.stage.create.copy"),
      status: create?.status === "ready" ? t("flow.status.ready") : t("flow.status.planned"),
      planned: create?.status !== "ready",
      action: createAction,
    })),
    el("li", {}, stageCard({
      number: 2,
      title: t("flow.stage.extend.title"),
      copy: t("flow.stage.extend.copy"),
      status: extend?.status === "ready" ? t("flow.status.ready") : t("flow.status.planned"),
      planned: extend?.status !== "ready",
      action: extendAction,
    })),
    el("li", {}, stageCard({
      number: 3,
      title: t("flow.stage.upscale.title"),
      copy: t("flow.stage.upscale.copy"),
      status: upscale?.status === "ready" ? t("flow.status.ready") : t("flow.status.planned"),
      planned: upscale?.status !== "ready",
      action: upscaleAction,
    })));

  const node = el("div", { class: "page flow-page" },
    el("header", { class: "flow-head" },
      el("div", {},
        el("span", { class: "tag ghost" }, t("flow.eyebrow")),
        el("h1", { class: "display" }, t("flow.title")),
        el("p", {}, t("flow.sub"))),
      el("a", { class: "btn ghost small", href: "#/video" }, icon("chevL"), t("flow.back"))),
    el("div", { class: "flow-layout" },
      el("div", { class: "flow-main" },
        el("div", { class: "flow-rail-head" },
          el("span", {}, t("flow.rail.label")),
          el("span", { class: "dim" }, t("flow.rail.optional"))),
        rail,
        el("section", { class: "flow-note" },
          el("div", { class: "flow-note-icon" }, icon("layers")),
          el("div", {},
            el("h2", {}, t("flow.one.title")),
            el("p", {}, t("flow.one.copy"))))),
      next));
  return { node, active: "video" };
}
