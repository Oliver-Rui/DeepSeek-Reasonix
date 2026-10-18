import { Fragment } from "react";
import { t } from "../i18n";
import type { SkillEntry } from "../port/port";

// What the skill says about itself in the Agent Skills format: who may use it
// and what it expects. Shown as written; nothing here changes how it runs.
export function SkillSpecInfo({ sk }: { sk: SkillEntry }) {
  const meta = Object.entries(sk.metadata ?? {});
  if (!sk.license && !sk.compatibility && meta.length === 0) return null;
  return (
    <details className="skprofile">
      <summary aria-label={t("{name} 的技能信息", { name: sk.name })}>{t("技能信息")}</summary>
      <dl>
        {sk.license && <><dt>{t("许可")}</dt><dd>{sk.license}</dd></>}
        {sk.compatibility && <><dt>{t("运行要求")}</dt><dd>{sk.compatibility}</dd></>}
        {meta.map(([key, value]) => <Fragment key={key}><dt>{key}</dt><dd>{value}</dd></Fragment>)}
      </dl>
    </details>
  );
}
