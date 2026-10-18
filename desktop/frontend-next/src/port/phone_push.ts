import { AccountError, type Account, type Device } from "./phone_device";
import { fromBase64url, pushMessage } from "./phone_proof";

export interface PushCategories {
  approval: boolean;
  input: boolean;
  error: boolean;
}

export const NO_CATEGORIES: PushCategories = { approval: false, input: false, error: false };

export interface PushStatus {
  categories: PushCategories;
  lastFailureAt: string | null;
  lastFailureStatus: number | null;
  failureCount: number;
}

export interface BrowserSubscription {
  endpoint: string;
  p256dh: string;
  auth: string;
}

// Everything the browser decides, behind one seam: whether push exists here, what
// the person answered, and the address the browser hands back.
export interface PushBrowser {
  supported(): boolean;
  permission(): NotificationPermission;
  requestPermission(): Promise<NotificationPermission>;
  subscribe(applicationServerKey: Uint8Array<ArrayBuffer>): Promise<BrowserSubscription>;
  unsubscribe(): Promise<void>;
}

export const WORKER_URL = "./push-sw.js";

export function realPushBrowser(): PushBrowser {
  const registration = () => navigator.serviceWorker.register(WORKER_URL, { scope: "./" }).then(() => navigator.serviceWorker.ready);
  return {
    supported: () => "serviceWorker" in navigator && "PushManager" in window && "Notification" in window,
    permission: () => Notification.permission,
    requestPermission: () => Notification.requestPermission(),
    async subscribe(applicationServerKey) {
      const reg = await registration();
      const existing = await reg.pushManager.getSubscription();
      if (existing) await existing.unsubscribe();
      const sub = (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey })).toJSON();
      return { endpoint: sub.endpoint ?? "", p256dh: sub.keys?.p256dh ?? "", auth: sub.keys?.auth ?? "" };
    },
    async unsubscribe() {
      const reg = await navigator.serviceWorker.getRegistration("./");
      await (await reg?.pushManager.getSubscription())?.unsubscribe();
    },
  };
}

export type EnableRefusal = "unsupported" | "denied" | "not_active" | "push_service";

export class EnableRefused extends Error {
  constructor(readonly reason: EnableRefusal) {
    super(reason);
  }
}

// The browser prompt needs a user gesture, so this is called from the press that
// turns the switch on and asks for permission before anything else. Only a
// subscription that carries the device's signature over its own address and keys
// is accepted by the account, so a stolen cookie cannot attach one.
export async function enablePush(
  account: Account, browser: PushBrowser, sign_: (message: Uint8Array<ArrayBuffer>) => Promise<string>,
  host: string, device: Device, userId: number, categories: PushCategories,
): Promise<PushStatus> {
  if (!browser.supported()) throw new EnableRefused("unsupported");
  if (device.state !== "active") throw new EnableRefused("not_active");
  const answer = browser.permission() === "granted" ? "granted" : await browser.requestPermission();
  if (answer !== "granted") throw new EnableRefused("denied");
  const { publicKey } = await account.call<{ publicKey: string }>("GET", "/me/remote-push/key");
  // Whatever the browser says when it cannot register with its own push service
  // is its answer, not the account's.
  const subscription = await browser.subscribe(fromBase64url(publicKey)).catch(() => { throw new EnableRefused("push_service"); });
  const { nonce } = await account.call<{ nonce: string }>("POST", "/me/remote-controllers/challenge", { host, purpose: "push" });
  const signature = await sign_(await pushMessage({
    nonce, userId, host, deviceId: device.id, endpoint: subscription.endpoint, p256dh: subscription.p256dh, auth: subscription.auth,
  }));
  const { subscription: stored } = await account.call<{ subscription: PushStatus }>("PUT", `/me/remote-push/${device.id}`, {
    host, nonce, signature, categories, subscription: { endpoint: subscription.endpoint, keys: { p256dh: subscription.p256dh, auth: subscription.auth } },
  });
  return stored;
}

export async function pushStatus(account: Account, deviceId: string): Promise<PushStatus | null> {
  try {
    return (await account.call<{ subscription: PushStatus }>("GET", `/me/remote-push/${deviceId}`)).subscription;
  } catch (error) {
    if (error instanceof AccountError && error.status === 404) return null;
    throw error;
  }
}

export async function setCategories(account: Account, deviceId: string, categories: PushCategories): Promise<PushStatus> {
  return (await account.call<{ subscription: PushStatus }>("PATCH", `/me/remote-push/${deviceId}`, { categories })).subscription;
}

export async function disablePush(account: Account, browser: PushBrowser, deviceId: string): Promise<void> {
  await account.call("DELETE", `/me/remote-push/${deviceId}`);
  await browser.unsubscribe();
}
