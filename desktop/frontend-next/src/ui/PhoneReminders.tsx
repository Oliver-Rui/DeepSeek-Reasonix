import { useCallback, useEffect, useMemo, useState } from "react";
import { t } from "../i18n";
import { accountOrigin, ownFetch } from "../port/cloud_remote";
import { AccountError, accountClient, indexedDbKeyStore, uaClassOf } from "../port/phone_device";
import { EnableRefused, realPushBrowser, type PushCategories } from "../port/phone_push";
import { phoneReminders, type PhoneReminders, type Reminders } from "../port/phone_reminders";
import { Group } from "./Group";
import { Switch } from "./Switch";

function realReminders(host: string): PhoneReminders {
  return phoneReminders(host, {
    account: accountClient(accountOrigin, ownFetch),
    keys: indexedDbKeyStore,
    browser: realPushBrowser(),
    uaClass: uaClassOf(navigator.userAgent),
  });
}

function problemFor(error: unknown): string {
  if (error instanceof EnableRefused) {
    if (error.reason === "denied") return t("浏览器没有允许通知。请在浏览器的网站设置里允许这个页面发通知，再打开这个开关。");
    if (error.reason === "unsupported") return t("这个浏览器不能接收提醒。");
    if (error.reason === "push_service") return t("浏览器没能向它的推送服务登记，所以这台手机暂时收不到提醒。常见原因是网络连不上浏览器厂商的推送服务。");
    return t("这台手机还没有被电脑批准。");
  }
  if (error instanceof AccountError && (error.status === 401 || error.code === "remote_reauth_required")) {
    return t("需要重新登录账号后再试。");
  }
  return t("账号服务暂时不可用，请稍后再试。");
}

/** What this phone does about reminders from one computer. Switching on is what
 *  registers the phone with the account: reading this block creates nothing. */
export function PhoneReminders({ host, reminders }: { host: string; reminders?: PhoneReminders }) {
  const live = useMemo(() => reminders ?? realReminders(host), [host, reminders]);
  const [state, setState] = useState<Reminders | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState("");

  useEffect(() => {
    let current = true;
    live.load().then((s) => current && setState(s)).catch((e) => { if (current) { setState({ kind: "off" }); setProblem(problemFor(e)); } });
    return () => { current = false; };
  }, [live]);

  // The first call into `live` stays in the press that made it: the browser's
  // permission prompt is only shown from one.
  const run = useCallback((go: () => Promise<Reminders>) => {
    setBusy(true);
    setProblem("");
    go().then(setState).catch((e) => setProblem(problemFor(e))).finally(() => setBusy(false));
  }, []);

  const supported = live.supported();
  const on = state?.kind === "on" ? state : null;
  const choose = (patch: Partial<PushCategories>) => on && run(() => live.choose({ ...on.status.categories, ...patch }));
  const occasion = (key: keyof PushCategories, label: string, hint: string) => (
    <div className="lrow subrow">
      <span className="tx"><span className="lb">{label}</span><span className="ds">{hint}</span></span>
      <Switch data-action="phone-device.occasion" data-value={key} on={on?.status.categories[key] ?? false} busy={busy}
        label={label} onClick={() => choose({ [key]: !on?.status.categories[key] })} />
    </div>
  );
  return (
    <Group id="phone-device" title={t("这台手机的提醒")}
      hint={t("电脑有事等你时，这台手机会收到一条通知。通知里只有“哪一类”和数量，不含会话名称、命令或对话内容。默认关闭，只提醒你勾选的几类。")}>
      <div className="lrow">
        <span className="tx">
          <span className="lb">{t("提醒这台手机")}</span>
          <span className="ds">{t("第一次打开时，这台手机会向电脑申请登记，需要你在电脑上批准。")}</span>
        </span>
        <Switch data-action="phone-device.enabled" on={!!on} busy={busy || state === null || !supported} label={t("提醒这台手机")}
          onClick={() => run(on ? live.disable : live.enable)} />
      </div>
      {!supported && <div className="peernote">{t("这个浏览器没有通知能力。iPhone 上通常要先把这个页面添加到主屏幕，再从主屏幕打开。")}</div>}
      {state?.kind === "waiting" && (
        <div className="peernote">
          {t("这台手机在等电脑批准：到电脑上的 设置 → 远程 → 手机通知，点「添加」，然后回来再试。")}
          <button className="act" data-action="phone-device.retry" disabled={busy} onClick={() => run(live.enable)}>{t("再试一次")}</button>
        </div>
      )}
      {state?.kind === "removed" && (
        <div className="peernote">
          {t("电脑已经把这台手机移除了。重新登记会换一把新的密钥，并需要电脑再批准一次。")}
          <button className="act" data-action="phone-device.restart" disabled={busy} onClick={() => run(live.startOver)}>{t("重新登记")}</button>
        </div>
      )}
      {on && (
        <>
          {occasion("approval", t("有操作要批准"), t("模型要动的东西超出了已经给出的授权"))}
          {occasion("input", t("模型向我提问"), t("模型停下来等你回答"))}
          {occasion("error", t("一轮出错结束"), t("这一轮因为出错而结束；你自己取消的不算"))}
          {on.status.failureCount > 0 && (
            <div className="peernote" role="status">
              {on.status.lastFailureStatus
                ? t("上一次提醒没有送达（推送服务回应 {status}），已自动放慢重试。", { status: on.status.lastFailureStatus })
                : t("上一次提醒没有送达，已自动放慢重试。")}
            </div>
          )}
        </>
      )}
      {problem && <div className="why" role="alert">{problem}</div>}
    </Group>
  );
}
