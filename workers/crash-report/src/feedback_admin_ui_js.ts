// Served as a same-origin script under a strict CSP. User text only ever reaches
// the DOM through textContent / text nodes; no markup string is built from data.
export const APP_JS = String.raw`(function () {
  "use strict";
  var KEY = "fbadmin.token";
  var BASE = "/v1/admin/feedback";
  var STATUS = {
    held: "待审", needs_info: "待补充", answered: "已回答", rejected: "已拒绝", received: "已放行",
    recorded: "已转 issue", in_progress: "处理中", fixed: "已修复", wontfix: "不修", duplicate: "重复", withdrawn: "已撤回"
  };
  var CATEGORY = { bug: "缺陷", idea: "建议", question: "提问", other: "其他" };
  var token = "";
  try { token = sessionStorage.getItem(KEY) || ""; } catch (e) { token = ""; }
  var root = document.getElementById("app");
  var state = { filters: { status: "", category: "", version: "", nickname: "", install: "" }, items: [], next: null, selected: "", urls: [] };

  function h(tag, attrs, kids) {
    var el = document.createElement(tag);
    var k;
    for (k in attrs || {}) {
      var v = attrs[k];
      if (v === null || v === undefined || v === false) continue;
      if (k === "class") el.className = v;
      else if (k === "text") el.textContent = String(v);
      else if (k.slice(0, 2) === "on") el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? "" : String(v));
    }
    (kids || []).forEach(function (c) {
      if (c === null || c === undefined || c === false) return;
      el.appendChild(typeof c === "string" || typeof c === "number" ? document.createTextNode(String(c)) : c);
    });
    return el;
  }
  function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); }
  function when(iso) { var d = new Date(iso); return isNaN(d) ? String(iso || "") : d.toLocaleString(); }
  function setToken(t) {
    token = t;
    try { if (t) sessionStorage.setItem(KEY, t); else sessionStorage.removeItem(KEY); } catch (e) {}
  }

  function api(method, path, body) {
    var headers = { authorization: "Bearer " + token };
    var init = { method: method, headers: headers, cache: "no-store", credentials: "omit", referrerPolicy: "no-referrer" };
    if (body !== undefined) { headers["content-type"] = "application/json"; init.body = JSON.stringify(body); }
    return fetch(BASE + path, init).then(function (res) {
      if (res.status === 401) { logout("令牌无效或已失效，请重新输入。"); throw new Error("unauthorized"); }
      return res.json().catch(function () { return {}; }).then(function (data) {
        if (!res.ok) {
          var e = new Error(data && data.error ? data.error.code + "：" + data.error.message : "HTTP " + res.status);
          e.status = res.status;
          if (res.status === 429 && data && data.error && data.error.code === "feedback.rate_limited") logout("失败次数过多，已被暂时锁定，请稍后再试。");
          throw e;
        }
        return data;
      });
    });
  }

  function logout(msg) { setToken(""); revoke(); renderLogin(msg || ""); }
  function revoke() { state.urls.forEach(function (u) { URL.revokeObjectURL(u); }); state.urls = []; }

  function renderLogin(msg) {
    clear(root);
    var input = h("input", { type: "password", autocomplete: "off", spellcheck: "false", placeholder: "管理员令牌", "aria-label": "管理员令牌" });
    var form = h("form", { class: "login", onsubmit: function (ev) {
      ev.preventDefault();
      if (!input.value) return;
      setToken(input.value);
      renderMain();
    } }, [
      h("h1", { text: "反馈后台" }),
      h("p", { class: "muted", text: "令牌只保存在本标签页的 sessionStorage 中，关闭标签页即丢失；仅通过请求头发送。" }),
      input,
      h("button", { type: "submit", class: "primary", text: "进入" }),
      msg ? h("p", { class: "error", role: "alert", text: msg }) : null
    ]);
    root.appendChild(h("main", { class: "center" }, [form]));
    input.focus();
  }

  function badge(status) { return h("span", { class: "badge s-" + status, text: STATUS[status] || status }); }

  function field(label, input) { return h("label", { class: "f" }, [h("span", { text: label }), input]); }

  function select(name, options, labels) {
    var sel = h("select", { name: name }, [h("option", { value: "", text: "全部" })].concat(options.map(function (o) {
      return h("option", { value: o, text: labels[o] || o });
    })));
    sel.value = state.filters[name];
    return sel;
  }

  var listBox, listMore, detailBox, listNote;

  function renderMain() {
    clear(root);
    var f = state.filters;
    var status = select("status", Object.keys(STATUS), STATUS);
    var category = select("category", Object.keys(CATEGORY), CATEGORY);
    var version = h("input", { name: "version", value: f.version, placeholder: "v2.24.0" });
    var nickname = h("input", { name: "nickname", value: f.nickname, placeholder: "昵称包含…" });
    var install = h("input", { name: "install", value: f.install, placeholder: "安装 id 或哈希前缀" });
    var bar = h("form", { class: "filters", onsubmit: function (ev) {
      ev.preventDefault();
      state.filters = { status: status.value, category: category.value, version: version.value.trim(), nickname: nickname.value.trim(), install: install.value.trim() };
      loadList(true);
    } }, [
      field("状态", status), field("类型", category), field("版本", version), field("昵称", nickname), field("安装", install),
      h("button", { type: "submit", class: "primary", text: "筛选" }),
      h("button", { type: "button", text: "重置", onclick: function () { state.filters = { status: "", category: "", version: "", nickname: "", install: "" }; renderMain(); } })
    ]);
    listNote = h("p", { class: "muted", role: "status" });
    listBox = h("div", { class: "rows" });
    listMore = h("button", { type: "button", class: "more", text: "加载更多", hidden: true, onclick: function () { loadList(false); } });
    detailBox = h("section", { class: "detail", "aria-live": "polite" }, [h("p", { class: "muted", text: "从左侧选择一条反馈查看详情。" })]);
    root.appendChild(h("header", { class: "top" }, [
      h("h1", { text: "反馈后台" }),
      h("button", { type: "button", text: "退出", onclick: function () { logout(""); } })
    ]));
    root.appendChild(h("div", { class: "layout" }, [
      h("section", { class: "list" }, [bar, listNote, listBox, listMore]),
      detailBox
    ]));
    loadList(true);
  }

  function query(before) {
    var p = [];
    Object.keys(state.filters).forEach(function (k) { if (state.filters[k]) p.push(k + "=" + encodeURIComponent(state.filters[k])); });
    if (before) p.push("before=" + before);
    p.push("limit=25");
    return "/list?" + p.join("&");
  }

  function loadList(reset) {
    if (reset) { state.items = []; state.next = null; clear(listBox); }
    listNote.textContent = "加载中…";
    api("GET", query(reset ? 0 : state.next)).then(function (data) {
      state.items = state.items.concat(data.items);
      state.next = data.nextBefore;
      data.items.forEach(function (it) { listBox.appendChild(row(it)); });
      listMore.hidden = state.next === null;
      listNote.textContent = state.items.length === 0 ? "没有符合条件的反馈。" : "已显示 " + state.items.length + " 条，按时间从新到旧。";
    }).catch(function (e) { if (e.message !== "unauthorized") listNote.textContent = "加载失败：" + e.message; });
  }

  function row(it) {
    var b = h("button", { type: "button", class: "row" + (it.receipt === state.selected ? " on" : ""), "data-receipt": it.receipt, onclick: function () { openDetail(it.receipt); } }, [
      h("span", { class: "r1" }, [
        h("span", { class: "mono", text: it.receipt }), badge(it.status),
        h("span", { class: "tag", text: CATEGORY[it.category] || it.category }),
        it.hasImages ? h("span", { class: "tag", title: "附带截图", text: "图 " + it.imageCount }) : null,
        it.replyCount ? h("span", { class: "tag", title: "回复数", text: "回复 " + it.replyCount }) : null
      ]),
      h("span", { class: "r2", text: it.snippet }),
      h("span", { class: "r3 muted" }, [it.displayName + " · " + (it.version || "未知版本") + " · " + (it.device || "未知设备") + " · " + when(it.createdAt)])
    ]);
    return b;
  }

  function kv(label, value, mono) {
    return [h("dt", { text: label }), h("dd", { class: mono ? "mono" : "", text: value === "" || value === null || value === undefined ? "—" : String(value) })];
  }

  function openDetail(receipt) {
    state.selected = receipt;
    Array.prototype.forEach.call(listBox.children, function (el) { el.classList.toggle("on", el.getAttribute("data-receipt") === receipt); });
    revoke();
    clear(detailBox);
    detailBox.appendChild(h("p", { class: "muted", text: "加载中…" }));
    api("GET", "/" + encodeURIComponent(receipt)).then(renderDetail).catch(function (e) {
      if (e.message === "unauthorized") return;
      clear(detailBox);
      detailBox.appendChild(h("p", { class: "error", text: "加载失败：" + e.message }));
    });
  }

  function safeIssue(url) { return /^https:\/\/github\.com\/[^\s]+$/.test(url || ""); }

  function renderDetail(d) {
    clear(detailBox);
    var e = d.env || {};
    var msg = h("p", { class: "muted", role: "status" });
    var text = h("textarea", { rows: "5", maxlength: "4096", placeholder: "回答 / 追问 / 回复的内容；拒绝和封禁时作为原因（200 字内）", "aria-label": "操作文字" });
    var images = h("label", { class: "inline" }, [h("input", { type: "checkbox" }), "放行时同时公开截图"]);
    var hours = h("input", { type: "number", min: "1", max: "8760", placeholder: "封禁小时数（空=永久）", "aria-label": "封禁小时数" });

    function run(label, path, body, confirmText) {
      return h("button", { type: "button", class: confirmText ? "danger" : "primary", text: label, onclick: function () {
        if (confirmText && !window.confirm(confirmText)) return;
        var payload;
        try { payload = body(); } catch (x) { return; }
        msg.textContent = "提交中…";
        api("POST", path, payload).then(function () { msg.textContent = "已完成。"; openDetail(d.receipt); refreshRow(); })
          .catch(function (err) { if (err.message !== "unauthorized") msg.textContent = "失败：" + err.message; });
      } });
    }
    function need() {
      var t = text.value.trim();
      if (!t) { msg.textContent = "请先填写文字。"; throw new Error("empty"); }
      return t;
    }
    var base = "/" + encodeURIComponent(d.receipt);
    var actions = [];
    if (d.status === "held") {
      actions.push(run("放行", base + "/release", function () { return { publishImages: images.querySelector("input").checked }; }));
      actions.push(run("回答并结案", base + "/answer", function () { return { body: need() }; }));
      actions.push(run("追问", base + "/ask", function () { return { body: need() }; }));
      actions.push(run("拒绝", base + "/reject", function () { return { reason: need() }; }, "确认拒绝这条反馈？这会删除其截图，三次拒绝会自动封禁该安装。"));
    } else if (d.status === "needs_info") {
      actions.push(run("回答并结案", base + "/answer", function () { return { body: need() }; }));
      actions.push(run("拒绝", base + "/reject", function () { return { reason: need() }; }, "确认拒绝这条反馈？"));
    }
    if (d.status !== "rejected") actions.push(run("追加回复", base + "/reply", function () { return { body: need() }; }));
    if (d.attachments.length) actions.push(run("删除全部截图", base + "/takedown", function () { return undefined; }, "确认永久删除这条反馈的全部截图？"));
    actions.push(run("封禁该安装", "/block", function () {
      var body = { target: "install:" + d.installHash, reason: need() };
      if (hours.value) body.hours = Number(hours.value);
      return body;
    }, "确认封禁该安装？此后它无法再提交反馈。"));

    var thread = d.replies.length ? d.replies.map(function (t) {
      var shots = t.images || [];
      var pub = shots.filter(function (i) { return i.released; }).length;
      var imageRow = shots.length ? h("div", { class: "muted" }, [
        "回复附图 " + shots.length + " 张（已公开 " + pub + "）　",
        pub < shots.length && d.issueNumber ? run("公开这条回复的图", base + "/replies/" + t.id + "/release-images", function () { return undefined; }, "确认把这条回复的图片公开到 GitHub 议题？") : null,
        run("删除这条回复的图", base + "/replies/" + t.id + "/remove-images", function () { return undefined; }, "确认永久删除这条回复的图片？已公开的链接会失效。")
      ]) : null;
      return h("div", { class: "msg " + (t.author === "user" ? "user" : "maint") }, [
        h("div", { class: "muted", text: (t.author === "user" ? "用户" : "维护者") + " · " + when(t.createdAt) }),
        h("div", { class: "text", text: t.body }),
        imageRow
      ]);
    }) : [h("p", { class: "muted", text: "暂无回复。" })];

    var imgBox = h("div", { class: "imgs" });
    d.attachments.forEach(function (a) {
      var cell = h("figure", {}, [h("figcaption", { class: "muted", text: a.name + " · " + Math.round(a.size / 1024) + " KB · " + (a.released ? "已公开" : "未公开（仅管理员可见）") })]);
      imgBox.appendChild(cell);
      fetch(BASE + "/" + encodeURIComponent(d.receipt) + "/attachments/" + encodeURIComponent(a.key), { headers: { authorization: "Bearer " + token }, cache: "no-store", credentials: "omit", referrerPolicy: "no-referrer" })
        .then(function (r) { if (!r.ok) throw new Error("HTTP " + r.status); return r.blob(); })
        .then(function (blob) {
          if (blob.type !== "image/png" && blob.type !== "image/jpeg") throw new Error("非图片内容");
          var u = URL.createObjectURL(blob);
          state.urls.push(u);
          cell.insertBefore(h("img", { src: u, alt: a.name }), cell.firstChild);
        })
        .catch(function (err) { cell.appendChild(h("p", { class: "error", text: "图片加载失败：" + err.message })); });
    });

    detailBox.appendChild(h("div", { class: "dh" }, [h("h2", { class: "mono", text: d.receipt }), badge(d.status), h("span", { class: "tag", text: CATEGORY[d.category] || d.category })]));
    detailBox.appendChild(h("h3", { text: "正文" }));
    detailBox.appendChild(h("div", { class: "text body", text: d.body }));
    detailBox.appendChild(h("h3", { text: "用户与设备" }));
    detailBox.appendChild(h("dl", {}, [].concat(
      kv("昵称", d.displayName), kv("联系方式（仅此处可见）", d.contact),
      kv("版本", e.version), kv("提交 commit", e.commit, true), kv("入口", e.surface), kv("渠道", e.channel),
      kv("系统", [e.os, e.osVersion, e.arch].filter(Boolean).join(" ")), kv("语言", e.locale), kv("模型厂商类型", e.providerKind),
      kv("安装哈希", d.installHash, true), kv("已受信安装", d.installTrusted ? "是" : "否"),
      kv("提交时间", when(d.createdAt)), kv("更新时间", when(d.updatedAt)),
      kv("已修复于", d.resolvedVersion), kv("重复于", d.duplicateOf)
    )));
    if (d.issueNumber) {
      detailBox.appendChild(h("p", {}, ["关联 issue：", safeIssue(d.issueUrl)
        ? h("a", { href: d.issueUrl, rel: "noopener noreferrer", target: "_blank", text: "#" + d.issueNumber })
        : h("span", { text: "#" + d.issueNumber })]));
    }
    detailBox.appendChild(h("h3", { text: "截图（" + d.attachments.length + "）" }));
    detailBox.appendChild(d.attachments.length ? imgBox : h("p", { class: "muted", text: "没有截图。" }));
    detailBox.appendChild(h("h3", { text: "对话" }));
    thread.forEach(function (n) { detailBox.appendChild(n); });
    detailBox.appendChild(h("h3", { text: "操作" }));
    detailBox.appendChild(text);
    detailBox.appendChild(h("div", { class: "opts" }, [d.status === "held" && d.attachments.length ? images : null, hours]));
    detailBox.appendChild(h("div", { class: "actions" }, actions));
    detailBox.appendChild(msg);
  }

  function refreshRow() { loadList(true); }

  if (token) renderMain(); else renderLogin("");
})();
`;
