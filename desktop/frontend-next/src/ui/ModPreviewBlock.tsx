import { t } from "../i18n";
import type { ModPreview } from "../port/plugin";

// Keyed by the kernel's reason and kind. A key with no entry shows the key itself
// rather than nothing: an unlisted module must never read as a clean one.
const NOT_LISTED: Record<string, string> = {
  typescript: "它是 TypeScript，本应用不读",
  too_large: "文件太大",
  unparseable: "语法解析失败",
  timeout: "解析超时",
  unsupported_module: "不是本宿主支持的模块形式",
};

const FINDING: Record<string, string> = {
  eval: "用了 eval",
  function_ctor: "用了 new Function",
  computed_member: "用计算出来的名字访问接口",
  api_escapes: "把接口对象交给了别处",
  on_escapes: "把注册函数交给了别处",
  destructured_api: "把接口对象解构了出来",
  no_register: "没有找到导出的 register",
};

const IMPORT_KIND: Record<string, string> = { static: "import", require: "require", dynamic: "import()" };

const list = (xs: string[]) => xs.join("、");

/** What the install preview says about a Claude Code mod: it runs on this
 *  machine with the user's full trust, and the listing below is read from the
 *  module's syntax tree. It is a static list and not a guarantee, and the block
 *  says so in those words; a module that could not be read is "not previewed". */
export function ModPreviewBlock({ mod }: { mod: ModPreview }) {
  const dynamic = mod.events.filter((e) => e.dynamic).length;
  const calls = mod.api.map((c) => (c.dynamic ? "$.…" : c.method ? `$.${c.namespace}.${c.method}` : `$.${c.namespace}`));
  return (
    <section className="modpreview" aria-label={t("Claude Code mod 预览")}>
      <div className="risk" data-kind="shell">
        <span className="lb">{t("Claude Code mod · 完全信任")}</span>
        <span className="why">{t("它的代码会在这台电脑上以你的权限运行：没有沙盒，不受网络出口治理，它做的事也不会被本应用观测到。只有在设置里打开「运行 Claude Code mod」后才会运行。")}</span>
      </div>
      <p className="why">{t("下面是读取代码语法树得到的静态清单，不是保证：imports 是看不见的代码；eval、new Function 和用计算出来的名字访问接口，都会让清单列不全。")}</p>
      {!mod.listed ? (
        <div className="risk" data-kind="secret">
          <span className="lb">{t("未预览")}</span>
          <span className="dt">{t(NOT_LISTED[mod.reason ?? ""] ?? mod.reason ?? "")}</span>
          <span className="why">{t("这不等于没问题：读不了的代码按“未预览”处理。")}</span>
        </div>
      ) : (
        <>
          <div className="risk"><span className="lb">{t("它挂钩的事件")}</span><span className="dt">{mod.events.filter((e) => !e.dynamic).map((e) => e.name).join(", ") || t("（没有列出）")}</span></div>
          {dynamic > 0 && <div className="risk" data-kind="secret"><span className="lb">{t("名字无法列出的事件")}</span><span className="dt">{dynamic}</span></div>}
          {calls.length > 0 && <div className="risk"><span className="lb">{t("它用到的接口")}</span><span className="dt">{calls.join(", ")}</span></div>}
          {mod.imports.length > 0 && (
            <div className="risk" data-kind="secret">
              <span className="lb">{t("它引入的代码（看不见）")}</span>
              <span className="dt">{mod.imports.map((i) => `${IMPORT_KIND[i.kind] ?? i.kind} ${i.spec}`).join(", ")}</span>
            </div>
          )}
          {mod.findings.length > 0 && (
            <div className="risk" data-kind="secret">
              <span className="lb">{t("会让清单列不全的写法")}</span>
              <span className="dt">{list(mod.findings.map((f) => t(FINDING[f.kind] ?? f.kind)))}</span>
            </div>
          )}
          {mod.unserved.length > 0 && <div className="risk"><span className="lb">{t("本应用不会触发的事件")}</span><span className="dt">{mod.unserved.join(", ")}</span></div>}
        </>
      )}
      <div className="risk">
        <span className="lb">{t("模块")}</span>
        <span className="dt" title={mod.sha256}>{mod.module} · {mod.sha256.slice(0, 12)}</span>
        <span className="why">{t("更新会重新预览并需要重新确认：模块内容变了就是新的授权。")}</span>
      </div>
    </section>
  );
}
